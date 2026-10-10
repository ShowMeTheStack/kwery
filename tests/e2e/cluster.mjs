// End-to-end test of the distributed views (Cluster, Distributed query, MapReduce, Architectures) in headless Chrome:
// every scenario opens, plays, steps forwards and back, takes the user's interventions, and nothing logs an error.
// node tests/e2e/cluster.mjs [--shots <dir>]   (screenshots of each view, both themes and phone width)
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../../tools/cdp.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const si = process.argv.indexOf('--shots');
const shots = si >= 0 ? process.argv[si + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });
execFileSync('node', [join(root, 'build.mjs')], { stdio: 'ignore' });

let fails = 0, passes = 0;
const check = (ok, what) => { if (ok) passes++; else { fails++; console.log('FAIL ' + what); } };
const J = JSON.stringify;

async function start(width, height) {
  const b = await launch({ width, height, mobile: width < 600 });
  await b.goto('');
  await b.waitFor('window.K && K.app && document.querySelector(".tab")', 20000);
  await b.eval('localStorage.clear(); K.app.settings.theme = "light"; K.app.applyTheme(); 1');
  await b.eval('window.VIEW = (id) => K.app.dock.open.find((o) => o.id === id).view; 1');
  return b;
}
const shot = async (b, name) => { if (shots) { await b.sleep(300); await b.screenshot(join(shots, name + '.png')); } };
const errors = (b) => b.logs.filter((l) => l.type === 'error' || l.type === 'exception');
const theme = (b, t) => b.eval(`K.app.settings.theme = ${J(t)}; K.app.applyTheme(); 1`);
const what = (b) => b.eval('(document.querySelector(".dock-pane:not([hidden]) .ck-what") || {}).textContent || ""');
/** a stage's player: i, number of frames, and the frame's state */
const P = (view) => `VIEW(${J(view)}).stage.player`;
const pos = (b, view) => b.eval(`[${P(view)}.i, ${P(view)}.rec.frames.length]`);

/** open a cluster scenario, wait until its stage is ready, step it about, play a little */
async function scenario(b, id, opts) {
  await b.eval(`VIEW('cluster').scenario(${J(id)}, ${J(opts || null)}); 1`);
  await b.waitFor(`VIEW('cluster').stage && VIEW('cluster').stage.player.rec.frames.length`, 30000);
  // partitioning starts as one frame: the moves come with a node joining
  if (id === 'partition') await b.eval(`VIEW('cluster').stage.intervene({ kind: 'add' }); 1`);
  const [, n] = await pos(b, 'cluster');
  check(n > 3, id + ': a recording with frames (' + n + ')');
  await b.eval(`${P('cluster')}.go(0); 1`);
  check(/start/i.test(await what(b)) || (await what(b)).length > 0, id + ': the first frame says something');
  for (let k = 0; k < 6; k++) await b.clickSel('.dock-pane:not([hidden]) .ck-player button[title^="Step forward"]');
  const [i1] = await pos(b, 'cluster');
  check(i1 === 6, id + ': six steps forward (' + i1 + ')');
  await b.clickSel('.dock-pane:not([hidden]) .ck-player button[title^="Step back"]');
  await b.clickSel('.dock-pane:not([hidden]) .ck-player button[title^="Step back"]');
  check((await pos(b, 'cluster'))[0] === 4, id + ': two steps back');
  check((await what(b)).length > 3, id + ': the step is described: ' + (await what(b)).slice(0, 80));
  check(await b.eval('document.querySelectorAll(".dock-pane:not([hidden]) .ck-node").length') >= 2, id + ': nodes drawn');
  const t0 = await b.eval(`${P('cluster')}.t`);
  await b.clickSel('.dock-pane:not([hidden]) .ck-player .ck-play');
  await b.sleep(600);
  await b.eval(`${P('cluster')}.pause(); 1`);
  check(await b.eval(`${P('cluster')}.t`) > t0, id + ': playing moves the clock on');
}

