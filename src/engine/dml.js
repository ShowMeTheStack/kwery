// Data manipulation: INSERT (with defaults, identity columns, ON CONFLICT), UPDATE and DELETE (with FROM and
// USING), RETURNING, and the integrity constraints every changed row must keep: NOT NULL, CHECK, UNIQUE and
// PRIMARY KEY (through the index), and FOREIGN KEY with its referential actions. A row update is a new version
// plus the old one marked replaced, as in PostgreSQL; foreign keys are checked when the statement ends.
(function (root) {
  'use strict';
  const K = root.K;
  const S = K.STATE;
  const B = () => K.T.BASE;
  const T = () => K.T;
  const X = () => K.Expr;
  const IM = () => K.Tuple.IM;

  const tidOf = (s) => { const m = /^\((\d+),(\d+)\)$/.exec(s); return { b: +m[1], o: +m[2] }; };
  const tkey = (t) => t.b + ':' + t.o;

  class DML {
    constructor(db) { this.db = db; }

    // ---- binding ----------------------------------------------------------------------------------------------------
    target(binder, q, verb) {
      const rel = binder.cat.lookup(q.table, binder.path(), ['table', 'view', 'matview', 'sequence']);
      if (!rel) binder.fail(S.undefinedTable, 'relation "' + (q.table.schema ? q.table.schema + '.' : '') + q.table.name + '" does not exist', q.pos);
      if (rel.kind === 'matview') binder.fail(S.wrongObjectType, 'cannot change materialized view "' + rel.name + '"', q.pos);
      if (rel.kind === 'sequence') binder.fail(S.wrongObjectType, 'cannot change sequence "' + rel.name + '"', q.pos);
      if (rel.kind === 'view') {
        if (rel.triggers.some((t) => t.timing === 'instead of' && t.events.some((e) => e.event === verb))) return { rel, instead: true };
        const base = this.updatableView(binder, rel, verb, q.pos);
        return { rel: base.rel, view: rel, viewMap: base.map, viewWhere: base.where, check: base.check };
      }
      // INSERT and UPDATE may be granted on some columns only
      const cols = verb === 'insert' ? q.cols : verb === 'update' && q.set ? q.set.flatMap((x) => x.cols || [x.col]) : null;
      binder.s.checkPrivilege(rel, verb, q.pos, binder.asUser, cols);
      return { rel, verb };
    }
    /**
     * row-level security: the condition (USING, or WITH CHECK falling back to USING) a row must meet for cmd, or null
     * when the table's policies do not apply (RLS off, a superuser, or the owner unless FORCE). Permissive policies
     * combine with OR, restrictive ones with AND; with no permissive policy nothing is allowed.
     */
    rls(s, rel, cmd, which, asUser) {
      if (!rel.rls) return null;
      const user = asUser || s.user, role = s.catalog.roles.get(user);
      if ((role && role.superuser) || (rel.owner === user && !rel.forceRls)) return null;
      const mine = s.roles(user);
      const ps = (rel.policies || []).filter((p) => (p.cmd === 'all' || p.cmd === cmd) && p.roles.some((r) => mine.has(r)));
      const qual = (p) => (which === 'check' ? p.check || p.using : p.using);
      const perm = ps.filter((p) => p.permissive && qual(p)).map(qual);
      let e = perm.length ? perm.reduce((a, b) => ({ k: 'or', l: a, r: b })) : { k: 'lit', v: false, type: 'bool' };
      for (const p of ps) if (!p.permissive && qual(p)) e = { k: 'and', l: e, r: qual(p) };
      return e;
    }
    /** a simple view (one table, no grouping, DISTINCT, set operations or LIMIT) can be changed through */
    updatableView(binder, v, verb, pos) {
      const q = v.parsed || (v.parsed = K.parse(v.queryText)[0]);
      const why = q.type !== 'select' ? 'Views containing UNION, INTERSECT, or EXCEPT are not automatically updatable.' : q.from.length !== 1 || q.from[0].kind !== 'table' ? 'Views that do not select from a single table or view are not automatically updatable.' : q.groupBy || q.having ? 'Views containing GROUP BY are not automatically updatable.' : q.distinct ? 'Views containing DISTINCT are not automatically updatable.' : q.limit !== undefined || q.offset !== undefined ? 'Views containing LIMIT or OFFSET are not automatically updatable.' : q.with ? 'Views containing WITH are not automatically updatable.' : null;
      if (why) binder.fail('55000', 'cannot ' + verb + ' ' + (verb === 'insert' ? 'into ' : verb === 'delete' ? 'from ' : '') + 'view "' + v.name + '"', pos, { detail: why, hint: 'To enable ' + (verb === 'insert' ? 'inserting into' : verb === 'update' ? 'updating' : 'deleting from') + ' the view, provide an INSTEAD OF ' + verb.toUpperCase() + ' trigger or an unconditional ON ' + verb.toUpperCase() + ' DO INSTEAD rule.' });
      const inner = this.target(binder, { table: q.from[0].name, pos }, verb);
      // view column -> base column (only plain column references can be written)
      const map = [];
      for (const [i, t] of q.targets.entries()) {
        if (t.star) { inner.rel.cols.forEach((c, a) => { if (!c.dropped) map.push({ name: c.name, attnum: inner.viewMap ? inner.viewMap[a] && inner.viewMap[a].attnum : a }); }); continue; }
        const name = (v.colNames && v.colNames[map.length]) || t.alias || binder.colName(t.expr);
        const col = t.expr.k === 'col' ? inner.rel.cols.findIndex((c) => c.name === t.expr.parts[t.expr.parts.length - 1]) : -1;
        map.push({ name, attnum: col >= 0 ? col : undefined, expr: t.expr });
        void i;
      }
      const and = (a, b) => (a && b ? { k: 'and', l: a, r: b } : a || b);
      const where = and(inner.viewWhere, q.where);
      // what new rows must satisfy: CASCADED checks every level below, LOCAL this view's condition and the
      // check options of the views below, no option only the latter
      const check = v.check === 'cascaded' ? where : v.check === 'local' ? and(inner.check, q.where) : inner.check;
      return { rel: inner.rel, map, where, check };
    }
    /** an assignment cast: what INSERT and UPDATE allow when storing a value into a column */
    /** is there an assignment (or implicit) cast from type a to type b */
    assignable(a, b) {
      const from = a.domain ? a.base : a, to = b.domain ? b.base : b;
      return T().implicit(from, to) || from.id === to.id || (from.cat === 'N' && to.cat === 'N') || to.cat === 'S' || (from.cat === 'S' && to.cat === 'S') || (from.cat === 'D' && to.cat === 'D') || (from.cat === 'J' && to.cat === 'J') || (from.cat === 'A' && to.cat === 'A') || (from.cat === 'C' && to.cat === 'C') || (from.cat === 'S' && to.cat === 'E');
    }
    assign(e, t, colName, binder) {
      if (e.k === 'default') return e;
      if (X().isUnknown(e) || e.type.cat === 'P') return X().coerce(e, t, false);
      if (e.type.id === t.id && e.type.cat !== 'S' && !(t.id === 'numeric' && t.p !== undefined) && t.prec === undefined && !t.field) return e;
      if (!this.assignable(e.type, t)) binder.fail(S.datatypeMismatch, 'column "' + colName + '" is of type ' + T().sqlName(t) + ' but expression is of type ' + T().sqlName(e.type), e.pos, { hint: 'You will need to rewrite or cast the expression.' });
      return { k: 'cast', e, type: t, explicit: false, pos: e.pos };
    }
    /** a scope item for the target table, with its columns (and system columns) */
    targetItem(binder, rel, name, scope) {
      const cols = [];
      rel.cols.forEach((c, i) => { if (!c.dropped) cols.push({ id: binder.id(), name: c.name, type: c.type, attnum: i, table: name }); });
      const item = { name, cols, rel };
      scope.items.push(item);
      return item;
    }
    bind(binder, q, scope) {
      if (q.type === 'insert') return this.bindInsert(binder, q, scope);
      if (q.type === 'update') return this.bindUpdate(binder, q, scope);
      return this.bindDelete(binder, q, scope);
    }
    bindDefaults(binder, rel) {
      const out = rel.cols.map(() => null);
      rel.cols.forEach((c, i) => {
        if (c.dropped) return;
        let ast = c.default || (c.type.domain && c.type.default) || null;
        if (!ast) return;
        const e = binder.expr(ast, new K.Scope(null), { noAgg: 'aggregate functions are not allowed in DEFAULT expressions' });
        out[i] = this.assign(e, c.type, c.name, binder);
      });
      return out;
    }
    bindGenerated(binder, rel) {
      return rel.cols.map((c) => (c.generated && !c.dropped ? { f: this.db.tableExpr(binder.s, rel, c.generated, 'generation expression', { type: c.type }) } : null));
    }
    bindInsert(binder, q, scope) {
      const tg = this.target(binder, q, 'insert');
      if (tg.instead) return this.bindInstead(binder, q, scope, tg);
      const rel = tg.rel;
      if (binder.s.readOnly()) binder.fail(S.readOnlyTxn, 'cannot execute INSERT in a read-only transaction', q.pos);
      // the target columns
      let targets;
      if (q.cols) {
        targets = q.cols.map((name) => {
          const m = tg.viewMap ? tg.viewMap.find((x) => x.name === name) : null;
          const a = tg.viewMap ? (m ? m.attnum : -2) : rel.cols.findIndex((c) => c.name === name && !c.dropped);
          if (a === -2 || a === undefined) binder.fail(S.featureNotSupported, 'cannot insert into column "' + name + '" of view "' + tg.view.name + '"', q.pos, { detail: 'View columns that are not columns of their base relation are not updatable.' });
          if (a < 0) binder.fail(S.undefinedColumn, 'column "' + name + '" of relation "' + rel.name + '" does not exist', q.pos);
          return a;
        });
        const fl = q.colFields;
        const dup = targets.find((a, i) => targets.findIndex((b, j) => b === a && !(fl && fl[i] && fl[j] && fl[i].join('.') !== fl[j].join('.'))) !== i);
        if (dup !== undefined) binder.fail(S.duplicateColumn, 'column "' + rel.cols[dup].name + '" specified more than once', q.pos);
      } else targets = tg.viewMap ? tg.viewMap.filter((m) => m.attnum !== undefined).map((m) => m.attnum) : rel.cols.map((c, i) => (c.dropped ? -1 : i)).filter((i) => i >= 0);
      // the source rows, typed for the target columns (or for the composite fields they name)
      const fieldOf = (i) => {
        let t = rel.cols[targets[i]].type, name = rel.cols[targets[i]].name;
        for (const f of (q.colFields && q.colFields[i]) || []) {
          const k = t.cat === 'C' && t.fields ? t.fields.findIndex((x) => x.name === f) : -1;
          if (k < 0) binder.fail(S.datatypeMismatch, 'cannot assign to field "' + f + '" of column "' + name + '" because its type ' + T().sqlName(t) + ' is not a composite type', q.pos);
          t = t.fields[k].type; name = f;
        }
        return { type: t, name };
      };
      const tt = targets.map((a, i) => fieldOf(i));
      let src;
      if (q.defaults) src = { op: 'Values', tuples: [targets.map(() => ({ k: 'default', type: B().unknown }))], cols: targets.map((a) => ({ id: binder.id(), name: rel.cols[a].name, type: rel.cols[a].type })), children: [] };
      else if (q.source.type === 'values' && !q.source.order && q.source.limit === undefined && !q.source.with) {
        const rows = q.source.rows.map((r) => {
          if (r.length > targets.length) binder.fail(S.syntax, 'INSERT has more expressions than target columns', r[targets.length].pos);
          if (r.length < targets.length && q.cols) binder.fail(S.syntax, 'INSERT has more target columns than expressions', r.length ? r[r.length - 1].pos : q.pos);
          return r.map((e, i) => (e.k === 'default' ? { k: 'default', type: B().unknown } : this.assign(binder.expr(e, scope, { noAgg: 'aggregate functions are not allowed in VALUES', noWin: 'window functions are not allowed in VALUES' }), tt[i].type, tt[i].name, binder)));
        });
        if (q.colFields) { const m = this.mergeFields(targets, q.colFields, rows, rel); targets = m.targets; rows.splice(0, rows.length, ...m.rows); }
        const width = Math.max(...rows.map((r) => r.length));
        targets = targets.slice(0, width);
        for (const r of rows) while (r.length < width) r.push({ k: 'default', type: B().unknown });
        src = { op: 'Values', tuples: rows, cols: targets.map((a) => ({ id: binder.id(), name: rel.cols[a].name, type: rel.cols[a].type })), children: [] };
      } else {
        const sub = binder.query(q.source, scope);
        const vis = sub.cols.filter((c) => !c.hidden);
        if (vis.length > targets.length) binder.fail(S.syntax, 'INSERT has more expressions than target columns', q.source.pos);
        if (vis.length < targets.length && q.cols) binder.fail(S.syntax, 'INSERT has more target columns than expressions', q.source.pos);
        targets = targets.slice(0, vis.length);
        let exprs = vis.map((c, i) => this.assign({ k: 'col', id: c.id, type: c.type, name: c.name }, tt[i].type, tt[i].name, binder));
        if (q.colFields) { const m = this.mergeFields(targets, q.colFields, [exprs], rel); targets = m.targets; exprs = m.rows[0]; }
        src = { op: 'Project', exprs, children: [sub], cols: exprs.map((c, i) => ({ id: binder.id(), name: rel.cols[targets[i]].name, type: rel.cols[targets[i]].type })) };
      }
      // identity GENERATED ALWAYS and generated columns may not be given values
      for (const a of targets) {
        const c = rel.cols[a];
        if (c.generated && !(src.op === 'Values' && src.tuples.every((r) => r[targets.indexOf(a)].k === 'default'))) binder.fail(S.generatedAlways, 'cannot insert a non-DEFAULT value into column "' + c.name + '"', q.pos, { detail: 'Column "' + c.name + '" is a generated column.' });
        if (c.identity === 'always' && q.overriding !== 'system' && !(src.op === 'Values' && src.tuples.every((r) => r[targets.indexOf(a)].k === 'default'))) binder.fail(S.generatedAlways, 'cannot insert a non-DEFAULT value into column "' + c.name + '"', q.pos, { detail: 'Column "' + c.name + '" is an identity column defined as GENERATED ALWAYS.', hint: 'Use OVERRIDING SYSTEM VALUE to override.' });
      }
      const node = { op: 'Modify', kind: 'insert', rel, children: [src], targets, overriding: q.overriding, defaults: this.bindDefaults(binder, rel), generated: this.bindGenerated(binder, rel), cols: [], view: tg.view || null, viewMap: tg.viewMap, viewWhere: tg.viewWhere, check: tg.check , rlsCheck: tg.verb ? this.rls(binder.s, rel, 'insert', 'check', binder.asUser) : null };
      if (q.onConflict) this.bindConflict(binder, q, scope, node);
      this.bindReturning(binder, q, scope, node, q.alias || (tg.view ? tg.view.name : rel.name), null);
      return node;
    }
    /** INSERT (c.x, c.y): the field values of one composite column become one ROW value, missing fields NULL */
    mergeFields(targets, fields, rows, rel) {
      const out = [...new Set(targets)];
      return { targets: out, rows: rows.map((r) => out.map((a) => {
        const ix = targets.map((b, i) => (b === a ? i : -1)).filter((i) => i >= 0);
        if (!fields[ix[0]]) return r[ix[0]];
        const t = rel.cols[a].type;
        const build = (t, depth, ixs) => ({ k: 'row', type: t, items: t.fields.map((f) => {
          const hit = ixs.filter((i) => fields[i][depth] === f.name);
          if (!hit.length) return K.cst(null, f.type);
          if (fields[hit[0]].length === depth + 1) return r[hit[0]].k === 'default' ? K.cst(null, f.type) : r[hit[0]];
          return build(f.type, depth + 1, hit);
        }) });
        return build(t, 0, ix);
      })) };
    }
    bindConflict(binder, q, scope, node) {
      const rel = node.rel, c = q.onConflict;
      let arbiter = null;
      const idxs = binder.cat.indexesOf(rel).filter((ix) => ix.unique);
      if (c.constraint) {
        const k = rel.constraints.find((x) => x.name === c.constraint);
        if (!k || !k.index) binder.fail(S.undefinedObject, 'constraint "' + c.constraint + '" for table "' + rel.name + '" does not exist', q.pos);
        arbiter = [binder.cat.rel(k.index)];
      } else if (c.target) {
        const atts = c.target.map((e) => { const n = e.k === 'col' ? e.parts[e.parts.length - 1] : null; const a = rel.cols.findIndex((x) => x.name === n); return a; });
        arbiter = idxs.filter((ix) => ix.keys.length === atts.length && ix.keys.every((k) => atts.includes(k.attnum)));
        if (!arbiter.length) binder.fail(S.invalidColumnReference || '42P10', 'there is no unique or exclusion constraint matching the ON CONFLICT specification', q.pos);
      }
      if (arbiter && arbiter.some((ix) => rel.constraints.some((k) => k.index === ix.oid && k.deferrable))) binder.fail('55000', 'ON CONFLICT does not support deferrable unique constraints/exclusion constraints as arbiters', q.pos);
      if (!c.constraint && !c.target && c.action === 'update') binder.fail(S.syntax, 'ON CONFLICT DO UPDATE requires inference specification or constraint name', q.pos, { hint: 'For example, ON CONFLICT (column_name).' });
      node.conflict = { action: c.action, arbiter: arbiter ? arbiter.map((ix) => ix.oid) : null };
      if (c.action === 'update') {
        const sc = new K.Scope(scope);
        const tItem = this.targetItem(binder, rel, q.alias || rel.name, sc);
        const xItem = this.targetItem(binder, rel, 'excluded', sc);
        const lay = new Map();
        tItem.cols.forEach((col) => lay.set(col.id, col.attnum));
        xItem.cols.forEach((col) => lay.set(col.id, rel.cols.length + col.attnum));
        node.conflict.sets = this.bindSets(binder, c.set, sc, rel);
        node.conflict.where = c.where ? binder.boolExpr(c.where, sc, 'WHERE') : null;
        node.conflict.layout = lay;
      }
    }
    bindSets(binder, list, scope, rel, tg) {
      const out = [];
      for (const s of list) {
        if (s.cols) {
          const atts = s.cols.map((n) => this.setCol(binder, rel, n, tg));
          if (s.expr.k === 'row') {
            if (s.expr.plain && atts.length > 1) binder.fail(S.featureNotSupported, 'source for a multiple-column UPDATE item must be a sub-SELECT or ROW() expression', s.expr.pos);
            if (s.expr.items.length !== atts.length) binder.fail(S.syntax, 'number of columns does not match number of values', s.expr.pos);
            s.expr.items.forEach((e, i) => out.push({ attnum: atts[i], e: e.k === 'default' ? { k: 'default' } : this.assign(binder.expr(e, scope), rel.cols[atts[i]].type, rel.cols[atts[i]].name, binder) }));
          } else {
            // (a, b) = (SELECT x, y ...): one subquery row gives several columns
            const rowSub = binder.subquery({ kind: 'row', query: s.expr.query, pos: s.expr.pos }, scope, {});
            const vis = rowSub.type.fields;
            if (vis.length !== atts.length) binder.fail(S.syntax, 'number of columns does not match number of values', s.expr.pos);
            atts.forEach((a, i) => out.push({ attnum: a, e: this.assign({ k: 'field', e: rowSub, index: i, type: vis[i].type, name: vis[i].name }, rel.cols[a].type, rel.cols[a].name, binder) }));
          }
          continue;
        }
        const a = this.setCol(binder, rel, s.col, tg);
        const c = rel.cols[a];
        if (s.expr.k === 'default') { out.push({ attnum: a, e: { k: 'default' } }); continue; }
        if (s.path) {
          // col[i] = v and col.field = v: change one part of the old value
          const e = binder.expr(s.expr, scope);
          out.push({ attnum: a, path: s.path.map((p) => (p.idx ? { idx: X().coerce(binder.expr(p.idx, scope), B().int4), hi: p.hi ? X().coerce(binder.expr(p.hi, scope), B().int4) : null } : { field: p.field })), e: c.type.cat === 'A' ? this.assign(e, s.path.some((p) => p.hi) ? c.type : c.type.elem, c.name, binder) : this.fieldAssign(binder, c, s.path, e) });
          continue;
        }
        if (c.generated) binder.fail(S.generatedAlways, 'column "' + c.name + '" can only be updated to DEFAULT', s.expr.pos, { detail: 'Column "' + c.name + '" is a generated column.' });
        if (c.identity === 'always') binder.fail(S.generatedAlways, 'column "' + c.name + '" can only be updated to DEFAULT', s.expr.pos, { detail: 'Column "' + c.name + '" is an identity column defined as GENERATED ALWAYS.' });
        out.push({ attnum: a, e: this.assign(binder.expr(s.expr, scope, { noAgg: 'aggregate functions are not allowed in UPDATE', noWin: 'window functions are not allowed in UPDATE' }), c.type, c.name, binder) });
      }
      const seen = new Set();
      for (const s of out) { if (seen.has(s.attnum) && !s.path) binder.fail(S.syntax, 'multiple assignments to same column "' + rel.cols[s.attnum].name + '"'); seen.add(s.attnum); }
      return out;
    }
    fieldAssign(binder, c, path, e) {
      let t = c.type;
      for (const p of path) { if (!t.fields) binder.fail(S.datatypeMismatch, 'cannot assign to field "' + p.field + '" of column "' + c.name + '" because its type ' + T().sqlName(t) + ' is not a composite type'); const f = t.fields.find((x) => x.name === p.field); if (!f) binder.fail(S.undefinedColumn, 'cannot assign to field "' + p.field + '" of column "' + c.name + '" because there is no such column in data type ' + t.name); t = f.type; }
      return this.assign(e, t, c.name, binder);
    }
    setCol(binder, rel, name, tg) {
      if (tg && tg.viewMap) { const m = tg.viewMap.find((x) => x.name === name); if (!m) binder.fail(S.undefinedColumn, 'column "' + name + '" of relation "' + tg.view.name + '" does not exist'); if (m.attnum === undefined) binder.fail(S.featureNotSupported, 'cannot update column "' + name + '" of view "' + tg.view.name + '"', null, { detail: 'View columns that are not columns of their base relation are not updatable.' }); return m.attnum; }
      const a = rel.cols.findIndex((c) => c.name === name && !c.dropped);
      if (a < 0) binder.fail(S.undefinedColumn, 'column "' + name + '" of relation "' + rel.name + '" does not exist');
      return a;
    }
    /** UPDATE and DELETE read their rows with a plan: the target table (and FROM / USING items) filtered by WHERE */
    bindScan(binder, q, scope, tg, extra) {
      const sc = new K.Scope(scope);
      const name = q.alias || (tg.view ? tg.view.name : tg.rel.name);
      const scan = binder.fromItem({ kind: 'table', name: { schema: tg.rel.schema, name: tg.rel.name }, alias: { name }, only: q.only }, sc);
      if (tg.view && tg.viewMap) {
        // view column names reach the base columns
        const item = sc.items[sc.items.length - 1];
        item.cols = tg.viewMap.filter((m) => m.attnum !== undefined).map((m) => Object.assign({}, scan.cols.find((c) => c.attnum === m.attnum), { name: m.name }));
        item.cols.push(...scan.cols.filter((c) => c.hidden));
      }
      let node = scan;
      for (const f of extra || []) { const n = binder.fromItem(f, sc); node = { op: 'Join', jtype: 'cross', children: [node, n], cols: node.cols.concat(n.cols), cond: null, implicit: true }; }
      let where = q.where ? binder.boolExpr(q.where, sc, 'WHERE', { noAgg: 'aggregate functions are not allowed in WHERE', noWin: 'window functions are not allowed in WHERE' }) : null;
      if (tg.viewWhere) {
        // the view's own condition may use base columns the view does not show
        const vs = new K.Scope(scope);
        vs.items.push({ name: tg.rel.name, cols: scan.cols, rel: tg.rel });
        const vw = binder.boolExpr(tg.viewWhere, vs, 'WHERE');
        where = where ? { k: 'and', items: [vw, where], type: B().bool } : vw;
      }
      const rq = tg.verb && this.rls(binder.s, tg.rel, tg.verb, 'using', binder.asUser);
      if (rq) {
        const rs = new K.Scope(null);
        rs.items.push({ name: tg.rel.name, cols: scan.cols, rel: tg.rel });
        const c = binder.boolExpr(rq, rs, 'POLICY');
        where = where ? { k: 'and', items: [c, where], type: B().bool } : c;
      }
      if (q.currentOf) {
        const cur = binder.s.cursor(q.currentOf);
        where = { k: 'cmp', op: '=', l: { k: 'col', id: scan.sys.ctid, type: B().text }, r: K.cst(cur.currentTid(tg.rel), B().text), ctype: B().text, type: B().bool };
      }
      if (where) node = { op: 'Filter', cond: where, children: [node], cols: node.cols, where: true };
      return { sc, scan, node, where };
    }
    bindUpdate(binder, q, scope) {
      const tg = this.target(binder, q, 'update');
      if (tg.instead) return this.bindInstead(binder, q, scope, tg);
      if (binder.s.readOnly()) binder.fail(S.readOnlyTxn, 'cannot execute UPDATE in a read-only transaction', q.pos);
      const { sc, scan, node, where } = this.bindScan(binder, q, scope, tg, q.from);
      const sets = this.bindSets(binder, q.set, sc, tg.rel, tg);
      const m = { op: 'Modify', kind: 'update', rel: tg.rel, children: [node], scanCols: scan.cols, ctidId: scan.sys.ctid, sets, recheck: where, defaults: this.bindDefaults(binder, tg.rel), generated: this.bindGenerated(binder, tg.rel), cols: [], view: tg.view || null, viewWhere: tg.viewWhere, check: tg.check , rlsCheck: tg.verb ? this.rls(binder.s, tg.rel, 'update', 'check', binder.asUser) : null };
      this.bindReturning(binder, q, sc, m, null, node);
      return m;
    }
    bindDelete(binder, q, scope) {
      const tg = this.target(binder, q, 'delete');
      if (tg.instead) return this.bindInstead(binder, q, scope, tg);
      if (binder.s.readOnly()) binder.fail(S.readOnlyTxn, 'cannot execute DELETE in a read-only transaction', q.pos);
      const { sc, scan, node, where } = this.bindScan(binder, q, scope, tg, q.using);
      const m = { op: 'Modify', kind: 'delete', rel: tg.rel, children: [node], scanCols: scan.cols, ctidId: scan.sys.ctid, recheck: where, cols: [], view: tg.view || null };
      this.bindReturning(binder, q, sc, m, null, node);
      return m;
    }
    /** RETURNING: expressions over the new row (old for DELETE), and for UPDATE ... FROM the other FROM items */
    bindReturning(binder, q, scope, node, name, child) {
      if (!q.returning) return;
      let sc = scope, lay;
      if (node.kind === 'insert') {
        sc = new K.Scope(scope);
        const item = this.targetItem(binder, node.rel, name, sc);
        // through a view, RETURNING sees the view's columns
        if (node.viewMap) item.cols = node.viewMap.filter((m) => m.attnum !== undefined).map((m) => Object.assign({}, item.cols.find((c) => c.attnum === m.attnum), { name: m.name }));
        lay = new Map(item.cols.map((c) => [c.id, c.attnum]));
      } else {
        // the scan's columns are replaced by the changed row's values; other columns come from the input row
        lay = new Map();
        const w = node.rel.cols.length;
        for (const c of node.scanCols) if (c.attnum !== undefined) lay.set(c.id, c.attnum);
        child.cols.forEach((c, i) => { if (!lay.has(c.id)) lay.set(c.id, w + i); });
      }
      const targets = binder.targets(q.returning, sc);
      for (const t of targets) if (binder.containsAgg(t.e)) binder.fail(S.groupingError, 'aggregate functions are not allowed in RETURNING', t.pos);
      node.returning = targets.map((t) => t.e);
      node.retLayout = lay;
      node.cols = targets.map((t) => ({ id: binder.id(), name: t.name, type: t.e.type }));
    }
    bindInstead(binder, q, scope, tg) {
      // INSTEAD OF triggers on a view: the rows are handed to the trigger function, nothing is written here
      const v = tg.rel;
      const fake = { kind: 'table', cols: v.cols.map((c) => ({ name: c.name, type: c.type })), name: v.name, schema: v.schema };
      void fake;
      binder.fail(S.featureNotSupported, 'INSTEAD OF triggers run in the procedural language module', q.pos);
    }

    // ---- running ------------------------------------------------------------------------------------------------------
    *run(n, ctx, run) {
      const rel = n.rel;
      yield* this.db.locks.acquire(ctx.tx, 'table:' + rel.oid, 'table', 'row exclusive', { what: 'relation ' + rel.name });
      const child = n.children[0];
      const lay = K.Exec.layoutOf(child.cols);
      const C = (e) => K.Expr.compile(e, lay);
      const w = rel.cols.length;
      // the planner may reorder the FROM / USING items: other columns are found where the plan put them
      let retLay = n.retLayout;
      if (retLay && n.kind !== 'insert') { retLay = new Map([...retLay].filter(([, v]) => v < w)); for (const [id, i] of lay) if (!retLay.has(id)) retLay.set(id, w + i); }
      const ret = n.returning ? n.returning.map((e) => K.Expr.compile(e, retLay)) : null;
      const emit = (vals, row) => (ret ? ret.map((f) => f(n.kind === 'insert' ? vals : vals.concat(row), ctx)) : null);
      const trig = this.db.triggers;
      if (trig) yield* trig.statement(rel, 'before', n.kind, ctx);
      let count = 0;
      if (n.kind === 'insert') {
        const defs = n.defaults.map((e) => (e && e.k !== 'default' ? K.Expr.compile(e, new Map()) : null));
        const conflict = n.conflict ? this.conflictRunner(n, ctx) : null;
        const touched = new Set();
        for (const r of run(child, ctx)) {
          if (K.Exec.isSignal(r)) { yield r; continue; }
          const vals = new Array(w).fill(null);
          const given = new Array(w).fill(false);
          // OVERRIDING USER VALUE ignores the values given for identity columns
          n.targets.forEach((a, i) => { if (r[i] !== K.DEFAULT && !(n.overriding === 'user' && rel.cols[a].identity)) { vals[a] = r[i]; given[a] = true; } });
          for (let a = 0; a < w; a++) {
            const c = rel.cols[a];
            if (c.dropped || given[a] || c.generated) continue;
            if (c.identity && c.seq) vals[a] = this.db.castTo(this.db.sequenceNext(ctx.session.catalog.rel(c.seq), ctx), c.type, ctx);
            else if (defs[a]) vals[a] = defs[a]([], ctx);
          }
          this.generate(n, vals, ctx);
          if (n.check) this.checkOption(n, vals, ctx);
          if (n.rlsCheck) this.rlsCheck(n, vals, ctx);
          if (conflict) {
            const c = yield* conflict(vals, touched);
            if (c.done) { if (c.row) { count++; const o = emit(c.row, r); if (o) yield o; } continue; }
          }
          let newVals = vals;
          if (trig) { newVals = yield* trig.row(rel, 'before', 'insert', ctx, null, vals); if (!newVals) continue; }
          const tid = yield* this.insertRow(rel, newVals, ctx);
          // a later row of this command may not update one it inserted
          if (conflict) touched.add(tkey(tid));
          if (trig) yield* trig.row(rel, 'after', 'insert', ctx, null, newVals, tid);
          count++;
          const o = emit(newVals, r); if (o) yield o;
        }
      } else {
        const ctidIdx = lay.get(n.ctidId);
        const tIdx = rel.cols.map((c, a) => { const sc = n.scanCols.find((x) => x.attnum === a); return sc ? lay.get(sc.id) : undefined; });
        const recheck = n.recheck ? C(n.recheck) : null;
        const sets = n.kind === 'update' ? n.sets.map((s) => ({ attnum: s.attnum, f: s.e.k === 'default' ? null : K.Expr.compile(s.e, lay), path: s.path ? s.path.map((p) => (p.idx ? { idx: K.Expr.compile(p.idx, lay), hi: p.hi ? K.Expr.compile(p.hi, lay) : null } : p)) : null })) : null;
        const defs = n.kind === 'update' ? n.defaults.map((e) => (e ? K.Expr.compile(e, new Map()) : null)) : null;
        const keyCols = new Set(this.db.catalogOf(ctx).indexesOf(rel).filter((ix) => ix.unique).flatMap((ix) => ix.keys.map((k) => k.attnum)));
        const keyChange = sets && sets.some((s) => keyCols.has(s.attnum));
        const done = new Set();
        for (let r of run(child, ctx)) {
          if (K.Exec.isSignal(r)) { yield r; continue; }
          let tid = tidOf(r[ctidIdx]);
          if (done.has(tkey(tid))) continue;
          let ok = false;
          for (let tries = 0; tries < 1000; tries++) {
            const p = yield* this.db.cc.prepareModify(rel, tid, ctx, n.kind === 'delete' || keyChange ? 'update' : 'no key update');
            if (p === false || p.gone) break;
            if (p.ok) { tid = p.tid; ok = true; break; }
            // READ COMMITTED: someone else committed a newer version; re-check this statement's conditions on it
            const latest = this.db.cc.latest(rel, p.moved);
            if (!latest || this.db.xact.aborted(latest.h.xmin)) break;
            const t = this.db.heap(rel).fetch(latest.tid);
            const vals = K.Tuple.deform(t.bytes, rel.cols, ctx);
            this.db.buffers.unpin(t.frame, false);
            r = r.slice();
            rel.cols.forEach((c, a) => { if (tIdx[a] !== undefined) r[tIdx[a]] = vals[a]; });
            r[ctidIdx] = '(' + latest.tid.b + ',' + latest.tid.o + ')';
            if (recheck && recheck(r, ctx) !== true) { ctx.bus.emit('cc.recheck.fail', { rel: rel.name, tid: latest.tid }); break; }
            tid = latest.tid;
          }
          if (!ok) continue;
          done.add(tkey(tid));
          const old = rel.cols.map((c, a) => (tIdx[a] !== undefined ? r[tIdx[a]] : null));
          if (n.kind === 'delete') {
            if (trig && !(yield* trig.row(rel, 'before', 'delete', ctx, old, null))) continue;
            yield* this.deleteRow(rel, tid, old, ctx);
            if (trig) yield* trig.row(rel, 'after', 'delete', ctx, old, null);
            count++;
            const o = emit(old, r); if (o) yield o;
          } else {
            let vals = old.slice();
            for (const s of sets) {
              if (!s.f) { vals[s.attnum] = rel.cols[s.attnum].identity ? this.db.castTo(this.db.sequenceNext(this.db.catalogOf(ctx).rel(rel.cols[s.attnum].seq), ctx), rel.cols[s.attnum].type, ctx) : defs[s.attnum] ? defs[s.attnum]([], ctx) : null; continue; }
              const v = s.f(r, ctx);
              vals[s.attnum] = s.path ? this.applyPath(vals[s.attnum], s.path, v, r, ctx, rel.cols[s.attnum].type) : v;
            }
            this.generate(n, vals, ctx);
            if (n.check) this.checkOption(n, vals, ctx);
            if (n.rlsCheck) this.rlsCheck(n, vals, ctx);
            if (trig) { vals = yield* trig.row(rel, 'before', 'update', ctx, old, vals); if (!vals) continue; }
            const nt = yield* this.updateRow(rel, tid, old, vals, ctx);
            if (trig) yield* trig.row(rel, 'after', 'update', ctx, old, vals, nt);
            count++;
            const o = emit(vals, r); if (o) yield o;
          }
        }
      }
      if (trig) yield* trig.statement(rel, 'after', n.kind, ctx);
      n.count = count;
      ctx.rowCount = (ctx.rowCount || 0) + count;
    }
    applyPath(old, path, v, row, ctx, type) {
      const p = path[0];
      if (p.field !== undefined) {
        const t = type;
        const i = t.fields.findIndex((f) => f.name === p.field);
        const vals = old ? old.values.slice() : t.fields.map(() => null);
        vals[i] = path.length > 1 ? this.applyPath(vals[i], path.slice(1), v, row, ctx, t.fields[i].type) : v;
        return new K.RowV(vals, t);
      }
      const i = p.idx(row, ctx);
      if (i === null) throw K.err(S.nullNotAllowed, 'array subscript in assignment must not be null');
      const a = old ? old : new K.ArrayV([], i);
      const items = a.items.slice();
      let lower = a.lower;
      if (p.hi) {
        const hi = p.hi(row, ctx);
        if (hi === null) throw K.err(S.nullNotAllowed, 'array subscript in assignment must not be null');
        if (v === null) return old;
        if (hi >= i && v.items.length < hi - i + 1) throw K.err(S.arraySubscript, 'source array too small');
        for (let k = i; k <= hi; k++) { const at = k - lower; while (items.length <= at) items.push(null); items[at] = v.items[k - i] === undefined ? null : v.items[k - i]; }
        return new K.ArrayV(items, lower);
      }
      if (!items.length) lower = i;
      if (i < lower) { for (let k = i; k < lower; k++) items.unshift(null); lower = i; }
      const at = i - lower;
      while (items.length <= at) items.push(null);
      items[at] = v;
      return new K.ArrayV(items, lower);
    }
    generate(n, vals, ctx) { if (n.generated) n.generated.forEach((g, a) => { if (g) vals[a] = g.f(vals, ctx); }); }
    rlsCheck(n, vals, ctx) {
      const f = this.db.tableExpr(ctx.session, n.rel, n.rlsCheck, 'policy', { bool: true });
      if (f(vals, ctx) !== true) throw K.err(S.insufficientPrivilege, 'new row violates row-level security policy for table "' + n.rel.name + '"');
    }
    checkOption(n, vals, ctx) {
      const f = this.db.tableExpr(ctx.session, n.rel, n.check, 'view check', { bool: true });
      if (f(vals, ctx) !== true) throw K.err(S.withCheckOptionViolation || '44000', 'new row violates check option for view "' + n.view.name + '"', { detail: 'Failing row contains (' + this.rowText(n.rel, vals, ctx) + ').' });
    }
    /** ON CONFLICT: before inserting, look for a row with the same key in the arbiter indexes */
    conflictRunner(n, ctx) {
      const rel = n.rel, c = n.conflict, cat = this.db.catalogOf(ctx);
      const idxs = (c.arbiter || cat.indexesOf(rel).filter((ix) => ix.unique).map((ix) => ix.oid)).map((o) => cat.rel(o));
      const sets = c.sets ? c.sets.map((s) => ({ attnum: s.attnum, f: s.e.k === 'default' ? null : K.Expr.compile(s.e, c.layout) })) : null;
      const where = c.where ? K.Expr.compile(c.where, c.layout) : null;
      const self = this;
      return function* (vals, touched) {
        for (let tries = 0; tries < 100; tries++) {
          let hit = null;
          for (const ix of idxs) { const r = yield* self.checkUnique(rel, ix, vals, null, ctx, false, true); if (r) { hit = r; break; } }
          if (!hit) return { done: false };
          if (c.action === 'nothing') return { done: true };
          const p = yield* self.db.cc.prepareModify(rel, hit, ctx, 'update');
          if (p === false || p.gone && !p.self) continue;
          if (p.gone && p.self || touched.has(tkey(hit))) throw K.err(S.cardinality, 'ON CONFLICT DO UPDATE command cannot affect row a second time', { hint: 'Ensure that no rows proposed for insertion within the same command have duplicate constrained values.' });
          if (p.moved) continue;
          const t = self.db.heap(rel).fetch(hit);
          const old = K.Tuple.deform(t.bytes, rel.cols, ctx);
          self.db.buffers.unpin(t.frame, false);
          const both = old.concat(vals);
          if (where && where(both, ctx) !== true) return { done: true };
          const nv = old.slice();
          for (const s of sets) nv[s.attnum] = s.f ? s.f(both, ctx) : null;
          self.generate(n, nv, ctx);
          const nt = yield* self.updateRow(rel, hit, old, nv, ctx);
          touched.add(tkey(nt));
          return { done: true, row: nv };
        }
        throw K.err(S.internal, 'ON CONFLICT retried too often');
      };
    }

    // ---- one row ----------------------------------------------------------------------------------------------------------
    rowText(rel, vals, ctx) { return rel.cols.map((c, i) => (c.dropped ? null : vals[i] === null || vals[i] === undefined ? 'null' : T().output(vals[i], c.type, ctx))).filter((x) => x !== null).join(', '); }
    /** NOT NULL and CHECK constraints on a row about to be stored */
    checkRow(rel, vals, ctx) {
      for (let a = 0; a < rel.cols.length; a++) {
        const c = rel.cols[a];
        if (c.dropped) continue;
        if ((c.notNull || (c.type.domain && c.type.notNull)) && (vals[a] === null || vals[a] === undefined)) throw K.err(S.notNullViolation, 'null value in column "' + c.name + '" of relation "' + rel.name + '" violates not-null constraint', { detail: 'Failing row contains (' + this.rowText(rel, vals, ctx) + ').', table: rel.name, column: c.name });
      }
      for (const k of rel.constraints) {
        if (k.kind !== 'check') continue;
        const f = this.db.tableExpr(ctx.session, rel, k.expr, 'check constraint', { bool: true });
        if (f(vals, ctx) === false) throw K.err(S.checkViolation, 'new row for relation "' + rel.name + '" violates check constraint "' + k.name + '"', { detail: 'Failing row contains (' + this.rowText(rel, vals, ctx) + ').', table: rel.name, constraint: k.name });
      }
    }
    indexWants(idx, vals, ctx, s) {
      if (!idx.where) return true;
      const rel = this.db.catalogOf(ctx).rel(idx.table);
      return this.db.tableExpr(s || ctx.session, rel, idx.where, 'index predicate', { bool: true })(vals, ctx) === true;
    }
    /** store a new row: the heap tuple, then an entry in every index (unique ones checked) */
    *insertRow(rel, vals, ctx, opts) {
      opts = opts || {};
      while (vals.length < rel.cols.length) vals.push(null);
      if (!opts.skipChecks) this.checkRow(rel, vals, ctx);
      const xid = this.db.writeXid(ctx);
      const bytes = K.Tuple.form(vals, rel.cols, xid, ctx.tx.cid);
      if (this.db.protocol && this.db.protocol.onInsert) yield* this.db.protocol.onInsert(rel, vals, ctx);
      const tid = this.db.heap(rel).insert(bytes, { xid });
      this.db.noteLive(rel, 1);
      if (ctx.tx.isolation === 'serializable' && K.SSI && K.SSI.onInsert) yield* K.SSI.onInsert(this.db, rel, tid, vals, ctx);
      yield* this.indexInsert(rel, vals, tid, ctx, null);
      if (!opts.skipChecks) this.queueForeign(rel, null, vals, ctx, tid);
      return tid;
    }
    *indexInsert(rel, vals, tid, ctx, oldVals) {
      const cat = this.db.catalogOf(ctx);
      for (const ix of cat.indexesOf(rel)) {
        if (!this.indexWants(ix, vals, ctx)) continue;
        const am = this.db.indexAm(ix, cat);
        const con = ix.unique && rel.constraints.find((c) => c.index === ix.oid);
        // a deferrable unique constraint is checked at the end of the statement (or at COMMIT), not row by row
        if (con && con.deferrable) { if (yield* this.checkUnique(rel, ix, vals, tid, ctx, false, true)) this.after(ctx, this.deferredNow(con, ctx.tx), { kind: 'unique', rel, ix, vals, tid }); }
        else if (ix.unique) yield* this.checkUnique(rel, ix, vals, tid, ctx);
        am.insert(vals, tid, ctx);
        void oldVals;
      }
    }
    *deleteRow(rel, tid, old, ctx) {
      this.db.cc.markDeleted(rel, tid, ctx, null);
      this.db.noteLive(rel, -1);
      this.queueReferenced(rel, old, null, ctx);
    }
    *updateRow(rel, tid, old, vals, ctx) {
      while (vals.length < rel.cols.length) vals.push(null);
      this.checkRow(rel, vals, ctx);
      const xid = this.db.writeXid(ctx);
      const bytes = K.Tuple.form(vals, rel.cols, xid, ctx.tx.cid);
      const heap = this.db.heap(rel);
      const nt = heap.insert(bytes, { xid });
      this.db.cc.markDeleted(rel, tid, ctx, nt);
      yield* this.indexInsert(rel, vals, nt, ctx, old);
      this.queueForeign(rel, old, vals, ctx, nt);
      this.queueReferenced(rel, old, vals, ctx);
      return nt;
    }

    // ---- unique keys ----------------------------------------------------------------------------------------------------
    /**
     * is there another live row with this key? A row some other running transaction inserted or is deleting
     * might or might not count, so we wait for that transaction (PostgreSQL does the same).
     * Returns the TID of a conflicting row when probing (ON CONFLICT), or throws a unique violation.
     */
    *checkUnique(rel, ix, vals, tid, ctx, building, probe) {
      const am = this.db.indexAm(ix, this.db.catalogOf(ctx));
      const key = am.keyOf(vals, ctx);
      if (ix.nullsDistinct !== false && key.some((v) => v === null)) return null;
      const heap = this.db.heap(rel);
      for (;;) {
        let waitFor = 0, hit = null;
        for (const e of am.find(key)) {
          if (tid && e.b === tid.b && e.o === tid.o) continue;
          const t = heap.fetch(e);
          if (!t) continue;
          const h = K.Tuple.header(t.bytes);
          this.db.buffers.unpin(t.frame, false);
          const st = this.liveness(h, ctx);
          if (st === 'dead') continue;
          if (st.wait) { waitFor = st.wait; break; }
          hit = { b: e.b, o: e.o };
          break;
        }
        if (waitFor) { yield* this.db.cc.waitXid(waitFor, ctx, 'a row with the same key in ' + ix.name); continue; }
        if (!hit) return null;
        if (probe) return hit;
        const cols = ix.keys.map((k) => (k.attnum !== undefined ? rel.cols[k.attnum].name : k.name));
        const text = key.map((v, i) => (v === null ? 'null' : T().output(v, ix.keyTypes[i], ctx))).join(', ');
        if (building) throw K.err(S.uniqueViolation, 'could not create unique index "' + ix.name + '"', { detail: 'Key (' + cols.join(', ') + ')=(' + text + ') is duplicated.' });
        throw K.err(S.uniqueViolation, 'duplicate key value violates unique constraint "' + ix.name + '"', { detail: 'Key (' + cols.join(', ') + ')=(' + text + ') already exists.', table: rel.name, constraint: ix.name });
      }
    }
    /** whether a version counts for uniqueness: 'dead', 'live', or { wait: xid } when its fate is open */
    liveness(h, ctx) {
      const x = this.db.xact, mine = (xid) => ctx.tx.xids.has(xid) && !x.aborted(xid);
      if (h.infomask & IM().XMIN_INVALID || x.aborted(h.xmin)) return 'dead';
      if (!mine(h.xmin) && x.inProgress(h.xmin)) return { wait: x.top(h.xmin) };
      const xmax = h.xmax && !(h.infomask & IM().XMAX_INVALID) && !(h.infomask & IM().XMAX_LOCK_ONLY) ? h.xmax : 0;
      if (!xmax || x.aborted(xmax)) return 'live';
      if (mine(xmax)) return 'dead';
      if (x.inProgress(xmax)) return { wait: x.top(xmax) };
      return 'dead';
    }

    // ---- foreign keys -------------------------------------------------------------------------------------------------------
    /** a referencing row was inserted or its key changed: the referenced row must exist (checked at the end of the statement) */
    queueForeign(rel, old, vals, ctx, tid) {
      for (const c of rel.constraints) {
        if (c.kind !== 'foreign') continue;
        const key = c.cols.map((a) => vals[a]);
        if (old && c.cols.every((a) => (old[a] === null && vals[a] === null) || (old[a] !== null && vals[a] !== null && T().compare(old[a], vals[a], rel.cols[a].type) === 0))) continue;
        if (key.every((v) => v === null)) continue;
        if (key.some((v) => v === null)) {
          if (c.match === 'full') throw K.err(S.foreignKeyViolation, 'insert or update on table "' + rel.name + '" violates foreign key constraint "' + c.name + '"', { detail: 'MATCH FULL does not allow mixing of null and nonnull key values.' });
          continue;
        }
        this.after(ctx, this.deferredNow(c, ctx.tx), { kind: 'fk', rel, c, key, tid });
      }
    }
    /** a referenced row was deleted or its key changed: act on the rows that reference it */
    queueReferenced(rel, old, vals, ctx) {
      if (!rel.referencedBy || !rel.referencedBy.length) return;
      const cat = this.db.catalogOf(ctx);
      for (const r of rel.referencedBy) {
        const child = cat.rel(r.rel);
        const c = child && child.constraints.find((x) => x.name === r.name);
        if (!c) continue;
        const key = c.refCols.map((a) => old[a]);
        if (key.some((v) => v === null)) continue;
        if (vals && c.refCols.every((a) => vals[a] !== null && T().compare(old[a], vals[a], rel.cols[a].type) === 0)) continue;
        const action = vals ? c.onUpdate : c.onDelete;
        this.after(ctx, action === 'no action' && this.deferredNow(c, ctx.tx), { kind: 'ref', rel, child, c, key, newKey: vals ? c.refCols.map((a) => vals[a]) : null, action });
      }
    }
    stillLive(rel, tid, ctx) {
      const t = this.db.heap(rel).fetch(tid);
      if (!t) return false;
      const h = K.Tuple.header(t.bytes);
      this.db.buffers.unpin(t.frame, false);
      return this.liveness(h, ctx) === 'live';
    }
    /** is a constraint deferred now: its declaration, overridden by SET CONSTRAINTS in this transaction */
    deferredNow(c, tx) {
      if (!c.deferrable) return false;
      const m = tx && tx.conModes;
      if (m && m.names.has(c.name)) return m.names.get(c.name) === 'deferred';
      if (m && m.all) return m.all === 'deferred';
      return !!c.deferred;
    }
    after(ctx, deferred, ev) {
      if (deferred) { (ctx.tx.deferred || (ctx.tx.deferred = [])).push(ev); return; }
      (ctx.afterQueue || (ctx.afterQueue = [])).push(ev);
    }
    /** run the queued foreign key checks and actions (at the end of a statement, or at COMMIT for deferred ones) */
    *runAfter(ctx, list) {
      const q = list || ctx.afterQueue || [];
      // walk the queue by position (it may grow as actions cascade); what was handled is removed at the end
      let i = 0;
      try {
        while (i < q.length) yield* this.afterEvent(q[i++], ctx, q);
      } finally { q.splice(0, i); }
    }
    *afterEvent(ev, ctx, q) {
      // only if the row is still there (a later change in the transaction may have replaced or removed it)
      if (ev.tid && (ev.kind === 'unique' || ev.kind === 'fk') && !this.stillLive(ev.rel, ev.tid, ctx)) return;
      if (ev.kind === 'unique') { yield* this.checkUnique(ev.rel, ev.ix, ev.vals, ev.tid, ctx); return; }
      if (ev.kind === 'fk') {
        const cat = this.db.catalogOf(ctx);
        const ref = cat.rel(ev.c.refRel);
        const found = yield* this.findKey(ref, ev.c.refIndex, ev.c.refCols, ev.key, ctx);
        if (!found) throw K.err(S.foreignKeyViolation, 'insert or update on table "' + ev.rel.name + '" violates foreign key constraint "' + ev.c.name + '"', { detail: 'Key (' + ev.c.cols.map((a) => ev.rel.cols[a].name).join(', ') + ')=(' + ev.key.map((v, i) => T().output(v, ev.rel.cols[ev.c.cols[i]].type, ctx)).join(', ') + ') is not present in table "' + ref.name + '".', table: ev.rel.name, constraint: ev.c.name });
        return;
      }
      yield* this.refAction(ev, ctx, q);
    }
    /** a referenced key went away: NO ACTION / RESTRICT fail if rows still use it; CASCADE, SET NULL, SET DEFAULT change them */
    *refAction(ev, ctx, q) {
      const { rel, child, c, key, action } = ev;
      // NO ACTION allows the key to come back in the same statement
      if (action === 'no action' && (yield* this.findKey(rel, null, c.refCols, key, ctx, true))) return;
      const users = [];
      for (const row of this.db.visibleRows(child, ctx)) if (c.cols.every((a, i) => row.vals[a] !== null && T().compare(row.vals[a], key[i], child.cols[a].type) === 0)) users.push(row);
      if (!users.length) return;
      if (action === 'no action' || action === 'restrict') {
        throw K.err(S.foreignKeyViolation, 'update or delete on table "' + rel.name + '" violates foreign key constraint "' + c.name + '" on table "' + child.name + '"', { detail: 'Key (' + c.refCols.map((a) => rel.cols[a].name).join(', ') + ')=(' + key.map((v, i) => T().output(v, rel.cols[c.refCols[i]].type, ctx)).join(', ') + ') is still referenced from table "' + child.name + '".', table: child.name, constraint: c.name });
      }
      ctx.bus.emit('dml.cascade', { from: rel.name, to: child.name, action, rows: users.length });
      const saved = ctx.afterQueue;
      ctx.afterQueue = q;
      for (const u of users) {
        const p = yield* this.db.cc.prepareModify(child, u.tid, ctx, 'update');
        if (p === false || p.gone || p.moved) continue;
        if (action === 'cascade' && !ev.newKey) { yield* this.deleteRow(child, u.tid, u.vals, ctx); continue; }
        const nv = u.vals.slice();
        if (action === 'cascade') c.cols.forEach((a, i) => { nv[a] = ev.newKey[i]; });
        else if (action === 'set null') (!ev.newKey && c.setCols || c.cols).forEach((a) => { nv[a] = null; });
        else if (action === 'set default') { const b = new K.Binder(ctx.session); const defs = this.bindDefaults(b, child); (!ev.newKey && c.setCols || c.cols).forEach((a) => { nv[a] = defs[a] ? K.Expr.compile(defs[a], new Map())([], ctx) : null; }); }
        yield* this.updateRow(child, u.tid, u.vals, nv, ctx);
        // the default may be the very key that went away: check it even when the row did not change
        if (action === 'set default' && c.cols.every((a) => nv[a] !== null)) q.push({ kind: 'fk', rel: child, c, key: c.cols.map((a) => nv[a]) });
      }
      ctx.afterQueue = saved;
    }
    /** does a row with this key exist (visible to this transaction now)? Locks it FOR KEY SHARE so it cannot vanish */
    *findKey(rel, indexOid, cols, key, ctx, noLock) {
      const cat = this.db.catalogOf(ctx);
      const ix = indexOid ? cat.rel(indexOid) : cat.indexesOf(rel).find((x) => x.unique && x.keys.length === cols.length && x.keys.every((k) => cols.includes(k.attnum)));
      const snap = this.db.xact.snapshot(ctx.tx.xid || null);
      const vctx = Object.assign({}, ctx, { snap, tx: Object.assign(Object.create(Object.getPrototypeOf(ctx.tx)), ctx.tx, { cid: Infinity }) });
      const heap = this.db.heap(rel);
      const test = (vals) => cols.every((a, i) => vals[a] !== null && T().compare(vals[a], key[i], rel.cols[a].type) === 0);
      const cand = [];
      if (ix) {
        const am = this.db.indexAm(ix, cat);
        const ikey = ix.keys.map((k) => key[cols.indexOf(k.attnum)]);
        for (const e of am.find(ikey)) cand.push({ b: e.b, o: e.o });
      } else for (const r of heap.scan()) cand.push(r.tid);
      for (const tid of cand) {
        const t = heap.fetch(tid);
        if (!t) continue;
        const h = K.Tuple.header(t.bytes);
        const vals = K.Tuple.deform(t.bytes, rel.cols, ctx);
        this.db.buffers.unpin(t.frame, false);
        if (!this.db.xact.satisfies(h, vctx.tx, snap).visible || !test(vals)) continue;
        if (noLock) return true;
        const ok = yield* this.db.cc.lockRow(rel, tid, { mode: 'key share' }, ctx);
        if (ok) return true;
      }
      return false;
    }
  }

  K.DML = DML;
})(typeof window !== 'undefined' ? window : globalThis);
