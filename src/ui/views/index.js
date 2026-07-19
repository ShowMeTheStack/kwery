// The index view (chapters 14 and 24): a real index of the database drawn from its pages. B+ trees as nodes of
// keys and pointers by level with the leaf chain; hash indexes as a directory or bucket table with overflow
// chains; bitmap indexes as bit rows with their WAH words; LSM trees as a memtable over levels of runs with
// Bloom filters; R-trees as rectangles on a plane plus the tree. Stepping through a recorded run lights the
// pages each step read, the path of the current lookup and the splits as they come. The index is described
// before and after every run, so stepping back to before its first change shows it as it was.
(function (root) {
  'use strict';
  const K = root.K;
  const UI = K.UI;
  const { h } = UI;
  const D = () => UI.IdxDraw;

  const STRUCT = new Set(['split', 'newroot', 'merge', 'redistribute', 'shrink', 'bulkload', 'double', 'overflow', 'halve', 'flush', 'compaction', 'newkey', 'condense', 'reinsert', 'free']);
  const CHANGE = new Set(['insert', 'delete']);
  const PREFIX = { bplus: 'btree', hash: 'hash', bitmap: 'bitmap', lsm: 'lsm', rtree: 'rtree' };
  const kindOf = (am) => (K.RTree && am instanceof K.RTree ? 'rtree' : K.LSMTree && am instanceof K.LSMTree ? 'lsm' : K.BitmapIndex && am instanceof K.BitmapIndex ? 'bitmap' : K.HashIndex && am instanceof K.HashIndex ? 'hash' : 'bplus');
  const NAMES = { bplus: 'B+ tree', hash: 'hash index', bitmap: 'bitmap index', lsm: 'LSM tree', rtree: 'R-tree' };

  const INTRO = {
    bplus: 'A B+ tree keeps every search key in its leaves, in key order, each with a pointer (the TID) to its record; the leaves are chained left to right, so a range scan walks along them. Internal nodes hold separator keys that steer a lookup from the root to the one leaf that can hold the key, so an equality lookup reads h_i + 1 blocks. Each node is one page of the index file.',
    static: 'A static hash index applies a hash function h to the search key and keeps the entry in bucket h(K) mod n, one page per bucket. The number of buckets n never changes, so a full bucket grows a chain of overflow pages and lookups slow down as the file grows.',
    extendible: 'Extendible hashing keeps a directory of 2^i slots addressed by the first i bits of h(K) (the global depth). Several slots may share a bucket; a bucket\'s local depth says how many bits its entries agree on. A full bucket splits in two, and only when its local depth equals i does the directory double.',
    linear: 'Linear hashing grows one bucket at a time: whenever the file gets too full, the bucket at the split pointer is split and the pointer moves on. A key goes to bucket h(K) mod (n · 2^level), or mod twice that when the result is below the pointer, so there is no directory, and overflow pages absorb the buckets not yet split.',
    bitmap: 'A bitmap index keeps one bitmap per distinct key value, with a bit for every record slot: bit i is 1 when record i has that value. Selections on several attributes become ANDs and ORs of bitmaps. Kwery compresses each bitmap with WAH: a literal word carries 31 bits, a fill word stands for a long run of equal bits.',
    lsm: 'A log-structured merge tree buffers new entries in an in-memory memtable and writes it out as a sorted run when it fills; runs are then merged into deeper levels (compaction), so every disk write is a sequential write of whole pages. A lookup checks the memtable and then each run, newest first, and a Bloom filter per run lets it skip the runs that cannot hold the key.',
    rtree: 'An R-tree indexes points and rectangles: each node is a page of entries, each with the minimum bounding rectangle (MBR) of a child node or of an indexed object. A query descends into every child whose rectangle meets the query region, so it may follow several paths; a node with more than M entries splits in two (Guttman\'s quadratic split).',
  };

  function create(app, el) {
    let oid = null, am = null, kind = null, idx = null;
    let base = null, before = null, seen = app.timeline.events, sel = null, err = null, drawn = null;
    const head = h('div.view-head.ix-head');
    const body = h('div.view-body.ix-body');
    const canvas = D().canvas();
    el.appendChild(head); el.appendChild(body);
    const cat = () => app.session.catalog;
    const userTables = () => cat().tables(['table', 'matview']).filter((r) => { const sc = cat().schema(r.schema, true); return !(sc && sc.system) && (r.indexes || []).length; }).sort((a, b) => (a.name < b.name ? -1 : 1));
    const describe = () => {
      err = null;
      if (!am || !app.db.disk.files.has(idx.file)) return null;
      try { return am.describe(); } catch (e) { err = e.message; console.error(e); return null; }
    };
    const choose = (id) => {
      const x = id !== null && id !== undefined ? cat().rel(id) : null;
      if (!x || x.kind !== 'index') { oid = null; am = null; idx = null; base = before = null; return; }
      if (x.oid !== oid) sel = null;
      oid = x.oid; idx = x;
      try { am = app.db.indexAm(x, cat()); kind = kindOf(am); } catch (e) { am = null; err = e.message; }
      base = describe(); before = null; seen = app.timeline.events;
    };
    const pickDefault = () => {
      const ts = userTables();
      if (!ts.length) return choose(null);
      const ix = cat().indexesOf(ts[0]);
      choose(ix.length ? ix[0].oid : null);
    };
    // a new recorded run: the picture before it is the one we had, the picture after it is read now
    const sync = () => {
      if (oid !== null && !cat().rel(oid)) { pickDefault(); return; }
      if (app.timeline.events !== seen) { seen = app.timeline.events; if (am) { before = base; base = describe(); } }
    };

    const examples = [
      ['B+ tree, fan-out 4', 'ex_bplus', 'ex_bplus_k', 'create table ex_bplus (k int, v text);\ninsert into ex_bplus select g, \'row \' || g from generate_series(1, 30) g;\ncreate index ex_bplus_k on ex_bplus (k) with (fanout = 4);'],
      ['Extendible hashing', 'ex_ehash', 'ex_ehash_k', 'create table ex_ehash (k int, v text);\ninsert into ex_ehash select g * 7, \'row \' || g from generate_series(1, 16) g;\ncreate index ex_ehash_k on ex_ehash using hash (k) with (scheme = \'extendible\', bucket_size = 3);'],
      ['Linear hashing', 'ex_lhash', 'ex_lhash_k', 'create table ex_lhash (k int, v text);\ninsert into ex_lhash select g * 3, \'row \' || g from generate_series(1, 16) g;\ncreate index ex_lhash_k on ex_lhash using hash (k) with (scheme = \'linear\', bucket_size = 3);'],
      ['Static hashing', 'ex_shash', 'ex_shash_k', 'create table ex_shash (k int, v text);\ninsert into ex_shash select g * 5, \'row \' || g from generate_series(1, 16) g;\ncreate index ex_shash_k on ex_shash using hash (k) with (scheme = \'static\', buckets = 4, bucket_size = 2);'],
      ['Bitmap', 'ex_bitmap', 'ex_bitmap_genre', 'create table ex_bitmap (id int, genre text);\ninsert into ex_bitmap select g, case g % 4 when 0 then \'drama\' when 1 then \'comedy\' when 2 then \'opera\' else \'dance\' end from generate_series(1, 40) g;\ncreate index ex_bitmap_genre on ex_bitmap using bitmap (genre);'],
      ['LSM tree', 'ex_lsm', 'ex_lsm_k', 'create table ex_lsm (k int, v text);\ncreate index ex_lsm_k on ex_lsm using lsm (k) with (memtable_size = 4, size_ratio = 3, page_entries = 4, bloom_bits = 8);\ninsert into ex_lsm select (g * 37) % 101, \'row \' || g from generate_series(1, 22) g;'],
      ['R-tree on points', 'ex_rtree', 'ex_rtree_xy', 'create table ex_rtree (x float8, y float8);\ninsert into ex_rtree select (g * 37) % 100, (g * 61) % 100 from generate_series(1, 24) g;\ncreate index ex_rtree_xy on ex_rtree using rtree (x, y) with (max_entries = 4);'],
    ];
    const runExample = (ex) => {
      app.runText('drop table if exists ' + ex[1] + ';\n' + ex[3], { insert: true });
      const r = cat().lookup({ name: ex[2] });
      if (r) { choose(r.oid); view.render(); } else UI.toast('The example did not build its index; see the results.', 'warn');
    };

    const openTid = (tid) => {
      const v = app.openView('storage', { rel: idx.table, tid: { b: tid.b, o: tid.o } });
      if (!v) UI.toast('The storage view is not available', 'warn');
    };

    // ---- what the recorded run did to this index, up to the current step ----------------------------------------------
    function trace() {
      const tl = app.timeline, evs = tl.events, pos = tl.pos;
      if (!idx || !evs.length) return null;
      const pre = PREFIX[kind] + '.';
      const mine = [];
      for (let i = 0; i < evs.length; i++) { const e = evs[i]; if (e.type.startsWith(pre) && e.data && e.data.index === idx.name) mine.push(i); }
      if (!mine.length) return { none: true };
      let fs = -1, fc = -1;
      for (const i of mine) { const a = evs[i].type.slice(pre.length); if (fs < 0 && STRUCT.has(a)) fs = i; if (fc < 0 && CHANGE.has(a)) fc = i; }
      const flip = fs >= 0 ? fs : fc;
      const r = { total: mine.length, upto: 0, visits: new Map(), path: [], cur: null, flip, after: flip < 0 || pos > flip, changes: mine.filter((i) => STRUCT.has(evs[i].type.slice(pre.length))).length, inserts: 0 };
      let lastLevel = Infinity;
      for (const i of mine) {
        if (i >= pos) break;
        r.upto++;
        const e = evs[i], a = e.type.slice(pre.length), d = e.data;
        if (a === 'visit') {
          if (d.block === 0 || (d.level !== undefined && d.level > lastLevel)) r.path = [];
          if (d.block !== 0) r.path.push(d.block);
          if (d.level !== undefined) lastLevel = d.level;
          r.visits.set(d.block, (r.visits.get(d.block) || 0) + 1);
        } else if (a === 'window') r.window = d.window;
        else if (a === 'insert') r.inserts++;
      }
      const cur = pos > 0 ? evs[pos - 1] : null;
      if (cur && cur.type.startsWith(pre) && cur.data && cur.data.index === idx.name) r.cur = { a: cur.type.slice(pre.length), d: cur.data };
      return r;
    }
    function highlight(tr, snap) {
      const hi = { visited: new Set(), path: new Set(), cur: new Set(), split: new Set(), fresh: new Set(), tids: new Set(), keys: new Set(), sel: null };
      if (sel) hi.sel = sel.id;
      if (!tr || tr.none) return hi;
      for (const b of tr.visits.keys()) hi.visited.add(b);
      for (const b of tr.path) hi.path.add(b);
      if (tr.window) hi.window = tr.window;
      if (kind === 'hash' && snap && snap.directoryPages && snap.directoryPages.some((b) => hi.visited.has(b))) hi.dirVis = new Set([true]);
      const c = tr.cur;
      if (!c) return hi;
      const d = c.d;
      if (d.block !== undefined) hi.cur.add(d.block);
      if (c.a === 'split') { hi.split.add(d.block); if (d.right !== undefined) hi.fresh.add(d.right); if (d.newBlock !== undefined) hi.fresh.add(d.newBlock); }
      if (c.a === 'newroot') hi.fresh.add(d.block);
      if (c.a === 'merge') { if (d.left !== undefined) hi.cur.add(d.left); if (d.right !== undefined) hi.split.add(d.right); }
      if (c.a === 'redistribute') { hi.cur.add(d.to); hi.split.add(d.from); }
      if (c.a === 'overflow') { hi.cur.add(d.block); hi.fresh.add(d.overflow); }
      if (c.a === 'double' || c.a === 'halve') hi.dirAll = new Set([true]);
      if (d.tid) hi.tids.add(D().tidKey(d.tid));
      if (kind === 'hash' && d.bucket !== undefined && (c.a === 'insert' || c.a === 'delete')) hi.slot = d.bucket;
      if (kind === 'hash' && snap && snap.directoryPages && snap.directoryPages.some((b) => hi.visited.has(b))) hi.dirVis = new Set([true]);
      if (kind === 'bplus' && d.tid && snap && snap.nodes) for (const n of snap.nodes) if (n.leaf) n.entries.forEach((e, i) => { if (e.tid.b === d.tid.b && e.tid.o === d.tid.o) hi.keys.add(n.block + ':' + i); });
      if (kind === 'bitmap' && (c.a === 'insert' || c.a === 'delete')) { const kt = D().key(d.key, idx.keyTypes, 40); hi.rows = new Set([kt]); hi.bits = new Map([[kt, d.bit]]); }
      if (kind === 'lsm') {
        if (c.a === 'bloom') { hi.probe = { run: d.run, value: d.value, maybe: d.maybe }; hi.runs = new Set([d.run]); }
        if (c.a === 'flush') { hi.fresh.add(d.run); hi.runs = new Set([d.run]); }
        if (c.a === 'compaction' && d.into) { hi.fresh.add(d.into); hi.runs = new Set([d.into]); }
        if (c.a === 'insert') hi.cur.add('mem');
      }
      return hi;
    }

    /** one recorded event on this index, in words */
    function say(c) {
      const d = c.d, k = (x) => D().key(x, idx.keyTypes, 30);
      switch (c.a) {
        case 'visit': return 'Read block ' + d.block + (d.block === 0 ? ' (the meta page)' : d.leaf === true ? ' (a leaf)' : d.leaf === false ? ' (an internal node, level ' + d.level + ')' : '');
        case 'insert': return 'Insert ' + k(d.key) + ' for TID ' + D().tid(d.tid) + (d.bucket !== undefined ? ' into ' + (base && base.scheme === 'extendible' ? 'slot ' : 'bucket ') + d.bucket : d.block !== undefined ? ' into block ' + d.block : d.bit !== undefined ? ': set bit ' + d.bit : '');
        case 'delete': return 'Delete ' + k(d.key) + (d.tid ? ' for TID ' + D().tid(d.tid) : '');
        case 'bloom': return 'The Bloom filter of run ' + d.run + ' says ' + (d.maybe ? 'maybe: the run is read' : 'no: the run is skipped') + ' for ' + D().val(d.value);
        case 'window': return 'Query window x ' + d.window[0] + ' … ' + d.window[2] + ', y ' + d.window[1] + ' … ' + d.window[3];
        case 'scan': return 'Bitmap scan: ' + UI.plural(d.keys, 'key value') + ', ' + UI.plural(d.bits, 'bit') + ' set';
        case 'flush': return 'The memtable is written out as run ' + d.run + ' (' + UI.plural(d.entries, 'entry', 'entries') + ')';
        case 'compaction': return 'Compaction into level ' + d.level + ': runs ' + d.from.map((r) => r.id).join(', ') + ' merged into run ' + d.into;
        case 'double': return 'The directory doubles to ' + d.slots + ' slots (global depth ' + d.globalDepth + ')';
        case 'overflow': return 'Bucket ' + d.bucket + ' is full: overflow page ' + d.overflow + ' chained to it';
        case 'newkey': return 'A new key value ' + k(d.key) + ' gets its own bitmap';
        case 'split': return kind === 'hash' ? 'Bucket block ' + d.block + ' splits; new bucket block ' + d.newBlock : 'Block ' + d.block + ' splits into ' + d.block + ' and ' + (d.right !== undefined ? d.right : d.newBlock) + (d.sep ? ', ' + k(d.sep) + ' goes up' : '');
      }
      return UI.describeEvent({ type: PREFIX[kind] + '.' + c.a, data: d });
    }

    // ---- summaries -------------------------------------------------------------------------------------------------------
    function summary(snap) {
      const pages = app.db.disk.blocks(idx.file);
      const usable = app.db.disk.pageSize - K.PAGE_HDR - 16;
      if (kind === 'bplus') {
        const leaves = snap.nodes.filter((n) => n.leaf);
        const entries = leaves.reduce((a, n) => a + n.entries.length, 0);
        const fo = am.fanout;
        const fill = fo ? leaves.reduce((a, n) => a + n.entries.length / (fo - 1), 0) / Math.max(1, leaves.length) : leaves.reduce((a, n) => a + 1 - n.free / usable, 0) / Math.max(1, leaves.length);
        const per = entries ? (usable - leaves.reduce((a, n) => a + n.free, 0) / leaves.length) / Math.max(1, entries / leaves.length) : 0;
        const est = per ? Math.floor(usable / per) : null;
        return [
          D().stats([['Height h_i', snap.levels], ['Pages', pages, null, pages + ' blocks in the index file, block 0 is the meta page'], ['Entries', entries.toLocaleString('en-US')], ['Fan-out n', fo ? fo : est ? '≈ ' + est : '—', null, fo ? 'set with WITH (fanout = ' + fo + '): leaves hold n − 1 = ' + (fo - 1) + ' keys, internal nodes n pointers' : 'as many entries as fit on a page'], ['Leaf fill', Math.round(fill * 100) + '%'], ['Lookup', snap.levels + 1 + ' blocks', 'acc', 'h_i + 1: one node per level, then the record']]),
          h('div.ix-formula', 'Equality lookup cost: ', h('code', 'h_i + 1 = ' + snap.levels + ' + 1 = ' + (snap.levels + 1)), ' block accesses (one node per level down to the leaf, then the record), i.e. ', h('code', '(h_i + 1)(t_T + t_S)'), '.'),
        ];
      }
      if (kind === 'hash') {
        const npages = snap.buckets.reduce((a, b) => a + b.pages.length, 0);
        const chain = npages / Math.max(1, snap.buckets.length);
        const lead = snap.scheme === 'extendible' ? 'directory' : 'bucket table';
        return [
          D().stats([['Buckets', snap.nbuckets], snap.scheme === 'extendible' ? ['Global depth i', snap.globalDepth] : snap.scheme === 'linear' ? ['Level · next', snap.level + ' · ' + snap.next] : ['Overflow pages', snap.stats.overflowPages], ['Pages', pages], ['Entries', snap.ntuples.toLocaleString('en-US')], ['Load factor', Math.round(snap.loadFactor * 100) + '%', null, 'entries / (buckets × bucket capacity ' + snap.bucketCapacity + ')'], ['Lookup', '≈ ' + +(1 + chain + 1).toFixed(1) + ' blocks', 'acc']]),
          h('div.ix-formula', h('code', snap.addressing), ' · lookup: the ' + lead + ' page, then the bucket\'s chain (' + chain.toFixed(1) + ' pages on average), then the record.'),
        ];
      }
      if (kind === 'bitmap') {
        return [
          D().stats([['Key values', snap.nkeys], ['Rows', snap.ntuples.toLocaleString('en-US')], ['Pages', pages], ['Compressed', snap.bytes + ' B'], ['Uncompressed', snap.rawBytes + ' B'], ['Ratio', snap.bytes ? (snap.rawBytes / snap.bytes).toFixed(1) + '×' : '—', 'acc']]),
          h('div.ix-formula', h('code', snap.tidToBit), ' · lookup: read the key\'s bitmap pages, then one block per heap page that has a matching bit.'),
        ];
      }
      if (kind === 'lsm') {
        const runs = snap.levels.reduce((a, l) => a + l.runs.length, 0);
        return [
          D().stats([['Levels', snap.levels.length], ['Runs', runs], ['Memtable', snap.memtable.size + ' / ' + snap.memtable.capacity], ['Pages', pages], ['Write amp.', snap.stats.writeAmplification.toFixed(2) + '×', 'acc', snap.stats.entriesWritten + ' entries written to runs for ' + snap.stats.userWrites + ' inserted'], ['Compactions', snap.stats.compactions]]),
          h('div.ix-formula', snap.compaction + ' compaction, size ratio ' + snap.sizeRatio + ' · lookup: the memtable, then for each run one Bloom filter probe and, if it says maybe, one data page.'),
        ];
      }
      const nodes = D().rtreeNodes(snap);
      return [
        D().stats([['Height', snap.levels], ['Nodes', nodes.length], ['Pages', pages], ['Entries', snap.ntuples.toLocaleString('en-US')], ['M · m', snap.maxEntries + ' · ' + snap.minEntries, null, 'at most M entries per node, at least m (but the root)'], ['Splits', snap.stats.splits]]),
        h('div.ix-formula', snap.shape + ' keys (' + snap.columns.join(', ') + ') · ' + snap.split + ' split · a point lookup reads at least h + 1 = ' + (snap.levels + 1) + ' blocks, more when rectangles overlap.'),
      ];
    }

    // ---- the selected node or bucket, entry by entry ---------------------------------------------------------------------
    function detail(snap) {
      if (!sel || !snap) return null;
      const T = idx.keyTypes;
      const tidBtn = (t) => h('button.ix-link', { type: 'button', title: 'Open this tuple in the storage view', onclick: () => openTid(t) }, D().tid(t));
      const table = (cols, rows) => h('div.ix-tablewrap', h('table.grid.small', h('thead', h('tr', cols.map((c) => h('th', c)))), h('tbody', rows)));
      const box = (title, sub, content) => h('section.ix-detail', h('div.ix-dh', h('b', title), sub ? h('span.muted', sub) : null, h('button.icon-btn', { type: 'button', 'aria-label': 'Close', onclick: () => { sel = null; view.render(); } }, UI.icon('x'))), content);
      if (sel.type === 'bnode') {
        const n = snap.nodes.find((x) => x.block === sel.id);
        if (!n) return null;
        if (n.leaf) return box('Leaf, block ' + n.block, n.entries.length + ' entries · left ' + (n.left ?? '—') + ' · right ' + (n.right ?? '—'), table(['#', 'Key', 'TID'], n.entries.map((e, i) => h('tr', h('td.rn', String(i + 1)), h('td', D().key(e.key, T, 60)), h('td', tidBtn(e.tid))))));
        return box('Internal node, block ' + n.block, 'level ' + n.level + ' · ' + n.entries.length + ' pointers', table(['#', 'Separator', 'Child block'], n.entries.map((e, i) => h('tr', h('td.rn', String(i + 1)), h('td', e.key ? D().key(e.key, T, 60) : h('span.muted', '(first pointer, no key)')), h('td', String(e.child))))));
      }
      if (sel.type === 'bucket') {
        const b = snap.buckets.find((x) => x.block === sel.id);
        if (!b) return null;
        const rows = [];
        b.pages.forEach((p, k) => p.entries.forEach((e) => rows.push(h('tr', h('td', String(p.block) + (k ? ' (overflow)' : '')), h('td', D().key(e.key, T, 60)), h('td', h('code', e.bits)), h('td', String(e.bucket)), h('td', tidBtn(e.tid))))));
        return box('Bucket ' + b.bucket, b.count + ' entries on ' + b.pages.length + (b.pages.length === 1 ? ' page' : ' pages') + (b.localDepth !== null ? ' · local depth ' + b.localDepth : ''), table(['Block', 'Key', 'h(K)', snap.scheme === 'extendible' ? 'Slot' : 'Bucket', 'TID'], rows));
      }
      if (sel.type === 'bkey') {
        const k = snap.keys.find((x) => D().key(x.key, T, 40) === sel.id);
        if (!k) return null;
        return box('Key ' + D().key(k.key, T, 60), k.count + ' rows · ' + k.words + ' words · ' + k.bytes + ' bytes (' + k.rawBytes + ' uncompressed) · pages ' + k.pages.join(', '), h('div.ix-tids', k.tids.map(tidBtn), k.count > k.tids.length ? h('span.muted', '…') : null));
      }
      if (sel.type === 'run') {
        let r = null;
        for (const l of snap.levels) for (const x of l.runs) if ('r' + x.id === sel.id) r = x;
        if (!r) return null;
        const rows = [];
        r.pages.forEach((p) => p.entries.forEach((e) => rows.push(h('tr', h('td', String(p.block)), h('td', (e.tomb ? '✕ ' : '') + D().key(e.key, T, 60)), h('td', e.tomb ? h('span.muted', 'tombstone') : tidBtn(e.tid))))));
        return box('Run ' + r.id, r.entries + ' entries · keys ' + D().key(r.minKey, T) + ' to ' + D().key(r.maxKey, T) + ' · Bloom filter ' + r.bloom.bits + ' bits, k = ' + r.bloom.hashes + (r.bloom.probes ? ' · ' + r.bloom.probes + ' probes, ' + r.bloom.falsePositives + ' false positives' : ''), table(['Block', 'Key', 'TID'], rows));
      }
      if (sel.type === 'rnode') {
        const n = D().rtreeNodes(snap).find((x) => x.block === sel.id);
        if (!n) return null;
        const f = (r) => '[' + r.map((v) => D().val(v)).join(', ') + ']';
        return box((n.leaf ? 'Leaf' : 'Internal node') + ', block ' + n.block, n.entries.length + ' entries · MBR ' + (n.mbr ? f(n.mbr) : '—'), table(n.leaf ? ['#', 'Key', 'MBR', 'TID'] : ['#', 'MBR', 'Child'], n.entries.map((e, i) => (n.leaf ? h('tr', h('td.rn', String(i + 1)), h('td', D().key(e.key, T, 40)), h('td', h('code', f(e.mbr))), h('td', tidBtn(e.tid))) : h('tr', h('td.rn', String(i + 1)), h('td', h('code', f(e.mbr))), h('td', String(e.child)))))));
      }
      return null;
    }

    // ---- drawing ---------------------------------------------------------------------------------------------------------
    function draw(snap, hi) {
      const o = { types: idx.keyTypes, hi, onTid: openTid };
      if (kind === 'bplus') {
        const fo = am.fanout;
        return D().tree(D().bplusItems(snap, { cap: fo ? { leaf: fo - 1, internal: fo } : null, usable: app.db.disk.pageSize - K.PAGE_HDR - 16, types: idx.keyTypes, hi, max: 8 }), Object.assign(o, { onNode: (it) => { sel = { type: 'bnode', id: it.block }; view.render(); }, label: 'B+ tree ' + idx.name }));
      }
      if (kind === 'hash') return D().hash(snap, Object.assign(o, { onNode: (x) => { sel = { type: 'bucket', id: x.bucket.block }; view.render(); } }));
      if (kind === 'bitmap') {
        if (hi.visited.size) { hi.visitedRows = new Set(snap.keys.filter((k) => k.pages.some((p) => hi.visited.has(p))).map((k) => D().key(k.key, idx.keyTypes, 40))); }
        if (sel) hi.sel = sel.id;
        return D().bitmap(snap, Object.assign(o, { onNode: (k) => { sel = { type: 'bkey', id: D().key(k.key, idx.keyTypes, 40) }; view.render(); } }));
      }
      if (kind === 'lsm') { if (sel) hi.sel = sel.id; return D().lsm(snap, Object.assign(o, { am, onNode: (x) => { sel = { type: 'run', id: 'r' + x.run.id }; view.render(); } })); }
      return D().tree(D().rtreeItems(snap, { types: idx.keyTypes, hi }), Object.assign(o, { onNode: (it) => { sel = { type: 'rnode', id: it.block }; view.render(); }, label: 'R-tree ' + idx.name }));
    }

    function renderHead() {
      head.innerHTML = '';
      const ts = userTables();
      const rel = idx ? cat().rel(idx.table) : null;
      if (ts.length) {
        head.appendChild(h('select.inp.ix-sel', { 'aria-label': 'Table', onchange: (e) => { const r = cat().rel(+e.target.value); const ix = r ? cat().indexesOf(r) : []; choose(ix.length ? ix[0].oid : null); view.render(); } },
          ts.map((r) => h('option', { value: String(r.oid), selected: rel && rel.oid === r.oid }, r.name))));
        if (rel) head.appendChild(h('select.inp.ix-sel', { 'aria-label': 'Index', onchange: (e) => { choose(+e.target.value); view.render(); } },
          cat().indexesOf(rel).map((x) => h('option', { value: String(x.oid), selected: x.oid === oid }, x.name + ' · ' + x.method))));
      }
      head.appendChild(h('div.grow'));
      head.appendChild(UI.btn('flask', 'Examples', 'Build a small example index of each kind', (e) => UI.menu(e.currentTarget, examples.map((ex) => ({ label: ex[0], icon: 'index', onclick: () => runExample(ex) })), { right: true }), 'ghost'));
      head.appendChild(UI.btn('refresh', null, 'Read the index again', () => { if (am) { base = describe(); before = null; } view.render(); }, 'icon'));
    }

    const view = {
      onSelect(x) {
        if (!x) return;
        if (x.index !== undefined) choose(typeof x.index === 'object' ? x.index.oid : x.index);
        else if (x.rel !== undefined) { const r = cat().rel(typeof x.rel === 'object' ? x.rel.oid : x.rel); const ix = r && r.kind !== 'index' ? cat().indexesOf(r) : []; if (ix.length) choose(ix[0].oid); }
        if (el.offsetParent !== null) view.render();
      },
      onRun() { sync(); },
      onDb() { oid = null; am = null; idx = null; base = before = null; seen = app.timeline.events; sel = null; },
      render() {
        if (oid === null || !cat().rel(oid)) pickDefault();
        sync();
        renderHead();
        body.innerHTML = '';
        if (!idx) {
          body.appendChild(h('div.empty', h('p', 'No table here has an index yet.'), h('p.muted', 'Create one (CREATE INDEX … ON t (k) WITH (fanout = 4) gives a teaching-size B+ tree), or build an example:'), h('div.ix-row.center', examples.map((ex) => UI.btn('index', ex[0], null, () => runExample(ex), 'small')))));
          return;
        }
        const scheme = kind === 'hash' && base ? base.scheme : null;
        const what = (scheme ? scheme + ' ' : '') + NAMES[kind];
        body.appendChild(h('p.ix-intro', h('b', idx.name), ' is ' + (/^([aeiou]|LSM|R-)/i.test(what) ? 'an ' : 'a ') + what + ' on ' + (cat().rel(idx.table) || {}).name + ' (' + idx.keys.map((k) => k.name || '?').join(', ') + '). ', INTRO[scheme || kind]));
        if (err || !base) { body.appendChild(h('div.res-err', 'This index cannot be drawn: ' + (err || 'its file is gone'))); return; }
        const tr = trace();
        const snap = tr && !tr.none && !tr.after && before ? before : base;
        body.appendChild(h('div.ix-sum', summary(snap)));
        // where we are in the recorded run, as far as this index goes
        if (tr && !tr.none) {
          const showing = snap === before ? 'as it was before the statement' : before && tr.flip >= 0 ? 'as it is after the statement' : 'now';
          const c = tr.cur;
          body.appendChild(h('div.ix-banner',
            h('div', h('span.ix-step', tr.upto + ' of ' + tr.total + ' events on this index'), tr.visits.size ? UI.plural([...tr.visits.values()].reduce((a, b) => a + b, 0), 'page read') + ' so far' + (tr.path.length ? ' · current path: blocks ' + tr.path.join(' → ') : '') : 'no pages read yet'),
            h('div.muted', c ? say(c) + '. ' : '', 'Drawn ' + showing + (tr.changes && before ? ' (' + UI.plural(tr.changes, 'structural change') + ' in this run; the index is read before and after each statement, so the picture changes at the first one).' : tr.changes ? ' (' + UI.plural(tr.changes, 'structural change') + ' in this run).' : '.')),
            D().legend([['vis', 'read in this run'], ['path', 'current path'], ['cur', 'this step'], ['split', 'split / changed']])));
        } else if (tr && tr.none) body.appendChild(h('div.ix-note', 'The last statement did not touch this index. Run a query that uses it (try EXPLAIN on a WHERE on its key) and step through the run.'));
        else body.appendChild(h('div.ix-note', 'Run a statement that uses this index (a SELECT with a WHERE on its key, an INSERT) and step through it with the controls above to see which pages each step reads.'));
        const hi = highlight(tr, snap);
        if (kind === 'rtree') body.appendChild(h('div.ix-plane', D().rtreePlane(snap, { types: idx.keyTypes, hi, size: 300 })));
        body.appendChild(canvas.el);
        const pic = draw(snap, hi);
        // a newly chosen index opens at its root (or, for the pictures without one, at the top left)
        canvas.show(pic.svg, pic.w, pic.h, pic.focus, drawn !== oid ? pic.home || { x: 0, y: 0, w: 0, h: 0 } : null);
        drawn = oid;
        const dt = detail(snap);
        if (dt) body.appendChild(dt);
        else body.appendChild(h('p.ix-hint.muted', 'Click a node, bucket, run or key to list its entries; click a TID to open that tuple in the storage view.'));
      },
    };
    pickDefault();
    return view;
  }

  UI.registerView({ id: 'index', title: 'Index', icon: 'index', group: 'Indexing', order: 20, events: true, create });
})(typeof window !== 'undefined' ? window : globalThis);
