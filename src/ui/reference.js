// The Reference pane: every statement, function, operator, data type, psql command, setting and glossary term,
// searchable from the side panel. An entry opens in the dock ('reference' view) with its syntax, an explanation,
// a runnable example and links to the lessons and views that show it. Function signatures and result types come
// from the engine's registry at run time; the hand-written text comes from K.Content.reference (src/content).
(function (root) {
  'use strict';
  const K = root.K;
  const UI = K.UI;
  const { h } = UI;

  const EMPTY = { statements: [], types: [], glossary: [], settings: [], functions: {}, functionGroups: {}, operators: {}, operatorList: [], functionExamples: {} };
  const data = () => Object.assign({}, EMPTY, (K.Content && K.Content.reference) || {});
  const inline = (t) => (UI.inline ? UI.inline(String(t || '')) : String(t || ''));
  const SECTIONS = [
    { id: 'all', title: 'All' }, { id: 'sql', title: 'Statements' }, { id: 'fn', title: 'Functions' }, { id: 'op', title: 'Operators' },
    { id: 'type', title: 'Types' }, { id: 'psql', title: 'psql' }, { id: 'set', title: 'Settings' }, { id: 'term', title: 'Glossary' },
  ];
  const SECTION_TITLE = { sql: 'Statement', fn: 'Function', op: 'Operator', type: 'Data type', psql: 'psql command', set: 'Setting', term: 'Glossary' };

  // ---- type names as PostgreSQL prints them in a signature ------------------------------------------------------
  const SHORT = { int2: 'smallint', int4: 'integer', int8: 'bigint', float4: 'real', float8: 'double precision', bool: 'boolean', char: 'character', varchar: 'varchar', timestamptz: 'timestamptz', timestamp: 'timestamp', time: 'time', unknown: 'unknown', null: 'unknown' };
  const CAT = { N: 'numeric', S: 'text', D: 'timestamp', T: 'interval', B: 'boolean', J: 'jsonb', A: 'anyarray', X: 'bytea' };
  function tname(t) {
    if (!t) return '?';
    if (typeof t === 'string') { if (t.length === 1) return CAT[t] || t; return SHORT[t] || (K.T.BASE[t] ? K.T.BASE[t].name : t); }
    if (t.cat === 'A' && t.elem) return tname(t.elem) + '[]';
    if (t.id && SHORT[t.id]) return SHORT[t.id];
    try { return K.T.sqlName(t); } catch (e) { return String(t.id || t.name || '?'); }
  }
  // aggregates, window functions and set-returning functions whose types are worked out in code by the registry:
  // their signatures, checked against the engine (the others are read from the registry or found by trying types)
  const XY = 'y double precision, x double precision';
  const HAND = {
    string_agg: { aggregate: [['value text, delimiter text', 'text'], ['value bytea, delimiter bytea', 'bytea']] },
    json_object_agg: { aggregate: [['key any, value any', 'json']] }, jsonb_object_agg: { aggregate: [['key any, value any', 'jsonb']] },
    covar_pop: { aggregate: [[XY, 'double precision']] }, covar_samp: { aggregate: [[XY, 'double precision']] }, corr: { aggregate: [[XY, 'double precision']] },
    regr_count: { aggregate: [[XY, 'bigint']] },
    ...Object.fromEntries(['regr_avgx', 'regr_avgy', 'regr_sxx', 'regr_syy', 'regr_sxy', 'regr_slope', 'regr_intercept', 'regr_r2'].map((n) => [n, { aggregate: [[XY, 'double precision']] }])),
    percentile_cont: { aggregate: [['fraction double precision) WITHIN GROUP (ORDER BY double precision', 'double precision'], ['fraction double precision) WITHIN GROUP (ORDER BY interval', 'interval'], ['fractions double precision[]) WITHIN GROUP (ORDER BY double precision', 'double precision[]']] },
    percentile_disc: { aggregate: [['fraction double precision) WITHIN GROUP (ORDER BY anyelement', 'anyelement'], ['fractions double precision[]) WITHIN GROUP (ORDER BY anyelement', 'anyarray']] },
    mode: { aggregate: [[') WITHIN GROUP (ORDER BY anyelement', 'anyelement']] },
    rank: { aggregate: [['value any, ...) WITHIN GROUP (ORDER BY any, ...', 'bigint']], window: [['', 'bigint']] },
    dense_rank: { aggregate: [['value any, ...) WITHIN GROUP (ORDER BY any, ...', 'bigint']], window: [['', 'bigint']] },
    percent_rank: { aggregate: [['value any, ...) WITHIN GROUP (ORDER BY any, ...', 'double precision']], window: [['', 'double precision']] },
    cume_dist: { aggregate: [['value any, ...) WITHIN GROUP (ORDER BY any, ...', 'double precision']], window: [['', 'double precision']] },
    ntile: { window: [['buckets integer', 'integer']] },
    unnest: { 'set-returning': [['anyarray', 'setof anyelement'], ['anyarray, anyarray, ... (in FROM only)', 'setof rows, one column per array']] },
    generate_subscripts: { 'set-returning': [['anyarray, dim integer [, reverse boolean]', 'setof integer']] },
    regexp_matches: { 'set-returning': [['string text, pattern text [, flags text]', 'setof text[]']] },
    regexp_split_to_table: { 'set-returning': [['string text, pattern text [, flags text]', 'setof text']] },
    string_to_table: { 'set-returning': [['string text, delimiter text [, null_string text]', 'setof text']] },
  };
  for (const j of ['json', 'jsonb']) {
    HAND[j + '_each'] = { 'set-returning': [[j, 'setof (key text, value ' + j + ')']] };
    HAND[j + '_each_text'] = { 'set-returning': [[j, 'setof (key text, value text)']] };
    HAND[j + '_array_elements'] = { 'set-returning': [[j, 'setof ' + j]] };
    HAND[j + '_array_elements_text'] = { 'set-returning': [[j, 'setof text']] };
    HAND[j + '_object_keys'] = { 'set-returning': [[j, 'setof text']] };
    HAND[j + '_to_record'] = { 'set-returning': [[j, 'record (name its columns: AS x(a integer, ...))']] };
    HAND[j + '_to_recordset'] = { 'set-returning': [[j, 'setof record (name its columns: AS x(a integer, ...))']] };
  }
  /** the signatures of a registry entry: [{ args, ret, kind }] */
  function signatures(name) {
    const out = [];
    const B = K.T.BASE;
    const probe = ['int2', 'int4', 'int8', 'numeric', 'float4', 'float8', 'bool', 'text', 'date', 'time', 'timestamp', 'timestamptz', 'interval', 'bytea', 'json', 'jsonb', 'uuid'].map((k) => B[k]).filter(Boolean);
    let arr = null; try { arr = K.T.arrayOf(B.int4); } catch (e) { /* none */ }
    const pairs = [['float8', 'float8'], ['text', 'text'], ['text', 'int4'], ['text', 'jsonb'], ['int4', 'int4'], ['jsonb', 'int4'], ['float8', 'int4']].map((p) => p.map((k) => B[k]));
    // overloads with argument specs
    const fromDefs = (list, kind) => {
      for (const d of list || []) {
        const args = (d.args || []).map((a, i) => {
          let s = tname(a);
          if (d.names && d.names[i]) s = d.names[i] + ' ' + s;
          if (d.variadic && i === d.args.length - 1) s = 'VARIADIC ' + s;
          return s;
        });
        const min = d.minArgs !== undefined ? d.minArgs : args.length;
        const shown = args.slice(0, min).join(', ') + args.slice(min).map((a, i) => (min + i ? ' [, ' : '[') + a + ']').join('');
        out.push({ kind, args: shown, ret: typeof d.ret === 'function' ? polyRet(d) : tname(d.ret) });
      }
    };
    // a result type worked out from the arguments: try integer for anyelement, integer[] for anyarray
    const polyRet = (d) => {
      const specs = d.args || [];
      const isPoly = specs.some((a) => a === 'anyelement' || a === 'anyarray');
      const want = specs.map((a) => (a === 'anyarray' ? arr : a === 'anyelement' ? B.int4 : typeof a === 'object' ? a : B[a] || B.text));
      try {
        const r = tname(d.ret(want, { elem: B.int4 }));
        if (isPoly && r === 'integer[]') return 'anyarray';
        if (isPoly && r === 'integer') return 'anyelement';
        return r;
      } catch (e) { return 'depends on the arguments'; }
    };
    // entries that resolve their own types: try a range of argument types, and say 'anyelement' where every type fits
    const fromResolve = (f, kind) => {
      if (HAND[name] && HAND[name][kind]) { for (const [args, ret] of HAND[name][kind]) out.push({ kind, args, ret }); return; }
      const res = (types) => { try { const r = f(types); return r && r.ret ? tname(r.ret) : null; } catch (e) { return null; } };
      const rows = [];
      // shapes: (T), (T, integer), (T, T), (T, integer, T); then a few fixed pairs
      const shapes = kind === 'window' ? [(t) => [t], (t) => [t, B.int4], (t) => [t, B.int4, t]] : [(t) => [t]];
      if (res([]) !== null) rows.push({ args: name === 'count' ? '*' : '', ret: res([]) });
      for (const mk of shapes) {
        const hits = probe.concat(arr ? [arr] : []).map((t) => [t, res(mk(t))]).filter((x) => x[1] !== null);
        if (!hits.length) continue;
        const shown = (t, as) => mk(t).map((x) => (x === t ? as : tname(x))).join(', ');
        const scalar = hits.filter((x) => x[0] !== arr);
        const rets = new Set(scalar.map((x) => x[1]));
        if (scalar.length >= 12 && rets.size === 1) { rows.push({ args: shown(hits[0][0], 'any'), ret: [...rets][0] }); continue; }
        if (scalar.length >= 12 && scalar.every(([t, r]) => r === tname(t))) { rows.push({ args: shown(hits[0][0], 'anyelement'), ret: 'anyelement' }); continue; }
        if (scalar.length >= 12 && scalar.every(([t, r]) => r === tname(t) + '[]')) { rows.push({ args: shown(hits[0][0], 'anyelement'), ret: 'anyarray' }); continue; }
        const byRet = new Map();
        for (const [t, r] of hits) { if (!byRet.has(r)) byRet.set(r, []); byRet.get(r).push(mk(t).map(tname).join(', ')); }
        for (const [r, list] of byRet) rows.push({ args: list.join(' | '), ret: r });
      }
      if (kind === 'aggregate' && name !== 'count') for (const p of pairs) { const r = res(p); const a = p.map(tname).join(', '); if (r !== null && !rows.some((x) => x.args.split(' | ').includes(a))) rows.push({ args: a, ret: r }); }
      for (const r of rows) out.push({ kind, args: r.args, ret: r.ret });
    };
    if (K.F.FUNCS.has(name)) fromDefs(K.F.FUNCS.get(name), 'function');
    if (K.F.AGGS.has(name)) {
      const a = K.F.AGGS.get(name);
      const n0 = out.length;
      if (a.resolve) fromResolve((types) => a.resolve(types, { star: !types.length, args: [], order: [] }, null), 'aggregate');
      if (out.length === n0) out.push({ kind: 'aggregate', args: '…', ret: 'depends on the arguments' });
    }
    if (K.F.WINS.has(name)) {
      const w = K.F.WINS.get(name);
      const n0 = out.length;
      if (w.resolve) fromResolve((types) => w.resolve(types), 'window');
      else out.push({ kind: 'window', args: '', ret: tname(w.ret) });
      if (out.length === n0) out.push({ kind: 'window', args: '…', ret: 'depends on the arguments' });
    }
    const srf = K.SRF && K.SRF.defs && (K.SRF.defs.get ? K.SRF.defs.get(name) : K.SRF.defs[name]);
    if (srf) {
      const n0 = out.length;
      if (HAND[name] && HAND[name]['set-returning']) { for (const [args, ret] of HAND[name]['set-returning']) out.push({ kind: 'set-returning', args, ret }); return out; }
      if (srf.overloads) fromDefs(srf.overloads, 'set-returning');
      else if (srf.resolve) fromResolve((types) => { const r = srf.resolve(types, {}); return r ? { ret: r.ret || { id: 'setof' } } : null; }, 'set-returning');
      for (let i = n0; i < out.length; i++) out[i].ret = 'setof ' + (out[i].ret === '?' || out[i].ret === 'depends on the arguments' ? 'rows' : out[i].ret);
      if (out.length === n0) out.push({ kind: 'set-returning', args: '…', ret: 'setof rows' });
    }
    return out;
  }
  function opSignatures(op) {
    const out = [];
    const unary = op[0] === 'u' && op.length > 1;
    const sym = unary ? op.slice(1) : op;
    for (const d of K.F.OPS.get(op) || []) {
      const a = (d.args || []).map(tname);
      const ret = typeof d.ret === 'function' ? 'depends on the arguments' : tname(d.ret);
      out.push({ text: unary ? sym + ' ' + a[0] : a[0] + ' ' + sym + ' ' + a[1], ret });
    }
    return out;
  }

  // ---- the index of entries -----------------------------------------------------------------------------------
  const OP_GROUPS = [
    ['Arithmetic', ['+', '-', '*', '/', '%', '^', 'u@', 'u|/', 'u||/', 'u-', 'u+']],
    ['Bitwise', ['&', '|', '#', 'u~', '<<', '>>']],
    ['Pattern matching', ['^@', '~', '~*', '!~', '!~*', '~~', '~~*', '!~~', '!~~*']],
    ['Strings, arrays and JSON', ['||']],
    ['JSON', ['->', '->>', '#>', '#>>', '?', '?|', '?&', '#-']],
    ['Containment and overlap', ['@>', '<@', '&&']],
  ];
  let cache = null, cacheSig = '';
  function index() {
    const R = data();
    const sig = [R.statements.length, R.types.length, R.glossary.length, R.settings.length, Object.keys(R.functions).length, (R.operatorList || []).length, K.F.FUNCS.size].join('/');
    if (cache && cacheSig === sig) return cache;
    const list = [];
    // a search word matches anywhere in the name, and at the start of a word in the description
    const add = (e) => { e.hay = (e.title + ' ' + (e.alias || '')).toLowerCase(); e.body = ' ' + ((e.sub || '') + ' ' + (e.words || '')).toLowerCase().replace(/[^a-z0-9_+]+/g, ' '); list.push(e); };
    const groupOrder = new Map();
    const order = (sec, g) => { const k = sec + ':' + g; if (!groupOrder.has(k)) groupOrder.set(k, groupOrder.size); return groupOrder.get(k); };
    // statements, in the order the content gives their groups
    for (const s of R.statements) add({ key: 'sql:' + s.id, sec: 'sql', group: s.group || 'Other', go: order('sql', s.group || 'Other'), title: s.name, sub: '', words: (s.keywords || '') + ' ' + (s.about || ''), item: s });
    // functions: every name the registry knows
    const names = new Set([...K.F.FUNCS.keys()].filter((n) => !n.startsWith('_')).concat([...K.F.AGGS.keys()], [...K.F.WINS.keys()], K.SRF && K.SRF.defs ? [...(K.SRF.defs.keys ? K.SRF.defs.keys() : Object.keys(K.SRF.defs))] : []));
    const groupOf = new Map();
    for (const [g, ns] of Object.entries(R.functionGroups || {})) { order('fn', g); for (const n of ns) if (!groupOf.has(n)) groupOf.set(n, g); }
    for (const n of [...names].sort()) {
      const srf = K.SRF && K.SRF.defs && (K.SRF.defs.get ? K.SRF.defs.get(n) : K.SRF.defs[n]);
      const g = groupOf.get(n) || (K.F.AGGS.has(n) ? 'Aggregates' : K.F.WINS.has(n) ? 'Window functions' : srf ? 'Set-returning functions' : 'Other');
      add({ key: 'fn:' + n, sec: 'fn', group: g, go: order('fn', g), title: n, mono: true, sub: R.functions[n] || '', words: g, item: { name: n } });
    }
    // operators: the registry's and the hand-listed predicates
    const opGroup = (op) => { for (const [g, l] of OP_GROUPS) if (l.includes(op)) return g; return 'Other operators'; };
    for (const g of ['Comparison', 'Logical', 'Membership', 'Pattern matching', 'Conditional']) order('op', g);
    for (const [g] of OP_GROUPS) order('op', g);
    const listed = new Map((R.operatorList || []).map((o) => [o.op, o]));
    for (const o of R.operatorList || []) add({ key: 'op:' + o.op, sec: 'op', group: o.group || 'Other operators', go: order('op', o.group || 'Other operators'), title: o.op, mono: true, sub: o.about || '', words: (o.args || '') + ' ' + (o.ret || ''), item: o });
    for (const op of K.F.OPS.keys()) {
      const unary = op[0] === 'u' && op.length > 1;
      const shown = unary ? op.slice(1) : op;
      if (listed.has(op) || (unary && listed.has(shown) && false)) continue;
      const g = opGroup(op);
      add({ key: 'op:' + op, sec: 'op', group: g, go: order('op', g), title: shown, alias: unary ? 'prefix' : '', mono: true, sub: (R.operators || {})[op] || (unary ? 'prefix operator' : ''), item: { op, registry: true } });
    }
    for (const t of R.types) add({ key: 'type:' + t.id, sec: 'type', group: t.group || 'Other', go: order('type', t.group || 'Other'), title: t.name, alias: (t.aliases || []).join(' '), mono: true, sub: (t.aliases || []).join(', '), words: t.about, item: t });
    for (const [cmd, what] of (K.Meta && K.Meta.HELP) || []) add({ key: 'psql:' + cmd.split(' ')[0], sec: 'psql', group: 'psql commands', go: 0, title: cmd, mono: true, sub: what, item: { cmd, what } });
    for (const s of R.settings) add({ key: 'set:' + s.name, sec: 'set', group: s.group || 'Other', go: order('set', s.group || 'Other'), title: s.name, mono: true, sub: s.values || '', words: s.about, item: s });
    for (const g of [...R.glossary].sort((a, b) => a.term.localeCompare(b.term))) {
      const letter = /[a-z]/i.test(g.term[0]) ? g.term[0].toUpperCase() : '#';
      add({ key: 'term:' + g.id, sec: 'term', group: letter, go: letter.charCodeAt(0), title: g.term, sub: g.chapter ? 'Chapter ' + g.chapter : '', words: g.def, item: g });
    }
    cache = { list, byKey: new Map(list.map((e) => [e.key, e])) };
    cacheSig = sig;
    return cache;
  }
  /** a link target to an entry key: statement:select, setting:x, term:x, type:x, fn:x ... */
  function keyOf(ref) {
    const m = /^(\w+):(.+)$/.exec(ref || '');
    if (!m) return null;
    const pre = { statement: 'sql', sql: 'sql', function: 'fn', fn: 'fn', operator: 'op', op: 'op', type: 'type', setting: 'set', set: 'set', term: 'term', glossary: 'term', psql: 'psql' }[m[1]];
    return pre ? pre + ':' + m[2] : null;
  }
  function search(q, sec) {
    const { list } = index();
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    let out = list.filter((e) => (sec === 'all' || e.sec === sec) && words.every((w) => e.hay.includes(w) || e.body.includes(' ' + w)));
    if (words.length) {
      const ql = q.trim().toLowerCase();
      const score = (e) => { const t = e.title.toLowerCase(); return t === ql ? 0 : t.startsWith(ql) ? 1 : t.includes(ql) ? 2 : (e.alias || '').toLowerCase().includes(ql) ? 3 : (e.sub || '').toLowerCase().includes(ql) ? 4 : 5; };
      out = out.map((e) => [score(e), e]).sort((a, b) => a[0] - b[0] || a[1].title.length - b[1].title.length).map((x) => x[1]);
    }
    return out;
  }

  // ---- the side panel ----------------------------------------------------------------------------------------
  const state = { sec: UI.store.get('ref.sec', 'all'), q: '', key: UI.store.get('ref.key', null) };
  function render(app, el) {
    const input = h('input.inp.filter', { type: 'search', placeholder: 'Search the reference', 'aria-label': 'Search the reference', value: state.q });
    const chips = h('div.rf-secs', { role: 'tablist', 'aria-label': 'Sections' });
    const listEl = h('div.rf-list');
    const drawChips = () => {
      chips.innerHTML = '';
      for (const s of SECTIONS) chips.appendChild(h('button.rf-sec' + (state.sec === s.id ? '.on' : ''), { type: 'button', role: 'tab', 'aria-selected': String(state.sec === s.id), onclick: () => { state.sec = s.id; UI.store.set('ref.sec', s.id); drawChips(); drawList(); } }, s.title));
    };
    const drawList = () => {
      listEl.innerHTML = '';
      const res = search(state.q, state.sec);
      const ranked = !!state.q.trim();
      if (!res.length) { listEl.appendChild(h('div.empty', 'Nothing matches “' + state.q + '”.')); return; }
      const groups = new Map();
      if (ranked) {
        // best matches first, then by section
        for (const e of res.slice(0, 400)) { const g = SECTIONS.find((s) => s.id === e.sec).title; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(e); }
      } else {
        const secOrder = SECTIONS.map((s) => s.id);
        const sorted = res.slice().sort((a, b) => secOrder.indexOf(a.sec) - secOrder.indexOf(b.sec) || a.go - b.go);
        for (const e of sorted) { const g = (state.sec === 'all' ? SECTIONS.find((s) => s.id === e.sec).title + ' · ' : '') + e.group; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(e); }
      }
      const frag = document.createDocumentFragment();
      for (const [g, items] of groups) {
        frag.appendChild(h('div.learn-part.rf-group', g, h('span.rf-n', String(items.length))));
        for (const e of items) frag.appendChild(h('button.rf-item' + (e.key === state.key ? '.on' : ''), { type: 'button', dataset: { key: e.key }, title: e.sub ? e.title + ': ' + e.sub : e.title, onclick: () => open(app, e.key) }, h('span.rf-t' + (e.mono ? '.mono' : ''), e.title), e.sub ? h('span.rf-s', e.sub) : null));
      }
      listEl.appendChild(frag);
      if (res.length > 400 && ranked) listEl.appendChild(h('div.empty', 'The first 400 matches. Type more to narrow them.'));
    };
    input.addEventListener('input', UI.debounce(() => { state.q = input.value; drawList(); }, 120));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { const f = listEl.querySelector('.rf-item'); if (f) open(app, f.dataset.key); }
      if (e.key === 'ArrowDown') { const f = listEl.querySelector('.rf-item'); if (f) { e.preventDefault(); f.focus(); } }
    });
    listEl.addEventListener('keydown', (e) => {
      const items = [...listEl.querySelectorAll('.rf-item')];
      const i = items.indexOf(document.activeElement);
      if (i < 0) return;
      if (e.key === 'ArrowDown' && items[i + 1]) { e.preventDefault(); items[i + 1].focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); (items[i - 1] || input).focus(); }
    });
    el.appendChild(h('div.side-tools', input));
    el.appendChild(chips);
    el.appendChild(listEl);
    drawChips();
    drawList();
    markOpen = (key) => { for (const b of listEl.querySelectorAll('.rf-item')) b.classList.toggle('on', b.dataset.key === key); };
  }
  /** marks the open entry in the side list (set by render) */
  let markOpen = () => {};

  /** open an entry in the dock */
  function open(app, key) {
    const k = keyOf(key) || key;
    if (!index().byKey.has(k)) { UI.toast('No reference entry for ' + key, 'warn'); return null; }
    state.key = k;
    UI.store.set('ref.key', k);
    markOpen(k);
    return app.openView('reference', { ref: k });
  }

  // ---- an entry in the dock -------------------------------------------------------------------------------------
  function highlight(sql) {
    const frag = document.createDocumentFragment();
    if (!K.sqlTokens) { frag.appendChild(document.createTextNode(sql)); return frag; }
    for (const t of K.sqlTokens(sql)) { const text = sql.slice(t.a, t.b); frag.appendChild(t.t === 'ws' ? document.createTextNode(text) : h('span.t-' + t.t, text)); }
    return frag;
  }
  /** a grammar: KEYWORDS bold, [ ] { } | ... as punctuation, placeholders in italics */
  function grammar(text) {
    const frag = document.createDocumentFragment();
    // each line wraps with a hanging indent, below its own indentation
    for (const line of String(text).split('\n')) {
      const ind = /^ */.exec(line)[0].length;
      frag.appendChild(h('div.g-line', { style: { paddingLeft: (ind + 3) + 'ch', textIndent: '-3ch' } }, grammarLine(line.slice(ind))));
    }
    return frag;
  }
  function grammarLine(text) {
    const frag = document.createDocumentFragment();
    const re = /([A-Z][A-Z_]*(?:\s+[A-Z][A-Z_]*)*)|(\[|\]|\{|\}|\||\.\.\.|…)|([a-z][a-z0-9_]*)/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      if (m[1]) frag.appendChild(h('span.g-kw', m[1]));
      else if (m[2]) frag.appendChild(h('span.g-meta', m[2]));
      else frag.appendChild(h('span.g-ph', m[3]));
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
  }
  /** a one-line script shows one statement per line (semicolons inside quotes stay) */
  function layout(sql) {
    if (sql.includes('\n') || sql.includes('$$')) return sql;
    const out = [];
    let cur = '', q = null;
    for (let i = 0; i < sql.length; i++) {
      const c = sql[i];
      cur += c;
      if (q) { if (c === q) q = null; continue; }
      if (c === "'" || c === '"') q = c;
      else if (c === ';') { out.push(cur.trim()); cur = ''; }
    }
    if (cur.trim()) out.push(cur.trim());
    return out.join('\n');
  }
  function example(app, sql, opts) {
    opts = opts || {};
    const text = layout(String(sql).trim());
    const tools = h('div.ls-sql-tools',
      opts.run === false ? null : h('button.btn.small', { type: 'button', title: 'Add to the editor and run it on the current database', onclick: () => (opts.meta ? runMeta(app, text) : app.runText(text, { insert: true })) }, UI.icon('run'), 'Run'),
      h('button.btn.small.ghost', { type: 'button', title: 'Put it in the editor without running it', onclick: () => { const v = app.editor.getValue(); app.editor.setValue((v.trim() ? v.replace(/\s*$/, '\n\n') : '') + text + '\n'); app.tab.text = app.editor.getValue(); app.saveTabs(); app.editor.focus(); } }, UI.icon('copy'), 'To the editor'));
    return h('div.ls-sqlbox.rf-ex', h('pre.ls-sql', highlight(text)), tools, opts.note ? h('div.ls-note', inline(opts.note)) : null);
  }
  /** a psql command: the session runs it (the statement parser does not take backslash commands) */
  function runMeta(app, text) {
    const v = app.editor.getValue();
    app.editor.setValue((v.trim() ? v.replace(/\s*$/, '\n\n') : '') + text + '\n');
    app.tab.text = app.editor.getValue(); app.saveTabs();
    let results;
    try { results = app.session.exec(text, { collectErrors: true }); } catch (e) { results = [{ tag: 'ERROR', error: e, notices: [] }]; }
    for (const r of results) { r.text = r.text || text; r.notices = r.notices || []; }
    app.finishRun(app.tab, { results, base: app.editor.getValue().length - text.length - 1, sql: text, events: [], io: { reads: 0, writes: 0, seeks: 0, ms: 0 } });
  }
  function links(app, list, go) {
    const out = [];
    for (const l of list || []) {
      if (l.lesson) {
        const les = K.Content && K.Content.lessons && K.Content.lessons.get(l.lesson);
        if (les && UI.Lessons) out.push(h('button.btn.small.rf-link', { type: 'button', onclick: () => UI.Lessons.open(app, l.lesson) }, UI.icon('learn'), l.label || 'Lesson: ' + les.title));
      } else if (l.view) {
        const v = UI.views.get(l.view);
        if (v) out.push(h('button.btn.small.rf-link', { type: 'button', onclick: () => app.openView(l.view, l.sel) }, UI.icon(v.icon || 'grid'), l.label || 'The ' + v.title + ' view'));
      } else if (l.term || l.ref) {
        const k = l.term ? 'term:' + l.term : keyOf(l.ref);
        const e = k && index().byKey.get(k);
        if (e) out.push(h('button.btn.small.rf-link', { type: 'button', onclick: () => go(k) }, UI.icon(e.sec === 'term' ? 'info' : 'book'), l.label || e.title));
      }
    }
    return out;
  }
  const section = (title, ...kids) => h('section.rf-part', title ? h('h2.ls-h', title) : null, ...kids);
  const facts = (rows) => h('dl.rf-facts', rows.filter((r) => r[1]).map(([k, v]) => [h('dt', k), h('dd', typeof v === 'string' ? inline(v) : v)]));

  function entryBody(app, e, go) {
    const R = data();
    const x = e.item;
    const out = [];
    const crumb = SECTION_TITLE[e.sec] + (e.group && e.sec !== 'term' && e.sec !== 'psql' ? ' · ' + e.group : x.chapter ? ' · Chapter ' + x.chapter : '');
    out.push(h('div.ls-crumb', crumb));
    out.push(h('h1.ls-title' + (e.mono ? '.mono' : ''), e.sec === 'fn' ? x.name + '()' : e.title));
    if (e.sec === 'sql') {
      if (x.syntax) out.push(h('pre.rf-syntax', grammar(x.syntax)));
      if (x.about) out.push(h('p', inline(x.about)));
      if (x.notes && x.notes.length) out.push(h('ul.ls-list', x.notes.map((n) => h('li', inline(n)))));
      if (x.example) out.push(section('Example', example(app, x.example, { run: x.run })));
      if (x.pg) out.push(h('div.ls-tip.rf-pg', UI.icon('info'), h('div', h('b', 'PostgreSQL. '), inline(x.pg))));
    } else if (e.sec === 'fn') {
      const desc = R.functions[x.name];
      if (desc) out.push(h('p.ls-sum', inline(desc)));
      const sigs = signatures(x.name);
      const rows = sigs.map((s) => h('tr', h('td', h('code', x.name + '(' + s.args + ')')), h('td', h('code', s.ret)), h('td.muted', s.kind)));
      if (sigs.length) out.push(section('Signatures', h('table.grid.small.rf-sig', h('thead', h('tr', h('th', 'Call'), h('th', 'Result'), h('th', 'Kind'))), h('tbody', rows))));
      const kinds = new Set(sigs.map((s) => s.kind));
      if (kinds.has('aggregate')) out.push(h('p.muted', 'An aggregate: it reduces the rows of each group to one value. With OVER (...) it is a window function.'));
      if (kinds.has('set-returning')) out.push(h('p.muted', 'A set-returning function: call it in FROM, as a table, or in the select list.'));
      if (R.functionExamples[x.name]) out.push(section('Example', example(app, R.functionExamples[x.name])));
      const others = (Object.entries(R.functionGroups || {}).find(([, l]) => l.includes(x.name)) || [null, []])[1].filter((n) => n !== x.name);
      if (others.length) out.push(section('Related', h('div.rf-chips', others.slice(0, 40).map((n) => h('button.rf-chip.mono', { type: 'button', onclick: () => go('fn:' + n) }, n)))));
    } else if (e.sec === 'op') {
      if (x.registry) {
        const desc = (R.operators || {})[x.op];
        if (desc) out.push(h('p.ls-sum', inline(desc)));
        const sigs = opSignatures(x.op);
        const rows = sigs.map((s) => h('tr', h('td', h('code', s.text)), h('td', h('code', s.ret))));
        if (sigs.length) out.push(section('Operand types', h('table.grid.small.rf-sig', h('thead', h('tr', h('th', 'Expression'), h('th', 'Result'))), h('tbody', rows))));
      } else {
        if (x.about) out.push(h('p.ls-sum', inline(x.about)));
        out.push(facts([['Operands', x.args ? h('code', x.args) : null], ['Result', x.ret ? h('code', x.ret) : null]]));
        if (x.example) out.push(section('Example', example(app, x.example)));
      }
    } else if (e.sec === 'type') {
      out.push(facts([['Also written', (x.aliases || []).length ? h('span', x.aliases.map((a, i) => [i ? ', ' : '', h('code', a)])) : null], ['Literals', x.literal], ['Values', x.range], ['Storage', x.size]]));
      if (x.about) out.push(h('p', inline(x.about)));
      if (x.example) out.push(section('Example', example(app, x.example)));
      if (x.pg) out.push(h('div.ls-tip.rf-pg', UI.icon('info'), h('div', h('b', 'PostgreSQL. '), inline(x.pg))));
    } else if (e.sec === 'psql') {
      out.push(h('p.ls-sum', x.what[0].toUpperCase() + x.what.slice(1) + '.'));
      out.push(h('p', 'A psql command starts with a backslash and takes the rest of the line; it needs no semicolon. psql is the PostgreSQL client: these commands are answered by the client, which looks them up in the system catalog, not by the SQL parser. Kwery answers them from its own catalog with a table, as psql does.'));
      if (/PATTERN/.test(x.cmd)) out.push(h('p', 'A pattern selects names as in psql: ', h('code', '*'), ' matches any characters and ', h('code', '?'), ' one character, so ', h('code', 'perf*'), ' matches ', h('code', 'performance'), '.'));
      const cmd = x.cmd.replace(/\s*\[.*$/, '');
      out.push(section('Example', example(app, /\[NAME\]/.test(x.cmd) ? cmd + ' performance' : cmd, { meta: true })));
    } else if (e.sec === 'set') {
      let cur = null; try { const v = app.session && app.session.settings[x.name]; cur = v === true ? 'on' : v === false ? 'off' : v === null || v === undefined ? '' : String(v); } catch (err) { cur = null; }
      out.push(facts([['Values', x.values], ['Default', x.default], ['In this tab now', cur !== null ? h('code', cur || '(empty)') : null]]));
      if (x.about) out.push(h('p', inline(x.about)));
      if (x.example) out.push(section('Example', example(app, x.example)));
      out.push(h('p.muted', 'SET name = value changes it for the session of this tab; SET LOCAL until the end of the transaction; RESET name goes back to the default.'));
    } else if (e.sec === 'term') {
      out.push(h('p.rf-def', inline(x.def)));
      if (x.example) out.push(section('Example', example(app, x.example)));
      const rel = (x.related || []).map((id) => index().byKey.get('term:' + id)).filter(Boolean);
      if (rel.length) out.push(section('Related terms', h('div.rf-chips', rel.map((r) => h('button.rf-chip', { type: 'button', onclick: () => go(r.key) }, r.title)))));
    }
    const ls = links(app, x.see, go);
    if (ls.length) out.push(section('See it in Kwery', h('div.rf-links', ls)));
    return out;
  }

  function overview(app, go) {
    const { list } = index();
    const count = (sec) => list.filter((e) => e.sec === sec).length;
    return [
      h('div.ls-crumb', 'Reference'),
      h('h1.ls-title', 'Kwery reference'),
      h('p.ls-sum', 'Every statement, function, operator, data type, psql command and setting that Kwery knows, and the terms of the course. Search in the side panel; an entry opens here.'),
      h('div.rf-cards', SECTIONS.filter((s) => s.id !== 'all').map((s) => h('button.rf-card', { type: 'button', onclick: () => { state.sec = s.id; UI.store.set('ref.sec', s.id); app.showPanel('ref'); } }, h('b', s.title), h('span', String(count(s.id)))))),
      h('p.muted', 'Examples run on the Theatre database. Examples that change data run inside a transaction that they roll back, so they can be run again.'),
      list.length ? null : h('div.empty', 'The reference content has not loaded.'),
    ].concat(state.key && index().byKey.get(state.key) ? [h('button.btn.small', { type: 'button', onclick: () => go(state.key) }, UI.icon('history'), 'Back to ' + index().byKey.get(state.key).title)] : []);
  }

  function referenceView(app, el) {
    const body = h('div.view-body.lesson.rf-view');
    el.appendChild(body);
    let key = UI.store.get('ref.key', null);
    const back = [];
    const go = (k, fromHistory) => { if (k !== key && key && !fromHistory) back.push(key); key = k; state.key = k; UI.store.set('ref.key', k); markOpen(k); view.render(); body.scrollTop = 0; };
    const view = {
      onSelect(sel) { if (sel && sel.ref) { const k = keyOf(sel.ref) || sel.ref; if (k !== key && key) back.push(key); key = k; body.scrollTop = 0; } },
      onDb() { /* entries do not depend on the data */ },
      render() {
        body.innerHTML = '';
        const e = key && index().byKey.get(key);
        const bar = h('div.rf-bar',
          back.length ? h('button.btn.small.ghost', { type: 'button', title: 'Back', onclick: () => go(back.pop(), true) }, UI.icon('stepBack'), 'Back') : null,
          h('span.grow'),
          e ? h('button.btn.small.ghost', { type: 'button', title: 'All sections', onclick: () => { back.push(key); key = null; view.render(); } }, UI.icon('grid'), 'Overview') : null);
        if (bar.children.length > 1) body.appendChild(bar);
        for (const n of e ? entryBody(app, e, go) : overview(app, go)) if (n) body.appendChild(n);
      },
    };
    return view;
  }

  UI.registerView({ id: 'reference', title: 'Reference', icon: 'book', group: 'Learning', order: 92, create: referenceView });
  UI.Reference = { render, open, search, index, signatures, opSignatures, keyOf };
})(typeof window !== 'undefined' ? window : globalThis);
