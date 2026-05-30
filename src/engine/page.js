// The slotted page, laid out as PostgreSQL lays it out: a 24-byte header, an array of 4-byte line pointers
// growing down from the header, free space, items growing up from the end, and an optional special area
// at the very end (B+ tree nodes keep their links there).
//
//   0  pd_lsn (8)          the log position of the last change: the WAL rule compares it with the flushed log
//   8  pd_checksum (2)     10 pd_flags (2)
//  12  pd_lower (2)        end of the line pointer array
//  14  pd_upper (2)        start of the item data
//  16  pd_special (2)      start of the special area
//  18  pd_pagesize (2)     20 pd_prune_xid (4)
//  24  line pointers: lp_off (15 bits) | lp_flags (2 bits) | lp_len (15 bits)
(function (root) {
  'use strict';
  const K = root.K;
  const HDR = 24;
  const LP = { UNUSED: 0, NORMAL: 1, REDIRECT: 2, DEAD: 3 };

  class Page {
    constructor(buf) { this.b = buf; this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength); }
    get size() { return this.b.length; }
    init(special) {
      this.b.fill(0);
      const sp = this.size - (special || 0);
      this.setU16(12, HDR); this.setU16(14, sp); this.setU16(16, sp); this.setU16(18, this.size | 4);
      return this;
    }
    isNew() { return this.u16(12) === 0; }
    u16(o) { return this.dv.getUint16(o, true); }
    setU16(o, v) { this.dv.setUint16(o, v, true); }
    get lsn() { return this.dv.getUint32(0, true) * 4294967296 + this.dv.getUint32(4, true); }
    set lsn(v) { this.dv.setUint32(0, Math.floor(v / 4294967296), true); this.dv.setUint32(4, v % 4294967296, true); }
    get flags() { return this.u16(10); }
    set flags(v) { this.setU16(10, v); }
    get lower() { return this.u16(12); }
    get upper() { return this.u16(14); }
    get special() { return this.u16(16); }
    get pruneXid() { return this.dv.getUint32(20, true); }
    set pruneXid(v) { this.dv.setUint32(20, v, true); }
    get nslots() { return (this.lower - HDR) / 4; }
    free() { return Math.max(0, this.upper - this.lower - 4); }
    /** line pointer i (1-based, as item numbers are) */
    lp(i) {
      const w = this.dv.getUint32(HDR + (i - 1) * 4, true);
      return { off: w & 0x7fff, flags: (w >>> 15) & 3, len: w >>> 17 };
    }
    setLp(i, off, flags, len) { this.dv.setUint32(HDR + (i - 1) * 4, ((off & 0x7fff) | ((flags & 3) << 15) | ((len & 0x7fff) << 17)) >>> 0, true); }
    item(i) { const p = this.lp(i); return p.flags === LP.NORMAL ? this.b.subarray(p.off, p.off + p.len) : null; }
    /** add an item; reuses an unused line pointer if there is one. Returns the item number, or 0 if it does not fit */
    add(bytes, align, at) {
      align = align || 8;
      const len = bytes.length;
      let slot = 0;
      if (!at) for (let i = 1; i <= this.nslots; i++) if (this.lp(i).flags === LP.UNUSED) { slot = i; break; }
      const needLp = slot || at ? 0 : 4;
      let upper = this.upper - len;
      upper -= upper % align;
      if (upper < this.lower + needLp + (at ? 4 : 0)) return 0;
      if (at) {
        // insert at a given position, shifting later line pointers up by one (sorted index pages)
        const n = this.nslots;
        for (let i = n; i >= at; i--) this.setLpRaw(i + 1, this.dv.getUint32(HDR + (i - 1) * 4, true));
        slot = at;
        this.setU16(12, this.lower + 4);
      } else if (!slot) { slot = this.nslots + 1; this.setU16(12, this.lower + 4); }
      this.b.set(bytes, upper);
      this.setU16(14, upper);
      this.setLp(slot, upper, LP.NORMAL, len);
      return slot;
    }
    setLpRaw(i, w) { this.dv.setUint32(HDR + (i - 1) * 4, w >>> 0, true); }
    /** remove line pointer i from a sorted page, shifting the others down (index pages only) */
    removeAt(i) {
      const n = this.nslots;
      for (let j = i; j < n; j++) this.setLpRaw(j, this.dv.getUint32(HDR + j * 4, true));
      this.setU16(12, this.lower - 4);
      // index items are 4-byte aligned: compacting them 8-aligned could need more room than the page has
      this.compact(4);
    }
    setFlags(i, flags) { const p = this.lp(i); this.setLp(i, p.off, flags, flags === LP.UNUSED ? 0 : p.len); }
    /** replace item i in place when the new bytes fit in the old space */
    overwrite(i, bytes) { const p = this.lp(i); if (bytes.length > p.len) return false; this.b.set(bytes, p.off); this.setLp(i, p.off, LP.NORMAL, bytes.length); return true; }
    /** defragment: move the items together at the end, so all free space is one hole (as page pruning does) */
    compact(align) {
      align = align || 8;
      const items = [];
      for (let i = 1; i <= this.nslots; i++) { const p = this.lp(i); if (p.flags === LP.NORMAL && p.len) items.push([i, this.b.slice(p.off, p.off + p.len)]); }
      let upper = this.special;
      for (const [i, bytes] of items.sort((a, b) => this.lp(a[0]).off - this.lp(b[0]).off).reverse()) {
        upper -= bytes.length; upper -= upper % align;
        this.b.set(bytes, upper);
        this.setLp(i, upper, LP.NORMAL, bytes.length);
      }
      this.b.fill(0, this.lower, upper);
      this.setU16(14, upper);
    }
    /** a description for the storage inspector: every region with its bytes */
    describe() {
      const slots = [];
      for (let i = 1; i <= this.nslots; i++) slots.push(Object.assign({ i }, this.lp(i)));
      return { size: this.size, lsn: this.lsn, lower: this.lower, upper: this.upper, special: this.special, free: this.free(), slots };
    }
  }

  K.Page = Page;
  K.LP = LP;
  K.PAGE_HDR = HDR;
})(typeof window !== 'undefined' ? window : globalThis);
