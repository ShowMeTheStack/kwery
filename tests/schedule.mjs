// The schedule workbench: small schedules with known answers, protocol simulations, and brute-force oracles
// (Herbrand semantics for view serializability, swaps of adjacent non-conflicting operations for conflict
// serializability) on random small schedules.
import { load } from './load.mjs';
const K = load();
const Sc = K.Schedule;
let pass = 0, fail = 0;
const eq = (a, b, what) => { if (JSON.stringify(a) === JSON.stringify(b)) pass++; else { fail++; console.log('FAIL ' + what + '\n  expected ' + JSON.stringify(b) + '\n  got      ' + JSON.stringify(a)); } };
const props = (s) => { const c = Sc.classify(s); return { serial: c.serial, cs: c.conflictSerializable, vs: c.viewSerializable, rc: c.recoverable, aca: c.cascadeless, strict: c.strict }; };

// ---- parsing ------------------------------------------------------------------------------------------------------------
eq(Sc.format('r1(A) w1(A) r2(A) w2(B) c1 c2'), 'r1(A) w1(A) r2(A) w2(B) c1 c2', 'one-line schedule');
eq(Sc.format('R1(A), W1(A); r2 (A) commit2'), 'r1(A) w1(A) r2(A) c2', 'commas, capitals, spaces, commit words');
eq(Sc.format('rT1[X] wT2[X] cT1 aT2'), 'r1(X) w2(X) c1 a2', 'T-names and brackets');
eq(Sc.format('T1 | T2\nread(A) |\nwrite(A) |\n | read(A)\n | commit\ncommit |'), 'r1(A) w1(A) r2(A) c2 c1', 'a column per transaction');
eq(Sc.format('| T1 | T2 |\n|---|---|\n| read(A) | |\n| | write(A) |\n| commit | |\n| | commit |'), 'r1(A) w2(A) c1 c2', 'a Markdown-style table');
eq(Sc.format('T5\tT6\nread(B)\t\n\tread(B)\n\twrite(B)\nread(A)\t'), 'r5(B) r6(B) w6(B) r5(A)', 'a tab-separated table');
eq(Sc.parse('lock-S1(A) r1(A) unlock1(A)').ops.map((o) => o.op), ['s', 'r', 'u'], 'lock operations parse');
eq(Sc.table('r1(A) w2(A) c1').rows, [['read(A)', ''], ['', 'write(A)'], ['commit', '']], 'table output');
{ let err = null; try { Sc.parse('r1(A) x y z'); } catch (e) { err = e.message; } eq(/cannot read "x"/.test(err), true, 'a bad token is reported'); }

