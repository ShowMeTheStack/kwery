// End-to-end test of the transactions view and the schedule workbench in headless Chrome.
// node tests/e2e/txn.mjs [--shots <dir>]   (screenshots of each part, both themes and phone width)
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

// in the page: what a tab's last statement gave (the first value, the tag, or the error code), and whether it waits
const HELPERS = `
  window.__tab = (n) => K.app.tabs.find((t) => t.name === n);
  window.__last = (n) => { const t = __tab(n); const rs = t && t.run ? t.run.results : []; const r = rs[rs.length - 1]; if (!r) return null; if (r.error) return 'ERR ' + r.error.code; if (r.rows && r.rows.length) return r.rows.map((row) => row.map((v, i) => v === null ? 'NULL' : K.UI.valueText(v, r.cols[i].type)).join('|')).join(';'); return r.tag; };
  window.__waits = (n) => { const t = __tab(n); return !!(t && t.runner && !t.runner.done); };
  window.__view = () => K.app.dock.open.find((o) => o.id === 'txn').view;
  1`;
async function start(width, height) {
  const b = await launch({ width, height, mobile: width < 600 });
  await b.goto('');
  await b.waitFor('window.K && K.app && document.querySelector(".tab")', 30000);
  await b.eval('localStorage.clear(); K.app.settings.theme = "light"; K.app.applyTheme(); K.app.newDatabase(); 1');
  await b.eval(HELPERS);
  return b;
}
const shot = async (b, name) => { if (shots) { await b.sleep(250); await b.screenshot(join(shots, name + '.png')); } };
const errors = (b) => b.logs.filter((l) => l.type === 'error' || l.type === 'exception');
const text = (b, sel) => b.eval(`(() => { const e = document.querySelector(${J(sel)}); return e ? e.innerText : null; })()`);
const count = (b, sel) => b.eval(`document.querySelectorAll(${J(sel)}).length`);
const theme = (b, t) => b.eval(`K.app.settings.theme = ${J(t)}; K.app.applyTheme(); 1`);
const subtab = (b, k) => b.eval(`document.querySelector('.tx-tabs button[data-tab="${k}"]').click(); 1`);
const choose = (b, i, v) => b.eval(`(() => { const s = document.querySelectorAll('.tx-sels select')[${i}]; s.value = ${J(v)}; s.dispatchEvent(new Event('change')); return s.value; })()`);
/** set up a scenario from its card in the Scenarios tab */
async function setup(b, id) {
  await subtab(b, 'scenarios');
  const i = await b.eval(`K.UI.TxnScenarios.list.findIndex((s) => s.id === ${J(id)})`);
  await b.eval(`document.querySelectorAll('.tx-scc')[${i}].querySelector('.btn.primary').click(); 1`);
  await b.sleep(30);
}
/** run the next n steps with the scenario bar's button (a step whose tab still waits is skipped) */
async function steps(b, n) {
  for (let k = 0; k < n; k++) {
    const ok = await b.eval(`(() => { const r = document.querySelector('.tx-runstep'); if (!r) return 'none'; r.click(); return document.querySelector('.tx-scbar .tx-alert') ? 'blocked' : 'ran'; })()`);
    if (ok === 'blocked') await b.eval(`document.querySelector('.tx-next .btn.icon[title="Skip this step"]').click(); 1`);
    await b.sleep(20);
  }
}
const stepNo = (b) => b.eval('__view().state.step');

