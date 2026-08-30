// The cluster simulator: network determinism, partitioning, replication, distributed queries, distributed
// transactions, Raft and Paxos, MapReduce and the architecture models.
//   node tests/cluster.mjs [section ...]
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { load } from './load.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const K = load();
const C = K.Cluster;
C.theatreSql = fs.readFileSync(path.join(root, 'src/data/theatre.sql'), 'utf8');
const only = process.argv.slice(2);
let pass = 0, fail = 0;
const show = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? String(x) : x));
const ok = (cond, what) => { if (cond) pass++; else { fail++; console.log('FAIL ' + what); } };
const eq = (a, b, what) => { if (show(a) === show(b)) pass++; else { fail++; console.log('FAIL ' + what + '\n  expected ' + show(b).slice(0, 600) + '\n  got      ' + show(a).slice(0, 600)); } };
function section(name, fn) {
  if (only.length && !only.includes(name)) return;
  const t = Date.now(), p0 = pass, f0 = fail;
  try { fn(); } catch (e) { fail++; console.log('FAIL ' + name + ' threw: ' + (e && e.stack || e)); }
  console.log(name.padEnd(12) + ' ' + String(pass - p0).padStart(5) + ' passed ' + String(fail - f0).padStart(3) + ' failed  ' + (Date.now() - t) + ' ms');
}

section('net', () => {
  // a ping-pong pair over a lossy, duplicating, jittery network
  class Pinger extends C.Actor {
    constructor(id, peer) { super(id); this.peer = peer; this.state = { got: 0, sent: 0 }; }
    onMessage(m) { this.state.got++; if (m.type === 'ping') this.send(m.from, 'pong', { n: m.body.n }); }
    onTimer(name) { if (name === 'tick' && this.state.sent < 20) { this.send(this.peer, 'ping', { n: ++this.state.sent }); this.setTimer('tick', 5); } }
  }
  const build = (seed) => {
    const net = new C.Net({ seed, latency: 4, jitter: 6, loss: 0.2, dup: 0.1 });
    net.add('a', new Pinger('a', 'b')); net.add('b', new Pinger('b', 'a'));
    net.setTimer('a', 'tick', 1);
    net.at(30, 'crash', 'b').at(45, 'restart', 'b').at(60, 'partition', [['a'], ['b']]).at(80, 'heal');
    net.run();
    return net;
  };
  const a = build(7), b = build(7), c = build(8);
  eq(a.trace.map((e) => [e.kind, e.t, e.msg || e.node]), b.trace.map((e) => [e.kind, e.t, e.msg || e.node]), 'same seed, same trace');
  ok(show(a.trace) !== show(c.trace), 'another seed, another trace');
  const kinds = new Set(a.trace.map((e) => e.kind));
  for (const k of ['send', 'deliver', 'drop', 'timer', 'crash', 'restart', 'partition', 'heal']) ok(kinds.has(k), 'trace has ' + k);
  ok(a.trace.some((e) => e.kind === 'drop' && e.reason === 'lost') && a.trace.some((e) => e.kind === 'drop' && e.reason === 'receiver down'), 'drop reasons');
  ok(a.trace.every((e, i) => i === 0 || e.t >= a.trace[i - 1].t), 'the clock never goes back');
  ok(a.trace.filter((e) => e.kind === 'deliver').every((e) => !(e.t >= 60 && e.t < 80)), 'nothing crosses the partition');
  ok(new Set(a.trace.map((e) => e.id)).size === a.trace.length, 'trace ids are unique');
  // snapshot, run on, restore, run on again: the same future
  const net = new C.Net({ seed: 3, latency: 2, jitter: 5, loss: 0.1, undo: 50 });
  net.add('a', new Pinger('a', 'b')); net.add('b', new Pinger('b', 'a'));
  net.setTimer('a', 'tick', 1);
  net.run(20);
  const snap = net.snapshot();
  net.run(60);
  const t1 = show(net.trace), st1 = show([net.node('a').state, net.node('b').state]);
  net.restore(snap);
  ok(net.clock === 20 && net.trace.length === snap.traceLen, 'restore goes back');
  net.run(60);
  eq(show(net.trace), t1, 'after restore the same events follow');
  eq(show([net.node('a').state, net.node('b').state]), st1, 'and the same node state');
  const len = net.trace.length;
  net.step(); net.step();
  ok(net.stepBack() && net.stepBack() && net.trace.length === len, 'stepBack undoes steps');
  // a timer of a crashed node never fires; fifo links keep order
  const n2 = new C.Net({ seed: 1, latency: 5, jitter: 20, fifo: true });
  const got = [];
  n2.add('x'); const y = n2.add('y'); y.onMessage = (m) => got.push(m.body);
  for (let i = 0; i < 10; i++) n2.send('x', 'y', 'n', i);
  n2.setTimer('x', 'never', 50); n2.at(10, 'crash', 'x');
  n2.run();
  eq(got, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 'fifo link keeps order under jitter');
  ok(!n2.trace.some((e) => e.kind === 'timer'), 'timer died with its node');
  ok(n2.describe().name === 'Network', 'describe');
});

