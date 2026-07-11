// Triggers, as PostgreSQL fires them. BEFORE ROW triggers run as each row is about to be stored and may change
// NEW or skip the row by returning NULL; AFTER ROW triggers are queued and run when the statement ends, with the
// final rows; statement-level triggers run once per statement even when no row is touched. Triggers on the same
// event fire in order of their names. WHEN conditions, UPDATE OF column lists, transition tables (REFERENCING
// OLD/NEW TABLE) and INSTEAD OF triggers on views are supported. Every firing is reported on the bus.
(function (root) {
  'use strict';
  const K = root.K;
  const S = K.STATE;
  const T = () => K.T;

  const MAX_DEPTH = 64;
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const live = (rel) => rel.cols.map((c, i) => (c.dropped ? -1 : i)).filter((i) => i >= 0);

  class Triggers {
    constructor(db) { this.db = db; this.whenCache = new Map(); this.seq = 0; installSession(); }

    /** the enabled triggers of a relation for one timing, event and level, in firing order */
    list(rel, timing, event, level) {
      const ts = rel.triggers;
      if (!ts || !ts.length) return [];
      return ts.filter((t) => t.enabled !== false && t.timing === timing && t.forEach === level && t.events.some((e) => e.event === event)).sort(byName);
    }
    has(rel) { return !!(rel.triggers && rel.triggers.length); }
    stack(ctx) { return ctx.plTrig || (ctx.plTrig = []); }
    frameOf(ctx, rel, event) {
      const st = ctx.plTrig;
      if (st) for (let i = st.length - 1; i >= 0; i--) if (st[i].rel.oid === rel.oid && st[i].event === event) return st[i];
      return null;
    }
    /** the columns an UPDATE assigns (for UPDATE OF triggers), when the statement is known */
    setCols(ctx) {
      if (ctx.plSets) return ctx.plSets;
      const n = ctx.plNode;
      return n && n.kind === 'update' && n.sets ? n.sets.map((s) => s.attnum) : null;
    }
    /** UPDATE OF a, b: the trigger fires when one of the columns is a target of the UPDATE */
    columnsMatch(t, rel, event, ctx, oldVals, newVals) {
      if (event !== 'update') return true;
      const ev = t.events.find((e) => e.event === 'update');
      if (!ev || !ev.cols || !ev.cols.length) return true;
      const atts = ev.cols.map((n) => rel.cols.findIndex((c) => c.name === n && !c.dropped));
      const sets = this.setCols(ctx);
      if (sets) return atts.some((a) => sets.includes(a));
      if (!oldVals || !newVals) return true;
      return atts.some((a) => a >= 0 && (oldVals[a] === null) !== (newVals[a] === null) || (oldVals[a] !== null && newVals[a] !== null && T().compare(oldVals[a], newVals[a], rel.cols[a].type) !== 0));
    }
    /** a trigger's WHEN condition over OLD and NEW */
    when(t, rel, ctx, oldVals, newVals) {
      if (!t.when) return true;
      const s = ctx.session;
      const cat = s.catalog;
      const key = rel.oid + ':' + t.name + ':' + cat.version;
      let f = this.whenCache.get(key);
      if (!f) {
        const b = new K.Binder(s);
        const scope = new K.Scope(null);
        const lay = new Map();
        const w = rel.cols.length;
        for (const [name, off] of [['new', 0], ['old', w]]) {
          const cols = [];
          rel.cols.forEach((c, i) => { if (!c.dropped) { const id = b.id(); cols.push({ id, name: c.name, type: c.type, attnum: i, table: name }); lay.set(id, off + i); } });
          scope.items.push({ name, cols, rel });
        }
        const e = b.boolExpr(t.when, scope, 'WHEN');
        f = K.Expr.compile(e, lay);
        if (this.whenCache.size > 500) this.whenCache.clear();
        this.whenCache.set(key, f);
      }
      const w = rel.cols.length;
      const row = (newVals || new Array(w).fill(null)).concat(oldVals || new Array(w).fill(null));
      return f(row, ctx) === true;
    }
    func(t, ctx) {
      const f = ctx.session.catalog.userFuncs(t.func).find((x) => x.retType && x.retType.id === 'trigger');
      if (!f) throw K.err(S.undefinedFunction, 'function ' + t.func + '() does not exist');
      return f;
    }
    /** call one trigger's function; returns what it returned (a row value or null) */
    *fire(t, rel, timing, level, event, ctx, oldVals, newVals, frame) {
      const s = ctx.session;
      const depth = (ctx.trigDepth || 0) + 1;
      if (depth > MAX_DEPTH) throw K.err('54001', 'stack depth limit exceeded', { hint: 'Trigger "' + t.name + '" seems to fire itself without end.' });
      const f = this.func(t, ctx);
      const rowType = s.catalog.rowType(rel);
      const cols = live(rel);
      const pick = (vals) => (vals ? cols.map((i) => (vals[i] === undefined ? null : vals[i])) : null);
      const td = { name: t.name, when: timing.toUpperCase(), level: level.toUpperCase(), op: event.toUpperCase(), rel, args: t.args || [], rowType, new: pick(newVals), old: pick(oldVals), transitions: [] };
      if (t.referencing && frame) {
        if (t.referencing.new && frame.trans.new) td.transitions.push({ name: t.referencing.new, rows: frame.trans.new.map(pick) });
        if (t.referencing.old && frame.trans.old) td.transitions.push({ name: t.referencing.old, rows: frame.trans.old.map(pick) });
      }
      this.db.bus.emit('trigger.fire', { trigger: t.name, table: rel.name, timing, level, event, func: t.func, depth, row: newVals || oldVals || null, session: s.id });
      const c = Object.assign({}, ctx, { trigDepth: depth, plTrig: null, plNode: null, plSets: null });
      c.subplan = (n, r, l) => s.subplan(c, n, r, l);
      c.callUdf = (n, a) => s.callUdf(c, n, a);
      c.callUdfSet = (n, a) => s.callUdf(c, n, a, true);
      return yield* K.PSM.callTriggerG(f, td, c, s);
    }
    /** a row value returned by a trigger, back to the table's column layout */
    toVals(v, rel, ctx, t) {
      const cols = live(rel);
      const vals = v.values;
      if (vals.length !== cols.length) throw K.err(S.datatypeMismatch, 'returned row structure does not match the structure of the triggering table', { detail: 'Number of returned columns (' + vals.length + ') does not match expected column count (' + cols.length + ').', context: 'trigger ' + t.name });
      const out = new Array(rel.cols.length).fill(null);
      const fts = v.type && v.type.fields;
      cols.forEach((a, i) => { out[a] = K.PSM.coerceTo(vals[i], fts && fts[i] ? fts[i].type : null, rel.cols[a].type, ctx); });
      return out;
    }

    /** run the queued AFTER ROW triggers of several events of one statement (MERGE), in the order of the changes */
    *flushRows(rel, events, ctx) {
      const frames = events.map((e) => this.frameOf(ctx, rel, e)).filter(Boolean);
      const all = frames.flatMap((f) => f.after.map((ev) => ({ ev, f }))).sort((a, b) => a.ev.seq - b.ev.seq);
      for (const f of frames) f.after = [];
      for (const { ev, f } of all) yield* this.fire(ev.t, rel, 'after', 'row', ev.event, ctx, ev.old, ev.new, f);
    }

    // ---- the hooks DML calls ------------------------------------------------------------------------------------------
    *statement(rel, timing, event, ctx) {
      const upsert = event === 'insert' && ctx.plNode && ctx.plNode.conflict && ctx.plNode.conflict.action === 'update';
      if (timing === 'before') {
        this.stack(ctx).push({ rel, event, after: [], trans: { old: event === 'insert' ? null : [], new: event === 'delete' ? null : [] } });
        for (const t of this.list(rel, 'before', event, 'statement')) if (this.columnsMatch(t, rel, event, ctx, null, null)) yield* this.fire(t, rel, 'before', 'statement', event, ctx, null, null, null);
        // INSERT ... ON CONFLICT DO UPDATE is an UPDATE statement too
        if (upsert) {
          const prev = ctx.plSets;
          ctx.plSets = ctx.plNode.conflict.sets.map((x) => x.attnum);
          try { yield* this.statement(rel, 'before', 'update', ctx); } finally { ctx.plSets = prev; }
        }
        return;
      }
      if (upsert) { yield* this.flushRows(rel, ['insert', 'update'], ctx); yield* this.statement(rel, 'after', 'update', ctx); }
      const st = this.stack(ctx);
      const frame = this.frameOf(ctx, rel, event);
      if (frame) {
        // AFTER ROW triggers run now, at the end of the statement, in the order their rows were changed
        for (let i = 0; i < frame.after.length; i++) { const ev = frame.after[i]; yield* this.fire(ev.t, rel, 'after', 'row', event, ctx, ev.old, ev.new, frame); }
        frame.after.length = 0;
      }
      for (const t of this.list(rel, 'after', event, 'statement')) if (this.columnsMatch(t, rel, event, ctx, null, null)) yield* this.fire(t, rel, 'after', 'statement', event, ctx, null, null, frame);
      if (frame) st.splice(st.lastIndexOf(frame), 1);
    }
    *row(rel, timing, event, ctx, oldVals, newVals) {
      if (timing === 'before') {
        // already run by the ON CONFLICT check
        if (newVals && newVals[Triggers.BEFORE_DONE]) { delete newVals[Triggers.BEFORE_DONE]; return newVals; }
        let cur = newVals;
        for (const t of this.list(rel, 'before', event, 'row')) {
          if (!this.columnsMatch(t, rel, event, ctx, oldVals, cur)) continue;
          if (!this.when(t, rel, ctx, oldVals, cur)) continue;
          const r = yield* this.fire(t, rel, 'before', 'row', event, ctx, oldVals, cur, null);
          if (r === null || r === undefined) return null;
          if (event !== 'delete') cur = this.toVals(r, rel, ctx, t);
        }
        return event === 'delete' ? oldVals || true : cur;
      }
      const frame = this.frameOf(ctx, rel, event);
      if (frame) {
        if (frame.trans.old && oldVals) frame.trans.old.push(oldVals.slice());
        if (frame.trans.new && newVals) frame.trans.new.push(newVals.slice());
      }
      for (const t of this.list(rel, 'after', event, 'row')) {
        if (!this.columnsMatch(t, rel, event, ctx, oldVals, newVals)) continue;
        if (!this.when(t, rel, ctx, oldVals, newVals)) continue;
        const ev = { t, old: oldVals ? oldVals.slice() : null, new: newVals ? newVals.slice() : null, seq: ++this.seq, event };
        if (frame) frame.after.push(ev);
        else yield* this.fire(t, rel, 'after', 'row', event, ctx, ev.old, ev.new, null);
      }
      return newVals;
    }
    /** INSTEAD OF triggers on a view: returns the row to report (NEW, or OLD for DELETE), or null when skipped */
    *instead(rel, event, ctx, oldVals, newVals) {
      let res = null;
      for (const t of this.list(rel, 'instead of', event, 'row')) {
        if (!this.when(t, rel, ctx, oldVals, newVals)) continue;
        const r = yield* this.fire(t, rel, 'instead of', 'row', event, ctx, oldVals, newVals, null);
        if (r === null || r === undefined) return null;
        res = event === 'delete' ? oldVals : this.toVals(r, rel, ctx, t);
        if (event !== 'delete') newVals = res;
      }
      return res;
    }
  }

  // ---- CALL and DO run procedural code as part of the statement, so it can wait for locks like any statement -------------
  let installed = false;
  function installSession() {
    if (installed || !K.Session) return;
    installed = true;
    const SP = K.Session.prototype;
    SP.call = function* (st, ctx) {
      const list = this.catalog.userFuncs(st.name.name).filter((f) => f.kind === 'procedure');
      if (!list.length) throw K.err(S.undefinedFunction, 'procedure ' + st.name.name + '() does not exist', { hint: 'No procedure matches the given name and argument types. You might need to add explicit type casts.' });
      const b = new K.Binder(this);
      const args = st.args.map((a) => b.expr(a.expr || a, new K.Scope(null), {}));
      const fits = (x) => { const ins = x.params.filter((p) => p.mode !== 'out'); return x.params.length >= args.length && ins.filter((p) => p.default === undefined && p.mode !== 'variadic').length <= args.length; };
      const f = list.find(fits) || (list.some((x) => x.params.some((p) => p.mode === 'variadic')) ? list[0] : null);
      if (!f) throw K.err(S.undefinedFunction, 'procedure ' + st.name.name + '(' + args.map((a) => K.T.sqlName(a.type)).join(', ') + ') does not exist', { hint: 'No procedure matches the given name and argument types. You might need to add explicit type casts.' });
      const ins = f.params.filter((p) => p.mode !== 'out');
      const vals = ins.map((p, i) => (args[i] ? K.Expr.compile(K.Expr.coerce(args[i], p.type, false), new Map())([], ctx) : p.default ? K.Expr.compile(b.expr(p.default, new K.Scope(null), {}), new Map())([], ctx) : null));
      let r = null;
      if (f.lang === 'sql') r = this.callUdf(ctx, { fn: f }, vals);
      else if (!(f.strict && vals.some((v) => v === null))) {
        const c = Object.assign({}, ctx, { outer: null, cteCache: new Map(), workTables: new Map(), udfDepth: (ctx.udfDepth || 0) + 1, subCache: new Map(), params: vals });
        c.subplan = (n, rr, l) => this.subplan(c, n, rr, l);
        c.callUdf = (n, a) => this.callUdf(c, n, a);
        c.callUdfSet = (n, a) => this.callUdf(c, n, a, true);
        r = yield* K.PSM.callG(f, vals, c, this);
      }
      yield* this.db.dml.runAfter(ctx);
      const outs = f.params.filter((p) => p.mode === 'inout' || p.mode === 'out');
      if (r && r instanceof K.RowV && outs.length) return new K.Result('CALL', outs.map((p) => ({ name: p.name, type: p.type })), [r.values]);
      return new K.Result('CALL');
    };
    SP.doBlock = function* (st, ctx) {
      if (st.lang && K.lower(st.lang) !== 'plpgsql') throw K.err(S.undefinedObject, 'language "' + st.lang + '" does not exist');
      yield* K.PSM.doInlineG(st, ctx, this, false);
      yield* this.db.dml.runAfter(ctx);
      return new K.Result('DO');
    };
  }

  // ---- INSTEAD OF triggers on views: the statement becomes calls of the trigger function ----------------------------------
  const DML = K.DML.prototype;
  DML.bindInstead = function (binder, q, scope, tg) {
    const v = tg.rel;
    const verb = q.type;
    const B = K.T.BASE;
    const w = v.cols.length;
    if (verb === 'insert') {
      let targets;
      if (q.cols) targets = q.cols.map((n) => { const a = v.cols.findIndex((c) => c.name === n); if (a < 0) binder.fail(S.undefinedColumn, 'column "' + n + '" of relation "' + v.name + '" does not exist', q.pos); return a; });
      else targets = v.cols.map((c, i) => i);
      let src;
      const colsOf = (ts) => ts.map((a) => ({ id: binder.id(), name: v.cols[a].name, type: v.cols[a].type }));
      if (q.defaults) src = { op: 'Values', tuples: [targets.map(() => K.cst(null, B.unknown))], cols: colsOf(targets), children: [] };
      else if (q.source.type === 'values' && !q.source.order && q.source.limit === undefined) {
        const rows = q.source.rows.map((r) => {
          if (r.length > targets.length) binder.fail(S.syntax, 'INSERT has more expressions than target columns', r[targets.length].pos);
          return r.map((e, i) => (e.k === 'default' ? K.cst(null, v.cols[targets[i]].type) : this.assign(binder.expr(e, scope), v.cols[targets[i]].type, v.cols[targets[i]].name, binder)));
        });
        const width = Math.max(...rows.map((r) => r.length));
        targets = targets.slice(0, width);
        for (const r of rows) while (r.length < width) r.push(K.cst(null, v.cols[targets[r.length]].type));
        src = { op: 'Values', tuples: rows, cols: colsOf(targets), children: [] };
      } else {
        const sub = binder.query(q.source, scope);
        const vis = sub.cols.filter((c) => !c.hidden);
        if (vis.length > targets.length) binder.fail(S.syntax, 'INSERT has more expressions than target columns', q.source.pos);
        targets = targets.slice(0, vis.length);
        const exprs = vis.map((c, i) => this.assign({ k: 'col', id: c.id, type: c.type, name: c.name }, v.cols[targets[i]].type, v.cols[targets[i]].name, binder));
        src = { op: 'Project', exprs, children: [sub], cols: colsOf(targets) };
      }
      const node = { op: 'Modify', kind: 'instead', event: 'insert', rel: v, children: [src], targets, cols: [] };
      if (q.returning) {
        const sc = new K.Scope(scope);
        const cols = v.cols.map((c, i) => ({ id: binder.id(), name: c.name, type: c.type, attnum: i, table: q.alias || v.name }));
        sc.items.push({ name: q.alias || v.name, cols });
        const ts = binder.targets(q.returning, sc);
        node.returning = ts.map((t) => t.e);
        node.retLayout = new Map(cols.map((c) => [c.id, c.attnum]));
        node.cols = ts.map((t) => ({ id: binder.id(), name: t.name, type: t.e.type }));
      }
      return node;
    }
    // UPDATE and DELETE read the view's rows
    const sc = new K.Scope(scope);
    const name = q.alias || v.name;
    const scan = binder.fromItem({ kind: 'table', name: { schema: v.schema, name: v.name }, alias: { name } }, sc);
    let node = scan;
    for (const f of (verb === 'update' ? q.from : q.using) || []) { const n = binder.fromItem(f, sc); node = { op: 'Join', jtype: 'cross', children: [node, n], cols: node.cols.concat(n.cols), cond: null, implicit: true }; }
    if (q.currentOf) binder.fail(S.featureNotSupported, 'WHERE CURRENT OF on a view is not implemented', q.pos);
    if (q.where) node = { op: 'Filter', cond: binder.boolExpr(q.where, sc, 'WHERE'), children: [node], cols: node.cols, where: true };
    const scanCols = scan.cols.filter((c) => !c.hidden);
    const m = { op: 'Modify', kind: 'instead', event: verb, rel: v, children: [node], scanIds: scanCols.map((c) => c.id), cols: [] };
    if (verb === 'update') {
      m.sets = q.set.map((s) => {
        if (s.cols) binder.fail(S.featureNotSupported, 'multiple-column assignment to a view is not implemented', q.pos);
        const a = v.cols.findIndex((c) => c.name === s.col);
        if (a < 0) binder.fail(S.undefinedColumn, 'column "' + s.col + '" of relation "' + v.name + '" does not exist', q.pos);
        return { attnum: a, e: s.expr.k === 'default' ? K.cst(null, v.cols[a].type) : this.assign(binder.expr(s.expr, sc), v.cols[a].type, v.cols[a].name, binder) };
      });
    }
    if (q.returning) {
      const lay = new Map();
      scanCols.forEach((c, i) => lay.set(c.id, i));
      node.cols.forEach((c, i) => { if (!lay.has(c.id)) lay.set(c.id, w + i); });
      const ts = binder.targets(q.returning, sc);
      m.returning = ts.map((t) => t.e);
      m.retLayout = lay;
      m.cols = ts.map((t) => ({ id: binder.id(), name: t.name, type: t.e.type }));
    }
    return m;
  };
  DML.runInstead = function* (n, ctx, run) {
    const v = n.rel;
    const trig = this.db.triggers;
    const child = n.children[0];
    const lay = K.Exec.layoutOf(child.cols);
    const sets = n.sets ? n.sets.map((s) => ({ attnum: s.attnum, f: K.Expr.compile(s.e, lay) })) : null;
    const ret = n.returning ? n.returning.map((e) => K.Expr.compile(e, n.retLayout)) : null;
    const idx = n.scanIds ? n.scanIds.map((id) => lay.get(id)) : null;
    const w = v.cols.length;
    yield* trig.statement(v, 'before', n.event, ctx);
    let count = 0;
    for (const r of run(child, ctx)) {
      if (K.Exec.isSignal(r)) { yield r; continue; }
      let old = null, vals = null;
      if (n.event === 'insert') { vals = new Array(w).fill(null); n.targets.forEach((a, i) => { vals[a] = r[i] === K.DEFAULT ? null : r[i]; }); }
      else {
        old = idx.map((i) => r[i]);
        if (n.event === 'update') { vals = old.slice(); for (const s of sets) vals[s.attnum] = s.f(r, ctx); }
      }
      const res = yield* trig.instead(v, n.event, ctx, old, vals);
      if (!res) continue;
      count++;
      if (ret) { const row = n.event === 'insert' ? res : res.concat(r); yield ret.map((f) => f(row, ctx)); }
    }
    yield* trig.statement(v, 'after', n.event, ctx);
    n.count = count;
    ctx.rowCount = (ctx.rowCount || 0) + count;
  };
  // the statement being run is known to the triggers (for UPDATE OF); INSTEAD OF statements run above
  const origRun = DML.run;
  DML.run = function* (n, ctx, run) {
    const prevNode = ctx.plNode, prevSets = ctx.plSets;
    ctx.plNode = n;
    ctx.plSets = null;
    try {
      if (n.kind === 'instead') return yield* this.runInstead(n, ctx, run);
      return yield* origRun.call(this, n, ctx, run);
    } finally { ctx.plNode = prevNode; ctx.plSets = prevSets; }
  };

  // INSERT ... ON CONFLICT with triggers, as PostgreSQL: BEFORE INSERT row triggers run before the conflict check
  // (and may change or skip the row); a row that conflicts and is updated fires the UPDATE row triggers instead
  const BEFORE_DONE = Symbol('before insert triggers done');
  const origConflict = DML.conflictRunner;
  DML.conflictRunner = function (n, ctx) {
    const trig = this.db.triggers;
    if (!trig || !trig.has(n.rel)) return origConflict.call(this, n, ctx);
    const rel = n.rel, c = n.conflict, cat = this.db.catalogOf(ctx);
    const idxs = (c.arbiter || cat.indexesOf(rel).filter((ix) => ix.unique).map((ix) => ix.oid)).map((o) => cat.rel(o));
    const sets = c.sets ? c.sets.map((s) => ({ attnum: s.attnum, f: s.e.k === 'default' ? null : K.Expr.compile(s.e, c.layout) })) : null;
    const where = c.where ? K.Expr.compile(c.where, c.layout) : null;
    const self = this;
    const key = (t) => t.b + ':' + t.o;
    return function* (vals, touched) {
      const nv0 = yield* trig.row(rel, 'before', 'insert', ctx, null, vals);
      if (!nv0) return { done: true };
      if (nv0 !== vals) for (let i = 0; i < vals.length; i++) vals[i] = nv0[i];
      vals[BEFORE_DONE] = true;
      for (let tries = 0; tries < 100; tries++) {
        let hit = null;
        for (const ix of idxs) { const r = yield* self.checkUnique(rel, ix, vals, null, ctx, false, true); if (r) { hit = r; break; } }
        if (!hit) return { done: false };
        if (c.action === 'nothing') return { done: true };
        const p = yield* self.db.cc.prepareModify(rel, hit, ctx, 'update');
        if (p === false || p.gone && !p.self) continue;
        if (p.gone && p.self || touched.has(key(hit))) throw K.err(S.cardinality, 'ON CONFLICT DO UPDATE command cannot affect row a second time', { hint: 'Ensure that no rows proposed for insertion within the same command have duplicate constrained values.' });
        if (p.moved) continue;
        const t = self.db.heap(rel).fetch(hit);
        const old = K.Tuple.deform(t.bytes, rel.cols, ctx);
        self.db.buffers.unpin(t.frame, false);
        const both = old.concat(vals);
        if (where && where(both, ctx) !== true) return { done: true };
        let nv = old.slice();
        for (const s of sets) nv[s.attnum] = s.f ? s.f(both, ctx) : null;
        self.generate(n, nv, ctx);
        const prevSets = ctx.plSets;
        ctx.plSets = sets.map((s) => s.attnum);
        try {
          nv = yield* trig.row(rel, 'before', 'update', ctx, old, nv);
          if (!nv) return { done: true };
          const nt = yield* self.updateRow(rel, hit, old, nv, ctx);
          touched.add(key(nt));
          yield* trig.row(rel, 'after', 'update', ctx, old, nv);
        } finally { ctx.plSets = prevSets; }
        return { done: true, row: nv };
      }
      throw K.err(S.internal, 'ON CONFLICT retried too often');
    };
  };
  Triggers.BEFORE_DONE = BEFORE_DONE;

  // rows changed by a referential action (ON DELETE CASCADE, SET NULL, SET DEFAULT ...) fire the triggers of the
  // referencing table, as PostgreSQL's referential integrity queries do: one DELETE or UPDATE statement per key
  const origRef = DML.refAction;
  DML.refAction = function* (ev, ctx, q) {
    const trig = this.db.triggers;
    if (!trig || !trig.has(ev.child) || ev.action === 'no action' || ev.action === 'restrict') return yield* origRef.call(this, ev, ctx, q);
    const { rel, child, c, key, action } = ev;
    const users = [];
    for (const row of this.db.visibleRows(child, ctx)) if (c.cols.every((a, i) => row.vals[a] !== null && T().compare(row.vals[a], key[i], child.cols[a].type) === 0)) users.push(row);
    const event = action === 'cascade' && !ev.newKey ? 'delete' : 'update';
    if (users.length) ctx.bus.emit('dml.cascade', { from: rel.name, to: child.name, action, rows: users.length });
    const saved = { q: ctx.afterQueue, node: ctx.plNode, sets: ctx.plSets };
    ctx.afterQueue = q;
    ctx.plNode = null;
    ctx.plSets = event === 'update' ? (!ev.newKey && c.setCols || c.cols).slice() : null;
    try {
      yield* trig.statement(child, 'before', event, ctx);
      for (const u of users) {
        const p = yield* this.db.cc.prepareModify(child, u.tid, ctx, 'update');
        if (p === false || p.gone || p.moved) continue;
        if (event === 'delete') {
          if (!(yield* trig.row(child, 'before', 'delete', ctx, u.vals, null))) continue;
          yield* this.deleteRow(child, u.tid, u.vals, ctx);
          yield* trig.row(child, 'after', 'delete', ctx, u.vals, null);
          continue;
        }
        let nv = u.vals.slice();
        if (action === 'cascade') c.cols.forEach((a, i) => { nv[a] = ev.newKey[i]; });
        else if (action === 'set null') (!ev.newKey && c.setCols || c.cols).forEach((a) => { nv[a] = null; });
        else if (action === 'set default') { const b = new K.Binder(ctx.session); const defs = this.bindDefaults(b, child); (!ev.newKey && c.setCols || c.cols).forEach((a) => { nv[a] = defs[a] ? K.Expr.compile(defs[a], new Map())([], ctx) : null; }); }
        nv = yield* trig.row(child, 'before', 'update', ctx, u.vals, nv);
        if (!nv) continue;
        yield* this.updateRow(child, u.tid, u.vals, nv, ctx);
        if (action === 'set default' && c.cols.every((a) => nv[a] !== null)) q.push({ kind: 'fk', rel: child, c, key: c.cols.map((a) => nv[a]) });
        yield* trig.row(child, 'after', 'update', ctx, u.vals, nv);
      }
      yield* trig.statement(child, 'after', event, ctx);
    } finally { ctx.afterQueue = saved.q; ctx.plNode = saved.node; ctx.plSets = saved.sets; }
  };

  // a trigger depends on its function: DROP FUNCTION fails, or with CASCADE drops the triggers too
  if (K.DDL) {
    // the rules CREATE TRIGGER checks in PostgreSQL
    const origCreate = K.DDL.prototype.createTrigger;
    K.DDL.prototype.createTrigger = function* (st, ctx, cat, s) {
      const rel = cat.lookup(st.table, s.searchPath(), ['table', 'view']);
      const fail = (code, msg, extra) => { throw K.err(code, msg, extra); };
      if (rel) {
        const row = st.forEach === 'row';
        const evs = st.events.map((e) => e.event);
        if (evs.includes('truncate') && row) fail(S.featureNotSupported, 'TRUNCATE FOR EACH ROW triggers are not supported');
        if (st.timing === 'instead of' && rel.kind === 'view') {
          if (!row) fail(S.featureNotSupported, 'INSTEAD OF triggers must be FOR EACH ROW');
          if (st.when) fail(S.featureNotSupported, 'INSTEAD OF triggers cannot have WHEN conditions');
          if (st.events.some((e) => e.cols)) fail(S.featureNotSupported, 'INSTEAD OF triggers cannot have column lists');
        }
        if (rel.kind === 'view' && st.timing !== 'instead of' && row) fail(S.wrongObjectType, '"' + rel.name + '" is a view', { detail: 'Views cannot have row-level BEFORE or AFTER triggers.' });
        for (const e of st.events) for (const c of e.cols || []) if (!rel.cols.some((x) => x.name === c && !x.dropped)) fail(S.undefinedColumn, 'column "' + c + '" of relation "' + rel.name + '" does not exist');
        if (st.when) {
          const refs = new Set();
          let sub = false;
          const walk = (x) => { if (!x || typeof x !== 'object') return; if (Array.isArray(x)) { x.forEach(walk); return; } if (x.query) sub = true; if (x.k === 'col' && x.parts.length > 1) refs.add(x.parts[0]); for (const k of Object.keys(x)) if (k !== 'pos') walk(x[k]); };
          walk(st.when);
          if (sub) fail(S.featureNotSupported, 'cannot use subquery in trigger WHEN condition');
          if (!row && (refs.has('new') || refs.has('old'))) fail(S.invalidObjectDefinition || '42P17', 'statement trigger\'s WHEN condition cannot reference column values');
          if (evs.includes('insert') && refs.has('old')) fail('42P17', 'INSERT trigger\'s WHEN condition cannot reference OLD values');
          if (evs.includes('delete') && refs.has('new')) fail('42P17', 'DELETE trigger\'s WHEN condition cannot reference NEW values');
        }
        if (st.referencing) {
          if (st.timing !== 'after') fail('42P17', 'transition table name can only be specified for an AFTER trigger');
          if (evs.includes('truncate')) fail(S.featureNotSupported, 'TRUNCATE triggers with transition tables are not supported');
          if (evs.length > 1) fail(S.featureNotSupported, 'transition tables cannot be specified for triggers with more than one event');
          if (st.events.some((e) => e.cols)) fail(S.featureNotSupported, 'transition tables cannot be specified for triggers with column lists');
          if (st.referencing.old && !evs.includes('delete') && !evs.includes('update')) fail('42P17', 'OLD TABLE can only be specified for a DELETE or UPDATE trigger');
          if (st.referencing.new && !evs.includes('insert') && !evs.includes('update')) fail('42P17', 'NEW TABLE can only be specified for an INSERT or UPDATE trigger');
        }
        const fs = cat.userFuncs(st.func.name);
        if (fs.length && !fs.some((f) => f.retType && f.retType.id === 'trigger')) fail('42P17', 'function ' + st.func.name + ' must return type trigger');
      }
      return yield* origCreate.call(this, st, ctx, cat, s);
    };
    // TRUNCATE fires its statement-level triggers (there are no row-level ones)
    const origTruncate = K.DDL.prototype.truncate;
    K.DDL.prototype.truncate = function* (st, ctx, cat, s) {
      const trig = this.db.triggers;
      const rels = trig ? st.names.map((n) => cat.lookup(n, s.searchPath(), ['table'])).filter((r) => r && trig.has(r)) : [];
      for (const r of rels) for (const t of trig.list(r, 'before', 'truncate', 'statement')) yield* trig.fire(t, r, 'before', 'statement', 'truncate', ctx, null, null, null);
      const tag = yield* origTruncate.call(this, st, ctx, cat, s);
      for (const r of rels) for (const t of trig.list(r, 'after', 'truncate', 'statement')) yield* trig.fire(t, r, 'after', 'statement', 'truncate', ctx, null, null, null);
      return tag;
    };
    const origDrop = K.DDL.prototype.drop;
    K.DDL.prototype.drop = function* (st, ctx, cat, s) {
      if (st.kind === 'function') {
        for (const n of st.names) {
          const fs = cat.userFuncs(n.name).filter((f) => f.kind === 'function' && f.retType && f.retType.id === 'trigger');
          if (!fs.length) continue;
          const users = cat.tables(['table', 'view']).flatMap((r) => (r.triggers || []).filter((t) => t.func === n.name).map((t) => ({ r, t })));
          if (!users.length) continue;
          if (!st.cascade) throw K.err(S.dependentObjects, 'cannot drop function ' + n.name + '() because other objects depend on it', { detail: users.map((u) => 'trigger ' + u.t.name + ' on table ' + u.r.name + ' depends on function ' + n.name + '()').join('\n'), hint: 'Use DROP ... CASCADE to drop the dependent objects too.' });
          for (const u of users) { u.r.triggers = u.r.triggers.filter((t) => t !== u.t); s.notice('drop cascades to trigger ' + u.t.name + ' on table ' + u.r.name); }
          cat.version++;
        }
      }
      return yield* origDrop.call(this, st, ctx, cat, s);
    };
  }

  K.Triggers = Triggers;
})(typeof window !== 'undefined' ? window : globalThis);