// ---- scenarios under MVCC, READ COMMITTED ----------------------------------------------------------------------------------
{
  const b = await start(1440, 900);
  await b.eval(`K.app.dock.close('plan'); K.app.openView('txn'); 1`);
  check(await b.eval('K.app.dock.active') === 'txn', 'the transactions view opens');
  check(/concurrency-control scheme/.test(await text(b, '.tx-intro')), 'it starts with a plain explanation');
  check(await count(b, '.tx-scc') === 9, 'nine scenarios are offered');
  await shot(b, 'txn-scenarios-light');

  // lost update: T2 waits for T1, then overwrites
  await setup(b, 'lost-update');
  check(await b.eval(`['T1', 'T2'].every((n) => __tab(n))`) && /step 3/.test(await b.eval(`__tab('T1').text`)), 'the scenario opens tabs T1 and T2 with their scripts');
  check(await b.eval(`K.app.db.session().query('select bal from acct where id = 1').rows[0][0]`) === 100, 'the scenario table is set up');
  await steps(b, 5);
  check(/What happens to T2/.test(await text(b, '.tx-pred')), 'the predict question comes before the interesting step');
  await b.eval(`document.querySelector('.tx-popt').click(); 1`);
  await steps(b, 1);
  check(await b.eval(`__waits('T2')`), 'lost update: T2\'s UPDATE waits for T1');
  check(await count(b, '.tx-c.live') > 0, 'the waiting lane shows a live wait bar');
  check(/waits for .*row \(0,1\) of acct/.test(await text(b, '.tx-grid')), 'the wait names the row');
  check(/What to expect/.test(await text(b, '.tx-exp')) && /lost/.test(await text(b, '.tx-exp')), 'the expected outcome for READ COMMITTED is shown');
  await shot(b, 'txn-lost-update-wait-light');
  await steps(b, 1);
  check(!await b.eval(`__waits('T2')`) && /went on: UPDATE 1/.test(await text(b, '.tx-grid')), 'T1\'s commit lets T2 go on');
  await steps(b, 2);
  check(await b.eval(`__last('T1')`) === '80', 'lost update under READ COMMITTED: the final balance is 80');
  check(/All steps have run/.test(await text(b, '.tx-scbar')), 'the scenario ends');
  // the versions of the row: three versions, each session sees the newest
  await subtab(b, 'versions');
  check(await count(b, '.tx-ver') === 3, 'the row has three versions (two updates)');
  check(await count(b, '.tx-vis td.sees') >= 2 && /deleted by transaction/.test(await text(b, '.tx-vis')), 'who sees which version, and why');
  check(await count(b, '.tx-snaps tbody tr') >= 2, 'a snapshot per session');
  await shot(b, 'txn-versions-light');
  await b.eval(`document.querySelector('.tx-ver .kv-link').click(); 1`);
  check(await b.eval(`K.app.dock.active`) === 'storage', 'a version links to the storage view');
  await b.eval(`K.app.dock.activate('txn'); 1`);

  // under REPEATABLE READ the second updater fails instead
  await choose(b, 1, 'repeatable read');
  check(await b.eval(`K.app.tabs.every((t) => t.session.settings.default_transaction_isolation === 'repeatable read')`), 'the isolation level is set in every tab');
  await setup(b, 'lost-update');
  await steps(b, 9);
  check(await b.eval(`__last('T1')`) === '90' && /40001/.test(await text(b, '.tx-grid')), 'lost update under REPEATABLE READ: T2 fails, the balance is 90');
  await choose(b, 1, 'read committed');

  // dirty read: never under MVCC
  await setup(b, 'dirty-read');
  await steps(b, 4);
  check(await b.eval(`__last('T2')`) === '100' && !await b.eval(`__waits('T2')`), 'dirty read: T2 reads 100 at once');
  await steps(b, 3);
  // non-repeatable read and phantom under READ COMMITTED
  await setup(b, 'unrepeatable');
  await steps(b, 4);
  check(await b.eval(`__last('T1')`) === '50', 'non-repeatable read: T1 reads 50 the second time');
  await steps(b, 1);
  await setup(b, 'phantom');
  await steps(b, 4);
  check(await b.eval(`__last('T1')`) === '3', 'phantom: T1 counts 3 the second time');
  await steps(b, 1);

  // write skew under SERIALIZABLE: SSI's dangerous structure, the second commit fails
  await choose(b, 1, 'serializable');
  await setup(b, 'write-skew');
  await steps(b, 7);
  await subtab(b, 'ssi');
  check(await count(b, '.dg-e') >= 2, 'write skew: two rw-antidependencies drawn');
  check(/Dangerous structure/.test(await text(b, '.tx-body')), 'write skew: the dangerous structure is flagged');
  await shot(b, 'txn-ssi-light');
  await steps(b, 1);
  check(await b.eval(`__last('T2')`) === 'ERR 40001', 'write skew under SERIALIZABLE: T2\'s commit fails');
  await steps(b, 1);
  check(/tomas\|t/.test(await b.eval(`__last('T1')`)), 'Tomas is still on standby');
  await choose(b, 1, 'read committed');

  // deadlock: the cycle is found, drawn, and the victim rolled back
  await setup(b, 'deadlock');
  await steps(b, 5);
  check(await b.eval(`__waits('T1')`), 'deadlock: T1 waits for T2');
  await subtab(b, 'locks');
  check(await count(b, '.dg-e') === 1, 'the wait-for graph has the edge T1 -> T2');
  check(await count(b, '.tx-locks tbody tr') > 0, 'the lock table lists the locks');
  check(await count(b, '.tx-mx') >= 1, 'the compatibility matrix is shown');
  await steps(b, 1);
  check(await b.eval(`__last('T2')`) === 'ERR 40P01', 'deadlock: T2 is the victim');
  check(await count(b, '.dg-n.bad') === 2 && /the last deadlock found/i.test(await text(b, '.tx-body')), 'the deadlock cycle is drawn in red');
  await shot(b, 'txn-deadlock-locks-light');
  await subtab(b, 'timeline');
  check(await count(b, '.tx-span.deadlock') === 1 && await count(b, '.tx-c.dl') > 0, 'the time line highlights the deadlock and the waits in the cycle');
  await shot(b, 'txn-deadlock-timeline-light');
  await steps(b, 2);
  // a three-way deadlock
  await setup(b, 'deadlock3');
  await steps(b, 9);
  check(await b.eval(`__last('T3')`) === 'ERR 40P01', 'three-way deadlock: T3 is the victim');
  await subtab(b, 'locks');
  check(await count(b, '.dg-n.bad') === 3, 'the cycle of three is drawn');
  await steps(b, 3);
  check(errors(b).length === 0, 'no console errors (MVCC scenarios): ' + J(errors(b).slice(0, 3)));
  await b.close();
}