section('partition', () => {
  const P = C.Partition, u = C.theatre();
  const booking = u.tables.booking, patron = u.tables.patron;
  const once = (r, n) => { const seen = new Array(n).fill(0); r.parts.forEach((p) => p.forEach((i) => seen[i]++)); return seen.every((c) => c === 1) && r.assign.length === n; };
  const rr = P.roundRobin(booking.rows, 4), h = P.hash(booking.rows, 4, { key: 1 });
  ok(once(rr, booking.rows.length) && once(h, booking.rows.length), 'round-robin and hash place every row exactly once');
  ok(rr.skew.max - rr.skew.min <= 1, 'round-robin is even');
  const owner = new Map(); let consistent = true;
  booking.rows.forEach((r, i) => { const o = owner.get(r[1]); if (o !== undefined && o !== h.assign[i]) consistent = false; owner.set(r[1], h.assign[i]); });
  ok(consistent, 'hash: one key, one node');
  ok(h.trace.length === booking.rows.length && h.trace[0].why.includes('mod 4'), 'hash trace row by row');
  eq(P.canon('65000.00', 'numeric(8,2)'), P.canon('65000', 'integer'), 'numeric keys hash by value');
  // range: partitions hold consecutive key ranges
  const ci = patron.cols.findIndex((c) => c.name === 'points'), ty = patron.cols[ci].type;
  const vals = patron.rows.map((r) => r[ci]);
  const bounds = P.equiDepth(vals, 4, { type: ty });
  const rg = P.range(patron.rows, bounds, { key: ci, type: ty });
  ok(once(rg, patron.rows.length), 'range places every row exactly once');
  let inOrder = true;
  for (let p = 0; p + 1 < rg.n; p++) for (const i of rg.parts[p]) for (const j of rg.parts[p + 1]) if (P.cmp(patron.rows[i][ci], patron.rows[j][ci], ty) > 0) inOrder = false;
  ok(inOrder, 'range partitions are ordered');
  // unique keys: equi-depth boundaries balance; a skewed column with equal-width boundaries does not
  const ids = P.range(patron.rows, P.equiDepth(patron.rows.map((r) => r[0]), 4, {}), { key: 0 });
  ok(ids.skew.ratio <= 1.05, 'equi-depth on unique keys is balanced (' + ids.skew.ratio + ')');
  const rng = new C.Rng(4);
  const skewed = K.range(1000).map((i) => [String(Math.floor(Math.pow(rng.next(), 3) * 1000))]);
  const w = P.range(skewed, P.equiWidth(skewed.map((r) => r[0]), 4), { key: 0, type: 'integer' });
  const d = P.range(skewed, P.equiDepth(skewed.map((r) => r[0]), 4, { type: 'integer' }), { key: 0, type: 'integer' });
  const hi = P.range(skewed, P.equiDepth(skewed.map((r) => r[0]), 4, { type: 'integer', method: 'histogram', buckets: 50 }), { key: 0, type: 'integer' });
  ok(w.skew.ratio > 2 && d.skew.ratio < 1.15 && hi.skew.ratio < 1.5 && hi.skew.ratio < w.skew.ratio, 'equal width ' + w.skew.ratio + ' vs histogram ' + hi.skew.ratio + ' vs exact ' + d.skew.ratio);
  const hist = P.histogram(skewed.map((r) => r[0]), 10, 'integer');
  eq(hist.reduce((n, b) => n + b.count, 0), 1000, 'histogram counts every value');
  // attribute-value skew: booking.seats has six values, so four hash partitions cannot be even; virtual nodes help some
  const cmpY = P.compare(booking, 'seats', 4);
  const byName = Object.fromEntries(cmpY.schemes.map((x) => [x.name, x]));
  ok(byName.hash.skew.ratio > 1.3 && cmpY.valueSkew.distinct === 6, 'attribute-value skew on booking.seats');
  ok(byName['virtual nodes, balanced mapping'].skew.ratio <= byName.hash.skew.ratio, 'balanced virtual nodes no worse than hash');
  const many = K.range(400).map((i) => [String(i < 120 ? 7 : i)]);
  const vh = P.hash(many, 4, { key: 0 }), vv = P.virtualNodes(many, 4, 32, { key: 0, map: 'balanced' });
  ok(vv.skew.ratio <= vh.skew.ratio && once(vv, 400), 'virtual nodes: every row once, skew ' + vh.skew.ratio + ' -> ' + vv.skew.ratio);
  // consistent hashing: a joining node takes keys only from others, a leaving node gives only its own
  const ring = new P.Ring({ vnodes: 32 });
  ['a', 'b', 'c', 'd'].forEach((n) => ring.addNode(n));
  const keys = K.range(2000).map((i) => 'k' + i);
  const before = keys.map((k) => ring.owner(k));
  ok(Math.abs(Object.values(ring.shares()).reduce((x, y) => x + y, 0) - 1) < 1e-3, 'ring shares add up to 1');
  ring.addNode('e');
  const after = keys.map((k) => ring.owner(k));
  const moved = keys.filter((k, i) => before[i] !== after[i]);
  ok(moved.every((k) => ring.owner(k) === 'e'), 'joining node: every moved key moved to it');
  ok(moved.length > 200 && moved.length < 700, 'about a fifth of the keys move (' + moved.length + ')');
  ring.removeNode('b');
  const after2 = keys.map((k) => ring.owner(k));
  ok(keys.every((k, i) => after[i] === after2[i] || after[i] === 'b'), 'leaving node: only its keys move');
  const pref = ring.preference('k1', 3);
  ok(pref.length === 3 && new Set(pref).size === 3 && pref[0] === ring.owner('k1'), 'preference list');
  ok(ring.view().points.length === 4 * 32, 'ring view');
  // sharded tables on real nodes: rows move one by one and stay exactly once
  const res = {};
  for (const scheme of ['consistent', 'hash', 'range', 'round-robin']) {
    const sh = new P.Shards({ scheme, nodes: ['n1', 'n2', 'n3'], seed: 1 });
    sh.load(booking, { key: 'patron_id' });
    ok(sh.check().ok, scheme + ': loaded exactly once');
    const add = sh.addNode('n4');
    ok(sh.check().ok, scheme + ': exactly once after a node joins');
    const sent = sh.net.trace.filter((e) => e.kind === 'send' && e.type === 'move-row').length;
    ok(sent === add.moved && add.moves.every((m) => m.msg), scheme + ': each moved row is a message');
    const rem = sh.removeNode('n2');
    ok(sh.check().ok, scheme + ': exactly once after a node leaves');
    if (scheme === 'consistent' || scheme === 'range') ok(rem.moves.every((m) => m.from === 'n2'), scheme + ': only the leaving node gives rows');
    else ok(rem.moves.some((m) => m.from !== 'n2'), scheme + ': rows move between the remaining nodes too');
    res[scheme] = { add, rem, sh };
  }
  ok(res.consistent.add.moves.every((m) => m.to === 'n4'), 'consistent hashing moves rows only to the new node');
  ok(res.consistent.add.moved < res.hash.add.moved / 2, 'consistent hashing moves far fewer rows than hash mod n (' + res.consistent.add.moved + ' vs ' + res.hash.add.moved + ')');
  ok(res.range.add.moves.every((m) => m.to === 'n4'), 'range: the new node splits one range');
  const rb = res.range.sh.rebalance();
  ok(res.range.sh.check().ok && rb.skew.ratio < 1.2, 'range rebalance evens out (' + rb.skew.ratio + ')');
  ok(P.describe().name === 'Partitioning', 'describe');
});