// ---- the Cluster view, every scenario --------------------------------------------------------------------------------
{
  const b = await start(1440, 1000);
  await b.eval(`K.app.openView('cluster'); 1`);
  check(await b.eval('K.app.dock.active') === 'cluster', 'cluster view opens');
  const ids = await b.eval('K.UI.CK.scenarios.map((s) => s.id)');
  check(ids.length >= 8, 'scenarios: ' + ids.join(', '));
  for (const id of ids) await scenario(b, id);

  // Raft: elect, cut the leader off with the client, write, heal: the old leader steps down, safety holds
  await scenario(b, 'raft', { n: 5, seed: 1 });
  await b.eval(`${P('cluster')}.go(${P('cluster')}.rec.last); 1`);
  const leader = await b.eval(`(() => { const f = ${P('cluster')}.rec.frames[${P('cluster')}.i]; const l = f.s.nodes.find((n) => n.role === 'leader'); return l && l.id; })()`);
  check(!!leader, 'raft: a leader is elected (' + leader + ')');
  await b.eval(`VIEW('cluster').stage.intervene({ kind: 'cutLeader' }); 1`);
  check(/partition/.test(await what(b)), 'raft: the partition is a frame of its own');
  await b.eval(`${P('cluster')}.go(${P('cluster')}.i + 3); VIEW('cluster').stage.intervene({ kind: 'write', key: 'z', value: 9 }); ${P('cluster')}.go(${P('cluster')}.rec.last); 1`);
  const minority = await b.eval(`(() => { const f = ${P('cluster')}.rec.frames[${P('cluster')}.i]; const n = f.s.nodes.find((x) => x.id === ${J(leader)}); return [n.log.length, n.commit, f.s.nodes.filter((x) => x.role === 'leader').length]; })()`);
  check(minority[0] > minority[1] && minority[2] === 2, 'raft: the cut-off leader appends but cannot commit; the majority elects another ' + J(minority));
  await b.eval(`VIEW('cluster').stage.intervene({ kind: 'heal' }); ${P('cluster')}.src.extend(); ${P('cluster')}.src.extend(); ${P('cluster')}.go(${P('cluster')}.rec.last); 1`);
  const after = await b.eval(`(() => { const f = ${P('cluster')}.rec.frames[${P('cluster')}.i]; return { old: f.s.nodes.find((x) => x.id === ${J(leader)}).role, viol: f.s.viol.length, logs: new Set(f.s.nodes.map((x) => JSON.stringify(x.log.slice(0, x.commit)))).size }; })()`);
  check(after.old === 'follower' && after.viol === 0, 'raft: after healing the old leader is a follower and safety holds ' + J(after));
  await shot(b, 'cluster-raft');
  // stepping back through the intervention and forward again shows the same frames
  const t1 = await b.eval(`${P('cluster')}.rec.frames.map((f) => f.t).join()`);
  await b.eval(`${P('cluster')}.go(10); ${P('cluster')}.go(${P('cluster')}.rec.last); 1`);
  check(await b.eval(`${P('cluster')}.rec.frames.map((f) => f.t).join()`) === t1, 'raft: going back and forth keeps the recording');
  // a crash from the node menu, in the past: the run is replayed from there
  await b.eval(`${P('cluster')}.go(40); 1`);
  await b.clickSel('.dock-pane:not([hidden]) .ck-node');
  check(await b.eval('!!document.querySelector(".menu")'), 'raft: clicking a node opens its menu');
  await b.eval(`[...document.querySelectorAll('.menu .menu-item')].find((x) => /Crash/.test(x.textContent)).click(); 1`);
  check(/crashes/.test(await what(b)), 'raft: the crash shows: ' + (await what(b)).slice(0, 60));
  check(await b.eval('document.querySelectorAll(".dock-pane:not([hidden]) .ck-node.down").length') === 1, 'raft: the crashed node is drawn down');

  // partitioning: consistent hashing moves only to the new node
  await scenario(b, 'partition', { table: 'booking', key: 'patron_id', scheme: 'consistent', n: 3, vnodes: 8 });
  await b.eval(`${P('cluster')}.go(${P('cluster')}.rec.last); 1`);
  const last = await b.eval(`${P('cluster')}.rec.frames[${P('cluster')}.i].s`);
  check(last.last && last.last.moved > 0 && last.last.tos.length === 1 && last.last.tos[0] === 'n4', 'partition: a joining node takes rows only for itself ' + J(last.last && [last.last.moved, last.last.tos]));
  const nBooking = await b.eval('K.UI.CK.theatre().tables.booking.rows.length');
  check(Object.values(last.sizes).reduce((a, c) => a + c, 0) === nBooking && last.last.hashWould > last.last.moved, 'partition: every row still placed once; hash mod n would move more');
  await shot(b, 'cluster-partition');
  await b.eval(`VIEW('cluster').stage.intervene({ kind: 'remove', id: 'n2' }); ${P('cluster')}.go(${P('cluster')}.rec.last); 1`);
  const rem = await b.eval(`${P('cluster')}.rec.frames[${P('cluster')}.i].s`);
  check(rem.nodes.length === 3 && !rem.nodes.includes('n2') && rem.last.froms.join() === 'n2', 'partition: a leaving node gives only its own rows');
  for (const scheme of ['round-robin', 'hash', 'range-width', 'range', 'virtual']) {
    await b.eval(`VIEW('cluster').scenario('partition', ${J({ table: 'patron', key: 'points', n: 4 })}); VIEW('cluster').scenario('partition', { scheme: ${J(scheme)} }); 1`);
    await b.waitFor(`VIEW('cluster').stage && VIEW('cluster').stage.player.rec.frames.length`, 30000);
    check(await b.eval(`${P('cluster')}.rec.frames[0].s.nodes.length`) === 4, 'partition: ' + scheme + ' on four nodes');
  }
  // 2PC: the coordinator decides and crashes; ready participants block and keep their locks
  await scenario(b, '2pc', { proto: '2pc', failure: 'coordinator-after-decision', restart: false, n: 3, target: 'P2' });
  await b.eval(`${P('cluster')}.go(${P('cluster')}.rec.last); 1`);
  const bl = await b.eval(`${P('cluster')}.rec.frames[${P('cluster')}.i].s.P`);
  check(Object.values(bl).every((p) => p.blocked !== null && p.locks), 'the 2PC participants are blocked and hold their row locks');
  await b.eval(`VIEW('cluster').stage.intervene({ kind: 'restart', id: 'C' }); ${P('cluster')}.go(${P('cluster')}.rec.last); 1`);
  const done = await b.eval(`${P('cluster')}.rec.frames[${P('cluster')}.i].s.P`);
  check(Object.values(done).every((p) => p.phase === 'committed' && !p.locks), '2PC: the restarted coordinator resends commit and unblocks ' + J(Object.values(done).map((p) => p.phase)));
  await shot(b, 'cluster-2pc');
  await scenario(b, '2pc', { proto: '3pc', failure: 'partition' });
  await scenario(b, 'deadlock', { variant: 'real' });
  await b.eval(`${P('cluster')}.go(${P('cluster')}.rec.last); 1`);
  check(await b.eval(`${P('cluster')}.rec.frames[${P('cluster')}.i].s.found`), 'deadlock: the detector finds the global cycle');
  await scenario(b, 'deadlock', { variant: 'false' });
  await b.eval(`${P('cluster')}.go(${P('cluster')}.rec.last); 1`);
  check(await b.eval(`!!${P('cluster')}.rec.frames[${P('cluster')}.i].s.det`), 'deadlock: delayed reports give a false cycle');
  // replication: async reads miss the client's writes; a session token fixes it
  await scenario(b, 'replication', { mode: 'async', readFrom: 'any', tokens: false, lag: 60, seed: 2 });
  await b.eval(`${P('cluster')}.go(${P('cluster')}.rec.last); 1`);
  check(await b.eval(`${P('cluster')}.rec.frames[${P('cluster')}.i].s.viol.some((v) => v.kind === 'ryw')`), 'replication: async breaks read-your-writes');
  await scenario(b, 'replication', { mode: 'async', readFrom: 'any', tokens: true, lag: 60, seed: 2 });
  await b.eval(`${P('cluster')}.go(${P('cluster')}.rec.last); 1`);
  check(await b.eval(`${P('cluster')}.rec.frames[${P('cluster')}.i].s.viol.length`) === 0, 'replication: the session token restores it');
  await scenario(b, 'quorum', { N: 5, R: 3, W: 3, repair: true, fanout: 'quorum', seed: 3 });
  await b.eval(`${P('cluster')}.go(${P('cluster')}.rec.last); 1`);
  check(await b.eval(`${P('cluster')}.rec.frames[${P('cluster')}.i].s.viol.length`) === 0, 'quorum: R + W > N gives no stale read');
  await scenario(b, 'cap', { mode: 'CP' });
  await b.eval(`${P('cluster')}.go(${P('cluster')}.rec.last); 1`);
  check(await b.eval(`Object.values(${P('cluster')}.rec.frames[${P('cluster')}.i].s.clients.c2.hist).some((h) => !h.ok)`), 'CAP: the CP minority is refused');
  await scenario(b, 'cap', { mode: 'AP', resolve: 'vv' });
  await b.eval(`${P('cluster')}.go(${P('cluster')}.rec.last); 1`);
  check(await b.eval(`Object.values(${P('cluster')}.rec.frames[${P('cluster')}.i].s.reps).every((v) => v.length === 2)`), 'CAP: AP with version vectors keeps both writes as siblings');
  await scenario(b, 'paxos', { acceptors: 3, proposers: 2, start: 'duel', loss: 0, seed: 1 });
  await b.eval(`${P('cluster')}.go(${P('cluster')}.rec.last); 1`);
  check(await b.eval(`${P('cluster')}.rec.frames[${P('cluster')}.i].s.learner !== null`), 'paxos: the learner learns a chosen value');
  await theme(b, 'dark');
  await scenario(b, 'raft');
  await shot(b, 'cluster-raft-dark');
  check(!errors(b).length, 'cluster: no console errors ' + J(errors(b).slice(0, 3)));
  await b.close();
}

