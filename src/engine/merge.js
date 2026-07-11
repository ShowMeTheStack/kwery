// MERGE, as in PostgreSQL 17: the target joined with the source on the ON condition; each joined row takes the
// first WHEN clause of its kind (MATCHED, NOT MATCHED [BY TARGET], NOT MATCHED BY SOURCE) whose condition holds,
// and that clause's action. A target row may be changed only once (21000). RETURNING sees merge_action().
(function (root) {
  'use strict';
  const K = root.K;
  const S = K.STATE;
  const B = () => K.T.BASE;

  // merge_action(): the action that produced a RETURNING row
  K.F.fn('merge_action', { args: [], ret: 'text', strict: false, volatile: true, fn: (v, ctx) => {
    if (!ctx || ctx.mergeAction === undefined) throw K.err(S.syntax, 'MERGE_ACTION() can only be used in the RETURNING list of a MERGE command');
    return ctx.mergeAction;
  } });

  /** the column ids an expression uses */
  function idsOf(e, b) { const out = new Set(); b.walk(e, (x) => { if (x.k === 'col') out.add(x.id); if (x.k === 'sub') for (const id of x.outerRefs || []) out.add(id); }, true); return out; }

  function* run(s, st, ctx, opts) {
    opts = opts || {};
    const db = s.db, dml = db.dml, trig = db.triggers;
    const b = opts.binderFor ? opts.binderFor(s) : new K.Binder(s);
    const found = s.catalog.lookup(st.table, s.searchPath(), ['table', 'view', 'matview', 'sequence']);
    if (!found) throw K.err(S.undefinedTable, 'relation "' + st.table.name + '" does not exist', { pos: st.pos });
    const actions = new Set(st.whens.map((w) => w.action).filter((a) => a !== 'nothing'));
    // a simple view is merged into through its base table, with the view's column names and WHERE condition
    let rel = found, view = null;
    if (found.kind === 'view') {
      if ((found.triggers || []).some((t) => t.timing === 'instead of')) throw K.err(S.featureNotSupported, 'MERGE on a view with INSTEAD OF triggers is not supported');
      const verb = actions.has('insert') ? 'insert' : actions.has('update') ? 'update' : 'delete';
      const base = dml.updatableView(b, found, verb, st.pos);
      rel = base.rel;
      view = { view: found, viewMap: base.map, where: base.where, alias: found.parsed && found.parsed.from[0] && found.parsed.from[0].alias ? found.parsed.from[0].alias.name : null };
    }
    if (rel.kind !== 'table') throw K.err(S.wrongObjectType, 'cannot execute MERGE on relation "' + rel.name + '"', { detail: 'This operation is not supported for ' + (rel.kind === 'view' ? 'views' : rel.kind === 'matview' ? 'materialized views' : 'sequences') + '.' });
    if (s.readOnly()) throw K.err(S.readOnlyTxn, 'cannot execute MERGE in a read-only transaction');
    for (const a of actions) s.checkPrivilege(found, a, st.pos);
    const talias = st.alias || found.name;

    // ---- binding: target and source in one scope, joined so every row of each side that a clause needs is seen
    const scope = new K.Scope(null);
    const tScan = b.fromItem({ kind: 'table', name: { schema: rel.schema, name: rel.name }, alias: { name: talias } }, scope);
    let tNode = tScan;
    if (view) {
      const item = scope.items[scope.items.length - 1];
      item.cols = view.viewMap.filter((m) => m.attnum !== undefined).map((m) => Object.assign({}, tScan.cols.find((c) => c.attnum === m.attnum), { name: m.name })).concat(tScan.cols.filter((c) => c.hidden));
      if (view.where) {
        const vs = new K.Scope(null);
        vs.items.push({ name: view.alias || rel.name, cols: tScan.cols, rel });
        tNode = { op: 'Filter', cond: b.boolExpr(view.where, vs, 'WHERE'), children: [tScan], cols: tScan.cols, where: true };
      }
    }
    const before = scope.items.length;
    const src = b.fromItem(st.source, scope);
    const srcItems = scope.items.slice(before);
    const markId = b.id();
    const srcProj = { op: 'Project', exprs: src.cols.map((c) => ({ k: 'col', id: c.id, type: c.type, name: c.name })).concat([K.cst(true, B().bool)]), children: [src], cols: src.cols.concat([{ id: markId, name: '?merge?', type: B().bool, hidden: true }]) };
    const targetIds = new Set(tScan.cols.map((c) => c.id));
    const sourceIds = new Set(src.cols.map((c) => c.id));
    const on = b.boolExpr(st.on, scope, 'JOIN/ON');
    const byTarget = st.whens.some((w) => !w.matched && w.by !== 'source');
    const bySource = st.whens.some((w) => !w.matched && w.by === 'source');
    const jtype = byTarget && bySource ? 'full' : byTarget ? 'right' : bySource ? 'left' : 'inner';
    const join = { op: 'Join', jtype, children: [tNode, srcProj], cols: tScan.cols.concat(srcProj.cols), cond: on };
    const refuse = (e, ids, item, what) => {
      for (const id of idsOf(e, b)) if (ids.has(id)) throw K.err(S.undefinedTable, 'invalid reference to FROM-clause entry for table "' + item + '"', { hint: 'There is an entry for table "' + item + '", but it cannot be referenced from this part of the query.', pos: st.pos, what });
    };
    const srcName = srcItems.length && srcItems[0].name ? srcItems[0].name : 'source';
    const defaults = dml.bindDefaults(b, rel);
    const generated = dml.bindGenerated(b, rel);
    const clauses = st.whens.map((w) => {
      const kind = w.matched ? 'matched' : w.by === 'source' ? 'source' : 'target';
      const c = { kind, action: w.action };
      if (w.cond) { c.cond = b.boolExpr(w.cond, scope, 'WHEN'); if (kind === 'target') refuse(c.cond, targetIds, talias); if (kind === 'source') refuse(c.cond, sourceIds, srcName); }
      if (w.action === 'update') {
        if (kind === 'target') throw K.err(S.syntax, 'syntax error at or near "UPDATE"');
        c.sets = dml.bindSets(b, w.set, scope, rel, view || undefined);
        if (kind === 'source') for (const x of c.sets) if (x.e.k !== 'default') refuse(x.e, sourceIds, srcName);
      }
      if (w.action === 'delete' && kind === 'target') throw K.err(S.syntax, 'syntax error at or near "DELETE"');
      if (w.action === 'insert') {
        if (kind !== 'target') throw K.err(S.syntax, 'syntax error at or near "INSERT"');
        const colOf = (n) => {
          const a = view ? (view.viewMap.find((m) => m.name === n) || {}).attnum : rel.cols.findIndex((x) => x.name === n && !x.dropped);
          if (a === undefined || a < 0) throw K.err(S.undefinedColumn, 'column "' + n + '" of relation "' + found.name + '" does not exist');
          return a;
        };
        let targets = w.cols ? w.cols.map(colOf) : view ? view.viewMap.filter((m) => m.attnum !== undefined).map((m) => m.attnum) : rel.cols.map((x, i) => (x.dropped ? -1 : i)).filter((i) => i >= 0);
        let values = [];
        if (!w.defaults) {
          if (w.values.length > targets.length) throw K.err(S.syntax, 'INSERT has more expressions than target columns');
          if (w.values.length < targets.length && w.cols) throw K.err(S.syntax, 'INSERT has more target columns than expressions');
          targets = targets.slice(0, w.values.length);
          values = w.values.map((e, i) => {
            if (e.k === 'default') return { k: 'default' };
            const x = dml.assign(b.expr(e, scope), rel.cols[targets[i]].type, rel.cols[targets[i]].name, b);
            refuse(x, targetIds, talias);
            return x;
          });
        } else targets = [];
        for (const a of targets) {
          const col = rel.cols[a];
          const v = values[targets.indexOf(a)];
          if (col.generated && v && v.k !== 'default') throw K.err(S.generatedAlways, 'cannot insert a non-DEFAULT value into column "' + col.name + '"', { detail: 'Column "' + col.name + '" is a generated column.' });
          if (col.identity === 'always' && v && v.k !== 'default') throw K.err(S.generatedAlways, 'cannot insert a non-DEFAULT value into column "' + col.name + '"', { detail: 'Column "' + col.name + '" is an identity column defined as GENERATED ALWAYS.', hint: 'Use OVERRIDING SYSTEM VALUE to override.' });
        }
        c.targets = targets;
        c.values = values;
      }
      return c;
    });
    let returning = null, retCols = null;
    if (st.returning) {
      const ts = b.targets(st.returning, scope);
      for (const t of ts) if (b.containsAgg(t.e)) throw K.err(S.groupingError, 'aggregate functions are not allowed in RETURNING');
      returning = ts.map((t) => t.e);
      retCols = ts.map((t) => ({ name: t.name, type: t.e.type }));
    }

    // ---- the plan, and compiled clauses over its rows
    const planner = new K.Planner(s, b);
    const plan = planner.plan(join);
    const lay = K.Exec.layoutOf(plan.cols);
    const C = (e) => K.Expr.compile(e, lay);
    const ctidIdx = lay.get(tScan.sys.ctid), markIdx = lay.get(markId);
    const tIdx = rel.cols.map((x, a) => { const c = tScan.cols.find((y) => y.attnum === a); return c ? lay.get(c.id) : undefined; });
    const defFns = defaults.map((e) => (e ? K.Expr.compile(e, new Map()) : null));
    for (const c of clauses) {
      c.condFn = c.cond ? C(c.cond) : null;
      if (c.sets) c.setFns = c.sets.map((x) => ({ attnum: x.attnum, f: x.e.k === 'default' ? null : C(x.e) }));
      if (c.values) c.valFns = c.values.map((x) => (x.k === 'default' ? null : C(x)));
    }
    const retFns = returning ? returning.map(C) : null;
    const node = { generated };
    const updSets = [...new Set(clauses.filter((c) => c.sets).flatMap((c) => c.sets.map((x) => x.attnum)))];

    const mctx = Object.assign({}, ctx, { planner, plTrig: null });
    mctx.subplan = (n, r, l) => s.subplan(mctx, n, r, l);
    yield* db.locks.acquire(mctx.tx, 'table:' + rel.oid, 'table', 'row exclusive', { what: 'relation ' + rel.name });
    const events = ['insert', 'update', 'delete'].filter((e) => actions.has(e));
    if (trig) for (const e of events) { mctx.plSets = e === 'update' ? updSets : null; yield* trig.statement(rel, 'before', e, mctx); }
    const touched = new Set();
    const out = [];
    let count = 0;
    const emit = (row, vals, action) => {
      if (!retFns) return;
      const r = row.slice();
      for (let a = 0; a < rel.cols.length; a++) if (tIdx[a] !== undefined) r[tIdx[a]] = vals ? vals[a] : null;
      mctx.mergeAction = action;
      out.push(retFns.map((f) => f(r, mctx)));
      mctx.mergeAction = undefined;
    };
    for (let r of K.Exec.run(plan, mctx)) {
      if (K.Exec.isSignal(r)) { s.waiting = r; yield r; s.waiting = null; continue; }
      const kind = r[markIdx] === null ? 'source' : r[ctidIdx] === null ? 'target' : 'matched';
      let tid = kind === 'target' ? null : tidOf(r[ctidIdx]);
      for (let attempt = 0; attempt < 100; attempt++) {
        const c = clauses.find((x) => x.kind === kind && (!x.condFn || x.condFn(r, mctx) === true));
        if (!c || c.action === 'nothing') break;
        if (c.action === 'insert') {
          const vals = new Array(rel.cols.length).fill(null);
          const given = new Array(rel.cols.length).fill(false);
          c.targets.forEach((a, i) => { if (c.valFns[i]) { vals[a] = c.valFns[i](r, mctx); given[a] = true; } });
          for (let a = 0; a < rel.cols.length; a++) {
            const col = rel.cols[a];
            if (col.dropped || given[a] || col.generated) continue;
            if (col.identity && col.seq) vals[a] = db.castTo(db.sequenceNext(s.catalog.rel(col.seq), mctx), col.type, mctx);
            else if (defFns[a]) vals[a] = defFns[a]([], mctx);
          }
          dml.generate(node, vals, mctx);
          let nv = vals;
          if (trig) { mctx.plSets = null; nv = yield* trig.row(rel, 'before', 'insert', mctx, null, vals); if (!nv) break; }
          yield* dml.insertRow(rel, nv, mctx);
          if (trig) yield* trig.row(rel, 'after', 'insert', mctx, null, nv);
          count++;
          emit(r, nv, 'INSERT');
          break;
        }
        // UPDATE and DELETE change the target row, which must not be changed twice
        const key = tid.b + ':' + tid.o;
        if (touched.has(key)) throw K.err(S.cardinality, 'MERGE command cannot affect row a second time', { hint: 'Ensure that not more than one source row matches any one target row.' });
        const p = yield* db.cc.prepareModify(rel, tid, mctx, 'update');
        if (p === false || p.gone) { if (p && p.gone && p.self) throw K.err(S.cardinality, 'MERGE command cannot affect row a second time', { hint: 'Ensure that not more than one source row matches any one target row.' }); break; }
        if (!p.ok) {
          // READ COMMITTED: another transaction changed the row; take its newest version and decide again
          const latest = db.cc.latest(rel, p.moved);
          if (!latest || db.xact.aborted(latest.h.xmin)) break;
          const t = db.heap(rel).fetch(latest.tid);
          const vals = K.Tuple.deform(t.bytes, rel.cols, mctx);
          db.buffers.unpin(t.frame, false);
          r = r.slice();
          rel.cols.forEach((x, a) => { if (tIdx[a] !== undefined) r[tIdx[a]] = vals[a]; });
          r[ctidIdx] = '(' + latest.tid.b + ',' + latest.tid.o + ')';
          tid = latest.tid;
          continue;
        }
        tid = p.tid;
        const old = rel.cols.map((x, a) => (tIdx[a] !== undefined ? r[tIdx[a]] : null));
        touched.add(tid.b + ':' + tid.o);
        if (c.action === 'delete') {
          if (trig && !(yield* trig.row(rel, 'before', 'delete', mctx, old, null))) break;
          yield* dml.deleteRow(rel, tid, old, mctx);
          if (trig) yield* trig.row(rel, 'after', 'delete', mctx, old, null);
          count++;
          emit(r, old, 'DELETE');
          break;
        }
        let vals = old.slice();
        for (const x of c.setFns) {
          const col = rel.cols[x.attnum];
          vals[x.attnum] = x.f ? x.f(r, mctx) : col.identity && col.seq ? db.castTo(db.sequenceNext(s.catalog.rel(col.seq), mctx), col.type, mctx) : defFns[x.attnum] ? defFns[x.attnum]([], mctx) : null;
        }
        dml.generate(node, vals, mctx);
        if (trig) { mctx.plSets = c.sets.map((x) => x.attnum); vals = yield* trig.row(rel, 'before', 'update', mctx, old, vals); if (!vals) break; }
        const nt = yield* dml.updateRow(rel, tid, old, vals, mctx);
        touched.add(nt.b + ':' + nt.o);
        if (trig) yield* trig.row(rel, 'after', 'update', mctx, old, vals);
        count++;
        emit(r, vals, 'UPDATE');
        break;
      }
    }
    // AFTER STATEMENT triggers fire in the opposite order: DELETE, UPDATE, INSERT
    if (trig) yield* trig.flushRows(rel, events, mctx);
    if (trig) for (const e of events.slice().reverse()) { mctx.plSets = e === 'update' ? updSets : null; yield* trig.statement(rel, 'after', e, mctx); }
    yield* dml.runAfter(mctx);
    if (s.checkAssertions) yield* s.checkAssertions(mctx, { op: 'Modify', rel });
    ctx.rowCount = (ctx.rowCount || 0) + count;
    db.bus.emit('dml.merge', { table: rel.name, rows: count });
    const res = new K.Result('MERGE ' + count, retCols, retCols ? out : null);
    res.count = count;
    return res;
  }
  const tidOf = (x) => { const m = /^\((\d+),(\d+)\)$/.exec(x); return { b: +m[1], o: +m[2] }; };

  K.Merge = { run };
})(typeof window !== 'undefined' ? window : globalThis);
