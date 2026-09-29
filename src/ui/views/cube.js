// Online analytical processing (Ch. 11): a data cube over a fact table, shown as a cross-tab with drill-down
// and roll-up along each dimension's hierarchy, slicing and dicing, and pivoting; the lattice of all 2^n
// group-bys that GROUP BY CUBE computes, with each node's size and its GROUPING SETS query; and the SQL behind the
// cross-tab on screen, which runs in the workbench and gives the same numbers. The fact rows are read once with
// SQL and aggregated here, so each click answers at once.
(function (root) {
  'use strict';
  const K = root.K;
  const UI = K.UI;
  const { h, s } = UI;

  const SEMS = ['Winter', 'Spring', 'Summer', 'Fall'];
  const PRESET = {
    id: 'preset',
    title: 'Bookings (booking ⋈ performance ⋈ production ⋈ venue)',
    from: 'booking b\n    join performance f on f.perf_id = b.perf_id\n    join production p on p.prod_id = f.prod_id\n    join venue v on v.venue_code = f.venue_code',
    cols: [['genre', 'p.genre'], ['production', 'p.title'], ['year', 'extract(year from f.perf_date)::int'], ['month', "to_char(f.perf_date, 'YYYY-MM')"],
      ['rated', "case when b.rating is null then 'none' when b.rating >= 4 then '4-5' else '1-3' end"], ['rating', "coalesce(b.rating::text, 'none')"],
      ['city', 'v.city'], ['venue', 'v.venue_name'], ['seats', 'b.seats']],
    dims: [
      { id: 'prod', name: 'Production', levels: [{ col: 'genre', label: 'genre' }, { col: 'production', label: 'production' }] },
      { id: 'time', name: 'Time', levels: [{ col: 'year', label: 'year' }, { col: 'month', label: 'month' }] },
      { id: 'rating', name: 'Rating', levels: [{ col: 'rated', label: 'band' }, { col: 'rating', label: 'rating' }] },
      { id: 'place', name: 'Venue', levels: [{ col: 'city', label: 'city' }, { col: 'venue', label: 'venue' }] },
    ],
    lattice: ['genre', 'year', 'city', 'rating'],
    measures: [['count', 'Bookings', 'count(*)'], ['sum', 'Seats sold', 'sum(seats)']],
    rowDim: 'prod', colDim: 'time',
  };
  const SHORT = { production: 'prod' };

  /** order values naturally: numbers as numbers, "2020 Fall" (a year and a season) by year then season, 'none' last */
  const termKey = (v) => { const m = /^(\d{4}) (\w+)$/.exec(v); return m ? +m[1] * 10 + Math.max(0, SEMS.indexOf(m[2])) : null; };
  function cmp(a, b) {
    if (a === b) return 0;
    if (a === 'none' || a === null) return 1;
    if (b === 'none' || b === null) return -1;
    const ta = termKey(a), tb = termKey(b);
    if (ta !== null && tb !== null) return ta - tb;
    if (SEMS.includes(a) && SEMS.includes(b)) return SEMS.indexOf(a) - SEMS.indexOf(b);
    const na = Number(a), nb = Number(b);
    if (a !== '' && b !== '' && !isNaN(na) && !isNaN(nb)) return na - nb;
    return String(a).localeCompare(String(b));
  }
  const q = (v) => "'" + String(v).replace(/'/g, "''") + "'";
  const ident = (x) => (/^[a-z_][a-z0-9_]*$/.test(x) && !(K.isReserved && K.isReserved(x)) ? x : '"' + x.replace(/"/g, '""') + '"');

  function create(app, el) {
    const A = UI.ADV;
    const saved = UI.store.get('cube.state', null) || {};
    const st = Object.assign({ source: 'preset', table: null, dimCols: [], measureCol: null, rows: PRESET.rowDim, cols: PRESET.colDim, levels: {}, measure: 'count', filters: {}, node: null }, saved);
    // a saved preset state from an older fact table: start the preset again
    if (st.source === 'preset' && ![st.rows, st.cols].every((d) => PRESET.dims.some((x) => x.id === d))) Object.assign(st, { rows: PRESET.rowDim, cols: PRESET.colDim, levels: {}, filters: {}, measure: 'count' });
    let cube = null;      // { def, rows: [{col: text}], types: {col: numeric?}, error }
    let stale = true;
    const save = () => UI.store.set('cube.state', { source: st.source, table: st.table, dimCols: st.dimCols, measureCol: st.measureCol, rows: st.rows, cols: st.cols, levels: st.levels, measure: st.measure, filters: st.filters });

    el.appendChild(h('div.view-intro', h('b', 'A data cube summarises a fact table along its dimensions. '), 'The cross-tab shows one measure for two dimensions, with "all" totals; drilling down moves to a finer level of a dimension\'s hierarchy and rolling up to a coarser one, slicing and dicing keep only some values, and pivoting swaps the axes. GROUP BY CUBE computes every one of the 2ⁿ group-bys at once.'));
    const head = h('div.view-head.adv-head');
    const body = h('div.view-body.adv-body.ox');
    el.appendChild(head); el.appendChild(body);

    // ---- the fact table: the preset join, or columns of any table ----------------------------------------------------
    function customDef() {
      const rel = st.table && A.privately(app, 'cube', (s2) => s2.catalog.lookup(st.table.includes('.') ? { schema: st.table.split('.')[0], name: st.table.split('.')[1] } : { name: st.table }, s2.searchPath()));
      if (!rel) return null;
      const cols = rel.cols.filter((c) => !c.dropped);
      const dimCols = st.dimCols.filter((c) => cols.some((x) => x.name === c)).slice(0, 4);
      const numeric = cols.filter((c) => /^(int|numeric|float|double|real|smallint|bigint|decimal)/i.test(K.T.sqlName(c.type)));
      const mcol = numeric.some((c) => c.name === st.measureCol) ? st.measureCol : null;
      return {
        id: 'custom', title: st.table, from: ident(st.table), allCols: cols.map((c) => c.name), numeric: numeric.map((c) => c.name),
        cols: dimCols.map((c) => [c, ident(c)]).concat(mcol ? [['measure_value', ident(mcol)]] : []),
        dims: dimCols.map((c) => ({ id: c, name: c, levels: [{ col: c, label: c }] })),
        lattice: dimCols, measures: [['count', 'Rows', 'count(*)']].concat(mcol ? [['sum', 'Sum of ' + mcol, 'sum(measure_value)']] : []),
        mcol,
      };
    }
    const def = () => (st.source === 'preset' ? PRESET : customDef());
    function load() {
      stale = false;
      const d = def();
      if (!d) { cube = { def: null, rows: [], types: {} }; return; }
      if (d.dims.length < 2 && d.id === 'custom') { cube = { def: d, rows: [], types: {}, error: 'Pick at least two columns as dimensions.' }; return; }
      const sql = factSql(d);
      try {
        const r = A.privately(app, 'cube', (s2) => { const rs = s2.exec(sql); return rs[rs.length - 1]; });
        const types = {};
        r.cols.forEach((c) => { types[c.name] = c.type.cat === 'N'; });
        const measure = d.cols.find((c) => c[0] === 'credits' || c[0] === 'measure_value');
        const txt = (v, t) => (v === null || v === undefined ? 'none' : typeof v === 'string' ? v : typeof v === 'bigint' ? String(v) : UI.valueText(v, t));
        const rows = r.rows.map((row) => { const o = {}; r.cols.forEach((c, i) => { o[c.name] = txt(row[i], c.type); if (measure && c.name === measure[0]) o.$m = A.number(row[i]) || 0; }); return o; });
        cube = { def: d, rows, types };
      } catch (e) { cube = { def: d, rows: [], types: {}, error: e.message }; }
    }
    function factSql(d, need) { return 'select ' + d.cols.filter(([n]) => !need || need.includes(n)).map(([n, e]) => (e === ident(n) ? e : e + ' as ' + n)).join(',\n       ') + '\nfrom ' + d.from; }
    const dimOf = (id) => cube.def.dims.find((x) => x.id === id);
    const levelOf = (id) => { const d = dimOf(id); return d ? d.levels[Math.min(st.levels[id] || 0, d.levels.length - 1)] : null; };

    // ---- slicing and dicing: values left out, per column ----------------------------------------------------------------
    const excluded = (col) => new Set(st.filters[col] || []);
    const keep = (row) => Object.entries(st.filters).every(([col, out]) => !out.length || !(col in row) || !out.includes(row[col]));
    function whereSql() {
      const parts = [];
      for (const [col, out] of Object.entries(st.filters)) {
        if (!out.length || !cube.rows.length || !(col in cube.rows[0])) continue;
        const all = [...new Set(cube.rows.map((r) => r[col]))];
        const inn = all.filter((v) => !out.includes(v));
        const lit = (v) => (cube.types[col] && v !== 'none' ? v : q(v));
        parts.push(inn.length <= out.length ? col + ' in (' + inn.sort(cmp).map(lit).join(', ') + ')' : (out.length === 1 ? col + ' <> ' + lit(out[0]) : col + ' not in (' + out.map(lit).join(', ') + ')'));
      }
      return parts.length ? '\nwhere ' + parts.join('\n  and ') : '';
    }

    // ---- the cross-tab ----------------------------------------------------------------------------------------------------
    function crossTab() {
      const rl = levelOf(st.rows), cl = levelOf(st.cols);
      const facts = cube.rows.filter(keep);
      const val = (r) => (st.measure === 'count' ? 1 : r.$m || 0);
      const cells = new Map(), rt = new Map(), ct = new Map();
      let grand = 0;
      for (const r of facts) {
        const a = r[rl.col], b = r[cl.col], v = val(r);
        const k = a + '\u0001' + b;
        cells.set(k, (cells.get(k) || 0) + v); rt.set(a, (rt.get(a) || 0) + v); ct.set(b, (ct.get(b) || 0) + v); grand += v;
      }
      const rv = [...rt.keys()].sort(cmp), cv = [...ct.keys()].sort(cmp);
      const max = Math.max(1, ...cells.values());
      const fmt = (x) => A.num(x, 0);
      const rd = dimOf(st.rows), cd = dimOf(st.cols);
      const deeper = (d) => (st.levels[d.id] || 0) < d.levels.length - 1;
      const drillInto = (d, v) => { const lv = st.levels[d.id] || 0; const col = d.levels[lv].col; const all = [...new Set(cube.rows.map((r) => r[col]))]; st.filters[col] = all.filter((x) => x !== v); st.levels[d.id] = lv + 1; changed(); };
      const headCell = (d, v) => deeper(d) ? h('button.ox-drill', { type: 'button', title: 'Drill down into ' + v + ' (slice to it and show its ' + d.levels[(st.levels[d.id] || 0) + 1].label + 's)', onclick: () => drillInto(d, v) }, v) : h('span', v);
      const shade = (x) => ({ style: '--p:' + Math.round(8 + 62 * (x / max)) + '%' });
      const table = h('table.ox-xt',
        h('thead', h('tr', h('th.ox-corner', h('span.ox-ax', rd.name + ' ↓ · ' + rl.label), h('span.ox-ax', cd.name + ' → · ' + cl.label)), cv.map((c) => h('th.ox-ch', headCell(cd, c))), h('th.ox-all', 'all'))),
        h('tbody', rv.map((r) => h('tr', h('th.ox-rh', headCell(rd, r)), cv.map((c) => { const x = cells.get(r + '\u0001' + c); return x ? h('td.ox-c', shade(x), fmt(x)) : h('td.ox-c.ox-0', '·'); }), h('td.ox-t', fmt(rt.get(r))))),
          h('tr.ox-tr', h('th.ox-rh', 'all'), cv.map((c) => h('td.ox-t', fmt(ct.get(c)))), h('td.ox-t.ox-g', fmt(grand)))));
      return { el: h('div.adv-scroll.ox-xtw', table), n: facts.length, rv, cv };
    }
    function axisTools(axis) {
      const id = st[axis], d = dimOf(id), lv = st.levels[id] || 0;
      const other = axis === 'rows' ? st.cols : st.rows;
      return h('div.ox-axis',
        h('span.ox-axl', axis === 'rows' ? 'Rows' : 'Columns'),
        h('select.inp', { 'aria-label': axis === 'rows' ? 'Row dimension' : 'Column dimension', onchange: (e) => { const v = e.target.value; if (v === other) st[axis === 'rows' ? 'cols' : 'rows'] = id; st[axis] = v; changed(); } }, cube.def.dims.map((x) => h('option', { value: x.id, selected: x.id === id }, x.name))),
        d.levels.length > 1 ? h('div.seg.adv-seg', d.levels.map((l, i) => h('button' + (i === lv ? '.on' : ''), { type: 'button', title: i > lv ? 'Drill down to ' + l.label : i < lv ? 'Roll up to ' + l.label : l.label, onclick: () => { rollTo(d, i); } }, (i < lv ? '▴ ' : i > lv ? '▾ ' : '') + l.label))) : null);
    }
    /** rolling up past a level drops the slice that drilling into one of its values made */
    function rollTo(d, i) {
      const lv = st.levels[d.id] || 0;
      if (i < lv) for (let k = i; k < lv; k++) delete st.filters[d.levels[k].col];
      st.levels[d.id] = i; changed();
    }
    function dicePanel() {
      const rowsByCol = (col) => [...new Set(cube.rows.map((r) => r[col]))].sort(cmp);
      const lines = cube.def.dims.map((d) => {
        const col = d.levels[0].col, out = excluded(col), vals = rowsByCol(col);
        const toggle = (v) => { const set = excluded(col); if (set.has(v)) set.delete(v); else set.add(v); if (set.size >= vals.length) { UI.toast('Keep at least one value', 'warn'); return; } st.filters[col] = [...set]; changed(); };
        const only = (v) => { st.filters[col] = vals.filter((x) => x !== v); changed(); };
        const extra = d.levels.slice(1).map((l) => (st.filters[l.col] && st.filters[l.col].length ? h('span.adv-badge.acc', l.label + ': ' + (rowsByCol(l.col).length - st.filters[l.col].length) + ' kept') : null));
        return h('div.ox-dice', h('div.ox-dn', h('b', d.name), out.size ? h('button.link', { type: 'button', onclick: () => { delete st.filters[col]; d.levels.slice(1).forEach((l) => delete st.filters[l.col]); changed(); } }, 'all') : h('span.muted', 'all'), extra),
          h('div.ox-chips', vals.slice(0, 40).map((v) => h('button.ox-chip' + (out.has(v) ? '' : '.on'), { type: 'button', 'aria-pressed': String(!out.has(v)), title: 'Click to leave out or put back; double-click to keep only this value (a slice)', onclick: () => toggle(v), ondblclick: () => only(v) }, v)), vals.length > 40 ? h('span.muted', '+' + (vals.length - 40) + ' more') : null));
      });
      return A.sec('Slice and dice', [UI.btn('refresh', 'Keep everything', null, () => { st.filters = {}; changed(); }, 'ghost')],
        A.note('A ', h('b', 'slice'), ' fixes one dimension to a single value (double-click a value); a ', h('b', 'dice'), ' keeps a subrange of several dimensions (click values to leave them out). Dimensions not on an axis are summed over the values kept.'), lines);
    }

    // ---- the SQL behind the cross-tab ---------------------------------------------------------------------------------------
    function measureSql() { return cube.def.measures.find((m) => m[0] === st.measure)[2]; }
    function measureName() { return st.measure === 'count' ? (cube.def.id === 'preset' ? 'enrolments' : 'n') : (cube.def.id === 'preset' ? 'credit_hours' : 'total'); }
    /** the fact columns a query needs: its grouping columns, the columns filtered on, the measure */
    const needed = (cols) => cols.concat(Object.keys(st.filters).filter((c) => st.filters[c].length), st.measure === 'sum' ? ['credits', 'measure_value'] : []);
    function viewSql() {
      const r = levelOf(st.rows).col, c = levelOf(st.cols).col;
      return '-- the cross-tab on screen; NULL in a grouping column (grouping() = 1) is "all"\nwith fact as (\n  ' + factSql(cube.def, needed([r, c])).replace(/\n/g, '\n  ') + '\n)\nselect ' + r + ', ' + c + ', ' + measureSql() + ' as ' + measureName() + ',\n       grouping(' + r + ') as all_' + r + ', grouping(' + c + ') as all_' + c + '\nfrom fact' + whereSql() +
        '\ngroup by grouping sets ((' + r + ', ' + c + '), (' + r + '), (' + c + '), ())\norder by grouping(' + r + '), ' + r + ', grouping(' + c + '), ' + c + ';';
    }
    function sqlPanel() {
      return A.sec('The SQL behind this view', null,
        A.note('One statement computes the cells and all the totals: GROUPING SETS lists the four group-bys the cross-tab needs (', h('code', '(r, c)'), ' for the cells, ', h('code', '(r)'), ' and ', h('code', '(c)'), ' for the "all" column and row, ', h('code', '()'), ' for the grand total). ', h('code', 'GROUP BY CUBE (r, c)'), ' is short for the same four.'),
        A.sqlBox(app, viewSql(), { note: 'runs in the active tab; the result has the same numbers as the cross-tab' }));
    }

    // ---- the lattice of group-bys ----------------------------------------------------------------------------------------------
    function latticePanel() {
      const attrs = cube.def.lattice.filter((a) => cube.rows.length && a in cube.rows[0]).slice(0, 4);
      if (attrs.length < 2) return null;
      const n = attrs.length, facts = cube.rows.filter(keep);
      const nodes = [];
      for (let m = (1 << n) - 1; m >= 0; m--) {
        const set = attrs.filter((a, i) => m & (1 << (n - 1 - i)));
        const groups = new Set(facts.map((r) => set.map((a) => r[a]).join('\u0001')));
        nodes.push({ m, set, size: set.length, rows: facts.length ? groups.size : 0 });
      }
      // the group-bys the cross-tab on screen uses, when its levels are lattice attributes
      const lvCols = (id) => [levelOf(id).col];
      const rc = lvCols(st.rows), cc = lvCols(st.cols);
      const used = rc.concat(cc).every((a) => attrs.includes(a)) ? [rc.concat(cc), rc, cc, []].map((x) => attrs.reduce((acc, a, i) => acc | (x.includes(a) ? 1 << (n - 1 - i) : 0), 0)) : [];
      const byLevel = []; nodes.forEach((x) => { (byLevel[n - x.size] = byLevel[n - x.size] || []).push(x); });
      const labelOf = (x) => (x.set.length ? x.set.map((a) => SHORT[a] || a).join(', ') : '( )  all');
      // nodes as wide as their labels (up to a limit; longer ones end in an ellipsis and keep a tooltip)
      // a label longer than a line breaks after a comma into two balanced lines; nodes are as wide as the longest line
      const linesOf = (x) => {
        const t = labelOf(x);
        if (t.length <= 18 || !x.set.length) return [t];
        const parts = x.set.map((a) => SHORT[a] || a);
        let best = null;
        for (let k = 1; k < parts.length; k++) { const a = parts.slice(0, k).join(', ') + ',', b = parts.slice(k).join(', '); if (!best || Math.max(a.length, b.length) < Math.max(best[0].length, best[1].length)) best = [a, b]; }
        return best;
      };
      const longest = Math.max(...nodes.map((x) => Math.max(...linesOf(x).map((l) => l.length))));
      const nw = Math.max(126, Math.min(200, Math.ceil(longest * 6.7 + 18))), gx = 12, gy = 40;
      const two = nodes.some((x) => linesOf(x).length > 1), nh = two ? 56 : 42;
      const fit = Math.floor((nw - 14) / 6.7);
      const cut = (l) => (l.length > fit ? l.slice(0, fit - 1) + '…' : l);
      const widest = Math.max(...byLevel.map((l) => l.length));
      const W = widest * (nw + gx) + gx, H = byLevel.length * (nh + gy) - gy + 16;
      const pos = new Map();
      byLevel.forEach((lv, li) => lv.forEach((x, k) => pos.set(x.m, { x: (W - lv.length * (nw + gx) + gx) / 2 + k * (nw + gx), y: 8 + li * (nh + gy) })));
      const sel = st.node === null || st.node === undefined || !pos.has(st.node) ? (used.length ? used[0] : (1 << n) - 1) : st.node;
      const g = [];
      // with two dimensions the whole lattice; with more, its edges cannot all be drawn without crossing (the
      // lattice of four is the 4-cube), so only the selected group-by's: what it is computed from, what it computes
      nodes.forEach((x) => nodes.forEach((y) => {
        if (y.size !== x.size - 1 || (y.m & x.m) !== y.m || (n > 2 && x.m !== sel && y.m !== sel)) return;
        const a = pos.get(x.m), b = pos.get(y.m);
        g.push(s('line', { class: 'ox-le' + ((n > 2 ? true : used.includes(x.m) && used.includes(y.m)) ? ' on' : ''), x1: a.x + nw / 2, y1: a.y + nh, x2: b.x + nw / 2, y2: b.y }));
      }));
      nodes.forEach((x) => {
        const p = pos.get(x.m);
        g.push(s('g', { class: 'ox-ln' + (used.includes(x.m) ? ' used' : '') + (x.m === sel ? ' sel' : ''), transform: 'translate(' + p.x + ',' + p.y + ')', tabindex: '0', role: 'button', 'aria-label': 'Group by ' + (x.set.join(', ') || 'nothing'), onclick: () => { st.node = x.m; draw(); }, onkeydown: (e) => { if (e.key === 'Enter') { st.node = x.m; draw(); } } },
          s('rect', { width: nw, height: nh, rx: 8 }), s('text', { x: nw / 2, y: two && linesOf(x).length === 1 ? 24 : 17, 'text-anchor': 'middle', class: 'ox-lt' }, linesOf(x).map((l, i) => s('tspan', { x: nw / 2, dy: i ? 14 : 0 }, cut(l)))), s('text', { x: nw / 2, y: nh - 9, 'text-anchor': 'middle', class: 'ox-lr' }, A.num(x.rows, 0) + ' row' + (x.rows === 1 ? '' : 's')), s('title', {}, '(' + x.set.join(', ') + ')')));
      });
      const node = nodes.find((x) => x.m === sel);
      const list = node.set.join(', ');
      const sql = 'with fact as (\n  ' + factSql(cube.def, needed(node.set)).replace(/\n/g, '\n  ') + '\n)\nselect ' + (list ? list + ', ' : '') + measureSql() + ' as ' + measureName() + '\nfrom fact' + whereSql() + '\ngroup by grouping sets ((' + list + '))' + (list ? '\norder by ' + list : '') + ';';
      const cubeSql = 'with fact as (\n  ' + factSql(cube.def, needed(attrs)).replace(/\n/g, '\n  ') + '\n)\nselect ' + attrs.join(', ') + ', ' + measureSql() + ' as ' + measureName() + ',\n       grouping(' + attrs.join(', ') + ') as grouping_id\nfrom fact' + whereSql() + '\ngroup by cube (' + attrs.join(', ') + ')\norder by grouping_id, ' + attrs.join(', ') + ';';
      const total = nodes.reduce((a, x) => a + x.rows, 0);
      return A.sec('The lattice of group-bys', null,
        A.note('With ' + n + ' dimensions there are 2', h('sup', String(n)), ' = ' + nodes.length + ' group-bys, from the finest at the top to the grand total at the bottom; each can be computed from any node above it that it is linked to, which is how a cube is built cheaply and why systems precompute (materialise) a few of them. ', n > 2 ? 'Select a group-by to draw its links: up to the ones it can be computed from, down to the ones it computes. ' : null, used.length ? h('span', h('b', 'Highlighted: '), 'the four the cross-tab on screen uses.') : null),
        h('div.adv-scroll', s('svg', { class: 'adv-svg ox-lat', width: W, height: H, viewBox: '0 0 ' + W + ' ' + H }, g)),
        h('div.ox-nodeh', h('b', '(' + list + ')'), A.badge(A.num(node.rows, 0) + (node.rows === 1 ? ' row' : ' rows'), 'acc'), h('span.adv-note', node.set.length ? 'one row per combination of ' + list + ' present in the data' : 'one row: the grand total')),
        A.sqlBox(app, sql),
        h('details.ox-det', h('summary', 'All ' + nodes.length + ' at once: GROUP BY CUBE (' + A.num(total, 0) + ' rows)'), A.sqlBox(app, cubeSql, { note: 'grouping_id tells the group-bys apart: a 1 bit marks a column that is "all"' })));
    }

    // ---- source picker --------------------------------------------------------------------------------------------------------------
    function sourcePanel() {
      if (st.source === 'preset') return null;
      const tables = A.privately(app, 'cube', (s2) => s2.catalog.tables(['table', 'view', 'matview']).filter((r) => !s2.catalog.schema(r.schema).system).map((r) => (r.schema === 'public' ? r.name : r.schema + '.' + r.name)).sort());
      const d = cube.def;
      const all = d ? d.allCols : [];
      return A.sec('Fact table', null,
        h('div.adv-row', A.select('Table', [['', 'choose a table…']].concat(tables.map((t) => [t, t])), st.table || '', (v) => { st.table = v || null; st.dimCols = []; st.measureCol = null; st.filters = {}; st.levels = {}; reload(); }),
          d && d.numeric.length ? A.select('Measure column', [['', 'count only']].concat(d.numeric.map((c) => [c, 'sum of ' + c])), st.measureCol || '', (v) => { st.measureCol = v || null; reload(); }) : null),
        d ? h('div.ox-colpick', h('span.adv-note', 'Dimensions (two to four columns):'), all.map((c) => h('label.ox-cp', h('input', { type: 'checkbox', checked: st.dimCols.includes(c), onchange: (e) => { if (e.target.checked) { if (st.dimCols.length >= 4) { e.target.checked = false; UI.toast('At most four dimensions', 'warn'); return; } st.dimCols.push(c); } else st.dimCols = st.dimCols.filter((x) => x !== c); st.filters = {}; reload(); } }), c))) : A.note('Pick a table, then the columns to use as dimensions.'));
    }

    function changed() { save(); draw(); }
    function reload() { save(); load(); draw(); }
    function draw() {
      if (stale) load();
      head.innerHTML = ''; body.innerHTML = '';
      head.appendChild(A.select('Fact table', [['preset', PRESET.title], ['custom', 'Columns of a table…']], st.source, (v) => { st.source = v; st.filters = {}; st.levels = {}; st.node = null; if (v === 'preset') { st.rows = PRESET.rowDim; st.cols = PRESET.colDim; } reload(); }));
      const src = sourcePanel();
      if (src) body.appendChild(src);
      if (!cube.def || cube.error || !cube.rows.length) {
        body.appendChild(h('div.empty', cube.error || (cube.def ? 'The fact table is empty.' : 'Pick a table and at least two dimension columns.')));
        return;
      }
      const ids = cube.def.dims.map((d) => d.id);
      if (!ids.includes(st.rows)) st.rows = ids[0];
      if (!ids.includes(st.cols) || st.cols === st.rows) st.cols = ids.find((x) => x !== st.rows);
      if (!cube.def.measures.some((m) => m[0] === st.measure)) st.measure = 'count';
      head.appendChild(A.seg(cube.def.measures.map((m) => [m[0], m[1]]), st.measure, (v) => { st.measure = v; changed(); }, 'Measure'));
      const xt = crossTab();
      body.appendChild(A.sec('Cross-tab', [UI.btn('refresh', 'Pivot', 'Swap rows and columns', () => { const t = st.rows; st.rows = st.cols; st.cols = t; changed(); })],
        h('div.ox-axes', axisTools('rows'), axisTools('cols')),
        xt.el,
        A.note(A.num(xt.n, 0) + ' fact rows kept of ' + A.num(cube.rows.length, 0) + ' · ' + xt.rv.length + ' × ' + xt.cv.length + ' cells. Click a ', h('b', 'row or column heading'), ' to drill down into it; the ▴ buttons roll up.')));
      body.appendChild(dicePanel());
      body.appendChild(sqlPanel());
      const lat = latticePanel();
      if (lat) body.appendChild(lat);
    }
    return {
      render() { draw(); },
      onDb() { stale = true; },
      onRun(run) { if (run && run.results && run.results.some((r) => r.tag && !/^SELECT/.test(r.tag))) stale = true; },
    };
  }

  UI.registerView({ id: 'cube', title: 'Data cube', icon: 'grid', group: 'Analytics', order: 85, create });
})(typeof window !== 'undefined' ? window : globalThis);