// ---- Distributed query ---------------------------------------------------------------------------------------------------
{
  const b = await start(1440, 1000);
  await b.eval(`K.app.openView('dquery'); 1`);
  await b.waitFor(`VIEW('dquery').result.run`, 30000);
  const ex = ['join', 'coloc', 'three', 'agg', 'distinct', 'sort', 'topk', 'nonequi', 'ship'];
  for (const e of ex) {
    await b.eval(`document.querySelector('.dock-pane:not([hidden]) .ck-controls select').value = ${J(e)}; document.querySelector('.dock-pane:not([hidden]) .ck-controls select').dispatchEvent(new Event('change')); 1`);
    await b.sleep(80);
    await b.waitFor(`VIEW('dquery').result.run && document.querySelector('.dock-pane:not([hidden]) .dq-stage')`, 30000);
    const r = await b.eval(`(() => { const x = VIEW('dquery').result; return { err: x.err && x.err.message, same: !!document.querySelector('.dock-pane:not([hidden]) .ck-verdict.good'), steps: x.run.steps.length, kind: x.run.plan.kind, joins: (x.run.plan.joins || []).map((j) => j.strategy) }; })()`);
    check(!r.err && r.same && r.steps > 0, 'dquery ' + e + ': ' + J(r));
    if (e === 'coloc') check(r.joins.includes('co-located'), 'dquery: patron ⋈ booking is co-located');
    if (e === 'ship') check(r.kind === 'ship', 'dquery: a subquery is shipped whole');
  }
  await b.eval(`VIEW('dquery').run(${J('select c.city, count(*) from company c join artist a on c.company_id = a.company_id group by c.city order by c.city')}); 1`);
  await b.waitFor(`VIEW('dquery').result.run && VIEW('dquery').stage`, 30000);
  for (let k = 0; k < 5; k++) await b.clickSel('.dock-pane:not([hidden]) .ck-player button[title^="Step forward"]');
  check(await b.eval(`VIEW('dquery').stage.player.i`) === 5 && await b.eval('!!document.querySelector(".dock-pane:not([hidden]) .dq-stage.on")'), 'dquery: stepping lights the current stage');
  await b.clickSel('.dock-pane:not([hidden]) .ck-player button[title^="Step back"]');
  check(await b.eval(`VIEW('dquery').stage.player.i`) === 4, 'dquery: step back');
  await b.eval(`VIEW('dquery').compare(); 1`);
  await b.waitFor(`VIEW('dquery').result.cmp`, 30000);
  const cmp = await b.eval(`VIEW('dquery').result.cmp.map((x) => [x.name, x.same, x.r && x.r.stats.bytes])`);
  check(cmp.length >= 4 && cmp.every((x) => x[1] === true), 'dquery: every strategy gives the same result ' + J(cmp));
  check(new Set(cmp.map((x) => x[2])).size > 1, 'dquery: strategies ship different amounts');
  const semi = await b.eval(`VIEW('dquery').result.semi`);
  check(semi && semi.sameResult && semi.best === 'semijoin reduction', 'dquery: the semijoin wins on a selective condition');
  await b.eval(`VIEW('dquery').run(${J('select nosuch from artist')}); 1`);
  await b.waitFor(`VIEW('dquery').result.err`, 30000);
  check(await b.eval('!!document.querySelector(".dock-pane:not([hidden]) .res-err")'), 'dquery: an error is shown');
  await b.eval(`VIEW('dquery').run(${J('select company_id, count(*) from artist group by company_id order by company_id')}, { nodes: 3, place: 'rr' }); 1`);
  await b.waitFor(`VIEW('dquery').result.run && !VIEW('dquery').result.err`, 30000);
  check(await b.eval('!!document.querySelector(".dock-pane:not([hidden]) .ck-verdict.good")'), 'dquery: 3 nodes, round-robin, same result');
  await shot(b, 'dquery');
  check(!errors(b).length, 'dquery: no console errors ' + J(errors(b).slice(0, 3)));
  await b.close();
}