// ---- schedules worked by hand ---------------------------------------------------------------------------------------------
// a serial schedule of T1 then T2, and an interleaving that is conflict equivalent to it
eq(props('r1(A) w1(A) r1(B) w1(B) c1 r2(A) w2(A) r2(B) w2(B) c2'), { serial: true, cs: true, vs: true, rc: true, aca: true, strict: true }, 'serial');
// (T2 starts on Y first, but its read of X comes after T1's write of X)
const s3 = 'r2(Y) r1(X) w1(X) w2(Y) r2(X) w2(X) c1 c2';
eq(props(s3), { serial: false, cs: true, vs: true, rc: true, aca: false, strict: false }, 'conflict serializable');
eq(Sc.conflictSerializable(s3).order, ['1', '2'], 'equivalent to T1, T2');
eq(Sc.conflictSerializable(s3).serial, 'r1(X) w1(X) c1 r2(Y) w2(Y) r2(X) w2(X) c2', 'the serial schedule');
// an interleaving that is not serializable
const s4 = 'r1(X) r2(Y) w2(X) w1(Y) c1 c2';
const c4 = Sc.conflictSerializable(s4);
eq([c4.serializable, c4.cycle], [false, ['1', '2', '1']], 'a cycle T1 -> T2 -> T1');
eq(Sc.viewSerializable(s4).serializable, false, 'not view serializable either');
eq(Sc.precedence(s4).edges.map((e) => e.from + e.to).sort(), ['12', '21'], 'both edges');
// view serializable, not conflict serializable: T1 and T3 write Y without reading it, and T3's write is the last
const s8 = 'r2(Y) w1(Y) w2(Y) r3(X) w3(Y) c1 c2 c3';
const v8 = Sc.viewSerializable(s8);
eq([Sc.conflictSerializable(s8).serializable, v8.serializable, v8.order], [false, true, ['2', '1', '3']], 'blind writes: view but not conflict serializable');
eq(v8.blindWrites, ['w1(Y)', 'w3(Y)'], 'blind writes: identified');
// a schedule that is not recoverable, and one with a cascading rollback
eq(props('w2(B) r1(B) w1(A) c1 r2(C)').rc, false, 'not recoverable');
const s10 = 'w1(B) r2(B) r1(A) w2(C) r3(C) a1';
eq([props(s10).rc, props(s10).aca], [true, false], 'recoverable, but a cascading rollback');
eq(Sc.readsFrom(s10).map((r) => r.reader + '<-' + r.writer), ['2<-1', '3<-2'], 'who reads from whom');
eq(props('w1(A) w2(A) c1 c2'), { serial: false, cs: true, vs: true, rc: true, aca: true, strict: false }, 'cascadeless but not strict');
eq(props('w1(A) c1 r2(A) w2(A) c2').strict, true, 'strict');
eq(props('w1(A) r2(A) a1 c2').rc, false, 'reading from a transaction that aborts, then committing: not recoverable');
eq(props('w1(A) a1 r2(A) c2').aca, true, 'a write undone before the read does not count');
// the committed projection
eq(Sc.conflictSerializable('r1(A) w2(A) w1(A) a2 c1').serializable, true, 'the aborted transaction leaves the test');
eq(Sc.conflictSerializable('r1(A) w2(A) w1(A)').serializable, false, 'without commits every transaction counts');
// three transactions, an order found by topological sort
eq(Sc.conflictSerializable('r2(A) r1(B) w2(A) r3(A) w1(B) w3(A) r2(B) w2(B) c1 c2 c3').order, ['1', '2', '3'], 'topological order T1, T2, T3');
eq(Sc.conflictSerializable('w1(A) r2(A) w2(B) r3(B) w3(C) r1(C)').cycle, ['1', '2', '3', '1'], 'a three-cycle');

// ---- protocols ------------------------------------------------------------------------------------------------------------
{
  const s = 'r1(A) w1(A) r2(A) c1 w2(A) c2';
  eq(Sc.simulate(s, 'strict2pl').final, 'r1(A) w1(A) c1 r2(A) w2(A) c2', 'strict 2PL: the read of A waits for the commit');
  eq(Sc.simulate(s, '2pl').final, 'r1(A) w1(A) r2(A) c1 w2(A) c2', 'basic 2PL: T1 lets go at its lock point');
  eq(Sc.simulate(s, '2pl').withLocks, 's1(A) r1(A) x1(A) w1(A) u1(A) s2(A) r2(A) c1 x2(A) w2(A) u2(A) c2', 'basic 2PL: locks and unlocks');
  const d = Sc.simulate('r1(A) r2(B) w1(B) w2(A) c1 c2', 'strict2pl');
  eq([d.deadlocks.length, d.outcome], [1, { 1: 'committed', 2: 'aborted' }], '2PL: a deadlock, the younger transaction is the victim');
  eq(Sc.simulate('r1(A) r2(B) w1(B) w2(A) c1 c2', 'strict2pl', { deadlock: 'wait-die' }).outcome, { 1: 'committed', 2: 'aborted' }, 'wait-die: T2 dies');
  eq(Sc.simulate('r2(B) r1(A) w2(A) w1(B) c1 c2', 'strict2pl', { deadlock: 'wait-die' }).outcome, { 1: 'aborted', 2: 'committed' }, 'wait-die: T2 came first, so it is older and waits; T1 dies');
  eq(Sc.simulate('r2(B) r1(A) w2(A) w1(B) c1 c2', 'strict2pl', { deadlock: 'wait-die', ts: { 1: 1, 2: 2 } }).outcome, { 1: 'committed', 2: 'aborted' }, 'wait-die with given timestamps: T2 is younger and dies');
  eq(Sc.simulate('r1(A) r2(B) w2(A) w1(B) c1 c2', 'strict2pl', { deadlock: 'wound-wait' }).outcome, { 1: 'committed', 2: 'aborted' }, 'wound-wait: T1 wounds T2');
  const c = Sc.simulate('w1(A) r2(A) a1 c2', '2pl');
  eq(c.outcome, { 1: 'aborted', 2: 'aborted' }, 'basic 2PL: a cascading rollback');
  eq(Sc.simulate('w1(A) r2(A) a1 c2', 'strict2pl').final, 'w1(A) a1 r2(A) c2', 'strict 2PL: no cascading rollback');
}
{
  const s = 'r1(X) r2(Y) w2(X) w1(X) c1 c2';
  eq(Sc.simulate(s, 'to').outcome, { 1: 'aborted', 2: 'committed' }, 'TO: T1 writes an obsolete value and rolls back');
  const t = Sc.simulate(s, 'thomas');
  eq([t.outcome, t.ignored, t.final], [{ 1: 'committed', 2: 'committed' }, ['w1(X)'], 'r1(X) r2(Y) w2(X) c1 c2'], "Thomas' write rule ignores it");
  eq(Sc.simulate('r2(A) r1(A) w1(A) c1 c2', 'to', { ts: { 1: 1, 2: 2 } }).outcome, { 1: 'aborted', 2: 'committed' }, 'TO: a write after a younger read');
  eq(Sc.simulate('r1(A) w2(A) r1(A) c1 c2', 'to', { ts: { 1: 1, 2: 2 } }).outcome, { 1: 'aborted', 2: 'committed' }, 'TO: a read after a younger write');
}
{
  // validation: T1 only reads X and Y, T2 updates Y and Z; T1 validates first and both commit
  const v = Sc.simulate('r1(X) r2(Y) w2(Y) r2(Z) w2(Z) r1(Y) c1 c2', 'validation');
  eq([v.outcome, v.final], [{ 1: 'committed', 2: 'committed' }, 'r1(X) r2(Y) r2(Z) r1(Y) c1 w2(Y) w2(Z) c2'], 'validation: writes wait for the write phase');
  eq(Sc.simulate('r1(A) r2(A) w2(A) c2 w1(A) c1', 'validation').outcome, { 1: 'aborted', 2: 'committed' }, 'validation: T1 read what T2 wrote');
}
{
  const m = Sc.simulate('r1(A) w2(A) r1(A) c1 c2', 'mvto');
  eq([m.outcome, m.versionReads.map((x) => x.version)], [{ 1: 'committed', 2: 'committed' }, ['initial', 'initial']], 'MVTO: T1 keeps reading the old version');
  eq(Sc.simulate('r2(A) w1(A) c1 c2', 'mvto', { ts: { 1: 1, 2: 2 } }).outcome, { 1: 'aborted', 2: 'committed' }, 'MVTO: a write under a younger read fails');
}

