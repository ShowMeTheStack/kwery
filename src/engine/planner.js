// The planner: a logical plan becomes a physical plan. It pushes predicates down, turns cross joins with
// equality conditions into joins, orders joins with dynamic programming over subsets (Selinger), and picks an
// algorithm for each operator by cost. Costs are counted in block transfers (tT) and seeks (tS), plus a small
// CPU cost per tuple; estimates come from the statistics ANALYZE gathers.
(function (root) {
  'use strict';
  const K = root.K;
  const S = K.STATE;
  const B = () => K.T.BASE;

  // cost units, in milliseconds of Kwery's default disk model (tS = 6 ms, tT = 0.15 ms for a 4 KB page); the CPU
  // costs and the small fixed costs below are in the same milliseconds
  const COST = { seek: 6, transfer: 0.15, cpuTuple: 0.00015, cpuOp: 0.000075, fixed: 0.75 };

  class Planner {
    constructor(session, binder) {
      this.s = session;
      this.db = session.db;
      this.b = binder;
      this.settings = session.settings;
      this.trace = [];             // what the optimizer considered, for the plan view
      // tS and tT come from the simulated disk, so estimated costs are in the same milliseconds the disk reports
      const m = this.db.disk.model;
      COST.transfer = (this.db.disk.pageSize / (m.mbps * 1e6)) * 1000;
      COST.seek = m.kind === 'ssd' ? m.latencyMs : m.seekMs + m.rotMs;
    }
    plan(node) {
      let p = this.rewrite(node);
      // the columns anything reads, so an index holding all of them can answer a scan alone
      this.used = this.usedColumns(p);
      p = this.physical(p);
      if (this.settings.enable_column_pruning !== false) this.prune(p);
      return p;
    }
    /** the column ids that some expression in the plan (or its output) reads */
    usedColumns(root) {
      const used = new Set();
      const seen = new Set();
      const SKIP = new Set(['cols', 'rel', 'index', 'type', 'ctype', 'def', 'rt', 'alternatives', 'children', 'fn', 'udf', 'srfs', 'keyTypes', 'scanCols']);
      const walk = (x) => {
        if (!x || typeof x !== 'object' || seen.has(x)) return;
        seen.add(x);
        if (Array.isArray(x)) { x.forEach(walk); return; }
        if (x instanceof Map || x instanceof Set || x instanceof Uint8Array) return;
        if (x.k === 'col' && x.id !== undefined) used.add(x.id);
        if (x.op && x.cols) { for (const ch of x.children || []) walk(ch); if (x.op === 'Modify' && x.scanCols) for (const c of x.scanCols) used.add(c.id); if (x.ctidId) used.add(x.ctidId); if (x.cte) { walk(x.cte.phys); walk(x.cte.plan); } }
        for (const k of Object.keys(x)) if (!SKIP.has(k) && k !== 'cte') walk(x[k]);
      };
      walk(root);
      for (const c of root.cols || []) used.add(c.id);
      return used;
    }
    /** each scan learns which of its columns anything above reads, so the others are never decoded */
    prune(root) {
      const used = this.usedColumns(root);
      const scans = [];
      const find = (n) => { if (!n || !n.op) return; if (/Scan$/.test(n.op) && n.rel && n.op !== 'CteScan') scans.push(n); for (const ch of n.children || []) find(ch); if (n.cte && n.cte.phys && !n.cte.pruneSeen) { n.cte.pruneSeen = true; find(n.cte.phys); } };
      find(root);
      // subqueries inside expressions have their own plans: their scans are pruned when those are planned
      for (const n of scans) {
        const need = new Set();
        for (const c of n.cols) if (c.attnum !== undefined && used.has(c.id)) need.add(c.attnum);
        // an index scan rechecks the index condition on the heap row: its key columns must be decoded too
        let all = false;
        for (const ix of (n.index ? [n.index] : []).concat((n.indexes || []).map((x) => x.index))) for (const k of ix.keys) { if (k.attnum === undefined) all = true; else need.add(k.attnum); }
        if (all) continue;
        if (need.size === n.cols.filter((c) => c.attnum !== undefined).length) continue;
        need.last = need.size ? Math.max(...need) : -1;
        n.need = need;
      }
    }

    // ---- logical rewriting --------------------------------------------------------------------------------------
    rewrite(n) {
      if (!n) return n;
      n.children = (n.children || []).map((c) => this.rewrite(c));
      if (n.op === 'Filter') {
        const d = this.settings.enable_decorrelation === false ? n : this.decorrelate(n);
        return d.op === 'Filter' ? this.pushFilter(d) : d;
      }
      return n;
    }
    /**
     * WHERE EXISTS (correlated subquery) becomes a semijoin, NOT EXISTS an antijoin, and x IN (subquery) a semijoin
     * on x = the subquery's column, when the subquery is a plain selection over its FROM items: the subquery then
     * runs once as a join input instead of once per outer row
     */
    decorrelate(f) {
      const preds = this.conjuncts(f.cond);
      let child = f.children[0];
      const rest = [];
      for (const p of preds) {
        let sub = p, neg = false;
        if (p.k === 'not' && p.e.k === 'sub' && p.e.kind === 'exists') { sub = p.e; neg = true; }
        const j = sub.k === 'sub' && !sub.outerMap && (sub.kind === 'exists' || (sub.kind === 'in' && !sub.neg && !sub.rowTest)) ? this.asJoin(sub, child) : null;
        if (!j) { rest.push(p); continue; }
        this.trace.push({ what: 'subquery rewritten as a ' + (neg ? 'antijoin' : 'semijoin'), note: (neg ? 'NOT EXISTS' : sub.kind === 'in' ? 'IN' : 'EXISTS') + ' (…) runs once, as the inner input of a join, instead of once per row' });
        child = { op: 'Join', jtype: neg ? 'anti' : 'semi', children: [child, j.inner], cond: j.cond, cols: child.cols, decorrelated: true };
      }
      if (!rest.length) return child;
      return { op: 'Filter', cond: this.and(rest), children: [child], cols: child.cols, where: f.where, having: f.having };
    }
    asJoin(sub, outer) {
      let n = sub.plan;
      let exprs = null;
      // peel off the projection (and, for EXISTS, a LIMIT, which does not change whether a row exists)
      for (;;) {
        if (n.op === 'Project') { if (!exprs) exprs = n.exprs; n = n.children[0]; continue; }
        if (n.op === 'Limit' && sub.kind === 'exists' && !n.offset && (!n.limit || n.limit.k === 'const' && (n.limit.v === null || Number(n.limit.v) > 0))) { n = n.children[0]; continue; }
        break;
      }
      let conds = [];
      if (n.op === 'Filter') { conds = this.conjuncts(n.cond); n = n.children[0]; }
      const plain = (x) => x.op === 'Scan' || x.op === 'Subquery' && !x.lateral || (x.op === 'Join' && ['inner', 'cross'].includes(x.jtype) && x.children.every(plain)) || (x.op === 'Filter' && plain(x.children[0]));
      if (!plain(n)) return null;
      const outerIds = this.ids(outer);
      const refs = sub.outerRefs || [];
      if (refs.some((id) => !outerIds.has(id))) return null;
      // inner conditions that mention the outer row join the two; the others filter the inner side
      const corr = [], local = [];
      for (const c of conds) { const used = this.usesIds(c); if ([...used].some((id) => outerIds.has(id))) corr.push(c); else local.push(c); }
      if (this.hasSubCorrelation(n, outerIds)) return null;
      let inner = local.length ? { op: 'Filter', cond: this.and(local), children: [n], cols: n.cols } : n;
      if (sub.kind === 'in') {
        if (!exprs || !exprs[0]) return null;
        const e = K.Expr.coerce(exprs[0], sub.ctype, true);
        corr.push({ k: 'cmp', op: '=', l: sub.test, r: e, ctype: sub.ctype, type: B().bool });
      }
      if (!corr.length && sub.kind === 'exists' && refs.length) return null;
      return { inner, cond: this.and(corr) };
    }
    /** does anything below (a nested subquery, a lateral item) read the outer row? then it cannot become a join input */
    hasSubCorrelation(n, outerIds) {
      let found = false;
      const walkPlan = (x) => {
        if (!x || found) return;
        for (const k of ['cond', 'filter']) if (x[k]) this.b.walk(x[k], (e) => { if (e.k === 'sub' && (e.outerRefs || []).some((id) => outerIds.has(id))) found = true; }, true);
        if (x.exprs) for (const e of x.exprs) this.b.walk(e, (y) => { if (y.k === 'sub' && (y.outerRefs || []).some((id) => outerIds.has(id))) found = true; }, true);
        if (x.op === 'Subquery' && x.children[0].outerRefs && [...x.children[0].outerRefs].some((id) => outerIds.has(id))) found = true;
        (x.children || []).forEach(walkPlan);
      };
      walkPlan(n);
      return found;
    }
    /** the ANDed parts of a condition; a row equality (a, b) = (x, y) is the same as a = x AND b = y */
    conjuncts(e) { if (!e) return []; if (e.k === 'and') return e.items.flatMap((x) => this.conjuncts(x)); if (e.k === 'rowcmp' && e.op === '=') return e.eqs.flatMap((x) => this.conjuncts(x)); return [e]; }
    and(list) { if (!list.length) return null; if (list.length === 1) return list[0]; return { k: 'and', items: list, type: B().bool }; }
    /** the column ids an expression uses (not looking inside subqueries except for their outer references) */
    usesIds(e, acc) {
      acc = acc || new Set();
      this.b.walk(e, (x) => { if (x.k === 'col') acc.add(x.id); if (x.k === 'sub') for (const id of x.outerRefs || []) acc.add(id); }, true);
      return acc;
    }
    hasVolatile(e) { let v = false; this.b.walk(e, (x) => { if (x.k === 'call' && x.def.volatile || x.k === 'udf' && x.fn.volatility === 'volatile') v = true; }, true); return v; }
    ids(n) { return new Set(n.cols.map((c) => c.id)); }
    /** push a filter's conjuncts as far down as they can go */
    pushFilter(f) {
      const preds = this.conjuncts(f.cond);
      const child = f.children[0];
      const rest = [];
      let c = child;
      for (const p of preds) { const r = this.pushInto(c, p); if (r) c = r; else rest.push(p); }
      return rest.length ? { op: 'Filter', cond: this.and(rest), children: [c], cols: c.cols, where: f.where, having: f.having } : c;
    }
    /** try to push predicate p into node n; returns the new node, or null if it must stay above n */
    pushInto(n, p) {
      if (this.hasVolatile(p)) return null;
      const used = this.usesIds(p);
      const has = (node) => [...used].every((id) => this.ids(node).has(id) || !this.anyHas(n, id));
      if (n.op === 'Join') {
        const [l, r] = n.children;
        const inL = [...used].every((id) => !this.ids(r).has(id));
        const inR = [...used].every((id) => !this.ids(l).has(id));
        const jt = n.jtype;
        if (inL && (jt === 'inner' || jt === 'cross' || jt === 'left' || jt === 'semi' || jt === 'anti')) { n.children[0] = this.pushInto(l, p) || { op: 'Filter', cond: p, children: [l], cols: l.cols }; return n; }
        if (inR && (jt === 'inner' || jt === 'cross' || jt === 'right')) { n.children[1] = this.pushInto(r, p) || { op: 'Filter', cond: p, children: [r], cols: r.cols }; return n; }
        if (jt === 'inner' || jt === 'cross') { n.cond = this.and(this.conjuncts(n.cond).concat([p])); if (n.jtype === 'cross') n.jtype = 'inner'; return n; }
        return null;
      }
      if (n.op === 'Filter') { n.cond = this.and(this.conjuncts(n.cond).concat([p])); return n; }
      if (n.op === 'Scan' || n.op === 'Values' || n.op === 'Func' || n.op === 'CteScan' || n.op === 'WorkTable') {
        if (!has(n)) return null;
        return { op: 'Filter', cond: p, children: [n], cols: n.cols };
      }
      if (n.op === 'Subquery' && !n.view?.securityBarrier) {
        // through a subquery in FROM: rename columns to the inner query's ids, if the inner query allows it
        const inner = n.children[0];
        if (!this.pushable(inner)) return null;
        const map = new Map(n.cols.map((c) => [c.id, c.src]));
        const innerCols = new Map(inner.cols.map((c) => [c.id, c]));
        const q = this.b.mapExpr(p, (x) => (x.k === 'col' && map.has(x.id) ? Object.assign({}, x, { id: map.get(x.id) }) : null));
        // the inner query must output those columns directly (a projection: substitute the expressions)
        const proj = this.topProject(inner);
        if (proj) {
          const exprOf = new Map(proj.cols.map((c, i) => [c.id, proj.exprs[i]]));
          if ([...this.usesIds(q)].some((id) => exprOf.has(id) && (this.hasVolatile(exprOf.get(id)) || this.hasAggOrWin(exprOf.get(id))))) return null;
          const q2 = this.b.mapExpr(q, (x) => (x.k === 'col' && exprOf.has(x.id) ? exprOf.get(x.id) : null));
          const below = proj.children[0];
          proj.children[0] = this.pushInto(below, q2) || { op: 'Filter', cond: q2, children: [below], cols: below.cols };
          void innerCols;
          return n;
        }
        return null;
      }
      return null;
    }
    anyHas(n, id) { return n.cols.some((c) => c.id === id); }
    pushable(n) { return n.op === 'Project' && !n.into && n.children[0] && !['Limit', 'Distinct', 'Window', 'Aggregate', 'SetOp', 'Sort'].includes(n.children[0].op) && !this.anyHasLimit(n); }
    anyHasLimit(n) { return n.op === 'Limit'; }
    topProject(n) { return n.op === 'Project' ? n : null; }
    hasAggOrWin(e) { let f = false; this.b.walk(e, (x) => { if (x.k === 'aggcall' || x.k === 'wincall' || x.k === 'sub') f = true; }, true); return f; }

    // ---- physical planning ------------------------------------------------------------------------------------------
    physical(n) {
      switch (n.op) {
        case 'Scan': return this.scanPath(n, []);
        case 'Filter': {
          const c = n.children[0];
          if (c.op === 'Scan') return this.scanPath(c, this.conjuncts(n.cond));
          if (c.op === 'Join' && this.joinable(c)) return this.joinTree(c, this.conjuncts(n.cond));
          const ch = this.physical(c);
          return this.est({ op: 'Filter', cond: n.cond, children: [ch], cols: ch.cols, where: n.where, having: n.having }, ch.rows * this.selectivity(n.cond, ch), ch.cost + ch.rows * COST.cpuOp);
        }
        case 'Join': if (this.joinable(n)) return this.joinTree(n, []); return this.joinNode(n);
        case 'Project': { const ch = this.physical(n.children[0]); return Object.assign({}, n, { children: [ch], rows: ch.rows, cost: ch.cost + ch.rows * COST.cpuOp * n.exprs.length, width: ch.width }); }
        case 'Aggregate': return this.aggPath(n);
        case 'Sort': return this.sortPath(n);
        case 'Distinct': return this.distinctPath(n);
        case 'Limit': { const ch = this.physical(n.children[0]); return Object.assign({}, n, { children: [ch], rows: Math.min(ch.rows, n.limit && n.limit.k === 'const' && n.limit.v !== null ? Number(n.limit.v) : ch.rows), cost: ch.cost }); }
        case 'SetOp': { const ch = n.children.map((c) => this.physical(c)); const rows = n.setop === 'union' ? ch[0].rows + ch[1].rows : n.setop === 'intersect' ? Math.min(ch[0].rows, ch[1].rows) : ch[0].rows; return Object.assign({}, n, { children: ch, rows, cost: ch[0].cost + ch[1].cost + (ch[0].rows + ch[1].rows) * COST.cpuTuple, alg: n.all && n.setop === 'union' ? 'append' : 'hash' }); }
        case 'Window': {
          // the input's columns may come in another order once its joins are reordered: the window's output is the
          // input row followed by the window values, so its columns must follow the planned input's order
          const ch = this.physical(n.children[0]);
          return Object.assign({}, n, { children: [ch], cols: ch.cols.concat(n.cols.slice(n.children[0].cols.length)), rows: ch.rows, cost: ch.cost + ch.rows * Math.log2(ch.rows + 2) * COST.cpuOp });
        }
        default: {
          const ch = (n.children || []).map((c) => this.physical(c));
          const out = Object.assign({}, n, { children: ch });
          if (n.op === 'Values') return this.est(out, n.tuples.length, n.tuples.length * COST.cpuTuple);
          if (n.op === 'Result') return this.est(out, 1, 0);
          if (n.op === 'Func') return this.est(out, n.calls.reduce((a, c) => Math.max(a, c.estRows || 100), 1), COST.fixed / 5);
          if (n.op === 'CteScan') { if (!n.cte.phys) n.cte.phys = this.physical(this.rewrite(n.cte.plan)); return this.est(out, n.cte.phys.rows || 100, COST.fixed * 2); }
          if (n.op === 'WorkTable') return this.est(out, 100, COST.fixed * 2);
          if (n.op === 'Subquery') return this.est(out, ch[0].rows, ch[0].cost);
          if (n.op === 'RecursiveUnion') return this.est(out, ch[0].rows * 10, ch[0].cost + ch[1].cost * 10);
          return this.est(out, ch[0] ? ch[0].rows : 1, ch[0] ? ch[0].cost : 0);
        }
      }
    }
    est(n, rows, cost) { n.rows = Math.max(1, Math.round(rows)); n.cost = cost; return n; }
    joinable(n) { return n.op === 'Join' && (n.jtype === 'inner' || n.jtype === 'cross'); }

    // ---- statistics and selectivity ----------------------------------------------------------------------------------
    relStats(rel) {
      const pages = Math.max(1, this.db.disk.blocks(rel.file));
      const st = this.db.statsOf(rel);
      const live = this.db.liveOf(rel);
      const rows = st && st.rows !== undefined ? Math.max(st.rows, live) : Math.max(live, 1);
      return { rows, pages, cols: st ? st.cols : null };
    }
    colStats(id, node) {
      // find which scan produced column id, and its statistics
      const find = (n) => {
        if (!n) return null;
        if (n.op === 'Scan' || n.op === 'SeqScan' || n.op === 'IndexScan' || n.op === 'IndexOnlyScan' || n.op === 'BitmapScan') { const c = n.cols.find((x) => x.id === id); const rs = c && this.db.statsOf(n.rel); if (rs && rs.cols) return { st: rs.cols[c.attnum], rows: this.relStats(n.rel).rows }; if (c) return { st: null, rows: this.relStats(n.rel).rows }; }
        for (const ch of n.children || []) { const r = find(ch); if (r) return r; }
        return null;
      };
      return find(node);
    }
    /** is the column the whole key of a unique index of its table? */
    uniqueCol(id, node) {
      const find = (n) => { if (!n) return null; if (n.rel && n.cols && (n.op === 'Scan' || /Scan$/.test(n.op))) { const c = n.cols.find((x) => x.id === id); if (c) return { rel: n.rel, attnum: c.attnum }; } for (const ch of n.children || []) { const r = find(ch); if (r) return r; } return null; };
      const f = find(node);
      if (!f || f.attnum === undefined) return false;
      return this.db.catalogOf({ session: this.s }).indexesOf(f.rel).some((ix) => ix.unique && ix.keys.length === 1 && ix.keys[0].attnum === f.attnum && !ix.where);
    }
    /** the selectivity of several conditions together: ranges on one column are combined (lo < x < hi), others multiplied */
    selectivityAll(list, node) {
      const byCol = new Map(), rest = [];
      for (const p of list) {
        const r = this.rangeOf(p);
        if (r) { if (!byCol.has(r.id)) byCol.set(r.id, { col: r.col, lo: null, hi: null }); const g = byCol.get(r.id); if (r.lo !== undefined) { g.lo = r.lo; g.loIncl = r.incl; } if (r.hi !== undefined) { g.hi = r.hi; g.hiIncl = r.incl; } }
        else rest.push(p);
      }
      let s = rest.reduce((a, p) => a * this.selectivity(p, node), 1);
      for (const g of byCol.values()) {
        const c = this.colStats(g.col.id, node);
        const st = c && c.st;
        // x >= lo keeps what is not below lo; x <= hi keeps what is below hi or equal to it
        const lo = g.lo === null ? 0 : this.belowFrac(st, g.lo, g.col.type, !g.loIncl), hi = g.hi === null ? (st ? 1 - st.nullFrac : 1) : this.belowFrac(st, g.hi, g.col.type, g.hiIncl);
        s *= lo === null || hi === null ? (g.lo !== null && g.hi !== null ? 0.005 : 1 / 3) : Math.max(0.0001, hi - lo);
      }
      return s;
    }
    /** x > c, x >= c, x < c, x <= c as a bound on column x */
    rangeOf(p) {
      if (p.k !== 'cmp' || !['<', '<=', '>', '>='].includes(p.op)) return null;
      const colL = p.l.k === 'col' && p.r.k === 'const' && p.r.v !== null, colR = p.r.k === 'col' && p.l.k === 'const' && p.l.v !== null;
      if (!colL && !colR) return null;
      const col = colL ? p.l : p.r, v = colL ? p.r.v : p.l.v;
      const lower = colL ? p.op[0] === '>' : p.op[0] === '<';
      const incl = p.op.length === 2;
      return { id: col.id, col, lo: lower ? v : undefined, hi: lower ? undefined : v, incl };
    }
    /**
     * the fraction of rows whose value is below v (or at most v): the most common values below it, plus the share of
     * the histogram below it times the rows the histogram describes, as PostgreSQL's scalarineqsel does; null when
     * there are no statistics to go on
     */
    belowFrac(st, v, type, incl) {
      if (!st) return null;
      const mcv = st.mcv || [];
      const mcvSum = mcv.reduce((a, x) => a + x.freq, 0);
      const mcvBelow = mcv.reduce((a, x) => { const c = K.T.compare(x.v, v, type); return a + (c < 0 || (incl && c === 0) ? x.freq : 0); }, 0);
      const rest = Math.max(0, 1 - st.nullFrac - mcvSum);
      if (st.hist && st.hist.length > 1) return mcvBelow + this.histFrac(st.hist, v, type) * rest;
      return mcv.length ? mcvBelow + rest / 2 : null;
    }
    /** the fraction of values below v in an equi-depth histogram, interpolating inside the bucket for numbers */
    histFrac(h, v, type) {
      if (K.T.compare(v, h[0], type) <= 0) return 0;
      if (K.T.compare(v, h[h.length - 1], type) >= 0) return 1;
      let i = 1; while (i < h.length && K.T.compare(h[i], v, type) < 0) i++;
      const a = h[i - 1], b = h[i];
      let within = 0.5;
      const num = (x) => (typeof x === 'number' ? x : typeof x === 'bigint' ? Number(x) : x instanceof K.Decimal ? Number(x.toString()) : x && x.days !== undefined ? x.days : x && x.us !== undefined ? x.us : null);
      const na = num(a), nb = num(b), nv = num(v);
      if (na !== null && nb !== null && nv !== null && nb > na) within = (nv - na) / (nb - na);
      return (i - 1 + within) / (h.length - 1);
    }
    /** the fraction of rows a predicate keeps, from histograms and distinct counts where ANALYZE has them */
    selectivity(e, node) {
      if (!e) return 1;
      switch (e.k) {
        case 'and': return this.selectivityAll(e.items, node);
        case 'or': return Math.min(1, 1 - e.items.reduce((a, x) => a * (1 - this.selectivity(x, node)), 1));
        case 'not': return 1 - this.selectivity(e.e, node);
        case 'isnull': { const c = e.e.k === 'col' && this.colStats(e.e.id, node); const nf = c && c.st ? c.st.nullFrac : 0.005; return e.neg ? 1 - nf : nf; }
        case 'cmp': {
          const col = e.l.k === 'col' ? e.l : e.r.k === 'col' ? e.r : null;
          const other = col === e.l ? e.r : e.l;
          if (col && (other.k === 'col')) { const a = this.colStats(e.l.id, node), b = this.colStats(e.r.id, node); const nd = Math.max(a && a.st ? a.st.ndistinct : 200, b && b.st ? b.st.ndistinct : 200); return e.op === '=' ? 1 / nd : e.op === '<>' ? 1 - 1 / nd : 1 / 3; }
          if (!col) return e.op === '=' ? 0.005 : 1 / 3;
          const c = this.colStats(col.id, node);
          const st = c && c.st;
          if (e.op === '=' && this.uniqueCol(col.id, node)) return 1 / Math.max(1, c ? c.rows : 1);
          if (other.k !== 'const') return e.op === '=' ? (st ? 1 / Math.max(1, st.ndistinct) : 0.005) : 1 / 3;
          const v = other.v;
          if (e.op === '=' || e.op === '<>') {
            let s;
            if (st) { const m = st.mcv && st.mcv.find((x) => K.T.compare(x.v, v, col.type) === 0); s = m ? m.freq : (1 - st.nullFrac - (st.mcv || []).reduce((a, x) => a + x.freq, 0)) / Math.max(1, st.ndistinct - (st.mcv || []).length); }
            else s = 0.005;
            return e.op === '=' ? Math.max(s, 1e-6) : 1 - s;
          }
          if (st && st.hist && st.hist.length > 1) {
            // equi-depth histogram: the fraction of the values below v
            const frac = this.histFrac(st.hist, v, col.type);
            const lt = col === e.l ? e.op.startsWith('<') : e.op.startsWith('>');
            return Math.max(lt ? frac : 1 - frac, 0.0001);
          }
          return 1 / 3;
        }
        case 'like': return e.neg ? 0.9 : 0.05;
        case 'inlist': {
          // x IN (a, b, ...) is x = a OR x = b ...: the equalities' selectivities add up
          const eq = e.e && e.e.k === 'col' ? e.items.reduce((a, it) => a + (it.k === 'const' ? this.selectivity({ k: 'cmp', op: '=', l: e.e, r: it }, node) : 0.005), 0) : e.items.length * 0.005;
          return Math.max(0, Math.min(1, e.neg ? 1 - eq : eq));
        }
        case 'sub': return 0.5;
        case 'const': return e.v === false || e.v === null ? 0 : 1;
      }
      return 0.33;
    }

    // ---- access paths ---------------------------------------------------------------------------------------------------
    /** a scan with its predicates: a sequential scan, or an index scan, bitmap scan or index-only scan if cheaper */
    scanPath(scan, preds) {
      preds = preds.map((p) => this.uncastInts(p));
      const rel = scan.rel;
      const st = this.relStats(rel);
      const sel = this.selectivityAll(preds, scan);
      const seqCost = COST.seek + st.pages * COST.transfer + st.rows * COST.cpuTuple + st.rows * preds.length * COST.cpuOp;
      const seq = this.est({ op: 'SeqScan', rel, alias: scan.alias, cols: scan.cols, sys: scan.sys, filter: this.and(preds), children: [], sample: scan.sample }, st.rows * sel, seqCost);
      const options = [seq];
      if (this.settings.enable_indexscan !== false) for (const idx of this.indexesOf(rel)) {
        if (idx.invalid) continue;
        const m = this.matchIndex(idx, scan, preds);
        if (!m) continue;
        // equality on every column of a unique index finds at most one row
        if (idx.unique && m.bounds.length === idx.keys.length && m.bounds.every((x) => x.op === '=')) m.sel = Math.min(m.sel, 1 / Math.max(1, st.rows));
        const isel = m.sel;
        const height = this.indexHeight(idx);
        const matches = st.rows * isel;
        // index scan: descend the tree, then one fetch per matching row (a seek each, unless the table is clustered on this index)
        // rows stored in the index's order are fetched almost sequentially: interpolate between one seek per row and a
        // sequential read of the pages holding them, by the square of the correlation (as PostgreSQL's cost model does)
        const ks = idx.keys[0] && idx.keys[0].attnum !== undefined && st.cols && st.cols[idx.keys[0].attnum];
        const corr = idx.clustered ? 1 : ks && ks.correlation !== undefined ? ks.correlation : 0;
        const randomFetch = matches * (COST.seek + COST.transfer), seqFetch = COST.seek + Math.ceil(isel * st.pages) * COST.transfer;
        const fetchCost = randomFetch + corr * corr * (seqFetch - randomFetch);
        const idxCost = (SPATIAL.has(idx.method) ? this.spatialPages(idx, isel, st.rows) : height + 1 + Math.ceil(matches / 100) * COST.transfer / (COST.seek + COST.transfer)) * (COST.seek + COST.transfer) + fetchCost + matches * COST.cpuTuple;
        const rest = preds.filter((p) => !m.used.includes(p));
        const covering = this.covers(idx, scan, rest);
        options.push(this.est({ op: covering && this.settings.enable_indexonlyscan !== false ? 'IndexOnlyScan' : 'IndexScan', rel, alias: scan.alias, cols: scan.cols, sys: scan.sys, index: idx, bounds: m.bounds, filter: this.and(rest), dir: m.dir || 'forward', children: [] }, st.rows * sel, covering ? idxCost - fetchCost + Math.ceil(matches / 100) * COST.transfer : idxCost));
        // bitmap scan: collect matching TIDs, sort by block, read each block once
        if (idx.method === 'btree' || idx.method === 'hash' || idx.method === 'bitmap') {
          const blocks = Math.min(st.pages, matches);
          // heap blocks are read in block order: nearly sequential when many are needed, one seek each when few are
          const bmCost = (height + 1) * (COST.seek + COST.transfer) + blocks * (COST.seek * (blocks / st.pages > 0.3 ? 0.5 : 1) + COST.transfer) + matches * COST.cpuTuple * 2 + COST.fixed;
          if (this.settings.enable_bitmapscan !== false) options.push(this.est({ op: 'BitmapScan', rel, alias: scan.alias, cols: scan.cols, sys: scan.sys, indexes: [{ index: idx, bounds: m.bounds }], recheck: this.and(m.used), filter: this.and(rest), children: [] }, st.rows * sel, bmCost));
        }
      }
      // BitmapAnd: two or more indexes on different conditions, their TID sets intersected before the heap is read
      const bm = options.filter((o) => o.op === 'BitmapScan');
      if (bm.length >= 2 && this.settings.enable_bitmapscan !== false) {
        const pick = [];
        for (const o of bm.sort((x, y) => x.rows - y.rows)) if (!pick.some((q) => q.indexes[0].index.oid === o.indexes[0].index.oid) && !pick.some((q) => this.b.key(q.recheck) === this.b.key(o.recheck))) pick.push(o);
        if (pick.length >= 2) {
          const used = pick.flatMap((o) => this.conjuncts(o.recheck));
          const sel2 = used.reduce((a, q) => a * this.selectivity(q, scan), 1);
          const matches = st.rows * sel2;
          const blocks = Math.min(st.pages, matches);
          const cost = pick.reduce((a, o) => a + (this.indexHeight(o.indexes[0].index) + 1) * (COST.seek + COST.transfer), 0) + blocks * (COST.seek * (blocks / st.pages > 0.3 ? 0.5 : 1) + COST.transfer) + matches * COST.cpuTuple * 2 + COST.fixed * pick.length;
          const rest = preds.filter((q) => !used.includes(q));
          options.push(this.est({ op: 'BitmapScan', rel, alias: scan.alias, cols: scan.cols, sys: scan.sys, indexes: pick.map((o) => o.indexes[0]), recheck: this.and(used), filter: this.and(rest), children: [], bitmapAnd: true }, st.rows * sel, cost));
        }
      }
      // BitmapOr: an OR whose every arm some index can answer; the arms' TID sets are united, then the heap is
      // read once in block order and the whole OR rechecked
      if (this.settings.enable_bitmapscan !== false) for (const p of preds) {
        if (p.k !== 'or') continue;
        const arms = [];
        for (const arm of p.items) {
          const cs = this.conjuncts(arm);
          let best = null;
          for (const idx of this.indexesOf(rel)) {
            if (idx.invalid || !['btree', 'hash', 'bitmap'].includes(idx.method)) continue;
            const m = this.matchIndex(idx, scan, cs);
            if (m && (!best || m.sel < best.m.sel)) best = { idx, m };
          }
          if (!best) { arms.length = 0; break; }
          arms.push(best);
        }
        if (!arms.length) continue;
        const matches = st.rows * this.selectivity(p, scan);
        const blocks = Math.min(st.pages, matches);
        const cost = arms.reduce((a, x) => a + (this.indexHeight(x.idx) + 1) * (COST.seek + COST.transfer) + Math.ceil(st.rows * x.m.sel / 100) * COST.transfer, 0) + blocks * (COST.seek * (blocks / st.pages > 0.3 ? 0.5 : 1) + COST.transfer) + matches * COST.cpuTuple * 2 + COST.fixed * arms.length;
        options.push(this.est({ op: 'BitmapScan', rel, alias: scan.alias, cols: scan.cols, sys: scan.sys, indexes: arms.map((x) => ({ index: x.idx, bounds: x.m.bounds })), recheck: p, filter: this.and(preds.filter((q) => q !== p)), children: [], bitmapOr: true }, st.rows * sel, cost));
      }
      if (this.settings.enable_seqscan === false && options.length > 1) options.shift();
      options.sort((a, b) => a.cost - b.cost);
      const best = options[0];
      this.trace.push({ what: 'access paths for ' + rel.name, options: options.map((o) => ({ op: o.op, index: o.index ? o.index.name : o.indexes ? o.indexes[0].index.name : null, cost: o.cost, rows: o.rows })) });
      best.alternatives = options.slice(1).map((o) => ({ op: o.op, cost: o.cost, index: o.index ? o.index.name : null }));
      return best;
    }
    /**
     * the pages an R-tree search reads: at each level, the nodes whose rectangles meet the query window. A node's
     * rectangle is about as wide as 1/sqrt(nodes) of each axis, so it meets a window of side w with probability
     * (w + 1/sqrt(nodes))^2 (the window grown by the node's extent); nodes are taken as 70% full
     */
    spatialPages(idx, sel, rows) {
      let M = 50, levels = 3;
      try { const m = this.db.indexAm(idx, this.s.catalog).meta(); M = m.maxE || M; levels = m.levels || levels; } catch (e) { /* estimated */ }
      const axes = idx.keys.length === 1 ? 1 : 2, w = Math.pow(Math.max(sel, 1e-12), 1 / axes);
      let pages = 0, nodes = Math.max(1, rows / (0.7 * M));
      for (let l = 0; l < levels; l++) {
        pages += Math.min(nodes, Math.max(1, nodes * Math.pow(Math.min(1, w + Math.pow(1 / nodes, 1 / axes)), axes)));
        nodes = Math.max(1, nodes / (0.7 * M));
      }
      return pages;
    }
    /**
     * a column of a narrower integer type compared with a wider integer is widened by an implicit cast; integers
     * compare by value whatever their width (PostgreSQL has cross-type operators for them), so the cast is dropped
     * and the column can use its index and its statistics
     */
    uncastInts(p) {
      const w = (x) => (x && x.k === 'cast' && !x.explicit && x.e.k === 'col' && INTS.has(x.type.id) && INTS.has(x.e.type.id) ? x.e : x);
      if (p.k === 'cmp') { const l = w(p.l), r = w(p.r); return l === p.l && r === p.r ? p : Object.assign({}, p, { l, r }); }
      if (p.k === 'inlist') { const e = w(p.e); return e === p.e ? p : Object.assign({}, p, { e }); }
      if (p.k === 'or' || p.k === 'and') { const items = p.items.map((x) => this.uncastInts(x)); return items.every((x, i) => x === p.items[i]) ? p : Object.assign({}, p, { items }); }
      return p;
    }
    /** which predicates an index can use: equality on a prefix of its keys, then one range */
    matchIndex(idx, scan, preds) {
      const colOf = (id) => scan.cols.find((c) => c.id === id);
      const bounds = [];
      const used = [];
      let sel = 1;
      for (let k = 0; k < idx.keys.length; k++) {
        const key = idx.keys[k];
        if (key.attnum === undefined) break;
        const eq = preds.find((p) => p.k === 'cmp' && p.op === '=' && this.isKeyCmp(p, key.attnum, colOf));
        if (eq) { const v = this.cmpConst(eq, key.attnum, colOf); bounds.push({ k, op: '=', v: v.e }); used.push(eq); sel *= this.selectivity(eq, scan); continue; }
        const inl = preds.find((p) => p.k === 'inlist' && !p.neg && p.e.k === 'col' && colOf(p.e.id) && colOf(p.e.id).attnum === key.attnum);
        if (inl && idx.method !== 'hash' && k === 0) { bounds.push({ k, op: 'in', v: inl.items }); used.push(inl); sel *= this.selectivity(inl, scan); break; }
        if (idx.method === 'hash') break;
        const ranges = preds.filter((p) => p.k === 'cmp' && ['<', '<=', '>', '>='].includes(p.op) && this.isKeyCmp(p, key.attnum, colOf));
        for (const r of ranges) { const v = this.cmpConst(r, key.attnum, colOf); bounds.push({ k, op: v.flip ? flipOp(r.op) : r.op, v: v.e }); used.push(r); }
        if (ranges.length) sel *= this.selectivityAll(ranges, scan);
        const isn = preds.find((p) => p.k === 'isnull' && p.e.k === 'col' && colOf(p.e.id) && colOf(p.e.id).attnum === key.attnum);
        if (isn && !ranges.length) { bounds.push({ k, op: isn.neg ? 'notnull' : 'isnull' }); used.push(isn); sel *= this.selectivity(isn, scan); }
        // a spatial index searches a box: conditions on every one of its columns help, not only a prefix
        if (!SPATIAL.has(idx.method)) break;
      }
      if (!used.length) return null;
      if (idx.method === 'hash' && !(bounds.length === idx.keys.length && bounds.every((b) => b.op === '='))) return null;
      if (idx.where && !preds.some((p) => this.b.key(p) === this.b.key(idx.whereBound || {}))) { /* a partial index must be implied by the query; checked loosely */ if (!idx.whereImplied || !idx.whereImplied(preds)) return null; }
      return { bounds, used, sel };
    }
    isKeyCmp(p, attnum, colOf) {
      const side = (x) => x.k === 'col' && colOf(x.id) && colOf(x.id).attnum === attnum;
      const constish = (x) => x.k === 'const' || x.k === 'param' || (x.k === 'cast' && constishDeep(x)) || x.k === 'col' && !colOf(x.id) || x.k === 'sub' && !x.outerRefs.length || x.k === 'call' && !x.def.volatile && x.args.every((a) => constishDeep(a));
      const constishDeep = (x) => x.k === 'const' || x.k === 'param' || x.k === 'col' && !colOf(x.id) || (x.k === 'cast' && constishDeep(x.e)) || x.k === 'call' && x.args.every(constishDeep);
      return (side(p.l) && constish(p.r)) || (side(p.r) && constish(p.l));
    }
    cmpConst(p, attnum, colOf) { const lIsCol = p.l.k === 'col' && colOf(p.l.id) && colOf(p.l.id).attnum === attnum; return { e: lIsCol ? p.r : p.l, flip: !lIsCol }; }
    covers(idx, scan, rest) {
      const keyAtts = new Set(idx.keys.map((k) => k.attnum).concat(idx.include || []));
      // only the columns something reads must be in the index (all of them when that is not known)
      const need = scan.cols.filter((c) => !this.used || this.used.has(c.id));
      return need.every((c) => c.attnum !== undefined && keyAtts.has(c.attnum)) && rest.every((p) => [...this.usesIds(p)].every((id) => { const c = scan.cols.find((x) => x.id === id); return !c || keyAtts.has(c.attnum); }));
    }

    // ---- joins ----------------------------------------------------------------------------------------------------------
    /** collect the relations and predicates of a tree of inner joins */
    flattenJoins(n, rels, preds) {
      if (this.joinable(n)) { for (const c of n.children) this.flattenJoins(c, rels, preds); preds.push(...this.conjuncts(n.cond)); return; }
      if (n.op === 'Filter' && n.children[0].op === 'Scan') { rels.push({ node: n.children[0], preds: this.conjuncts(n.cond) }); return; }
      rels.push({ node: n, preds: [] });
    }
    /** join order by dynamic programming over subsets of relations (left-deep and bushy plans) */
    joinTree(n, extra) {
      const items = [], preds = extra.slice();
      this.flattenJoins(n, items, preds);
      // predicates that touch one relation go into its access path
      const idsOf = items.map((it) => this.ids(it.node));
      const local = items.map(() => []);
      const joinPreds = [];
      for (const p of preds) {
        const used = this.usesIds(p);
        const owners = items.map((_, i) => i).filter((i) => [...used].some((id) => idsOf[i].has(id)));
        if (owners.length === 1 && !this.hasVolatile(p)) local[owners[0]].push(p);
        else joinPreds.push({ p, owners: new Set(owners), used });
      }
      const base = items.map((it, i) => {
        const ps = it.preds.concat(local[i]);
        if (it.node.op === 'Scan') return this.scanPath(it.node, ps);
        const ch = this.physical(it.node);
        return ps.length ? this.est({ op: 'Filter', cond: this.and(ps), children: [ch], cols: ch.cols }, ch.rows * this.selectivity(this.and(ps), ch), ch.cost) : ch;
      });
      const nrel = base.length;
      // LATERAL items read columns of the items before them: they are joined in the written order, each by a
      // nested loop that runs the lateral side again for every row of the left side
      const lat = items.map((it) => this.lateralRefs(it.node));
      if (lat.some((r) => r.size)) {
        let acc = base[0];
        let mask = 1;
        for (let i = 1; i < nrel; i++) {
          const m2 = 1 << i;
          const conds = joinPreds.filter((j) => [...j.owners].every((o) => ((mask | m2) >> o) & 1) && [...j.owners].some((o) => (m2 >> o) & 1)).map((j) => j.p);
          const isLat = [...lat[i]].some((id) => this.ids(acc).has(id));
          acc = this.bestJoin(acc, base[i], conds, 'inner', null, isLat);
          mask |= m2;
        }
        const done = new Set();
        const mark = (q) => { if (!q) return; if (q.op && q.op.endsWith('Join') && q.cond) for (const c of this.conjuncts(q.cond)) done.add(c); (q.children || []).forEach(mark); };
        mark(acc);
        const left = joinPreds.map((j) => j.p).filter((q) => !done.has(q));
        return left.length ? this.est({ op: 'Filter', cond: this.and(left), children: [acc], cols: acc.cols }, acc.rows, acc.cost) : acc;
      }
      if (nrel === 1) { const jp = joinPreds.map((j) => j.p); return jp.length ? this.est({ op: 'Filter', cond: this.and(jp), children: [base[0]], cols: base[0].cols }, base[0].rows, base[0].cost) : base[0]; }
      const limit = this.settings.join_collapse_limit || 8;
      if (nrel > limit) {
        // too many to search exhaustively: join greedily in the written order
        let acc = base[0];
        let mask = 1;
        for (let i = 1; i < nrel; i++) {
          const m2 = 1 << i;
          const conds = joinPreds.filter((j) => [...j.owners].every((o) => ((mask | m2) >> o) & 1) && [...j.owners].some((o) => (m2 >> o) & 1)).map((j) => j.p);
          acc = this.bestJoin(acc, base[i], conds, 'inner');
          mask |= m2;
        }
        return acc;
      }
      const best = new Map();
      for (let i = 0; i < nrel; i++) best.set(1 << i, base[i]);
      const full = (1 << nrel) - 1;
      const connected = (a, b) => joinPreds.some((j) => [...j.owners].some((o) => (a >> o) & 1) && [...j.owners].some((o) => (b >> o) & 1));
      const considered = [];
      for (let size = 2; size <= nrel; size++) {
        for (let set = 1; set <= full; set++) {
          if (popcount(set) !== size) continue;
          let bestPlan = null;
          // every split of the set into two non-empty halves
          for (let a = (set - 1) & set; a > 0; a = (a - 1) & set) {
            const b = set ^ a;
            if (a < b && !this.settings.bushy) { /* both orders are tried by symmetry below */ }
            const pa = best.get(a), pb = best.get(b);
            if (!pa || !pb) continue;
            if (!this.settings.bushy && popcount(b) > 1 && popcount(a) > 1) continue; // left-deep only, unless bushy plans are on
            if (!connected(a, b) && size < nrel && joinPreds.length) continue; // avoid Cartesian products when possible
            const conds = joinPreds.filter((j) => [...j.owners].every((o) => (set >> o) & 1) && [...j.owners].some((o) => (a >> o) & 1) && [...j.owners].some((o) => (b >> o) & 1)).map((j) => j.p);
            const cand = this.bestJoin(pa, pb, conds, 'inner');
            if (!bestPlan || cand.cost < bestPlan.cost) bestPlan = cand;
          }
          if (bestPlan) { best.set(set, bestPlan); considered.push({ set: setNames(set, base), cost: bestPlan.cost, rows: bestPlan.rows, plan: bestPlan.op + ' ' + (bestPlan.alg || '') }); }
        }
      }
      // any set that could not be connected: fall back to a Cartesian product
      if (!best.has(full)) { let acc = base[0]; for (let i = 1; i < nrel; i++) acc = this.bestJoin(acc, base[i], [], 'inner'); best.set(full, acc); }
      this.trace.push({ what: 'join order (dynamic programming over ' + nrel + ' relations)', lattice: considered });
      const top = best.get(full);
      // predicates no join consumed (e.g. using three relations at once in a left-deep chain) stay on top
      const done = new Set();
      const mark = (p) => { if (!p) return; if (p.op && p.op.endsWith('Join') && p.cond) for (const c of this.conjuncts(p.cond)) done.add(c); (p.children || []).forEach(mark); };
      mark(top);
      const left = joinPreds.map((j) => j.p).filter((p) => !done.has(p));
      return left.length ? this.est({ op: 'Filter', cond: this.and(left), children: [top], cols: top.cols }, top.rows, top.cost) : top;
    }
    /** a join that is not reordered (outer joins, semi and anti joins) */
    joinNode(n) {
      const l = this.physical(n.children[0]), r = this.physical(n.children[1]);
      const isLat = [...this.lateralRefs(n.children[1])].some((id) => this.ids(l).has(id));
      return this.bestJoin(l, r, this.conjuncts(n.cond), n.jtype, n, isLat);
    }
    /** the column ids a FROM item takes from outside itself (a LATERAL subquery or function's references) */
    lateralRefs(n) {
      const out = new Set();
      if (n.op === 'Subquery' && n.children[0].outerRefs) for (const id of n.children[0].outerRefs) out.add(id);
      if (n.op === 'Func') for (const c of n.calls || []) for (const id of c.outerRefs || []) out.add(id);
      if (n.op === 'Filter') for (const id of this.lateralRefs(n.children[0])) out.add(id);
      return out;
    }
    /** pick the cheapest algorithm for one join */
    bestJoin(l, r, conds, jtype, orig, lateral) {
      const lrows = l.rows, rrows = r.rows;
      const cond = this.and(conds);
      // equalities that make up a whole foreign key and the key it references match each referencing row to one
      // referenced row: their selectivity is 1 / |referenced table| (so the join keeps the referencing side's rows)
      const fk = this.fkJoin(l, r, conds);
      const sel = conds.reduce((a, p) => (fk && fk.used.has(p) ? a : a * this.selectivity(p, { op: 'X', cols: [], children: [l, r] })), fk ? fk.sel : 1);
      let rows = lrows * rrows * sel;
      if (jtype === 'left') rows = Math.max(rows, lrows);
      if (jtype === 'right') rows = Math.max(rows, rrows);
      if (jtype === 'full') rows = Math.max(rows, lrows + rrows);
      if (jtype === 'semi') rows = lrows * Math.min(1, rrows * sel);
      if (jtype === 'anti') rows = lrows * Math.max(0.05, 1 - rrows * sel);
      const cols = jtype === 'semi' || jtype === 'anti' ? l.cols : l.cols.concat(r.cols);
      const lIds = this.ids(l), rIds = this.ids(r);
      // equi-join keys: left_col = right_col
      const keys = [];
      const rest = [];
      for (const p of conds) {
        if (p.k === 'cmp' && p.op === '=' && this.sideOf(p.l, lIds, rIds) === 'L' && this.sideOf(p.r, lIds, rIds) === 'R') keys.push({ l: p.l, r: p.r, ctype: p.ctype, p });
        else if (p.k === 'cmp' && p.op === '=' && this.sideOf(p.l, lIds, rIds) === 'R' && this.sideOf(p.r, lIds, rIds) === 'L') keys.push({ l: p.r, r: p.l, ctype: p.ctype, p });
        else rest.push(p);
      }
      const M = this.settings.work_mem_pages || 32;
      const bl = this.blocksOf(l), br = this.blocksOf(r);
      const opts = [];
      const base = { cols, jtype, children: [l, r], cond, keys, restCond: this.and(rest), origJtype: orig ? orig.jtype : jtype };
      if (lateral) {
        if (jtype === 'right' || jtype === 'full') throw K.err(S.invalidColumnReference, 'the combining JOIN type must be INNER or LEFT for a LATERAL reference');
        return this.est(Object.assign({ op: 'NestLoopJoin', alg: 'nested loop (lateral)', lateral: true }, base), rows, l.cost + lrows * (r.cost || COST.fixed * 2));
      }
      // nested loop: for each outer tuple scan the inner (materialized if small)
      if (this.settings.enable_nestloop !== false || !keys.length) {
        opts.push(this.est(Object.assign({ op: 'NestLoopJoin', alg: 'nested loop' }, base), rows, l.cost + lrows * (r.cost || COST.fixed * 2) * 0.5 + lrows * rrows * COST.cpuOp));
        // block nested loop: inner scanned once per block of the outer
        opts.push(this.est(Object.assign({ op: 'BlockNestLoopJoin', alg: 'block nested loop', blockPages: Math.max(1, M - 2), outerBlocks: bl, innerBlocks: br }, base), rows, l.cost + Math.ceil(bl / Math.max(1, M - 2)) * br * COST.transfer + (2 * Math.ceil(bl / Math.max(1, M - 2)) - 1) * COST.seek + lrows * rrows * COST.cpuOp));
      }
      // index nested loop: probe an index on the inner relation for each outer tuple
      if (keys.length && (r.op === 'SeqScan' || r.op === 'IndexScan') && r.rel && this.settings.enable_indexscan !== false && ['inner', 'left', 'semi', 'anti'].includes(jtype)) {
        for (const idx of this.indexesOf(r.rel)) {
          if (idx.invalid || !idx.keys[0] || idx.keys[0].attnum === undefined) continue;
          const k = keys.find((kk) => kk.r.k === 'col' && (r.cols.find((c) => c.id === kk.r.id) || {}).attnum === idx.keys[0].attnum);
          if (!k) continue;
          const height = this.indexHeight(idx);
          const per = (height + 1) * (COST.seek + COST.transfer) * 0.3 + Math.max(1, rrows * this.selectivity(k.p, { op: 'X', cols: [], children: [l, r] })) * (COST.seek + COST.transfer) * 0.3;
          opts.push(this.est(Object.assign({}, base, { op: 'IndexNestLoopJoin', alg: 'indexed nested loop', index: idx, indexKey: k, restCond: this.and(conds.filter((c) => c !== k.p)), innerFilter: r.filter }), rows, l.cost + lrows * per + lrows * COST.cpuTuple));
        }
      }
      if (keys.length) {
        // hash join: build on the smaller side's hash table, probe with the other (partitioned if it does not fit)
        if (this.settings.enable_hashjoin !== false) {
          // building costs more per row than probing; partitioning adds (2 b_r + 2 b_s) transfers, as in the standard cost model
          const hashCost = (bb, buildRows, probeRows) => l.cost + r.cost + (bb > M ? 2 * (bl + br) * COST.transfer : 0) + probeRows * COST.cpuTuple * 2 + buildRows * COST.cpuTuple * 3;
          opts.push(this.est(Object.assign({ op: 'HashJoin', alg: 'hash join', partitions: br > M ? Math.ceil(br / M) : 0 }, base), rows, hashCost(br, rrows, lrows)));
          // the executor builds on the right input: to build on the left one, swap the inputs (a left join becomes a right join)
          if (['inner', 'left', 'right', 'full'].includes(jtype)) {
            const swapped = Object.assign({}, base, { cols: r.cols.concat(l.cols), children: [r, l], jtype: FLIP[jtype], keys: keys.map((k) => ({ l: k.r, r: k.l, ctype: k.ctype, p: k.p })) });
            opts.push(this.est(Object.assign({ op: 'HashJoin', alg: 'hash join', partitions: bl > M ? Math.ceil(bl / M) : 0 }, swapped), rows, hashCost(bl, lrows, rrows)));
          }
        }
        // merge join: both inputs sorted on the keys, then one pass
        if (this.settings.enable_mergejoin !== false && ['inner', 'left', 'right', 'full'].includes(jtype)) {
          // each input sorted on its keys: by an explicit Sort, unless an index scan already returns that order
          // (keys that are expressions, or compared in another type, are sorted inside the merge join instead)
          const side = (ch, ks) => (ks.every((k) => k.k === 'col' && ch.cols.some((c) => c.id === k.id)) && ks.every((k, i) => k.type.id === keys[i].ctype.id) ? this.sortedOn(ch, ks.map((k) => ({ id: k.id, type: k.type }))) : null);
          const sl = side(l, keys.map((k) => k.l)), sr = side(r, keys.map((k) => k.r));
          const inner = (x, ch) => (x ? 0 : this.sortCost(ch).cost - ch.cost);
          const ml = sl || l, mr = sr || r;
          opts.push(this.est(Object.assign({ op: 'MergeJoin', alg: 'merge join' }, base, { children: [ml, mr], sortedL: !!sl, sortedR: !!sr }), rows, ml.cost + mr.cost + inner(sl, l) + inner(sr, r) + (lrows + rrows) * COST.cpuTuple));
        }
      }
      if (jtype === 'full' && !keys.length) {
        // like PostgreSQL, a full join needs a hashable or mergeable condition unless it is a constant
        if (cond && this.usesIds(cond).size) throw K.err(S.featureNotSupported, 'FULL JOIN is only supported with merge-joinable or hash-joinable join conditions');
        return this.est(Object.assign({ op: 'NestLoopJoin', alg: 'nested loop' }, base), rows, l.cost + lrows * r.cost);
      }
      if (jtype === 'full') { const ok = opts.filter((o) => o.op === 'HashJoin' || o.op === 'MergeJoin'); if (ok.length) opts.splice(0, opts.length, ...ok); }
      // every algorithm disabled: as in PostgreSQL, the settings only discourage, so fall back to a nested loop
      if (!opts.length) opts.push(this.est(Object.assign({ op: 'NestLoopJoin', alg: 'nested loop' }, base), rows, l.cost + lrows * (r.cost || COST.fixed * 2) * 0.5 + lrows * rrows * COST.cpuOp));
      if (this.settings.force_join) { const f = opts.find((o) => o.op === this.settings.force_join); if (f) return f; }
      opts.sort((a, b) => a.cost - b.cost);
      opts[0].alternatives = opts.slice(1).map((o) => ({ op: o.op, cost: o.cost }));
      return opts[0];
    }
    /** the indexes of a table as this session's catalog has them (one created in the open transaction counts) */
    indexesOf(rel) { return this.db.catalogOf({ session: this.s }).indexesOf(rel); }
    /** a column id's base table and attribute, found in the scans below a node */
    baseCol(n, id) {
      if (n.rel && /Scan$/.test(n.op)) { const c = n.cols.find((x) => x.id === id); if (c && c.attnum !== undefined) return { rel: n.rel, attnum: c.attnum }; }
      for (const ch of n.children || []) { const b = this.baseCol(ch, id); if (b) return b; }
      return null;
    }
    fkJoin(l, r, conds) {
      const eqs = [];
      for (const p of conds) {
        if (p.k !== 'cmp' || p.op !== '=' || p.l.k !== 'col' || p.r.k !== 'col') continue;
        const a = this.baseCol(l, p.l.id) || this.baseCol(r, p.l.id), b = this.baseCol(r, p.r.id) || this.baseCol(l, p.r.id);
        if (a && b) eqs.push({ p, a, b }, { p, a: b, b: a });
      }
      for (const e of eqs) {
        for (const c of e.a.rel.constraints || []) {
          if (c.kind !== 'foreign' || c.refRel !== e.b.rel.oid || !c.refCols) continue;
          const used = new Set();
          const ok = c.cols.every((att, i) => { const m = eqs.find((x) => x.a.rel === e.a.rel && x.b.rel === e.b.rel && x.a.attnum === att && x.b.attnum === c.refCols[i]); if (m) used.add(m.p); return !!m; });
          if (ok) return { used, sel: 1 / Math.max(1, this.relStats(e.b.rel).rows) };
        }
      }
      return null;
    }
    indexHeight(idx) { try { const am = this.db.indexAm(idx, this.s.catalog); return am.height ? am.height() : 3; } catch (e) { return 3; } }
    sideOf(e, lIds, rIds) { const used = this.usesIds(e); if (!used.size) return null; if ([...used].every((id) => lIds.has(id))) return 'L'; if ([...used].every((id) => rIds.has(id))) return 'R'; return null; }
    blocksOf(n) { const width = n.cols.length * 8 + 24; return Math.max(1, Math.ceil((n.rows * width) / (this.db.disk.pageSize * 0.9))); }

    // ---- aggregation, sorting, distinct ------------------------------------------------------------------------------------
    aggPath(n) {
      const ch = this.physical(n.children[0]);
      const groups = n.groups.length ? Math.min(ch.rows, n.groups.reduce((a, g) => { const c = g.e.k === 'col' && this.colStats(g.e.id, ch); return a * (c && c.st ? Math.max(1, c.st.ndistinct) : 10); }, 1)) : 1;
      const hash = this.settings.enable_hashagg !== false && n.groups.length && !n.sets && !n.aggs.some((a) => a.distinct || a.order || a.within);
      const alg = !n.groups.length && !n.sets ? 'plain' : hash ? 'hashed' : 'sorted';
      // a group aggregate reads its input sorted on the grouping columns (with grouping sets, or grouping
      // expressions, the executor groups by hashing and no sort is shown)
      const input = alg === 'sorted' && !n.sets && n.groups.every((g) => g.e.k === 'col' && ch.cols.some((c) => c.id === g.e.id)) ? this.sortedOn(ch, n.groups.map((g) => ({ id: g.e.id, type: g.e.type }))) : ch;
      return this.est(Object.assign({}, n, { children: [input], alg }), n.sets ? groups * n.sets.length : groups, input.cost + ch.rows * COST.cpuTuple * (1 + n.aggs.length) + (alg === 'sorted' && input === ch ? ch.rows * Math.log2(ch.rows + 2) * COST.cpuOp : 0));
    }
    /** the cost of sorting a node's output: in memory, or an external merge sort when it does not fit in work memory */
    sortCost(ch) {
      const b = this.blocksOf(ch), M = this.settings.work_mem_pages || 32;
      const external = b > M;
      // a merge needs at least two input buffers, however small work memory is
      const passes = external ? Math.ceil(Math.log(Math.ceil(b / M)) / Math.log(Math.max(2, M - 1))) : 0;
      return { alg: external ? 'external merge' : 'quicksort', runs: external ? Math.ceil(b / M) : 1, passes, cost: ch.cost + (external ? 2 * b * (passes + 1) * COST.transfer : 0) + ch.rows * Math.log2(ch.rows + 2) * COST.cpuOp };
    }
    sortPath(n) {
      const ch = this.physical(n.children[0]);
      const sc = this.sortCost(ch);
      return this.est(Object.assign({}, n, { children: [ch], alg: sc.alg, runs: sc.runs, passes: sc.passes }), ch.rows, sc.cost);
    }
    /** a node's output ascending on the given columns (nulls last): itself if an index scan returns that order, else sorted */
    sortedOn(ch, keys) {
      const ix = ch.index;
      const ordered = (ch.op === 'IndexScan' || ch.op === 'IndexOnlyScan') && ch.dir === 'forward' && ix.method === 'btree' && !ch.bounds.some((b) => b.op === 'in') &&
        keys.every((k, i) => { const key = ix.keys[i], c = ch.cols.find((x) => x.id === k.id); return key && c && key.attnum === c.attnum && key.dir !== 'desc' && key.nulls !== 'first' && ix.keyTypes[i].id === k.type.id; });
      if (ordered) return ch;
      const sc = this.sortCost(ch);
      return this.est({ op: 'Sort', keys: keys.map((k) => ({ id: k.id, dir: 'asc', nulls: 'last', type: k.type })), children: [ch], cols: ch.cols, alg: sc.alg, runs: sc.runs, passes: sc.passes }, ch.rows, sc.cost);
    }
    distinctPath(n) {
      const ch = this.physical(n.children[0]);
      return this.est(Object.assign({}, n, { children: [ch], alg: n.on ? 'sorted' : this.settings.enable_hashagg !== false ? 'hashed' : 'sorted' }), ch.rows * 0.5, ch.cost + ch.rows * COST.cpuTuple);
    }
  }
  const SPATIAL = new Set(['rtree', 'gist']);
  const INTS = new Set(['int2', 'int4', 'int8']);
  const FLIP = { inner: 'inner', left: 'right', right: 'left', full: 'full' };
  const flipOp = (o) => ({ '<': '>', '>': '<', '<=': '>=', '>=': '<=' }[o] || o);
  const popcount = (x) => { let c = 0; while (x) { x &= x - 1; c++; } return c; };
  const setNames = (set, base) => base.filter((_, i) => (set >> i) & 1).map((b) => (b.rel ? b.alias || b.rel.name : b.op)).join(' ⋈ ');

  K.Planner = Planner;
  K.COST = COST;
})(typeof window !== 'undefined' ? window : globalThis);
