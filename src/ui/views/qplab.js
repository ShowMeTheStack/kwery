// The query processing lab (Ch. 15): the same join run with every algorithm on a copy of the database with a cold
// buffer pool, its measured block reads, seeks and time next to the cost formula; and external sort-merge
// drawn as runs and merge passes for a table, a sort key and M buffer blocks.
(function (root) {
  'use strict';
  const K = root.K;
  const UI = K.UI;
  const { h, s } = UI;

  const ALGS = [
    ['NestLoopJoin', 'Nested loop', 'n_r · b_s + b_r transfers, n_r + b_r seeks'],
    ['BlockNestLoopJoin', 'Block nested loop', '⌈b_r / (M − 2)⌉ · b_s + b_r transfers, 2 · ⌈b_r / (M − 2)⌉ seeks'],
    ['IndexNestLoopJoin', 'Indexed nested loop', 'b_r · (tT + tS) + n_r · c'],
    ['MergeJoin', 'Merge join', 'b_r + b_s transfers after sorting, plus the sorts'],
    ['HashJoin', 'Hash join', 'b_r + b_s, or 3 · (b_r + b_s) + 4 · n_h when partitioned'],
  ];
  const PRESETS = [
    ['booking ⋈ patron', 'select count(*) from booking b join patron p on b.patron_id = p.patron_id'],
    ['performance ⋈ stage', 'select count(*) from performance f join stage s on f.venue_code = s.venue_code and f.stage_no = s.stage_no'],
    ['artist ⋈ casting', 'select count(*) from artist a join casting c on a.person_id = c.person_id'],
    ['artist ⋈ mentor', 'select count(*) from artist a join mentor m on a.person_id = m.mentee_id'],
  ];

  /** run one query on a private copy of the database: cold buffer pool of M frames, one algorithm forced */
  function trial(snap, sql, alg, frames, settings) {
    const db = K.Snapshot.load(snap, { frames });
    const ses = db.session({ name: 'lab' });
    for (const [k, v] of Object.entries(settings || {})) ses.settings[k] = v;
    ses.settings.force_join = alg;
    ses.settings.work_mem_pages = Math.max(3, frames - 2);
    db.disk.resetStats(); db.buffers.resetStats();
    const t0 = K.now();
    const r = ses.query('explain analyze ' + sql);
    const ms = K.now() - t0;
    const find = (n) => (n.op === alg ? n : (n.children || []).map(find).find(Boolean));
    const node = find(r.plan);
    return { alg, used: !!node, plan: r.plan, io: Object.assign({}, db.disk.stats), buf: Object.assign({}, db.buffers.stats), ms, node, rows: node && node.rt ? node.rt.rows : 0, text: r.rows.map((x) => x[0]).join('\n') };
  }

  function create(app, el) {
    let tab = UI.store.get('qplab.tab', 'join');
    let sql = UI.store.get('qplab.sql', PRESETS[0][1]);
    let frames = UI.store.get('qplab.frames', 8);
    let results = null, busy = false;
    let sortRel = UI.store.get('qplab.sortRel', 'booking'), sortCol = UI.store.get('qplab.sortCol', 'paid'), M = UI.store.get('qplab.M', 4), sortStep = 0;
    el.appendChild(h('div.view-intro', h('b', 'Query processing, measured. '), 'The same join can be computed by several algorithms, and each has a cost formula in block transfers and seeks. Here each algorithm runs on its own copy of this database with a cold buffer pool of M blocks, so you can set the measured I/O beside the formula. Your database is not touched.'));
    const head = h('div.view-head');
    const body = h('div.view-body.qpl');
    el.appendChild(head); el.appendChild(body);
    const view = {
      render() {
        head.innerHTML = '';
        head.appendChild(h('div.seg', [['join', 'Join algorithms'], ['sort', 'External sort-merge']].map(([k, l]) => h('button' + (tab === k ? '.on' : ''), { type: 'button', onclick: () => { tab = k; UI.store.set('qplab.tab', k); view.render(); } }, l))));
        body.innerHTML = '';
        if (tab === 'join') drawJoin(); else drawSort();
      },
    };
    function drawJoin() {
      const ta = h('textarea.inp.qpl-sql', { rows: 3, spellcheck: 'false', oninput: (e) => { sql = e.target.value; UI.store.set('qplab.sql', sql); } }, sql);
      const pre = h('select.inp', { 'aria-label': 'Preset', onchange: (e) => { if (e.target.value) { sql = e.target.value; UI.store.set('qplab.sql', sql); results = null; view.render(); } } }, [h('option', { value: '' }, 'Presets…')].concat(PRESETS.map(([l, q]) => h('option', { value: q }, l))));
      const fr = h('select.inp', { 'aria-label': 'Buffer blocks M', onchange: (e) => { frames = +e.target.value; UI.store.set('qplab.frames', frames); } }, [4, 6, 8, 16, 32, 64].map((v) => h('option', { value: String(v), selected: v === frames }, 'M = ' + v + ' blocks')));
      const go = UI.btn('run', busy ? 'Running…' : 'Run with every algorithm', null, () => runAll(), 'primary');
      body.appendChild(h('div.qpl-in', ta, h('div.qpl-row', pre, fr, go)));
      if (!results) { body.appendChild(h('p.muted', 'Write an equi-join (or pick a preset), choose the memory M, and run it. Each algorithm that can compute the join runs once.')); return; }
      if (results.error) { body.appendChild(h('div.res-err', h('div.err-line', h('span.err-tag', 'ERROR'), h('span.err-msg', results.error)))); return; }
      const best = Math.min(...results.list.filter((r) => r.used).map((r) => r.io.ms));
      const maxMs = Math.max(...results.list.filter((r) => r.used).map((r) => r.io.ms), 1);
      const table = h('table.grid.small.qpl-t', h('thead', h('tr', ['Algorithm', 'Block reads', 'Seeks', 'Disk time', 'Buffer hits', ''].map((x) => h('th', x)))),
        h('tbody', results.list.map((r) => {
          const label = ALGS.find((a) => a[0] === r.alg);
          const name = h('td', h('b', label[1]), h('div.qpl-f', h('code', label[2])));
          if (!r.used) return h('tr.na', name, h('td', { colspan: '5' }, h('span.muted', 'not possible here (' + (r.alg === 'IndexNestLoopJoin' ? 'no index on the inner side\'s join column' : 'the planner could not use it') + ')')));
          return h('tr' + (r.io.ms === best ? '.best' : ''), name, h('td.num', String(r.io.reads)), h('td.num', String(r.io.seeks)), h('td.num', UI.ms(r.io.ms)), h('td.num', String(r.buf.hits)),
            h('td', h('div.qpl-bar', { title: UI.ms(r.io.ms) }, h('i', { style: { width: Math.max(2, (r.io.ms / maxMs) * 100) + '%' } }))));
        })));
      body.appendChild(h('div.qpl-res', h('div.muted', 'Same result from every algorithm: ' + (new Set(results.list.filter((r) => r.used).map((r) => r.count)).size === 1 ? 'yes (' + results.list.find((r) => r.used).count + ')' : 'NO — a bug'), '. Sizes: ' + results.sizes), table));
      const pick = h('select.inp', { onchange: (e) => { const r = results.list[+e.target.value]; pre2.textContent = r.text; } }, results.list.map((r, i) => (r.used ? h('option', { value: String(i) }, ALGS.find((a) => a[0] === r.alg)[1]) : null)));
      const pre2 = h('pre.res-plan', (results.list.find((r) => r.used) || {}).text || '');
      body.appendChild(h('div.qpl-plan', h('div.qpl-row', h('b', 'EXPLAIN ANALYZE of '), pick), pre2));
    }
    function runAll() {
      if (busy) return;
      busy = true; view.render();
      setTimeout(() => {
        try {
          // the copies start from the database as it is now, with every page written out
          const snap = K.Snapshot.save(app.db);
          const list = ALGS.map(([a]) => { try { return trial(snap, sql, a, frames, { enable_hashjoin: true }); } catch (e) { return { alg: a, used: false, error: e.message }; } });
          for (const r of list) if (r.used) { const s2 = K.Snapshot.load(snap); const ses = s2.session(); ses.settings.force_join = r.alg; try { const q = ses.query(sql); r.count = q.rows.length === 1 && q.rows[0].length === 1 ? String(q.rows[0][0]) : String(q.rows.length); } catch (e) { r.count = 'error'; } }
          const rels = [...new Set([...sql.matchAll(/\b(?:from|join)\s+(\w+)/gi)].map((m) => m[1]))];
          const sizes = rels.map((n) => { const r = app.session.catalog.lookup({ name: n }, app.session.searchPath()); return r && r.file ? n + ' ' + app.db.liveOf(r) + ' rows in ' + app.db.disk.blocks(r.file) + ' blocks' : n; }).join(', ');
          results = { list, sizes };
        } catch (e) { results = { error: e.message }; }
        busy = false; view.render();
      }, 20);
    }
    function drawSort() {
      const cat = app.session.catalog;
      const rels = cat.tables(['table']).filter((r) => !cat.schema(r.schema).system);
      const rel = rels.find((r) => r.name === sortRel) || rels[0];
      if (!rel) { body.appendChild(h('div.empty', 'There are no tables.')); return; }
      const cols = rel.cols.filter((c) => !c.dropped);
      if (!cols.some((c) => c.name === sortCol)) sortCol = cols[0].name;
      const b = Math.max(1, app.db.disk.blocks(rel.file));
      const nRuns = Math.ceil(b / M);
      // merge passes: M - 1 runs merged at a time
      const passes = [];
      let runs = nRuns;
      while (runs > 1) { const next = Math.ceil(runs / (M - 1)); passes.push({ from: runs, to: next }); runs = next; }
      const transfers = b * (2 * passes.length + 1);
      const ctrl = h('div.qpl-row',
        h('select.inp', { 'aria-label': 'Table', onchange: (e) => { sortRel = e.target.value; UI.store.set('qplab.sortRel', sortRel); sortStep = 0; view.render(); } }, rels.map((r) => h('option', { value: r.name, selected: r === rel }, r.name + ' (' + app.db.disk.blocks(r.file) + ' blocks)'))),
        h('select.inp', { 'aria-label': 'Sort key', onchange: (e) => { sortCol = e.target.value; UI.store.set('qplab.sortCol', sortCol); view.render(); } }, cols.map((c) => h('option', { value: c.name, selected: c.name === sortCol }, 'order by ' + c.name))),
        h('select.inp', { 'aria-label': 'M', onchange: (e) => { M = +e.target.value; UI.store.set('qplab.M', M); sortStep = 0; view.render(); } }, [3, 4, 5, 8, 16].map((v) => h('option', { value: String(v), selected: v === M }, 'M = ' + v + ' blocks'))));
      body.appendChild(ctrl);
      body.appendChild(h('div.pl-formula', h('div.f-t', 'Cost: ', h('code', 'b_r · (2 ⌈log_{M−1}(b_r / M)⌉ + 1) block transfers')), h('div.f-v', '= ', h('code', b + ' · (2 · ' + passes.length + ' + 1) = ' + transfers)), h('div.f-n', b + ' blocks are read M = ' + M + ' at a time and sorted in memory into ' + nRuns + ' runs; then ' + (passes.length ? passes.length + ' merge pass' + (passes.length > 1 ? 'es' : '') + ' merge M − 1 = ' + (M - 1) + ' runs at a time' : 'one run is already the sorted result') + '. (The final pass\'s output is not written back, as the formula counts it.)')));
      // the stages: the table's blocks, the runs, then each pass
      const stages = [{ title: 'The table: ' + b + ' blocks', boxes: [b], kind: 'table' }, { title: 'Pass 0: ' + nRuns + ' sorted runs of up to ' + M + ' blocks', boxes: Array.from({ length: nRuns }, (_, i) => Math.min(M, b - i * M)), kind: 'run' }];
      let sizes = stages[1].boxes;
      passes.forEach((p, i) => { const next = []; for (let k = 0; k < sizes.length; k += M - 1) next.push(sizes.slice(k, k + M - 1).reduce((x, y) => x + y, 0)); stages.push({ title: 'Merge pass ' + (i + 1) + ': ' + p.from + ' runs → ' + p.to, boxes: next, kind: i === passes.length - 1 ? 'out' : 'run' }); sizes = next; });
      // drawn at the pane's width (text stays at its size), within reason
      const W = Math.max(300, Math.min(1200, (body.clientWidth || 600) - 30));
      const svg = s('svg', { class: 'qpl-sort', viewBox: '0 0 ' + W + ' ' + (stages.length * 70 + 10), width: W, height: stages.length * 70 + 10, style: 'flex: none; width: ' + W + 'px; height: ' + (stages.length * 70 + 10) + 'px' });
      stages.forEach((st, si) => {
        const y = 10 + si * 70;
        svg.appendChild(s('text', { x: 6, y: y + 12, class: 'qs-t', text: st.title }));
        if (si > sortStep + 1) return;
        // too many runs for a box each: the first and last few, and how many are left out between them
        const fit = Math.floor((W - 12 + 4) / 10);
        const shown = st.boxes.length <= fit ? st.boxes.map((n, bi) => ({ n, bi })) : st.boxes.slice(0, Math.floor(fit / 2) - 2).map((n, bi) => ({ n, bi })).concat([{ more: st.boxes.length - (Math.floor(fit / 2) - 2) - 4 }], st.boxes.slice(-4).map((n, k) => ({ n, bi: st.boxes.length - 4 + k })));
        const moreW = shown.some((b) => b.more) ? 96 : 0;
        const total = shown.reduce((x, b) => x + (b.more ? 0 : b.n), 0);
        const boxes = shown.filter((b) => !b.more);
        // every box at least 6 wide: the space left after the minimums is shared in proportion to the blocks
        const room = W - 12 - (shown.length - 1) * 4 - moreW;
        const scale = Math.max(0, room - boxes.length * 6) / Math.max(1, total);
        let x = 6;
        for (const b of shown) {
          if (b.more) { svg.appendChild(s('text', { x: x + moreW / 2, y: y + 39, class: 'qs-more', 'text-anchor': 'middle', text: '⋯ ' + b.more + ' more' })); x += moreW + 4; continue; }
          const w = 6 + b.n * scale;
          svg.appendChild(s('rect', { x, y: y + 20, width: w, height: 28, rx: Math.min(5, w / 2), class: 'qs-b ' + st.kind, 'data-i': b.bi }));
          if (w > String(b.n).length * 7 + 10) svg.appendChild(s('text', { x: x + w / 2, y: y + 39, class: 'qs-n', 'text-anchor': 'middle', text: String(b.n) }));
          x += w + 4;
        }
      });
      body.appendChild(svg);
      body.appendChild(h('div.qpl-row', UI.btn('stepBack', 'Back', null, () => { sortStep = Math.max(0, sortStep - 1); view.render(); }), UI.btn('step', 'Next pass', null, () => { sortStep = Math.min(stages.length - 2, sortStep + 1); view.render(); }, 'primary'), h('span.muted', 'Step ' + (sortStep + 1) + ' of ' + (stages.length - 1))));
      const q = 'set work_mem_pages = ' + M + ';\nexplain analyze select * from ' + rel.name + ' order by ' + sortCol + ';';
      body.appendChild(h('div.ls-sqlbox', h('pre.ls-sql', UI.highlightSql ? UI.highlightSql(q) : q), h('div.ls-sql-tools', h('button.btn.small', { type: 'button', onclick: () => app.runText(q, { insert: true }) }, UI.icon('run'), 'Run it on the real table'))));
    }
    return view;
  }

  UI.registerView({ id: 'qplab', title: 'Processing lab', icon: 'flask', group: 'Queries', order: 3, create });
})(typeof window !== 'undefined' ? window : globalThis);
