// Hash indexes on pages, in three schemes (CREATE INDEX ... USING hash (col) WITH (scheme = '...')):
//
//   linear      (the default) Litwin's linear hashing, the scheme PostgreSQL's hash index follows: buckets are
//               split one at a time in order, at the split pointer, whenever the load factor passes the fill
//               factor; bucket b = h mod (n0 * 2^level), or h mod (n0 * 2^(level+1)) if that is below the pointer.
//   static      a fixed number of buckets (option buckets, default 4); a full bucket grows a chain of overflow pages.
//   extendible  a directory of 2^global-depth slots addressed by the high-order bits of the hash (as in the
//               the usual scheme); each bucket has a local depth; a full bucket splits, doubling the directory when its
//               local depth equals the global depth. Keys whose hashes cannot be told apart, and buckets past
//               option max_depth (default 10), go to overflow pages.
//
// The hash is FNV-1a (32 bits) of the key's canonical text (K.indexHashText). Bucket capacity is what fits on a
// page, or option bucket_size entries for teaching. NULL keys are not indexed (as in PostgreSQL).
//
// Block 0 is the meta page (fields below). The bucket table (static, linear: bucket number -> primary page) or
// the directory (extendible: slot -> primary page) is an array of block numbers on its own page chain.
// Bucket page special area: bucket number (4), next overflow page (4), local depth (4), flags (4).
// Entry: hash code (4), then the B+ tree's entry encoding of (key, heap TID).
(function (root) {
  'use strict';
  const K = root.K;
  const NONE = K.INDEX_NONE;
  const FIELDS = ['magic', 'scheme', 'nbuckets', 'level', 'next', 'n0', 'ntuples', 'dir', 'dirSize', 'splits', 'doublings', 'overflows', 'free', 'cap', 'fill', 'merges', 'halvings', 'seq'];
  const SCHEMES = ['static', 'linear', 'extendible'];
  const MAGIC = 0x48415348;
  const PF = { PRIMARY: 1, OVERFLOW: 2, FREE: 4 };

  class HashIndex extends K.IndexBase {
    constructor(db, idx) {
      super(db, idx, 'hash');
      if (!this.nblocks()) this.init();
      const m = this.meta();
      this.scheme = SCHEMES[m.scheme];
      // past this global depth a full bucket overflows instead of doubling the directory again
      this.maxDepth = K.clamp(Math.floor(this.opt('max_depth', 10)), 1, 24);
    }
    init() {
      const scheme = this.optStr('scheme', 'linear').replace(/[^a-z]/g, '');
      const s = SCHEMES.indexOf(scheme === 'linearhashing' ? 'linear' : scheme);
      if (s < 0) throw K.err(K.STATE.invalidParameter, 'invalid value for hash option "scheme": "' + scheme + '" (static, linear or extendible)');
      const mf = this.newPage();
      const m = { magic: MAGIC, scheme: s, cap: Math.max(0, Math.floor(this.opt('bucket_size', 0))), fill: K.clamp(Math.floor(this.opt('fillfactor', 75)), 10, 100), free: NONE, dir: NONE, seq: 0 };
      if (SCHEMES[s] === 'extendible') {
        m.level = 0; m.nbuckets = 1; m.dirSize = 1;
        m.dir = this.arrGrow(NONE, 1);
        this.arrSet(m.dir, 0, this.newBucket(m, 0, 0));
      } else {
        m.n0 = Math.max(1, Math.floor(this.opt('buckets', SCHEMES[s] === 'static' ? 4 : 2)));
        m.nbuckets = m.n0; m.level = 0; m.next = 0; m.dirSize = m.n0;
        m.dir = this.arrGrow(NONE, m.n0);
        for (let i = 0; i < m.n0; i++) this.arrSet(m.dir, i, this.newBucket(m, i, 0));
      }
      this.writeFields(0, FIELDS, m, mf);
    }
    meta() { return this.readFields(0, FIELDS); }
    saveMeta(m) { this.writeFields(0, FIELDS, m); }
    height() { return 1; }

    // ---- bucket pages ------------------------------------------------------------------------------------------------
    newBucket(m, no, depth) { const f = this.newPage(); this.setSp32(f, 0, no); this.setSp32(f, 1, NONE); this.setSp32(f, 2, depth); this.setSp32(f, 3, PF.PRIMARY); const b = f.block; this.unpin(f, true); return b; }
    /** an overflow page: from the free list if it has one */
    newOverflow(m, no) {
      let f;
      if (m.free !== NONE) { f = this.pin(m.free); m.free = this.sp32(f, 1); this.page(f).init(K.INDEX_SPECIAL); } else f = this.newPage();
      this.setSp32(f, 0, no); this.setSp32(f, 1, NONE); this.setSp32(f, 2, 0); this.setSp32(f, 3, PF.OVERFLOW);
      m.overflows++;
      return f;
    }
    freePage(m, block) { const f = this.pin(block); this.page(f).init(K.INDEX_SPECIAL); this.setSp32(f, 0, NONE); this.setSp32(f, 1, m.free); this.setSp32(f, 3, PF.FREE); m.free = block; m.overflows--; this.unpin(f, true); this.emit('free', { block }); }
    chain(block) { const out = []; while (block !== NONE) { out.push(block); const f = this.pin(block); const nx = this.sp32(f, 1); this.unpin(f, false); block = nx; } return out; }
    entry(h, key, tid) { const e = this.encode(key, tid.b, tid.o); const out = new Uint8Array(e.length + 4); new DataView(out.buffer).setUint32(0, h >>> 0, true); out.set(e, 4); return out; }
    unpack(bytes) { const h = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true); const e = this.decode(bytes.subarray(4)); return { h, key: e.key, b: e.b, o: e.o }; }
    roomFor(m, f, len) { return (!m.cap || this.page(f).nslots < m.cap) && this.fits(f, len); }
    /** the entries of a bucket's chain */
    bucketEntries(block) { const out = []; for (const b of this.chain(block)) { const f = this.pin(b); for (const it of this.items(f)) out.push(it); this.unpin(f, false); } return out; }
    /** add to a bucket's chain; with noOverflow, give up (false) instead of adding an overflow page */
    addToChain(m, block, bytes, noOverflow) {
      let b = block, last = null;
      while (b !== NONE) {
        const f = this.pin(b);
        if (this.roomFor(m, f, bytes.length)) { this.page(f).add(bytes, 4); this.unpin(f, true); return true; }
        const nx = this.sp32(f, 1);
        if (nx === NONE) last = f; else this.unpin(f, false);
        b = nx;
      }
      if (noOverflow) { this.unpin(last, false); return false; }
      const no = this.sp32(last, 0);
      const of = this.newOverflow(m, no);
      this.page(of).add(bytes, 4);
      this.setSp32(last, 1, of.block);
      this.note(m, 'overflow', { bucket: no, block: last.block, overflow: of.block });
      this.unpin(of, true); this.unpin(last, true);
      return true;
    }
    /** put these entries in a bucket's chain from the start, freeing the overflow pages no longer needed */
    rewriteChain(m, block, entries) {
      const pages = this.chain(block);
      let i = 0, prev = null;
      for (let k = 0; k < pages.length; k++) {
        if (k > 0 && i >= entries.length) {
          if (prev) { this.setSp32(prev, 1, NONE); this.unpin(prev, true); prev = null; }
          this.freePage(m, pages[k]);
          continue;
        }
        const f = this.pin(pages[k]);
        const keep = [this.sp32(f, 0), this.sp32(f, 1), this.sp32(f, 2), this.sp32(f, 3)];
        this.page(f).init(K.INDEX_SPECIAL);
        keep.forEach((v, j) => this.setSp32(f, j, v));
        while (i < entries.length && this.roomFor(m, f, entries[i].length)) this.page(f).add(entries[i++], 4);
        if (prev) this.unpin(prev, true);
        prev = f;
      }
      if (prev) this.unpin(prev, true);
      while (i < entries.length) this.addToChain(m, block, entries[i++]);
    }

    // ---- addressing ----------------------------------------------------------------------------------------------------
    /** the bucket number (static, linear) or directory slot (extendible) of a hash code */
    bucketOf(m, h) {
      const s = SCHEMES[m.scheme];
      if (s === 'static') return h % m.n0;
      if (s === 'extendible') return m.level ? h >>> (32 - m.level) : 0;
      const span = m.n0 * 2 ** m.level;
      const b = h % span;
      return b < m.next ? h % (span * 2) : b;
    }
    blockOf(m, h) { return this.arrGet(m.dir, this.bucketOf(m, h)); }
    hashOf(v) {
      const key = Array.isArray(v) ? v : [v];
      const text = K.indexHashText(key, this.keyTypes), h = K.fnv(text);
      const m = this.meta();
      return { text, hash: h, hex: K.hex(h, 8), bin: K.bits32(h), bucket: this.bucketOf(m, h), scheme: SCHEMES[m.scheme] };
    }
    capOf(m, len) { return m.cap || this.perPage(len); }

    // ---- inserting -----------------------------------------------------------------------------------------------------
    insert(vals, tid, ctx) {
      const key = this.keyOf(vals, ctx);
      if (key.some((v) => v === null || v === undefined)) return;
      const h = this.hashKey(key);
      const bytes = this.entry(h, key, tid);
      const m = this.meta();
      this.emit('insert', { key, tid, hash: h, bucket: this.bucketOf(m, h) });
      if (SCHEMES[m.scheme] === 'extendible') this.insertExtendible(m, h, bytes);
      else this.addToChain(m, this.blockOf(m, h), bytes);
      m.ntuples++;
      // linear hashing splits the bucket at the pointer whenever the load factor passes the fill factor
      if (SCHEMES[m.scheme] === 'linear') while (m.ntuples > (m.fill / 100) * this.capOf(m, bytes.length) * m.nbuckets) this.splitLinear(m);
      this.saveMeta(m);
    }
    insertExtendible(m, h, bytes) {
      for (;;) {
        const slot = this.bucketOf(m, h);
        const block = this.arrGet(m.dir, slot);
        if (this.addToChain(m, block, bytes, true)) return;
        const f = this.pin(block);
        const depth = this.sp32(f, 2);
        this.unpin(f, false);
        // splitting cannot separate entries whose hash codes are all equal (duplicate keys): they overflow instead
        const hs = this.bucketEntries(block).map((e) => new DataView(e.buffer, e.byteOffset).getUint32(0, true));
        if (!hs.some((y) => y !== h) || depth >= this.maxDepth) { this.addToChain(m, block, bytes); return; }
        if (depth === m.level) this.doubleDirectory(m);
        this.splitExtendible(m, block, depth);
      }
    }
    doubleDirectory(m) {
      const n = 2 ** m.level;
      m.dir = this.arrGrow(m.dir, n * 2);
      const old = this.arrAll(m.dir, n);
      for (let j = 2 * n - 1; j >= 0; j--) this.arrSet(m.dir, j, old[j >> 1]);
      m.level++; m.dirSize = n * 2; m.doublings++;
      this.note(m, 'double', { globalDepth: m.level, slots: n * 2 });
    }
    splitExtendible(m, block, depth) {
      const entries = this.bucketEntries(block);
      const nb = this.newBucket(m, ++m.seq, depth + 1);
      const f = this.pin(block); this.setSp32(f, 2, depth + 1); this.unpin(f, true);
      const bit = (e) => (new DataView(e.buffer, e.byteOffset).getUint32(0, true) >>> (31 - depth)) & 1;
      this.rewriteChain(m, block, entries.filter((e) => !bit(e)));
      this.rewriteChain(m, nb, entries.filter((e) => bit(e)));
      const dir = this.arrAll(m.dir, m.dirSize);
      for (let j = 0; j < dir.length; j++) if (dir[j] === block && (j >>> (m.level - depth - 1)) & 1) this.arrSet(m.dir, j, nb);
      m.nbuckets++; m.splits++;
      this.note(m, 'split', { block, newBlock: nb, localDepth: depth + 1, globalDepth: m.level });
    }
    splitLinear(m) {
      const span = m.n0 * 2 ** m.level;
      const s = m.next, ns = s + span;
      const block = this.arrGet(m.dir, s);
      m.dir = this.arrGrow(m.dir, ns + 1);
      const nb = this.newBucket(m, ns, 0);
      this.arrSet(m.dir, ns, nb);
      const entries = this.bucketEntries(block);
      const moves = (e) => new DataView(e.buffer, e.byteOffset).getUint32(0, true) % (span * 2) !== s;
      this.rewriteChain(m, block, entries.filter((e) => !moves(e)));
      this.rewriteChain(m, nb, entries.filter(moves));
      m.next++; m.nbuckets++; m.dirSize = m.nbuckets; m.splits++;
      if (m.next === span) { m.level++; m.next = 0; }
      this.note(m, 'split', { bucket: s, newBucket: ns, block, newBlock: nb, level: m.level, next: m.next, moved: entries.filter(moves).length });
    }

    // ---- searching -----------------------------------------------------------------------------------------------------
    /** the entries with exactly this key: one bucket's chain, comparing stored hash codes first */
    lookup(key) {
      const h = this.hashKey(key);
      const m = this.meta();
      const out = [];
      for (const b of this.chain(this.blockOf(m, h))) {
        const f = this.pin(b);
        for (const it of this.items(f)) {
          if (new DataView(it.buffer).getUint32(0, true) !== h) continue;
          const e = this.unpack(it);
          if (this.sameKey(e.key, key)) out.push({ b: e.b, o: e.o, key: e.key });
        }
        this.unpin(f, false);
      }
      return out;
    }
    *search(bounds, backward) {
      const eqs = [];
      for (let k = 0; k < this.nk; k++) { const b = bounds.find((x) => x.k === k && (x.op === '=' || x.op === 'in')); if (!b) break; eqs.push(b); }
      if (eqs.length === this.nk && bounds.every((b) => b.op === '=' || b.op === 'in')) {
        // a probe per key value (IN lists are probed value by value)
        let keys = [[]];
        for (const b of eqs) { const vs = b.op === 'in' ? b.v.filter((v) => v !== null) : [b.v]; keys = keys.flatMap((p) => vs.map((v) => p.concat([v]))); }
        if (keys.some((k) => k.some((v) => v === null || v === undefined))) return;
        const seen = new Set();
        for (const key of keys) {
          const ht = K.indexHashText(key, this.keyTypes);
          if (seen.has(ht)) continue;
          seen.add(ht);
          for (const e of this.lookup(key)) if (this.matches(e.key, bounds)) yield e;
        }
        return;
      }
      // anything else reads every bucket: hash order says nothing about key order
      const all = this.allEntries().filter((e) => this.matches(e.key, bounds));
      all.sort((a, b) => this.cmpKT(a, b) * (backward ? -1 : 1));
      for (const e of all) yield { b: e.b, o: e.o, key: e.key };
    }
    *find(key) { if (key.some((v) => v === null || v === undefined)) return; yield* this.lookup(key); }
    bucketBlocks(m) { const dir = this.arrAll(m.dir, m.dirSize); return SCHEMES[m.scheme] === 'extendible' ? [...new Set(dir)] : dir.slice(0, m.nbuckets); }
    allEntries() { const m = this.meta(); const out = []; for (const b of this.bucketBlocks(m)) for (const it of this.bucketEntries(b)) out.push(this.unpack(it)); return out; }

    // ---- removing ------------------------------------------------------------------------------------------------------
    /** VACUUM: drop entries of dead tuples bucket by bucket, squeezing each chain (as PostgreSQL's hashbucketcleanup does) */
    vacuum(isDead) {
      const m = this.meta();
      let removed = 0;
      for (const block of this.bucketBlocks(m)) {
        const entries = this.bucketEntries(block);
        const keep = entries.filter((e) => { const x = this.unpack(e); return !isDead({ b: x.b, o: x.o }); });
        if (keep.length === entries.length) continue;
        removed += entries.length - keep.length;
        this.rewriteChain(m, block, keep);
      }
      m.ntuples -= Math.min(m.ntuples, removed);
      this.saveMeta(m);
      return removed;
    }
    /** remove one entry (the playground's delete); extendible buckets merge with their buddy and the directory halves */
    deleteEntry(key, tid) {
      const h = this.hashKey(key);
      const m = this.meta();
      const slot = this.bucketOf(m, h);
      const block = this.arrGet(m.dir, slot);
      const entries = this.bucketEntries(block);
      const i = entries.findIndex((e) => { const x = this.unpack(e); return x.h === h && (!tid || (x.b === tid.b && x.o === tid.o)) && this.sameKey(x.key, key); });
      if (i < 0) return false;
      entries.splice(i, 1);
      this.rewriteChain(m, block, entries);
      m.ntuples--;
      this.emit('delete', { key, tid, hash: h, bucket: slot });
      if (SCHEMES[m.scheme] === 'extendible') this.coalesce(m, slot);
      this.saveMeta(m);
      return true;
    }
    coalesce(m, slot) {
      for (;;) {
        const block = this.arrGet(m.dir, slot);
        const f = this.pin(block); const depth = this.sp32(f, 2); this.unpin(f, false);
        if (depth === 0) break;
        // the buddy differs in the last bit of the local depth
        const shift = m.level - depth;
        const buddySlot = slot ^ (1 << shift);
        const buddy = this.arrGet(m.dir, buddySlot);
        const bf = this.pin(buddy); const bdepth = this.sp32(bf, 2); this.unpin(bf, false);
        if (buddy === block || bdepth !== depth) break;
        const mine = this.bucketEntries(block), theirs = this.bucketEntries(buddy);
        const all = mine.concat(theirs);
        const cap = all.length ? this.capOf(m, Math.max(...all.map((e) => e.length))) : 1;
        if (all.length > cap) break;
        const keep = (slot >>> shift) & 1 ? buddy : block, gone = keep === block ? buddy : block;
        const kf = this.pin(keep); this.setSp32(kf, 2, depth - 1); this.unpin(kf, true);
        this.rewriteChain(m, keep, all);
        this.rewriteChain(m, gone, []);
        const gf = this.pin(gone); this.page(gf).init(K.INDEX_SPECIAL); this.setSp32(gf, 1, m.free); this.setSp32(gf, 3, PF.FREE); this.unpin(gf, true);
        m.free = gone;
        const dir = this.arrAll(m.dir, m.dirSize);
        for (let j = 0; j < dir.length; j++) if (dir[j] === gone) this.arrSet(m.dir, j, keep);
        m.nbuckets--; m.merges++;
        this.note(m, 'merge', { block: keep, gone, localDepth: depth - 1 });
        // the directory halves when no bucket needs all of its bits
        while (m.level > 0) {
          const d = this.arrAll(m.dir, m.dirSize);
          const depths = [...new Set(d)].map((b) => { const x = this.pin(b); const v = this.sp32(x, 2); this.unpin(x, false); return v; });
          if (Math.max(...depths) >= m.level) break;
          const half = m.dirSize / 2;
          for (let j = 0; j < half; j++) this.arrSet(m.dir, j, d[j * 2]);
          m.level--; m.dirSize = half; m.halvings++;
          slot >>>= 1;
          this.note(m, 'halve', { globalDepth: m.level, slots: half });
        }
      }
    }

    // ---- for the index view -----------------------------------------------------------------------------------------------
    describe() {
      return this.muted(() => {
        const m = this.meta();
        const scheme = SCHEMES[m.scheme];
        const dir = this.arrAll(m.dir, m.dirSize);
        const blocks = this.bucketBlocks(m);
        let sampleLen = 0;
        const buckets = blocks.map((block, i) => {
          const pages = this.chain(block).map((b, k) => {
            const f = this.pin(b);
            const entries = this.items(f).map((it) => { sampleLen = Math.max(sampleLen, it.length); const e = this.unpack(it); return { key: e.key, tid: { b: e.b, o: e.o }, hash: e.h, hex: K.hex(e.h, 8), bits: K.bits32(e.h), bucket: this.bucketOf(m, e.h) }; });
            const pg = { block: b, overflow: k > 0, free: this.page(f).free(), entries };
            this.unpin(f, false);
            return pg;
          });
          const f = this.pin(block);
          const out = { bucket: scheme === 'extendible' ? this.sp32(f, 0) : i, block, localDepth: scheme === 'extendible' ? this.sp32(f, 2) : null, count: pages.reduce((a, p) => a + p.entries.length, 0), pages };
          this.unpin(f, false);
          return out;
        });
        const directory = dir.map((block, slot) => ({ slot, bits: scheme === 'extendible' ? (m.level ? slot.toString(2).padStart(m.level, '0') : '') : null, block, bucket: (buckets.find((b) => b.block === block) || {}).bucket }));
        return {
          method: 'hash', scheme, meta: 0,
          hashFunction: 'FNV-1a, 32 bits, of the key text (numbers by value, so 1, 1.0 and 1::bigint hash alike)',
          maxDepth: scheme === 'extendible' ? this.maxDepth : null,
          addressing: scheme === 'static' ? 'bucket = h mod ' + m.n0 : scheme === 'linear' ? 'bucket = h mod ' + m.n0 * 2 ** m.level + ', or h mod ' + m.n0 * 2 ** (m.level + 1) + ' if that is below the split pointer ' + m.next : 'slot = the first ' + m.level + ' bits of h',
          bucketCapacity: m.cap || (sampleLen ? this.perPage(sampleLen) : null), bucketSizeOption: m.cap || null, fillfactor: m.fill,
          nbuckets: m.nbuckets, initialBuckets: m.n0 || null, level: scheme === 'linear' ? m.level : null, next: scheme === 'linear' ? m.next : null, globalDepth: scheme === 'extendible' ? m.level : null,
          ntuples: m.ntuples, loadFactor: m.nbuckets ? m.ntuples / (m.nbuckets * (m.cap || (sampleLen ? this.perPage(sampleLen) : 1))) : 0,
          stats: { splits: m.splits, doublings: m.doublings, merges: m.merges, halvings: m.halvings, overflowPages: m.overflows, freePages: this.chainFree(m.free) },
          directory, directoryPages: this.arrBlocks(m.dir), buckets,
        };
      });
    }
    chainFree(b) { let n = 0; while (b !== NONE) { n++; const f = this.pin(b); const nx = this.sp32(f, 1); this.unpin(f, false); b = nx; } return n; }
  }

  K.HashIndex = HashIndex;
  K.INDEX_AMS.hash = (db, idx) => new HashIndex(db, idx);
})(typeof window !== 'undefined' ? window : globalThis);
