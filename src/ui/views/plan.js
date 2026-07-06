// The plan view: the physical plan of the last statement as a tree, each operator with the algorithm the
// optimizer chose, its estimated and (after a run) actual rows, the cost formula with the numbers
// filled in, and the alternatives it rejected. Stepping through a recorded run lights the operator at work
// and shows the rows passing between operators.
(function (root) {
  'use strict';
  const K = root.K;
  const UI = K.UI;
  const { h, s } = UI;

  const NAMES = {
    SeqScan: 'Sequential scan', IndexScan: 'Index scan', IndexOnlyScan: 'Index-only scan', BitmapScan: 'Bitmap heap scan', NestLoopJoin: 'Nested-loop join', BlockNestLoopJoin: 'Block nested-loop join',
    IndexNestLoopJoin: 'Indexed nested-loop join', HashJoin: 'Hash join', MergeJoin: 'Merge join', Filter: 'Selection σ', Project: 'Projection π', Aggregate: 'Aggregation γ', Sort: 'Sort', Limit: 'Limit',
    Distinct: 'Duplicate elimination', SetOp: 'Set operation', Window: 'Window functions', ProjectSet: 'Set-returning functions', CteScan: 'CTE scan', WorkTable: 'Working table', RecursiveUnion: 'Recursive union',
    Subquery: 'Subquery', Func: 'Function scan', Values: 'Values', Result: 'Result', LockRows: 'Row locks', Modify: 'Modify', SeqState: 'Sequence',
  };
  const JT = { inner: '⋈', cross: '×', left: '⟕', right: '⟖', full: '⟗', semi: '⋉', anti: '▷' };

  /** the cost formula for an operator, with this plan's numbers */
  function formula(n, db, settings) {
    const pages = (x) => (x.rel && x.rel.file && db.disk.files.has(x.rel.file) ? db.disk.blocks(x.rel.file) : Math.max(1, Math.ceil((x.rows || 1) * (x.cols ? x.cols.length * 8 + 24 : 40) / (db.disk.pageSize * 0.9))));
    const tS = K.COST.seek, tT = K.COST.transfer;
    const M = (settings && settings.work_mem_pages) || 32;
    switch (n.op) {
      case 'SeqScan': { const b = pages(n); return { text: 'tS + b_r · tT', values: tS + ' + ' + b + ' · ' + tT, total: tS + b * tT, note: 'one seek, then every block of the table in order (b_r = ' + b + ' blocks)' }; }
      case 'IndexScan': case 'IndexOnlyScan': {
        const hgt = safe(() => db.indexAm(n.index).height(), 3);
        const unique = n.index.unique && n.bounds && n.bounds.length === n.index.keys.length && n.bounds.every((x) => x.op === '=');
        return unique
          ? { text: '(h_i + 1) · (tT + tS)', values: '(' + hgt + ' + 1) · ' + (tT + tS) + ' = ' + ((hgt + 1) * (tT + tS)).toFixed(1) + ' ms', note: 'equality on a key: down the B+ tree (height h_i = ' + hgt + ') and one block fetch for the one record' }
          : { text: '(h_i + n) · (tT + tS)', values: '(' + hgt + ' + ' + n.rows + ') · ' + (tT + tS) + ' = ' + ((hgt + n.rows) * (tT + tS)).toFixed(1) + ' ms', note: 'down the B+ tree (height h_i = ' + hgt + '), then one block fetch per matching record in the worst case (n = ' + n.rows + ' estimated); rows stored in key order need fewer' };
      }
      case 'BitmapScan': return { text: '(h_i + 1) · (tT + tS) + b · (tS + tT)', values: '', note: 'the index gives all matching TIDs first; the heap blocks are then read in block order, each once' };
      case 'NestLoopJoin': { const br = pages(n.children[0]), bs = pages(n.children[1]), nr = n.children[0].rows || 1; return { text: 'n_r · b_s + b_r transfers, n_r + b_r seeks', values: nr + ' · ' + bs + ' + ' + br + ' = ' + (nr * bs + br) + ' transfers', note: 'for each tuple of the outer relation r, scan the inner relation s' }; }
      case 'BlockNestLoopJoin': { const br = pages(n.children[0]), bs = pages(n.children[1]); const k = Math.ceil(br / Math.max(1, M - 2)); return { text: '⌈b_r / (M − 2)⌉ · b_s + b_r transfers, 2 · ⌈b_r / (M − 2)⌉ seeks', values: '⌈' + br + ' / ' + (M - 2) + '⌉ · ' + bs + ' + ' + br + ' = ' + (k * bs + br) + ' transfers', note: 'M = ' + M + ' buffer blocks: M − 2 hold a block of the outer relation, one the inner, one the output' }; }
      case 'IndexNestLoopJoin': { const br = pages(n.children[0]), nr = n.children[0].rows || 1; return { text: 'b_r · (tT + tS) + n_r · c', values: br + ' · ' + (tT + tS) + ' + ' + nr + ' · c', note: 'c is the cost of one index lookup on the inner relation (' + n.index.name + ')' }; }
      case 'MergeJoin': { const br = pages(n.children[0]), bs = pages(n.children[1]); return { text: 'b_r + b_s transfers (after sorting both inputs)', values: br + ' + ' + bs + ' = ' + (br + bs), note: 'both inputs sorted on the join attributes, then read once together' }; }
      case 'HashJoin': { const br = pages(n.children[1]), bs = pages(n.children[0]); return n.partitions ? { text: '3 · (b_r + b_s) + 4 · n_h transfers', values: '3 · (' + br + ' + ' + bs + ') + 4 · ' + n.partitions + ' = ' + (3 * (br + bs) + 4 * n.partitions), note: 'the build input (r) does not fit in memory: both are partitioned by the hash function first' } : { text: 'b_r + b_s transfers', values: br + ' + ' + bs + ' = ' + (br + bs), note: 'the build input r (the right child) fits in memory: one pass over each' }; }
      case 'Sort': { const b = pages(n.children[0]); return n.alg === 'external merge' ? { text: 'b_r · (2 ⌈log_{M−1}(b_r / M)⌉ + 1) transfers', values: b + ' · (2 · ' + (n.passes || 1) + ' + 1)', note: (n.runs || 1) + ' sorted runs, ' + (n.passes || 1) + ' merge passes with M − 1 = ' + (M - 1) + ' input buffers' } : { text: 'in memory (quicksort)', values: '', note: 'the input fits in work memory (' + M + ' blocks): no runs are written' }; }
      case 'Aggregate': return n.alg === 'hashed' ? { text: 'one pass, a hash table on the grouping attributes', note: 'each group\'s running aggregate lives in the hash table' } : n.alg === 'sorted' ? { text: 'sort on the grouping attributes, then one pass', note: 'groups arrive one after another' } : { text: 'one pass', note: 'a single group' };
      case 'Distinct': return { text: n.alg === 'hashed' ? 'hashing' : 'sorting', note: 'duplicates are found with a hash table (or by sorting)' };
    }
    return null;
  }
  const safe = (f, d) => { try { return f(); } catch (e) { return d; } };

  // projections that only drop hidden columns are not worth a box
  const visibleKids = (n) => (n.children || []).map((c) => (c.op === 'Project' && c.passthrough ? c.children[0] : c));

  function create(app, el) {
    let plan = null, trace = null, sel = null, tab = 'plan', lastText = '';
    const head = h('div.view-head');
    const body = h('div.view-body.plan-body');
    el.appendChild(head); el.appendChild(body);
    const pick = (run) => {
      const r = run && [...run.results].reverse().find((x) => x.plan);
      if (r) { plan = r.plan; trace = r.trace || null; lastText = r.text || ''; sel = null; }
    };
    const view = {
      onRun(run) { pick(run); },
      onSelect(x) { if (x && x.plan) { plan = x.plan; sel = null; } },
      onDb() { plan = null; },
      render() {
        head.innerHTML = '';
        const tabs = [['plan', 'Physical plan'], ['tree', 'Algebra'], ['trace', 'What the optimizer tried']];
        head.appendChild(h('div.seg', tabs.map(([k, l]) => h('button' + (tab === k ? '.on' : ''), { type: 'button', onclick: () => { tab = k; view.render(); } }, l))));
        if (lastText) head.appendChild(h('code.view-sql', { title: lastText }, lastText.replace(/\s+/g, ' ').slice(0, 90)));
        body.innerHTML = '';
        if (!plan) { body.appendChild(h('div.empty', h('p', 'Run a query (or press Explain) to see its plan here.'), h('p.muted', 'Each box is an operator of the executor. Rows flow upwards from the scans at the bottom to the result at the top.'))); return; }
        if (tab === 'plan') drawPlan(app, body, plan, () => sel, (n) => { sel = n; view.render(); });
        else if (tab === 'tree') drawAlgebra(body, plan);
        else drawTrace(body, trace);
      },
    };
    pick(app.tab && app.tab.run);
    return view;
  }

  // text widths for sizing the boxes, measured in the fonts the boxes use
  let measureCtx = null;
  const textW = (text, font) => {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    const cs = getComputedStyle(document.documentElement);
    measureCtx.font = font.replace('$f', cs.getPropertyValue('--font') || 'sans-serif').replace('$m', cs.getPropertyValue('--mono') || 'monospace');
    return measureCtx.measureText(text).width;
  };

  function drawPlan(app, body, plan, getSel, setSel) {
    const GX = 22, GY = 28, PAD = 24, MINW = 150, MAXW = 340;
    const tl = app.timeline;
    // the operator active at the current step, and the rows each has produced so far
    const produced = new Map();
    let active = null, lastRow = null;
    const stepping = tl.length && tl.events.some((e) => e.type === 'exec.open');
    if (stepping) {
      const upto = tl.upTo();
      const openSet = new Set();
      for (const e of upto) {
        if (e.type === 'exec.open') openSet.add(e.data.node);
        else if (e.type === 'exec.row') { produced.set(e.data.node, (produced.get(e.data.node) || 0) + 1); active = e.data.node; lastRow = e.data; }
        else if (e.type === 'exec.close') openSet.delete(e.data.node);
      }
      const cur = tl.current();
      if (cur && cur.data && cur.data.node) active = cur.data.node;
    }
    const partway = stepping && tl.pos < tl.length;
    // each operator's box: its lines of text, sized to fit them (a long table and index list wraps)
    const item = (n) => {
      const est = n.rows !== undefined ? 'est. ' + n.rows.toLocaleString('en-US') + ' rows' : '';
      const cost = n.cost !== undefined ? 'cost ' + n.cost.toFixed(1) : '';
      const act = n.rt && n.rt.loops ? n.rt.rows.toLocaleString('en-US') + ' rows' + (n.rt.loops > 1 ? ' in ' + n.rt.loops + ' loops' : '') : '';
      const title = (NAMES[n.op] || n.op) + (n.jtype && JT[n.jtype] ? ' ' + JT[n.jtype] : '') + (n.op === 'SetOp' ? ' ' + n.setop.toUpperCase() + (n.all ? ' ALL' : '') : '') + (n.op === 'Modify' ? ' ' + n.kind.toUpperCase() : '');
      const sub = n.rel ? n.rel.name + (n.alias && n.alias !== n.rel.name ? ' ' + n.alias : '') + (n.index ? ' via ' + n.index.name : n.indexes ? ' via ' + n.indexes.map((x) => x.index.name).join(', ') : '') : n.cte ? n.cte.name : n.alg && !/scan/i.test(n.op) ? n.alg : n.op === 'Aggregate' && n.groups.length ? 'group by ' + n.groups.length : '';
      const so = partway ? (produced.get(n) || 0).toLocaleString('en-US') + ' rows so far' : '';
      const subW = sub ? textW(sub, '12px $m') : 0;
      // the figures share one line: estimate, cost, then the actual rows
      const need = Math.max(textW(title, '650 13px $f'), textW(est, '11.5px $f') + textW(cost, '11.5px $f') + (act ? textW(act, '600 11.5px $f') + 10 : 0) + 10, so ? textW(so, '600 11.5px $f') : 0) + PAD + 4;
      const w = Math.ceil(Math.min(MAXW, Math.max(MINW, need, Math.min(subW + PAD + 4, MAXW))));
      const subLines = sub ? Math.ceil((subW + 2) / (w - PAD)) : 0;
      // padding and border 17, then the lines (title 19, table 16 a line, figures 17, rows so far 17) 1 apart
      const lines = [19, subLines * 16, 17, so ? 17 : 0].filter(Boolean);
      const hh = 17 + lines.reduce((a, b) => a + b, 0) + lines.length - 1 + 2;
      return { n, title, sub, est, cost, act, so, w, h: hh, kids: visibleKids(n).map(item) };
    };
    const top = item(plan);
    const L = UI.IdxDraw.tidy(top, (it) => it.kids, (it) => it.w, GX);
    const rowH = [];
    for (const it of L.all) rowH[it.depth] = Math.max(rowH[it.depth] || 0, it.h);
    const ys = [GY / 2];
    for (let d = 1; d < rowH.length; d++) ys[d] = ys[d - 1] + rowH[d - 1] + GY;
    const W = Math.ceil(L.W) + GX * 2, HT = ys[ys.length - 1] + rowH[rowH.length - 1] + GY / 2;
    const canvas = h('div.plan-canvas', { style: { width: W + 'px', height: HT + 'px' } });
    const svg = s('svg', { class: 'plan-lines', width: W, height: HT });
    canvas.appendChild(svg);
    const X = (it) => GX + it.x, Y = (it) => ys[it.depth];
    for (const it of L.all) {
      // rows flow up: from the top of each child, straight up, across the gap between the rows, up into the parent
      const px = X(it) + it.w / 2, pb = Y(it) + it.h, rail = Y(it) + rowH[it.depth] + 3;
      for (const k of it.kids) {
        const cx0 = X(k) + k.w / 2, ct = Y(k), low = ct - 4, mid = (rail + low) / 2;
        const flowing = produced.get(k.n) && active === k.n;
        svg.appendChild(s('path', { d: 'M' + cx0 + ' ' + ct + ' L ' + cx0 + ' ' + low + ' C ' + cx0 + ' ' + mid + ', ' + px + ' ' + mid + ', ' + px + ' ' + rail + ' L ' + px + ' ' + pb, class: 'pl-edge' + (flowing ? ' flow' : '') }));
      }
      const n = it.n;
      const box = h('button.pl-node.op-' + n.op + (getSel() === n ? '.sel' : '') + (active === n ? '.active' : '') + (n.rt && n.rt.loops === 0 ? '.never' : ''), { type: 'button', style: { left: X(it) + 'px', top: Y(it) + 'px', width: it.w + 'px', height: it.h + 'px' }, onclick: () => setSel(n) },
        h('div.pn-t', it.title), it.sub ? h('div.pn-s', it.sub) : null, h('div.pn-m', h('span', it.est), it.cost ? h('span', it.cost) : null, it.act ? h('span.pn-a', it.act) : null), it.so ? h('div.pn-p', it.so) : null);
      canvas.appendChild(box);
    }
    const sizer = h('div', canvas);
    const wrap = h('div.plan-scroll', sizer);
    body.appendChild(wrap);
    // the plan opens fitted (whole, or to the pane's width), with its root in view
    UI.IdxDraw.fitHtml(wrap, sizer, canvas, W, HT, { x: X(top), y: Y(top), w: top.w }, true);
    // the selected operator's details
    const n = getSel();
    const info = h('div.pl-info');
    if (lastRow && active) info.appendChild(h('div.pl-row', h('b', (NAMES[active.op] || active.op) + ' produced: '), lastRow.text || ''));
    if (n) {
      const names = K.Explain.nameMap(plan);
      const d = K.Explain.describe(n, names, {});
      info.appendChild(h('h3', (NAMES[n.op] || n.op) + (n.rel ? ' on ' + n.rel.name : '')));
      info.appendChild(h('div.pl-pg', 'In PostgreSQL\'s words: ', h('code', d.name)));
      for (const l of d.lines) info.appendChild(h('div.pl-line', typeof l === 'string' ? l : l.text));
      const f = formula(n, app.db, app.session.settings);
      if (f) info.appendChild(h('div.pl-formula', h('div.f-t', 'Cost: ', h('code', f.text)), f.values ? h('div.f-v', '= ', h('code', f.values)) : null, h('div.f-n', f.note)));
      if (n.alternatives && n.alternatives.length) info.appendChild(h('div.pl-alt', h('b', 'Also considered: '), n.alternatives.map((a) => (NAMES[a.op] || a.op) + (a.index ? ' via ' + a.index : '') + ' (cost ' + a.cost.toFixed(1) + ')').join(', ')));
      info.appendChild(h('div.pl-cols', h('b', 'Columns out: '), n.cols.filter((c) => !c.hidden).map((c) => c.name).join(', ') || '(none)'));
      if (n.rt) info.appendChild(h('div.pl-cols', h('b', 'Actual: '), n.rt.rows + ' rows, ' + n.rt.loops + ' loop' + (n.rt.loops === 1 ? '' : 's')));
      if (n.bitmap) info.appendChild(h('div.pl-cols', h('b', 'Bitmap: '), n.bitmap.tids + ' TIDs on ' + n.bitmap.blocks + ' blocks'));
      if (n.hashInfo) info.appendChild(h('div.pl-cols', h('b', 'Hash table: '), n.hashInfo.rows + ' rows in ' + n.hashInfo.buckets + ' buckets'));
    } else info.appendChild(h('p.muted', 'Select an operator to see its algorithm, conditions and cost formula.'));
    body.appendChild(info);
  }

  /** the plan as relational algebra (the logical view of the query) */
  function drawAlgebra(body, plan) {
    const names = K.Explain.nameMap(plan);
    const sh = (e) => K.Explain.show(e, names);
    const txt = (n) => {
      const k = visibleKids(n);
      switch (n.op) {
        case 'SeqScan': case 'IndexScan': case 'IndexOnlyScan': case 'BitmapScan': { const base = n.rel.name + (n.alias && n.alias !== n.rel.name ? ' ' + n.alias : ''); const cond = n.filter || n.recheck || (n.bounds && n.bounds.length ? { k: 'raw' } : null); return cond && n.filter ? 'σ[' + sh(n.filter) + '](' + base + ')' : base; }
        case 'Filter': return 'σ[' + sh(n.cond) + '](' + txt(k[0]) + ')';
        case 'Project': return 'π[' + n.cols.filter((c) => !c.hidden).map((c, i) => (n.exprs[i] && n.exprs[i].k === 'col' && names.get(n.exprs[i].id) === c.name ? c.name : sh(n.exprs[i]) + ' → ' + c.name)).join(', ') + '](' + txt(k[0]) + ')';
        case 'Aggregate': return (n.groups.length ? n.groups.map((g) => sh(g.e)).join(', ') + ' ' : '') + 'γ[' + n.aggs.map((a) => sh(a)).join(', ') + '](' + txt(k[0]) + ')';
        case 'Sort': return 'sort[' + n.keys.map((x) => names.get(x.id) + (x.dir === 'desc' ? ' desc' : '')).join(', ') + '](' + txt(k[0]) + ')';
        case 'Distinct': return 'δ(' + txt(k[0]) + ')';
        case 'SetOp': return '(' + txt(k[0]) + ' ' + { union: '∪', intersect: '∩', except: '−' }[n.setop] + ' ' + txt(k[1]) + ')';
        default:
          if (/Join$/.test(n.op)) return '(' + txt(k[0]) + ' ' + (JT[n.jtype] || '⋈') + (n.cond ? '[' + sh(n.cond) + ']' : '') + ' ' + txt(k[1]) + ')';
          return k.length ? (NAMES[n.op] || n.op) + '(' + k.map(txt).join(', ') + ')' : (NAMES[n.op] || n.op);
      }
    };
    body.appendChild(h('div.alg', h('p.muted', 'The same plan written as an expression of the relational algebra (σ selection, π projection, ⋈ join, γ aggregation, δ duplicate elimination):'), h('pre.alg-expr', txt(plan))));
  }
  /** the optimizer's search: access paths considered per table, and the join-order lattice */
  function drawTrace(body, trace) {
    if (!trace || !trace.length) { body.appendChild(h('div.empty', 'Press Explain to see what the optimizer considered.')); return; }
    for (const t of trace) {
      const box = h('section.tr-box', h('h3', t.what));
      if (t.options) box.appendChild(h('table.grid.small', h('thead', h('tr', h('th', 'Access path'), h('th', 'Index'), h('th.num', 'Est. rows'), h('th.num', 'Cost'))), h('tbody', t.options.map((o, i) => h('tr' + (i === 0 ? '.best' : ''), h('td', NAMES[o.op] || o.op), h('td', o.index || ''), h('td.num', String(o.rows)), h('td.num', o.cost.toFixed(2)))))));
      if (t.lattice) {
        const bySize = new Map();
        for (const x of t.lattice) { const k = x.set.split(' ⋈ ').length; if (!bySize.has(k)) bySize.set(k, []); bySize.get(k).push(x); }
        const lat = h('div.lattice');
        for (const [k, list] of [...bySize].sort((a, b) => a[0] - b[0])) lat.appendChild(h('div.lat-row', h('span.lat-k', k + ' relations'), list.map((x) => h('div.lat-cell', { title: 'best plan: ' + x.plan }, h('div', x.set), h('div.muted', 'cost ' + x.cost.toFixed(1) + ' · ' + x.rows + ' rows')))));
        box.appendChild(h('p.muted', 'Dynamic programming over subsets: for each set of relations the cheapest way to join them is kept and built on.'));
        box.appendChild(lat);
      }
      body.appendChild(box);
    }
  }

  UI.registerView({ id: 'plan', title: 'Plan', icon: 'plan', group: 'Queries', order: 1, events: true, create });
  UI.PlanView = { formula, NAMES };
})(typeof window !== 'undefined' ? window : globalThis);