// ---- the classic protocols ----------------------------------------------------------------------------------------------------
{
  const b = await start(1440, 900);
  await b.eval(`K.app.dock.close('plan'); K.app.openView('txn'); 1`);
  // switching the protocol issues SET in every tab
  await choose(b, 0, 'strict2pl');
  check(await b.eval(`K.app.db.protocol && K.app.db.protocol.name`) === 'strict2pl', 'the protocol selector switches to strict 2PL');
  await setup(b, 'lost-update');
  check(await b.eval(`K.app.tabs.every((t) => t.session.settings.concurrency_control === 'strict2pl')`), 'every tab runs under strict 2PL');
  await steps(b, 5);
  check(await b.eval(`__waits('T1')`), 'strict 2PL: T1\'s upgrade to X waits for T2\'s S lock');
  await steps(b, 1);
  check(await b.eval(`__last('T2')`) === 'ERR 40P01', 'strict 2PL: both upgrades deadlock, T2 is rolled back');
  await steps(b, 3);
  check(await b.eval(`__last('T1')`) === '90', 'strict 2PL: no lost update');
  await subtab(b, 'protocol');
  check(await count(b, '.tx-lc') >= 2 && /Strict two-phase locking/.test(await text(b, '.tx-body')), 'growing and shrinking phases are drawn per transaction');
  await subtab(b, 'locks');
  check(/multiple granularity/i.test(await text(b, '.tx-body')), 'the multiple-granularity matrix is shown under 2PL');
  // the history goes to the schedule workbench
  await b.eval(`K.app.openView('schedule', { replay: true }); 1`);
  await b.sleep(100);
  check(/strict2pl/.test(await text(b, '.sw-legend')) && /a2/.test(await b.eval(`document.querySelector('.sw-text').value`)), 'replay: the protocol\'s history becomes a schedule');
  await b.eval(`K.app.dock.activate('txn'); 1`);

  // cascading rollback: under strict 2PL the reader waits; under basic 2PL it reads dirty data
  await setup(b, 'cascade');
  check(await b.eval(`K.app.db.protocol.name`) === 'strict2pl', 'the cascading-rollback scenario keeps strict 2PL for comparison');
  await steps(b, 5);
  check(await b.eval(`__waits('T2')`), 'strict 2PL: T2 waits for T1\'s X lock');
  await steps(b, 2);
  check(await b.eval(`__last('T2')`) === '100', 'strict 2PL: T2 reads 100 after T1 rolls back');
  await steps(b, 1);
  await choose(b, 0, 'mvcc');
  await setup(b, 'cascade');
  check(await b.eval(`K.app.db.protocol.name`) === '2pl', 'from MVCC the cascading-rollback scenario switches to basic 2PL');
  await steps(b, 5);
  check(await b.eval(`__last('T2')`) === '5', 'basic 2PL: T2 reads T1\'s uncommitted 5');
  await steps(b, 2);
  check(await b.eval(`__last('T2')`) === 'ERR 25P02' && /cascading rollback/.test(await text(b, '.tx-grid')), 'T1\'s rollback cascades to T2');
  await shot(b, 'txn-cascade-light');
  await steps(b, 1);

  // Thomas' write rule
  await setup(b, 'thomas');
  check(await b.eval(`K.app.db.protocol.name === 'to' && K.app.session.settings.thomas_write_rule === true`), 'the Thomas scenario switches to TO with Thomas\' rule');
  await steps(b, 6);
  check(await b.eval(`__last('T1')`) === 'UPDATE 0' && /obsolete write/.test(await text(b, '.tx-grid')), 'Thomas\' write rule ignores the obsolete write');
  await subtab(b, 'protocol');
  check(/R-timestamp\(Q\)/.test(await text(b, '.tx-body')), 'R- and W-timestamps per item');
  await shot(b, 'txn-thomas-protocol-light');
  await steps(b, 2);
  check(await b.eval(`__last('T1')`) === '2', 'the balance stays 2');

  // validation and MVTO bookkeeping
  await choose(b, 0, 'occ');
  await setup(b, 'unrepeatable');
  await steps(b, 5);
  check(await b.eval(`__last('T1')`) === 'ERR 40001', 'validation: T1 fails at commit');
  await subtab(b, 'protocol');
  check(/Validation/.test(await text(b, '.tx-body')) && /failed/.test(await text(b, '.tx-body')), 'the validation test is shown');
  await choose(b, 0, 'mvto');
  await setup(b, 'unrepeatable');
  await steps(b, 5);
  check(await b.eval(`__last('T1')`) === 'COMMIT', 'MVTO: T1 reads its version and commits');
  await subtab(b, 'protocol');
  check(await count(b, '.tx-vq') >= 2, 'MVTO: the version list with timestamps');
  await shot(b, 'txn-mvto-light');
  // deadlock prevention
  await choose(b, 0, 'mvcc');
  await choose(b, 2, 'wait-die');
  await setup(b, 'deadlock');
  await steps(b, 6);
  check(/wait-die/.test(await b.eval(`__tab('T2').run.results.slice(-1)[0].error.message`)), 'wait-die: the younger T2 dies');
  await steps(b, 2);
  await choose(b, 2, 'wound-wait');
  await setup(b, 'deadlock');
  await steps(b, 5);
  check(await b.eval(`__last('T1')`) === 'UPDATE 1' && /wound/.test(await text(b, '.tx-grid')), 'wound-wait: the older T1 wounds T2 and goes on');
  await steps(b, 3);
  // the protocol cannot change under an open transaction: the view asks to roll it back
  await b.eval(`K.app.runSql(__tab('T1'), 'begin; select 1;'); 1`);
  await choose(b, 0, 'to');
  check(await count(b, '.dlg') === 1, 'changing the protocol with a transaction open asks first');
  await b.eval(`document.querySelector('.dlg .btn.primary').click(); 1`);
  check(await b.eval(`K.app.db.protocol && K.app.db.protocol.name`) === 'to' && !await b.eval(`__tab('T1').session.tx`), 'after rolling back, the protocol switches');
  await theme(b, 'dark');
  await subtab(b, 'timeline');
  await shot(b, 'txn-timeline-dark');
  check(errors(b).length === 0, 'no console errors (protocols): ' + J(errors(b).slice(0, 3)));
  await b.close();
}

