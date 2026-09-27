// Performance tuning (Ch. 25): an index advisor and a small benchmark. The advisor takes a workload of queries
// with frequencies, derives candidate indexes from their WHERE and join columns, and asks the optimizer for each
// query's estimated cost (EXPLAIN) without and with each candidate: the candidates are built in a private session
// inside a transaction that is rolled back, so the database is not changed, and a what-if switch hides the ones
// not in the set being priced. It picks indexes greedily by benefit per page and can apply them; the workload can
// then be run to compare the simulated I/O. The benchmark runs new-order transactions from N clients side by side
// (sessions stepped together) and plots throughput, aborts and lock waits as N grows, under READ COMMITTED and
// SERIALIZABLE.
(function (root) {
  'use strict';
  const K = root.K;
  const UI = K.UI;
  const { h, s } = UI;

  const PRESETS = {
    boxoffice: { title: 'Box office (lookups)', sql: `-- weight 50
select name, city, points from patron where patron_id = 42;
-- weight 40
select perf_id, seats, paid, rating from booking where patron_id = 42;
-- weight 20
select patron_id, points from patron where name = 'Priya Quintero';
-- weight 15
select b.patron_id, b.seats, f.perf_date, f.start_time
from booking b join performance f on f.perf_id = b.perf_id
where f.prod_id = 'PR115';
-- weight 10
select billed_as, fee from artist where company_id = 'C08';
-- weight 10
select patron_id, name from patron where points > 900;
-- weight 5
select prod_id, title from production where genre = 'opera' and runtime_min > 150;` },
    reports: { title: 'Season reports (scans)', sql: `-- weight 20
select city, count(*) as patrons, avg(points) from patron group by city;
-- weight 10
select prod_id, count(*) from performance where perf_date between date '2025-01-01' and date '2025-06-30' group by prod_id;
-- weight 10
select p.genre, sum(b.seats) from booking b join performance f on f.perf_id = b.perf_id join production p on p.prod_id = f.prod_id group by p.genre;
-- weight 5
select company_id, max(fee) from artist group by company_id;
-- weight 5
select venue_code, count(*) from performance where perf_date >= date '2025-09-01' group by venue_code;` },
  };

  /** split a workload into statements, each with the weight from a "-- weight N" line before it */
  function parseWorkload(text) {
    const out = [];
    for (const chunk of text.split(/;\s*(?:\n|$)/)) {
      const m = /--\s*weight\s*(\d+)/i.exec(chunk);
      const sql = chunk.replace(/--[^\n]*/g, '').trim();
      if (!sql) continue;
      out.push({ sql, w: m ? Math.max(1, +m[1]) : 1 });
    }
    return out;
  }

  /** the columns a query restricts or joins on, per table: [{ table (rel), col, kind: 'eq' | 'range' | 'join' }] */
  function predicateColumns(ast, cat, path) {
    const tables = [];
    const out = [];
    const fromItem = (f, conds) => {
      if (!f) return;
      if (f.kind === 'table') { const rel = cat.lookup(f.name, path); if (rel && rel.kind === 'table') tables.push({ rel, alias: (f.alias && f.alias.name) || f.name.name }); return; }
      if (f.kind === 'join') { fromItem(f.left, conds); fromItem(f.right, conds); if (f.on) conds.push(f.on); if (f.using) conds.push({ k: 'using', cols: f.using, l: f.left, r: f.right }); }
    };
    const conds = [];
    (ast.from || []).forEach((f) => fromItem(f, conds));
    if (ast.where) conds.push(ast.where);
    const has = (rel, c) => rel.cols.some((x) => !x.dropped && x.name === c);
    const resolve = (e) => {
      if (!e || e.k !== 'col') return null;
      const p = e.parts, c = p[p.length - 1];
      if (p.length >= 2) { const t = tables.find((x) => x.alias === p[p.length - 2]); return t && has(t.rel, c) ? { rel: t.rel, col: c } : null; }
      const t = tables.find((x) => has(x.rel, c));
      return t ? { rel: t.rel, col: c } : null;
    };
    const isConst = (e) => e && (e.k === 'lit' || e.k === 'param' || (e.k === 'cast' && isConst(e.e)));
    let group = 0;
    const add = (r, kind, g) => { if (r) out.push({ rel: r.rel, col: r.col, kind, g }); };
    const walk = (e) => {
      if (!e || typeof e !== 'object') return;
      if (e.k === 'and' || e.k === 'or') { walk(e.l); walk(e.r); return; }
      if (e.k === 'using') { const g = ++group; for (const c of e.cols) for (const t of tables) if (has(t.rel, c)) add({ rel: t.rel, col: c }, 'join', g); return; }
      if (e.k === 'op' && ['=', '<', '>', '<=', '>='].includes(e.op)) {
        const l = resolve(e.l), r = resolve(e.r);
        if (l && r) { add(l, 'join', curGroup || ++group); add(r, 'join', curGroup || group); return; }
        if (l && isConst(e.r)) add(l, e.op === '=' ? 'eq' : 'range');
        if (r && isConst(e.l)) add(r, e.op === '=' ? 'eq' : 'range');
        return;
      }
      if (e.k === 'between' && !e.neg) { add(resolve(e.e), 'range'); return; }
      if (e.k === 'in' && !e.neg && e.list) { add(resolve(e.e), 'eq'); return; }
      if (e.k === 'like' && !e.neg && e.pat && e.pat.k === 'lit' && /^[^%_]/.test(e.pat.v)) add(resolve(e.e), 'range');
    };
    let curGroup = 0;
    conds.forEach((c) => { curGroup = c.k === 'using' || c === ast.where ? 0 : ++group; walk(c); });
    return out;
  }

  /** the scans and index probes of a plan, as a short line */
  function access(plan) {
    const out = [];
    const walk = (n) => {
      if (!n) return;
      const rel = n.rel && n.rel.name;
      if (n.op === 'SeqScan') out.push('seq scan ' + rel);
      else if (n.op === 'IndexScan' || n.op === 'IndexOnlyScan') out.push((n.op === 'IndexOnlyScan' ? 'index-only ' : 'index ') + (n.index ? n.index.name : rel));
      else if (n.op === 'BitmapScan') out.push('bitmap ' + (n.indexes || []).map((x) => x.index.name).join('+'));
      else if (n.op === 'IndexNestLoopJoin' && n.index) out.push('probe ' + n.index.name);
      (n.children || []).forEach(walk);
    };
    walk(plan);
    return [...new Set(out)].join(', ');
  }

  // ---- the benchmark ---------------------------------------------------------------------------------------------------------
  const BENCH_SETUP = `drop schema if exists bench cascade;
create schema bench;
create table bench.district (d_id int primary key, next_o_id int not null);
create table bench.customer (c_id int primary key, d_id int, balance numeric(10,2));
create table bench.stock (i_id int primary key, qty int);
create table bench.orders (o_id int, d_id int, c_id int, primary key (d_id, o_id));
create table bench.order_line (o_id int, d_id int, n int, i_id int, qty int, primary key (d_id, o_id, n));
insert into bench.district values (1, 1), (2, 1);
insert into bench.customer select g, 1 + g % 2, 1000 from generate_series(1, 30) g;
insert into bench.stock select g, 1000 from generate_series(1, 100) g;`;
  /** a new-order transaction (as in TPC-C): read the customer, take the district's next order number, insert the order, then per line update the stock and insert the line */
  function newOrder(rnd, iso) {
    const c = rnd.int(1, 30), d = 1 + (c % 2), n = rnd.int(2, 4);
    const st = ['begin isolation level ' + iso, 'select balance from bench.customer where c_id = ' + c, 'update bench.district set next_o_id = next_o_id + 1 where d_id = ' + d,
      'insert into bench.orders select next_o_id - 1, d_id, ' + c + ' from bench.district where d_id = ' + d];
    for (let i = 0; i < n; i++) { const it = rnd.int(1, 100), q = rnd.int(1, 5); st.push('update bench.stock set qty = qty - ' + q + ' where i_id = ' + it, 'insert into bench.order_line select next_o_id - 1, d_id, ' + i + ', ' + it + ', ' + q + ' from bench.district where d_id = ' + d); }
    st.push('commit');
    return st;
  }

  function create(app, el) {
    const A = UI.ADV;
    let preset = UI.store.get('tuning.preset', 'boxoffice');
    if (preset !== 'custom' && !PRESETS[preset]) { preset = 'boxoffice'; UI.store.set('tuning.preset', preset); UI.store.set('tuning.sql', PRESETS.boxoffice.sql); }
    let text = UI.store.get('tuning.sql', PRESETS[preset] ? PRESETS[preset].sql : PRESETS.boxoffice.sql);
    let scale = null;
    let budget = UI.store.get('tuning.budget', 0);
    let result = null, busy = null, applied = null;
    const runs = [];
    const bench = { clients: [1, 2, 4, 8], tx: UI.store.get('tuning.benchTx', 20), seed: 7, results: null, busy: false, progress: '' };

    el.appendChild(h('div.view-intro', h('b', 'Tuning starts from the workload: which queries run, and how often. '), 'An index speeds up the queries that can use it but costs space and slows every update, so a tuning advisor asks the optimizer what each query would cost with each candidate index and picks the set with the most benefit per page. A benchmark then measures what really matters to users: transactions per second as the load grows.'));
    const head = h('div.view-head.adv-head');
    const body = h('div.view-body.adv-body.tu');
    el.appendChild(head); el.appendChild(body);

    const bookingRows = () => { try { return A.privately(app, 'tuning', (s2) => { const r = s2.catalog.lookup({ name: 'booking' }, s2.searchPath()); return r ? Math.max(app.db.liveOf(r), (app.db.statsOf(r) || {}).rows || 0) : 0; }); } catch (e) { return 0; } };
    const defaultScale = () => (bookingRows() < 10000 ? 100 : 1);

    /**
     * plan inside the private session with the tables seen F times larger: row and page counts grow, and so does
     * the number of distinct values of columns that have many (ids, names) but not of those with few (cities,
     * genres, ratings).
     */
    function withScale(s2, F, f) {
      const db = app.db;
      const scaled = new Map();
      if (F !== 1) {
        const sp = K.Database.prototype.statsOf, lo = K.Database.prototype.liveOf, bl = Object.getPrototypeOf(db.disk).blocks;
        db.statsOf = function (rel) { const st = sp.call(this, rel); if (!st) return st; if (!scaled.has(st)) scaled.set(st, Object.assign({}, st, { rows: st.rows * F, cols: (st.cols || []).map((c) => (c && c.ndistinct >= 40 ? Object.assign({}, c, { ndistinct: c.ndistinct * F }) : c)) })); return scaled.get(st); };
        db.liveOf = function (rel) { return lo.call(this, rel) * F; };
        db.disk.blocks = function (file) { return bl.call(this, file) * F; };
      }
      try { return f(); } finally { delete db.statsOf; delete db.liveOf; delete db.disk.blocks; }
    }
    const planOf = (s2, q) => s2.plan(K.parse(q.sql)[0]).plan;

    // ---- the advisor -----------------------------------------------------------------------------------------------------
    function analyse() {
      if (busy) return;
      const F = scale || defaultScale();
      const qs = parseWorkload(text);
      if (!qs.length) { UI.toast('The workload is empty', 'warn'); return; }
      busy = { text: 'Reading the workload…' };
      draw();
      const s2 = app.db.session({ name: 'tuning advisor' });
      const steps = [];
      const res = { F, queries: [], cands: [], skipped: [], chosen: [], error: null };
      const fail = (e) => { res.error = e.message; finish(); };
      const finish = () => { A.close(app, s2); busy = null; result = res; draw(); };
      try {
        for (const q of qs) {
          let ast;
          try { ast = K.parse(q.sql); } catch (e) { res.queries.push(Object.assign({}, q, { error: e.message })); continue; }
          if (ast.length !== 1 || ast[0].type !== 'select') { res.queries.push(Object.assign({}, q, { error: 'only SELECT statements are analysed' })); continue; }
          let base;
          try { base = withScale(s2, F, () => planOf(s2, q)); } catch (e) { res.queries.push(Object.assign({}, q, { error: e.message })); continue; }
          res.queries.push(Object.assign({}, q, { ast: ast[0], base: base.cost, baseAccess: access(base), preds: predicateColumns(ast[0], s2.catalog, s2.searchPath()) }));
        }
        // candidates: each restricted or joined column, and the equality columns of one table in one query together
        const seen = new Map();
        const addCand = (rel, cols, qi) => {
          const key = rel.oid + ':' + cols.join(',');
          if (!seen.has(key)) seen.set(key, { rel, table: rel.name, schema: rel.schema, cols, from: new Set() });
          seen.get(key).from.add(qi);
        };
        // and the columns a table is joined on, together, as an index for an indexed nested-loop join would need
        const groups = (list, keyOf) => { const m = new Map(); for (const p of list) { const k = keyOf(p); if (!m.has(k)) m.set(k, { rel: p.rel, cols: [] }); const g = m.get(k); if (!g.cols.includes(p.col)) g.cols.push(p.col); } return [...m.values()]; };
        res.queries.forEach((q, qi) => {
          if (!q.preds) return;
          for (const p of q.preds.filter((x) => x.kind !== 'join')) addCand(p.rel, [p.col], qi);
          for (const g of groups(q.preds.filter((x) => x.kind === 'eq'), (p) => p.rel.oid)) if (g.cols.length > 1) addCand(g.rel, g.cols.slice(0, 3), qi);
          for (const g of groups(q.preds.filter((x) => x.kind === 'join'), (p) => p.rel.oid + ':' + p.g)) addCand(g.rel, g.cols.slice(0, 4), qi);
        });
        // an existing index whose leading columns are the candidate's already does its job
        for (const c of seen.values()) {
          const have = s2.catalog.indexesOf(c.rel).find((ix) => c.cols.every((col, i) => ix.keys[i] && ix.keys[i].attnum !== undefined && c.rel.cols[ix.keys[i].attnum] && c.rel.cols[ix.keys[i].attnum].name === col));
          if (have) res.skipped.push(Object.assign(c, { covered: have.name })); else res.cands.push(c);
        }
        // a dozen candidates at most, those of the most frequent queries first, so the advisor stays quick on large tables
        if (res.cands.length > 12) { const wOf = (c) => Math.max(...[...c.from].map((i) => res.queries[i].w)); res.cands.sort((a, b) => wOf(b) - wOf(a)); res.cands.length = 12; }
        res.cands.forEach((c, i) => { c.name = ('tune_' + c.table + '_' + c.cols.join('_')).slice(0, 60); c.i = i; c.ddl = 'create index ' + c.name + ' on ' + (c.schema === 'public' ? '' : c.schema + '.') + c.table + ' (' + c.cols.join(', ') + ')'; });
        s2.exec('begin');
        res.cands.forEach((c) => steps.push(() => { busy.text = 'Building candidate ' + (c.i + 1) + ' of ' + res.cands.length + ' (' + c.table + ' (' + c.cols.join(', ') + ')) in the private transaction…'; s2.exec(c.ddl); c.rel2 = s2.catalog.lookup({ schema: c.schema, name: c.name }, s2.searchPath()); c.pages = app.db.disk.blocks(c.rel2.file) * F; }));
        steps.push(() => {
          busy.text = 'Pricing the workload with each set of indexes…';
          const costs = (set) => { res.cands.forEach((c) => { c.rel2.invalid = !set.includes(c); }); return withScale(s2, F, () => res.queries.map((q) => (q.ast ? planOf(s2, q) : null))); };
          const total = (plans) => plans.reduce((a, p, i) => a + (p ? p.cost * res.queries[i].w : 0), 0);
          const baseTotal = total(costs([]));
          for (const c of res.cands) { const p = costs([c]); c.alone = baseTotal - total(p); c.helps = p.map((x, i) => (x && res.queries[i].base - x.cost > 1e-6 ? i : -1)).filter((i) => i >= 0); }
          // greedy: add the candidate with the largest extra benefit per page, while it helps and fits the budget
          let cur = baseTotal, used = 0;
          for (;;) {
            let best = null;
            for (const c of res.cands) {
              if (res.chosen.includes(c) || c.alone <= 1e-6) continue;
              if (budget && used + c.pages > budget) continue;
              const gain = cur - total(costs(res.chosen.concat([c])));
              if (gain > Math.max(1e-6, cur * 0.002) && (!best || gain / c.pages > best.gain / best.c.pages)) best = { c, gain };
            }
            if (!best) break;
            res.chosen.push(best.c); best.c.gain = best.gain; best.c.order = res.chosen.length; cur -= best.gain; used += best.c.pages;
          }
          const fin = costs(res.chosen);
          res.queries.forEach((q, i) => { if (fin[i]) { q.after = fin[i].cost; q.afterAccess = access(fin[i]); } });
          res.baseTotal = baseTotal; res.afterTotal = cur; res.pages = used;
          s2.exec('rollback');
          res.cands.forEach((c) => { delete c.rel2; });
        });
      } catch (e) { fail(e); return; }
      const next = () => {
        if (!steps.length) { finish(); return; }
        try { steps.shift()(); } catch (e) { fail(e); return; }
        draw();
        setTimeout(next, 0);
      };
      setTimeout(next, 0);
    }

    function bars(res) {
      const qs = res.queries.filter((q) => q.ast);
      const max = Math.max(...qs.map((q) => q.base * q.w), 1e-9);
      return h('div.tu-bars', qs.map((q) => {
        const i = res.queries.indexOf(q);
        const b = q.base * q.w, a = (q.after === undefined ? q.base : q.after) * q.w;
        const pct = b > 0 ? Math.round((1 - a / b) * 100) : 0;
        return h('div.tu-bar', h('div.tu-bq', h('b', 'Q' + (i + 1)), h('span.tu-w', '×' + q.w), h('code', { title: q.sql }, q.sql.replace(/\s+/g, ' '))),
          h('div.tu-bt', h('i.b', { style: 'width:' + (100 * b / max).toFixed(2) + '%' }), h('i.a', { style: 'width:' + (100 * a / max).toFixed(2) + '%' })),
          h('div.tu-bv', A.num(b, 1) + ' → ' + A.num(a, 1) + ' ms', pct > 0 ? h('span.tu-save', ' −' + pct + '%') : null),
          h('div.tu-ba', q.baseAccess + (q.afterAccess && q.afterAccess !== q.baseAccess ? '  ⟶  ' + q.afterAccess : '')));
      }));
    }
    function advisorPanel() {
      const res = result;
      if (!res) return null;
      if (res.error) return A.sec('What the advisor found', null, h('div.res-err', res.error));
      const bad = res.queries.filter((q) => q.error);
      const save = res.baseTotal ? 1 - res.afterTotal / res.baseTotal : 0;
      const ddl = res.chosen.map((c) => c.ddl + ';').join('\n');
      const scaleNote = res.F === 1 ? 'Costs are the optimizer\'s estimates for this database as it is.' : 'Costs are the optimizer\'s estimates for tables ' + res.F + ' times their present size (row and page counts scaled, as a tuning tool does with statistics copied from production); on today\'s small tables a sequential scan of a few pages beats any index.';
      const useless = res.cands.filter((c) => c.alone <= 1e-6);
      const candRows = res.cands.filter((c) => c.alone > 1e-6).sort((a, b) => (a.order || 99) - (b.order || 99) || b.alone - a.alone).map((c) => h('tr' + (c.order ? '.good' : ''),
        h('td.txt', c.order ? A.badge('#' + c.order, 'ok') : c.alone > 1e-6 ? A.badge(budget && c.pages > budget ? 'too big' : 'not needed', 'warn') : A.badge('no use', '')),
        h('td', c.table + ' (' + c.cols.join(', ') + ')'), h('td.num', A.num(c.pages, 0)), h('td.num', A.num(c.alone, 1)), h('td.num', c.pages ? A.num(c.alone / c.pages, 2) : '–'),
        h('td.txt', [...c.from].map((i) => 'Q' + (i + 1)).join(' ') + (c.helps.length ? ' · helps ' + c.helps.map((i) => 'Q' + (i + 1)).join(' ') : ''))));
      return h('div.tu-res',
        A.sec('What the advisor found', null,
          A.note(scaleNote, ' Each bar is a query\'s cost times its frequency: grey without new indexes, blue with the recommended ones.'),
          h('div.adv-kpis', kpi('Cost now', A.num(res.baseTotal, 0) + ' ms'), kpi('With indexes', A.num(res.afterTotal, 0) + ' ms'), kpi('Saving', Math.round(save * 100) + '%'), kpi('Index pages', A.num(res.pages, 0)), kpi('Indexes', res.chosen.length + ' of ' + res.cands.length)),
          bars(res),
          bad.length ? A.note(h('b', 'Not analysed: '), bad.map((q) => 'Q' + (res.queries.indexOf(q) + 1) + ' (' + q.error + ')').join('; ')) : null),
        A.sec('Candidate indexes', [A.select('Space budget', [[0, 'no limit'], [50, '50 pages'], [200, '200 pages'], [1000, '1,000 pages']], budget, (v) => { budget = v; UI.store.set('tuning.budget', v); analyse(); })],
          A.note('Candidates come from the columns the queries restrict (WHERE) or join on, one index per column plus one per group of equality columns. Each was built inside a transaction that was then rolled back; its size is the pages it took (×' + res.F + '). ', h('b', 'Benefit'), ' is the weighted cost it saves on its own; the advisor adds the one with the most extra benefit per page, prices the workload again with the set chosen so far (indexes overlap: two may help the same query), and stops when nothing helps or the budget is spent.'),
          candRows.length ? h('div.adv-tbl', h('table.grid', h('thead', h('tr', h('th', ''), h('th', 'Index on'), h('th.num', 'Pages'), h('th.num', 'Benefit (ms)'), h('th.num', 'Per page'), h('th', 'From · helps'))), h('tbody', candRows))) : null,
          useless.length ? A.note(h('b', 'No benefit' + (candRows.length ? '' : ' from any candidate') + ': '), useless.map((c) => c.table + ' (' + c.cols.join(', ') + ')').join(', ') + '. The optimizer would not use them: the column is not selective enough, or a scan or another index is cheaper.') : null,
          res.skipped.length ? A.note(h('b', 'Already indexed: '), res.skipped.map((c) => c.table + ' (' + c.cols.join(', ') + ') by ' + c.covered).join('; ') + '.') : null),
        A.sec('Recommendation', res.chosen.length ? [UI.btn('check', applied ? 'Applied' : 'Apply to the database', 'Create these indexes in the database (in the active tab)', applyIt, applied ? '' : 'primary'), applied ? UI.btn('trash', 'Drop them again', null, dropIt, 'ghost') : null] : null,
          res.chosen.length ? A.sqlBox(app, ddl, { noRun: true }) : A.note('No index pays for itself on this workload' + (res.F === 1 ? ' at this size: the tables are small enough that sequential scans are cheapest. Plan for a larger database (×10 or ×100) to see what would change as it grows.' : '.')),
          res.chosen.length ? A.note('Every index also slows down each INSERT, UPDATE and DELETE on its table and takes space in the buffer pool; a real advisor weighs the update rate of the workload too.') : null));
    }
    function applyIt() {
      if (!result || !result.chosen.length) return;
      applied = result.chosen.map((c) => ({ name: c.name, schema: c.schema, ddl: c.ddl }));
      app.runText(applied.map((c) => c.ddl + ';').join('\n'));
      draw();
    }
    function dropIt() {
      if (!applied) return;
      app.runText(applied.map((c) => 'drop index if exists ' + (c.schema === 'public' ? '' : c.schema + '.') + c.name + ';').join('\n'));
      applied = null; draw();
    }

    // ---- measured I/O ---------------------------------------------------------------------------------------------------
    function measure() {
      const qs = parseWorkload(text);
      const label = 'Run ' + (runs.length + 1) + (applied ? ' (with the advisor\'s indexes)' : runs.length ? '' : ' (before)');
      const per = A.privately(app, 'tuning measure', (s2) => qs.map((q) => {
        const b0 = Object.assign({}, app.db.buffers.stats), d0 = Object.assign({}, app.db.disk.stats);
        let err = null, plan = '';
        try { plan = access(s2.plan(K.parse(q.sql)[0]).plan); s2.exec(q.sql); } catch (e) { err = e.message; }
        const b1 = app.db.buffers.stats, d1 = app.db.disk.stats;
        return { pages: b1.hits + b1.misses - b0.hits - b0.misses, reads: d1.reads - d0.reads, ms: d1.ms - d0.ms, plan, err, w: q.w };
      }));
      runs.push({ label, per, total: per.reduce((a, x) => a + x.pages * x.w, 0), ms: per.reduce((a, x) => a + x.ms * x.w, 0) });
      app.updateStatus && app.updateStatus();
      draw();
    }
    function measurePanel() {
      const qs = parseWorkload(text);
      const table = runs.length ? h('div.adv-tbl', h('table.grid', h('thead', h('tr', h('th', 'Query'), h('th.num', 'Weight'), runs.map((r) => h('th.num', { title: r.label }, r.label.replace(/ \(.*/, ''))), runs.length > 1 ? h('th', 'Access path (last run)') : h('th', 'Access path'))),
        h('tbody', qs.map((q, i) => h('tr', h('td', 'Q' + (i + 1)), h('td.num', String(q.w)), runs.map((r) => h('td.num', r.per[i] ? (r.per[i].err ? 'error' : A.num(r.per[i].pages, 0)) : '–')), h('td.txt', runs[runs.length - 1].per[i] ? runs[runs.length - 1].per[i].plan : ''))),
          h('tr.tu-tot', h('td', h('b', 'Weighted total')), h('td', ''), runs.map((r) => h('td.num', h('b', A.num(r.total, 0)))), h('td.txt', 'page accesses (buffer hits + misses) × weight'))))) : null;
      return A.sec('Measured on this database', [UI.btn('run', 'Run the workload', 'Run every query once in a private session and count the pages it touched', measure, result && !runs.length ? 'primary' : '')],
        A.note('Estimates are only estimates: run the workload before applying the recommendation and again after, and compare the pages each query really touched in the buffer pool. ', result && result.F !== 1 ? 'The advisor planned for a database ' + result.F + ' times larger, so on today\'s tables the optimizer may still prefer sequential scans and the counts change little: the indexes are for the database the tables will grow into.' : ''),
        table, runs.length ? h('div.adv-row', UI.btn('trash', 'Forget the runs', null, () => { runs.length = 0; draw(); }, 'ghost')) : null);
    }

    // ---- the benchmark ----------------------------------------------------------------------------------------------------
    function runBench() {
      if (bench.busy) return;
      bench.busy = true; bench.results = [];
      const configs = [];
      for (const iso of ['read committed', 'serializable']) for (const n of bench.clients) configs.push({ iso, n });
      const admin = app.db.session({ name: 'bench' });
      let cfgI = -1, st = null;
      /** close the clients, drop the schema and close the admin session, whether the run ended or was stopped */
      const cleanup = (msg) => {
        if (st) { for (const cl of st.clients) { if (cl.r && !cl.r.done) cl.r.cancel(); A.close(app, cl.s); } st = null; }
        try { admin.exec('drop schema if exists bench cascade'); } catch (e) { console.error(e); }
        A.close(app, admin);
        bench.busy = false; bench.progress = msg || ''; app.emit('schema');
        draw();
      };
      const startConfig = () => {
        cfgI++;
        if (cfgI >= configs.length) { cleanup(''); return false; }
        const c = configs[cfgI];
        admin.exec(BENCH_SETUP);
        const rnd = A.rng(bench.seed);
        st = { c, rnd, clients: Array.from({ length: c.n }, (_, i) => ({ s: app.db.session({ name: 'client ' + (i + 1) }), q: [], cur: null, r: null })), done: 0, started: 0, aborts: 0, ser: 0, dead: 0, waits: 0, ticks: 0 };
        return true;
      };
      const tick = () => {
        const c = st;
        for (const cl of c.clients) {
          if (cl.r && !cl.r.done) continue;
          if (cl.r && cl.r.error) {
            // a failed transaction is rolled back and retried by its client, as an application would
            c.aborts++; if (cl.r.error.code === '40001') c.ser++; else if (cl.r.error.code === '40P01') c.dead++;
            if (cl.s.tx) cl.s.exec('rollback');
            cl.q = cl.cur.slice();
          } else if (cl.r && !cl.q.length) { c.done++; cl.cur = null; }
          cl.r = null;
          if (!cl.q.length) { if (c.started >= bench.tx) continue; cl.cur = newOrder(c.rnd, c.c.iso); cl.q = cl.cur.slice(); c.started++; }
          cl.r = cl.s.start(cl.q.shift());
        }
        app.db.step();
        c.ticks++;
        for (const cl of c.clients) if (cl.r && !cl.r.done) c.waits++;
        return c.clients.some((cl) => cl.r) && c.ticks < 4000;
      };
      const endConfig = () => {
        const c = st;
        for (const cl of c.clients) { if (cl.r && !cl.r.done) cl.r.cancel(); A.close(app, cl.s); }
        st = null;
        bench.results.push({ iso: c.c.iso, n: c.c.n, done: c.done, aborts: c.aborts, ser: c.ser, dead: c.dead, waits: c.waits, ticks: c.ticks, tput: c.done / Math.max(1, c.ticks) });
      };
      const loop = () => {
        if (!bench.busy) { cleanup(bench.progress); return; }
        const until = performance.now() + 40;
        try {
          while (performance.now() < until) {
            if (!st) { if (!startConfig()) return; }
            if (!tick()) endConfig();
          }
        } catch (e) { console.error(e); cleanup('The benchmark stopped: ' + e.message); return; }
        if (st) bench.progress = configs[cfgI].iso.toUpperCase() + ', ' + UI.plural(configs[cfgI].n, 'client') + ': ' + st.done + ' of ' + bench.tx + ' committed, step ' + st.ticks;
        drawBench();
        setTimeout(loop, 0);
      };
      draw();
      setTimeout(loop, 0);
    }
    function chart(res) {
      const W = 520, H = 220, l = 46, r = 16, t = 14, b = 34;
      const ns = bench.clients;
      const X = (n) => l + (ns.indexOf(n) / Math.max(1, ns.length - 1)) * (W - l - r);
      const raw = Math.max(0.05, ...res.map((x) => x.tput)) * 1.05 / 4, mag = Math.pow(10, Math.floor(Math.log10(raw)));
      const max = 4 * mag * [1, 2, 2.5, 5, 10].find((m) => m * mag >= raw);
      const Y = (v) => t + (1 - v / max) * (H - t - b);
      const g = [];
      for (let k = 0; k <= 4; k++) { const v = (max * k) / 4; g.push(s('line', { class: 'tu-gl', x1: l, x2: W - r, y1: Y(v), y2: Y(v) }), s('text', { x: l - 6, y: Y(v) + 4, 'text-anchor': 'end' }, String(+v.toFixed(3)))); }
      ns.forEach((n) => g.push(s('text', { x: X(n), y: H - b + 18, 'text-anchor': 'middle' }, String(n))));
      g.push(s('text', { x: (l + W - r) / 2, y: H - 4, 'text-anchor': 'middle', class: 'tu-axl' }, 'concurrent clients'));
      g.push(s('text', { x: 12, y: (t + H - b) / 2, 'text-anchor': 'middle', class: 'tu-axl', transform: 'rotate(-90 12 ' + (t + H - b) / 2 + ')' }, 'commits per step'));
      for (const iso of ['read committed', 'serializable']) {
        const pts = res.filter((x) => x.iso === iso);
        if (!pts.length) continue;
        const cls = iso === 'serializable' ? 'ser' : 'rc';
        g.push(s('polyline', { class: 'tu-line ' + cls, points: pts.map((p) => X(p.n) + ',' + Y(p.tput)).join(' ') }));
        pts.forEach((p) => g.push(s('circle', { class: 'tu-pt ' + cls, cx: X(p.n), cy: Y(p.tput), r: 4.5 }, s('title', {}, iso + ', ' + p.n + ' clients: ' + p.tput.toFixed(3) + ' commits per step'))));
      }
      return h('div.adv-scroll', s('svg', { class: 'adv-svg tu-chart', width: W, height: H, viewBox: '0 0 ' + W + ' ' + H }, g));
    }
    const benchEl = h('div');
    function drawBench() {
      benchEl.innerHTML = '';
      const res = bench.results || [];
      const tools = [A.select('Transactions per run', [[10, '10'], [20, '20'], [40, '40']], bench.tx, (v) => { bench.tx = v; UI.store.set('tuning.benchTx', v); }), bench.busy ? UI.btn('stop', 'Stop', null, () => { bench.busy = false; bench.progress = 'Stopped.'; drawBench(); }) : UI.btn('run', 'Run the benchmark', 'Run every configuration (it takes a few seconds)', runBench, 'primary')];
      benchEl.appendChild(A.sec('Benchmark: new-order transactions', tools,
        A.note('Like TPC-C\'s new-order transaction, each one reads a customer, takes the next order number from one of only two district rows, inserts the order and, per line, updates the stock and inserts the line. N clients run ' + bench.tx + ' transactions between them, each a session of its own; in every ', h('b', 'step'), ' each client that is not blocked runs one statement, so steps stand in for time. The schema bench is created for each run and dropped at the end, and the clients draw their transactions from the same seeded sequence, so every run gives the same numbers.'),
        h('details.tu-det', h('summary', 'One transaction'), h('pre.ls-sql', UI.highlightSql(newOrder(A.rng(1), 'serializable').join(';\n') + ';'))),
        bench.busy || bench.progress ? h('div.adv-busy', bench.busy ? h('span.adv-spin') : null, bench.progress || 'Starting…') : null,
        res.length ? h('div.adv-split.tu-bench', h('div', chart(res), h('div.adv-legend', h('span', h('i.tu-krc'), 'READ COMMITTED'), h('span', h('i.tu-kser'), 'SERIALIZABLE'))),
          h('div.adv-tbl', h('table.grid', h('thead', h('tr', h('th', 'Isolation'), h('th.num', 'Clients'), h('th.num', 'Steps'), h('th.num', 'Commits/step'), h('th.num', 'Aborts'), h('th.num', 'Lock waits'))),
            h('tbody', res.map((x) => h('tr', h('td.txt', x.iso === 'serializable' ? 'serializable' : 'read committed'), h('td.num', String(x.n)), h('td.num', String(x.ticks)), h('td.num', x.tput.toFixed(3)), h('td.num', { title: x.ser + ' serialization failures, ' + x.dead + ' deadlocks' }, String(x.aborts)), h('td.num', String(x.waits)))))))) : null,
        res.length > 4 ? A.note(h('b', 'Reading it: '), 'under READ COMMITTED more clients overlap their work until they queue for the two district rows (the lock waits grow), so throughput levels off: the hot spot, not the hardware, is the bottleneck. Under SERIALIZABLE two transactions that update the same district row cannot both commit, so one is aborted and retried: the work is done twice and throughput stays where one client is. Tuning such a workload means removing the hot spot (an order number per client or a sequence) or accepting a weaker isolation level where it is safe.') : null));
    }

    function draw() {
      if (scale === null) scale = defaultScale();
      head.innerHTML = '';
      head.appendChild(A.select('Workload', Object.entries(PRESETS).map(([k, v]) => [k, v.title]).concat([['custom', 'My own queries']]), preset, (v) => { preset = v; UI.store.set('tuning.preset', v); if (PRESETS[v]) { text = PRESETS[v].sql; UI.store.set('tuning.sql', text); } result = null; draw(); }));
      head.appendChild(A.select('Plan for', [[1, 'this database'], [10, '10× larger'], [100, '100× larger']], scale, (v) => { scale = v; result = null; draw(); }, 'Estimate costs as if every table were this much larger'));
      head.appendChild(busy ? h('span.adv-busy', h('span.adv-spin'), busy.text) : UI.btn('bolt', 'Run the advisor', 'Price the workload with each candidate index', analyse, 'primary'));
      body.innerHTML = '';
      const ta = h('textarea.tu-sql', { spellcheck: 'false', 'aria-label': 'Workload', rows: '10', oninput: (e) => { text = e.target.value; UI.store.set('tuning.sql', text); if (preset !== 'custom' && PRESETS[preset] && text !== PRESETS[preset].sql) { preset = 'custom'; UI.store.set('tuning.preset', preset); } } });
      ta.value = text;
      body.appendChild(A.sec('Workload', null, A.note('One statement per entry, ended by a semicolon; a line ', h('code', '-- weight 30'), ' before a query says how often it runs (relative to the others). Paste your own queries to tune them.'), ta));
      const adv = advisorPanel();
      if (adv) body.appendChild(adv);
      body.appendChild(measurePanel());
      drawBench();
      body.appendChild(benchEl);
    }
    const kpi = (k, v) => h('div.adv-kpi', h('div.k', k), h('div.v', v));
    return { render() { if (!busy) draw(); }, onDb() { result = null; applied = null; runs.length = 0; scale = null; }, destroy() { bench.busy = false; } };
  }

  UI.registerView({ id: 'tuning', title: 'Tuning', icon: 'bolt', group: 'Advanced', order: 96, create });
})(typeof window !== 'undefined' ? window : globalThis);
