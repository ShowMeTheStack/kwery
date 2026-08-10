// Translations between relational algebra and SQL.
//   toSQL(program, src, { bag })  -> { sql, notes }: runnable SQL whose result equals the algebra's (as a set, or
//                                    as a bag with { bag: true })
//   fromSQL(sql, session, { bag }) -> { program, text, ascii, tree, notes, exact }: the algebra of a query, read from
//                                    the binder's logical plan; subqueries in WHERE become semijoins and antijoins
(function (root) {
  'use strict';
  const K = root.K;
  const A = K.Algebra;
  const SYNTAX = '42601';
  const failc = (code, msg, pos, extra) => { throw K.err(code, msg, Object.assign({ pos }, extra || {})); };

  // ---- algebra -> SQL ----------------------------------------------------------------------------------------------
  const q = A.quoteSql;
  const sqlLit = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? (v < 0 ? '(' + v + ')' : String(v)) : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : '\'' + String(v).replace(/'/g, '\'\'') + '\'');
  const SQLPREC = { or: 1, and: 2, not: 3, cmp: 4, isnull: 4, like: 4, '+': 5, '-': 5, '||': 5, '*': 6, '/': 6, '%': 6, neg: 7 };
  /** a scalar expression in SQL; attrs carry the SQL expression of each attribute (a.sql) */
  function scalarSQL(e, attrs, where, parent) {
    const t = (x, p) => scalarSQL(x, attrs, where, p);
    let s, p;
    switch (e.k) {
      case 'lit': return sqlLit(e.v);
      case 'attr': return attrs[A.resolve(attrs, e, where)].sql;
      case 'and': case 'or': p = SQLPREC[e.k]; s = e.items.map((x) => t(x, p + 1)).join(e.k === 'and' ? ' AND ' : ' OR '); break;
      case 'not': p = SQLPREC.not; s = 'NOT ' + t(e.e, p); break;
      case 'cmp': p = SQLPREC.cmp; s = t(e.l, p + 1) + ' ' + e.op + ' ' + t(e.r, p + 1); break;
      case 'isnull': p = SQLPREC.isnull; s = t(e.e, p + 1) + (e.neg ? ' IS NOT NULL' : ' IS NULL'); break;
      case 'like': p = SQLPREC.like; s = t(e.e, p + 1) + (e.neg ? ' NOT LIKE ' : ' LIKE ') + t(e.pat, p + 1); break;
      case 'arith': p = SQLPREC[e.op]; s = t(e.l, p) + ' ' + e.op + ' ' + t(e.r, p + 1); break;
      case 'neg': p = SQLPREC.neg; s = '-' + t(e.e, p); break;
      case 'fn': {
        if (e.op === '||') { p = SQLPREC['||']; s = t(e.args[0], p) + ' || ' + t(e.args[1], p + 1); break; }
        const name = e.name === 'substr' ? 'substring' : e.name;
        if (name === 'substring') return 'substring(' + t(e.args[0], 0) + ' FROM ' + t(e.args[1], 0) + (e.args[2] ? ' FOR ' + t(e.args[2], 0) : '') + ')';
        return name + '(' + e.args.map((x) => t(x, 0)).join(', ') + ')';
      }
      default: failc(SYNTAX, 'cannot translate this expression to SQL', e.pos);
    }
    return parent !== undefined && p < parent ? '(' + s + ')' : s;
  }
  const aggSQL = (a, attrs) => a.fn + '(' + (a.distinct ? 'DISTINCT ' : '') + (a.arg ? scalarSQL(a.arg, attrs, 'γ') : '*') + ')';

  /**
   * Translate a program (text or AST) to SQL. src gives the schemas of the base relations (a session or a map).
   * Each operator becomes part of a SELECT block; blocks are merged where SQL allows (σ, π, ×, ⋈ into one
   * SELECT ... FROM ... WHERE) and wrapped as subqueries elsewhere. Base tables are assumed to be sets (true for
   * every table with a primary key); the outermost SELECT is DISTINCT under set semantics.
   */
  function toSQL(input, src, opts) {
    opts = opts || {};
    const bag = !!opts.bag;
    const prog = typeof input === 'string' ? A.parse(input) : input.stmts ? input : { stmts: [], result: input };
    const get = A.source(src);
    const notes = [];
    const used = new Map();
    const alias = (base) => { const b = String(base).replace(/[^a-z0-9_]/gi, '_').toLowerCase() || 't'; const n = (used.get(b) || 0) + 1; used.set(b, n); return n === 1 && !/^t\d+$/.test(b) && q(b) === b ? b : b + '_' + n; };
    const ctes = new Map();     // variable -> { names (SQL column names), attrs }
    const withs = [];
    const sattr = (name, quals, sql) => ({ name, quals, sql });
    const outNames = (attrs) => {
      const names = A.displayNames(attrs).map((x) => x.replace(/\./g, '_'));
      const seen = new Map();
      return names.map((x) => { const k = seen.get(x) || 0; seen.set(x, k + 1); return k ? x + '_' + (k + 1) : x; });
    };
    // a block: { from: [items], where: [conds], attrs, distinct, group, order }
    const spj = (b) => !b.group && !b.wrapped;
    const query = (b, opt) => {
      opt = opt || {};
      const names = opt.names || outNames(b.attrs);
      const sel = b.attrs.map((a, i) => (a.sql === q(names[i]) || a.sql.endsWith('.' + q(names[i])) ? a.sql : a.sql + ' AS ' + q(names[i])));
      let s = 'SELECT ' + (b.distinct || ((opt.top || b.projected) && !bag) ? 'DISTINCT ' : '') + sel.join(', ') + '\nFROM ' + b.from.join(', ');
      if (b.where.length) s += '\nWHERE ' + b.where.join('\n  AND ');
      if (b.groupBy && b.groupBy.length) s += '\nGROUP BY ' + b.groupBy.join(', ');
      if (opt.order && opt.order.length) s += '\nORDER BY ' + opt.order.join(', ');
      return { sql: s, names };
    };
    const indent = (s) => s.split('\n').join('\n  ');
    const wrap = (sqlText, names, attrs, hint) => {
      const t = alias(hint || 't');
      return { from: ['(\n  ' + indent(sqlText) + '\n) AS ' + t], where: [], attrs: attrs.map((a, i) => sattr(a.name, a.quals.slice(), t + '.' + q(names[i]))) };
    };
    const asWrapped = (b, hint) => { const r = query(b); return wrap(r.sql, r.names, b.attrs, hint); };
    // a block usable as one FROM item (for outer joins)
    const single = (b) => (b.from.length === 1 && !b.where.length && spj(b) && !b.distinct && !(b.projected && !bag) ? b : asWrapped(b));
    const condSQL = (c, attrs, where) => scalarSQL(c, attrs, where, SQLPREC.and + 1);

    const gen = (n) => {
      switch (n.op) {
        case 'rel': {
          if (ctes.has(n.name)) {
            const c = ctes.get(n.name);
            const t = alias(n.name);
            return { from: [q(n.name) + (t === n.name ? '' : ' AS ' + t)], where: [], attrs: c.attrs.map((a, i) => sattr(a.name, [n.name], t + '.' + q(c.names[i]))) };
          }
          const r = get(n.name);
          if (!r) failc('42P01', 'relation "' + n.name + '" does not exist', n.pos);
          const t = alias(n.name);
          return { from: [q(n.name) + (t === n.name ? '' : ' AS ' + t)], where: [], attrs: r.attrs.map((a) => sattr(a, [n.name], t + '.' + q(a))) };
        }
        case 'const': {
          const t = alias('v');
          const names = n.rows[0].map((_, i) => 'column' + (i + 1));
          return { from: ['(VALUES ' + n.rows.map((r) => '(' + r.map(sqlLit).join(', ') + ')').join(', ') + ') AS ' + t + '(' + names.join(', ') + ')'], where: [], attrs: names.map((x) => sattr(x, [], t + '.' + x)) };
        }
        case 'select': {
          let b = gen(n.child);
          if (!spj(b)) b = asWrapped(b);
          b.where.push(condSQL(n.cond, b.attrs, 'σ'));
          return b;
        }
        case 'project': {
          let b = gen(n.child);
          if (!spj(b)) b = asWrapped(b);
          const attrs = n.items.map((it) => {
            const sql = scalarSQL(it.e, b.attrs, 'π');
            if (!it.as && it.e.k === 'attr') { const a = b.attrs[A.resolve(b.attrs, it.e, 'π')]; return sattr(a.name, a.quals.slice(), sql); }
            return sattr(it.as || A.itemName(it.e), [], sql.includes(' ') ? '(' + sql + ')' : sql);
          });
          // σ above a projection still reads the underlying columns, so the block stays mergeable
          return Object.assign({}, b, { attrs, projected: true });
        }
        case 'rename': {
          const b = gen(n.child);
          let attrs;
          if (n.map) { attrs = b.attrs.map((a) => sattr(a.name, a.quals.slice(), a.sql)); for (const m of n.map) attrs[A.resolve(attrs, { parts: [m.from], pos: m.pos }, 'ρ')].name = m.to; }
          else {
            if (n.attrs && n.attrs.length !== b.attrs.length) failc(SYNTAX, 'ρ[' + n.rel + '(…)] names ' + n.attrs.length + ' attributes but its operand has ' + b.attrs.length, n.pos);
            attrs = b.attrs.map((a, i) => sattr(n.attrs ? n.attrs[i] : a.name, [n.rel], a.sql));
          }
          return Object.assign({}, b, { attrs });
        }
        case 'distinct': {
          const b = gen(n.child);
          if (!bag) return b;
          const r = query(Object.assign({}, b, { distinct: true }));
          return wrap(r.sql, r.names, b.attrs);
        }
        case 'sort': {
          const b = gen(n.child);
          // ORDER BY only matters at the top; τ below another operator has no effect on a relation
          b.order = n.keys.map((k) => scalarSQL(k.e, b.attrs, 'τ') + (k.dir === 'desc' ? ' DESC' : ''));
          b.orderKeys = n.keys;
          return b;
        }
        case 'group': {
          let b = gen(n.child);
          if (!spj(b) || b.distinct) b = asWrapped(b);
          // under set semantics the input of γ is a set: a projection below it must remove duplicates first
          if (!bag && b.projected) b = asWrapped(b);
          const gattrs = n.groups.map((g) => b.attrs[A.resolve(b.attrs, g, 'γ')]);
          const outs = gattrs.map((a) => sattr(a.name, a.quals.slice(), a.sql)).concat(n.aggs.map((a) => sattr(A.aggName(a), [], aggSQL(a, b.attrs))));
          const r = query(Object.assign({}, b, { attrs: outs, groupBy: gattrs.map((a) => a.sql) }));
          return Object.assign(wrap(r.sql, r.names, outs, 'g'), { wrapped: true });
        }
        case 'union': case 'minus': case 'intersect': {
          const l = gen(n.left), r = gen(n.right);
          if (l.attrs.length !== r.attrs.length) A.schemaOf(n, get, schemaEnv());
          const ql = query(l), qr = query(r, { names: outNames(l.attrs) });
          const kw = { union: 'UNION', minus: 'EXCEPT', intersect: 'INTERSECT' }[n.op] + (bag ? ' ALL' : '');
          return wrap(ql.sql + '\n' + kw + '\n' + qr.sql, ql.names, l.attrs.map((a) => ({ name: a.name, quals: a.quals.slice() })), { union: 'un', minus: 'diff', intersect: 'isect' }[n.op]);
        }
        case 'product': {
          const l = gen(n.left), r = gen(n.right);
          return merge(l, r);
        }
        case 'join': case 'ljoin': case 'rjoin': case 'fjoin': {
          const l = gen(n.left), r = gen(n.right);
          if (n.op === 'join') {
            const m = merge(l, r);
            if (n.cond) { m.where.push(condSQL(n.cond, m.attrs, 'the join condition')); return m; }
            const names = A.common(l.attrs, r.attrs, n, 'natural join');
            const out = [];
            for (const nm of names) {
              const a = m.attrs.find((x, i) => i < l.attrs.length && x.name === nm), b = m.attrs.find((x, i) => i >= l.attrs.length && x.name === nm);
              m.where.push(a.sql + ' = ' + b.sql);
              out.push(sattr(nm, a.quals.concat(b.quals.filter((x) => !a.quals.includes(x))), a.sql));
            }
            m.attrs = out.concat(m.attrs.filter((x, i) => !names.includes(x.name) || false).filter((x) => !names.includes(x.name)));
            return m;
          }
          const L = single(l), R = single(r);
          const all = L.attrs.concat(R.attrs);
          const kw = { ljoin: 'LEFT JOIN', rjoin: 'RIGHT JOIN', fjoin: 'FULL JOIN' }[n.op];
          let on, attrs;
          if (n.cond) { on = scalarSQL(n.cond, all, 'the join condition'); attrs = all; }
          else {
            const names = A.common(L.attrs, R.attrs, n, 'natural join');
            on = names.map((nm) => L.attrs.find((x) => x.name === nm).sql + ' = ' + R.attrs.find((x) => x.name === nm).sql).join(' AND ') || 'TRUE';
            attrs = names.map((nm) => {
              const a = L.attrs.find((x) => x.name === nm), b = R.attrs.find((x) => x.name === nm);
              const sql = n.op === 'ljoin' ? a.sql : n.op === 'rjoin' ? b.sql : 'COALESCE(' + a.sql + ', ' + b.sql + ')';
              return sattr(nm, a.quals.concat(b.quals.filter((x) => !a.quals.includes(x))), sql);
            }).concat(L.attrs.filter((x) => !names.includes(x.name)), R.attrs.filter((x) => !names.includes(x.name)));
          }
          return { from: [L.from[0] + '\n  ' + kw + ' ' + R.from[0] + ' ON ' + on], where: [], attrs };
        }
        case 'semijoin': case 'antijoin': {
          let l = gen(n.left);
          if (!spj(l)) l = asWrapped(l);
          let r = gen(n.right);
          if (!spj(r)) r = asWrapped(r);
          const all = l.attrs.concat(r.attrs), lw = l.attrs.length;
          // equalities between the sides become (x, y) IN (SELECT ...), which needs no correlation; conditions on the
          // right side alone go into that subquery; anything else needs a correlated EXISTS
          const pairs = [], rightOnly = [], rest = [];
          if (n.cond) {
            for (const c of n.cond.k === 'and' ? n.cond.items : [n.cond]) {
              const side = (e) => { const out = new Set(); const w = (x) => { if (!x || typeof x !== 'object') return; if (x.k === 'attr') { out.add(A.resolve(all, x) < lw ? 'l' : 'r'); return; } for (const k in x) if (k !== 'pos') w(x[k]); }; w(e); return out; };
              if (c.k === 'cmp' && c.op === '=' && c.l.k === 'attr' && c.r.k === 'attr') {
                const i = A.resolve(all, c.l), j = A.resolve(all, c.r);
                if (i < lw && j >= lw) { pairs.push([all[i].sql, all[j].sql]); continue; }
                if (j < lw && i >= lw) { pairs.push([all[j].sql, all[i].sql]); continue; }
              }
              const sd = side(c);
              if (!sd.has('l')) rightOnly.push(condSQL(c, all, 'the join condition')); else rest.push(c);
            }
          } else {
            for (const nm of A.common(l.attrs, r.attrs, n, n.op)) pairs.push([l.attrs.find((x) => x.name === nm).sql, r.attrs.find((x) => x.name === nm).sql]);
          }
          const tup = (xs) => (xs.length === 1 ? xs[0] : '(' + xs.join(', ') + ')');
          if (pairs.length && !rest.length) {
            const anti = n.op === 'antijoin';
            const where = r.where.concat(rightOnly, anti ? pairs.map((p) => p[1] + ' IS NOT NULL') : []);
            const sub = 'SELECT ' + pairs.map((p) => p[1]).join(', ') + ' FROM ' + r.from.join(', ') + (where.length ? ' WHERE ' + where.join(' AND ') : '');
            const test = tup(pairs.map((p) => p[0])) + ' IN (\n    ' + sub.split('\n').join('\n    ') + ')';
            // NOT IN is never true when a NULL is involved, so the antijoin keeps NULL keys explicitly
            l.where.push(anti ? 'NOT (' + pairs.map((p) => p[0] + ' IS NOT NULL').concat([test]).join(' AND ') + ')' : test);
            return l;
          }
          const conds = pairs.map((p) => p[0] + ' = ' + p[1]).concat(rightOnly, rest.map((c) => condSQL(c, all, 'the join condition')));
          const sub = 'SELECT 1 FROM ' + r.from.join(', ') + (r.where.concat(conds).length ? ' WHERE ' + r.where.concat(conds).join(' AND ') : '');
          l.where.push((n.op === 'antijoin' ? 'NOT ' : '') + 'EXISTS (\n    ' + sub.split('\n').join('\n    ') + ')');
          return l;
        }
        case 'divide': {
          // the definition: r ÷ s = π(R−S)(r) − π(R−S)((π(R−S)(r) × s) − r), with EXCEPT (which, like the
          // algebra, treats NULLs as equal)
          const r1 = gen(n.left), s1 = gen(n.right);
          const rq = query(r1);
          const sNames = s1.attrs.map((a) => a.name);
          const xi = r1.attrs.map((a, i) => i).filter((i) => !sNames.includes(r1.attrs[i].name));
          const yi = s1.attrs.map((b) => r1.attrs.findIndex((a) => a.name === b.name));
          const sq = query(s1, { names: yi.map((i) => rq.names[i]) });
          const X = xi.map((i) => q(rq.names[i])), Y = yi.map((i) => q(rq.names[i]));
          const ind = (x) => indent(indent(x));
          const pa = alias('a'), pb = alias('b'), d1 = alias('d'), d2 = alias('d'), d3 = alias('d'), m = alias('m');
          const sql = 'SELECT ' + X.join(', ') + ' FROM (\n  ' + indent(rq.sql) + '\n) AS ' + d1 +
            '\nEXCEPT\nSELECT ' + X.join(', ') + ' FROM (\n  SELECT ' + X.map((x) => pa + '.' + x).concat(Y.map((y) => pb + '.' + y)).join(', ') +
            '\n  FROM (SELECT DISTINCT ' + X.join(', ') + ' FROM (\n      ' + ind(indent(rq.sql)) + '\n    ) AS ' + d2 + ') AS ' + pa + '\n  CROSS JOIN (\n    ' + ind(sq.sql) + '\n  ) AS ' + pb +
            '\n  EXCEPT\n  SELECT ' + X.concat(Y).join(', ') + ' FROM (\n    ' + ind(rq.sql) + '\n  ) AS ' + d3 + '\n) AS ' + m;
          return wrap(sql, xi.map((i) => rq.names[i]), xi.map((i) => r1.attrs[i]), 'quot');
        }
      }
      failc(SYNTAX, 'cannot translate ' + n.op + ' to SQL', n.pos);
    };
    const merge = (l, r) => {
      if (!spj(l) || l.distinct) l = asWrapped(l);
      if (!spj(r) || r.distinct) r = asWrapped(r);
      return { from: l.from.concat(r.from), where: l.where.concat(r.where), attrs: l.attrs.concat(r.attrs), projected: l.projected || r.projected };
    };
    const schemaEnv = () => new Map([...ctes].map(([k, v]) => [k, v.attrs]));

    for (const st of prog.stmts) {
      const b = gen(st.expr);
      let attrs = b.attrs.map((a) => ({ name: a.name, quals: a.quals.slice() }));
      if (st.attrs) { if (st.attrs.length !== attrs.length) failc(SYNTAX, st.name + '(…) names ' + st.attrs.length + ' attributes but the expression has ' + attrs.length, st.pos); attrs = st.attrs.map((x) => ({ name: x, quals: [] })); }
      const names = outNames(attrs);
      const r = query(b, { names, top: true });
      withs.push(q(st.name) + '(' + names.map(q).join(', ') + ') AS (\n  ' + indent(r.sql) + '\n)');
      ctes.set(st.name, { names, attrs });
    }
    let body;
    if (prog.result) {
      const b = gen(prog.result);
      body = query(b, { top: true, order: b.order }).sql;
      if (b.order) notes.push('τ is translated to ORDER BY on the outermost query.');
    } else {
      const last = prog.stmts[prog.stmts.length - 1];
      body = 'SELECT * FROM ' + q(last.name);
    }
    const sql = (withs.length ? 'WITH ' + withs.join(',\n') + '\n' : '') + body;
    if (!bag) notes.push('SELECT DISTINCT gives the set semantics of the algebra.');
    return { sql, notes };
  }

  // ---- SQL -> algebra --------------------------------------------------------------------------------------------------
  const V = (v) => (v && typeof v === 'object' && v.toNumber ? v.toNumber() : typeof v === 'bigint' ? Number(v) : v);
  class FromSQL {
    constructor(session, opts) { this.s = session; this.opts = opts || {}; this.notes = []; this.exact = true; this.n = 0; this.stmts = []; this.ctes = new Map(); }
    note(msg, inexact) { if (!this.notes.includes(msg)) this.notes.push(msg); if (inexact) this.exact = false; }
    unsupported(msg) { const e = K.err('0A000', msg); e.unsupported = true; throw e; }
    fresh(base) { this.n++; return (base || 't') + this.n; }

    // a translated subtree: { e (algebra AST), attrs: [{ name, quals, ids: [binder ids] }] }
    tr(n) {
      switch (n.op) {
        case 'Scan': {
          let e = { op: 'rel', name: n.rel.name };
          const quals = [n.alias || n.rel.name];
          if (n.alias && n.alias !== n.rel.name) e = { op: 'rename', rel: n.alias, attrs: null, map: null, child: e };
          const attrs = n.cols.filter((c) => !c.hidden).map((c) => ({ name: c.name, quals: quals.slice(), ids: [c.id] }));
          if (n.sample) this.note('TABLESAMPLE has no counterpart in the algebra; it is ignored.', true);
          return { e, attrs };
        }
        case 'CteScan': {
          if (!this.ctes.has(n.cte.name)) {
            if (n.cte.recursive) this.unsupported('recursive queries (WITH RECURSIVE) go beyond the relational algebra');
            const sub = this.tr(n.cte.plan);
            const st = { name: n.cte.name, attrs: null, expr: sub.e };
            const names = n.cte.cols.map((c) => c.name);
            if (names.some((x, i) => x !== sub.attrs[i].name)) st.attrs = names;
            this.stmts.push(st);
            this.ctes.set(n.cte.name, names);
          }
          const names = this.ctes.get(n.cte.name);
          return { e: { op: 'rel', name: n.cte.name }, attrs: n.cols.map((c, i) => ({ name: names[i], quals: [n.cols[i].table || n.cte.name], ids: [c.id] })), aliasOf: n.cte.name };
        }
        case 'Subquery': {
          if (n.lateral) this.unsupported('LATERAL subqueries have no direct algebra counterpart');
          const c = this.tr(n.children[0]);
          const name = n.cols[0] && n.cols[0].table;
          const vis = c.attrs;
          if (vis.length !== n.cols.length) this.unsupported('a subquery in FROM with hidden columns');
          let e = c.e;
          const renamed = n.cols.some((col, i) => col.name !== vis[i].name);
          if (name) e = { op: 'rename', rel: name, attrs: renamed ? n.cols.map((x) => x.name) : null, map: null, child: e };
          else if (renamed) e = { op: 'rename', rel: this.fresh('s'), attrs: n.cols.map((x) => x.name), map: null, child: e };
          return { e, attrs: n.cols.map((col, i) => ({ name: col.name, quals: name ? [name] : [], ids: vis[i].ids.concat([col.id]) })) };
        }
        case 'Values': {
          const rows = n.tuples.map((t) => t.map((x) => { if (x.k === 'const') return A.plain(x.v, x.type); if (x.k === 'cast' && x.e.k === 'const') return A.plain(x.e.v, x.e.type); this.unsupported('VALUES with expressions'); return null; }));
          return { e: { op: 'const', rows }, attrs: n.cols.map((c, i) => ({ name: 'column' + (i + 1), quals: [], ids: [c.id] })) };
        }
        case 'Filter': return this.filter(n);
        case 'Project': return this.project(n);
        case 'Join': return this.join(n);
        case 'Aggregate': return this.aggregate(n);
        case 'SetOp': {
          const l = this.tr(n.children[0]), r = this.tr(n.children[1]);
          const op = { union: 'union', except: 'minus', intersect: 'intersect' }[n.setop];
          if (n.all && !this.opts.bag) this.note(n.setop.toUpperCase() + ' ALL keeps duplicates; under set semantics the algebra operator removes them.');
          if (!n.all && this.opts.bag) this.note(n.setop.toUpperCase() + ' removes duplicates: δ is applied to the result.');
          let e = { op, left: l.e, right: r.e };
          if (!n.all && this.opts.bag) e = { op: 'distinct', child: e };
          return { e, attrs: n.cols.map((c, i) => ({ name: l.attrs[i].name, quals: l.attrs[i].quals.slice(), ids: [c.id] })) };
        }
        case 'Distinct': {
          if (n.on) this.unsupported('DISTINCT ON picks one row per group in sort order, which the algebra cannot express');
          const c = this.tr(n.children[0]);
          if (this.opts.bag) return { e: { op: 'distinct', child: c.e }, attrs: c.attrs };
          this.distinctSeen = true;
          return c;
        }
        case 'Sort': {
          const c = this.tr(n.children[0]);
          const keys = n.keys.map((k) => ({ e: this.ref(k.id, c.attrs), dir: k.dir }));
          return { e: { op: 'sort', keys, child: c.e }, attrs: c.attrs };
        }
        case 'Limit': {
          this.note('LIMIT/OFFSET has no counterpart in the relational algebra; it is left out, so the results may differ.', true);
          return this.tr(n.children[0]);
        }
        case 'Result': this.unsupported('a SELECT without FROM has no relation to start from');
        // falls through
        case 'Window': this.unsupported('window functions go beyond the relational algebra');
        // falls through
        default: this.unsupported(n.op + ' has no relational algebra counterpart');
      }
    }
    /** an attribute reference for a binder column id: as short as the schema allows */
    ref(id, attrs) {
      const i = attrs.findIndex((a) => a.ids.includes(id));
      if (i < 0) this.unsupported('a column that is not available here (a correlated reference in an unsupported position)');
      return this.refAt(i, attrs);
    }
    refAt(i, attrs) {
      const a = attrs[i];
      if (attrs.filter((b) => b.name === a.name).length === 1) return { k: 'attr', parts: [a.name] };
      const qual = a.quals.find((x) => attrs.filter((b) => b.name === a.name && b.quals.includes(x)).length === 1);
      if (qual) return { k: 'attr', parts: [qual, a.name] };
      const e = K.err('42702', 'ambiguous'); e.ambiguousAt = i; throw e;
    }
    /** rename the right side's relation when its qualifiers clash with the left's */
    distinctQuals(l, r) {
      const clash = r.attrs.some((b) => l.attrs.some((a) => a.name === b.name && a.quals.some((x) => b.quals.includes(x))));
      const internal = r.attrs.some((b, i) => r.attrs.some((c, j) => j !== i && c.name === b.name));
      if (!clash) return r;
      const t = this.fresh('t');
      let names = null;
      if (internal) { const seen = new Map(); names = r.attrs.map((b) => { const k = (seen.get(b.name) || 0) + 1; seen.set(b.name, k); return k > 1 ? b.name + '_' + k : b.name; }); }
      return { e: { op: 'rename', rel: t, attrs: names, map: null, child: r.e }, attrs: r.attrs.map((b, i) => ({ name: names ? names[i] : b.name, quals: [t], ids: b.ids })) };
    }
    /** a bound expression as algebra */
    expr(x, attrs) {
      const r = (y) => this.expr(y, attrs);
      switch (x.k) {
        case 'const': return { k: 'lit', v: A.plain(x.v, x.type) };
        case 'col': if (x.outer) this.unsupported('correlated reference'); return this.ref(x.id, attrs);
        case 'cmp': return { k: 'cmp', op: x.op, l: r(x.l), r: r(x.r) };
        case 'and': case 'or': return { k: x.k, items: x.items.map(r) };
        case 'not': return { k: 'not', e: r(x.e) };
        case 'arith': return { k: 'arith', op: x.op, l: r(x.l), r: r(x.r) };
        case 'neg': return { k: 'neg', e: r(x.e) };
        case 'isnull': return { k: 'isnull', e: r(x.e), neg: !!x.neg };
        case 'istruth': { const e = r(x.e); const t = { k: 'cmp', op: '=', l: e, r: { k: 'lit', v: x.v } }; return x.neg ? { k: 'or', items: [{ k: 'not', e: t }, { k: 'isnull', e, neg: false }] } : t; }
        case 'like': if (x.ci || x.similar || x.esc) this.unsupported('ILIKE, SIMILAR TO and LIKE ... ESCAPE'); return { k: 'like', e: r(x.e), pat: r(x.pat), neg: !!x.neg };
        case 'cast': if (x.explicit) this.note('Casts are left out of the algebra.'); return r(x.e);
        case 'concat': return { k: 'fn', name: 'concat', op: '||', args: [r(x.l), r(x.r)] };
        case 'coalesce': return { k: 'fn', name: 'coalesce', args: x.items.map(r) };
        case 'inlist': { const e = r(x.e); const o = { k: 'or', items: x.items.map((i) => ({ k: 'cmp', op: '=', l: e, r: r(i) })) }; return x.neg ? { k: 'not', e: o } : o; }
        case 'distinct': {
          const a = r(x.l), b = r(x.r);
          const same = { k: 'or', items: [{ k: 'cmp', op: '=', l: a, r: b }, { k: 'and', items: [{ k: 'isnull', e: a, neg: false }, { k: 'isnull', e: b, neg: false }] }] };
          return x.neg ? same : { k: 'not', e: same };
        }
        case 'call': {
          const name = String(x.name || (x.def && x.def.name) || '').toLowerCase();
          const ok = ['upper', 'lower', 'length', 'abs', 'round', 'floor', 'ceil', 'trim', 'mod', 'substr', 'substring', 'coalesce'];
          if (ok.includes(name)) return { k: 'fn', name, args: x.args.map(r) };
          if (['+', '-', '*', '/', '%'].includes(name) && x.args.length === 2) return { k: 'arith', op: name, l: r(x.args[0]), r: r(x.args[1]) };
          this.unsupported('the function ' + name + '() has no counterpart in the algebra here');
        }
        // falls through
        case 'sub': this.unsupported('a subquery in this position (only WHERE conditions of the form [NOT] EXISTS, [NOT] IN, op ANY/ALL and comparisons with an uncorrelated scalar subquery are translated)');
        // falls through
        default: this.unsupported('the expression ' + x.k + ' has no counterpart in the algebra');
      }
    }
    filter(n) {
      let c = this.tr(n.children[0]);
      const conj = n.cond.k === 'and' ? n.cond.items : [n.cond];
      const plain = [], subs = [];
      for (const x of conj) (hasSub(x) ? subs : plain).push(x);
      if (plain.length) {
        const conds = plain.map((x) => this.expr(x, c.attrs));
        c = { e: { op: 'select', cond: conds.length === 1 ? conds[0] : { k: 'and', items: conds }, child: c.e }, attrs: c.attrs };
      }
      for (const x of subs) c = this.subCond(x, c);
      return c;
    }
    /** a WHERE conjunct with a subquery, against the translated input c */
    subCond(x, c) {
      let neg = false;
      let s = x;
      if (s.k === 'not' && s.e.k === 'sub') { neg = true; s = s.e; }
      if (s.k === 'cmp' && (s.l.k === 'sub' || s.r.k === 'sub')) return this.scalarSub(s, c);
      if (s.k !== 'sub') this.unsupported('a subquery inside OR, NOT or another expression; only top-level conjuncts of WHERE are translated');
      if (s.kind === 'scalar' || s.kind === 'array') this.unsupported('a scalar subquery used as a condition');
      const inner = this.decorrelate(s.plan, c);
      const r = inner.tr;
      let conds = inner.corr.slice();
      let kind;
      if (s.kind === 'exists') kind = neg ? 'antijoin' : 'semijoin';
      else {
        const op = s.op || '=';
        if (s.rowTest) this.unsupported('row comparisons with subqueries');
        const test = this.exprOuter(s.test, inner.all);
        const col = inner.out[0];
        const cmp = { k: 'cmp', op, l: test, r: col };
        if (s.kind === 'in') { kind = s.neg !== neg ? 'antijoin' : 'semijoin'; conds.push(cmp); if (kind === 'antijoin') this.note('NOT IN is translated as an antijoin; the two differ when the subquery returns NULLs (NOT IN is then never true).'); }
        else if (s.kind === 'any') { kind = neg ? 'antijoin' : 'semijoin'; conds.push(cmp); }
        else if (s.kind === 'all') {
          // x op ALL (S): no tuple of S for which x op s fails
          kind = neg ? 'semijoin' : 'antijoin';
          conds.push({ k: 'not', e: cmp });
          this.note('op ALL is translated as an antijoin on the negated comparison; they differ when NULLs are involved.');
        } else this.unsupported('subquery of kind ' + s.kind);
      }
      const cond = conds.length === 0 ? null : conds.length === 1 ? conds[0] : { k: 'and', items: conds };
      if (!cond) {
        // an uncorrelated EXISTS: the left side survives exactly when the subquery is not empty
        const t = this.fresh('t');
        const e = { op: kind, left: c.e, right: { op: 'rename', rel: t, attrs: r.attrs.map((a, i) => '_e' + (i + 1)), map: null, child: r.e }, cond: { k: 'lit', v: true } };
        return { e, attrs: c.attrs };
      }
      return { e: { op: kind, left: c.e, right: r.e, cond }, attrs: c.attrs };
    }
    /** a subquery plan as a right operand: its correlation predicates become the join condition */
    decorrelate(plan, outer) {
      let p = plan;
      while (p.op === 'Distinct' || p.op === 'Sort' || (p.op === 'Project' && p.passthrough)) p = p.children[0];
      let projExprs = null;
      if (p.op === 'Project') { projExprs = p.exprs; p = p.children[0]; }
      const corr = [];
      if (p.op === 'Filter' && containsOuter(p.cond)) {
        const conj = p.cond.k === 'and' ? p.cond.items : [p.cond];
        const keep = conj.filter((x) => !containsOuter(x));
        const moved = conj.filter((x) => containsOuter(x));
        if (moved.some(hasSub)) this.unsupported('a correlated subquery nested inside another subquery');
        p = keep.length ? Object.assign({}, p, { cond: keep.length === 1 ? keep[0] : { k: 'and', items: keep, type: p.cond.type } }) : p.children[0];
        corr.push(...moved);
      }
      if (planHasOuter(p)) this.unsupported('a correlated subquery whose correlation is not a WHERE condition of the subquery itself');
      let r = this.tr(p);
      r = this.distinctQuals(outer, r);
      const all = outer.attrs.concat(r.attrs);
      const exprIn = (x) => this.exprOuter(x, all);
      const corrA = corr.map(exprIn);
      const out = projExprs ? projExprs.map(exprIn) : r.attrs.map((_, i) => this.refAt(outer.attrs.length + i, all));
      return { tr: r, corr: corrA, out, all };
    }
    /** like expr, but outer references (depth 1) resolve against the same combined schema */
    exprOuter(x, attrs) {
      const strip = (y) => {
        if (!y || typeof y !== 'object') return y;
        if (Array.isArray(y)) return y.map(strip);
        if (y.k === 'col' && y.outer) { if (y.outer > 1) this.unsupported('a reference to a query two levels out'); return Object.assign({}, y, { outer: undefined }); }
        if (y.k === 'sub') return y;
        const o = {};
        for (const k in y) o[k] = k === 'type' || k === 'def' || k === 'ctype' ? y[k] : strip(y[k]);
        return o;
      };
      return this.expr(strip(x), attrs);
    }
    scalarSub(s, c) {
      const subSide = s.l.k === 'sub' ? 'l' : 'r';
      const sub = s[subSide];
      if (sub.kind !== 'scalar') this.unsupported('subquery comparison');
      if (sub.outerRefs.length) this.unsupported('a correlated scalar subquery (it is evaluated once per tuple; rewrite it with γ and a join)');
      const r = this.tr(sub.plan);
      if (r.attrs.length !== 1) this.unsupported('a scalar subquery with more than one column');
      const t = this.fresh('s');
      const right = { e: { op: 'rename', rel: t, attrs: ['v'], map: null, child: r.e }, attrs: [{ name: 'v', quals: [t], ids: [-1] }] };
      const all = c.attrs.concat(right.attrs);
      const other = this.expr(s[subSide === 'l' ? 'r' : 'l'], all);
      const vref = { k: 'attr', parts: [t, 'v'] };
      const cond = { k: 'cmp', op: s.op, l: subSide === 'l' ? vref : other, r: subSide === 'l' ? other : vref };
      this.note('A scalar subquery becomes a product with its one-tuple result, renamed ' + t + '(v).');
      const items = c.attrs.map((_, i) => ({ e: this.refAt(i, all), as: null }));
      return { e: { op: 'project', items, child: { op: 'select', cond, child: { op: 'product', left: c.e, right: right.e } } }, attrs: c.attrs };
    }
    project(n) {
      const child = n.children[0];
      if (n.joinMerge) {
        const c = this.tr(child);
        // a full natural join: the algebra's ⟗ already merges the common attributes
        return { e: c.e, attrs: c.attrs.map((a) => a), passMerge: true, merged: c.merged };
      }
      const c = this.tr(child);
      const vis = n.cols.map((col, i) => ({ col, e: n.exprs[i] })).filter((x) => !x.col.hidden || true);
      if (n.op === 'ProjectSet') this.unsupported('set-returning functions in the select list');
      // the identity projection disappears
      if (vis.length === c.attrs.length && vis.every((x, i) => x.e.k === 'col' && c.attrs[i].ids.includes(x.e.id) && c.attrs[i].name === x.col.name)) return { e: c.e, attrs: c.attrs.map((a, i) => ({ name: a.name, quals: a.quals, ids: a.ids.concat([vis[i].col.id]) })) };
      // a projection over γ that only names its columns: the names go into γ itself
      if (c.e.op === 'group' && vis.every((x) => x.e.k === 'col' && c.attrs.some((a) => a.ids.includes(x.e.id)))) {
        const g = c.e, ng = g.groups.length;
        const idx = vis.map((x) => c.attrs.findIndex((a) => a.ids.includes(x.e.id)));
        const groupsKeepNames = idx.every((i, j) => i >= ng || c.attrs[i].name === vis[j].col.name);
        if (groupsKeepNames && new Set(idx).size === idx.length) {
          const aggs = g.aggs.map((a) => Object.assign({}, a));
          idx.forEach((i, j) => { if (i >= ng) aggs[i - ng].as = vis[j].col.name; });
          const ge = Object.assign({}, g, { aggs });
          const gattrs = c.attrs.map((a, i) => ({ name: i >= ng && idx.includes(i) ? vis[idx.indexOf(i)].col.name : a.name, quals: a.quals, ids: a.ids.concat(idx.includes(i) ? [vis[idx.indexOf(i)].col.id] : []) }));
          if (idx.length === c.attrs.length && idx.every((i, j) => i === j)) return { e: ge, attrs: gattrs };
          const items = idx.map((i) => ({ e: this.refAt(i, gattrs), as: null }));
          return { e: { op: 'project', items, child: ge }, attrs: idx.map((i) => gattrs[i]) };
        }
      }
      const items = [], attrs = [];
      for (const x of vis) {
        if (hasSub(x.e)) this.unsupported('a subquery in the select list');
        if (x.e.k === 'aggcall' || x.e.k === 'wincall') this.unsupported('an aggregate outside γ');
        const e = this.expr(x.e, c.attrs);
        const src = x.e.k === 'col' ? c.attrs.find((a) => a.ids.includes(x.e.id)) : null;
        const name = x.col.hidden ? '_sort' + items.length : x.col.name;
        if (src && src.name === name) { items.push({ e, as: null }); attrs.push({ name, quals: src.quals.slice(), ids: [x.col.id].concat(src.ids) }); }
        else { items.push({ e, as: name }); attrs.push({ name, quals: [], ids: [x.col.id] }); }
      }
      return { e: { op: 'project', items, child: c.e }, attrs };
    }
    join(n) {
      const l = this.tr(n.children[0]);
      let r = this.tr(n.children[1]);
      r = this.distinctQuals(l, r);
      const jt = n.jtype === 'cross' ? 'product' : { inner: 'join', left: 'ljoin', right: 'rjoin', full: 'fjoin' }[n.jtype];
      if (!jt) this.unsupported(n.jtype + ' join');
      const all = l.attrs.concat(r.attrs);
      if (n.natural || n.using) {
        const common = l.attrs.filter((a) => r.attrs.some((b) => b.name === a.name)).map((a) => a.name);
        const names = n.natural ? common : n.using;
        if (names.length === common.length && names.every((x) => common.includes(x))) {
          // the algebra's natural join: common attributes once, then the rest of each side
          const out = common.map((nm) => { const a = l.attrs.find((x) => x.name === nm), b = r.attrs.find((x) => x.name === nm); return { name: nm, quals: a.quals.concat(b.quals.filter((x) => !a.quals.includes(x))), ids: a.ids.concat(b.ids) }; });
          const attrs = out.concat(l.attrs.filter((a) => !common.includes(a.name)), r.attrs.filter((a) => !common.includes(a.name)));
          if (n.merged && n.jtype === 'full') for (const m of n.merged.cols) { const a = attrs.find((x) => x.name === m.name); a.ids.push(m.id); }
          return { e: { op: n.jtype === 'cross' ? 'join' : jt, left: l.e, right: r.e, cond: null }, attrs };
        }
        if (n.jtype === 'full') this.unsupported('FULL JOIN ... USING a subset of the common columns');
        // USING some of the common columns: a theta join on equalities
        const conds = names.map((nm) => ({ k: 'cmp', op: '=', l: this.refAt(l.attrs.findIndex((a) => a.name === nm), all), r: this.refAt(l.attrs.length + r.attrs.findIndex((a) => a.name === nm), all) }));
        return { e: { op: jt === 'product' ? 'join' : jt, left: l.e, right: r.e, cond: conds.length === 1 ? conds[0] : { k: 'and', items: conds } }, attrs: all };
      }
      if (jt === 'product' || !n.cond) return { e: jt === 'product' || jt === 'join' ? { op: 'product', left: l.e, right: r.e } : { op: jt, left: l.e, right: r.e, cond: { k: 'lit', v: true } }, attrs: all };
      if (hasSub(n.cond)) this.unsupported('a subquery in a join condition');
      return { e: { op: jt, left: l.e, right: r.e, cond: this.expr(n.cond, all) }, attrs: all };
    }
    aggregate(n) {
      if (n.sets) this.unsupported('GROUPING SETS, ROLLUP and CUBE');
      let c = this.tr(n.children[0]);
      // grouping by expressions: compute them first with a generalized projection
      const groups = [];
      const extra = [];
      for (const g of n.groups) {
        if (g.e.k === 'col' && c.attrs.some((a) => a.ids.includes(g.e.id))) { groups.push({ id: g.id, src: c.attrs.find((a) => a.ids.includes(g.e.id)) }); continue; }
        extra.push(g);
      }
      if (extra.length) {
        const items = c.attrs.map((_, i) => ({ e: this.refAt(i, c.attrs), as: null }));
        const attrs = c.attrs.slice();
        for (const g of extra) { const name = '_g' + (attrs.length + 1); items.push({ e: this.expr(g.e, c.attrs), as: name }); const a = { name, quals: [], ids: [-2 - attrs.length] }; attrs.push(a); groups.push({ id: g.id, src: a }); }
        c = { e: { op: 'project', items, child: c.e }, attrs };
      }
      const aggs = n.aggs.map((a) => {
        if (a.filter) this.unsupported('aggregate FILTER clauses');
        if (a.args && a.args.length > 1) this.unsupported('aggregates with more than one argument');
        const fn = String(a.name).toLowerCase();
        if (!['count', 'sum', 'avg', 'min', 'max'].includes(fn)) this.unsupported('the aggregate ' + fn + '()');
        return { fn, arg: a.star || !a.args || !a.args.length ? null : this.expr(a.args[0], c.attrs), distinct: !!a.distinct, as: null, id: a.outId };
      });
      if (!this.opts.bag && aggs.some((a) => !a.distinct && a.fn !== 'min' && a.fn !== 'max') && mayHaveDuplicates(n.children[0])) this.note('Under set semantics γ sees its input without duplicates; count, sum and avg can then differ from SQL when the input has duplicate tuples.');
      // name the aggregates after the column names SQL gives them (fixed up by the projection above, if any)
      const used = new Set(groups.map((g) => g.src.name));
      for (const a of aggs) { let nm = a.fn + (a.arg && a.arg.k === 'attr' ? '_' + a.arg.parts[a.arg.parts.length - 1] : ''); let k = 2; const base = nm; while (used.has(nm)) nm = base + '_' + k++; used.add(nm); a.as = nm; }
      const e = { op: 'group', groups: groups.map((g) => this.refAt(c.attrs.indexOf(g.src), c.attrs)), aggs: aggs.map((a) => ({ fn: a.fn, arg: a.arg, distinct: a.distinct, as: a.as })), child: c.e };
      const attrs = groups.map((g) => ({ name: g.src.name, quals: g.src.quals.slice(), ids: [g.id].concat(g.src.ids) })).concat(aggs.map((a) => ({ name: a.as, quals: [], ids: [a.id] })));
      return { e, attrs };
    }
  }
  function hasSub(x) {
    let f = false;
    const w = (y) => { if (f || !y || typeof y !== 'object') return; if (Array.isArray(y)) { y.forEach(w); return; } if (y.k === 'sub') { f = true; return; } for (const k in y) if (k !== 'type' && k !== 'def' && k !== 'ctype' && k !== 'plan') w(y[k]); };
    w(x);
    return f;
  }
  function containsOuter(x) {
    let f = false;
    const w = (y) => { if (f || !y || typeof y !== 'object') return; if (Array.isArray(y)) { y.forEach(w); return; } if (y.k === 'col' && y.outer) { f = true; return; } for (const k in y) if (k !== 'type' && k !== 'def' && k !== 'ctype') w(y[k]); };
    w(x);
    return f;
  }
  function planHasOuter(p) {
    let f = false;
    const w = (y) => { if (f || !y || typeof y !== 'object') return; if (Array.isArray(y)) { y.forEach(w); return; } if (y.k === 'col' && y.outer) { f = true; return; } if (y.k === 'sub') { if (y.outerRefs && y.outerRefs.length && y.plan && planHasOuterDeep(y.plan)) f = true; return; } for (const k in y) if (k !== 'type' && k !== 'def' && k !== 'ctype' && k !== 'rel' && k !== 'cte' && k !== 'outerRefs') w(y[k]); };
    w(p);
    return f;
  }
  // a nested subquery's outer references of depth 2 or more reach past the subquery being decorrelated
  function planHasOuterDeep(p) {
    let f = false;
    const w = (y) => { if (f || !y || typeof y !== 'object') return; if (Array.isArray(y)) { y.forEach(w); return; } if (y.k === 'col' && y.outer > 1) { f = true; return; } for (const k in y) if (k !== 'type' && k !== 'def' && k !== 'ctype' && k !== 'rel' && k !== 'cte' && k !== 'outerRefs') w(y[k]); };
    w(p);
    return f;
  }

  /**
   * SQL text (one SELECT) -> algebra. session: a Kwery session that knows the tables.
   * Returns { program, text, ascii, tree, notes, exact, cols } or, for queries outside the algebra,
   * { error: message, notes } with exact false.
   */
  function fromSQL(sql, session, opts) {
    opts = opts || {};
    const stmts = K.parse(sql);
    if (stmts.length !== 1) failc(SYNTAX, 'give exactly one query');
    const st = stmts[0];
    if (!['select', 'setop', 'values'].includes(st.type)) failc(SYNTAX, 'only queries (SELECT, set operations, VALUES) translate to the algebra');
    const plan = session.bindOnly(st);
    const f = new FromSQL(session, opts);
    let r;
    try { r = f.tr(plan); } catch (e) {
      if (e.unsupported || e.code === '0A000') return { error: e.message, notes: f.notes.concat(['Not expressible in the algebra as translated here: ' + e.message + '.']), exact: false };
      throw e;
    }
    const env = new Map();
    for (const s2 of f.stmts) { s2.expr = foldProjections(s2.expr, session, env); try { env.set(s2.name, A.schemaOf(s2.expr, session, env).map((a, i) => A.attr(s2.attrs ? s2.attrs[i] : a.name, [s2.name]))); } catch (e) { /* leave it */ } }
    const prog = { stmts: f.stmts, result: foldProjections(r.e, session, env) };
    if (!opts.bag && !f.distinctSeen && produceDuplicates(plan)) f.note('SQL keeps duplicate rows here (no DISTINCT); the algebra under set semantics returns each tuple once.');
    // the result's attribute names follow the SQL column names
    const names = plan.cols.filter((c) => !c.hidden).map((c) => c.name);
    const text = A.programText(prog), ascii = A.programText(prog, 'ascii');
    return { program: prog, text, ascii, tree: A.toTree(r.e), notes: f.notes, exact: f.exact, cols: names };
  }
  /** π[L1](π[L2](E)) = π[L1](E) when L1 and L2 only name attributes: the cascade of projections */
  function foldProjections(e, src, env) {
    const rec = (n) => {
      if (n.child) n.child = rec(n.child);
      if (n.left) n.left = rec(n.left);
      if (n.right) n.right = rec(n.right);
      if (n.op === 'project' && n.child.op === 'project' && n.items.every((it) => it.e.k === 'attr') && n.child.items.every((it) => it.e.k === 'attr' && !it.as)) {
        const cand = Object.assign({}, n, { child: n.child.child });
        try {
          const a = A.schemaOf(n, src, env), b = A.schemaOf(cand, src, env);
          if (a.length === b.length && a.every((x, i) => x.name === b[i].name)) return cand;
        } catch (err) { /* keep both */ }
      }
      return n;
    };
    return rec(e);
  }
  /** could SQL produce duplicate rows here, where the algebra would produce each tuple once? */
  function produceDuplicates(plan) {
    let p = plan;
    while (p.op === 'Sort' || p.op === 'Limit' || (p.op === 'Project' && p.passthrough)) p = p.children[0];
    if (p.op === 'Distinct' || p.op === 'SetOp' && !p.all) return false;
    if (p.op === 'SetOp') return true;
    if (p.op === 'Project') {
      const c = p.children[0];
      if (p.joinMerge) return mayHaveDuplicates(c);
      // all grouping columns kept: one row per group
      if (c.op === 'Aggregate') return !c.groups.every((g) => p.exprs.some((e) => e.k === 'col' && e.id === g.id));
      // every visible column of the input kept
      const vis = c.cols.filter((x) => !x.hidden);
      if (vis.every((x) => p.exprs.some((e) => e.k === 'col' && e.id === x.id))) return mayHaveDuplicates(c);
      return true;
    }
    return mayHaveDuplicates(p);
  }
  /** a binder subtree that may hold duplicate rows even though its base tables hold none */
  function mayHaveDuplicates(p) {
    switch (p.op) {
      case 'Scan': case 'CteScan': case 'Values': return p.op === 'Values';
      case 'Filter': case 'Sort': case 'Limit': return mayHaveDuplicates(p.children[0]);
      case 'Join': return mayHaveDuplicates(p.children[0]) || mayHaveDuplicates(p.children[1]);
      case 'Distinct': case 'Aggregate': return false;
      case 'SetOp': return !!p.all;
      case 'Subquery': return produceDuplicates(p.children[0]);
      case 'Project': return p.joinMerge ? mayHaveDuplicates(p.children[0]) : produceDuplicates(p);
      default: return true;
    }
  }

  Object.assign(A, { toSQL, fromSQL, scalarSQL, sqlLit });
})(typeof window !== 'undefined' ? window : globalThis);
