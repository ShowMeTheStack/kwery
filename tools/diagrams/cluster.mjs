// The distributed views: every Cluster scenario at several moments (the start, mid-run with many messages in flight,
// during a partition, after a crash, the end), the Distributed query plans, MapReduce and the Architectures charts,
// each with the largest node counts the controls allow.
const J = JSON.stringify;
// helpers defined in the page: open a view, wait, and pause a stage at a moment
const pre = `
const V = (id) => K.app.dock.open.find((o) => o.id === id).view;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > (ms || 30000)) throw new Error('timed out'); await sleep(50); } };
K.app.dock.toggleMax(true);
// a moment of the recording: frame i, with the clock between it and the next frame
const at = (st, i, u) => { const P = st.player, fr = P.rec.frames; P.pause(); P.go(i); const nx = fr[i + 1]; if (nx && nx.t > fr[i].t) { P.t = fr[i].t + (nx.t - fr[i].t) * (u === undefined ? 0.5 : u); P.sync(); P.opts.onTick(P.t); } };
// the busiest moment from frame i0 on: the most messages out on their links at once
const busiest = (st, i0) => {
  const rec = st.player.rec; let best = i0 || 0, bn = -1;
  for (let i = i0 || 0; i < rec.frames.length - 1; i++) { const n = rec.inFlight(i).filter((m) => m.from !== m.to).length; if (n > bn) { bn = n; best = i; } }
  at(st, best);
};
const show = (sel) => { const e = document.querySelector('.dock-pane:not([hidden]) ' + (sel || '.ck-canvas')); if (e) e.scrollIntoView({ block: 'start' }); };
const more = (st, k) => { for (let j = 0; j < (k || 3); j++) if (st.src.extend) st.src.extend(); };
const scen = async (id, o) => { K.app.openView('cluster'); await sleep(50); V('cluster').scenario(id, o); await until(() => V('cluster').stage && V('cluster').stage.player.rec.frames.length); return V('cluster').stage; };
`;
/** a Cluster scenario at a moment: start | busy | end | crash | partition | (a function body given the stage) */
const ck = (id, o, moment) => pre + `const st = await scen(${J(id)}, ${J(o)});
` + ({
  start: 'at(st, 0, 0);',
  busy: 'more(st); busiest(st, 1);',
  end: 'more(st); at(st, st.player.rec.last, 0);',
  crash: 'more(st); const k = Math.min(st.player.rec.last, 30); st.player.go(k); const ids = [...st.canvas.cards.keys()].filter((x) => !/^c\\d|client|learner|network/.test(x)); const fi = st.src.intervene(k, { kind: "crash", id: ids[0] }); st.player.load(st.src, fi); more(st); busiest(st, fi);',
  partition: 'more(st); const k = Math.min(st.player.rec.last, 30); const ids = [...st.canvas.cards.keys()].filter((x) => x !== "network"); const half = ids.slice(0, Math.ceil(ids.length / 2)); const fi = st.src.intervene(k, { kind: "partition", groups: [half] }); st.player.load(st.src, fi); more(st); busiest(st, fi);',
}[moment] || moment) + '\nshow();';

const S = [];
const add = (name, setup, wait) => S.push({ name, setup, wait: wait || 900 });

// ---- partitioning and the hash ring ----
const part = (o) => Object.assign({ table: 'booking', key: 'patron_id', scheme: 'consistent', n: 6, vnodes: 32 }, o);
add('ck-partition-start', ck('partition', part(), 'start'), 1500);
add('ck-partition-join', ck('partition', part(), 'st.intervene({ kind: "add" }); busiest(st, 1);'), 1500);
add('ck-partition-join-end', ck('partition', part(), 'st.intervene({ kind: "add" }); at(st, st.player.rec.last, 0);'), 1500);
add('ck-partition-ring8', ck('partition', part({ n: 3, vnodes: 8 }), 'st.intervene({ kind: "add" }); at(st, st.player.rec.last, 0); show(".ck-ringbox"); return;'), 1500);
add('ck-partition-ring4', ck('partition', part({ n: 6, vnodes: 4 }), 'st.intervene({ kind: "add" }); at(st, st.player.rec.last, 0); show(".ck-ringbox"); return;'), 1500);
add('ck-partition-ring2', ck('partition', part({ n: 6, vnodes: 2 }), 'at(st, 0, 0); show(".ck-ringbox"); return;'), 1500);
add('ck-partition-ringpanel', ck('partition', part(), "st.intervene({ kind: 'add' }); at(st, st.player.rec.last, 0); show('.ck-ringbox'); return;"), 1500);
add('ck-partition-ring1', ck('partition', part({ n: 2, vnodes: 1 }), 'at(st, 0, 0); show(".ck-ringbox"); return;'), 1500);
add('ck-partition-range', ck('partition', part({ scheme: 'range', table: 'patron', key: 'points' }), 'st.intervene({ kind: "remove", id: "n2" }); busiest(st, 1);'), 1500);
add('ck-partition-virtual', ck('partition', part({ scheme: 'virtual' }), 'at(st, 0, 0);'), 1500);

