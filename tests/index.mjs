// Tests of the index structures: hash (static, extendible, linear), bitmap, LSM tree, R-tree, the B+ tree's
// textbook deletion and bulk loading, the in-memory B-tree, k-d tree and quadtree, and the playground. Random
// operations are checked against a sorted array, structural invariants against describe(), and SQL queries
// on the Theatre database answered through each index against the same queries without it.
// Run: node tests/index.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { load } from './load.mjs';

const K = load();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const theatre = fs.readFileSync(path.join(root, 'src/data/theatre.sql'), 'utf8');
const PG = K.IndexPlayground;

let pass = 0, fail = 0;
const json = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? String(x) : x));
function ok(name, cond, info) {
  if (cond) { pass++; return; }
  fail++;
  console.log('FAIL ' + name + (info !== undefined ? ': ' + json(info).slice(0, 400) : ''));
}
function eq(name, got, want) { ok(name, json(got) === json(want), { got, want }); }
function rng(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }
const count = (arr, v) => arr.filter((x) => x === v).length;
const steps = (pg, action) => pg.history.filter((h) => h.action === action).length;

// ---- the B+ tree: textbook delete (redistribution, coalescing) and bulk loading ----------------------------------------
function bplusCheck(name, d, fanout) {
  const leaves = [];
  const depths = new Set();
  const walk = (n, depth, lo, hi, isRoot) => {
    if (n.leaf) {
      depths.add(depth);
      for (const e of n.entries) { leaves.push(e.key[0]); if (lo !== null && e.key[0] < lo) ok(name + ' leaf key below its separator', false, { key: e.key, lo }); if (hi !== null && e.key[0] > hi) ok(name + ' leaf key above the next separator', false, { key: e.key, hi }); }
      if (!isRoot && fanout) ok(name + ' leaf at least half full', n.entries.length >= Math.ceil((fanout - 1) / 2), { block: n.block, n: n.entries.length });
      if (fanout) ok(name + ' leaf not over full', n.entries.length <= fanout - 1, { n: n.entries.length });
      return;
    }
    if (!isRoot && fanout) ok(name + ' internal node at least half full', n.children.length >= Math.ceil(fanout / 2), { block: n.block, n: n.children.length });
    if (fanout) ok(name + ' internal node not over full', n.children.length <= fanout, { n: n.children.length });
    if (isRoot) ok(name + ' internal root has two children', n.children.length >= 2);
    n.children.forEach((c, i) => walk(c, depth + 1, i === 0 ? lo : n.entries[i].key[0], i + 1 < n.entries.length ? n.entries[i + 1].key[0] : hi, false));
  };
  walk(d.tree, 0, null, null, true);
  ok(name + ' leaves all at one depth', depths.size === 1, [...depths]);
  return leaves;
}
{
  const r = rng(7);
  const pg = PG.make('bplus', { fanout: 4 });
  const oracle = [];
  for (let i = 0; i < 400; i++) {
    const k = Math.floor(r() * 60);
    if (r() < 0.6 || !oracle.length) { pg.insert(k); oracle.push(k); } else { const v = oracle[Math.floor(r() * oracle.length)]; ok('bplus delete finds the key', pg.delete(v)); oracle.splice(oracle.indexOf(v), 1); }
    if (i % 50 === 49) eq('bplus leaves = sorted oracle after ' + (i + 1) + ' operations', bplusCheck('bplus', pg.describe(), 4), oracle.slice().sort((a, b) => a - b));
  }
  for (let k = 0; k < 60; k++) eq('bplus search ' + k, pg.search(k).tids.length, count(oracle, k));
  eq('bplus range 10..20', pg.range(10, 20).keys, oracle.filter((x) => x >= 10 && x <= 20).sort((a, b) => a - b));
  ok('bplus splits recorded', steps(pg, 'split') > 0);
  ok('bplus merges recorded', steps(pg, 'merge') > 0);
  ok('bplus redistributions recorded', steps(pg, 'redistribute') > 0);
  ok('bplus history has snapshots', pg.history.every((h) => h.snapshot && h.snapshot.tree));
  while (oracle.length) { pg.delete(oracle.pop()); }
  const d = pg.describe();
  ok('bplus emptied back to one leaf', d.levels === 1 && d.tree.leaf && d.tree.entries.length === 0, { levels: d.levels });
  ok('bplus root shrank on the way', steps(pg, 'shrink') > 0);
}
{
  const keys = Array.from({ length: 100 }, (_, i) => (i * 37) % 100);
  for (const ff of [100, 70]) {
    const pg = PG.make('bplus', { fanout: 5 });
    const res = pg.bulkLoad(keys, ff);
    const d = pg.describe();
    const leaves = [];
    const walk = (n) => { if (n.leaf) { leaves.push(n); return; } n.children.forEach(walk); };
    walk(d.tree);
    eq('bulk load ' + ff + '% leaves in order', leaves.flatMap((l) => l.entries.map((e) => e.key[0])), keys.slice().sort((a, b) => a - b));
    ok('bulk load ' + ff + '% leaf fill', leaves.every((l) => l.entries.length <= Math.max(1, Math.floor(4 * ff / 100))), leaves.map((l) => l.entries.length));
    ok('bulk load ' + ff + '% leaves linked', leaves.every((l, i) => (i === 0 ? l.left === null : l.left === leaves[i - 1].block) && (i === leaves.length - 1 ? l.right === null : l.right === leaves[i + 1].block)));
    eq('bulk load ' + ff + '% levels', res.levels, d.levels);
    for (const k of [0, 42, 99]) eq('bulk load search ' + k, pg.search(k).tids.length, 1);
    for (let k = 100; k < 140; k++) pg.insert(k);
    for (let k = 0; k < 50; k++) pg.delete(k);
    const after = bplusCheck('bulk load then changes', pg.describe(), 5);
    eq('bulk load then changes keys', after, Array.from({ length: 90 }, (_, i) => i + 50));
  }
}

