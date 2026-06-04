// The binder: a parsed query becomes a logical plan (a tree of relational algebra operators) whose expressions
// refer to columns by id. It resolves names through nested scopes (so correlated subqueries work), checks
// grouping and aggregates, collects window functions, expands *, and types everything.
//
// Plan nodes: { op, cols: [{ id, name, type, table }], children, ...op-specific }
//   Scan(rel) Values(rows) Func(calls) CteScan(cte) Subquery(child) Result(no input, one row)
//   Filter(cond) Project(exprs) Join(jtype, cond) Aggregate(groups, sets, aggs) Window(wins) Sort(keys)
//   Distinct(on) Limit(limit, offset) SetOp(op, all) RecursiveUnion(cte) Modify(...) LockRows
(function (root) {
  'use strict';
  const K = root.K;
  const S = K.STATE;
  const B = () => K.T.BASE;
  const T = () => K.T;
  const X = () => K.Expr;

  class Scope {
    constructor(parent, opts) {
      this.parent = parent || null;
      this.items = [];          // FROM items: { name, cols: [{ name, id, type, hidden }], rel, kind, lateralOk }
      this.ctes = new Map();    // name -> cte
      this.outerRefs = new Set(); // ids from enclosing scopes used here (correlation)
      Object.assign(this, opts || {});
    }
    findCte(name) { for (let s = this; s; s = s.parent) { if (s.ctes.has(name)) return s.ctes.get(name); } return null; }
  }

  class Binder {
    constructor(session) {
      this.s = session;
      this.db = session.db;
      this.cat = session.catalog;
      this.nextId = 1;
      this.paramTypes = [];
    }
    id() { return this.nextId++; }
    path() { return this.s.searchPath(); }
    fail(code, msg, pos, extra) { throw K.err(code, msg, Object.assign({ pos }, extra || {})); }

    // ---- queries ----------------------------------------------------------------------------------------------
    /** bind any query (SELECT, VALUES, set operation), with its WITH, ORDER BY and LIMIT */
    query(q, parent, opts) {
      const scope = new Scope(parent, { top: !parent });
      if (q.with) this.withClause(q.with, scope);
      let node;
      if (q.type === 'select') node = this.select(q, scope, opts);
      else if (q.type === 'values') node = this.values(q, scope);
      else if (q.type === 'setop') node = this.setop(q, scope);
      else if (q.type === 'insert' || q.type === 'update' || q.type === 'delete') node = this.db.dml.bind(this, q, scope);
      else this.fail(S.syntax, 'not a query', q.pos);
      if (q.type !== 'select') node = this.orderLimit(q, node, scope, null);
      node.outerRefs = scope.outerRefs;
      // data-modifying CTEs run to completion even when nothing reads them
      if (q.with) { const dml = [...scope.ctes.values()].filter((c) => c.dml); if (dml.length) { if (!scope.top) this.fail(S.featureNotSupported, 'WITH clause containing a data-modifying statement must be at the top level', q.pos); node.dmlCtes = dml; } }
      return node;
    }
    withClause(w, scope) {
      for (const c of w.ctes) {
        if (scope.ctes.has(c.name)) this.fail(S.duplicateAlias, 'WITH query name "' + c.name + '" specified more than once', c.query.pos);
        const cte = { name: c.name, colNames: c.cols, ast: c.query, recursive: false, materialized: c.materialized, refs: 0, search: c.search, cycle: c.cycle };
        scope.ctes.set(c.name, cte);
        if (w.recursive && this.refersTo(c.query, c.name)) this.recursiveCte(cte, c, scope);
        else {
          // a non-recursive CTE may not see itself (or later ones), only earlier ones
          scope.ctes.delete(c.name);
          cte.plan = this.query(c.query, scope);
          scope.ctes.set(c.name, cte);
          cte.cols = this.cteCols(cte, cte.plan);
          if (['insert', 'update', 'delete'].includes(c.query.type)) cte.dml = true;
        }
      }
    }
    cteCols(cte, plan) {
      const cols = plan.cols.filter((c) => !c.hidden);
      if (cte.colNames && cte.colNames.length > cols.length) this.fail(S.invalidColumnReference, 'WITH query "' + cte.name + '" has ' + cols.length + ' columns available but ' + cte.colNames.length + ' columns specified');
      return cols.map((c, i) => ({ name: cte.colNames && cte.colNames[i] ? cte.colNames[i] : c.name, type: c.type }));
    }
    refersTo(ast, name) {
      let found = false;
      const walk = (x) => {
        if (found || !x || typeof x !== 'object') return;
        if (Array.isArray(x)) { x.forEach(walk); return; }
        if (x.kind === 'table' && !x.name.schema && x.name.name === name) { found = true; return; }
        for (const k in x) if (k !== 'pos') walk(x[k]);
      };
      walk(ast);
      return found;
    }
    /** WITH RECURSIVE: non-recursive term UNION [ALL] recursive term; the recursive term reads the working table */
    recursiveCte(cte, c, scope) {
      const q = c.query;
      if (q.type !== 'setop' || q.op !== 'union') this.fail(S.invalidRecursion, 'recursive query "' + c.name + '" does not have the form non-recursive-term UNION [ALL] recursive-term', q.pos);
      if (this.refersTo(q.left, c.name)) this.fail(S.invalidRecursion, 'recursive reference to query "' + c.name + '" must not appear within its non-recursive term', q.left.pos);
      for (const [k, w] of [['order', 'ORDER BY'], ['offset', 'OFFSET'], ['limit', 'LIMIT'], ['locking', 'FOR UPDATE/SHARE']]) if (q[k] !== undefined && q[k] !== null && !(Array.isArray(q[k]) && !q[k].length)) this.fail(S.featureNotSupported, w + ' in a recursive query is not implemented', q.pos);
      this.checkRecursiveTerm(q.right, c.name);
      cte.recursive = true;
      scope.ctes.delete(c.name);
      let base = this.query(q.left, scope);
      // an untyped literal in the non-recursive term is text
      const unk = (x) => x.type && (x.type.id === 'unknown' || x.type.id === 'null');
      if (base.cols.some((x) => !x.hidden && unk(x))) base = this.castTo(base, base.cols.filter((x) => !x.hidden).map((x) => ({ type: unk(x) ? B().text : x.type })));
      scope.ctes.set(c.name, cte);
      cte.cols = this.cteCols(cte, base);
      const nOrig = cte.cols.length;
      const sc = (c.search || c.cycle) && this.searchCycle(cte, c);
      cte.workId = this.id();
      cte.binding = true;
      const rec = this.query(q.right, scope);
      cte.binding = false;
      const rvis = rec.cols.filter((x) => !x.hidden);
      if (rvis.length !== nOrig) this.fail(S.syntax, 'each UNION query must have the same number of columns', q.right.pos);
      // the recursive term may not widen a column's type: the non-recursive term fixes it
      const mod = (t) => [t.id, t.n, t.p, t.s, t.prec].join(',');
      for (let i = 0; i < nOrig; i++) {
        if (unk(rvis[i])) continue;
        const bt = cte.cols[i].type, all = T().common([bt, rvis[i].type], 'UNION types');
        if (mod(all) !== mod(bt)) this.fail(S.datatypeMismatch, 'recursive query "' + c.name + '" column ' + (i + 1) + ' has type ' + T().sqlName(bt) + ' in non-recursive term but type ' + T().sqlName(all) + ' overall', q.left.pos, { hint: 'Cast the output of the non-recursive term to the correct type.' });
      }
      if (sc) this.passParentCols(rec, cte, nOrig, q.right.pos);
      // the recursive term fixes the types: the non-recursive term's types win
      const outCols = cte.cols.map((col) => ({ id: this.id(), name: col.name, type: col.type }));
      cte.plan = {
        op: 'RecursiveUnion', all: q.all, cte, children: [this.castTo(base, cte.cols), this.castTo(rec, cte.cols)], cols: outCols,
      };
      if (sc) Object.assign(cte.plan, sc, { nOrig });
    }
    /** the recursive reference must appear once, outside subqueries and the nullable side of outer joins; no aggregates */
    checkRecursiveTerm(ast, name) {
      let count = 0;
      const msg = (what) => this.fail(S.invalidRecursion, 'recursive reference to query "' + name + '" must not appear ' + what, ast.pos);
      const walk = (x, inSub, inOuter) => {
        if (!x || typeof x !== 'object') return;
        if (Array.isArray(x)) { x.forEach((y) => walk(y, inSub, inOuter)); return; }
        if (x.kind === 'table' && x.name && !x.name.schema && x.name.name === name) {
          if (inSub) msg('within a subquery');
          if (inOuter) msg('within an outer join');
          if (++count > 1) msg('more than once');
          return;
        }
        if (x.kind === 'join') {
          walk(x.left, inSub, inOuter || x.jtype === 'right' || x.jtype === 'full');
          walk(x.right, inSub, inOuter || x.jtype === 'left' || x.jtype === 'full');
          walk(x.on, inSub, inOuter);
          return;
        }
        for (const k in x) if (k !== 'pos') walk(x[k], inSub || (k === 'query' && !!x.k), inOuter);
      };
      walk(ast, false, false);
      if (ast.type === 'select') {
        let agg = false;
        const find = (x) => { if (!x || typeof x !== 'object' || agg) return; if (Array.isArray(x)) { x.forEach(find); return; } if (x.k === 'fn' && !x.over && K.F.AGGS.get(x.name)) { agg = true; return; } for (const k in x) if (k !== 'query' && k !== 'pos') find(x[k]); };
        find(ast.targets); find(ast.having);
        if (agg) this.fail(S.invalidRecursion, 'aggregate functions are not allowed in a recursive query\'s recursive term', ast.pos);
      }
    }
    /**
     * SEARCH and CYCLE add columns to a recursive CTE: the search order (an array of key rows, or a
     * (depth, keys) row), the cycle mark and the path; the executor computes them from the parent row's values
     */
    searchCycle(cte, c) {
      const names = cte.cols.map((x) => x.name);
      const keyIdx = (list, what) => list.map((n) => { const i = names.indexOf(n); if (i < 0) this.fail(S.syntax, what + ' column "' + n + '" not in WITH query column list'); return i; });
      const rowOf = (idx, pre) => ({ id: 'record', name: 'record', cat: 'C', len: -1, fields: (pre || []).concat(idx.map((i) => ({ name: names[i], type: cte.cols[i].type }))) });
      const out = {};
      const add = (name, type, what) => { if (cte.cols.some((x) => x.name === name)) this.fail(S.ambiguousColumn, what + ' column name "' + name + '" already used in WITH query column list'); cte.cols.push({ name, type }); };
      if (c.search) {
        const idx = keyIdx(c.search.by, 'search');
        const kt = rowOf(idx);
        const t = c.search.depth ? K.T.arrayOf(kt) : rowOf(idx, [{ name: '*DEPTH*', type: B().int8 }]);
        add(c.search.set, t, 'search sequence');
        out.search = { depth: c.search.depth, keys: idx, keyType: kt, type: t };
      }
      if (c.cycle) {
        const idx = keyIdx(c.cycle.cols, 'cycle');
        const kt = rowOf(idx);
        let mark = K.cst(true, B().bool), def = K.cst(false, B().bool);
        if (c.cycle.to) {
          const sc = new Scope(null);
          mark = this.expr(c.cycle.to, sc); def = this.expr(c.cycle.def, sc);
          const t = T().common([mark.type, def.type], 'CYCLE types');
          mark = X().coerce(mark, t); def = X().coerce(def, t);
          if (mark.k !== 'const' || def.k !== 'const') this.fail(S.syntax, 'cycle mark values must be constants');
        }
        if (c.cycle.using === c.cycle.set) this.fail(S.syntax, 'cycle path column name and cycle mark column name are the same');
        add(c.cycle.set, mark.type, 'cycle mark');
        add(c.cycle.using, K.T.arrayOf(kt), 'cycle path');
        out.cycle = { keys: idx, keyType: kt, mark: mark.v, def: def.v };
      }
      return out;
    }
    /** the recursive term carries the working-table row's added columns through, for the executor to extend */
    passParentCols(rec, cte, nOrig, pos) {
      const chain = [];
      let p = rec;
      while (p && p.op !== 'Project' && p.children && p.children.length === 1) { chain.push(p); p = p.children[0]; }
      let wt = null;
      const find = (n) => { if (!n || wt) return; if (n.op === 'WorkTable' && n.cte === cte) wt = n; else for (const ch of n.children || []) find(ch); };
      if (p && p.op === 'Project') find(p.children[0]);
      if (!wt) this.fail(S.featureNotSupported, 'SEARCH and CYCLE need the recursive reference in the FROM clause of the recursive term', pos);
      const extra = wt.cols.slice(nOrig).map((c) => ({ id: this.id(), name: c.name, type: c.type, src: c }));
      p.exprs = p.exprs.slice(0, p.cols.filter((c) => !c.hidden).length).concat(extra.map((e) => ({ k: 'col', id: e.src.id, type: e.type }))).concat(p.exprs.slice(p.cols.filter((c) => !c.hidden).length));
      const vis = p.cols.filter((c) => !c.hidden), hid = p.cols.filter((c) => c.hidden);
      const cols = vis.concat(extra.map((e) => ({ id: e.id, name: e.name, type: e.type }))).concat(hid);
      for (const n of chain) if (n.cols === p.cols) n.cols = cols;
      p.cols = cols;
    }
    /** wrap a node in a projection that casts its columns to the given types (for UNION and recursive CTEs) */
    castTo(node, cols) {
      const vis = node.cols.filter((c) => !c.hidden);
      if (vis.every((c, i) => c.type.id === cols[i].type.id)) return node;
      const exprs = vis.map((c, i) => X().coerce({ k: 'col', id: c.id, type: c.type, name: c.name }, cols[i].type, true));
      return { op: 'Project', children: [node], exprs, cols: vis.map((c, i) => ({ id: this.id(), name: c.name, type: cols[i].type })) };
    }

    select(q, scope, opts) {
      opts = opts || {};
      // FROM
      let node = null;
      for (const f of q.from) {
        const n = this.fromItem(f, scope);
        node = node ? { op: 'Join', jtype: 'cross', children: [node, n], cols: node.cols.concat(n.cols), cond: null, implicit: true } : n;
      }
      if (!node) node = { op: 'Result', cols: [], children: [] };
      // WHERE
      if (q.where) {
        const c = this.boolExpr(q.where, scope, 'WHERE', { noAgg: 'aggregate functions are not allowed in WHERE', noWin: 'window functions are not allowed in WHERE' });
        node = { op: 'Filter', cond: c, children: [node], cols: node.cols, where: true };
        if (scope.outerAggs) this.fail(S.groupingError, 'aggregate functions are not allowed in WHERE', q.where.pos);
      }
      // named windows (WINDOW w AS (...)), which may build on one another
      const savedWindows = this.currentWindows;
      if (q.windows) {
        const named = new Map();
        for (const w of q.windows) {
          if (named.has(w.name)) this.fail(S.windowingError, 'window "' + w.name + '" is already defined', q.pos);
          let spec = w.spec;
          if (spec.ref) { const base = named.get(spec.ref); if (!base) this.fail(S.undefinedObject, 'window "' + spec.ref + '" does not exist', q.pos); if (spec.partition) this.fail(S.windowingError, 'cannot override PARTITION BY clause of window "' + spec.ref + '"', q.pos); if (base.order && spec.order) this.fail(S.windowingError, 'cannot override ORDER BY clause of window "' + spec.ref + '"', q.pos); if (base.frame) this.fail(S.windowingError, 'cannot copy window "' + spec.ref + '" because it has a frame clause', q.pos); spec = Object.assign({}, base, spec, { ref: undefined }); }
          named.set(w.name, spec);
        }
        this.currentWindows = named;
      } else this.currentWindows = null;
      // the select list, bound against the FROM scope (aggregates and windows still as calls)
      const targets = this.targets(q.targets, scope);
      const hasAgg = !!(q.groupBy && q.groupBy.length) || !!q.having || targets.some((t) => this.containsAgg(t.e));
      // ORDER BY may name output columns, positions, or any expression of the FROM scope
      let order = null;
      if (q.order) order = this.orderItems(q.order, targets, scope);
      let having = q.having ? this.boolExpr(q.having, scope, 'HAVING', { inAgg: true, noWin: 'window functions are not allowed in HAVING' }) : null;
      if (hasAgg || this.anyAgg(order) || scope.outerAggs) {
        const r = this.aggregate(q, scope, node, targets, having, order);
        node = r.node; having = r.having; order = r.order;
        if (having) node = { op: 'Filter', cond: having, children: [node], cols: node.cols, having: true };
      }
      // windows
      const wins = [];
      const collectWins = (e) => this.mapExpr(e, (x) => { if (x.k === 'wincall') { wins.push(x); return { k: 'col', id: x.outId, type: x.type, name: x.name }; } return null; });
      for (const t of targets) t.e = collectWins(t.e);
      if (order) for (const o of order) o.e = collectWins(o.e);
      if (wins.length) node = this.window(q, wins, node, scope);
      // projection
      const outCols = targets.map((t) => ({ id: this.id(), name: t.name, type: t.e.type, srcId: t.e.k === 'col' ? t.e.id : undefined }));
      let exprs = targets.map((t) => t.e);
      // hidden sort columns: expressions ORDER BY needs that are not in the select list
      if (order) {
        for (const o of order) {
          if (o.target !== undefined) { o.id = outCols[o.target].id; continue; }
          const k = this.key(o.e);
          const i = exprs.findIndex((e) => this.key(e) === k);
          if (i >= 0 && i < targets.length) { o.id = outCols[i].id; continue; }
          if (q.distinct && !q.distinctOn) this.fail(S.invalidColumnReference, 'for SELECT DISTINCT, ORDER BY expressions must appear in select list', o.pos);
          const id = this.id();
          exprs.push(o.e);
          outCols.push({ id, name: '?sort?', type: o.e.type, hidden: true });
          o.id = id;
        }
      }
      // DISTINCT ON keys may be expressions outside the select list: they become hidden columns too
      const keys = q.distinctOn && q.distinctOn.map((e) => {
        const b = this.bindOrderRef(e, targets, scope, true);
        if (b.target !== undefined) return outCols[b.target].id;
        const k = this.key(b.e); const i = exprs.findIndex((x) => this.key(x) === k);
        if (i >= 0) return outCols[i].id;
        const id = this.id();
        exprs.push(b.e);
        outCols.push({ id, name: '?distinct?', type: b.e.type, hidden: true });
        return id;
      });
      node = { op: 'Project', exprs, children: [node], cols: outCols };
      if (exprs.some((x) => { let f = false; this.walk(x, (y) => { if (y.k === 'srfcall') f = true; }, true); return f; })) node.op = 'ProjectSet';
      // DISTINCT and DISTINCT ON
      if (q.distinctOn) {
        if (order) for (let i = 0; i < Math.min(keys.length, order.length); i++) if (!keys.includes(order[i].id)) this.fail(S.invalidColumnReference, 'SELECT DISTINCT ON expressions must match initial ORDER BY expressions', q.pos);
        // DISTINCT ON keeps the first row of each group in ORDER BY order, so the rows are sorted first
        const ord = order || keys.map((id) => ({ id, dir: 'asc' }));
        const sorted = { op: 'Sort', keys: ord.map((o) => ({ id: o.id, dir: o.dir, nulls: o.nulls || (o.dir === 'desc' ? 'first' : 'last'), type: (node.cols.find((c) => c.id === o.id) || {}).type })), children: [node], cols: node.cols };
        node = { op: 'Distinct', on: keys, order: ord, children: [sorted], cols: node.cols };
      } else if (q.distinct) node = { op: 'Distinct', children: [node], cols: node.cols };
      node = this.orderLimit(q, node, scope, order);
      if (q.into && !opts.allowInto) node.into = q.into;
      this.currentWindows = savedWindows;
      return node;
    }
    anyAgg(order) { return !!order && order.some((o) => this.containsAgg(o.e)); }
    /** ORDER BY, LIMIT and OFFSET on top of a node */
    orderLimit(q, node, scope, order) {
      if (q.order && !order) {
        // a set operation or VALUES: ORDER BY may only name output columns
        const vis = node.cols.filter((c) => !c.hidden);
        order = q.order.map((o) => {
          let id;
          if (o.expr.k === 'lit' && o.expr.type === 'int') { const n = +o.expr.v; if (n < 1 || n > vis.length) this.fail(S.invalidColumnReference, 'ORDER BY position ' + n + ' is not in select list', o.expr.pos); id = vis[n - 1].id; }
          else if (o.expr.k === 'col' && o.expr.parts.length > 1) this.fail(S.undefinedTable, 'missing FROM-clause entry for table "' + o.expr.parts[o.expr.parts.length - 2] + '"', o.expr.pos);
          else if (o.expr.k === 'col' && o.expr.parts.length === 1) { const c = vis.find((x) => x.name === o.expr.parts[0]); if (!c) this.fail(S.undefinedColumn, 'column "' + o.expr.parts[0] + '" does not exist', o.expr.pos, { hint: 'In a set operation ORDER BY may only use output column names or positions.' }); id = c.id; }
          else this.fail(S.featureNotSupported, 'invalid UNION/INTERSECT/EXCEPT ORDER BY clause: only result column names can be used, not expressions or functions', o.expr.pos);
          return { id, dir: o.dir, nulls: o.nulls };
        });
      }
      if (order && order.length) node = { op: 'Sort', keys: order.map((o) => ({ id: o.id, dir: o.dir, nulls: o.nulls || (o.dir === 'desc' ? 'first' : 'last'), type: (node.cols.find((c) => c.id === o.id) || {}).type })), children: [node], cols: node.cols };
      if (q.withTies && !(order && order.length)) this.fail(S.syntax, 'WITH TIES cannot be specified without ORDER BY clause', q.pos);
      // rows are locked below LIMIT, as in PostgreSQL: a row skipped (SKIP LOCKED) does not use up the limit
      if (q.locking) node = { op: 'LockRows', locking: q.locking, children: [node], cols: node.cols };
      if (q.limit !== undefined || q.offset !== undefined) {
        const lim = q.limit === null || q.limit === undefined ? null : this.scalarConst(q.limit, scope, 'LIMIT');
        const off = q.offset === undefined ? null : this.scalarConst(q.offset, scope, 'OFFSET');
        node = { op: 'Limit', limit: lim, offset: off, withTies: !!q.withTies, children: [node], cols: node.cols, sortKeys: order };
      }
      // the hidden sort columns are dropped once sorted
      if (node.cols.some((c) => c.hidden)) {
        const vis = node.cols.filter((c) => !c.hidden);
        node = { op: 'Project', exprs: vis.map((c) => ({ k: 'col', id: c.id, type: c.type })), children: [node], cols: vis.map((c) => ({ id: c.id, name: c.name, type: c.type })), passthrough: true };
      }
      return node;
    }
    scalarConst(e, scope, what) {
      const b = this.expr(e, scope, { noAgg: 'aggregate functions are not allowed in ' + what, noWin: 'window functions are not allowed in ' + what });
      if (this.hasColumns(b)) this.fail(S.syntax, 'argument of ' + what + ' must not contain variables', e.pos);
      // LIMIT and OFFSET take an assignment cast, so a numeric argument is rounded
      return X().coerce(b, B().int8, b.type && b.type.cat === 'N', 'argument of ' + what);
    }
    hasColumns(b) { let f = false; this.walk(b, (x) => { if (x.k === 'col' || x.k === 'outer') f = true; }); return f; }

    values(q, scope) {
      const rows = q.rows.map((r) => r.map((e) => (e.k === 'default' ? { k: 'default', type: B().unknown } : this.expr(e, scope, { noAgg: 'aggregate functions are not allowed in VALUES' }))));
      const n = rows[0].length;
      for (const r of rows) if (r.length !== n) this.fail(S.syntax, 'VALUES lists must all be the same length', q.pos);
      const types = K.range(n).map((i) => T().common(rows.map((r) => r[i].type), 'VALUES types'));
      const coerced = rows.map((r) => r.map((e, i) => (e.k === 'default' ? e : X().coerce(e, types[i], false, 'VALUES item'))));
      return { op: 'Values', tuples: coerced, cols: types.map((t, i) => ({ id: this.id(), name: 'column' + (i + 1), type: t })), children: [] };
    }
    setop(q, scope) {
      if (q.locking && q.locking.length) this.fail(S.featureNotSupported, 'FOR ' + q.locking[0].mode.toUpperCase() + ' is not allowed with UNION/INTERSECT/EXCEPT', q.pos);
      const l = this.query(q.left, scope), r = this.query(q.right, scope);
      const lc = l.cols.filter((c) => !c.hidden), rc = r.cols.filter((c) => !c.hidden);
      if (lc.length !== rc.length) this.fail(S.syntax, 'each ' + q.op.toUpperCase() + ' query must have the same number of columns', q.right.pos !== undefined ? q.right.pos : q.pos);
      const types = lc.map((c, i) => T().common([c.type, rc[i].type], q.op.toUpperCase() + ' types'));
      const outCols = lc.map((c, i) => ({ id: this.id(), name: c.name, type: types[i] }));
      return { op: 'SetOp', setop: q.op, all: q.all, children: [this.castTo(l, outCols), this.castTo(r, outCols)], cols: outCols };
    }

    // ---- FROM -------------------------------------------------------------------------------------------------
    fromItem(f, scope) {
      if (f.kind === 'join') return this.join(f, scope);
      let node, name, cols;
      if (f.kind === 'table') {
        const cte = !f.name.schema && scope.findCte(f.name.name);
        if (cte) {
          if (cte.binding) {
            // the recursive reference: reads the working table
            node = { op: 'WorkTable', cte, cols: cte.cols.map((c) => ({ id: this.id(), name: c.name, type: c.type })), children: [] };
          } else {
            cte.refs++;
            node = { op: 'CteScan', cte, cols: cte.cols.map((c) => ({ id: this.id(), name: c.name, type: c.type })), children: [] };
          }
          name = f.alias ? f.alias.name : f.name.name;
        } else {
          const rel = this.cat.lookup(f.name, this.path(), ['table', 'view', 'matview', 'sequence', 'foreign', 'system']);
          if (!rel) {
            const sys = this.db.systemView(f.name, this.s);
            if (sys) { node = sys(this); name = f.alias ? f.alias.name : f.name.name; }
            else this.fail(S.undefinedTable, 'relation "' + (f.name.schema ? f.name.schema + '.' : '') + f.name.name + '" does not exist', f.pos);
          } else {
            // with only column grants, each referenced column is checked when it is used
            let colPriv = null;
            try { this.s.checkPrivilege(rel, 'select', f.pos, this.asUser); } catch (e) { if (!this.s.hasColumnGrant(rel, 'select', this.asUser)) throw e; colPriv = { rel, asUser: this.asUser }; }
            name = f.alias ? f.alias.name : rel.name;
            if (rel.kind === 'view') node = this.viewNode(rel, scope);
            else if (rel.kind === 'matview' && rel.populated === false) this.fail('55000', 'materialized view "' + rel.name + '" has not been populated', f.pos, { hint: 'Use the REFRESH MATERIALIZED VIEW command.' });
            else if (rel.kind === 'sequence') node = { op: 'SeqState', rel, cols: [{ id: this.id(), name: 'last_value', type: B().int8 }, { id: this.id(), name: 'log_cnt', type: B().int8 }, { id: this.id(), name: 'is_called', type: B().bool }], children: [] };
            else {
              node = { op: 'Scan', rel, alias: name, only: f.only, cols: [], children: [], sample: f.sample ? { method: f.sample.method, args: f.sample.args.map((a) => this.expr(a, scope)), seed: f.sample.seed ? this.expr(f.sample.seed, scope) : null } : null };
              rel.cols.forEach((c, i) => { if (!c.dropped) node.cols.push(Object.assign({ id: this.id(), name: c.name, type: c.type, attnum: i, table: name, notNull: c.notNull }, colPriv ? { priv: Object.assign({ col: c.name }, colPriv) } : {})); });
              // the system columns, hidden unless named
              node.sys = { ctid: this.id(), xmin: this.id(), xmax: this.id(), tableoid: this.id() };
              // they travel with the row as hidden columns, so any operator above can read them
              node.cols.push({ id: node.sys.ctid, name: 'ctid', type: B().text, sys: 'ctid', hidden: true, table: name }, { id: node.sys.xmin, name: 'xmin', type: B().xid, sys: 'xmin', hidden: true, table: name }, { id: node.sys.xmax, name: 'xmax', type: B().xid, sys: 'xmax', hidden: true, table: name }, { id: node.sys.tableoid, name: 'tableoid', type: B().regclass, sys: 'tableoid', hidden: true, table: name });
              // row-level security: only the rows the user's SELECT policies allow
              const rq = this.db.dml.rls(this.s, rel, 'select', 'using', this.asUser);
              if (rq) {
                const ps = new Scope(null);
                ps.items.push({ name: rel.name, cols: node.cols.filter((c) => !c.hidden), rel });
                node = { op: 'Filter', cond: this.boolExpr(rq, ps, 'POLICY'), children: [node], cols: node.cols, sys: node.sys, rel, where: true };
              }
            }
          }
        }
      } else if (f.kind === 'sub') {
        const sub = new Scope(scope, { lateral: f.lateral });
        if (!f.lateral) sub.blockSiblings = true;
        const child = this.query(f.query, f.lateral ? this.lateralScope(scope) : this.nonLateral(scope));
        void sub;
        name = f.alias && f.alias.name ? f.alias.name : null;
        node = { op: 'Subquery', children: [child], cols: child.cols.filter((c) => !c.hidden).map((c) => ({ id: this.id(), name: c.name, type: c.type, src: c.id })), lateral: f.lateral, correlated: child.outerRefs && child.outerRefs.size > 0 };
      } else if (f.kind === 'func') {
        node = this.funcFrom(f, f.lateral || true ? this.lateralScope(scope) : scope);
        name = f.alias ? f.alias.name : node.defaultName;
      }
      if (f.alias && f.alias.cols) {
        if (f.alias.cols.length > node.cols.length) this.fail(S.invalidColumnReference, 'table "' + name + '" has ' + node.cols.length + ' columns available but ' + f.alias.cols.length + ' columns specified', f.pos);
        f.alias.cols.forEach((cn, i) => { node.cols[i] = Object.assign({}, node.cols[i], { name: cn }); });
      }
      for (const c of node.cols) c.table = name;
      if (name && scope.items.some((it) => it.name === name && !it.join)) this.fail(S.duplicateAlias, 'table name "' + name + '" specified more than once', f.pos);
      scope.items.push({ name, cols: node.cols, rel: node.rel, node, sys: node.sys });
      return node;
    }
    /** a subquery in FROM without LATERAL may not see the other FROM items, only enclosing queries */
    nonLateral(scope) { const s = new Scope(scope.parent, {}); s.ctes = scope.ctes; s.parentCtes = scope; s.from = scope; return Object.assign(s, { findCte: (n) => scope.findCte(n) }); }
    lateralScope(scope) { return scope; }
    viewNode(rel, scope) {
      if (!rel.parsed) rel.parsed = K.parse(rel.queryText)[0];
      const inner = new Binder(this.s);
      inner.nextId = this.nextId;
      // a view's query runs with its owner's privileges, as PostgreSQL's views do
      inner.asUser = rel.owner;
      const plan = inner.query(rel.parsed, null);
      this.nextId = inner.nextId;
      const vis = plan.cols.filter((c) => !c.hidden);
      return { op: 'Subquery', view: rel, children: [plan], cols: vis.map((c, i) => ({ id: this.id(), name: rel.colNames && rel.colNames[i] ? rel.colNames[i] : c.name, type: c.type, src: c.id })) };
    }
    funcFrom(f, scope) {
      const calls = f.calls.map((c) => {
        if (c.k !== 'fn') this.fail(S.syntax, 'a function call is expected in FROM', c.pos);
        return this.db.srf.bind(this, c, scope, f.alias);
      });
      const cols = [];
      for (const c of calls) for (const col of c.cols) cols.push(Object.assign({ id: this.id() }, col));
      if (f.ordinality) cols.push({ id: this.id(), name: 'ordinality', type: B().int8 });
      return { op: 'Func', calls, ordinality: f.ordinality, cols, children: [], defaultName: calls.length === 1 ? calls[0].name : 'rows_from' };
    }
    join(f, scope) {
      const before = scope.items.length;
      const l = this.fromItem(f.left, scope);
      const lItems = scope.items.slice(before);
      const r = this.fromItem(f.right, scope);
      const rItems = scope.items.slice(before + lItems.length);
      let cond = null, merged = null;
      if (f.natural || f.using) {
        const lv = this.joinCols(lItems), rv = this.joinCols(rItems);
        let names = f.using;
        if (f.natural) names = lv.map((c) => c.name).filter((n) => rv.some((c) => c.name === n));
        const conds = [];
        merged = [];
        for (const [i, n] of names.entries()) {
          if (names.indexOf(n) < i) this.fail(S.duplicateColumn, 'column name "' + n + '" appears more than once in USING clause', f.pos);
          const a = lv.filter((c) => c.name === n), b = rv.filter((c) => c.name === n);
          if (!a.length) this.fail(S.undefinedColumn, 'column "' + n + '" specified in USING clause does not exist in left table', f.pos);
          if (!b.length) this.fail(S.undefinedColumn, 'column "' + n + '" specified in USING clause does not exist in right table', f.pos);
          if (a.length > 1 || b.length > 1) this.fail(S.ambiguousColumn, 'common column name "' + n + '" appears more than once in ' + (a.length > 1 ? 'left' : 'right') + ' table', f.pos);
          this.colPriv([a[0], b[0]], f.pos);
          conds.push(X().bindOp('=', { k: 'col', id: a[0].id, type: a[0].type, name: n }, { k: 'col', id: b[0].id, type: b[0].type, name: n }, f.pos));
          merged.push({ name: n, l: a[0], r: b[0] });
        }
        cond = conds.length ? (conds.length === 1 ? conds[0] : { k: 'and', items: conds, type: B().bool }) : null;
      } else if (f.on) {
        cond = this.boolExpr(f.on, scope, 'JOIN/ON', { noAgg: 'aggregate functions are not allowed in JOIN conditions', noWin: 'window functions are not allowed in JOIN conditions' });
      }
      const node = { op: 'Join', jtype: f.jtype, children: [l, r], cond, cols: l.cols.concat(r.cols), natural: !!f.natural, using: f.using || null };
      if (merged) {
        // the merged USING columns come first, then the others from each side; for a full join the
        // merged value is COALESCE(left, right), for a right join it is the right side's
        const mcols = [], mexprs = [];
        for (const m of merged) {
          const t = T().common([m.l.type, m.r.type], 'JOIN/USING types');
          const pick = f.jtype === 'right' ? m.r : m.l;
          const e = f.jtype === 'full' ? { k: 'coalesce', items: [X().coerce({ k: 'col', id: m.l.id, type: m.l.type }, t, true), X().coerce({ k: 'col', id: m.r.id, type: m.r.type }, t, true)], type: t } : { k: 'col', id: pick.id, type: pick.type };
          const id = f.jtype === 'full' ? this.id() : pick.id;
          mcols.push({ id, name: m.name, type: e.type, merged: true });
          mexprs.push(e);
        }
        node.merged = { cols: mcols, exprs: mexprs, hide: new Set(merged.flatMap((m) => [m.l.id, m.r.id])) };
        if (f.jtype === 'full') {
          // the coalesced columns need a projection on top of the join
          const keep = node.cols;
          const proj = { op: 'Project', exprs: mexprs.concat(keep.map((c) => ({ k: 'col', id: c.id, type: c.type }))), children: [node], cols: mcols.concat(keep.map((c) => Object.assign({}, c))), joinMerge: true };
          // the other columns keep their ids through the projection, so the input items still name them
          const item = { name: f.alias ? f.alias.name : null, join: true, cols: mcols, merged: true };
          scope.items.push(item);
          // qualified references (a.x) still reach the original columns, unqualified x reaches the merged one
          for (const it of lItems.concat(rItems)) it.hiddenByMerge = new Set(merged.map((m) => m.name));
          return proj;
        }
        for (const it of lItems.concat(rItems)) it.hiddenByMerge = new Set(merged.map((m) => m.name));
        scope.items.push({ name: f.alias ? f.alias.name : null, join: true, cols: mcols, merged: true });
      } else if (f.alias) {
        scope.items.push({ name: f.alias.name, join: true, cols: node.cols, aliasOnly: true });
      }
      return node;
    }
    joinCols(items) {
      const out = [];
      for (const it of items) {
        if (it.merged) { for (const c of it.cols) out.push(c); continue; }
        if (it.join) continue;
        for (const c of it.cols) if (!c.hidden && !(it.hiddenByMerge && it.hiddenByMerge.has(c.name) && items.some((x) => x.merged && x.cols.some((m) => m.name === c.name)))) out.push(c);
      }
      // drop duplicates that merged columns already cover
      const seen = new Map();
      return out.filter((c) => { if (c.merged) { seen.set(c.name, true); return true; } return !(seen.get(c.name) && items.some((x) => x.merged)); });
    }

    // ---- the select list ---------------------------------------------------------------------------------------------
    targets(list, scope) {
      const out = [];
      if (!list.length) return out;
      for (const t of list) {
        if (t.star) {
          const cols = this.starCols(t, scope);
          for (const c of cols) out.push({ e: { k: 'col', id: c.id, type: c.type, name: c.name }, name: c.name });
          continue;
        }
        if (t.expr.k === 'fieldstar') {
          // (composite).* expands to one column per field
          const x = this.expr(t.expr.e, scope, { allowAgg: true, allowWin: true, allowSrf: true });
          if (x.type.cat !== 'C' || !x.type.fields) this.fail(S.syntax, 'type ' + T().sqlName(x.type) + ' is not composite', t.pos);
          x.type.fields.forEach((f, i) => out.push({ e: { k: 'field', e: x, index: i, type: f.type, name: f.name }, name: f.name, pos: t.pos }));
          continue;
        }
        const e = this.expr(t.expr, scope, { allowAgg: true, allowWin: true, allowSrf: true });
        out.push({ e, name: t.alias || this.colName(t.expr), pos: t.pos, ast: t.expr });
      }
      return out;
    }
    starCols(t, scope) { const cols = this.starCols1(t, scope); this.colPriv(cols, t.pos); return cols; }
    /** columns reached through a table the user holds only column grants on need a grant each */
    colPriv(cols, pos) { for (const c of cols) if (c.priv) this.s.checkPrivilege(c.priv.rel, 'select', pos, c.priv.asUser, [c.priv.col]); }
    starCols1(t, scope) {
      if (t.table) {
        const it = scope.items.slice().reverse().find((x) => x.name === t.table);
        if (!it) this.fail(S.undefinedTable, 'missing FROM-clause entry for table "' + t.table + '"', t.pos);
        return it.cols.filter((c) => !c.hidden);
      }
      if (!scope.items.length) this.fail(S.syntax, 'SELECT * with no tables specified is not valid', t.pos);
      // * follows the FROM clause: merged join columns once, then everything else
      const out = [];
      const seenMerged = new Set();
      const tops = this.topItems(scope);
      for (const it of tops) {
        if (it.merged) { for (const c of it.cols) { if (c.hidden) continue; if (!seenMerged.has(c.name + ':' + c.id)) out.push(c); seenMerged.add(c.name + ':' + c.id); } continue; }
        if (it.join) continue;
        for (const c of it.cols) if (!c.hidden && !(it.hiddenByMerge && it.hiddenByMerge.has(c.name))) out.push(c);
      }
      return out;
    }
    /** FROM items in order, with each join's merged columns placed before the columns of its inputs */
    topItems(scope) {
      const items = scope.items;
      const out = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.merged) {
          // move this merged item before the items it was built from (the ones directly before it that it hides)
          let j = out.length;
          while (j > 0 && out[j - 1].hiddenByMerge && [...out[j - 1].hiddenByMerge].some((n) => it.cols.some((c) => c.name === n))) j--;
          out.splice(j, 0, it);
        } else out.push(it);
      }
      return out;
    }
    /** the default name of a select-list column, as PostgreSQL chooses it */
    colName(e) {
      switch (e.k) {
        case 'col': return e.parts[e.parts.length - 1];
        case 'fn': return e.name === 'extract' ? 'extract' : e.special ? e.name : e.name;
        case 'cast': return e.e.k === 'lit' && !e.colon ? e.type.name.split(' ')[0] : this.colName(e.e);
        case 'case': return 'case';
        case 'field': return e.name;
        case 'array': return 'array';
        case 'row': return 'row';
        case 'exists': return 'exists';
        case 'sub': { const t = e.query.targets && e.query.targets[0]; return t && !t.star ? (t.alias || this.colName(t.expr)) : '?column?'; }
        case 'idx': return this.colName(e.e);
        case 'grouping': return 'grouping';
        case 'lit': return e.type === 'null' ? '?column?' : '?column?';
      }
      return '?column?';
    }
    orderItems(list, targets, scope) {
      return list.map((o) => Object.assign(this.bindOrderRef(o.expr, targets, scope), { dir: o.dir, nulls: o.nulls, pos: o.expr.pos }));
    }
    /** ORDER BY 2, ORDER BY alias, or ORDER BY expression */
    bindOrderRef(e, targets, scope, distinctOn) {
      if (e.k === 'lit' && ['str', 'num', 'bits'].includes(e.type)) this.fail(S.syntax, 'non-integer constant in ' + (distinctOn ? 'DISTINCT ON' : 'ORDER BY'), e.pos);
      if (e.k === 'lit' && e.type === 'int') {
        const n = +e.v;
        if (n < 1 || n > targets.length) this.fail(S.invalidColumnReference, 'ORDER BY position ' + n + ' is not in select list', e.pos);
        return { target: n - 1, e: targets[n - 1].e };
      }
      if (e.k === 'col' && e.parts.length === 1) {
        const matches = targets.map((t, i) => [t, i]).filter(([t]) => t.name === e.parts[0] && (t.ast ? true : true));
        // an output column name wins over an input column of the same name, as in SQL-92
        const explicit = matches.filter(([t]) => t.ast && t.ast.k !== 'col' || t.ast && t.name !== this.colName(t.ast) || t.ast && t.ast.k === 'col');
        if (matches.length > 1 && new Set(matches.map(([t]) => this.key(t.e))).size > 1) this.fail(S.ambiguousColumn, 'ORDER BY "' + e.parts[0] + '" is ambiguous', e.pos);
        if (matches.length) return { target: matches[0][1], e: matches[0][0].e };
        void explicit;
      }
      return { e: this.expr(e, scope, { allowAgg: true, allowWin: true }) };
    }

    // ---- aggregation ---------------------------------------------------------------------------------------------
    containsAgg(e) { let f = false; this.walk(e, (x) => { if (x.k === 'aggcall' || x.k === 'grouping') f = true; }, true); return f; }
    /**
     * GROUP BY and aggregates: the Aggregate node computes the grouping keys and the aggregates; everything
     * above it may only use those, so each select-list expression is rewritten in terms of them.
     */
    aggregate(q, scope, input, targets, having, order) {
      const groups = [];  // { e, id, key }
      let sets = null;    // grouping sets: arrays of group indexes
      const addGroup = (ast) => {
        let b;
        if (ast.k === 'lit' && ast.type === 'int') { const n = +ast.v; if (n < 1 || n > targets.length) this.fail(S.invalidColumnReference, 'GROUP BY position ' + n + ' is not in select list', ast.pos); b = targets[n - 1].e; if (this.containsAgg(b)) this.fail(S.groupingError, 'aggregate functions are not allowed in GROUP BY', ast.pos); }
        else if (ast.k === 'col' && ast.parts.length === 1 && !this.resolvesInFrom(ast, scope) && targets.some((t) => t.name === ast.parts[0])) b = targets.find((t) => t.name === ast.parts[0]).e;
        else b = this.expr(ast, scope, { noAgg: 'aggregate functions are not allowed in GROUP BY', noWin: 'window functions are not allowed in GROUP BY', allowSrf: true });
        let win = false;
        this.walk(b, (y) => { if (y.k === 'wincall') win = true; }, true);
        if (win) this.fail(S.windowingError, 'window functions are not allowed in GROUP BY', ast.pos);
        const key = this.key(b);
        let g = groups.findIndex((x) => x.key === key);
        if (g < 0) { groups.push({ e: b, id: this.id(), key }); g = groups.length - 1; }
        return g;
      };
      const expandSets = (items) => {
        // each item contributes a list of sets; the cross product combines them
        let acc = [[]];
        for (const it of items) {
          let opts;
          if (it.k === 'rollup') { const gs = it.items.map((x) => (x.k === 'row' && x.implicit ? x.items.map(addGroup) : [addGroup(x)])); opts = K.range(gs.length + 1).map((n) => gs.slice(0, gs.length - n).flat()); }
          else if (it.k === 'cube') { const gs = it.items.map((x) => (x.k === 'row' && x.implicit ? x.items.map(addGroup) : [addGroup(x)])); opts = []; for (let m = (1 << gs.length) - 1; m >= 0; m--) opts.push(gs.filter((_, i) => m & (1 << (gs.length - 1 - i))).flat()); }
          else if (it.k === 'sets') { opts = []; for (const sub of it.items) for (const s of expandSets([sub])) opts.push(s); }
          else if (it.k === 'emptyset') opts = [[]];
          else if (it.k === 'row' && it.implicit) opts = [it.items.map(addGroup)];
          else opts = [[addGroup(it)]];
          const next = [];
          for (const a of acc) for (const o of opts) next.push(a.concat(o));
          acc = next;
        }
        return acc;
      };
      if (q.groupBy) {
        const special = q.groupBy.some((g) => g.k === 'rollup' || g.k === 'cube' || g.k === 'sets' || g.k === 'emptyset');
        if (special) { sets = expandSets(q.groupBy); if (q.groupDistinct) { const seen = new Set(); sets = sets.filter((s) => { const k = [...new Set(s)].sort().join(','); if (seen.has(k)) return false; seen.add(k); return true; }); } }
        else for (const g of q.groupBy) addGroup(g);
      }
      // a grouping key that is a set-returning function's output is computed below the grouping (a ProjectSet)
      const srfs = [];
      for (const g of groups) g.e = this.mapExpr(g.e, (x) => { if (x.k !== 'srfcall') return null; if (!srfs.includes(x)) srfs.push(x); return { k: 'col', id: x.id, type: x.type, name: x.name }; });
      if (srfs.length) input = { op: 'ProjectSet', exprs: input.cols.map((c) => ({ k: 'col', id: c.id, type: c.type })).concat(srfs), children: [input], cols: input.cols.concat(srfs.map((x) => ({ id: x.id, name: x.name, type: x.type }))) };
      const aggs = (scope.outerAggs || []).map((a) => Object.assign({}, a, { key: this.key(a) }));
      const aggId = (call) => {
        const key = this.key(call);
        let a = aggs.find((x) => x.key === key);
        if (!a) { a = Object.assign({}, call, { outId: this.id(), key }); aggs.push(a); }
        return a.outId;
      };
      // grouped tables: a table whose primary key is grouped makes all its columns usable
      const pkGrouped = new Set();
      for (const it of scope.items) {
        if (!it.rel || !it.rel.pk) continue;
        const pkIds = it.rel.pk.map((ai) => (it.cols.find((c) => c.attnum === ai) || {}).id);
        if (pkIds.every((id) => groups.some((g) => g.e.k === 'col' && g.e.id === id))) for (const c of it.cols) pkGrouped.add(c.id);
      }
      const groupIdOf = new Map();
      const dependent = (x) => {
        let id = groupIdOf.get(x.id);
        if (!id) { const gr = { e: x, id: this.id(), key: this.key(x), dependent: true }; groups.push(gr); id = gr.id; groupIdOf.set(x.id, id); if (sets) for (const s of sets) s.push(groups.length - 1); }
        return id;
      };
      // columns of this level a subquery uses must be grouped; it then reads the grouped values
      const levelCols = new Map(scope.items.flatMap((it) => it.cols.map((c) => [c.id, c])));
      const inOuterAggs = new Set();
      for (const a of scope.outerAggs || []) for (const x of a.args.concat(a.filter ? [a.filter] : [])) this.walk(x, (y) => { if (y.k === 'col') inOuterAggs.add(y.id); }, true);
      const subRefs = (x) => {
        const map = new Map();
        for (const id of x.outerRefs) {
          if (!levelCols.has(id)) continue;
          const g = groups.find((gg) => gg.e.k === 'col' && gg.e.id === id);
          if (g) map.set(id, g.id);
          else if (pkGrouped.has(id)) map.set(id, dependent(levelCols.get(id)));
          else if (!inOuterAggs.has(id)) { const c = levelCols.get(id); this.fail(S.groupingError, 'subquery uses ungrouped column "' + (c.table ? c.table + '.' : '') + c.name + '" from outer query', x.pos); }
        }
        return map;
      };
      const rewrite = (e, what) => this.mapExpr(e, (x) => {
        if (x.k === 'sub' && x.outerRefs && x.outerRefs.length) {
          const o = Object.assign({}, x, { outerMap: subRefs(x) });
          if (x.test) o.test = rewrite(x.test, what);
          if (x.tests) o.tests = x.tests.map((t) => Object.assign({}, t, { e: rewrite(t.e, what) }));
          return o;
        }
        const k = this.key(x);
        const g = groups.find((gg) => gg.key === k);
        if (g && x.k !== 'const') return { k: 'col', id: g.id, type: g.e.type, name: g.e.name };
        if (x.k === 'aggcall') return { k: 'col', id: aggId(x), type: x.type, name: x.name };
        if (x.k === 'grouping') {
          const bits = x.args.map((a) => { const kk = this.key(a); const gg = groups.find((y) => y.key === kk); if (!gg) this.fail(S.groupingError, 'arguments to GROUPING must be grouping expressions of the associated query level', x.pos); return gg.id; });
          return { k: 'grouping', bits, type: B().int4 };
        }
        if (x.k === 'col' && !x.outer) {
          if (pkGrouped.has(x.id)) return { k: 'col', id: dependent(x), type: x.type, name: x.name };
          this.fail(S.groupingError, 'column "' + (x.table ? x.table + '.' : '') + x.name + '" must appear in the GROUP BY clause or be used in an aggregate function', x.pos);
        }
        if (x.k === 'wincall') {
          // window functions run after grouping: their arguments are rewritten too
          return Object.assign({}, x, { args: x.args.map((a) => rewrite(a, what)), partition: (x.partition || []).map((a) => rewrite(a, what)), order: (x.order || []).map((o) => Object.assign({}, o, { e: rewrite(o.e, what) })) });
        }
        return null;
      });
      for (const t of targets) t.e = rewrite(t.e, 'select list');
      if (having) having = rewrite(having, 'HAVING');
      if (order) for (const o of order) o.e = rewrite(o.e, 'ORDER BY');
      const cols = groups.map((g) => ({ id: g.id, name: g.e.name || '?column?', type: g.e.type })).concat(aggs.map((a) => ({ id: a.outId, name: a.name, type: a.type })));
      const node = { op: 'Aggregate', groups: groups.map((g) => ({ e: g.e, id: g.id })), sets, aggs, children: [input], cols };
      return { node, having, order };
    }
    resolvesInFrom(ast, scope) { try { this.column(ast, scope, true); return true; } catch (e) { return false; } }

    // ---- windows -----------------------------------------------------------------------------------------------------
    window(q, wins, node, scope) {
      const named = new Map((q.windows || []).map((w) => [w.name, w.spec]));
      void named; void scope;
      const cols = node.cols.concat(wins.map((w) => ({ id: w.outId, name: w.name, type: w.type })));
      return { op: 'Window', wins, children: [node], cols };
    }

    // ---- expressions ----------------------------------------------------------------------------------------------
    boolExpr(e, scope, what, opts) {
      const b = this.expr(e, scope, opts);
      if (b.type.cat !== 'B' && b.type.cat !== 'P') this.fail(S.datatypeMismatch, 'argument of ' + what + ' must be type boolean, not type ' + T().sqlName(b.type), e.pos);
      return X().coerce(b, B().bool);
    }
    /** bind an expression in a scope; opts: { allowAgg, allowWin, noAgg (message), noWin, inAgg } */
    expr(e, scope, opts) {
      opts = opts || {};
      const b = this.bind(e, scope, opts);
      if (b.pos === undefined) b.pos = e.pos;
      return b;
    }
    bind(e, scope, opts) {
      const r = (x, o) => this.expr(x, scope, o || opts);
      switch (e.k) {
        case 'lit': return this.literal(e);
        case 'col': return this.column(e, scope);
        case 'param': {
          const t = this.paramTypes[e.n - 1] || B().unknown;
          return { k: 'param', n: e.n, type: t };
        }
        case 'var': return { k: 'var', name: e.name, type: (this.s.varType && this.s.varType(e.name)) || B().unknown };
        case 'op': {
          // (a, b) = (SELECT x, y ...): the subquery yields one row whose fields are compared pairwise
          if (X().CMP[e.op] && e.l.k === 'row' && e.r.k === 'sub') {
            const side = (x) => { if (x.k !== 'sub') return r(x); const n = this.subquery({ kind: 'row', query: x.query, pos: x.pos }, scope, opts); return { k: 'row', items: n.type.fields.map((f, i) => ({ k: 'field', e: n, index: i, type: f.type, name: f.name })), type: n.type }; };
            return X().bindOp(e.op, side(e.l), side(e.r), e.pos);
          }
          return X().bindOp(e.op, r(e.l), r(e.r), e.pos);
        }
        case 'neg': {
          const x = r(e.e);
          if (X().isUnknown(x)) this.fail(S.ambiguousFunction, 'operator is not unique: - unknown', e.pos);
          const t = x.type;
          if (t.cat !== 'N' && t.cat !== 'T') this.fail(S.undefinedFunction, 'operator does not exist: - ' + T().sqlName(t), e.pos);
          return { k: 'neg', e: X().coerce(x, t), type: t.cat === 'N' && t.p !== undefined ? B().numeric : t };
        }
        case 'un': { const d = K.F.resolve(K.F.OPS.get('u' + e.op), [r(e.e).type]); if (!d) this.fail(S.undefinedFunction, 'operator does not exist: ' + e.op + ' ' + T().sqlName(r(e.e).type), e.pos); return { k: 'call', def: d.def, args: [X().coerce(r(e.e), d.argTypes[0])], type: d.ret }; }
        case 'and': case 'or': {
          const items = [];
          const flatten = (x) => { if (x.k === e.k) { flatten(x.l); flatten(x.r); } else items.push(x); };
          flatten(e);
          const bound = items.map((x) => this.boolArg(r(x), e.k.toUpperCase(), x.pos));
          // a constant FALSE in an AND (TRUE in an OR) decides it at plan time, so the other arms never run
          const decided = bound.find((x) => x.k === 'const' && x.v === (e.k === 'or'));
          return decided || { k: e.k, items: bound, type: B().bool };
        }
        case 'not': return { k: 'not', e: this.boolArg(r(e.e), 'NOT', e.pos), type: B().bool };
        case 'isnull': return { k: 'isnull', e: r(e.e), neg: e.neg, type: B().bool };
        case 'istruth': return { k: 'istruth', e: this.boolArg(r(e.e), 'IS ' + (e.v ? 'TRUE' : 'FALSE'), e.pos), v: e.v, neg: e.neg, type: B().bool };
        case 'distinct': { const a = r(e.l), b = r(e.r); const t = X().compareType(a, b, 'IS DISTINCT FROM'); return { k: 'distinct', l: X().coerce(a, t), r: X().coerce(b, t), ctype: t, neg: e.neg, type: B().bool }; }
        case 'between': {
          const x = r(e.e), lo = r(e.lo), hi = r(e.hi);
          const mk = (a, b) => ({ k: 'and', items: [X().bindOp('>=', x, a, e.pos), X().bindOp('<=', x, b, e.pos)], type: B().bool });
          let n = mk(lo, hi);
          if (e.sym) n = { k: 'or', items: [n, mk(hi, lo)], type: B().bool };
          return e.neg ? { k: 'not', e: n, type: B().bool } : n;
        }
        case 'in': {
          if (e.query) return this.subquery({ kind: 'in', query: e.query, test: r(e.e), op: '=', neg: e.neg, pos: e.pos }, scope, opts);
          const x = r(e.e);
          const items = e.list.map((i) => r(i));
          if (x.type.cat === 'C' || items.some((i) => i.type.cat === 'C')) {
            // (a, b) IN ((1, 2), (3, 4)): each item compared as a row
            const ors = items.map((i) => X().bindOp('=', x, i, e.pos));
            const n = { k: 'or', items: ors, type: B().bool };
            return e.neg ? { k: 'not', e: n, type: B().bool } : n;
          }
          // one item is a plain comparison, as in PostgreSQL (its operator, not the list's common type, decides)
          if (items.length === 1) return X().bindOp(e.neg ? '<>' : '=', x, items[0], e.pos);
          const t = T().common([x.type].concat(items.map((i) => i.type)), 'IN types');
          return { k: 'inlist', e: X().coerce(x, t), items: items.map((i) => X().coerce(i, t)), ctype: t, neg: e.neg, type: B().bool };
        }
        case 'like': {
          const x = r(e.e), p = r(e.pat);
          if (x.type.cat !== 'S' && x.type.cat !== 'P') this.fail(S.undefinedFunction, 'operator does not exist: ' + T().sqlName(x.type) + (e.ci ? ' ~~* ' : ' ~~ ') + T().sqlName(p.type), e.pos, { hint: 'You might need to add an explicit cast to text.' });
          return { k: 'like', e: X().coerce(x, B().text, true), pat: X().coerce(p, B().text), esc: e.esc ? X().coerce(r(e.esc), B().text) : null, neg: e.neg, ci: e.ci, similar: e.similar, type: B().bool };
        }
        case 'case': return this.caseExpr(e, scope, opts);
        case 'cast': {
          const t = this.typeOf(e.type, e.pos);
          const x = e.e.k === 'array' && !e.e.query && !e.e.items.length ? this.expr(e.e, scope, Object.assign({}, opts, { emptyArrayOk: true })) : r(e.e);
          if (x.k === 'const' && X().isUnknown(x) && !t.domain) { try { return { k: 'const', v: t.cat === 'S' && t.id !== 'regclass' && x.v !== null ? T().strFit(String(x.v), t, true) : T().input(x.v, t, K.ctxZone()), type: t, from: x }; } catch (er) { if (e.tryCast) return K.cst(null, t); er.pos = e.e.pos; throw er; } }
          if (x.type && !T().castable(x.type, t)) this.fail(S.cannotCoerce, 'cannot cast type ' + T().sqlName(x.type) + ' to ' + T().sqlName(t), e.pos);
          return { k: 'cast', e: x, type: t, explicit: true, tryCast: e.tryCast };
        }
        case 'fn': return this.call(e, scope, opts);
        case 'sub': return this.subquery({ kind: 'scalar', query: e.query, pos: e.pos }, scope, opts);
        case 'exists': return this.subquery({ kind: 'exists', query: e.query, pos: e.pos }, scope, opts);
        case 'quant': {
          if (e.query) return this.subquery({ kind: e.q, query: e.query, test: e.like ? X().coerce(r(e.e), B().text, true) : r(e.e), op: e.op, like: e.like, pos: e.pos }, scope, opts);
          const x = r(e.e), a = r(e.array);
          if (e.like && x.type.cat !== 'S' && x.type.cat !== 'P') this.fail(S.undefinedFunction, 'operator does not exist: ' + T().sqlName(x.type) + ' ' + e.op + ' text', e.pos, { hint: 'No operator matches the given name and argument types. You might need to add explicit type casts.' });
          if (e.like) return { k: 'quant', op: e.op, like: e.like, q: e.q, e: X().coerce(x, B().text, true), arr: X().coerce(a, K.T.arrayOf(B().text)), ctype: B().text, type: B().bool };
          let at = a.type;
          if (X().isUnknown(a)) at = K.T.arrayOf(X().isUnknown(x) ? B().text : x.type);
          if (at.cat !== 'A') this.fail(S.wrongObjectType, 'op ANY/ALL (array) requires array on right side', e.pos);
          if (!X().CMP[e.op]) {
            // any other boolean operator (~, @>, ...) applied to each element, which qelem stands for
            const pred = X().bindOp(e.op, X().isUnknown(x) ? X().coerce(x, at.elem) : x, { k: 'qelem', type: at.elem }, e.pos);
            if (pred.type.id !== 'bool') this.fail(S.datatypeMismatch, 'op ANY/ALL (array) requires operator to yield boolean', e.pos);
            return { k: 'quant', q: e.q, pred, arr: a, type: B().bool };
          }
          const t = X().isUnknown(x) ? at.elem : T().common([x.type, at.elem], 'ANY/ALL types');
          return { k: 'quant', op: e.op, q: e.q, e: X().coerce(x, t), arr: X().coerce(a, K.T.arrayOf(t)), ctype: t, type: B().bool };
        }
        case 'row': { const items = e.items.map((i) => r(i)); return { k: 'row', items, type: { id: 'record', name: 'record', cat: 'C', len: -1, fields: items.map((x, i) => ({ name: 'f' + (i + 1), type: x.type })) } }; }
        case 'array': {
          if (e.query) return this.subquery({ kind: 'array', query: e.query, pos: e.pos }, scope, opts);
          const items = e.items.map((i) => r(i));
          if (!items.length) { if (!opts || !opts.emptyArrayOk) this.fail(S.indeterminateDatatype, 'cannot determine type of empty array', e.pos, { hint: 'Explicitly cast to the desired type, for example ARRAY[]::integer[].' }); return { k: 'array', items: [], type: K.T.arrayOf(B().text), empty: true }; }
          const nested = items.every((i) => i.k === 'array' || i.type.cat === 'A');
          const et = nested ? T().common(items.map((i) => i.type.elem || i.type), 'ARRAY types') : T().common(items.map((i) => i.type), 'ARRAY types');
          const ti = nested ? K.T.arrayOf(et) : et;
          return { k: 'array', items: items.map((i) => X().coerce(i, ti)), type: K.T.arrayOf(et) };
        }
        case 'idx': {
          // a[i][j] on an array is one subscript operation with two subscripts (PostgreSQL arrays are not nested types)
          if (!e.slice && e.e.k === 'idx' && !e.e.slice) {
            const subs = [];
            let base = e;
            while (base.k === 'idx' && !base.slice) { subs.unshift(base.lo); base = base.e; }
            const bx = r(base);
            if (bx.type.cat === 'A') return { k: 'idx', e: bx, subs: subs.map((x) => X().coerce(r(x), B().int4)), type: bx.type.elem || B().text };
          }
          // a[1:2][2:3]: once any subscript is a slice, every subscript is one (n alone meaning 1:n)
          if (e.e.k === 'idx') {
            const chain = [];
            let base = e;
            while (base.k === 'idx') { chain.unshift(base); base = base.e; }
            if (chain.some((c) => c.slice)) {
              const bx = r(base);
              if (bx.type.cat === 'A') return { k: 'idx', e: bx, dims: chain.map((c) => ({ lo: c.lo ? X().coerce(r(c.lo), B().int4) : null, hi: c.hi ? X().coerce(r(c.hi), B().int4) : null, slice: c.slice })), type: bx.type };
            }
          }
          const x = r(e.e);
          const json = x.type.cat === 'J';
          if (!json && x.type.cat !== 'A' && x.type.cat !== 'P') this.fail(S.datatypeMismatch, 'cannot subscript type ' + T().sqlName(x.type) + ' because it does not support subscripting', e.pos);
          const lo = e.lo ? X().coerce(r(e.lo), json ? B().text : B().int4) : null, hi = e.hi ? X().coerce(r(e.hi), B().int4) : null;
          if (json && e.lo && r(e.lo).type.cat === 'N') return { k: 'idx', e: x, lo: X().coerce(r(e.lo), B().int4), type: x.type };
          return { k: 'idx', e: x, lo, hi, slice: e.slice, type: json ? x.type : e.slice ? x.type : x.type.elem || B().text };
        }
        case 'field': {
          // (expr).field, or table.column through a function result
          const x = r(e.e);
          if (x.type.cat !== 'C' || !x.type.fields) this.fail(S.syntax, 'column notation .' + e.name + ' applied to type ' + T().sqlName(x.type) + ', which is not a composite type', e.pos);
          const i = x.type.fields.findIndex((f) => f.name === e.name);
          if (i < 0) this.fail(S.undefinedColumn, 'column "' + e.name + '" not found in data type ' + x.type.name, e.pos);
          return { k: 'field', e: x, index: i, type: x.type.fields[i].type, name: e.name };
        }
        case 'grouping':
          if (opts.inAggArg) this.fail(S.groupingError, 'aggregate function calls cannot contain grouping operations', e.pos);
          if (!opts.allowAgg && !opts.inAgg) this.fail(S.groupingError, (opts.noAgg || 'aggregate functions are not allowed here').replace('aggregate functions', 'grouping operations'), e.pos);
          return { k: 'grouping', args: e.args.map((a) => r(a)), type: B().int4, pos: e.pos };
        case 'default': return { k: 'default', type: B().unknown, pos: e.pos };
        case 'isjson': { const x = r(e.e); return { k: 'call', def: K.F.FUNCS.get('__isjson')[0], args: [X().coerce(x, B().text, true), K.cst(e.what || 'value', B().text)], type: B().bool, neg: e.neg, wrapNot: e.neg }; }
        case 'fieldstar': this.fail(S.featureNotSupported, '(expr).* is only allowed in the select list', e.pos);
      }
      this.fail(S.featureNotSupported, 'expression not supported: ' + e.k, e.pos);
    }
    boolArg(b, what, pos) {
      if (b.type.cat !== 'B' && b.type.cat !== 'P') this.fail(S.datatypeMismatch, 'argument of ' + what + ' must be type boolean, not type ' + T().sqlName(b.type), pos);
      return X().coerce(b, B().bool);
    }
    literal(e) {
      switch (e.type) {
        case 'null': return K.cst(null, B().null);
        case 'bool': return K.cst(e.v, B().bool);
        case 'str': return { k: 'const', v: e.v, type: B().unknown };
        case 'bits': return K.cst(e.v, B().text);
        case 'int': {
          const n = BigInt(e.v);
          if (n >= -2147483648n && n <= 2147483647n) return K.cst(Number(n), B().int4);
          if (n >= -(2n ** 63n) && n < 2n ** 63n) return K.cst(n, B().int8);
          return K.cst(K.Decimal.parse(e.v), B().numeric);
        }
        case 'num': return K.cst(K.Decimal.parse(e.v), B().numeric);
      }
    }
    /** a column reference: col, table.col, schema.table.col, or a composite field access table.col.field */
    column(e, scope, quiet) {
      const parts = e.parts;
      let depth = 0;
      for (let s = e.wholeRow ? null : scope; s; s = s.parent, depth++) {
        const found = this.findIn(parts, s, e.pos);
        if (found) {
          this.colPriv([found], e.pos);
          if (depth > 0) this.markOuter(scope, s, found.id);
          return Object.assign({ k: 'col', id: found.id, type: found.type, name: found.name, table: found.table, pos: e.pos }, depth > 0 ? { outer: depth } : {}, found.field ? {} : {});
        }
      }
      if (quiet) throw K.err(S.undefinedColumn, 'no');
      // inside a SQL function, a parameter can be named like a column
      if (this.paramNames && parts.length === 1 && this.paramNames.has(parts[0])) { const n = this.paramNames.get(parts[0]); return { k: 'param', n, type: this.paramTypes[n - 1] || B().unknown, pos: e.pos }; }
      if (this.paramNames && parts.length === 2 && this.fnName === parts[0] && this.paramNames.has(parts[1])) { const n = this.paramNames.get(parts[1]); return { k: 'param', n, type: this.paramTypes[n - 1] || B().unknown, pos: e.pos }; }
      // a table name alone (SELECT t FROM t) is the whole row
      if (parts.length === 1) {
        for (let s = scope; s; s = s.parent) {
          const it = s.items.find((x) => x.name === parts[0] && !x.join);
          if (it) {
            this.colPriv(it.cols.filter((c) => !c.hidden), e.pos);
            const items = it.cols.filter((c) => !c.hidden).map((c) => ({ k: 'col', id: c.id, type: c.type, name: c.name }));
            if (s !== scope) for (const c of items) this.markOuter(scope, s, c.id);
            return { k: 'row', items, type: it.rel ? this.cat.rowType(it.rel) : { id: 'record', name: 'record', cat: 'C', len: -1, fields: items.map((c) => ({ name: c.name, type: c.type })) }, pos: e.pos };
          }
        }
      }
      // a function with no parentheses, like current_date, handled by the parser; give a helpful message
      const name = parts.join('.');
      const tableMissing = parts.length > 1 && !this.anyItem(scope, parts[parts.length - 2]);
      if (tableMissing) this.fail(S.undefinedTable, 'missing FROM-clause entry for table "' + parts[parts.length - 2] + '"', e.pos);
      const hint = this.suggest(parts[parts.length - 1], scope);
      this.fail(S.undefinedColumn, 'column ' + (parts.length > 1 ? parts.slice(-2).join('.') : '"' + name + '"') + ' does not exist', e.pos, hint ? { hint: 'Perhaps you meant to reference the column "' + hint + '".' } : {});
    }
    /** an outer reference is passed down by every query between its use and its source; a FROM subquery's
        scope skips the query it belongs to (it cannot see its siblings), so that query is marked through from */
    markOuter(scope, s, id) { for (let t = scope; t && t !== s; t = t.parent) { t.outerRefs.add(id); if (t.from) this.markOuter(t.from, s, id); } }
    anyItem(scope, name) { for (let s = scope; s; s = s.parent) if (s.items.some((x) => x.name === name)) return true; return false; }
    suggest(name, scope) {
      let best = null, bestD = 3;
      for (let s = scope; s; s = s.parent) for (const it of s.items) for (const c of it.cols) { const d = lev(name, c.name); if (d < bestD) { bestD = d; best = (it.name ? it.name + '.' : '') + c.name; } }
      return best;
    }
    findIn(parts, s, pos) {
      if (s.blockedLateral) return null;
      if (parts.length === 1) {
        const n = parts[0];
        const hits = [];
        for (const it of s.items) {
          if (it.aliasOnly) continue;
          for (const c of it.cols) {
            if (c.name !== n || c.hidden) continue;
            if (!it.merged && it.hiddenByMerge && it.hiddenByMerge.has(n) && s.items.some((x) => x.merged && x.cols.some((m) => m.name === n))) continue;
            hits.push(c);
          }
        }
        const uniq = [...new Map(hits.map((h) => [h.id, h])).values()];
        if (uniq.length > 1) this.fail(S.ambiguousColumn, 'column reference "' + n + '" is ambiguous', pos);
        if (uniq.length) return uniq[0];
        // system columns of a single table: ctid, xmin, xmax
        if (['ctid', 'xmin', 'xmax', 'tableoid'].includes(n)) { const it = s.items.find((x) => x.sys); if (it && s.items.filter((x) => x.sys).length === 1) return { id: it.sys[n], type: n === 'ctid' ? B().text : n === 'tableoid' ? B().regclass : B().xid, name: n, table: it.name, sys: n }; }
        return null;
      }
      // table.col (the last match of the table name, as an inner alias hides an outer one)
      const tn = parts[parts.length - 2], cn = parts[parts.length - 1];
      const schema = parts.length >= 3 ? parts[parts.length - 3] : null;
      const its = s.items.filter((x) => x.name === tn && (!schema || x.rel && x.rel.schema === schema));
      if (!its.length) {
        // composite field: col.field where col is a column of composite type
        return null;
      }
      const it = its[its.length - 1];
      const c = it.cols.find((x) => x.name === cn && !x.hidden);
      if (c) return c;
      if (it.sys && it.sys[cn]) return { id: it.sys[cn], type: cn === 'ctid' ? B().text : cn === 'tableoid' ? B().regclass : B().xid, name: cn, table: tn, sys: cn };
      this.fail(S.undefinedColumn, 'column ' + tn + '.' + cn + ' does not exist', pos, this.suggest(cn, s) ? { hint: 'Perhaps you meant to reference the column "' + this.suggest(cn, s) + '".' } : {});
    }
    caseExpr(e, scope, opts) {
      const r = (x) => this.expr(x, scope, opts);
      const base = e.base ? r(e.base) : null;
      const whens = e.whens.map((w) => ({ c: r(w.c), r: r(w.r) }));
      const els = e.else ? r(e.else) : null;
      const t = T().common(whens.map((w) => w.r.type).concat(els ? [els.type] : []), 'CASE types');
      let ctype = null;
      if (base) ctype = T().common([base.type].concat(whens.map((w) => w.c.type)), 'CASE/WHEN types');
      return {
        k: 'case', base: base ? X().coerce(base, ctype) : null, ctype,
        whens: whens.map((w) => ({ c: base ? X().coerce(w.c, ctype) : this.boolArg(w.c, 'CASE/WHEN', w.c.pos), r: X().coerce(w.r, t) })),
        else: els ? X().coerce(els, t) : null, type: t,
      };
    }
    typeOf(tn, pos) {
      const t = T().byName(tn.name, tn.mods, this.cat);
      if (!t) this.fail(S.undefinedObject, 'type "' + tn.name + '" does not exist', pos !== undefined ? pos : tn.pos);
      let out = tn.field && t.id === 'interval' ? Object.assign({}, t, { field: tn.field }) : t;
      for (let i = 0; i < (tn.dims || 0); i++) out = K.T.arrayOf(out);
      return out;
    }

    // ---- function calls ------------------------------------------------------------------------------------------------
    call(e, scope, opts) {
      const name = e.name;
      const special = this.specialCall(e, scope, opts);
      if (special) return special;
      // set-returning functions in the select list: each input row gives as many output rows as the function returns
      if (!e.over && !K.F.AGGS.has(name) && this.db.srf && (this.db.srf.defs.has(name) || this.cat.userFuncs(name).some((f) => f.setof || f.returnsTable))) {
        if (!opts.allowSrf) this.fail(S.featureNotSupported, 'set-returning functions are not allowed in ' + (opts.srfWhere || 'this context'), e.pos);
        const b = this.db.srf.bind(this, e, scope, null, opts.allowAgg ? { allowAgg: true, allowWin: opts.allowWin } : undefined);
        const type = b.cols.length === 1 ? b.cols[0].type : { id: 'record', name: 'record', cat: 'C', len: -1, fields: b.cols.map((c) => ({ name: c.name, type: c.type })) };
        return { k: 'srfcall', call: b, args: b.args || (b.scalar ? [b.scalar] : []), id: this.id(), type, name };
      }
      // aggregates and window functions
      const aggDef = K.F.AGGS.get(name);
      const userAgg = !aggDef && this.cat.userFuncs(name).find((f) => f.aggregate);
      const winDef = K.F.WINS.get(name);
      if (e.over) {
        if (opts.inAggArg && !opts.allowWin) this.fail(S.groupingError, 'aggregate function calls cannot contain window function calls', e.pos);
        if (!opts.allowWin) this.fail(S.windowingError, opts.noWin || 'window functions are not allowed here', e.pos);
        if (!aggDef && !winDef) this.fail(userAgg ? S.featureNotSupported : S.wrongObjectType, userAgg ? 'user-defined aggregates cannot be used as window functions' : 'OVER specified, but ' + name + ' is not a window function nor an aggregate function', e.pos);
        if (!winDef && aggDef && aggDef.ordered) this.fail(S.wrongObjectType, 'WITHIN GROUP is required for ordered-set aggregate ' + name, e.pos);
        return this.windowCall(e, scope, opts, aggDef, winDef);
      }
      if (aggDef || userAgg) {
        if (opts.inAggArg) this.fail(S.groupingError, 'aggregate function calls cannot be nested', e.pos);
        const call = this.aggCall(e, scope, opts, aggDef || userAgg);
        // an aggregate whose arguments only use columns of enclosing queries belongs to the nearest of them
        const lvl = this.aggLevel(call);
        if (lvl > 0) {
          let s = scope;
          for (let i = 0; i < lvl; i++) s = s.parent;
          const id = this.id();
          (s.outerAggs || (s.outerAggs = [])).push(Object.assign({}, call, { outId: id }));
          this.markOuter(scope, s, id);
          return { k: 'col', id, type: call.type, name: call.name, outer: lvl };
        }
        if (!opts.allowAgg && !opts.inAgg) this.fail(S.groupingError, opts.noAgg || 'aggregate functions are not allowed here', e.pos);
        return call;
      }
      if (winDef) this.fail(S.wrongObjectType, 'window function ' + name + ' requires an OVER clause', e.pos);
      if (e.filter) this.fail(S.syntax, 'FILTER specified, but ' + name + ' is not an aggregate function', e.pos);
      if (e.distinct) this.fail(S.syntax, 'DISTINCT specified, but ' + name + ' is not an aggregate function', e.pos);
      const args = e.args.map((a) => this.expr(a, scope, opts));
      // user-defined functions first (they can overload built-ins with a schema), then built-ins
      const udfs = this.cat.userFuncs(name).filter((f) => !f.aggregate && f.kind !== 'procedure' && (!e.schema || f.schema === e.schema));
      if (udfs.length) {
        // polymorphic parameters (anyelement, anyarray) are matched by name, as built-in functions are
        const poly = (t) => (t && (t.id === 'anyelement' || t.id === 'anyarray' || t.id === 'anycompatible' || t.id === 'anyenum') ? t.id === 'anycompatible' ? 'anyelement' : t.id : t && t.cat === 'A' && t.elem && t.elem.id === 'anyelement' ? 'anyarray' : t);
        const cands = udfs.map((f) => ({ name, args: f.params.filter((p) => p.mode !== 'out').map((p) => poly(p.type)), minArgs: f.params.filter((p) => p.mode !== 'out' && p.default === undefined).length, ret: poly(f.retType), udf: f, variadic: f.params.some((p) => p.mode === 'variadic') }));
        const named = e.named ? this.reorderNamed(e, args, udfs) : null;
        const r = K.F.resolve(cands, (named || args).map((a) => a.type), name);
        if (r) {
          const out = (named || args).map((a, i) => (a.k === 'default' ? a : X().coerce(a, r.argTypes[i])));
          // parameters left out (or skipped by named notation) take their defaults
          const ins = r.def.udf.params.filter((p) => p.mode !== 'out');
          if (!r.def.udf.params.some((p) => p.mode === 'variadic')) for (let i = 0; i < ins.length; i++) if ((!out[i] || out[i].k === 'default') && ins[i].default !== undefined && typeof poly(ins[i].type) !== 'string') out[i] = X().coerce(this.expr(ins[i].default, new K.Scope(null), {}), ins[i].type, false);
          return { k: 'udf', fn: r.def.udf, args: out, type: r.ret, name, setof: r.def.udf.setof };
        }
      }
      const list = K.F.FUNCS.get(name);
      if (list && e.named && e.named.some(Boolean)) {
        const d = list.find((x) => x.names);
        if (!d) this.fail(S.undefinedFunction, 'function ' + name + ' does not accept named arguments', e.pos);
        const re = d.names.map(() => null);
        e.named.forEach((nm, i) => { const k = nm ? d.names.indexOf(nm) : i; if (k < 0) this.fail(S.undefinedFunction, 'function ' + name + ' has no parameter named "' + nm + '"', e.pos); re[k] = args[i]; });
        while (re.length && re[re.length - 1] === null) re.pop();
        args.length = 0;
        re.forEach((a, i) => args.push(a || K.cst(d.defaults ? d.defaults[i] : 0, d.args[i] && B()[d.args[i]] ? B()[d.args[i]] : B().int4)));
      }
      if (!list) this.fail(S.undefinedFunction, 'function ' + name + '(' + args.map((a) => T().sqlName(a.type)).join(', ') + ') does not exist', e.pos, { hint: 'No function matches the given name and argument types. You might need to add explicit type casts.' });
      // VARIADIC arr passes the array's elements as the trailing arguments
      const spread = e.variadic && args.length && args[args.length - 1].type && args[args.length - 1].type.cat === 'A' && list.some((d) => d.variadic);
      const r = K.F.resolve(spread ? list.filter((d) => d.variadic) : list, args.map((a, i) => (spread && i === args.length - 1 ? a.type.elem : a.type)), name);
      if (!r) this.fail(S.undefinedFunction, 'function ' + name + '(' + args.map((a) => T().sqlName(a.type)).join(', ') + ') does not exist', e.pos, { hint: 'No function matches the given name and argument types. You might need to add explicit type casts.' });
      if (r.def.srfOnly) this.fail(S.featureNotSupported, 'set-returning function ' + name + ' is only allowed in FROM or the select list', e.pos);
      const out = { k: 'call', def: r.def, args: args.map((a, i) => (spread && i === args.length - 1 ? X().coerce(a, T().arrayOf(r.argTypes[i])) : X().coerce(a, r.argTypes[i]))), type: r.ret, name, pos: e.pos, spread };
      if (r.def.bindHook) return r.def.bindHook(out, this, e);
      return out;
    }
    reorderNamed(e, args, udfs) {
      const f = udfs[0];
      const ins = f.params.filter((p) => p.mode !== 'out');
      const out = new Array(ins.length).fill(null);
      e.named.forEach((n, i) => { if (n && e.named.indexOf(n) < i) this.fail(S.syntax, 'argument name "' + n + '" used more than once', e.pos); });
      e.named.forEach((n, i) => { const k = n ? ins.findIndex((p) => p.name === n) : i; if (k < 0) this.fail(S.undefinedFunction, 'function ' + f.name + ' has no parameter named ' + n, e.pos); out[k] = args[i]; });
      while (out.length && out[out.length - 1] === null) out.pop();
      return out.map((a, i) => a || { k: 'default', type: ins[i].type, param: ins[i] });
    }
    /** functions with special argument handling: COALESCE, NULLIF, GREATEST, LEAST, and friends */
    specialCall(e, scope, opts) {
      const r = (x) => this.expr(x, scope, opts);
      switch (e.name) {
        case 'coalesce': { const items = e.args.map(r); if (!items.length) this.fail(S.syntax, 'COALESCE needs at least one argument', e.pos); const t = T().common(items.map((i) => i.type), 'COALESCE types'); return { k: 'coalesce', items: items.map((i) => X().coerce(i, t)), type: t }; }
        case 'nullif': { if (e.args.length !== 2) return null; const a = r(e.args[0]), b = r(e.args[1]); const t = X().compareType(a, b, 'NULLIF'); return { k: 'nullif', a: X().coerce(a, t), b: X().coerce(b, t), ctype: t, type: t }; }
        case 'greatest': case 'least': { const items = e.args.map(r); const t = T().common(items.map((i) => i.type), e.name.toUpperCase() + ' types'); return { k: e.name, items: items.map((i) => X().coerce(i, t)), type: t }; }
      }
      return null;
    }
    aggCall(e, scope, opts, def) {
      const inner = Object.assign({}, opts, { allowAgg: false, inAggArg: true, allowWin: false, allowSrf: false, srfWhere: 'aggregate function calls', noWin: 'window function calls cannot be nested inside an aggregate' });
      const args = e.star ? [] : e.args.map((a) => this.expr(a, scope, inner));
      if (def.udf || def.aggregate) {
        return { k: 'aggcall', name: e.name, udf: def, args, distinct: !!e.distinct, type: def.retType, filter: e.filter ? this.boolExpr(e.filter, scope, 'FILTER', inner) : null };
      }
      if (e.star && !def.star) this.fail(S.syntax, e.name + '(*) must be used with an aggregate that takes no arguments', e.pos);
      const r = def.resolve(args.map((a) => a.type), e, this);
      if (!r) this.fail(S.undefinedFunction, 'function ' + e.name + '(' + args.map((a) => T().sqlName(a.type)).join(', ') + ') does not exist', e.pos, { hint: 'No function matches the given name and argument types. You might need to add explicit type casts.' });
      const call = {
        k: 'aggcall', name: e.name, def, args: args.map((a, i) => (r.argTypes[i] ? X().coerce(a, r.argTypes[i]) : a)), star: !!e.star, distinct: !!e.distinct, type: r.ret,
        filter: e.filter ? this.boolExpr(e.filter, scope, 'FILTER', inner) : null,
        order: e.order ? e.order.map((o) => ({ e: this.expr(o.expr, scope, inner), dir: o.dir, nulls: o.nulls || (o.dir === 'desc' ? 'first' : 'last') })) : null,
        within: e.withinGroup ? e.withinGroup.map((o) => ({ e: this.expr(o.expr, scope, inner), dir: o.dir, nulls: o.nulls || (o.dir === 'desc' ? 'first' : 'last') })) : null,
        pos: e.pos,
      };
      if (call.within && call.order) this.fail(S.syntax, 'cannot use multiple ORDER BY clauses with WITHIN GROUP', e.pos);
      if (call.within && !def.ordered) this.fail(S.wrongObjectType, 'WITHIN GROUP is specified, but ' + e.name + ' is not an ordered-set aggregate', e.pos);
      if (def.ordered && !call.within) this.fail(S.undefinedFunction, 'WITHIN GROUP is required for ordered-set aggregate ' + e.name, e.pos);
      if (call.within && r.withinType) call.within = call.within.map((o) => {
        const w = r.withinType(o.e.type);
        if (!w) this.fail(S.undefinedFunction, 'function ' + e.name + '(' + args.concat(call.within.map((x) => x.e)).map((a) => T().sqlName(a.type)).join(', ') + ') does not exist', e.pos);
        return Object.assign(o, { e: X().coerce(o.e, w) });
      });
      if (call.distinct && call.order && call.order.some((o) => !args.some((a) => this.key(a) === this.key(o.e)))) this.fail(S.invalidColumnReference, 'in an aggregate with DISTINCT, ORDER BY expressions must appear in argument list', e.pos);
      return call;
    }
    aggLevel(call) {
      let lvl = Infinity;
      const see = (x) => this.walk(x, (y) => { if (y.k === 'col') lvl = Math.min(lvl, y.outer || 0); }, true);
      for (const a of call.args) see(a);
      if (call.filter) see(call.filter);
      for (const o of (call.order || []).concat(call.within || [])) see(o.e);
      return lvl === Infinity ? 0 : lvl;
    }
    windowCall(e, scope, opts, aggDef, winDef) {
      const inner = Object.assign({}, opts, { allowWin: false, noWin: 'window function calls cannot be nested' });
      let spec = e.over;
      if (spec.ref) {
        const base = this.currentWindows && this.currentWindows.get(spec.ref);
        if (!base) this.fail(S.undefinedObject, 'window "' + spec.ref + '" does not exist', e.pos);
        if (spec.partition) this.fail(S.windowingError, 'cannot override PARTITION BY clause of window "' + spec.ref + '"', e.pos);
        if (base.order && spec.order) this.fail(S.windowingError, 'cannot override ORDER BY clause of window "' + spec.ref + '"', e.pos);
        if (base.frame && !spec.bare) this.fail(S.windowingError, 'cannot copy window "' + spec.ref + '" because it has a frame clause', e.pos);
        spec = Object.assign({}, base, spec, { ref: undefined, bare: undefined });
      }
      const args = e.star ? [] : e.args.map((a) => this.expr(a, scope, inner));
      let r;
      if (winDef) r = winDef.resolve ? winDef.resolve(args.map((a) => a.type)) : { argTypes: args.map((a) => a.type), ret: typeof winDef.ret === 'function' ? winDef.ret(args.map((a) => a.type)) : B()[winDef.ret] };
      else r = aggDef.resolve(args.map((a) => a.type), e, this);
      if (!r && aggDef && aggDef.ordered) this.fail(S.wrongObjectType, 'WITHIN GROUP is required for ordered-set aggregate ' + e.name, e.pos);
      if (!r) this.fail(S.undefinedFunction, 'function ' + e.name + '(' + args.map((a) => T().sqlName(a.type)).join(', ') + ') does not exist', e.pos);
      const call = {
        k: 'wincall', name: e.name, def: winDef || aggDef, isAgg: !winDef, args: args.map((a, i) => (r.argTypes && r.argTypes[i] ? X().coerce(a, r.argTypes[i]) : a)), star: !!e.star, distinct: !!e.distinct,
        type: r.ret, outId: this.id(), filter: e.filter ? this.boolExpr(e.filter, scope, 'FILTER', inner) : null, nulls: e.nulls,
        partition: (spec.partition || []).map((p) => this.expr(p, scope, inner)),
        order: (spec.order || []).map((o) => ({ e: this.expr(o.expr, scope, inner), dir: o.dir, nulls: o.nulls || (o.dir === 'desc' ? 'first' : 'last') })),
        frame: spec.frame ? Object.assign({}, spec.frame, { start: this.frameBound(spec.frame.start, scope, spec), end: this.frameBound(spec.frame.end, scope, spec) }) : null,
        pos: e.pos,
      };
      if (call.frame && call.frame.unit === 'groups' && !call.order.length) this.fail(S.windowingError, 'GROUPS mode requires an ORDER BY clause', e.pos);
      if (call.frame && call.frame.unit === 'range' && call.order.length === 1) {
        // PostgreSQL looks up an in_range support function for the column and offset types when binding
        const ct = call.order[0].e.type.domain ? call.order[0].e.type.base : call.order[0].e.type;
        for (const b of [call.frame.start, call.frame.end]) {
          if (!b || b.kind !== 'offset') continue;
          const ot = b.e.type;
          const ok = ot.cat === 'P' || (ct.cat === 'N' ? ot.cat === 'N' && (ct.int ? ot.int : ct.float || !ot.float) : ['date', 'time', 'timetz', 'timestamp', 'timestamptz', 'interval'].includes(ct.id) && ot.id === 'interval');
          if (!ok) this.fail(S.featureNotSupported, 'RANGE with offset PRECEDING/FOLLOWING is not supported for column type ' + T().sqlName(ct) + ' and offset type ' + T().sqlName(ot), e.pos);
        }
      }
      return call;
    }
    frameBound(b, scope, spec) {
      if (!b || b.kind !== 'offset') return b;
      const e = this.expr(b.e, scope, { noAgg: 'aggregate functions are not allowed in window frames' });
      if (spec.frame.unit === 'range') {
        // RANGE offsets have the type of the ORDER BY column (or an interval for dates)
        return Object.assign({}, b, { e });
      }
      return Object.assign({}, b, { e: X().coerce(e, B().int8, false, 'frame offset') });
    }

    // ---- subqueries ------------------------------------------------------------------------------------------------------
    subquery(sq, scope, opts) {
      void opts;
      let plan = this.query(sq.query, scope);
      // an untyped literal the subquery returns is text, as in PostgreSQL
      const unk = (c) => c.type && (c.type.id === 'unknown' || c.type.id === 'null');
      if (plan.cols.some((c) => !c.hidden && unk(c))) plan = Object.assign(this.castTo(plan, plan.cols.filter((c) => !c.hidden).map((c) => ({ type: unk(c) ? B().text : c.type }))), { outerRefs: plan.outerRefs });
      const vis = plan.cols.filter((c) => !c.hidden);
      const outer = plan.outerRefs ? [...plan.outerRefs] : [];
      for (const id of outer) if (!this.inScopeChain(id, scope)) scope.outerRefs.add(id);
      const n = { k: 'sub', kind: sq.kind, plan, outerRefs: outer, pos: sq.pos, id: this.id() };
      if (sq.kind === 'scalar') {
        if (vis.length !== 1) this.fail(S.syntax, 'subquery must return only one column', sq.pos);
        n.type = vis[0].type; return n;
      }
      if (sq.kind === 'exists') { n.type = B().bool; return n; }
      if (sq.kind === 'row') { n.type = { id: 'record', name: 'record', cat: 'C', len: -1, fields: vis.map((c) => ({ name: c.name, type: c.type })) }; return n; }
      if (sq.kind === 'array') { if (vis.length !== 1) this.fail(S.syntax, 'subquery must return only one column', sq.pos); n.type = K.T.arrayOf(vis[0].type); return n; }
      // IN / ANY / ALL: x op (subquery)
      const test = sq.test;
      if (test.k === 'row' && vis.length !== test.items.length || test.k !== 'row' && vis.length !== 1) this.fail(S.syntax, vis.length > 1 ? 'subquery has too many columns' : 'subquery has too few columns', sq.pos);
      if (test.k === 'row') {
        n.tests = test.items.map((t, i) => { const ct = X().compareType(t, { k: 'col', type: vis[i].type }, sq.op); return { e: X().coerce(t, ct), ctype: ct, colType: vis[i].type }; });
        n.type = B().bool; n.op = sq.op; n.neg = sq.neg; n.rowTest = true;
        return n;
      }
      const ct = X().compareType(test, { k: 'col', type: vis[0].type }, sq.op);
      n.test = X().coerce(test, ct); n.ctype = ct; n.op = sq.op; n.neg = sq.neg; n.type = B().bool;
      if (sq.like) n.like = sq.like;
      return n;
    }
    inScopeChain(id, scope) { for (const it of scope.items) if (it.cols.some((c) => c.id === id)) return true; return false; }

    // ---- tree utilities -------------------------------------------------------------------------------------------------
    /** a canonical key for a bound expression, to match GROUP BY expressions and remove duplicate aggregates */
    key(e) {
      if (!e || typeof e !== 'object') return String(e);
      switch (e.k) {
        case 'const': return 'c:' + (e.type ? e.type.id : '') + ':' + K.keyOf(e.v);
        case 'col': return 'v' + e.id;
        case 'sub': return 'sub' + e.id;
      }
      const parts = [e.k, e.op || '', e.name || '', e.def ? e.def.name : '', e.neg ? 'N' : '', e.distinct ? 'D' : '', e.star ? '*' : '', e.type ? e.type.id : ''];
      for (const k of ['l', 'r', 'e', 'a', 'b', 'base', 'else', 'test', 'filter', 'arr', 'lo', 'hi', 'pat', 'esc']) if (e[k]) parts.push(k + '(' + this.key(e[k]) + ')');
      for (const k of ['items', 'args']) if (e[k]) parts.push(k + '[' + e[k].map((x) => this.key(x)).join(',') + ']');
      if (e.whens) parts.push('w[' + e.whens.map((w) => this.key(w.c) + '>' + this.key(w.r)).join(',') + ']');
      if (e.order) parts.push('o[' + e.order.map((o) => this.key(o.e) + o.dir + o.nulls).join(',') + ']');
      if (e.within) parts.push('wg[' + e.within.map((o) => this.key(o.e) + o.dir + o.nulls).join(',') + ']');
      if (e.index !== undefined) parts.push('#' + e.index);
      return parts.join('|');
    }
    /** visit every node; inAgg false stops at aggregate calls unless all is set */
    walk(e, f, all) {
      if (!e || typeof e !== 'object') return;
      if (Array.isArray(e)) { e.forEach((x) => this.walk(x, f, all)); return; }
      if (!e.k) return;
      f(e);
      if (e.k === 'sub') { if (e.test) this.walk(e.test, f, all); if (e.tests) for (const t of e.tests) this.walk(t.e, f, all); return; }
      if (e.k === 'aggcall' && !all) return;
      for (const k of ['l', 'r', 'e', 'a', 'b', 'base', 'else', 'test', 'filter', 'arr', 'lo', 'hi', 'pat', 'esc']) if (e[k]) this.walk(e[k], f, all);
      for (const k of ['items', 'args', 'partition']) if (e[k]) this.walk(e[k], f, all);
      if (e.whens) for (const w of e.whens) { this.walk(w.c, f, all); this.walk(w.r, f, all); }
      if (e.order) for (const o of e.order) this.walk(o.e, f, all);
      if (e.tests) for (const t of e.tests) this.walk(t.e, f, all);
      if (e.pairs) { this.walk(e.pairs, f, all); this.walk(e.eqs, f, all); }
    }
    /** rebuild an expression bottom-up; fn returns a replacement node or null to keep going */
    mapExpr(e, fn) {
      if (!e || typeof e !== 'object' || !e.k) return e;
      const rep = fn(e);
      if (rep) return rep;
      // a subquery's own plan belongs to its level, but the tested value (x IN (...)) belongs to this one
      if (e.k === 'sub') { if (!e.test && !e.tests) return e; const o = Object.assign({}, e); if (e.test) o.test = this.mapExpr(e.test, fn); if (e.tests) o.tests = e.tests.map((t) => Object.assign({}, t, { e: this.mapExpr(t.e, fn) })); return o; }
      if (e.k === 'const' || e.k === 'col') return e;
      const out = Object.assign({}, e);
      for (const k of ['l', 'r', 'e', 'a', 'b', 'base', 'else', 'test', 'arr', 'lo', 'hi', 'pat', 'esc']) if (e[k]) out[k] = this.mapExpr(e[k], fn);
      if (e.k !== 'aggcall' && e.k !== 'wincall') for (const k of ['items', 'args']) if (e[k]) out[k] = e[k].map((x) => this.mapExpr(x, fn));
      if (e.k === 'aggcall' || e.k === 'wincall') { /* their arguments belong to the level below */ if (e.filter && e.k === 'wincall') out.filter = this.mapExpr(e.filter, fn); }
      if (e.whens) out.whens = e.whens.map((w) => ({ c: this.mapExpr(w.c, fn), r: this.mapExpr(w.r, fn) }));
      if (e.tests) out.tests = e.tests.map((t) => Object.assign({}, t, { e: this.mapExpr(t.e, fn) }));
      if (e.pairs) { out.pairs = e.pairs.map((x) => this.mapExpr(x, fn)); out.eqs = e.eqs.map((x) => this.mapExpr(x, fn)); }
      return out;
    }
  }
  function lev(a, b) {
    if (Math.abs(a.length - b.length) > 3) return 9;
    const d = K.range(b.length + 1);
    for (let i = 1; i <= a.length; i++) {
      let prev = d[0]; d[0] = i;
      for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
    }
    return d[b.length];
  }

  K.Binder = Binder;
  K.Scope = Scope;
})(typeof window !== 'undefined' ? window : globalThis);