// ---- the schedule workbench ----------------------------------------------------------------------------------------------------
{
  const b = await start(1440, 900);
  await b.eval(`K.app.dock.close('plan'); K.app.openView('schedule'); 1`);
  const setText = (t) => b.eval(`(() => { const i = document.querySelector('.sw-text'); i.value = ${J(t)}; i.dispatchEvent(new Event('input')); return 1; })()`);
  const verdict = (title) => b.eval(`(() => { const c = [...document.querySelectorAll('.sw-v')].find((x) => x.querySelector('h3').textContent.includes(${J(title)})); return c ? c.querySelector('.kv-badge').textContent : null; })()`);
  check(/precedence graph/.test(await text(b, '.kv-intro')), 'the workbench starts with an explanation');
  await setText('r1(A) r2(A) w1(A) w2(A) c1 c2');
  await b.sleep(450);
  check(await count(b, '.sw-op') === 6 && await count(b, '.sw-gh') === 4, 'a column per transaction, a row per operation');
  check(await verdict('Conflict serializable') === 'no' && await count(b, '.dg-e.bad') === 2, 'the lost update is not conflict serializable: the cycle is red');
  check(await verdict('Recoverable') === 'yes' && await verdict('Serial') === 'no', 'recoverable, not serial');
  await setText('w1(X) r2(Y) w2(X) w1(X) w3(X) c2 c1 c3');
  await b.sleep(450);
  check(await verdict('Conflict serializable') === 'no' && await verdict('View serializable') === 'yes', 'blind writes: view but not conflict serializable');
  await setText('w1(A) r2(A) c2 a1');
  await b.sleep(450);
  check(await verdict('Recoverable') === 'no' && await verdict('Cascadeless') === 'no', 'not recoverable, not cascadeless');
  await setText('r1(A) w1(A) c1 r2(A) w2(A) c2');
  await b.sleep(450);
  check(await verdict('Serial') === 'yes' && await verdict('Strict') === 'yes', 'a serial schedule is strict');
  await shot(b, 'schedule-serial-light');
  // drag r2(A) (row 4) above everything with pointer events
  const moved = await b.eval(`(() => {
    const chip = document.querySelector('.sw-op[data-i="3"]');
    const a = chip.getBoundingClientRect(), t = document.querySelector('.sw-n[data-row="0"]').getBoundingClientRect();
    const ev = (type, y, el) => (el || window).dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: a.left + 5, clientY: y, pointerId: 1, button: 0, isPrimary: true }));
    ev('pointerdown', a.top + 5, chip); ev('pointermove', a.top - 20); ev('pointermove', t.top + 2); ev('pointerup', t.top + 2);
    return document.querySelector('.sw-text').value;
  })()`);
  check(moved === 'r2(A) r1(A) w1(A) c1 w2(A) c2', 'dragging moves the operation: ' + moved);
  check(await verdict('Serial') === 'no' && await verdict('Conflict serializable') === 'no', 'the verdicts follow the drag');
  // keyboard: move it back down
  await b.eval(`document.querySelector('.sw-op[data-i="0"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); 1`);
  check(await b.eval(`document.querySelector('.sw-text').value`) === 'r1(A) r2(A) w1(A) c1 w2(A) c2', 'the arrow keys move an operation');
  // under protocols
  await setText('r1(A) r2(A) w1(A) w2(A) c1 c2');
  await b.sleep(450);
  await b.eval(`(() => { const s = document.querySelector('.sw-sim select'); s.value = '2pl'; s.dispatchEvent(new Event('change')); })(); 1`);
  check(await count(b, '.sw-steps tr.wait') >= 2 && /Deadlocks/.test(await text(b, '.sw-out')), 'under 2PL: both wait, a deadlock');
  await b.eval(`(() => { const s = document.querySelector('.sw-sim select'); s.value = 'to'; s.dispatchEvent(new Event('change')); })(); 1`);
  check(/aborted/.test(await text(b, '.sw-out')), 'under timestamp ordering one is rolled back');
  await setText('r1(A) w2(A) c2 w1(A) c1');
  await b.sleep(450);
  await b.eval(`(() => { const s = document.querySelector('.sw-sim select'); s.value = 'thomas'; s.dispatchEvent(new Event('change')); })(); 1`);
  check(/Ignored.*w1\(A\)/.test(await text(b, '.sw-out')), 'Thomas\' write rule ignores w1(A)');
  await b.eval(`document.querySelector('.sw-sim').scrollIntoView(); 1`);
  await shot(b, 'schedule-protocol-light');
  // an exercise, answered correctly
  await b.eval(`document.querySelector('.sw-head .btn').click(); 1`);
  await b.eval(`document.querySelectorAll('.menu-item')[1].click(); 1`);
  check(await count(b, '.sw-ex') === 1 && await count(b, '.sw-v') === 0, 'an exercise hides the verdicts');
  const answers = await b.eval(`(() => { const a = K.Schedule.classify(document.querySelector('.sw-text').value); return { conflictSerializable: a.conflictSerializable, viewSerializable: a.viewSerializable, recoverable: a.recoverable, cascadeless: a.cascadeless, strict: a.strict, order: a.order }; })()`);
  for (const k of ['conflictSerializable', 'viewSerializable', 'recoverable', 'cascadeless', 'strict']) await b.eval(`document.querySelector('.sw-q button[data-q="${k}"][data-v="${answers[k] !== false}"]').click(); 1`);
  if (answers.conflictSerializable) await b.eval(`(() => { const i = document.querySelector('.sw-ord'); i.value = ${J(answers.order.map((t) => 'T' + t).join(', '))}; i.dispatchEvent(new Event('input')); })(); 1`);
  await b.eval(`document.querySelector('.sw-check').click(); 1`);
  check(/(\d) of \1 right/.test(await text(b, '.sw-score')), 'the right answers score full marks: ' + await text(b, '.sw-score'));
  check(await count(b, '.sw-v') === 6, 'checking shows the verdicts');
  await shot(b, 'schedule-exercise-light');
  await theme(b, 'dark');
  await shot(b, 'schedule-exercise-dark');
  check(errors(b).length === 0, 'no console errors (schedule): ' + J(errors(b).slice(0, 3)));
  await b.close();
}

// ---- phone width ----------------------------------------------------------------------------------------------------------------
{
  const b = await start(390, 844);
  await b.eval(`K.app.dock.close('plan'); K.app.openView('txn'); 1`);
  await setup(b, 'deadlock');
  await steps(b, 6);
  check(await b.eval(`document.documentElement.scrollWidth <= innerWidth + 1`), 'no horizontal page scroll at 390 px');
  check(await b.eval(`(() => { const r = document.querySelector('.tx-runstep').getBoundingClientRect(); return r.width > 0 && r.right <= innerWidth; })()`), 'the step button is on screen');
  await shot(b, 'txn-phone-light');
  await subtab(b, 'locks');
  await shot(b, 'txn-phone-locks-light');
  await theme(b, 'dark');
  await b.eval(`K.app.openView('schedule'); 1`);
  check(await b.eval(`document.documentElement.scrollWidth <= innerWidth + 1`), 'the schedule workbench fits at 390 px');
  await shot(b, 'schedule-phone-dark');
  check(errors(b).length === 0, 'no console errors (phone): ' + J(errors(b).slice(0, 3)));
  await b.close();
}

console.log(passes + ' passed, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