// ---- replication, quorums, CAP ----
const repl = { mode: 'async', readFrom: 'any', tokens: false, lag: 120, seed: 2 };
for (const m of ['start', 'busy', 'crash', 'partition', 'end']) add('ck-replication-' + m, ck('replication', repl, m));
add('ck-replication-panel', ck('replication', repl, "more(st); busiest(st, 1); show('.ck-panel'); return;"));
add('ck-replication-sync', ck('replication', Object.assign({}, repl, { mode: 'sync', tokens: true }), 'busy'));
const quo = { N: 5, R: 2, W: 2, repair: true, fanout: 'all', seed: 3 };
for (const m of ['start', 'busy', 'crash', 'partition', 'end']) add('ck-quorum-' + m, ck('quorum', quo, m));
for (const mode of ['CP', 'AP']) {
  const o = { mode, resolve: 'vv', seed: 1 };
  add('ck-cap-' + mode + '-start', ck('cap', o, 'start'));
  add('ck-cap-' + mode + '-split', ck('cap', o, 'more(st); const fr = st.player.rec.frames; const i = fr.findIndex((f) => f.t >= 120); busiest(st, i);'));
  add('ck-cap-' + mode + '-end', ck('cap', o, 'end'));
}

// ---- 2PC, 3PC ----
const tpc = (failure, extra) => Object.assign({ proto: '2pc', failure, n: 4, target: 'P2', restart: false, seed: 1 }, extra || {});
add('ck-2pc-start', ck('2pc', tpc('none'), 'start'));
add('ck-2pc-busy', ck('2pc', tpc('none'), 'busy'));
add('ck-2pc-end', ck('2pc', tpc('none'), 'end'));
add('ck-2pc-blocked', ck('2pc', tpc('coordinator-after-decision'), 'end'));
add('ck-2pc-partial', ck('2pc', tpc('coordinator-partial-decision', { restart: true }), 'busy'));
add('ck-2pc-cutoff', ck('2pc', tpc('partition-during-vote'), 'more(st); const fr = st.player.rec.frames; const i = fr.findIndex((f) => f.n && f.n.groups); busiest(st, Math.max(1, i));'));
add('ck-2pc-panel', ck('2pc', tpc('coordinator-after-decision'), "more(st); at(st, st.player.rec.last, 0); show('.ck-panel'); return;"));
add('ck-2pc-crash', ck('2pc', tpc('none'), 'crash'));
add('ck-3pc-busy', ck('2pc', { proto: '3pc', failure: 'none', n: 4, seed: 1 }, 'busy'));
add('ck-3pc-partition', ck('2pc', { proto: '3pc', failure: 'partition', n: 4, seed: 1 }, 'more(st); const fr = st.player.rec.frames; const i = fr.findIndex((f) => f.n && f.n.groups); busiest(st, Math.max(1, i));'));
add('ck-3pc-end', ck('2pc', { proto: '3pc', failure: 'partition', n: 4, seed: 1 }, 'end'));

// ---- distributed deadlock ----
add('ck-deadlock-busy', ck('deadlock', { variant: 'real', seed: 1 }, 'busy'));
add('ck-deadlock-end', ck('deadlock', { variant: 'real', seed: 1 }, 'end'));
add('ck-deadlock-panel', ck('deadlock', { variant: 'real', seed: 1 }, "more(st); at(st, st.player.rec.last, 0); show('.ck-panel'); return;"));
add('ck-deadlock-false', ck('deadlock', { variant: 'false' }, 'busy'));
add('ck-deadlock-false-end', ck('deadlock', { variant: 'false' }, 'end'));

// ---- Raft, Paxos ----
const raft = { n: 5, seed: 1 };
for (const m of ['start', 'busy', 'crash', 'partition', 'end']) add('ck-raft-' + m, ck('raft', raft, m));
add('ck-raft-election', ck('raft', raft, 'const fr = st.player.rec.frames; const i = fr.findIndex((f) => f.s.nodes.some((n) => n.role === "candidate")); busiest(st, i); at(st, i + 1);'));
add('ck-raft-cutleader', ck('raft', raft, 'more(st); const fr = st.player.rec.frames; const k = fr.findIndex((f) => f.s.nodes.some((n) => n.role === "leader")) + 4; const fi = st.src.intervene(k, { kind: "cutLeader" }); st.player.load(st.src, fi); more(st); busiest(st, fi);'));
add('ck-raft-writes', ck('raft', raft, 'more(st); for (let j = 0; j < 4; j++) { const fi = st.src.intervene(st.player.rec.last, { kind: "write", key: "abcd"[j], value: j }); st.player.load(st.src, fi); } more(st); at(st, st.player.rec.last, 0);'));
add('ck-raft-panel', ck('raft', raft, "more(st); for (let j = 0; j < 6; j++) { const fi = st.src.intervene(st.player.rec.last, { kind: 'write', key: 'abcdef'[j], value: j }); st.player.load(st.src, fi); } more(st); at(st, st.player.rec.last, 0); show('.ck-panel'); return;"));
add('ck-raft3-busy', ck('raft', { n: 3, seed: 2 }, 'busy'));
const pax = { acceptors: 5, proposers: 3, start: 'duel', loss: 0.1, seed: 1 };
for (const m of ['start', 'busy', 'crash', 'end']) add('ck-paxos-' + m, ck('paxos', pax, m));

