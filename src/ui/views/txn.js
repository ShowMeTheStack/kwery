// The transactions view: every tab's session as a lane on a time line, with what each transaction did as it
// happened (statements, reads and writes, waits and grants, deadlocks, rollbacks); the transaction state
// machine of each session; the lock table, the compatibility matrix and the wait-for graph; for MVCC the
// snapshots and, for a chosen row, its versions with who sees which and why; SSI's rw-antidependency graph;
// and the bookkeeping of the classic protocols (lock points, timestamps, validation phases, version lists).
// A scenario panel sets up the classic anomalies in two or three tabs and runs them a step at a time.
(function (root) {
  'use strict';
  const K = root.K;
  const UI = K.UI;
  const { h, s } = UI;

  const safe = (f, d) => { try { return f(); } catch (e) { return d; } };
  const quiet = (db, f) => { db.bus.muted++; try { return f(); } finally { db.bus.muted--; } };
  const truthy = (v) => v === true || ['on', 'true', '1', 'yes'].includes(String(v).toLowerCase());
  const PROTOS = [['mvcc', 'MVCC (PostgreSQL)'], ['2pl', 'Basic 2PL'], ['strict2pl', 'Strict 2PL'], ['rigorous2pl', 'Rigorous 2PL'], ['to', 'Timestamp ordering'], ['thomas', 'TO + Thomas\' rule'], ['occ', 'Validation (OCC)'], ['mvto', 'Multiversion TO'], ['mv2pl', 'Multiversion 2PL']];
  const ISOS = [['read committed', 'Read committed'], ['repeatable read', 'Repeatable read'], ['serializable', 'Serializable']];
  const DLS = [['detect', 'Deadlock detection'], ['wait-die', 'Wait-die'], ['wound-wait', 'Wound-wait'], ['timeout', 'Lock timeout']];
  const LOCKING = ['2pl', 'strict2pl', 'rigorous2pl', 'mv2pl'];
  const J = JSON.stringify;
  const protoName = (k) => (PROTOS.find((p) => p[0] === k) || [k, k])[1];

  // ---- the recorder: the bus events of every run, kept while a transactions or schedule view is open ----------------
  const KEEP = /^(xact\.(begin|commit|abort|assign)|lock\.(wait|grant|deadlock|timeout)|cc\.\w+|ssi\.\w+|heap\.(insert|update|delete|page)|runner\.done)$/;
  const copy = (d) => { const o = {}; for (const [k, v] of Object.entries(d || {})) o[k] = Array.isArray(v) ? v.slice() : v && typeof v === 'object' && 'b' in v && 'o' in v ? { b: v.b, o: v.o } : v; return o; };
  const Rec = {
    app: null, db: null, events: [], seq: 0, refs: 0, offBus: null, offApp: [], listeners: new Set(),
    tx: new Map(),    // transaction id -> { sid, implicit, iso, xid }
    xid: new Map(),   // xid -> transaction id
    names: new Map(), // session id -> tab name
    attach(app) {
      if (this.refs++) return;
      this.app = app;
      this.offApp = [app.on('db', () => this.bind(true)), app.on('beforeRun', (x) => { if (x && x.tab && x.tab.session) this.add('stmt', { sql: String(x.sql || '').trim() }, x.tab.session.id); })];
      this.bind(false);
    },
    detach() {
      if (--this.refs > 0) return;
      this.refs = 0;
      if (this.offBus) this.offBus();
      for (const f of this.offApp) f();
      this.offBus = null; this.offApp = []; this.app = null; this.db = null;
    },
    bind(reset) {
      if (this.offBus) this.offBus();
      if (reset) this.clear();
      this.db = this.app.db;
      this.offBus = this.db.bus.on('*', (d, t) => this.onEvent(t, d));
      if (reset) this.add('note', { text: 'A new database' });
    },
    clear() { this.events = []; this.tx.clear(); this.xid.clear(); this.emit(); },
    on(f) { this.listeners.add(f); return () => this.listeners.delete(f); },
    emit() { for (const f of this.listeners) f(); },
    name(sid) {
      const t = this.app && this.app.tabs.find((x) => x.session && x.session.id === sid);
      if (t) this.names.set(sid, t.name);
      return this.names.get(sid) || 'session ' + sid;
    },
    add(type, d, sid) {
      const e = { n: ++this.seq, type, d: d || {}, sid: sid === undefined ? null : sid, tx: K.currentSession && K.currentSession.tx ? K.currentSession.tx.id : null };
      if (sid !== null && sid !== undefined) this.name(sid);
      this.events.push(e);
      if (this.events.length > 6000) this.events.splice(0, 1000);
      this.emit();
      return e;
    },
    sidOfTx(id) { const t = this.tx.get(id); return t ? t.sid : null; },
    onEvent(type, d) {
      if (!KEEP.test(type)) return;
      d = d || {};
      const cur = K.currentSession && K.currentSession.id ? K.currentSession.id : null;
      // a page read counts only while a tab's statement is running (other views read pages too)
      if (type === 'heap.page') {
        const tab = this.app && this.app.tabs.find((t) => t.session === K.currentSession);
        if (!tab || !tab.runner || tab.runner.done || !K.currentSession.tx) return;
      }
      let sid = typeof d.session === 'number' ? d.session : d.tx !== undefined && this.tx.has(d.tx) ? this.tx.get(d.tx).sid : cur;
      const data = copy(d);
      if (type === 'xact.begin') this.tx.set(d.tx, { sid: d.session, implicit: !!d.implicit, iso: d.isolation, xid: 0 });
      else if (type === 'xact.assign') { const t = K.currentSession && K.currentSession.tx; if (t && !d.parent) { this.xid.set(d.xid, t.id); if (this.tx.has(t.id)) this.tx.get(t.id).xid = d.xid; } }
      else if (type === 'xact.commit' || type === 'xact.abort') { const t = this.tx.get(d.tx); if (t) data.implicit = t.implicit; if (d.xid) this.xid.set(d.xid, d.tx); }
      else if (type === 'lock.grant' && d.xid) this.xid.set(d.xid, d.tx);
      else if (type === 'cc.rollback' || type === 'cc.cascade') sid = this.sidOfTx(d.tx);
      else if (type === 'ssi.fail' || type === 'ssi.doom') sid = this.sidOfTx(d.tx) || cur;
      else if (type === 'runner.done') {
        // what the statements returned: the tab's runner has its results by now
        const tab = this.app && this.app.tabs.find((t) => t.session && t.session.id === d.session);
        const r = tab && tab.runner;
        if (r && r.done) {
          const res = r.results || (r.error && r.error.results) || [];
          data.out = res.map(summary);
          if (r.error) { data.code = r.error.code; data.err = r.error.message; data.detail = r.error.detail || ''; }
        }
      }
      this.add(type, data, sid);
    },
    /** what ran, as a schedule for the workbench: the protocol's own history, or one rebuilt from the events */
    schedule() {
      const db = this.app && this.app.db;
      if (db && db.protocol && db.protocol.history.length) return { text: db.protocol.schedule(), source: 'the ' + db.protocol.name + ' protocol\'s history' };
      // under MVCC there is no per-item history: rebuild one at page granularity, a read for each heap page a
      // statement scanned and a write for each page whose tuples it changed (index fetches leave no trace)
      const ops = [];
      const has = new Set();
      const add = (tx, op, item) => {
        const l = ops[ops.length - 1];
        if (l && l.tx === tx && l.op === op && l.item === item) return;
        if (op === 'r' && ops.some((o) => o.tx === tx && o.item === item && (o.op === 'r' || o.op === 'w') && ops.indexOf(o) >= ops.length - 3)) return;
        ops.push({ tx, op, item }); has.add(tx);
      };
      for (const e of this.events) {
        const d = e.d;
        const tx = e.tx !== null && e.tx !== undefined ? String(e.tx) : null;
        if (e.type === 'heap.page' && tx) add(tx, 'r', d.rel + '.p' + d.block);
        else if ((e.type === 'heap.insert' || e.type === 'heap.update' || e.type === 'heap.delete') && tx && d.tid) add(tx, 'w', d.rel + '.p' + d.tid.b);
        else if ((e.type === 'xact.commit' || e.type === 'xact.abort') && has.has(String(d.tx))) ops.push({ tx: String(d.tx), op: e.type === 'xact.commit' ? 'c' : 'a' });
      }
      return { text: ops.map((o) => (o.op === 'c' || o.op === 'a' ? o.op + o.tx : o.op + o.tx + '(' + o.item + ')')).join(' '), source: 'the pages each transaction read and wrote (MVCC keeps no per-row history of reads, so the items are heap pages)' };
    },
  };
  UI.TxnRecorder = Rec;

  function summary(r) {
    if (r && r.rows && r.cols) {
      if (r.rows.length <= 3 && r.cols.length <= 3) {
        const v = r.rows.map((row) => row.map((x, i) => (x === null || x === undefined ? 'NULL' : safe(() => UI.valueText(x, r.cols[i].type), String(x)))).join(', ')).join('; ');
        return r.rows.length ? v : '(no rows)';
      }
      return r.rows.length + ' rows';
    }
    return r ? r.tag : '';
  }

  // ---- small drawing helpers ------------------------------------------------------------------------------------------
  let markId = 0;
  let measureCtx = null;
  /** the width of a text in a font size (px), as the page's font draws it */
  function textW(t, px, bold) {
    if (!measureCtx) { try { measureCtx = document.createElement('canvas').getContext('2d'); } catch (e) { measureCtx = null; } }
    if (!measureCtx) return String(t).length * px * 0.58;
    const fam = (getComputedStyle(document.documentElement).getPropertyValue('--font') || '').trim() || 'sans-serif';
    measureCtx.font = (bold ? '700 ' : '400 ') + px + 'px ' + fam;
    return measureCtx.measureText(String(t)).width;
  }
  /** a label in at most two lines of about `max` characters, broken at spaces; longer ones end in an ellipsis */
  function wrap2(t, max) {
    t = String(t);
    if (t.length <= max) return [t];
    const words = t.split(' ');
    let a = '';
    while (words.length && (a + (a ? ' ' : '') + words[0]).length <= max) a += (a ? ' ' : '') + words.shift();
    if (!a) a = words.shift();
    let b = words.join(' ');
    if (b.length > max) b = b.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
    return b ? [a, b] : [a];
  }
  // geometry for the graph drawing
  const sub = (p, q) => ({ x: p.x - q.x, y: p.y - q.y });
  const len = (v) => Math.hypot(v.x, v.y) || 1;
  const boxHit = (a, b, pad) => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
  const segInBox = (p, q, b) => {
    // does the segment p-q meet the box? (clip it to the box, Liang-Barsky)
    let t0 = 0, t1 = 1;
    const dx = q.x - p.x, dy = q.y - p.y;
    for (const [pp, qq] of [[-dx, p.x - b.x], [dx, b.x + b.w - p.x], [-dy, p.y - b.y], [dy, b.y + b.h - p.y]]) {
      if (pp === 0) { if (qq < 0) return false; continue; }
      const t = qq / pp;
      if (pp < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
    }
    return t0 <= t1;
  };
  /** do the chords a-b and c-d of nodes at circle positions interleave (and so cross)? */
  const interleave = (a, b, c, d, n) => {
    if (a === c || a === d || b === c || b === d) return false;
    const inside = (x, lo, hi) => (lo < hi ? x > lo && x < hi : x > lo || x < hi);
    return inside(c, a, b) !== inside(d, a, b);
  };
  /**
   * the order of the nodes around the circle with the fewest crossings: each edge is a chord drawn inside the circle
   * or an arc around the outside, and chords on the same side that interleave cross. Exhaustive up to 8 nodes, then
   * by swapping neighbours while it helps. Returns { order, outside: Set of pair keys drawn outside }
   */
  function circleOrder(ids, pairs) {
    const n = ids.length;
    const cost = (order) => {
      const at = new Map(order.map((id, i) => [id, i]));
      const ch = pairs.map(([a, b]) => [at.get(a), at.get(b)]);
      // two pages: 2-colour the conflict graph of the chords (breadth first), then move single chords while that
      // removes crossings; the larger colour goes inside
      const span = (c) => { const d = Math.abs(c[0] - c[1]); return Math.min(d, n - d); };
      const m = ch.length;
      const conf = ch.map((c, i) => ch.map((d, j) => i !== j && span(c) > 1 && span(d) > 1 && interleave(c[0], c[1], d[0], d[1], n)));
      const page = new Array(m).fill(0);
      for (let i = 0; i < m; i++) {
        if (page[i] || span(ch[i]) <= 1) continue;
        page[i] = 1;
        const q = [i];
        while (q.length) { const x = q.shift(); for (let j = 0; j < m; j++) if (conf[x][j] && !page[j]) { page[j] = 3 - page[x]; q.push(j); } }
      }
      const clashes = (i, pg) => { let c = 0; for (let j = 0; j < m; j++) if (conf[i][j] && page[j] === pg) c++; return c; };
      for (let round = 0, moved = true; moved && round < 4; round++) {
        moved = false;
        for (let i = 0; i < m; i++) if (page[i] && clashes(i, 3 - page[i]) < clashes(i, page[i])) { page[i] = 3 - page[i]; moved = true; }
      }
      const ones = page.filter((x) => x === 1).length, twos = page.filter((x) => x === 2).length;
      if (twos > ones) for (let i = 0; i < m; i++) if (page[i]) page[i] = 3 - page[i];
      let cross = 0, out = 0, spread = 0;
      for (let i = 0; i < m; i++) {
        spread += span(ch[i]) - 1;
        if (page[i] === 2) out++;
        for (let j = i + 1; j < m; j++) if (conf[i][j] && page[i] === page[j]) cross++;
      }
      return { score: cross * 1000 + out * 10 + spread, page, cross };
    };
    let best = null;
    const consider = (order) => { const c = cost(order); if (!best || c.score < best.c.score) best = { order: order.slice(), c }; };
    if (n <= 8) {
      const rest = ids.slice(1);
      const perm = (k) => {
        if (k === rest.length) { consider([ids[0]].concat(rest)); return; }
        for (let i = k; i < rest.length; i++) { [rest[k], rest[i]] = [rest[i], rest[k]]; perm(k + 1); [rest[k], rest[i]] = [rest[i], rest[k]]; }
      };
      perm(0);
    } else {
      // start from a walk along the edges, then swap pairs while it helps
      const adj = new Map(ids.map((id) => [id, []]));
      for (const [a, b] of pairs) { adj.get(a).push(b); adj.get(b).push(a); }
      const order = [], seen = new Set();
      const walk = (id) => { if (seen.has(id)) return; seen.add(id); order.push(id); for (const m of adj.get(id)) walk(m); };
      for (const id of ids) walk(id);
      consider(order);
      for (let round = 0, better = true; better && round < 20; round++) {
        better = false;
        for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
          const o = best.order.slice();
          [o[i], o[j]] = [o[j], o[i]];
          const before = best.c.score;
          consider(o);
          if (best.c.score < before) better = true;
        }
      }
    }
    const at = new Map(best.order.map((id, i) => [id, i]));
    const outside = new Set();
    pairs.forEach(([a, b], i) => { if (best.c.page[i] === 2) outside.add(a + '\u0000' + b); });
    return { order: best.order, outside, at };
  }
  /**
   * a directed graph: nodes [{ id, label, sub, cls }], edges [{ from, to, label, cls }]; edges of class 'bad' are
   * drawn red (a cycle), 'acc' in the accent colour. The nodes sit on a circle in the order with the fewest
   * crossings; an edge that would cross another goes round the outside; an edge and its reverse are two curves;
   * labels go where they hit nothing. The drawing is as large as what it holds.
   */
  function digraph(nodes, edges, opts) {
    opts = opts || {};
    const n = nodes.length;
    const ids = nodes.map((nd) => nd.id);
    const has = new Set(ids);
    edges = edges.filter((e) => has.has(e.from) && has.has(e.to) && e.from !== e.to);
    // the nodes: big enough for their label and the line under it
    const LBL = 12, SUB = 10.5;
    const nodeText = nodes.map((nd) => {
      let l = String(nd.label);
      if (textW(l, LBL, true) > 64) { while (l.length > 2 && textW(l + '…', LBL, true) > 64) l = l.slice(0, -1); l += '…'; }
      return { l, sub: nd.sub ? String(nd.sub) : '' };
    });
    let r = 23;
    for (const t of nodeText) {
      r = Math.max(r, Math.hypot(textW(t.l, LBL, true) / 2 + 2, t.sub ? 10 : 7) + 2);
      if (t.sub) r = Math.max(r, Math.hypot(textW(t.sub, SUB) / 2 + 2, 17) + 2);
    }
    r = Math.min(40, Math.ceil(r));
    // the edge labels: one or two lines
    const lab = edges.map((e) => (e.label ? wrap2(e.label, 18) : []));
    const labW = lab.map((ls) => Math.max(0, ...ls.map((x) => textW(x, 10.5))));
    const maxLab = Math.max(0, ...labW);
    // pairs of nodes joined by an edge (either way), and where each goes
    const key = (a, b) => a + '\u0000' + b;
    const pairs = [];
    const pairOf = new Map();
    for (const e of edges) {
      const k1 = key(e.from, e.to), k2 = key(e.to, e.from);
      if (pairOf.has(k1) || pairOf.has(k2)) continue;
      pairOf.set(k1, pairs.length);
      pairs.push([e.from, e.to]);
    }
    const lay = n > 2 ? circleOrder(ids, pairs) : { order: ids, outside: new Set(), at: new Map(ids.map((id, i) => [id, i])) };
    const pos = new Map();
    let R = 0;
    const spread = opts.spread || 1;
    if (n === 1) pos.set(ids[0], { x: 0, y: 0, a: 0 });
    else if (n === 2) { const d = Math.max(200, 2 * r + maxLab + 60) * spread; R = d / 2; pos.set(lay.order[0], { x: -R, y: 0, a: Math.PI }); pos.set(lay.order[1], { x: R, y: 0, a: 0 }); }
    else {
      // neighbours far enough apart for a node, a gap and a label between them
      R = spread * Math.max(70, (2 * r + Math.max(72, Math.min(maxLab, 120) + 40)) / (2 * Math.sin(Math.PI / n)));
      lay.order.forEach((id, i) => { const a = -Math.PI / 2 + (2 * Math.PI * i) / n; pos.set(id, { x: R * Math.cos(a), y: R * Math.sin(a), a }); });
    }
    const centers = ids.map((id) => pos.get(id));
    // ---- the edges, as point lists from the edge of one node to the edge of the other
    const trim = (f, a, b) => {
      // the part of the curve f(t) outside both circles: from the edge of a to just before the edge of b
      const find = (c, rad, fromStart) => { let lo = 0, hi = 1; for (let k = 0; k < 30; k++) { const m = (lo + hi) / 2; const inside = len(sub(f(m), c)) < rad; if (fromStart ? inside : !inside) lo = m; else hi = m; } return (lo + hi) / 2; };
      const t0 = find(a, r, true), t1 = find(b, r + 2, false);
      const pts = [];
      for (let k = 0; k <= 32; k++) pts.push(f(t0 + ((t1 - t0) * k) / 32));
      return pts;
    };
    const clearOf = (pts, skip) => centers.every((c) => skip.includes(c) || pts.every((p) => len(sub(p, c)) > r + 7));
    const chord = (a, b, h) => {
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const d = sub(b, a), L = len(d);
      const c = { x: m.x - (d.y / L) * 2 * h, y: m.y + (d.x / L) * 2 * h };
      return (t) => ({ x: (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * c.x + t * t * b.x, y: (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * c.y + t * t * b.y });
    };
    // arcs round the outside: nested ones further out
    const outs = [];
    const arcSpan = (a, b) => { let d = b.a - a.a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
    const routes = edges.map((e) => {
      const a = pos.get(e.from), b = pos.get(e.to);
      const back = edges.some((f) => f.from === e.to && f.to === e.from);
      const pk = pairOf.has(key(e.from, e.to)) ? key(e.from, e.to) : key(e.to, e.from);
      if (lay.outside.has(pk)) { const o = { e, a, b, span: arcSpan(a, b), level: 1, back }; outs.push(o); return o; }
      if (back) { const L = len(sub(b, a)); const h = Math.max(10, Math.min(22, L * 0.1)); return { e, pts: trim(chord(a, b, h), a, b) }; }
      // straight, unless that runs into a node: then bend just enough, towards the middle first
      for (const h of [0, 14, -14, 26, -26, 40, -40, 56, -56]) {
        const pts = trim(chord(a, b, h), a, b);
        if (clearOf(pts, [a, b])) return { e, pts };
      }
      return { e, pts: trim(chord(a, b, 0), a, b) };
    });
    const within = (o, p) => { const s0 = Math.min(0, o.span), s1 = Math.max(0, o.span); const q = arcSpan(o.a, p); return q > s0 + 1e-6 && q < s1 - 1e-6; };
    outs.sort((x, y) => Math.abs(x.span) - Math.abs(y.span));
    outs.forEach((o, i) => {
      for (let j = 0; j < i; j++) {
        const p = outs[j];
        const same = (p.a === o.a && p.b === o.b) || (p.a === o.b && p.b === o.a);
        if (same || ((within(o, p.a) || p.a === o.a || p.a === o.b) && (within(o, p.b) || p.b === o.a || p.b === o.b))) o.level = Math.max(o.level, p.level + 1);
      }
      // out of the node, round a circle outside the others, and into the target: arcs further out leave and
      // arrive more steeply, so nested arcs never meet
      const Rout = R + r + 18 + 18 * (o.level - 1);
      const sg = Math.sign(o.span) || 1;
      const lean = Math.max(0.12, 0.6 - 0.16 * (o.level - 1));
      const polar = (rad, ang) => ({ x: rad * Math.cos(ang), y: rad * Math.sin(ang) });
      const onNode = (c, ang, k) => ({ x: c.x + k * Math.cos(ang), y: c.y + k * Math.sin(ang) });
      const reach = Rout - R;
      const step = (reach * Math.tan(lean) + r * 0.6 + 8) / Rout;
      const p0 = onNode(o.a, o.a.a + sg * lean, r), c0 = onNode(o.a, o.a.a + sg * lean, reach * 0.8), a0 = polar(Rout, o.a.a + sg * step);
      const p1 = onNode(o.b, o.b.a - sg * lean, r), c1 = onNode(o.b, o.b.a - sg * lean, reach * 0.8), a1 = polar(Rout, o.b.a - sg * step);
      const qb = (u, v, w, t) => ({ x: (1 - t) * (1 - t) * u.x + 2 * (1 - t) * t * v.x + t * t * w.x, y: (1 - t) * (1 - t) * u.y + 2 * (1 - t) * t * v.y + t * t * w.y });
      const pts = [];
      for (let k = 0; k <= 8; k++) pts.push(qb(p0, c0, a0, k / 8));
      const from = o.a.a + sg * step, to = o.a.a + o.span - sg * step;
      for (let k = 1; k < 24; k++) pts.push(polar(Rout, from + ((to - from) * k) / 24));
      for (let k = 0; k <= 8; k++) pts.push(qb(a1, c1, p1, k / 8));
      // stop short of the target's edge for the arrowhead
      const last = pts[pts.length - 1], prev = pts[pts.length - 2], dv = sub(last, prev), dl = len(dv);
      pts[pts.length - 1] = { x: last.x - (dv.x / dl) * 2, y: last.y - (dv.y / dl) * 2 };
      o.pts = pts;
    });
    // ---- the drawing
    const id = 'dgm' + ++markId;
    const marker = (cls) => s('marker', { id: id + cls, viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse', class: 'dg-arrow ' + cls }, s('path', { d: 'M0 0L10 5L0 10z' }));
    const svg = s('svg', { class: 'dg', role: 'img', 'aria-label': opts.label || 'graph' }, s('defs', null, marker('n'), marker('bad'), marker('acc')));
    const boxes = centers.map((c) => ({ x: c.x - r - 2, y: c.y - r - 2, w: 2 * r + 4, h: 2 * r + 4 }));
    const all = routes.map((x) => x.pts);
    const ext = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    const grow = (b) => { ext.x0 = Math.min(ext.x0, b.x); ext.y0 = Math.min(ext.y0, b.y); ext.x1 = Math.max(ext.x1, b.x + b.w); ext.y1 = Math.max(ext.y1, b.y + b.h); };
    boxes.forEach(grow);
    for (const pts of all) for (const p of pts) grow({ x: p.x - 4, y: p.y - 4, w: 8, h: 8 });
    const d = (pts) => pts.map((p, i) => (i ? 'L' : 'M') + p.x.toFixed(1) + ' ' + p.y.toFixed(1)).join('');
    for (const rt of routes) {
      const cls = rt.e.cls || 'n';
      svg.appendChild(s('path', { class: 'dg-e ' + cls, d: d(rt.pts), 'marker-end': 'url(#' + id + cls + ')' }));
    }
    // the edge labels: beside their own edge, clear of nodes, other edges and labels already placed
    const placed = [];
    let crowded = false;
    routes.forEach((rt, i) => {
      const ls = lab[i];
      if (!ls.length) return;
      const w = labW[i] + 4, hgt = ls.length * 13 + 1;
      const pts = rt.pts;
      let best = null;
      for (const t of [0.5, 0.44, 0.56, 0.38, 0.62, 0.32, 0.68, 0.26, 0.74, 0.2, 0.8, 0.14, 0.86]) {
        const k = Math.round(t * (pts.length - 1));
        const p = pts[k], q = pts[Math.min(pts.length - 1, k + 1)], o = pts[Math.max(0, k - 1)];
        const tg = sub(q, o), L = len(tg);
        const nx = -tg.y / L, ny = tg.x / L;
        for (const [side, more] of [[1, 0], [-1, 0], [1, 8], [-1, 8], [1, 18], [-1, 18]]) {
          const off = Math.abs(nx) * w / 2 + Math.abs(ny) * hgt / 2 + 4 + more;
          const b = { x: p.x + nx * side * off - w / 2, y: p.y + ny * side * off - hgt / 2, w, h: hgt };
          let bad = 0;
          for (const nb of boxes) if (boxHit(b, nb, 2)) bad += 10;
          for (const pb of placed) if (boxHit(b, pb, 2)) bad += 10;
          for (const other of all) for (let j = 1; j < other.length; j++) if (segInBox(other[j - 1], other[j], { x: b.x - 2, y: b.y - 2, w: b.w + 4, h: b.h + 4 })) { bad += 3; break; }
          const score = bad * 100 + Math.abs(t - 0.5) * 10 + (side < 0 ? 0.5 : 0) + more / 5;
          if (!best || score < best.score) best = { score, b };
        }
        if (best && best.score < 100) break;
      }
      const b = best.b;
      if (best.score >= 100) crowded = true;
      placed.push(b);
      grow(b);
      const cls = rt.e.cls || 'n';
      const tx = s('text', { class: 'dg-el ' + cls, x: b.x + b.w / 2, y: b.y + 10, 'text-anchor': 'middle' });
      ls.forEach((line, j) => tx.appendChild(s('tspan', { x: b.x + b.w / 2, dy: j ? 13 : 0 }, line)));
      if (ls.join(' ') !== rt.e.label) tx.appendChild(s('title', null, rt.e.label));
      svg.appendChild(tx);
    });
    nodes.forEach((nd, i) => {
      const p = pos.get(nd.id);
      const t = nodeText[i];
      const g = s('g', { class: 'dg-n ' + (nd.cls || '') });
      g.appendChild(s('circle', { cx: p.x, cy: p.y, r }));
      g.appendChild(s('text', { x: p.x, y: p.y + (t.sub ? 0 : 4), 'text-anchor': 'middle', class: 'dg-nl' }, t.l));
      if (t.sub) g.appendChild(s('text', { x: p.x, y: p.y + 13, 'text-anchor': 'middle', class: 'dg-ns' }, t.sub));
      if (t.l !== String(nd.label)) g.appendChild(s('title', null, nd.label + (nd.sub ? ', ' + nd.sub : '')));
      svg.appendChild(g);
    });
    // no room for a label: spread the nodes further apart and draw it again
    if (crowded && spread < 2) return digraph(nodes, edges, Object.assign({}, opts, { spread: spread * 1.2 }));
    const pad = 6;
    const W = Math.ceil(ext.x1 - ext.x0 + 2 * pad), H = Math.ceil(ext.y1 - ext.y0 + 2 * pad);
    svg.setAttribute('viewBox', (ext.x0 - pad).toFixed(1) + ' ' + (ext.y0 - pad).toFixed(1) + ' ' + W + ' ' + H);
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    // it shrinks to fit a narrow pane, but not below 80%, where its labels would be too small to read: the box scrolls
    svg.style.minWidth = Math.round(W * 0.8) + 'px';
    return h('div.dg-box', svg);
  }
  UI.digraph = digraph;
  /** the cycle through the graph's edges, as node ids, or null */
  function cycleOf(nodes, edges) {
    const adj = new Map(nodes.map((n) => [n, []]));
    for (const e of edges) if (adj.has(e.from)) adj.get(e.from).push(e.to);
    const color = new Map(), stack = [];
    let found = null;
    const dfs = (n) => { color.set(n, 1); stack.push(n); for (const m of adj.get(n) || []) { if (found) return; if (color.get(m) === 1) { found = stack.slice(stack.indexOf(m)); return; } if (!color.get(m)) dfs(m); } stack.pop(); color.set(n, 2); };
    for (const n of nodes) { if (!color.get(n)) dfs(n); if (found) break; }
    return found;
  }
  const inCycle = (cyc, a, b) => { if (!cyc) return false; const i = cyc.indexOf(a); return i >= 0 && cyc[(i + 1) % cyc.length] === b; };

  /** the states of a transaction (active, partially committed, committed, failed, aborted), with the current one lit */
  function stateMachine(cur) {
    const N = { active: [36, 56, 'active'], partial: [170, 20, 'partially committed'], failed: [170, 92, 'failed'], committed: [292, 20, 'committed'], aborted: [292, 92, 'aborted'] };
    const id = 'sm' + ++markId;
    const svg = s('svg', { class: 'sm', viewBox: '0 0 334 112', role: 'img', 'aria-label': 'Transaction state: ' + (cur ? N[cur][2] : 'no transaction yet') }, s('defs', null, s('marker', { id, viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '6', markerHeight: '6', orient: 'auto', class: 'dg-arrow n' }, s('path', { d: 'M0 0L10 5L0 10z' }))));
    const W = { active: 64, partial: 118, failed: 56, committed: 76, aborted: 68 };
    const edge = (a, b) => {
      const [x1, y1] = N[a], [x2, y2] = N[b];
      const sx = x1 + (x2 > x1 ? W[a] / 2 : 0), ex = x2 - (x2 > x1 ? W[b] / 2 + 2 : 0);
      const sy = x2 === x1 ? y1 + 12 : y1, ey = x2 === x1 ? y2 - 13 : y2;
      svg.appendChild(s('path', { class: 'sm-e', d: 'M' + (x2 === x1 ? x1 : sx) + ' ' + sy + ' L' + (x2 === x1 ? x2 : ex) + ' ' + ey, 'marker-end': 'url(#' + id + ')' }));
    };
    edge('active', 'partial'); edge('active', 'failed'); edge('partial', 'committed'); edge('partial', 'failed'); edge('failed', 'aborted');
    for (const [k, [x, y, l]] of Object.entries(N)) {
      const g = s('g', { class: 'sm-n' + (cur === k ? ' on ' + k : '') });
      g.appendChild(s('rect', { x: x - W[k] / 2, y: y - 11, width: W[k], height: 22, rx: 11 }));
      g.appendChild(s('text', { x, y: y + 4, 'text-anchor': 'middle' }, l));
      svg.appendChild(g);
    }
    return svg;
  }

  /** the compatibility matrix of a set of lock modes: conf[mode] lists the modes it conflicts with */
  function matrix(title, modes, conf, note, used) {
    const t = h('table.tx-mx', h('thead', h('tr', h('th', ''), modes.map((m) => h('th' + (used && used.has(m) ? '.use' : ''), m)))),
      h('tbody', modes.map((a) => h('tr', h('th' + (used && used.has(a) ? '.use' : ''), a), modes.map((b) => { const ok = !conf[a].includes(b); return h('td.' + (ok ? 'ok' : 'no'), { title: a + ' and ' + b + (ok ? ' are compatible' : ' conflict') }, ok ? '✓' : '✗'); })))));
    return h('div.tx-mxbox', h('h4', title), h('div.tx-scroll', t), note ? h('p.kv-small.muted', note) : null);
  }

  // ---- the view ---------------------------------------------------------------------------------------------------------
  function create(app, el) {
    Rec.attach(app);
    const SC = () => UI.TxnScenarios;
    const st = { tab: UI.store.get('txn.tab', 'scenarios'), sc: null, step: 0, pos: [], picked: null, ran: [], rel: null, chain: null, all: false, msg: null };
    const intro = h('div.kv-intro.tx-intro', { title: 'Show or hide the whole explanation', onclick: () => intro.classList.toggle('open') }, h('span.tx-it', h('b', 'Transactions and concurrency control. '), 'When transactions run at the same time, the concurrency-control scheme decides the order in which their reads and writes take effect, by making some wait for locks, rolling some back, or giving each its own snapshot, so that the outcome is that of some serial schedule. Each tab is a session: run statements in two tabs, or pick a scenario, and follow each transaction here.'));
    const head = h('div.view-head.tx-head');
    const bar = h('div.tx-scbar');
    const body = h('div.view-body.tx-body');
    el.appendChild(intro); el.appendChild(head); el.appendChild(bar); el.appendChild(body);
    let pending = false;
    const soon = () => { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; if (!el.hidden && el.isConnected) view.render(); }); };
    const offRec = Rec.on(soon);

    // ---- settings -----------------------------------------------------------------------------------------------------
    const cfg = () => {
      const ss = app.session ? app.session.settings : app.db.settings;
      const cc = app.db.protocol ? app.db.protocol.name : 'mvcc';
      const thomas = truthy(ss.thomas_write_rule);
      return { cc, thomas, proto: cc === 'to' && thomas ? 'thomas' : cc, iso: String(ss.default_transaction_isolation || 'read committed').replace('read uncommitted', 'read committed'), dl: String(ss.deadlock_handling || 'detect'), phantom: truthy(ss.phantom_protection) };
    };
    /** run SET statements in every tab's session; returns the first error */
    function setAll(stmts, tabs) {
      let err = null;
      for (const t of tabs || app.tabs) {
        if (!t.session) continue;
        for (const sql of stmts) { try { t.session.exec(sql); } catch (e) { err = err || e; } }
      }
      return err;
    }
    function setProto(p, ask) {
      const name = p === 'thomas' ? 'to' : p;
      const busy = app.tabs.filter((t) => t.session && t.session.tx);
      if ((app.db.protocol ? app.db.protocol.name : 'mvcc') !== name && busy.length) {
        const who = busy.map((t) => t.name).join(', ');
        if (ask) UI.confirm('Change the protocol?', 'The protocol cannot change while transactions run, and ' + who + (busy.length > 1 ? ' have' : ' has') + ' one open. Roll ' + (busy.length > 1 ? 'them' : 'it') + ' back and switch to ' + protoName(p) + '?', () => { rollbackAll(); setProto(p); view.render(); }, 'Roll back and switch');
        else UI.toast('Finish the open transactions first (' + who + '): the protocol cannot change while transactions run.', 'warn', 5000);
        return false;
      }
      const err = setAll(["set concurrency_control = '" + name + "'", 'set thomas_write_rule = ' + (p === 'thomas' ? 'on' : 'off')]);
      if (err) { UI.toast(err.message, 'err', 5000); return false; }
      Rec.add('note', { text: 'SET concurrency_control = \'' + name + '\'' + (name === 'to' ? ', thomas_write_rule = ' + (p === 'thomas' ? 'on' : 'off') : '') + ' in every tab' });
      return true;
    }
    function setIso(v) { setAll(["set default_transaction_isolation = '" + v + "'"]); Rec.add('note', { text: 'SET default_transaction_isolation = \'' + v + '\' in every tab (for the next transactions)' }); }
    function setDl(v) { setAll(["set deadlock_handling = '" + v + "'"]); Rec.add('note', { text: 'SET deadlock_handling = \'' + v + '\' in every tab' }); }
    const sel = (label, opts, value, on, cls) => h('label.tx-sel' + (cls ? '.' + cls : ''), { title: label }, h('select.inp', { 'aria-label': label, onchange: (e) => { on(e.target.value); app.updateStatus(); view.render(); } }, opts.map(([v, l]) => h('option', { value: v, selected: v === value }, l))));

    function drawHead() {
      const c = cfg();
      head.innerHTML = '';
      head.appendChild(h('div.tx-sels', sel('Concurrency-control protocol', PROTOS, c.proto, (v) => setProto(v, true), 'proto'), sel('Isolation level of new transactions', ISOS, c.iso, setIso), sel('Deadlock handling', DLS, c.dl, setDl)));
      const tabs = [['scenarios', 'Scenarios'], ['timeline', 'Timeline'], ['locks', 'Locks'], ['versions', 'Versions'], ['ssi', 'SSI'], ['protocol', 'Protocol']];
      head.appendChild(h('div.seg.tx-tabs', { role: 'tablist' }, tabs.map(([k, l]) => h('button' + (st.tab === k ? '.on' : ''), { type: 'button', role: 'tab', 'aria-selected': String(st.tab === k), dataset: { tab: k }, onclick: () => { st.tab = k; UI.store.set('txn.tab', k); view.render(); } }, l))));
    }

    // ---- labels -------------------------------------------------------------------------------------------------------
    const tabOf = (sid) => app.tabs.find((t) => t.session && t.session.id === sid);
    const sname = (sid) => (sid === null || sid === undefined ? '?' : Rec.name(sid));
    const txName = (id) => { const t = Rec.tx.get(id); return t && t.sid !== null ? sname(t.sid) : 'tx ' + id; };
    const txLabel = (id) => { const t = Rec.tx.get(id); return t && t.sid !== null ? sname(t.sid) + ' (tx ' + id + ')' : 'tx ' + id; };
    const xidLabel = (x) => { const t = Rec.xid.get(x); return t !== undefined ? txLabel(t) : 'xid ' + x; };
    const tidText = (t) => (t ? '(' + t.b + ',' + t.o + ')' : '');

    // ---- the time line --------------------------------------------------------------------------------------------------
    const KIND = (sql) => { const q = sql.replace(/^(\s|--[^\n]*\n)*/, '').toLowerCase(); return /^(begin|start)\b/.test(q) ? 'begin' : /^(commit|end)\b/.test(q) ? 'commit' : /^(rollback|abort)\b/.test(q) && !/^rollback\s+to\b/.test(q) ? 'rollback' : /^select\b/.test(q) && !/\bfor\s+(update|share|no key|key)\b/.test(q) ? 'read' : /^(insert|update|delete|merge|select)\b/.test(q) ? 'write' : 'other'; };
    function rowsOf(events) {
      const rows = [], waits = [], open = new Map(), lastStmt = new Map();
      const push = (r) => {
        if (r.sid !== null && r.sid !== undefined && open.has(r.sid) && r.kind !== 'wait') { const w = open.get(r.sid); w.to = rows.length; open.delete(r.sid); }
        rows.push(r);
        return r;
      };
      const merge = (e, kind, piece, extra) => {
        const last = rows[rows.length - 1];
        if (last && last.sid === e.sid && last.kind === kind && last.items && last.items.length < 40) { last.items.push(piece); return last; }
        return push(Object.assign({ n: e.n, sid: e.sid, kind, items: [piece] }, extra || {}));
      };
      for (const e of events) {
        const d = e.d;
        switch (e.type) {
          case 'note': push({ n: e.n, sid: null, kind: 'note', text: d.text }); break;
          case 'scenario': push({ n: e.n, sid: null, kind: 'scenario', text: d.text }); break;
          case 'stmt': lastStmt.set(e.sid, push({ n: e.n, sid: e.sid, kind: KIND(d.sql), text: d.sql.replace(/\s+/g, ' ') })); break;
          case 'lock.wait': {
            if (open.has(e.sid)) break;
            const by = d.holders ? d.holders.map(txName) : d.waitsFor ? [xidLabel(d.waitsFor)] : [];
            const r = push({ n: e.n, sid: e.sid, kind: 'wait', text: 'waits for ' + (d.mode ? d.mode + ' lock on ' : '') + (d.what || 'transaction ' + d.waitsFor), sub: by.length ? 'held by ' + by.join(', ') : '' });
            const w = { sid: e.sid, from: rows.indexOf(r), to: null, dl: false };
            waits.push(w); open.set(e.sid, w);
            break;
          }
          case 'lock.grant': if (open.has(e.sid)) push({ n: e.n, sid: e.sid, kind: 'grant', text: 'granted ' + d.mode + ' on ' + d.what }); break;
          case 'lock.timeout': push({ n: e.n, sid: e.sid, kind: 'error', text: 'lock timeout: gave up waiting for ' + (d.what || 'transaction ' + d.waitsFor) }); break;
          case 'lock.deadlock': {
            const cyc = d.cycle || [];
            for (const id of cyc) { const w = open.get(Rec.sidOfTx(id)); if (w) w.dl = true; }
            push({ n: e.n, sid: null, kind: 'deadlock', text: 'Deadlock: ' + cyc.concat(cyc.slice(0, 1)).map(txName).join(' → ') + '. The wait that closed the cycle fails: ' + sname(e.sid) + ' is rolled back.', cycle: cyc });
            break;
          }
          case 'heap.insert': merge(e, 'version', 'new version ' + tidText(d.tid), { rel: d.rel, tid: d.tid, pre: '' }); break;
          case 'heap.update': {
            // an UPDATE inserts the new version first, then marks the old one: show the pair as one change
            const last = rows[rows.length - 1];
            const k = last && last.sid === e.sid && last.kind === 'version' ? last.items.lastIndexOf('new version ' + tidText(d.newTid)) : -1;
            if (k >= 0) { last.items[k] = tidText(d.tid) + ' → ' + tidText(d.newTid); last.tid = d.newTid; last.pre = 'update '; } else merge(e, 'version', tidText(d.tid) + ' → ' + tidText(d.newTid), { rel: d.rel, tid: d.newTid, pre: 'update ' });
            break;
          }
          case 'heap.delete': merge(e, 'version', 'delete ' + tidText(d.tid), { rel: d.rel, tid: d.tid }); break;
          case 'runner.done': {
            const out = (d.out || []).filter(Boolean).join(' · ');
            const text = d.err ? 'ERROR ' + (d.code || '') + ': ' + d.err : out;
            const kind = d.err ? (d.code === '40P01' ? 'deadlock-err' : d.code === '40001' ? 'serial' : 'error') : 'result';
            const st0 = lastStmt.get(e.sid);
            const i = st0 ? rows.indexOf(st0) : -1;
            const later = i >= 0 && rows.slice(i + 1).some((r) => r.sid !== e.sid && r.sid !== null);
            const waited = open.has(e.sid) || (i >= 0 && rows.slice(i + 1).some((r) => r.sid === e.sid && (r.kind === 'wait' || r.kind === 'grant')));
            if (st0 && !later && !waited) { st0.result = text; st0.rkind = kind; }
            else push({ n: e.n, sid: e.sid, kind, text: (st0 && waited && !d.err ? 'went on: ' : '') + text });
            break;
          }
          case 'cc.grant': if (!d.waited) merge(e, 'locks', d.mode + '(' + d.item + ')', { pre: 'locks ' }); else if (!open.has(e.sid)) push({ n: e.n, sid: e.sid, kind: 'grant', text: 'granted ' + d.mode + ' on ' + d.item }); break;
          case 'cc.release': merge(e, 'release', d.mode + '(' + d.item + ')', { pre: 'released ' }); break;
          case 'cc.lockpoint': push({ n: e.n, sid: e.sid, kind: 'phase', text: 'lock point: the shrinking phase begins' + (d.released ? ' (' + d.released + ' released)' : '') }); break;
          case 'cc.read': merge(e, 'ts', 'r(' + d.item + ')' + (d.version !== undefined ? ' v' + d.version : '') + ' R-ts ' + d.rts, { pre: '' }); break;
          case 'cc.write': merge(e, 'ts', 'w(' + d.item + ')' + (d.version !== undefined ? ' v' + d.version : ' W-ts ' + d.wts), { pre: '' }); break;
          case 'cc.reject': push({ n: e.n, sid: e.sid, kind: 'serial', text: 'rejected (' + d.rule + '): ' + d.detail }); break;
          case 'cc.ignore': push({ n: e.n, sid: e.sid, kind: 'ignore', text: 'obsolete write of ' + d.item + ' ignored (Thomas\' write rule: W-ts ' + d.wts + ')' }); break;
          case 'cc.validate': push({ n: e.n, sid: e.sid, kind: d.ok ? 'phase' : 'serial', text: d.ok ? 'validation passed: write phase' : 'validation failed: ' + ((d.tests || []).find((t) => !t.ok) || {}).rule }); break;
          case 'cc.buffer': merge(e, 'local', d.item, { pre: 'local write ' }); break;
          case 'cc.cascade': push({ n: e.n, sid: e.sid, kind: 'abort', text: 'cascading rollback: it read uncommitted data of ' + txName(d.from) }); break;
          case 'cc.dirty': push({ n: e.n, sid: e.sid, kind: 'warn', text: 'dirty read: ' + d.item + ', written by ' + txName(d.from) + ', not committed' }); break;
          case 'cc.die': push({ n: e.n, sid: e.sid, kind: 'abort', text: 'wait-die: younger than ' + txName(d.holder) + ' (ts ' + d.holderTs + '), so it dies' }); break;
          case 'cc.wound': push({ n: e.n, sid: e.sid, kind: 'warn', text: 'wound-wait: wounds the younger ' + txName(d.victim) }); break;
          case 'cc.rollback': push({ n: e.n, sid: e.sid, kind: 'abort', text: 'rolled back' + (d.reason ? ': ' + d.reason : '') }); break;
          case 'cc.violation': push({ n: e.n, sid: e.sid, kind: 'error', text: '2PL violated: ' + d.mode + ' lock in the shrinking phase' }); break;
          case 'cc.predicate': push({ n: e.n, sid: e.sid, kind: 'info', text: 'predicate lock on ' + d.index + ': ' + (d.keys || []).join(', ') }); break;
          case 'cc.ts': push({ n: e.n, sid: e.sid, kind: 'info', text: 'commit timestamp ' + d.ts }); break;
          case 'cc.snapshot': push({ n: e.n, sid: e.sid, kind: 'info', text: 'reads a snapshot (ts-counter ' + d.ts + ')' }); break;
          case 'ssi.rw': push({ n: e.n, sid: e.sid, kind: 'info', text: 'rw-antidependency ' + txName(d.reader) + ' → ' + txName(d.writer) + (d.what ? ' on ' + d.what : '') }); break;
          case 'ssi.dangerous': push({ n: e.n, sid: null, kind: 'deadlock', text: 'Dangerous structure: ' + d.why }); break;
          case 'ssi.fail': push({ n: e.n, sid: e.sid, kind: 'serial', text: 'serialization failure: ' + d.reason }); break;
          default: break;
        }
      }
      return { rows, waits };
    }

    /** the sessions with something recorded, in tab order (closed tabs after) */
    function lanes() {
      const seen = new Set(Rec.events.filter((e) => e.sid !== null && e.type === 'stmt').map((e) => e.sid));
      if (st.sc) for (const t of scTabs(st.sc)) if (t && t.session) seen.add(t.session.id);
      const ids = app.tabs.filter((t) => t.session && seen.has(t.session.id)).map((t) => t.session.id);
      for (const sid of seen) if (!ids.includes(sid)) ids.push(sid);
      return ids;
    }
    /** the abstract state of a session's transaction */
    function stateOf(sid) {
      const t = tabOf(sid);
      const ses = t && t.session;
      if (ses && ses.tx) {
        const tx = ses.tx;
        if (tx.failed || tx.killed) return 'failed';
        const last = [...Rec.events].reverse().find((e) => e.sid === sid && e.type === 'stmt');
        if (ses.waiting && last && KIND(last.d.sql) === 'commit') return 'partial';
        return 'active';
      }
      const end = [...Rec.events].reverse().find((e) => e.sid === sid && (e.type === 'xact.commit' || e.type === 'xact.abort'));
      return end ? (end.type === 'xact.commit' ? 'committed' : 'aborted') : null;
    }
    const STATE_TEXT = { active: 'active', partial: 'partially committed', failed: 'failed', committed: 'committed', aborted: 'aborted' };

    function laneHead(sid) {
      const t = tabOf(sid);
      const ses = t && t.session;
      const tx = ses && ses.tx;
      const stv = stateOf(sid);
      return h('div.tx-lh' + (t && t === app.tab ? '.cur' : ''), { title: t ? 'Show tab ' + t.name : 'A closed tab' },
        h('button.tx-ln', { type: 'button', onclick: () => { if (t) app.selectTab(t.id); }, disabled: !t }, sname(sid)),
        h('span.tx-lm', tx ? 'tx ' + tx.id + (tx.xid ? ' · xid ' + tx.xid : '') + ' · ' + tx.isolation : t ? 'no transaction' : 'closed'),
        stv ? h('span.kv-badge.' + ({ active: 'acc', partial: 'acc', failed: 'no', committed: 'ok', aborted: 'no' }[stv]) + (ses && ses.waiting ? '.tx-waitb' : ''), ses && ses.waiting ? 'waiting' : STATE_TEXT[stv]) : null);
    }

    function drawTimeline() {
      const ids = lanes();
      const box = h('div.tx-tl');
      // the state machines first: one per session, the current state lit
      const sm = h('div.tx-sms');
      for (const sid of ids.filter((x) => tabOf(x)).slice(0, 4)) sm.appendChild(h('div.tx-sm', h('div.tx-smh', sname(sid), h('span.muted', ' ' + (STATE_TEXT[stateOf(sid)] || 'no transaction yet'))), stateMachine(stateOf(sid))));
      const { rows, waits } = rowsOf(Rec.events);
      const tools = h('div.kv-row.tx-tools', h('span.muted.kv-small', UI.plural(rows.length, 'entry', 'entries') + ' since the view opened'),
        h('div.grow'),
        UI.btn('share', 'To the schedule workbench', 'Turn what ran into a schedule (r1(A) w2(A) ...) and analyse it', () => app.openView('schedule', { replay: true }), 'small'),
        UI.btn('trash', 'Clear', 'Forget the recorded history', () => { Rec.clear(); view.render(); }, 'small'));
      if (ids.some((x) => tabOf(x))) box.appendChild(h('details.kv-card.tx-smcard', { open: UI.store.get('txn.sm', false), ontoggle: (e) => UI.store.set('txn.sm', e.target.open) }, h('summary', h('b', 'Transaction states'), h('span.muted', ' ' + ids.filter((x) => tabOf(x)).slice(0, 4).map((x) => sname(x) + ' ' + (STATE_TEXT[stateOf(x)] || 'not started')).join(' · '))), sm));
      box.appendChild(tools);
      if (!rows.length) { box.appendChild(h('div.empty', h('p', 'Nothing has run since this view opened.'), h('p.muted', 'Run statements in two tabs (BEGIN; ... in each), or set up a scenario: each tab becomes a lane here, with its operations in the order they happened.'), UI.btn('flask', 'Choose a scenario', null, () => { st.tab = 'scenarios'; view.render(); }, 'primary'))); return box; }
      const MAX = 400;
      const first = st.all ? 0 : Math.max(0, rows.length - MAX);
      const grid = h('div.tx-grid', { style: { gridTemplateColumns: '38px repeat(' + ids.length + ', minmax(150px, 1fr))' } });
      grid.appendChild(h('div.tx-gh.tx-t', '#'));
      for (const sid of ids) grid.appendChild(h('div.tx-gh', laneHead(sid)));
      if (first) grid.appendChild(h('div.tx-more', { style: { gridColumn: '1 / -1' } }, h('button.link', { type: 'button', onclick: () => { st.all = true; view.render(); } }, 'Show ' + first + ' earlier entries')));
      const live = new Set([...app.tabs].filter((t) => t.session && t.session.waiting).map((t) => t.session.id));
      for (let i = first; i < rows.length; i++) {
        const r = rows[i];
        grid.appendChild(h('div.tx-t', String(i + 1)));
        if (r.sid === null || r.sid === undefined || !ids.includes(r.sid)) {
          grid.appendChild(h('div.tx-span.' + r.kind, { style: { gridColumn: '2 / -1' } }, r.kind === 'deadlock' ? UI.icon('warn') : r.kind === 'scenario' ? UI.icon('flask') : UI.icon('info'), h('span', r.text)));
          continue;
        }
        for (const sid of ids) {
          const w = waits.find((x) => x.sid === sid && x.from <= i && (x.to === null ? live.has(sid) || i === x.from : i <= x.to));
          const wc = w ? (w.from === i ? '.ws' : w.to === i ? '.we' : '.wb') + (w.dl ? '.dl' : '') + (w.to === null ? '.live' : '') : '';
          if (sid !== r.sid) { grid.appendChild(h('div.tx-c' + wc)); continue; }
          grid.appendChild(h('div.tx-c' + wc, cellOf(r)));
        }
      }
      // a lane still waiting continues to the bottom
      const tail = ids.filter((sid) => live.has(sid));
      if (tail.length) {
        grid.appendChild(h('div.tx-t', ''));
        for (const sid of ids) grid.appendChild(h('div.tx-c' + (tail.includes(sid) ? '.wb.live' : ''), tail.includes(sid) ? h('span.tx-op.wait', UI.icon('clock'), h('span', 'still waiting')) : null));
      }
      box.appendChild(h('div.tx-scroll.tx-gridbox', grid));
      box.appendChild(h('div.st-legend.kv-small.tx-legend', h('span', h('i.tx-sw.read'), 'read'), h('span', h('i.tx-sw.write'), 'write'), h('span', h('i.tx-sw.version'), 'row versions'), h('span', h('i.tx-sw.wait'), 'waiting (bar)'), h('span', h('i.tx-sw.dl'), 'deadlock / failure'), h('span', h('i.tx-sw.commit'), 'commit')));
      return box;
    }
    function cellOf(r) {
      const ICON = { begin: 'run', commit: 'check', rollback: 'x', read: 'eye', write: 'format', other: 'cog', wait: 'clock', grant: 'lock', version: 'page', result: 'chev', error: 'warn', serial: 'warn', 'deadlock-err': 'warn', abort: 'x', locks: 'lock', release: 'lock', phase: 'flag', ts: 'clock', ignore: 'info', local: 'copy', warn: 'warn', info: 'info' };
      const text = r.items ? (r.kind === 'version' ? r.rel + ' ' : '') + (r.pre || '') + r.items.join(', ') : r.text;
      const op = h('div.tx-op.' + r.kind + (r.rkind && r.rkind !== 'result' ? '.failed' : ''), { title: text + (r.result ? '\n→ ' + r.result : '') },
        UI.icon(ICON[r.kind] || 'info'),
        h('div.tx-opb', r.kind === 'begin' || r.kind === 'commit' || r.kind === 'rollback' || r.kind === 'read' || r.kind === 'write' || r.kind === 'other' ? h('code', text) : h('span', text),
          r.sub ? h('div.tx-sub', r.sub) : null,
          r.result !== undefined ? h('div.tx-res.' + (r.rkind || 'result'), '→ ' + r.result) : null));
      if (r.kind === 'version' && r.rel && r.tid) { op.classList.add('click'); op.addEventListener('click', () => { st.rel = r.rel; st.chain = 'tid:' + r.tid.b + ',' + r.tid.o; st.tab = 'versions'; view.render(); }); op.title += '\nClick: show its versions'; }
      return op;
    }

    // ---- locks ------------------------------------------------------------------------------------------------------------
    function waitEdges() {
      const L = app.db.locks;
      const out = [];
      for (const t of app.tabs) {
        const tx = t.session && t.session.tx;
        if (!tx) continue;
        const w = L.waiting.get(tx);
        const hold = w ? w.holders : tx.waitXid ? safe(() => tx.waitXid(), []) : [];
        for (const hd of hold) out.push({ from: tx.id, to: hd.id, label: w ? w.mode + ' ' + (w.what || '') : 'its transaction' });
      }
      return out;
    }
    function drawLocks() {
      const box = h('div');
      const c = cfg();
      const L = app.db.locks;
      const list = L.describe().filter((e) => e.granted.length || e.queue.length);
      const txl = (x) => h('span.tx-who', txLabel(x.tx));
      const card = h('div.kv-card', h('h3', 'Lock table', h('span.muted', ' ' + UI.plural(list.length, 'object') + ' locked')));
      if (!list.length) card.appendChild(h('p.muted.kv-small', 'No locks are held. Start a transaction and read or write rows: ' + (c.cc === 'mvcc' ? 'under MVCC readers take no row locks, writers lock the rows they change (and every statement takes a weak lock on its table).' : 'under ' + c.cc + ' every read takes S, every write X, under intention locks on the table and the database.')));
      else {
        const kindName = { table: 'table', row: 'row', item: 'data item', granular: 'granule' };
        card.appendChild(h('div.tx-scroll', h('table.grid.small.tx-locks', h('thead', h('tr', h('th', 'Object'), h('th', 'Kind'), h('th', 'Granted'), h('th', 'Waiting (in order)'))),
          h('tbody', list.sort((a, b) => (b.queue.length - a.queue.length) || String(a.what).localeCompare(String(b.what))).map((e) => h('tr' + (e.queue.length ? '.q' : ''), h('td', h('code', e.what)), h('td', kindName[e.kind] || e.kind),
            h('td', e.granted.map((g) => h('span.tx-lk.g', txl(g), ' ', h('b', g.mode)))), h('td', e.queue.map((q) => h('span.tx-lk.w', txl(q), ' ', h('b', q.mode))))))))));
      }
      box.appendChild(card);
      // the wait-for graph, live; and the last deadlock found
      const edges = waitEdges();
      const nodes = [...new Set(edges.flatMap((e) => [e.from, e.to]))];
      const cyc = cycleOf(nodes, edges);
      const wf = h('div.kv-card', h('h3', 'Wait-for graph', h('span.muted', ' an edge Ti → Tj when Ti waits for a lock Tj holds; a cycle is a deadlock')));
      if (!edges.length) wf.appendChild(h('p.muted.kv-small', 'Nobody is waiting.'));
      else wf.appendChild(digraph(nodes.map((id) => ({ id, label: txName(id), sub: 'tx ' + id, cls: cyc && cyc.includes(id) ? 'bad' : '' })), edges.map((e) => Object.assign({}, e, { cls: inCycle(cyc, e.from, e.to) ? 'bad' : 'n' })), { label: 'wait-for graph' }));
      const dl = [...Rec.events].reverse().find((e) => e.type === 'lock.deadlock');
      if (dl) {
        const cy = dl.d.cycle || [];
        const victim = Rec.events.find((e) => e.n > dl.n && e.type === 'runner.done' && e.d.code === '40P01');
        wf.appendChild(h('h4', 'The last deadlock found'));
        wf.appendChild(digraph(cy.map((id) => ({ id, label: txName(id), sub: 'tx ' + id, cls: 'bad' })), cy.map((id, i) => ({ from: id, to: cy[(i + 1) % cy.length], cls: 'bad' })), { label: 'deadlock cycle' }));
        wf.appendChild(h('p.kv-small', 'The cycle ' + cy.concat(cy.slice(0, 1)).map(txName).join(' → ') + ' was found when the last of these waits began; that transaction (' + (victim ? sname(victim.sid) : sname(dl.sid)) + ') was rolled back with "deadlock detected", which breaks the cycle.'));
      }
      box.appendChild(wf);
      // the compatibility matrices of the scheme in use
      const used = new Set(list.flatMap((e) => e.granted.concat(e.queue).map((g) => g.mode)));
      const M = K.LOCK_MODES;
      const mx = h('div.kv-card', h('h3', 'Lock compatibility', h('span.muted', ' ✓ both may hold it at once; ✗ the second request waits')));
      if (LOCKING.includes(c.cc)) {
        mx.appendChild(matrix('Shared and exclusive locks on data items', ['S', 'X'], M.ICONF, 'Two-phase locking: a read needs S, a write X. An S lock is upgraded to X in place.', used));
        mx.appendChild(matrix('Multiple granularity (database, tables, rows)', M.GMODES, M.GCONF, 'Intention locks (IS, IX, SIX) on the database and a table say what the transaction locks further down.', used));
      } else {
        mx.appendChild(matrix('Row locks (UPDATE, DELETE, SELECT ... FOR ...)', ['key share', 'share', 'no key update', 'update'], M.RCONF, c.cc === 'mvcc' ? 'Readers take no row locks under MVCC: only writers, who lock the rows they change until they end.' : 'Timestamp ordering, validation and MVTO take no read or write locks; only a row whose new version is being written is locked against a second writer.', used));
        mx.appendChild(h('details.tx-det', h('summary', 'Table lock modes (PostgreSQL)'), matrix('Table locks', M.TABLE, M.TCONF, 'Every statement takes one: SELECT access share, UPDATE row exclusive, DDL access exclusive.', used)));
      }
      box.appendChild(mx);
      return box;
    }

    // ---- versions (MVCC) ------------------------------------------------------------------------------------------------------
    function userTables() { return safe(() => app.session.catalog.tables(['table']).filter((r) => !app.session.catalog.schema(r.schema).system), []); }
    /** every version of the table's rows, grouped into update chains */
    function chainsOf(rel) {
      const db = app.db;
      return quiet(db, () => {
        const heap = db.heap(rel);
        const vers = [];
        for (const t of heap.scan()) {
          const hd = K.Tuple.header(t.bytes);
          const vals = safe(() => K.Tuple.deform(t.bytes, rel.cols, {}), null);
          vers.push({ tid: { b: t.tid.b, o: t.tid.o }, h: hd, vals });
        }
        const key = (t) => t.b + ',' + t.o;
        const by = new Map(vers.map((v) => [key(v.tid), v]));
        const pointed = new Set();
        for (const v of vers) if (v.h.ctid.b !== v.tid.b || v.h.ctid.o !== v.tid.o) pointed.add(key(v.h.ctid));
        const chains = [];
        for (const v of vers) {
          if (pointed.has(key(v.tid))) continue;
          const c = [v];
          let cur = v;
          for (let k = 0; k < 60; k++) { const n = cur.h.ctid; if (n.b === cur.tid.b && n.o === cur.tid.o) break; const nx = by.get(key(n)); if (!nx || c.includes(nx)) break; c.push(nx); cur = nx; }
          chains.push(c);
        }
        return chains;
      });
    }
    const showVals = (rel, v) => (v.vals ? rel.cols.map((c, i) => [c, v.vals[i]]).filter(([c]) => !c.dropped).slice(0, 4).map(([c, x]) => (x === null || x === undefined ? 'NULL' : safe(() => UI.valueText(x, c.type), String(x)))).join(', ') : '?');
    /** the snapshot a session would read with now, and the transaction to judge with */
    function viewOf(ses) {
      const db = app.db;
      return quiet(db, () => {
        const tx = ses && ses.tx;
        if (!tx) return { snap: db.xact.snapshot(null), tx: null, fresh: true };
        const snap = tx.snapshot && tx.isolation !== 'read committed' ? tx.snapshot : db.xact.snapshot(tx.xid || null);
        return { snap, tx: Object.assign({}, tx, { cid: Infinity }), fresh: !tx.snapshot || tx.isolation === 'read committed' };
      });
    }
    const xstat = (x) => (x ? app.db.xact.status(x) : '');
    function snapStrip(snap) {
      const lo = Math.max(K.FIRST_XID, Math.min(snap.xmin, snap.xmax) - 2), hi = snap.xmax + 1;
      const cells = [];
      for (let x = Math.max(lo, hi - 14); x <= hi; x++) {
        const cls = x >= snap.xmax ? 'fut' : snap.xip.has(x) ? 'run' : app.db.xact.committed(x) ? 'com' : 'abt';
        cells.push(h('span.tx-xc.' + cls, { title: 'xid ' + x + ': ' + { fut: 'not started when the snapshot was taken (≥ xmax): invisible', run: 'in progress at the snapshot (in xip): invisible', com: 'committed before the snapshot: visible', abt: 'aborted: invisible' }[cls] }, String(x)));
      }
      return h('div.tx-xs', cells);
    }
    function drawVersions() {
      const box = h('div');
      const c = cfg();
      // snapshots
      const sc = h('div.kv-card', h('h3', 'Snapshots', h('span.muted', ' xmin: every xid below it had finished; xmax: no xid from it on had started; xip: the ones running in between')));
      const tb0 = h('tbody');
      for (const t of app.tabs) {
        if (!t.session) continue;
        const v = viewOf(t.session);
        const tx = t.session.tx;
        tb0.appendChild(h('tr', h('th', t.name, h('div.tx-sub', tx ? 'tx ' + tx.id + (tx.xid ? ', xid ' + tx.xid : ', no xid yet') : 'no transaction')),
          h('td.num', String(v.snap.xmin)), h('td.num', String(v.snap.xmax)), h('td', v.snap.xip.size ? '{' + [...v.snap.xip].join(', ') + '}' : '∅'), h('td', snapStrip(v.snap)),
          h('td.kv-small.muted.tx-wrap', !tx ? 'a new transaction would take this one' : tx.isolation === 'read committed' ? 'READ COMMITTED: a new one per statement (this is the next)' : tx.snapshot ? 'taken at its first statement, kept to the end' : 'not taken yet: at the first statement')));
      }
      sc.appendChild(h('div.tx-scroll', h('table.grid.small.tx-snaps', h('thead', h('tr', h('th', 'Session'), h('th', 'xmin'), h('th', 'xmax'), h('th', 'xip'), h('th', 'xids'), h('th', ''))), tb0)));
      sc.appendChild(h('div.st-legend.kv-small', h('span', h('i.tx-xc.com'), 'committed: visible'), h('span', h('i.tx-xc.run'), 'running (xip)'), h('span', h('i.tx-xc.abt'), 'aborted'), h('span', h('i.tx-xc.fut'), 'after xmax')));
      box.appendChild(sc);
      // a row's versions
      const rels = userTables();
      const card = h('div.kv-card', h('h3', 'A row\'s versions', h('span.muted', ' each UPDATE adds a version; xmin made it, xmax replaced or deleted it, ctid leads to the next')));
      if (!rels.length) { card.appendChild(h('p.muted', 'There are no tables yet.')); box.appendChild(card); return box; }
      let rel = rels.find((r) => r.name === st.rel) || rels.find((r) => r.name === 'acct') || rels[0];
      st.rel = rel.name;
      const chains = safe(() => chainsOf(rel), []);
      const chainKey = (ch) => 'tid:' + ch[0].tid.b + ',' + ch[0].tid.o;
      let ch = null;
      if (st.chain && st.chain.startsWith('tid:')) ch = chains.find((x) => x.some((v) => 'tid:' + v.tid.b + ',' + v.tid.o === st.chain));
      if (!ch && st.chain && st.chain.startsWith('key:')) ch = chains.find((x) => x.some((v) => v.vals && String(safe(() => K.T.output(v.vals[0], rel.cols[0].type), v.vals[0])) === st.chain.slice(4)));
      if (!ch) ch = chains[0];
      if (ch) st.chain = chainKey(ch);
      const pick = h('div.kv-row',
        h('label.tx-sel', h('span', 'Table'), h('select.inp', { 'aria-label': 'Table', onchange: (e) => { st.rel = e.target.value; st.chain = null; view.render(); } }, rels.map((r) => h('option', { value: r.name, selected: r === rel }, r.name)))),
        h('label.tx-sel.wide', h('span', 'Row'), h('select.inp.tx-rowsel', { 'aria-label': 'Row', onchange: (e) => { st.chain = e.target.value; view.render(); } }, chains.slice(0, 300).map((x) => h('option', { value: chainKey(x), selected: x === ch }, showVals(rel, x[x.length - 1]) + (x.length > 1 ? '  (' + x.length + ' versions)' : ''))))));
      card.appendChild(pick);
      if (!ch) { card.appendChild(h('p.muted', 'The table is empty.')); box.appendChild(card); return box; }
      const strip = h('div.tx-chain');
      ch.forEach((v, i) => {
        if (i) strip.appendChild(h('div.tx-arrow', { 'aria-hidden': 'true' }, 'ctid →'));
        const xm = v.h.xmax && !(v.h.infomask & K.Tuple.IM.XMAX_INVALID) ? v.h.xmax : 0;
        strip.appendChild(h('div.tx-ver', h('div.tx-vt', h('b', 'Version ' + (i + 1)), h('button.kv-link', { type: 'button', title: 'Open this tuple in the storage view', onclick: () => app.openView('storage', { rel: rel.oid, tid: v.tid }) }, tidText(v.tid))),
          h('div.tx-vv', h('code', showVals(rel, v))),
          h('div.tx-vf', h('span', 'xmin ', h('b', String(v.h.xmin)), h('span.tx-xst.' + xstat(v.h.xmin).replace(/\W/g, ''), xstat(v.h.xmin))), h('span', 'xmax ', h('b', String(xm || 0)), xm ? h('span.tx-xst.' + xstat(xm).replace(/\W/g, ''), xstat(xm) + (v.h.infomask & K.Tuple.IM.XMAX_LOCK_ONLY ? ', lock only' : '')) : h('span.tx-xst', 'none'))),
          h('div.tx-vf', h('span', 'ctid ', h('b', tidText(v.h.ctid))))));
      });
      card.appendChild(h('div.tx-scroll', strip));
      // who sees which version, and why
      const vt = h('table.grid.small.tx-vis', h('thead', h('tr', h('th', 'Session'), ch.map((v, i) => h('th', 'Version ' + (i + 1) + ' ' + tidText(v.tid))))));
      const tb = h('tbody');
      for (const t of app.tabs) {
        if (!t.session) continue;
        const v = viewOf(t.session);
        tb.appendChild(h('tr', h('th', t.name, h('div.tx-sub', t.session.tx ? 'tx ' + t.session.tx.id : 'fresh snapshot')),
          ch.map((ver) => { const r = safe(() => app.db.xact.satisfies(ver.h, v.tx, v.snap), { visible: false, why: '?' }); return h('td.' + (r.visible ? 'sees' : 'not'), h('b', r.visible ? '✓ sees it' : '✗ not visible'), h('div.tx-sub', r.why)); })));
      }
      vt.appendChild(tb);
      card.appendChild(h('h4', 'Which version each session sees'));
      card.appendChild(h('div.tx-scroll', vt));
      card.appendChild(h('p.kv-small.muted', 'Exactly one version of a row is visible to a snapshot (or none, if the row was deleted or not yet inserted for it). A session with no open transaction is judged with a fresh snapshot.' + (c.cc !== 'mvcc' ? ' Note: under ' + c.cc + ' the single-version protocols read the newest committed version (or their own), not their snapshot; this table shows the snapshot rule.' : '')));
      box.appendChild(card);
      return box;
    }

    // ---- SSI -----------------------------------------------------------------------------------------------------------------
    function drawSSI() {
      const box = h('div');
      const live = safe(() => K.SSI.describe(app.db), { transactions: [], locks: [], edges: [] });
      // the rw edges recorded since the last scenario (SSI forgets transactions once nobody overlaps them)
      let from = 0;
      for (let i = Rec.events.length - 1; i >= 0; i--) if (Rec.events[i].type === 'scenario') { from = i; break; }
      const evs = Rec.events.slice(from);
      const edges = [];
      for (const e of evs) if (e.type === 'ssi.rw' && !edges.some((x) => x.from === e.d.reader && x.to === e.d.writer)) edges.push({ from: e.d.reader, to: e.d.writer, label: e.d.what ? 'rw ' + e.d.what : 'rw' });
      for (const e of live.edges) if (!edges.some((x) => x.from === e.from && x.to === e.to)) edges.push({ from: e.from, to: e.to, label: 'rw' });
      const nodes = [...new Set(edges.flatMap((e) => [e.from, e.to]).concat(live.transactions.map((t) => t.tx)))];
      const fate = (id) => { const f = [...evs].reverse().find((e) => (e.type === 'ssi.commit' || e.type === 'ssi.abort' || e.type === 'ssi.fail' || e.type === 'ssi.doom') && e.d.tx === id); return f ? f.type.slice(4) : 'running'; };
      const dang = evs.filter((e) => e.type === 'ssi.dangerous');
      // the pivots: a transaction with an rw edge in and an rw edge out
      const pivots = nodes.filter((n) => edges.some((e) => e.to === n) && edges.some((e) => e.from === n));
      const card = h('div.kv-card', h('h3', 'Serialization graph (rw-antidependencies)', h('span.muted', ' Ti → Tj: Ti read a version that Tj replaced, or missed a row Tj inserted, so Ti must come first')));
      card.appendChild(h('p.kv-small', 'Under SERIALIZABLE, PostgreSQL runs snapshot isolation and watches for two consecutive rw edges T1 → T2 → T3 (the dangerous structure; T2 is the pivot). Every cycle in the serialization graph contains one, so cancelling a transaction when it forms keeps the schedule serializable.'));
      if (!nodes.length) card.appendChild(h('p.muted.kv-small', 'No serializable transactions have conflicted since the last scenario began. Try the write-skew scenario with the isolation level SERIALIZABLE.'));
      else {
        card.appendChild(digraph(nodes.map((id) => ({ id, label: txName(id), sub: fate(id), cls: pivots.includes(id) ? 'bad' : fate(id) === 'commit' ? 'ok' : '' })), edges.map((e) => Object.assign({}, e, { cls: pivots.includes(e.from) || pivots.includes(e.to) ? 'bad' : 'n' })), { label: 'rw-antidependency graph' }));
        if (pivots.length || dang.length) card.appendChild(h('div.tx-alert', UI.icon('warn'), h('div', h('b', 'Dangerous structure. '), pivots.length ? 'Pivot ' + pivots.map(txName).join(', ') + ': it has an rw edge in and one out. ' : '', dang.length ? dang[dang.length - 1].d.why + '.' : '')));
      }
      box.appendChild(card);
      const lk = h('div.kv-card', h('h3', 'SIREAD locks', h('span.muted', ' what serializable transactions read; they block nobody')));
      if (!live.locks.length) lk.appendChild(h('p.muted.kv-small', 'None held now.'));
      else lk.appendChild(h('div.tx-scroll', h('table.grid.small', h('thead', h('tr', h('th', 'Target'), h('th', 'Granularity'), h('th', 'Held by'))), h('tbody', live.locks.slice(0, 200).map((l) => h('tr', h('td', h('code', l.target)), h('td', l.kind), h('td', l.holders.map(txLabel).join(', '))))))));
      box.appendChild(lk);
      return box;
    }

    // ---- the classic protocols ------------------------------------------------------------------------------------------------
    function lockChart(t) {
      // the number of locks held after each of the transaction's events: growing, then shrinking
      const held = new Set();
      const pts = [];
      let lp = null;
      for (const e of t.events) {
        if (e.kind === 'grant') held.add(e.item);
        else if (e.kind === 'release') held.delete(e.item);
        else if (e.kind === 'commit' || e.kind === 'abort') held.clear();
        else if (e.kind === 'lockpoint') lp = pts.length;
        else continue;
        pts.push(held.size);
      }
      if (!pts.length) return h('span.muted.kv-small', 'no locks');
      // without a declared lock point, the lock point is the transaction's last acquisition (once it has ended)
      const declared = lp !== null;
      if (!declared && t.status !== 'active') { let g = -1, k = 0; for (const e of t.events) { if (e.kind === 'grant') g = k; if (['grant', 'release', 'commit', 'abort', 'lockpoint'].includes(e.kind)) k++; } if (g >= 0) lp = g + 1; }
      const max = Math.max(1, ...pts);
      // the plot between a band for the phase names above and one for the lock point below
      const W = 220, TOP = 15, PH = 52, H = TOP + PH + 14, dx = W / Math.max(1, pts.length);
      const y0 = TOP + PH;
      let d = 'M0 ' + y0;
      pts.forEach((p, i) => { const y = y0 - 2 - (p / max) * (PH - 6); d += ' L' + (i * dx) + ' ' + y + ' L' + ((i + 1) * dx) + ' ' + y; });
      const peak = pts.indexOf(max);
      const x = lp !== null ? lp * dx : null;
      const gw = textW('growing', 9.5), sw = textW('shrinking', 9.5), lw = textW('lock point', 9.5);
      // "shrinking" just right of the lock point, never over "growing" nor past the right edge
      const sx = x === null ? 0 : Math.min(W - sw - 2, Math.max(x + 4, gw + 10));
      const lx = x === null ? 0 : Math.max(2, Math.min(W - lw - 2, x - lw / 2));
      const svg = s('svg', { class: 'tx-lc', viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, role: 'img', 'aria-label': 'locks held over time' },
        s('rect', { class: 'tx-lc-g', x: 0, y: TOP, width: ((lp !== null ? lp : peak) + 1) * dx, height: PH }),
        s('path', { class: 'tx-lc-l', d }),
        x !== null ? s('line', { class: 'tx-lc-p', x1: x, x2: x, y1: TOP, y2: y0 }) : null,
        s('text', { class: 'tx-lc-t', x: 2, y: 11 }, 'growing'),
        x !== null && sx + sw <= W ? s('text', { class: 'tx-lc-t', x: sx, y: 11 }, 'shrinking') : null,
        x !== null ? s('text', { class: 'tx-lc-t lp', x: lx, y: H - 3 }, 'lock point') : null);
      return svg;
    }
    function drawProtocol() {
      const box = h('div');
      const p = app.db.protocol;
      const c = cfg();
      if (!p) {
        box.appendChild(h('div.kv-card', h('h3', 'MVCC (PostgreSQL)'), h('p.kv-small', 'The default scheme is multiversion: a reader never waits, it reads the version its snapshot allows; a writer locks the row it changes and waits for an earlier writer. Under READ COMMITTED the waiter then goes on with the newest version; under REPEATABLE READ and SERIALIZABLE it fails if that version is newer than its snapshot (first updater wins), and SERIALIZABLE adds SSI.'),
          h('p.kv-small', 'Choose one of the classic protocols above to see its bookkeeping here: lock points for two-phase locking, R- and W-timestamps for timestamp ordering, the phases of validation, the version lists of multiversion timestamp ordering.'),
          h('div.kv-row', PROTOS.slice(1).map(([k, l]) => h('button.btn.small', { type: 'button', onclick: () => { if (setProto(k)) view.render(); } }, l)))));
        return box;
      }
      const d = safe(() => p.describe(), null);
      if (!d) return box;
      const txs = d.transactions.slice(-8).reverse();
      const status = (t) => h('span.kv-badge.' + (t.status === 'committed' ? 'ok' : t.status === 'aborted' ? 'no' : 'acc'), t.status);
      const who = (t) => h('b', txLabel(t.id));
      if (LOCKING.includes(p.name)) {
        const card = h('div.kv-card', h('h3', { '2pl': 'Basic', strict2pl: 'Strict', rigorous2pl: 'Rigorous', mv2pl: 'Multiversion' }[p.name] + ' two-phase locking'),
          h('p.kv-small', 'A transaction acquires locks in its growing phase and releases them in its shrinking phase; the lock point is where one ends and the other begins. Declare it with SELECT lock_point(). ' + { '2pl': 'Basic 2PL then releases every lock at once: others may read uncommitted data, so rollbacks can cascade.', strict2pl: 'Strict 2PL releases S locks at the lock point but keeps X locks to the end: no cascading rollbacks.', rigorous2pl: 'Rigorous 2PL keeps every lock to the end: the transactions serialize in commit order.', mv2pl: 'Update transactions follow rigorous 2PL; READ ONLY transactions read a snapshot (by ts-counter) and take no locks.' }[p.name]));
        if (!txs.length) card.appendChild(h('p.muted.kv-small', 'No transaction has taken a lock yet.'));
        for (const t of txs) card.appendChild(h('div.tx-pt', h('div.tx-pth', who(t), ' ', status(t), h('span.kv-badge.mute', t.phase), t.lockPoint ? h('span.muted.kv-small', ' lock point at step ' + t.lockPoint) : null, h('span.muted.kv-small', ' · at most ' + UI.plural(t.maxLocks, 'lock') + (t.commitTs ? ' · commit ts ' + t.commitTs : ''))), lockChart(t),
          h('div.tx-sub', 'read ' + (t.reads.join(', ') || 'nothing') + ' · wrote ' + (t.writes.join(', ') || 'nothing'))));
        box.appendChild(card);
      } else if (p.name === 'to') {
        const card = h('div.kv-card', h('h3', 'Timestamp ordering' + (c.thomas ? ' with Thomas\' write rule' : '')),
          h('p.kv-small', 'Each transaction gets a timestamp TS(Ti) when it starts; each data item Q keeps W-timestamp(Q) and R-timestamp(Q), the largest timestamps of transactions that wrote and read it. A read with TS(Ti) < W-timestamp(Q), or a write with TS(Ti) < R-timestamp(Q), comes too late and rolls Ti back. ' + (c.thomas ? 'A write with TS(Ti) < W-timestamp(Q) is obsolete and simply ignored (Thomas\' write rule).' : 'So does a write with TS(Ti) < W-timestamp(Q).')));
        card.appendChild(h('h4', 'Data items'));
        card.appendChild(h('div.tx-scroll', h('table.grid.small', h('thead', h('tr', h('th', 'Item Q'), h('th', 'R-timestamp(Q)'), h('th', 'W-timestamp(Q)'))), h('tbody', d.items.filter((i) => i.rts || i.wts).slice(-40).map((i) => h('tr', h('td', h('code', i.item)), h('td.num', String(i.rts || 0)), h('td.num', String(i.wts === null ? 0 : i.wts))))))));
        card.appendChild(h('h4', 'Transactions'));
        card.appendChild(h('div.tx-scroll', h('table.grid.small', h('thead', h('tr', h('th', 'Transaction'), h('th', 'TS(Ti)'), h('th', 'Status'), h('th', 'Last decision'))), h('tbody', txs.map((t) => { const last = [...t.events].reverse().find((e) => e.rule); return h('tr', h('td', who(t)), h('td.num', String(t.ts)), h('td', status(t)), h('td.kv-small.tx-wrap', last ? last.kind + ': ' + last.rule : '')); })))));
        box.appendChild(card);
      } else if (p.name === 'occ') {
        const card = h('div.kv-card', h('h3', 'Validation (optimistic concurrency control)'),
          h('p.kv-small', 'Each transaction runs in three phases: a read phase (it reads the database and writes to local copies), a validation phase at commit, and a write phase. Ti validates against every Tk that validated before it: either Finish(Tk) < Start(Ti), or Tk finished before Ti validated and wrote nothing Ti read.'));
        card.appendChild(h('div.tx-scroll', h('table.grid.small', h('thead', h('tr', h('th', 'Transaction'), h('th', 'Phase'), h('th', 'Start'), h('th', 'Validation'), h('th', 'Finish'), h('th', 'Read set'), h('th', 'Write set'))),
          h('tbody', txs.map((t) => h('tr', h('td', who(t), ' ', status(t)), h('td', t.status === 'active' ? 'read' : t.status === 'committed' ? 'written' : 'rolled back'), h('td.num', String(t.start)), h('td.num', t.validation ? String(t.validation) : '–'), h('td.num', t.finish ? String(t.finish) : '–'), h('td.kv-small.tx-wrap', t.reads.join(', ')), h('td.kv-small.tx-wrap', t.writes.join(', '))))))));
        for (const t of txs) {
          const v = t.events.find((e) => e.kind === 'validate');
          if (v) card.appendChild(h('div.tx-pt', h('div.tx-pth', who(t), ' validation ', h('span.kv-badge.' + (v.ok ? 'ok' : 'no'), v.ok ? 'passed' : 'failed')), (v.tests || []).length ? h('ul.kv-small', v.tests.map((x) => h('li', (x.ok ? '✓ ' : '✗ ') + 'against ' + txName(x.with) + ': ' + x.rule))) : h('div.tx-sub', 'nobody validated before it while it ran')));
        }
        box.appendChild(card);
      } else if (p.name === 'mvto') {
        const card = h('div.kv-card', h('h3', 'Multiversion timestamp ordering'),
          h('p.kv-small', 'Each write makes a new version Qk with W-timestamp = TS(Ti). A read by Ti picks the version with the largest W-timestamp ≤ TS(Ti) and never waits or fails; it raises that version\'s R-timestamp. A write fails if a younger transaction already read the version it would replace (TS(Ti) < R-timestamp(Qk)).'));
        const items = new Map();
        const ver = (item, w) => { if (!items.has(item)) items.set(item, new Map([[0, { w: 0, r: 0, by: null }]])); const m = items.get(item); if (!m.has(w)) m.set(w, { w, r: w, by: null }); return m.get(w); };
        for (const t of d.transactions) for (const e of t.events) {
          if (e.kind === 'write' && e.item) { const v = ver(e.item, e.version); v.by = t.id; v.r = Math.max(v.r, e.version); if (t.status === 'aborted') v.gone = true; }
          if (e.kind === 'read' && e.item) { const v = ver(e.item, e.version || 0); v.r = Math.max(v.r, e.rts || 0); }
        }
        if (!items.size) card.appendChild(h('p.muted.kv-small', 'Nothing read or written yet.'));
        for (const [item, m] of [...items].slice(-12)) card.appendChild(h('div.tx-pt', h('div.tx-pth', h('code', item)), h('div.tx-vl', [...m.values()].sort((a, b) => a.w - b.w).map((v) => h('span.tx-vq' + (v.gone ? '.gone' : ''), h('b', 'W ' + v.w), ' R ' + v.r, h('span.tx-sub', v.by === null ? 'initial' : txName(v.by) + (v.gone ? ' (rolled back)' : '')))))));
        card.appendChild(h('h4', 'Transactions'));
        card.appendChild(h('div.tx-scroll', h('table.grid.small', h('tbody', txs.map((t) => h('tr', h('td', who(t)), h('td', 'TS ' + t.ts), h('td', status(t))))))));
        box.appendChild(card);
      }
      box.appendChild(h('div.kv-card', h('h3', 'The schedule it produced'), h('code.tx-schedtext', d.schedule || '(nothing yet)'), h('div.kv-row', UI.btn('share', 'Analyse in the schedule workbench', null, () => app.openView('schedule', { replay: true }), 'small'))));
      return box;
    }

    // ---- scenarios --------------------------------------------------------------------------------------------------------------
    /** an outcome's condition in words; earlier outcomes of the same scenario make "otherwise" precise */
    const whenText = (w, before) => {
      const parts = [];
      const cc = w.cc ? [].concat(w.cc) : null;
      if (cc) parts.push(cc.length === 4 && LOCKING.every((x) => cc.includes(x)) ? 'Two-phase locking (any variant)' : cc.map(protoName).join(', '));
      if (w.iso) parts.push(w.iso.toUpperCase());
      else if (before && before.some((b) => b.iso && J(b.cc) === J(w.cc))) parts.push('the other isolation levels');
      if (w.dl) parts.push(w.dl);
      if (w.thomas) parts.push('Thomas\' write rule on');
      if (w.phantom) parts.push('phantom protection on');
      return parts.length ? parts.join(', ') : 'otherwise';
    };
    function scTabs(sc) { return Array.from({ length: sc.tabs }, (_, i) => app.tabs.find((t) => t.name === 'T' + (i + 1))); }
    function scriptOf(sc, i) {
      const lines = ['-- ' + sc.title + ': the statements of T' + (i + 1) + '.', '-- Run them in step order (the scenario panel does it for you).', ''];
      sc.steps.forEach(([t, sql, note], k) => { if (t === i) lines.push('-- step ' + (k + 1) + (note ? ': ' + note : ''), sql, ''); });
      return lines.join('\n');
    }
    function startScenario(sc) {
      const db = app.db;
      // end what is running: a waiting statement is cancelled, an open transaction rolled back
      for (const t of app.tabs) {
        if (t.runner && !t.runner.done) safe(() => t.runner.cancel(), null);
        if (t.session && t.session.tx) safe(() => t.session.exec('rollback'), null);
      }
      safe(() => db.step(), null);
      let c = cfg();
      if (sc.require && !sc.require.cc.includes(c.cc)) setProto(sc.require.use.thomas ? 'thomas' : sc.require.use.cc);
      c = cfg();
      // the tabs T1, T2 (and T3), each with its part of the script
      const tabs = [];
      for (let i = 0; i < sc.tabs; i++) {
        let t = app.tabs.find((x) => x.name === 'T' + (i + 1));
        if (!t) t = app.addTab('T' + (i + 1), '', true);
        t.text = scriptOf(sc, i);
        t.run = null;
        tabs.push(t);
      }
      setAll(["set default_transaction_isolation = '" + c.iso + "'", "set deadlock_handling = '" + c.dl + "'", 'set thomas_write_rule = ' + (c.thomas ? 'on' : 'off')].concat(sc.tabSetup ? sc.tabSetup.split(';').map((x) => x.trim()).filter(Boolean) : []), tabs);
      // the tables, made quietly in a session of their own; then a fresh protocol, so its history starts here
      const ses = db.session({ name: 'scenario setup' });
      db.bus.muted++;
      let err = null;
      try {
        ses.exec(sc.setup);
        if (db.protocol) { const n = db.protocol.name; ses.exec("set concurrency_control = 'mvcc'"); ses.exec("set concurrency_control = '" + n + "'"); }
      } catch (e) { err = e; } finally { db.bus.muted--; db.closeSession(ses); }
      if (err) { UI.toast('The scenario could not be set up: ' + err.message, 'err', 6000); return; }
      Rec.add('scenario', { text: 'Scenario: ' + sc.title + ' (' + protoName(c.proto) + ', ' + c.iso + ', deadlocks: ' + c.dl + ')' });
      st.sc = sc; st.step = 0; st.pos = tabs.map(() => 0); st.picked = null; st.ran = []; st.msg = null;
      st.rel = sc.table; st.chain = 'key:' + sc.row;
      if (st.tab === 'scenarios') st.tab = 'timeline';
      app.selectTab(tabs[0].id);
      app.saveTabs();
      app.emit('schema');
      if (app.panel === 'schema') app.renderPanel();
      app.updateStatus();
      view.render();
    }
    function runStep(skip) {
      const sc = st.sc;
      if (!sc || st.step >= sc.steps.length) return;
      const [ti, sql] = sc.steps[st.step];
      const tab = scTabs(sc)[ti];
      if (!tab) { UI.toast('Tab T' + (ti + 1) + ' is gone: set the scenario up again.', 'err'); return; }
      if (skip) { st.ran[st.step] = 'skipped'; st.step++; st.msg = null; view.render(); return; }
      if (tab.runner && !tab.runner.done) { st.msg = tab.name + ' is still waiting for its previous statement, so it cannot run the next one. Skip this step, or end the transaction that blocks it.'; view.render(); return; }
      st.msg = null;
      app.selectTab(tab.id);
      const text = app.editor.getValue();
      let at = text.indexOf(sql, st.pos[ti] || 0);
      if (at < 0) at = text.indexOf(sql);
      if (at >= 0) { st.pos[ti] = at + sql.length; safe(() => { app.editor.ta.setSelectionRange(at, at + sql.length); app.editor.scrollToPos(at); }, null); }
      const k = st.step;
      st.step++;
      app.runSql(tab, sql, at >= 0 ? at : 0);
      st.ran[k] = tab.runner && !tab.runner.done ? 'waits' : tab.runner && tab.runner.error ? 'error' : 'done';
      view.render();
    }
    function endScenario() { st.sc = null; view.render(); }
    function rollbackAll() {
      for (const t of app.tabs) { if (t.runner && !t.runner.done) safe(() => t.runner.cancel(), null); if (t.session && t.session.tx) safe(() => t.session.exec('rollback'), null); }
      safe(() => app.db.step(), null);
      Rec.add('note', { text: 'Every open transaction rolled back' });
      app.drawTabs(); app.updateStatus(); view.render();
    }

    function drawBar() {
      bar.innerHTML = '';
      const sc = st.sc;
      bar.hidden = !sc;
      if (!sc) return;
      const n = sc.steps.length;
      const done = st.step >= n;
      const tabs = scTabs(sc);
      const c = cfg();
      const dots = h('div.tx-dots', sc.steps.map(([t, sql], i) => h('span.tx-dot' + (i < st.step ? '.' + (st.ran[i] || 'done') : i === st.step ? '.next' : ''), { title: 'Step ' + (i + 1) + ': T' + (t + 1) + ' ' + sql + (st.ran[i] ? ' (' + st.ran[i] + ')' : '') }, String(i + 1))));
      bar.appendChild(h('div.tx-sct', UI.icon('flask'), h('b', sc.title), dots, h('div.grow'),
        UI.btn('refresh', null, 'Restart: set the scenario up again', () => startScenario(sc), 'icon'), UI.btn('x', null, 'Close the scenario', endScenario, 'icon')));
      if (!done) {
        const [ti, sql, note] = sc.steps[st.step];
        const tab = tabs[ti];
        const blocked = tab && tab.runner && !tab.runner.done;
        bar.appendChild(h('div.tx-next', h('span.tx-who.big', 'T' + (ti + 1)), h('code', sql), h('div.grow'),
          UI.btn('step', 'Run step ' + (st.step + 1), 'Run the next statement in its tab (T' + (ti + 1) + ')', () => runStep(false), 'primary small tx-runstep'), UI.btn('last', null, 'Skip this step', () => runStep(true), 'icon')));
        if (note) bar.appendChild(h('div.kv-small.muted.tx-note', note));
        const pr = sc.predict;
        if (pr && pr.step === st.step) {
          bar.appendChild(h('div.tx-pred', h('div.tx-pq', UI.icon('help'), h('span', h('b', 'Predict. '), pr.q)), h('div.tx-popts', pr.options.map((o, i) => h('button.tx-popt' + (st.picked === i ? '.on' : ''), { type: 'button', onclick: () => { st.picked = i; view.render(); } }, o)))));
        }
        if (st.msg || blocked) bar.appendChild(h('div.tx-alert.warn', UI.icon('clock'), h('div', st.msg || tab.name + ' is waiting, so it cannot run this statement yet: skip it, or let the other transaction finish.')));
      } else {
        bar.appendChild(h('div.tx-next', UI.icon('check'), h('span.grow', 'All steps have run. Change the protocol or isolation level and run it again.'), UI.btn('refresh', 'Restart', null, () => startScenario(sc), 'primary small'), app.tabs.some((t) => t.session && t.session.tx) ? UI.btn('x', 'Roll back the rest', 'Roll back the transactions still open', rollbackAll, 'small') : null));
      }
    }
    /** what the scenario should do under the current setting, once the question has been answered or passed */
    function expectCard() {
      const sc = st.sc;
      if (!sc || !sc.predict || st.step <= sc.predict.step) return null;
      const c = cfg();
      const o = SC().outcome(sc, c);
      if (st.expOpen === undefined) st.expOpen = !app.el.classList.contains('narrow');
      return h('details.kv-card.tx-exp', { open: st.expOpen, ontoggle: (e) => { st.expOpen = e.target.open; } }, h('summary', h('b', 'What to expect'), h('span.muted', ' under ' + protoName(c.proto) + ', ' + c.iso + (c.dl !== 'detect' ? ', deadlocks: ' + c.dl : ''))), h('p', o ? o.text : 'No expectation is written down for this setting.'), st.picked !== null ? h('p.muted.kv-small', 'You predicted: ' + sc.predict.options[st.picked] + '.') : null);
    }
    function drawScenarios() {
      const box = h('div');
      const c = cfg();
      box.appendChild(h('p.kv-small.muted.tx-lead', 'Each scenario opens two or three tabs (T1, T2, T3) with their statements and runs them in the right order, one step at a time, so you can watch a transaction block and see what releases it. Answer the question before the interesting step. The outcome depends on the protocol and isolation level chosen above: run a scenario, change them, and run it again.'));
      for (const sc of SC().list) {
        const ok = !sc.require || sc.require.cc.includes(c.cc);
        const cur = SC().outcome(sc, c);
        const card = h('div.kv-card.tx-scc' + (st.sc === sc ? '.on' : ''),
          h('h3', sc.title, h('span.muted', ' ' + sc.tabs + ' tabs · ' + sc.steps.length + ' steps')),
          h('p.kv-small', sc.about),
          h('details.tx-det', h('summary', 'The schedule'), h('ol.tx-steps', sc.steps.map(([t, sql]) => h('li', h('span.tx-who', 'T' + (t + 1)), ' ', h('code', sql))))),
          h('details.tx-det', h('summary', 'Expected outcomes'), h('ul.tx-outs', sc.outcomes.map((o, i) => h('li' + (o === cur ? '.cur' : ''), h('b', whenText(o.when, sc.outcomes.slice(0, i).map((x) => x.when)) + ': '), o.text)))),
          h('div.kv-row', UI.btn('run', st.sc === sc ? 'Restart' : 'Set up', 'Open the tabs and set up the tables', () => startScenario(sc), 'primary small'),
            !ok ? h('span.muted.kv-small', 'Switches the protocol to ' + protoName(sc.require.use.thomas ? 'thomas' : sc.require.use.cc) + '.') : null,
            sc.suggest && sc.suggest.iso && c.iso !== sc.suggest.iso ? h('button.btn.small.ghost', { type: 'button', onclick: () => { setIso(sc.suggest.iso); startScenario(sc); } }, 'Set up under ' + sc.suggest.iso.toUpperCase()) : null));
        box.appendChild(card);
      }
      box.appendChild(h('div.kv-row', UI.btn('x', 'Roll back every open transaction', null, rollbackAll, 'small ghost')));
      return box;
    }

    let lastTab = null;
    const view = {
      render() {
        const same = lastTab === st.tab;
        lastTab = st.tab;
        const keep = same ? body.scrollTop : 0;
        const gb = body.querySelector('.tx-gridbox');
        const keepX = gb && same ? gb.scrollLeft : 0;
        const gbEnd = !gb || !same || gb.scrollTop + gb.clientHeight >= gb.scrollHeight - 30;
        const gbTop = gb ? gb.scrollTop : 0;
        drawHead();
        drawBar();
        body.innerHTML = '';
        body.classList.toggle('tx-fill', st.tab === 'timeline');
        const draw = { scenarios: drawScenarios, timeline: drawTimeline, locks: drawLocks, versions: drawVersions, ssi: drawSSI, protocol: drawProtocol }[st.tab] || drawTimeline;
        try { body.appendChild(draw()); } catch (e) { console.error(e); body.appendChild(h('div.res-err', 'This part of the view failed: ' + e.message)); }
        const ex = st.tab !== 'scenarios' ? expectCard() : null;
        if (ex) body.prepend(ex);
        const gb2 = body.querySelector('.tx-gridbox');
        if (gb2) { gb2.scrollLeft = keepX; gb2.scrollTop = gbEnd ? gb2.scrollHeight : gbTop; }
        body.scrollTop = keep;
      },
      onDb() { st.sc = null; },
      onSelect(x) { if (x && x.txnTab) st.tab = x.txnTab; if (x && x.scenario) { const sc = SC().list.find((y) => y.id === x.scenario); if (sc) setTimeout(() => startScenario(sc), 0); } },
      destroy() { offRec(); Rec.detach(); },
      // for tests and lessons
      start(id) { const sc = SC().list.find((y) => y.id === id); if (sc) startScenario(sc); return !!sc; },
      next() { runStep(false); return st.step; },
      state: st,
    };
    return view;
  }

  UI.registerView({ id: 'txn', title: 'Transactions', icon: 'users', group: 'Transactions', order: 40, create });
})(typeof window !== 'undefined' ? window : globalThis);
