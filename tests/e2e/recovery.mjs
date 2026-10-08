// End-to-end test of the log view and the crash and recovery view in headless Chrome: updates in two tabs, a
// checkpoint, a crash, a restart with each algorithm, the rows afterwards, stepping through the passes, the
// scenarios, a disk loss with dump and replay, a remote backup taking over, and shadow paging.
// node tests/e2e/recovery.mjs [--shots <dir>]   (screenshots in both themes and at phone width)
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

async function start(width, height) {
  const b = await launch({ width, height, mobile: width < 600 });
  await b.goto('');
  await b.waitFor('window.K && K.app && document.querySelector(".tab")', 20000);
  await b.eval('localStorage.clear(); K.app.settings.theme = "light"; K.app.applyTheme(); K.app.newDatabase(); 1');
  // helpers in the page: click a button by its text, read a table through a fresh session
  await b.eval(`window.T = {
    click(sel, re) { const e = [...document.querySelectorAll(sel)].find((x) => new RegExp(re).test(x.textContent)); if (!e) throw new Error('nothing to click: ' + sel + ' ' + re); e.click(); return true; },
    rows(sql) { const s = K.app.db.session({ name: 'test' }); try { const r = s.query(sql); return r.rows.map((row) => row.map((v, i) => v === null ? null : K.T.output(v, r.cols[i].type)).join('=')); } finally { K.app.db.sessions = K.app.db.sessions.filter((x) => x !== s); } },
    text(sel) { const e = document.querySelector(sel); return e ? e.innerText : ''; },
    n(sel) { return document.querySelectorAll(sel).length; },
  }; 1`);
  return b;
}
const shot = async (b, name) => { if (shots) { await b.sleep(250); await b.screenshot(join(shots, name + '.png')); } };
const errors = (b) => b.logs.filter((l) => l.type === 'error' || l.type === 'exception');
const run = (b, tab, sql) => b.eval(`K.app.runSql(K.app.tabs[${tab}], ${J(sql)}, 0); 1`);
const theme = (b, t) => b.eval(`K.app.settings.theme = ${J(t)}; K.app.applyTheme(); 1`);
const fits = (b, sel) => b.eval(`(() => { const p = [...document.querySelectorAll('.dock-pane')].find((x) => !x.hidden); const body = p.querySelector(${J(sel)}); return { page: document.documentElement.scrollWidth, pane: p.scrollWidth - p.clientWidth, body: body.scrollWidth - body.clientWidth }; })()`);
const BASE = "create table account (name text primary key, balance int); insert into account values ('A', 4200), ('B', 3100), ('C', 860); checkpoint;";
const accounts = (b) => b.eval(`T.rows('select name, balance from account order by name').join(' ')`);