section('replication', () => {
  const R = C.Replication;
  const kinds = (vs) => vs.reduce((o, v) => { o[v.kind] = (o[v.kind] || 0) + 1; return o; }, {});
  // a random script of writes and reads over a few keys
  const script = (rng, n, keys, tag) => K.range(n).map((i) => (rng.chance(0.4) ? { op: 'write', key: rng.pick(keys), value: tag + i } : { op: 'read', key: rng.pick(keys) }));
  // synchronous primary copy: once a write is acknowledged every replica has it, so no read anywhere is stale
  let syncBad = 0, syncOps = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const rng = new C.Rng(seed);
    const sys = R.primaryCopy({ seed, nodes: ['P', 'R1', 'R2'], mode: 'sync', readFrom: 'any', net: { latency: 5, jitter: 15 }, lag: { R2: 30 } });
    sys.client('c1', script(rng, 25, ['x', 'y'], 'a'), { timeout: 1000 }); sys.client('c2', script(rng, 25, ['x', 'y'], 'b'), { timeout: 1000 });
    sys.run();
    syncBad += sys.violations().length; syncOps += sys.history().filter((h) => h.ok).length;
  }
  ok(syncBad === 0 && syncOps === 400, 'sync replication: no stale, RYW or monotonic violations (' + syncBad + ', ' + syncOps + ' ops)');
  // asynchronous: lag shows, session guarantees fail with random routing, tokens fix both, sticky routing fixes monotonic reads
  const ss = R.sessions({ seed: 2 });
  const pk = kinds(ss.plain.violations);
  ok(pk.ryw > 0 && pk.monotonic > 0, 'async + any replica: read-your-writes and monotonic reads violated ' + show(pk));
  ok(Math.max(...ss.plain.lagSeries.map((x) => x.lag.R2)) > 0 && ss.plain.lagSeries.some((x) => x.lag.R2 > x.lag.R1), 'replication lag visible, larger on the slow replica');
  eq(ss.tokens.violations, [], 'session tokens: no violations');
  ok(ss.tokens.trace.some((e) => e.kind === 'note' && e.what === 'read waits'), 'a replica held a read until it caught up');
  ok(!ss.sticky.violations.some((v) => v.kind === 'monotonic'), 'sticky routing: monotonic reads hold');
  ok(ss.plain.history.length === 36 && ss.tokens.history.every((h) => h.ok), 'every operation finished');
  let mono = 0;
  for (let seed = 1; seed <= 6; seed++) mono += R.sessions({ seed, rounds: 8 }).sticky.violations.filter((v) => v.kind === 'monotonic').length;
  ok(mono === 0, 'sticky routing over seeds');
  const semi = R.primaryCopy({ seed: 4, mode: 'semi', nodes: ['P', 'R1', 'R2'], lag: { R2: 50 } });
  semi.client('c', [{ op: 'write', key: 'k', value: 1 }]); semi.run(50);
  ok(semi.history()[0].ok && semi.lag().R2 === 1 && semi.lag().R1 === 0, 'semi-sync: acknowledged after one replica, the other still behind');
  // async with message loss: the primary resends until every replica has caught up
  const lossy = R.primaryCopy({ seed: 9, mode: 'async', nodes: ['P', 'R1', 'R2'], net: { loss: 0.3 } });
  lossy.client('c', K.range(10).map((i) => ({ op: 'write', key: 'k' + (i % 3), value: i })), { timeout: 2000 }); lossy.run(5000);
  eq(lossy.lag(), { R1: 0, R2: 0 }, 'lost replication messages are resent');
  eq(lossy.replica('R2').store, lossy.replica('P').store, 'replica equals primary');
  // version vectors
  const V = R.VV;
  eq([V.compare({ A: 1 }, { A: 2 }), V.compare({ A: 2, B: 1 }, { A: 2 }), V.compare({ A: 1, B: 0 }, { A: 1 }), V.compare({ A: 2 }, { A: 1, B: 1 })], ['before', 'after', 'equal', 'concurrent'], 'version vector order');
  eq(V.merge({ A: 2, B: 1 }, { B: 3, C: 1 }), { A: 2, B: 3, C: 1 }, 'version vector merge');
  // multi-master with version vectors: concurrent writes become siblings everywhere, a merge resolves them
  const mm = R.multiMaster({ seed: 3, resolve: 'vv' });
  mm.client('c1', [{ op: 'write', key: 'x', value: 'base', to: 'A' }, { op: 'write', key: 'x', value: 'fromA', to: 'A', at: 60 }, { op: 'read', key: 'x', to: 'A', at: 200 }, { op: 'merge', key: 'x', to: 'A', at: 220 }, { op: 'read', key: 'x', to: 'B', at: 300 }]);
  mm.client('c2', [{ op: 'write', key: 'x', value: 'fromC', to: 'C', at: 61 }]);
  mm.net.at(50, 'partition', [['A', 'B', 'c1'], ['C', 'c2']]).at(120, 'heal').at(130, 'call', () => mm.sync());
  mm.run(400);
  const mh = mm.net.node('c1').state.hist;
  eq(mh[2].value, ['fromA', 'fromC'], 'concurrent writes kept as siblings');
  ok(mm.conflicts().length >= 3 && mm.conflicts().every((c) => c.versions.length === 2), 'conflict detected at every replica');
  eq(mh[4].value, 'fromA+fromC', 'after the merge one value');
  ok(mm.converged() && Object.values(mm.values('x')).every((v) => v.length === 1), 'replicas converge on the merged version');
  const mm2 = R.multiMaster({ seed: 3, resolve: 'vv' });
  mm2.client('c1', [{ op: 'write', key: 'x', value: 1, to: 'A' }, { op: 'write', key: 'x', value: 2, to: 'B', at: 50 }, { op: 'write', key: 'x', value: 3, to: 'C', at: 100 }]);
  mm2.run(300);
  ok(mm2.conflicts().length === 0 && mm2.converged() && mm2.values('x').A[0] === 3, 'causally ordered writes: no conflict');
  // last-writer-wins: concurrent writes on all nodes under loss, with periodic anti-entropy, converge to one value per key
  for (let seed = 1; seed <= 5; seed++) {
    const rng = new C.Rng(seed * 31);
    const lww = R.multiMaster({ seed, resolve: 'lww', antiEntropy: 80, net: { latency: 5, jitter: 20, loss: 0.2 } });
    for (const [c, n] of [['c1', 'A'], ['c2', 'B'], ['c3', 'C']]) lww.client(c, K.range(15).map((i) => ({ op: 'write', key: rng.pick(['x', 'y', 'z']), value: c + ':' + i })), { home: n, timeout: 1000 });
    lww.run(1500);
    ok(lww.converged() && ['x', 'y', 'z'].every((k) => Object.values(lww.values(k)).every((v) => v.length === 1)), 'LWW converges (seed ' + seed + ')');
    if (seed === 1) ok(lww.conflicts().some((c) => c.lost.length), 'LWW loses concurrent writes, and says so');
  }
  // quorums: with R + W > N a read never misses a completed write, over random seeds with loss and jitter
  const qrun = (seed, o) => {
    const rng = new C.Rng(seed * 7);
    const q = R.quorum(Object.assign({ seed, nodes: ['A', 'B', 'C', 'D', 'E'], net: { latency: 5, jitter: 25, loss: 0.05 } }, o));
    for (const c of ['c1', 'c2', 'c3']) q.client(c, script(rng, 20, ['x', 'y'], c), { timeout: 150 });
    q.run();
    return q;
  };
  let strictBad = 0, strictReads = 0, looseBad = 0;
  for (let seed = 1; seed <= 12; seed++) {
    for (const o of [{ R: 3, W: 3 }, { R: 2, W: 4 }, { R: 3, W: 3, fanout: 'quorum' }]) { const q = qrun(seed, o); strictBad += q.violations().length; strictReads += q.history().filter((h) => h.op === 'read' && h.ok).length; }
    looseBad += qrun(seed, { R: 1, W: 1, fanout: 'quorum', readRepair: false }).violations().length;
  }
  ok(strictBad === 0 && strictReads > 300, 'R + W > N: no stale read in ' + strictReads + ' reads');
  ok(looseBad > 0, 'R + W <= N: stale reads happen (' + looseBad + ')');
  ok(R.quorum({ nodes: ['A', 'B', 'C'], R: 1, W: 1 }).describe().strict === false, 'describe says when quorums do not overlap');
  // read repair: a replica that missed a write gets it from the next read
  const rr = (repair) => {
    const q = R.quorum({ seed: 5, nodes: ['A', 'B', 'C'], R: 2, W: 2, readRepair: repair, net: { latency: 5 } });
    q.client('c', [{ op: 'write', key: 'k', value: 'new', at: 10 }, { op: 'read', key: 'k', at: 100 }]);
    q.net.at(0, 'block', 'c', 'C').at(50, 'unblock', 'c', 'C');
    q.run();
    return q;
  };
  const r1 = rr(true), r0 = rr(false);
  ok(r1.history()[1].value === 'new' && r1.replica('C').store.k && r1.replica('C').store.k.value === 'new', 'read repair brings the stale replica up to date');
  ok(r1.net.trace.some((e) => e.kind === 'note' && e.what === 'repaired'), 'repair traced');
  ok(!r0.replica('C').store.k, 'without read repair it stays stale');
  // CAP
  const cp = R.cap('CP'), ap = R.cap('AP'), apv = R.cap('AP', { resolve: 'vv' });
  eq(cp.outcome.accepted, ['c1 left'], 'CP: the majority side accepts its write');
  ok(cp.outcome.refused.length === 2 && cp.outcome.refused.every((x) => x.startsWith('c2')), 'CP: the minority side refuses writes and reads');
  ok(!cp.outcome.diverged && cp.outcome.convergedAfter && cp.outcome.finalValue === 'left' && cp.violations.length === 0, 'CP: never diverges');
  eq(ap.outcome.accepted, ['c1 left', 'c2 right'], 'AP: both sides accept writes');
  ok(ap.outcome.refused.length === 0 && ap.outcome.diverged, 'AP: the sides diverge');
  ok(ap.outcome.convergedAfter && ap.outcome.conflicts.length > 0, 'AP + LWW: reconciled after healing');
  ok(apv.outcome.convergedAfter && show(apv.outcome.finalValue) === show(['left', 'right']), 'AP + version vectors: both writes kept as siblings');
  ok(cp.trace.some((e) => e.kind === 'drop' && e.reason === 'partition') && ap.trace.some((e) => e.kind === 'heal'), 'the trace shows the partition');
  // determinism
  const d1 = R.sessions({ seed: 11, rounds: 5 }), d2 = R.sessions({ seed: 11, rounds: 5 }), d3 = R.sessions({ seed: 12, rounds: 5 });
  ok(show(d1.plain.trace) === show(d2.plain.trace) && show(d1.plain.history) === show(d2.plain.history), 'same seed, same run');
  ok(show(d1.plain.trace) !== show(d3.plain.trace), 'another seed, another run');
  const snapSys = R.quorum({ seed: 2 });
  snapSys.client('c', [{ op: 'write', key: 'k', value: 1 }, { op: 'read', key: 'k' }, { op: 'write', key: 'k', value: 2 }]);
  snapSys.run(15); const snap = snapSys.net.snapshot(); snapSys.run(); const h1 = show(snapSys.history());
  snapSys.net.restore(snap); snapSys.run();
  eq(show(snapSys.history()), h1, 'snapshot and restore replay the same history');
  ok(['describe', 'cap', 'sessions', 'check'].every((f) => typeof R[f] === 'function') && R.describe().designs.length === 3 && ss.plain.system.describe().text && mm.describe().name && cp.system.describe().name, 'describe');
});

