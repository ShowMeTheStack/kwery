// The index playground (chapters 14 and 24): one index structure on its own, with its parameters, fed with keys
// one operation at a time. Every structural step the structure takes (a split, a redistribution or coalescing,
// a directory doubling, an overflow page, a flush, a compaction) is a step of K.IndexPlayground's history with
// the structure as it was then, so each operation can be played, paused and stepped through backwards and
// forwards with a sentence saying what happened and why. Two comparisons: B+ tree against B-tree on the same
// keys, and the page writes of an LSM tree against a B+ tree on the same inserts.
(function (root) {
  'use strict';
  const K = root.K;
  const UI = K.UI;
  const { h } = UI;
  const D = () => UI.IdxDraw;

  const KINDS = [
    ['Trees', [['bplus', 'B+ tree'], ['btree', 'B-tree']]],
    ['Hashing', [['static-hash', 'Static hashing'], ['extendible-hash', 'Extendible hashing'], ['linear-hash', 'Linear hashing']]],
    ['Write-optimized and others', [['lsm', 'LSM tree'], ['bitmap', 'Bitmap index']]],
    ['Spatial (2-D points)', [['rtree', 'R-tree'], ['kdtree', 'k-d tree'], ['quadtree', 'Quadtree']]],
  ];
  const TITLE = Object.fromEntries(KINDS.flatMap((g) => g[1]));
  const SPATIAL = new Set(['rtree', 'kdtree', 'quadtree']);
  const PARAMS = {
    bplus: [['fanout', 'Fan-out n', [3, 4, 5, 6, 8, 10], 4]],
    btree: [['order', 'Order n', [3, 4, 5, 6, 8], 4]],
    'static-hash': [['buckets', 'Buckets', [2, 3, 4, 5, 8], 4], ['bucket_size', 'Bucket size', [1, 2, 3, 4], 2]],
    'extendible-hash': [['bucket_size', 'Bucket size', [1, 2, 3, 4], 2]],
    'linear-hash': [['bucket_size', 'Bucket size', [1, 2, 3, 4], 2], ['buckets', 'First buckets', [1, 2, 4], 2], ['fillfactor', 'Split above load %', [50, 75, 90, 100], 75]],
    lsm: [['memtable_size', 'Memtable', [2, 3, 4, 6, 8], 4], ['compaction', 'Compaction', ['leveled', 'tiered'], 'leveled'], ['size_ratio', 'Size ratio', [2, 3, 4], 3], ['bloom_bits', 'Bloom bits per key', [2, 4, 8, 10], 8]],
    bitmap: [['rows_per_block', 'Rows per heap block', [4, 8, 16, 32], 8]],
    rtree: [['max_entries', 'M (max entries)', [3, 4, 5, 6, 8], 4], ['min_entries', 'm (min entries)', [1, 2, 3, 4], 2]],
    kdtree: [],
    quadtree: [['capacity', 'Points per square', [1, 2, 3, 4], 1]],
  };
  const INTRO = {
    bplus: 'A B+ tree of fan-out n: leaves hold up to n − 1 keys, internal nodes up to n pointers, and every node but the root stays at least half full. Inserting into a full leaf splits it and copies the new leaf\'s first key up; deleting may borrow from a sibling (redistribution) or merge with it (coalescing).',
    btree: 'A B-tree of order n keeps every key exactly once, in a leaf or in an internal node, with its record pointer; a node holds up to n − 1 keys. A full node splits and moves its middle key up, so searches can end above the leaves, but internal nodes fit fewer keys.',
    'static-hash': 'A fixed number of buckets, each a page of a few entries; a key goes to bucket h(K) mod n. When a bucket fills, overflow pages are chained to it, and those chains grow as the file grows.',
    'extendible-hash': 'A directory of 2^i slots indexed by the first i bits of the hash. A full bucket splits on its next bit; the directory doubles only when the bucket\'s local depth already equals the global depth i.',
    'linear-hash': 'Buckets split one at a time, in order, at the split pointer, whenever the load passes a threshold; a key goes to h mod (n · 2^level), or twice that when the result is below the pointer. Overflow pages tide a full bucket over until its turn comes.',
    lsm: 'Inserts go to an in-memory memtable; a full memtable is written out as a sorted run, and runs are merged into deeper levels (leveled: one run per level; tiered: a few runs per level, merged together). A Bloom filter per run lets lookups skip it.',
    bitmap: 'One bitmap per key value, with bit i set when row i has that value (row i is TID (block, item), numbered block × slots per block + item − 1). Each bitmap is WAH-compressed: literal words of 31 bits and fill words for runs of zeros.',
    rtree: 'Over 2-D points: nodes hold up to M entries, each the bounding rectangle of a child; a new point goes down the child whose rectangle grows least, and an overfull node splits with Guttman\'s quadratic split. Click the plane to insert a point, drag a rectangle to query it.',
    kdtree: 'A binary tree whose levels split the plane alternately on x and on y at the point stored there. Click the plane to insert a point, drag a rectangle for a range query and see which nodes the search visits.',
    quadtree: 'A point-region quadtree: each node is a square; a square holding more points than its capacity splits into four quadrants (SW, SE, NW, NE). Click the plane to insert a point, drag a rectangle for a range query.',
  };
  const PRESETS = {
    bplus: [['Ten keys: 8 14 21 26 33 38 44 50 57 63', 'insert 8 14 21 26 33 38 44 50 57 63'], ['Ascending 1…20', 'insert ' + K.range(20).map((i) => i + 1).join(' ')], ['Then delete 21 26 33', 'delete 21 26 33']],
    btree: [['Ten keys: 8 14 21 26 33 38 44 50 57 63', 'insert 8 14 21 26 33 38 44 50 57 63'], ['Ascending 1…20', 'insert ' + K.range(20).map((i) => i + 1).join(' ')], ['Then delete 44 14', 'delete 44 14']],
    'static-hash': [['Twelve keys', 'insert 6 15 22 27 34 39 48 51 60 66 73 81'], ['Search 34', 'search 34']],
    'extendible-hash': [['Twelve keys', 'insert 6 15 22 27 34 39 48 51 60 66 73 81'], ['Then delete 15 22 27', 'delete 15 22 27']],
    'linear-hash': [['Twelve keys', 'insert 6 15 22 27 34 39 48 51 60 66 73 81'], ['Search 60', 'search 60']],
    lsm: [['Twenty keys', 'insert 50 12 77 3 91 34 60 8 25 44 70 15 88 1 39 66 20 95 57 30'], ['Search 44', 'search 44'], ['Delete 12', 'delete 12']],
    bitmap: [['Income levels', 'insert L1 L2 L1 L4 L3 L1 L2 L5 L3 L1 L2 L2'], ['Search L1', 'search L1'], ['Range L1…L2', 'range L1 L2']],
    rtree: [['Twelve points', 'insert (10,10) (20,15) (15,30) (70,80) (75,70) (80,85) (40,50) (45,40) (90,10) (85,20) (30,75) (60,30)'], ['Window (5,5)–(50,50)', 'range (5,5) (50,50)']],
    kdtree: [['Eight points', 'insert (42,58) (18,40) (12,77) (71,62) (88,14) (30,9) (57,83) (64,27)'], ['Range (15,15)–(65,70)', 'range (15,15) (65,70)']],
    quadtree: [['Eight points', 'insert (35,60) (20,45) (10,35) (80,65) (90,5) (25,10) (60,75) (50,20)'], ['Range (15,15)–(65,70)', 'range (15,15) (65,70)']],
  };
  const CMPL = [['fanout', 'B+ tree fan-out', [3, 4, 5, 6, 8, 10], 4, 'cmp'], ['memtable_size', 'Memtable', [4, 8, 16, 32, 64], 16, 'cmp'], ['compaction', 'Compaction', ['leveled', 'tiered'], 'leveled', 'cmp'], ['size_ratio', 'Size ratio', [2, 3, 4, 8], 4, 'cmp'], ['page_entries', 'LSM keys per page', [3, 4, 8, 16], 4, 'cmp']];
  const VERBS = { insert: 'insert', i: 'insert', add: 'insert', delete: 'delete', del: 'delete', d: 'delete', remove: 'delete', search: 'search', find: 'search', s: 'search', lookup: 'search', range: 'range', r: 'range', random: 'random' };

  /** "insert 2 3 5; search 7; range 5 20" → [{ op, vals }] (points as [x, y] for the 2-D kinds) */
  function parse(text, spatial, textKeys) {
    const out = [];
    for (const part of text.split(/[;\n]+/)) {
      const toks = part.match(/\(\s*-?[\d.]+\s*,\s*-?[\d.]+\s*\)|[^\s,()]+/g);
      if (!toks) continue;
      let op = null;
      if (VERBS[toks[0].toLowerCase()]) op = VERBS[toks.shift().toLowerCase()];
      let vals;
      if (spatial) {
        const nums = toks.flatMap((t) => t.replace(/[()]/g, '').split(',').map((x) => x.trim()).filter(Boolean)).map(Number);
        if (op === 'random') vals = [nums[0] || 10];
        else { vals = []; for (let i = 0; i + 1 < nums.length; i += 2) vals.push([nums[i], nums[i + 1]]); }
        if (nums.some((n) => !Number.isFinite(n))) throw new Error('points are written (x, y), for example (10, 20)');
      } else {
        vals = toks.map((t) => (textKeys ? t : Number(t)));
        if (!textKeys && vals.some((v) => !Number.isFinite(v))) throw new Error('keys here are numbers; "' + toks.find((t) => !Number.isFinite(Number(t))) + '" is not one');
      }
      out.push({ op, vals });
    }
    return out;
  }

  function create(app, el) {
    const store = UI.store;
    let kind = store.get('lab.kind', 'bplus');
    if (!PARAMS[kind]) kind = 'bplus';
    let params = Object.assign({}, store.get('lab.params.' + kind, {}));
    let mode = 'step';
    let pg = null, cur = 0, ops = [], timer = null, lastErr = null;
    let cmp = null;
    let oldPos = null;
    const head = h('div.view-head.ix-head');
    const body = h('div.view-body.ix-body');
    el.appendChild(head); el.appendChild(body);
    const canvas = D().canvas();
    const canvas2 = D().canvas();
    const P = (name) => { const d = PARAMS[kind].find((x) => x[0] === name); return params[name] !== undefined ? params[name] : d ? d[3] : undefined; };
    const options = () => {
      const o = {};
      for (const [k] of PARAMS[kind]) o[k] = P(k);
      if (kind === 'bitmap') o.type = 'text';
      if (kind === 'rtree' && o.min_entries > Math.floor(o.max_entries / 2)) o.min_entries = Math.max(1, Math.floor(o.max_entries / 2));
      return o;
    };
    const textKeys = () => kind === 'bitmap';
    const rnd = (() => { let x = 12345; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; })();

    // ---- running operations -----------------------------------------------------------------------------------------
    const fresh = () => { stop(); pg = K.IndexPlayground.make(kind, options()); cur = 0; };
    const apply1 = (target, op, v) => {
      if (op === 'insert') target.insert(v);
      else if (op === 'delete') target.delete(v);
      else if (op === 'search') target.search(v);
    };
    /** run parsed commands on the playground; returns the history index the new steps start at */
    const run = (cmds, defOp, quiet) => {
      const start = pg.history.length;
      for (const c of cmds) {
        let op = c.op || defOp;
        let vals = c.vals;
        if (op === 'random') {
          const n = Math.min(200, Math.max(1, (SPATIAL.has(kind) ? vals[0] : vals[0]) || 10));
          vals = K.range(n).map(() => (SPATIAL.has(kind) ? [Math.round(rnd() * 96) + 2, Math.round(rnd() * 96) + 2] : kind === 'bitmap' ? 'L' + (1 + Math.floor(rnd() * 5)) : Math.floor(rnd() * 99) + 1));
          op = 'insert';
        }
        if (op === 'range') {
          if (vals.length < 2) throw new Error('a range needs two ' + (SPATIAL.has(kind) ? 'corners, (x1, y1) (x2, y2)' : 'keys, low and high'));
          pg.range(vals[0], vals[1]);
          ops.push({ op, vals: [vals[0], vals[1]] });
          continue;
        }
        if (!vals.length) throw new Error('type some ' + (SPATIAL.has(kind) ? 'points, like (10, 20) (30, 40)' : 'keys, like 2 3 5 7'));
        for (const v of vals) apply1(pg, op, v);
        ops.push({ op, vals });
      }
      if (!quiet) { cur = Math.min(start, pg.history.length - 1); play(); }
      return start;
    };
    const exec = (text, defOp) => {
      lastErr = null;
      try {
        const cmds = mode === 'step' ? parse(text, SPATIAL.has(kind), textKeys()) : parse(text, false, false);
        if (!cmds.length) { UI.toast('Type some keys first, or pick a sequence below', 'warn'); return; }
        if (mode === 'step') run(cmds, defOp);
        else runCompare(cmds, defOp);
      } catch (e) { lastErr = e.message; UI.toast(e.message, 'err', 5000); }
      view.render();
    };
    /** after a parameter change: the same operations on a new structure */
    const replay = () => {
      const old = ops;
      fresh(); ops = [];
      try { for (const o of old) run([o], o.op, true); } catch (e) { UI.toast(e.message, 'err'); }
      cur = pg.history.length - 1;
    };

    // ---- stepping ------------------------------------------------------------------------------------------------------
    function stop() { if (timer) { clearInterval(timer); timer = null; } }
    function play() {
      stop();
      if (cur >= pg.history.length - 1) return;
      timer = setInterval(() => { if (cur >= pg.history.length - 1 || !el.isConnected) { stop(); view.render(); return; } cur++; view.render(); }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 300 : 850);
    }
    const go = (i) => { stop(); cur = Math.max(0, Math.min(pg.history.length - 1, i)); view.render(); };

    // ---- what a step did: a sentence, and what to light up ------------------------------------------------------------
    const kt = (v) => (Array.isArray(v) ? '(' + v.map((x) => D().val(x)).join(', ') + ')' : D().key(v, null, 20));
    const nkey = (k) => (Array.isArray(k) ? D().key(k, null, 20) : kt(k));
    const plural = UI.plural;
    /** the next snapshot (within this operation) in which a block shows up: for nodes a split wrote but not yet linked */
    function laterNode(i, block, nodesOf) {
      for (let j = i + 1; j < pg.history.length; j++) {
        const n = nodesOf(pg.history[j].snapshot).find((x) => x.block === block);
        if (n) return n;
        if (pg.history[j].action === 'done') break;
      }
      return null;
    }
    const hashOf = (key) => K.indexHash([key], pg.idx.keyTypes);
    const slotOf = (snap, hv) => {
      if (snap.scheme === 'extendible') return snap.globalDepth ? hv >>> (32 - snap.globalDepth) : 0;
      if (snap.scheme === 'static') return hv % snap.nbuckets;
      const span = snap.initialBuckets * 2 ** snap.level;
      const b = hv % span;
      return b < snap.next ? hv % (span * 2) : b;
    };
    /** the B+ tree search from the root, as the engine does it: the leaf where (key, -inf) belongs, then right along the chain */
    function bplusWalk(snap, lo, hi) {
      const byBlock = new Map(snap.nodes.map((n) => [n.block, n]));
      const path = [];
      let n = snap.tree;
      while (n && !n.leaf) {
        path.push(n.block);
        let j = 0;
        for (let i = 1; i < n.entries.length; i++) if (n.entries[i].key[0] < lo) j = i;
        n = n.children[j];
      }
      const leaves = [];
      while (n) {
        leaves.push(n.block);
        const last = n.entries[n.entries.length - 1];
        if (last && last.key[0] > hi) break;
        n = n.right !== null ? byBlock.get(n.right) : null;
      }
      return { path: path.concat(leaves.slice(0, 1)), leaves };
    }
    function btreeVisits(snap, lo, hi) {
      const ids = [];
      const w = (n) => { ids.push(n.id); if (!n.children.length) return; for (let i = 0; i <= n.keys.length; i++) if ((i === 0 || n.keys[i - 1] <= hi) && (i === n.keys.length || n.keys[i] >= lo)) w(n.children[i]); };
      w(snap.root);
      return ids;
    }
    const meets = (r, w) => r[2] >= w[0] && r[3] >= w[1] && r[0] <= w[2] && r[1] <= w[3];
    const winOf = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];

    function explain(i) {
      const st = pg.history[i], d = st.detail || {}, snap = st.snapshot, a = st.action;
      const hi = { visited: new Set(), path: new Set(), cur: new Set(), split: new Set(), fresh: new Set(), tids: new Set(), keys: new Set(), found: new Set() };
      let tag = a, text = '', pending = null;
      const n = P('fanout'), ord = P('order');
      if (a === 'create') return { tag: 'start', text: 'An empty ' + TITLE[kind] + (PARAMS[kind].length ? ' (' + PARAMS[kind].map(([k, l]) => l.toLowerCase() + ' ' + P(k)).join(', ') + ')' : '') + '. Type keys and press Insert, or pick a sequence.', hi };
      const tidOf = (t) => (t ? 'TID ' + D().tid(t) : '');
      if (kind === 'bplus') {
        const leafOf = (tid) => { for (const x of snap.nodes || []) if (x.leaf && x.entries.some((e) => e.tid.b === tid.b && e.tid.o === tid.o)) return x; return null; };
        if (a === 'split') {
          hi.split.add(d.block); hi.fresh.add(d.right);
          const node = laterNode(i, d.right, (sn) => sn.nodes || []);
          if (node) pending = [{ node, after: d.block }];
          const sep = D().key(d.sep, null, 12);
          text = d.leaf
            ? 'Leaf block ' + d.block + ' was full (n − 1 = ' + (n - 1) + ' keys) and one more key arrived, so it splits: the first ⌈n/2⌉ = ' + Math.ceil(n / 2) + ' keys stay in block ' + d.block + ', the rest move to a new leaf, block ' + d.right + ', and its first key ' + sep + ' is copied up into the parent.'
            : 'Internal block ' + d.block + ' overflowed (n + 1 = ' + (n + 1) + ' pointers for room for n = ' + n + '), so it splits: the first ⌈(n + 1)/2⌉ = ' + Math.ceil((n + 1) / 2) + ' pointers stay, the rest go to a new node, block ' + d.right + ', and the key between them, ' + sep + ', moves up into the parent (it is not kept below, unlike a leaf split).';
        } else if (a === 'newroot') { hi.fresh.add(d.block); text = 'The root split, so a new root, block ' + d.block + ', is made above the two halves and the tree grows to ' + (d.levels + 1) + ' levels. A B+ tree only grows at the top, which keeps every leaf at the same depth.'; }
        else if (a === 'merge') { hi.cur.add(d.left); hi.split.add(d.right); text = 'Coalescing: block ' + d.right + ' fell below half full and fits together with its sibling, so its entries move into block ' + d.left + (d.leaf ? ' and the separator ' + D().key(d.sep) + ' is deleted from the parent.' : ', with the separator ' + D().key(d.sep) + ' brought down from the parent between them.') + ' The parent may now be under-full in turn.'; }
        else if (a === 'redistribute') { hi.cur.add(d.to); hi.split.add(d.from); text = 'Redistribution: block ' + d.to + ' fell below half full (' + (d.leaf ? 'fewer than ⌈(n − 1)/2⌉ = ' + Math.ceil((n - 1) / 2) + ' keys' : 'fewer than ⌈n/2⌉ = ' + Math.ceil(n / 2) + ' pointers') + '), but its sibling block ' + d.from + ' has ' + (d.moved === 1 ? 'an entry' : 'entries') + ' to spare: ' + plural(d.moved, 'entry', 'entries') + ' move' + (d.moved === 1 ? 's' : '') + ' over and the separator in the parent becomes ' + D().key(d.sep) + '.'; }
        else if (a === 'shrink') { hi.cur.add(d.root); text = 'The root was left with a single child, so that child, block ' + d.root + ', becomes the root and the tree is one level shorter (' + d.levels + ' levels).'; }
        else if (d.op === 'insert') { const l = leafOf(d.tid); if (l) { hi.cur.add(l.block); hi.path = new Set(bplusWalk(snap, d.key, d.key).path); } hi.tids.add(D().tidKey(d.tid)); text = 'Inserted ' + kt(d.key) + ' (' + tidOf(d.tid) + ') into leaf block ' + (l ? l.block : '?') + ': ' + plural(d.pages, 'page access', 'page accesses') + ' in all.'; }
        else if (d.op === 'delete') { text = d.found ? 'Deleted ' + kt(d.key) + ' (' + tidOf(d.tid) + '): ' + plural(d.pages, 'page access', 'page accesses') + '.' : kt(d.key) + ' is not in the tree.'; }
        else if (d.op === 'search' || d.op === 'range') {
          const lo = d.op === 'search' ? d.key : d.lo, hiK = d.op === 'search' ? d.key : d.hi;
          const w = bplusWalk(snap, Math.min(lo, hiK), Math.max(lo, hiK));
          w.path.forEach((b) => hi.path.add(b)); w.leaves.forEach((b) => hi.visited.add(b));
          for (const t of d.tids || []) hi.tids.add(D().tidKey(t));
          text = d.op === 'search'
            ? 'Search ' + kt(d.key) + ': from the root down to leaf block ' + w.leaves[0] + ', one node per level (h = ' + snap.levels + ')' + (w.leaves.length > 1 ? ', then right along the leaf chain to block ' + w.leaves[w.leaves.length - 1] + ' (a separator equal to the key sends the search left, since copies of the key may begin in the leaf before it)' : '') + ': ' + (d.found ? 'found at ' + d.tids.map(D().tid).join(', ') : 'not there') + '. ' + plural(d.pages, 'page access', 'page accesses') + ', the meta page included.'
            : 'Range ' + kt(d.lo) + ' to ' + kt(d.hi) + ': down to the first leaf, then right along the leaf chain (blocks ' + w.leaves.join(' → ') + '): ' + plural(d.keys.length, 'key') + ' found' + (d.keys.length ? ' (' + d.keys.slice(0, 12).map(kt).join(', ') + (d.keys.length > 12 ? ' …' : '') + ')' : '') + '.';
        }
      } else if (kind === 'btree') {
        if (a === 'insert') { hi.cur.add(d.node); hi.keys.add(d.key); text = kt(d.key) + ' goes into leaf node ' + d.node + ' (new keys always go into a leaf).'; }
        else if (a === 'split') { hi.split.add(d.node); hi.fresh.add(d.right); hi.keys.add(d.up); text = 'Node ' + d.node + ' now has n = ' + ord + ' keys, one more than the n − 1 = ' + (ord - 1) + ' it can hold, so it splits: the middle key ' + kt(d.up) + ' moves up into the parent (in a B-tree each key is stored once, so it is not copied) and the keys after it go to a new node ' + d.right + '.'; }
        else if (a === 'newroot') { hi.fresh.add(d.node); text = 'The root split, so a new root, node ' + d.node + ', holds just the middle key: the tree grows a level.'; }
        else if (a === 'duplicate') text = kt(d.key) + ' is already in the tree; this B-tree keeps each key once.';
        else if (a === 'delete') { hi.cur.add(d.node); text = 'Removed ' + kt(d.key) + ' from leaf node ' + d.node + '.'; }
        else if (a === 'replace') { hi.cur.add(d.node); hi.keys.add(d.with); text = kt(d.key) + ' is in internal node ' + d.node + ', so it is replaced by its predecessor ' + kt(d.with) + ' (the largest key of its left subtree), which is then deleted from its leaf.'; }
        else if (a === 'redistribute') { hi.cur.add(d.to); hi.split.add(d.from); text = 'Node ' + d.to + ' has fewer than ⌈n/2⌉ − 1 = ' + (Math.ceil(ord / 2) - 1) + ' keys; its sibling node ' + d.from + ' can spare one, so the separator comes down from the parent into node ' + d.to + ' and the sibling\'s nearest key goes up to take its place.'; }
        else if (a === 'merge') { hi.cur.add(d.left); text = 'Neither sibling can spare a key, so node ' + d.right + ' merges into node ' + d.left + ', together with the separator pulled down from the parent between them.'; }
        else if (a === 'shrink') { hi.cur.add(d.root); text = 'The root is empty, so its only child, node ' + d.root + ', becomes the root: the tree is a level shorter.'; }
        else if (a === 'missing') text = kt(d.key) + ' is not in the tree.';
        else if (d.op === 'insert') text = 'Inserted ' + kt(d.key) + '. The tree has ' + plural(snap.size, 'key') + ' in ' + snap.height + (snap.height === 1 ? ' level.' : ' levels.');
        else if (d.op === 'delete') text = d.found ? 'Deleted ' + kt(d.key) + '.' : kt(d.key) + ' was not there.';
        else if (d.op === 'search') { (d.path || []).forEach((x) => hi.path.add(x)); if (d.found) { hi.cur.add(d.node); hi.keys.add(d.key); } text = 'Search ' + kt(d.key) + ': ' + (d.found ? 'found in node ' + d.node + ' after reading ' + plural(d.visited, 'node') + (d.path.length < snap.height ? ', above the leaves: in a B-tree a search can stop early' : '') : 'not there, after reading ' + plural(d.visited, 'node')) + '.'; }
        else if (d.op === 'range') { btreeVisits(snap, Math.min(d.lo, d.hi), Math.max(d.lo, d.hi)).forEach((x) => hi.visited.add(x)); (d.keys || []).forEach((k) => hi.keys.add(k)); text = 'Range ' + kt(d.lo) + ' to ' + kt(d.hi) + ': an in-order walk of every subtree that can hold keys in the range (' + plural(d.visited, 'node') + ' read, since a B-tree has no leaf chain), ' + plural(d.keys.length, 'key') + ' found.'; }
      } else if (kind.endsWith('-hash')) {
        const cap = P('bucket_size');
        if (a === 'overflow') { hi.cur.add(d.block); hi.fresh.add(d.overflow); text = snap.scheme === 'static' ? 'Bucket ' + d.bucket + ' is full (' + plural(cap, 'entry', 'entries') + '), so an overflow page, block ' + d.overflow + ', is chained to it. Static hashing never adds buckets: from now on a lookup in bucket ' + d.bucket + ' reads its whole chain.' : snap.scheme === 'linear' ? 'Bucket ' + d.bucket + ' is full, so an overflow page, block ' + d.overflow + ', is chained to it for now; the split pointer reaches each bucket in turn, and splitting it will spread the entries out again.' : 'The entries of this bucket cannot be told apart by more hash bits (equal keys, or the maximum depth), so an overflow page, block ' + d.overflow + ', is chained instead of splitting.'; }
        else if (a === 'double') { hi.dirAll = new Set([true]); text = 'The full bucket\'s local depth equals the global depth, so it cannot split without more bits: the directory doubles to 2^' + d.globalDepth + ' = ' + d.slots + ' slots. Each old slot becomes two that point to the same bucket, and the global depth i is now ' + d.globalDepth + '.'; }
        else if (a === 'split' && snap.scheme === 'extendible') { hi.split.add(d.block); hi.fresh.add(d.newBlock); text = 'Bucket block ' + d.block + ' is full, so it splits on hash bit ' + d.localDepth + ': its entries whose bit ' + d.localDepth + ' is 1 move to a new bucket, block ' + d.newBlock + '. Both now have local depth ' + d.localDepth + ', and the directory slots for the new bit pattern point to the new bucket.'; }
        else if (a === 'split') {
          hi.split.add(d.block); hi.fresh.add(d.newBlock);
          const lvBefore = d.next === 0 ? d.level - 1 : d.level, span = snap.initialBuckets * 2 ** lvBefore;
          text = 'The load passed ' + P('fillfactor') + '% of the space in the buckets, so bucket ' + d.bucket + ', the one at the split pointer, splits: its entries are rehashed with h mod ' + span * 2 + ' and ' + plural(d.moved, 'entry', 'entries') + ' move' + (d.moved === 1 ? 's' : '') + ' to the new bucket ' + d.newBucket + '. ' + (d.next === 0 ? 'Every bucket of this round has now split, so the level goes up to ' + d.level + ' and the pointer goes back to bucket 0.' : 'The split pointer moves on to bucket ' + d.next + '.');
        } else if (a === 'merge') { hi.cur.add(d.block); text = 'After the delete, the bucket and its buddy (they differ only in the last bit of their local depth) fit in one page, so they merge into block ' + d.block + ' with local depth ' + d.localDepth + '.'; }
        else if (a === 'halve') { hi.dirAll = new Set([true]); text = 'No bucket uses all the directory\'s bits any more, so it halves to ' + d.slots + ' slots (global depth ' + d.globalDepth + ').'; }
        else if (d.op === 'insert' || d.op === 'search' || d.op === 'delete') {
          const hv = hashOf(d.key), slot = slotOf(snap, hv);
          hi.slot = slot;
          const ent = snap.directory[slot];
          if (ent) hi.cur.add(ent.block);
          if (d.tid) hi.tids.add(D().tidKey(d.tid));
          for (const t of d.tids || []) hi.tids.add(D().tidKey(t));
          const bits = K.bits32(hv);
          const where = snap.scheme === 'extendible' ? 'its first ' + snap.globalDepth + ' bits, ' + (bits.slice(0, snap.globalDepth) || '(none)') + ', pick directory slot ' + slot : snap.scheme === 'static' ? 'h mod ' + snap.nbuckets + ' = bucket ' + slot : 'bucket ' + slot + ' (' + snap.addressing.replace(/^bucket = /, '') + ')';
          const verb = d.op === 'insert' ? 'Inserted ' + kt(d.key) : d.op === 'delete' ? (d.found ? 'Deleted ' : 'Tried to delete ') + kt(d.key) : 'Search ' + kt(d.key);
          text = verb + ': h(' + kt(d.key) + ') = ' + bits.slice(0, 12) + '… (0x' + K.hex(hv, 8) + '); ' + where + '. ' + (d.op === 'search' ? (d.found ? 'Found ' + d.tids.map(D().tid).join(', ') + '. ' : 'Not there. ') : d.op === 'delete' && !d.found ? 'It is not there. ' : '') + plural(d.pages, 'page access', 'page accesses') + ' in all.';
        } else if (d.op === 'range') { for (const t of d.tids || []) hi.tids.add(D().tidKey(t)); text = 'A hash index cannot help with a range: hashing scatters neighbouring keys, so every bucket is read (' + plural(d.pages, 'page access', 'page accesses') + ') and the ' + plural(d.keys.length, 'match', 'matches') + ' sorted afterwards.'; }
      } else if (kind === 'lsm') {
        if (a === 'flush') { hi.fresh.add(d.run); hi.runs = new Set([d.run]); text = 'The memtable is full (' + plural(P('memtable_size'), 'entry', 'entries') + '), so it is written out sorted as run ' + d.run + ' on level 1' + (d.merged && d.merged.length ? ', merged with the run already there (run ' + d.merged.join(', ') + ')' : '') + '. Runs are written once, in whole pages, sequentially, and never updated in place.'; }
        else if (a === 'compaction') { hi.fresh.add(d.into); hi.runs = new Set([d.into]); const from = d.from.map((r) => 'run ' + r.id + ' (level ' + r.level + ', ' + r.n + ')').join(', '); text = (snap.compaction === 'tiered' ? 'Level ' + (d.level - 1) + ' has ' + P('size_ratio') + ' runs, so they are merged' : 'Level ' + (d.level - 1) + ' holds more entries than it may, so it is merged with level ' + d.level) + ': ' + from + ' become run ' + d.into + ' on level ' + d.level + ' (' + plural(d.entries, 'entry', 'entries') + (d.tombstonesDropped ? ', ' + plural(d.tombstonesDropped, 'tombstone') + ' dropped at the bottom' : '') + '). Every entry is read and written again: this is the LSM tree\'s write amplification.'; }
        else if (d.op === 'insert') { hi.tids.add(D().tidKey(d.tid)); let flushed = false; for (let j = i - 1; j >= 0 && pg.history[j].action !== 'done' && pg.history[j].action !== 'create'; j--) if (pg.history[j].action === 'flush') flushed = true; text = 'Inserted ' + kt(d.key) + ' into the memtable, in memory: ' + (d.pages ? plural(d.pages, 'page access', 'page accesses') + (flushed ? ', for the flush' : ' (the index\'s meta page)') : 'no page written') + '.'; }
        else if (d.op === 'delete') { text = d.found ? 'Deleted ' + kt(d.key) + ': runs are never changed in place, so a tombstone goes into the memtable. It hides the older entry from lookups until a merge into the bottom level drops both.' : kt(d.key) + ' is not in the tree.'; }
        else if (d.op === 'search') {
          hi.probes = new Map();
          const am = pg.am;
          for (const lv of snap.levels) for (const r of lv.runs) {
            if (d.key < r.minKey[0] || d.key > r.maxKey[0]) continue;
            const set = D().bloomSet(am, r);
            const maybe = am.bloomIdx(am.bloomText([d.key]), r.bloom.bits, r.bloom.hashes).every((x) => set.has(x));
            hi.probes.set(r.id, { value: d.key, maybe });
          }
          for (const t of d.tids || []) hi.tids.add(D().tidKey(t));
          const probed = [...hi.probes.values()];
          text = 'Lookup ' + kt(d.key) + ': the memtable first, then the runs newest first. ' + (probed.length ? probed.filter((x) => !x.maybe).length + ' of ' + plural(probed.length, 'run') + ' whose key range covers it are skipped because their Bloom filter says no. ' : 'No run\'s key range covers it. ') + (d.found ? 'Found at ' + d.tids.map(D().tid).join(', ') : 'Not found') + '; ' + plural(d.pages, 'page access', 'page accesses') + '.';
        } else if (d.op === 'range') { for (const t of d.tids || []) hi.tids.add(D().tidKey(t)); text = 'Range ' + kt(d.lo) + ' to ' + kt(d.hi) + ': every run whose key range overlaps is read (Bloom filters only help with single keys), and the newest version of each entry wins: ' + plural(d.keys.length, 'key') + ', ' + plural(d.pages, 'page access', 'page accesses') + '.'; }
      } else if (kind === 'bitmap') {
        const bpb = snap.bitsPerBlock;
        const row = (k) => D().key([k], null, 40);
        if (a === 'newkey') { hi.rows = new Set([row(d.key[0])]); text = kt(d.key[0]) + ' is a value not seen before, so it gets a bitmap of its own (a new entry in the key directory).'; }
        else if (d.op === 'insert') { const pos = d.tid.b * bpb + d.tid.o - 1; hi.rows = new Set([row(d.key)]); hi.bits = new Map([[row(d.key), pos]]); const k = snap.keys.find((x) => x.key[0] === d.key); text = 'Row ' + tidOf(d.tid) + ' has the value ' + kt(d.key) + ': bit ' + pos + ' = ' + d.tid.b + ' × ' + bpb + ' + (' + d.tid.o + ' − 1) of its bitmap is set. Stored WAH-compressed, that bitmap is ' + plural(k ? k.words : 1, 'word') + ' (' + (k ? k.bytes : 4) + ' bytes).'; }
        else if (d.op === 'delete') { hi.rows = new Set([row(d.key)]); text = d.found ? 'Cleared the bit of row ' + tidOf(d.tid) + ' in the bitmap of ' + kt(d.key) + '.' : kt(d.key) + ' has no rows.'; }
        else if (d.op === 'search') { hi.rows = new Set([row(d.key)]); text = 'Lookup ' + kt(d.key) + ': read its bitmap; each 1 bit is a matching row: ' + plural(d.tids.length, 'row') + (d.tids.length ? ' (' + d.tids.slice(0, 10).map(D().tid).join(', ') + (d.tids.length > 10 ? ' …' : '') + ')' : '') + '.'; }
        else if (d.op === 'range') { hi.rows = new Set(snap.keys.filter((k) => k.key[0] >= d.lo && k.key[0] <= d.hi).map((k) => row(k.key[0]))); text = 'Range ' + kt(d.lo) + ' to ' + kt(d.hi) + ': the OR of the bitmaps of every value in the range (' + plural(hi.rows.size, 'bitmap') + '): ' + plural(d.tids.length, 'row') + '.'; }
      } else if (kind === 'rtree') {
        const M = snap.maxEntries, m = snap.minEntries;
        if (a === 'split') { hi.split.add(d.block); hi.fresh.add(d.newBlock); const node = laterNode(i, d.newBlock, D().rtreeNodes); if (node) pending = [{ node, after: d.block }]; text = 'Node block ' + d.block + ' has M + 1 = ' + (M + 1) + ' entries, so it splits with the quadratic split: the two entries that would waste the most area in one rectangle seed two groups, and each other entry joins the group whose rectangle grows least. ' + d.sizes[0] + ' stay in block ' + d.block + ', ' + d.sizes[1] + ' go to the new block ' + d.newBlock + '.'; }
        else if (a === 'newroot') { hi.fresh.add(d.block); text = 'The root split, so a new root, block ' + d.block + ', holds the two halves\' rectangles: the tree now has ' + d.levels + ' levels.'; }
        else if (a === 'condense') { hi.split.add(d.block); text = 'Node block ' + d.block + ' fell below m = ' + m + ' entries, so it is dissolved (CondenseTree) and its ' + plural(d.orphans, 'entry', 'entries') + ' set aside to be inserted again from the top.'; }
        else if (a === 'reinsert') text = 'Reinserting an entry of the dissolved node, at its level, from the root down.';
        else if (a === 'shrink') { hi.cur.add(d.root); text = 'The root has a single child left, so that child, block ' + d.root + ', becomes the root (' + d.levels + ' levels).'; }
        else if (d.op === 'insert') { hi.tids.add(D().tidKey(d.tid)); const leaf = D().rtreeNodes(snap).find((x) => x.leaf && x.entries.some((e) => e.tid.b === d.tid.b && e.tid.o === d.tid.o)); if (leaf) hi.cur.add(leaf.block); text = 'Inserted ' + kt(d.key) + ': from the root, each step goes into the child whose rectangle needs the least enlargement to cover it, ending in leaf block ' + (leaf ? leaf.block : '?') + '; the rectangles on the way are widened. ' + plural(d.pages, 'page access', 'page accesses') + '.'; }
        else if (d.op === 'delete') text = d.found ? 'Deleted ' + kt(d.key) + ' (Guttman: remove it from its leaf, then condense the tree on the way up).' : kt(d.key) + ' is not in the tree.';
        else if (d.op === 'range' || d.op === 'search') {
          const w = d.op === 'search' ? winOf(d.key, d.key) : winOf(d.lo, d.hi);
          hi.window = w;
          for (const nd of D().rtreeNodes(snap)) if (nd.mbr && meets(nd.mbr, w)) hi.visited.add(nd.block);
          for (const t of d.tids || []) hi.found.add(D().tidKey(t));
          text = (d.op === 'search' ? 'Point lookup ' + kt(d.key) : 'Window ' + kt([w[0], w[1]]) + ' to ' + kt([w[2], w[3]])) + ': every node whose rectangle meets the window is read (' + plural(hi.visited.size, 'node') + ', ' + plural(d.pages, 'page access', 'page accesses') + ' in all), and ' + plural((d.tids || []).length, 'point') + ' inside are found. Overlapping rectangles make the search follow more than one path.';
        }
      } else if (kind === 'kdtree') {
        if (a === 'insert') { hi.cur.add(D().ptKey(d.point)); text = '(' + D().val(d.point.x) + ', ' + D().val(d.point.y) + ') goes down comparing x, then y, then x …, and becomes a new node at depth ' + d.depth + ', which splits its region on ' + (d.depth % 2 ? 'y' : 'x') + '.'; }
        else if (a === 'replace') { hi.cur.add(D().ptKey(d.with)); text = 'The deleted point is replaced by (' + D().val(d.with.x) + ', ' + D().val(d.with.y) + '), the point with the least coordinate on the node\'s axis in its right subtree, which is then deleted below.'; }
        else if (a === 'delete') text = 'Deleted (' + D().val(d.point.x) + ', ' + D().val(d.point.y) + ').';
        else if (d.op === 'search') { const p = { x: d.key[0], y: d.key[1] }; let nd = snap.root; while (nd) { hi.path.add(D().ptKey(nd.point)); if (nd.point.x === p.x && nd.point.y === p.y) { hi.found.add(D().ptKey(nd.point)); break; } nd = p[nd.axis] < nd.point[nd.axis] ? nd.left : nd.right; } text = 'Search ' + kt(d.key) + ': one comparison per level, on x or y in turn: ' + (d.found ? 'found' : 'not there') + ' after ' + plural(d.visited, 'node') + '.'; }
        else if (d.op === 'range') {
          const w = winOf(d.lo, d.hi);
          hi.window = w;
          const walk = (nd) => { if (!nd) return; const k = D().ptKey(nd.point); hi.visited.add(k); if (nd.point.x >= w[0] && nd.point.x <= w[2] && nd.point.y >= w[1] && nd.point.y <= w[3]) hi.found.add(k); const lo = nd.axis === 'x' ? w[0] : w[1], up = nd.axis === 'x' ? w[2] : w[3]; if (lo < nd.split) walk(nd.left); if (up >= nd.split) walk(nd.right); };
          walk(snap.root);
          text = 'Range ' + kt(d.lo) + ' to ' + kt(d.hi) + ': a subtree is entered only when the window reaches its side of the splitting line, so ' + plural(d.visited, 'node') + ' of ' + snap.size + ' are visited and ' + plural(d.points.length, 'point') + ' found.';
        } else if (d.op === 'insert' || d.op === 'delete') text = (d.op === 'insert' ? 'Inserted ' : d.found ? 'Deleted ' : 'Not found: ') + kt(d.key) + '. The tree has ' + plural(snap.size, 'point') + ', height ' + snap.height + '.';
      } else if (kind === 'quadtree') {
        const k4 = (b) => b.join(',');
        if (a === 'subdivide') { hi.split.add(k4(d.bounds)); text = 'The square [' + d.bounds.map((v) => D().val(v)).join(', ') + '] holds more than ' + plural(P('capacity'), 'point') + ', so it splits into four quadrants (SW, SE, NW, NE) and its points move down into them.'; }
        else if (a === 'grow') { hi.cur.add(k4(d.bounds)); text = 'The point lies outside the root square, so the root doubles in size to [' + d.bounds.map((v) => D().val(v)).join(', ') + '].'; }
        else if (a === 'insert') { hi.tids.add(D().ptKey(d.point)); text = '(' + D().val(d.point.x) + ', ' + D().val(d.point.y) + ') goes down, at each level into the quadrant that contains it, to a leaf square.'; }
        else if (a === 'delete') text = 'Deleted (' + D().val(d.point.x) + ', ' + D().val(d.point.y) + ').';
        else if (a === 'merge') { hi.cur.add(k4(d.bounds)); text = 'The four quadrants of [' + d.bounds.map((v) => D().val(v)).join(', ') + '] together hold only ' + plural(d.points, 'point') + ', so they collapse back into one square.'; }
        else if (d.op === 'range' || d.op === 'search') {
          const w = d.op === 'search' ? winOf(d.key, d.key) : winOf(d.lo, d.hi);
          hi.window = w;
          const walk = (nd) => { const b = nd.bounds; if (b[2] < w[0] || b[0] > w[2] || b[3] < w[1] || b[1] > w[3]) return; hi.visited.add(k4(b)); for (const p of nd.points) if (p.x >= w[0] && p.x <= w[2] && p.y >= w[1] && p.y <= w[3]) hi.found.add(D().ptKey(p)); nd.children.forEach(walk); };
          walk(snap.root);
          text = (d.op === 'search' ? 'Search ' + kt(d.key) + ': down the squares that contain it, ' + plural(d.visited, 'node') + ' read: ' + (d.found ? 'found.' : 'not there.') : 'Range ' + kt(d.lo) + ' to ' + kt(d.hi) + ': only squares that meet the window are entered (' + plural(d.visited, 'square') + '), ' + plural(d.points.length, 'point') + ' found.');
        } else if (d.op === 'insert' || d.op === 'delete') text = (d.op === 'insert' ? 'Inserted ' : d.found ? 'Deleted ' : 'Not found: ') + kt(d.key) + '. Height ' + snap.height + ', ' + plural(snap.size, 'point') + '.';
      }
      if (a === 'done') tag = d.op;
      return { tag, text: text || (a === 'done' ? d.op + ' ' + nkey(d.key) : a.replace(/-/g, ' ')), hi, pending };
    }

    // ---- drawing a snapshot -------------------------------------------------------------------------------------------
    function picture(k, snap, ex, onPlane, target) {
      const hi = ex.hi || {};
      if (k === 'bplus') { const n = target.options.fanout || 4; return { pic: D().tree(D().bplusItems(snap, { cap: { leaf: n - 1, internal: n }, hi, max: 12, pending: ex.pending }), { label: 'B+ tree' }) }; }
      if (k === 'btree') return { pic: D().tree(D().btreeItems(snap, { hi }), { label: 'B-tree' }) };
      if (k.endsWith('-hash')) return { pic: D().hash(snap, { hi }) };
      if (k === 'lsm') return { pic: D().lsm(snap, { hi, am: target.am }) };
      if (k === 'bitmap') return { pic: D().bitmap(snap, { hi }) };
      if (k === 'rtree') return { plane: D().rtreePlane(snap, { hi, bounds: [0, 0, 100, 100], size: 300, pending: ex.pending, onPoint: onPlane && onPlane.point, onRect: onPlane && onPlane.rect }), pic: D().tree(D().rtreeItems(snap, { hi, pending: ex.pending }), { label: 'R-tree' }) };
      if (k === 'kdtree') return { plane: D().kdPlane(snap, { hi, bounds: [0, 0, 100, 100], size: 300, onPoint: onPlane && onPlane.point, onRect: onPlane && onPlane.rect }), pic: D().tree(D().kdItems(snap, { hi }), { label: 'k-d tree' }) };
      return { plane: D().quadPlane(snap, { hi, bounds: [0, 0, 100, 100], size: 300, onPoint: onPlane && onPlane.point, onRect: onPlane && onPlane.rect }), pic: D().tree(D().quadItems(snap, { hi }), { label: 'Quadtree' }) };
    }
    function figures(k, snap) {
      if (k === 'bplus') { const leaves = snap.nodes.filter((n) => n.leaf); return [['Height', snap.levels], ['Nodes', snap.nodes.length], ['Keys', leaves.reduce((a, n) => a + n.entries.length, 0)], ['Pages', snap.io ? snap.io.pages : '—', null, 'pages in the index file, with the meta page']]; }
      if (k === 'btree') { let nodes = 0; const w = (n) => { nodes++; n.children.forEach(w); }; w(snap.root); return [['Height', snap.height], ['Nodes', nodes], ['Keys', snap.size], ['Capacity', snap.maxKeys + ' keys']]; }
      if (k.endsWith('-hash')) return [['Buckets', snap.nbuckets], snap.scheme === 'extendible' ? ['Depth i', snap.globalDepth] : snap.scheme === 'linear' ? ['Level · next', snap.level + ' · ' + snap.next] : ['Overflow pg', snap.stats.overflowPages], ['Entries', snap.ntuples], ['Load', Math.round(snap.loadFactor * 100) + '%']];
      if (k === 'lsm') return [['Memtable', snap.memtable.size + ' / ' + snap.memtable.capacity], ['Runs', snap.stats.runs], ['Compactions', snap.stats.compactions], ['Write amp.', snap.stats.writeAmplification.toFixed(2) + '×', 'acc', 'entries written to runs ÷ entries inserted']];
      if (k === 'bitmap') return [['Values', snap.nkeys], ['Rows', snap.ntuples], ['Compressed', snap.bytes + ' B'], ['Raw', snap.rawBytes + ' B']];
      if (k === 'rtree') return [['Height', snap.levels], ['Nodes', snap.nodes], ['Points', snap.ntuples], ['Splits', snap.stats.splits]];
      if (k === 'kdtree') return [['Points', snap.size], ['Height', snap.height]];
      return [['Points', snap.size], ['Height', snap.height], ['Capacity', snap.capacity]];
    }

    // ---- the comparisons ---------------------------------------------------------------------------------------------
    function runCompare(cmds, defOp) {
      if (mode === 'cmp-btree') {
        for (const c of cmds) {
          let op = c.op || defOp, vals = c.vals;
          if (op === 'random') { vals = K.range(Math.min(200, vals[0] || 10)).map(() => Math.floor(rnd() * 99) + 1); op = 'insert'; }
          if (op === 'range') { cmp.bp.range(vals[0], vals[1]); cmp.bt.range(vals[0], vals[1]); cmp.last = { op, vals }; continue; }
          for (const v of vals) { apply1(cmp.bp, op, v); apply1(cmp.bt, op, v); }
          cmp.ops.push({ op, vals });
          if (op === 'search') cmp.last = { op, vals };
        }
      } else {
        const keys = [];
        for (const c of cmds) {
          const op = c.op || defOp;
          if (op === 'random') keys.push(...K.range(Math.min(2000, c.vals[0] || 100)).map(() => Math.floor(rnd() * 100000)));
          else if (op === 'insert') keys.push(...c.vals);
        }
        cmp.keys.push(...keys);
        writeRace();
      }
    }
    function newCompare() {
      if (mode === 'cmp-btree') { const n = cmpN(); cmp = { bp: K.IndexPlayground.make('bplus', { fanout: n }), bt: K.IndexPlayground.make('btree', { order: n }), ops: [], last: null }; }
      else { cmp = { keys: [], series: null }; }
    }
    const cmpN = () => store.get('lab.params.bplus', {}).fanout || 4;
    /** count page images written (the meta page aside): what each structure writes for the same inserts */
    function writeRace() {
      const saved = store.get('lab.params.cmp', {});
      const o = Object.fromEntries(CMPL.map(([k, , , d]) => [k, saved[k] !== undefined ? saved[k] : d]));
      const bp = K.IndexPlayground.make('bplus', { fanout: o.fanout });
      const ls = K.IndexPlayground.make('lsm', { memtable_size: o.memtable_size, compaction: o.compaction, size_ratio: o.size_ratio, page_entries: o.page_entries, bloom_bits: 8 });
      const count = (p) => { const c = { n: 0 }; p.db.wal.log = (r) => { if (r && r.image && r.block !== 0) c.n++; return 0; }; return c; };
      const cb = count(bp), cl = count(ls);
      // the data pages of the runs an LSM tree writes, apart from its index, Bloom filter and manifest pages
      let data = 0;
      const writeRun = ls.am.writeRun.bind(ls.am);
      ls.am.writeRun = (m, entries, level) => { const r = writeRun(m, entries, level); data += r.npages; return r; };
      const sb = [[0, 0]], sl = [[0, 0]], sa = [[0, 0]];
      // the history snapshots are not needed here; skip describing every step
      bp.record = ls.record = () => null;
      cmp.keys.forEach((k, i) => { bp.insert(k); ls.insert(k); sb.push([i + 1, cb.n]); sl.push([i + 1, data]); sa.push([i + 1, cl.n]); });
      const st = ls.am.describe().stats;
      cmp.series = { sb, sl, sa, bpWrites: cb.n, lsmData: data, lsmAll: cl.n, wa: st.writeAmplification, written: st.entriesWritten, user: st.userWrites, o };
    }

    // ---- the page -----------------------------------------------------------------------------------------------------------
    function renderHead() {
      head.innerHTML = '';
      if (mode === 'step') head.appendChild(h('select.inp.ix-sel', { 'aria-label': 'Structure', onchange: (e) => { kind = e.target.value; store.set('lab.kind', kind); params = Object.assign({}, store.get('lab.params.' + kind, {})); ops = []; fresh(); view.render(); } },
        KINDS.map(([g, list]) => h('optgroup', { label: g }, list.map(([k, l]) => h('option', { value: k, selected: k === kind }, l))))));
      head.appendChild(h('div.seg', [['step', 'Step through'], ['cmp-btree', 'B+ vs B-tree'], ['cmp-lsm', 'LSM vs B+ writes']].map(([k, l]) => h('button' + (mode === k ? '.on' : ''), { type: 'button', onclick: () => { stop(); mode = k; if (k !== 'step') newCompare(); view.render(); } }, l))));
    }
    function paramRow() {
      const list = mode === 'cmp-btree' ? [['fanout', 'Fan-out / order n', [3, 4, 5, 6, 8], 4, 'bplus']] : mode === 'cmp-lsm' ? CMPL : PARAMS[kind].map((p) => p.concat([kind]));
      if (!list.length) return h('div.lab-params.muted', 'This structure has no parameters.');
      return h('div.lab-params', list.map(([k, l, opts, def, owner]) => {
        const saved = owner === kind && mode === 'step' ? params : store.get('lab.params.' + owner, {});
        const v = saved[k] !== undefined ? saved[k] : def;
        return h('label.lab-param', h('span', l), h('select.inp', { 'aria-label': l, onchange: (e) => {
          const nv = typeof def === 'number' ? +e.target.value : e.target.value;
          const p = Object.assign({}, store.get('lab.params.' + owner, {}), { [k]: nv });
          store.set('lab.params.' + owner, p);
          if (mode === 'step') { params = p; replay(); }
          else if (mode === 'cmp-btree') { const old = cmp.ops; newCompare(); for (const o of old) for (const x of o.vals) { apply1(cmp.bp, o.op, x); apply1(cmp.bt, o.op, x); } cmp.ops = old; }
          else if (cmp.keys.length) writeRace();
          view.render();
        } }, opts.map((o) => h('option', { value: String(o), selected: String(o) === String(v) }, String(o)))));
      }));
    }
    function opsRow() {
      const sp = SPATIAL.has(kind) && mode === 'step';
      const input = h('input.inp.lab-in', { type: 'text', 'aria-label': 'Keys or commands', placeholder: mode === 'cmp-lsm' ? 'keys to insert, or: random 300' : sp ? '(10, 20) (30, 40)   or   range (0,0) (50,50)' : kind === 'bitmap' && mode === 'step' ? 'L1 L2 L1   or   search L1' : '2 3 5 7 11   or   insert 2 3 5; search 7; range 5 20', value: view.draft || '', oninput: (e) => { view.draft = e.target.value; } });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); exec(input.value, 'insert'); } });
      const b = (icon, label, op, title) => UI.btn(icon, label, title || label, () => exec(input.value, op), 'small');
      const row = h('div.lab-ops', input);
      if (mode === 'cmp-lsm') row.appendChild(b('plus', 'Insert', 'insert'));
      else row.appendChild(h('div.ix-row', b('plus', 'Insert', 'insert'), b('trash', 'Delete', 'delete'), b('search', 'Search', 'search'), b('format', 'Range', 'range', 'Range query: two keys, low and high' + (sp ? ' (two corners)' : ''))));
      const quick = h('div.lab-quick', h('span', 'Try:'));
      const chip = (label, cmd) => h('button.lab-chip', { type: 'button', onclick: () => exec(cmd, 'insert') }, label);
      if (mode === 'cmp-lsm') { quick.appendChild(chip('random 100', 'random 100')); quick.appendChild(chip('random 500', 'random 500')); quick.appendChild(chip('ascending 1…200', 'insert ' + K.range(200).map((i) => i + 1).join(' '))); }
      else if (mode === 'cmp-btree') { quick.appendChild(chip('8 14 21 26 33 38 44 50 57 63', 'insert 8 14 21 26 33 38 44 50 57 63')); quick.appendChild(chip('random 15', 'random 15')); quick.appendChild(chip('search 38', 'search 38')); quick.appendChild(chip('search 21', 'search 21')); }
      else { for (const [l, c] of PRESETS[kind] || []) quick.appendChild(chip(l, c)); quick.appendChild(chip('random ' + (SPATIAL.has(kind) ? 8 : 10), 'random ' + (SPATIAL.has(kind) ? 8 : 10))); }
      quick.appendChild(h('div.grow'));
      quick.appendChild(UI.btn('refresh', 'Start over', 'Empty the structure', () => { if (mode === 'step') { ops = []; fresh(); } else newCompare(); view.render(); }, 'small ghost'));
      return [row, quick];
    }

    function renderStep() {
      const total = pg.history.length;
      const ex = explain(cur);
      const st = pg.history[cur];
      const playing = !!timer;
      const bar = h('div.lab-stepbar',
        UI.btn('first', null, 'First step', () => go(0), 'icon'),
        UI.btn('stepBack', null, 'Step back', () => go(cur - 1), 'icon'),
        UI.btn(playing ? 'pause' : 'run', null, playing ? 'Pause' : 'Play the steps', () => { if (timer) stop(); else { if (cur >= total - 1) cur = 0; play(); } view.render(); }, 'icon'),
        UI.btn('step', null, 'Step forward', () => go(cur + 1), 'icon'),
        UI.btn('last', null, 'Last step', () => go(total - 1), 'icon'),
        h('input', { type: 'range', min: '0', max: String(total - 1), value: String(cur), 'aria-label': 'Step', oninput: (e) => go(+e.target.value) }),
        h('span.lab-pos', 'step ' + cur + ' of ' + (total - 1)));
      body.appendChild(h('div.lab-step', bar, h('div.lab-say', { 'aria-live': 'polite' }, h('span.lab-kind.' + ex.tag, ex.tag), ex.text)));
      body.appendChild(D().stats(figures(kind, st.snapshot).concat(st.detail && st.detail.pages !== undefined && st.detail.pages !== null ? [['Pages read', st.detail.pages, 'acc', 'pages this operation pinned in the buffer pool']] : [])));
      const onPlane = SPATIAL.has(kind) ? { point: (x, y) => exec('insert (' + x + ',' + y + ')', 'insert'), rect: (r) => exec('range (' + r[0] + ',' + r[1] + ') (' + r[2] + ',' + r[3] + ')', 'range') } : null;
      const p = picture(kind, st.snapshot, ex, onPlane, pg);
      if (p.plane) body.appendChild(h('div.ix-plane', p.plane));
      body.appendChild(canvas.el);
      const prevSvg = canvas.scroll.querySelector('svg');
      const old = oldPos && oldPos.kind === kind ? oldPos.map : null;
      canvas.show(p.pic.svg, p.pic.w, p.pic.h, p.pic.focus, !prevSvg || !old ? p.pic.home || { x: 0, y: 0, w: 0, h: 0 } : null);
      D().flip(old || D().positions(prevSvg), p.pic.svg);
      oldPos = { kind, map: D().positions(p.pic.svg) };
      // every step, with its sentence
      const log = h('details.lab-log', { open: view.logOpen || null, ontoggle: (e) => { view.logOpen = e.target.open; } }, h('summary', 'All ' + total + ' steps'));
      const from = Math.max(0, total - 400);
      for (let i = from; i < total; i++) {
        const s = pg.history[i];
        const label = s.action === 'done' ? s.detail.op + ' ' + nkey(s.detail.key !== undefined ? s.detail.key : s.detail.lo !== undefined ? s.detail.lo + '…' + s.detail.hi : '') : s.action === 'create' ? 'start' : s.action;
        log.appendChild(h('button.lab-li' + (i === cur ? '.on' : '') + (s.action === 'done' || s.action === 'create' ? '.op' : ''), { type: 'button', onclick: () => go(i) }, h('span.n', String(i)), h('span.t', label)));
      }
      body.appendChild(log);
    }

    function renderCmpBtree() {
      body.appendChild(h('p.lab-cmp-note', 'The same keys go into a B+ tree of fan-out n and a B-tree of order n. The B+ tree repeats separator keys above its leaves and keeps every key in a leaf; the B-tree stores each key once, so a search may stop at an internal node, but its internal nodes also carry record pointers, which in a real page means fewer keys per node and a taller tree.'));
      const bs = cmp.bp.describe(), ts = cmp.bt.describe();
      const leafKeys = bs.nodes.filter((x) => x.leaf).reduce((a, x) => a + x.entries.length, 0), seps = bs.nodes.filter((x) => !x.leaf).reduce((a, x) => a + x.entries.length - 1, 0);
      let tnodes = 0; const tw = (x) => { tnodes++; x.children.forEach(tw); }; tw(ts.root);
      let hb = {}, ht = {}, sb = null, sbt = null;
      if (cmp.last && cmp.last.op === 'search') {
        const k = cmp.last.vals[cmp.last.vals.length - 1];
        const lb = cmp.bp.history[cmp.bp.history.length - 1].detail, lt = cmp.bt.history[cmp.bt.history.length - 1].detail;
        const w = bplusWalk(bs, k, k);
        hb = { path: new Set(w.path), tids: new Set((lb.tids || []).map(D().tidKey)) };
        ht = { path: new Set(lt.path || []), cur: new Set(lt.found ? [lt.node] : []), keys: new Set(lt.found ? [k] : []) };
        hb.visited = new Set(w.leaves);
        sb = 'search ' + kt(k) + ': ' + (w.path.length + w.leaves.length - 1) + ' nodes read'; sbt = 'search ' + kt(k) + ': ' + (lt.visited || 0) + ' nodes read' + (lt.found && lt.path.length < ts.height ? ' (stopped above the leaves)' : '');
      }
      const n = cmpN();
      const one = (title, sub, figs, pic, cv) => { const sec = h('section', h('h3', title, h('span.muted', sub)), D().stats(figs), cv.el); return [sec, () => cv.show(pic.svg, pic.w, pic.h, pic.focus, pic.home)]; };
      const pb = D().tree(D().bplusItems(bs, { cap: { leaf: n - 1, internal: n }, hi: hb, max: 12 }), {});
      const pt = D().tree(D().btreeItems(ts, { hi: ht }), {});
      const [s1, f1] = one('B+ tree, fan-out ' + n, sb || 'every key in a leaf, separators copied up', [['Height', bs.levels], ['Nodes', bs.nodes.length], ['Leaf keys', leafKeys], ['Separators', seps, null, 'keys stored a second time in internal nodes']], pb, canvas);
      const [s2, f2] = one('B-tree, order ' + n, sbt || 'each key stored once', [['Height', ts.height], ['Nodes', tnodes], ['Keys', ts.size], ['Separators', 0, null, 'no key is stored twice']], pt, canvas2);
      body.appendChild(h('div.lab-two', s1, s2));
      f1(); f2();
    }

    function renderCmpLsm() {
      body.appendChild(h('p.lab-cmp-note', 'Each insert into a B+ tree rewrites at least the leaf page it lands in, and more when nodes split: one random page write per key, or more. An LSM tree writes nothing until its memtable fills, then whole sorted pages, sequentially; but compaction writes every entry again on each level it moves down, which is its write amplification. Both are counted here in pages written, on the same keys.'));
      if (!cmp.series) { body.appendChild(h('div.ix-note', 'Insert some keys (try random 500) to race the two structures.')); return; }
      const S = cmp.series, n = cmp.keys.length, o = S.o;
      body.appendChild(D().stats([['Inserts', n], ['B+ tree pages', S.bpWrites, null, 'page images the B+ tree wrote: leaves, split nodes, parents (the meta page aside)'], ['LSM pages', S.lsmData, 'acc', 'data pages of the sorted runs written by flushes and compactions'], ['B+ per insert', (S.bpWrites / n).toFixed(2)], ['LSM per insert', (S.lsmData / n).toFixed(2), 'acc'], ['LSM write amp.', S.wa.toFixed(2) + '×', null, S.written + ' entries written to runs for ' + S.user + ' inserted']]));
      const box = h('div.ix-cbox', h('h3', 'Pages written as keys arrive'), h('p.sub', 'B+ tree of fan-out ' + o.fanout + ' against an LSM tree (memtable ' + o.memtable_size + ', ' + o.compaction + ', size ratio ' + o.size_ratio + ', ' + o.page_entries + ' keys per page)'),
        D().chartKeys([{ name: 'B+ tree, random page writes', c: 1 }, { name: 'LSM tree, sequential run pages', c: 2 }]),
        D().chart({ label: 'Cumulative page writes against inserts', series: [{ name: 'B+ tree', c: 1, pts: thin(S.sb), end: true, endLabel: String(S.bpWrites) }, { name: 'LSM tree', c: 2, pts: thin(S.sl), end: true, endLabel: String(S.lsmData) }], x: { label: 'keys inserted', max: n, fmt: (v) => String(Math.round(v)) }, y: { label: 'pages written', fmt: (v) => String(Math.round(v)) } }));
      body.appendChild(box);
      const fewer = S.lsmData < S.bpWrites;
      body.appendChild(h('p.lab-cmp-note', 'Per insert the LSM tree wrote ' + (S.lsmData / n).toFixed(2) + ' data pages against the B+ tree\'s ' + (S.bpWrites / n).toFixed(2) + (fewer ? ', and its writes are long sequential runs rather than scattered single pages, which is why write-heavy systems use LSM trees. ' : '. With a small memtable or few keys per page the merges dominate; try a bigger memtable. ') + 'Counting its index, Bloom filter and manifest pages too, it wrote ' + S.lsmAll + ' pages. The price is paid on reads: a lookup may have to probe every run, and the Bloom filters keep most of those probes off the disk.'));
    }
    const thin = (pts) => { if (pts.length <= 400) return pts; const step = Math.ceil(pts.length / 400); return pts.filter((p, i) => i % step === 0 || i === pts.length - 1); };

    const view = {
      draft: '',
      logOpen: false,
      onDb() {},
      destroy() { stop(); },
      render() {
        renderHead();
        body.innerHTML = '';
        if (!pg) fresh();
        const intro = mode === 'step' ? INTRO[kind] : mode === 'cmp-btree' ? 'B+ tree or B-tree? Same keys, both structures, side by side.' : 'Write amplification: the pages an LSM tree and a B+ tree write for the same inserts.';
        body.appendChild(h('p.ix-intro', h('b', mode === 'step' ? TITLE[kind] + '. ' : ''), intro));
        body.appendChild(h('div.lab-ctl', paramRow(), ...opsRow()));
        if (lastErr) body.appendChild(h('div.res-err', lastErr));
        if (mode === 'step') renderStep();
        else if (mode === 'cmp-btree') renderCmpBtree();
        else renderCmpLsm();
      },
    };
    fresh();
    return view;
  }

  UI.registerView({ id: 'indexlab', title: 'Index playground', icon: 'flask', group: 'Indexing', order: 21, create });
  UI.IndexLab = { parse };
})(typeof window !== 'undefined' ? window : globalThis);