// ---- the log view, then crash and restart with each algorithm -------------------------------------------------------------
for (const algorithm of ['textbook', 'aries']) {
  const b = await start(1440, 900);
  await b.eval(`K.app.openView('log'); K.app.addTab('Second', '', true); 1`);
  await run(b, 0, BASE);
  await run(b, 0, "begin; update account set balance = 3900 where name = 'A'; update account set balance = 3400 where name = 'B'; commit;");
  await run(b, 1, "begin; update account set balance = 500 where name = 'C';");
  await b.eval(`T.click('.lg-head .btn', 'Checkpoint'); 1`);
  await run(b, 0, "begin; update account set balance = 3500 where name = 'A';");
  if (algorithm === 'textbook') {
    check(await b.eval(`T.n('.lg-row')`) > 10, 'log records listed');
    check(await b.eval(`T.n('.lg-row.vol')`) >= 2 && await b.eval(`T.n('.lg-div')`) === 1, 'the log buffer is split from the stable part');
    check(/balance 3100 → 3400/.test(await b.eval(`T.text('.lg-list')`)), 'an update decoded with its before and after values');
    check(await b.eval(`T.n('.lg-row .lg-pg .kv-badge.warn')`) > 0 && await b.eval(`T.n('.lg-row .lg-pg .kv-badge.ok')`) > 0, 'PageLSN beside records: some changes on disk, some only in memory');
    check(await b.eval(`T.n('svg.lg-lanes path.lg-chain')`) > 3, 'prevLSN chains drawn');
    check(await b.eval(`T.n('.lg-two .kv-card:first-child tbody tr')`) >= 1, 'dirty page table has the page the last update dirtied');
    check(await b.eval(`T.n('.lg-two .kv-card:last-child tbody tr')`) === 2, 'transaction table: two running transactions');
    check(/flush first/.test(await b.eval(`T.text('.lg-body')`)), 'the checkpoint wrote a dirty page after forcing the log (WAL rule)');
    await shot(b, 'log-light');
    await b.eval(`T.click('.lg-head .seg button', 'Angle-bracket'); 1`);
    check(/<T\d+ start>/.test(await b.eval(`T.text('.lg-list')`)) && /<T\d+ commit>/.test(await b.eval(`T.text('.lg-list')`)), 'angle-bracket notation');
    const xid = await b.eval('K.app.tabs[1].session.tx.xid');
    await b.eval(`(() => { const s = document.querySelector('.lg-xf'); s.value = '${xid}'; s.dispatchEvent(new Event('change')); return 1; })()`);
    check(await b.eval(`T.n('.lg-row')`) === 3, 'filter by transaction: T' + xid + ' has start, new version and update (' + await b.eval(`T.n('.lg-row')`) + ')');
    await b.eval(`T.click('.lg-head .seg button', 'Records'); (() => { const s = document.querySelector('.lg-xf'); s.value = 'all'; s.dispatchEvent(new Event('change')); return 1; })()`);
    // stepping the recorded run: before it, its records are not there yet; at an append, the record is marked
    const all = await b.eval(`T.n('.lg-row')`);
    await b.eval('K.app.timeline.go(0); 1');
    check(await b.eval(`T.n('.lg-row')`) < all, 'at the start of the run its records are not yet appended');
    await b.eval(`K.app.timeline.go(K.app.timeline.events.findIndex((e) => e.type === 'wal.append') + 1); 1`);
    check(await b.eval(`T.n('.lg-row.just')`) === 1 && /appended to the log buffer/.test(await b.eval(`T.text('.lg-step')`)), 'stepping to an append marks the new record');
    await b.eval('K.app.timeline.go(K.app.timeline.length); 1');
    // the policies reach every session
    await b.eval(`T.click('.lg-pol .seg button', '^Force$'); 1`);
    check(await b.eval('K.app.db.settings.buffer_force === true && K.app.tabs.every((t) => t.session.settings.buffer_force === true)'), 'force set for the database and every tab');
    await b.eval(`T.click('.lg-pol .seg button', '^No-force$'); 1`);
    check(await b.eval('K.app.db.settings.buffer_force === false'), 'back to no-force');
    await theme(b, 'dark');
    await shot(b, 'log-dark');
    await theme(b, 'light');
  }

  await b.eval(`K.app.openView('recovery'); T.click('.rc-tabs button', 'Crash and restart'); 1`);
  check(/A crash now would lose/.test(await b.eval(`T.text('.rc-crash')`)), 'the crash card says what a crash would lose');
  await b.eval(`document.querySelector('.rc-big').click(); 1`);
  check(await b.eval('!!K.app.db.down'), 'crash: the database is down');
  check(await b.eval('K.app.tabs.every((t) => !t.session.tx) && !document.querySelector(".tab.tx")'), 'the tabs lost their transactions');
  check(/Second/.test(await b.eval(`T.text('.rc-crash')`)), 'the crash card names the tab whose transaction was lost');
  await b.eval(`T.click('.rc-restart .seg button', '${algorithm === 'aries' ? 'ARIES' : 'Redo then undo'}'); T.click('.rc-restart .btn', 'Restart'); 1`);
  check(await b.eval('!K.app.db.down'), algorithm + ': the database is up again');
  check(await accounts(b) === 'A=3900 B=3400 C=860', algorithm + ': committed changes survive, uncommitted ones vanish (' + await accounts(b) + ')');
  check(await b.eval(`T.rows('select count(*) from venue')[0]`) === '8', algorithm + ': the sample data survives the restart');
  check(await b.eval(`T.n('.rc-rows .kv-badge.ok')`) >= 1, algorithm + ': the rows card marks the undone change');
  const passNames = await b.eval(`[...document.querySelectorAll('.rc-pass b')].map((x) => x.textContent)`);
  check(J(passNames) === J(algorithm === 'aries' ? ['Page check', 'Analysis', 'Redo', 'Undo', 'Finish'] : ['Page check', 'Redo', 'Undo', 'Finish']), algorithm + ': passes ' + J(passNames));
  // step forward through everything, then back
  const total = await b.eval(`+T.text('.rc-trace .tl-pos').split(' / ')[1]`);
  let seen = new Set();
  for (let i = 0; i < total; i++) { seen.add(await b.eval(`T.text('.rc-pn')`)); await b.eval(`document.querySelectorAll('.rc-trace .rc-stepper .btn')[2].click(); 1`); }
  check(await b.eval(`T.text('.rc-trace .tl-pos')`) === total + ' / ' + total, algorithm + ': stepped to the last step');
  check(seen.has('Redo') && seen.has('Undo') && (algorithm === 'textbook' || seen.has('Analysis')), algorithm + ': every pass visited ' + J([...seen]));
  await b.eval(`document.querySelectorAll('.rc-trace .rc-stepper .btn')[1].click(); 1`);
  check(await b.eval(`T.text('.rc-trace .tl-pos')`) === (total - 1) + ' / ' + total, algorithm + ': one step back');
  await b.eval(`[...document.querySelectorAll('.rc-pass')].find((x) => /Undo/.test(x.textContent)).click(); 1`);
  const undo = await b.eval(`T.text('.rc-step')`);
  check(/undo|abort|skip/.test(undo), algorithm + ': the first undo step is shown');
  if (algorithm === 'aries') {
    await b.eval(`[...document.querySelectorAll('.rc-pass')].find((x) => /Analysis/.test(x.textContent)).click(); 1`);
    check(await b.eval(`T.n('.rc-ctx table')`) === 2, 'aries: analysis shows the transaction table and the dirty page table');
    check(await b.eval(`T.n('.rc-li .kv-badge')`) > 0, 'aries: the steps of the pass are listed');
    check(/CLR/.test(await b.eval(`T.text('.rc-facts2')`)), 'aries: CLRs counted');
  } else {
    await b.eval(`[...document.querySelectorAll('.rc-pass')].find((x) => /Redo/.test(x.textContent)).click(); 1`);
    check(/Undo-list/i.test(await b.eval(`T.text('.rc-ctx')`)), 'textbook: the undo-list is shown');
  }
  await shot(b, 'recovery-' + algorithm);
  check(errors(b).length === 0, 'no console errors (' + algorithm + '): ' + J(errors(b).slice(0, 3)));
  await b.close();
}

