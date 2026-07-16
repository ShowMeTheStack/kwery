// Log-structured merge trees (CREATE INDEX ... USING lsm (col) WITH (...)), as in the course's section on
// write-optimized indexes. New entries go to the memtable, a sorted list in memory (L0); when it holds
// memtable_size entries it is written out as a sorted run (an SSTable) on pages. Runs are merged:
//
//   leveled   (the default) each level holds one run; level i may hold memtable_size * size_ratio^i entries,
//             and a level that grows past that is merged into the next one down.
//   tiered    (size-tiered, a stepped merge) each level collects runs; when it has size_ratio of
//             them they are merged into one run on the next level.
//
// Deletions (VACUUM, or the playground's delete) write tombstones, which hide older entries for the same
// (key, TID) until a merge into the bottom level drops both. Each run has a Bloom filter on its first key
// column (bloom_bits bits per key, bloom_hashes hash functions) so an equality probe skips runs that cannot
// hold the key; describe() reports the expected and the measured false positive rates.
// A lookup reads the memtable and then the runs newest first; the newest version of each (key, TID) wins.
//
// Block 0 is the meta page. The manifest (one entry per run) is a page chain. A run is a chain of data pages
// of sorted entries (the B+ tree's encoding; a tombstone has 0x8000 set in the TID's item number), a chain of
// index pages holding the first key of every data page, and a chain of Bloom filter pages.
// The memtable is in memory only: its entries are logged (lsm.put) but a crash before a flush loses it.
(function (root) {
  'use strict';
  const K = root.K;
  const NONE = K.INDEX_NONE;
  const FIELDS = ['magic', 'policy', 'manifest', 'seq', 'memSize', 'ratio', 'bloomBits', 'bloomK', 'free', 'flushes', 'compactions', 'written', 'userWrites', 'pageEntries', 'tombstones'];
  const MAGIC = 0x4c534d54;
  const TOMB = 0x8000;
  const POLICIES = ['leveled', 'tiered'];
  const DESC = ['id', 'level', 'first', 'index', 'bloom', 'n', 'npages', 'bloomBits', 'k', 'ntomb'];

  class LSMTree extends K.IndexBase {
    constructor(db, idx) {
      super(db, idx, 'lsm');
      if (!this.nblocks()) this.init();
      this.memtable = [];
      this.bloomStats = new Map(); // run id -> { probes, negatives, positives, falsePositives }
      this.opSeq = 0;
    }
    init() {
      const mf = this.newPage();
      let pol = this.optStr('compaction', 'leveled').replace(/[^a-z]/g, '');
      if (pol === 'sizetiered' || pol === 'steppedmerge' || pol === 'stepped') pol = 'tiered';
      if (!POLICIES.includes(pol)) throw K.err(K.STATE.invalidParameter, 'invalid value for lsm option "compaction": "' + pol + '" (leveled or tiered)');
      const bits = K.clamp(Math.floor(this.opt('bloom_bits', 10)), 1, 64);
      const m = {
        magic: MAGIC, policy: POLICIES.indexOf(pol), seq: 0, free: NONE,
        memSize: Math.max(1, Math.floor(this.opt('memtable_size', 64))), ratio: Math.max(2, Math.floor(this.opt('size_ratio', 4))),
        bloomBits: bits, bloomK: K.clamp(Math.floor(this.opt('bloom_hashes', Math.max(1, Math.round(bits * Math.LN2)))), 1, 16),
        pageEntries: Math.max(0, Math.floor(this.opt('page_entries', 0))),
      };
      const f = this.chainPage(m);
      m.manifest = f.block;
      this.unpin(f, true);
      this.writeFields(0, FIELDS, m, mf);
    }
    meta() { return this.readFields(0, FIELDS); }
    saveMeta(m) { this.writeFields(0, FIELDS, m); }
    get policy() { return POLICIES[this.meta().policy]; }
    chainPage(m) {
      let f;
      if (m.free !== NONE) { f = this.pin(m.free); m.free = this.sp32(f, 0); this.page(f).init(K.INDEX_SPECIAL); } else f = this.newPage();
      this.setSp32(f, 0, NONE);
      return f;
    }
    freeChain(m, b) { while (b !== NONE) { const f = this.pin(b); const nx = this.sp32(f, 0); this.page(f).init(K.INDEX_SPECIAL); this.setSp32(f, 0, m.free); m.free = b; this.unpin(f, true); b = nx; } }
    chainBlocks(b) { const out = []; while (b !== NONE) { out.push(b); const f = this.pin(b); const nx = this.sp32(f, 0); this.unpin(f, false); b = nx; } return out; }
    height() { return 1 + new Set(this.runs().map((r) => r.level)).size; }

    // ---- entries ---------------------------------------------------------------------------------------------------------
    cmpE(a, b) { return this.cmpKey(a.key, b.key) || a.b - b.b || a.o - b.o; }
    idOf(e) { return K.keyOf(e.key) + '@' + e.b + ':' + e.o; }
    packE(e) { return this.encode(e.key, e.b, e.o | (e.tomb ? TOMB : 0)); }
    unpackE(bytes) { const x = this.decode(bytes); return { key: x.key, b: x.b, o: x.o & ~TOMB, tomb: !!(x.o & TOMB) }; }
    bloomText(key) { return K.indexHashText([key[0]], [this.keyTypes[0]]); }

    // ---- the manifest ------------------------------------------------------------------------------------------------------
    packDesc(r) {
      const lo = this.encode(r.minKey, 0, 0), hi = this.encode(r.maxKey, 0, 0);
      const out = new Uint8Array(DESC.length * 4 + 4 + lo.length + hi.length);
      const dv = new DataView(out.buffer);
      DESC.forEach((n, i) => dv.setUint32(i * 4, r[n] >>> 0, true));
      dv.setUint32(DESC.length * 4, lo.length, true);
      out.set(lo, DESC.length * 4 + 4); out.set(hi, DESC.length * 4 + 4 + lo.length);
      return out;
    }
    unpackDesc(bytes) {
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const r = {};
      DESC.forEach((n, i) => { r[n] = dv.getUint32(i * 4, true); });
      const o = DESC.length * 4 + 4, len = dv.getUint32(DESC.length * 4, true);
      r.minKey = this.decode(bytes.subarray(o, o + len)).key; r.maxKey = this.decode(bytes.subarray(o + len)).key;
      return r;
    }
    /** the runs, newest first: shallower levels first, and within a level the later run first */
    runs(m) {
      m = m || this.meta();
      const out = [];
      let b = m.manifest;
      while (b !== NONE) {
        const f = this.pin(b);
        for (const it of this.items(f)) out.push(this.unpackDesc(it));
        const nx = this.sp32(f, 0);
        this.unpin(f, false);
        b = nx;
      }
      return out.sort((a, c) => a.level - c.level || c.id - a.id);
    }
    addDesc(m, r) {
      const bytes = this.packDesc(r);
      let b = m.manifest;
      for (;;) {
        const f = this.pin(b);
        if (this.fits(f, bytes.length)) { this.page(f).add(bytes, 4); this.unpin(f, true); return; }
        let nx = this.sp32(f, 0);
        if (nx === NONE) { const nf = this.chainPage(m); nx = nf.block; this.unpin(nf, true); this.setSp32(f, 0, nx); this.unpin(f, true); } else this.unpin(f, false);
        b = nx;
      }
    }
    dropDesc(m, id) {
      let b = m.manifest;
      while (b !== NONE) {
        const f = this.pin(b);
        const p = this.page(f);
        for (let i = 1; i <= p.nslots; i++) { const it = p.item(i); if (it && this.unpackDesc(it).id === id) { p.removeAt(i); this.unpin(f, true); return; } }
        const nx = this.sp32(f, 0);
        this.unpin(f, false);
        b = nx;
      }
    }

    // ---- writing runs ------------------------------------------------------------------------------------------------------
    /** write sorted entries as a run on a level: data pages, index pages (first key per data page), Bloom filter */
    writeRun(m, entries, level) {
      const r = { id: ++m.seq, level, first: NONE, index: NONE, bloom: NONE, n: entries.length, npages: 0, ntomb: entries.filter((e) => e.tomb).length, minKey: entries[0].key, maxKey: entries[entries.length - 1].key };
      const fences = [];
      let cur = null;
      for (const e of entries) {
        const bytes = this.packE(e);
        if (!cur || !this.fits(cur, bytes.length) || (m.pageEntries && this.page(cur).nslots >= m.pageEntries)) {
          const nf = this.chainPage(m);
          if (cur) { this.setSp32(cur, 0, nf.block); this.unpin(cur, true); } else r.first = nf.block;
          cur = nf; r.npages++;
          fences.push({ key: e.key, block: nf.block });
        }
        this.page(cur).add(bytes, 4);
      }
      if (cur) this.unpin(cur, true);
      // the index: one entry per data page
      let ic = null;
      for (const fe of fences) {
        const bytes = this.encode(fe.key, fe.block, 0);
        if (!ic || !this.fits(ic, bytes.length)) { const nf = this.chainPage(m); if (ic) { this.setSp32(ic, 0, nf.block); this.unpin(ic, true); } else r.index = nf.block; ic = nf; }
        this.page(ic).add(bytes, 4);
      }
      if (ic) this.unpin(ic, true);
      // the Bloom filter on the first key column
      const distinct = new Set(entries.map((e) => this.bloomText(e.key)));
      r.bloomBits = Math.max(8, distinct.size * m.bloomBits); r.k = m.bloomK;
      const bits = new Uint8Array(Math.ceil(r.bloomBits / 8));
      for (const t of distinct) for (const i of this.bloomIdx(t, r.bloomBits, r.k)) bits[i >> 3] |= 1 << (i & 7);
      const per = this.arrPer * 4;
      let bc = null;
      for (let o = 0; o < bits.length; o += per) {
        const nf = this.chainPage(m);
        this.page(nf).add(bits.subarray(o, o + per), 8);
        if (bc) { this.setSp32(bc, 0, nf.block); this.unpin(bc, true); } else r.bloom = nf.block;
        bc = nf;
      }
      if (bc) this.unpin(bc, true);
      m.written += entries.length;
      this.addDesc(m, r);
      return r;
    }
    bloomIdx(text, m, k) {
      const h1 = K.fnv(text), h2 = (K.fnv('\u0002' + text) | 1) >>> 0;
      const out = [];
      for (let i = 0; i < k; i++) out.push(((h1 + Math.imul(i, h2)) >>> 0) % m);
      return out;
    }
    bloomBitsOf(r) { const out = []; for (const b of this.chainBlocks(r.bloom)) { const f = this.pin(b); const it = this.page(f).item(1); if (it) out.push(...it); this.unpin(f, false); } return Uint8Array.from(out); }
    /** might the run hold this first-column value? (one page read per probe for the filter) */
    mayContain(r, v) {
      const idx = this.bloomIdx(this.bloomText([v]), r.bloomBits, r.k);
      const per = this.arrPer * 4 * 8;
      const st = this.statsOf(r.id);
      st.probes++;
      const blocks = this.chainBlocks(r.bloom);
      for (const i of idx) {
        const f = this.pin(blocks[Math.floor(i / per)]);
        const it = this.page(f).item(1);
        const j = i % per;
        const set = it[j >> 3] & (1 << (j & 7));
        this.unpin(f, false);
        if (!set) { st.negatives++; this.emit('bloom', { run: r.id, value: v, maybe: false }); return false; }
      }
      st.positives++;
      this.emit('bloom', { run: r.id, value: v, maybe: true });
      return true;
    }
    statsOf(id) { let s = this.bloomStats.get(id); if (!s) { s = { probes: 0, negatives: 0, positives: 0, falsePositives: 0 }; this.bloomStats.set(id, s); } return s; }

    // ---- reading runs ------------------------------------------------------------------------------------------------------
    /** the entries of a run whose first key column lies in [lo, hi] (either may be absent) */
    readRun(r, lo, hi) {
      let start = r.first;
      if (lo !== undefined) {
        // the index: start at the last data page whose first key is below lo (equal keys may begin there)
        for (const b of this.chainBlocks(r.index)) {
          const f = this.pin(b);
          let stop = false;
          for (const it of this.items(f)) { const e = this.decode(it); if (this.cmpKey([e.key[0]], [lo]) < 0) start = e.b; else { stop = true; break; } }
          this.unpin(f, false);
          if (stop) break;
        }
      }
      const out = [];
      let b = start;
      while (b !== NONE) {
        const f = this.pin(b);
        let past = false;
        for (const it of this.items(f)) {
          const e = this.unpackE(it);
          if (lo !== undefined && this.cmpKey([e.key[0]], [lo]) < 0) continue;
          if (hi !== undefined && this.cmpKey([e.key[0]], [hi]) > 0) { past = true; break; }
          out.push(e);
        }
        const nx = this.sp32(f, 0);
        this.unpin(f, false);
        if (past) break;
        b = nx;
      }
      return out;
    }
    allOf(r) { return this.readRun(r); }

    // ---- the memtable and flushing -----------------------------------------------------------------------------------------
    put(e) {
      const m = this.meta();
      let lo = 0, hi = this.memtable.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (this.cmpE(this.memtable[mid], e) < 0) lo = mid + 1; else hi = mid; }
      e.seq = ++this.opSeq;
      if (lo < this.memtable.length && this.cmpE(this.memtable[lo], e) === 0) this.memtable[lo] = e; else this.memtable.splice(lo, 0, e);
      this.db.wal.log({ type: 'lsm.put', rel: this.idx.oid, file: this.file, data: { key: e.key.map((v) => K.keyOf(v)), b: e.b, o: e.o, tomb: e.tomb } });
      m.userWrites++;
      if (e.tomb) m.tombstones++;
      if (this.memtable.length >= m.memSize) this.flush(m);
      this.saveMeta(m);
    }
    insert(vals, tid, ctx) {
      const key = this.keyOf(vals, ctx).map((v) => (v === undefined ? null : v));
      this.emit('insert', { key, tid });
      this.put({ key, b: tid.b, o: tid.o, tomb: false });
    }
    /** write the memtable out as a run, then compact as the policy says */
    flush(m) {
      const own = !m;
      m = m || this.meta();
      if (!this.memtable.length) return;
      const entries = this.memtable.map((e) => ({ key: e.key, b: e.b, o: e.o, tomb: e.tomb }));
      this.memtable = [];
      m.flushes++;
      if (POLICIES[m.policy] === 'leveled') {
        // the memtable is merged straight into level 1
        const l1 = this.runs(m).filter((r) => r.level === 1);
        const r = this.merge(m, entries, l1, 1);
        this.note(m, 'flush', { run: r && r.id, entries: entries.length, level: 1, merged: l1.map((x) => x.id) });
      } else {
        const r = this.writeRun(m, entries, 1);
        this.note(m, 'flush', { run: r.id, entries: entries.length, level: 1 });
      }
      this.compact(m);
      if (own) this.saveMeta(m);
    }
    /** merge runs (and fresh entries newer than all of them) into one run on a level */
    merge(m, fresh, runs, level) {
      const all = this.runs(m);
      // older entries live on in any run left out of the merge on the target level or below it
      const deeper = all.some((r) => r.level >= level && !runs.some((x) => x.id === r.id));
      const seen = new Map();
      for (const e of fresh || []) seen.set(this.idOf(e), e);
      for (const r of runs.slice().sort((a, b) => a.level - b.level || b.id - a.id)) for (const e of this.allOf(r)) { const id = this.idOf(e); if (!seen.has(id)) seen.set(id, e); }
      let out = [...seen.values()];
      // at the bottom nothing older is left to hide: tombstones and what they shadow are both dropped
      const dropped = deeper ? 0 : out.filter((e) => e.tomb).length;
      if (!deeper) out = out.filter((e) => !e.tomb);
      out.sort((a, b) => this.cmpE(a, b));
      for (const r of runs) { this.dropDesc(m, r.id); this.freeChain(m, r.first); this.freeChain(m, r.index); this.freeChain(m, r.bloom); this.bloomStats.delete(r.id); }
      const nr = out.length ? this.writeRun(m, out, level) : null;
      if (runs.length) { m.compactions++; this.note(m, 'compaction', { level, from: runs.map((r) => ({ id: r.id, level: r.level, n: r.n })), into: nr && nr.id, entries: out.length, tombstonesDropped: dropped }); }
      return nr;
    }
    levelCap(m, level) { return m.memSize * m.ratio ** level; }
    compact(m) {
      for (let changed = true; changed;) {
        changed = false;
        const runs = this.runs(m);
        const levels = [...new Set(runs.map((r) => r.level))].sort((a, b) => a - b);
        for (const lv of levels) {
          const here = runs.filter((r) => r.level === lv);
          if (POLICIES[m.policy] === 'tiered') {
            if (here.length >= m.ratio) { this.merge(m, null, here, lv + 1); changed = true; break; }
          } else if (here.reduce((a, r) => a + r.n, 0) > this.levelCap(m, lv)) {
            this.merge(m, null, here.concat(runs.filter((r) => r.level === lv + 1)), lv + 1);
            changed = true; break;
          }
        }
      }
    }
    /** merge everything into one run (a major compaction) */
    compactAll() {
      const m = this.meta();
      const runs = this.runs(m);
      const fresh = this.memtable.map((e) => ({ key: e.key, b: e.b, o: e.o, tomb: e.tomb }));
      this.memtable = [];
      if (fresh.length) m.flushes++;
      const bottom = Math.max(1, ...runs.map((r) => r.level));
      this.merge(m, fresh, runs, bottom);
      this.saveMeta(m);
    }

    // ---- searching ---------------------------------------------------------------------------------------------------------
    /** the live entries matching the bounds: the memtable, then each run newest first; the newest version wins */
    collect(bounds) {
      const b0 = bounds.filter((b) => b.k === 0);
      const eq = b0.find((b) => b.op === '=');
      const inl = b0.find((b) => b.op === 'in');
      let lo, hi;
      for (const b of b0) {
        if (b.v === null && b.op !== 'in') continue;
        if (b.op === '>' || b.op === '>=') { if (lo === undefined || this.cmpKey([b.v], [lo]) > 0) lo = b.v; }
        if (b.op === '<' || b.op === '<=') { if (hi === undefined || this.cmpKey([b.v], [hi]) < 0) hi = b.v; }
      }
      if (this.dirs[0] < 0) [lo, hi] = [hi, lo];
      const points = eq ? [eq.v] : inl ? inl.v.filter((v) => v !== null) : null;
      if (eq && eq.v === null) return [];
      const seen = new Map();
      const take = (e) => { const id = this.idOf(e); if (!seen.has(id)) seen.set(id, e); };
      for (const e of this.memtable) take(e);
      for (const r of this.runs()) {
        if (points) {
          for (const v of points) {
            if (this.cmpKey([v], [r.minKey[0]]) < 0 || this.cmpKey([v], [r.maxKey[0]]) > 0) continue;
            if (!this.mayContain(r, v)) continue;
            const got = this.readRun(r, v, v).filter((e) => this.cmpKey([e.key[0]], [v]) === 0);
            if (!got.length) this.statsOf(r.id).falsePositives++;
            got.forEach(take);
          }
          continue;
        }
        if (lo !== undefined && this.cmpKey([r.maxKey[0]], [lo]) < 0) continue;
        if (hi !== undefined && this.cmpKey([r.minKey[0]], [hi]) > 0) continue;
        this.readRun(r, lo, hi).forEach(take);
      }
      return [...seen.values()].filter((e) => !e.tomb && this.matches(e.key, bounds));
    }
    *search(bounds, backward) {
      const out = this.collect(bounds).sort((a, b) => this.cmpE(a, b) * (backward ? -1 : 1));
      for (const e of out) yield { b: e.b, o: e.o, key: e.key };
    }

    // ---- removing ----------------------------------------------------------------------------------------------------------
    /** VACUUM: a tombstone for every entry whose heap tuple is dead */
    vacuum(isDead) {
      const dead = this.collect([]).filter((e) => isDead({ b: e.b, o: e.o }));
      for (const e of dead) this.put({ key: e.key, b: e.b, o: e.o, tomb: true });
      this.emit('vacuum', { tombstones: dead.length });
      return dead.length;
    }
    /** delete one entry with a tombstone (the playground's delete) */
    deleteEntry(key, tid) {
      const live = this.collect(key.map((v, k) => (v === null ? { k, op: 'isnull' } : { k, op: '=', v })));
      const e = tid ? live.find((x) => x.b === tid.b && x.o === tid.o) : live[0];
      if (!e) return false;
      this.emit('delete', { key, tid: { b: e.b, o: e.o } });
      this.put({ key: e.key, b: e.b, o: e.o, tomb: true });
      return true;
    }

    describe() {
      return this.muted(() => {
        const m = this.meta();
        const runs = this.runs(m);
        const levels = [...new Set(runs.map((r) => r.level))].sort((a, b) => a - b).map((lv) => ({
          level: lv,
          capacity: POLICIES[m.policy] === 'leveled' ? this.levelCap(m, lv) : null,
          maxRuns: POLICIES[m.policy] === 'tiered' ? m.ratio : 1,
          runs: runs.filter((r) => r.level === lv).map((r) => {
            const bits = this.bloomBitsOf(r);
            let set = 0; for (let i = 0; i < r.bloomBits; i++) if (bits[i >> 3] & (1 << (i & 7))) set++;
            const distinct = Math.max(1, Math.round(r.bloomBits / m.bloomBits));
            const st = this.statsOf(r.id);
            const pages = this.chainBlocks(r.first).map((b) => { const f = this.pin(b); const entries = this.items(f).map((it) => { const e = this.unpackE(it); return { key: e.key, tid: { b: e.b, o: e.o }, tomb: e.tomb }; }); this.unpin(f, false); return { block: b, entries }; });
            return {
              id: r.id, entries: r.n, tombstones: r.ntomb, minKey: r.minKey, maxKey: r.maxKey, pages, indexPages: this.chainBlocks(r.index), bloomPages: this.chainBlocks(r.bloom),
              bloom: { bits: r.bloomBits, hashes: r.k, bitsPerKey: m.bloomBits, setBits: set, expectedFp: Math.pow(1 - Math.exp((-r.k * distinct) / r.bloomBits), r.k), probes: st.probes, negatives: st.negatives, positives: st.positives, falsePositives: st.falsePositives, measuredFp: st.negatives + st.falsePositives ? st.falsePositives / (st.negatives + st.falsePositives) : null },
            };
          }),
        }));
        return {
          method: 'lsm', compaction: POLICIES[m.policy], sizeRatio: m.ratio, meta: 0, manifestPages: this.chainBlocks(m.manifest),
          memtable: { capacity: m.memSize, size: this.memtable.length, entries: this.memtable.map((e) => ({ key: e.key, tid: { b: e.b, o: e.o }, tomb: e.tomb })) },
          levels, bloomOptions: { bitsPerKey: m.bloomBits, hashes: m.bloomK, on: 'the first key column' },
          stats: { flushes: m.flushes, compactions: m.compactions, entriesWritten: m.written, userWrites: m.userWrites, tombstones: m.tombstones, writeAmplification: m.userWrites ? m.written / m.userWrites : 0, runs: runs.length },
        };
      });
    }
  }

  K.LSMTree = LSMTree;
  K.INDEX_AMS.lsm = (db, idx) => new LSMTree(db, idx);
})(typeof window !== 'undefined' ? window : globalThis);