// ---- MapReduce -------------------------------------------------------------------------------------------------------------
{
  const b = await start(1440, 1000);
  await b.eval(`K.app.openView('mapreduce'); 1`);
  for (const [job, fail] of [['words', 'none'], ['join', 'map'], ['group', 'after'], ['bookings', 'restart']]) {
    await b.eval(`VIEW('mapreduce').set('job', ${J(job)}); VIEW('mapreduce').set('fail', ${J(fail)}); 1`);
    await b.waitFor(`VIEW('mapreduce').stage && document.querySelector('.dock-pane:not([hidden]) .mr-dag')`, 30000);
    for (let k = 0; k < 4; k++) await b.clickSel('.dock-pane:not([hidden]) .ck-player button[title^="Step forward"]');
    await b.clickSel('.dock-pane:not([hidden]) .ck-player button[title^="Step back"]');
    const mi = await b.eval(`VIEW('mapreduce').stage.player.i`);
    check(mi === 3, 'mapreduce ' + job + ': steps (' + mi + ')');
    await b.eval(`(() => { const p = VIEW('mapreduce').stage.player; while (p.src.extend()); p.go(p.rec.last); })(); 1`);
    const st = await b.eval(`(() => { const p = VIEW('mapreduce').stage.player; const s = p.rec.frames[p.i].s; return { phase: s.phase, re: s.counters.reexecuted, out: s.outN }; })()`);
    check(st.phase === 'done' && st.out > 0, 'mapreduce ' + job + ': the job finishes ' + J(st));
    if (fail === 'after') check(st.re >= 1, 'mapreduce: finished maps on the dead worker run again');
    check(await b.eval('document.querySelectorAll(".dock-pane:not([hidden]) .mr-matrix td").length') > 4, 'mapreduce ' + job + ': the shuffle matrix');
  }
  await b.eval(`[...document.querySelectorAll('.dock-pane:not([hidden]) button')].find((x) => /Lose worker/.test(x.textContent)).click(); 1`);
  check(await b.eval('/after losing w2/.test(document.querySelector(".dock-pane:not([hidden])").textContent)'), 'mapreduce: the Spark job recomputes after losing a worker');
  await shot(b, 'mapreduce');
  check(!errors(b).length, 'mapreduce: no console errors ' + J(errors(b).slice(0, 3)));
  await b.close();
}

