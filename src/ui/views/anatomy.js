// Query anatomy: a SELECT taken apart in the order SQL defines its meaning (FROM, WHERE, GROUP BY, HAVING,
// SELECT, DISTINCT, ORDER BY, LIMIT), with the table after each clause. The NULL lens shows, for every row,
// whether each WHERE condition is TRUE, FALSE or UNKNOWN, and why the UNKNOWN rows are dropped.
(function (root) {
  'use strict';
  const K = root.K;
  const UI = K.UI;
  const { h } = UI;

  const CLAUSES = ['select', 'from', 'where', 'group', 'having', 'window', 'order', 'limit', 'offset', 'fetch', 'for'];
  /** the top-level clauses of one SELECT statement, as slices of its text */
  function clauses(sql) {
    const text = sql.trim().replace(/;\s*$/, '');
    const toks = K.sqlTokens(text);
    let depth = 0;
    const marks = [];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.t === 'pu' && text[t.a] === '(') depth++;
      else if (t.t === 'pu' && text[t.a] === ')') depth--;
      else if (depth === 0 && t.t === 'kw') {
        const w = text.slice(t.a, t.b).toLowerCase();
        if (w === 'union' || w === 'intersect' || w === 'except' || w === 'with') return { error: 'The anatomy view takes apart a single SELECT (no WITH, UNION, INTERSECT or EXCEPT at the top).' };
        if (CLAUSES.includes(w) && !(w === 'for' && marks.length && marks[marks.length - 1].w === 'fetch')) marks.push({ w, a: t.a, b: t.b });
      }
    }
    if (!marks.length || marks[0].w !== 'select') return { error: 'Put the caret on a SELECT statement.' };
    const out = {};
    marks.forEach((m, i) => { const end = i + 1 < marks.length ? marks[i + 1].a : text.length; out[m.w] = text.slice(m.b, end).trim().replace(/^by\b/i, '').trim(); });
    // DISTINCT is part of the select list's text
    const dm = /^distinct(\s+on\s*\([^)]*\))?/i.exec(out.select || '');
    if (dm) { out.distinct = dm[0]; out.select = out.select.slice(dm[0].length).trim(); }
    else if (/^all\b/i.test(out.select || '')) out.select = out.select.slice(3).trim();
    return out;
  }
  /** split a condition at its top-level ANDs */
  function conjuncts(cond) {
    const toks = K.sqlTokens(cond);
    const parts = [];
    let depth = 0, start = 0, between = false;
    for (const t of toks) {
      const w = t.t === 'kw' ? cond.slice(t.a, t.b).toLowerCase() : '';
      if (t.t === 'pu' && cond[t.a] === '(') depth++;
      else if (t.t === 'pu' && cond[t.a] === ')') depth--;
      else if (depth === 0 && w === 'between') between = true;
      else if (depth === 0 && w === 'and') { if (between) { between = false; continue; } parts.push(cond.slice(start, t.a).trim()); start = t.b; }
    }
    parts.push(cond.slice(start).trim());
    return parts.filter(Boolean);
  }

  function create(app, el) {
    let sql = '';
    const head = h('div.view-head');
    const body = h('div.view-body.anat');
    el.appendChild(h('div.view-intro', h('b', 'The meaning of a query, clause by clause. '), 'SQL defines a SELECT as if FROM built a table first, WHERE then kept some rows, GROUP BY formed groups, HAVING kept some groups, and only then SELECT computed the output columns, before DISTINCT, ORDER BY and LIMIT. The optimizer may run it differently, but the result is always this one.'));
    el.appendChild(head); el.appendChild(body);
    const take = () => { const cur = app.editor.current(); sql = cur ? cur.text : ''; view.render(); };
    // the steps run in a session of their own, so an error in one cannot spoil the transaction of the editor's tab
    const run = (q) => { const s = app.db.session({ name: 'anatomy' }); try { s.settings = Object.assign({}, app.session.settings); const rs = s.exec(q); return rs[rs.length - 1]; } finally { app.db.closeSession(s); } };
    const view = {
      onRun(r) { const last = r && r.results && r.results[r.results.length - 1]; if (last && last.text && /^\s*select\b/i.test(last.text)) { sql = last.text; } },
      render() {
        head.innerHTML = '';
        head.appendChild(UI.btn('refresh', 'Take the statement under the caret', null, take));
        body.innerHTML = '';
        if (!sql) { body.appendChild(h('div.empty', 'Run a SELECT (or press the button above) to take it apart here.')); return; }
        const c = clauses(sql);
        if (c.error) { body.appendChild(h('div.empty', c.error)); return; }
        const steps = [];
        const from = c.from ? ' from ' + c.from : '';
        const grouped = !!c.group || !!c.having || /\b(count|sum|avg|min|max|string_agg|array_agg|bool_and|bool_or|every)\s*\(/i.test(c.select);
        const step = (n, title, explain, q, opts) => { steps.push({ n, title, explain, q, opts: opts || {} }); };
        let k = 1;
        if (c.from) step(k++, 'FROM ' + short(c.from), 'Every combination of rows the FROM clause describes (joins included): the table the rest of the query works on.', 'select *' + from + ' limit 500');
        else step(k++, 'No FROM', 'Without FROM there is one row with no columns; SELECT computes its values from constants.', 'select 1 as "(one row)"');
        if (c.where) {
          const parts = conjuncts(c.where);
          const label = (p) => p.replace(/\s+/g, ' ').replace(/"/g, "'").slice(0, 60);
          const lens = parts.map((p) => '(' + p + ') as "' + label(p) + '"').join(', ');
          step(k++, 'WHERE ' + short(c.where), 'The NULL lens: each condition is TRUE, FALSE or UNKNOWN for each row (UNKNOWN comes from comparing with NULL). A row is kept only when the whole condition is TRUE; FALSE and UNKNOWN rows are both dropped.', 'select ' + lens + (parts.length > 1 ? ', (' + c.where + ') as "all of WHERE"' : '') + ', *' + from + ' limit 500', { lens: parts.length + (parts.length > 1 ? 1 : 0) });
        }
        const where = c.where ? ' where ' + c.where : '';
        if (c.group) step(k++, 'GROUP BY ' + short(c.group), 'Rows with equal values of the grouping expressions form one group. From here on, each group becomes one row: only the grouping expressions and aggregates can be used.', 'select ' + c.group + ', count(*) as "rows in the group"' + from + where + ' group by ' + c.group + ' order by ' + c.group + ' limit 500');
        else if (grouped) step(k++, 'One group', 'There is an aggregate but no GROUP BY: all the rows kept by WHERE form one group (even if there are none).', 'select count(*) as "rows in the group"' + from + where);
        if (c.having) step(k++, 'HAVING ' + short(c.having), 'HAVING keeps or drops whole groups, using aggregates of each group. Like WHERE, a group is kept only when the condition is TRUE.', 'select ' + (c.group ? c.group + ', ' : '') + '(' + c.having + ') as "HAVING"' + from + where + (c.group ? ' group by ' + c.group : '') + ' limit 500', { lens: 1 });
        const gh = (c.group ? ' group by ' + c.group : '') + (c.having ? ' having ' + c.having : '');
        step(k++, 'SELECT ' + short(c.select), 'Now the output columns are computed for each remaining row (or group). Column aliases defined here exist only from this point on, which is why WHERE cannot use them but ORDER BY can.', 'select ' + c.select + from + where + gh + (c.window ? ' window ' + c.window : '') + ' limit 500');
        if (c.distinct) step(k++, c.distinct.toUpperCase(), 'Duplicate output rows are removed' + (/on/i.test(c.distinct) ? ': DISTINCT ON keeps the first row of each group of equal key values, in ORDER BY order.' : '.'), 'select ' + c.distinct + ' ' + c.select + from + where + gh + (c.order ? ' order by ' + c.order : '') + ' limit 500');
        if (c.order) step(k++, 'ORDER BY ' + short(c.order), 'The rows are sorted. Without ORDER BY, the order of a result is not defined: it is whatever the plan happened to produce.', 'select ' + (c.distinct ? c.distinct + ' ' : '') + c.select + from + where + gh + ' order by ' + c.order + ' limit 500');
        if (c.limit || c.offset || c.fetch) step(k++, 'LIMIT / OFFSET', 'Finally only part of the sorted result is returned.', sql.trim().replace(/;\s*$/, ''));
        for (const st of steps) {
          const box = h('section.anat-step', h('div.anat-h', h('span.anat-n', String(st.n)), h('code', st.title)), h('p.anat-x', st.explain));
          let r;
          try { r = run(st.q); } catch (e) { box.appendChild(h('div.res-err', h('div.err-line', h('span.err-tag', 'ERROR'), h('span.err-msg', e.message)))); body.appendChild(box); continue; }
          box.appendChild(h('div.anat-meta', UI.plural(r.rows.length, 'row') + (r.rows.length >= 500 ? ' (the first 500)' : '')));
          if (st.opts.lens) {
            // colour the TRUE / FALSE / UNKNOWN columns, and count them
            const n = st.opts.lens;
            const counts = { t: 0, f: 0, u: 0 };
            for (const row of r.rows) { const v = row[n - 1]; if (v === true) counts.t++; else if (v === false) counts.f++; else counts.u++; }
            box.appendChild(h('div.anat-lens', h('span.l-t', 'TRUE ' + counts.t), h('span.l-f', 'FALSE ' + counts.f), h('span.l-u', 'UNKNOWN ' + counts.u), h('span.muted', (st.title.startsWith('HAVING') ? 'groups' : 'rows') + ' kept: ' + counts.t)));
            const g = UI.Results.grid(r, { zone: app.session.settings.timezone });
            g.querySelectorAll('tbody tr').forEach((tr, i) => { const row = r.rows[i]; for (let j = 0; j < n; j++) { const td = tr.children[j + 1]; const v = row[j]; td.classList.add(v === true ? 'lens-t' : v === false ? 'lens-f' : 'lens-u'); td.textContent = v === true ? 'TRUE' : v === false ? 'FALSE' : 'UNKNOWN'; } if (row[n - 1] !== true) tr.classList.add('dropped'); });
            box.appendChild(g);
          } else box.appendChild(r.rows.length ? UI.Results.grid(r, { zone: app.session.settings.timezone, page: 50 }) : h('div.res-none', '(no rows)'));
          body.appendChild(box);
        }
      },
    };
    return view;
  }
  const short = (s) => (s.length > 60 ? s.slice(0, 57) + '…' : s).replace(/\s+/g, ' ');

  UI.registerView({ id: 'anatomy', title: 'Query anatomy', icon: 'format', group: 'Queries', order: 2, create });
  UI.Anatomy = { clauses, conjuncts };
})(typeof window !== 'undefined' ? window : globalThis);