section('dquery', () => {
  const Q = [
    'select * from venue',
    'select person_id, fee from artist where fee > 1500 order by fee desc, person_id',
    'select patron_id, name, city from patron where points >= 300 order by patron_id',
    'select company_id, count(*), avg(fee), min(fee), max(fee), sum(fee) from artist group by company_id order by company_id',
    'select count(*) from booking',
    'select count(*), count(rating), count(distinct perf_id) from booking',
    'select perf_id, count(*) as n from booking group by perf_id having count(*) > 8 order by n desc, perf_id',
    'select a.person_id, c.name from artist a join company c on a.company_id = c.company_id order by a.person_id',
    'select a.person_id, k.prod_id, k.role_name from artist a, casting k where a.person_id = k.person_id and k.lead order by 1, 2, 3',
    'select p.name, r.title, b.booking_id, b.rating from patron p join booking b on p.patron_id = b.patron_id join performance f on b.perf_id = f.perf_id join production r on f.prod_id = r.prod_id where f.venue_code = \'HAR\' order by p.name, r.title, b.booking_id',
    'select c.city, count(*) from company c join artist a on c.company_id = a.company_id group by c.city order by c.city',
    'select distinct genre from production order by genre',
    'select distinct venue_code from performance',
    'select title, runtime_min from production where runtime_min > 120 and genre in (\'opera\', \'drama\') order by title, runtime_min',
    'select genre, sum(runtime_min) from production group by genre',
    'select venue_code, stage_no, count(*) from performance group by venue_code, stage_no order by venue_code, stage_no',
    'select person_id from artist order by fee desc, person_id limit 5',
    'select name, points from patron order by points desc, name limit 10 offset 5',
    'select p.city, avg(p.points) from patron p group by p.city having avg(p.points) > 100 order by 1',
    'select r.genre, count(distinct b.patron_id) from production r join performance f on r.prod_id = f.prod_id join booking b on b.perf_id = f.perf_id group by r.genre order by r.genre',
    'select m.mentor_id, m.mentee_id, p1.family_name, p2.family_name from mentor m join person p1 on m.mentor_id = p1.person_id join person p2 on m.mentee_id = p2.person_id order by m.mentor_id, m.mentee_id',
    'select a.company_id, count(*) from mentor m join artist a on m.mentor_id = a.person_id group by a.company_id order by count(*) desc, a.company_id',
    'select f.perf_id, f.venue_code, f.stage_no, s.seats from performance f join stage s on f.venue_code = s.venue_code and f.stage_no = s.stage_no where s.seats > 400 order by 1',
    'select v.venue_code, v.city, count(*) from performance f join venue v on f.venue_code = v.venue_code group by v.venue_code, v.city order by 1, 2',
    'select upper(p.family_name) as n, p.person_id, a.fee * 1.1 as raised from artist a join person p on a.person_id = p.person_id where a.company_id = \'C07\' order by n, p.person_id',
    'select company_id, case when budget > 1000000 then \'big\' else \'small\' end as size from company order by company_id',
    'select count(*) from artist a, company c where a.fee > c.budget / 1000',
    'select a1.person_id, a2.person_id from artist a1, artist a2 where a1.company_id = a2.company_id and a1.fee > a2.fee and a1.company_id = \'C07\' order by 1, 2',
    'select rating, count(*) from booking where rating is not null group by rating order by rating',
    'select patron_id, count(*) from booking group by patron_id having count(*) >= 9 order by patron_id',
    'select prod_id, based_on from production where based_on is not null order by 1, 2',
    'select r.title, b.title from production r join production b on r.based_on = b.prod_id order by r.title, b.title',
    'select max(fee) - min(fee) from artist',
    'select city, max(budget) from company group by city having max(budget) > 500000 order by 2 desc, 1',
    'select p.patron_id, p.name from patron p where p.city = \'Vantmoor\' and p.points between 50 and 400 order by p.patron_id',
    'select f.venue_code, avg(r.runtime_min), count(*) from performance f join production r on f.prod_id = r.prod_id group by f.venue_code order by f.venue_code',
    'select extract(year from date \'2024-05-01\') + 0 as y, count(*) from company',
    'select company_id, bool_and(fee > 500), bool_or(fee > 2500) from artist group by company_id order by company_id',
    'select p1.family_name, p2.family_name from mentor m join person p1 on p1.person_id = m.mentor_id join person p2 on p2.person_id = m.mentee_id where p1.home_city <> p2.home_city order by 1, 2',
    'select prod_id, string_agg(role_name, \',\' order by role_name) from casting where lead group by prod_id order by prod_id',
    'select coalesce(rating, 0) as r, count(*) from booking group by coalesce(rating, 0) order by r',
    'select company_id, count(*) * 2 + 1, sum(fee) / count(*) from artist group by company_id order by company_id',
    'select name from patron where patron_id in (select patron_id from booking where perf_id = 150) order by name',
    'select company_id from company except select company_id from artist',
    'select c.company_id, count(a.person_id) from company c left join artist a on c.company_id = a.company_id group by c.company_id order by c.company_id',
    'select person_id, fee, rank() over (order by fee desc) from artist order by 3, 1',
    'select venue_code, stage_no, seats from stage where seats >= 300 order by seats desc, venue_code, stage_no',
    'select p.name, b.perf_id from patron p, booking b where p.patron_id = b.patron_id and b.rating = 5 order by p.name, b.perf_id',
    'select count(*) from patron p, booking b, performance f, venue v where p.patron_id = b.patron_id and b.perf_id = f.perf_id and f.venue_code = v.venue_code and v.city = p.city',
    'select r.genre, count(distinct r.prod_id), count(*) from production r join performance f on f.prod_id = r.prod_id group by r.genre order by r.genre',
  ];
  const bag = (rows) => rows.map((r) => JSON.stringify(r)).sort();
  const same = (db, q, r, what) => {
    const ref = db.reference(q);
    eq(r.cols.map((c) => c.name), ref.cols.map((c) => c.name), what + ' columns: ' + q);
    if (/\border by\b/i.test(q) && !/\bover\b/i.test(q)) eq(r.rows, ref.rows, what + ': ' + q);
    else eq(bag(r.rows), bag(ref.rows), what + ': ' + q);
  };
  const db = new C.DistDB({ nodes: 4, seed: 5 }).loadTheatre();
  const kinds = new Set(), joins = new Set(), aggs = new Set(), sorts = new Set();
  for (const q of Q) {
    const r = db.query(q);
    same(db, q, r, '4 nodes');
    kinds.add(r.plan.kind); if (r.plan.agg) aggs.add(r.plan.agg); if (r.plan.sort) sorts.add(r.plan.sort);
    for (const j of r.plan.joins || []) joins.add(j.strategy);
    const shipped = r.trace.filter((e) => e.kind === 'send' && e.type === 'rows').reduce((n, e) => n + e.bytes, 0);
    ok(shipped === r.stats.bytes, 'bytes counted match the messages sent: ' + q);
  }
  ok(Q.length >= 40, Q.length + ' queries');
  for (const k of ['distributed', 'ship']) ok(kinds.has(k), 'plan kind ' + k);
  for (const k of ['co-located', 'repartition', 'broadcast', 'local']) ok(joins.has(k), 'join strategy ' + k);
  for (const k of ['two-phase', 'repartition', 'local']) ok(aggs.has(k), 'aggregation ' + k);
  for (const k of ['range', 'top-k']) ok(sorts.has(k), 'sort ' + k);
  ok(db.coord.tables().every((t) => !t.startsWith('_q')) && db.ids.every((id) => db.node(id).tables().every((t) => !t.startsWith('_q'))), 'temporary fragments are dropped');
  // forced strategies give the same answers
  const sub = Q.filter((q) => / join |, \w+ \w+ where|group by|order by/.test(q) && !/ left join |\bover\b|\bexcept\b|\bin \(select/.test(q)).slice(0, 10);
  for (const o of [{ join: 'repartition' }, { join: 'broadcast' }, { join: 'fragment-replicate' }, { agg: 'repartition' }, { agg: 'two-phase' }, { sort: 'merge' }]) {
    for (const q of sub) same(db, q, db.query(q, o), JSON.stringify(o));
  }
  const fr = db.query('select count(*) from artist a, company c where a.fee > c.budget / 1000', { grid: true });
  ok(fr.plan.joins[0].strategy === 'fragment-replicate' && fr.steps.some((s) => s.exchange === 'grid'), 'non-equi join on a grid of nodes');
  same(db, 'select count(*) from artist a, company c where a.fee > c.budget / 1000', fr, 'grid');
  // other cluster sizes and placements
  const rr = new C.DistDB({ nodes: 3, seed: 2 }).loadTheatre(Object.fromEntries(C.theatre().names.map((n) => [n, { scheme: 'round-robin' }])));
  for (const q of Q.filter((x, i) => i % 3 === 0)) same(rr, q, rr.query(q), '3 nodes round-robin');
  const five = new C.DistDB({ nodes: 5, seed: 3 }).loadTheatre({ booking: { scheme: 'range', key: 'perf_id' }, patron: { scheme: 'hash', key: 'city' }, artist: { scheme: 'replicated' } });
  for (const q of Q.filter((x, i) => i % 3 === 1)) same(five, q, five.query(q), '5 nodes mixed');
  // co-partitioned join ships nothing for the join; a repartition does
  const co = db.query('select count(*) from patron p join booking b on p.patron_id = b.patron_id');
  ok(co.plan.joins[0].strategy === 'co-located' && co.steps.findIndex((s) => s.kind === 'exchange') > co.steps.findIndex((s) => s.kind === 'join'), 'co-located join without an exchange');
  const rp = db.query('select count(*) from patron p join booking b on p.patron_id = b.patron_id', { join: 'repartition' });
  const rp2 = db.query('select count(*) from booking b join performance f on b.perf_id = f.perf_id', { join: 'repartition' });
  ok(rp2.stats.bytes > co.stats.bytes && rp2.steps.some((s) => s.exchange === 'hash'), 'repartition ships rows');
  ok(rp.stats.bytes === co.stats.bytes, 'forcing repartition on co-partitioned inputs ships nothing extra');
  // the range sort ships each row once and the ranges come back in order
  const so = db.query('select perf_id, patron_id, booking_id, seats from booking order by perf_id, patron_id, booking_id');
  const ex = so.steps.find((s) => s.exchange === 'range');
  ok(ex && so.steps.find((s) => s.kind === 'sample').bounds.length === 3, 'range sort with three boundaries');
  same(db, 'select perf_id, patron_id, booking_id, seats from booking order by perf_id, patron_id, booking_id', so, 'range sort');
  // determinism: the same seed gives the same trace
  const t1 = new C.DistDB({ nodes: 3, seed: 9, jitter: 4 }).loadTheatre().query(Q[9]).trace.map((e) => [e.kind, e.t, e.from, e.to, e.bytes]);
  const t2 = new C.DistDB({ nodes: 3, seed: 9, jitter: 4 }).loadTheatre().query(Q[9]).trace.map((e) => [e.kind, e.t, e.from, e.to, e.bytes]);
  eq(t1, t2, 'distributed query trace is deterministic');
  // errors come back with their SQLSTATE
  let code = null; try { db.query('select nosuch from artist'); } catch (e) { code = e.code; }
  eq(code, '42703', 'undefined column reported by the coordinator');
  // semijoin reduction across two sites
  const sj = db.semijoin({ left: 'booking', right: 'performance', on: ['perf_id', 'perf_id'], rightWhere: "venue_code = 'FER'" });
  ok(sj.sameResult, 'semijoin gives the same join');
  eq(sj.best, 'semijoin reduction', 'semijoin ships the fewest bytes when the filter is selective');
  ok(sj.strategies[2].reduced.after < sj.strategies[2].reduced.before, 'semijoin reduces the shipped relation');
  ok(db.describe().placement.length === 11 && C.DQuery.describe().name, 'describe');
});

section('dtx', () => {
  // 2PC: every failure point, several seeds: all commit or all abort, and the data agrees with the outcome
  const expect = { none: 'committed', 'vote-no': 'aborted', 'participant-before-vote': 'aborted', 'participant-after-vote': 'committed', 'coordinator-before-prepare': 'aborted', 'coordinator-before-decision': 'aborted', 'coordinator-after-decision': 'committed', 'coordinator-partial-decision': 'committed', 'lost-prepare': 'aborted', 'lost-vote': 'aborted', 'lost-decision': 'committed', 'partition-during-vote': 'aborted' };
  for (const f of Object.keys(expect)) {
    let good = true, outcome = true;
    for (let seed = 1; seed <= 4; seed++) {
      const r = C.TwoPC.run({ failure: f, seed });
      if (!(r.atomic && r.complete && r.dataOk && r.total === 300 && !r.violations.length)) { good = false; console.log('  ' + f + ' seed ' + seed + ' ' + show(r.participants) + ' ' + show(r.balances)); }
      if (r.outcome !== expect[f]) outcome = false;
    }
    ok(good, '2PC atomic under ' + f);
    ok(outcome, '2PC outcome under ' + f + ' is ' + expect[f]);
  }
  { // random crashes of any node at any time, with message loss: still atomic
    let bad = 0; const seen = new Set();
    for (let seed = 1; seed <= 40; seed++) { const n = 3 + (seed % 2), r = C.TwoPC.run({ failure: 'random', seed, n }); seen.add(r.outcome); if (!(r.atomic && r.complete && r.dataOk && r.total === 100 * n)) { bad++; console.log('  random seed ' + seed + ' ' + show(r.participants)); } }
    ok(bad === 0, '2PC atomic over 40 random failure runs');
    ok(seen.has('committed') && seen.has('aborted'), 'random runs both commit and abort');
  }
  { // logs
    const r = C.TwoPC.run({ failure: 'none' });
    eq(r.logs.C, ['<prepare T1>', '<commit T1>', '<end T1>'], 'coordinator log');
    eq(r.logs.P2, ['<ready T1 1 writes>', '<commit T1>'], 'participant log');
    const kinds = new Set(r.trace.filter((e) => e.kind === 'send').map((e) => e.type));
    for (const t of ['work', 'done', 'prepare', 'vote', 'commit', 'ack']) ok(kinds.has(t), '2PC sends ' + t);
    const no = C.TwoPC.run({ failure: 'vote-no' });
    ok(no.logs.P2.includes('<no T1>') && no.logs.C.includes('<abort T1>'), 'a failed statement votes no and the coordinator aborts');
  }
  { // blocking: the coordinator decided and crashed; the ready participants wait with their row locks held
    const sim = new C.TwoPC({ failure: 'coordinator-after-decision', restart: false });
    const r = sim.run(400);
    eq(r.participants, { P1: 'blocked', P2: 'blocked', P3: 'blocked' }, 'participants blocked while the coordinator is down');
    ok(r.blocked.length === 3 && r.blocked.every((b) => b.to === null), 'blocked periods are open');
    const p = sim.probe('P1');
    ok(p.blocked && p.code === '55P03', 'a blocked participant still holds its row locks (FOR UPDATE NOWAIT fails)');
    ok(r.trace.some((e) => e.kind === 'send' && e.type === 'status'), 'blocked participants ask for the outcome');
    sim.net.restart('C');
    const r2 = sim.run(2000);
    ok(r2.outcome === 'committed' && r2.dataOk && r2.blocked.every((b) => b.to !== null), 'coordinator recovery resends commit and unblocks');
    ok(!sim.probe('P1').blocked, 'locks released after the decision');
    ok(r2.logs.C.includes('<end T1>'), 'coordinator ends the transaction after all acks');
  }
  { // a participant that voted yes, crashed and came back redoes its writes and asks
    const r = C.TwoPC.run({ failure: 'participant-after-vote' });
    ok(r.trace.some((e) => e.kind === 'note' && e.node === 'P2' && e.what === 'recover' && /ready/.test(e.data)), 'in-doubt participant recovers from <ready T>');
    ok(r.outcome === 'committed' && r.balances.P2 === 110, 'and commits its redone writes');
    const r2 = C.TwoPC.run({ failure: 'coordinator-before-decision' });
    ok(r2.trace.some((e) => e.kind === 'note' && e.node === 'C' && e.what === 'recover' && /no decision/.test(e.data)), 'coordinator without a decision aborts on recovery');
  }
  ok(C.TwoPC.describe().failures.none && C.ThreePC.describe().name && C.DistDeadlock.describe().name, 'describe');
  // 3PC: never blocked under crash failures; split by a partition it can disagree
  const t3 = { none: 'committed', 'vote-no': 'aborted', 'coordinator-before-precommit': 'aborted', 'coordinator-partial-precommit': 'committed', 'coordinator-after-precommit': 'committed' };
  for (const [f, want] of Object.entries(t3)) {
    let good = true;
    for (let seed = 1; seed <= 3; seed++) { const r = C.ThreePC.run({ failure: f, seed }); if (!(r.atomic && !r.blocked && r.outcome === want)) good = false; }
    ok(good, '3PC ' + f + ': ' + want + ', nobody blocked');
  }
  const p3 = C.ThreePC.run({ failure: 'partition' });
  ok(!p3.atomic && p3.participants.P1 === 'committed' && p3.participants.P2 === 'aborted', '3PC is not safe under a partition');
  ok(C.ThreePC.run({ failure: 'coordinator-partial-precommit' }).trace.some((e) => e.kind === 'note' && e.what === 'new coordinator'), '3PC termination elects a new coordinator');
  // distributed deadlock: no local cycle, a global one; the victim is aborted everywhere and the other commits
  const d = C.DistDeadlock.run();
  eq(d.cycle, ['T1', 'T2'], 'global wait-for graph has the cycle');
  eq(d.localCycles, [null, null], 'neither local graph has one');
  eq(d.victim, 'T2', 'youngest transaction is the victim');
  eq(d.outcome, { T1: 'committed', T2: 'aborted' }, 'victim aborted, the other committed');
  eq(d.items, { 'S1:1': 1, 'S2:2': 1 }, 'only the survivor\'s writes remain');
  ok(d.rounds[0].local.every((l) => l.edges.length === 1), 'each site reports one waiting edge');
  const fc = C.DistDeadlock.falseCycle();
  ok(fc.falseCycle && fc.detections[0].trueEdges.length === 1, 'delayed reports give a false cycle');
});

section('raft', () => {
  const R = C.Raft;
  // the classic demonstrations: elections, log repair, partitions
  const e = R.scenarios.election({ seed: 5 });
  ok(e.steps[0].leader && e.cluster.leaders().length === 1, 'election: one leader');
  ok(e.trace.some((x) => x.kind === 'send' && x.type === 'RequestVote') && e.trace.some((x) => x.kind === 'note' && x.what === 'vote'), 'election: votes in the trace');
  const lc = R.scenarios.leaderCrash({ seed: 5 });
  ok(lc.steps[3].leader !== lc.steps[0].leader && lc.steps[3].term > lc.steps[0].term, 'leader crash: new leader, higher term');
  eq(lc.steps[5].kv, { x: 1, y: 2 }, 'leader crash: the old leader catches up as a follower');
  eq(lc.steps[5].role, 'follower', 'leader crash: old leader is a follower');
  ok(lc.check.ok, 'leader crash: safe');
  const mp = R.scenarios.minorityPartition({ seed: 9 });
  const st = mp.steps[1];
  ok(st.logLength > st.commit && st.commit === st.committedBefore && st.request === 'pending', 'minority leader appends but cannot commit');
  ok(mp.newLeader && mp.cluster.node(mp.newLeader).state.term > mp.cluster.node(mp.oldLeader).state.term, 'majority elects a leader of a higher term');
  ok(mp.cluster.leaders().length === 2, 'two nodes believe they lead, in different terms');
  const lr = R.scenarios.logRepair({ seed: 9 });
  const last = lr.steps[lr.steps.length - 1];
  ok(last.role === 'follower' && last.x === 'majority' && last.truncated.length >= 1, 'log repair: old leader steps down and its uncommitted entry is replaced');
  ok(lr.check.ok, 'log repair: safe');
  const logs = lr.cluster.nodes().map((n) => show(n.state.log.map((x) => [x.term, x.cmd])));
  ok(logs.every((l) => l === logs[0]), 'log repair: all logs identical after healing');
  // client redirects, exactly-once retries, cas
  const c = R.create({ n: 3, seed: 2 });
  const l = c.elect();
  const follower = c.ids.find((i) => i !== l);
  const r1 = c.await(c.client.submit({ op: 'set', key: 'a', value: 1 }, follower));
  ok(r1.status === 'done' && r1.leader === l && r1.tries === 2, 'a follower redirects the client to the leader');
  eq(c.await(c.submit({ op: 'cas', key: 'a', expect: 1, value: 2 })).result, { ok: true, value: 1 }, 'cas succeeds');
  eq(c.await(c.submit({ op: 'cas', key: 'a', expect: 1, value: 3 })).result, { ok: false, value: 2 }, 'cas fails on a changed value');
  eq(c.await(c.submit({ op: 'get', key: 'a' })).result, { ok: true, value: 2 }, 'get through the log');
  c.runFor(200);
  ok(c.nodes().every((n) => n.state.kv.data.a === 2), 'every replica applied the same commands');
  // snapshot and restore of a whole Raft cluster
  const snap = c.snapshot();
  const tr = c.net.trace.length;
  c.crash(l); c.runFor(1000);
  c.restore(snap);
  ok(c.leader() === l && c.net.trace.length === tr, 'restore brings back the leader and the trace');
  // the checker itself notices a broken log and a second leader
  const bad = R.create({ n: 3, seed: 4 });
  bad.elect(); bad.await(bad.submit({ op: 'set', key: 'k', value: 1 }));
  bad.node('s1').state.log[0] = Object.assign({}, bad.node('s1').state.log[0], { cmd: { op: 'set', key: 'evil', value: 1 } });
  ok(!bad.check().logMatching, 'checker catches a log matching violation');
  const b2 = R.create({ n: 3, seed: 4 });
  const bl = b2.elect();
  b2.net.note(b2.ids.find((i) => i !== bl), 'leader', { term: b2.node(bl).state.term });
  ok(!b2.check().electionSafety, 'checker catches two leaders in one term');
  // random runs with crashes, restarts, partitions, loss and duplication: safety always, liveness after healing
  let runs = 0, safe = 0, live = 0, converged = 0, elections = 0, truncs = 0;
  for (let seed = 1; seed <= 80; seed++) {
    const n = seed % 3 === 0 ? 3 : 5;
    const k = R.create({ n, seed, loss: 0.05, dup: 0.03, jitter: 10 });
    const rng = new C.Rng(seed * 7919);
    for (let t = 100; t < 4000; t += 80 + rng.int(0, 120)) {
      const x = rng.next();
      if (x < 0.25) k.net.at(t, 'crash', rng.pick(k.ids));
      else if (x < 0.5) k.net.at(t, 'restart', rng.pick(k.ids));
      else if (x < 0.6) { const ids = rng.shuffle(k.ids.slice()); const cut = rng.int(1, ids.length - 1); k.net.at(t, 'call', () => k.partition([ids.slice(0, cut), ids.slice(cut)])); }
      else if (x < 0.7) k.net.at(t, 'heal');
      else k.net.at(t, 'call', () => k.submit({ op: rng.next() < 0.7 ? 'incr' : 'set', key: 'k' + rng.int(1, 3), value: t }));
    }
    k.run(4000);
    runs++;
    k.heal(); for (const id of k.ids) k.restart(id);
    const fin = k.await(k.submit({ op: 'set', key: 'final', value: seed }), 8000);
    k.runFor(1500);
    const chk = k.check();
    if (chk.ok) safe++; else console.log('  raft seed ' + seed + ': ' + show(chk.violations[0]));
    if (fin.status === 'done') live++;
    const kvs = k.nodes().map((x) => show(x.state.kv.data));
    if (kvs.every((v) => v === kvs[0]) && k.nodes().every((x) => x.state.applied === k.nodes()[0].state.applied)) converged++;
    elections += Object.keys(k.chk.leaders).length;
    truncs += k.net.trace.filter((x) => x.kind === 'note' && x.what === 'truncate').length;
  }
  eq(safe, runs, 'raft: election safety, log matching, leader completeness and state machine safety in every random run');
  eq(live, runs, 'raft: after healing every run commits a new command');
  eq(converged, runs, 'raft: after healing all replicas hold the same state');
  ok(elections > runs * 2 && truncs > 0, 'raft: the random runs had many elections (' + elections + ') and log repairs (' + truncs + ')');
  ok(R.create().describe().properties.length === 5 && R.describe().name === 'Raft', 'raft describe');

  // single-decree Paxos: duelling proposers, losses and acceptor crashes never choose two values
  const P = C.Paxos;
  const p1 = P.single({ seed: 1, proposers: 2, values: ['A', 'B'], start: [0, 3] });
  p1.run(20000);
  ok(p1.check().ok && p1.chosen() !== null, 'paxos: one value chosen');
  ok(p1.view().proposers.every((p) => p.chosen === p1.chosen()) && p1.learner.state.chosen === p1.chosen(), 'paxos: every learner learns it');
  let pruns = 0, psafe = 0, pchosen = 0, duels = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const p = P.single({ seed, acceptors: seed % 2 ? 3 : 5, proposers: 3, loss: 0.1, dup: 0.05, jitter: 15, start: [0, seed % 7, (seed * 3) % 11] });
    const rng = new C.Rng(seed);
    for (let i = 0; i < 4; i++) { const a = rng.pick(p.acceptors); const t = rng.int(0, 400); p.net.at(t, 'crash', a).at(t + rng.int(20, 200), 'restart', a); }
    p.net.at(rng.int(0, 300), 'crash', 'p1').at(500, 'restart', 'p1');
    p.run(30000);
    pruns++;
    const chk = p.check();
    if (chk.ok) psafe++; else console.log('  paxos seed ' + seed + ': ' + show(chk.violations[0]));
    if (chk.chosen !== null) pchosen++;
    if (p.net.trace.some((x) => x.kind === 'note' && x.what === 'rejected')) duels++;
  }
  eq(psafe, pruns, 'paxos: at most one value chosen in every random run');
  eq(pchosen, pruns, 'paxos: a value is eventually chosen in every run');
  ok(duels > 0, 'paxos: proposers pre-empted each other in some runs (' + duels + ')');
  // a later proposer adopts the value already accepted
  const p2 = P.single({ seed: 3, proposers: 2, values: ['first', 'second'], start: [0, 400], proposersLearn: false });
  p2.run(20000);
  eq(p2.chosen(), 'first', 'paxos: a later ballot re-proposes the chosen value');
  ok(p2.net.trace.some((x) => x.kind === 'note' && x.node === 'p2' && x.what === 'propose' && x.data.adopted), 'paxos: p2 adopted it from a promise');

  // multi-Paxos: one phase 1, then phase 2 per command; a new leader keeps the chosen slots
  const m = P.multi({ n: 3, seed: 1 });
  eq(m.lead('m1'), 'm1', 'multi-paxos: m1 leads');
  const prep = m.messages().prepare;
  for (let i = 0; i < 5; i++) m.submit({ op: 'set', key: 'k', value: i });
  m.settle();
  eq(m.messages().prepare, prep, 'multi-paxos: no phase 1 for later commands');
  eq(m.messages().accept, 10, 'multi-paxos: one accept round per command');
  m.net.crash('m1');
  eq(m.lead('m2'), 'm2', 'multi-paxos: m2 takes over');
  m.submit({ op: 'set', key: 'z', value: 9 }); m.settle();
  const mc = m.check();
  ok(mc.ok && Object.keys(mc.log).length === 6 && mc.log[3].value === 2 && mc.log[6].value === 9, 'multi-paxos: the log survives the change of leader');
  // random leadership fights and crashes never choose two values in a slot
  let mruns = 0, msafe = 0;
  for (let seed = 1; seed <= 15; seed++) {
    const mm = P.multi({ n: 5, seed, loss: 0.05, jitter: 10 });
    const rng = new C.Rng(seed);
    for (let i = 0; i < 40; i++) {
      const id = rng.pick(mm.ids), x = rng.next();
      if (x < 0.15) mm.node(id).lead(); else if (x < 0.25) mm.net.crash(id); else if (x < 0.35) mm.net.restart(id);
      else { const ld = mm.leader(); if (ld) mm.submit({ op: 'set', key: 'k', value: i }, ld); }
      mm.net.runFor(rng.int(5, 40));
    }
    mm.settle(); mruns++;
    if (mm.check().ok) msafe++;
  }
  eq(msafe, mruns, 'multi-paxos: one value per slot under competing leaders');
  ok(P.describe().name.startsWith('Paxos') && m.describe().name === 'Multi-Paxos', 'paxos describe');
});