// ---- the in-memory B-tree ------------------------------------------------------------------------------------------------
{
  const r = rng(11);
  const t = new K.BTreeClassic({ order: 4 });
  const set = new Set();
  const stepsSeen = new Set();
  t.onStep = (a) => stepsSeen.add(a);
  const check = () => {
    const depths = new Set();
    const walk = (n, depth, isRoot) => {
      if (!isRoot) ok('btree node keys >= min', n.keys.length >= t.minKeys, n.keys);
      ok('btree node keys <= max', n.keys.length <= t.maxKeys, n.keys);
      if (!n.kids) { depths.add(depth); return; }
      ok('btree children = keys + 1', n.kids.length === n.keys.length + 1);
      n.kids.forEach((c) => walk(c, depth + 1, false));
    };
    walk(t.root, 0, true);
    ok('btree leaves at one depth', depths.size === 1);
    eq('btree keys = sorted set', t.keys(), [...set].sort((a, b) => a - b));
  };
  for (let i = 0; i < 600; i++) {
    const k = Math.floor(r() * 120);
    if (r() < 0.55) { t.insert(k); set.add(k); } else { eq('btree delete result ' + k, t.delete(k), set.has(k)); set.delete(k); }
    if (i % 100 === 99) check();
  }
  for (let k = 0; k < 120; k += 7) eq('btree search ' + k, t.search(k).found, set.has(k));
  eq('btree range', t.range(30, 60).keys, [...set].filter((x) => x >= 30 && x <= 60).sort((a, b) => a - b));
  ok('btree steps split, merge, redistribute', ['split', 'merge', 'redistribute', 'newroot'].every((s) => stepsSeen.has(s)), [...stepsSeen]);
  const d = t.describe();
  ok('btree describe', d.kind === 'btree' && d.size === set.size && d.root.keys);
}

// ---- hash indexes ------------------------------------------------------------------------------------------------------------
ok('hash: 1, 1.0 and 1::bigint hash alike', K.indexHash([1]) === K.indexHash([1n]) && K.indexHash([1]) === K.indexHash([K.Decimal.parse('1.0')]) && K.indexHash([1]) === K.indexHash([1.0]));
ok('hash: 1 and 2 differ', K.indexHash([1]) !== K.indexHash([2]));
ok('hash: char ignores trailing blanks', K.indexHash(['ab  '], [K.T.BASE.char]) === K.indexHash(['ab'], [K.T.BASE.char]));
eq('hash: FNV-1a of "a"', K.fnv('a'), 0xe40c292c);
for (const kind of ['static-hash', 'extendible-hash', 'linear-hash']) {
  const r = rng(kind.length * 31);
  const pg = PG.make(kind, { bucket_size: 2, buckets: 3 });
  const oracle = [];
  for (let i = 0; i < 300; i++) {
    const k = Math.floor(r() * 80);
    if (r() < 0.7 || !oracle.length) { pg.insert(k); oracle.push(k); } else { const v = oracle[Math.floor(r() * oracle.length)]; ok(kind + ' delete', pg.delete(v)); oracle.splice(oracle.indexOf(v), 1); }
  }
  for (let k = 0; k < 80; k++) eq(kind + ' search ' + k, pg.search(k).tids.length, count(oracle, k));
  eq(kind + ' range (a scan of every bucket)', pg.range(5, 25).keys, oracle.filter((x) => x >= 5 && x <= 25).sort((a, b) => a - b));
  const d = pg.describe();
  eq(kind + ' entries in buckets', d.buckets.reduce((a, b) => a + b.count, 0), oracle.length);
  eq(kind + ' ntuples', d.ntuples, oracle.length);
  ok(kind + ' bucket capacity respected', d.buckets.every((b) => b.pages.every((p) => p.entries.length <= 2)));
  ok(kind + ' overflow pages only after full ones', d.buckets.every((b) => b.pages.every((p, i) => i === b.pages.length - 1 || p.entries.length === 2)));
  if (d.scheme === 'extendible') {
    eq('extendible directory size = 2^global depth', d.directory.length, 2 ** d.globalDepth);
    for (const b of d.buckets) {
      ok('extendible local depth <= global depth', b.localDepth <= d.globalDepth);
      eq('extendible slots per bucket = 2^(global - local)', d.directory.filter((s) => s.block === b.block).length, 2 ** (d.globalDepth - b.localDepth));
      for (const p of b.pages) for (const e of p.entries) eq('extendible entry in the bucket its bits pick', d.directory[d.globalDepth ? e.hash >>> (32 - d.globalDepth) : 0].block, b.block);
    }
    ok('extendible doublings recorded', steps(pg, 'double') > 0 && d.stats.doublings > 0);
    ok('extendible merges after deletes', steps(pg, 'merge') > 0);
  } else {
    for (const b of d.buckets) for (const p of b.pages) for (const e of p.entries) eq(d.scheme + ' entry in its bucket', e.bucket, b.bucket);
  }
  if (d.scheme === 'linear') {
    eq('linear buckets = n0 * 2^level + next', d.nbuckets, d.initialBuckets * 2 ** d.level + d.next);
    ok('linear splits recorded', steps(pg, 'split') > 0);
  }
  if (d.scheme === 'static') { eq('static keeps its buckets', d.nbuckets, 3); ok('static overflow chains', steps(pg, 'overflow') > 0 && d.stats.overflowPages > 0); }
  ok(kind + ' describe has the hash function', /FNV-1a/.test(d.hashFunction));
  const h = pg.am.hashOf(42);
  ok(kind + ' hashOf', h.hash === K.indexHash([42]) && h.bin.length === 32);
}