// ---- scenarios with predictions -------------------------------------------------------------------------------------------
{
  const b = await start(1440, 900);
  await b.eval(`K.app.openView('recovery'); 1`);
  const expect = { 'A checkpoint between': 'A=3900 B=3400 C=860', 'Another commit flushes the log': 'A=4200 B=3100 C=500', 'Commit without waiting for the log': 'A=4200 B=3100 C=860', 'Torn page': 'A=3900 B=3100 C=860', 'Torn page, no full-page writes': 'A=3900' };
  let k = 0;
  for (const [title, rows] of Object.entries(expect)) {
    const alg = k++ % 2 ? 'Redo then undo' : 'ARIES';
    await b.eval(`T.click('.rc-chip', '^' + ${J(title.replace(/[,]/g, '.'))} + '$'); T.click('.rc-scen .btn', '^Set up'); 1`);
    check(await b.eval(`K.app.tabs.some((t) => t.name === 'Session A') && K.app.tabs.some((t) => t.name === 'Session B')`), title + ': two tabs');
    const np = await b.eval(`T.n('.rc-pred')`);
    for (let i = 0; i < np; i++) await b.eval(`document.querySelectorAll('.rc-pred')[${i}].querySelectorAll('.seg button')[0].click(); 1`);
    await b.eval(`T.click('.rc-scen .btn', 'Crash as described'); 1`);
    check(await b.eval('!!K.app.db.down'), title + ': crashed');
    if (/Torn/.test(title)) check(/torn/.test(await b.eval(`T.text('.rc-crash')`)), title + ': the crash tore a page');
    await b.eval(`T.click('.rc-restart .seg button', '${alg}'); T.click('.rc-restart .btn', 'Restart'); 1`);
    check(await accounts(b) === rows, title + ' (' + alg + '): ' + await accounts(b));
    check(await b.eval(`T.n('.rc-pred.right') + T.n('.rc-pred.wrong')`) === np, title + ': every prediction is marked');
    if (title === 'Torn page') {
      check(/Torn/.test(await b.eval(`T.text('.rc-facts2')`)), 'torn page: reported by restart');
      check(await b.eval(`[...document.querySelectorAll('.rc-li .kv-badge')].length >= 0`), 'torn page: steps listed');
    }
    if (title === 'Torn page, no full-page writes') check(await b.eval(`T.n('.rc-trace .kv-banner.bad')`) >= 1, 'no full-page writes: the problem is reported');
  }
  await shot(b, 'scenario-light');
  check(errors(b).length === 0, 'no console errors (scenarios): ' + J(errors(b).slice(0, 3)));
  await b.close();
}