// ---- oracles on random schedules ----------------------------------------------------------------------------------------
/** Herbrand semantics: a write's value is a term over everything its transaction read so far */
function herbrand(ops) {
  const state = new Map(), reads = new Map(), count = new Map();
  for (const o of ops) {
    if (!reads.has(o.tx)) reads.set(o.tx, []);
    if (o.op === 'r') reads.get(o.tx).push(o.item + '=' + (state.get(o.item) || o.item + '0'));
    else if (o.op === 'w') { const k = (count.get(o.tx) || 0) + 1; count.set(o.tx, k); state.set(o.item, 'f' + o.tx + '_' + k + '(' + reads.get(o.tx).join(',') + ')'); }
  }
  return JSON.stringify([[...reads].sort(), [...state].sort()]);
}
function* perms(a) { if (a.length <= 1) { yield a.slice(); return; } for (let i = 0; i < a.length; i++) for (const p of perms(a.slice(0, i).concat(a.slice(i + 1)))) yield [a[i]].concat(p); }
const dataOf = (s) => s.ops.filter((o) => o.op === 'r' || o.op === 'w');
function oracleVS(s) {
  const ops = dataOf(s);
  const h = herbrand(ops);
  for (const p of perms(s.txs)) if (herbrand(p.flatMap((t) => ops.filter((o) => o.tx === t))) === h) return true;
  return false;
}
/** conflict serializable iff swapping adjacent non-conflicting operations of different transactions reaches a serial schedule */
function oracleCS(s) {
  const start = dataOf(s);
  const key = (ops) => ops.map((o) => o.op + o.tx + o.item).join(' ');
  const serial = (ops) => { const seen = new Set(); let cur = null; for (const o of ops) { if (o.tx !== cur) { if (seen.has(o.tx)) return false; if (cur !== null) seen.add(cur); cur = o.tx; } } return true; };
  const seen = new Set([key(start)]);
  const queue = [start];
  while (queue.length) {
    const ops = queue.shift();
    if (serial(ops)) return true;
    for (let i = 0; i + 1 < ops.length; i++) {
      const a = ops[i], b = ops[i + 1];
      if (a.tx === b.tx || (a.item === b.item && (a.op === 'w' || b.op === 'w'))) continue;
      const n = ops.slice(); n[i] = b; n[i + 1] = a;
      const k = key(n);
      if (!seen.has(k)) { seen.add(k); queue.push(n); }
    }
  }
  return false;
}
let agreeVS = 0, agreeCS = 0, vsNotCs = 0, protoOk = 0;
for (let seed = 1; seed <= 400; seed++) {
  const s = Sc.random({ seed, txs: 2 + (seed % 3), items: ['A', 'B'], ops: [1, 3] });
  if (dataOf(s).length > 9) continue;
  const c = Sc.classify(s);
  if (c.viewSerializable === oracleVS(s)) agreeVS++; else eq(c.viewSerializable, oracleVS(s), 'view serializability of ' + c.schedule);
  if (c.conflictSerializable === oracleCS(s)) agreeCS++; else eq(c.conflictSerializable, oracleCS(s), 'conflict serializability of ' + c.schedule);
  if (c.conflictSerializable && !c.viewSerializable) eq(true, false, 'conflict serializable implies view serializable: ' + c.schedule);
  if (c.viewSerializable && !c.conflictSerializable) { vsNotCs++; if (!c.blindWrites.length) eq(true, false, 'view but not conflict serializable needs a blind write: ' + c.schedule); }
  if (c.strict && !c.cascadeless) eq(true, false, 'strict implies cascadeless: ' + c.schedule);
  if (c.cascadeless && !c.recoverable) eq(true, false, 'cascadeless implies recoverable: ' + c.schedule);
  // every protocol finishes every transaction, and what the serializable ones produce is serializable
  let good = true;
  for (const p of ['2pl', 'strict2pl', 'rigorous2pl', 'to', 'thomas', 'validation', 'mvto']) {
    const r = Sc.simulate(s, p);
    if (Object.values(r.outcome).some((x) => x === 'blocked')) { good = false; eq(r.outcome, 'finished', p + ' leaves a transaction blocked: ' + c.schedule); }
    if (p !== 'mvto' && !r.serializable.serializable) { good = false; eq(r.final, 'serializable', p + ' produced a non-serializable schedule from ' + c.schedule); }
    if (p === 'strict2pl' || p === 'rigorous2pl') { const f = Sc.classify(r.final); if (!f.strict) { good = false; eq(r.final, 'strict', p + ' produced a schedule that is not strict'); } }
    if (p === 'mvto') {
      // multiversion serializable: each read sees what it would in the serial schedule in timestamp order
      const ts = s.txs.slice();
      const committed = ts.filter((t) => r.outcome[t] === 'committed');
      const last = new Map();
      const expect = new Map();
      for (const t of committed) for (const o of r.final ? Sc.parse(r.final).ops.filter((x) => x.tx === t) : []) { if (o.op === 'r') { const k = t + o.item; if (!expect.has(k)) expect.set(k, last.has(o.item) ? 'T' + last.get(o.item) : 'initial'); } if (o.op === 'w') last.set(o.item, t); }
      const fin = Sc.parse(r.final).ops;
      let ri = 0;
      for (const o of fin) { if (o.op !== 'r') continue; const v = r.versionReads[ri++]; const k = o.tx + o.item; const by = v.version === 'initial' ? null : v.version.slice(1); if (by !== null && r.outcome[by] !== 'committed') continue; if (committed.includes(o.tx) && expect.get(k) !== v.version && !fin.slice(0, fin.indexOf(o)).some((x) => x.tx === o.tx && x.op === 'w' && x.item === o.item)) { good = false; eq(v.version, expect.get(k), 'MVTO read ' + v.op + ' in ' + c.schedule); } }
    }
  }
  if (good) protoOk++;
}
eq(agreeVS > 300 && agreeCS > 300, true, 'oracles agree on the random schedules (' + agreeVS + ' view, ' + agreeCS + ' conflict)');
eq(vsNotCs > 0, true, 'some random schedules are view but not conflict serializable (' + vsNotCs + ')');
eq(protoOk > 300, true, 'protocols on random schedules (' + protoOk + ')');
{
  const x = Sc.exercise({ seed: 42, txs: 3 });
  eq(typeof x.schedule === 'string' && x.questions.length === 3 && typeof x.answers.conflictSerializable === 'boolean', true, 'an exercise has a schedule, questions and answers');
  eq(Sc.exercise({ seed: 42, txs: 3 }).schedule, x.schedule, 'exercises are reproducible from their seed');
}
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
