// Heap files and tuples, laid out like PostgreSQL's: every row version carries the transaction that made it
// (xmin), the one that deleted or replaced it (xmax), a command id, a pointer to its newer version (ctid),
// flags, a null bitmap, and then the column values aligned by type.
//
//   0 t_xmin (4)   4 t_xmax (4)   8 t_cid (4)   12 t_ctid block (4)  16 t_ctid item (2)
//  18 t_infomask2 (2): number of attributes      20 t_infomask (2): flags below
//  22 t_hoff (1): where the data starts          23 null bitmap (one bit per column, 1 = not null)
(function (root) {
  'use strict';
  const K = root.K;
  const T = () => K.T;

  const IM = {
    HASNULL: 0x0001, HASVARWIDTH: 0x0002, HASEXTERNAL: 0x0004,
    XMAX_KEYSHR_LOCK: 0x0010, XMAX_EXCL_LOCK: 0x0040, XMAX_LOCK_ONLY: 0x0080,
    XMIN_COMMITTED: 0x0100, XMIN_INVALID: 0x0200, XMAX_COMMITTED: 0x0400, XMAX_INVALID: 0x0800,
    XMAX_IS_MULTI: 0x1000, UPDATED: 0x2000, MOVED: 0xc000,
  };
  const IM2 = { NATTS: 0x07ff, HOT_UPDATED: 0x4000, ONLY_TUPLE: 0x8000 };
  const HEADER = 23;

  const alignUp = (n, a) => (n + a - 1) & ~(a - 1);

  /** build a tuple's bytes from values; cols are the table's columns (with .type), dropped ones skipped as null */
  function form(values, cols, xmin, cid) {
    const n = cols.length;
    const hasNull = values.some((v) => v === null || v === undefined);
    const bitmapLen = hasNull ? Math.ceil(n / 8) : 0;
    const hoff = alignUp(HEADER + bitmapLen, 8);
    const parts = [];
    let off = hoff;
    let varwidth = false;
    for (let i = 0; i < n; i++) {
      const v = values[i];
      if (v === null || v === undefined || cols[i].dropped) continue;
      const t = cols[i].type;
      const bytes = T().encode(v, t);
      if (t.len === -1) varwidth = true;
      off = alignUp(off, T().align(t));
      parts.push([off, bytes]);
      off += bytes.length;
    }
    const buf = new Uint8Array(off);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, xmin >>> 0, true);
    dv.setUint32(4, 0, true);
    dv.setUint32(8, cid >>> 0, true);
    dv.setUint32(12, 0xffffffff, true);
    dv.setUint16(16, 0, true);
    dv.setUint16(18, n & IM2.NATTS, true);
    dv.setUint16(20, (hasNull ? IM.HASNULL : 0) | (varwidth ? IM.HASVARWIDTH : 0) | IM.XMAX_INVALID, true);
    buf[22] = hoff;
    if (hasNull) for (let i = 0; i < n; i++) if (values[i] !== null && values[i] !== undefined && !cols[i].dropped) buf[23 + (i >> 3)] |= 1 << (i & 7);
    for (const [o, bytes] of parts) buf.set(bytes, o);
    return buf;
  }

  /** read the header of a tuple in place */
  function header(bytes) {
    const u32 = (o) => (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16)) + bytes[o + 3] * 16777216;
    const m2 = bytes[18] | (bytes[19] << 8);
    return {
      xmin: u32(0), xmax: u32(4), cid: u32(8),
      ctid: { b: u32(12), o: bytes[16] | (bytes[17] << 8) },
      natts: m2 & IM2.NATTS, hot: !!(m2 & IM2.HOT_UPDATED), infomask: bytes[20] | (bytes[21] << 8), hoff: bytes[22],
    };
  }
  /** decode the values; tuples written before a column was added have fewer attributes: the rest are null (or the default) */
  /** decode the values; need (optional) lists the columns wanted, the others are skipped without decoding */
  function deform(bytes, cols, ctx, need) {
    const h = header(bytes);
    const hasNull = !!(h.infomask & IM.HASNULL);
    const out = new Array(cols.length);
    let off = h.hoff;
    const last = need ? need.last : cols.length - 1;
    for (let i = 0; i < cols.length; i++) {
      if (i > last) { out[i] = null; continue; }
      if (i >= h.natts) { out[i] = cols[i].missing !== undefined ? cols[i].missing : null; continue; }
      const isNull = hasNull && !(bytes[23 + (i >> 3)] & (1 << (i & 7)));
      if (isNull) { out[i] = null; continue; }
      const t = cols[i].type;
      off = alignUp(off, T().align(t));
      if (cols[i].dropped || (need && !need.has(i))) { out[i] = null; off += T().width(bytes, off, t); continue; }
      const [v, len] = T().decode(bytes, off, t, ctx);
      out[i] = v;
      off += len;
    }
    return out;
  }
  function setXmax(bytes, xmax, flags) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    dv.setUint32(4, xmax >>> 0, true);
    let im = dv.getUint16(20, true) & ~(IM.XMAX_INVALID | IM.XMAX_COMMITTED | IM.XMAX_LOCK_ONLY | IM.XMAX_EXCL_LOCK | IM.XMAX_KEYSHR_LOCK);
    if (!xmax) im |= IM.XMAX_INVALID;
    dv.setUint16(20, im | (flags || 0), true);
  }
  function setCid(bytes, cid) { new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(8, cid >>> 0, true); }
  function setCtid(bytes, b, o) { const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); dv.setUint32(12, b >>> 0, true); dv.setUint16(16, o, true); }
  function setInfo(bytes, set, clear) { const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); dv.setUint16(20, ((dv.getUint16(20, true) & ~(clear || 0)) | (set || 0)) & 0xffff, true); }
  function setHot(bytes, on) { const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); const v = dv.getUint16(18, true); dv.setUint16(18, on ? v | IM2.HOT_UPDATED : v & ~IM2.HOT_UPDATED, true); }

  /**
   * A heap file: the table's pages. Pages are reached only through the buffer pool. Inserts look in a free
   * space map for a page with room, as PostgreSQL's FSM does.
   */
  class Heap {
    constructor(db, rel) { this.db = db; this.rel = rel; this.file = rel.file; }
    get buf() { return this.db.buffers; }
    nblocks() { return this.db.disk.blocks(this.file); }
    fsm() { if (!this.rel.fsm) this.rel.fsm = []; return this.rel.fsm; }
    /** find a page with room for len bytes, or extend the file */
    pageFor(len) {
      const need = len + 4 + 8;
      const fsm = this.fsm();
      // the last page first (inserts cluster at the end), then any page the map says has room
      const n = this.nblocks();
      const tryBlock = (b) => {
        const f = this.buf.pin(this.file, b);
        const p = new K.Page(f.buf);
        if (p.isNew()) p.init(0);
        if (p.free() >= need) return f;
        fsm[b] = p.free();
        this.buf.unpin(f, false);
        return null;
      };
      if (n > 0 && (fsm[n - 1] === undefined || fsm[n - 1] >= need)) { const f = tryBlock(n - 1); if (f) return f; }
      for (let b = 0; b < n - 1; b++) if (fsm[b] !== undefined && fsm[b] >= need) { const f = tryBlock(b); if (f) return f; }
      const f = this.buf.extend(this.file);
      new K.Page(f.buf).init(0);
      this.db.bus.emit('heap.extend', { rel: this.rel.name, block: f.block });
      return f;
    }
    /** put a tuple on a page; returns its TID. The WAL record is written by the caller's log helper. */
    insert(bytes, opts) {
      if (bytes.length > this.db.disk.pageSize - K.PAGE_HDR - 8) throw K.err(K.STATE.featureNotSupported, 'row is too big: ' + bytes.length + ' bytes, but a ' + this.db.disk.pageSize + '-byte page holds at most ' + (this.db.disk.pageSize - K.PAGE_HDR - 8) + '. Use a larger page size in Settings.');
      const f = opts && opts.frame ? opts.frame : this.pageFor(bytes.length);
      const p = new K.Page(f.buf);
      const o = p.add(bytes, 8);
      if (!o) { this.buf.unpin(f, false); throw K.err(K.STATE.internal, 'page full after the free space check'); }
      const tid = { b: f.block, o };
      setCtid(p.item(o), tid.b, tid.o);
      this.fsm()[f.block] = p.free();
      const lsn = this.db.wal.log({ xid: opts && opts.xid, type: 'heap.insert', rel: this.rel.oid, file: this.file, block: f.block, item: o, bytes: p.item(o).slice() });
      p.lsn = lsn;
      this.buf.unpin(f, true);
      this.db.bus.emit('heap.insert', { rel: this.rel.name, tid, len: bytes.length });
      return tid;
    }
    /** pin a tuple's page and return {frame, page, bytes}; the caller unpins */
    fetch(tid) {
      if (tid.b >= this.nblocks()) return null;
      const f = this.buf.pin(this.file, tid.b);
      const p = new K.Page(f.buf);
      if (p.isNew() || tid.o < 1 || tid.o > p.nslots) { this.buf.unpin(f, false); return null; }
      const lp = p.lp(tid.o);
      if (lp.flags === K.LP.REDIRECT) { this.buf.unpin(f, false); return this.fetch({ b: tid.b, o: lp.off }); }
      const bytes = p.item(tid.o);
      if (!bytes) { this.buf.unpin(f, false); return null; }
      return { frame: f, page: p, bytes, tid };
    }
    /** change a tuple's header in place (xmax, hint bits), logged so recovery can redo it */
    mark(tid, fn, logRec) {
      const t = this.fetch(tid);
      if (!t) throw K.err(K.STATE.internal, 'tuple ' + tid.b + ',' + tid.o + ' not found');
      // the before-image lets undo put the header back; the after-image lets redo write it again
      const before = t.bytes.slice();
      fn(t.bytes);
      if (logRec) t.page.lsn = this.db.wal.log(Object.assign({ rel: this.rel.oid, file: this.file, block: t.tid.b, item: t.tid.o, bytes: t.bytes.slice(), before }, logRec));
      this.buf.unpin(t.frame, true);
    }
    /** every tuple of the table, block by block: yields {tid, bytes, frame}; the frame stays pinned while the caller looks */
    *scan(opts) {
      const n = this.nblocks();
      const from = (opts && opts.from) || 0, to = opts && opts.to !== undefined ? opts.to : n;
      for (let b = from; b < Math.min(to, n); b++) {
        const f = this.buf.pin(this.file, b);
        const p = new K.Page(f.buf);
        this.db.bus.emit('heap.page', { rel: this.rel.name, block: b });
        try {
          if (p.isNew()) continue;
          const ns = p.nslots;
          for (let o = 1; o <= ns; o++) {
            const lp = p.lp(o);
            if (lp.flags !== K.LP.NORMAL) continue;
            yield { tid: { b, o }, bytes: p.item(o), frame: f, page: p };
          }
        } finally { this.buf.unpin(f, false); }
      }
    }
    /** VACUUM's first step on one page: dead line pointers to unused, and compaction */
    prune(b, isDead) {
      const f = this.buf.pin(this.file, b);
      const p = new K.Page(f.buf);
      let freed = 0;
      if (!p.isNew()) {
        for (let o = 1; o <= p.nslots; o++) {
          const lp = p.lp(o);
          if (lp.flags === K.LP.NORMAL && isDead(p.item(o), { b, o })) { p.setFlags(o, K.LP.DEAD); freed++; }
        }
        if (freed) { p.compact(); p.lsn = this.db.wal.log({ type: 'heap.prune', rel: this.rel.oid, file: this.file, block: b, image: f.buf.slice() }); }
        this.fsm()[b] = p.free();
      }
      this.buf.unpin(f, freed > 0);
      return freed;
    }
  }

  // ---- redo and undo of heap records, used by recovery.js ------------------------------------------------------------

  /** set item i of a heap page to these bytes, adding line pointers (unused ones) up to i if the page has fewer */
  function place(p, i, bytes) {
    if (p.isNew()) p.init(0);
    const n = p.nslots;
    if (i <= n) {
      const lp = p.lp(i);
      if (lp.flags === K.LP.NORMAL && lp.len === bytes.length) { p.b.set(bytes, lp.off); return true; }
    }
    const extra = i > n ? (i - n) * 4 : 0;
    let upper = p.upper - bytes.length;
    upper -= upper % 8;
    if (upper < p.lower + extra) return false;
    if (i > n) { for (let k = n + 1; k < i; k++) p.setLp(k, 0, K.LP.UNUSED, 0); p.setU16(12, p.lower + extra); }
    p.b.set(bytes, upper);
    p.setU16(14, upper);
    p.setLp(i, upper, K.LP.NORMAL, bytes.length);
    return true;
  }
  const same = (a, b) => a.length === b.length && a.every((x, k) => x === b[k]);
  /** the image of the whole page a record carries, if any (page images, or the full-page image of a first change) */
  const imageOf = (rec) => rec.image || rec.fpi || null;
  /** redo one record on its page; returns what was done */
  function redo(p, rec) {
    const img = imageOf(rec);
    let what;
    if (img) { p.b.set(img); what = rec.image ? 'wrote the page image' : 'wrote the full-page image'; }
    else if (rec.item && rec.bytes) {
      what = place(p, rec.item, rec.bytes) ? (rec.type === 'heap.insert' ? 'put the tuple at item ' + rec.item : 'wrote item ' + rec.item + ' (' + rec.bytes.length + ' bytes)') : 'item ' + rec.item + ' no longer fits: a later image of this page restores it';
    } else what = 'nothing to write';
    p.lsn = rec.lsn;
    return what;
  }
  /** is this a record undo has to reverse? (index pages and page images are not: see Recovery.describe) */
  const undoable = (rec) => !!rec.xid && !!rec.item && (rec.type === 'heap.insert' || !!rec.before);
  /**
   * the undo of a heap record on its page: { bytes, what } to write (and log as a compensation record), or { skip }.
   * Undo is conditional: it changes the item only while it still holds what the record wrote, so undoing twice (a
   * crash during undo) or undoing a change that a later transaction already superseded does no harm.
   */
  function undo(p, rec) {
    if (p.isNew() || rec.item > p.nslots) return { skip: 'item ' + rec.item + ' is not on the page' };
    const cur = p.item(rec.item);
    if (!cur) return { skip: 'item ' + rec.item + ' is no longer a live item' };
    if (rec.type === 'heap.insert') {
      const h = header(cur);
      if (h.xmin !== rec.xid) return { skip: 'item ' + rec.item + ' now holds a tuple of transaction ' + h.xmin };
      if (h.infomask & IM.XMIN_INVALID) return { skip: 'already marked invalid' };
      const nb = cur.slice();
      setInfo(nb, IM.XMIN_INVALID, IM.XMIN_COMMITTED);
      return { bytes: nb, what: 'mark the inserted tuple invalid (XMIN_INVALID): no snapshot will see it, VACUUM removes it', action: 'invalidate' };
    }
    if (same(cur, rec.before)) return { skip: 'already undone: the item holds its before-image' };
    if (!same(cur, rec.bytes)) return { skip: 'the item was changed again after this record by a later transaction, which keeps its change' };
    const b = header(rec.before), a = header(rec.bytes);
    return { bytes: rec.before.slice(), what: 'restore the before-image: xmax ' + a.xmax + ' back to ' + (b.xmax || 'none'), action: 'restore' };
  }

  K.Heap = Heap;
  K.HeapRedo = { place, redo, undo, undoable, imageOf };
  K.Tuple = { form, header, deform, setXmax, setCid, setCtid, setInfo, setHot, IM, IM2, HEADER };
})(typeof window !== 'undefined' ? window : globalThis);