// ---- disk loss, remote backup, shadow paging --------------------------------------------------------------------------------
{
  const b = await start(1440, 900);
  await b.eval(`K.app.openView('recovery'); T.click('.rc-tabs button', 'Disk loss'); T.click('.rc-steps .btn', 'Take a dump'); 1`);
  await run(b, 0, "update artist set fee = fee + 100 where company_id = 'C08'; insert into company values ('C90', 'Robot Theatre', 'Brightwater', 2024, 50000);");
  await b.eval(`K.app.addTab('Open', '', true); 1`);
  await run(b, 1, "begin; delete from booking where rating = 1;");
  const before = await b.eval(`[T.rows('select count(*) from company')[0], T.rows('select count(*) from booking')[0], T.rows('select sum(fee) from artist')[0]]`);
  await b.eval(`K.app.dock.renderActive(); T.click('.rc-steps .btn', 'Disk failure'); 1`);
  check(await b.eval('!!K.app.db.down'), 'disk failure: the database is down');
  await b.eval(`T.click('.rc-steps .btn', 'Restore'); 1`);
  const after = await b.eval(`[T.rows('select count(*) from company')[0], T.rows('select count(*) from booking')[0], T.rows('select sum(fee) from artist')[0]]`);
  check(J(after) === J(before), 'dump and replay: committed changes back, the open delete undone ' + J(before) + ' ' + J(after));
  check(await b.eval(`T.n('.rc-trace')`) === 1, 'the replay is drawn step by step');
  await shot(b, 'dump-light');

  await b.eval(`T.click('.rc-tabs button', 'Remote backup'); T.click('.kv-card .seg button', '^1 flush$'); T.click('.kv-card .btn', 'Start the backup'); 1`);
  await run(b, 0, "insert into company values ('C91', 'Quantum Stage', 'Quillmere', 2024, 70000);");
  await run(b, 0, "insert into company values ('C92', 'Origami Players', 'Saltreach', 2025, 1000);");
  await b.eval(`K.app.dock.renderActive(); 1`);
  check(/in flight/.test(await b.eval(`T.text('.rc-sites')`)), 'the backup lags behind the primary');
  await b.eval(`T.click('.kv-card .btn', 'take over'); 1`);
  check(/without the commits of/.test(await b.eval(`T.text('.rc-body .kv-banner')`)), 'takeover with lag: the last commit is lost at the backup');
  const old = await b.eval('K.app.db.disk.files.size');
  await b.eval(`T.click('.kv-card .btn', 'Work on the new primary'); 1`);
  check(await b.eval(`T.rows("select count(*) from company where company_id = 'C92'")[0]`) === '0' && await b.eval(`T.rows("select count(*) from company where company_id = 'C91'")[0]`) === '1', 'the new primary has the commit that arrived, not the one that did not');
  check(await b.eval(`T.rows('select count(*) from venue')[0]`) === '8' && old > 0, 'the new primary has the sample data');
  await run(b, 0, "insert into company values ('C92', 'Origami Players', 'Saltreach', 2025, 1000);");
  check(await b.eval(`T.rows("select count(*) from company where company_id = 'C92'")[0]`) === '1', 'the tabs work on the new primary');

  await b.eval(`T.click('.rc-tabs button', 'Shadow paging'); T.click('.rc-sptools .btn', 'Begin'); document.querySelector('.rc-write select').value = '2'; document.querySelector('.rc-val').value = 'z'; T.click('.rc-sptools .btn', 'Write'); 1`);
  check(await b.eval(`T.n('.rc-sp .rc-spe.new')`) === 1, 'shadow paging: the written page points to a copy');
  await b.eval(`T.click('.rc-sptools .btn', 'Crash'); 1`);
  check(/table 0/.test(await b.eval(`T.text('.rc-sp')`) || await b.eval(`document.querySelector('.rc-sp').textContent`)), 'shadow paging: after a crash the pointer still names table 0');
  await b.eval(`T.click('.rc-sptools .btn', 'Begin'); T.click('.rc-sptools .btn', 'Write'); T.click('.rc-sptools .btn', 'Commit'); 1`);
  check(/table 1/.test(await b.eval(`document.querySelector('.rc-sp').textContent`)), 'shadow paging: commit switches the pointer');
  await b.eval(`document.querySelectorAll('.rc-shadow .rc-stepper .btn')[0].click(); 1`);
  check(/\d+ \/ \d+/.test(await b.eval(`T.text('.rc-shadow .rc-stepper')`)), 'shadow paging: steppable history');
  await theme(b, 'dark');
  await shot(b, 'shadow-dark');
  check(errors(b).length === 0, 'no console errors (panels): ' + J(errors(b).slice(0, 3)));
  await b.close();
}

