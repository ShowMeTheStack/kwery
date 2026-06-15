// What the page-based index structures other than the B+ tree share: pinning and logging their pages, the B+
// tree's entry encoding (key values plus a heap TID), option parsing, matching keys against scan bounds,
// the canonical text a key is hashed from, and arrays of block numbers spread over a chain of pages (hash
// directories, bucket tables). Every page goes through the buffer pool, so each structure's I/O is counted.
(function (root) {
  'use strict';
  const K = root.K;
  const T = () => K.T;
  const NONE = 0xffffffff;
  const SPECIAL = 16;

  const truthy = (v) => v === true || v === 1 || (typeof v === 'string' && /^(on|true|yes|1)$/i.test(v));

  /** the text a value is hashed from: numbers by value whatever their type (1, 1.0, 1::bigint agree), char without trailing blanks */
  function canon(v, t) {
    if (v === null || v === undefined) return 'N';
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return Number.isNaN(v) ? 'fNaN' : v > 0 ? 'f+inf' : 'f-inf';
      return K.Decimal.of(v).key();
    }
    if (typeof v === 'bigint' || v instanceof K.Decimal) return K.Decimal.of(v).key();
    if (typeof v === 'string') {
      if (t && t.cat === 'N') { try { return K.Decimal.parse(v).key(); } catch (e) { /* not a number: hash the text */ } }
      return 's' + (t && t.id === 'char' ? v.replace(/ +$/, '') : v);
    }
    return K.keyOf(v);
  }
  K.indexHashText = (key, types) => key.map((v, i) => canon(v, types && types[i])).join('\u0001');
  K.indexHash = (key, types) => K.fnv(K.indexHashText(key, types));
  K.bits32 = (h) => (h >>> 0).toString(2).padStart(32, '0');

  class IndexBase {
    constructor(db, idx, kind) {
      this.db = db;
      this.idx = idx;
      this.kind = kind;
      this.file = idx.file;
      this.keyTypes = idx.keyTypes;
      this.nk = this.keyTypes.length;
      this.cols = this.keyTypes.map((t) => ({ type: t }));
      this.dirs = idx.keys.map((k) => (k.dir === 'desc' ? -1 : 1));
      this.nullsFirst = idx.keys.map((k) => (k.nulls ? k.nulls === 'first' : k.dir === 'desc'));
    }
    get buf() { return this.db.buffers; }
    get bus() { return this.db.bus; }
    get opts() { return (this.idx && this.idx.options) || {}; }
    get pageSize() { return this.db.disk.pageSize; }
    opt(name, def) { const v = this.opts[name]; if (v === undefined || v === null || v === '') return def; const n = Number(typeof v === 'bigint' ? Number(v) : v instanceof K.Decimal ? v.toNumber() : v); return Number.isFinite(n) ? n : def; }
    optStr(name, def) { const v = this.opts[name]; return v === undefined || v === null ? def : String(v).toLowerCase(); }
    flag(name) { return truthy(this.opts[name]); }
    nblocks() { return this.db.disk.blocks(this.file); }
    emit(what, data) { this.bus.emit(this.kind + '.' + what, Object.assign({ index: this.idx.name }, data)); }
    /** a structural change (split, doubling, compaction ...): the meta page is brought up to date first, so whoever is told can look */
    note(m, what, data) { this.saveMeta(m); this.emit(what, data); }

    // ---- pages --------------------------------------------------------------------------------------------------------
    pin(block) { const f = this.buf.pin(this.file, block); this.emit('visit', { block }); return f; }
    unpin(f, dirty) { if (dirty) this.logPage(f); this.buf.unpin(f, !!dirty); }
    page(f) { return new K.Page(f.buf); }
    newPage(special) { const f = this.buf.extend(this.file); new K.Page(f.buf).init(special === undefined ? SPECIAL : special); return f; }
    logPage(f) { const lsn = this.db.wal.log({ type: 'index.page', method: this.kind, rel: this.idx.oid, file: this.file, block: f.block, image: f.buf.slice() }); if (lsn) new K.Page(f.buf).lsn = lsn; }
    sp32(f, i) { const p = this.page(f); return p.dv.getUint32(p.special + i * 4, true); }
    setSp32(f, i, v) { const p = this.page(f); p.dv.setUint32(p.special + i * 4, v >>> 0, true); }
    /** a page's live items as byte copies */
    items(f) { const p = this.page(f), out = []; for (let i = 1; i <= p.nslots; i++) { const it = p.item(i); if (it) out.push(it.slice()); } return out; }
    /** room for another item of this length on the page */
    fits(f, len) { const p = this.page(f); return p.upper - ((len + 7) & ~7) - 8 >= p.lower + 4; }
    /** entries of this size that fit on an empty page */
    perPage(len) { return Math.max(1, Math.floor((this.pageSize - K.PAGE_HDR - SPECIAL) / (((len + 7) & ~7) + 4))); }
    muted(fn) { this.bus.muted++; this.db.buffers.quiet = (this.db.buffers.quiet || 0) + 1; try { return fn(); } finally { this.bus.muted--; this.db.buffers.quiet--; } }

    // ---- a table of fields on a page (meta pages) -------------------------------------------------------------------
    readFields(block, names) {
      const f = this.pin(block);
      const it = this.page(f).item(1);
      const dv = new DataView(it.buffer, it.byteOffset, it.byteLength);
      const m = {};
      names.forEach((n, i) => { m[n] = dv.getUint32(i * 4, true); });
      this.unpin(f, false);
      return m;
    }
    writeFields(block, names, m, fresh) {
      const f = fresh || this.pin(block);
      const p = this.page(f);
      if (!p.nslots) p.add(new Uint8Array(names.length * 4), 8);
      const it = p.item(1);
      const dv = new DataView(it.buffer, it.byteOffset, it.byteLength);
      names.forEach((n, i) => dv.setUint32(i * 4, (m[n] === undefined ? 0 : m[n]) >>> 0, true));
      this.unpin(f, true);
    }

    // ---- an array of uint32 over a chain of pages (special: next block) -----------------------------------------------
    get arrPer() { return Math.floor((this.pageSize - K.PAGE_HDR - SPECIAL - 4 - 8) / 4); }
    arrPage(head, i) {
      let b = head;
      for (let k = Math.floor(i / this.arrPer); k > 0; k--) { const f = this.pin(b); const nx = this.sp32(f, 0); this.unpin(f, false); b = nx; }
      return b;
    }
    arrGet(head, i) { const b = this.arrPage(head, i); const f = this.pin(b); const it = this.page(f).item(1); const v = new DataView(it.buffer, it.byteOffset).getUint32((i % this.arrPer) * 4, true); this.unpin(f, false); return v; }
    arrSet(head, i, v) { const b = this.arrPage(head, i); const f = this.pin(b); const it = this.page(f).item(1); new DataView(it.buffer, it.byteOffset).setUint32((i % this.arrPer) * 4, v >>> 0, true); this.unpin(f, true); }
    arrNewPage() { const f = this.newPage(SPECIAL); this.page(f).add(new Uint8Array(this.arrPer * 4).fill(0xff), 8); this.setSp32(f, 0, NONE); const b = f.block; this.unpin(f, true); return b; }
    /** make sure the array starting at head holds n slots; returns the head (a new one if head is NONE) */
    arrGrow(head, n) {
      if (head === NONE) head = this.arrNewPage();
      let b = head, have = this.arrPer;
      while (have < n) {
        const f = this.pin(b);
        let nx = this.sp32(f, 0);
        if (nx === NONE) { nx = this.arrNewPage(); this.setSp32(f, 0, nx); this.unpin(f, true); } else this.unpin(f, false);
        b = nx; have += this.arrPer;
      }
      return head;
    }
    arrAll(head, n) {
      const out = [];
      let b = head;
      while (b !== NONE && out.length < n) {
        const f = this.pin(b);
        const it = this.page(f).item(1);
        const dv = new DataView(it.buffer, it.byteOffset);
        for (let i = 0; i < this.arrPer && out.length < n; i++) out.push(dv.getUint32(i * 4, true));
        const nx = this.sp32(f, 0);
        this.unpin(f, false);
        b = nx;
      }
      return out;
    }
    arrBlocks(head) { const out = []; let b = head; while (b !== NONE) { out.push(b); const f = this.pin(b); const nx = this.sp32(f, 0); this.unpin(f, false); b = nx; } return out; }

    // ---- keys and bounds ----------------------------------------------------------------------------------------------
    hashKey(key) { return K.indexHash(key, this.keyTypes); }
    sameKey(a, b) { for (let i = 0; i < this.nk; i++) { const x = a[i], y = b[i]; if (x === null || y === null || x === undefined || y === undefined) { if ((x == null) !== (y == null)) return false; continue; } if (T().compare(x, y, this.keyTypes[i]) !== 0) return false; } return true; }
    /** does an index key satisfy the bounds ([{ k, op, v }], the planner's form) */
    matches(key, bounds) {
      for (const b of bounds) {
        const x = key[b.k], t = this.keyTypes[b.k];
        if (b.op === 'isnull') { if (x !== null && x !== undefined) return false; continue; }
        if (b.op === 'notnull') { if (x === null || x === undefined) return false; continue; }
        if (x === null || x === undefined) return false;
        if (b.op === 'in') { if (!b.v.some((v) => v !== null && T().compare(x, v, t) === 0)) return false; continue; }
        if (b.v === null || b.v === undefined) return false;
        if (!K.Expr.CMP[b.op](T().compare(x, b.v, t))) return false;
      }
      return true;
    }
    recheck(bounds, vals, ctx) { return this.matches(this.keyOf(vals, ctx), bounds); }
    /** compare (key, tid) pairs in index order */
    cmpKT(a, b) { return this.cmpKey(a.key, b.key) || a.b - b.b || a.o - b.o; }
    *find(key) { yield* this.search(key.map((v, k) => (v === null ? { k, op: 'isnull' } : { k, op: '=', v }))); }
  }
  // the B+ tree's entry encoding, key extraction and key comparison are shared
  for (const m of ['encode', 'decode', 'cmpKey', 'keyOf']) IndexBase.prototype[m] = K.BTree.prototype[m];

  K.IndexBase = IndexBase;
  K.INDEX_NONE = NONE;
  K.INDEX_SPECIAL = SPECIAL;
  K.indexTruthy = truthy;
  K.INDEX_AMS = K.INDEX_AMS || {};
})(typeof window !== 'undefined' ? window : globalThis);
