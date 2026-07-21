// The index playground: index structures on their own, without a table, for stepping through how they
// change. K.IndexPlayground.make(kind, options) gives an object with insert(key), delete(key), search(key),
// range(lo, hi) and describe(), and a history of steps { action, detail, snapshot } with one entry per
// operation and one per structural change inside it (split, merge, redistribution, directory doubling,
// overflow page, flush, compaction, reinsertion ...), each with the structure as it was at that moment.
//
// The page-based kinds run on a small private disk and buffer pool of their own, so their pages are real
// pages and every operation reports how many it touched. Keys get made-up heap TIDs, rows_per_block to a block.
//
// kinds: bplus (option fanout, default 4), btree (option order, default 4), static-hash (buckets), extendible-hash,
// linear-hash (bucket_size, default 2, for all three), lsm (memtable_size, compaction, size_ratio, bloom_bits),
// bitmap, rtree (max_entries, default 4; keys are [x, y]), kdtree, quadtree (capacity, bounds).
(function (root) {
  'use strict';
  const K = root.K;

  const STRUCTURAL = new Set([
    'btree.split', 'btree.newroot', 'btree.merge', 'btree.redistribute', 'btree.shrink', 'btree.bulkload',
    'hash.split', 'hash.double', 'hash.overflow', 'hash.merge', 'hash.halve',
    'lsm.flush', 'lsm.compaction', 'bitmap.newkey',
    'rtree.split', 'rtree.newroot', 'rtree.condense', 'rtree.reinsert', 'rtree.shrink',
  ]);
  const KINDS = ['bplus', 'btree', 'static-hash', 'extendible-hash', 'linear-hash', 'lsm', 'bitmap', 'rtree', 'kdtree', 'quadtree'];

  /** a private disk and buffer pool: just enough of a database for an access method */
  function store(opts) {
    const bus = new K.Bus();
    const disk = new K.Disk({ pageSize: opts.pageSize || 4096, bus });
    const buffers = new K.BufferPool(disk, { frames: opts.frames || 64, bus });
    return { bus, disk, buffers, wal: { log: () => 0, flushedLsn: 0 }, catalog: null, settings: {} };
  }
  const T = () => K.T.BASE;

  class Playground {
    constructor(kind, options) {
      if (!KINDS.includes(kind)) throw K.err(K.STATE.invalidParameter, 'unknown index kind ' + kind + ' (one of ' + KINDS.join(', ') + ')');
      this.kind = kind;
      this.options = Object.assign({}, options || {});
      this.history = [];
      this.rowsPerBlock = this.options.rows_per_block || 8;
      this.rows = 0;
      this.tids = new Map(); // key text -> heap TIDs given to that key
      this.stepFn = (action, detail) => this.record(action, detail);
      const o = this.options;
      if (kind === 'btree') this.mem = new K.BTreeClassic({ order: o.order || o.fanout || o.n || 4, onStep: this.stepFn });
      else if (kind === 'kdtree') this.mem = new K.KDTree({ onStep: this.stepFn });
      else if (kind === 'quadtree') this.mem = new K.QuadTree({ capacity: o.capacity || 1, bounds: o.bounds, maxDepth: o.maxDepth, onStep: this.stepFn });
      else this.makePaged();
      this.record('create', { kind, options: this.options });
    }
    makePaged() {
      const o = this.options, kind = this.kind;
      this.db = store(o);
      const type = o.type === 'text' ? T().text : T().float8;
      const spatial = kind === 'rtree';
      const keys = spatial ? [{ attnum: 0, name: 'x', dir: 'asc' }, { attnum: 1, name: 'y', dir: 'asc' }] : [{ attnum: 0, name: 'key', dir: 'asc' }];
      const opts = {};
      if (kind === 'bplus') opts.fanout = o.fanout || o.n || 4;
      if (kind.endsWith('-hash')) { opts.scheme = kind.split('-')[0]; opts.bucket_size = o.bucket_size || o.bucketSize || 2; if (o.buckets) opts.buckets = o.buckets; if (o.fillfactor) opts.fillfactor = o.fillfactor; if (o.max_depth) opts.max_depth = o.max_depth; }
      if (kind === 'lsm') Object.assign(opts, { memtable_size: o.memtable_size || 4, compaction: o.compaction || 'leveled', size_ratio: o.size_ratio || 3, bloom_bits: o.bloom_bits || 8 }, o.bloom_hashes ? { bloom_hashes: o.bloom_hashes } : {}, o.page_entries ? { page_entries: o.page_entries } : { page_entries: 4 });
      if (spatial) { opts.max_entries = o.max_entries || o.fanout || 4; if (o.min_entries) opts.min_entries = o.min_entries; }
      this.idx = { name: kind, oid: 0, file: this.db.disk.createFile(kind, 'index'), keys, keyTypes: keys.map(() => type), options: opts, method: kind };
      const make = kind === 'bplus' ? (db, idx) => new K.BTree(db, idx) : K.INDEX_AMS[kind.endsWith('-hash') ? 'hash' : kind];
      this.am = make(this.db, this.idx);
      this.db.bus.on('*', (data, type) => { if (STRUCTURAL.has(type)) this.record(type.split('.')[1], data); });
    }
    get paged() { return !!this.am; }
    snapshot() {
      if (this.mem) return this.mem.describe();
      const s = this.am.describe();
      s.io = { pages: this.db.disk.blocks(this.idx.file), buffer: Object.assign({}, this.db.buffers.stats) };
      return s;
    }
    record(action, detail) { const r = { action, detail: detail || {}, snapshot: this.snapshot() }; this.history.push(r); return r; }
    /** run an operation and count the page accesses it made */
    measure(fn) {
      if (!this.paged) return { result: fn(), pages: null };
      const st = this.db.buffers.stats, before = st.hits + st.misses;
      const result = fn();
      return { result, pages: st.hits + st.misses - before };
    }
    keyVals(key) {
      if (this.kind === 'rtree') { const p = Array.isArray(key) ? key : [key.x, key.y]; return p.map(Number); }
      return [typeof key === 'string' && this.idx.keyTypes[0] !== T().text ? Number(key) : key];
    }
    keyText(vals) { return K.keyOf(vals); }
    nextTid() { const n = this.rows++; return { b: Math.floor(n / this.rowsPerBlock), o: (n % this.rowsPerBlock) + 1 }; }
    eqBounds(vals) { return vals.map((v, k) => ({ k, op: '=', v })); }

    insert(key) {
      if (this.mem) { const r = this.mem.insert(key); this.record('done', { op: 'insert', key }); return r !== false; }
      const vals = this.keyVals(key);
      const tid = this.nextTid();
      const { pages } = this.measure(() => this.am.insert(vals, tid));
      const t = this.keyText(vals);
      if (!this.tids.has(t)) this.tids.set(t, []);
      this.tids.get(t).push(tid);
      this.record('done', { op: 'insert', key, tid, pages });
      return true;
    }
    delete(key) {
      if (this.mem) { const r = this.mem.delete(key); this.record('done', { op: 'delete', key, found: !!r }); return !!r; }
      const vals = this.keyVals(key);
      const t = this.keyText(vals);
      const list = this.tids.get(t) || [];
      const tid = list[0];
      let ok = false;
      const { pages } = this.measure(() => {
        if (!tid) return;
        if (this.kind === 'bplus') ok = this.am.deleteKey(vals, tid);
        else ok = this.am.deleteEntry(vals, tid);
      });
      if (ok) list.shift();
      this.record('done', { op: 'delete', key, tid: tid || null, found: ok, pages });
      return ok;
    }
    search(key) {
      if (this.mem) { const r = this.mem.search(key); this.record('done', Object.assign({ op: 'search', key }, r)); return r; }
      const vals = this.keyVals(key);
      const { result, pages } = this.measure(() => [...this.am.search(this.eqBounds(vals))]);
      const r = { found: result.length > 0, tids: result.map((e) => ({ b: e.b, o: e.o })), pages };
      this.record('done', Object.assign({ op: 'search', key }, r));
      return r;
    }
    range(lo, hi) {
      if (this.mem) {
        const r = this.mem.range(lo, hi);
        this.record('done', Object.assign({ op: 'range', lo, hi }, r));
        return r;
      }
      const a = this.keyVals(lo), b = this.keyVals(hi);
      const bounds = a.flatMap((v, k) => { const [x, y] = v <= b[k] ? [v, b[k]] : [b[k], v]; return [{ k, op: '>=', v: x }, { k, op: '<=', v: y }]; });
      const { result, pages } = this.measure(() => [...this.am.search(bounds)]);
      const r = { keys: result.map((e) => (this.kind === 'rtree' ? e.key : e.key[0])), tids: result.map((e) => ({ b: e.b, o: e.o })), pages };
      if (this.kind !== 'rtree') r.keys.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
      this.record('done', Object.assign({ op: 'range', lo, hi }, r));
      return r;
    }
    nearest(q, k) {
      if (!this.mem || !this.mem.nearest) throw K.err(K.STATE.featureNotSupported, 'nearest neighbour search is for the k-d tree and the quadtree');
      const r = this.mem.nearest(q, k);
      this.record('done', Object.assign({ op: 'nearest', q, k: k || 1 }, r));
      return r;
    }
    /** bulk loading, for the B+ tree: build from these keys bottom up */
    bulkLoad(keys, fillfactor) {
      if (this.kind !== 'bplus') throw K.err(K.STATE.featureNotSupported, 'bulk loading is for the B+ tree');
      this.tids.clear(); this.rows = 0;
      const entries = keys.map((k) => { const vals = this.keyVals(k); const tid = this.nextTid(); const t = this.keyText(vals); if (!this.tids.has(t)) this.tids.set(t, []); this.tids.get(t).push(tid); return { key: vals, tid }; });
      const r = this.am.bulkLoad(entries, { fillfactor: fillfactor || this.options.fillfactor || 100 });
      this.record('done', Object.assign({ op: 'bulkload' }, r));
      return r;
    }
    /** an LSM tree's major compaction: everything into one run */
    compact() { if (this.kind !== 'lsm') throw K.err(K.STATE.featureNotSupported, 'compaction is for the LSM tree'); this.am.compactAll(); this.record('done', { op: 'compact' }); }
    flush() { if (this.kind !== 'lsm') throw K.err(K.STATE.featureNotSupported, 'flushing is for the LSM tree'); this.am.flush(); this.record('done', { op: 'flush' }); }
    describe() { return this.snapshot(); }
    /** the steps of the last operation (from just after the previous 'done') */
    lastSteps() { let i = this.history.length - 2; while (i >= 0 && this.history[i].action !== 'done' && this.history[i].action !== 'create') i--; return this.history.slice(i + 1); }
  }

  K.IndexPlayground = {
    kinds: KINDS,
    make: (kind, options) => new Playground(kind, options),
    Playground,
  };
})(typeof window !== 'undefined' ? window : globalThis);