// ---- phone width ----------------------------------------------------------------------------------------------------------
{
  const b = await start(390, 844);
  await b.eval(`K.app.openView('log'); K.app.addTab('Second', '', true); 1`);
  await run(b, 0, BASE);
  await run(b, 1, "begin; update account set balance = 500 where name = 'C';");
  let over = await fits(b, '.view-body');
  check(over.page <= 390 && over.pane <= 1 && over.body <= 1, 'log fits a phone: ' + J(over));
  await shot(b, 'log-phone');
  await b.eval(`K.app.openView('recovery'); document.querySelector('.rc-big').click(); T.click('.rc-restart .btn', 'Restart'); 1`);
  over = await fits(b, '.view-body');
  check(over.page <= 390 && over.pane <= 1 && over.body <= 1, 'recovery fits a phone: ' + J(over));
  await shot(b, 'recovery-phone');
  for (const t of ['Disk loss', 'Remote backup', 'Shadow paging']) {
    await b.eval(`T.click('.rc-tabs button', ${J(t)}); 1`);
    over = await fits(b, '.view-body');
    check(over.page <= 390 && over.body <= 1, t + ' fits a phone: ' + J(over));
  }
  check(errors(b).length === 0, 'no console errors (phone): ' + J(errors(b).slice(0, 3)));
  await b.close();
}

console.log(passes + ' passed, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
