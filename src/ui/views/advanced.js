// A small kit shared by the Blockchain, Tuning, Data cube and Streams views (UI.ADV): sections, selects and
// segmented buttons, a SQL box that runs in the workbench, a history of states with back and forward, a
// seeded random generator, and a private session that is always closed again. The views use it at run time,
// so the order the files load in does not matter.
(function (root) {
  'use strict';
  const K = root.K;
  const UI = K.UI;
  const { h } = UI;
  const A = UI.ADV = UI.ADV || {};

  /** a section: a title, optional tools on the right, then the content */
  A.sec = (title, tools, ...kids) => h('section.adv-sec', h('div.adv-sh', h('h3', title), tools ? h('div.adv-tools', tools) : null), h('div.adv-sb', ...kids));
  A.note = (...kids) => h('p.adv-note', ...kids);
  A.badge = (text, cls) => h('span.adv-badge' + (cls ? '.' + cls : ''), text);
  A.seg = (opts, value, onchange, label) => h('div.seg.adv-seg', { role: 'group', 'aria-label': label || null }, opts.map(([v, l]) => h('button' + (v === value ? '.on' : ''), { type: 'button', 'aria-pressed': String(v === value), onclick: () => onchange(v) }, l)));
  A.select = (label, opts, value, onchange, title) => {
    const numeric = typeof opts[0][0] === 'number';
    return h('label.adv-field', { title: title || null }, label ? h('span', label) : null,
      h('select.inp', { 'aria-label': label || title, onchange: (e) => onchange(numeric ? Number(e.target.value) : e.target.value) },
        opts.map(([v, l]) => h('option', { value: String(v), selected: String(v) === String(value) }, l))));
  };
  A.num = (n, d) => (typeof n !== 'number' || !isFinite(n) ? '–' : n.toLocaleString('en-US', { maximumFractionDigits: d === undefined ? 1 : d, minimumFractionDigits: 0 }));

  /** SQL with the workbench's colours, a Run button (it runs in the active tab, results below the editor) and a copy to the editor */
  A.sqlBox = (app, sql, opts) => {
    opts = opts || {};
    const run = () => { if (opts.before) opts.before(); app.runText(sql.trim(), { insert: true }); };
    return h('div.adv-sqlbox' + (opts.cls ? '.' + opts.cls : ''), h('pre.ls-sql', UI.highlightSql(sql.trim())),
      h('div.adv-sqltools', opts.noRun ? null : h('button.btn.adv-run', { type: 'button', onclick: run }, UI.icon('run'), opts.runLabel || 'Run it'),
        h('button.btn.ghost', { type: 'button', onclick: () => { app.editor.setValue(sql.trim() + '\n'); app.tab.text = app.editor.getValue(); app.saveTabs(); } }, UI.icon('copy'), 'To the editor'),
        opts.note ? h('span.adv-note', opts.note) : null));
  };

  /** a seeded generator (mulberry32): the same seed gives the same numbers on every run */
  A.rng = (seed) => {
    let a = seed >>> 0;
    const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    next.int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
    next.pick = (arr) => arr[Math.floor(next() * arr.length)];
    return next;
  };

  /** run f(session) in a session of its own, closed afterwards even if f throws (an open transaction is rolled back) */
  A.privately = (app, name, f) => {
    const s = app.db.session({ name });
    try { return f(s); } finally {
      if (s.tx) { try { s.abortTx(s.tx); } catch (e) { /* already gone */ } }
      app.db.closeSession(s);
    }
  };
  A.close = (app, s) => { if (s.tx) { try { s.abortTx(s.tx); } catch (e) { /* already gone */ } } app.db.closeSession(s); };
  /** a value from a result row as text */
  A.text = (v, t) => (v === null || v === undefined ? null : typeof v === 'bigint' ? Number(v).toLocaleString('en-US') : typeof v === 'string' ? v : UI.valueText(v, t));
  /** a value from a result row as a number (NaN if it is not one) */
  A.number = (v) => (v === null || v === undefined ? NaN : typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : Number(String(v)));
  A.later = (f) => setTimeout(f, 0);

  /**
   * a history of states: push(state, label) after every change; back, forward and the slider move through it and
   * call onGo(state). The bar is the strip of controls to put in a view's head.
   */
  A.history = (onGo) => {
    const H = { list: [], pos: -1 };
    const label = h('span.adv-hl', '');
    const pos = h('span.adv-hp', '');
    const slider = h('input.adv-hr', { type: 'range', min: '0', max: '0', value: '0', 'aria-label': 'Position in the history', oninput: (e) => H.go(+e.target.value) });
    const back = UI.btn('stepBack', null, 'Back one step', () => H.go(H.pos - 1), 'icon');
    const fwd = UI.btn('step', null, 'Forward one step', () => H.go(H.pos + 1), 'icon');
    const first = UI.btn('first', null, 'Back to the start', () => H.go(0), 'icon');
    const last = UI.btn('last', null, 'To the latest step', () => H.go(H.list.length - 1), 'icon');
    H.bar = h('div.adv-hist', first, back, fwd, last, slider, pos, label);
    const clone = (x) => JSON.parse(JSON.stringify(x));
    H.update = () => {
      slider.max = String(Math.max(0, H.list.length - 1)); slider.value = String(Math.max(0, H.pos));
      pos.textContent = (H.pos + 1) + ' / ' + H.list.length;
      label.textContent = H.pos >= 0 ? H.list[H.pos].label : '';
      label.title = label.textContent;
      back.disabled = first.disabled = H.pos <= 0; fwd.disabled = last.disabled = H.pos >= H.list.length - 1;
    };
    /** record a new state; anything after the current position is dropped, as in an editor's undo */
    H.push = (state, text) => { H.list = H.list.slice(0, H.pos + 1); H.list.push({ state: clone(state), label: text }); if (H.list.length > 400) H.list.shift(); H.pos = H.list.length - 1; H.update(); };
    /** replace the current state (small edits that should not add a step each) */
    H.amend = (state, text) => { if (H.pos < 0) return H.push(state, text); H.list[H.pos] = { state: clone(state), label: text || H.list[H.pos].label }; H.update(); };
    H.go = (p) => { p = Math.max(0, Math.min(H.list.length - 1, p)); if (p === H.pos || p < 0) return; H.pos = p; H.update(); onGo(clone(H.list[p].state)); };
    H.current = () => (H.pos >= 0 ? clone(H.list[H.pos].state) : null);
    return H;
  };
})(typeof window !== 'undefined' ? window : globalThis);
