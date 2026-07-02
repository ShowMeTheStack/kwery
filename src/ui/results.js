// The results of a script: one block per statement (a grid for rows, the command tag otherwise), notices,
// and errors with their SQLSTATE, detail and hint. Big results are drawn a screenful at a time.
(function (root) {
  'use strict';
  const K = root.K;
  const UI = K.UI;
  const { h } = UI;

  const RIGHT = new Set(['N']);

  /** a grid for one result */
  function grid(r, opts) {
    opts = opts || {};
    const zone = opts.zone;
    const cols = r.cols || [];
    const table = h('table.grid');
    const head = h('tr', h('th.rn', '#'), cols.map((c) => h('th' + (RIGHT.has(c.type && c.type.cat) ? '.num' : ''), { title: K.T.sqlName(c.type) }, h('span.cn', c.name), h('span.ct', K.T.sqlName(c.type)))));
    table.appendChild(h('thead', head));
    const body = h('tbody');
    table.appendChild(body);
    let shown = 0;
    const page = opts.page || 200;
    const more = h('button.btn.more', { type: 'button', onclick: () => draw(page * 5) });
    const draw = (n) => {
      const until = Math.min(r.rows.length, shown + n);
      const frag = document.createDocumentFragment();
      for (let i = shown; i < until; i++) {
        const row = r.rows[i];
        frag.appendChild(h('tr', h('td.rn', String(i + 1)), cols.map((c, j) => {
          const v = row[j];
          if (v === null || v === undefined) return h('td.null', 'NULL');
          const text = UI.valueText(v, c.type, zone);
          const long = text.length > 120;
          return h('td' + (RIGHT.has(c.type && c.type.cat) ? '.num' : '') + (c.type && c.type.cat === 'B' ? '.bool' : '') + (long ? '.long' : ''), { title: long ? text.slice(0, 2000) : null }, long ? text.slice(0, 120) + '…' : text);
        })));
      }
      body.appendChild(frag);
      shown = until;
      more.textContent = 'Show ' + Math.min(page * 5, r.rows.length - shown) + ' more of ' + (r.rows.length - shown).toLocaleString('en-US') + ' remaining rows';
      more.style.display = shown < r.rows.length ? '' : 'none';
    };
    draw(page);
    const wrap = h('div.grid-wrap', table);
    return h('div.grid-box', wrap, more);
  }

  /** the CSV text of a result */
  function csv(r, zone) {
    const q = (s) => (/[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
    return [r.cols.map((c) => q(c.name)).join(',')].concat(r.rows.map((row) => row.map((v, i) => (v === null ? '' : q(UI.valueText(v, r.cols[i].type, zone)))).join(','))).join('\n') + '\n';
  }

  /** an error as PostgreSQL's client shows it, with a link to the position */
  function errorBlock(e, onPos) {
    const box = h('div.res-err');
    box.appendChild(h('div.err-line', h('span.err-tag', 'ERROR'), h('span.err-msg', e.message), e.code ? h('span.err-code', { title: 'SQLSTATE: ' + (STATE_NAMES[e.code] || '') }, e.code) : null));
    if (e.detail) box.appendChild(h('div.err-sub', h('b', 'Detail '), e.detail));
    if (e.hint) box.appendChild(h('div.err-sub', h('b', 'Hint '), e.hint));
    if (e.pos !== undefined && onPos) box.appendChild(h('button.link', { type: 'button', onclick: () => onPos(e) }, 'Show where in the statement'));
    if (!e.code) box.appendChild(h('div.err-sub.muted', 'This is a bug in Kwery, not in your SQL. ' + (e.stack ? e.stack.split('\n').slice(0, 3).join(' ') : '')));
    return box;
  }
  const STATE_NAMES = {};
  for (const [k, v] of Object.entries(K.STATE)) STATE_NAMES[v] = k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());

  /** the whole output of a run */
  function render(el, run, opts) {
    opts = opts || {};
    el.innerHTML = '';
    if (!run) { el.appendChild(h('div.empty', h('p', 'Run a statement with ', h('kbd', 'Ctrl'), ' + ', h('kbd', 'Enter'), ' (the one under the caret) or ', h('kbd', 'Ctrl'), ' + ', h('kbd', 'Shift'), ' + ', h('kbd', 'Enter'), ' (the whole script).'))); return; }
    const list = h('div.res-list');
    run.results.forEach((r, i) => {
      const block = h('section.res' + (r.error ? '.bad' : ''));
      const head = h('div.res-head');
      const text = (r.text || '').replace(/\s+/g, ' ').trim();
      head.appendChild(h('button.res-sql', { type: 'button', title: 'Show this statement in the editor', onclick: () => opts.onShow && opts.onShow(r) }, text.length > 110 ? text.slice(0, 110) + '…' : text));
      if (!r.error) head.appendChild(h('span.res-tag', r.tag + (r.rows && r.tag.split(' ')[0] !== 'SELECT' && r.tag !== 'SHOW' && r.tag !== 'EXPLAIN' && !/^FETCH/.test(r.tag) ? ' · ' + UI.plural(r.rows.length, 'row') + ' returned' : '')));
      if (r.io) head.appendChild(h('span.res-io', { title: 'Simulated I/O: page reads and writes, and the time the simulated disk took' }, UI.icon('disk'), r.io.reads + ' reads · ' + r.io.writes + ' writes · ' + UI.ms(r.io.ms)));
      const tools = h('span.res-tools');
      if (r.rows && r.cols && r.rows.length) {
        tools.appendChild(UI.btn('copy', null, 'Copy as CSV', () => UI.copy(csv(r, opts.zone))));
        tools.appendChild(UI.btn('download', null, 'Download as CSV', () => UI.download('result-' + (i + 1) + '.csv', csv(r, opts.zone), 'text/csv')));
      }
      if (r.plan && opts.onPlan) tools.appendChild(UI.btn('plan', null, 'Show the plan of this statement', () => opts.onPlan(r)));
      head.appendChild(tools);
      block.appendChild(head);
      for (const n of r.notices || []) block.appendChild(h('div.res-note.' + n.level.toLowerCase(), h('span.nt', n.level), n.message));
      if (r.error) block.appendChild(errorBlock(r.error, opts.onPos ? (e) => opts.onPos(e, r) : null));
      else if (r.rows && r.cols) {
        if (r.tag === 'EXPLAIN') block.appendChild(h('pre.res-plan', r.rows.map((x) => x[0]).join('\n')));
        else block.appendChild(r.rows.length ? grid(r, opts) : h('div.res-none', '(no rows)'));
      }
      if (r.copyText !== undefined) block.appendChild(h('pre.res-plan', r.copyText));
      if (r.title) block.insertBefore(h('div.res-title', r.title), block.children[1] || null);
      if (r.footer && r.footer.length) block.appendChild(h('pre.res-plan', r.footer.join('\n')));
      list.appendChild(block);
    });
    if (run.stopped) list.appendChild(h('div.res-note.warning', h('span.nt', 'Stopped'), 'The script stopped at the first error; the statements after it did not run.'));
    el.appendChild(list);
    const last = list.lastElementChild;
    if (last && opts.scrollLast) last.scrollIntoView({ block: 'nearest' });
  }

  UI.Results = { render, grid, csv, errorBlock };
})(typeof window !== 'undefined' ? window : globalThis);
