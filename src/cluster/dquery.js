// Distributed query processing (chapter 22). Tables are partitioned over C.Node engines; the coordinator takes
// SQL, picks a distributed plan and runs it: local scans with the single-table predicates pushed down, exchange
// operators (repartition on a key, broadcast, gather, range repartition for sorting) that ship rows as messages
// on the net, parallel joins (local when co-partitioned, partitioned on the join key, broadcast of the small side,
// fragment-and-replicate when there is no equi-join), parallel aggregation (partial aggregates per node, then a
// global combine) and parallel sorting by range partitioning. Every fragment is SQL that a node's engine runs on
// the rows it holds; the coordinator only routes rows. A query the planner does not take apart (subqueries, set
// operations, window functions, outer joins) still runs: the referenced tables are shipped to the coordinator.
(function (root) {
  'use strict';
  const K = root.K;
  const C = K.Cluster = K.Cluster || {};
  const P = () => C.Partition;
  const { lit, ident } = C;

  class Unsupported extends Error {}
  const no = (why) => { throw new Unsupported(why); };

  // ---- SQL from expression trees --------------------------------------------------------------------------------
  const BAD = new Set(['sub', 'exists', 'quant', 'var', 'param', 'fieldstar', 'field', 'idx', 'array', 'row', 'grouping', 'rollup', 'cube', 'sets', 'emptyset', 'isof', 'isjson', 'default']);
  const AGG = new Set(['count', 'sum', 'avg', 'min', 'max', 'bool_and', 'bool_or', 'every', 'string_agg', 'array_agg', 'stddev', 'stddev_samp', 'stddev_pop', 'variance', 'var_samp', 'var_pop', 'json_agg', 'jsonb_agg', 'bit_and', 'bit_or']);
  const isAgg = (e) => e && e.k === 'fn' && !e.schema && AGG.has(e.name) && !e.over;
  function typeSql(t) {
    const mods = t.mods && t.mods.length ? '(' + t.mods.map((m) => (typeof m === 'object' ? sql(m, () => no('type modifier')) : m)).join(', ') + ')' : '';
    return t.name + mods + (t.dims ? '[]'.repeat(t.dims) : '');
  }
  /** SQL text for an expression; col(e) gives the text of a column reference, hook(e) may replace any subtree */
  function sql(e, col, hook) {
    const r = (x) => sql(x, col, hook);
    if (hook) { const h = hook(e); if (h !== undefined) return h; }
    if (BAD.has(e.k)) no(e.k);
    switch (e.k) {
      case 'col': return col(e);
      case 'lit':
        if (e.v === null) return 'null';
        if (e.type === 'int' || e.type === 'num') return String(e.v);
        if (e.type === 'bool') return e.v ? 'true' : 'false';
        if (e.type === 'str') return lit(e.v);
        return no('literal ' + e.type);
      case 'op': return '(' + r(e.l) + ' ' + e.op + ' ' + r(e.r) + ')';
      case 'and': return '(' + r(e.l) + ' and ' + r(e.r) + ')';
      case 'or': return '(' + r(e.l) + ' or ' + r(e.r) + ')';
      case 'not': return '(not ' + r(e.e) + ')';
      case 'neg': return '(- ' + r(e.e) + ')';
      case 'un': return '(' + e.op + ' ' + r(e.e) + ')';
      case 'isnull': return '(' + r(e.e) + ' is ' + (e.neg ? 'not ' : '') + 'null)';
      case 'istruth': return '(' + r(e.e) + ' is ' + (e.neg ? 'not ' : '') + (e.v ? 'true' : 'false') + ')';
      case 'distinct': return '(' + r(e.l) + ' is ' + (e.neg ? 'not ' : '') + 'distinct from ' + r(e.r) + ')';
      case 'between': return '(' + r(e.e) + (e.neg ? ' not' : '') + ' between ' + (e.sym ? 'symmetric ' : '') + r(e.lo) + ' and ' + r(e.hi) + ')';
      case 'in': if (e.query) no('in subquery'); return '(' + r(e.e) + (e.neg ? ' not' : '') + ' in (' + e.list.map(r).join(', ') + '))';
      case 'like': return '(' + r(e.e) + (e.neg ? ' not' : '') + (e.similar ? ' similar to ' : e.ci ? ' ilike ' : ' like ') + r(e.pat) + (e.esc ? ' escape ' + r(e.esc) : '') + ')';
      case 'case': return '(case' + (e.base ? ' ' + r(e.base) : '') + e.whens.map((w) => ' when ' + r(w.c) + ' then ' + r(w.r)).join('') + (e.else ? ' else ' + r(e.else) : '') + ' end)';
      case 'cast': if (e.tryCast) no('try_cast'); return 'cast(' + r(e.e) + ' as ' + typeSql(e.type) + ')';
      case 'fn': {
        if (e.over || e.withinGroup || e.order || e.named || e.variadic || e.separator || e.returning) no('function form');
        const name = (e.schema ? ident(e.schema) + '.' : '') + e.name;
        if (e.special && !e.args.length) return e.name;
        if (e.name === 'extract' && e.args.length === 2 && e.args[0].k === 'lit') return 'extract(' + e.args[0].v + ' from ' + r(e.args[1]) + ')';
        if (e.name === 'position' && e.args.length === 2) return 'position(' + r(e.args[0]) + ' in ' + r(e.args[1]) + ')';
        if (e.name === 'substring_similar' || e.name === 'overlaps') no(e.name);
        return name + '(' + (e.star ? '*' : (e.distinct ? 'distinct ' : '') + e.args.map(r).join(', ')) + ')' + (e.filter ? ' filter (where ' + r(e.filter) + ')' : '');
      }
    }
    return no('expression ' + e.k);
  }
  /** every node of an expression tree, depth first */
  function walk(e, f) {
    if (!e || typeof e !== 'object') return;
    if (Array.isArray(e)) { e.forEach((x) => walk(x, f)); return; }
    if (e.k) f(e);
    for (const k of Object.keys(e)) if (k !== 'type' || e.k !== 'cast') { const v = e[k]; if (v && typeof v === 'object' && k !== 'query') walk(v, f); }
  }
  const conjuncts = (e) => (!e ? [] : e.k === 'and' ? conjuncts(e.l).concat(conjuncts(e.r)) : [e]);

  /** the AST of a statement uses only what the planner takes apart */
  function shapeProblem(q) {
    if (q.type !== 'select') return 'a ' + q.type + ' query';
    if (q.with) return 'WITH';
    if (q.distinctOn) return 'DISTINCT ON';
    if (q.windows || q.locking || q.into || q.withTies || q.groupDistinct) return 'clause not distributed';
    let bad = null;
    const check = (e) => walk(e, (x) => { if (BAD.has(x.k)) bad = bad || x.k; if (x.k === 'in' && x.query) bad = 'IN (subquery)'; if (x.k === 'fn' && (x.over || x.withinGroup)) bad = 'window or ordered-set function'; if (isAgg(x) && x.args.some((a) => { let inner = false; walk(a, (y) => { if (isAgg(y)) inner = true; }); return inner; })) bad = 'nested aggregate'; });
    check(q.targets.map((t) => t.expr)); check(q.where); check(q.groupBy); check(q.having); check((q.order || []).map((o) => o.expr)); check(q.limit); check(q.offset);
    const fromOk = (f) => (f.kind === 'table' ? !f.name.schema || f.name.schema === 'public' : f.kind === 'join' && (f.jtype === 'inner' || f.jtype === 'cross') && !f.natural && !f.using && fromOk(f.left) && fromOk(f.right));
    if (!q.from.every(fromOk)) return 'FROM item (outer join, USING, subquery or function)';
    return bad;
  }
  /** the base tables a statement reads, anywhere in it */
  function tablesIn(q, out) {
    out = out || new Set();
    const ctes = new Set();
    const visit = (x) => {
      if (!x || typeof x !== 'object') return;
      if (Array.isArray(x)) { x.forEach(visit); return; }
      if (x.with) for (const w of x.with.ctes || x.with.list || x.with) if (w && w.name) ctes.add(typeof w.name === 'string' ? w.name : w.name.name);
      if (x.kind === 'table' && x.name && x.name.name && !ctes.has(x.name.name)) out.add(x.name.name);
      for (const k of Object.keys(x)) if (x[k] && typeof x[k] === 'object') visit(x[k]);
    };
    visit(q);
    return out;
  }

  // ---- the distributed database -----------------------------------------------------------------------------------
  let qid = 0;
  /**
   * opts: nodes (count or ids), seed, latency, jitter, bandwidth, batchRows (rows per message),
   * broadcastFactor (broadcast the small side when its size times the node count is below this share of a repartition)
   */
  class DistDB {
    constructor(opts) {
      opts = opts || {};
      this.opts = Object.assign({ batchRows: 100, broadcastFactor: 1 }, opts);
      this.net = opts.net || new C.Net({ seed: opts.seed || 1, latency: opts.latency || 5, jitter: opts.jitter || 0, bandwidth: opts.bandwidth || 0 });
      this.ids = Array.isArray(opts.nodes) ? opts.nodes.slice() : K.range(opts.nodes || 4).map((i) => 'n' + (i + 1));
      for (const id of this.ids) if (!this.net.node(id)) this.net.add(id, new C.Node(id, { role: 'worker' }));
      this.coordId = opts.coordinator || 'coord';
      this.coord = this.net.node(this.coordId) || this.net.add(this.coordId, new C.Node(this.coordId, { role: 'coordinator' }));
      this.catalog = {};
      this.history = [];
    }
    node(id) { return this.net.node(id); }
    /**
     * place a table: spec.scheme 'hash' (on spec.key), 'range' (on spec.key, spec.bounds or equi-depth ones),
     * 'round-robin' or 'replicated' (a copy on every node)
     */
    load(table, spec) {
      spec = Object.assign({ scheme: 'hash' }, spec || {});
      const cols = table.cols, k = this.ids.length;
      const keyIdx = spec.key === undefined ? 0 : typeof spec.key === 'number' ? spec.key : cols.findIndex((c) => c.name === spec.key);
      if (spec.scheme !== 'round-robin' && spec.scheme !== 'replicated' && keyIdx < 0) throw new Error('no column ' + spec.key + ' in ' + table.name);
      const meta = { name: table.name, cols, scheme: spec.scheme, key: keyIdx >= 0 ? cols[keyIdx].name : null, keyIdx, nodes: this.ids.slice(), rows: table.rows.length, bytes: table.rows.reduce((n, r) => n + C.rowBytes(r), 0), data: table };
      let assign;
      if (spec.scheme === 'hash') assign = table.rows.map((r) => P().hashOf(r[keyIdx], cols[keyIdx].type) % k);
      else if (spec.scheme === 'range') { meta.bounds = spec.bounds || P().equiDepth(table.rows.map((r) => r[keyIdx]), k, { type: cols[keyIdx].type }); assign = table.rows.map((r) => Math.min(k - 1, P().rangeOf(r[keyIdx], meta.bounds, cols[keyIdx].type))); }
      else if (spec.scheme === 'round-robin') assign = table.rows.map((r, i) => i % k);
      for (let i = 0; i < k; i++) {
        const n = this.node(this.ids[i]);
        n.createTable(table.name, cols, { replace: true });
        n.insert(table.name, assign ? table.rows.filter((r, j) => assign[j] === i) : table.rows);
      }
      meta.sizes = this.ids.map((id) => this.node(id).count(table.name));
      // the coordinator keeps an empty copy of every schema: it checks and types the incoming SQL with it
      this.coord.createTable(table.name, cols, { replace: true });
      this.catalog[table.name] = meta;
      return meta;
    }
    /** the Theatre database, partitioned so that every join strategy turns up: the small venue and stage tables
     *  are copied to every node, each artist's castings sit with the artist and each patron's bookings with the
     *  patron (co-located joins), performances sit with their production, and mentor is range-partitioned */
    loadTheatre(specs) {
      const u = C.theatre();
      const def = {
        venue: { scheme: 'replicated' }, stage: { scheme: 'replicated' }, company: { scheme: 'hash', key: 'company_id' },
        person: { scheme: 'hash', key: 'person_id' }, artist: { scheme: 'hash', key: 'person_id' }, casting: { scheme: 'hash', key: 'person_id' },
        production: { scheme: 'hash', key: 'prod_id' }, performance: { scheme: 'hash', key: 'prod_id' },
        patron: { scheme: 'hash', key: 'patron_id' }, booking: { scheme: 'hash', key: 'patron_id' }, mentor: { scheme: 'range', key: 'mentor_id' },
      };
      for (const n of u.names) this.load(u.tables[n], Object.assign({}, def[n], specs && specs[n]));
      return this;
    }
    placement() { return Object.values(this.catalog).map((m) => ({ table: m.name, scheme: m.scheme, key: m.key, bounds: m.bounds, sizes: m.sizes })); }

    /** run SQL over the cluster: { cols, rows (text), plan, steps, stats, trace } */
    query(text, opts) { return new Run(this, text, opts || {}).go(); }
    explain(text, opts) { const r = this.query(text, opts); return { plan: r.plan, steps: r.steps.map((s) => ({ id: s.id, kind: s.kind, what: s.what, strategy: s.strategy, reason: s.reason, nodes: s.nodes, rows: s.rows, bytes: s.bytes, messages: s.messages })), stats: r.stats }; }
    /** the same SQL on one engine holding all the data, for comparison */
    reference(text) {
      if (!this.ref) {
        this.ref = new C.Node('reference');
        for (const m of Object.values(this.catalog)) { this.ref.createTable(m.name, m.cols, { replace: true }); this.ref.insert(m.name, m.data.rows); }
      }
      return this.ref.query(text);
    }

    /**
     * a join of r (at one site) with s (at another), shipping either a whole relation or only a semijoin.
     * opts: left/right table names, on [leftCol, rightCol], leftWhere/rightWhere (SQL on that table), sites, result site
     */
    semijoin(opts) {
      const L = this.catalog[opts.left], R = this.catalog[opts.right];
      const sA = opts.leftSite || this.ids[0], sB = opts.rightSite || this.ids[1], out = opts.resultSite || sB;
      const [lc, rc] = opts.on;
      const A = new C.Node('site-' + sA), B = new C.Node('site-' + sB);
      // the two sites hold the whole relations for this comparison
      A.createTable('r', L.cols); A.insert('r', L.data.rows); B.createTable('s', R.cols); B.insert('s', R.data.rows);
      const lw = opts.leftWhere ? ' where ' + opts.leftWhere : '', rw = opts.rightWhere ? ' where ' + opts.rightWhere : '';
      const cost = (rows) => ({ rows: rows.length, bytes: rows.reduce((n, x) => n + C.rowBytes(x), 0), messages: Math.max(1, Math.ceil(rows.length / this.opts.batchRows)) });
      const strategies = [];
      const joinSql = (rt, st) => 'select ' + L.cols.map((c) => 'r.' + ident(c.name)).concat(R.cols.map((c) => 's.' + ident(c.name))).join(', ') + ' from ' + rt + ' r, ' + st + ' s where r.' + ident(lc) + ' = s.' + ident(rc);
      // 1: ship s (filtered at its site) to r's site and join there
      const s1 = B.query('select * from s' + rw);
      A.createTable('s_in', R.cols); A.insert('s_in', s1.rows);
      const j1 = A.query(joinSql('(select * from r' + lw + ')', 's_in'));
      const ship1 = [Object.assign({ from: sB, to: sA, what: 's' + (rw ? ' filtered' : '') }, cost(s1.rows))];
      if (out !== sA) ship1.push(Object.assign({ from: sA, to: out, what: 'result' }, cost(j1.rows)));
      strategies.push({ name: 'ship ' + opts.right + ' to ' + sA, ships: ship1, result: j1.rows.length });
      // 2: ship r to s's site
      const r2 = A.query('select * from r' + lw);
      B.createTable('r_in', L.cols); B.insert('r_in', r2.rows);
      const j2 = B.query(joinSql('r_in', '(select * from s' + rw + ')'));
      const ship2 = [Object.assign({ from: sA, to: sB, what: 'r' + (lw ? ' filtered' : '') }, cost(r2.rows))];
      if (out !== sB) ship2.push(Object.assign({ from: sB, to: out, what: 'result' }, cost(j2.rows)));
      strategies.push({ name: 'ship ' + opts.left + ' to ' + sB, ships: ship2, result: j2.rows.length });
      // 3: semijoin: ship the distinct join values of s to r's site, reduce r there, ship the reduced r back
      const keys = B.query('select distinct ' + ident(rc) + ' from s' + rw);
      A.createTable('k', [R.cols.find((c) => c.name === rc)]); A.insert('k', keys.rows);
      const red = A.query('select * from r' + (lw ? lw + ' and ' : ' where ') + ident(lc) + ' in (select ' + ident(rc) + ' from k)');
      B.createTable('r_red', L.cols); B.insert('r_red', red.rows);
      const j3 = B.query(joinSql('r_red', '(select * from s' + rw + ')'));
      const ship3 = [Object.assign({ from: sB, to: sA, what: 'distinct ' + rc + ' of s' }, cost(keys.rows)), Object.assign({ from: sA, to: sB, what: 'r semijoin s' }, cost(red.rows))];
      if (out !== sB) ship3.push(Object.assign({ from: sB, to: out, what: 'result' }, cost(j3.rows)));
      strategies.push({ name: 'semijoin reduction', ships: ship3, result: j3.rows.length, reduced: { before: r2.rows.length, after: red.rows.length } });
      for (const st of strategies) {
        st.bytes = st.ships.reduce((n, s) => n + s.bytes, 0); st.messages = st.ships.reduce((n, s) => n + s.messages, 0);
        for (const sh of st.ships) this.net.send(sh.from === sA || sh.from === sB ? sh.from : sA, sh.to === out && !this.net.node(out) ? this.coordId : sh.to, 'ship', { strategy: st.name, what: sh.what, rows: sh.rows }, { bytes: sh.bytes });
      }
      this.net.settle();
      const norm = (rows) => rows.map((x) => JSON.stringify(x)).sort();
      const same = JSON.stringify(norm(j1.rows)) === JSON.stringify(norm(j2.rows)) && JSON.stringify(norm(j2.rows)) === JSON.stringify(norm(j3.rows));
      const best = strategies.reduce((a, b) => (b.bytes < a.bytes ? b : a));
      return { strategies, best: best.name, sameResult: same, rows: j3.rows, cols: j3.cols };
    }
    describe() {
      return {
        name: 'Distributed query processing',
        text: 'The coordinator parses the SQL and splits it into fragments that run on the nodes holding the data. Predicates on one table '
          + 'are pushed into the local scans. A join of tables partitioned on the join key runs locally; otherwise either both inputs are '
          + 'repartitioned on the join key or the small input is broadcast to every node (asymmetric fragment-and-replicate). '
          + 'Aggregates are computed per node first (count, sum, min, max; avg as sum and count) and combined after repartitioning the '
          + 'partial groups. ORDER BY without LIMIT sorts in parallel: the rows are range-partitioned on the first sort key with boundaries '
          + 'from a sample, each node sorts its range, and the ranges are concatenated. With LIMIT each node keeps only its top rows. '
          + 'Every exchange is counted in rows, bytes and messages.',
        strategies: { join: ['local (co-partitioned)', 'repartition', 'broadcast', 'fragment-replicate'], agg: ['two-phase', 'repartition', 'local'], sort: ['range', 'merge', 'top-k'] },
        placement: this.placement(),
      };
    }
  }

  // ---- one query --------------------------------------------------------------------------------------------------
  class Run {
    constructor(db, text, opts) {
      this.db = db; this.text = text; this.opts = opts;
      this.id = ++qid;
      this.steps = []; this.temps = []; this.n = 0;
      this.t0 = db.net.trace.length;
      this.stats = { messages: 0, bytes: 0, rowsShipped: 0, control: 0, fragments: 0 };
    }
    tmp(what) { return '_q' + this.id + '_' + (++this.n) + '_' + what.replace(/[^a-z0-9]/g, ''); }
    placed(name, node) { this.temps.push([name, node]); }
    step(kind, o) { const s = Object.assign({ id: this.steps.length + 1, kind, t: this.db.net.clock }, o); this.steps.push(s); return s; }
    /** run a fragment of SQL on a node: create table name as select ...; returns the row count */
    fragment(node, name, select) {
      this.stats.fragments++;
      const r = this.db.node(node).exec('create table ' + name + ' as ' + select);
      this.placed(name, node);
      return r[r.length - 1].rowCount;
    }
    /** run a fragment on every node of a stream, with control messages from the coordinator */
    everywhere(kind, at, name, sqlOf, extra) {
      const rows = {};
      const sqlBy = {};
      for (const node of at) {
        const q = sqlOf(node);
        sqlBy[node] = q;
        if (node !== this.db.coordId) { this.db.net.send(this.db.coordId, node, 'fragment', { query: this.id, kind, table: name }); this.stats.control++; }
      }
      this.db.net.settle();
      for (const node of at) rows[node] = this.fragment(node, name, sqlBy[node]);
      for (const node of at) if (node !== this.db.coordId) { this.db.net.send(node, this.db.coordId, 'done', { query: this.id, table: name, rows: rows[node] }); this.stats.control++; }
      this.db.net.settle();
      this.step(kind, Object.assign({ nodes: at.slice(), table: name, sql: sqlBy, rows }, extra || {}));
      return rows;
    }
    rawRows(node, name) { const r = this.db.node(node).exec('select * from ' + name); const x = r[r.length - 1]; return { types: x.cols.map((c) => c.type), text: C.textResult(x) }; }
    /**
     * ship a stream's rows: kind 'hash' (cols), 'broadcast', 'gather', 'range' (route(row) gives the target index),
     * 'grid' (dest(row, i) gives target indexes). Returns the new stream located at targets.
     */
    exchange(stream, kind, o) {
      o = o || {};
      const targets = o.to || (kind === 'gather' ? [this.db.coordId] : this.db.ids);
      const name = this.tmp(o.what || kind);
      const sources = stream.part.kind === 'replicated' && kind !== 'broadcast-all' ? [stream.at[0]] : stream.at;
      const batches = new Map();
      const add = (from, to, row) => { const k = from + '>' + to; if (!batches.has(k)) batches.set(k, { from, to, rows: [] }); batches.get(k).rows.push(row); };
      let samples = null;
      for (const from of sources) {
        const { text } = this.rawRows(from, stream.name);
        const idx = (o.cols || []).map((c) => stream.cols.findIndex((x) => x.name === c));
        text.rows.forEach((row, i) => {
          if (kind === 'hash') {
            const h = idx.length === 1 ? P().hashOf(row[idx[0]], stream.cols[idx[0]].type) : P().hashOf(idx.map((j) => P().canon(row[j], stream.cols[j].type)).join('\u0001'), 'text');
            add(from, targets[h % targets.length], row);
          } else if (kind === 'broadcast' || kind === 'broadcast-all') for (const t of targets) add(from, t, row);
          else if (kind === 'gather') add(from, targets[0], row);
          else if (kind === 'range') add(from, targets[o.route(row)], row);
          else if (kind === 'grid') for (const t of o.dest(row, i, from)) add(from, targets[t], row);
        });
      }
      for (const t of targets) this.placed(name, t);
      let bytes = 0, messages = 0, shipped = 0;
      const flows = [];
      for (const b of batches.values()) {
        const nb = b.rows.reduce((n, r) => n + C.rowBytes(r), 0);
        if (b.from !== b.to) {
          for (let i = 0; i < b.rows.length; i += this.db.opts.batchRows) {
            const part = b.rows.slice(i, i + this.db.opts.batchRows);
            const pb = part.reduce((n, r) => n + C.rowBytes(r), 0);
            this.db.net.send(b.from, b.to, 'rows', { query: this.id, table: name, kind, rows: part.length }, { bytes: pb });
            messages++;
          }
          bytes += nb; shipped += b.rows.length;
        }
        flows.push({ from: b.from, to: b.to, rows: b.rows.length, bytes: b.from === b.to ? 0 : nb, local: b.from === b.to });
      }
      this.db.net.settle();
      const rows = {};
      for (const t of targets) {
        const n = this.db.node(t);
        n.createTable(name, stream.cols);
        rows[t] = 0;
        for (const b of batches.values()) if (b.to === t) { n.insert(name, b.rows); rows[t] += b.rows.length; }
      }
      this.stats.messages += messages; this.stats.bytes += bytes; this.stats.rowsShipped += shipped;
      this.step('exchange', { exchange: kind, what: o.what, strategy: o.strategy, reason: o.reason, input: stream.name, from: sources, nodes: targets.slice(), table: name, flows, bytes, messages, rowsShipped: shipped, rows, samples });
      return Object.assign({}, stream, { name, at: targets.slice(), part: o.part || { kind: 'any' } });
    }

    go() {
      const db = this.db;
      const t = Date.now();
      let res;
      try {
        // the coordinator checks the statement against the empty schemas: errors surface here with their SQLSTATE
        const shape = db.coord.exec(this.text);
        const last = shape[shape.length - 1];
        this.outCols = last.cols ? last.cols.map((c) => ({ name: c.name, type: K.T.sqlName(c.type) })) : [];
        const stmts = K.parse(this.text);
        if (stmts.length !== 1) throw new Error('one statement at a time');
        const q = stmts[0];
        const problem = this.opts.strategy === 'ship' ? 'shipping requested' : shapeProblem(q);
        if (problem) res = this.shipAll(q, problem);
        else {
          try { res = this.plan(q); } catch (e) { if (!(e instanceof Unsupported)) throw e; this.cleanup(); this.steps = []; res = this.shipAll(q, e.message); }
        }
      } finally { this.cleanup(); }
      const trace = db.net.trace.slice(this.t0);
      const out = { cols: this.outCols, rows: res.rows, plan: res.plan, steps: this.steps, stats: Object.assign(this.stats, { ms: Date.now() - t, steps: this.steps.length }), trace, sql: this.text };
      db.history.push({ sql: this.text, plan: res.plan.kind, stats: out.stats });
      return out;
    }
    cleanup() {
      const by = new Map();
      for (const [name, node] of this.temps) { if (!by.has(node)) by.set(node, new Set()); by.get(node).add(name); }
      for (const [node, names] of by) this.db.node(node).exec([...names].map((n) => 'drop table if exists ' + n).join('; '));
      this.temps = [];
    }
    /** data shipping: every referenced table goes to the coordinator, which runs the statement as written */
    shipAll(q, why) {
      const db = this.db;
      const names = [...tablesIn(q)].filter((n) => db.catalog[n]);
      for (const n of names) {
        const m = db.catalog[n];
        const stream = { name: n, cols: m.cols, at: m.nodes, part: m.scheme === 'replicated' ? { kind: 'replicated' } : { kind: 'any' } };
        const s = this.exchange(stream, 'gather', { what: n, strategy: 'ship table', reason: why });
        db.coord.exec('insert into ' + ident(n) + ' select * from ' + s.name);
      }
      let r;
      try { r = db.coord.query(this.text); } finally { for (const n of names) db.coord.exec('delete from ' + ident(n)); }
      this.step('final', { nodes: [db.coordId], sql: { [db.coordId]: this.text }, rows: { [db.coordId]: r.rows.length }, what: 'the statement as written, at the coordinator' });
      return { rows: r.rows, plan: { kind: 'ship', reason: why, tables: names } };
    }

    // ---- planning and running a select block ------------------------------------------------------------------
    plan(q) {
      const db = this.db, opts = this.opts;
      if (!q.from.length) { const r = db.coord.query(this.text); this.step('final', { nodes: [db.coordId], sql: { [db.coordId]: this.text }, rows: { [db.coordId]: r.rows.length } }); return { rows: r.rows, plan: { kind: 'local' } }; }
      // the FROM list: aliases, and the conditions of inner joins as conjuncts
      const aliases = [];
      const conds = conjuncts(q.where);
      const flat = (f) => {
        if (f.kind === 'table') {
          const m = db.catalog[f.name.name];
          if (!m) no('table ' + f.name.name + ' is not distributed');
          const a = f.alias ? f.alias.name : f.name.name;
          if (f.alias && f.alias.cols) no('column aliases');
          if (aliases.some((x) => x.alias === a)) no('duplicate alias');
          aliases.push({ alias: a, table: m.name, meta: m, cols: m.cols.map((c) => c.name) });
        } else { flat(f.left); flat(f.right); if (f.on) conds.push(...conjuncts(f.on)); }
      };
      q.from.forEach(flat);
      const byAlias = new Map(aliases.map((a) => [a.alias, a]));
      const outAliases = q.targets.map((t) => t.alias).filter(Boolean);
      // a column reference: { alias, col }
      const resolve = (e) => {
        const p = e.parts;
        if (p.length >= 2) { const a = byAlias.get(p[p.length - 2]); if (!a || !a.cols.includes(p[p.length - 1])) no('column ' + p.join('.')); return { alias: a.alias, col: p[p.length - 1] }; }
        const hits = aliases.filter((a) => a.cols.includes(p[0]));
        if (hits.length !== 1) no('column ' + p[0]);
        return { alias: hits[0].alias, col: p[0] };
      };
      const sname = (r) => r.alias + '__' + r.col;
      const need = new Map(aliases.map((a) => [a.alias, new Set()]));
      const touch = (e) => walk(e, (x) => { if (x.k === 'col') { const r = resolve(x); need.get(r.alias).add(r.col); } });
      // order by and group by may name an output column or its position
      const targetOf = (e, allowAlias) => {
        if (e.k === 'lit' && e.type === 'int') { const t = q.targets[Number(e.v) - 1]; if (!t || t.star) no('position'); return t.expr; }
        if (allowAlias && e.k === 'col' && e.parts.length === 1 && outAliases.includes(e.parts[0])) {
          const isCol = aliases.some((a) => a.cols.includes(e.parts[0]));
          if (allowAlias === 'order' || !isCol) return q.targets.find((t) => t.alias === e.parts[0]).expr;
        }
        return e;
      };
      const targets = [];
      for (const t of q.targets) {
        if (t.star) {
          for (const a of aliases) if (!t.table || t.table === a.alias) for (const c of a.cols) targets.push({ k: 'col', parts: [a.alias, c] });
        } else targets.push(t.expr);
      }
      const groups = (q.groupBy || []).map((g) => targetOf(g, 'group'));
      const order = (q.order || []).map((o) => ({ expr: targetOf(o.expr, 'order'), dir: o.dir || 'asc', nulls: o.nulls }));
      [targets, groups, order.map((o) => o.expr), q.having, conds].forEach(touch);
      // conjuncts by the aliases they touch
      const aliasesOf = (e) => { const s = new Set(); walk(e, (x) => { if (x.k === 'col') s.add(resolve(x).alias); }); return s; };
      const local = new Map(aliases.map((a) => [a.alias, []]));
      const edges = [], rest = [];
      for (const c of conds) {
        let agg = false; walk(c, (x) => { if (isAgg(x)) agg = true; });
        if (agg) no('aggregate in WHERE');
        const s = aliasesOf(c);
        if (s.size <= 1) local.get(s.size ? [...s][0] : aliases[0].alias).push(c);
        else if (s.size === 2 && c.k === 'op' && c.op === '=' && c.l.k === 'col' && c.r.k === 'col') edges.push({ l: resolve(c.l), r: resolve(c.r), e: c });
        else rest.push({ e: c, aliases: s });
      }
      const baseCol = (e) => { const r = resolve(e); return ident(r.alias) + '.' + ident(r.col); };
      const streamCol = (e) => ident(sname(resolve(e)));

      // 1. scans
      const streams = new Map();
      for (const a of aliases) {
        const cols = [...need.get(a.alias)];
        const sel = cols.length ? cols.map((c) => ident(a.alias) + '.' + ident(c) + ' as ' + ident(sname({ alias: a.alias, col: c }))).join(', ') : '1 as ' + ident(a.alias + '__one');
        const where = local.get(a.alias).map((c) => sql(c, baseCol)).join(' and ');
        const name = this.tmp('scan_' + a.alias);
        const m = a.meta;
        const at = m.nodes.slice();
        const rows = this.everywhere('scan', at, name, () => 'select ' + sel + ' from ' + ident(m.name) + ' ' + ident(a.alias) + (where ? ' where ' + where : ''), { what: m.name + (a.alias !== m.name ? ' ' + a.alias : '') + (where ? ' where ' + where : ''), pushed: local.get(a.alias).length });
        const scols = cols.length ? cols.map((c) => ({ name: sname({ alias: a.alias, col: c }), type: m.cols.find((x) => x.name === c).type })) : [{ name: a.alias + '__one', type: 'integer' }];
        const part = m.scheme === 'replicated' ? { kind: 'replicated' } : m.scheme === 'hash' && cols.includes(m.key) ? { kind: 'hash', keys: [sname({ alias: a.alias, col: m.key })], nodes: m.nodes } : { kind: 'any' };
        const total = Object.values(rows).reduce((x, y) => x + y, 0);
        streams.set(a.alias, { name, cols: scols, at, part, aliases: new Set([a.alias]), rows: m.scheme === 'replicated' ? rows[at[0]] : total, bytesPerRow: scols.reduce((n, c) => n + 8, 4) });
      }
      const sizeOf = (s) => s.rows * s.bytesPerRow;

      // 2. joins, left deep: the largest input stays where it is, the rest join it one by one
      const order0 = aliases.map((a) => a.alias).sort((x, y) => sizeOf(streams.get(y)) - sizeOf(streams.get(x)));
      let cur = streams.get(order0[0]);
      const left = order0.slice(1);
      let pendingRest = rest.slice();
      const joinPlans = [];
      while (left.length) {
        let pick = left.findIndex((a) => edges.some((e) => (cur.aliases.has(e.l.alias) && e.r.alias === a) || (cur.aliases.has(e.r.alias) && e.l.alias === a)));
        if (pick < 0) pick = 0;
        const a = left.splice(pick, 1)[0];
        const S = streams.get(a);
        const keys = edges.filter((e) => (cur.aliases.has(e.l.alias) && e.r.alias === a) || (cur.aliases.has(e.r.alias) && e.l.alias === a)).map((e) => (e.r.alias === a ? { l: sname(e.l), r: sname(e.r) } : { l: sname(e.r), r: sname(e.l) }));
        edges.splice(0, edges.length, ...edges.filter((e) => !((cur.aliases.has(e.l.alias) && e.r.alias === a) || (cur.aliases.has(e.r.alias) && e.l.alias === a))));
        const covered = new Set([...cur.aliases, a]);
        const residual = pendingRest.filter((r) => [...r.aliases].every((x) => covered.has(x)));
        pendingRest = pendingRest.filter((r) => !residual.includes(r));
        // edges between aliases already joined become residual predicates too
        const inner = edges.filter((e) => covered.has(e.l.alias) && covered.has(e.r.alias));
        edges.splice(0, edges.length, ...edges.filter((e) => !inner.includes(e)));
        cur = this.join(cur, S, keys, residual.map((r) => r.e).concat(inner.map((e) => e.e)), streamCol);
        joinPlans.push({ with: a, strategy: cur.strategy });
      }

      // 3. aggregation and the final block
      const aggs = [];
      const findAggs = (e) => walk(e, (x) => { if (isAgg(x)) { const key = sql(x, streamCol); if (!aggs.some((a) => a.key === key)) aggs.push({ key, e: x }); } });
      [targets, q.having, order.map((o) => o.expr)].forEach(findAggs);
      const grouped = groups.length > 0 || aggs.length > 0;
      let F, plan = { kind: 'distributed', joins: joinPlans };
      if (q.having && !grouped) no('HAVING without aggregation');
      if (!grouped) {
        F = this.finalBlock(cur, q, targets, order, (e) => sql(e, streamCol), null, null);
      } else {
        F = this.aggregate(cur, q, targets, groups, aggs, order, streamCol, plan);
      }
      plan.agg = plan.agg || null;
      // 4. output: sort, limit, gather
      const rows = this.output(F, q, targets.length, order, plan);
      return { rows, plan };
    }

    /** join two streams on equi-join keys [{ l, r }] plus residual predicates */
    join(L, R, keys, residual, streamCol) {
      const db = this.db, force = this.opts.join;
      const k = db.ids.length;
      const reasons = [];
      const hashedOn = (s, col) => s.part.kind === 'hash' && s.part.keys.includes(col) && s.part.nodes.join() === db.ids.join();
      let strategy, li = L, ri = R, part;
      const key = keys[0];
      const lb = L.rows * L.bytesPerRow, rb = R.rows * R.bytesPerRow;
      if (L.part.kind === 'replicated' && R.part.kind === 'replicated') { strategy = 'local'; reasons.push('both inputs are on every node'); part = { kind: 'replicated' }; }
      else if (R.part.kind === 'replicated' || L.part.kind === 'replicated') { strategy = 'local'; reasons.push((R.part.kind === 'replicated' ? 'right' : 'left') + ' input is replicated'); part = R.part.kind === 'replicated' ? L.part : R.part; }
      else if (key && !force && keys.some((x) => hashedOn(L, x.l) && hashedOn(R, x.r))) { strategy = 'co-located'; reasons.push('both inputs are hash-partitioned on the join key'); const x = keys.find((y) => hashedOn(L, y.l) && hashedOn(R, y.r)); part = { kind: 'hash', keys: L.part.keys.concat(R.part.keys, [x.l, x.r]), nodes: db.ids }; }
      else if (!key || force === 'fragment-replicate' || force === 'broadcast' || (force !== 'repartition' && Math.min(lb, rb) * (k - 1) < this.db.opts.broadcastFactor * ((hashedOn(L, key.l) ? 0 : lb) + (hashedOn(R, key.r) ? 0 : rb)) * (k - 1) / k)) {
        if (force === 'fragment-replicate' || (!key && force !== 'broadcast' && this.opts.grid)) {
          strategy = 'fragment-replicate';
          const m = gridShape(k);
          reasons.push(key ? 'forced' : 'no equi-join condition', m.rows + ' x ' + m.cols + ' grid of nodes');
          let rr = 0;
          li = this.exchange(L, 'grid', { what: 'fragment left', strategy, reason: 'fragment i of the left input goes to every node of row i', dest: () => { const i = rr++ % m.rows; return K.range(m.cols).map((j) => i * m.cols + j); } });
          let rs = 0;
          ri = this.exchange(R, 'grid', { what: 'fragment right', strategy, reason: 'fragment j of the right input goes to every node of column j', dest: () => { const j = rs++ % m.cols; return K.range(m.rows).map((i) => i * m.cols + j); } });
          li.at = ri.at = db.ids.slice(0, m.rows * m.cols);
          part = { kind: 'any' };
        } else {
          strategy = 'broadcast';
          const small = rb <= lb ? 'right' : 'left';
          reasons.push(key ? 'the ' + small + ' input (' + Math.min(lb, rb) + ' bytes) is cheaper to send everywhere than repartitioning' : 'no equi-join condition: the smaller input is replicated (asymmetric fragment-and-replicate)');
          if (force === 'broadcast') reasons.push('forced');
          if (small === 'right') { ri = this.exchange(R, 'broadcast', { to: L.at, what: 'broadcast right', strategy, reason: reasons[0], part: { kind: 'replicated' } }); part = L.part; }
          else { li = this.exchange(L, 'broadcast', { to: R.at, what: 'broadcast left', strategy, reason: reasons[0], part: { kind: 'replicated' } }); part = R.part; }
        }
      } else {
        strategy = 'repartition';
        reasons.push('hash both inputs on the join key ' + key.l + ' = ' + key.r);
        if (!hashedOn(L, key.l)) li = this.exchange(L, 'hash', { cols: [key.l], what: 'repartition left on ' + key.l, strategy, reason: reasons[0], part: { kind: 'hash', keys: [key.l], nodes: db.ids } });
        if (!hashedOn(R, key.r)) ri = this.exchange(R, 'hash', { cols: [key.r], what: 'repartition right on ' + key.r, strategy, reason: reasons[0], part: { kind: 'hash', keys: [key.r], nodes: db.ids } });
        part = { kind: 'hash', keys: [key.l, key.r], nodes: db.ids };
      }
      const cols = li.cols.concat(ri.cols);
      const cond = keys.map((x) => 'l.' + ident(x.l) + ' = r.' + ident(x.r)).concat(residual.map((e) => sql(e, (c) => { const n = streamCol(c); return (li.cols.some((x) => ident(x.name) === n) ? 'l.' : 'r.') + n; })));
      const at = part.kind === 'replicated' ? [li.at[0]] : (li.part.kind === 'replicated' ? ri.at : li.at);
      const name = this.tmp('join');
      const rows = this.everywhere('join', at, name, () => 'select ' + cols.map((c) => (li.cols.includes(c) ? 'l.' : 'r.') + ident(c.name)).join(', ') + ' from ' + li.name + ' l, ' + ri.name + ' r' + (cond.length ? ' where ' + cond.join(' and ') : ''), { strategy, reason: reasons.join('; '), what: [...L.aliases].join(',') + ' with ' + [...R.aliases].join(',') });
      const total = Object.values(rows).reduce((x, y) => x + y, 0);
      const outPart = part.kind === 'replicated' ? { kind: 'replicated' } : part;
      return { name, cols, at, part: outPart, aliases: new Set([...L.aliases, ...R.aliases]), rows: total, bytesPerRow: L.bytesPerRow + R.bytesPerRow, strategy };
    }

    /** group by and aggregates: local partials then a global combine, or repartition the rows on the group key */
    aggregate(S, q, targets, groups, aggs, order, streamCol, plan) {
      const db = this.db;
      const gtext = groups.map((g) => sql(g, streamCol));
      const decomposable = aggs.every((a) => ['count', 'sum', 'min', 'max', 'avg', 'bool_and', 'bool_or', 'every'].includes(a.e.name) && !a.e.distinct);
      // a group key that is the partitioning column means every group is already on one node
      const colocated = S.part.kind === 'hash' && groups.some((g) => g.k === 'col' && S.part.keys.some((k) => ident(k) === streamCol(g)));
      let mode = this.opts.agg || (S.part.kind === 'replicated' ? 'single' : colocated ? 'local' : decomposable ? 'two-phase' : 'repartition');
      if (mode === 'two-phase' && !decomposable) mode = 'repartition';
      if (mode === 'local' && !colocated) mode = decomposable ? 'two-phase' : 'repartition';
      plan.agg = mode;
      const gname = (i) => 'g' + i;
      if (mode === 'single' || mode === 'local') {
        const at = mode === 'single' ? [S.at[0]] : S.at;
        const hook = this.groupHook(gtext, gtext, streamCol, (a) => sql(a, streamCol));
        return this.finalBlock(Object.assign({}, S, { at }), q, targets, order, (e) => sql(e, streamCol, hook), gtext, (e) => sql(e, streamCol, hook), mode === 'single' ? 'one node holds everything' : 'groups are partitioned on the group key already');
      }
      if (mode === 'two-phase') {
        const parts = [];
        const comb = new Map();
        aggs.forEach((a, i) => {
          const f = a.e.name === 'every' ? 'bool_and' : a.e.name;
          const arg = a.e.star ? '*' : sql(a.e.args[0], streamCol);
          const filt = a.e.filter ? ' filter (where ' + sql(a.e.filter, streamCol) + ')' : '';
          if (f === 'count') { parts.push('count(' + arg + ')' + filt + ' as a' + i); comb.set(a.key, 'coalesce(sum(a' + i + '), 0)'); }
          else if (f === 'avg') { parts.push('sum(' + arg + ')' + filt + ' as a' + i + 's', 'count(' + arg + ')' + filt + ' as a' + i + 'c'); comb.set(a.key, '(sum(a' + i + 's) / nullif(sum(a' + i + 'c), 0))'); }
          else { parts.push(f + '(' + arg + ')' + filt + ' as a' + i); comb.set(a.key, (f === 'sum' ? 'sum' : f) + '(a' + i + ')'); }
        });
        const pname = this.tmp('partial');
        const sel = gtext.map((g, i) => g + ' as ' + gname(i)).concat(parts);
        this.everywhere('partial-agg', S.at, pname, () => 'select ' + sel.join(', ') + ' from ' + S.name + (gtext.length ? ' group by ' + gtext.join(', ') : ''), { what: 'partial aggregates per node', strategy: 'two-phase' });
        const pcols = this.colsOf(S.at[0], pname);
        let P1 = { name: pname, cols: pcols, at: S.at, part: { kind: 'any' } };
        P1 = groups.length ? this.exchange(P1, 'hash', { cols: groups.map((g, i) => gname(i)), what: 'repartition partial groups', strategy: 'two-phase', reason: 'all partials of a group meet on one node', part: { kind: 'hash', keys: [gname(0)], nodes: db.ids } })
          : this.exchange(P1, 'gather', { what: 'gather partials', strategy: 'two-phase', reason: 'one group: combine at the coordinator' });
        const refs = gtext.map((g, i) => gname(i));
        const hook = this.groupHook(gtext, refs, streamCol, (a) => comb.get(sql(a, streamCol)));
        return this.finalBlock(P1, q, targets, order, (e) => sql(e, streamCol, hook), refs, null, 'combine the partial aggregates');
      }
      // repartition the rows themselves on the group key (or gather them all for a single group)
      const xname = this.tmp('keyed');
      const withKeys = gtext.map((g, i) => g + ' as ' + gname(i));
      this.everywhere('project', S.at, xname, () => 'select *' + (withKeys.length ? ', ' + withKeys.join(', ') : '') + ' from ' + S.name, { what: 'compute the group key' });
      let X = { name: xname, cols: this.colsOf(S.at[0], xname), at: S.at, part: { kind: 'any' } };
      X = groups.length ? this.exchange(X, 'hash', { cols: groups.map((g, i) => gname(i)), what: 'repartition rows on the group key', strategy: 'repartition', reason: 'aggregates that cannot be split (' + aggs.filter((a) => !['count', 'sum', 'min', 'max', 'avg'].includes(a.e.name) || a.e.distinct).map((a) => a.key).join(', ') + ')', part: { kind: 'hash', keys: [gname(0)], nodes: db.ids } })
        : this.exchange(X, 'gather', { what: 'gather rows', strategy: 'repartition', reason: 'one group' });
      const refs = gtext.map((g, i) => gname(i));
      const hook = this.groupHook(gtext, refs, streamCol, (a) => sql(a, streamCol));
      return this.finalBlock(X, q, targets, order, (e) => sql(e, streamCol, hook), refs, null, 'aggregate each group where its rows met');
    }
    /** in the final block a group expression becomes its group column and an aggregate its combined form */
    groupHook(gtext, refs, streamCol, aggText) {
      const self = (e) => {
        if (isAgg(e)) return aggText(e);
        let t = null;
        try { t = sql(e, streamCol); } catch (x) { if (!(x instanceof Unsupported)) throw x; }
        const i = t === null ? -1 : gtext.indexOf(t);
        if (i >= 0) return refs[i];
        if (e.k === 'col') no('column ' + e.parts.join('.') + ' outside GROUP BY');
        return undefined;
      };
      return self;
    }
    colsOf(node, name) { const r = this.db.node(node).exec('select * from ' + name + ' limit 0'); return r[r.length - 1].cols.map((c) => ({ name: c.name, type: K.T.sqlName(c.type) })); }

    /** projection, HAVING and DISTINCT on each node of a stream: output columns o0.., sort keys k0.. */
    finalBlock(S, q, targets, order, map, groupBy, groupText, why) {
      const name = this.tmp('final');
      const sel = targets.map((e, i) => map(e) + ' as o' + i).concat(order.map((o, j) => map(o.expr) + ' as k' + j));
      const having = q.having ? ' having ' + map(q.having) : '';
      const gb = groupBy && groupBy.length ? ' group by ' + groupBy.join(', ') : '';
      const at = S.part.kind === 'replicated' ? [S.at[0]] : S.at;
      this.everywhere('final', at, name, () => 'select ' + (q.distinct ? 'distinct ' : '') + sel.join(', ') + ' from ' + S.name + gb + having, { what: why || 'projection' + (q.distinct ? ' and local distinct' : '') });
      return { name, cols: this.colsOf(at[0], name), at, part: at.length === 1 ? { kind: 'single' } : { kind: 'any' } };
    }

    /** ORDER BY / LIMIT / DISTINCT across the nodes, then the rows at the coordinator */
    output(F, q, nOut, order, plan) {
      const db = this.db;
      const outs = K.range(nOut).map((i) => 'o' + i);
      const keyList = order.map((o, j) => 'k' + j + ' ' + o.dir + (o.nulls ? ' nulls ' + o.nulls : ''));
      const orderBy = order.length ? ' order by ' + keyList.join(', ') : '';
      const lim = q.limit ? sql(q.limit, () => no('limit')) : null, off = q.offset ? sql(q.offset, () => no('offset')) : null;
      const limitSql = (lim !== null ? ' limit ' + lim : '') + (off !== null ? ' offset ' + off : '');
      const all = outs.concat(order.map((o, j) => 'k' + j));
      const fetch = (node, name, tail) => this.db.node(node).query('select ' + outs.join(', ') + ' from ' + name + tail).rows;
      const finalAt = (G, what) => {
        const inner = q.distinct ? '(select distinct ' + all.join(', ') + ' from ' + G.name + ') d' : G.name;
        const rows = fetch(db.coordId, inner, orderBy + limitSql);
        this.step('final', { nodes: [db.coordId], what, rows: { [db.coordId]: rows.length }, sql: { [db.coordId]: 'select ' + outs.join(', ') + ' from ' + inner + orderBy + limitSql } });
        return rows;
      };
      // one node holds the result: gather and finish at the coordinator
      if (F.at.length === 1) {
        plan.sort = order.length ? 'single node' : null;
        const G = F.at[0] === db.coordId ? F : this.exchange(F, 'gather', { what: 'gather result', strategy: 'gather' });
        return finalAt(G, order.length || lim !== null ? 'order and limit at the coordinator' : 'result at the coordinator');
      }
      if (lim !== null || (!order.length)) {
        if (lim !== null && order.length) {
          // each node keeps only its first limit+offset rows
          plan.sort = 'top-k';
          const n = Number(lim) + (off !== null ? Number(off) : 0);
          const tname = this.tmp('topk');
          this.everywhere('top-k', F.at, tname, () => 'select ' + (q.distinct ? 'distinct ' : '') + all.join(', ') + ' from ' + F.name + orderBy + ' limit ' + n, { what: 'local top ' + n });
          F = Object.assign({}, F, { name: tname });
        }
        const G = this.exchange(F, 'gather', { what: 'gather result', strategy: 'gather' });
        if (!q.distinct && !order.length && lim === null) { const rows = fetch(db.coordId, G.name, ''); this.step('final', { nodes: [db.coordId], what: 'concatenate', rows: { [db.coordId]: rows.length } }); return rows; }
        return finalAt(G, (q.distinct ? 'distinct, ' : '') + (order.length ? 'merge order' : '') + (lim !== null ? ', limit' : ''));
      }
      if (this.opts.sort === 'merge') {
        // each node sorts its rows; the coordinator merges the sorted runs
        plan.sort = 'merge';
        const runs = [];
        const types = order.map((o, j) => F.cols.find((c) => c.name === 'k' + j).type);
        for (const node of F.at) {
          const r = this.db.node(node).query('select ' + (q.distinct ? 'distinct ' : '') + all.join(', ') + ' from ' + F.name + orderBy);
          runs.push(r.rows);
          this.db.net.send(node, db.coordId, 'rows', { query: this.id, kind: 'sorted run', rows: r.rows.length }, { bytes: r.rows.reduce((x, y) => x + C.rowBytes(y), 0) });
          this.stats.messages++; this.stats.bytes += r.rows.reduce((x, y) => x + C.rowBytes(y), 0); this.stats.rowsShipped += r.rows.length;
        }
        this.db.net.settle();
        const cmp = this.rowCmp(order, types, nOut);
        const merged = [];
        const idx = runs.map(() => 0);
        for (;;) {
          let best = -1;
          for (let i = 0; i < runs.length; i++) if (idx[i] < runs[i].length && (best < 0 || cmp(runs[i][idx[i]], runs[best][idx[best]]) < 0)) best = i;
          if (best < 0) break;
          merged.push(runs[best][idx[best]++]);
        }
        let rows = merged;
        if (q.distinct) { const seen = new Set(); rows = rows.filter((r) => { const k = JSON.stringify(r.slice(0, nOut)); if (seen.has(k)) return false; seen.add(k); return true; }); }
        this.step('merge', { nodes: [db.coordId], what: 'merge ' + runs.length + ' sorted runs', rows: { [db.coordId]: rows.length } });
        return rows.map((r) => r.slice(0, nOut));
      }
      // range-partitioning sort: sample the first key, cut it into ranges, send each range to one node
      plan.sort = 'range';
      const ktype = F.cols.find((c) => c.name === 'k0').type;
      const typeObj = this.typeOf(F.at[0], F.name, 'k0');
      const o0 = order[0];
      const nullsFirst = o0.nulls ? o0.nulls === 'first' : o0.dir === 'desc';
      const pos = (a, b) => {
        if (a === b) return 0;
        if (a === null) return nullsFirst ? -1 : 1;
        if (b === null) return nullsFirst ? 1 : -1;
        const c = K.T.compare(K.T.input(a, typeObj), K.T.input(b, typeObj), typeObj);
        return o0.dir === 'desc' ? -c : c;
      };
      const sample = [];
      for (const node of F.at) {
        const r = this.db.node(node).query('select k0 from ' + F.name).rows;
        const every = Math.max(1, Math.floor(r.length / (this.opts.sampleSize || 16)));
        const mine = r.filter((x, i) => i % every === 0).map((x) => x[0]);
        sample.push(...mine);
        this.db.net.send(node, db.coordId, 'sample', { query: this.id, values: mine.length }, { bytes: mine.reduce((n, v) => n + (v === null ? 1 : String(v).length + 4), 0) });
        this.stats.control++;
      }
      this.db.net.settle();
      sample.sort(pos);
      const k = db.ids.length, bounds = [];
      for (let i = 1; i < k; i++) if (sample.length) bounds.push(sample[Math.min(sample.length - 1, Math.floor(sample.length * i / k))]);
      for (const node of db.ids) { this.db.net.send(db.coordId, node, 'ranges', { query: this.id, bounds }); this.stats.control++; }
      this.db.net.settle();
      this.step('sample', { nodes: F.at.slice(), what: 'sample k0 for range boundaries', bounds: bounds.slice(), sampleSize: sample.length, type: ktype });
      const ki = F.cols.findIndex((c) => c.name === 'k0');
      const route = (row) => { let i = 0; while (i < bounds.length && pos(row[ki], bounds[i]) > 0) i++; return i; };
      const Rg = this.exchange(F, 'range', { route, what: 'range-partition on the first sort key', strategy: 'range sort', reason: 'node i gets the i-th range of the sort key', part: { kind: 'range' } });
      const rows = [];
      for (const node of db.ids) {
        const r = this.db.node(node).query('select ' + outs.join(', ') + ' from ' + (q.distinct ? '(select distinct ' + all.join(', ') + ' from ' + Rg.name + ') d' : Rg.name) + orderBy).rows;
        if (r.length) { this.db.net.send(node, db.coordId, 'rows', { query: this.id, kind: 'sorted range', rows: r.length }, { bytes: r.reduce((x, y) => x + C.rowBytes(y), 0) }); this.stats.messages++; this.stats.bytes += r.reduce((x, y) => x + C.rowBytes(y), 0); this.stats.rowsShipped += r.length; }
        rows.push(...r);
      }
      this.db.net.settle();
      this.step('sort', { nodes: db.ids.slice(), what: 'each node sorts its range; the coordinator concatenates them in range order', rows: { [db.coordId]: rows.length } });
      return rows;
    }
    typeOf(node, name, col) { const r = this.db.node(node).exec('select ' + col + ' from ' + name + ' limit 0'); return r[r.length - 1].cols[0].type; }
    rowCmp(order, types, nOut) {
      return (a, b) => {
        for (let j = 0; j < order.length; j++) {
          const x = a[nOut + j], y = b[nOut + j], o = order[j];
          if (x === y) continue;
          const nf = o.nulls ? o.nulls === 'first' : o.dir === 'desc';
          if (x === null) return nf ? -1 : 1;
          if (y === null) return nf ? 1 : -1;
          const c = P().cmp(x, y, types[j]);
          if (c) return o.dir === 'desc' ? -c : c;
        }
        return 0;
      };
    }
  }

  /** an m x n grid with m * n <= k, as square as possible */
  function gridShape(k) { let r = Math.floor(Math.sqrt(k)); while (r > 1 && k % r) r--; return { rows: r, cols: Math.floor(k / r) }; }

  C.DistDB = DistDB;
  C.DQuery = { DistDB, sql, shapeProblem, tablesIn, gridShape, describe: () => DistDB.prototype.describe.call({ placement: () => [] }) };
})(typeof window !== 'undefined' ? window : globalThis);
