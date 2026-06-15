// The B+ tree index, on slotted pages like every other file. Block 0 is the meta page (where the root is and
// how tall the tree is). Every node is one page: leaves hold (key, heap TID) entries in key order and are
// linked left and right; internal nodes hold child pointers separated by keys, the first pointer with no key,
// so a node with pointers P1..Pn has keys K1..Kn-1 and subtree Pi+1 holds keys >= Ki, the usual convention.
// Duplicate keys are told apart by their heap TID, which is part of every key (as in PostgreSQL 12 and later).
//
// Index entry: 0 block (4) 4 item (2): the heap TID, or the child block in an internal node
//              6 info (2): entry size | 0x8000 if it has nulls    8 null bitmap (if any)    then the key values
// Node special area (16 bytes): level (2) flags (2) left sibling (4) right sibling (4)
(function (root) {
  'use strict';
  const K = root.K;
  const T = () => K.T;
  const SPECIAL = 16;
  const NONE = 0xffffffff;
  const F = { LEAF: 1, ROOT: 2, META: 4 };

  /** a node page: the page plus its links */
  class Node {
    constructor(frame) { this.f = frame; this.p = new K.Page(frame.buf); this.dv = this.p.dv; this.block = frame.block; }
    get sp() { return this.p.special; }
    get level() { return this.dv.getUint16(this.sp, true); }
    set level(v) { this.dv.setUint16(this.sp, v, true); }
    get flags() { return this.dv.getUint16(this.sp + 2, true); }
    set flags(v) { this.dv.setUint16(this.sp + 2, v, true); }
    get left() { return this.dv.getUint32(this.sp + 4, true); }
    set left(v) { this.dv.setUint32(this.sp + 4, v >>> 0, true); }
    get right() { return this.dv.getUint32(this.sp + 8, true); }
    set right(v) { this.dv.setUint32(this.sp + 8, v >>> 0, true); }
    get leaf() { return !!(this.flags & F.LEAF); }
    get n() { return this.p.nslots; }
    item(i) { return this.p.item(i); }
  }

  const DECODED = new WeakMap();
  const same = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };

  class BTree {
    constructor(db, idx) {
      this.db = db;
      this.idx = idx;
      this.file = idx.file;
      this.keyTypes = idx.keyTypes;
      this.nk = this.keyTypes.length;
      this.dirs = idx.keys.map((k) => (k.dir === 'desc' ? -1 : 1));
      // NULLS LAST is the default for ascending keys, NULLS FIRST for descending ones
      this.nullsFirst = idx.keys.map((k) => (k.nulls ? k.nulls === 'first' : k.dir === 'desc'));
      this.fanout = idx.options && idx.options.fanout ? Math.max(3, Number(idx.options.fanout)) : 0;
      // the include columns ride along in leaf entries only
      this.cols = this.keyTypes.map((t) => ({ type: t }));
      if (!this.db.disk.blocks(this.file)) this.init();
    }
    get buf() { return this.db.buffers; }
    get bus() { return this.db.bus; }

    // ---- the meta page --------------------------------------------------------------------------------------
    init() {
      const mf = this.buf.extend(this.file);
      const meta = new K.Page(mf.buf).init(SPECIAL);
      const rf = this.buf.extend(this.file);
      const r = new Node(rf); r.p.init(SPECIAL); r.level = 0; r.flags = F.LEAF | F.ROOT; r.left = NONE; r.right = NONE;
      this.setMeta(meta, rf.block, 0);
      this.logPage(mf); this.logPage(rf);
      this.buf.unpin(rf, true); this.buf.unpin(mf, true);
    }
    setMeta(page, rootBlock, levels) { page.dv.setUint32(page.special, rootBlock, true); page.dv.setUint32(page.special + 4, levels, true); page.dv.setUint16(page.special + 8, F.META, true); }
    meta() { const f = this.buf.pin(this.file, 0); const p = new K.Page(f.buf); const m = { root: p.dv.getUint32(p.special, true), levels: p.dv.getUint32(p.special + 4, true) }; this.buf.unpin(f, false); return m; }
    /** the height of the tree: 1 for a lone root leaf */
    height() { return this.meta().levels + 1; }
    pin(block) { const f = this.buf.pin(this.file, block); const n = new Node(f); this.bus.emit('btree.visit', { index: this.idx.name, block, level: n.level, leaf: n.leaf }); return n; }
    unpin(n, dirty) { this.buf.unpin(n.f, dirty); }
    logPage(f) { const p = new K.Page(f.buf); p.lsn = this.db.wal.log({ type: 'btree.page', rel: this.idx.oid, file: this.file, block: f.block, image: f.buf.slice() }); }

    // ---- entries ----------------------------------------------------------------------------------------------
    encode(key, b, o) {
      const hasNull = key.some((v) => v === null);
      const bm = hasNull ? Math.ceil(key.length / 8) : 0;
      const parts = [];
      let off = 8 + bm;
      for (let i = 0; i < key.length; i++) {
        if (key[i] === null) continue;
        const t = this.cols[i] ? this.cols[i].type : T().typeOfValue(key[i]);
        const bytes = T().encode(key[i], t);
        off = (off + T().align(t) - 1) & ~(T().align(t) - 1);
        parts.push([off, bytes]);
        off += bytes.length;
      }
      const out = new Uint8Array(off);
      const dv = new DataView(out.buffer);
      dv.setUint32(0, b >>> 0, true); dv.setUint16(4, o, true); dv.setUint16(6, (off & 0x1fff) | (hasNull ? 0x8000 : 0), true);
      if (hasNull) for (let i = 0; i < key.length; i++) if (key[i] !== null) out[8 + (i >> 3)] |= 1 << (i & 7);
      for (const [p, bytes] of parts) out.set(bytes, p);
      return out;
    }
    /** read an entry: { b, o, key } (key is [] for an internal node's first, keyless pointer); decoded entries are
     * remembered per page position and reused while the bytes there are unchanged (a search decodes the same keys often) */
    decode(bytes) {
      let pc = DECODED.get(bytes.buffer);
      if (!pc) { pc = new Map(); DECODED.set(bytes.buffer, pc); }
      const hit = pc.get(bytes.byteOffset);
      if (hit && hit.raw.length === bytes.length && same(hit.raw, bytes)) return hit.e;
      const e = BTree.prototype.decode0.call(this, bytes);
      pc.set(bytes.byteOffset, { raw: bytes.slice(), e });
      return e;
    }
    decode0(bytes) {
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const b = dv.getUint32(0, true), o = dv.getUint16(4, true), info = dv.getUint16(6, true);
      const size = info & 0x1fff;
      if (size <= 8 && !(info & 0x8000)) return { b, o, key: [] };
      const hasNull = !!(info & 0x8000);
      const bm = hasNull ? Math.ceil(this.nk / 8) : 0;
      const key = new Array(this.nk);
      let off = 8 + bm;
      for (let i = 0; i < this.nk; i++) {
        if (hasNull && !(bytes[8 + (i >> 3)] & (1 << (i & 7)))) { key[i] = null; continue; }
        const t = this.cols[i].type;
        off = (off + T().align(t) - 1) & ~(T().align(t) - 1);
        const [v, len] = T().decode(bytes, off, t, null);
        key[i] = v; off += len;
      }
      return { b, o, key };
    }
    /** compare keys in index order (direction and null placement per column); missing trailing columns compare as -inf */
    cmpKey(a, b) {
      const n = Math.min(a.length, b.length);
      for (let i = 0; i < n; i++) {
        const x = a[i], y = b[i];
        if (x === null || y === null) { if (x === y) continue; return (x === null) === this.nullsFirst[i] ? -1 : 1; }
        const c = T().compare(x, y, this.keyTypes[i]) * this.dirs[i];
        if (c) return c;
      }
      return 0;
    }
    /** compare (key, tid) entries; tid null in the search key means -inf, Infinity means +inf */
    cmpEntry(ak, at, bk, bt) {
      const c = this.cmpKey(ak, bk);
      if (c) return c;
      if (ak.length !== bk.length) return ak.length < bk.length ? (at === Infinity ? 1 : -1) : (bt === Infinity ? -1 : 1);
      if (at === null || bt === Infinity) return at === bt ? 0 : -1;
      if (bt === null || at === Infinity) return 1;
      return at.b - bt.b || at.o - bt.o;
    }

    // ---- searching ----------------------------------------------------------------------------------------------
    /** the child of an internal node to follow for (key, tid): the last pointer whose separator is <= it */
    childFor(node, key, tid) {
      let lo = 2, hi = node.n, ans = 1;
      while (lo <= hi) {
        const m = (lo + hi) >> 1;
        const bytes = node.item(m);
        if (this.cmpEntry(this.decode(bytes).key, this.tidOfSep(bytes), key, tid) <= 0) { ans = m; lo = m + 1; } else hi = m - 1;
      }
      return { i: ans, block: this.decode(node.item(ans)).b };
    }
    /** descend to the leaf where (key, tid) belongs; returns the path of internal blocks and the leaf */
    descend(key, tid) {
      const m = this.meta();
      let block = m.root;
      const path = [];
      for (;;) {
        const node = this.pin(block);
        if (node.leaf) return { leaf: node, path };
        const c = this.childFor(node, key, tid);
        path.push({ block, i: c.i });
        this.unpin(node, false);
        block = c.block;
      }
    }
    /** position in a leaf of the first entry >= (key, tid) */
    leafPos(node, key, tid) {
      let lo = 1, hi = node.n;
      while (lo <= hi) {
        const m = (lo + hi) >> 1;
        const e = this.decode(node.item(m));
        if (this.cmpEntry(e.key, { b: e.b, o: e.o }, key, tid) < 0) lo = m + 1; else hi = m - 1;
      }
      return lo;
    }
    /** the index key of a table row (from columns or expressions) */
    keyOf(vals, ctx) { return this.idx.keyFn ? this.idx.keyFn(vals, ctx) : this.idx.keys.map((k) => vals[k.attnum]); }

    /**
     * the heap TIDs matching the bounds, in index order (or reverse): bounds are [{ k, op, v }] with = on a prefix
     * of the key columns, then <, <=, >, >= on the next, or IN on the first, or IS NULL / IS NOT NULL
     */
    *search(bounds, backward) {
      const inb = bounds.find((b) => b.op === 'in');
      if (inb) {
        const vals = inb.v.filter((x) => x !== null).sort((a, b) => this.cmpKey([a], [b]) * (backward ? -1 : 1));
        for (const v of vals) yield* this.search(bounds.map((b) => (b === inb ? { k: b.k, op: '=', v } : b)), backward);
        return;
      }
      const eq = [];
      for (let k = 0; k < this.nk; k++) { const b = bounds.find((x) => x.k === k && x.op === '='); if (!b) break; eq.push(b.v); }
      const m = eq.length;
      const rng = bounds.filter((b) => b.k === m && b.op !== '=');
      // the physical lower and upper limits on column m
      let lower = null, upper = null;
      for (const b of rng) {
        let side, incl = b.op === '<=' || b.op === '>=';
        if (b.op === 'isnull') { lower = upper = { v: null, incl: true }; continue; }
        if (b.op === 'notnull') { if (this.nullsFirst[m]) lower = { v: null, incl: false }; else upper = { v: null, incl: false }; continue; }
        const lessThan = b.op === '<' || b.op === '<=';
        side = (lessThan ? 1 : -1) * this.dirs[m] > 0 ? 'upper' : 'lower';
        if (side === 'upper' && (!upper || this.cmpKey(eq.concat([b.v]), eq.concat([upper.v])) < 0)) upper = { v: b.v, incl };
        if (side === 'lower' && (!lower || this.cmpKey(eq.concat([b.v]), eq.concat([lower.v])) > 0)) lower = { v: b.v, incl };
      }
      if (rng.length && !rng.some((b) => b.op === 'isnull' || b.op === 'notnull') && lower === null && upper === null) return;
      // ranges exclude nulls: a NULL key never satisfies < or >
      const notNullCol = rng.some((b) => b.op !== 'isnull');
      const before = (key) => {
        // is the entry before the start of the range (keep going) ...
        if (lower) { const c = this.cmpKey(key.slice(0, m + 1), eq.concat([lower.v])); if (c < 0 || (c === 0 && !lower.incl)) return true; }
        return false;
      };
      const after = (key) => {
        // ... or past its end (stop)?
        if (m && this.cmpKey(key.slice(0, m), eq) !== 0) return this.cmpKey(key.slice(0, m), eq) > 0 ? 'past' : 'before';
        if (upper) { const c = this.cmpKey(key.slice(0, m + 1), eq.concat([upper.v])); if (c > 0 || (c === 0 && !upper.incl)) return 'past'; }
        return null;
      };
      const ok = (key) => !(notNullCol && key[m] === null && !(lower && lower.v === null && lower.incl));
      if (!backward) {
        const start = lower ? eq.concat([lower.v]) : eq;
        const { leaf } = this.descend(start, lower && !lower.incl ? Infinity : null);
        let node = leaf, i = this.leafPos(node, start, lower && !lower.incl ? Infinity : null);
        for (;;) {
          if (i > node.n) {
            const r = node.right;
            this.unpin(node, false);
            if (r === NONE) return;
            node = this.pin(r); i = 1;
            continue;
          }
          const e = this.decode(node.item(i++));
          const a = after(e.key);
          if (a === 'past') { this.unpin(node, false); return; }
          if (a === 'before' || before(e.key) || !ok(e.key)) continue;
          yield { b: e.b, o: e.o, key: e.key };
        }
      } else {
        const start = upper ? eq.concat([upper.v]) : eq;
        const { leaf } = this.descend(start, upper && !upper.incl ? null : Infinity);
        let node = leaf, i = this.leafPos(node, start, upper && !upper.incl ? null : Infinity) - 1;
        for (;;) {
          if (i < 1) {
            const l = node.left;
            this.unpin(node, false);
            if (l === NONE) return;
            node = this.pin(l); i = node.n;
            continue;
          }
          const e = this.decode(node.item(i--));
          if (m && this.cmpKey(e.key.slice(0, m), eq) < 0) { this.unpin(node, false); return; }
          if (after(e.key) || !ok(e.key)) continue;
          if (before(e.key)) { this.unpin(node, false); return; }
          yield { b: e.b, o: e.o, key: e.key };
        }
      }
    }
    /** does a row still satisfy the index condition (the heap version may differ from the one indexed) */
    recheck(bounds, vals, ctx) {
      const key = this.keyOf(vals, ctx);
      for (const b of bounds) {
        const x = key[b.k], t = this.keyTypes[b.k];
        if (b.op === 'isnull') { if (x !== null) return false; continue; }
        if (b.op === 'notnull') { if (x === null) return false; continue; }
        if (x === null) return false;
        if (b.op === 'in') { if (!b.v.some((v) => v !== null && T().compare(x, v, t) === 0)) return false; continue; }
        if (b.v === null) return false;
        const c = T().compare(x, b.v, t);
        if (!K.Expr.CMP[b.op](c)) return false;
      }
      return true;
    }
    /** every entry with exactly this key (for unique checks) */
    *find(key) { yield* this.search(key.map((v, k) => ({ k, op: '=', v }))); }

    // ---- inserting -----------------------------------------------------------------------------------------------
    capacity(node) { return this.fanout ? (node.leaf ? this.fanout - 1 : this.fanout) : Infinity; }
    insert(vals, tid, ctx) {
      const key = this.keyOf(vals, ctx);
      const entry = this.encode(key, tid.b, tid.o);
      const { leaf, path } = this.descend(key, tid);
      const pos = this.leafPos(leaf, key, tid);
      this.bus.emit('btree.insert', { index: this.idx.name, block: leaf.block, key, tid });
      this.put(leaf, pos, entry, key, tid, path);
    }
    /** put an entry at a position, splitting the node if it is full */
    put(node, pos, entry, key, tid, path) {
      if (node.n < this.capacity(node) && node.p.add(entry, 4, pos)) { this.logPage(node.f); this.unpin(node, true); return; }
      this.split(node, pos, entry, key, tid, path);
    }
    split(node, pos, entry, key, tid, path) {
      // gather the node's entries with the new one, then share them between the node and a new right sibling
      const items = [];
      for (let i = 1; i <= node.n; i++) items.push(node.item(i).slice());
      items.splice(pos - 1, 0, entry);
      const leaf = node.leaf;
      const rf = this.buf.extend(this.file);
      const right = new Node(rf);
      right.p.init(SPECIAL);
      right.level = node.level; right.flags = node.flags & ~F.ROOT; right.left = node.block; right.right = node.right;
      if (node.right !== NONE) { const nr = this.pin(node.right); nr.left = rf.block; this.logPage(nr.f); this.unpin(nr, true); }
      const wasRoot = !!(node.flags & F.ROOT);
      const level = node.level, flags = node.flags & ~F.ROOT, left = node.left;
      node.p.init(SPECIAL); node.level = level; node.flags = flags; node.left = left; node.right = rf.block;
      // leaves split ceil(n/2) left; the first key of the right leaf is copied up. Internal nodes push the middle key up
      const half = Math.ceil(items.length / 2);
      let sep;
      if (leaf) {
        items.slice(0, half).forEach((it, i) => node.p.add(it, 4, i + 1));
        items.slice(half).forEach((it, i) => right.p.add(it, 4, i + 1));
        const first = this.decode(items[half]);
        sep = { key: first.key, tid: { b: first.b, o: first.o } };
      } else {
        items.slice(0, half).forEach((it, i) => node.p.add(it, 4, i + 1));
        const mid = this.decode(items[half]);
        sep = { key: mid.key, tid: this.tidOfSep(items[half]) };
        // the middle entry's pointer becomes the right node's keyless first pointer
        right.p.add(this.encode([], mid.b, 0).subarray(0, 8), 4, 1);
        items.slice(half + 1).forEach((it, i) => right.p.add(it, 4, i + 2));
      }
      this.bus.emit('btree.split', { index: this.idx.name, block: node.block, right: rf.block, level: node.level, leaf, sep: sep.key });
      this.logPage(node.f); this.logPage(rf);
      const sepEntry = this.sepEntry(sep.key, sep.tid, rf.block);
      const leftBlock = node.block;
      this.unpin(node, true);
      this.buf.unpin(rf, true);
      if (wasRoot || !path.length) {
        // a new root above the two halves: the tree grows one level
        const nf = this.buf.extend(this.file);
        const nr = new Node(nf);
        nr.p.init(SPECIAL); nr.level = level + 1; nr.flags = F.ROOT; nr.left = NONE; nr.right = NONE;
        nr.p.add(this.encode([], leftBlock, 0).subarray(0, 8), 4, 1);
        nr.p.add(sepEntry, 4, 2);
        this.logPage(nf);
        const mf = this.buf.pin(this.file, 0);
        this.setMeta(new K.Page(mf.buf), nf.block, level + 1);
        this.logPage(mf);
        this.buf.unpin(mf, true);
        this.buf.unpin(nf, true);
        this.bus.emit('btree.newroot', { index: this.idx.name, block: nf.block, levels: level + 1 });
        return;
      }
      const parent = path[path.length - 1];
      const pn = this.pin(parent.block);
      this.put(pn, parent.i + 1, sepEntry, sep.key, sep.tid, path.slice(0, -1));
    }
    /** an internal entry: the separator key, the child pointer, and the separator's heap TID after the key */
    sepEntry(key, tid, child) {
      const e = this.encode(key, child, 0);
      const out = new Uint8Array(e.length + 6);
      out.set(e);
      const dv = new DataView(out.buffer);
      dv.setUint32(e.length, tid ? tid.b : 0, true); dv.setUint16(e.length + 4, tid ? tid.o : 0, true);
      return out;
    }
    tidOfSep(bytes) { const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); const size = dv.getUint16(6, true) & 0x1fff; return size + 6 <= bytes.length ? { b: dv.getUint32(size, true), o: dv.getUint16(size + 4, true) } : null; }

    // ---- removing (VACUUM) ------------------------------------------------------------------------------------------
    /** remove entries whose heap tuples are dead; empty leaves stay (as PostgreSQL leaves them until a later pass) */
    vacuum(isDead) {
      let removed = 0;
      const m = this.meta();
      let block = m.root;
      for (;;) { const n = this.pin(block); if (n.leaf) { this.unpin(n, false); break; } const b = this.decode(n.item(1)).b; this.unpin(n, false); block = b; }
      while (block !== NONE) {
        const n = this.pin(block);
        let changed = false;
        for (let i = n.n; i >= 1; i--) { const e = this.decode(n.item(i)); if (isDead({ b: e.b, o: e.o })) { n.p.removeAt(i); removed++; changed = true; } }
        if (changed) this.logPage(n.f);
        const r = n.right;
        this.unpin(n, changed);
        block = r;
      }
      return removed;
    }

    // ---- for the index view ------------------------------------------------------------------------------------------
    /** the whole tree as nested nodes, without counting the reads (the view looks at the disk image through the pool) */
    describe(limit) {
      const out = { levels: 0, nodes: [] };
      this.bus.muted++;
      this.buf.quiet = (this.buf.quiet || 0) + 1;
      try {
        const m = this.meta();
        out.levels = m.levels + 1;
        out.root = m.root;
        const walk = (block, depth) => {
          if (out.nodes.length > (limit || 400)) return null;
          const n = this.pin(block);
          const node = { block, level: n.level, leaf: n.leaf, left: n.left === NONE ? null : n.left, right: n.right === NONE ? null : n.right, free: n.p.free(), entries: [] };
          const kids = [];
          for (let i = 1; i <= n.n; i++) {
            const e = this.decode(n.item(i));
            if (n.leaf) node.entries.push({ key: e.key, tid: { b: e.b, o: e.o } });
            else { node.entries.push({ key: i === 1 ? null : e.key, child: e.b }); kids.push(e.b); }
          }
          this.unpin(n, false);
          out.nodes.push(node);
          node.children = kids.map((b) => walk(b, depth + 1)).filter(Boolean);
          return node;
        };
        out.tree = walk(m.root, 0);
      } finally { this.bus.muted--; this.buf.quiet--; }
      return out;
    }
  }
  K.BTree = BTree;
  K.BT_FLAGS = F;
})(typeof window !== 'undefined' ? window : globalThis);