section('mapreduce', () => {
  const M = C.MapReduce, U = C.theatre();
  const sql = (q) => C.textResult(U.s.query(q)).rows;
  const bag = (rows) => rows.map((r) => show(r)).sort();
  const near = (a, b) => (a === null || b === null ? a === b : Math.abs(Number(a) - Number(b)) <= 1e-6 * Math.max(1, Math.abs(Number(b))));
  // word count: equals a direct count; same with or without the combiner and with failures; the combiner cuts the shuffle
  const rng = new C.Rng(5), vocab = ['data', 'base', 'query', 'join', 'node', 'shard', 'log', 'commit', 'raft', 'map'];
  const lines = K.range(60).map(() => K.range(8).map(() => vocab[Math.floor(rng.next() ** 2 * vocab.length)]).join(' '));
  const direct = {};
  for (const l of lines) for (const w of l.split(' ')) direct[w] = (direct[w] || 0) + 1;
  const expect = Object.entries(direct).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const wc = M.run(M.examples.wordCount(lines, 6), { seed: 3 });
  eq(wc.output, expect, 'word count equals a direct count');
  ok(wc.stats.done && wc.stats.maps === 6 && wc.stats.reduces === 3, 'word count finished with 6 maps and 3 reduces');
  const noComb = M.run(M.examples.wordCount(lines, 6), { seed: 3, combiner: false });
  eq(noComb.output, expect, 'same result without the combiner');
  ok(wc.stats.shuffleRecords < noComb.stats.shuffleRecords / 5 && wc.stats.shuffleBytes < noComb.stats.shuffleBytes, 'the combiner cuts shuffle records and bytes');
  eq(noComb.stats.shuffleRecords, lines.length * 8, 'without a combiner every emitted pair is shuffled');
  const again = M.run(M.examples.wordCount(lines, 6), { seed: 3 });
  eq(again.trace.map((e) => [e.kind, e.t, e.msg || e.what]), wc.trace.map((e) => [e.kind, e.t, e.msg || e.what]), 'same seed, same trace');
  // a worker dies while running a map task
  const f1 = M.run(M.examples.wordCount(lines, 6), { seed: 3, failures: [{ worker: 'w1', at: 3 }] });
  eq(f1.output, expect, 'result unchanged when a worker fails during the map phase');
  ok(f1.trace.some((e) => e.what === 'worker.dead' && e.data.worker === 'w1') && f1.trace.some((e) => e.what === 'task.reexecute' && e.data.was === 'running'), 'failure detected and the running map re-executed');
  ok(f1.tasks.some((t) => t.status === 'failed') && f1.tasks.filter((t) => t.status === 'done').length === 9, 'task history shows the failed attempt');
  // a worker dies after its map finished, while reducers still need its output: the finished map runs again
  const mapsDone = Math.max(...wc.trace.filter((e) => e.what === 'task.done' && e.data.task[0] === 'm').map((e) => e.t));
  const victim = wc.tasks.find((t) => t.kind === 'map' && t.end === mapsDone).worker;
  const f2 = M.run(M.examples.wordCount(lines, 6), { seed: 3, failures: [{ worker: victim, at: mapsDone + 0.001, restart: mapsDone + 100 }] });
  eq(f2.output, expect, 'result unchanged when a worker fails after its maps finished');
  ok(f2.trace.some((e) => e.what === 'task.reexecute' && e.data.was === 'done'), 'a completed map task re-executed');
  ok(f2.stats.reexecuted >= 1 && f2.stats.failures >= 1, 'failure counters');
  // two failures, one restart
  const f3 = M.run(M.examples.wordCount(lines, 6), { seed: 9, workers: 5, failures: [{ worker: 'w2', at: 4, restart: 50 }, { worker: 'w4', at: mapsDone + 3 }] });
  eq(f3.output, expect, 'result unchanged with two failures and a restart');
  // the equi-join of artist and company equals SQL (freelance artists, with no company, join nothing)
  const ins = U.tables.artist, dep = U.tables.company;
  const jn = M.run(M.examples.join(ins, dep, 'company_id', 'company_id', 5), { seed: 4 });
  eq(bag(jn.output.map((kv) => kv[1])), bag(sql('select a.*, c.* from artist a join company c on a.company_id = c.company_id')), 'MapReduce join artist-company equals SQL');
  const bk = U.tables.booking, pf = U.tables.performance;
  const jn2 = M.run(M.examples.join(bk, pf, 'perf_id', 'perf_id', 8), { seed: 4, workers: 6, failures: [{ worker: 'w3', at: 5 }] });
  eq(bag(jn2.output.map((kv) => kv[1])), bag(sql('select b.*, f.* from booking b join performance f on b.perf_id = f.perf_id')), 'MapReduce join booking-performance equals SQL, with a failure');
  // group-bys equal SQL
  const gb = (table, g, x, q, opts) => {
    const r = M.run(M.examples.groupBy(U.tables[table], g, x, 5), opts || { seed: 6 });
    const want = sql(q);
    const got = r.output.map(([k, v]) => [k, v.count, v.sum, v.avg]);
    const byKey = new Map(want.map((w) => [show(w[0]), w]));
    ok(got.length === want.length && got.every((row) => { const w = byKey.get(show(row[0])); return w && Number(w[1]) === row[1] && near(row[2], w[2]) && near(row[3], w[3]); }), 'group-by ' + table + '.' + g + ' equals SQL');
    return r;
  };
  gb('artist', 'company_id', 'fee', 'select company_id, count(*), sum(fee), avg(fee) from artist group by company_id');
  gb('patron', 'city', 'points', 'select city, count(*), sum(points), avg(points) from patron group by city');
  gb('booking', 'perf_id', 'seats', 'select perf_id, count(*), sum(seats), avg(seats) from booking group by perf_id', { seed: 2, combiner: false });
  gb('performance', 'venue_code', 'price', 'select venue_code, count(*), sum(price), avg(price) from performance group by venue_code', { seed: 2, failures: [{ worker: 'w2', at: 2 }] });
  ok(M.describe().name === 'MapReduce', 'describe');
  // Spark-style operator chains
  const sc = new M.Spark({ workers: 3 });
  const counts = sc.textFile(lines, 4).flatMap((l) => l.split(' ')).map((w) => [w, 1]).reduceByKey((a, b) => a + b);
  const run = counts.run();
  eq(run.result.sort((a, b) => (a[0] < b[0] ? -1 : 1)), expect, 'RDD word count equals a direct count');
  eq(run.stages.map((s) => s.ops), [['source', 'flatMap', 'map'], ['reduceByKey']], 'narrow operators pipelined in one stage, the shuffle starts another');
  ok(run.stats.shuffleRecords > 0 && run.stats.shuffleRecords <= vocab.length * 4 * 3, 'map-side combine before the shuffle');
  const instr = sc.parallelize(ins.rows, 4).filter((r) => r[1] !== null).map((r) => [r[1], r]);
  const depts = sc.parallelize(dep.rows, 2).map((r) => [r[0], r]);
  const joined = instr.join(depts, 3);
  const jr = joined.run();
  eq(bag(jr.result.map(([, [a, b]]) => a.concat(b))), bag(sql('select a.*, c.* from artist a join company c on a.company_id = c.company_id')), 'RDD join equals SQL');
  eq(jr.stages.length, 3, 'a join has two map stages feeding it');
  const big = sc.parallelize(ins.rows, 4).filter((r) => Number(r[3]) > 1500).map((r) => [r[1], 1]).reduceByKey((a, b) => a + b).cache();
  sc.track(big);
  const want = sql('select company_id, count(*) from artist where fee > 1500 group by company_id').map((r) => [r[0], Number(r[1])]);
  eq(bag(big.collect()), bag(want), 'RDD filter + reduceByKey equals SQL');
  ok(big.run().events.every((e) => e.kind === 'cache-hit'), 'a cached RDD is served from its cache');
  const lost = sc.failWorker('w2');
  ok(lost.length > 0, 'a worker failure loses cached partitions');
  const rerun = big.run();
  eq(bag(rerun.result), bag(want), 'same result after recomputation');
  ok(rerun.events.some((e) => e.kind === 'recompute') && rerun.events.some((e) => e.kind === 'cache-hit'), 'only the lost partitions are recomputed from the lineage');
  ok(big.lineage().length === 4, 'lineage');
});

