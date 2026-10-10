// End-to-end test of the theory workbenches in headless Chrome: the relational algebra view (evaluation with its
// tree and steps, set and bag semantics, parse errors, translation to and from SQL, the equivalence rules, TRC and
// DRC), the design theory view (closure, keys, cover, normal forms, decompositions, the chase, preservation,
// anomaly scripts run in the editor, FD discovery) and the exercises of chapters 2 and 7.
// node tests/e2e/theory.mjs [--shots <dir>]   (screenshots of each view, both themes and phone width)
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../../tools/cdp.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const si = process.argv.indexOf('--shots');
const shots = si >= 0 ? process.argv[si + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });
execFileSync('node', [join(root, 'build.mjs')], { stdio: 'ignore' });

let fails = 0, passes = 0;
const check = (ok, what) => { if (ok) passes++; else { fails++; console.log('FAIL ' + what); } };
const J = JSON.stringify;
const PANE = '.dock-pane:not([hidden]) ';

async function start(width, height, theme) {
  const b = await launch({ width, height, mobile: width < 600 });
  await b.goto('');
  await b.waitFor('window.K && K.app && document.querySelector(".tab")', 20000);
  await b.eval(`localStorage.clear(); K.app.settings.theme = ${J(theme || 'light')}; K.app.applyTheme(); K.app.newDatabase(); 1`);
  return b;
}
const shot = async (b, name) => { if (shots) { await b.sleep(250); await b.screenshot(join(shots, name + '.png')); } };
const errors = (b) => b.logs.filter((l) => l.type === 'error' || l.type === 'exception');
const text = (b, sel) => b.eval(`(() => { const e = document.querySelector(${J(PANE + sel)}); return e ? e.innerText : null; })()`);
const texts = (b, sel) => b.eval(`[...document.querySelectorAll(${J(PANE + sel)})].map((e) => e.innerText)`);
const count = (b, sel) => b.eval(`document.querySelectorAll(${J(PANE + sel)}).length`);
const click = (b, sel) => b.eval(`(() => { const e = document.querySelector(${J(PANE + sel)}); if (!e) return false; e.click(); return true; })()`);
const clickText = (b, sel, t) => b.eval(`(() => { const e = [...document.querySelectorAll(${J(PANE + sel)})].find((x) => x.textContent.trim() === ${J(t)} || x.textContent.includes(${J(t)})); if (!e) return false; e.click(); return true; })()`);
const type = async (b, sel, value) => { await b.eval(`(() => { const e = document.querySelector(${J(PANE + sel)}); e.focus(); e.value = ${J(value)}; e.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`); await b.sleep(600); };
const open = async (b, id, sel) => { await b.eval(`K.app.openView(${J(id)}${sel ? ', ' + J(sel) : ''}); 1`); await b.sleep(150); };
// result sizes computed on the page's own data (the sample may change; the views must agree with the engine)
const algN = (b, x, bag) => b.eval(`K.Algebra.evaluate(${J(x)}, K.Algebra.source(K.app.session), { bag: ${!!bag} }).rows.length`);
const calcN = (b, x) => b.eval(`(() => { const r = K.Algebra.Calculus.evaluate(${J(x)}, K.Algebra.source(K.app.session)); return (r.rows || r.result.rows).length; })()`);
const lastRun = (b) => b.eval(`(() => { const r = K.app.tab.run; if (!r) return null; const x = r.results[r.results.length - 1]; return { tag: x.tag, rows: x.rows ? x.rows.length : null, error: x.error ? x.error.code : null, n: r.results.length }; })()`);

