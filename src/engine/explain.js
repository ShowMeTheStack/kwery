// EXPLAIN: a physical plan as text, laid out as PostgreSQL lays it out (node names, conditions, keys), with
// Kwery's cost model numbers (milliseconds of the simulated disk) and, for EXPLAIN ANALYZE, the actual rows,
// loops and I/O. Also the deparser that turns bound expressions back into SQL text for plans and views.
(function (root) {
  'use strict';
  const K = root.K;
  const T = () => K.T;

  const PREC = { or: 1, and: 2, not: 3, cmp: 4, like: 4, inlist: 4, isnull: 5, arith: 6, concat: 6 };
  /** a bound expression as SQL text; names maps column ids to "table.column" */
  function show(e, names, outer) {
    const s = (x, p) => { const t = show(x, names, outer); return p && PREC[x.k] && PREC[x.k] < p ? '(' + t + ')' : t; };
    if (!e) return '';
    switch (e.k) {
      case 'col': return names.get(e.id) || (e.table ? e.table + '.' + e.name : e.name || '$' + e.id);
      case 'outer': return names.get(e.id) || e.name;
      case 'const': {
        if (e.v === null) return 'NULL';
        const t = e.type;
        const txt = T().output(e.v, t);
        if (t.cat === 'N' && t.id !== 'numeric') return txt;
        if (t.cat === 'N') return txt;
        if (t.cat === 'B') return e.v ? 'true' : 'false';
        return "'" + txt.replace(/'/g, "''") + "'::" + T().sqlName(t);
      }
      case 'param': return '$' + e.n;
      case 'var': return e.name;
      case 'cmp': return '(' + s(e.l, 5) + ' ' + e.op + ' ' + s(e.r, 5) + ')';
      case 'rowcmp': return '(' + e.pairs.map((p) => show(p.l, names)).join(', ') + ') ' + e.op + ' (' + e.pairs.map((p) => show(p.r, names)).join(', ') + ')';
      case 'arith': return '(' + s(e.l) + ' ' + e.op + ' ' + s(e.r) + ')';
      case 'concat': return '(' + s(e.l) + ' || ' + s(e.r) + ')';
      case 'neg': return '(- ' + s(e.e) + ')';
      case 'and': return '(' + e.items.map((x) => s(x, 2)).join(' AND ') + ')';
      case 'or': return '(' + e.items.map((x) => s(x, 1)).join(' OR ') + ')';
      case 'not': return '(NOT ' + s(e.e, 3) + ')';
      case 'isnull': return '(' + s(e.e, 6) + (e.neg ? ' IS NOT NULL' : ' IS NULL') + ')';
      case 'istruth': return '(' + s(e.e) + ' IS ' + (e.neg ? 'NOT ' : '') + (e.v ? 'TRUE' : 'FALSE') + ')';
      case 'distinct': return '(' + s(e.l) + ' IS ' + (e.neg ? 'NOT ' : '') + 'DISTINCT FROM ' + s(e.r) + ')';
      case 'like': return '(' + s(e.e) + ' ' + (e.similar ? (e.neg ? '!~ ' : '~ ') : (e.neg ? '!' : '') + (e.ci ? '~~* ' : '~~ ')) + s(e.pat) + ')';
      case 'inlist': return '(' + s(e.e) + (e.neg ? ' <> ALL ' : ' = ANY ') + "('{" + e.items.map((x) => (x.k === 'const' ? (x.v === null ? 'NULL' : T().output(x.v, x.type)) : show(x, names))).join(',') + "}'::" + T().sqlName(e.ctype) + '[])' + ')';
      case 'quant': return '(' + s(e.e) + ' ' + e.op + ' ' + e.q.toUpperCase() + ' (' + show(e.arr, names) + '))';
      case 'case': return 'CASE' + (e.base ? ' ' + show(e.base, names) : '') + e.whens.map((w) => ' WHEN ' + show(w.c, names) + ' THEN ' + show(w.r, names)).join('') + (e.else ? ' ELSE ' + show(e.else, names) : '') + ' END';
      case 'coalesce': return 'COALESCE(' + e.items.map((x) => show(x, names)).join(', ') + ')';
      case 'nullif': return 'NULLIF(' + show(e.a, names) + ', ' + show(e.b, names) + ')';
      case 'greatest': case 'least': return e.k.toUpperCase() + '(' + e.items.map((x) => show(x, names)).join(', ') + ')';
      case 'cast': return '(' + s(e.e, 9) + ')::' + T().sqlName(e.type);
      case 'call': return /^[a-z_]/.test(e.def.name) ? e.def.name + '(' + e.args.map((x) => show(x, names)).join(', ') + ')' : e.args.length === 1 ? '(' + e.def.name + ' ' + s(e.args[0]) + ')' : '(' + s(e.args[0]) + ' ' + e.def.name + ' ' + s(e.args[1]) + ')';
      case 'udf': return e.fn.name + '(' + e.args.map((x) => show(x, names)).join(', ') + ')';
      case 'aggcall': return e.name + '(' + (e.distinct ? 'DISTINCT ' : '') + (e.star ? '*' : e.args.map((x) => show(x, names)).join(', ')) + (e.order ? ' ORDER BY ' + e.order.map((o) => show(o.e, names) + (o.dir === 'desc' ? ' DESC' : '')).join(', ') : '') + ')' + (e.filter ? ' FILTER (WHERE ' + show(e.filter, names) + ')' : '');
      case 'wincall': return e.name + '(' + (e.star ? '*' : e.args.map((x) => show(x, names)).join(', ')) + ') OVER (...)';
      case 'srfcall': return e.name + '(' + e.args.map((x) => show(x, names)).join(', ') + ')';
      case 'row': return 'ROW(' + e.items.map((x) => show(x, names)).join(', ') + ')';
      case 'array': return 'ARRAY[' + e.items.map((x) => show(x, names)).join(', ') + ']';
      case 'idx': return s(e.e, 9) + (e.subs ? e.subs.map((x) => '[' + show(x, names) + ']').join('') : '[' + (e.lo ? show(e.lo, names) : '') + (e.slice ? ':' + (e.hi ? show(e.hi, names) : '') : '') + ']');
      case 'field': return '(' + show(e.e, names) + ').' + e.name;
      case 'grouping': return 'GROUPING(...)';
      case 'sub': {
        const label = outer && outer.subs ? '(SubPlan ' + outer.label(e) + ')' : '(SubPlan)';
        if (e.kind === 'exists') return 'EXISTS' + label;
        if (e.kind === 'scalar' || e.kind === 'array' || e.kind === 'row') return label;
        const t = e.rowTest ? '(' + e.tests.map((x) => show(x.e, names)).join(', ') + ')' : show(e.test, names);
        return (e.neg ? 'NOT ' : '') + '(' + t + ' ' + (e.kind === 'in' ? '= ANY' : e.op + ' ' + e.kind.toUpperCase()) + ' ' + label + ')';
      }
      case 'default': return 'DEFAULT';
      case 'raw': return e.text;
    }
    return '?';
  }

  const JT = { inner: '', cross: '', left: ' Left Join', right: ' Right Join', full: ' Full Join', semi: ' Semi Join', anti: ' Anti Join' };
  /** the name PostgreSQL gives a plan node, and its detail lines */
  function describe(n, names, ctx) {
    const cond = (label, e) => (e ? [label + ': ' + show(e, names, ctx)] : []);
    const rel = (n) => (n.rel ? (n.rel.schema !== 'public' ? n.rel.schema + '.' : '') + n.rel.name + (n.alias && n.alias !== n.rel.name ? ' ' + n.alias : '') : '');
    const keys = (list) => list.map((k) => names.get(k.id) + (k.dir === 'desc' ? ' DESC' : '') + (k.nulls && k.nulls !== (k.dir === 'desc' ? 'first' : 'last') ? ' NULLS ' + k.nulls.toUpperCase() : '')).join(', ');
    switch (n.op) {
      case 'SeqScan': return { name: 'Seq Scan on ' + rel(n), lines: cond('Filter', n.filter) };
      case 'IndexScan': return { name: 'Index Scan' + (n.dir === 'backward' ? ' Backward' : '') + ' using ' + n.index.name + ' on ' + rel(n), lines: cond('Index Cond', boundsExpr(n.bounds, n.index, n, names)).concat(cond('Filter', n.filter)) };
      case 'IndexOnlyScan': return { name: 'Index Only Scan using ' + n.index.name + ' on ' + rel(n), lines: cond('Index Cond', boundsExpr(n.bounds, n.index, n, names)).concat(cond('Filter', n.filter)) };
      case 'BitmapScan': return { name: 'Bitmap Heap Scan on ' + rel(n), lines: cond('Recheck Cond', n.recheck).concat(cond('Filter', n.filter)), bitmapAnd: n.indexes.length > 1 && !n.bitmapOr, bitmapOr: !!n.bitmapOr, kids: n.indexes.map((ix) => ({ name: 'Bitmap Index Scan on ' + ix.index.name, lines: cond('Index Cond', boundsExpr(ix.bounds, ix.index, n, names)), node: null })) };
      case 'NestLoopJoin': return { name: 'Nested Loop' + JT[n.jtype], lines: cond('Join Filter', n.cond).concat(n.lateral ? ['(lateral: the inner side runs once per outer row)'] : []) };
      case 'BlockNestLoopJoin': return { name: 'Block Nested Loop' + JT[n.jtype], lines: cond('Join Filter', n.cond).concat(['Outer block: ' + (n.blockPages || 4) + ' pages']) };
      case 'IndexNestLoopJoin': return { name: 'Nested Loop' + JT[n.jtype], lines: cond('Join Filter', n.restCond), innerName: 'Index Scan using ' + n.index.name + ' on ' + rel(n.children[1]), innerLines: ['Index Cond: (' + (n.children[1].cols.find((c) => c.attnum === n.index.keys[0].attnum) ? names.get(n.children[1].cols.find((c) => c.attnum === n.index.keys[0].attnum).id) : '?') + ' = ' + show(n.indexKey.l, names) + ')'].concat(cond('Filter', n.innerFilter)) };
      case 'HashJoin': return { name: 'Hash' + (JT[n.jtype] || ' Join'), lines: ['Hash Cond: ' + andText(n.keys.map((k) => '(' + show(k.l, names) + ' = ' + show(k.r, names) + ')'))].concat(cond('Join Filter', n.restCond)).concat(n.rt && n.hashInfo && n.hashInfo.spill ? ['Batches: ' + n.hashInfo.spill.partitions + '  Disk: ' + n.hashInfo.spill.pagesWritten + ' pages written, ' + n.hashInfo.spill.pagesRead + ' read'] : []), hashInner: true };
      case 'MergeJoin': return { name: 'Merge' + (JT[n.jtype] || ' Join'), lines: ['Merge Cond: ' + andText(n.keys.map((k) => '(' + show(k.l, names) + ' = ' + show(k.r, names) + ')'))].concat(cond('Join Filter', n.restCond)), sortInputs: true };
      case 'Filter': return { name: 'Filter', lines: cond(n.having ? 'Filter' : 'Filter', n.cond), fold: true };
      case 'Aggregate': {
        const nm = n.sets ? 'MixedAggregate' : n.alg === 'hashed' ? 'HashAggregate' : n.alg === 'sorted' ? 'GroupAggregate' : 'Aggregate';
        const lines = [];
        if (n.sets) for (const set of n.sets) lines.push((set.length ? 'Group Key: ' + set.map((i) => show(n.groups[i].e, names)).join(', ') : 'Group Key: ()'));
        else if (n.groups.length) lines.push('Group Key: ' + n.groups.filter((g) => !g.dependent).map((g) => show(g.e, names)).join(', '));
        return { name: nm, lines };
      }
      case 'Sort': return { name: 'Sort', lines: ['Sort Key: ' + keys(n.keys)].concat(n.rt && n.rt.loops ? ['Sort Method: ' + (n.sortInfo && n.sortInfo.spill ? 'external merge  Disk: ' + n.sortInfo.spill.runs + ' runs, ' + n.sortInfo.spill.passes + ' merge passes, ' + n.sortInfo.spill.pagesWritten + ' pages written, ' + n.sortInfo.spill.pagesRead + ' read' : 'quicksort')] : []) };
      case 'Limit': return { name: 'Limit', lines: [] };
      case 'Distinct': return n.on ? { name: 'Unique', lines: [] } : { name: n.alg === 'sorted' ? 'Unique' : 'HashAggregate', lines: ['Group Key: ' + n.children[0].cols.filter((c) => !c.hidden).map((c) => names.get(c.id)).join(', ')] };
      case 'SetOp': return n.setop === 'union' ? { name: n.all ? 'Append' : 'HashAggregate', lines: n.all ? [] : ['Group Key: ' + n.cols.map((c) => c.name).join(', ')], unionAppend: !n.all } : { name: 'HashSetOp ' + (n.setop === 'intersect' ? 'Intersect' : 'Except') + (n.all ? ' All' : ''), lines: [] };
      case 'Window': return { name: 'WindowAgg', lines: [] };
      case 'ProjectSet': return { name: 'ProjectSet', lines: [] };
      case 'CteScan': return { name: 'CTE Scan on ' + n.cte.name + (n.cols[0] && n.cols[0].table && n.cols[0].table !== n.cte.name ? ' ' + n.cols[0].table : ''), lines: [] };
      case 'WorkTable': return { name: 'WorkTable Scan on ' + n.cte.name, lines: [] };
      case 'RecursiveUnion': return { name: 'Recursive Union', lines: n.iterations ? ['Iterations: ' + n.iterations] : [] };
      case 'Subquery': return n.view ? { name: 'Subquery Scan on ' + n.view.name, lines: [], fold: true } : { name: 'Subquery Scan on ' + ((n.cols[0] && n.cols[0].table) || 'unnamed_subquery'), lines: [] };
      case 'Func': return { name: 'Function Scan on ' + n.calls.map((c) => c.name).join(', '), lines: [] };
      case 'Values': return { name: n.system ? 'Function Scan on ' + n.system : 'Values Scan on "*VALUES*"', lines: [] };
      case 'Result': return { name: 'Result', lines: [] };
      case 'SeqState': return { name: 'Seq Scan on ' + n.rel.name, lines: [] };
      case 'LockRows': return { name: 'LockRows', lines: [] };
      case 'Modify': return { name: n.kind[0].toUpperCase() + n.kind.slice(1) + ' on ' + n.rel.name, lines: n.conflict ? ['Conflict Resolution: ' + n.conflict.action.toUpperCase()] : [] };
      case 'Project': return { name: 'Project', fold: true, lines: [] };
    }
    return { name: n.op, lines: [] };
  }
  const andText = (parts) => (parts.length === 1 ? parts[0] : '(' + parts.join(' AND ') + ')');
  function boundsExpr(bounds, idx, scan, names) {
    const col = (k) => { const key = idx.keys[k]; const c = key && key.attnum !== undefined && scan.cols.find((x) => x.attnum === key.attnum); return c ? names.get(c.id) : key ? '(' + key.name + ')' : '?'; };
    const parts = bounds.map((b) => {
      if (b.op === 'isnull') return '(' + col(b.k) + ' IS NULL)';
      if (b.op === 'notnull') return '(' + col(b.k) + ' IS NOT NULL)';
      if (b.op === 'in') return '(' + col(b.k) + " = ANY ('{" + b.v.map((x) => (x.k === 'const' ? T().output(x.v, x.type) : show(x, names))).join(',') + "}'))";
      return '(' + col(b.k) + ' ' + b.op + ' ' + (b.v && b.v.k ? show(b.v, names) : String(b.v)) + ')';
    });
    return parts.length ? { k: 'raw', text: andText(parts) } : null;
  }
  /** the column names a plan's expressions refer to: table.column for scans, the output names otherwise */
  function nameMap(plan) {
    const names = new Map();
    // with one table in the query, PostgreSQL leaves column names unqualified
    let tables = 0;
    const count = (n) => { if (!n) return; if (/Scan$/.test(n.op) && n.rel) tables++; if (n.op === 'CteScan' || n.op === 'Func' || n.op === 'Values' || n.op === 'WorkTable') tables++; (n.children || []).forEach(count); if (n.cte && n.cte.phys && n.op === 'CteScan') count(n.cte.phys); };
    count(plan);
    const single = tables <= 1;
    const seen = new Set();
    const walk = (n) => {
      if (!n || seen.has(n)) return;
      seen.add(n);
      for (const c of n.cols || []) if (!names.has(c.id)) names.set(c.id, c.table && !single ? c.table + '.' + c.name : c.name);
      if (n.groups) for (const g of n.groups) if (!names.has(g.id)) names.set(g.id, show(g.e, names));
      if (n.aggs) for (const a of n.aggs) if (!names.has(a.outId)) names.set(a.outId, show(a, names));
      for (const ch of n.children || []) walk(ch);
      if (n.cte && n.cte.phys) walk(n.cte.phys);
    };
    walk(plan);
    // a scan's columns were named before the aggregates above them, so fill aggregate names from the bottom up
    const fix = (n) => { for (const ch of n.children || []) fix(ch); if (n.aggs) for (const a of n.aggs) names.set(a.outId, show(a, names)); if (n.groups) for (const g of n.groups) names.set(g.id, show(g.e, names)); if (n.wins) for (const w of n.wins) names.set(w.outId, show(w, names)); };
    fix(plan);
    return names;
  }

  /** EXPLAIN text */
  function text(plan, opts, session) {
    opts = opts || {};
    const names = nameMap(plan);
    const out = [];
    const subs = [];
    const subIds = new Map();
    const ctx = { subs, label: (e) => { if (!subIds.has(e)) { subIds.set(e, subIds.size + 1); subs.push(e); } return subIds.get(e); } };
    const costs = opts.costs !== false;
    const fmt = (n) => (costs && n.cost !== undefined ? '  (cost=' + n.cost.toFixed(2) + ' rows=' + (n.rows || 0) + ')' : '') + (opts.analyze ? (n.rt ? ' (actual rows=' + Math.round(n.rt.rows / Math.max(1, n.rt.loops)) + ' loops=' + n.rt.loops + ')' : ' (never executed)') : '');
    const showRaw = (l) => l.replace(/\[object Object\]/g, '');
    const emit = (n, depth, first) => {
      const d = describe(n, names, ctx);
      // projections and plain filters fold into the node below, as in PostgreSQL's output
      if (d.fold && n.op === 'Project') { if (n.children[0]) emit(n.children[0], depth, first); return; }
      if (d.fold && n.op === 'Filter') {
        const ch = n.children[0];
        const cd = describe(ch, names, ctx);
        if (cd.fold && ch.op === 'Project') { emit(ch.children[0], depth, first); return; }
        line(depth, first, cd.name + fmt(n));
        for (const l of cd.lines.concat(d.lines)) detail(depth, l);
        kids(ch, depth, cd);
        return;
      }
      if (d.fold && n.op === 'Subquery') { emit(n.children[0], depth, first); return; }
      line(depth, first, d.name + fmt(n));
      for (const l of d.lines) detail(depth, l);
      kids(n, depth, d);
    };
    const pad = (depth) => ' '.repeat(depth === 0 ? 0 : depth * 6 - 4);
    const line = (depth, first, s) => out.push(depth === 0 ? s : pad(depth) + '->  ' + s);
    const detail = (depth, l) => out.push(' '.repeat(depth === 0 ? 2 : depth * 6 + 2) + showRaw(typeof l === 'string' ? l : l.text || ''));
    const kids = (n, depth, d) => {
      if (d.kids) {
        const base = d.bitmapAnd || d.bitmapOr ? depth + 2 : depth + 1;
        if (d.bitmapAnd || d.bitmapOr) line(depth + 1, false, d.bitmapOr ? 'BitmapOr' : 'BitmapAnd');
        for (const k of d.kids) { line(base, false, k.name); for (const l of k.lines) detail(base, typeof l === 'string' ? l : l); }
        return;
      }
      const ch = n.children || [];
      ch.forEach((c, i) => {
        if (n.op === 'IndexNestLoopJoin' && i === 1) { line(depth + 1, false, d.innerName); for (const l of d.innerLines) detail(depth + 1, l); return; }
        if (d.hashInner && i === 1) { line(depth + 1, false, 'Hash' + (costs && c.cost !== undefined ? '  (cost=' + c.cost.toFixed(2) + ' rows=' + (c.rows || 0) + ')' : '')); emit(c, depth + 2); return; }
        emit(c, depth + 1);
      });
      if (n.op === 'CteScan' && n.cte.phys && !n.cte.shown) { n.cte.shown = true; }
    };
    // CTEs are shown first, as PostgreSQL shows them
    const ctes = [];
    const findCtes = (n) => { if (!n) return; if (n.op === 'CteScan' && n.cte.phys && !ctes.includes(n.cte)) ctes.push(n.cte); for (const c of n.children || []) findCtes(c); };
    findCtes(plan);
    emit(plan, 0, true);
    for (const c of ctes) { out.splice(1, 0); out.push('  CTE ' + c.name); const before = out.length; emitSub(c.phys, 2); void before; }
    function emitSub(p, depth) { const save = out.length; emit(p, depth - 1, false); for (let i = save; i < out.length; i++) out[i] = '  ' + out[i]; }
    for (let i = 0; i < subs.length; i++) {
      const e = subs[i];
      out.push('  SubPlan ' + (i + 1));
      if (!e.phys && session) e.phys = new K.Planner(session, new K.Binder(session)).plan(e.plan);
      if (e.phys) emitSub(e.phys, 2);
    }
    if (opts.analyze && plan.io) {
      out.push('Simulated I/O: ' + plan.io.reads + ' page reads, ' + plan.io.writes + ' page writes, ' + plan.io.seeks + ' seeks, ' + plan.io.ms.toFixed(2) + ' ms on the ' + (session ? session.db.disk.model.name : 'disk'));
      out.push('Buffer pool: ' + plan.bufStats.hits + ' hits, ' + plan.bufStats.misses + ' misses, ' + plan.bufStats.evictions + ' evictions');
      out.push('Execution Time: ' + plan.totalMs.toFixed(3) + ' ms');
    }
    return out.join('\n');
  }

  K.Explain = { text, show, nameMap, describe };
  K.showExpr = show;
})(typeof window !== 'undefined' ? window : globalThis);