// ---- distributed query ----
const dq = (ex, nodes, place) => pre + `K.app.openView('dquery'); await sleep(50);
const v = V('dquery');
await until(() => v.result.run || v.result.err);
v.run(null, { nodes: ${nodes}, place: ${J(place || 'mixed')} });
await sleep(80); await until(() => (v.result.run || v.result.err) && v.stage);
const sel = document.querySelector('.dock-pane:not([hidden]) .ck-controls select');
sel.value = ${J(ex)}; sel.dispatchEvent(new Event('change'));
await sleep(80); await until(() => (v.result.run || v.result.err) && v.stage);
busiest(v.stage, 1); show();`;
for (const ex of ['join', 'three', 'agg', 'sort', 'distinct', 'ship']) add('dq-' + ex, dq(ex, 6), 1200);
add('dq-join-2', dq('join', 2, 'rr'), 1200);
for (const ex of ['join', 'three', 'sort']) add('dq-' + ex + '-tree', dq(ex, 6) + "show('.dq-tree');", 1200);
add('dq-join-stages', dq('join', 6) + "show('.dq-mx');", 1200);
add('dq-compare', dq('three', 6) + `v.compare(); await sleep(60); await until(() => v.result.cmp);`, 1500);

// ---- MapReduce ----
const mr = (o, moment) => pre + `K.app.openView('mapreduce'); await sleep(50);
const v = V('mapreduce');
for (const [k, x] of Object.entries(${J(Object.assign({ job: 'words', workers: 6, maps: 8, R: 4, combiner: true, fail: 'none', seed: 1 }, o))})) v.set(k, x);
await sleep(80); await until(() => v.stage && document.querySelector('.dock-pane:not([hidden]) .mr-dag'));
const st = v.stage;
${moment === 'end' ? 'more(st, 10); at(st, st.player.rec.last, 0);' : moment === 'busy' ? 'more(st, 2); busiest(st, 1);' : moment}
show();`;
for (const job of ['words', 'join', 'group', 'bookings']) add('mr-' + job + '-busy', mr({ job, fail: 'map' }, 'busy'), 1200);
for (const job of ['words', 'join', 'group']) add('mr-' + job + '-panels', mr({ job, fail: 'map' }, 'end') + "show('.mr-gantt');", 1200);
for (const job of ['words', 'join', 'group']) add('mr-' + job + '-lineage', mr({ job, fail: 'none' }, 'end') + "show('.mr-dag');", 1200);
add('mr-words-end', mr({ job: 'words', fail: 'after' }, 'end'), 1200);
add('mr-restart-end', mr({ job: 'bookings', fail: 'restart', workers: 3, maps: 3, R: 2 }, 'end'), 1200);
add('mr-spark-lost', mr({ job: 'join' }, 'end') + `[...document.querySelectorAll('.dock-pane:not([hidden]) button')].find((b) => /Lose worker/.test(b.textContent)).click();`, 1200);

// ---- architectures ----
const ar = (o, at) => pre + `K.app.openView('arch'); await sleep(50); const v = V('arch'); for (const [k, x] of Object.entries(${J(o)})) v.set(k, x); show(${J(at || '.ck-sec')});`;
for (const a of ['shared-memory', 'shared-disk', 'shared-nothing', 'hierarchical']) add('ar-' + a, ar({ arch: a, max: 128, n: 8, topo: 'hypercube', tn: 16 }));
add('ar-n1', ar({ arch: 'shared-nothing', max: 16, n: 1, scale: 'tx', startup: 5, skew: 5 }, '.ar-two'));
add('ar-n128', ar({ arch: 'hierarchical', max: 128, n: 128, scale: 'batch', startup: 0, skew: 0 }, '.ar-two'));
add('ar-charts-sm', ar({ arch: 'shared-memory', max: 64, n: 16, scale: 'tx', startup: 1, skew: 1 }, '.ar-two'));
for (const t of ['bus', 'ring', 'mesh', 'hypercube', 'tree', 'fat-tree']) add('ar-topo-' + t, ar({ topo: t, tn: 16 }, '.ar-topo'));
for (const t of ['bus', 'hypercube', 'fat-tree']) add('ar-topo8-' + t, ar({ topo: t, tn: 8 }, '.ar-topo'));

export default S;
