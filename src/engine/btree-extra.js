// Teaching additions to the B+ tree (btree.js):
//
//   delete(vals, tid)   the classic deletion: remove the entry, and when a node falls below half full either
//                       borrow an entry from a sibling (redistribution, fixing the separator in the parent) or
//                       merge with it (coalescing, removing the separator from the parent, recursively), and
//                       replace a root left with a single child by that child. "Half full" is counted in entries
//                       with the fanout option and in bytes otherwise. A normal DELETE leaves the entry for VACUUM
//                       as PostgreSQL does; with WITH (textbook_delete = on), VACUUM removes dead entries this way.
//   bulkLoad(entries)   build the tree bottom up from sorted entries: leaves filled to the fill factor (option
//                       fillfactor, default 90 as in PostgreSQL), then each level of internal nodes above them.
//
// And K.BTreeClassic: an in-memory B-tree in which every key appears once, in a leaf or an internal node, for
// the B-tree versus B+ tree comparison view.
(function (root) {
  'use strict';
  const K = root.K;
  const P = K.BTree.prototype;
  const F = K.BT_FLAGS;
  const NONE = 0xffffffff;
  const DELETED = 8;
  const SPECIAL = 16;

  const used = (n) => (n.p.special - n.p.upper) + (n.p.lower - K.PAGE_HDR);
  const usable = (n) => n.p.special - K.PAGE_HDR;
  const cost = (bytes) => ((bytes.length + 3) & ~3) + 4;

  P.minFill = function (node) { return node.leaf ? Math.ceil((this.fanout - 1) / 2) : Math.ceil(this.fanout / 2); };
  P.underfull = function (node) { return this.fanout ? node.n < this.minFill(node) : used(node) < usable(node) / 2; };
  /** could the sibling give up this item and stay at least half full? */
  P.canGive = function (sib, item) { return this.fanout ? sib.n - 1 >= this.minFill(sib) : used(sib) - cost(item) >= usable(sib) / 2; };
  P.canMerge = function (l, r, sepBytes) {
    if (this.fanout) return l.n + r.n <= (l.leaf ? this.fanout - 1 : this.fanout);
    return used(l) + used(r) + (l.leaf ? 0 : cost(sepBytes) - 12) <= usable(l);
  };
  P.keyless = function (child) { return this.encode([], child, 0).subarray(0, 8); };
  P.replaceItem = function (node, i, bytes) {
    node.p.removeAt(i);
    if (!node.p.add(bytes, 4, i)) throw K.err(K.STATE.internal, 'the new separator does not fit in B+ tree node ' + node.block);
  };
  P.relink = function (block, left) { if (block === NONE) return; const n = this.pin(block); n.left = left; this.logPage(n.f); this.unpin(n, true); };
  P.setRoot = function (block, levels) { const mf = this.buf.pin(this.file, 0); this.setMeta(new K.Page(mf.buf), block, levels); this.logPage(mf); this.buf.unpin(mf, true); };

  /** the classic delete of one entry; false if it is not in the tree */
  P.delete = function (vals, tid, ctx) { return this.deleteKey(this.keyOf(vals, ctx), tid); };
  P.deleteKey = function (key, tid) {
    const { leaf, path } = this.descend(key, tid);
    const pos = this.leafPos(leaf, key, tid);
    if (pos > leaf.n) { this.unpin(leaf, false); return false; }
    const e = this.decode(leaf.item(pos));
    if (this.cmpEntry(e.key, { b: e.b, o: e.o }, key, tid) !== 0) { this.unpin(leaf, false); return false; }
    leaf.p.removeAt(pos);
    this.bus.emit('btree.delete', { index: this.idx.name, block: leaf.block, key, tid });
    this.rebalance(leaf, path);
    return true;
  };
  /** a node lost an entry: fix it up if it is now less than half full (the caller's pin is released here) */
  P.rebalance = function (node, path) {
    if (node.flags & F.ROOT || !path.length) {
      if (!node.leaf && node.n === 1) {
        // a root with one child: the child becomes the root and the tree is one level shorter
        const child = this.decode(node.item(1)).b;
        node.flags = (node.flags & ~F.ROOT) | DELETED;
        this.logPage(node.f); this.unpin(node, true);
        const c = this.pin(child); c.flags |= F.ROOT; c.left = NONE; c.right = NONE; this.logPage(c.f); const lv = c.level; this.unpin(c, true);
        this.setRoot(child, lv);
        this.bus.emit('btree.shrink', { index: this.idx.name, root: child, levels: lv + 1, freed: node.block });
        return;
      }
      this.logPage(node.f); this.unpin(node, true);
      return;
    }
    if (!this.underfull(node)) { this.logPage(node.f); this.unpin(node, true); return; }
    const { block: pb, i } = path[path.length - 1];
    const parent = this.pin(pb);
    const fromLeft = i > 1;
    const si = fromLeft ? i - 1 : i + 1;
    if (si > parent.n) { this.unpin(parent, false); this.logPage(node.f); this.unpin(node, true); return; }
    const sepIdx = fromLeft ? i : i + 1;
    const sepBytes = parent.item(sepIdx).slice();
    let sep = { key: this.decode(sepBytes).key, tid: this.tidOfSep(sepBytes) };
    const sib = this.pin(this.decode(parent.item(si)).b);
    const L = fromLeft ? sib : node, R = fromLeft ? node : sib;
    if (this.canMerge(L, R, this.sepEntry(sep.key, sep.tid, 0))) {
      // coalesce: everything into the left node; the separator comes down into it if the nodes are internal
      const items = [];
      for (let k = 1; k <= R.n; k++) items.push(R.item(k).slice());
      if (!L.leaf) items[0] = this.sepEntry(sep.key, sep.tid, this.decode(items[0]).b);
      for (const it of items) if (!L.p.add(it, 4, L.n + 1)) throw K.err(K.STATE.internal, 'B+ tree merge overflowed node ' + L.block);
      L.right = R.right;
      this.relink(R.right, L.block);
      R.p.init(SPECIAL); R.flags = DELETED;
      this.bus.emit('btree.merge', { index: this.idx.name, left: L.block, right: R.block, leaf: L.leaf, level: L.level, sep: sep.key });
      this.logPage(L.f); this.logPage(R.f); this.unpin(L, true); this.unpin(R, true);
      parent.p.removeAt(sepIdx);
      this.rebalance(parent, path.slice(0, -1));
      return;
    }
    // redistribute: borrow from the sibling one entry at a time, moving the separator in the parent with it
    let moved = 0;
    for (;;) {
      let newSep;
      if (fromLeft) {
        const last = L.item(L.n).slice();
        if (moved && !this.canGive(L, last)) break;
        L.p.removeAt(L.n);
        if (R.leaf) { R.p.add(last, 4, 1); const f = this.decode(R.item(1)); newSep = { key: f.key, tid: { b: f.b, o: f.o } }; }
        else {
          const x = this.decode(last);
          const p1 = this.decode(R.item(1)).b;
          this.replaceItem(R, 1, this.sepEntry(sep.key, sep.tid, p1));
          R.p.add(this.keyless(x.b), 4, 1);
          newSep = { key: x.key, tid: this.tidOfSep(last) };
        }
      } else {
        const first = R.item(1).slice();
        if (moved && !this.canGive(R, R.leaf ? first : R.item(2))) break;
        if (R.leaf) { R.p.removeAt(1); L.p.add(first, 4, L.n + 1); const f = this.decode(R.item(1)); newSep = { key: f.key, tid: { b: f.b, o: f.o } }; }
        else {
          const p1 = this.decode(first).b;
          L.p.add(this.sepEntry(sep.key, sep.tid, p1), 4, L.n + 1);
          R.p.removeAt(1);
          const second = R.item(1).slice();
          const x = this.decode(second);
          this.replaceItem(R, 1, this.keyless(x.b));
          newSep = { key: x.key, tid: this.tidOfSep(second) };
        }
      }
      sep = newSep;
      this.replaceItem(parent, sepIdx, this.sepEntry(sep.key, sep.tid, R.block));
      moved++;
      if (!this.underfull(node) || (fromLeft ? L.n < 2 : R.n < 2)) break;
    }
    this.bus.emit('btree.redistribute', { index: this.idx.name, from: sib.block, to: node.block, moved, leaf: node.leaf, level: node.level, sep: sep.key });
    this.logPage(L.f); this.logPage(R.f); this.logPage(parent.f);
    this.unpin(L, true); this.unpin(R, true); this.unpin(parent, true);
  };

  // with textbook_delete, VACUUM deletes dead entries one by one with redistribution and coalescing
  const vacuum0 = P.vacuum;
  P.vacuum = function (isDead) {
    if (!K.indexTruthy((this.idx.options || {}).textbook_delete)) return vacuum0.call(this, isDead);
    const dead = [];
    let block = this.meta().root;
    for (;;) { const n = this.pin(block); if (n.leaf) { this.unpin(n, false); break; } const b = this.decode(n.item(1)).b; this.unpin(n, false); block = b; }
    while (block !== NONE) {
      const n = this.pin(block);
      for (let i = 1; i <= n.n; i++) { const e = this.decode(n.item(i)); if (isDead({ b: e.b, o: e.o })) dead.push({ key: e.key, tid: { b: e.b, o: e.o } }); }
      const r = n.right;
      this.unpin(n, false);
      block = r;
    }
    let removed = 0;
    for (const d of dead) if (this.deleteKey(d.key, d.tid)) removed++;
    return removed;
  };

  /** build the tree bottom up from entries ({ key, tid } or { key, b, o }), replacing whatever it held */
  P.bulkLoad = function (entries, opts) {
    opts = opts || {};
    const ff = K.clamp(Number(opts.fillfactor || (this.idx.options || {}).fillfactor || 90), 10, 100) / 100;
    const es = entries.map((e) => ({ key: Array.isArray(e.key) ? e.key : [e.key], tid: e.tid || { b: e.b, o: e.o } }));
    es.sort((a, b) => this.cmpEntry(a.key, a.tid, b.key, b.tid));
    this.buf.forget(this.file);
    this.db.disk.truncate(this.file, 0);
    const mf = this.buf.extend(this.file);
    new K.Page(mf.buf).init(SPECIAL);
    const room = this.db.disk.pageSize - K.PAGE_HDR - SPECIAL;
    // how many items go in each node: as even as possible, no more than the fill factor allows, two at least in internal nodes
    const plan = (n, leaf, sizes) => {
      const per = this.fanout ? Math.floor((leaf ? this.fanout - 1 : this.fanout) * ff) : Math.floor((room * ff) / sizes.reduce((a, x) => (x > a ? x : a), 8));
      const c = Math.max(leaf ? 1 : 2, per);
      let g = Math.max(1, Math.ceil(n / c));
      if (!leaf && g > 1 && Math.floor(n / g) < 2) g = Math.floor(n / 2);
      return K.range(g).map((i) => Math.floor(n / g) + (i < n % g ? 1 : 0));
    };
    const writeLevel = (items, level, leaf) => {
      const bytes = items.map((it, k) => (leaf ? this.encode(it.key, it.tid.b, it.tid.o) : this.sepEntry(it.key, it.tid, it.block)));
      const sizes = plan(items.length, leaf, bytes.map(cost));
      const blocks = sizes.map(() => { const f = this.buf.extend(this.file); const b = f.block; this.buf.unpin(f, false); return b; });
      const out = [];
      let at = 0;
      sizes.forEach((size, g) => {
        const n = this.pin(blocks[g]);
        n.p.init(SPECIAL); n.level = level; n.flags = leaf ? F.LEAF : 0;
        n.left = g ? blocks[g - 1] : NONE; n.right = g + 1 < blocks.length ? blocks[g + 1] : NONE;
        for (let k = 0; k < size; k++) {
          const it = items[at + k];
          const b = leaf || k ? bytes[at + k] : this.keyless(it.block);
          if (!n.p.add(b, 4, k + 1)) throw K.err(K.STATE.internal, 'bulk load overfilled node ' + n.block + '; use a lower fillfactor');
        }
        out.push({ block: blocks[g], key: items[at].key, tid: items[at].tid });
        this.logPage(n.f); this.unpin(n, true);
        at += size;
      });
      return out;
    };
    let level = 0;
    let nodes = es.length ? writeLevel(es, 0, true) : [];
    if (!nodes.length) { const f = this.buf.extend(this.file); const n = this.pin(f.block); this.buf.unpin(f, false); n.p.init(SPECIAL); n.level = 0; n.flags = F.LEAF; n.left = NONE; n.right = NONE; nodes = [{ block: n.block }]; this.logPage(n.f); this.unpin(n, true); }
    while (nodes.length > 1) nodes = writeLevel(nodes, ++level, false);
    const r = this.pin(nodes[0].block);
    r.flags |= F.ROOT; this.logPage(r.f); this.unpin(r, true);
    this.setMeta(new K.Page(mf.buf), nodes[0].block, level);
    this.logPage(mf); this.buf.unpin(mf, true);
    this.bus.emit('btree.bulkload', { index: this.idx.name, entries: es.length, levels: level + 1, fillfactor: ff * 100 });
    return { entries: es.length, levels: level + 1, root: nodes[0].block };
  };

  /**
   * A B-tree in memory, with keys in internal nodes as well as leaves (each key once). Order n: a node has at
   * most n children and n - 1 keys, and every node but the root at least ceil(n/2) children.
   */
  class BTreeClassic {
    constructor(opts) {
      opts = opts || {};
      this.order = Math.max(3, opts.order || opts.fanout || (opts.t ? opts.t * 2 : 4));
      this.cmp = opts.cmp || ((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      this.nextId = 1;
      this.root = this.node(true);
      this.size = 0;
      this.onStep = opts.onStep || null;
    }
    get maxKeys() { return this.order - 1; }
    get minKeys() { return Math.ceil(this.order / 2) - 1; }
    node(leaf) { return { id: this.nextId++, keys: [], kids: leaf ? null : [] }; }
    step(action, detail) { if (this.onStep) this.onStep(action, detail); }
    pos(n, key) { let i = 0; while (i < n.keys.length && this.cmp(n.keys[i], key) < 0) i++; return i; }
    search(key) {
      const path = [];
      let n = this.root;
      for (;;) {
        path.push(n.id);
        const i = this.pos(n, key);
        if (i < n.keys.length && this.cmp(n.keys[i], key) === 0) return { found: true, node: n.id, path, visited: path.length };
        if (!n.kids) return { found: false, path, visited: path.length };
        n = n.kids[i];
      }
    }
    insert(key) {
      const path = [];
      let n = this.root;
      for (;;) {
        const i = this.pos(n, key);
        if (i < n.keys.length && this.cmp(n.keys[i], key) === 0) { this.step('duplicate', { key }); return false; }
        if (!n.kids) { n.keys.splice(i, 0, key); break; }
        path.push({ n, i });
        n = n.kids[i];
      }
      this.size++;
      this.step('insert', { key, node: n.id });
      // split upwards while a node has too many keys: its middle key moves up to the parent
      while (n.keys.length > this.maxKeys) {
        const mid = Math.floor(n.keys.length / 2), up = n.keys[mid];
        const r = this.node(!n.kids);
        r.keys = n.keys.splice(mid + 1); n.keys.pop();
        if (n.kids) r.kids = n.kids.splice(mid + 1);
        const parentEntry = path.pop();
        if (!parentEntry) {
          const nr = this.node(false);
          nr.keys = [up]; nr.kids = [n, r];
          this.root = nr;
          this.step('split', { node: n.id, right: r.id, up });
          this.step('newroot', { node: nr.id });
          break;
        }
        const { n: p, i } = parentEntry;
        p.keys.splice(i, 0, up); p.kids.splice(i + 1, 0, r);
        this.step('split', { node: n.id, right: r.id, up });
        n = p;
      }
      return true;
    }
    delete(key) {
      const path = [];
      let n = this.root, i;
      for (;;) {
        i = this.pos(n, key);
        if (i < n.keys.length && this.cmp(n.keys[i], key) === 0) break;
        if (!n.kids) { this.step('missing', { key }); return false; }
        path.push({ n, i });
        n = n.kids[i];
      }
      if (n.kids) {
        // an internal key is replaced by its predecessor, the largest key of its left subtree, which is deleted from its leaf
        path.push({ n, i });
        let m = n.kids[i];
        while (m.kids) { path.push({ n: m, i: m.kids.length - 1 }); m = m.kids[m.kids.length - 1]; }
        n.keys[i] = m.keys[m.keys.length - 1];
        this.step('replace', { key, with: n.keys[i], node: n.id });
        m.keys.pop();
        n = m;
      } else n.keys.splice(i, 1);
      this.size--;
      this.step('delete', { key, node: n.id });
      while (n !== this.root && n.keys.length < this.minKeys) {
        const { n: p, i: ci } = path.pop();
        const left = ci > 0 ? p.kids[ci - 1] : null, right = ci < p.kids.length - 1 ? p.kids[ci + 1] : null;
        if (left && left.keys.length > this.minKeys) {
          // borrow through the parent: the separator comes down, the sibling's last key goes up
          n.keys.unshift(p.keys[ci - 1]); p.keys[ci - 1] = left.keys.pop();
          if (left.kids) n.kids.unshift(left.kids.pop());
          this.step('redistribute', { from: left.id, to: n.id });
          return true;
        }
        if (right && right.keys.length > this.minKeys) {
          n.keys.push(p.keys[ci]); p.keys[ci] = right.keys.shift();
          if (right.kids) n.kids.push(right.kids.shift());
          this.step('redistribute', { from: right.id, to: n.id });
          return true;
        }
        // merge with a sibling, pulling the separator down between them
        const [a, b, si] = left ? [left, n, ci - 1] : [n, right, ci];
        a.keys.push(p.keys[si], ...b.keys);
        if (a.kids) a.kids.push(...b.kids);
        p.keys.splice(si, 1); p.kids.splice(si + 1, 1);
        this.step('merge', { left: a.id, right: b.id });
        n = p;
      }
      if (!this.root.keys.length && this.root.kids) { this.root = this.root.kids[0]; this.step('shrink', { root: this.root.id }); }
      return true;
    }
    range(lo, hi) {
      const out = [];
      let visited = 0;
      const walk = (n) => {
        visited++;
        for (let i = 0; i <= n.keys.length; i++) {
          if (n.kids && (i === 0 || this.cmp(n.keys[i - 1], lo) >= 0) && (i === n.keys.length || this.cmp(n.keys[i], lo) >= 0) && (i === 0 || this.cmp(n.keys[i - 1], hi) <= 0)) walk(n.kids[i]);
          if (i < n.keys.length && this.cmp(n.keys[i], lo) >= 0 && this.cmp(n.keys[i], hi) <= 0) out.push(n.keys[i]);
        }
      };
      walk(this.root);
      return { keys: out, visited };
    }
    keys() { const out = []; const w = (n) => { for (let i = 0; i <= n.keys.length; i++) { if (n.kids) w(n.kids[i]); if (i < n.keys.length) out.push(n.keys[i]); } }; w(this.root); return out; }
    height() { let h = 1, n = this.root; while (n.kids) { h++; n = n.kids[0]; } return h; }
    describe() {
      const walk = (n) => ({ id: n.id, leaf: !n.kids, keys: n.keys.slice(), children: n.kids ? n.kids.map(walk) : [] });
      return { kind: 'btree', order: this.order, maxKeys: this.maxKeys, minKeys: this.minKeys, size: this.size, height: this.height(), root: walk(this.root) };
    }
  }

  K.BTreeClassic = BTreeClassic;
})(typeof window !== 'undefined' ? window : globalThis);