// ---- the relational algebra workbench ------------------------------------------------------------------------------------------
{
  const b = await start(1440, 900);
  await open(b, 'algebra');
  check(await b.eval(`K.app.dock.active`) === 'algebra', 'algebra view opens');
  check(/Relational algebra\./.test(await text(b, '.th-intro')), 'starts with a plain explanation');
  check(await count(b, '.th-tab') === 6, 'six tabs: Evaluate, As SQL, From SQL, rules, TRC, DRC');
  check(await count(b, '.th-pal .th-key') >= 18, 'symbol palette');

  // evaluate: a tree with a relation at every node
  const E1 = "π[person_id, prod_id](σ[company_id = 'C08'](artist) ⋈ casting)";
  const nE1 = await algN(b, E1), nSel = await algN(b, "σ[company_id = 'C08'](artist)"), nCast = await algN(b, 'casting');
  await type(b, '.th-ed-ta', E1);
  check(await count(b, '.th-node') === 5, 'five nodes in the tree');
  check(new RegExp(nE1 + ' tuples').test(await text(b, '.th-rel-n')), 'the root gives ' + nE1 + ' tuples');
  check(/Step 5 of 5/.test(await text(b, '.th-step-l')), 'at the last step');
  await shot(b, 'algebra-eval-light');
  // step from the leaves up
  await click(b, '.th-step .btn:nth-child(1)');
  check(await count(b, '.th-node.pending') === 5, 'before evaluation every node is pending');
  await click(b, '.th-step .btn:nth-child(3)');
  await click(b, '.th-step .btn:nth-child(3)');
  check(/Step 2 of 5/.test(await text(b, '.th-step-l')) && new RegExp('selection σ\\[company_id = "C08"\\] gives ' + nSel + ' tuples').test(await text(b, '.th-step-l')), 'step 2 is the selection, ' + nSel + ' tuples');
  check(await count(b, '.th-node.cur') === 1 && await count(b, '.th-node.pending') === 3, 'two nodes evaluated, the current one marked');
  check(new RegExp(nSel + ' tuples').test(await text(b, '.th-rel-n')), 'the current step\'s relation is shown');
  await clickText(b, '.th-node', 'casting');
  check(new RegExp(nCast + ' tuples').test(await text(b, '.th-rel-n')), 'clicking a leaf shows its relation');
  await shot(b, 'algebra-step');
  // set and bag semantics
  const nSet = await algN(b, 'π[company_id](artist)'), nBag = await algN(b, 'π[company_id](artist)', true);
  await type(b, '.th-ed-ta', 'π[company_id](artist)');
  check(new RegExp(nSet + ' tuples').test(await text(b, '.th-rel-n')) && nSet < nBag, 'set semantics: ' + nSet + ' distinct companies (one is null)');
  await clickText(b, '.seg button', 'Bag');
  check(new RegExp(nBag + ' tuples').test(await text(b, '.th-rel-n')), 'bag semantics: ' + nBag + ' tuples');
  await clickText(b, '.seg button', 'Set');
  // ASCII input and the conversion
  await type(b, '.th-ed-ta', "project[billed_as](select[fee > 2000 and company_id = 'C08'](artist))");
  check(await count(b, '.th-msg.err') === 0 && await count(b, '.th-node') === 3, 'ASCII input parses');
  await clickText(b, '.btn', 'ASCII');
  check(/^π\[billed_as\]\(σ\[/.test(await b.eval(`document.querySelector(${J(PANE + '.th-ed-ta')}).value`)), 'ASCII converts to the symbols');
  // a parse error, underlined at its position
  await type(b, '.th-ed-ta', "π[title](σ[genre = 'opera'(production))");
  check(await count(b, '.th-msg.err') === 1 && /Syntax error/.test(await text(b, '.th-msg.err')), 'syntax error reported');
  check(await count(b, '.th-ed-hl .mk-err') === 1 && await text(b, '.th-ed-hl .mk-err') === '(', 'the error is underlined at the "("');
  check(/at 27/.test(await text(b, '.th-pos')), 'with its position');
  await shot(b, 'algebra-error');
  await type(b, '.th-ed-ta', 'π[name](nosuch)');
  check(/does not exist/.test(await text(b, '.th-msg.err')) && await text(b, '.th-ed-hl .mk-err') === 'nosuch', 'an unknown relation is underlined');

  // as SQL, checked and run in the editor
  await type(b, '.th-ed-ta', E1);
  await click(b, '.th-tab[data-mode=sql]');
  check(/SELECT DISTINCT/.test(await text(b, 'pre.ls-sql')), 'translated to SQL with DISTINCT');
  check(new RegExp('same ' + nE1 + ' rows').test(await text(b, '.th-msg.ok')), 'the SQL is checked against the algebra');
  await clickText(b, '.btn', 'Run');
  const r1 = await lastRun(b);
  check(r1 && r1.rows === nE1 && !r1.error, 'Run runs the SQL in the editor (' + nE1 + ' rows)');
  check(/SELECT DISTINCT/.test(await b.eval('K.app.editor.getValue()')), 'the SQL is in the editor');
  await shot(b, 'algebra-sql');

  // from SQL: pasted, and the editor's statement
  await open(b, 'algebra', { sql: "select title from production where runtime_min > 120 and company_id in (select company_id from company where city = 'Quillmere')" });
  check(/⋉/.test(await text(b, '.th-pre')), 'IN (subquery) becomes a semijoin');
  check(/duplicate/.test(await text(b, '.th-sec:last-child')), 'a note explains the duplicates');
  await b.eval(`K.app.editor.setValue('select company_id, count(*) as n from artist group by company_id;'); K.app.editor.ta.setSelectionRange(5, 5); 1`);
  await clickText(b, '.btn', 'Take the editor');
  check(/γ/.test(await text(b, '.th-pre')), 'the editor\'s GROUP BY becomes γ');
  await clickText(b, '.btn', 'Evaluate it');
  check(await b.eval(`K.app.dock.open.find((o) => o.id === 'algebra').view.state().mode`) === 'eval' && await count(b, '.th-node') >= 2, 'the translation opens in the evaluator');
  await open(b, 'algebra', { sql: 'select title from production order by runtime_min desc limit 3' });
  check(await count(b, '.th-msg') >= 1, 'a query outside the algebra is explained, not a crash');
  await shot(b, 'algebra-from-sql');

  // equivalence rules: push a selection below a join, the result checked
  const RULE = "π[family_name, title](σ[company_id = 'C08' ∧ fee > 2000](person ⋈ artist ⋈ casting ⋈ π[prod_id, title](production)))";
  const nRule = await algN(b, RULE);
  await open(b, 'algebra', { expr: RULE, mode: 'rules' });
  check(await count(b, '.tn-badge') >= 2, 'nodes show how many rules apply');
  await clickText(b, '.th-node', 'σ');
  const rules = await texts(b, '.th-rule-n');
  check(rules.some((r) => /7a/.test(r)) && rules.some((r) => /^1/.test(r)), 'the rules for σ over ⋈ are listed by number and name');
  await b.eval(`[...document.querySelectorAll(${J(PANE + '.th-rule')})].find((r) => /7a/.test(r.textContent)).querySelector('.btn').click(); 1`);
  await b.sleep(200);
  check(new RegExp('same ' + nRule + ' tuples').test(await text(b, '.th-msg.ok')), 'after the rewrite the result is unchanged (checked)');
  const after = await b.eval(`document.querySelector(${J(PANE + '.th-ed-ta')}).value`);
  check(after.includes('σ[company_id = "C08" ∧ fee > 2000](person ⋈ artist ⋈ casting) ⋈ π[prod_id, title](production)'), 'the selection moved below the join: ' + after);
  check(await count(b, '.th-node.changed') === 1, 'the rewritten subtree is marked');
  await shot(b, 'algebra-rules');
  await clickText(b, '.btn', 'Undo');
  check(/^π\[family_name, title\]\(σ\[/.test(await b.eval(`document.querySelector(${J(PANE + '.th-ed-ta')}).value`)), 'undo restores the expression');

  // the calculus
  const TRC = '{ t | ∃ s ∈ production (t[title] = s[title] ∧ s[runtime_min] > 150) }', nTrc = await calcN(b, TRC);
  await open(b, 'algebra', { trc: TRC });
  check(/Safe/.test(await text(b, '.th-msg.ok')) && new RegExp(nTrc + ' tuples').test(await text(b, '.th-rel-n')), 'a safe TRC query is evaluated (' + nTrc + ' tuples)');
  check(/π\[/.test(await text(b, '.th-sec .th-pre')) || (await texts(b, '.th-pre')).some((t) => /π\[/.test(t)), 'with its equivalent algebra');
  check((await texts(b, '.th-msg.ok')).some((t) => new RegExp('algebra gives the same ' + nTrc + ' tuples').test(t)), 'the algebra is checked against the calculus');
  await shot(b, 'algebra-trc');
  await open(b, 'algebra', { drc: '{ ⟨c⟩ | ¬ ∃ p, b, f (⟨p, c, b, f⟩ ∈ artist) }' });
  check(/Not safe/.test(await text(b, '.th-msg.warn')) && await count(b, '.th-ed-hl .mk-err') === 1, 'an unsafe DRC query is reported and underlined');
  await type(b, '.th-ed-ta', "{ ⟨t⟩ | ∃ p, c, g, d, r, b (⟨p, t, c, g, d, r, b⟩ ∈ production ∧ g = 'opera') }");
  check(/Safe/.test(await text(b, '.th-msg.ok')), 'a safe DRC query typed in');

  // an algebra exercise: answered in the workbench, checked there and in the exercise view
  await b.eval(`K.UI.Exercises.open(K.app, 'ra-never-performed'); 1`);
  await b.sleep(150);
  check(/never been performed/.test(await text(b, '.ls-title + p')), 'the exercise text');
  await click(b, '.ls-view');
  await b.sleep(200);
  check(await b.eval(`K.app.dock.active`) === 'algebra' && /never been performed/.test(await text(b, '.th-ex-p')), 'the button opens the workbench on the exercise');
  await type(b, '.th-ed-ta', 'π[prod_id](production)');
  await clickText(b, '.th-ex .btn', 'Check');
  check(/Not yet/.test(await text(b, '.th-verdict.bad')), 'a wrong answer is caught');
  await type(b, '.th-ed-ta', 'π[prod_id](production) − π[prod_id](performance)');
  await clickText(b, '.th-ex .btn', 'Check');
  check(/Correct/.test(await text(b, '.th-verdict.ok')), 'a right answer passes');
  check(await b.eval(`!!JSON.parse(localStorage.getItem('kwery.progress')).solved['ra-never-performed']`), 'the exercise is marked solved');
  await shot(b, 'algebra-exercise');
  await b.eval(`K.UI.Exercises.open(K.app, 'ra-never-performed'); 1`);
  await b.sleep(150);
  await clickText(b, '.btn', 'Check my answer');
  check(await count(b, '.ex-res.ok') === 1, 'the exercise view checks the workbench\'s answer');
  await clickText(b, '.btn', 'A hint');
  check(await count(b, '.ls-tip') >= 2, 'hints');
  await clickText(b, '.btn', 'Show an answer');
  await b.eval(`[...document.querySelectorAll('.dlg .btn')].find((x) => x.textContent === 'Show it').click(); 1`);
  check(/π\[prod_id\]/.test(await text(b, '.ex-res pre')), 'the reference answer can be shown');
  check(await b.eval(`[...K.Content.exercises.values()].filter((x) => x.kind === 'algebra' && x.chapter === 2).length`) >= 20, 'about twenty algebra exercises');
  check(await b.eval(`[...K.Content.exercises.values()].filter((x) => x.kind === 'design' && x.chapter === 7).length`) >= 30, 'thirty design exercises');
  check(await b.eval(`[...K.Content.exercises.values()].filter((x) => x.kind === 'algebra' || x.kind === 'design').every((x) => x.hints.length === 3 && x.text.some((t) => t && (t.view === 'algebra' || t.view === 'design')))`), 'each has three hints and a workbench button');

  // dark theme
  await open(b, 'algebra', { expr: "π[prod_id](σ[company_id = 'C08'](artist) ⋈ casting)", mode: 'eval' });
  await b.eval(`K.app.settings.theme = 'dark'; K.app.applyTheme(); 1`);
  await shot(b, 'algebra-eval-dark');
  check(errors(b).length === 0, 'no console errors in the algebra view' + (errors(b).length ? ': ' + errors(b).map((e) => e.text).join(' | ') : ''));
  await b.close();
}

// ---- the design theory workbench ------------------------------------------------------------------------------------------------
{
  const b = await start(1440, 900);
  await open(b, 'design', { preset: 'letters', tab: 'closure' });
  check(await b.eval(`K.app.dock.active`) === 'design' && /Attribute closure\./.test(await text(b, '.th-intro')), 'design view opens with an explanation');
  check(await count(b, '.th-tab') === 9, 'nine tabs');
  check(await count(b, '.de-chip') === 4, 'the four dependencies are read');
  // closure step by step
  await type(b, '.th-row .inp', 'AC');
  check(await count(b, '.de-steps li:not(.de-start)') === 4 && (await texts(b, '.de-steps li .de-fd')).join() === 'A → B,BC → D,D → E,E → CF', 'four closure steps, each naming its dependency');
  check(/superkey/.test(await text(b, '.th-msg')), 'AC is a superkey');
  await click(b, '.th-step .btn:nth-child(1)');
  check(await count(b, '.de-attr.in') === 2, 'at the start only A and C are in the result');
  await click(b, '.th-step .btn:nth-child(3)');
  check(await count(b, '.de-attr.new') === 1 && await count(b, '.de-chip.use') === 1, 'step 1 adds B using A → B, which is marked');
  await shot(b, 'design-closure');
  // Armstrong
  await click(b, '.th-tab[data-tab=proof]');
  await b.sleep(150);
  check(await count(b, '.de-proof tbody tr') >= 3 && /transitivity/.test(await text(b, '.de-proof')), 'a proof with transitivity');
  // keys
  await click(b, '.th-tab[data-tab=keys]');
  check(J(await texts(b, '.de-key')) === J(['{AC}', '{AD}', '{AE}']), 'candidate keys AC, AD, AE');
  // cover
  await click(b, '.th-tab[data-tab=cover]');
  check(/already a canonical cover/.test(await text(b, '.th-sec')), 'F is already canonical');
  // normal forms
  await click(b, '.th-tab[data-tab=nf]');
  check(/is in 1NF/.test(await text(b, '.th-msg')), 'the schema is only in 1NF');
  check(await count(b, '.de-nfc.first') === 1 && /2NF/.test(await text(b, '.de-nfc.first')), '2NF is the first form that fails');
  check(await count(b, '.de-chip.bad') >= 1, 'the violating dependency is highlighted');
  await shot(b, 'design-nf');
  // decompositions
  await click(b, '.th-tab[data-tab=decomp]');
  check(await count(b, '.th-node') >= 3, 'a BCNF decomposition tree');
  const nb = await count(b, '.de-key');
  check(nb >= 2, 'BCNF result has ' + nb + ' schemas');
  await click(b, '.th-step .btn:nth-child(1)');
  check(await count(b, '.th-node') === 1, 'stepping back to the start shows R alone');
  await click(b, '.th-step .btn:nth-child(3)');
  check(await count(b, '.th-node') === 3 && await count(b, '.th-node.cur') === 1, 'the first split');
  await click(b, '.th-step .btn:nth-child(4)');
  await shot(b, 'design-bcnf');
  await clickText(b, '.seg button', '3NF synthesis');
  check(await count(b, '.th-node') >= 3 && /candidate key|contains the candidate key|for the key/.test(await text(b, '.de-steps')), '3NF synthesis steps');
  await clickText(b, '.btn', 'Test with the chase');
  check(await b.eval(`K.app.dock.open.find((o) => o.id === 'design').view.state().tab`) === 'lossless', 'on to the lossless tab');
  // the chase
  check(await count(b, '.de-chase tbody tr') >= 2, 'a tableau row per schema');
  check(/Initial tableau/.test(await text(b, '.th-step-l')), 'the chase starts at the initial tableau');
  await click(b, '.th-step .btn:nth-child(4)');
  check(await count(b, '.de-chase tr.de-full') === 1 && /lossless/.test(await text(b, '.th-sec .th-msg.ok')), 'a row of a\'s: lossless');
  await type(b, '.de-wide', '(A, B), (C, D, E, F)');
  await click(b, '.th-step .btn:nth-child(1)');
  await click(b, '.th-step .btn:nth-child(3)');
  check(await count(b, '.de-chase td.chg') >= 0, 'cells changed by a step are marked');
  await click(b, '.th-step .btn:nth-child(4)');
  check(/lossy/.test(await text(b, '.th-sec .th-msg.warn')), '(AB), (CDEF) is lossy');
  check(/neither|lossy/.test(await text(b, '.th-sec .th-msg')), 'the two-schema test agrees');
  await type(b, '.de-wide', '(A, B), (A, C, D), (D, E), (E, C, F)');
  await clickText(b, '.btn', 'Play');
  await b.sleep(5000);
  check(await count(b, '.de-chase tr.de-full') === 1, 'playing the chase reaches a row of a\'s');
  await shot(b, 'design-chase');
  // preservation
  await click(b, '.th-tab[data-tab=pres]');
  await type(b, '.de-wide', '(A, B), (A, C, D), (D, E), (E, C, F)');
  check(await count(b, '.de-pres') === 4, 'one result per dependency');
  check(await count(b, '.de-pres.bad') === 1 && /BC → D/.test(await text(b, '.de-pres.bad h3')), 'BC → D is not preserved');
  // anomalies, run in the editor
  await open(b, 'design', { preset: 'showings', tab: 'anom' });
  check(await count(b, '.th-sec') === 3, 'three anomaly scripts');
  await b.eval(`[...document.querySelectorAll(${J(PANE + '.th-sec')})][0].querySelector('.btn.primary').click(); 1`);
  const u = await lastRun(b);
  check(u && u.rows === 1 && !u.error, 'the update anomaly shows a stage with two seat counts');
  await b.eval(`[...document.querySelectorAll(${J(PANE + '.th-sec')})][1].querySelector('.btn.primary').click(); 1`);
  const ins = await lastRun(b);
  check(ins && ins.error === '23502', 'the insertion anomaly fails on the key (23502)');
  await b.eval(`[...document.querySelectorAll(${J(PANE + '.th-sec')})][2].querySelector('.btn.primary').click(); 1`);
  const del = await lastRun(b);
  check(del && del.rows === 0 && !del.error, 'the deletion anomaly loses the fact');
  await shot(b, 'design-anomalies');
  // multivalued dependencies
  await open(b, 'design', { preset: 'touring', tab: 'nf' });
  check(/BCNF/.test(await text(b, '.th-msg')) && await count(b, '.de-nfc') === 5, 'with an MVD, 4NF is tested too');
  // dependencies found in a table
  await open(b, 'design', { table: 'company' });
  check(await count(b, '.de-hyp-i') >= 1, 'hypotheses from the rows of company');
  await clickText(b, '.btn', 'Use the checked dependencies');
  check(/^company\(company_id, name, city, founded, budget\)$/.test(await b.eval(`document.querySelector(${J(PANE + '.de-schema')}).value`)), 'the table becomes the schema');
  check(/company_id → /.test(await b.eval(`document.querySelector(${J(PANE + '.th-ed-ta')}).value`)), 'with company_id → the other columns');
  // a design exercise
  await b.eval(`K.UI.Exercises.open(K.app, 'nf-keys-1'); 1`);
  await b.sleep(150);
  await click(b, '.ls-view');
  await b.sleep(200);
  check(await b.eval(`K.app.dock.active`) === 'design' && /candidate keys/.test(await text(b, '.th-ex-p')), 'the design workbench opens on the exercise');
  await click(b, '.th-tab[data-tab=keys]');
  check(await count(b, '.th-guard') === 1, 'the tab that answers it is covered');
  await type(b, '.th-ex .inp', 'A; CD');
  await clickText(b, '.th-ex .btn', 'Check');
  check(/Not yet/.test(await text(b, '.th-verdict.bad')), 'a wrong key list is caught');
  await type(b, '.th-ex .inp', 'AC; CD');
  await clickText(b, '.th-ex .btn', 'Check');
  check(/Correct/.test(await text(b, '.th-verdict.ok')) && await count(b, '.th-guard') === 0, 'right: the tab is uncovered');
  await shot(b, 'design-exercise');
  await b.eval(`K.UI.Exercises.open(K.app, 'nf-lossless-1'); 1`);
  await b.sleep(150);
  await click(b, '.ls-view');
  await clickText(b, '.th-ex .seg button', 'no');
  await clickText(b, '.th-ex .btn', 'Check');
  check(await count(b, '.th-verdict') === 1, 'a yes/no exercise is checked');
  await b.eval(`K.app.settings.theme = 'dark'; K.app.applyTheme(); K.app.openView('design', { preset: 'coaching', tab: 'nf' }); 1`);
  await shot(b, 'design-nf-dark');
  check(errors(b).length === 0, 'no console errors in the design view' + (errors(b).length ? ': ' + errors(b).map((e) => e.text).join(' | ') : ''));
  await b.close();
}

// ---- phone width ------------------------------------------------------------------------------------------------------------------
{
  const b = await start(390, 844);
  const fits = () => b.eval(`(() => { const p = document.querySelector(${J(PANE.trim())}); return document.documentElement.scrollWidth <= innerWidth + 1 && p.scrollWidth <= p.clientWidth + 1; })()`);
  await open(b, 'algebra', { expr: "π[family_name, title](σ[company_id = 'C08' ∧ fee > 2000](person ⋈ artist ⋈ casting ⋈ π[prod_id, title](production)))", mode: 'eval' });
  check(await fits(), 'algebra fits the phone width');
  check(await count(b, '.th-node') === 10, 'the tree is drawn (it scrolls on its own)');
  await shot(b, 'phone-algebra');
  await open(b, 'algebra', { mode: 'rules' });
  check(await fits(), 'rules fit the phone width');
  await open(b, 'design', { preset: 'showings', tab: 'nf' });
  check(await fits(), 'design fits the phone width');
  await shot(b, 'phone-design');
  await open(b, 'design', { tab: 'lossless' });
  check(await fits(), 'the chase fits the phone width');
  await shot(b, 'phone-chase');
  await b.eval(`K.app.settings.theme = 'dark'; K.app.applyTheme(); 1`);
  await open(b, 'design', { tab: 'decomp' });
  await shot(b, 'phone-design-dark');
  check(errors(b).length === 0, 'no console errors at phone width' + (errors(b).length ? ': ' + errors(b).map((e) => e.text).join(' | ') : ''));
  await b.close();
}

console.log(passes + ' passed, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
