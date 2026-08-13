// The schedule workbench: the theory of chapters 17 and 18 with no database behind it. A schedule is a grid
// with a column per transaction and a row per operation; drag the operations to change the interleaving, or
// type it as text. The verdicts (serial, conflict and view serializable, recoverable, cascadeless, strict)
// follow every change, with the precedence graph. Then run the schedule under a protocol to see its waits and
// rollbacks, try random exercises, or bring in what really ran in the transactions view.
(function (root) {
  'use strict';
  const K = root.K;
  const UI = K.UI;
  const { h } = UI;

  const safe = (f, d) => { try { return f(); } catch (e) { return d; } };
  const PRESETS = [
    ['r1(X) w1(X) r2(X) r1(Y) w2(X) w1(Y) c1 r2(Y) w2(Y) c2', 'Concurrent, conflict serializable'],
    ['r2(Y) w2(Y) c2 r1(X) w1(X) r1(Y) c1', 'Serial: T2 then T1'],
    ['r1(X) r2(X) w1(X) w2(X) c1 c2', 'Lost update: not serializable'],
    ['w1(X) r2(Y) w2(X) w1(X) w3(X) c2 c1 c3', 'View serializable, not conflict serializable (blind writes)'],
    ['w1(Y) r2(Y) c2 a1', 'Not recoverable: T2 commits after reading from T1, which aborts'],
    ['w1(X) r2(X) w2(Z) r3(Z) a1 c2 c3', 'Cascading rollback'],
    ['w1(X) w1(Y) c1 r2(X) w2(Y) c2', 'Strict'],
    ['r1(X) r2(Y) w1(Y) w2(X) c1 c2', 'A deadlock under two-phase locking'],
    ['r1(X) w2(X) c2 w1(X) c1', 'An obsolete write (Thomas\' write rule)'],
  ];
  const SIMS = [['2pl', 'Basic 2PL'], ['strict2pl', 'Strict 2PL'], ['rigorous2pl', 'Rigorous 2PL'], ['to', 'Timestamp ordering'], ['thomas', 'TO + Thomas\' rule'], ['validation', 'Validation'], ['mvto', 'Multiversion TO']];
  const DL = [['detect', 'Deadlock detection'], ['wait-die', 'Wait-die'], ['wound-wait', 'Wound-wait']];
  const opText = (o) => (o.op === 'c' || o.op === 'a' ? o.op + o.tx : o.op + o.tx + '(' + o.item + ')');
  const WORD = { r: 'read', w: 'write', c: 'commit', a: 'abort', s: 'lock-S', x: 'lock-X', u: 'unlock' };

  function create(app, el) {
    const S = K.Schedule;
    const st = { text: UI.store.get('sched.text', PRESETS[0][0]), err: null, proto: UI.store.get('sched.proto', '2pl'), dl: 'detect', ex: null, legend: null };
    const Rec = UI.TxnRecorder;
    if (Rec) Rec.attach(app);
    const intro = h('div.kv-intro.tx-intro', { title: 'Show or hide the whole explanation', onclick: () => intro.classList.toggle('open') }, h('span.tx-it', h('b', 'Schedules. '), 'A schedule is the order in which the operations of concurrent transactions run. It is serializable when it is equivalent to some serial schedule: conflict serializable when its precedence graph has no cycle, view serializable when every read reads from the same write and the final writes agree. Drag operations to change the interleaving, or type the schedule, and the verdicts follow.'));
    const head = h('div.view-head.sw-head');
    const body = h('div.view-body.sw-body');
    el.appendChild(intro); el.appendChild(head); el.appendChild(body);

    const parse = () => { try { st.err = null; return S.parse(st.text); } catch (e) { st.err = e.message; return null; } };
    const setOps = (ops) => { st.text = ops.map(opText).join(' '); UI.store.set('sched.text', st.text); };
    const setText = (t, legend) => { st.text = t; st.legend = legend || null; UI.store.set('sched.text', t); };

    // ---- the real history ------------------------------------------------------------------------------------------------
    function replay() {
      const r = Rec ? Rec.schedule() : null;
      if (!r || !r.text.trim()) { UI.toast('Nothing to replay yet: run a scenario (or two transactions) in the Transactions view first.', 'warn', 5000); return; }
      // number the transactions 1, 2, ... in the order they appear
      const p = safe(() => S.parse(r.text), null);
      if (!p) { UI.toast('The recorded history could not be read as a schedule.', 'err'); return; }
      const map = new Map(p.txs.map((t, i) => [t, String(i + 1)]));
      const name = (t) => { const tx = Rec.tx.get(+t); return tx && tx.sid !== null ? Rec.name(tx.sid) : null; };
      setText(p.ops.map((o) => opText(Object.assign({}, o, { tx: map.get(o.tx) }))).join(' '), 'From ' + r.source + ': ' + p.txs.map((t) => 'T' + map.get(t) + ' = transaction ' + t + (name(t) ? ' (tab ' + name(t) + ')' : '')).join(', ') + '.');
      st.ex = null;
      view.render();
    }

    // ---- the grid, with drag and drop ------------------------------------------------------------------------------------------
    function drawGrid(s) {
      const txs = s.txs;
      const grid = h('div.sw-grid', { style: { gridTemplateColumns: '34px repeat(' + txs.length + ', minmax(84px, 1fr)) 30px' }, role: 'grid', 'aria-label': 'The schedule: a column per transaction' });
      grid.appendChild(h('div.sw-gh', ''));
      for (const t of txs) grid.appendChild(h('div.sw-gh', 'T' + t));
      grid.appendChild(h('div.sw-gh', ''));
      s.ops.forEach((o, i) => {
        grid.appendChild(h('div.sw-n', { dataset: { row: i } }, String(i + 1)));
        for (const t of txs) {
          if (t !== o.tx) { grid.appendChild(h('div.sw-cell', { dataset: { row: i } })); continue; }
          const chip = h('button.sw-op.' + o.op, { type: 'button', dataset: { i }, title: WORD[o.op] + (o.item ? '(' + o.item + ')' : '') + ' by T' + o.tx + '. Drag up or down to move it; arrow keys move it, Delete removes it.', 'aria-label': 'Operation ' + (i + 1) + ': ' + opText(o) }, opText(o));
          chip.addEventListener('pointerdown', (e) => startDrag(e, i, grid, s));
          chip.addEventListener('keydown', (e) => {
            const d = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
            if (d) { e.preventDefault(); move(s, i, i + d); focusOp(i + d); }
            if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); const ops = s.ops.slice(); ops.splice(i, 1); setOps(ops); view.render(); }
          });
          grid.appendChild(h('div.sw-cell', { dataset: { row: i } }, chip));
        }
        grid.appendChild(h('div.sw-cell.sw-x', { dataset: { row: i } }, h('button.icon-btn.sw-del', { type: 'button', title: 'Remove ' + opText(o), 'aria-label': 'Remove ' + opText(o), onclick: () => { const ops = s.ops.slice(); ops.splice(i, 1); setOps(ops); view.render(); } }, UI.icon('x'))));
      });
      return grid;
    }
    const focusOp = (i) => requestAnimationFrame(() => { const b = body.querySelector('.sw-op[data-i="' + i + '"]'); if (b) b.focus(); });
    function move(s, from, to) {
      to = Math.max(0, Math.min(s.ops.length - 1, to));
      if (to === from) return;
      const ops = s.ops.slice();
      const [o] = ops.splice(from, 1);
      ops.splice(to, 0, o);
      setOps(ops);
      view.render();
    }
    function startDrag(e, i, grid, s) {
      if (e.button !== undefined && e.button !== 0) return;
      const chip = e.currentTarget;
      const y0 = e.clientY;
      let target = i, moved = false;
      const rowsY = () => [...grid.querySelectorAll('.sw-n')].map((n) => { const r = n.getBoundingClientRect(); return (r.top + r.bottom) / 2; });
      const mids = rowsY();
      const mark = (t) => { grid.querySelectorAll('.drop-a, .drop-b').forEach((x) => x.classList.remove('drop-a', 'drop-b')); if (t === i) return; grid.querySelectorAll('[data-row="' + t + '"]').forEach((x) => x.classList.add(t > i ? 'drop-b' : 'drop-a')); };
      const onMove = (ev) => {
        if (!moved && Math.abs(ev.clientY - y0) < 4) return;
        moved = true;
        chip.classList.add('drag');
        chip.style.transform = 'translateY(' + (ev.clientY - y0) + 'px)';
        let t = 0;
        for (let k = 0; k < mids.length; k++) if (ev.clientY > mids[k]) t = k;
        if (ev.clientY < mids[0]) t = 0;
        target = t;
        mark(t);
      };
      const onUp = () => {
        removeEventListener('pointermove', onMove); removeEventListener('pointerup', onUp); removeEventListener('pointercancel', onUp);
        chip.classList.remove('drag'); chip.style.transform = '';
        mark(i);
        if (moved && target !== i) move(s, i, target);
      };
      addEventListener('pointermove', onMove); addEventListener('pointerup', onUp); addEventListener('pointercancel', onUp);
      e.preventDefault();
    }
    function addForm(s) {
      const txs = s ? s.txs : ['1'];
      const tx = h('select.inp', { 'aria-label': 'Transaction' }, txs.concat([String(Math.max(0, ...txs.map(Number).filter((n) => !isNaN(n))) + 1)]).map((t) => h('option', { value: t }, 'T' + t)));
      const op = h('select.inp', { 'aria-label': 'Operation' }, [['r', 'read'], ['w', 'write'], ['c', 'commit'], ['a', 'abort']].map(([v, l]) => h('option', { value: v }, l)));
      const item = h('input.inp.sw-item', { type: 'text', value: 'A', 'aria-label': 'Data item', size: 4 });
      const add = () => { const o = { tx: tx.value, op: op.value, item: item.value.trim() || 'A' }; if (o.op === 'c' || o.op === 'a') delete o.item; setOps((s ? s.ops : []).concat([o])); view.render(); };
      op.addEventListener('change', () => { item.disabled = op.value === 'c' || op.value === 'a'; });
      return h('div.sw-add', h('span.muted.kv-small', 'Add'), tx, op, item, UI.btn('plus', 'Add', 'Add the operation at the end', add, 'small'));
    }

    // ---- verdicts ---------------------------------------------------------------------------------------------------------------------
    const badge = (v, yes, no) => h('span.kv-badge.' + (v === null || v === undefined ? 'mute' : v ? 'ok' : 'no'), v === null || v === undefined ? 'not decided' : v ? yes || 'yes' : no || 'no');
    function verdicts(s, a) {
      const box = h('div.sw-verdicts');
      const card = (title, v, text, extra) => h('div.kv-card.sw-v' + (v === false ? '.bad' : v ? '.good' : ''), h('h3', badge(v), ' ', title), h('p.kv-small', text), extra || null);
      box.appendChild(card('Serial', a.serial, a.explanations.serial));
      // the precedence graph, a cycle in red, and the serial order
      const g = a.precedence;
      const cyc = a.cycle;
      const onCycle = (e) => { if (!cyc) return false; for (let i = 0; i + 1 < cyc.length; i++) if (cyc[i] === e.from && cyc[i + 1] === e.to) return true; return false; };
      const graph = g.nodes.length && UI.digraph ? UI.digraph(g.nodes.map((t) => ({ id: t, label: 'T' + t, cls: cyc && cyc.includes(t) ? 'bad' : '' })), g.edges.map((e) => ({ from: e.from, to: e.to, label: [...new Set(e.reasons.map((r) => r.item))].join(', '), cls: onCycle(e) ? 'bad' : 'n' })), { label: 'precedence graph' }) : h('p.muted.kv-small', 'No committed transactions to draw.');
      const order = a.conflictSerializable && a.order ? h('div.sw-order', 'Equivalent serial order: ', h('b', a.order.map((t) => 'T' + t).join(' → ')), h('code.sw-serial', S.serialOf(s, a.order))) : null;
      box.appendChild(card('Conflict serializable', a.conflictSerializable, a.explanations.conflict, h('div', h('h4', 'Precedence graph'), h('p.kv-small.muted', 'An edge Ti → Tj for each pair of conflicting operations (same item, at least one a write) with Ti\'s first. Only committed transactions count.'), graph, order)));
      box.appendChild(card('View serializable', a.viewSerializable, a.explanations.view));
      box.appendChild(card('Recoverable', a.recoverable, a.explanations.recoverable));
      box.appendChild(card('Cascadeless', a.cascadeless, a.explanations.cascadeless));
      box.appendChild(card('Strict', a.strict, a.explanations.strict));
      return box;
    }

    // ---- under a protocol ---------------------------------------------------------------------------------------------------------------
    function simulate(s) {
      const card = h('div.kv-card.sw-sim', h('h3', 'Run it under a protocol', h('span.muted', ' the schedule is the order the transactions ask for their operations; a transaction that must wait keeps its later operations')));
      const ctl = h('div.kv-row',
        h('select.inp', { 'aria-label': 'Protocol', onchange: (e) => { st.proto = e.target.value; UI.store.set('sched.proto', st.proto); view.render(); } }, SIMS.map(([k, l]) => h('option', { value: k, selected: k === st.proto }, l))),
        /2pl/.test(st.proto) ? h('select.inp', { 'aria-label': 'Deadlock handling', onchange: (e) => { st.dl = e.target.value; view.render(); } }, DL.map(([k, l]) => h('option', { value: k, selected: k === st.dl }, l))) : null);
      card.appendChild(ctl);
      let run;
      try { run = S.simulate(s, st.proto, { deadlock: st.dl }); } catch (e) { card.appendChild(h('div.res-err', e.message)); return card; }
      const steps = h('table.grid.small.sw-steps', h('thead', h('tr', h('th', '#'), h('th', 'T'), h('th', 'Action'), h('th', 'Operation'), h('th', 'Why'))),
        h('tbody', run.steps.map((x, i) => h('tr.' + x.action, h('td.num', String(i + 1)), h('td', 'T' + x.tx), h('td', h('span.sw-act.' + x.action, x.action)), h('td', h('code', x.op)), h('td.sw-why', x.why || '')))));
      card.appendChild(h('div.tx-scroll.sw-stepsbox', steps));
      const out = h('div.sw-out',
        h('div', h('b', 'What became of each: '), Object.entries(run.outcome).map(([t, o]) => h('span.sw-oc', 'T' + t + ' ', h('span.kv-badge.' + (o === 'committed' ? 'ok' : o === 'aborted' ? 'no' : 'warn'), o)))),
        run.deadlocks.length ? h('div', h('b', 'Deadlocks: '), run.deadlocks.map((d) => d.cycle.map((t) => 'T' + t).join(' → ') + ' → T' + d.cycle[0] + ' (victim T' + d.victim + ')').join('; ')) : null,
        run.ignored.length ? h('div', h('b', 'Ignored (Thomas\' write rule): '), run.ignored.join(', ')) : null,
        run.unrecoverable && run.unrecoverable.length ? h('div.sw-warn', 'Not recoverable: ' + run.unrecoverable.map((u) => 'T' + u.tx + ' committed after reading from T' + u.from + ', which aborted').join('; ')) : null,
        h('div', h('b', 'The schedule it produced: '), h('code.sw-serial', run.final || '(empty)')),
        /2pl/.test(st.proto) && run.withLocks ? h('div', h('b', 'With its lock operations: '), h('code.sw-serial', run.withLocks.replace(/\bs(\d+)\(/g, 'lock-S$1(').replace(/\bx(\d+)\(/g, 'lock-X$1(').replace(/\bu(\d+)\(/g, 'unlock$1('))) : null,
        h('div.kv-small', run.serializable.explanation),
        h('div.kv-row', UI.btn('format', 'Use the produced schedule', 'Put the schedule the protocol produced in the workbench', () => { setText(run.final); view.render(); }, 'small')));
      card.appendChild(out);
      return card;
    }

    // ---- exercises ----------------------------------------------------------------------------------------------------------------------
    const QS = [['conflictSerializable', 'Conflict serializable?'], ['viewSerializable', 'View serializable?'], ['recoverable', 'Recoverable?'], ['cascadeless', 'Cascadeless?'], ['strict', 'Strict?']];
    function newExercise(n) {
      const ex = S.exercise({ txs: n || 3, seed: Math.floor(Math.random() * 1e9) });
      st.ex = { ex, n: n || 3, ans: {}, order: '', checked: false };
      setText(ex.schedule);
      view.render();
    }
    function orderOk(a, text) {
      const order = (text.match(/\d+/g) || []);
      const g = a.precedence;
      if (order.length !== g.nodes.length || !g.nodes.every((t) => order.includes(t))) return false;
      return g.edges.every((e) => order.indexOf(e.from) < order.indexOf(e.to));
    }
    function exercisePanel(a) {
      const x = st.ex;
      const card = h('div.kv-card.sw-ex', h('h3', 'Exercise', h('span.muted', ' ' + x.n + ' transactions, a random schedule')));
      for (const [k, q] of QS) {
        const right = a[k];
        const mine = x.ans[k];
        card.appendChild(h('div.sw-q', h('span.sw-ql', q),
          h('div.seg', [[true, 'Yes'], [false, 'No']].map(([v, l]) => h('button' + (mine === v ? '.on' : ''), { type: 'button', dataset: { q: k, v: String(v) }, onclick: () => { x.ans[k] = v; x.checked = false; view.render(); } }, l))),
          x.checked ? (right === null ? h('span.kv-badge.mute', 'too large to decide') : mine === undefined ? h('span.kv-badge.mute', 'not answered') : h('span.kv-badge.' + (mine === right ? 'ok' : 'no'), mine === right ? 'right' : 'wrong')) : null));
      }
      const ord = h('input.inp.sw-ord', { type: 'text', value: x.order, placeholder: 'e.g. T2, T1, T3', 'aria-label': 'An equivalent serial order', oninput: (e) => { x.order = e.target.value; } });
      card.appendChild(h('div.sw-q', h('span.sw-ql', 'If conflict serializable, an equivalent serial order:'), ord,
        x.checked && a.conflictSerializable ? h('span.kv-badge.' + (orderOk(a, x.order) ? 'ok' : 'no'), orderOk(a, x.order) ? 'right' : 'wrong (one answer: ' + a.order.map((t) => 'T' + t).join(', ') + ')') : null));
      const score = QS.filter(([k]) => a[k] !== null && x.ans[k] === a[k]).length;
      card.appendChild(h('div.kv-row', UI.btn('check', 'Check', 'Check the answers', () => { x.checked = true; view.render(); }, 'primary small sw-check'), UI.btn('refresh', 'Another one', null, () => newExercise(x.n), 'small'), UI.btn('x', 'Done', 'Leave the exercise', () => { st.ex = null; view.render(); }, 'small ghost'),
        x.checked ? h('b.sw-score', score + ' of ' + QS.filter(([k]) => a[k] !== null).length + ' right') : null));
      return card;
    }

    // ---- the whole view -------------------------------------------------------------------------------------------------------------------
    function drawHead() {
      head.innerHTML = '';
      head.appendChild(h('select.inp.sw-preset', { 'aria-label': 'Example schedules', onchange: (e) => { if (e.target.value) { setText(e.target.value); st.ex = null; view.render(); } } }, [h('option', { value: '' }, 'Examples…')].concat(PRESETS.map(([t, l]) => h('option', { value: t }, l)))));
      head.appendChild(UI.btn('flask', 'Exercise', 'A random schedule to classify', (e) => UI.menu(e.currentTarget, [2, 3, 4].map((n) => ({ label: n + ' transactions', onclick: () => newExercise(n) }))), 'small'));
      head.appendChild(UI.btn('history', 'Replay the real history', 'Turn what ran in the transactions view into a schedule', replay, 'small'));
    }
    const view = {
      render() {
        const y = body.scrollTop;
        drawHead();
        body.innerHTML = '';
        const input = h('input.inp.sw-text', { type: 'text', value: st.text, spellcheck: 'false', 'aria-label': 'The schedule as text', placeholder: 'r1(A) w1(A) r2(A) w2(A) c1 c2' });
        input.addEventListener('input', UI.debounce(() => { setText(input.value, st.legend); const pos = input.selectionStart; view.render(); const i2 = body.querySelector('.sw-text'); if (i2) { i2.focus(); i2.setSelectionRange(pos, pos); } }, 350));
        body.appendChild(h('div.sw-textrow', input));
        const s = parse();
        if (st.err) body.appendChild(h('div.res-err.sw-err', st.err));
        if (st.legend) body.appendChild(h('p.kv-small.muted.sw-legend', st.legend));
        if (!s || !s.ops.length) { body.appendChild(h('div.empty', 'Type a schedule such as r1(A) w2(A) c1 c2, or pick an example.')); body.appendChild(addForm(s)); return; }
        const a = safe(() => S.classify(s), null);
        body.appendChild(h('div.kv-card.sw-gridcard', h('h3', 'The schedule', h('span.muted', ' ' + UI.plural(s.ops.length, 'operation') + ' · drag an operation up or down to reorder')), h('div.tx-scroll', drawGrid(s)), addForm(s)));
        if (st.ex && a) body.appendChild(exercisePanel(a));
        if (a && (!st.ex || st.ex.checked)) body.appendChild(verdicts(s, a));
        else if (st.ex) body.appendChild(h('p.muted.kv-small.sw-hidden', 'The verdicts appear when you check your answers.'));
        body.appendChild(simulate(s));
        body.scrollTop = y;
      },
      onSelect(x) {
        if (!x) return;
        if (x.replay) setTimeout(replay, 0);
        if (x.schedule) { setText(x.schedule); st.ex = null; }
      },
      destroy() { if (Rec) Rec.detach(); },
      state: st,
    };
    return view;
  }

  UI.registerView({ id: 'schedule', title: 'Schedules', icon: 'tasks', group: 'Transactions', order: 41, create });
})(typeof window !== 'undefined' ? window : globalThis);
