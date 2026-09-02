// The Distributed query view: SQL over the Theatre database partitioned across simulated nodes
// (K.Cluster.DistDB). It draws the distributed plan as stages (scans per node, exchanges with the rows and bytes
// they move between nodes, joins, partial and final aggregates, the parallel sort), plays the query's messages on
// the cluster canvas, checks the answer against one engine holding all the data, compares join, aggregation and
// sort strategies by what they ship, and shows the semijoin reduction between two sites.
(function (root) {
  'use strict';
  const K = root.K;
  const UI = K.UI;
  const { h, s } = UI;
  const C = () => K.Cluster;

  const EXAMPLES = [
    ['join', 'Join, repartitioned', 'select c.city, count(*) as artists\nfrom company c join artist a on c.company_id = a.company_id\ngroup by c.city\norder by c.city'],
    ['coloc', 'Join, co-located', 'select p.name, count(*) as bookings\nfrom patron p join booking b on p.patron_id = b.patron_id\ngroup by p.name\norder by bookings desc, p.name\nlimit 10'],
    ['three', 'Three-way join', "select b.booking_id, p.name, f.perf_date, b.seats\nfrom patron p join booking b on p.patron_id = b.patron_id join performance f on b.perf_id = f.perf_id\nwhere f.venue_code = 'GLA' and f.perf_date < date '2025-01-01'\norder by b.booking_id"],
    ['agg', 'Aggregation', 'select company_id, count(*), avg(fee), max(fee)\nfrom artist\ngroup by company_id\norder by company_id'],
    ['distinct', 'Aggregate that cannot be split', 'select prod_id, count(distinct person_id) as artists\nfrom casting\ngroup by prod_id\norder by artists desc, prod_id\nlimit 8'],
    ['sort', 'Parallel sort', 'select booking_id, patron_id, perf_id, seats, paid\nfrom booking\norder by perf_id, booking_id'],
    ['topk', 'Top-k', 'select billed_as, fee from artist order by fee desc, person_id limit 5'],
    ['nonequi', 'Join without an equality', 'select count(*) from artist a, artist b where a.fee > 2 * b.fee'],
    ['ship', 'Subquery (shipped whole)', 'select name from patron where patron_id in (select patron_id from booking where rating = 5) order by name'],
  ];
  const PLACEMENTS = [
    ['mixed', 'Mixed (some co-partitioned, small tables replicated)', null],
    ['hash', 'Hash on each primary key', { venue: { scheme: 'hash', key: 'venue_code' }, stage: { scheme: 'hash', key: 'venue_code' }, company: { scheme: 'hash', key: 'company_id' }, person: { scheme: 'hash', key: 'person_id' }, artist: { scheme: 'hash', key: 'person_id' }, production: { scheme: 'hash', key: 'prod_id' }, performance: { scheme: 'hash', key: 'perf_id' }, casting: { scheme: 'hash', key: 'person_id' }, patron: { scheme: 'hash', key: 'patron_id' }, booking: { scheme: 'hash', key: 'booking_id' }, mentor: { scheme: 'hash', key: 'mentor_id' } }],
    ['rr', 'Round-robin everywhere', 'rr'],
    ['small', 'Small tables replicated, the rest hashed', { venue: { scheme: 'replicated' }, stage: { scheme: 'replicated' }, company: { scheme: 'replicated' }, production: { scheme: 'replicated' } }],
  ];
  const SEMI = [
    { id: 'city', label: 'artist ⋈ companies in Quillmere', left: 'artist', right: 'company', on: ['company_id', 'company_id'], rightWhere: "city = 'Quillmere'" },
    { id: 'opera', label: 'casting ⋈ operas', left: 'casting', right: 'production', on: ['prod_id', 'prod_id'], rightWhere: "genre = 'opera'" },
    { id: 'patron', label: 'booking ⋈ patrons from Saltreach', left: 'booking', right: 'patron', on: ['patron_id', 'patron_id'], rightWhere: "city = 'Saltreach'" },
    { id: 'all', label: 'artist ⋈ every company', left: 'artist', right: 'company', on: ['company_id', 'company_id'] },
  ];
  const KIND = { scan: ['Scan', 'c0'], exchange: ['Exchange', 'c1'], join: ['Join', 'c2'], 'partial-agg': ['Partial aggregation', 'c3'], final: ['Final', 'c7'], project: ['Project', 'c7'], 'top-k': ['Local top-k', 'c6'], sample: ['Sample the sort key', 'c6'], sort: ['Parallel sort', 'c6'], merge: ['Merge sorted runs', 'c6'] };
  const EXK = { hash: 'repartition on a hash of the key', broadcast: 'broadcast to every node', gather: 'gather at the coordinator', range: 'range repartition', grid: 'fragment and replicate' };
  const bag = (rows) => rows.map((r) => JSON.stringify(r)).sort();
  const sameRows = (sql, a, b) => (/\border\s+by\b/i.test(sql) ? JSON.stringify(a) === JSON.stringify(b) : JSON.stringify(bag(a)) === JSON.stringify(bag(b)));

  function create(app, el) {
    const CK = UI.CK;
    const st = Object.assign({ nodes: 4, place: 'mixed', ex: 'join', semi: 'city' }, UI.store.get('dq.opts', {}));
    if (!PLACEMENTS.some((x) => x[0] === st.place)) st.place = 'mixed';
    if (!EXAMPLES.some((x) => x[0] === st.ex)) st.ex = 'join';
    st.sql = UI.store.get('dq.sql', null) || EXAMPLES.find((x) => x[0] === st.ex)[2];
    let db = null, run = null, ref = null, err = null, cmp = null, semi = null, stage = null, dbKey = null;
    const body = h('div.view-body.ck-body');
    el.appendChild(body);
    const save = () => { UI.store.set('dq.opts', { nodes: st.nodes, place: st.place, ex: st.ex, semi: st.semi }); UI.store.set('dq.sql', st.sql); };

    const ta = h('textarea.dq-sql', { spellcheck: 'false', 'aria-label': 'SQL to run on the cluster', onkeydown: (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); go(); } }, oninput: () => { st.sql = ta.value; save(); } });
    ta.value = st.sql;
    const ctl = h('div.ck-controls');
    const out = h('div.ck-host');
    body.appendChild(CK.about('The coordinator splits a query into fragments that run where the data lives: scans with their selections pushed down, then exchange operators that ship rows so that a join or a group meets on one node (repartitioning on the key, broadcasting the smaller input, or nothing when the inputs are already co-partitioned), and partial aggregates combined after the exchange. Every fragment is SQL run by a real engine on its node, and the answer is checked against one engine holding all the data.'));
    body.appendChild(ctl);
    body.appendChild(ta);
    body.appendChild(h('div.dq-bar', UI.btn('run', 'Run on the cluster', 'Run (Ctrl+Enter)', () => go(), 'primary small'), UI.btn('refresh', 'Compare strategies', 'Run the query with every join, aggregation and sort strategy that applies', () => compare(), 'small'), h('span.ck-note', 'Ctrl+Enter runs')));
    body.appendChild(out);

    function drawControls() {
      ctl.innerHTML = '';
      ctl.appendChild(CK.select('Example', [['', 'Your own query']].concat(EXAMPLES.map((x) => [x[0], x[1]])), EXAMPLES.some((x) => x[0] === st.ex && x[2] === st.sql) ? st.ex : '', (v) => { if (!v) return; st.ex = v; st.sql = ta.value = EXAMPLES.find((x) => x[0] === v)[2]; save(); go(); }));
      ctl.appendChild(CK.select('Nodes', [2, 3, 4, 5, 6].map((n) => [n, n + ' nodes']), st.nodes, (v) => { st.nodes = v; save(); go(); }));
      ctl.appendChild(CK.select('Placement', PLACEMENTS.map((p) => [p[0], p[1]]), st.place, (v) => { st.place = v; save(); go(); }));
    }
    function ensureDb() {
      const key = st.nodes + '|' + st.place;
      if (db && dbKey === key) return db;
      CK.theatre();
      const p = PLACEMENTS.find((x) => x[0] === st.place)[2];
      const specs = p === 'rr' ? Object.fromEntries(C().theatre().names.map((n) => [n, { scheme: 'round-robin' }])) : p;
      db = new (C().DistDB)({ nodes: st.nodes, seed: 1, latency: 5 }).loadTheatre(specs || undefined);
      dbKey = key; cmp = null; semi = null;
      return db;
    }
    function go() {
      drawControls();
      run = null; err = null;
      if (stage) { stage.destroy(); stage = null; }
      CK.later(out, db ? 'Running on ' + st.nodes + ' nodes…' : 'Loading the Theatre database into ' + st.nodes + ' nodes…', () => {
        ensureDb();
        err = null; run = null; ref = null; cmp = null;
        try { run = db.query(st.sql.trim().replace(/;\s*$/, '')); } catch (e) { err = e; }
        if (run) { try { ref = db.reference(st.sql.trim().replace(/;\s*$/, '')); } catch (e) { ref = null; } }
        draw();
      });
    }
    function compare() {
      if (!run) { go(); return; }
      CK.later(cmpBox(), 'Running the query with each strategy…', () => {
        const q = run.sql;
        const v = [['chosen by the planner', {}]];
        if (run.plan.joins && run.plan.joins.length) v.push(['repartition join', { join: 'repartition' }], ['broadcast join', { join: 'broadcast' }], ['fragment and replicate', { join: 'fragment-replicate' }]);
        if (run.plan.agg) v.push(['two-phase aggregation', { agg: 'two-phase' }], ['repartition aggregation', { agg: 'repartition' }]);
        if (run.plan.sort) v.push(['merge at the coordinator', { sort: 'merge' }]);
        if (v.length === 1) v.push(['ship every table to the coordinator', { strategy: 'ship' }]);
        const keep = run;
        cmp = v.map(([name, o]) => { try { const r = db.query(q, o); return { name, o, r, same: ref ? sameRows(q, r.rows, ref.rows) : null }; } catch (e) { return { name, o, err: e }; } });
        run = keep;
        draw();
      });
    }
    let cmpEl = null;
    const cmpBox = () => { if (!cmpEl) { cmpEl = h('div'); out.appendChild(cmpEl); } return cmpEl; };

    function draw() {
      out.innerHTML = ''; cmpEl = null;
      if (stage) { stage.destroy(); stage = null; }
      out.appendChild(placementBox());
      if (err) { out.appendChild(h('div.res-err', h('div.err-line', h('span.err-tag', 'ERROR'), h('span.err-msg', err.message), err.code ? h('span.err-code', err.code) : null))); return; }
      if (!run) return;
      const p = run.plan, S = run.stats;
      const chips = [CK.badge(p.kind === 'ship' ? 'shipped to the coordinator' : 'distributed', p.kind === 'ship' ? 'warn' : 'acc')];
      for (const j of p.joins || []) chips.push(CK.badge('join: ' + j.strategy));
      if (p.agg) chips.push(CK.badge('aggregation: ' + p.agg));
      if (p.sort) chips.push(CK.badge('sort: ' + p.sort));
      out.appendChild(CK.section('The plan', h('div.ck-kv', chips), p.kind === 'ship' ? h('p.ck-note', 'Not taken apart (' + p.reason + '): every table it reads is shipped to the coordinator, which runs the statement as written.') : null,
        h('div.ck-kv', h('span', h('b', CK.num(S.messages)), ' data messages'), h('span', h('b', CK.bytes(S.bytes)), ' shipped'), h('span', h('b', CK.num(S.rowsShipped)), ' rows moved'), h('span', h('b', String(S.fragments)), ' SQL fragments'), h('span', h('b', String(S.control)), ' control messages')),
        ref ? CK.ok(sameRows(st.sql, run.rows, ref.rows), sameRows(st.sql, run.rows, ref.rows) ? 'Same result as one engine holding all the data: ' + UI.plural(run.rows.length, 'row') + '.' : 'The result differs from the single-node result.') : null));
      // the query's messages, played on the cluster
      const host = h('div');
      out.appendChild(CK.section('The query on the cluster', host));
      stage = CK.stage({ el: host });
      stage.load(querySrc(run, db), 0);
      out.appendChild(CK.section('Result', resultTable(run)));
      const cb = cmpBox();
      if (cmp) drawCompare(cb);
      out.appendChild(semiBox());
    }
    function placementBox() {
      const rows = db.placement().map((x) => h('tr', h('td', x.table), h('td', x.scheme + (x.key ? ' on ' + x.key : '')), h('td', x.scheme === 'replicated' ? 'a copy on every node' : x.sizes.join(' · '))));
      return h('details.ck-sec', h('summary.ck-h', 'Where the tables are (' + st.nodes + ' nodes)'), h('div.ck-tbl', h('table.grid.small', h('thead', h('tr', h('th', 'Table'), h('th', 'Partitioning'), h('th', 'Rows per node'))), h('tbody', rows))));
    }
    function resultTable(r) {
      const max = 12;
      return h('div', h('div.ck-tbl', h('table.grid.small', h('thead', h('tr', r.cols.map((c) => h('th', c.name)))), h('tbody', r.rows.slice(0, max).map((row) => h('tr', row.map((v) => h('td' + (v === null ? '.null' : ''), v === null ? 'NULL' : v))))))), r.rows.length > max ? h('p.ck-note', 'and ' + (r.rows.length - max) + ' more rows') : null);
    }
    function drawCompare(box) {
      box.innerHTML = '';
      const ok = cmp.filter((x) => x.r);
      const best = Math.min(...ok.map((x) => x.r.stats.bytes));
      const rows = cmp.map((x) => x.err ? h('tr.bad', h('td', x.name), h('td', { colspan: '5' }, x.err.message)) : h('tr' + (x.r.stats.bytes === best ? '.good' : ''), h('td', x.name), h('td', (x.r.plan.joins || []).map((j) => j.strategy).join(', ') + (x.r.plan.agg ? ' · agg ' + x.r.plan.agg : '') + (x.r.plan.sort ? ' · sort ' + x.r.plan.sort : '') || x.r.plan.kind), h('td.num', CK.num(x.r.stats.messages)), h('td.num', CK.bytes(x.r.stats.bytes)), h('td.num', CK.num(x.r.stats.rowsShipped)), h('td', x.same === null ? '?' : x.same ? '✓ same' : '✗ differs')));
      box.appendChild(CK.section('Strategies compared', h('div.ck-tbl', h('table.grid.small', h('thead', h('tr', h('th', 'Strategy'), h('th', 'Plan'), h('th.num', 'Messages'), h('th.num', 'Bytes'), h('th.num', 'Rows moved'), h('th', 'Result'))), h('tbody', rows))),
        CK.bars(ok.map((x) => ({ label: x.name, value: x.r.stats.bytes, note: CK.bytes(x.r.stats.bytes), cls: x.r.stats.bytes === best ? 'best c4' : 'c1' }))),
        h('p.ck-note', 'Every strategy returns the same rows; they differ in what crosses the network. A broadcast join ships the small input to every node; a repartition join ships both inputs once; a co-located join ships nothing.')));
    }
    function semiBox() {
      const box = h('div');
      const draw2 = () => {
        box.innerHTML = '';
        const pre = SEMI.find((x) => x.id === st.semi) || SEMI[0];
        const ctl2 = h('div.ck-controls', CK.select('Join', SEMI.map((x) => [x.id, x.label]), pre.id, (v) => { st.semi = v; save(); semi = null; draw2(); }));
        if (!semi || semi.id !== pre.id) { try { semi = Object.assign({ id: pre.id }, db.semijoin(pre)); } catch (e) { semi = { id: pre.id, err: e }; } }
        const r = semi;
        const kids = [h('p.ck-note', 'Site ' + db.ids[0] + ' holds ' + pre.left + ' (r), site ' + db.ids[1] + ' holds ' + pre.right + ' (s)' + (pre.rightWhere ? ' and the condition ' + pre.rightWhere + ' on s' : '') + '; the result is wanted at ' + db.ids[1] + '. A semijoin ships only the distinct join values of s to r\'s site, so that only the rows of r that will join travel back.'), ctl2];
        if (r.err) kids.push(h('div.res-err', r.err.message));
        else {
          const best = Math.min(...r.strategies.map((x) => x.bytes));
          kids.push(CK.bars(r.strategies.map((x) => ({ label: x.name, value: x.bytes, note: CK.bytes(x.bytes) + ', ' + UI.plural(x.messages, 'message'), cls: x.bytes === best ? 'best c4' : 'c1' }))));
          kids.push(h('div.ck-cols', r.strategies.map((x) => h('div.ck-box' + (x.bytes === best ? '.on' : ''), h('h4', x.name), h('ul.ck-loglist.wrap', x.ships.map((sh) => h('li', { title: sh.what }, sh.from + ' → ' + sh.to + ': ' + sh.what + ', ' + UI.plural(sh.rows, 'row') + ', ' + CK.bytes(sh.bytes))))))));
          const red = r.strategies[2].reduced;
          kids.push(h('p.ck-note', 'The semijoin cut r from ' + red.before + ' to ' + red.after + ' rows before shipping it.'));
          kids.push(CK.ok(r.sameResult, r.sameResult ? 'All three give the same ' + UI.plural(r.rows.length, 'row') + '; the cheapest here is ' + r.best + '.' : 'The strategies disagree.'));
        }
        box.appendChild(CK.section('Semijoin reduction', ...kids));
      };
      draw2();
      return box;
    }

    /** a playable recording of the query's messages, with the stage list as its panel */
    function querySrc(r, d) {
      const ids = d.ids.slice(), coord = d.coordId;
      const bytes = new Map(), io = {};
      for (const id of ids.concat([coord])) io[id] = { in: 0, out: 0 };
      const t0 = r.trace.length ? r.trace[0].t : 0;
      const rec = CK.fromTrace(r.trace, {
        t0,
        group: (e) => e.kind + '|' + e.t + '|' + (e.type || e.what || ''),
        apply: (e) => {
          if (e.kind === 'send') bytes.set(e.msg, e.bytes);
          if (e.kind === 'deliver' && e.type === 'rows' && io[e.to] && io[e.from]) { const b = bytes.get(e.msg) || 0; io[e.to].in += b; io[e.from].out += b; }
        },
        snap: () => JSON.parse(JSON.stringify(io)),
        start: 'The coordinator has the plan; press play to watch the fragments and rows travel.',
      });
      rec.frames[0].s = JSON.parse(JSON.stringify(Object.fromEntries(Object.keys(io).map((k) => [k, { in: 0, out: 0 }]))));
      const stepAt = (f) => { if (f.i === 0) return -1; const k = r.steps.findIndex((x) => x.t >= f.t); return k < 0 ? r.steps.length - 1 : k; };
      return {
        rec, base: 12, noCrash: true, noLinks: true,
        // the coordinator and the nodes on one ellipse around the network hub: fragments, exchanged rows and results
        // all go along the sender's spoke and the receiver's
        layout: (f, w) => ({ height: ids.length > 4 ? 330 : 290, nodes: CK.circle([coord].concat(ids), { narrow: w < 520 }).concat([{ id: CK.HUB, x: 0.5, y: 0.5, kind: 'hub' }]), links: CK.spokes([coord].concat(ids)) }),
        card(id, f) {
          const x = f.s[id] || { in: 0, out: 0 };
          const k = stepAt(f), step = r.steps[k];
          const busy = step && step.nodes && step.nodes.includes(id) && step.rows && step.rows[id] !== undefined;
          return { title: id, cls: (busy ? 'hot' : '') + (id === coord ? ' lead' : ''), lines: [h('span', 'in ', h('b', CK.bytes(x.in))), h('span', 'out ', h('b', CK.bytes(x.out))), busy ? h('span', h('b', CK.num(step.rows[id])), ' rows') : ''] };
        },
        panel(el2, f) { const k = stepAt(f); el2.appendChild(CK.section('The plan as a tree', planTree(r, k))); el2.appendChild(stagesList(r, k)); },
      };
    }
    function stagesList(r, cur) {
      const box = h('div.dq-stages');
      r.steps.forEach((x, i) => {
        if (i) box.appendChild(h('div.dq-arrow'));
        const [name, c] = KIND[x.kind] || [x.kind, 'c7'];
        const title = x.kind === 'exchange' ? 'Exchange: ' + (EXK[x.exchange] || x.exchange) : x.kind === 'join' ? 'Join, ' + x.strategy : name;
        const kids = [h('div.dq-st', h('span.dq-k', (i + 1) + '. ' + title), x.what ? h('span.dq-w', x.what) : null)];
        if (x.reason) kids.push(h('div.dq-why', x.reason));
        if (x.kind === 'exchange') { kids.push(flowTable(x)); kids.push(h('div.dq-why', CK.num(x.rowsShipped) + ' rows, ' + CK.bytes(x.bytes) + ' in ' + UI.plural(x.messages, 'message') + ' crossed the network' + (x.flows.some((fl) => fl.local) ? '; the shaded cells are rows that stay on their node' : ''))); }
        else if (x.rows) kids.push(h('div.dq-nodes', Object.entries(x.rows).map(([n, v]) => h('span.dq-nc', n + ' ', h('b', CK.num(v)), ' rows'))));
        if (x.kind === 'sample' && x.bounds) kids.push(h('div.dq-why', 'boundaries: ' + x.bounds.join(' | ')));
        if (x.sql) { const n0 = Object.keys(x.sql)[0]; kids.push(h('details', h('summary', 'SQL run on ' + (Object.keys(x.sql).length > 1 ? 'each node' : n0)), h('pre', x.sql[n0]))); }
        box.appendChild(h('div.dq-stage.' + c + (i === cur ? '.on' : ''), kids));
      });
      return box;
    }
    /**
     * an exchange as a matrix: a row per sending node, a column per receiving node, the rows each pair ships. Every
     * node can send to every node, which no drawing of lines shows without crossings
     */
    function flowTable(x) {
      const src = x.from, dst = x.nodes;
      const at = new Map(x.flows.map((f) => [f.from + '>' + f.to, f]));
      const max = Math.max(1, ...x.flows.filter((f) => !f.local).map((f) => f.rows));
      const cell = (a, b) => {
        const f = at.get(a + '>' + b);
        if (!f || !f.rows) return h('td' + (a === b ? '.local' : ''), '·');
        return h('td' + (f.local ? '.local' : ''), { style: f.local ? null : '--w: ' + Math.round(8 + (40 * f.rows) / max) + '%', title: a + ' → ' + b + ': ' + f.rows + ' rows' + (f.local ? ' (stay on the node)' : ', ' + CK.bytes(f.bytes)) }, CK.num(f.rows));
      };
      return h('div.dq-mxbox', { style: { overflowX: 'auto' } }, h('table.mr-matrix.dq-mx', { 'aria-label': 'rows shipped from each node to each node' },
        h('thead', h('tr', h('th', 'from ╲ to'), dst.map((b) => h('th', b)))),
        h('tbody', src.map((a) => h('tr', h('th', a), dst.map((b) => cell(a, b)))))));
    }
    /**
     * the plan as a tree, drawn tidy: each step under the step that reads its output, leaves (the scans) at the
     * bottom, a parent centred over its children, each child's arrow arriving at its own point on the parent's lower
     * edge. Scans read the stored tables; any other step reads the steps whose results its SQL names (an exchange,
     * the stream it ships); a step that names none reads the one before it, and a step nobody reads (the sample of
     * the sort key) feeds the next one
     */
    function planTree(r, cur) {
      const steps = r.steps, n = steps.length;
      if (!n) return h('p.ck-note', 'No steps.');
      const kids = steps.map(() => []), parent = steps.map(() => -1);
      steps.forEach((x, i) => {
        const text = x.sql ? Object.values(x.sql).join(' ') : '';
        let ins = [];
        for (let j = 0; j < i; j++) { const t = steps[j].table; if (t && (x.input === t || (text && new RegExp('\\b' + t + '\\b').test(text)))) ins.push(j); }
        if (!ins.length && i && x.kind !== 'scan') ins = [i - 1];
        for (const j of ins) if (parent[j] < 0) { parent[j] = i; kids[i].push(j); }
      });
      for (let j = 0; j < n - 1; j++) if (parent[j] < 0) { parent[j] = j + 1; kids[j + 1].push(j); kids[j + 1].sort((a, b) => a - b); }
      // the boxes are as wide as the longest title needs (an upper bound on the font's character widths), within limits;
      // a longer subtitle is shortened, and the box's tooltip and the step list below give it whole
      const CW = { k: 7, w: 6.4 };
      const titleOf = (x, i) => (i + 1) + '. ' + (x.kind === 'exchange' ? 'Exchange: ' + x.exchange : x.kind === 'join' ? 'Join, ' + x.strategy : (KIND[x.kind] || [x.kind])[0]);
      const subOf = (x) => x.what || (x.kind === 'exchange' ? EXK[x.exchange] || x.exchange : '');
      const BW = Math.round(Math.min(230, Math.max(150, ...steps.map((x, i) => Math.max(titleOf(x, i).length * CW.k, Math.min(subOf(x).length, 26) * CW.w) + 18)))), BH = 54, GX = 18, GY = 30;
      const xs = [], depth = [];
      let next = 0;
      const place = (i, d) => { depth[i] = d; if (!kids[i].length) { xs[i] = next++; return; } kids[i].forEach((k) => place(k, d + 1)); xs[i] = (xs[kids[i][0]] + xs[kids[i][kids[i].length - 1]]) / 2; };
      place(n - 1, 0);
      const D = Math.max(...depth.filter((v) => v !== undefined));
      const W = next * (BW + GX) - GX + 8, H = (D + 1) * (BH + GY) - GY + 8;
      const X = (i) => 4 + xs[i] * (BW + GX), Y = (i) => 4 + depth[i] * (BH + GY);
      // drawn at its own size: on a narrow screen the box scrolls rather than shrinking the text
      const svg = s('svg', { class: 'dq-tree', viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, role: 'img', 'aria-label': 'the distributed plan as a tree of ' + n + ' steps' });
      const id = 'dqa' + (++trees);
      svg.appendChild(s('defs', {}, s('marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' }, s('path', { d: 'M0 0L10 5L0 10z', class: 'dq-ah' }))));
      // the data flows up: an arrow from each child's top to its parent's bottom
      steps.forEach((x, i) => {
        if (parent[i] < 0 || depth[i] === undefined) return;
        const p = parent[i], k = kids[p].indexOf(i), m = kids[p].length;
        svg.appendChild(s('line', { x1: X(i) + BW / 2, y1: Y(i), x2: X(p) + (BW * (k + 1)) / (m + 1), y2: Y(p) + BH + 1, class: 'dq-te' + (x.kind === 'exchange' ? ' ex' : ''), 'marker-end': 'url(#' + id + ')' }));
      });
      const fit = (t, cw) => { const max = Math.floor((BW - 18) / cw); return t.length > max ? t.slice(0, max - 1) + '…' : t; };
      // the detail wraps at word boundaries onto two lines; only a detail longer than that is shortened (the box's
      // tooltip and the step list give it whole)
      const wrap2 = (t) => {
        const max = Math.floor((BW - 18) / CW.w), words = t.split(/\s+/), lines = [''];
        for (const w of words) {
          const cur = lines[lines.length - 1], next = cur ? cur + ' ' + w : w;
          if (next.length <= max) lines[lines.length - 1] = next;
          else if (lines.length < 2 && cur) lines.push(w.length > max ? w.slice(0, max - 1) + '…' : w);
          else { lines[lines.length - 1] = fit(next, CW.w); lines.more = true; break; }
        }
        return lines.slice(0, 2);
      };
      steps.forEach((x, i) => {
        if (depth[i] === undefined) return;
        const c = (KIND[x.kind] || [x.kind, 'c7'])[1];
        const title = titleOf(x, i), sub = subOf(x);
        svg.appendChild(s('g', { class: 'dq-tn ' + c + (x.kind === 'exchange' ? ' ex' : '') + (i === cur ? ' on' : '') },
          s('title', { text: title + (sub ? ': ' + sub : '') }),
          s('rect', { x: X(i), y: Y(i), width: BW, height: BH, rx: 7 }),
          s('text', { x: X(i) + 9, y: Y(i) + 16, class: 'k', text: fit(title, CW.k) }),
          ...(sub ? wrap2(sub).map((ln, k) => s('text', { x: X(i) + 9, y: Y(i) + 31 + k * 13, class: 'w', text: ln })) : [])));
      });
      return h('div.dq-treebox', { style: { overflowX: 'auto' } }, svg);
    }
    let trees = 0;
    drawControls();
    go();
    return {
      render() { if (stage) stage.redraw(); },
      destroy() { if (stage) stage.destroy(); },
      /** for tests: run SQL and wait */
      run(sql, o) { if (sql) { st.sql = ta.value = sql; } if (o) Object.assign(st, o); save(); go(); },
      compare,
      get result() { return { run, ref, err, cmp, semi }; },
      get stage() { return stage; },
    };
  }
  UI.registerView({ id: 'dquery', title: 'Distributed query', icon: 'share', group: 'Distributed', order: 61, create });
})(typeof window !== 'undefined' ? window : globalThis);
