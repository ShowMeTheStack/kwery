// Partitioning a relation across nodes (chapter 21): round-robin, hash and range partitioning, the skew each
// suffers from and the remedies (histogram-based range boundaries, virtual nodes), consistent hashing
// on a ring with virtual nodes, and a sharded table on real nodes that moves exactly the rows whose owner changes
// when a node joins or leaves. Rows are text, as the engines output them; numeric keys compare as numbers.
(function (root) {
  'use strict';
  const K = root.K;
  const C = K.Cluster = K.Cluster || {};

  const NUMERIC = /^(smallint|integer|bigint|int\d?|numeric|decimal|real|double precision|float\d?)/;
  const isNumType = (t) => !!t && NUMERIC.test(String(t));
  /** a canonical text form so equal values hash alike whatever their type: 65000.00 and 65000 are the same key */
  function canon(v, type) {
    if (v === null || v === undefined) return '\u0000';
    let s = String(v);
    if ((type === undefined || isNumType(type)) && /^-?\d+(\.\d+)?$/.test(s)) {
      const neg = s[0] === '-'; if (neg) s = s.slice(1);
      let [i, f] = s.split('.');
      i = i.replace(/^0+(?=\d)/, '');
      f = (f || '').replace(/0+$/, '');
      s = i + (f ? '.' + f : '');
      if (neg && s !== '0') s = '-' + s;
    }
    return s;
  }
  // FNV-1a alone barely changes its high bits when only the last character differs ('n1#3', 'n1#4'), which bunches
  // the points of a ring together; murmur3's finalizer spreads them
  const mix = (h) => { h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return h >>> 0; };
  const hashOf = (v, type) => mix(K.fnv(canon(v, type)));
  /** compare two text values of a column type; nulls sort last */
  function cmp(a, b, type) {
    if (a === b) return 0;
    if (a === null || a === undefined) return 1;
    if (b === null || b === undefined) return -1;
    if (isNumType(type)) { const x = Number(a), y = Number(b); return x < y ? -1 : x > y ? 1 : 0; }
    return a < b ? -1 : a > b ? 1 : 0;
  }

  /** how unevenly a partitioning spreads its rows */
  function skew(sizes) {
    const n = sizes.length, total = sizes.reduce((a, b) => a + b, 0), mean = total / (n || 1);
    const max = Math.max(...sizes), min = Math.min(...sizes);
    const sd = Math.sqrt(sizes.reduce((a, s) => a + (s - mean) * (s - mean), 0) / (n || 1));
    // the slowest node finishes last: with skew the parallel time is max/mean times the balanced time
    return { sizes: sizes.slice(), total, mean: +mean.toFixed(3), max, min, ratio: mean ? +(max / mean).toFixed(3) : 1, stdev: +sd.toFixed(3), cv: mean ? +(sd / mean).toFixed(3) : 0, speedupLoss: mean ? +(1 - mean / max).toFixed(3) : 0 };
  }

  const keyFn = (opts) => (typeof opts.key === 'function' ? opts.key : (row) => row[opts.key || 0]);
  function finish(scheme, n, rows, assign, trace, extra) {
    const parts = Array.from({ length: n }, () => []);
    assign.forEach((p, i) => parts[p].push(i));
    return Object.assign({ scheme, n, assign, parts, sizes: parts.map((p) => p.length), skew: skew(parts.map((p) => p.length)), trace }, extra || {});
  }
  /** row i goes to node i mod n */
  function roundRobin(rows, n) {
    const assign = rows.map((r, i) => i % n);
    return finish('round-robin', n, rows, assign, rows.map((r, i) => ({ row: i, node: i % n, why: i + ' mod ' + n })));
  }
  /** row goes to hash(key) mod n */
  function hash(rows, n, opts) {
    opts = opts || {};
    const kf = keyFn(opts);
    const trace = [];
    const assign = rows.map((r, i) => { const k = kf(r), h = hashOf(k, opts.type), p = h % n; trace.push({ row: i, key: k, hash: h, node: p, why: h + ' mod ' + n + ' = ' + p }); return p; });
    return finish('hash', n, rows, assign, trace, { key: opts.key });
  }
  /** boundaries [v0, v1, ...]: partition 0 takes key <= v0, partition i takes v(i-1) < key <= vi, the last the rest; nulls go to the last */
  function rangeOf(k, bounds, type) {
    if (k === null || k === undefined) return bounds.length;
    let lo = 0, hi = bounds.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cmp(k, bounds[m], type) <= 0) hi = m; else lo = m + 1; }
    return lo;
  }
  function range(rows, bounds, opts) {
    opts = opts || {};
    const kf = keyFn(opts);
    const trace = [];
    const assign = rows.map((r, i) => { const k = kf(r), p = rangeOf(k, bounds, opts.type); trace.push({ row: i, key: k, node: p, why: p === 0 ? '<= ' + bounds[0] : p === bounds.length ? '> ' + bounds[bounds.length - 1] : '(' + bounds[p - 1] + ', ' + bounds[p] + ']' }); return p; });
    return finish('range', bounds.length + 1, rows, assign, trace, { key: opts.key, bounds: bounds.slice() });
  }

  // ---- range boundaries ---------------------------------------------------------------------------------------
  /** equal-width ranges between the smallest and largest value (numeric keys): what a naive vector gives */
  function equiWidth(values, n) {
    const xs = values.filter((v) => v !== null).map(Number);
    const lo = Math.min(...xs), hi = Math.max(...xs), w = (hi - lo) / n;
    return K.range(n - 1).map((i) => String(+(lo + w * (i + 1)).toFixed(6)));
  }
  /** an equi-width frequency histogram with b buckets */
  function histogram(values, b, type) {
    const xs = values.filter((v) => v !== null);
    if (!isNumType(type)) {
      const m = new Map();
      for (const v of xs) m.set(v, (m.get(v) || 0) + 1);
      return [...m].sort((a, c) => cmp(a[0], c[0], type)).map(([v, c]) => ({ lo: v, hi: v, count: c }));
    }
    const ns = xs.map(Number), lo = Math.min(...ns), hi = Math.max(...ns), w = (hi - lo) / b || 1;
    const out = K.range(b).map((i) => ({ lo: lo + w * i, hi: i === b - 1 ? hi : lo + w * (i + 1), count: 0 }));
    for (const x of ns) out[Math.min(b - 1, Math.floor((x - lo) / w))].count++;
    return out;
  }
  /**
   * boundaries for n balanced partitions. method 'exact' sorts the values and cuts at the quantiles; 'histogram'
   * uses only a histogram, assuming values spread evenly inside a bucket (what a database keeps in its statistics).
   * A value that alone exceeds a partition's share cannot be split: that is attribute-value skew.
   */
  function equiDepth(values, n, opts) {
    opts = opts || {};
    const type = opts.type;
    const xs = values.filter((v) => v !== null).slice().sort((a, b) => cmp(a, b, type));
    if (!xs.length) return [];
    if (opts.method === 'histogram' && isNumType(type)) {
      const h = histogram(xs, opts.buckets || 10, type), total = xs.length, out = [];
      let acc = 0, bi = 0;
      for (let p = 1; p < n; p++) {
        const target = total * p / n;
        while (bi < h.length && acc + h[bi].count < target) acc += h[bi++].count;
        if (bi >= h.length) break;
        const b = h[bi], frac = b.count ? (target - acc) / b.count : 0;
        out.push(String(+(b.lo + (b.hi - b.lo) * frac).toFixed(6)));
      }
      return out;
    }
    const out = [];
    for (let p = 1; p < n; p++) { const v = xs[Math.min(xs.length - 1, Math.ceil(xs.length * p / n) - 1)]; if (!out.length || cmp(v, out[out.length - 1], type) > 0) out.push(v); }
    while (out.length < n - 1) out.push(out[out.length - 1]);
    return out;
  }

  /**
   * virtual-node partitioning: the relation is split into v virtual partitions (by hash or by range) which are then
   * mapped to the n real nodes round-robin, so a heavy virtual partition shares a node with light ones
   */
  function virtualNodes(rows, n, v, opts) {
    opts = opts || {};
    const kf = keyFn(opts);
    // the virtual partitions hash with a salt: h mod v mod n would be h mod n again whenever n divides v
    const inner = opts.scheme === 'range' ? range(rows, equiDepth(rows.map(kf), v, { type: opts.type }), opts) : hash(rows, v, Object.assign({}, opts, { key: (r) => '~' + canon(kf(r), opts.type), type: 'text' }));
    let map = K.range(inner.n).map((i) => i % n);
    if (Array.isArray(opts.map)) map = opts.map;
    else if (opts.map === 'balanced') {
      // largest virtual partition first, each to the least loaded node
      const load = new Array(n).fill(0);
      inner.sizes.map((s, i) => [s, i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]).forEach(([s, i]) => { const t = load.indexOf(Math.min(...load)); map[i] = t; load[t] += s; });
    }
    const assign = inner.assign.map((p) => map[p]);
    const trace = inner.trace.map((t) => Object.assign({}, t, { virtual: t.node, node: map[t.node] }));
    return finish('virtual-' + (opts.scheme || 'hash'), n, rows, assign, trace, { virtualSizes: inner.sizes, map });
  }

  /** every scheme on one column of a table, side by side: skew on real data */
  function compare(table, col, n, opts) {
    opts = opts || {};
    const ci = typeof col === 'number' ? col : table.cols.findIndex((c) => c.name === col);
    const type = table.cols[ci].type, rows = table.rows, vals = rows.map((r) => r[ci]);
    const out = { table: table.name, col: table.cols[ci].name, n, schemes: [] };
    const add = (name, r, note) => out.schemes.push({ name, sizes: r.sizes, skew: r.skew, bounds: r.bounds, note });
    add('round-robin', roundRobin(rows, n), 'perfectly even, but every lookup by key must ask all nodes');
    add('hash', hash(rows, n, { key: ci, type }), 'even when keys are many and spread; a frequent key value stays on one node');
    if (isNumType(type)) add('range, equal width', range(rows, equiWidth(vals, n), { key: ci, type }), 'boundaries ignore where the values are: partition skew');
    add('range, equi-depth (exact quantiles)', range(rows, equiDepth(vals, n, { type }), { key: ci, type }), 'balanced except where one value outweighs a share');
    if (isNumType(type)) add('range, histogram boundaries', range(rows, equiDepth(vals, n, { type, method: 'histogram', buckets: opts.buckets || 8 }), { key: ci, type }), 'boundaries from a histogram, assuming even spread within a bucket');
    add('virtual nodes (' + (opts.virtual || n * 4) + ' hash partitions)', virtualNodes(rows, n, opts.virtual || n * 4, { key: ci, type }), 'small virtual partitions dealt round-robin even out the load');
    add('virtual nodes, balanced mapping', virtualNodes(rows, n, opts.virtual || n * 4, { key: ci, type, map: 'balanced' }), 'largest virtual partition first to the least loaded node');
    const freq = new Map(); for (const v of vals) freq.set(v, (freq.get(v) || 0) + 1);
    const top = [...freq].sort((a, b) => b[1] - a[1]).slice(0, 5);
    out.valueSkew = { distinct: freq.size, top: top.map(([v, c]) => ({ value: v, count: c, share: +(c / rows.length).toFixed(3) })), share: rows.length / n };
    return out;
  }

  // ---- consistent hashing -------------------------------------------------------------------------------------
  const RING = 4294967296;
  /** a hash ring: each node owns the arc that ends at each of its virtual points; a key belongs to the next point clockwise */
  class Ring {
    constructor(opts) { opts = opts || {}; this.vnodes = opts.vnodes || 8; this.points = []; this.nodes = []; }
    pointHash(node, i) { return mix(K.fnv(String(node) + '#' + i)); }
    keyHash(k, type) { return hashOf(k, type); }
    addNode(id, vnodes) {
      if (this.nodes.includes(id)) return [];
      this.nodes.push(id);
      const pts = K.range(vnodes || this.vnodes).map((i) => ({ h: this.pointHash(id, i), node: id, v: i }));
      this.points = this.points.concat(pts).sort((a, b) => a.h - b.h || (a.node < b.node ? -1 : 1));
      return pts;
    }
    removeNode(id) { this.nodes = this.nodes.filter((n) => n !== id); this.points = this.points.filter((p) => p.node !== id); }
    pointFor(h) {
      let lo = 0, hi = this.points.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (this.points[m].h < h) lo = m + 1; else hi = m; }
      return this.points[lo % this.points.length];
    }
    owner(k, type) { return this.points.length ? this.pointFor(this.keyHash(k, type)).node : null; }
    /** the first n distinct nodes clockwise from the key: its replicas (Dynamo's preference list) */
    preference(k, n, type) {
      const h = this.keyHash(k, type);
      let i = this.points.indexOf(this.pointFor(h));
      const out = [];
      for (let s = 0; s < this.points.length && out.length < n; s++, i = (i + 1) % this.points.length) if (!out.includes(this.points[i].node)) out.push(this.points[i].node);
      return out;
    }
    /** the share of the ring each node owns */
    shares() {
      const out = {}; for (const n of this.nodes) out[n] = 0;
      this.points.forEach((p, i) => { const prev = i ? this.points[i - 1].h : this.points[this.points.length - 1].h - RING; out[p.node] += (p.h - prev) / RING; });
      for (const n of this.nodes) out[n] = +out[n].toFixed(4);
      return out;
    }
    /** for drawing: points at angles, and the arcs between them */
    view() {
      return {
        nodes: this.nodes.slice(),
        points: this.points.map((p) => ({ node: p.node, v: p.v, hash: p.h, angle: +(p.h / RING * 360).toFixed(3) })),
        arcs: this.points.map((p, i) => ({ node: p.node, from: i ? this.points[i - 1].h : this.points[this.points.length - 1].h, to: p.h })),
        shares: this.shares(),
      };
    }
    clone() { const r = new Ring({ vnodes: this.vnodes }); r.points = this.points.slice(); r.nodes = this.nodes.slice(); return r; }
  }

  // ---- a sharded table on real nodes ------------------------------------------------------------------------------
  /**
   * One table spread over C.Node engines under a scheme ('hash' mod n, 'consistent', 'range', 'round-robin').
   * Adding or removing a node computes every row's new owner and moves the rows whose owner changed, one by one:
   * each move is a message on the net and an INSERT at the new node and a DELETE at the old one.
   */
  class Shards {
    constructor(opts) {
      opts = opts || {};
      this.scheme = opts.scheme || 'consistent';
      this.net = opts.net || new C.Net({ seed: opts.seed || 1, latency: opts.latency || 2 });
      this.ring = new Ring({ vnodes: opts.vnodes || 8 });
      this.nodes = [];
      this.moves = [];
      for (const id of opts.nodes || ['n1', 'n2', 'n3']) this.join(id, true);
    }
    join(id, quiet) {
      const n = this.net.node(id) || this.net.add(id, new C.Node(id, { role: 'shard' }));
      this.nodes.push(id);
      this.ring.addNode(id);
      if (this.table && this.table.cols) n.createTable(this.table.name, this.table.cols, { replace: true });
      if (!quiet) this.net.note(id, 'join', { nodes: this.nodes.slice() });
      return n;
    }
    load(table, opts) {
      opts = opts || {};
      this.table = { name: table.name, cols: table.cols };
      this.keyCol = typeof opts.key === 'number' ? opts.key : Math.max(0, table.cols.findIndex((c) => c.name === opts.key));
      this.type = table.cols[this.keyCol].type;
      this.rows = table.rows.map((r) => r.slice());
      if (this.scheme === 'range') this.bounds = opts.bounds || equiDepth(this.rows.map((r) => r[this.keyCol]), this.nodes.length, { type: this.type });
      this.owner = this.rows.map((r, i) => this.ownerOf(r, i));
      for (const id of this.nodes) {
        const n = this.net.node(id);
        n.createTable(table.name, table.cols, { replace: true });
        n.insert(table.name, this.rows.filter((r, i) => this.owner[i] === id));
      }
      return this.sizes();
    }
    ownerOf(row, i) {
      const k = row[this.keyCol];
      switch (this.scheme) {
        case 'hash': return this.nodes[hashOf(k, this.type) % this.nodes.length];
        case 'consistent': return this.ring.owner(k, this.type);
        case 'range': return this.nodes[Math.min(this.nodes.length - 1, rangeOf(k, this.bounds, this.type))];
        default: return this.nodes[i % this.nodes.length];
      }
    }
    sizes() { const out = {}; for (const id of this.nodes) out[id] = this.net.node(id).count(this.table.name); return out; }
    /** move every row whose owner differs under the current layout; returns the moves */
    relocate(why) {
      const moves = [];
      const next = this.rows.map((r, i) => this.ownerOf(r, i));
      const keyName = this.table.cols[this.keyCol].name;
      const byFrom = new Map();
      this.rows.forEach((r, i) => {
        if (next[i] === this.owner[i]) return;
        const m = { row: i, key: r[this.keyCol], from: this.owner[i], to: next[i], why };
        moves.push(m);
        if (!byFrom.has(m.from)) byFrom.set(m.from, []);
        byFrom.get(m.from).push(m);
      });
      for (const [from, ms] of byFrom) {
        const src = this.net.node(from);
        // all rows with one key move together under the key-based schemes; round-robin moves rows by their ctid
        const keyed = this.scheme !== 'round-robin';
        const ctids = keyed ? null : src.query('select ctid, * from ' + C.ident(this.table.name)).rows;
        const gone = [];
        const byTo = new Map();
        for (const m of ms) {
          const row = this.rows[m.row];
          m.msg = this.net.send(from, m.to, 'move-row', { table: this.table.name, row }, { bytes: C.rowBytes(row) });
          if (!byTo.has(m.to)) byTo.set(m.to, []);
          byTo.get(m.to).push(row);
          if (keyed) continue;
          const hit = ctids.findIndex((c) => c && c.slice(1).every((v, j) => v === row[j]));
          gone.push(ctids[hit][0]);
          ctids[hit] = null;
        }
        for (const [to, rows] of byTo) this.net.node(to).insert(this.table.name, rows);
        if (gone.length) src.exec('delete from ' + C.ident(this.table.name) + ' where ctid in (' + gone.map((t) => "'" + t + "'").join(', ') + ')');
        if (keyed) {
          const keys = [...new Set(ms.map((m) => m.key))];
          const isNull = keys.includes(null), vals = keys.filter((k) => k !== null);
          const conds = [];
          if (vals.length) conds.push(C.ident(keyName) + ' in (' + vals.map(C.lit).join(', ') + ')');
          if (isNull) conds.push(C.ident(keyName) + ' is null');
          src.exec('delete from ' + C.ident(this.table.name) + ' where ' + conds.join(' or '));
        }
      }
      this.net.settle();
      this.owner = next;
      this.moves.push(...moves);
      return moves;
    }
    /** a new node joins; with consistent hashing only the keys on the arcs it takes over move, and all to it */
    addNode(id) {
      this.join(id);
      if (this.scheme === 'range') this.splitLargest(id);
      const moves = this.relocate('node ' + id + ' joined');
      return { node: id, moved: moves.length, total: this.rows.length, fraction: +(moves.length / this.rows.length).toFixed(4), moves, sizes: this.sizes() };
    }
    /** with range partitioning the new node takes the upper half of the largest range */
    splitLargest(id) {
      const old = this.nodes.slice(0, -1);
      const counts = old.map((n) => this.owner.filter((o) => o === n).length);
      const big = counts.indexOf(Math.max(...counts));
      const vals = this.rows.filter((r, i) => this.owner[i] === old[big]).map((r) => r[this.keyCol]).sort((a, b) => cmp(a, b, this.type));
      const mid = vals[Math.max(0, Math.ceil(vals.length / 2) - 1)];
      // node order follows the ranges: the new node goes right after the one it splits
      this.nodes = old.slice(0, big + 1).concat([id], old.slice(big + 1));
      this.bounds = this.bounds.slice(0, big).concat([mid], this.bounds.slice(big));
      if (this.bounds.length > this.nodes.length - 1) this.bounds.length = this.nodes.length - 1;
    }
    removeNode(id) {
      const i = this.nodes.indexOf(id);
      if (i < 0) return null;
      // the leaving node stays up until its rows are handed over
      this.nodes.splice(i, 1);
      this.ring.removeNode(id);
      if (this.scheme === 'range') this.bounds.splice(Math.min(i, this.bounds.length - 1), 1);
      const moves = this.relocate('node ' + id + ' left');
      this.net.note(id, 'leave', { nodes: this.nodes.slice() });
      this.net.node(id).dropTable(this.table.name);
      return { node: id, moved: moves.length, total: this.rows.length, fraction: +(moves.length / this.rows.length).toFixed(4), moves, sizes: this.sizes() };
    }
    /** recompute the layout for balance (range: fresh equi-depth boundaries) and move what must move */
    rebalance() {
      if (this.scheme === 'range') this.bounds = equiDepth(this.rows.map((r) => r[this.keyCol]), this.nodes.length, { type: this.type });
      const moves = this.relocate('rebalance');
      return { moved: moves.length, moves, sizes: this.sizes(), skew: skew(Object.values(this.sizes())) };
    }
    /** every source row is on exactly one node, at the node the layout says */
    check() {
      const seen = new Map();
      const key = (r) => JSON.stringify(r);
      for (const r of this.rows) seen.set(key(r), (seen.get(key(r)) || 0) + 1);
      const problems = [];
      for (const id of this.nodes) {
        for (const r of this.net.node(id).table(this.table.name).rows) {
          const k = key(r), c = seen.get(k);
          if (!c) problems.push({ node: id, row: r, problem: 'extra or duplicated' });
          else seen.set(k, c - 1);
        }
      }
      for (const [k, c] of seen) if (c) problems.push({ row: JSON.parse(k), problem: 'missing' });
      this.rows.forEach((r, i) => { if (this.ownerOf(r, i) !== this.owner[i]) problems.push({ row: r, problem: 'misplaced' }); });
      return { ok: !problems.length, problems };
    }
    view() { return { scheme: this.scheme, nodes: this.nodes.slice(), sizes: this.sizes(), bounds: this.bounds, ring: this.scheme === 'consistent' ? this.ring.view() : null, moves: this.moves.length }; }
  }

  C.Partition = {
    canon, hashOf, cmp, isNumType, skew, roundRobin, hash, range, rangeOf, equiWidth, equiDepth, histogram, virtualNodes, compare, Ring, Shards,
    describe() {
      return {
        name: 'Partitioning',
        text: 'Round-robin sends row i to node i mod n: perfectly even, but no key lookup can be routed. Hash partitioning sends a row to '
          + 'h(key) mod n: point lookups go to one node and joins on the key can run locally, but a frequent key value lands on one node '
          + '(attribute-value skew). Range partitioning keeps keys ordered, which serves range queries and sorting, but boundaries chosen '
          + 'without looking at the data overload some partitions (partition skew); boundaries from a histogram balance them. Virtual nodes '
          + 'split the data into many small partitions dealt out to the real nodes. Consistent hashing places nodes and keys on a ring, so '
          + 'a joining node takes over only the keys on its arcs, where hash mod n would move almost every key.',
        schemes: ['round-robin', 'hash', 'range', 'virtual-hash', 'virtual-range', 'consistent'],
      };
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