// ---- bitmaps --------------------------------------------------------------------------------------------------------------------
{
  const r = rng(5);
  for (let t = 0; t < 40; t++) {
    const n = 2000;
    const pick = (p) => { const s = new Set(); const runLen = Math.floor(r() * 200); for (let i = 0; i < n; i++) if (r() < p || (i > 500 && i < 500 + runLen)) s.add(i); return s; };
    const a = pick(r() * 0.1), b = pick(r() * 0.5);
    const A = K.Bitmap.fromPositions([...a]), B = K.Bitmap.fromPositions([...b]);
    eq('wah round trip', [...A.positions()], [...a].sort((x, y) => x - y));
    eq('wah count', A.count(), a.size);
    eq('wah and', [...K.Bitmap.and(A, B).positions()], [...a].filter((x) => b.has(x)).sort((x, y) => x - y));
    eq('wah or', [...K.Bitmap.or(A, B).positions()], [...new Set([...a, ...b])].sort((x, y) => x - y));
    eq('wah and not', [...K.Bitmap.andNot(A, B).positions()], [...a].filter((x) => !b.has(x)).sort((x, y) => x - y));
  }
  const sparse = K.Bitmap.fromPositions([3, 100000]);
  ok('wah compresses a long run of zeros', sparse.words.length === 3, sparse.describe().words);
  const full = K.Bitmap.fromPositions(Array.from({ length: 31 * 10 }, (_, i) => i));
  ok('wah compresses ones', full.words.length === 1 && full.describe().words[0].type === 'fill' && full.describe().words[0].bit === 1);

  const pg = PG.make('bitmap', {});
  const oracle = [];
  for (let i = 0; i < 300; i++) {
    const k = Math.floor(r() * 6);
    if (r() < 0.75 || !oracle.length) { pg.insert(k); oracle.push(k); } else { const v = oracle[Math.floor(r() * oracle.length)]; ok('bitmap delete', pg.delete(v)); oracle.splice(oracle.indexOf(v), 1); }
  }
  for (let k = 0; k < 7; k++) eq('bitmap search ' + k, pg.search(k).tids.length, count(oracle, k));
  eq('bitmap range', pg.range(2, 4).keys, oracle.filter((x) => x >= 2 && x <= 4).sort((a, b) => a - b));
  const d = pg.describe();
  eq('bitmap keys', d.keys.map((k) => k.key[0]), [...new Set(oracle)].sort((a, b) => a - b));
  ok('bitmap counts', d.keys.every((k) => k.count === count(oracle, k.key[0]) && k.runs.length === k.words));
  ok('bitmap describe says WAH', /WAH/.test(d.compression) && d.bitsPerBlock > 0);
  const am = pg.am;
  const or = K.Bitmap.or(am.bitmapOf(1), am.bitmapOf(2));
  eq('bitmap OR of two keys', or.count(), count(oracle, 1) + count(oracle, 2));
  eq('bitmap AND of two keys is empty', K.Bitmap.and(am.bitmapOf(1), am.bitmapOf(2)).count(), 0);
}

// ---- LSM trees --------------------------------------------------------------------------------------------------------------------
for (const compaction of ['leveled', 'tiered']) {
  const r = rng(compaction.length * 13);
  const pg = PG.make('lsm', { memtable_size: 4, compaction, size_ratio: 3, bloom_bits: 6 });
  const oracle = [];
  for (let i = 0; i < 400; i++) {
    const k = Math.floor(r() * 100);
    if (r() < 0.7 || !oracle.length) { pg.insert(k); oracle.push(k); } else { const v = oracle[Math.floor(r() * oracle.length)]; ok('lsm delete', pg.delete(v)); oracle.splice(oracle.indexOf(v), 1); }
    if (i % 80 === 79) for (let q = 0; q < 100; q += 3) eq('lsm ' + compaction + ' search ' + q + ' after ' + (i + 1), pg.search(q).tids.length, count(oracle, q));
  }
  for (let q = 0; q < 100; q++) eq('lsm ' + compaction + ' search ' + q, pg.search(q).tids.length, count(oracle, q));
  for (const [lo, hi] of [[0, 99], [10, 20], [50, 50], [90, 200]]) eq('lsm ' + compaction + ' range ' + lo + '..' + hi, pg.range(lo, hi).keys, oracle.filter((x) => x >= lo && x <= hi).sort((a, b) => a - b));
  const d = pg.describe();
  ok('lsm ' + compaction + ' flushes and compactions', steps(pg, 'flush') > 0 && steps(pg, 'compaction') > 0 && d.stats.compactions > 0, d.stats);
  ok('lsm ' + compaction + ' memtable below capacity', d.memtable.size < d.memtable.capacity);
  if (compaction === 'leveled') ok('lsm leveled: one run per level', d.levels.every((l) => l.runs.length === 1));
  else ok('lsm tiered: fewer than size_ratio runs per level', d.levels.every((l) => l.runs.length < 3));
  const runs = d.levels.flatMap((l) => l.runs);
  ok('lsm runs sorted', runs.every((run) => { const ks = run.pages.flatMap((p) => p.entries.map((e) => e.key[0])); return ks.every((k, i) => i === 0 || ks[i - 1] <= k); }));
  ok('lsm run entry counts', runs.every((run) => run.pages.reduce((a, p) => a + p.entries.length, 0) === run.entries));
  ok('lsm bloom filters probed', runs.some((run) => run.bloom.probes > 0 && run.bloom.negatives > 0), runs.map((x) => x.bloom));
  ok('lsm expected false positive rate', runs.every((run) => run.bloom.expectedFp > 0 && run.bloom.expectedFp < 0.5));
  ok('lsm write amplification >= 1', d.stats.writeAmplification >= 1, d.stats);
  pg.compact();
  const after = pg.describe();
  ok('lsm major compaction leaves one run and no tombstones', after.levels.flatMap((l) => l.runs).length <= 1 && after.levels.every((l) => l.runs.every((x) => x.tombstones === 0)));
  for (let q = 0; q < 100; q += 5) eq('lsm after compaction search ' + q, pg.search(q).tids.length, count(oracle, q));
}

