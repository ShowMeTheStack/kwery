// The relational algebra workbench: an expression editor with the usual symbols (ASCII spellings work too),
// the expression drawn as a tree whose every node holds its intermediate relation, stepping through the tree from
// the leaves up, set or bag semantics, translations to and from SQL, the equivalence rules applied to a chosen
// subtree with the result checked unchanged, and the tuple and domain relational calculus. The small building
// blocks at the top (editor, tree, stepper, relation table) are shared with the design theory workbench.
(function (root) {
  'use strict';
  const K = root.K;
  const UI = K.UI;
  const { h, s } = UI;
  const A = K.Algebra;

  // ---- shared pieces ---------------------------------------------------------------------------------------------
  const T = UI.Theory = UI.Theory || {};
  /** a button whose label stays visible on narrow screens (UI.btn hides labels there) */
  T.button = (icon, label, title, onclick, cls) => h('button.btn' + (cls ? '.' + cls.split(' ').join('.') : ''), { type: 'button', title: title || label || '', 'aria-label': title || label, onclick }, icon ? UI.icon(icon) : null, label ? h('span', label) : null);
  const esc = UI.esc;

  /** the token at pos: its end, for underlining an error */
  T.tokenEnd = (text, pos) => {
    if (pos >= text.length) return pos;
    const m = /^[A-Za-z_À-ɏ][\w$À-ɏ]*|^\d+(\.\d+)?|^'(?:[^']|'')*'|^"(?:[^"]|"")*"|^[^\s]/u.exec(text.slice(pos));
    return pos + (m ? m[0].length : 1);
  };

  /**
   * a one-field editor whose text is coloured by colorize(text) -> [{ a, b, cls }] and can underline a range.
   * opts: { value, placeholder, label, colorize, onInput(text), onRun(), minRows }
   */
  T.editor = function (opts) {
    const hl = h('pre.th-ed-hl', { 'aria-hidden': 'true' });
    const ta = h('textarea.th-ed-ta', { spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', 'aria-label': opts.label || 'Expression', placeholder: opts.placeholder || '', rows: String(opts.minRows || 1) });
    const el = h('div.th-ed', hl, ta);
    let mark = null;
    const draw = () => {
      const text = ta.value;
      const n = text.length;
      const cls = new Array(n).fill('');
      if (opts.colorize) { try { for (const t of opts.colorize(text)) for (let i = t.a; i < t.b && i < n; i++) cls[i] = t.cls; } catch (e) { /* plain text */ } }
      let out = '', i = 0;
      const inMark = (k) => mark && k >= mark.a && k < mark.b;
      while (i < n) {
        let j = i + 1;
        while (j < n && cls[j] === cls[i] && inMark(j) === inMark(i)) j++;
        const piece = esc(text.slice(i, j));
        const c = (cls[i] ? cls[i] : '') + (inMark(i) ? ' mk-err' : '');
        out += c.trim() ? '<span class="' + c.trim() + '">' + piece + '</span>' : piece;
        i = j;
      }
      if (mark && mark.a >= n) out += '<span class="mk-err"> </span>';
      hl.innerHTML = out + '\n';
      if (!ta.isConnected) return;
      ta.style.height = 'auto';
      ta.style.height = Math.max(ta.scrollHeight, 30) + 'px';
    };
    ta.addEventListener('input', () => { mark = null; draw(); if (opts.onInput) opts.onInput(ta.value); });
    ta.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); if (opts.onRun) opts.onRun(); }
      // keep Enter for new lines; Tab moves focus as usual
    });
    const api = {
      el, ta,
      get: () => ta.value,
      set(v) { ta.value = v; mark = null; draw(); },
      mark(a, b) { mark = a === null || a === undefined ? null : { a, b: Math.max(b, a + 1) }; draw(); },
      redraw: draw,
      /** insert text at the caret; the caret goes to `caret` characters into the inserted text */
      insert(text, caret) {
        const a = ta.selectionStart, b = ta.selectionEnd, v = ta.value;
        const before = v.slice(0, a), after = v.slice(b);
        const pad = text.startsWith(' ') && /\s$/.test(before) ? text.slice(1) : text;
        ta.value = before + pad + after;
        const at = a + (caret === undefined ? pad.length : Math.max(0, caret - (text.length - pad.length)));
        ta.focus();
        ta.setSelectionRange(at, at);
        mark = null; draw();
        if (opts.onInput) opts.onInput(ta.value);
      },
    };
    ta.value = opts.value || '';
    // the height follows the text, which wraps with the width of the pane
    let lastW = 0;
    if (root.ResizeObserver) new ResizeObserver(() => { if (ta.clientWidth && ta.clientWidth !== lastW) { lastW = ta.clientWidth; draw(); } }).observe(el);
    draw();
    return api;
  };

  // colouring of algebra and calculus text
  const OPS = 'σπΠργΓτδ∪∩−×⋈⨝⟕⟖⟗⋉⋊▷⊳÷←→↦';
  const LOGIC = '∧∨¬≠≤≥∃∀∈∉⇒⟨⟩';
  const OPWORDS = new Set(['select', 'sigma', 'project', 'pi', 'rename', 'rho', 'group', 'gamma', 'sort', 'tau', 'distinct', 'delta', 'union', 'intersect', 'minus', 'except', 'cross', 'times', 'join', 'njoin', 'ljoin', 'rjoin', 'fjoin', 'leftjoin', 'rightjoin', 'fulljoin', 'semijoin', 'antijoin', 'divide']);
  const LOGWORDS = new Set(['and', 'or', 'not', 'is', 'null', 'like', 'as', 'exists', 'forall', 'in', 'implies', 'true', 'false', 'asc', 'desc']);
  T.colorAlgebra = function (text) {
    const out = [];
    const re = /--[^\n]*|'(?:[^']|'')*'?|"(?:[^"]|"")*"?|“[^”]*”?|\d+(?:\.\d+)?|[A-Za-z_][\w$]*|<-|->|<>|<=|>=|\S/gu;
    let m;
    while ((m = re.exec(text))) {
      const t = m[0], a = m.index, b = a + t.length;
      let cls = '';
      if (t.startsWith('--')) cls = 'th-cm';
      else if (/^['"“]/.test(t)) cls = 'th-str';
      else if (/^\d/.test(t)) cls = 'th-num';
      else if (/^[A-Za-z_]/.test(t)) { const w = t.toLowerCase(); cls = OPWORDS.has(w) ? 'th-sym' : LOGWORDS.has(w) ? 'th-kw' : ''; }
      else if (OPS.includes(t) || t === '<-' || t === '->') cls = 'th-sym';
      else if (LOGIC.includes(t) || t === '<>' || t === '<=' || t === '>=') cls = 'th-kw';
      else if ('[]{}|'.includes(t)) cls = 'th-br';
      if (cls) out.push({ a, b, cls });
    }
    return out;
  };
  T.colorSql = (text) => (K.sqlTokens ? K.sqlTokens(text).filter((t) => t.t !== 'ws').map((t) => ({ a: t.a, b: t.b, cls: 't-' + t.t })) : []);

  /** a palette of keys: [{ k (label), ins, caret, title, wide }] or 'gap' */
  T.palette = (keys, onKey) => h('div.th-pal', { role: 'toolbar', 'aria-label': 'Symbols' }, keys.map((k) => (k === 'gap' ? h('span.th-gap') : h('button.th-key' + (k.wide ? '.wide' : ''), { type: 'button', title: k.title || k.k, 'aria-label': k.title || k.k, onmousedown: (e) => e.preventDefault(), onclick: () => onKey(k) }, k.k))));

  /** a message box: kind err | warn | ok | info */
  T.msg = (kind, ...kids) => h('div.th-msg.' + kind, UI.icon(kind === 'ok' ? 'check' : kind === 'info' ? 'info' : kind === 'warn' ? 'warn' : 'x'), h('div', kids));

  /** step controls: count steps, at (0..count), label(at) -> text, go(at) */
  T.stepper = function (count, at, label, go) {
    return h('div.th-step',
      T.button('first', null, 'To the first step', () => go(0), 'icon'),
      T.button('stepBack', null, 'Step back', () => go(Math.max(0, at - 1)), 'icon'),
      T.button('step', null, 'Step forward', () => go(Math.min(count, at + 1)), 'icon'),
      T.button('last', null, 'To the last step', () => go(count), 'icon'),
      h('span.th-step-l', label(at)));
  };

  const cell = (v) => (v === null || v === undefined ? h('td.null', 'null') : typeof v === 'number' ? h('td.num', String(Number.isInteger(v) ? v : Number(v.toPrecision(10)))) : typeof v === 'boolean' ? h('td.bool', v ? 'true' : 'false') : h('td', String(v)));
  /** a relation as a table: cols (names), rows (plain values) */
  T.table = function (cols, rows, opts) {
    opts = opts || {};
    const max = opts.max || 200;
    const tbl = h('table.grid.small', h('thead', h('tr', cols.map((c) => h('th', c)))), h('tbody', rows.slice(0, max).map((r, i) => h('tr' + (opts.mark && opts.mark(r, i) ? '.best' : ''), r.map(cell)))));
    const box = h('div.th-tbl', tbl);
    return rows.length > max ? h('div', box, h('div.th-more', 'The first ' + max + ' of ' + rows.length + ' tuples.')) : box;
  };

  /**
   * a tree, root at the top: nodes { kids, ...}; opts.box(n) -> { el (contents), cls, title, w, h }, opts.click(n),
   * opts.edgeDone(parent, kid). A tidy layout: rows as tall as their tallest box, parents centred over their
   * children, subtrees packed as close as their outlines allow. Returns the scrolling wrapper.
   */
  T.tree = function (rootNode, opts) {
    const H = opts.H || 52, GX = opts.GX || 14, GY = opts.GY || 30, P = 8;
    const build = (n) => { const b = opts.box(n); return { n, b, w: b.w, h: b.h || H, kids: (n.kids || []).map(build) }; };
    const top = build(rootNode);
    const L = UI.IdxDraw.tidy(top, (it) => it.kids, (it) => it.w, GX);
    const rowH = [];
    for (const it of L.all) rowH[it.depth] = Math.max(rowH[it.depth] || 0, it.h);
    const ys = [P];
    for (let d = 1; d < rowH.length; d++) ys[d] = ys[d - 1] + rowH[d - 1] + GY;
    const W = Math.ceil(L.W) + P * 2, HT = ys[ys.length - 1] + rowH[rowH.length - 1] + P;
    const canvas = h('div.th-tree', { style: { width: W + 'px', height: HT + 'px' } });
    const svg = s('svg', { width: W, height: HT });
    canvas.appendChild(svg);
    const x = (it) => P + it.x, y = (it) => ys[it.depth];
    for (const it of L.all) {
      // down from the box, along a rail just below its row, across the gap, down into the child: never crossing
      const x1 = x(it) + it.w / 2, y1 = y(it) + it.h, rail = y(it) + rowH[it.depth] + 2;
      for (const k of it.kids) {
        const x2 = x(k) + k.w / 2, y2 = y(k), low = y2 - 3, mid = (rail + low) / 2;
        svg.appendChild(s('path', { d: 'M' + x1 + ' ' + y1 + ' L ' + x1 + ' ' + rail + ' C ' + x1 + ' ' + mid + ', ' + x2 + ' ' + mid + ', ' + x2 + ' ' + low + ' L ' + x2 + ' ' + y2, class: 'th-edge' + (opts.edgeDone && opts.edgeDone(it.n, k.n) ? ' done' : '') }));
      }
      const b = it.b;
      canvas.appendChild(h('button.th-node' + (b.cls ? '.' + b.cls.trim().split(/\s+/).join('.') : ''), { type: 'button', title: b.title || '', style: { left: x(it) + 'px', top: y(it) + 'px', width: it.w + 'px', height: it.h + 'px' }, onclick: opts.click ? () => opts.click(it.n) : null }, b.el));
    }
    const sizer = h('div', canvas);
    const wrap = h('div.th-tree-wrap', sizer);
    // a tree wider than the pane opens fitted to its width (down to 60%), else centred on its root
    UI.IdxDraw.fitHtml(wrap, sizer, canvas, W, HT, { x: x(top), y: 0, w: top.w }, false);
    return wrap;
  };
  /** an estimate of the width a node's text needs */
  T.width = (chars, min, max) => Math.max(min || 64, Math.min(max || 250, Math.round(chars * 7.3 + 26)));
  /** the width of text in a font ('$f' and '$m' stand for the page's text and monospace fonts) */
  let measureCtx = null;
  T.textW = (text, font) => {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    const cs = getComputedStyle(document.documentElement);
    measureCtx.font = font.replace('$f', cs.getPropertyValue('--font') || 'sans-serif').replace('$m', cs.getPropertyValue('--mono') || 'monospace');
    return measureCtx.measureText(text).width;
  };

  // ---- the algebra -------------------------------------------------------------------------------------------------
  const PAL = [
    { k: 'σ', ins: 'σ[]()', caret: 2, title: 'Selection σ[condition](E). ASCII: select[...](E)' },
    { k: 'π', ins: 'π[]()', caret: 2, title: 'Projection π[attributes](E). ASCII: project[...](E)' },
    { k: 'ρ', ins: 'ρ[]()', caret: 2, title: 'Rename ρ[x](E) or ρ[x(A, B)](E). ASCII: rename[...](E)' },
    { k: '⋈', ins: ' ⋈ ', title: 'Natural join; ⋈[θ] is a theta join. ASCII: join' },
    { k: '⟕', ins: ' ⟕ ', title: 'Left outer join. ASCII: ljoin' },
    { k: '⟖', ins: ' ⟖ ', title: 'Right outer join. ASCII: rjoin' },
    { k: '⟗', ins: ' ⟗ ', title: 'Full outer join. ASCII: fjoin' },
    { k: '⋉', ins: ' ⋉ ', title: 'Semijoin: the tuples of the left side with a match. ASCII: semijoin' },
    { k: '▷', ins: ' ▷ ', title: 'Antijoin: the tuples of the left side without a match. ASCII: antijoin' },
    'gap',
    { k: '∪', ins: ' ∪ ', title: 'Union. ASCII: union' },
    { k: '−', ins: ' − ', title: 'Set difference. ASCII: minus' },
    { k: '∩', ins: ' ∩ ', title: 'Intersection. ASCII: intersect' },
    { k: '×', ins: ' × ', title: 'Cartesian product. ASCII: cross' },
    { k: '÷', ins: ' ÷ ', title: 'Division. ASCII: divide' },
    'gap',
    { k: 'γ', ins: 'γ[]()', caret: 2, title: 'Aggregation γ[G, count(A) → n](E), or G γ count(A) → n (E). ASCII: group' },
    { k: 'τ', ins: 'τ[]()', caret: 2, title: 'Sort τ[A desc](E). ASCII: sort' },
    { k: 'δ', ins: 'δ()', caret: 2, title: 'Duplicate elimination (bag semantics). ASCII: distinct' },
    { k: '←', ins: ' ← ', title: 'Assignment: temp ← E; then use temp. ASCII: <-' },
    'gap',
    { k: '∧', ins: ' ∧ ', title: 'and' }, { k: '∨', ins: ' ∨ ', title: 'or' }, { k: '¬', ins: '¬', title: 'not' },
    { k: '≠', ins: ' ≠ ', title: 'not equal (<>)' }, { k: '≤', ins: ' ≤ ', title: 'at most (<=)' }, { k: '≥', ins: ' ≥ ', title: 'at least (>=)' }, { k: '→', ins: ' → ', title: 'names a result attribute: π[salary * 1.1 → raise](E) (ASCII: as)' },
  ];
  const CALC_PAL = [
    { k: '∃', ins: '∃ ', title: 'there exists (exists)' }, { k: '∀', ins: '∀ ', title: 'for all (forall)' }, { k: '∈', ins: ' ∈ ', title: 'is a tuple of (in)' },
    { k: '∧', ins: ' ∧ ', title: 'and' }, { k: '∨', ins: ' ∨ ', title: 'or' }, { k: '¬', ins: '¬', title: 'not' }, { k: '⇒', ins: ' ⇒ ', title: 'implies (=>)' },
    'gap', { k: '≠', ins: ' ≠ ', title: 'not equal (<>)' }, { k: '≤', ins: ' ≤ ', title: 'at most (<=)' }, { k: '≥', ins: ' ≥ ', title: 'at least (>=)' },
  ];
  const DRC_PAL = CALC_PAL.concat(['gap', { k: '⟨ ⟩', ins: '⟨⟩', caret: 1, title: 'a tuple of domain variables (ASCII: < >)' }]);

  const EXAMPLES = [
    ['Selection', "σ[genre = 'opera'](production)"],
    ['Selection and projection', "π[title, runtime_min](σ[genre = 'drama' ∧ runtime_min > 120](production))"],
    ['Natural join', 'π[family_name, role_name](person ⋈ casting)'],
    ['Product, rename and selection', "π[a.title](σ[a.runtime_min > b.runtime_min ∧ b.prod_id = 'PR101'](ρ[a](production) × ρ[b](production)))"],
    ['Union of two venues', "π[prod_id](σ[venue_code = 'GLA'](performance)) ∪ π[prod_id](σ[venue_code = 'RIV'](performance))"],
    ['Set difference', "π[prod_id](σ[venue_code = 'GLA'](performance)) − π[prod_id](σ[venue_code = 'RIV'](performance))"],
    ['Antijoin: never cast', 'π[person_id, family_name](person ⋈ (artist ▷ casting))'],
    ['Left outer join', 'π[person_id, prod_id, role_name](artist ⟕ casting)'],
    ['Aggregation', 'company_id γ avg(fee) → avg_fee (artist)'],
    ['Division', "π[venue_code, genre](performance ⋈ π[prod_id, genre](production)) ÷ π[genre](σ[genre = 'opera' ∨ genre = 'musical'](production))"],
    ['Assignment', "operas ← σ[genre = 'opera'](production)\nπ[title, perf_date](operas ⋈ performance)"],
    ['Pushing a selection (try the rules)', "π[family_name, title](σ[genre = 'opera' ∧ fee > 2000](person ⋈ artist ⋈ casting ⋈ π[prod_id, title, genre](production)))"],
  ];
  const TRC_EX = [
    ['Productions longer than 150 minutes', '{ t | ∃ s ∈ production (t[title] = s[title] ∧ s[runtime_min] > 150) }'],
    ['Productions staged at GLA (∃ inside ∃)', "{ t | ∃ s ∈ production (t[title] = s[title] ∧ ∃ f ∈ performance (f[prod_id] = s[prod_id] ∧ f[venue_code] = 'GLA')) }"],
    ['Artists never cast (¬ ∃)', '{ t | ∃ a ∈ artist (t[person_id] = a[person_id] ∧ t[company_id] = a[company_id] ∧ ¬ ∃ c ∈ casting (c[person_id] = a[person_id])) }'],
    ['Patrons who rated only 5 (∀ and ⇒)', '{ t | ∃ p ∈ patron (t[name] = p[name] ∧ ∀ b ∈ booking (b[patron_id] = p[patron_id] ⇒ b[rating] = 5)) }'],
    ['An unsafe query', '{ t | ¬ (t ∈ artist) }'],
  ];
  const DRC_EX = [
    ['Productions longer than 150 minutes', '{ ⟨t⟩ | ∃ p, c, g, d, r, b (⟨p, t, c, g, d, r, b⟩ ∈ production ∧ r > 150) }'],
    ['Operas', "{ ⟨t⟩ | ∃ p, c, g, d, r, b (⟨p, t, c, g, d, r, b⟩ ∈ production ∧ g = 'opera') }"],
    ['Artists never cast', '{ ⟨p, c⟩ | ∃ b, f (⟨p, c, b, f⟩ ∈ artist ∧ ¬ ∃ x, r, l (⟨p, x, r, l⟩ ∈ casting)) }'],
    ['An unsafe query', '{ ⟨c⟩ | ¬ ∃ p, b, f (⟨p, c, b, f⟩ ∈ artist) }'],
  ];

  const MODES = [['eval', 'Evaluate', 'Evaluate the expression over the database, step by step'], ['sql', 'As SQL', 'The expression translated to SQL'], ['from', 'From SQL', 'An SQL query translated to the algebra'], ['rules', 'Equivalence rules', 'Rewrite a subtree with the equivalence rules'], ['trc', 'TRC', 'The tuple relational calculus'], ['drc', 'DRC', 'The domain relational calculus']];
  const INTRO = {
    eval: ['Relational algebra.', 'A query is an expression built from operators that each take relations and return a relation: σ selects tuples, π keeps attributes, ⋈ joins, ∪ − ∩ combine union-compatible relations. The tree below evaluates from the leaves (the stored relations) up; select any node to see the relation it produces.'],
    sql: ['From the algebra to SQL.', 'Every expression of the basic algebra has an SQL query with the same result: σ becomes WHERE, π the SELECT list, ⋈ a join, and the set operators UNION, EXCEPT and INTERSECT. Under set semantics the query needs DISTINCT, because SQL keeps duplicates.'],
    from: ['From SQL to the algebra.', 'A query in SQL reads as an algebra expression: the FROM clause is a product or join, WHERE a selection, the SELECT list a projection, GROUP BY an aggregation γ. Subqueries in WHERE become semijoins ⋉ and antijoins ▷; what the algebra cannot say is noted.'],
    rules: ['Equivalence rules.', 'Two expressions are equivalent when they give the same relation on every database. The optimizer rewrites a query with equivalence rules, for example pushing a selection below a join so that fewer tuples are joined. Select a node to see which rules apply there.'],
    trc: ['Tuple relational calculus.', 'A query { t | P(t) } describes the tuples t for which the formula P is true, without saying how to find them. A query is safe when every value in its answer comes from the database; only safe queries can be answered, and every safe query has an equivalent algebra expression.'],
    drc: ['Domain relational calculus.', 'Here the variables range over attribute values instead of tuples: { ⟨x1, …, xn⟩ | P(x1, …, xn) }, with ⟨…⟩ ∈ r saying that the values form a tuple of r. It has the same power as the tuple calculus and the basic algebra once restricted to safe queries.'],
  };

  const KEY = 'alg.';
  const store = { get: (k, d) => UI.store.get(KEY + k, d), set: (k, v) => UI.store.set(KEY + k, v) };
  const plural = (n, w) => n.toLocaleString('en-US') + ' ' + (n === 1 ? w : w + 's');

  // the expression of a program with its assignments substituted, so the rules can see one tree
  function inline(prog) {
    const env = new Map();
    const sub = (e) => {
      const x = A.clone(e);
      const rec = (n) => {
        if (n.op === 'rel' && env.has(n.name)) return A.clone(env.get(n.name));
        if (n.child) n.child = rec(n.child);
        if (n.left) n.left = rec(n.left);
        if (n.right) n.right = rec(n.right);
        return n;
      };
      return rec(x);
    };
    for (const st of prog.stmts) env.set(st.name, { op: 'rename', rel: st.name, attrs: st.attrs || null, map: null, child: sub(st.expr) });
    return prog.result ? sub(prog.result) : env.get(prog.stmts[prog.stmts.length - 1].name);
  }
  // a display tree from an AST, each node with its path from the root
  function astTree(n, path) {
    path = path || [];
    if (n.op === 'rel') return { op: 'rel', symbol: n.name, sub: '', kids: [], path, ast: n };
    if (n.op === 'const') return { op: 'const', symbol: A.toText(n), sub: '', kids: [], path, ast: n };
    const kids = A.UNARY.has(n.op) ? [astTree(n.child, path.concat('child'))] : [astTree(n.left, path.concat('left')), astTree(n.right, path.concat('right'))];
    return { op: n.op, symbol: A.SYMBOLS.unicode[n.op] || n.op, sub: A.subscript(n, 'unicode'), kids, path, ast: n };
  }
  // a node's box fits its symbol and subscript on one line up to MAXW wide; a longer subscript wraps below the symbol
  const MAXW = 300, PADW = 22;
  const nodeBox = (n, extra) => {
    const leaf = n.op === 'rel' || n.op === 'const';
    const sub = n.sub || '';
    const cnt = extra && extra.count !== undefined ? plural(extra.count, 'tuple') : '';
    const symW = T.textW(n.symbol, leaf ? '650 13px $f' : '16px $m'), subW = sub ? T.textW(sub, '11.5px $m') : 0;
    const one = symW + (sub ? 4 + subW : 0) + PADW;
    const wrap = one > MAXW;
    const lines = wrap ? Math.ceil((subW + 2) / (MAXW - PADW)) : 0;
    return {
      el: [wrap ? h('div.tn-top', h('span.tn-sym', n.symbol)) : h('div.tn-top', h('span.tn-sym', n.symbol), sub ? h('span.tn-sub', sub) : null), wrap ? h('div.tn-subw', sub) : null, cnt ? h('div.tn-cnt', cnt) : null, extra && extra.badge ? h('span.tn-badge', String(extra.badge)) : null],
      w: Math.ceil(Math.max(leaf ? 70 : 60, Math.min(MAXW, one + 2), cnt ? T.textW(cnt, '11px $f') + PADW : 0)),
      h: wrap ? 52 + lines * 15 : undefined,
      cls: (leaf ? 'leaf ' : '') + ((extra && extra.cls) || ''),
      title: (extra && extra.title) || (n.symbol + (sub ? '[' + sub + ']' : '')),
    };
  };

  function create(app, el) {
    const st = {
      mode: store.get('mode', 'eval'), bag: store.get('bag', false),
      expr: store.get('expr', "π[family_name, role_name](σ[company_id = 'C08'](artist) ⋈ person ⋈ casting)"),
      trc: store.get('trc', TRC_EX[0][1]), drc: store.get('drc', DRC_EX[0][1]), sql: store.get('sql', ''),
      at: null, sel: null, rulePath: [], history: [], lastRule: null, exercise: null, verdict: null,
    };
    if (!MODES.some((m) => m[0] === st.mode)) st.mode = 'eval';
    let result = null;      // { prog, ev, perr, eerr }
    let dirty = true;
    const intro = h('p.th-intro');
    const exBox = h('div.th-ex');
    const tabs = h('div.th-tabs', { role: 'tablist' });
    const body = h('div.th-body');
    el.appendChild(h('div.th-view', intro, exBox, tabs, body));

    // ---- the algebra editor (shared by Evaluate, As SQL and Equivalence rules)
    const recompute = UI.debounce(() => { dirty = true; renderMode(); }, 260);
    const ed = T.editor({ value: st.expr, label: 'Relational algebra expression', placeholder: "σ[genre = 'opera'](production)", colorize: T.colorAlgebra, onInput: (v) => { st.expr = v; saveExpr(); st.at = null; st.sel = null; st.history = []; st.lastRule = null; recompute(); }, onRun: () => { dirty = true; renderMode(); } });
    const saveExpr = () => { if (st.exercise) store.set('ex.' + st.exercise, st.expr); else store.set('expr', st.expr); };
    const setExpr = (v, keepHistory) => { st.expr = v; ed.set(v); saveExpr(); st.at = null; st.sel = null; if (!keepHistory) { st.history = []; st.lastRule = null; } dirty = true; };
    const pal = T.palette(PAL, (k) => ed.insert(k.ins, k.caret));
    const asciiBtn = T.button(null, 'ASCII', 'Rewrite the expression in ASCII (select, project, join ...) or back in the usual symbols', () => {
      try { const p = A.parse(st.expr); const ascii = !/[σπρ⋈∪−∩×÷γτδ⟕⟖⟗⋉▷←]/.test(st.expr); setExpr(A.programText(p, ascii ? 'unicode' : 'ascii')); renderAll(); } catch (e) { UI.toast('Fix the expression first: ' + e.message, 'err'); }
    }, 'ghost');
    const exBtn = T.button('book', 'Examples', 'Example expressions over the Theatre database', (e) => UI.menu(e.currentTarget, EXAMPLES.map(([l, x]) => ({ label: l, onclick: () => { setExpr(x); renderAll(); } }))), 'ghost');
    const algEditor = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } }, h('div.th-row', h('span.th-label', 'Expression'), h('span.grow'), asciiBtn, exBtn), ed.el, pal);

    // ---- evaluation
    function compute() {
      if (!dirty && result) return result;
      dirty = false;
      result = { prog: null, ev: null, perr: null, eerr: null };
      if (!st.expr.trim()) { ed.mark(null); return result; }
      try { result.prog = A.parse(st.expr); } catch (e) { result.perr = e; ed.mark(e.pos === undefined ? null : e.pos, T.tokenEnd(st.expr, e.pos || 0)); return result; }
      try { result.ev = A.evaluate(result.prog, A.source(app.session), { bag: st.bag, maxRows: 200000 }); ed.mark(null); }
      catch (e) { result.eerr = e; if (e.pos !== undefined && e.pos !== null) ed.mark(e.pos, T.tokenEnd(st.expr, e.pos)); else ed.mark(null); }
      return result;
    }
    const errBox = (e, what) => T.msg('err', h('b', (what || 'Error') + ': '), e.message, e.pos !== undefined && e.pos !== null ? h('span.th-pos', 'at ' + (e.pos + 1)) : null, e.hint ? h('span.th-hint', e.hint) : null);

    function renderEval() {
      const r = compute();
      body.appendChild(algEditor);
      ed.redraw();
      if (r.perr) { body.appendChild(errBox(r.perr, 'Syntax error')); return; }
      if (!r.prog) { body.appendChild(h('div.empty', 'Type an expression, or pick one of the examples.')); return; }
      const ctl = h('div.th-row', h('div.seg', [['set', 'Set'], ['bag', 'Bag']].map(([k, l]) => h('button' + ((k === 'bag') === st.bag ? '.on' : ''), { type: 'button', title: k === 'set' ? 'Set semantics: every operator removes duplicate tuples (the classic definition)' : 'Multiset (bag) semantics, as SQL without DISTINCT: duplicates are kept; δ removes them', onclick: () => { st.bag = k === 'bag'; store.set('bag', st.bag); dirty = true; st.at = null; renderAll(); } }, l))));
      body.appendChild(ctl);
      if (r.eerr) {
        body.appendChild(errBox(r.eerr, 'The expression cannot be evaluated'));
        const prog = r.prog;
        const roots = prog.stmts.map((x) => ({ name: x.name, t: astTree(x.expr) })).concat(prog.result ? [{ name: null, t: astTree(prog.result) }] : []);
        for (const x of roots) body.appendChild(h('div', x.name ? h('div.th-stmt', x.name + ' ←') : null, T.tree(x.t, { box: (n) => nodeBox(n) })));
        return;
      }
      const ev = r.ev;
      const steps = ev.steps;
      const byId = new Map(steps.map((x, i) => [x.id, Object.assign(x, { idx: i })]));
      const n = steps.length;
      if (st.at === null || st.at > n) st.at = n;
      const cur = st.at > 0 ? steps[st.at - 1] : null;
      if (st.sel === null || !byId.has(st.sel)) st.sel = steps[n - 1].id;
      const label = (at) => (at === 0 ? [h('b', 'Before evaluation'), ': only the stored relations exist'] : [h('b', 'Step ' + at + ' of ' + n), ': ' + describe(steps[at - 1])]);
      ctl.appendChild(h('span.grow'));
      ctl.appendChild(T.stepper(n, st.at, label, (k) => { st.at = k; if (k > 0) st.sel = steps[k - 1].id; renderAll(); }));
      // the forest: each assignment's tree, then the result's tree
      const build = (x) => ({ x, kids: (x.children || []).map((id) => build(byId.get(id))) });
      const roots = steps.filter((x) => x.op === 'assign').concat(ev.program.result ? [steps[n - 1]] : []);
      const forest = h('div.th-forest');
      for (const rt of roots) {
        forest.appendChild(T.tree(build(rt), {
          box: (t) => {
            const x = t.x;
            const done = x.idx < st.at;
            const node = x.op === 'assign' ? { op: 'assign', symbol: x.assign + ' ←', sub: '' } : x.op === 'rel' ? { op: 'rel', symbol: x.symbol, sub: '' } : { op: x.op, symbol: x.symbol, sub: x.sub };
            return nodeBox(node, { count: done ? x.count : undefined, cls: (done ? '' : 'pending ') + (cur === x ? 'cur ' : '') + (st.sel === x.id ? 'sel' : ''), title: x.text + (done ? ' — ' + plural(x.count, 'tuple') : ' — not evaluated yet at this step') });
          },
          edgeDone: (p, k) => k.x.idx < st.at,
          click: (t) => { st.sel = t.x.id; if (t.x.idx >= st.at) st.at = t.x.idx + 1; renderAll(); },
        }));
      }
      body.appendChild(forest);
      const sel = byId.get(st.sel);
      if (sel) {
        const done = sel.idx < st.at;
        body.appendChild(h('div.th-rel',
          h('div.th-rel-h', h('span.th-rel-e', sel.text), h('span.th-rel-n', done ? [h('b', plural(sel.count, 'tuple')), ' · ' + plural(sel.cols.length, 'attribute')] : 'not evaluated yet at this step')),
          done ? T.table(sel.cols, sel.rows) : h('div.th-more', 'Step forward to compute it: its operands are evaluated first.')));
      }
      body.appendChild(h('p.th-note', 'Evaluated over the database of the active tab (', app.tab ? app.tab.name : '', '). Ctrl+Enter re-evaluates after running SQL that changes the data.'));
    }
    function describe(x) {
      if (x.op === 'assign') return x.assign + ' ← its expression (' + plural(x.count, 'tuple') + ')';
      if (x.op === 'rel') return x.variable ? 'read the temporary relation ' + x.symbol + ' (' + plural(x.count, 'tuple') + ')' : 'read the relation ' + x.symbol + ' (' + plural(x.count, 'tuple') + ')';
      const names = { select: 'selection', project: 'projection', rename: 'rename', group: 'aggregation', sort: 'sort', distinct: 'duplicate elimination', union: 'union', minus: 'difference', intersect: 'intersection', product: 'Cartesian product', divide: 'division', join: x.sub ? 'theta join' : 'natural join', ljoin: 'left outer join', rjoin: 'right outer join', fjoin: 'full outer join', semijoin: 'semijoin', antijoin: 'antijoin' };
      return (names[x.op] || x.op) + ' ' + x.symbol + (x.sub ? '[' + x.sub + ']' : '') + ' gives ' + plural(x.count, 'tuple');
    }

    // ---- algebra to SQL
    function renderSql() {
      const r = compute();
      body.appendChild(algEditor);
      ed.redraw();
      if (r.perr) { body.appendChild(errBox(r.perr, 'Syntax error')); return; }
      if (!r.prog) return;
      body.appendChild(h('div.th-row', h('div.seg', [['set', 'Set'], ['bag', 'Bag']].map(([k, l]) => h('button' + ((k === 'bag') === st.bag ? '.on' : ''), { type: 'button', onclick: () => { st.bag = k === 'bag'; store.set('bag', st.bag); dirty = true; renderAll(); } }, l))), h('span.th-note', st.bag ? 'Bag semantics: no DISTINCT, ALL on the set operators.' : 'Set semantics: SELECT DISTINCT.')));
      let t;
      try { t = A.toSQL(r.prog, A.source(app.session), { bag: st.bag }); } catch (e) { body.appendChild(errBox(e, 'No translation')); return; }
      const sec = h('div.th-sec', h('h3', 'The same query in SQL'), h('pre.ls-sql', UI.highlightSql ? UI.highlightSql(t.sql) : t.sql),
        h('div.th-row', { style: { marginTop: '8px' } },
          T.button('run', 'Run', 'Add the query to the editor and run it there', () => app.runText(t.sql + ';', { insert: true }), 'primary'),
          T.button('copy', 'Copy', 'Copy the SQL', () => UI.copy(t.sql), 'ghost')));
      body.appendChild(sec);
      if (t.notes.length) body.appendChild(h('div.th-sec', h('h3', 'How it was translated'), h('ul.th-hist', t.notes.map((x) => h('li', x)))));
      // the check: the SQL's result is the algebra's
      if (r.ev) {
        try {
          const q = app.session.query(t.sql);
          const got = { cols: q.cols.map((c) => c.name), rows: q.rows.map((row) => row.map((v, i) => A.plain(v, q.cols[i].type))) };
          const same = A.sameResult(got, { cols: r.ev.cols, rows: r.ev.rows }, { bag: st.bag });
          body.appendChild(same.equal ? T.msg('ok', 'Checked: the SQL gives the same ' + plural(q.rows.length, 'row') + ' as the algebra' + (st.bag ? ' (as a multiset).' : '.')) : T.msg('warn', 'The SQL gives ' + plural(q.rows.length, 'row') + ' and the algebra ' + plural(r.ev.rows.length, 'tuple') + '.'));
        } catch (e) { body.appendChild(T.msg('warn', 'The SQL could not be run here: ' + e.message)); }
      }
    }

    // ---- SQL to the algebra
    let fromEd = null, fromTimer = null;
    function renderFrom() {
      if (!fromEd) fromEd = T.editor({ value: st.sql, minRows: 4, label: 'SQL query', placeholder: 'select title from production where runtime_min > 150', colorize: T.colorSql, onInput: (v) => { st.sql = v; store.set('sql', v); clearTimeout(fromTimer); fromTimer = setTimeout(() => renderAll(), 400); }, onRun: () => renderAll() });
      const take = () => { const cur = app.editor.current(); const text = cur ? cur.text.trim().replace(/;\s*$/, '') : ''; if (!text) { UI.toast('The editor has no statement at the caret', 'warn'); return; } st.sql = text; store.set('sql', text); fromEd.set(text); renderAll(); };
      body.appendChild(h('div.th-row', h('span.th-label', 'SQL query'), h('span.grow'), T.button('copy', 'Take the editor\'s statement', 'Use the statement under the caret in the SQL editor', take, 'ghost')));
      body.appendChild(fromEd.el);
      fromEd.redraw();
      const sql = st.sql.trim().replace(/;\s*$/, '');
      if (!sql) { body.appendChild(h('div.empty', 'Paste a SELECT query, or take the statement under the caret in the editor.')); return; }
      let res;
      try { res = A.fromSQL(sql, app.session, { bag: st.bag }); fromEd.mark(null); } catch (e) {
        if (e.pos !== undefined && e.pos !== null) fromEd.mark(e.pos, T.tokenEnd(sql, e.pos)); else fromEd.mark(null);
        body.appendChild(errBox(e, 'Cannot translate'));
        return;
      }
      if (res.error) { body.appendChild(T.msg('warn', h('b', 'Outside the algebra. '), res.error)); if (res.notes.length) body.appendChild(h('ul.th-hist', res.notes.map((x) => h('li', x)))); return; }
      const sec = h('div.th-sec', h('h3', 'As relational algebra', h('span.muted', res.exact ? 'the same result as the SQL' : 'close to the SQL: see the notes')), h('pre.th-pre', colored(res.text)),
        h('div.th-row', { style: { marginTop: '8px' } }, T.button('chev', 'Evaluate it', 'Open this expression in the algebra editor', () => { setExpr(res.text); st.mode = 'eval'; store.set('mode', 'eval'); renderAll(); }, 'primary'), T.button('copy', 'Copy', null, () => UI.copy(res.text), 'ghost'), T.button(null, 'ASCII', 'Copy it in ASCII', () => UI.copy(res.ascii), 'ghost')));
      body.appendChild(sec);
      try { const p = res.program; const t = p.result ? astTree(p.result) : null; if (t) body.appendChild(T.tree(t, { box: (n) => nodeBox(n) })); } catch (e) { /* no tree */ }
      if (!res.exact) body.appendChild(T.msg('warn', h('b', 'Not an exact translation. '), 'Part of the query has no counterpart in the algebra, so the results may differ; see the notes.'));
      body.appendChild(h('div.th-sec', h('h3', 'Notes'), res.notes.length ? h('ul.th-hist', res.notes.map((x) => h('li', x))) : h('p.th-note', 'Nothing to add: each clause has its operator.')));
    }
    const colored = (text) => { const out = document.createDocumentFragment(); let at = 0; for (const t of T.colorAlgebra(text)) { if (t.a > at) out.appendChild(document.createTextNode(text.slice(at, t.a))); out.appendChild(h('span.' + t.cls, text.slice(t.a, t.b))); at = t.b; } out.appendChild(document.createTextNode(text.slice(at))); return out; };

    // ---- equivalence rules
    function renderRules() {
      const r = compute();
      body.appendChild(algEditor);
      ed.redraw();
      if (r.perr) { body.appendChild(errBox(r.perr, 'Syntax error')); return; }
      if (!r.prog) return;
      const src = A.source(app.session);
      const expr = inline(r.prog);
      if (r.prog.stmts.length) body.appendChild(T.msg('info', 'The assignments are written into one expression here, since the rules rewrite a single tree.'));
      let all = [];
      try { all = A.applicable(expr, src); } catch (e) { body.appendChild(errBox(e)); return; }
      const count = new Map(all.map((x) => [x.path.join('.'), x.rules.length]));
      let node;
      try { node = A.getAt(expr, st.rulePath); } catch (e) { node = null; }
      if (!node) st.rulePath = [];
      const pk = st.rulePath.join('.');
      const changed = st.lastRule ? st.lastRule.path.join('.') : null;
      body.appendChild(h('p.th-note', 'Select a subtree; the number on a node is how many rewrites apply there.'));
      body.appendChild(T.tree(astTree(expr), {
        box: (n) => { const k = n.path.join('.'); return nodeBox(n, { badge: count.get(k), cls: (k === pk ? 'sel ' : '') + (changed !== null && k === changed ? 'changed' : ''), title: A.toText(n.ast) + (count.get(k) ? ' — ' + count.get(k) + ' rule(s) apply' : '') }); },
        click: (n) => { st.rulePath = n.path; renderAll(); },
      }));
      const here = A.rulesAt(expr, st.rulePath, src);
      const sub = A.getAt(expr, st.rulePath);
      const sec = h('div.th-sec', h('h3', 'Rules that apply to ', h('code', A.toText(sub))));
      if (!here.length) sec.appendChild(h('p.th-note', 'No rule rewrites this node. ' + (all.length ? 'Nodes with a number have rules.' : 'Try an expression with a selection over a join, for example the last of the examples.')));
      const list = h('div.th-rules');
      here.forEach((x) => list.appendChild(h('div.th-rule',
        h('div.th-rule-n', h('span.num', x.n), x.name),
        h('div.th-rule-f', x.formula),
        h('div.th-rule-r', '⇒ ', colored(x.text)),
        T.button(null, 'Apply', 'Rewrite the expression with this rule', () => apply(expr, x)))));
      sec.appendChild(list);
      body.appendChild(sec);
      if (st.lastRule) body.appendChild(st.lastRule.check);
      if (st.history.length) {
        body.appendChild(h('div.th-sec', h('h3', 'Rewrites so far', h('span.grow'), T.button('stepBack', 'Undo', 'Undo the last rewrite', () => { const last = st.history.pop(); setExpr(last.before, true); st.lastRule = null; st.rulePath = last.path; renderAll(); }, 'ghost'), T.button('first', 'Start again', 'Back to the expression before the first rewrite', () => { const first = st.history[0]; setExpr(first.before); st.rulePath = []; renderAll(); }, 'ghost')),
          h('ol.th-hist', st.history.map((x) => h('li', 'Rule ' + x.n + ' (' + x.name + ')')))));
      }
    }
    function apply(expr, rule) {
      const src = A.source(app.session);
      const after = rule.exprText;
      let check;
      try {
        const a = A.evaluate(expr, src, { steps: false, bag: st.bag }), b = A.evaluate(rule.expr, src, { steps: false, bag: st.bag });
        const same = A.sameResult(a, b, { bag: st.bag });
        check = same.equal ? T.msg('ok', h('b', 'Rule ' + rule.n + ' applied. '), 'Checked on this database: before and after give the same ' + plural(a.rows.length, 'tuple') + ', as an equivalence rule promises on every database.') : T.msg('err', 'Before and after differ on this database (' + a.rows.length + ' and ' + b.rows.length + ' tuples).');
      } catch (e) { check = T.msg('warn', 'Rule ' + rule.n + ' applied; the check could not run: ' + e.message); }
      st.history.push({ before: st.expr, n: rule.n, name: rule.name, path: st.rulePath.slice() });
      st.lastRule = { path: st.rulePath.slice(), check };
      setExpr(after, true);
      renderAll();
    }

    // ---- the calculus
    const calc = {};
    function renderCalc(kind) {
      const key = kind;
      if (!calc[key]) {
        const timer = { t: null };
        calc[key] = T.editor({ value: st[key], minRows: 2, label: kind === 'trc' ? 'Tuple calculus query' : 'Domain calculus query', colorize: T.colorAlgebra, onInput: (v) => { st[key] = v; store.set(key, v); clearTimeout(timer.t); timer.t = setTimeout(() => renderAll(), 350); }, onRun: () => renderAll() });
      }
      const ced = calc[key];
      const exs = kind === 'trc' ? TRC_EX : DRC_EX;
      body.appendChild(ced.el);
      ced.redraw();
      body.appendChild(h('div.th-row', T.palette(kind === 'trc' ? CALC_PAL : DRC_PAL, (k) => ced.insert(k.ins, k.caret)), h('span.grow'), T.button('book', 'Examples', null, (e) => UI.menu(e.currentTarget, exs.map(([l, x]) => ({ label: l, onclick: () => { st[key] = x; store.set(key, x); ced.set(x); renderAll(); } }))), 'ghost')));
      body.appendChild(h('p.th-note', kind === 'trc' ? 'ASCII works too: { t | exists s in production (t.title = s.title and s.runtime_min > 150) }.' : 'ASCII works too: { <t> | exists p, c, g, d, r, b (<p, t, c, g, d, r, b> in production and r > 150) }.'));
      const text = st[key];
      if (!text.trim()) return;
      const src = A.source(app.session);
      const C = A.Calculus;
      let safety;
      try { safety = C.safety(text, src); } catch (e) { ced.mark(e.pos === undefined ? null : e.pos, T.tokenEnd(text, e.pos || 0)); body.appendChild(errBox(e, 'Syntax error')); return; }
      if (safety.kind && safety.kind !== kind) body.appendChild(T.msg('info', 'This is a ' + (safety.kind === 'trc' ? 'tuple' : 'domain') + ' calculus query; it is evaluated all the same.'));
      if (!safety.safe) {
        ced.mark(safety.pos === undefined ? null : safety.pos, T.tokenEnd(text, safety.pos || 0));
        body.appendChild(T.msg('warn', h('b', 'Not safe. '), safety.reason.replace(/^unsafe: /, ''), safety.pos !== undefined ? h('span.th-pos', 'at ' + (safety.pos + 1)) : null, safety.hint ? h('span.th-hint', safety.hint) : null));
        body.appendChild(h('p.th-note', 'An unsafe query may have an infinite answer (all the tuples not in a relation, say), so it is not evaluated. Tie every variable to a relation with ∈ first.'));
        return;
      }
      ced.mark(null);
      let res;
      try { res = C.evaluate(text, src); } catch (e) { body.appendChild(errBox(e, 'The query cannot be evaluated')); return; }
      body.appendChild(T.msg('ok', h('b', 'Safe. '), 'Every variable is limited to values of a relation, so the answer is finite: ' + plural(res.rows.length, 'tuple') + '.'));
      body.appendChild(h('div.th-rel', h('div.th-rel-h', h('span.th-rel-e', 'Answer'), h('span.th-rel-n', h('b', plural(res.rows.length, 'tuple')), ' · ' + plural(res.cols.length, 'attribute'))), T.table(res.cols, res.rows)));
      body.appendChild(h('div.th-sec', h('h3', 'How it is computed', h('span.muted', 'the order the safety analysis found')), h('pre.th-pre', res.text)));
      try {
        const al = C.toAlgebra(text, src);
        const ae = A.evaluate(al.program, src, { steps: false });
        const same = A.sameResult({ cols: res.cols, rows: res.rows }, ae);
        body.appendChild(h('div.th-sec', h('h3', 'The equivalent algebra'), h('pre.th-pre', colored(al.text)),
          h('div.th-row', { style: { marginTop: '8px' } }, T.button('chev', 'Open in the algebra editor', null, () => { setExpr(al.text); st.mode = 'eval'; store.set('mode', 'eval'); renderAll(); }, 'primary'), T.button('copy', 'Copy', null, () => UI.copy(al.text), 'ghost')),
          h('div', { style: { marginTop: '8px' } }, same.equal ? T.msg('ok', 'Checked: the algebra gives the same ' + plural(ae.rows.length, 'tuple') + '.') : T.msg('warn', 'The algebra gives ' + plural(ae.rows.length, 'tuple') + '.'))));
      } catch (e) { body.appendChild(T.msg('warn', 'No algebra translation: ' + e.message)); }
    }

    // ---- exercises
    function renderExercise() {
      exBox.innerHTML = '';
      exBox.hidden = !st.exercise;
      if (!st.exercise) return;
      const x = K.Content && K.Content.exercises.get(st.exercise);
      if (!x) { exBox.hidden = true; return; }
      exBox.appendChild(h('div.th-ex-t', UI.icon('tasks'), 'Exercise: ' + x.title, h('span.grow'),
        T.button('check', 'Check', 'Check the expression in the editor', () => { st.verdict = x.check(app); if (st.verdict.ok) solved(app, x.id); renderAll(); }, 'primary'),
        T.button('tasks', 'Hints', 'Open the exercise with its hints', () => app.openView('exercise', { exercise: x.id }), 'ghost'),
        T.button('x', null, 'Leave the exercise (your answer is kept)', () => { st.exercise = null; st.verdict = null; setExpr(store.get('expr', '')); st.mode = 'eval'; renderAll(); }, 'icon')));
      exBox.appendChild(h('div.th-ex-p', x.prompt || ''));
      if (st.verdict) exBox.appendChild(verdictEl(st.verdict));
    }

    function renderMode() {
      // the editors are taken out and put back: keep the caret where it was
      const a = document.activeElement;
      const focus = a && el.contains(a) && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT') ? { a, s: a.selectionStart, e: a.selectionEnd } : null;
      renderModeBody();
      if (focus && focus.a.isConnected && document.activeElement !== focus.a) { focus.a.focus(); try { focus.a.setSelectionRange(focus.s, focus.e); } catch (err) { /* not a text field */ } }
    }
    function renderModeBody() {
      body.innerHTML = '';
      const m = st.mode;
      const [lead, text] = INTRO[m];
      intro.innerHTML = '';
      intro.appendChild(h('b', lead + ' '));
      intro.appendChild(document.createTextNode(text));
      try {
        if (m === 'eval') renderEval();
        else if (m === 'sql') renderSql();
        else if (m === 'from') renderFrom();
        else if (m === 'rules') renderRules();
        else renderCalc(m);
      } catch (e) { console.error(e); body.appendChild(T.msg('err', 'Something went wrong here: ' + e.message)); }
    }
    function renderTabs() {
      tabs.innerHTML = '';
      for (const [k, l, t] of MODES) tabs.appendChild(h('button.th-tab' + (st.mode === k ? '.on' : ''), { type: 'button', role: 'tab', title: t, 'aria-selected': String(st.mode === k), dataset: { mode: k }, onclick: () => { st.mode = k; store.set('mode', k); renderAll(); } }, l));
    }
    function renderAll() { renderExercise(); renderTabs(); const y = body.scrollTop; renderMode(); body.scrollTop = y; }

    const view = {
      render() { renderAll(); },
      onRun() { dirty = true; },
      onDb() { dirty = true; },
      onSelect(sel) {
        if (!sel) return;
        if (sel.exercise) {
          if (st.exercise !== sel.exercise) { st.exercise = sel.exercise; st.verdict = null; setExpr(store.get('ex.' + sel.exercise, '')); }
          st.mode = 'eval';
        }
        if (sel.expr) { if (st.exercise) { st.exercise = null; st.verdict = null; } setExpr(sel.expr); st.mode = 'eval'; }
        if (sel.sql) { st.sql = sel.sql; store.set('sql', sel.sql); if (fromEd) fromEd.set(sel.sql); st.mode = 'from'; }
        if (sel.trc) { st.trc = sel.trc; if (calc.trc) calc.trc.set(sel.trc); st.mode = 'trc'; }
        if (sel.drc) { st.drc = sel.drc; if (calc.drc) calc.drc.set(sel.drc); st.mode = 'drc'; }
        if (sel.mode) st.mode = sel.mode;
        store.set('mode', st.mode);
      },
      current: () => st.expr,
      state: () => ({ mode: st.mode, expr: st.expr, bag: st.bag, at: st.at, sel: st.sel, rulePath: st.rulePath.slice(), exercise: st.exercise }),
      step(k) { st.at = k; renderAll(); },
    };
    UI.AlgebraWorkbench.view = view;
    return view;
  }

  /** the exercise checker's verdict, inline */
  function verdictEl(v) {
    return h('div.th-verdict.' + (v.ok ? 'ok' : 'bad'), h('div', h('b', v.ok ? 'Correct. ' : 'Not yet. '), v.message || ''), (v.details || []).map((d) => h('div', UI.inline ? UI.inline(d) : d)));
  }
  T.verdict = verdictEl;
  /** mark an exercise solved in the progress the Exercises panel shows */
  function solved(app, id) {
    const p = UI.store.get('progress', { done: {}, solved: {} });
    p.solved = p.solved || {};
    p.solved[id] = Date.now();
    UI.store.set('progress', p);
    if (app.panel === 'tasks') app.renderPanel();
  }
  T.solved = solved;

  UI.AlgebraWorkbench = {
    view: null,
    /** the answer kept for an exercise: what the student last wrote for it in the workbench */
    answer: (id) => UI.store.get(KEY + 'ex.' + id, null),
    current: () => (UI.AlgebraWorkbench.view ? UI.AlgebraWorkbench.view.current() : UI.store.get(KEY + 'expr', '')),
  };
  UI.registerView({ id: 'algebra', title: 'Relational algebra', icon: 'sigma', group: 'Theory', order: 70, create });
})(typeof window !== 'undefined' ? window : globalThis);
