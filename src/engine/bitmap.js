// Bitmap indexes (CREATE INDEX ... USING bitmap (col)): one bitmap per distinct key value (NULL included) with
// one bit per possible heap tuple slot, bit = block * N + (item - 1) where N is the most tuples a heap page
// can hold. The bitmaps are compressed with WAH, the word-aligned hybrid code:
//
//   literal word  0xxxxxxx...  the low 31 bits are 31 bitmap bits as they are
//   fill word     1fnnnnnn...  a run of n groups of 31 bits, all equal to f
//
// so long runs of zeros (the rows that do not have this value) take one word. AND and OR work on the
// compressed words directly, run against run (K.Bitmap.and/or), which is what a bitmap scan combines.
//
// Block 0 is the meta page. The key directory is a chain of pages whose entries are (words, set bits) and the
// B+ tree's encoding of (key, first bitmap page). A bitmap is a chain of pages each holding a run of words.
// Page special area: next page in the chain (4).
(function (root) {
  'use strict';
  const K = root.K;
  const NONE = K.INDEX_NONE;
  const FIELDS = ['magic', 'nkeys', 'dir', 'bitsPerBlock', 'ntuples', 'free'];
  const MAGIC = 0x4249544d;
  const FILL = 0x80000000, FILLBIT = 0x40000000, LEN = 0x3fffffff, LIT = 0x7fffffff;

  /** a WAH-compressed bitmap: an array of 32-bit words */
  class Bitmap {
    constructor(words) { this.words = words || []; }
    static fromPositions(positions) {
      const ps = [...new Set(positions)].sort((a, b) => a - b);
      const out = new Bitmap();
      let g = 0, i = 0;
      while (i < ps.length) {
        const pg = Math.floor(ps[i] / 31);
        if (pg > g) { out.pushFill(0, pg - g); g = pg; }
        let lit = 0;
        while (i < ps.length && Math.floor(ps[i] / 31) === g) lit |= 1 << (ps[i++] % 31);
        out.pushLit(lit >>> 0);
        g++;
      }
      return out;
    }
    static fromTids(tids, perBlock) { return Bitmap.fromPositions(tids.map((t) => t.b * perBlock + t.o - 1)); }
    pushFill(bit, n) {
      if (n <= 0) return;
      const last = this.words.length ? this.words[this.words.length - 1] : null;
      if (last !== null && last & FILL && !!(last & FILLBIT) === !!bit && (last & LEN) + n <= LEN) { this.words[this.words.length - 1] = (last + n) >>> 0; return; }
      this.words.push((FILL | (bit ? FILLBIT : 0) | n) >>> 0);
    }
    pushLit(v) { if (v === 0) this.pushFill(0, 1); else if (v === LIT) this.pushFill(1, 1); else this.words.push(v >>> 0); }
    /** the words as runs: { fill: 0|1, n } or { lit, n: 1 } */
    *runs() { for (const w of this.words) { if (w & FILL) yield { fill: w & FILLBIT ? 1 : 0, n: w & LEN }; else yield { lit: w, n: 1 }; } }
    *positions() {
      let g = 0;
      for (const r of this.runs()) {
        if (r.fill === 1) { for (let i = 0; i < r.n * 31; i++) yield g * 31 + i; } else if (r.lit !== undefined) { for (let i = 0; i < 31; i++) if (r.lit & (1 << i)) yield g * 31 + i; }
        g += r.n;
      }
    }
    count() { let n = 0; for (const r of this.runs()) n += r.fill === 1 ? r.n * 31 : r.lit !== undefined ? popcount(r.lit) : 0; return n; }
    has(pos) { for (const p of this.positions()) { if (p === pos) return true; if (p > pos) return false; } return false; }
    with(pos, on) { const ps = [...this.positions()].filter((p) => p !== pos); if (on) ps.push(pos); return Bitmap.fromPositions(ps); }
    groups() { let n = 0; for (const r of this.runs()) n += r.n; return n; }
    get bytes() { return this.words.length * 4; }
    /** bits covered without compression, in bytes */
    get rawBytes() { return Math.ceil((this.groups() * 31) / 8); }
    /** combine two compressed bitmaps without decompressing them: runs are consumed in step */
    static combine(a, b, op) {
      const out = new Bitmap();
      const ia = a.runs(), ib = b.runs();
      let ra = null, rb = null;
      const next = (it) => { const x = it.next(); return x.done ? null : Object.assign({}, x.value); };
      ra = next(ia); rb = next(ib);
      while (ra || rb) {
        // the shorter bitmap continues as zeros
        const x = ra || { fill: 0, n: rb.n }, y = rb || { fill: 0, n: ra.n };
        const n = Math.min(x.n, y.n);
        if (x.fill !== undefined && y.fill !== undefined) out.pushFill(op(x.fill, y.fill) & 1, n);
        else {
          const lx = x.fill !== undefined ? (x.fill ? LIT : 0) : x.lit, ly = y.fill !== undefined ? (y.fill ? LIT : 0) : y.lit;
          out.pushLit((op(lx, ly) & LIT) >>> 0);
        }
        if (ra) { ra.n -= n; if (!ra.n) ra = next(ia); }
        if (rb) { rb.n -= n; if (!rb.n) rb = next(ib); }
      }
      return out;
    }
    static and(a, b) { return Bitmap.combine(a, b, (x, y) => x & y); }
    static or(a, b) { return Bitmap.combine(a, b, (x, y) => x | y); }
    static andNot(a, b) { return Bitmap.combine(a, b, (x, y) => x & ~y); }
    /** the words spelled out for the view */
    describe() {
      return {
        words: this.words.map((w) => (w & FILL ? { type: 'fill', bit: w & FILLBIT ? 1 : 0, groups: w & LEN, bits: (w & LEN) * 31, hex: K.hex(w, 8) } : { type: 'literal', bits: (w >>> 0).toString(2).padStart(31, '0').split('').reverse().join(''), hex: K.hex(w, 8) })),
        count: this.count(), bytes: this.bytes, rawBytes: this.rawBytes,
      };
    }
  }
  const popcount = (v) => { let n = 0; while (v) { v &= v - 1; n++; } return n; };

  class BitmapIndex extends K.IndexBase {
    constructor(db, idx) {
      super(db, idx, 'bitmap');
      if (!this.nblocks()) this.init();
      this.perBlock = this.meta().bitsPerBlock;
    }
    init() {
      const mf = this.newPage();
      // the most tuples a heap page holds: each needs a line pointer and at least an aligned header
      const per = Math.floor((this.pageSize - K.PAGE_HDR) / (((K.Tuple.HEADER + 7) & ~7) + 4));
      const m = { magic: MAGIC, nkeys: 0, dir: NONE, bitsPerBlock: per, ntuples: 0, free: NONE };
      m.dir = this.chainPage(m);
      this.writeFields(0, FIELDS, m, mf);
    }
    meta() { return this.readFields(0, FIELDS); }
    saveMeta(m) { this.writeFields(0, FIELDS, m); }
    height() { return 1; }
    chainPage(m) {
      let f;
      if (m && m.free !== NONE) { f = this.pin(m.free); m.free = this.sp32(f, 0); this.page(f).init(K.INDEX_SPECIAL); } else f = this.newPage();
      this.setSp32(f, 0, NONE);
      const b = f.block;
      this.unpin(f, true);
      return b;
    }
    pos(tid) { return tid.b * this.perBlock + tid.o - 1; }
    tid(pos) { return { b: Math.floor(pos / this.perBlock), o: (pos % this.perBlock) + 1 }; }

    // ---- the key directory ---------------------------------------------------------------------------------------------
    dirEntry(key, first, words, count) {
      const e = this.encode(key, first, 0);
      const out = new Uint8Array(e.length + 8);
      const dv = new DataView(out.buffer);
      dv.setUint32(0, words >>> 0, true); dv.setUint32(4, count >>> 0, true);
      out.set(e, 8);
      return out;
    }
    readDir(bytes) { const dv = new DataView(bytes.buffer, bytes.byteOffset); const e = this.decode(bytes.subarray(8)); return { key: e.key, first: e.b, words: dv.getUint32(0, true), count: dv.getUint32(4, true) }; }
    /** every directory entry with where it is: { block, i, key, first, words, count } */
    directory(m) {
      const out = [];
      let b = m.dir;
      while (b !== NONE) {
        const f = this.pin(b);
        const p = this.page(f);
        for (let i = 1; i <= p.nslots; i++) { const it = p.item(i); if (it) out.push(Object.assign({ block: b, i }, this.readDir(it))); }
        const nx = this.sp32(f, 0);
        this.unpin(f, false);
        b = nx;
      }
      return out;
    }
    setDir(d) {
      const f = this.pin(d.block);
      const bytes = this.dirEntry(d.key, d.first, d.words, d.count);
      const p = this.page(f);
      if (!p.overwrite(d.i, bytes)) throw K.err(K.STATE.internal, 'bitmap directory entry changed size');
      this.unpin(f, true);
    }
    addDir(m, key) {
      const bytes = this.dirEntry(key, NONE, 0, 0);
      let b = m.dir;
      for (;;) {
        const f = this.pin(b);
        if (this.fits(f, bytes.length)) { const i = this.page(f).add(bytes, 4); this.unpin(f, true); m.nkeys++; this.emit('newkey', { key }); return { block: b, i, key, first: NONE, words: 0, count: 0 }; }
        let nx = this.sp32(f, 0);
        if (nx === NONE) { nx = this.chainPage(m); this.setSp32(f, 0, nx); this.unpin(f, true); } else this.unpin(f, false);
        b = nx;
      }
    }

    // ---- bitmaps on pages ----------------------------------------------------------------------------------------------
    get wordsPer() { return this.arrPer; }
    readBitmap(first) {
      const words = [];
      let b = first;
      while (b !== NONE) {
        const f = this.pin(b);
        const it = this.page(f).item(1);
        if (it) { const dv = new DataView(it.buffer, it.byteOffset, it.byteLength); for (let i = 0; i < it.byteLength / 4; i++) words.push(dv.getUint32(i * 4, true)); }
        const nx = this.sp32(f, 0);
        this.unpin(f, false);
        b = nx;
      }
      return new Bitmap(words);
    }
    /** write a bitmap over its page chain (reusing the pages it had); returns the first page */
    writeBitmap(m, first, bm) {
      const pages = first === NONE ? [] : this.blocksOf(first);
      const chunks = [];
      for (let i = 0; i < bm.words.length; i += this.wordsPer) chunks.push(bm.words.slice(i, i + this.wordsPer));
      while (pages.length < chunks.length) pages.push(this.chainPage(m));
      for (let k = 0; k < pages.length; k++) {
        const f = this.pin(pages[k]);
        const p = this.page(f);
        if (k >= chunks.length) { p.init(K.INDEX_SPECIAL); this.setSp32(f, 0, m.free); m.free = pages[k]; this.unpin(f, true); continue; }
        p.init(K.INDEX_SPECIAL);
        const bytes = new Uint8Array(chunks[k].length * 4);
        const dv = new DataView(bytes.buffer);
        chunks[k].forEach((w, i) => dv.setUint32(i * 4, w, true));
        p.add(bytes, 8);
        this.setSp32(f, 0, k + 1 < chunks.length ? pages[k + 1] : NONE);
        this.unpin(f, true);
      }
      return chunks.length ? pages[0] : NONE;
    }
    blocksOf(first) { const out = []; let b = first; while (b !== NONE) { out.push(b); const f = this.pin(b); const nx = this.sp32(f, 0); this.unpin(f, false); b = nx; } return out; }
    /** the bitmap of one key value (empty if the value is not in the index) */
    bitmapOf(v) {
      const key = Array.isArray(v) ? v : [v];
      const d = this.directory(this.meta()).find((x) => this.sameKey(x.key, key));
      return d ? this.readBitmap(d.first) : new Bitmap();
    }
    /** the OR of the bitmaps of every key matching the bounds */
    bitmapFor(bounds) {
      let bm = new Bitmap();
      for (const d of this.directory(this.meta())) if (this.matches(d.key, bounds)) bm = Bitmap.or(bm, this.readBitmap(d.first));
      return bm;
    }

    // ---- the access method -----------------------------------------------------------------------------------------------
    insert(vals, tid, ctx) {
      const key = this.keyOf(vals, ctx).map((v) => (v === undefined ? null : v));
      const m = this.meta();
      if (tid.o > this.perBlock) throw K.err(K.STATE.internal, 'heap item ' + tid.o + ' is past the bitmap index\'s ' + this.perBlock + ' bits per block');
      let d = this.directory(m).find((x) => this.sameKey(x.key, key));
      if (!d) d = this.addDir(m, key);
      const bm = (d.first === NONE ? new Bitmap() : this.readBitmap(d.first)).with(this.pos(tid), true);
      d.first = this.writeBitmap(m, d.first, bm);
      d.words = bm.words.length; d.count = bm.count();
      this.setDir(d);
      m.ntuples++;
      this.saveMeta(m);
      this.emit('insert', { key, tid, bit: this.pos(tid), words: d.words });
    }
    *search(bounds, backward) {
      const m = this.meta();
      const hits = [];
      for (const d of this.directory(m)) {
        if (!this.matches(d.key, bounds)) continue;
        for (const p of this.readBitmap(d.first).positions()) hits.push({ p, key: d.key });
      }
      hits.sort((a, b) => (a.p - b.p) * (backward ? -1 : 1));
      this.emit('scan', { keys: new Set(hits.map((h) => K.keyOf(h.key))).size, bits: hits.length });
      for (const h of hits) { const t = this.tid(h.p); yield { b: t.b, o: t.o, key: h.key }; }
    }
    vacuum(isDead) {
      const m = this.meta();
      let removed = 0;
      const gone = [];
      for (const d of this.directory(m)) {
        const ps = [...this.readBitmap(d.first).positions()];
        const keep = ps.filter((p) => !isDead(this.tid(p)));
        if (keep.length === ps.length) continue;
        removed += ps.length - keep.length;
        const bm = Bitmap.fromPositions(keep);
        d.first = this.writeBitmap(m, d.first, bm);
        d.words = bm.words.length; d.count = keep.length;
        if (keep.length) this.setDir(d); else gone.push(d);
      }
      // keys with no rows left leave the directory (last first, so the item numbers stay right)
      gone.sort((a, b) => b.block - a.block || b.i - a.i);
      for (const d of gone) { const f = this.pin(d.block); this.page(f).removeAt(d.i); this.unpin(f, true); m.nkeys--; }
      m.ntuples -= Math.min(m.ntuples, removed);
      this.saveMeta(m);
      return removed;
    }
    /** clear one row's bit (the playground's delete) */
    deleteEntry(key, tid) {
      const m = this.meta();
      const d = this.directory(m).find((x) => this.sameKey(x.key, key));
      if (!d) return false;
      const bm = this.readBitmap(d.first);
      let pos = tid ? this.pos(tid) : null;
      if (pos === null) { const it = bm.positions().next(); if (it.done) return false; pos = it.value; }
      if (!bm.has(pos)) return false;
      const nb = bm.with(pos, false);
      d.first = this.writeBitmap(m, d.first, nb);
      d.words = nb.words.length; d.count = nb.count();
      if (d.count) this.setDir(d); else { const f = this.pin(d.block); this.page(f).removeAt(d.i); this.unpin(f, true); m.nkeys--; }
      m.ntuples--;
      this.saveMeta(m);
      this.emit('delete', { key, tid: this.tid(pos), bit: pos });
      return true;
    }
    describe() {
      return this.muted(() => {
        const m = this.meta();
        const dir = this.directory(m);
        const keys = dir.map((d) => {
          const bm = this.readBitmap(d.first);
          const x = bm.describe();
          const tids = [...bm.positions()].slice(0, 500).map((p) => this.tid(p));
          return { key: d.key, count: d.count, words: d.words, bytes: x.bytes, rawBytes: x.rawBytes, ratio: x.bytes ? x.rawBytes / x.bytes : null, pages: d.first === NONE ? [] : this.blocksOf(d.first), runs: x.words, tids };
        }).sort((a, b) => this.cmpKey(a.key, b.key));
        return {
          method: 'bitmap', meta: 0,
          compression: 'WAH (word-aligned hybrid), 32-bit words: a literal word (top bit 0) holds 31 bits as they are; a fill word (top bit 1, then the fill bit, then a 30-bit count) stands for that many groups of 31 equal bits',
          tidToBit: 'bit = block * ' + this.perBlock + ' + (item - 1)', bitsPerBlock: this.perBlock,
          nkeys: m.nkeys, ntuples: m.ntuples, directoryPages: this.blocksOf(m.dir), keys,
          bytes: keys.reduce((a, k) => a + k.bytes, 0), rawBytes: keys.reduce((a, k) => a + k.rawBytes, 0),
        };
      });
    }
  }

  K.Bitmap = Bitmap;
  K.BitmapIndex = BitmapIndex;
  K.INDEX_AMS.bitmap = (db, idx) => new BitmapIndex(db, idx);
})(typeof window !== 'undefined' ? window : globalThis);