section('arch', () => {
  const A = C.Arch;
  const all = A.compare({ maxNodes: 128 });
  for (const c of all) {
    ok(c.points.every((p) => p.speedup <= p.n + 1e-9 && p.scaleupBatch <= 1 + 1e-9 && p.scaleupTx <= 1 + 1e-9), c.arch + ': speed-up at most linear, scale-up at most 1');
    ok(c.points[0].n === 1 && Math.abs(c.points[0].speedup - 1) < 1e-9, c.arch + ': speed-up 1 on one processor');
    ok(c.points[1].speedup > 1, c.arch + ': a second processor helps');
  }
  const by = Object.fromEntries(all.map((c) => [c.arch, c]));
  const at = (a, n) => by[a].points.find((p) => p.n === n);
  ok(at('shared-nothing', 128).scaleupTx > 0.7, 'shared nothing: near-linear transaction scale-up');
  ok(at('shared-memory', 128).throughput < at('shared-memory', 16).throughput, 'shared memory: adding processors past the peak slows it down');
  const pk = A.peak('shared-memory');
  ok(pk.n > 4 && pk.n < 64, 'shared memory peaks at a few dozen processors (' + pk.n + ')');
  ok(at('shared-disk', 64).throughput > at('shared-memory', 64).throughput && at('shared-nothing', 64).throughput > at('shared-disk', 64).throughput, 'shared nothing > shared disk > shared memory at 64');
  ok(at('hierarchical', 128).throughput > at('shared-memory', 128).throughput, 'hierarchical scales past shared memory');
  ok(by['shared-nothing'].points.every((p, i, a) => i === 0 || p.throughput > a[i - 1].throughput), 'shared nothing throughput keeps growing');
  ok(A.curves({ arch: 'shared-nothing', skew: 0.3 }).points.slice(-1)[0].speedup < A.curves({ arch: 'shared-nothing', skew: 0 }).points.slice(-1)[0].speedup, 'skew lowers speed-up');
  ok(A.curves({ arch: 'shared-nothing', startup: 20 }).points.slice(-1)[0].speedup < A.curves({ arch: 'shared-nothing', startup: 0 }).points.slice(-1)[0].speedup, 'start-up cost lowers speed-up');
  // the queueing simulation: a shared bus saturates, private disks do not
  const sm = [1, 4, 16, 32].map((n) => A.simulate({ arch: 'shared-memory', n, think: 10, service: 1, requests: 100 }));
  const sn = [1, 4, 16, 32].map((n) => A.simulate({ arch: 'shared-nothing', n, think: 10, service: 1, requests: 100 }));
  ok(sm[3].utilization > 0.9 && sm[3].throughput < sm[2].throughput * 1.3, 'shared bus saturates');
  ok(sm[3].avgWait > sm[0].avgWait * 5, 'waits grow on the shared bus');
  ok(sn[3].throughput > sn[0].throughput * 25, 'private resources scale almost linearly');
  eq(show(A.simulate({ n: 8, seed: 4 })), show(A.simulate({ n: 8, seed: 4 })), 'simulation is deterministic');
  // interconnects
  const d = (k, n) => A.topology(k, n).diameter;
  eq([d('bus', 8), d('ring', 8), d('mesh', 16), d('hypercube', 8), d('hypercube', 16), d('tree', 8)], [2, 4, 6, 3, 4, 6], 'topology diameters');
  eq(A.topology('hypercube', 16).linkCount, 32, 'a 4-cube has 32 links');
  ok(A.topology('fat-tree', 8).links.some((l) => l[2] === 4), 'fat tree links get wider toward the root');
  ok(A.diagram('shared-disk', 4).disks.length === 3 && A.diagram('shared-nothing', 4).disks.length === 4, 'diagrams');
  ok(A.describe().architectures.length === 4, 'describe');
});

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