// ---- Architectures -----------------------------------------------------------------------------------------------------------
{
  const b = await start(1440, 1000);
  await b.eval(`K.app.openView('arch'); 1`);
  for (const a of ['shared-memory', 'shared-disk', 'shared-nothing', 'hierarchical']) {
    await b.eval(`VIEW('arch').set('arch', ${J(a)}); 1`);
    check(await b.eval('document.querySelectorAll(".dock-pane:not([hidden]) .ar-chart .ln").length') === 8 && await b.eval('!!document.querySelector(".dock-pane:not([hidden]) .ar-diag .p")'), 'arch ' + a + ': diagram and curves');
  }
  const n0 = await b.eval(`VIEW('arch').opts.n`);
  await b.clickSel('.dock-pane:not([hidden]) .ar-stepper button[title="More processors"]');
  const n1 = await b.eval(`VIEW('arch').opts.n`);
  await b.clickSel('.dock-pane:not([hidden]) .ar-stepper button[title="Fewer processors"]');
  check(n1 > n0 && await b.eval(`VIEW('arch').opts.n`) === n0, 'arch: the stepper moves n forwards and back');
  for (const t of ['bus', 'ring', 'mesh', 'hypercube', 'tree', 'fat-tree']) { await b.eval(`VIEW('arch').set('topo', ${J(t)}); 1`); check(await b.eval('document.querySelectorAll(".dock-pane:not([hidden]) .ar-topo circle.p").length') >= 8, 'arch: topology ' + t); }
  await shot(b, 'arch');
  await theme(b, 'dark');
  await shot(b, 'arch-dark');
  check(!errors(b).length, 'arch: no console errors ' + J(errors(b).slice(0, 3)));
  await b.close();
}

// ---- phone width ---------------------------------------------------------------------------------------------------------
{
  const b = await start(390, 844);
  for (const v of ['cluster', 'dquery', 'mapreduce', 'arch']) {
    await b.eval(`K.app.openView(${J(v)}); 1`);
    await b.sleep(v === 'arch' ? 100 : 2500);
    const over = await b.eval(`(() => { const p = document.querySelector('.dock-pane:not([hidden])'); return [...p.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1 && !e.closest('.ck-tbl, .ck-logs, [style*="overflow"]')).length; })()`);
    check(over === 0, v + ' at 390 px: nothing sticks out (' + over + ')');
    await shot(b, v + '-phone');
  }
  check(!errors(b).length, 'phone: no console errors ' + J(errors(b).slice(0, 3)));
  await b.close();
}

console.log(passes + ' passed, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
