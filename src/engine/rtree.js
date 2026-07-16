// R-trees (CREATE INDEX ... USING rtree (x, y), or USING gist): Guttman's R-tree with the quadratic split,
// over numeric columns read as a point (two columns x, y), a box (four columns xmin, ymin, xmax, ymax) or an
// interval on the x axis (one column). Every node is a page of entries, each a minimum bounding rectangle
// (four float8: min x, min y, max x, max y) and a child block, or in a leaf the B+ tree's encoding of
// (key, heap TID). A query's bounds on the key columns make a window; subtrees whose rectangle cannot hold
// a match are skipped, and leaf keys are compared exactly. Rows with a NULL coordinate are kept on a chain
// of pages of their own, so IS NULL can still be answered from the index.
//
// Options: max_entries (M, default what fits on a page), min_entries (m, default 40% of M).
// Deletion (VACUUM) is Guttman's: the entry is removed, underfull nodes on the way up are dissolved and
// their entries reinserted (CondenseTree), and a root left with one child is replaced by it.
// Node special area: level (4), flags (4: 1 = leaf), next page for the NULL chain (4).
//
// Also here, in memory only, for the spatial playground: K.KDTree and K.QuadTree.
(function (root) {
  'use strict';
  const K = root.K;
  const NONE = K.INDEX_NONE;
  const FIELDS = ['magic', 'root', 'levels', 'maxE', 'minE', 'nulls', 'splits', 'ntuples', 'reinserts', 'condensed', 'free'];
  const MAGIC = 0x52545245;
  const LEAF = 1;
  const MBR = 32;

  const area = (r) => (r[2] - r[0]) * (r[3] - r[1]);
  const union = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
  const enlarge = (r, by) => area(union(r, by)) - area(r);
  const cover = (es) => es.reduce((a, e) => (a ? union(a, e.mbr) : e.mbr.slice()), null);
  const contains = (a, b) => a[0] <= b[0] && a[1] <= b[1] && a[2] >= b[2] && a[3] >= b[3];
  const num = (v) => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : v instanceof K.Decimal ? v.toNumber() : Number(v));

  class RTree extends K.IndexBase {
    constructor(db, idx) {
      super(db, idx, 'rtree');
      if (![1, 2, 4].includes(this.nk)) throw K.err(K.STATE.featureNotSupported, 'an R-tree indexes 1 column (an interval on x), 2 columns (a point x, y) or 4 columns (a box xmin, ymin, xmax, ymax), not ' + this.nk);
      const bad = this.keyTypes.find((t) => t.cat !== 'N');
      if (bad) throw K.err(K.STATE.featureNotSupported, 'an R-tree needs numeric columns; ' + bad.name + ' is not');
      // which axis each key column bounds
      this.axes = this.nk === 1 ? [0] : this.nk === 2 ? [0, 1] : [0, 1, 0, 1];
      if (!this.nblocks()) this.init();
      const m = this.meta();
      this.M = m.maxE; this.m = m.minE;
    }
    init() {
      const mf = this.newPage();
      // a leaf entry holds the rectangle and the encoded key: size it by the widest value of each key's type
      const widest = (t) => (t.id === 'numeric' ? K.Decimal.parse('9'.repeat(Math.max(1, (t.p || 20) - (t.s || 0))) + ((t.s || 0) > 0 ? '.' + '9'.repeat(t.s) : '')) : t.id === 'int8' ? 0n : 0);
      const per = this.perPage(MBR + this.encode(this.keyTypes.map(widest), 0, 0).length);
      const M = Math.max(3, Math.floor(this.opt('max_entries', this.opt('fanout', per))));
      const m = { magic: MAGIC, levels: 1, maxE: M, minE: K.clamp(Math.floor(this.opt('min_entries', Math.max(1, Math.floor(M * 0.4)))), 1, Math.floor(M / 2)), nulls: NONE, free: NONE };
      m.root = this.newNode(m, 0, true, []);
      this.writeFields(0, FIELDS, m, mf);
    }
    meta() { return this.readFields(0, FIELDS); }
    saveMeta(m) { this.writeFields(0, FIELDS, m); }
    height() { return this.meta().levels; }

    // ---- nodes -------------------------------------------------------------------------------------------------------------
    mbrOf(key) {
      const c = key.map(num);
      if (this.nk === 1) return [c[0], 0, c[0], 0];
      if (this.nk === 2) return [c[0], c[1], c[0], c[1]];
      return [Math.min(c[0], c[2]), Math.min(c[1], c[3]), Math.max(c[0], c[2]), Math.max(c[1], c[3])];
    }
    pack(e, leaf) {
      const tail = leaf ? this.encode(e.key, e.b, e.o) : new Uint8Array(4);
      const out = new Uint8Array(MBR + tail.length);
      const dv = new DataView(out.buffer);
      for (let i = 0; i < 4; i++) dv.setFloat64(i * 8, e.mbr[i], true);
      if (leaf) out.set(tail, MBR); else dv.setUint32(MBR, e.child >>> 0, true);
      return out;
    }
    unpack(bytes, leaf) {
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const mbr = [0, 1, 2, 3].map((i) => dv.getFloat64(i * 8, true));
      if (!leaf) return { mbr, child: dv.getUint32(MBR, true) };
      const x = this.decode(bytes.subarray(MBR));
      return { mbr, key: x.key, b: x.b, o: x.o };
    }
    newNode(m, level, leaf, entries) {
      let f;
      if (m.free !== NONE) { f = this.pin(m.free); m.free = this.sp32(f, 2); } else f = this.buf.extend(this.file);
      const b = f.block;
      this.buf.unpin(f, false);
      this.writeNode(b, level, leaf, entries);
      return b;
    }
    readNode(block) {
      const f = this.pin(block);
      const level = this.sp32(f, 0), leaf = !!(this.sp32(f, 1) & LEAF);
      const entries = this.items(f).map((it) => this.unpack(it, leaf));
      this.unpin(f, false);
      return { block, level, leaf, entries };
    }
    writeNode(block, level, leaf, entries) {
      const f = this.buf.pin(this.file, block);
      this.page(f).init(K.INDEX_SPECIAL);
      this.setSp32(f, 0, level); this.setSp32(f, 1, leaf ? LEAF : 0); this.setSp32(f, 2, NONE);
      for (const e of entries) if (!this.page(f).add(this.pack(e, leaf), 8)) { this.buf.unpin(f, false); throw K.err(K.STATE.internal, 'R-tree node ' + block + ' overflows its page; use a smaller max_entries'); }
      this.unpin(f, true);
    }
    /** do a node's entries fit on one page? (wide keys, such as long numerics, can fill it before M entries) */
    fits(node) { return node.entries.reduce((a, e) => a + ((this.pack(e, node.leaf).length + 7) & ~7) + 4, 0) <= this.pageSize - K.PAGE_HDR - K.INDEX_SPECIAL; }
    freeNode(m, block) { const f = this.buf.pin(this.file, block); this.page(f).init(K.INDEX_SPECIAL); this.setSp32(f, 2, m.free); m.free = block; this.unpin(f, true); }

    // ---- inserting ---------------------------------------------------------------------------------------------------------
    insert(vals, tid, ctx) {
      const key = this.keyOf(vals, ctx).map((v) => (v === undefined ? null : v));
      const m = this.meta();
      m.ntuples++;
      if (key.some((v) => v === null || Number.isNaN(num(v)))) { this.addNull(m, key, tid); this.saveMeta(m); return; }
      const e = { mbr: this.mbrOf(key), key, b: tid.b, o: tid.o };
      this.emit('insert', { key, tid, mbr: e.mbr });
      this.insertAt(m, e, 0);
      this.saveMeta(m);
    }
    /** put an entry into a node at a level (0 = leaves), choosing the subtree needing least enlargement */
    insertAt(m, e, level) {
      const path = [];
      let node = this.readNode(m.root);
      while (node.level > level) {
        let best = -1, bestEn = Infinity, bestArea = Infinity;
        node.entries.forEach((c, i) => { const en = enlarge(c.mbr, e.mbr), ar = area(c.mbr); if (en < bestEn || (en === bestEn && ar < bestArea)) { best = i; bestEn = en; bestArea = ar; } });
        path.push({ node, i: best });
        node = this.readNode(node.entries[best].child);
      }
      node.entries.push(e);
      this.adjust(m, node, path);
    }
    /** write a changed node, splitting it if it has more than M entries, and fix the rectangles up to the root */
    adjust(m, node, path) {
      let split = null;
      if (node.entries.length > m.maxE || !this.fits(node)) split = this.split(m, node);
      else this.writeNode(node.block, node.level, node.leaf, node.entries);
      for (let k = path.length - 1; k >= 0; k--) {
        const { node: parent, i } = path[k];
        parent.entries[i] = { mbr: cover(node.entries), child: node.block };
        if (split) parent.entries.push({ mbr: cover(split.entries), child: split.block });
        node = parent;
        split = node.entries.length > m.maxE || !this.fits(node) ? this.split(m, node) : null;
        if (!split) this.writeNode(node.block, node.level, node.leaf, node.entries);
      }
      if (split) {
        // the root split: a new root over the two halves
        const r = this.newNode(m, node.level + 1, false, [{ mbr: cover(node.entries), child: node.block }, { mbr: cover(split.entries), child: split.block }]);
        m.root = r; m.levels++;
        this.note(m, 'newroot', { block: r, levels: m.levels });
      }
    }
    /** Guttman's quadratic split: the two entries that would waste most area together seed two groups */
    split(m, node) {
      const es = node.entries.slice();
      let s1 = 0, s2 = 1, worst = -Infinity;
      for (let i = 0; i < es.length; i++) for (let j = i + 1; j < es.length; j++) { const d = area(union(es[i].mbr, es[j].mbr)) - area(es[i].mbr) - area(es[j].mbr); if (d > worst) { worst = d; s1 = i; s2 = j; } }
      const g1 = [es[s1]], g2 = [es[s2]];
      let r1 = es[s1].mbr.slice(), r2 = es[s2].mbr.slice();
      const rest = es.filter((_, i) => i !== s1 && i !== s2);
      while (rest.length) {
        // a group that needs all the rest to reach the minimum takes them
        if (g1.length + rest.length <= m.minE) { g1.push(...rest.splice(0)); break; }
        if (g2.length + rest.length <= m.minE) { g2.push(...rest.splice(0)); break; }
        let pick = 0, diff = -1;
        rest.forEach((e, i) => { const d = Math.abs(enlarge(r1, e.mbr) - enlarge(r2, e.mbr)); if (d > diff) { diff = d; pick = i; } });
        const e = rest.splice(pick, 1)[0];
        const d1 = enlarge(r1, e.mbr), d2 = enlarge(r2, e.mbr);
        const to1 = d1 < d2 || (d1 === d2 && (area(r1) < area(r2) || (area(r1) === area(r2) && g1.length <= g2.length)));
        if (to1) { g1.push(e); r1 = union(r1, e.mbr); } else { g2.push(e); r2 = union(r2, e.mbr); }
      }
      node.entries = g1;
      this.writeNode(node.block, node.level, node.leaf, g1);
      const nb = this.newNode(m, node.level, node.leaf, g2);
      m.splits++;
      this.note(m, 'split', { block: node.block, newBlock: nb, level: node.level, leaf: node.leaf, seeds: [es[s1].mbr, es[s2].mbr], sizes: [g1.length, g2.length] });
      return { block: nb, entries: g2 };
    }
    addNull(m, key, tid) {
      const bytes = this.encode(key, tid.b, tid.o);
      let b = m.nulls, last = null;
      while (b !== NONE) {
        const f = this.pin(b);
        if (this.fits(f, bytes.length)) { this.page(f).add(bytes, 4); this.unpin(f, true); if (last) this.unpin(last, false); return; }
        if (last) this.unpin(last, false);
        last = f; b = this.sp32(f, 2);
      }
      const nf = this.newPage();
      this.setSp32(nf, 2, NONE);
      this.page(nf).add(bytes, 4);
      if (last) { this.setSp32(last, 2, nf.block); this.unpin(last, true); } else m.nulls = nf.block;
      this.unpin(nf, true);
    }
    nullEntries(m) {
      const out = [];
      let b = m.nulls;
      while (b !== NONE) { const f = this.pin(b); for (const it of this.items(f)) { const x = this.decode(it); out.push({ key: x.key, b: x.b, o: x.o, block: b }); } const nx = this.sp32(f, 2); this.unpin(f, false); b = nx; }
      return out;
    }

    // ---- searching ---------------------------------------------------------------------------------------------------------
    /** the query window from bounds: per axis the lowest and highest coordinate a match can reach */
    windowOf(bounds) {
      const w = [-Infinity, -Infinity, Infinity, Infinity];
      // a box's min columns bound the rectangle from below only through its max side, and the other way round
      for (const b of bounds) {
        const a = this.axes[b.k];
        if (a === undefined || b.op === 'isnull' || b.op === 'notnull') continue;
        const vs = b.op === 'in' ? b.v.filter((v) => v !== null).map(num) : b.v === null || b.v === undefined ? [] : [num(b.v)];
        if (!vs.length) continue;
        const lo = Math.min(...vs), hi = Math.max(...vs);
        if (b.op === '=' || b.op === 'in' || b.op === '>' || b.op === '>=') w[a] = Math.max(w[a], lo);
        if (b.op === '=' || b.op === 'in' || b.op === '<' || b.op === '<=') w[a + 2] = Math.min(w[a + 2], hi);
      }
      return w;
    }
    /** can a rectangle hold an entry inside the window? */
    meets(r, w) { return r[2] >= w[0] && r[3] >= w[1] && r[0] <= w[2] && r[1] <= w[3]; }
    *search(bounds) {
      const m = this.meta();
      const out = [];
      const wantNull = bounds.some((b) => b.op === 'isnull');
      const hasCond = bounds.some((b) => b.op !== 'notnull' && b.op !== 'isnull');
      if (wantNull || !bounds.length) for (const e of this.nullEntries(m)) if (this.matches(e.key, bounds)) out.push({ b: e.b, o: e.o, key: e.key });
      if (!wantNull || !hasCond) {
        const w = this.windowOf(bounds);
        this.emit('window', { window: w });
        const stack = [m.root];
        while (stack.length) {
          const n = this.readNode(stack.pop());
          for (const e of n.entries) {
            if (!this.meets(e.mbr, w)) continue;
            if (n.leaf) { if (this.matches(e.key, bounds)) out.push({ b: e.b, o: e.o, key: e.key }); } else stack.push(e.child);
          }
        }
      }
      for (const e of out) yield e;
    }

    // ---- deleting (Guttman) ---------------------------------------------------------------------------------------------------
    /** find the leaf holding an entry: every subtree whose rectangle contains it may */
    findLeaf(m, mbr, match) {
      const walk = (block, path) => {
        const n = this.readNode(block);
        if (n.leaf) { const i = n.entries.findIndex(match); return i >= 0 ? { node: n, i, path } : null; }
        for (let i = 0; i < n.entries.length; i++) if (contains(n.entries[i].mbr, mbr)) { const r = walk(n.entries[i].child, path.concat([{ node: n, i }])); if (r) return r; }
        return null;
      };
      return walk(m.root, []);
    }
    deleteEntry(key, tid, mm) {
      const m = mm || this.meta();
      if (key.some((v) => v === null || Number.isNaN(num(v)))) {
        const e = this.nullEntries(m).find((x) => (!tid || (x.b === tid.b && x.o === tid.o)) && this.sameKey(x.key, key));
        if (!e) return false;
        const f = this.pin(e.block); const p = this.page(f);
        for (let i = 1; i <= p.nslots; i++) { const x = this.decode(p.item(i)); if (x.b === e.b && x.o === e.o) { p.removeAt(i); break; } }
        this.unpin(f, true);
        m.ntuples--;
        if (!mm) this.saveMeta(m);
        return true;
      }
      const mbr = this.mbrOf(key);
      const hit = this.findLeaf(m, mbr, (e) => (!tid || (e.b === tid.b && e.o === tid.o)) && this.sameKey(e.key, key));
      if (!hit) return false;
      hit.node.entries.splice(hit.i, 1);
      m.ntuples--;
      this.emit('delete', { key, tid: tid || { b: 0, o: 0 }, block: hit.node.block });
      this.condense(m, hit.node, hit.path);
      if (!mm) this.saveMeta(m);
      return true;
    }
    condense(m, node, path) {
      const orphans = [];
      for (let k = path.length - 1; k >= 0; k--) {
        const { node: parent, i } = path[k];
        if (node.entries.length < m.minE) {
          // dissolve the underfull node; its entries go back in from the top
          parent.entries.splice(i, 1);
          orphans.push({ level: node.level, leaf: node.leaf, entries: node.entries });
          this.freeNode(m, node.block);
          m.condensed++;
          this.note(m, 'condense', { block: node.block, level: node.level, orphans: node.entries.length });
        } else {
          this.writeNode(node.block, node.level, node.leaf, node.entries);
          parent.entries[i] = { mbr: cover(node.entries), child: node.block };
        }
        node = parent;
      }
      this.writeNode(node.block, node.level, node.leaf, node.entries);
      for (const o of orphans) for (const e of o.entries) { m.reinserts++; this.note(m, 'reinsert', { level: o.level, mbr: e.mbr }); this.insertAt(m, e, o.level); }
      // a root with a single child gives way to it
      for (;;) {
        const r = this.readNode(m.root);
        if (r.leaf || r.entries.length !== 1) break;
        this.freeNode(m, r.block);
        m.root = r.entries[0].child; m.levels--;
        this.note(m, 'shrink', { root: m.root, levels: m.levels });
      }
    }
    vacuum(isDead) {
      const m = this.meta();
      const dead = [];
      const walk = (block) => { const n = this.readNode(block); for (const e of n.entries) { if (!n.leaf) walk(e.child); else if (isDead({ b: e.b, o: e.o })) dead.push(e); } };
      walk(m.root);
      for (const e of this.nullEntries(m)) if (isDead({ b: e.b, o: e.o })) dead.push(e);
      let removed = 0;
      for (const e of dead) if (this.deleteEntry(e.key, { b: e.b, o: e.o }, m)) removed++;
      this.saveMeta(m);
      return removed;
    }
    describe() {
      return this.muted(() => {
        const m = this.meta();
        const nodes = [];
        const walk = (block) => {
          const n = this.readNode(block);
          const out = { block, level: n.level, leaf: n.leaf, mbr: cover(n.entries), entries: n.entries.map((e) => (n.leaf ? { mbr: e.mbr, key: e.key, tid: { b: e.b, o: e.o } } : { mbr: e.mbr, child: e.child })) };
          nodes.push(out);
          out.children = n.leaf ? [] : n.entries.map((e) => walk(e.child));
          return out;
        };
        const tree = walk(m.root);
        return {
          method: 'rtree', shape: this.nk === 4 ? 'box' : this.nk === 2 ? 'point' : 'interval', columns: this.idx.keys.map((k) => k.name), axes: this.axes.map((a) => 'xy'[a]),
          split: 'quadratic (Guttman)', maxEntries: m.maxE, minEntries: m.minE, levels: m.levels, root: m.root, meta: 0,
          ntuples: m.ntuples, stats: { splits: m.splits, condensed: m.condensed, reinserts: m.reinserts }, nodes: nodes.length, tree,
          nulls: this.nullEntries(m).map((e) => ({ key: e.key, tid: { b: e.b, o: e.o } })),
        };
      });
    }
  }

  // ---- in-memory spatial structures for the playground ------------------------------------------------------------------------
  const pt = (p) => (Array.isArray(p) ? { x: num(p[0]), y: num(p[1]) } : { x: num(p.x), y: num(p.y), data: p.data });
  const d2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
  const boxD2 = (q, b) => { const dx = Math.max(b.x0 - q.x, 0, q.x - b.x1), dy = Math.max(b.y0 - q.y, 0, q.y - b.y1); return dx * dx + dy * dy; };
  const rectOf = (lo, hi) => { const a = pt(lo), b = pt(hi); return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) }; };
  const inRect = (p, r) => p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1;

  /** a 2-d tree: each level splits on x then y, alternately */
  class KDTree {
    constructor(opts) { this.opts = opts || {}; this.root = null; this.size = 0; this.onStep = this.opts.onStep || null; }
    step(action, detail) { if (this.onStep) this.onStep(action, detail); }
    static build(points, opts) {
      const t = new KDTree(opts);
      const make = (ps, depth) => {
        if (!ps.length) return null;
        const axis = depth % 2, k = axis ? 'y' : 'x';
        ps.sort((a, b) => a[k] - b[k]);
        const mid = ps.length >> 1;
        return { p: ps[mid], axis, left: make(ps.slice(0, mid), depth + 1), right: make(ps.slice(mid + 1), depth + 1) };
      };
      t.root = make(points.map(pt), 0);
      t.size = points.length;
      t.step('build', { points: points.length, height: t.height() });
      return t;
    }
    height(n) { if (n === undefined) n = this.root; return n ? 1 + Math.max(this.height(n.left), this.height(n.right)) : 0; }
    insert(p) {
      p = pt(p);
      const node = { p, axis: 0, left: null, right: null };
      if (!this.root) { this.root = node; this.size++; this.step('insert', { point: p, depth: 0 }); return; }
      let n = this.root, depth = 0;
      for (;;) {
        const k = n.axis ? 'y' : 'x';
        const side = p[k] < n.p[k] ? 'left' : 'right';
        depth++;
        if (!n[side]) { node.axis = depth % 2; n[side] = node; break; }
        n = n[side];
      }
      this.size++;
      this.step('insert', { point: p, depth });
    }
    /** find a node with this point: { node, parent, side } */
    locate(p) {
      let n = this.root, parent = null, side = null, visited = 0;
      while (n) { visited++; if (n.p.x === p.x && n.p.y === p.y) return { node: n, parent, side, visited }; const k = n.axis ? 'y' : 'x'; parent = n; side = p[k] < n.p[k] ? 'left' : 'right'; n = n[side]; }
      return { node: null, visited };
    }
    search(p) { p = pt(p); const r = this.locate(p); return { found: !!r.node, point: r.node ? r.node.p : null, visited: r.visited }; }
    /** the node with the least coordinate on an axis in a subtree */
    minNode(n, axis) {
      if (!n) return null;
      const k = axis ? 'y' : 'x';
      let best = n;
      const l = this.minNode(n.left, axis); if (l && l.p[k] < best.p[k]) best = l;
      if (n.axis !== axis) { const r = this.minNode(n.right, axis); if (r && r.p[k] < best.p[k]) best = r; }
      return best;
    }
    delete(p) {
      p = pt(p);
      const del = (n, target) => {
        if (!n) return { n: null, done: false };
        if (n.p.x === target.x && n.p.y === target.y) {
          // replace with the minimum on this node's axis from the right subtree (or the left one, moved right)
          if (n.right) { const mn = this.minNode(n.right, n.axis); n.p = mn.p; this.step('replace', { with: mn.p }); n.right = del(n.right, mn.p).n; return { n, done: true }; }
          if (n.left) { const mn = this.minNode(n.left, n.axis); n.p = mn.p; this.step('replace', { with: mn.p }); n.right = del(n.left, mn.p).n; n.left = null; return { n, done: true }; }
          return { n: null, done: true };
        }
        const k = n.axis ? 'y' : 'x';
        const side = target[k] < n.p[k] ? 'left' : 'right';
        const r = del(n[side], target);
        n[side] = r.n;
        return { n, done: r.done };
      };
      if (!this.locate(p).node) return false;
      this.root = del(this.root, p).n;
      this.size--;
      this.step('delete', { point: p });
      return true;
    }
    range(lo, hi) {
      const r = rectOf(lo, hi), out = [];
      let visited = 0;
      const walk = (n) => {
        if (!n) return;
        visited++;
        if (inRect(n.p, r)) out.push(n.p);
        const k = n.axis ? 'y' : 'x', a = n.axis ? r.y0 : r.x0, b = n.axis ? r.y1 : r.x1;
        if (a < n.p[k]) walk(n.left);
        if (b >= n.p[k]) walk(n.right);
      };
      walk(this.root);
      return { points: out, visited };
    }
    nearest(q, k) {
      q = pt(q); k = k || 1;
      const best = [];
      const visitedPts = [];
      const walk = (n) => {
        if (!n) return;
        visitedPts.push(n.p);
        const d = d2(q, n.p);
        best.push({ p: n.p, d }); best.sort((a, b) => a.d - b.d); if (best.length > k) best.pop();
        const key = n.axis ? 'y' : 'x', diff = q[key] - n.p[key];
        const near = diff < 0 ? n.left : n.right, far = diff < 0 ? n.right : n.left;
        walk(near);
        // the far side can only help if the splitting line is closer than the k-th best
        if (best.length < k || diff * diff < best[best.length - 1].d) walk(far);
      };
      walk(this.root);
      return { points: best.map((b) => b.p), distances: best.map((b) => Math.sqrt(b.d)), visited: visitedPts.length, path: visitedPts };
    }
    all() { const out = []; const w = (n) => { if (!n) return; out.push(n.p); w(n.left); w(n.right); }; w(this.root); return out; }
    describe() {
      const walk = (n, b) => {
        if (!n) return null;
        const k = n.axis ? 'y' : 'x';
        const lb = Object.assign({}, b), rb = Object.assign({}, b);
        if (n.axis) { lb.y1 = n.p.y; rb.y0 = n.p.y; } else { lb.x1 = n.p.x; rb.x0 = n.p.x; }
        return { point: n.p, axis: k, split: n.p[k], bounds: b, left: walk(n.left, lb), right: walk(n.right, rb) };
      };
      return { kind: 'kdtree', size: this.size, height: this.height(), root: walk(this.root, { x0: -Infinity, y0: -Infinity, x1: Infinity, y1: Infinity }) };
    }
  }

  /** a point-region quadtree: a square splits into four when it holds more than capacity points */
  class QuadTree {
    constructor(opts) {
      this.opts = opts || {};
      const b = this.opts.bounds || [0, 0, 100, 100];
      this.capacity = Math.max(1, this.opts.capacity || 4);
      this.maxDepth = this.opts.maxDepth || 12;
      this.root = this.node(b[0], b[1], b[2], b[3], 0);
      this.size = 0;
      this.onStep = this.opts.onStep || null;
    }
    step(action, detail) { if (this.onStep) this.onStep(action, detail); }
    node(x0, y0, x1, y1, depth) { return { x0, y0, x1, y1, depth, points: [], kids: null }; }
    /** grow the root (doubling it) until the point is inside */
    grow(p) {
      while (!inRect(p, this.root)) {
        const r = this.root, w = r.x1 - r.x0, h = r.y1 - r.y0;
        const left = p.x < r.x0, below = p.y < r.y0;
        const nr = this.node(left ? r.x0 - w : r.x0, below ? r.y0 - h : r.y0, left ? r.x1 : r.x1 + w, below ? r.y1 : r.y1 + h, 0);
        this.subdivide(nr, true);
        const i = (left ? 1 : 0) + (below ? 2 : 0);
        nr.kids[i] = r;
        const bump = (n) => { n.depth++; if (n.kids) n.kids.forEach(bump); };
        bump(r);
        this.root = nr;
        this.step('grow', { bounds: [nr.x0, nr.y0, nr.x1, nr.y1] });
      }
    }
    subdivide(n, empty) {
      const mx = (n.x0 + n.x1) / 2, my = (n.y0 + n.y1) / 2, d = n.depth + 1;
      // children in order: south-west, south-east, north-west, north-east (y grows upwards)
      n.kids = [this.node(n.x0, n.y0, mx, my, d), this.node(mx, n.y0, n.x1, my, d), this.node(n.x0, my, mx, n.y1, d), this.node(mx, my, n.x1, n.y1, d)];
      if (empty) return;
      const ps = n.points; n.points = [];
      for (const p of ps) this.place(n, p);
      this.step('subdivide', { bounds: [n.x0, n.y0, n.x1, n.y1], depth: n.depth });
    }
    kidFor(n, p) { const mx = (n.x0 + n.x1) / 2, my = (n.y0 + n.y1) / 2; return n.kids[(p.x >= mx ? 1 : 0) + (p.y >= my ? 2 : 0)]; }
    place(n, p) {
      while (n.kids) n = this.kidFor(n, p);
      n.points.push(p);
      if (n.points.length > this.capacity && n.depth < this.maxDepth) this.subdivide(n);
      return n;
    }
    insert(p) { p = pt(p); this.grow(p); this.place(this.root, p); this.size++; this.step('insert', { point: p }); }
    search(p) {
      p = pt(p);
      let n = this.root, visited = 1;
      if (!inRect(p, n)) return { found: false, visited };
      while (n.kids) { n = this.kidFor(n, p); visited++; }
      const hit = n.points.find((q) => q.x === p.x && q.y === p.y);
      return { found: !!hit, point: hit || null, visited };
    }
    delete(p) {
      p = pt(p);
      if (!inRect(p, this.root)) return false;
      const path = [this.root];
      let n = this.root;
      while (n.kids) { n = this.kidFor(n, p); path.push(n); }
      const i = n.points.findIndex((q) => q.x === p.x && q.y === p.y);
      if (i < 0) return false;
      n.points.splice(i, 1);
      this.size--;
      this.step('delete', { point: p });
      // collapse squares whose four children together fit in one
      for (let k = path.length - 2; k >= 0; k--) {
        const q = path[k];
        if (q.kids.some((c) => c.kids)) break;
        const total = q.kids.reduce((a, c) => a + c.points.length, 0);
        if (total > this.capacity) break;
        q.points = q.kids.flatMap((c) => c.points); q.kids = null;
        this.step('merge', { bounds: [q.x0, q.y0, q.x1, q.y1], points: total });
      }
      return true;
    }
    range(lo, hi) {
      const r = rectOf(lo, hi), out = [];
      let visited = 0;
      const walk = (n) => {
        if (n.x1 < r.x0 || n.x0 > r.x1 || n.y1 < r.y0 || n.y0 > r.y1) return;
        visited++;
        if (n.kids) n.kids.forEach(walk); else for (const p of n.points) if (inRect(p, r)) out.push(p);
      };
      walk(this.root);
      return { points: out, visited };
    }
    /** best first: squares in order of their distance from the query point */
    nearest(q, k) {
      q = pt(q); k = k || 1;
      const queue = [{ d: boxD2(q, this.root), n: this.root }], best = [];
      let visited = 0;
      while (queue.length) {
        queue.sort((a, b) => a.d - b.d);
        const { d, n } = queue.shift();
        if (best.length >= k && d > best[best.length - 1].d) break;
        visited++;
        if (n.kids) for (const c of n.kids) queue.push({ d: boxD2(q, c), n: c });
        else for (const p of n.points) { best.push({ p, d: d2(q, p) }); best.sort((a, b) => a.d - b.d); if (best.length > k) best.pop(); }
      }
      return { points: best.map((b) => b.p), distances: best.map((b) => Math.sqrt(b.d)), visited };
    }
    height(n) { n = n || this.root; return 1 + (n.kids ? Math.max(...n.kids.map((c) => this.height(c))) : 0); }
    all() { const out = []; const w = (n) => { if (n.kids) n.kids.forEach(w); else out.push(...n.points); }; w(this.root); return out; }
    describe() {
      const walk = (n) => ({ bounds: [n.x0, n.y0, n.x1, n.y1], depth: n.depth, points: n.kids ? [] : n.points.slice(), children: n.kids ? n.kids.map(walk) : [] });
      return { kind: 'quadtree', size: this.size, capacity: this.capacity, height: this.height(), root: walk(this.root) };
    }
  }

  K.RTree = RTree;
  K.KDTree = KDTree;
  K.QuadTree = QuadTree;
  K.INDEX_AMS.rtree = (db, idx) => new RTree(db, idx);
  K.INDEX_AMS.gist = K.INDEX_AMS.rtree;
})(typeof window !== 'undefined' ? window : globalThis);
