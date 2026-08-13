// The schedule workbench (chapters 17 and 18), with no database behind it: parse a schedule,
// written in one line ('r1(A) w1(A) r2(A) w2(B) c1 c2') or as a table with a column per transaction, and decide
// whether it is serial, conflict serializable (precedence graph, a cycle, a serial order by topological sort),
// view serializable (an exact search over serial orders, for small schedules), recoverable, cascadeless and
// strict, with the reasons. Then run it under two-phase locking (basic, strict, rigorous), timestamp ordering
// (with or without Thomas' write rule), validation and multiversion timestamp ordering, and report the waits,
// rollbacks and the schedule each protocol actually produces. Random schedules with their answers make exercises.
(function (root) {
  'use strict';
  const K = root.K = root.K || {};
  const SYN = K.STATE ? K.STATE.syntax || '42601' : '42601';
  const fail = (msg) => { throw (K.err ? K.err(SYN, msg) : new Error(msg)); };

  // ---- parsing and printing ------------------------------------------------------------------------------------
  const OPWORD = { r: 'r', read: 'r', w: 'w', write: 'w', c: 'c', commit: 'c', a: 'a', abort: 'a', rollback: 'a', s: 's', 'lock-s': 's', ls: 's', x: 'x', 'lock-x': 'x', lx: 'x', u: 'u', unlock: 'u' };
  /** one operation: r1(A), w2(B), c1, a3, read(A), write(B), commit, lock-S(A), unlock(A) */
  function parseOp(tok, colTx) {
    const t = tok.trim().replace(/\s+(?=[([])/g, '');
    if (!t) return null;
    let m = /^(read|write|lock-s|lock-x|unlock|ls|lx|r|w|s|x|u)_?(T?\d+|T\w+)?[([]\s*([^)\]]*?)\s*[)\]]$/i.exec(t);
    if (m && (m[2] !== undefined || colTx !== undefined)) {
      if (!m[3]) fail('"' + tok + '": no data item');
      return { tx: String(m[2] !== undefined ? m[2] : colTx).replace(/^T/i, ''), op: OPWORD[m[1].toLowerCase()], item: m[3] };
    }
    m = /^(commit|abort|rollback|c|a)_?(T?\d+|T\w+)?$/i.exec(t);
    if (m && (m[2] !== undefined || colTx !== undefined)) return { tx: String(m[2] !== undefined ? m[2] : colTx).replace(/^T/i, ''), op: OPWORD[m[1].toLowerCase()] };
    fail('cannot read "' + tok + '" as an operation (write r1(A), w1(A), c1, a1)');
  }
  function fromTable(text) {
    const rows = text.split(/\r?\n/).filter((l) => l.trim() && !/^[\s|:+-]+$/.test(l));
    // '| T1 | T2 |' has outer bars on every row; without them a row may start with an empty cell
    const outer = /^\s*\|/.test(rows[0]) && /\|\s*$/.test(rows[0]);
    const split = (l) => { const cells = l.split(/\||\t/); if (outer) { cells.shift(); cells.pop(); } return cells.map((c) => c.trim()); };
    let header = null;
    const first = split(rows[0]);
    if (first.every((c) => /^T?\w+$/i.test(c) && !/^(read|write|commit|abort|r|w|c|a)$/i.test(c)) && first.some((c) => /^T\w+$/i.test(c))) { header = first.map((c) => c.replace(/^T/i, '')); rows.shift(); }
    const ops = [];
    for (const l of rows) split(l).forEach((c, i) => { if (!c) return; for (const part of c.split(/[;,]\s*|\s{2,}/)) { const o = parseOp(part, header ? header[i] : String(i + 1)); if (o) ops.push(o); } });
    return ops;
  }
  /** a schedule from text (one line, or a table with a column per transaction), an array of operations, or a schedule */
  function parse(input) {
    if (input && input.ops) return make(input.ops);
    if (Array.isArray(input)) return make(input.map((o) => (typeof o === 'string' ? parseOp(o) : Object.assign({}, o, { tx: String(o.tx) }))));
    const text = String(input || '');
    if (/\||\t/.test(text)) return make(fromTable(text));
    const toks = text.replace(/\s+(?=[([])/g, '').split(/[\s,;]+/).filter(Boolean);
    return make(toks.map((t) => parseOp(t)).filter(Boolean));
  }
  function make(ops) {
    const txs = [];
    for (const o of ops) if (!txs.includes(o.tx)) txs.push(o.tx);
    return { ops: ops.map((o) => Object.assign({}, o)), txs };
  }
  const opText = (o) => (o.op === 'c' || o.op === 'a' ? o.op + o.tx : o.op + o.tx + '(' + o.item + ')');
  const format = (s) => parse(s).ops.map(opText).join(' ');
  /** the schedule as a table, a column per transaction, a row per operation */
  function table(s) {
    s = parse(s);
    const word = { r: 'read', w: 'write', s: 'lock-S', x: 'lock-X', u: 'unlock' };
    return { header: s.txs.map((t) => 'T' + t), rows: s.ops.map((o) => s.txs.map((t) => (t !== o.tx ? '' : o.op === 'c' ? 'commit' : o.op === 'a' ? 'abort' : word[o.op] + '(' + o.item + ')'))) };
  }

  // ---- projections and basic facts -------------------------------------------------------------------------------------
  const isData = (o) => o.op === 'r' || o.op === 'w';
  function ends(s) { const m = new Map(); s.ops.forEach((o, i) => { if ((o.op === 'c' || o.op === 'a') && !m.has(o.tx)) m.set(o.tx, { op: o.op, at: i }); }); return m; }
  /** the transactions a serializability test looks at: the committed ones, or every one when nothing ends */
  function projection(s, which) {
    const e = ends(s);
    if (which === 'all' || (which !== 'committed' && !e.size)) return s.txs.slice();
    return s.txs.filter((t) => e.get(t) && e.get(t).op === 'c');
  }
  function dataOps(s, txs) { const keep = new Set(txs); return s.ops.filter((o) => isData(o) && keep.has(o.tx)); }
  function isSerial(s) {
    s = parse(s);
    const ops = s.ops.filter((o) => o.op !== 's' && o.op !== 'x' && o.op !== 'u');
    const done = new Set();
    let cur = null;
    for (const o of ops) { if (o.tx !== cur) { if (done.has(o.tx)) return false; if (cur !== null) done.add(cur); cur = o.tx; } }
    return true;
  }
  const conflict = (a, b) => a.tx !== b.tx && a.item === b.item && (a.op === 'w' || b.op === 'w');

  // ---- conflict serializability ---------------------------------------------------------------------------------------
  function precedence(s, which) {
    s = parse(s);
    const txs = projection(s, which);
    const ops = dataOps(s, txs);
    const edges = new Map();
    for (let i = 0; i < ops.length; i++) for (let j = i + 1; j < ops.length; j++) {
      if (!conflict(ops[i], ops[j])) continue;
      const k = ops[i].tx + '>' + ops[j].tx;
      if (!edges.has(k)) edges.set(k, { from: ops[i].tx, to: ops[j].tx, reasons: [] });
      edges.get(k).reasons.push({ item: ops[i].item, first: opText(ops[i]), second: opText(ops[j]) });
    }
    return { nodes: txs, edges: [...edges.values()] };
  }
  function findCycle(g) {
    const adj = new Map(g.nodes.map((n) => [n, []]));
    for (const e of g.edges) adj.get(e.from).push(e.to);
    const color = new Map(), stack = [];
    let found = null;
    const dfs = (n) => {
      color.set(n, 1); stack.push(n);
      for (const m of adj.get(n)) {
        if (found) return;
        if (color.get(m) === 1) { found = stack.slice(stack.indexOf(m)).concat([m]); return; }
        if (!color.get(m)) dfs(m);
      }
      stack.pop(); color.set(n, 2);
    };
    for (const n of g.nodes) { if (!color.get(n)) dfs(n); if (found) break; }
    return found;
  }
  /** a topological order (ties broken by first appearance), or null when there is a cycle */
  function topo(g) {
    const indeg = new Map(g.nodes.map((n) => [n, 0]));
    for (const e of g.edges) indeg.set(e.to, indeg.get(e.to) + 1);
    const out = [], left = g.nodes.slice();
    while (left.length) {
      const i = left.findIndex((n) => indeg.get(n) === 0);
      if (i < 0) return null;
      const n = left.splice(i, 1)[0];
      out.push(n);
      for (const e of g.edges) if (e.from === n) indeg.set(e.to, indeg.get(e.to) - 1);
    }
    return out;
  }
  function serialOf(s, order) { s = parse(s); const ops = []; for (const t of order) for (const o of s.ops) if (o.tx === t && o.op !== 's' && o.op !== 'x' && o.op !== 'u') ops.push(o); return make(ops); }
  const T = (t) => 'T' + t;
  function conflictSerializable(s, which) {
    s = parse(s);
    const g = precedence(s, which);
    const cycle = findCycle(g);
    if (cycle) {
      const why = cycle.slice(0, -1).map((a, i) => { const b = cycle[i + 1]; const e = g.edges.find((x) => x.from === a && x.to === b); return e.reasons[0].first + ' before ' + e.reasons[0].second; });
      return { serializable: false, graph: g, cycle, order: null, explanation: 'Not conflict serializable: the precedence graph has the cycle ' + cycle.map(T).join(' -> ') + ' (' + why.join('; ') + ').' };
    }
    const order = topo(g);
    return { serializable: true, graph: g, cycle: null, order, serial: format(serialOf(s, order)), explanation: 'Conflict serializable: the precedence graph is acyclic' + (g.edges.length ? ' (' + g.edges.map((e) => T(e.from) + ' -> ' + T(e.to) + ' because ' + e.reasons[0].first + ' comes before ' + e.reasons[0].second).join('; ') + ')' : ', it has no edges') + ', so it is conflict equivalent to the serial schedule ' + order.map(T).join(', ') + '.' };
  }

  // ---- view serializability -----------------------------------------------------------------------------------------------
  /**
   * for each read: which write it reads, as the writer and which of its writes of the item (null: the initial
   * value); and each item's final write
   */
  function viewOf(ops) {
    const last = new Map(), reads = [], count = new Map(), writes = new Map();
    for (const o of ops) {
      const k = o.tx + '|' + o.item;
      if (o.op === 'r') { const n = (count.get(k) || 0) + 1; count.set(k, n); const w = last.get(o.item); reads.push({ tx: o.tx, item: o.item, n, from: w ? w.tx : null, write: w ? w.tx + '#' + w.n : null }); }
      else if (o.op === 'w') { const n = (writes.get(k) || 0) + 1; writes.set(k, n); last.set(o.item, { tx: o.tx, n }); }
    }
    const finals = new Map([...last].map(([i, w]) => [i, w.tx]));
    return { reads, finals };
  }
  function sameView(a, b) {
    if (a.finals.size !== b.finals.size) return false;
    for (const [k, v] of a.finals) if (b.finals.get(k) !== v) return false;
    const key = (r) => r.tx + '|' + r.item + '|' + r.n;
    const m = new Map(b.reads.map((r) => [key(r), r.write]));
    return a.reads.length === b.reads.length && a.reads.every((r) => m.has(key(r)) && m.get(key(r)) === r.write);
  }
  function* permutations(a) {
    if (a.length <= 1) { yield a.slice(); return; }
    for (let i = 0; i < a.length; i++) for (const p of permutations(a.slice(0, i).concat(a.slice(i + 1)))) yield [a[i]].concat(p);
  }
  const MAX_VIEW = 8;
  function viewSerializable(s, which) {
    s = parse(s);
    const txs = projection(s, which);
    const ops = dataOps(s, txs);
    const v = viewOf(ops);
    const blind = ops.filter((o, i) => o.op === 'w' && !ops.slice(0, i).some((p) => p.tx === o.tx && p.op === 'r' && p.item === o.item)).map(opText);
    if (txs.length > MAX_VIEW) return { serializable: null, order: null, blindWrites: blind, explanation: 'Too many transactions (' + txs.length + ') for the exact test, which tries every serial order; testing view serializability is NP-complete.' };
    for (const order of permutations(txs)) {
      const ser = order.flatMap((t) => ops.filter((o) => o.tx === t));
      if (sameView(v, viewOf(ser))) {
        const cs = conflictSerializable(s, which).serializable;
        return { serializable: true, order, serial: ser.map(opText).join(' '), blindWrites: blind, explanation: 'View serializable: view equivalent to the serial schedule ' + order.map(T).join(', ') + ' (every read reads from the same write, and every item has the same final writer).' + (!cs ? ' It is not conflict serializable: the blind writes ' + blind.join(', ') + ' make the difference.' : '') };
      }
    }
    const src = (r) => (r.from === null ? 'the initial value' : 'T' + r.from);
    return { serializable: false, order: null, blindWrites: blind, explanation: 'Not view serializable: no serial order of ' + txs.map(T).join(', ') + ' gives the same reads (' + v.reads.map((r) => 'r' + r.tx + '(' + r.item + ') reads ' + src(r)).join(', ') + ') and final writes (' + [...v.finals].map(([k, t]) => k + ' by T' + t).join(', ') + ').' };
  }

  // ---- recoverability -------------------------------------------------------------------------------------------------------
  /** each read of another transaction's write, aware of aborts: a write undone by an abort before the read does not count */
  function readsFrom(s) {
    s = parse(s);
    const out = [];
    const abortedAt = new Map();
    s.ops.forEach((o, i) => { if (o.op === 'a' && !abortedAt.has(o.tx)) abortedAt.set(o.tx, i); });
    s.ops.forEach((o, i) => {
      if (o.op !== 'r') return;
      for (let j = i - 1; j >= 0; j--) {
        const p = s.ops[j];
        if (p.op !== 'w' || p.item !== o.item) continue;
        if (abortedAt.has(p.tx) && abortedAt.get(p.tx) < i) continue;
        if (p.tx !== o.tx) out.push({ reader: o.tx, writer: p.tx, item: o.item, at: i, read: opText(o), write: opText(p) });
        break;
      }
    });
    return out;
  }
  function recoverable(s) {
    s = parse(s);
    const e = ends(s);
    const bad = [];
    for (const rf of readsFrom(s)) {
      const r = e.get(rf.reader), w = e.get(rf.writer);
      if (!r || r.op !== 'c') continue;
      if (!w || w.op !== 'c' || w.at > r.at) bad.push(Object.assign({}, rf, { why: 'T' + rf.reader + ' read ' + rf.item + ' written by T' + rf.writer + ' (' + rf.write + ' then ' + rf.read + ') and committed before T' + rf.writer + (w && w.op === 'a' ? ' aborted' : ' committed') }));
    }
    return { recoverable: !bad.length, violations: bad, explanation: bad.length ? 'Not recoverable: ' + bad[0].why + '.' : 'Recoverable: every transaction commits only after the transactions it read from have committed.' };
  }
  function cascadeless(s) {
    s = parse(s);
    const e = ends(s);
    const bad = [];
    for (const rf of readsFrom(s)) {
      const w = e.get(rf.writer);
      if (!w || w.op !== 'c' || w.at > rf.at) bad.push(Object.assign({}, rf, { why: 'T' + rf.reader + ' read ' + rf.item + ' (' + rf.read + ') before T' + rf.writer + ', which wrote it, committed' }));
    }
    return { cascadeless: !bad.length, violations: bad, explanation: bad.length ? 'Not cascadeless (cascading aborts are possible): ' + bad[0].why + '.' : 'Cascadeless: transactions read only committed data.' };
  }
  function strict(s) {
    s = parse(s);
    const bad = [];
    const endAt = new Map();
    s.ops.forEach((o, i) => { if ((o.op === 'c' || o.op === 'a') && !endAt.has(o.tx)) endAt.set(o.tx, i); });
    s.ops.forEach((o, i) => {
      if (!isData(o)) return;
      for (let j = 0; j < i; j++) {
        const p = s.ops[j];
        if (p.op !== 'w' || p.item !== o.item || p.tx === o.tx) continue;
        if (!endAt.has(p.tx) || endAt.get(p.tx) > i) { bad.push({ op: opText(o), after: opText(p), why: opText(o) + ' comes after ' + opText(p) + ' but before T' + p.tx + ' commits or aborts' }); break; }
      }
    });
    return { strict: !bad.length, violations: bad, explanation: bad.length ? 'Not strict: ' + bad[0].why + '.' : 'Strict: no transaction reads or writes an item until the last transaction that wrote it has ended.' };
  }
  /** everything the workbench says about a schedule */
  function classify(input) {
    const s = parse(input);
    const cs = conflictSerializable(s), vs = viewSerializable(s), rc = recoverable(s), ca = cascadeless(s), st = strict(s);
    return {
      schedule: format(s), transactions: s.txs, serial: isSerial(s),
      conflictSerializable: cs.serializable, viewSerializable: vs.serializable, recoverable: rc.recoverable, cascadeless: ca.cascadeless, strict: st.strict,
      precedence: cs.graph, cycle: cs.cycle, order: cs.order || vs.order, blindWrites: vs.blindWrites,
      explanations: { serial: isSerial(s) ? 'Serial: each transaction runs to the end before the next starts.' : 'Not serial: the transactions interleave.', conflict: cs.explanation, view: vs.explanation, recoverable: rc.explanation, cascadeless: ca.explanation, strict: st.explanation },
    };
  }

  // ---- protocols -------------------------------------------------------------------------------------------------------------
  /**
   * run a schedule under a protocol. The schedule gives the order in which the transactions ask for their
   * operations; a transaction that must wait keeps its later operations until it can go on. Returns the steps,
   * the schedule actually executed (final, with lock operations in withLocks), and what became of each transaction.
   * protocol: '2pl', 'strict2pl', 'rigorous2pl', 'to', 'thomas', 'validation' (or 'occ'), 'mvto'.
   * opts: { deadlock: 'detect' | 'wait-die' | 'wound-wait', ts: { tx: timestamp }, restart: true }
   */
  function simulate(input, protocol, opts) {
    opts = opts || {};
    const s = parse(input);
    const p = String(protocol).toLowerCase().replace(/[\s_-]/g, '');
    const kind = { '2pl': 'lock', basic2pl: 'lock', strict2pl: 'lock', rigorous2pl: 'lock', to: 'to', thomas: 'to', validation: 'occ', occ: 'occ', mvto: 'mvto' }[p];
    if (!kind) fail('unknown protocol "' + protocol + '" (2pl, strict2pl, rigorous2pl, to, thomas, validation, mvto)');
    const progs = new Map();
    for (const t of s.txs) progs.set(t, s.ops.filter((o) => o.tx === t && o.op !== 's' && o.op !== 'x' && o.op !== 'u'));
    // a transaction that never ends in the schedule commits after its last operation
    for (const [t, ops] of progs) if (!ops.some((o) => o.op === 'c' || o.op === 'a')) ops.push({ tx: t, op: 'c', implicit: true });
    const arrival = [];
    const seen = new Map();
    for (const o of s.ops) { if (o.op === 's' || o.op === 'x' || o.op === 'u') continue; const n = seen.get(o.tx) || 0; seen.set(o.tx, n + 1); arrival.push({ tx: o.tx, n }); }
    for (const [t, ops] of progs) { const n = seen.get(t) || 0; for (let i = n; i < ops.length; i++) arrival.push({ tx: t, n: i }); }
    const run = { steps: [], exec: [], withLocks: [], outcome: {}, waits: [], aborts: [], deadlocks: [], ignored: [] };
    const step = (tx, action, text, why) => run.steps.push({ tx, action, op: text, why: why || '' });
    const st = new Map(s.txs.map((t, i) => [t, { tx: t, pc: 0, avail: 0, ts: opts.ts && opts.ts[t] !== undefined ? opts.ts[t] : i + 1, status: 'active', waiting: null, reads: new Set(), writes: new Set(), start: null, validation: null, finish: null, deps: new Set(), local: [], name: t }]));
    let clock = 0;
    const engine = ({ lock: lockEngine, to: toEngine, occ: occEngine, mvto: mvtoEngine })[kind](run, st, progs, p, opts, step);
    const live = () => [...st.values()].filter((x) => x.status === 'active');
    // feed operations in arrival order; after each, let waiting transactions go on where they can
    const tryRun = () => {
      let moved = true;
      while (moved) {
        moved = false;
        for (const x of live()) {
          while (x.status === 'active' && x.pc < x.avail) {
            const o = progs.get(x.tx)[x.pc];
            const r = engine.exec(x, o, ++clock);
            if (r === 'wait') break;
            x.pc++;
            moved = true;
          }
        }
        if (!moved && engine.stuck) moved = engine.stuck(live());
      }
    };
    for (const a of arrival) {
      const x = st.get(a.tx);
      if (x.status !== 'active') continue;
      x.avail = Math.max(x.avail, a.n + 1);
      tryRun();
    }
    tryRun();
    for (const x of st.values()) run.outcome[x.tx] = x.status === 'active' ? 'blocked' : x.status;
    const final = make(run.exec);
    run.final = format(final);
    run.withLocks = run.withLocks.map(opText).join(' ');
    run.serializable = conflictSerializable(final, 'committed');
    run.protocol = p;
    return run;
  }
  function abortTx(run, st, x, why, step) {
    if (x.status !== 'active') return;
    x.status = 'aborted';
    run.exec.push({ tx: x.tx, op: 'a' });
    run.withLocks.push({ tx: x.tx, op: 'a' });
    run.aborts.push({ tx: x.tx, why });
    step(x.tx, 'abort', 'a' + x.tx, why);
    if (run.cleanup) run.cleanup(x);
    // anyone who read what x wrote before it ended goes too
    for (const y of st.values()) if (y.status === 'active' && y.deps.has(x.tx)) abortTx(run, st, y, 'cascading rollback: T' + y.tx + ' read data written by T' + x.tx, step);
    for (const y of st.values()) if (y.status === 'committed' && y.deps.has(x.tx)) run.unrecoverable = (run.unrecoverable || []).concat([{ tx: y.tx, from: x.tx }]);
  }

  /** two-phase locking: S and X locks on items, a lock point, deadlocks detected or prevented */
  function lockEngine(run, st, progs, p, opts, step) {
    const locks = new Map(); // item -> Map(tx -> 'S' | 'X')
    const release = p === '2pl' || p === 'basic2pl' ? 'all' : p === 'strict2pl' ? 'shared' : 'none';
    const policy = opts.deadlock || 'detect';
    const held = (item) => locks.get(item) || new Map();
    const lastWriter = new Map();
    // the lock point: after the last operation that needs a lock the transaction does not hold yet; past it, a
    // lock goes as soon as the transaction has made its last use of the item
    const lockPoint = new Map(), lastUse = new Map();
    for (const [t, ops] of progs) {
      const have = new Map(), last = new Map();
      let lp = -1;
      ops.forEach((o, i) => { if (!isData(o)) return; last.set(o.item, i); const need = o.op === 'r' ? 'S' : 'X'; const h = have.get(o.item); if (!h || (h === 'S' && need === 'X')) { have.set(o.item, need); lp = i; } });
      lockPoint.set(t, lp);
      lastUse.set(t, last);
    }
    const unlock = (x, item) => { const h = held(item); if (!h.has(x.tx)) return; h.delete(x.tx); run.withLocks.push({ tx: x.tx, op: 'u', item }); step(x.tx, 'release', 'u' + x.tx + '(' + item + ')'); };
    const unlockAll = (x, which) => { for (const [item, h] of locks) { const m = h.get(x.tx); if (m && (which === 'all' || m === which)) unlock(x, item); } };
    const blockers = (x, item, mode) => [...held(item)].filter(([t, m]) => t !== x.tx && (mode === 'X' || m === 'X')).map(([t]) => st.get(t));
    run.cleanup = (x) => unlockAll(x, 'all');
    const victim = (cycle) => cycle.reduce((a, b) => (b.ts > a.ts ? b : a));
    const cycleFrom = (x) => {
      const path = [];
      const dfs = (y) => { if (path.includes(y)) return path.slice(path.indexOf(y)); if (!y.waiting) return null; path.push(y); for (const h of y.waiting.on) { const c = dfs(h); if (c) return c; } path.pop(); return null; };
      return dfs(x);
    };
    return {
      exec(x, o) {
        if (o.op === 'c' || o.op === 'a') {
          if (o.op === 'c') {
            const d = [...x.deps].map((t) => st.get(t)).find((y) => y.status === 'active');
            if (d) { if (!x.waiting) { step(x.tx, 'wait', 'c' + x.tx, 'commit waits for T' + d.tx + ', whose uncommitted data it read'); run.waits.push({ tx: x.tx, on: [d.tx], op: 'c' + x.tx }); } x.waiting = { on: [d], op: o }; return 'wait'; }
            x.waiting = null;
            x.status = 'committed';
            run.exec.push(o); run.withLocks.push(o);
            step(x.tx, 'commit', 'c' + x.tx);
          } else abortTx(run, st, x, 'the schedule aborts it', step);
          unlockAll(x, 'all');
          return 'done';
        }
        const mode = o.op === 'r' ? 'S' : 'X';
        const h = held(o.item);
        const mine = h.get(x.tx);
        if (!(mine === 'X' || mine === mode)) {
          let b = blockers(x, o.item, mode);
          if (b.length && policy === 'wait-die' && b.some((y) => y.ts < x.ts)) { abortTx(run, st, x, 'wait-die: T' + x.tx + ' (timestamp ' + x.ts + ') is younger than T' + b.find((y) => y.ts < x.ts).tx + ', which holds ' + o.item + ', so it dies', step); unlockAll(x, 'all'); return 'done'; }
          if (b.length && policy === 'wound-wait') { for (const y of b.filter((y) => y.ts > x.ts)) { abortTx(run, st, y, 'wound-wait: older T' + x.tx + ' wounds T' + y.tx, step); unlockAll(y, 'all'); } b = blockers(x, o.item, mode); }
          if (b.length) {
            if (!x.waiting || x.waiting.op !== o) { step(x.tx, 'wait', opText(o), 'needs ' + mode + ' lock on ' + o.item + ', held by ' + b.map((y) => 'T' + y.tx).join(', ')); run.waits.push({ tx: x.tx, on: b.map((y) => y.tx), op: opText(o) }); }
            x.waiting = { on: b, op: o };
            if (policy === 'detect') {
              const c = cycleFrom(x);
              if (c) { const v = victim(c); run.deadlocks.push({ cycle: c.map((y) => y.tx), victim: v.tx }); abortTx(run, st, v, 'deadlock ' + c.map((y) => 'T' + y.tx).join(' -> ') + ' -> T' + c[0].tx + ': the youngest, T' + v.tx + ', is rolled back', step); unlockAll(v, 'all'); if (v === x) return 'done'; }
            }
            if (blockers(x, o.item, mode).length) return 'wait';
          }
          x.waiting = null;
          h.set(x.tx, mode);
          locks.set(o.item, h);
          run.withLocks.push({ tx: x.tx, op: mode === 'S' ? 's' : 'x', item: o.item });
          step(x.tx, 'grant', (mode === 'S' ? 's' : 'x') + x.tx + '(' + o.item + ')', mine ? 'upgrade S to X' : '');
        }
        x.waiting = null;
        // a read sees the last write; with basic 2PL that may be uncommitted (the writer let its lock go)
        if (o.op === 'r' && lastWriter.has(o.item)) { const w = st.get(lastWriter.get(o.item)); if (w.tx !== x.tx && w.status === 'active') x.deps.add(w.tx); }
        if (o.op === 'w') lastWriter.set(o.item, x.tx);
        run.exec.push(o); run.withLocks.push(o);
        step(x.tx, 'execute', opText(o));
        const i = progs.get(x.tx).indexOf(o);
        if (release !== 'none' && i >= lockPoint.get(x.tx)) {
          for (const [item, h2] of locks) { const m = h2.get(x.tx); if (m && lastUse.get(x.tx).get(item) <= i && (release === 'all' || m === 'S')) unlock(x, item); }
        }
        return 'done';
      },
      stuck(live) {
        // waits that no new operation can end: a commit waiting for an aborted writer, or a cycle of waits
        for (const x of live) if (x.waiting) { const c = cycleFrom(x); if (c) { const v = victim(c); run.deadlocks.push({ cycle: c.map((y) => y.tx), victim: v.tx }); abortTx(run, st, v, 'deadlock: the youngest, T' + v.tx + ', is rolled back', step); unlockAll(v, 'all'); return true; } }
        return false;
      },
    };
  }

  /** timestamp ordering: R- and W-timestamps per item; Thomas' write rule ignores obsolete writes */
  function toEngine(run, st, progs, p, opts, step) {
    const R = new Map(), W = new Map(), lastWriter = new Map();
    const thomas = p === 'thomas' || opts.thomas;
    return {
      exec(x, o) {
        if (o.op === 'c') {
          const d = [...x.deps].map((t) => st.get(t)).find((y) => y.status === 'active');
          if (d && opts.recoverable) { if (!x.waiting) step(x.tx, 'wait', 'c' + x.tx, 'commit waits for T' + d.tx); x.waiting = { on: [d], op: o }; return 'wait'; }
          x.status = 'committed'; run.exec.push(o); step(x.tx, 'commit', 'c' + x.tx); return 'done';
        }
        if (o.op === 'a') { abortTx(run, st, x, 'the schedule aborts it', step); return 'done'; }
        const r = R.get(o.item) || 0, w = W.get(o.item) || 0;
        if (o.op === 'r') {
          if (x.ts < w) { abortTx(run, st, x, opText(o) + ': TS(T' + x.tx + ') = ' + x.ts + ' < W-timestamp(' + o.item + ') = ' + w + ', rolled back', step); return 'done'; }
          R.set(o.item, Math.max(r, x.ts));
          if (lastWriter.has(o.item)) { const y = st.get(lastWriter.get(o.item)); if (y.tx !== x.tx && y.status === 'active') x.deps.add(y.tx); }
          run.exec.push(o); step(x.tx, 'execute', opText(o), 'R-timestamp(' + o.item + ') = ' + R.get(o.item));
          return 'done';
        }
        if (x.ts < r) { abortTx(run, st, x, opText(o) + ': TS(T' + x.tx + ') = ' + x.ts + ' < R-timestamp(' + o.item + ') = ' + r + ', rolled back', step); return 'done'; }
        if (x.ts < w) {
          if (thomas) { run.ignored.push(opText(o)); step(x.tx, 'ignore', opText(o), "Thomas' write rule: TS(T" + x.tx + ') = ' + x.ts + ' < W-timestamp(' + o.item + ') = ' + w + ', obsolete write ignored'); return 'done'; }
          abortTx(run, st, x, opText(o) + ': TS(T' + x.tx + ') = ' + x.ts + ' < W-timestamp(' + o.item + ') = ' + w + ', rolled back', step); return 'done';
        }
        W.set(o.item, x.ts); lastWriter.set(o.item, x.tx);
        run.exec.push(o); step(x.tx, 'execute', opText(o), 'W-timestamp(' + o.item + ') = ' + x.ts);
        return 'done';
      },
      stuck(live) { for (const x of live) if (x.waiting && x.waiting.on.every((y) => y.status !== 'active')) { x.waiting = null; return true; } return false; },
    };
  }

  /** validation: reads from the database, writes kept local until the transaction validates at its commit */
  function occEngine(run, st, progs, p, opts, step) {
    let clock = 0;
    const done = [];
    return {
      exec(x, o) {
        if (x.start === null) x.start = ++clock;
        if (o.op === 'r') { x.reads.add(o.item); run.exec.push(o); step(x.tx, 'execute', opText(o), 'read phase'); return 'done'; }
        if (o.op === 'w') { x.writes.add(o.item); x.local.push(o); step(x.tx, 'buffer', opText(o), 'read phase: written to a local copy'); return 'done'; }
        if (o.op === 'a') { abortTx(run, st, x, 'the schedule aborts it', step); return 'done'; }
        x.validation = ++clock;
        for (const k of done) {
          if (k.finish < x.start) continue;
          const clash = [...k.writes].filter((i) => x.reads.has(i));
          if (clash.length) { abortTx(run, st, x, 'validation fails: T' + k.tx + ' finished after T' + x.tx + ' started and wrote ' + clash.join(', ') + ', which T' + x.tx + ' read', step); return 'done'; }
        }
        step(x.tx, 'validate', 'v' + x.tx, 'validation succeeds');
        for (const w of x.local) { run.exec.push(w); step(x.tx, 'execute', opText(w), 'write phase'); }
        x.finish = ++clock;
        x.status = 'committed';
        run.exec.push(o);
        step(x.tx, 'commit', 'c' + x.tx);
        done.push(x);
        return 'done';
      },
    };
  }

  /** multiversion timestamp ordering: reads never wait or fail; a write fails when a younger transaction read the version it replaces */
  function mvtoEngine(run, st, progs, p, opts, step) {
    const versions = new Map(); // item -> [{ w, r, by }]
    const vs = (item) => { if (!versions.has(item)) versions.set(item, [{ w: 0, r: 0, by: null }]); return versions.get(item); };
    const pick = (item, ts) => vs(item).filter((v) => v.w <= ts).reduce((a, b) => (b.w > a.w ? b : a));
    run.versionReads = [];
    run.cleanup = (x) => { for (const [, l] of versions) for (let i = l.length - 1; i >= 0; i--) if (l[i].by === x.tx) l.splice(i, 1); };
    return {
      exec(x, o) {
        if (o.op === 'c') { x.status = 'committed'; run.exec.push(o); step(x.tx, 'commit', 'c' + x.tx); return 'done'; }
        if (o.op === 'a') { abortTx(run, st, x, 'the schedule aborts it', step); return 'done'; }
        const q = pick(o.item, x.ts);
        if (o.op === 'r') {
          q.r = Math.max(q.r, x.ts);
          if (q.by !== null && q.by !== x.tx && st.get(q.by).status === 'active') x.deps.add(q.by);
          run.exec.push(o);
          run.versionReads.push({ op: opText(o), version: q.by === null ? 'initial' : 'T' + q.by });
          step(x.tx, 'execute', opText(o), 'reads the version of ' + o.item + ' written by ' + (q.by === null ? 'nobody (the initial value)' : 'T' + q.by) + ' (W-timestamp ' + q.w + ')');
          return 'done';
        }
        if (x.ts < q.r) { abortTx(run, st, x, opText(o) + ': TS(T' + x.tx + ') = ' + x.ts + ' < R-timestamp of the version it replaces = ' + q.r, step); return 'done'; }
        if (q.w === x.ts && q.by === x.tx) { run.exec.push(o); step(x.tx, 'execute', opText(o), 'overwrites its own version'); return 'done'; }
        vs(o.item).push({ w: x.ts, r: x.ts, by: x.tx });
        run.exec.push(o);
        step(x.tx, 'execute', opText(o), 'creates a version of ' + o.item + ' with W-timestamp ' + x.ts);
        return 'done';
      },
    };
  }

  // ---- exercises --------------------------------------------------------------------------------------------------------------
  function rng(seed) { let a = (seed >>> 0) || 1; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  /** a random schedule: opts { txs: 3, items: ['A', 'B'], ops: [2, 4], commits: true, aborts: 0, seed } */
  function random(opts) {
    opts = opts || {};
    const rand = rng(opts.seed !== undefined ? opts.seed : Math.floor(Math.random() * 1e9));
    const n = opts.txs || 3;
    const items = opts.items || ['A', 'B', 'C'].slice(0, Math.max(2, Math.min(3, n)));
    const [lo, hi] = opts.ops || [2, 4];
    const progs = [];
    for (let t = 1; t <= n; t++) {
      const k = lo + Math.floor(rand() * (hi - lo + 1));
      const ops = [];
      for (let i = 0; i < k; i++) ops.push({ tx: String(t), op: rand() < 0.5 ? 'r' : 'w', item: items[Math.floor(rand() * items.length)] });
      if (opts.commits !== false) ops.push({ tx: String(t), op: rand() < (opts.aborts || 0) ? 'a' : 'c' });
      progs.push(ops);
    }
    const out = [];
    const pos = progs.map(() => 0);
    while (out.length < progs.reduce((a, p) => a + p.length, 0)) {
      const live = progs.map((p, i) => i).filter((i) => pos[i] < progs[i].length);
      const i = live[Math.floor(rand() * live.length)];
      out.push(progs[i][pos[i]++]);
    }
    return make(out);
  }
  /** an exercise: a random schedule, the questions, and the answers with their reasons */
  function exercise(opts) {
    const s = random(opts);
    const a = classify(s);
    return { schedule: format(s), table: table(s), questions: ['Is the schedule conflict serializable? If so, give an equivalent serial schedule.', 'Is it view serializable?', 'Is it recoverable? Cascadeless? Strict?'], answers: a };
  }

  K.Schedule = { parse, format, table, isSerial, precedence, findCycle, topo, conflictSerializable, viewSerializable, readsFrom, recoverable, cascadeless, strict, classify, simulate, random, exercise, serialOf: (s, order) => format(serialOf(s, order)) };
})(typeof window !== 'undefined' ? window : globalThis);