// ---- R-trees, k-d trees, quadtrees --------------------------------------------------------------------------------------------------
{
  const r = rng(99);
  const pg = PG.make('rtree', { max_entries: 4, min_entries: 2 });
  const pts = [];
  const key = (p) => p.join(',');
  for (let i = 0; i < 250; i++) {
    if (r() < 0.75 || !pts.length) { const p = [Math.floor(r() * 100), Math.floor(r() * 100)]; pg.insert(p); pts.push(p); } else { const j = Math.floor(r() * pts.length); ok('rtree delete', pg.delete(pts[j])); pts.splice(j, 1); }
  }
  const check = () => {
    const d = pg.describe();
    const levels = new Set();
    const walk = (n, isRoot) => {
      ok('rtree node not over full', n.entries.length <= d.maxEntries);
      if (!isRoot) ok('rtree node at least m entries', n.entries.length >= d.minEntries, { n: n.entries.length, m: d.minEntries });
      if (n.leaf) { levels.add(n.level); return; }
      n.children.forEach((c, i) => { const e = n.entries[i].mbr, cm = c.mbr; ok('rtree child rectangle inside its entry', e[0] <= cm[0] && e[1] <= cm[1] && e[2] >= cm[2] && e[3] >= cm[3], { e, cm }); walk(c, false); });
    };
    walk(d.tree, true);
    ok('rtree leaves on one level', levels.size === 1);
    return d;
  };
  const d = check();
  eq('rtree entries', d.ntuples, pts.length);
  for (let q = 0; q < 30; q++) {
    const a = [Math.floor(r() * 100), Math.floor(r() * 100)], b = [Math.floor(r() * 100), Math.floor(r() * 100)];
    const lo = [Math.min(a[0], b[0]), Math.min(a[1], b[1])], hi = [Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    const want = pts.filter((p) => p[0] >= lo[0] && p[0] <= hi[0] && p[1] >= lo[1] && p[1] <= hi[1]).map(key).sort();
    eq('rtree window ' + key(lo) + '..' + key(hi), pg.range(lo, hi).keys.map(key).sort(), want);
  }
  ok('rtree splits, condensing, reinserts', steps(pg, 'split') > 0 && steps(pg, 'condense') > 0 && steps(pg, 'reinsert') > 0);
  for (const p of pts.slice(0, 20)) ok('rtree point search', pg.search(p).found);
  while (pts.length > 3) pg.delete(pts.pop());
  check();
  ok('rtree shrank', steps(pg, 'shrink') > 0);

  for (const kind of ['kdtree', 'quadtree']) {
    const t = PG.make(kind, { capacity: 2 });
    const ps = [];
    for (let i = 0; i < 200; i++) { const p = [Math.floor(r() * 1000) / 10, Math.floor(r() * 1000) / 10]; t.insert(p); ps.push(p); }
    for (let i = 0; i < 40; i++) { const j = Math.floor(r() * ps.length); ok(kind + ' delete', t.delete(ps[j])); ps.splice(j, 1); }
    const xy = (p) => p.x + ',' + p.y;
    for (let q = 0; q < 25; q++) {
      const lo = [r() * 60, r() * 60], hi = [lo[0] + r() * 40, lo[1] + r() * 40];
      eq(kind + ' range', t.range(lo, hi).points.map(xy).sort(), ps.filter((p) => p[0] >= lo[0] && p[0] <= hi[0] && p[1] >= lo[1] && p[1] <= hi[1]).map((p) => p.join(',')).sort());
      const qp = [r() * 100, r() * 100];
      const best = ps.map((p) => Math.hypot(p[0] - qp[0], p[1] - qp[1])).sort((a, b) => a - b);
      const nn = t.nearest(qp, 3);
      ok(kind + ' nearest 3', nn.distances.length === 3 && nn.distances.every((x, i) => Math.abs(x - best[i]) < 1e-9), { got: nn.distances, want: best.slice(0, 3) });
    }
    for (const p of ps.slice(0, 10)) ok(kind + ' search', t.search(p).found);
    ok(kind + ' describe', t.describe().size === ps.length);
    ok(kind + ' history', t.history.length > 200 && (kind === 'kdtree' || t.history.some((h) => h.action === 'subdivide')));
  }
  const kd = K.KDTree.build([[1, 1], [2, 5], [7, 3], [4, 4], [9, 9], [6, 1]]);
  ok('kdtree build is balanced', kd.height() === 3 && kd.range([0, 0], [10, 10]).points.length === 6);
}

// ---- the playground in general --------------------------------------------------------------------------------------------------------
{
  for (const kind of PG.kinds) {
    const pg = PG.make(kind, {});
    const keys = kind === 'rtree' || kind === 'kdtree' || kind === 'quadtree' ? [[1, 2], [3, 4], [5, 6], [7, 8], [2, 2], [9, 1]] : [5, 3, 8, 1, 9, 7, 2];
    for (const k of keys) pg.insert(k);
    ok(kind + ' playground search', pg.search(keys[2]).found, pg.search(keys[2]));
    ok(kind + ' playground delete', pg.delete(keys[2]));
    ok(kind + ' playground search after delete', !pg.search(keys[2]).found);
    ok(kind + ' playground history', pg.history[0].action === 'create' && pg.history.filter((h) => h.action === 'done').length === keys.length + 4 && pg.history.every((h) => h.snapshot));
    ok(kind + ' playground lastSteps', pg.lastSteps().length >= 1);
    if (pg.paged) ok(kind + ' playground counts pages', pg.history.filter((h) => h.detail.op === 'insert').every((h) => h.detail.pages > 0));
  }
}

// ---- SQL on the Theatre database -- --------------------------------------------------------------------------------------------------
function fresh() { const db = new K.Database(); const s = db.session(); s.exec(theatre); return { db, s }; }
const rowsOf = (s, sql) => s.exec(sql).pop().rows.map((r) => json(r)).sort();
function methodsIn(s, sql) { const out = []; const walk = (n) => { if (!n) return; if (n.index) out.push(n.index.method); if (n.indexes) n.indexes.forEach((i) => out.push(i.index.method)); (n.children || []).forEach(walk); }; walk(s.exec('explain ' + sql).pop().plan); return out; }
const SQL = [
  { ddl: "create index ix on casting using hash (prod_id)", method: 'hash', qs: ["select * from casting where prod_id = 'PR118'", "select person_id from casting where prod_id = 'PR102'", "-select c.role_name, p.title from production p join casting c on c.prod_id = p.prod_id where p.genre = 'opera'"] },
  { ddl: "create index ix on booking using hash (perf_id) with (scheme = 'static', buckets = 8)", method: 'hash', qs: ["select patron_id, seats, paid from booking where perf_id = 150", "select count(*) from booking where perf_id = 37"] },
  { ddl: "create index ix on booking using hash (perf_id) with (scheme = 'extendible', bucket_size = 8)", method: 'hash', qs: ["select patron_id, rating from booking where perf_id = 152", "select count(*) from booking where perf_id = -1"] },
  { ddl: "create index ix on booking using hash (paid) with (scheme = 'linear', bucket_size = 4)", method: 'hash', qs: ["select booking_id from booking where paid = 83", "select booking_id from booking where paid = 83.0"] },
  { ddl: "create index ix on casting using bitmap (role_name)", method: 'bitmap', qs: ["select person_id, prod_id from casting where role_name = 'Ensemble'", "select person_id from casting where role_name in ('Soloist', 'Chorus', 'Corps')", "select count(*) from casting where role_name is null"] },
  { ddl: "create index ix on casting using bitmap (lead)", method: 'bitmap', qs: ["select person_id, prod_id from casting where lead = true", "select count(*) from casting where lead in (false)"] },
  { ddl: "create index ix on booking using lsm (perf_id) with (memtable_size = 32, compaction = 'tiered', size_ratio = 3)", method: 'lsm', qs: ["select booking_id, patron_id from booking where perf_id = 153", "select count(*) from booking where perf_id >= 40 and perf_id < 60", "select count(*) from booking where perf_id > 1000"] },
  { ddl: "create index ix on booking using lsm (paid) with (memtable_size = 16, bloom_bits = 4)", method: 'lsm', qs: ["select booking_id from booking where paid = 56", "select booking_id from booking where paid between 35 and 38", "select booking_id from booking where paid < 2"] },
  { ddl: "create index ix on casting using rtree (prod_id, role_name)", method: null, err: '0A000' },
  { ddl: "create index ix on booking using rtree (perf_id)", method: 'rtree', qs: ["select booking_id from booking where perf_id between 30 and 40", "select booking_id from booking where perf_id = 114"] },
  { ddl: "create index ix on booking using gist (perf_id, patron_id)", method: 'gist', qs: ["select * from booking where perf_id >= 10 and perf_id <= 13", "select booking_id, seats from booking where perf_id = 77 and patron_id > 20"] },
];
for (const c of SQL) {
  const { s: plain } = fresh();
  const { db, s } = fresh();
  if (c.err) { try { s.exec(c.ddl); ok(c.ddl + ' fails', false); } catch (e) { eq(c.ddl + ' fails with', e.code, c.err); } continue; }
  s.exec(c.ddl);
  s.exec('set enable_seqscan = off');
  // a query written with a leading '-' only has its rows checked: the planner may well pick another plan
  c.qs = c.qs.map((q) => (q[0] === '-' ? { q: q.slice(1), any: true } : { q }));
  for (const { q, any } of c.qs) {
    const ms = methodsIn(s, q);
    if (!any) ok('plan uses the ' + c.method + ' index: ' + q, ms.includes(c.method), ms);
    eq(c.ddl + ' | ' + q, rowsOf(s, q), rowsOf(plain, q));
  }
  // changes go through the index too, and VACUUM takes the dead entries out
  const table = /on (\w+)/.exec(c.ddl)[1];
  const ix = db.catalog.tables(['index']).find((x) => x.name === 'ix');
  const am = db.indexAm(ix);
  const n0 = s.exec('select count(*) from ' + table).pop().rows[0][0];
  for (const x of [plain, s]) {
    x.exec('set enable_seqscan = on');
    x.exec('create table saved as select * from ' + table + ' limit 40');
    x.exec('delete from ' + table + ' where ctid in (select ctid from ' + table + ' limit 40)');
  }
  s.exec('set enable_seqscan = off');
  for (const { q } of c.qs) eq('after delete: ' + q, rowsOf(s, q), rowsOf(plain, q));
  let removed = 0;
  const v0 = am.vacuum;
  am.vacuum = function (isDead) { const n = v0.call(this, isDead); removed += n; return n; };
  s.exec('vacuum ' + table);
  am.vacuum = v0;
  ok('vacuum removed the dead entries of ' + ix.method + ' (' + removed + ')', removed >= Math.min(40, Number(n0)), { removed, n0 });
  for (const x of [plain, s]) x.exec('insert into ' + table + ' select * from saved');
  for (const { q } of c.qs) eq('after vacuum and insert: ' + q, rowsOf(s, q), rowsOf(plain, q));
  const d = am.describe();
  ok(ix.method + ' describe', d.method === (ix.method === 'gist' ? 'rtree' : ix.method));
}
{
  const { s } = fresh();
  // as in PostgreSQL, only B+ trees can enforce uniqueness
  try { s.exec("create unique index venue_hash on venue using hash (venue_code)"); ok('unique hash refused', false); } catch (e) { eq('hash indexes cannot be unique', e.code, '0A000'); }
  try { s.exec("create unique index r_bm on booking using bitmap (rating)"); ok('unique bitmap', false); } catch (e) { eq('bitmap indexes cannot be unique', e.code, '0A000'); }
}
{
  // a B+ tree with textbook deletion: VACUUM merges and redistributes nodes
  const { db, s } = fresh();
  const { s: plain } = fresh();
  s.exec('create index tb on booking (patron_id) with (fanout = 4, textbook_delete = true)');
  s.exec('set enable_seqscan = off');
  const ix = db.catalog.tables(['index']).find((x) => x.name === 'tb');
  const am = db.indexAm(ix);
  const events = [];
  db.bus.on('btree.merge', () => events.push('merge'));
  db.bus.on('btree.redistribute', () => events.push('redistribute'));
  const h0 = am.height();
  for (const x of [s, plain]) x.exec('delete from booking where patron_id < 100');
  s.exec('vacuum booking');
  ok('textbook delete merged and redistributed', events.includes('merge') && events.includes('redistribute'), events.length);
  const keys = bplusCheck('textbook delete in SQL', am.describe(500000), 4);
  eq('textbook delete leaves only live keys', keys.length, Number(plain.exec('select count(*) from booking').pop().rows[0][0]));
  ok('textbook delete height did not grow', am.height() <= h0);
  for (const q of ["select perf_id from booking where patron_id = (select max(patron_id) from patron)", "select count(*) from booking where patron_id >= 120 and patron_id < 160"]) eq('textbook delete: ' + q, rowsOf(s, q), rowsOf(plain, q));
}

{
  // plan shapes: what the optimizer chooses, and that every choice gives the same rows
  const { db, s } = fresh();
  const plan = (sql) => { let n = s.exec('explain ' + sql).pop().plan; while (n.op === 'Project') n = n.children[0]; return n; };
  const ops = (n, out = []) => { if (!n) return out; out.push(n.op); (n.children || []).forEach((c) => ops(c, out)); return out; };
  const q = 'select a.billed_as, c.name from artist a join company c using (company_id)';
  const want = rowsOf(s, q);
  for (const k of ['enable_hashjoin', 'enable_mergejoin', 'enable_nestloop']) s.exec('set ' + k + ' = off');
  ok('every join algorithm off falls back to a nested loop', ops(plan(q)).includes('NestLoopJoin'));
  eq('every join algorithm off: same rows', rowsOf(s, q), want);
  s.exec('reset all');
  s.exec('set work_mem_pages = 2');
  ok('a tiny work memory gives a finite sort cost', Number.isFinite(plan('select * from booking order by rating').cost));
  s.exec('reset all');
  // a left join builds its hash table on the smaller input: company, as a hash right join
  const lj = plan('select c.name, a.billed_as from company c left join artist a using (company_id)');
  const hj = (function find(n) { return n.op === 'HashJoin' ? n : (n.children || []).map(find).find(Boolean); })(lj);
  ok('hash join builds on the smaller input', hj && hj.jtype === 'right' && hj.children[1].rel && hj.children[1].rel.name === 'company', hj && { jtype: hj.jtype });
  eq('hash join on the swapped inputs: same rows', rowsOf(s, 'select c.name, a.billed_as from company c left join artist a using (company_id)').length, +rowsOf(s, 'select count(*) + (select count(*) from company c where not exists (select 1 from artist a where a.company_id = c.company_id)) from artist where company_id is not null')[0].replace(/\D/g, ''));
  // a row equality gives one join key per column
  const rj = (function find(n) { return n.keys && n.keys.length ? n : (n.children || []).map(find).find(Boolean); })(plan('select * from performance p join stage s on (p.venue_code, p.stage_no) = (s.venue_code, s.stage_no)'));
  eq('row equality split into join keys', rj && rj.keys.length, 2);
  // merge joins and group aggregates read sorted inputs: Sort nodes below them
  s.exec('set enable_hashjoin = off'); s.exec('set enable_nestloop = off'); s.exec('set enable_hashagg = off');
  const mj = plan('select * from patron p join booking b on p.patron_id = b.patron_id');
  ok('merge join sorts both inputs', mj.op === 'MergeJoin' && mj.children.every((c) => c.op === 'Sort'), ops(mj));
  ok('EXPLAIN shows the sort keys', /Merge Join[\s\S]*Sort Key: b\.patron_id[\s\S]*Sort Key: p\.patron_id/.test(s.exec('explain select * from patron p join booking b on p.patron_id = b.patron_id').pop().rows.map((r) => r[0]).join('\n')));
  eq('merge join over Sort nodes: same count', rowsOf(s, 'select count(*) from patron p join booking b on p.patron_id = b.patron_id'), rowsOf(s, 'select count(*) from booking'));
  const ga = (function find(n) { return n.op === 'Aggregate' ? n : (n.children || []).map(find).find(Boolean); })(plan('select city, count(*) from patron group by city'));
  ok('group aggregate sorts its input', ga && ga.alg === 'sorted' && ga.children[0].op === 'Sort');
  s.exec('reset all');
  // an index holding every column the query reads answers it alone
  s.exec('create table big (a int, b int, c text)');
  s.exec("insert into big select g, g % 100, 'x' || g from generate_series(1, 20000) g");
  s.exec('create index big_ab on big (a, b)');
  s.exec('analyze big');
  eq('index-only scan when the index covers the query', plan('select b from big where a = 5').op, 'IndexOnlyScan');
  eq('index scan when it does not', plan('select c from big where a = 5').op, 'IndexScan');
  eq('index-only scan rows', rowsOf(s, 'select a, b from big where a between 10 and 12'), ['[10,10]', '[11,11]', '[12,12]']);
  // CREATE INDEX builds the B+ tree bottom up: a valid tree, every row in it, uniqueness still checked
  s.exec('create index booking_pp on booking (patron_id, perf_id)');
  const ix = db.catalog.tables(['index']).find((x) => x.name === 'booking_pp');
  eq('bulk-built index holds every row', bplusCheck('bulk-built index', db.indexAm(ix).describe(500000)).length, +rowsOf(s, 'select count(*) from booking')[0].replace(/\D/g, ''));
  s.exec('set enable_seqscan = off');
  eq('bulk-built index answers', rowsOf(s, 'select perf_id from booking where patron_id = 42 order by 1'), rowsOf(fresh().s, 'select perf_id from booking where patron_id = 42 order by 1'));
  try { s.exec('create unique index booking_u on booking (patron_id)'); ok('unique bulk build refused duplicates', false); } catch (e) { eq('unique bulk build refuses duplicates', [e.code, /could not create unique index/.test(e.message)], ['23505', true]); }
  s.exec('create table u (x int)'); s.exec('insert into u select generate_series(1, 500)'); s.exec('create unique index u_x on u (x)');
  try { s.exec('insert into u values (250)'); ok('unique bulk-built index enforced', false); } catch (e) { eq('unique bulk-built index enforced', [e.code, /u_x/.test(e.message)], ['23505', true]); }
}

{
  // BitmapOr, the block nested-loop cost, sort and hash spills at run time, the R-tree cost, foreign-key join estimates
  const { db, s } = fresh();
  const plan = (sql) => { let n = s.exec('explain ' + sql).pop().plan; while (n.op === 'Project' || n.op === 'Aggregate') n = n.children[0]; return n; };
  const find = (n, op) => (n.op === op ? n : (n.children || []).map((c) => find(c, op)).find(Boolean));
  s.exec('create table bo (id int, a int, b int, c text)');
  s.exec("insert into bo select g, g % 9000, g % 7777, 'x' || g from generate_series(1, 20000) g");
  s.exec('create index bo_a on bo (a)'); s.exec('create index bo_b on bo (b)'); s.exec('analyze bo');
  const q = 'select id from bo where a = 5 or b = 7 or a = 900';
  const seq = rowsOf(s, q);
  s.exec('set enable_seqscan = off');
  const bp = plan(q);
  ok('an OR of indexed conditions is a BitmapOr', bp.op === 'BitmapScan' && bp.bitmapOr && bp.indexes.length === 3, bp.op);
  eq('BitmapOr gives the sequential scan\'s rows', rowsOf(s, q), seq);
  ok('EXPLAIN shows BitmapOr', /Bitmap Heap Scan on bo[\s\S]*BitmapOr[\s\S]*Bitmap Index Scan on bo_a[\s\S]*Bitmap Index Scan on bo_b/.test(s.exec('explain ' + q).pop().rows.map((r) => r[0]).join('\n')));
  ok('an OR with an unindexed arm is no BitmapOr', !(plan("select id from bo where a = 5 or c = 'x'").bitmapOr));
  s.exec('reset all');
  // block nested loop: b_r + ceil(b_r / (M - 2)) * b_s transfers and 2 * ceil(b_r / (M - 2)) seeks
  s.exec("set force_join = 'BlockNestLoopJoin'"); s.exec('set work_mem_pages = 4');
  const bnl = find(plan('select * from patron p join booking b on p.patron_id = b.patron_id'), 'BlockNestLoopJoin');
  const P = db.planner || null; void P;
  const [o, i2] = bnl.children;
  const k = Math.ceil(bnl.outerBlocks / 2);
  const expect = o.cost + k * bnl.innerBlocks * K.COST.transfer + (2 * k - 1) * K.COST.seek + o.rows * i2.rows * K.COST.cpuOp;
  ok('the disk model: tS = 6 ms, tT = 0.15 ms', K.COST.seek === 6 && Math.abs(K.COST.transfer - 0.15) < 1e-12, [K.COST.seek, K.COST.transfer]);
  ok('block nested-loop cost counts outer blocks and two seeks per block', Math.abs(bnl.cost - expect) < 1e-6, { cost: bnl.cost, expect });
  s.exec('reset all');
  // a sort or hash join larger than work memory spills: its temporary-file I/O is counted when it runs
  s.exec('set work_mem_pages = 4');
  const sx = s.exec('explain analyze select * from booking order by rating, booking_id').pop();
  const st = find(sx.plan, 'Sort');
  ok('external sort counts its run I/O', st.sortInfo.spill && st.sortInfo.spill.pagesWritten > 0 && sx.plan.io.writes >= st.sortInfo.spill.pagesWritten, st.sortInfo);
  ok('EXPLAIN ANALYZE shows the external merge', /Sort Method: external merge/.test(sx.rows.map((r) => r[0]).join('\n')));
  s.exec('set enable_mergejoin = off'); s.exec('set enable_nestloop = off');
  const hx = s.exec('explain analyze select * from booking b join patron p on p.patron_id = b.patron_id').pop();
  const hj = find(hx.plan, 'HashJoin');
  ok('partitioned hash join counts its partition I/O', hj.hashInfo.spill && hj.hashInfo.spill.pagesRead > 0 && hx.plan.io.reads >= hj.hashInfo.spill.pagesRead, hj.hashInfo);
  s.exec('reset all');
  const qx = s.exec('explain analyze select * from booking order by rating, booking_id').pop();
  ok('a sort that fits in memory writes nothing', !find(qx.plan, 'Sort').sortInfo.spill && qx.plan.io.writes === 0);
  // the R-tree's cost: the nodes whose rectangles meet the window, level by level
  s.exec('create table pts (id int, x float8, y float8)');
  s.exec('insert into pts select g, (g * 37) % 1000, (g * 91) % 1000 from generate_series(1, 20000) g');
  s.exec('create index pts_xy on pts using rtree (x, y)'); s.exec('analyze pts');
  const rq = 'select id from pts where x between 10 and 11 and y between 100 and 103';
  const rp = plan(rq);
  ok('a selective window uses the R-tree', rp.op === 'IndexScan' && rp.index.method === 'rtree' && Number.isFinite(rp.cost), rp.op);
  const wide = plan('select id from pts where x between 0 and 900 and y between 0 and 900');
  ok('a wide window scans the table', wide.op === 'SeqScan', wide.op);
  s.exec('set enable_indexscan = off');
  const rseq = rowsOf(s, rq);
  s.exec('reset all');
  eq('R-tree scan gives the sequential scan\'s rows', rowsOf(s, rq), rseq);
  // a join on a whole foreign key and the key it references keeps the referencing side's rows
  s.exec('analyze');
  const NB = +rowsOf(s, 'select count(*) from booking')[0].replace(/\D/g, '');
  eq('FK join estimate is the referencing table\'s rows', Math.round(find(plan('select * from booking b join patron p on p.patron_id = b.patron_id'), 'HashJoin').rows), NB);
  eq('multi-column FK join estimate', Math.round(find(plan('select * from performance p join stage s using (venue_code, stage_no)'), 'HashJoin').rows), +rowsOf(s, 'select count(*) from performance')[0].replace(/\D/g, ''));
  const fj = find(plan("select * from booking b join patron p on p.patron_id = b.patron_id where p.city = 'Vantmoor'"), 'HashJoin');
  const ps = find(plan("select * from patron p where p.city = 'Vantmoor'"), 'SeqScan');
  ok('a filter on the referenced side scales the FK estimate', Math.abs(fj.rows - NB * ps.rows / +rowsOf(s, 'select count(*) from patron')[0].replace(/\D/g, '')) < 1, { rows: fj.rows });
  // a smallint column compared with an integer constant uses its index and its statistics
  s.exec('create table ti (a smallint, b int)'); s.exec('insert into ti select g % 5, g from generate_series(1, 2000) g');
  s.exec('create index ti_a on ti (a)'); s.exec('analyze ti'); s.exec('set enable_seqscan = off');
  const tp = plan('select * from ti where a = 3');
  ok('smallint = integer uses the index', (tp.op === 'BitmapScan' || tp.op === 'IndexScan') && Math.round(tp.rows) === 400, { op: tp.op, rows: tp.rows });
  ok('EXPLAIN shows the uncast column', /Index Cond: \(a = 3\)/.test(s.exec('explain select * from ti where a = 3').pop().rows.map((r) => r[0]).join('\n')));
  const tr = plan('select * from ti where a < 2 or a in (3, 4)');
  ok('smallint ranges and IN lists use the index', tr.op === 'BitmapScan', tr.op);
  eq('smallint against a bigint constant', rowsOf(s, 'select count(*) from ti where a < 3000000000'), rowsOf(s, 'select count(*) from ti'));
  ok('a numeric constant still casts the column', plan('select * from ti where a = 3.0').op === 'SeqScan');
  s.exec('reset all');
}

{ // an R-tree over wide numeric keys: entries are sized by the key's type, and a node that would not fit splits
  const db = new K.Database(); const s = db.session();
  s.exec("create table rn (id int, fee numeric(8,2), big numeric, x float8); insert into rn select g, (g * 37 % 9000) + 0.25, g * 1234567890123.456789, g / 7.0 from generate_series(1, 3000) g");
  const count = (sql) => Number(s.query(sql).rows[0][0]);
  let err = null;
  try { s.exec('create index rn_fee on rn using rtree (fee)'); s.exec('create index rn_big on rn using rtree (big)'); s.exec('create index rn_pt on rn using rtree (fee, x)'); } catch (e) { err = e.message; }
  ok('rtree on numeric(8,2) and unconstrained numeric builds', err === null, { err });
  const want = [count('select count(*) from rn where fee between 100 and 200'), count('select count(*) from rn where big between 1e15 and 2e15'), count('select count(*) from rn where fee between 100 and 200 and x between 0 and 100')];
  s.exec('set enable_seqscan = off');
  const got = [count('select count(*) from rn where fee between 100 and 200'), count('select count(*) from rn where big between 1e15 and 2e15'), count('select count(*) from rn where fee between 100 and 200 and x between 0 and 100')];
  ok('rtree on numerics finds the same rows', JSON.stringify(got) === JSON.stringify(want), { got, want });
  s.exec("insert into rn select g, 999999.99, 9.99999999999999999999e30, g from generate_series(1, 500) g");
  ok('rtree keeps splitting wide entries', count('select count(*) from rn where fee = 999999.99') === 500);
}

console.log(pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
