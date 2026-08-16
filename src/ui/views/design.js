// The design theory workbench (chapter 7): a relation schema with functional and multivalued dependencies, typed
// in, taken from a preset, or found in the rows of a table; then attribute closure, Armstrong proofs, candidate
// keys, the canonical cover, the normal forms with the dependencies that violate them, BCNF decomposition and 3NF
// synthesis, the lossless-join tests (with the chase tableau played step by step), dependency preservation, and
// scripts that make the update, insertion and deletion anomalies happen in the database.
(function (root) {
  'use strict';
  const K = root.K;
  const UI = K.UI;
  const { h } = UI;
  const N = K.Normal;
  const T = UI.Theory;

  const PRESETS = [
    { id: 'showings', title: 'Showings (not in 3NF)', schema: 'showing(perf_id, prod_id, title, venue_code, stage_no, seats)', deps: 'perf_id → prod_id, venue_code, stage_no\nprod_id → title\nvenue_code, stage_no → seats' },
    { id: 'loans', title: 'Library loans (not in 3NF)', schema: 'loan(copy_id, isbn, title, member_id, member_name, due)', deps: 'copy_id → isbn, member_id, due\nisbn → title\nmember_id → member_name' },
    { id: 'castlist', title: 'Cast list (not in 2NF)', schema: 'cast_list(person_id, prod_id, billed_as, title, role_name)', deps: 'person_id → billed_as\nprod_id → title\nperson_id, prod_id → role_name' },
    { id: 'coaching', title: 'Coaching (3NF but not BCNF)', schema: 'coaching(artist, skill, coach)', deps: 'artist, skill → coach\ncoach → skill' },
    { id: 'flights', title: 'Flights (a chain of dependencies)', schema: 'flight(flight_no, day, pilot, plane, model, seats)', deps: 'flight_no, day → pilot, plane\nplane → model\nmodel → seats' },
    { id: 'touring', title: 'Touring (BCNF but not 4NF)', schema: 'tour(company, city, production)', deps: 'company ↠ city' },
    { id: 'letters', title: 'Letters: R(A, B, C, D, E, F)', schema: 'R(A, B, C, D, E, F)', deps: 'BC → D\nD → E\nE → CF\nA → B' },
  ];
  const TABS = [['closure', 'Closure'], ['proof', 'Armstrong proof'], ['keys', 'Keys'], ['cover', 'Canonical cover'], ['nf', 'Normal forms'], ['decomp', 'Decomposition'], ['lossless', 'Lossless join'], ['pres', 'Dependency preservation'], ['anom', 'Anomalies']];
  const INTRO = {
    closure: ['Attribute closure.', 'The closure X+ of a set of attributes X is every attribute that X determines under F. Start with X and keep adding the right side of any dependency whose left side is already inside; X is a superkey exactly when X+ is the whole schema.'],
    proof: ['Armstrong\'s axioms.', 'Reflexivity, augmentation and transitivity derive every dependency implied by F and nothing else (they are sound and complete); union and decomposition follow from them. A proof lists dependencies, each given or obtained from earlier lines by one rule.'],
    keys: ['Candidate keys.', 'A superkey determines every attribute; a candidate key is a minimal superkey. An attribute on no right side must be in every key and one only on right sides is in none, which narrows the search. Attributes in some candidate key are called prime.'],
    cover: ['Canonical cover.', 'A canonical cover Fc is equivalent to F (it has the same closure) but has no extraneous attributes on either side and each left side only once. Checking dependencies against Fc is cheaper, and 3NF synthesis starts from it.'],
    nf: ['Normal forms.', 'A schema is in BCNF when the left side of every nontrivial dependency is a superkey, and in 3NF when every such dependency has a superkey on the left or only prime attributes on the right. 2NF forbids nonprime attributes depending on part of a key; 4NF extends BCNF to multivalued dependencies.'],
    decomp: ['Decomposition.', 'BCNF decomposition repeatedly splits a schema on a dependency that violates BCNF; the result is lossless but may lose dependencies. 3NF synthesis builds one schema per dependency of the canonical cover, plus a key: lossless and dependency preserving.'],
    lossless: ['Lossless-join decomposition.', 'A decomposition is lossless when joining the projections always gives back exactly the original relation. For two schemas it is enough that R1 ∩ R2 is a superkey of R1 or of R2; for any number, the chase applies the dependencies to a tableau until a row of distinguished values a appears, or nothing changes.'],
    pres: ['Dependency preservation.', 'A decomposition preserves the dependencies when every dependency of F can be checked within the separate schemas, without a join. The test grows a result from the left side of each dependency using closures restricted to each schema in turn.'],
    anom: ['Anomalies.', 'Redundancy in a schema that is not in BCNF causes anomalies: an update that changes one copy of a fact and not the others, an insertion that cannot record a fact without an unrelated key, and a deletion that loses a fact along with the last row that held it. Run the scripts to watch them happen.'],
  };
  // the tab that would give an exercise's answer away
  const GUARD = { closure: 'closure', keys: 'keys', cover: 'cover', normalForm: 'nf', bcnf: 'decomp', '3nf': 'decomp', lossless: 'lossless', preservation: 'pres' };

  const KEY = 'des.';
  const store = { get: (k, d) => UI.store.get(KEY + k, d), set: (k, v) => UI.store.set(KEY + k, v) };
  const plural = (n, w, ws) => n + ' ' + (n === 1 ? w : ws || w + 's');
  const colorDeps = (text) => {
    const out = [];
    const re = /->>|->|=>|[→↠]|[;,]/g;
    let m;
    while ((m = re.exec(text))) out.push({ a: m.index, b: m.index + m[0].length, cls: /[;,]/.test(m[0]) ? 'th-br' : 'th-sym' });
    return out;
  };
  /** '(A, B), (B, C)' or one schema per line -> lists of attribute names */
  function parseDecomp(P, text) {
    const parts = [];
    const re = /\(([^)]*)\)/g;
    let m;
    if (/\(/.test(text)) while ((m = re.exec(text))) parts.push(m[1]);
    else for (const line of text.split(/[\n;]+/)) if (line.trim()) parts.push(line);
    if (!parts.length) throw new Error('write the schemas as (A, B), (B, C)');
    return parts.map((x) => { const ms = N.mask(P, x); if (!ms) throw new Error('a schema of the decomposition is empty'); return N.names(P, ms); });
  }
  const schemaText = (attrs) => '(' + attrs.join(', ') + ')';

  function create(app, el) {
    const preset = PRESETS[0];
    const st = {
      tab: store.get('tab', 'closure'), schema: store.get('schema', preset.schema), deps: store.get('deps', preset.deps),
      X: store.get('X', ''), pX: store.get('pX', ''), pY: store.get('pY', ''), basic: false,
      dmode: 'bcnf', dAt: null, chaseText: store.get('chase', ''), chaseAt: null, presText: store.get('pres', ''), closeAt: null, coverAt: null,
      exercise: null, verdict: null, reveal: {}, disc: null, source: store.get('source', null), folded: store.get('folded', innerWidth < 600),
    };
    if (!TABS.some((t) => t[0] === st.tab)) st.tab = 'closure';
    let P = null, perr = null, deps = [];
    let play = null;
    const intro = h('p.th-intro');
    const exBox = h('div.th-ex');
    const inputs = h('div.th-inputs');
    const tabs = h('div.th-tabs.de-tabs', { role: 'tablist' });
    const body = h('div.de-tabbody');
    const scroller = h('div.th-body', inputs, tabs, body);
    el.appendChild(h('div.th-view', intro, exBox, scroller));

    // ---- the schema and its dependencies
    const schemaIn = h('input.inp.th-mono.de-schema', { type: 'text', value: st.schema, spellcheck: 'false', 'aria-label': 'Relation schema', placeholder: 'R(A, B, C, D)', oninput: (e) => { st.schema = e.target.value; changed(); } });
    const depsEd = T.editor({ value: st.deps, minRows: 3, label: 'Dependencies', placeholder: 'A → B\nB, C → D\nA ↠ C', colorize: colorDeps, onInput: (v) => { st.deps = v; changed(); } });
    const chips = h('div.de-chips');
    const schemaErr = h('div'), depsErr = h('div');
    const discBox = h('div');
    const changed = UI.debounce(() => { store.set('schema', st.schema); store.set('deps', st.deps); st.dAt = st.chaseAt = st.closeAt = st.coverAt = null; st.source = null; store.set('source', null); parse(); renderAll(); }, 250);
    const setProblem = (schema, depsText, source) => { st.schema = schema; st.deps = depsText; schemaIn.value = schema; depsEd.set(depsText); store.set('schema', schema); store.set('deps', depsText); st.source = source || null; store.set('source', st.source); st.dAt = st.chaseAt = st.closeAt = st.coverAt = null; st.X = ''; st.pX = st.pY = ''; st.chaseText = st.presText = ''; parse(); };
    const presetBtn = T.button('book', 'Presets', 'Classic schemas to explore', (e) => UI.menu(e.currentTarget, PRESETS.map((p) => ({ label: p.title, onclick: () => { setProblem(p.schema, p.deps); st.disc = null; renderAll(); } }))), 'ghost');
    const discBtn = T.button('table', 'From a table', 'Find the dependencies that hold in the rows of a table of the database', () => { st.disc = st.disc ? null : { table: null, res: null, chosen: null }; renderAll(); }, 'ghost');
    // the inputs fold into one line (the schema and the dependency chips) to leave room for the tabs
    const foldBtn = T.button(null, 'Fold', 'Fold the schema and dependencies into one line, or open them for editing', () => { st.folded = !st.folded; store.set('folded', st.folded); renderAll(); }, 'ghost');
    const summary = h('code.de-sum');
    const edit = h('div.th-inputs',
      schemaIn, schemaErr,
      h('div.th-row', h('span.th-label', 'Dependencies'), h('span.th-note', 'one per line: → (->) functional, ↠ (->>) multivalued'), h('span.grow'), T.palette([{ k: '→', ins: ' → ', title: 'functional dependency (->)' }, { k: '↠', ins: ' ↠ ', title: 'multivalued dependency (->>)' }], (k) => depsEd.insert(k.ins))),
      depsEd.el, depsErr);
    inputs.appendChild(h('div.th-row', h('span.th-label', 'Schema'), summary, h('span.grow'), presetBtn, discBtn, foldBtn));
    inputs.appendChild(edit);
    inputs.appendChild(chips);
    inputs.appendChild(discBox);
    const drawFold = () => {
      edit.hidden = !!st.folded;
      summary.hidden = !st.folded;
      summary.textContent = st.schema;
      foldBtn.lastChild.textContent = st.folded ? 'Edit' : 'Fold';
      if (st.folded && perr) { edit.hidden = false; summary.hidden = true; }
    };

    function parse() {
      P = null; perr = null; deps = [];
      schemaErr.innerHTML = ''; depsErr.innerHTML = '';
      let sch;
      try { sch = N.parseSchema(st.schema); } catch (e) { perr = e; schemaErr.appendChild(T.msg('err', h('b', 'Schema: '), e.message)); return; }
      try { deps = N.parseDeps(st.deps, sch); depsEd.mark(null); } catch (e) { perr = e; depsErr.appendChild(T.msg('err', h('b', 'Dependencies: '), e.message)); if (e.pos !== undefined) depsEd.mark(e.pos, T.tokenEnd(st.deps, e.pos)); return; }
      try { P = N.problem(sch, deps.map((d) => ({ lhs: d.lhs, rhs: d.rhs, mvd: d.mvd, text: d.text }))); } catch (e) { perr = e; depsErr.appendChild(T.msg('err', e.message)); }
    }
    const fmtSet = (attrs) => (P && P.letters ? attrs.join('') : attrs.join(', ')) || '∅';
    const fdOf = (d) => fmtSet(d.lhs) + (d.mvd ? ' ↠ ' : ' → ') + fmtSet(d.rhs);
    function drawChips(hi) {
      chips.innerHTML = '';
      if (!P) return;
      const m = (x) => N.mask(P, x);
      for (const d of deps) {
        const l = m(d.lhs), r = m(d.rhs);
        const flag = hi.find((x) => x.l === l && (x.r & r) && !!x.mvd === !!d.mvd);
        chips.appendChild(h('span.de-chip' + (d.mvd ? '.mvd' : '') + (flag ? '.' + flag.kind : ''), { title: flag ? flag.why : '' }, fdOf(d)));
      }
      if (!deps.length) chips.appendChild(h('span.th-note', 'No dependencies yet: the only key is the whole schema.'));
    }

    // ---- discovering dependencies in the rows of a table
    function renderDisc() {
      discBox.innerHTML = '';
      if (!st.disc) return;
      const cat = app.session.catalog;
      let rels = [];
      try { rels = cat.tables(['table', 'view', 'matview']).filter((r) => !cat.schema(r.schema).system).map((r) => r.name).sort(); } catch (e) { rels = []; }
      const d = st.disc;
      const sel = h('select.inp', { 'aria-label': 'Table', onchange: (e) => { d.table = e.target.value; d.res = null; } }, h('option', { value: '' }, 'Choose a table'), rels.map((n) => h('option', { value: n, selected: d.table === n }, n)));
      const box = h('div.th-sec.de-disc', h('h3', 'Dependencies found in a table', h('span.muted', 'what holds in these rows, as hypotheses')),
        h('div.th-row', sel, T.button('search', 'Find them', 'Test every X → A with up to three attributes in X against the rows', () => discover(), 'primary'), h('span.grow'), T.button('x', null, 'Close', () => { st.disc = null; renderAll(); }, 'icon')));
      if (d.err) box.appendChild(T.msg('err', d.err));
      if (d.res) {
        const r = d.res;
        box.appendChild(h('p.th-note', 'In the ' + plural(r.rows.length, 'row') + ' of ' + d.table + ', these minimal dependencies hold. A dependency that holds in one instance may still fail in another: only the meaning of the data decides, so keep the ones that are true of every possible ' + d.table + '.'));
        const list = h('div.de-hyp');
        // one line per left side: X → A, B, C
        const groups = new Map();
        r.holds.forEach((x, i) => { const k = x.lhs.join(', '); if (!groups.has(k)) groups.set(k, { lhs: x.lhs, items: [] }); groups.get(k).items.push(i); });
        for (const g of groups.values()) {
          const xs = g.items.map((i) => r.holds[i]);
          const rhs = xs.map((x) => x.rhs[0]);
          const on = g.items.every((i) => d.chosen.has(i));
          const cb = h('input', { type: 'checkbox', checked: on, 'aria-label': 'Use ' + (g.lhs.join(', ') || '∅') + ' → ' + rhs.join(', '), onchange: (e) => { for (const i of g.items) { if (e.target.checked) d.chosen.add(i); else d.chosen.delete(i); } } });
          const sup = xs.find((x) => !x.vacuous);
          const lhsT = g.lhs.join(', ') || '∅';
          const ev = !sup ? h('span.th-note', 'no two rows agree on ' + lhsT + ' (a key of these rows), so nothing contradicts it') : h('details', h('summary', 'rows that agree on ' + lhsT + ' also agree on ' + rhs.join(', ') + ': for example'), pairTable(r, sup.support.slice(0, 2), g.lhs, rhs));
          list.appendChild(h('label.de-hyp-i', cb, h('span.de-hyp-t', h('code', lhsT + ' → ' + rhs.join(', ')), xs[0].key ? h('span.de-tag', 'unique in these rows') : null), ev));
        }
        box.appendChild(list);
        if (r.fails.length) {
          const near = r.fails.filter((f) => f.lhs.length >= 1).slice(0, 6);
          if (near.length) box.appendChild(h('details.de-fails', h('summary', 'Dependencies that fail, with the two rows that break them'), near.map((f) => h('div.de-fail', h('code', (f.lhs.join(', ') || '∅') + ' → ' + f.rhs[0]), ' fails: ', pairTable(r, [f.violation], f.lhs, f.rhs, true)))));
        }
        box.appendChild(h('div.th-row', T.button('check', 'Use the checked dependencies', 'Make ' + d.table + ' the schema and the checked dependencies its F', () => {
          const chosen = [...d.chosen].map((i) => r.holds[i]);
          const byL = new Map();
          for (const x of chosen) { const k = x.lhs.join(', '); if (!byL.has(k)) byL.set(k, []); byL.get(k).push(x.rhs[0]); }
          const text = [...byL].map(([l, rs]) => (l || '∅') + ' → ' + rs.join(', ')).filter((x) => !x.startsWith('∅')).join('\n');
          setProblem(d.table + '(' + r.cols.join(', ') + ')', text, { table: d.table });
          st.disc = null;
          renderAll();
        }, 'primary')));
      }
      discBox.appendChild(box);
    }
    function discover() {
      const d = st.disc;
      d.err = null; d.res = null;
      if (!d.table) { d.err = 'Choose a table first.'; renderAll(); return; }
      try {
        const rel = K.Algebra.source(app.session)(d.table);
        const res = N.discover({ cols: rel.attrs, rows: rel.rows }, { maxLhs: 2 });
        d.res = res;
        // a dependency with an empty left side says the column is constant: rarely meant, so not checked
        // checked to begin with: what follows from the first key of the instance, and what some rows support;
        // a dependency with an empty left side says the column is constant, rarely what the design means
        const key0 = res.keys[0] ? res.keys[0].join() : null;
        d.chosen = new Set(res.holds.map((x, i) => (x.lhs.length && (!x.vacuous || x.lhs.join() === key0) ? i : -1)).filter((i) => i >= 0));
      } catch (e) { d.err = e.message; }
      renderAll();
    }
    function pairTable(r, pairs, lhs, rhs, bad) {
      const cols = r.cols;
      const rows = [];
      for (const [i, j] of pairs) rows.push(i, j);
      const tbl = h('table.grid.small.de-pair', h('thead', h('tr', h('th', 'row'), cols.map((c) => h('th' + (lhs.includes(c) ? '.de-l' : rhs.includes(c) ? (bad ? '.de-bad' : '.de-r') : ''), c)))),
        h('tbody', rows.map((i) => h('tr', h('td.rn', String(i + 1)), r.rows[i].map((v, k) => h('td' + (lhs.includes(cols[k]) ? '.de-l' : rhs.includes(cols[k]) ? (bad ? '.de-bad' : '.de-r') : ''), v === null ? 'null' : String(v)))))));
      return h('div.th-tbl', tbl);
    }

    // ---- the tabs
    const attrChips = (all, inSet, newSet) => h('div.de-attrs', all.map((a) => h('span.de-attr' + (newSet && newSet.includes(a) ? '.new' : inSet.includes(a) ? '.in' : ''), a)));
    const attrInput = (value, label, oninput, placeholder) => h('input.inp.th-mono', { type: 'text', value, 'aria-label': label, placeholder: placeholder || '', spellcheck: 'false', oninput });
    const hi = [];      // dependencies to mark in the chips: { l, r, mvd, kind, why }
    const mark = (lhs, rhs, kind, why, mvd) => { try { hi.push({ l: N.mask(P, lhs), r: N.mask(P, rhs), kind, why, mvd }); } catch (e) { /* not on the schema */ } };
    const later = UI.debounce(() => renderAll(), 300);

    function tabClosure() {
      const def = deps.length ? deps[0].lhs.join(P.letters ? '' : ', ') : P.attrs[0];
      const X = st.X || def;
      body.appendChild(h('div.th-row', h('span.th-label', 'Closure of'), attrInput(X, 'Attributes X', (e) => { st.X = e.target.value; store.set('X', st.X); st.closeAt = null; later(); }, P.letters ? 'AB' : 'a, b')));
      let r;
      try { r = N.closure(P, undefined, X); } catch (e) { body.appendChild(T.msg('err', e.message)); return; }
      const n = r.steps.length;
      if (st.closeAt === null || st.closeAt > n) st.closeAt = n;
      const at = st.closeAt;
      const x0 = N.names(P, N.mask(P, X));
      const cur = at ? r.steps[at - 1].result : x0;
      body.appendChild(T.stepper(n, at, (k) => (k === 0 ? [h('b', 'Start'), ': result := ' + fmtSet(x0)] : [h('b', 'Step ' + k + ' of ' + n), ': using ' + r.steps[k - 1].fd.text]), (k) => { st.closeAt = k; renderAll(); }));
      body.appendChild(attrChips(P.attrs, cur, at ? r.steps[at - 1].added : null));
      const list = h('ol.de-steps', h('li.de-start', 'result := ', h('code', fmtSet(x0))));
      r.steps.slice(0, at).forEach((s, i) => list.appendChild(h('li' + (i === at - 1 ? '.cur' : ''), 'using ', h('code.de-fd', s.fd.text), ': ', fmtSet(s.fd.lhs), ' ⊆ result, so add ', h('b', s.added.join(', ')), ' → result = ', h('code', fmtSet(s.result)))));
      body.appendChild(h('div.th-sec', list));
      if (at) mark(r.steps[at - 1].fd.lhs, r.steps[at - 1].fd.rhs, 'use', 'used in this step');
      if (at === n) body.appendChild(T.msg(r.superkey ? 'ok' : 'info', 'No dependency adds anything more, so (' + fmtSet(x0) + ')+ = ', h('b', fmtSet(r.attrs)), '. ', r.superkey ? fmtSet(x0) + ' is a superkey of ' + (P.name || 'R') + '.' : fmtSet(x0) + ' is not a superkey: it does not determine ' + fmtSet(P.attrs.filter((a) => !r.attrs.includes(a))) + '.'));
    }

    function tabProof() {
      const X = st.pX || (deps[0] ? deps[0].lhs.join(P.letters ? '' : ', ') : P.attrs[0]);
      let Y = st.pY;
      if (!Y) { try { const c = N.closure(P, undefined, X).attrs; const x = N.names(P, N.mask(P, X)); const extra = c.filter((a) => !x.includes(a)); Y = (extra.slice(-1)[0] || c[0]); } catch (e) { Y = P.attrs[0]; } }
      body.appendChild(h('div.th-row', h('span.th-label', 'Prove'), attrInput(X, 'Left side X', (e) => { st.pX = e.target.value; later(); }), h('span', '→'), attrInput(Y, 'Right side Y', (e) => { st.pY = e.target.value; later(); }),
        h('label.de-check', h('input', { type: 'checkbox', checked: st.basic, onchange: (e) => { st.basic = e.target.checked; renderAll(); } }), 'only the three axioms')));
      let r;
      try { r = N.derive(P, undefined, X, Y, { basic: st.basic }); } catch (e) { body.appendChild(T.msg('err', e.message)); return; }
      if (!r.follows) { body.appendChild(T.msg('warn', r.text)); return; }
      const RULE = { given: 'given', reflexivity: 'reflexivity', augmentation: 'augmentation', transitivity: 'transitivity', union: 'union', decomposition: 'decomposition' };
      body.appendChild(h('div.th-sec', h('h3', 'Proof of ', h('code', fmtSet(N.names(P, N.mask(P, X))) + ' → ' + fmtSet(N.names(P, N.mask(P, Y))))),
        h('table.grid.small.de-proof', h('thead', h('tr', h('th', '#'), h('th', 'dependency'), h('th', 'by'), h('th', 'from'))),
          h('tbody', r.steps.map((s) => h('tr', h('td.rn', s.n + '.'), h('td', s.fd), h('td', h('span.de-rule.' + s.rule, RULE[s.rule] || s.rule), s.note ? h('span.th-note', ' ' + s.note) : null), h('td', s.from.length ? (s.from.length === 1 ? 'line ' : 'lines ') + s.from.join(', ') : '')))))));
      body.appendChild(h('p.th-note', 'Reflexivity: if Y ⊆ X then X → Y. Augmentation: if X → Y then XZ → YZ. Transitivity: if X → Y and Y → Z then X → Z. Union and decomposition are derived from these' + (st.basic ? '; here they are spelled out with the three axioms.' : '; tick the box to see them replaced by the axioms.')));
    }

    function tabKeys() {
      const r = N.keys(P), pr = N.primeAttrs(P);
      body.appendChild(h('div.th-sec', h('h3', 'Candidate keys of ' + (P.name || 'R')), h('div.de-keys', r.keys.map((k) => h('span.de-key', '{' + fmtSet(k) + '}'))),
        h('p.th-note', 'Prime attributes: ', h('b', fmtSet(pr.prime)), '; nonprime: ', h('b', fmtSet(pr.nonprime)), '.')));
      body.appendChild(h('div.th-sec', h('h3', 'How the search went'),
        h('ul.th-hist', h('li', 'On no right side, so in every key: ', h('b', fmtSet(r.mustHave))), h('li', 'Only on right sides, so in no key: ', h('b', fmtSet(r.never)))),
        h('table.grid.small', h('thead', h('tr', h('th', 'key size'), h('th.num', 'sets tested'), h('th', 'keys found'))), h('tbody', r.steps.map((s) => h('tr', h('td', String(s.size)), h('td.num', String(s.tested)), h('td', s.found.length ? s.found.map((k) => '{' + fmtSet(k) + '}').join(', ') : '—'))))),
        h('p.th-note', 'Sets of each size are tested by their closure; supersets of a key already found are skipped, since they are not minimal.')));
    }

    function tabCover() {
      if (!P.fds.length) { body.appendChild(h('div.empty', 'There are no functional dependencies to cover.')); return; }
      const r = N.canonicalCover(P);
      const n = r.steps.length;
      if (st.coverAt === null || st.coverAt > n) st.coverAt = n;
      const at = st.coverAt;
      const LABEL = { union: 'union rule', lhs: 'extraneous on the left', rhs: 'extraneous on the right' };
      body.appendChild(T.stepper(n, at, (k) => (k === 0 ? [h('b', 'Start'), ' from F as given'] : [h('b', 'Step ' + k + ' of ' + n), ': ' + LABEL[r.steps[k - 1].action]]), (k) => { st.coverAt = k; renderAll(); }));
      const list = h('ol.de-steps');
      r.steps.slice(0, at).forEach((s, i) => list.appendChild(h('li' + (i === at - 1 ? '.cur' : ''), h('span.de-rule.' + s.action, LABEL[s.action]), ' ', s.text, s.into ? [' ⇒ ', h('code', s.into)] : s.action === 'rhs' ? ' ⇒ the dependency goes' : null)));
      body.appendChild(h('div.th-sec', h('h3', 'Removing what is extraneous'), !n ? h('p.th-note', 'Nothing is extraneous and no two dependencies have the same left side: F is already a canonical cover.') : at ? list : h('p.th-note', 'Step forward: each step combines two dependencies with the same left side, or removes an attribute whose removal leaves the closure unchanged.')));
      if (at && r.steps[at - 1].fd) { const f = parseFd(r.steps[at - 1].fd); if (f) mark(f[0], f[1], 'use', 'the dependency this step changes'); }
      if (at === n) body.appendChild(h('div.th-sec', h('h3', 'Canonical cover Fc'), h('div.de-keys', r.fds.map((f) => h('span.de-key', f.text))), h('p.th-note', 'Fc has the same closure as F: each dependency of F follows from Fc and the other way round.')));
    }
    const parseFd = (text) => { const m = /^(.*?)\s*[→↠]\s*(.*)$/.exec(text); return m ? [m[1] === '∅' ? [] : m[1], m[2]] : null; };

    function tabNF() {
      const r = N.normalForm(P);
      const order = ['1NF', '2NF', '3NF', 'BCNF'].concat(r.tests['4NF'] ? ['4NF'] : []);
      const DEF = {
        '1NF': 'every attribute\'s domain is atomic',
        '2NF': 'no nonprime attribute depends on a proper part of a candidate key',
        '3NF': 'for every nontrivial X → A: X is a superkey or A is prime',
        'BCNF': 'for every nontrivial X → Y: X is a superkey',
        '4NF': 'for every nontrivial X ↠ Y: X is a superkey',
      };
      body.appendChild(T.msg(r.nf === order[order.length - 1] ? 'ok' : 'info', h('b', (P.name || 'R') + ' is in ' + (r.nf || 'no normal form') + '. '), r.nf === order[order.length - 1] ? 'It satisfies every normal form tested here.' : 'It is not in ' + order[order.indexOf(r.nf) + 1] + '.', ' Candidate keys: ' + r.keys.map((k) => '{' + fmtSet(k) + '}').join(', ') + '.'));
      const grid = h('div.de-nf');
      let failedYet = false;
      for (const k of order) {
        const t = r.tests[k];
        const first = !t.ok && !failedYet;
        if (!t.ok) failedYet = true;
        const card = h('div.de-nfc' + (t.ok ? '.ok' : '.bad') + (first ? '.first' : ''), h('div.de-nfh', h('b', k), h('span.de-verdict', t.ok ? 'yes' : 'no')), h('div.th-note', DEF[k]));
        if (t.note) card.appendChild(h('div.th-note', t.note));
        if (t.violations.length) card.appendChild(h('ul.de-viol', t.violations.slice(0, 6).map((v) => h('li', h('code.de-fd.bad', v.text), ' ', v.reason, v.given ? '' : ' (implied by F)'))));
        if (t.violations.length > 6) card.appendChild(h('div.th-note', '… and ' + (t.violations.length - 6) + ' more'));
        grid.appendChild(card);
        if (first) for (const v of t.violations) mark(v.lhs, v.rhs, 'bad', 'violates ' + k + ': ' + v.reason, k === '4NF');
      }
      body.appendChild(grid);
      body.appendChild(h('p.th-note', 'The dependencies that stop the schema reaching the next normal form are marked in red in the list above.'));
    }

    function tabDecomp() {
      const modes = [['bcnf', 'BCNF decomposition'], ['3nf', '3NF synthesis']].concat(P.mvds.length ? [['4nf', '4NF decomposition']] : []);
      if (!modes.some((m) => m[0] === st.dmode)) st.dmode = 'bcnf';
      body.appendChild(h('div.th-row', h('div.seg', modes.map(([k, l]) => h('button' + (st.dmode === k ? '.on' : ''), { type: 'button', onclick: () => { st.dmode = k; st.dAt = null; renderAll(); } }, l)))));
      const nm = P.name || 'R';
      if (st.dmode === '3nf') return synth(nm);
      const r = st.dmode === '4nf' ? N.fourNFDecompose(P) : N.bcnfDecompose(P);
      const n = r.steps.length;
      if (st.dAt === null || st.dAt > n) st.dAt = n;
      const at = st.dAt;
      // the tree of schemas: each step splits a leaf in two
      const rootN = { attrs: P.attrs.slice(), kids: [], name: nm };
      const leaves = [rootN];
      const same = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
      r.steps.slice(0, at).forEach((s, i) => {
        const leaf = leaves.find((x) => !x.kids.length && same(x.attrs, s.schema));
        if (!leaf) return;
        leaf.split = s.fd || s.dep; leaf.stepNo = i + 1;
        leaf.kids = s.into.map((a) => ({ attrs: a, kids: [] }));
        leaves.push(...leaf.kids);
      });
      const finals = r.schemas;
      body.appendChild(T.stepper(n, at, (k) => (k === 0 ? [h('b', 'Start'), ': result := { ' + nm + ' }'] : [h('b', 'Step ' + k + ' of ' + n), ': split on ' + (r.steps[k - 1].fd || r.steps[k - 1].dep)]), (k) => { st.dAt = k; renderAll(); }));
      body.appendChild(T.tree(rootN, {
        H: 50,
        box: (x) => {
          const t = x.name ? x.name + schemaText(x.attrs) : schemaText(x.attrs);
          const leaf = !x.kids.length;
          const dropped = leaf && at === n && !finals.some((f) => same(f, x.attrs));
          const sub = x.split ? 'split on ' + x.split : leaf ? (dropped ? 'contained in another schema' : at === n ? (st.dmode === '4nf' ? 'in 4NF' : 'in BCNF') : '') : '';
          return { el: [h('div.tn-top', h('span.tn-sub.de-sch', t)), sub ? h('div.tn-cnt', sub) : null], w: T.width(Math.max(t.length, sub.length), 80, 1000), cls: (leaf && at === n && !dropped ? 'leaf ' : '') + (dropped ? 'pending ' : '') + (x.stepNo === at ? 'cur' : ''), title: t };
        },
      }));
      if (at) { const s = r.steps[at - 1]; body.appendChild(h('div.th-sec', h('p.de-why', s.text))); mark(s.lhs || [], s.rhs || [], 'use', 'used to split'); }
      if (at === n) {
        body.appendChild(h('div.th-sec', h('h3', 'Result'), h('div.de-keys', finals.map((f) => h('span.de-key', schemaText(f)))),
          h('p.th-note', 'Lossless, since each split is on X → Y with X a superkey of one part' + (st.dmode === 'bcnf' ? (r.preserved ? '; every dependency is preserved.' : '; not dependency preserving: ' + r.lost.map((f) => f.text).join(', ') + ' cannot be checked on one schema.') : '.')),
          h('div.th-row', T.button('grid', 'Test with the chase', 'Check this decomposition in the Lossless join tab', () => { st.chaseText = finals.map(schemaText).join(', '); st.chaseAt = 0; st.tab = 'lossless'; renderAll(); }), T.button('check', 'Test preservation', 'Check this decomposition in the Dependency preservation tab', () => { st.presText = finals.map(schemaText).join(', '); st.tab = 'pres'; renderAll(); }))));
      }
    }
    function synth(nm) {
      const r = N.synth3NF(P);
      const n = r.steps.length;
      if (st.dAt === null || st.dAt > n) st.dAt = n;
      const at = st.dAt;
      const kids = [];
      const removed = [];
      r.steps.slice(0, at).forEach((s) => { if (s.action === 'schema' || (s.action === 'key' && s.schema)) kids.push({ attrs: s.schema, kids: [], why: s.action === 'key' ? 'for a key' : 'from ' + s.fd }); if (s.action === 'remove') removed.push(s.schema); });
      const rootN = { attrs: P.attrs, kids, name: nm };
      const same = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
      body.appendChild(T.stepper(n, at, (k) => (k === 0 ? [h('b', 'Start')] : [h('b', 'Step ' + k + ' of ' + n), ': ' + r.steps[k - 1].text]), (k) => { st.dAt = k; renderAll(); }));
      body.appendChild(T.tree(rootN, {
        box: (x) => {
          const t = x.name ? x.name + schemaText(x.attrs) : schemaText(x.attrs);
          const gone = !x.name && removed.some((y) => same(y, x.attrs));
          const sub = x.name ? '' : gone ? 'removed: contained in another' : x.why;
          return { el: [h('div.tn-top', h('span.tn-sub.de-sch', t)), sub ? h('div.tn-cnt', sub) : null], w: T.width(Math.max(t.length, sub.length), 80, 1000), cls: (x.name ? '' : gone ? 'pending' : 'leaf') };
        },
      }));
      const list = h('ol.de-steps');
      r.steps.slice(0, at).forEach((s, i) => list.appendChild(h('li' + (i === at - 1 ? '.cur' : ''), s.text)));
      if (at) body.appendChild(h('div.th-sec', list));
      if (at === n) body.appendChild(h('div.th-sec', h('h3', 'Result'), h('div.de-keys', r.schemas.map((f) => h('span.de-key', schemaText(f)))), h('p.th-note', 'Each schema is in 3NF; the decomposition is lossless (one schema holds a candidate key) and preserves every dependency of Fc.'),
        h('div.th-row', T.button('grid', 'Test with the chase', null, () => { st.chaseText = r.schemas.map(schemaText).join(', '); st.chaseAt = 0; st.tab = 'lossless'; renderAll(); }), T.button('check', 'Test preservation', null, () => { st.presText = r.schemas.map(schemaText).join(', '); st.tab = 'pres'; renderAll(); }))));
    }
    const defaultDecomp = () => { try { return N.bcnfDecompose(P).schemas.map(schemaText).join(', '); } catch (e) { return ''; } };

    function tabLossless() {
      if (!st.chaseText) st.chaseText = defaultDecomp();
      body.appendChild(h('div.th-row', h('span.th-label', 'Decomposition'), h('span.th-note', 'schemas in parentheses')));
      body.appendChild(h('input.inp.th-mono.de-wide', { type: 'text', value: st.chaseText, 'aria-label': 'Decomposition', spellcheck: 'false', oninput: (e) => { st.chaseText = e.target.value; store.set('chase', st.chaseText); st.chaseAt = null; later(); } }));
      let D;
      try { D = parseDecomp(P, st.chaseText); } catch (e) { body.appendChild(T.msg('err', e.message)); return; }
      if (D.length === 2) { const b = N.losslessBinary(P, undefined, D[0], D[1]); body.appendChild(h('div.th-sec', h('h3', 'The test for two schemas'), T.msg(b.lossless ? 'ok' : 'warn', b.text))); }
      const r = N.chase(P, undefined, D);
      const states = r.tableaux;
      const n = states.length - 1;
      if (st.chaseAt === null || st.chaseAt > n) st.chaseAt = n;
      const at = st.chaseAt;
      const s = states[at], prev = at ? states[at - 1] : null;
      const sec = h('div.th-sec', h('h3', 'The chase', h('span.muted', 'one row per schema of the decomposition')));
      const playBtn = T.button(play ? 'pause' : 'run', play ? 'Pause' : 'Play', 'Apply the dependencies one after another', () => {
        if (play) { clearInterval(play); play = null; renderAll(); return; }
        if (st.chaseAt >= n) st.chaseAt = 0;
        play = setInterval(() => { if (st.tab !== 'lossless' || st.chaseAt >= n) { clearInterval(play); play = null; } else st.chaseAt++; renderAll(); }, 1100);
        renderAll();
      });
      sec.appendChild(h('div.th-row', T.stepper(n, at, (k) => (k === 0 ? [h('b', 'Initial tableau')] : [h('b', 'Step ' + k + ' of ' + n), ': apply ' + states[k].fd]), (k) => { st.chaseAt = k; if (play) { clearInterval(play); play = null; } renderAll(); }), h('span.grow'), playBtn));
      const full = s.rows.findIndex((row) => row.every((v) => v[0] === 'a'));
      const tbl = h('table.grid.de-chase', h('thead', h('tr', h('th', 'schema'), r.attrs.map((a) => h('th', a)))),
        h('tbody', s.rows.map((row, i) => h('tr' + (i === full ? '.de-full' : ''), h('td.de-rs', { title: schemaText(D[i]) }, h('b', 'R' + (i + 1)), ' ' + (D[i].join(P.letters ? '' : ', '))), row.map((v, j) => h('td.de-c' + (v[0] === 'a' ? '.a' : '.b') + (prev && prev.rows[i][j] !== v ? '.chg' : ''), v[0], h('sub', v.slice(1))))))));
      sec.appendChild(h('div.th-tbl', tbl));
      sec.appendChild(h('p.th-note', at === 0 ? 'Row i has the distinguished value a_j in the columns of the attributes R_i contains, and b_ij elsewhere. Each step takes a dependency X → Y and makes rows that agree on X agree on Y too, preferring an a.' : 'After ' + s.fd + ': rows that agree on its left side now agree on its right side (changed cells are highlighted).'));
      if (at === n) sec.appendChild(T.msg(r.lossless ? 'ok' : 'warn', r.lossless ? 'Row ' + (full + 1) + ' has only a\'s: the join of the projections always gives back the original relation, so the decomposition is lossless.' : 'No dependency changes the tableau any more and no row has only a\'s, so the decomposition is lossy: the tableau itself is a relation on which the join of the projections has extra tuples.'));
      body.appendChild(sec);
    }

    function tabPres() {
      if (!st.presText) st.presText = st.chaseText || defaultDecomp();
      body.appendChild(h('div.th-row', h('span.th-label', 'Decomposition')));
      body.appendChild(h('input.inp.th-mono.de-wide', { type: 'text', value: st.presText, 'aria-label': 'Decomposition', spellcheck: 'false', oninput: (e) => { st.presText = e.target.value; store.set('pres', st.presText); later(); } }));
      let D;
      try { D = parseDecomp(P, st.presText); } catch (e) { body.appendChild(T.msg('err', e.message)); return; }
      if (!P.fds.length) { body.appendChild(h('div.empty', 'There are no functional dependencies to preserve.')); return; }
      const r = N.preservesDependencies(P, undefined, D);
      body.appendChild(T.msg(r.preserved ? 'ok' : 'warn', r.preserved ? 'Every dependency of F can be checked on the schemas of the decomposition.' : 'Not preserved: ' + r.lost.map((f) => f.text).join(', ') + '. Checking ' + (r.lost.length === 1 ? 'it' : 'them') + ' needs a join of the schemas.'));
      for (const x of r.results) {
        if (!x.preserved) mark(x.fd.lhs, x.fd.rhs, 'bad', 'not preserved');
        const steps = x.steps.filter((s) => s.added.length);
        body.appendChild(h('div.th-sec.de-pres' + (x.preserved ? '.ok' : '.bad'), h('h3', h('code', x.fd.text), h('span.de-verdict', x.preserved ? 'preserved' : 'not preserved')),
          h('ol.de-steps', h('li.de-start', 'result := ', h('code', fmtSet(x.fd.lhs))), steps.map((s) => h('li', 'on ', h('code', schemaText(s.schema)), ': (', fmtSet(s.from), ')+ ∩ R', ' adds ', h('b', s.added.join(', ')), ' → result = ', h('code', fmtSet(s.result))))),
          h('div.th-note', x.preserved ? fmtSet(x.fd.rhs) + ' ⊆ result' : 'the result ' + fmtSet(x.result) + ' never contains ' + fmtSet(x.fd.rhs.filter((a) => !x.result.includes(a))))));
      }
    }

    function tabAnom() {
      // a name of its own, so a script never drops a table of the database
      const table = (P.name || 'r').toLowerCase().replace(/[^a-z0-9_]/g, '_') + '_demo';
      let rows;
      if (st.source && st.source.table) { try { const rel = K.Algebra.source(app.session)(st.source.table); if (rel && rel.attrs.join() === P.attrs.join()) rows = rel.rows.slice(0, 12); } catch (e) { rows = undefined; } }
      let r;
      try { r = N.anomalies(P, undefined, { table, rows }); } catch (e) { body.appendChild(T.msg('err', e.message)); return; }
      if (!r.violation) { body.appendChild(T.msg('ok', r.text)); return; }
      mark(r.violation.lhs, r.violation.rhs, 'bad', 'the cause of the anomalies');
      body.appendChild(T.msg('warn', h('b', (P.name || 'R') + ' is not in BCNF '), 'because of ', h('code', r.violation.text), ': ', fmtSet(r.violation.lhs), ' is not a key (the key is ', fmtSet(r.key), '), so each fact ' + r.violation.text + ' is stored in every row that repeats ' + fmtSet(r.violation.lhs) + '.'));
      body.appendChild(h('p.th-note', 'Each script drops and creates a table ' + table + ' with ' + plural(r.rows.length, 'row') + (rows ? ' copied from ' + st.source.table : '') + ', then shows one anomaly. Run puts it in the editor and runs it in the active tab.'));
      const LOOK = { update: 'The last query returns a row: one ' + fmtSet(r.violation.lhs) + ' now has two different values, and the table contradicts ' + r.violation.text + '.', insert: 'The INSERT fails: the key cannot be NULL, so the new fact cannot be stored on its own.', delete: 'The query finds nothing: the fact went with the row.' };
      for (const sc of r.scenarios) {
        const sql = 'DROP TABLE IF EXISTS ' + r.table + ';\n' + sc.sql;
        body.appendChild(h('div.th-sec', h('h3', sc.title), h('p.th-note', sc.explain), h('pre.ls-sql.de-sql', UI.highlightSql ? UI.highlightSql(sql) : sql),
          h('div.th-row', { style: { marginTop: '8px' } }, T.button('run', 'Run', 'Put the script in the editor and run it', () => app.runText(sql, { insert: true }), 'primary'), T.button('copy', 'Copy', null, () => UI.copy(sql), 'ghost')),
          h('div.th-note', h('b', 'What to look for: '), LOOK[sc.kind] || '')));
      }
      body.appendChild(h('p.th-note', 'The cure is a decomposition: split on ' + r.violation.text + ' (Decomposition tab), and each fact is stored once.'));
    }

    // ---- exercises
    function exAnswerControls(x) {
      const id = x.id;
      const a = store.get('ex.' + id, {});
      const save = (k, v) => { const cur = store.get('ex.' + id, {}); cur[k] = v; store.set('ex.' + id, cur); };
      const kind = x.design.kind;
      const inp = (k, ph, label) => h('input.inp.th-mono.de-wide', { type: 'text', value: a[k] || '', placeholder: ph, 'aria-label': label, spellcheck: 'false', oninput: (e) => save(k, e.target.value) });
      const ta = (k, ph, label) => h('textarea.inp.th-mono.de-ta', { rows: '3', placeholder: ph, 'aria-label': label, spellcheck: 'false', oninput: (e) => save(k, e.target.value) }, a[k] || '');
      const seg = (k, opts) => h('div.seg', opts.map((o) => h('button' + (a[k] === o ? '.on' : ''), { type: 'button', onclick: () => { save(k, o); renderExercise(); } }, o)));
      const lbl = (t) => h('span.th-label', t);
      switch (kind) {
        case 'closure': return h('div.th-row', lbl('(' + x.design.given.attrs.join('') + ')+ ='), inp('closure', 'the attributes, e.g. A C D', 'Closure'));
        case 'keys': return h('div.th-row', lbl('Keys'), inp('keys', 'one key per group: AC; CD', 'Candidate keys'));
        case 'cover': return h('div', lbl('Canonical cover'), ta('fds', 'A → B\nC → D', 'Canonical cover'));
        case 'normalForm': return h('div.th-row', lbl('Highest normal form'), seg('nf', ['1NF', '2NF', '3NF', 'BCNF']));
        case 'bcnf': case '3nf': return h('div', lbl('Decomposition'), ta('schemas', '(A, B), (B, C, D)', 'Decomposition'));
        case 'lossless': return h('div.th-row', lbl('Lossless?'), seg('lossless', ['yes', 'no']));
        case 'preservation': return h('div', h('div.th-row', lbl('Preserved?'), seg('preserved', ['yes', 'no'])), h('div.th-row', { style: { marginTop: '6px' } }, lbl('Lost'), inp('lost', 'the dependencies lost, if any: C → E', 'Lost dependencies')));
      }
      return null;
    }
    function renderExercise() {
      exBox.innerHTML = '';
      exBox.hidden = !st.exercise;
      if (!st.exercise) return;
      const x = K.Content && K.Content.exercises.get(st.exercise);
      if (!x || !x.design) { exBox.hidden = true; return; }
      exBox.appendChild(h('div.th-ex-t', UI.icon('tasks'), 'Exercise: ' + x.title, h('span.grow'),
        T.button('check', 'Check', 'Check your answer', () => { st.verdict = x.check(app); if (st.verdict.ok) T.solved(app, x.id); renderAll(); }, 'primary'),
        T.button('tasks', 'Hints', 'Open the exercise with its hints', () => app.openView('exercise', { exercise: x.id }), 'ghost'),
        T.button('x', null, 'Leave the exercise (your answer is kept)', () => { st.exercise = null; st.verdict = null; setProblem(store.get('schema0', PRESETS[0].schema), store.get('deps0', PRESETS[0].deps)); renderAll(); }, 'icon')));
      exBox.appendChild(h('div.th-ex-p', x.design.prompt));
      exBox.appendChild(exAnswerControls(x));
      if (st.verdict) exBox.appendChild(T.verdict(st.verdict));
    }
    function enterExercise(id) {
      const x = K.Content && K.Content.exercises.get(id);
      if (!x || !x.design) return;
      if (!st.exercise) { store.set('schema0', st.schema); store.set('deps0', st.deps); }
      st.exercise = id; st.verdict = null; st.reveal = {};
      const ex = x.design;
      setProblem('R(' + ex.schema.attrs.join(', ') + ')', ex.fds.map((f) => f.text).join('\n'));
      if (ex.given.schemas) { st.chaseText = st.presText = ex.given.schemas.map(schemaText).join(', '); }
      if (ex.given.attrs) st.X = '';
      st.tab = ex.kind === 'closure' ? 'keys' : 'closure';
    }

    function renderTab() {
      body.innerHTML = '';
      hi.length = 0;
      const [lead, text] = INTRO[st.tab];
      intro.innerHTML = '';
      intro.appendChild(h('b', lead + ' '));
      intro.appendChild(document.createTextNode(text));
      if (!P) { body.appendChild(h('div.empty', perr ? 'Fix the schema or the dependencies above.' : 'Enter a schema and its dependencies.')); drawChips(hi); return; }
      const x = st.exercise && K.Content && K.Content.exercises.get(st.exercise);
      if (x && x.design && GUARD[x.design.kind] === st.tab && !st.reveal[st.tab] && !(st.verdict && st.verdict.ok)) {
        body.appendChild(h('div.th-guard', h('b', 'This tab works the exercise out.'), h('p', 'Try it on paper or with the other tabs first; check your answer above.'), T.button('eye', 'Show it anyway', null, () => { st.reveal[st.tab] = true; renderAll(); })));
        drawChips(hi);
        return;
      }
      try {
        ({ closure: tabClosure, proof: tabProof, keys: tabKeys, cover: tabCover, nf: tabNF, decomp: tabDecomp, lossless: tabLossless, pres: tabPres, anom: tabAnom })[st.tab]();
      } catch (e) { console.error(e); body.appendChild(T.msg('err', 'Something went wrong here: ' + e.message)); }
      drawChips(hi);
    }
    function renderTabs() {
      tabs.innerHTML = '';
      const x = st.exercise && K.Content && K.Content.exercises.get(st.exercise);
      const guarded = x && x.design ? GUARD[x.design.kind] : null;
      for (const [k, l] of TABS) tabs.appendChild(h('button.th-tab' + (st.tab === k ? '.on' : ''), { type: 'button', role: 'tab', 'aria-selected': String(st.tab === k), dataset: { tab: k }, onclick: () => { st.tab = k; store.set('tab', k); renderAll(); } }, l, guarded === k && !st.reveal[k] ? h('span.th-lock', '(answer)') : null));
    }
    function renderAll() {
      const y = scroller.scrollTop;
      // the inputs of the tabs are drawn again: keep the one being typed in focused, with its caret
      const a = document.activeElement;
      const focus = a && a !== depsEd.ta && a !== schemaIn && el.contains(a) && a.getAttribute('aria-label') ? { key: a.getAttribute('aria-label'), s: a.selectionStart, e: a.selectionEnd } : null;
      drawFold();
      renderExercise();
      renderDisc();
      renderTabs();
      renderTab();
      depsEd.redraw();
      scroller.scrollTop = y;
      if (focus) { const e = [...el.querySelectorAll('input, textarea')].find((x) => x.getAttribute('aria-label') === focus.key); if (e) { e.focus(); try { e.setSelectionRange(focus.s, focus.e); } catch (err) { /* not a text field */ } } }
    }

    parse();
    const view = {
      render() { renderAll(); },
      onDb() { if (st.disc) st.disc.res = null; },
      onSelect(sel) {
        if (!sel) return;
        if (sel.exercise) enterExercise(sel.exercise);
        if (sel.schema) { if (st.exercise) { st.exercise = null; st.verdict = null; } setProblem(sel.schema, sel.deps || ''); }
        if (sel.preset) { const p = PRESETS.find((x) => x.id === sel.preset); if (p) setProblem(p.schema, p.deps); }
        if (sel.table) { st.disc = { table: sel.table, res: null, chosen: null }; discover(); }
        if (sel.tab) st.tab = sel.tab;
      },
      destroy() { if (play) clearInterval(play); },
      state: () => ({ tab: st.tab, schema: st.schema, deps: st.deps, exercise: st.exercise, chaseAt: st.chaseAt, dAt: st.dAt, ok: !!P }),
      problem: () => P,
    };
    UI.DesignWorkbench.view = view;
    return view;
  }

  UI.DesignWorkbench = {
    view: null,
    /** the answer kept for an exercise, as K.Normal.check reads it: { closure, keys, fds, nf, schemas, lossless, preserved, lost } */
    answer(id) {
      const a = UI.store.get(KEY + 'ex.' + id, null);
      if (!a) return null;
      const out = Object.assign({}, a);
      if (a.lossless) out.lossless = a.lossless === 'yes';
      if (a.preserved) out.preserved = a.preserved === 'yes';
      return out;
    },
    presets: PRESETS,
  };
  UI.registerView({ id: 'design', title: 'Design theory', icon: 'key', group: 'Theory', order: 71, create });
})(typeof window !== 'undefined' ? window : globalThis);
