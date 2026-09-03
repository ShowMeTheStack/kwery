// Lessons, exercises and tours. Content files add chapters, lessons and exercises with K.Content; the side
// panel lists them by chapter (with progress), a lesson opens in the dock with runnable examples and questions
// to answer before running, and an exercise is checked by running the student's query and the reference query
// on the database and on altered copies of it, so a query that only fits the sample data is caught.
(function (root) {
  'use strict';
  const K = root.K;
  const UI = K.UI;
  const { h } = UI;

  // ---- content registry -------------------------------------------------------------------------------
  const C = K.Content = K.Content || { chapters: new Map(), lessons: new Map(), exercises: new Map(), tours: new Map(), variants: {} };
  C.chapter = (n, part, title, about) => { C.chapters.set(n, Object.assign(C.chapters.get(n) || { lessons: [], exercises: [] }, { n, part, title, about })); };
  C.lesson = (l) => { C.lessons.set(l.id, l); const ch = C.chapters.get(l.chapter); if (ch && !ch.lessons.includes(l.id)) ch.lessons.push(l.id); };
  C.exercise = (x) => { C.exercises.set(x.id, Object.assign({ kind: 'sql', db: 'theatre' }, x)); const ch = C.chapters.get(x.chapter); if (ch && !ch.exercises.includes(x.id)) ch.exercises.push(x.id); };
  C.tour = (t) => { C.tours.set(t.id, t); };

  const progress = () => UI.store.get('progress', { done: {}, solved: {} });
  const mark = (kind, id) => { const p = progress(); p[kind][id] = Date.now(); UI.store.set('progress', p); };

  // ---- inline text: `code`, **bold**, *italic*, [link](url) --------------------------------------------------
  function inline(text) {
    const out = [];
    const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push(text.slice(last, m.index));
      const t = m[0];
      if (t[0] === '`') out.push(h('code', t.slice(1, -1)));
      else if (t.startsWith('**')) out.push(h('b', t.slice(2, -2)));
      else if (t[0] === '*') out.push(h('i', t.slice(1, -1)));
      else { const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(t); out.push(h('a', { href: mm[2], target: '_blank', rel: 'noopener' }, mm[1])); }
      last = m.index + t.length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }
  UI.inline = inline;

  // ---- the side panel: chapters with their lessons --------------------------------------------------------------
  function renderList(app, el, kind) {
    const p = progress();
    const parts = new Map();
    for (const ch of [...C.chapters.values()].sort((a, b) => a.n - b.n)) { if (!parts.has(ch.part)) parts.set(ch.part, []); parts.get(ch.part).push(ch); }
    const openCh = new Set(UI.store.get('learn.open', [1]));
    const filter = h('input.inp.filter', { type: 'search', placeholder: kind === 'lessons' ? 'Find a lesson' : 'Find an exercise', 'aria-label': 'Filter', value: renderList.f || '', oninput: UI.debounce((e) => { renderList.f = e.target.value; app.renderPanel(); const f = app.side.querySelector('.filter'); if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); } }, 200) });
    el.appendChild(h('div.side-tools', filter));
    const f = (renderList.f || '').toLowerCase();
    const list = h('div.learn');
    let total = 0, done = 0;
    for (const [part, chs] of parts) {
      list.appendChild(h('div.learn-part', part));
      for (const ch of chs) {
        const ids = kind === 'lessons' ? ch.lessons : ch.exercises;
        const items = ids.map((id) => (kind === 'lessons' ? C.lessons.get(id) : C.exercises.get(id))).filter((x) => x && (!f || x.title.toLowerCase().includes(f) || ch.title.toLowerCase().includes(f)));
        if (!items.length) continue;
        const nDone = items.filter((x) => p[kind === 'lessons' ? 'done' : 'solved'][x.id]).length;
        total += items.length; done += nDone;
        const isOpen = openCh.has(ch.n) || !!f;
        list.appendChild(h('button.learn-ch' + (isOpen ? '.open' : ''), { type: 'button', 'aria-expanded': String(isOpen), onclick: () => { if (openCh.has(ch.n)) openCh.delete(ch.n); else openCh.add(ch.n); UI.store.set('learn.open', [...openCh]); app.renderPanel(); } },
          h('span.lc-n', String(ch.n)), h('span.lc-t', ch.title), h('span.lc-p', nDone + '/' + items.length)));
        if (!isOpen) continue;
        for (const x of items) {
          const ok = p[kind === 'lessons' ? 'done' : 'solved'][x.id];
          list.appendChild(h('button.learn-item' + (ok ? '.ok' : '') + (app.lessonOpen === x.id ? '.on' : ''), { type: 'button', onclick: () => (kind === 'lessons' ? openLesson(app, x.id) : openExercise(app, x.id)) },
            h('span.li-mark', ok ? UI.icon('check') : null), h('span.li-t', x.title), x.minutes ? h('span.li-m', x.minutes + ' min') : x.level ? h('span.li-m', '●'.repeat(x.level)) : null));
        }
      }
    }
    if (!total) list.appendChild(h('div.empty', 'Nothing here yet.'));
    else el.prepend(h('div.learn-sum', h('div.bar', h('i', { style: { width: Math.round((done / total) * 100) + '%' } })), h('span', done + ' of ' + total + (kind === 'lessons' ? ' lessons read' : ' exercises solved'))));
    el.appendChild(list);
    if (kind === 'lessons' && C.tours.size) {
      el.appendChild(h('div.learn-part', 'Guided tours'));
      for (const t of C.tours.values()) el.appendChild(h('button.learn-item', { type: 'button', onclick: () => UI.Tour.start(app, t.id) }, h('span.li-mark', UI.icon('flag')), h('span.li-t', t.title)));
    }
  }

  // ---- a lesson in the dock --------------------------------------------------------------------------------------
  function openLesson(app, id) {
    app.lessonOpen = id;
    const v = app.openView('lesson', { lesson: id });
    if (app.panel === 'learn') app.renderPanel();
    return v;
  }
  function lessonView(app, el) {
    let id = null;
    const body = h('div.view-body.lesson');
    el.appendChild(body);
    const view = {
      onSelect(sel) { if (sel && sel.lesson) { id = sel.lesson; view.render(); body.scrollTop = 0; } },
      render() {
        body.innerHTML = '';
        const l = C.lessons.get(id);
        if (!l) { body.appendChild(h('div.empty', 'Choose a lesson in the Lessons panel.')); return; }
        const ch = C.chapters.get(l.chapter);
        body.appendChild(h('div.ls-crumb', 'Chapter ' + l.chapter + ' · ' + (ch ? ch.title : '')));
        body.appendChild(h('h1.ls-title', l.title));
        if (l.summary) body.appendChild(h('p.ls-sum', inline(l.summary)));
        if (l.setup && !l._setupDone) { try { app.db.session({ name: 'lesson setup' }).exec(l.setup); } catch (e) { /* already set up */ } l._setupDone = true; app.emit('schema'); }
        for (const b of l.body || []) body.appendChild(block(app, b));
        const ids = ch ? ch.lessons : [];
        const i = ids.indexOf(id);
        const nav = h('div.ls-nav',
          i > 0 ? h('button.btn', { type: 'button', onclick: () => openLesson(app, ids[i - 1]) }, UI.icon('stepBack'), 'Previous') : h('span'),
          h('button.btn.primary', { type: 'button', onclick: () => { mark('done', id); if (i + 1 < ids.length) openLesson(app, ids[i + 1]); else { UI.toast('Chapter finished'); app.renderPanel(); } } }, UI.icon('check'), i + 1 < ids.length ? 'Done, next lesson' : 'Done'));
        body.appendChild(nav);
      },
    };
    return view;
  }
  /** one block of a lesson */
  function block(app, b) {
    if (typeof b === 'string') return h('p', inline(b));
    if (b.p) return h('p', inline(b.p));
    if (b.h) return h('h2.ls-h', b.h);
    if (b.list) return h('ul.ls-list', b.list.map((x) => h('li', inline(x))));
    if (b.tip) return h('div.ls-tip', UI.icon('info'), h('div', inline(b.tip)));
    if (b.warn) return h('div.ls-warn', UI.icon('warn'), h('div', inline(b.warn)));
    if (b.def) return h('div.ls-def', h('b', b.def + ' '), inline(b.text || ''));
    if (b.table) return h('table.grid.small.ls-table', h('thead', h('tr', b.table[0].map((x) => h('th', inline(String(x)))))), h('tbody', b.table.slice(1).map((r) => h('tr', r.map((x) => h('td', inline(String(x))))))));
    if (b.svg) { const d = h('div.ls-fig'); d.innerHTML = b.svg; if (b.caption) d.appendChild(h('div.ls-cap', inline(b.caption))); return d; }
    if (b.predict) return predictBlock(app, b);
    if (b.sql) return sqlBlock(app, b);
    if (b.view) return h('button.btn.ls-view', { type: 'button', onclick: () => app.openView(b.view, b.sel) }, UI.icon(UI.views.get(b.view) ? UI.views.get(b.view).icon : 'grid'), b.label || 'Open the ' + (UI.views.get(b.view) ? UI.views.get(b.view).title : b.view) + ' view');
    if (b.steps) return h('ol.ls-steps', b.steps.map((x) => h('li', inline(x))));
    return h('div');
  }
  function sqlBlock(app, b) {
    const code = h('pre.ls-sql', highlight(b.sql));
    const run = () => { app.openView(b.thenView || (b.view === false ? null : b.thenView) || app.dock.active || 'plan'); app.runText(b.sql.trim(), { insert: true }); };
    const tools = h('div.ls-sql-tools',
      b.run === false ? null : h('button.btn.small', { type: 'button', onclick: run }, UI.icon('run'), 'Run'),
      h('button.btn.small.ghost', { type: 'button', onclick: () => { app.editor.setValue(b.sql.trim() + '\n'); app.tab.text = app.editor.getValue(); app.saveTabs(); app.editor.focus(); } }, UI.icon('copy'), 'To the editor'));
    return h('div.ls-sqlbox', code, tools, b.note ? h('div.ls-note', inline(b.note)) : null);
  }
  function highlight(sql) {
    const frag = document.createDocumentFragment();
    for (const t of K.sqlTokens(sql)) { const text = sql.slice(t.a, t.b); frag.appendChild(t.t === 'ws' ? document.createTextNode(text) : h('span.t-' + t.t, text)); }
    return frag;
  }
  UI.highlightSql = highlight;
  /** a question to answer before running: the answer shows after a choice, and then the query can be run to check */
  function predictBlock(app, b) {
    const q = b.predict;
    const box = h('div.ls-predict', h('div.lp-q', UI.icon('help'), h('div', inline(q.q))));
    const opts = h('div.lp-opts');
    const result = h('div.lp-res');
    q.options.forEach((o, i) => opts.appendChild(h('button.lp-opt', { type: 'button', onclick: () => {
      [...opts.children].forEach((c, k) => { c.disabled = true; c.classList.toggle('right', k === q.answer); c.classList.toggle('wrong', k === i && i !== q.answer); });
      result.innerHTML = '';
      result.appendChild(h('div.' + (i === q.answer ? 'lp-ok' : 'lp-no'), i === q.answer ? 'Right. ' : 'Not quite. ', inline(q.explain || '')));
      if (b.sql) result.appendChild(sqlBlock(app, { sql: b.sql, note: 'Run it to see for yourself.' }));
    } }, inline(o))));
    box.appendChild(opts);
    box.appendChild(result);
    return box;
  }

  // ---- exercises ----------------------------------------------------------------------------------------------------
  function openExercise(app, id) {
    app.lessonOpen = id;
    app.openView('exercise', { exercise: id });
    if (app.panel === 'tasks') app.renderPanel();
  }
  function exerciseView(app, el) {
    let id = null, hints = 0, verdict = null;
    const body = h('div.view-body.lesson');
    el.appendChild(body);
    const view = {
      onSelect(sel) { if (sel && sel.exercise) { id = sel.exercise; hints = 0; verdict = null; view.render(); } },
      render() {
        body.innerHTML = '';
        const x = C.exercises.get(id);
        if (!x) { body.appendChild(h('div.empty', 'Choose an exercise in the Exercises panel.')); return; }
        const ch = C.chapters.get(x.chapter);
        body.appendChild(h('div.ls-crumb', 'Chapter ' + x.chapter + ' · ' + (ch ? ch.title : '') + (x.level ? ' · ' + ['', 'easy', 'medium', 'hard'][x.level] : '')));
        body.appendChild(h('h1.ls-title', x.title));
        for (const b of [].concat(x.text)) body.appendChild(block(app, b));
        if (x.kind === 'sql' || x.kind === 'dml') body.appendChild(h('p.muted', 'Write your answer in the editor, then check it. Your query is run on this database and on altered copies of it, and must give the same result as the reference answer on all of them.'));
        const tools = h('div.ex-tools',
          h('button.btn.primary', { type: 'button', onclick: () => { verdict = check(app, x, currentAnswer(app)); if (verdict.ok) mark('solved', x.id); view.render(); if (app.panel === 'tasks') app.renderPanel(); } }, UI.icon('check'), 'Check my answer'),
          x.hints && hints < x.hints.length ? h('button.btn', { type: 'button', onclick: () => { hints++; view.render(); } }, UI.icon('help'), hints ? 'Another hint' : 'A hint') : null,
          x.ref ? h('button.btn.ghost', { type: 'button', onclick: () => UI.confirm('Show the answer?', 'You learn more by trying first. Show a reference answer anyway?', () => { verdict = { ok: false, shown: true, ref: x.ref }; view.render(); }, 'Show it') }, 'Show an answer') : null);
        body.appendChild(tools);
        for (let i = 0; i < hints; i++) body.appendChild(h('div.ls-tip', UI.icon('info'), h('div', h('b', 'Hint ' + (i + 1) + '. '), inline(x.hints[i]))));
        if (verdict) body.appendChild(verdictBlock(app, verdict));
      },
    };
    return view;
  }
  function currentAnswer(app) { const cur = app.editor.current(); const sel = app.editor.selection(); return sel.b > sel.a ? sel.text : cur ? cur.text : app.editor.getValue(); }
  function verdictBlock(app, v) {
    if (v.shown) return h('div.ex-res', h('b', 'A reference answer (other answers can be just as right):'), h('pre.ls-sql', highlight(v.ref)));
    const box = h('div.ex-res' + (v.ok ? '.ok' : '.bad'), h('div.ex-v', v.ok ? UI.icon('check') : UI.icon('x'), h('b', v.ok ? 'Correct.' : 'Not yet.'), ' ', v.message || ''));
    if (v.details) for (const d of v.details) box.appendChild(h('div.ex-d', inline(d)));
    return box;
  }
  /**
   * check an answer: SQL exercises compare result multisets (in order if the reference has ORDER BY) on the
   * database and on each variant; a variant is a script run inside a transaction that is rolled back afterwards
   */
  function check(app, x, answer) {
    if (x.check) return x.check(app, answer);
    if (!answer || !answer.trim()) return { ok: false, message: 'The editor is empty.' };
    const s = app.db.session({ name: 'checker' });
    const out = (r) => r.rows.map((row) => row.map((v, i) => (v === null ? '∅' : UI.valueText(v, r.cols[i].type))).join('\u0001'));
    const ordered = x.ordered !== undefined ? x.ordered : /\border\s+by\b/i.test(x.ref);
    const variants = [null].concat(x.variants || C.variants[x.db] || []);
    try {
      for (let vi = 0; vi < variants.length; vi++) {
        s.exec('begin');
        try {
          if (variants[vi]) s.exec(variants[vi]);
          let ref, got;
          if (x.kind === 'dml') {
            s.exec('savepoint before_answer');
            s.exec(x.ref); ref = s.query(x.after);
            s.exec('rollback to savepoint before_answer');
            try { s.exec(answer); } catch (e) { return { ok: false, message: 'Your statement fails: ' + e.message }; }
            got = s.query(x.after);
          } else {
            ref = s.query(x.ref);
            try { const rs = s.exec(answer); got = rs[rs.length - 1]; } catch (e) { return { ok: false, message: 'Your query fails: ' + e.message + (e.hint ? ' (' + e.hint + ')' : '') }; }
            if (!got.rows) return { ok: false, message: 'That statement does not return rows. The answer should be a query.' };
          }
          if (got.cols.length !== ref.cols.length) return { ok: false, message: 'Your result has ' + UI.plural(got.cols.length, 'column') + '; the answer has ' + ref.cols.length + '.', details: ['Expected columns like: ' + ref.cols.map((c) => c.name).join(', ')] };
          const a = out(ref), b = out(got);
          const same = ordered ? a.length === b.length && a.every((r, i) => r === b[i]) : a.length === b.length && a.slice().sort().every((r, i, arr) => r === b.slice().sort()[i]);
          if (!same) {
            const missing = a.filter((r) => !b.includes(r)).length, extra = b.filter((r) => !a.includes(r)).length;
            const why = a.length !== b.length ? 'your query gives ' + UI.plural(b.length, 'row') + ', the answer ' + a.length + '.' : missing || extra ? 'some rows differ.' : ordered ? 'the rows are right but not in the order asked for.' : 'the rows differ.';
            return { ok: false, message: (vi === 0 ? 'On this database ' : 'On an altered copy of the database (' + ((x.variantNotes || C.variantNotes || [])[vi - 1] || 'some rows changed') + ') ') + why, details: vi > 0 ? ['Your query works on the sample data but not in general: check for NULLs, duplicates, ties and rows that the sample happens not to have.'] : [] };
          }
        } finally { s.exec('rollback'); }
      }
      return { ok: true, message: 'Your answer gives the right result on this database and on ' + UI.plural(variants.length - 1, 'altered copy', 'altered copies') + ' of it.' };
    } finally { app.db.closeSession(s); }
  }

  UI.registerView({ id: 'lesson', title: 'Lesson', icon: 'learn', group: 'Learning', order: 90, create: lessonView });
  UI.registerView({ id: 'exercise', title: 'Exercise', icon: 'tasks', group: 'Learning', order: 91, create: exerciseView });
  UI.Lessons = { render: (app, el) => renderList(app, el, 'lessons'), open: openLesson, block, inline };
  UI.Exercises = { render: (app, el) => renderList(app, el, 'exercises'), open: openExercise, check, markSolved: (id) => mark('solved', id), isSolved: (id) => !!progress().solved[id] };
  UI.Lessons.markDone = (id) => mark('done', id);

  // ---- guided tours: a callout next to an element, step by step --------------------------------------------------------
  UI.Tour = {
    start(app, id) {
      const t = C.tours.get(id);
      if (!t) return;
      let i = 0;
      let box = null;
      const close = () => { if (box) box.remove(); document.querySelectorAll('.tour-hi').forEach((e) => e.classList.remove('tour-hi')); };
      const show = () => {
        close();
        const st = t.steps[i];
        if (st.before) { try { st.before(app); } catch (e) { console.error(e); } }
        const target = st.target ? document.querySelector(st.target) : null;
        if (target) target.classList.add('tour-hi');
        box = h('div.tour', { role: 'dialog', 'aria-label': t.title },
          h('div.tour-k', t.title + ' · ' + (i + 1) + ' of ' + t.steps.length),
          h('div.tour-t', inline(st.text)),
          h('div.tour-b', i ? h('button.btn.small', { type: 'button', onclick: () => { i--; show(); } }, 'Back') : h('span'), h('button.btn.small.ghost', { type: 'button', onclick: close }, 'Close'), h('button.btn.small.primary', { type: 'button', onclick: () => { if (i + 1 < t.steps.length) { i++; show(); } else close(); } }, i + 1 < t.steps.length ? 'Next' : 'Finish')));
        document.body.appendChild(box);
        const r = target ? target.getBoundingClientRect() : { left: innerWidth / 2 - 160, bottom: innerHeight / 2 - 80, top: innerHeight / 2, right: innerWidth / 2 };
        const bw = box.offsetWidth, bh = box.offsetHeight;
        let x = Math.min(innerWidth - bw - 12, Math.max(12, r.left));
        let y = r.bottom + 10;
        if (y + bh > innerHeight - 12) y = Math.max(12, r.top - bh - 10);
        box.style.left = x + 'px'; box.style.top = y + 'px';
      };
      show();
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
