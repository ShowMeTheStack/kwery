// End-to-end test of the Blockchain, Tuning, Data cube and Streams views in headless Chrome.
// node tests/e2e/advanced.mjs [--shots <dir>] [--no-build]   (screenshots of each view, both themes and phone width)
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../../tools/cdp.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const si = process.argv.indexOf('--shots');
const shots = si >= 0 ? process.argv[si + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });
if (!process.argv.includes('--no-build')) execFileSync('node', [join(root, 'build.mjs')], { stdio: 'ignore' });

let fails = 0, passes = 0;
const check = (ok, what) => { if (ok) passes++; else { fails++; console.log('FAIL ' + what); } };
const J = JSON.stringify;

async function start(width, height, theme) {
  const b = await launch({ width, height, mobile: width < 600 });
  await b.goto('');
  await b.waitFor('window.K && K.app && document.querySelector(".tab")', 30000);
  await b.eval(`localStorage.clear(); K.app.settings.theme = ${J(theme || 'light')}; K.app.applyTheme(); 1`);
  return b;
}
const shot = async (b, name) => { if (shots) { await b.sleep(250); await b.screenshot(join(shots, name + '.png')); } };
const errors = (b) => b.logs.filter((l) => l.type === 'error' || l.type === 'exception');
const pane = (sel) => `document.querySelector('.dock-pane:not([hidden]) ${sel}')`;
const count = (b, sel) => b.eval(`document.querySelectorAll('.dock-pane:not([hidden]) ' + ${J(sel)}).length`);
const text = (b, sel) => b.eval(`(() => { const e = ${pane(sel)}; return e ? e.innerText : null; })()`);
/** click the button in the open view whose text matches */
const press = (b, re) => b.eval(`(() => { const x = [...document.querySelectorAll('.dock-pane:not([hidden]) button')].find((e) => ${re}.test(e.textContent) && !e.disabled); if (!x) return false; x.click(); return true; })()`);
const setInput = (b, sel, i, value) => b.eval(`(() => { const e = document.querySelectorAll('.dock-pane:not([hidden]) ' + ${J(sel)})[${i}]; e.value = ${J(String(value))}; e.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
const top = (b, y) => b.eval(`(${pane('.adv-body')}.scrollTop = ${y}, 1)`);
const sql1 = (b, sql) => b.eval(`(() => { const s = K.app.db.session({ name: 't' }); try { const r = s.exec(${J(sql)}); const x = r[r.length - 1]; return x.rows.map((row) => row.map((v) => v === null ? null : typeof v === 'bigint' ? Number(v) : typeof v === 'object' ? String(K.T.output(v, x.cols[0].type)) : v)); } finally { K.app.db.sessions = K.app.db.sessions.filter((y) => y !== s); } })()`);
const lastRun = (b) => b.eval(`(() => { const r = K.app.tab.run; if (!r) return null; return r.results.map((x) => ({ tag: x.tag, error: x.error ? x.error.message : null, rows: x.rows ? x.rows.length : null })); })()`);

// ---- blockchain --------------------------------------------------------------------------------------------------------------------
{
  const b = await start(1440, 900);
  await b.eval(`K.app.openView('blockchain'); K.app.dock.toggleMax(true); 1`);
  check(await b.eval('K.app.dock.active') === 'blockchain', 'blockchain view opens');
  check(/append-only log/.test(await text(b, '.view-intro')), 'blockchain explains itself');
  // the JS SHA-256 agrees with the browser's
  const shaOk = await b.eval(`(async () => { for (const s of ['', 'abc', 'Alice→Bob:25', 'x'.repeat(1000), 'é and 日本']) { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); const hex = [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join(''); if (hex !== K.UI.sha256(s)) return s; } return true; })()`);
  check(shaOk === true, 'SHA-256 matches crypto.subtle (' + shaOk + ')');
  check(await count(b, '.bc-card') === 4 && await count(b, '.bc-card.bad') === 0, 'a valid chain of 4 blocks');
  check(/The chain verifies/.test(await text(b, '.bc-verdict')), 'verdict: the chain verifies');
  await shot(b, 'chain-light');
  // tamper with a transaction of block 1: blocks 1 to 3 fail
  await b.eval(`document.querySelectorAll('.dock-pane:not([hidden]) .bc-card')[1].click(); 1`);
  await setInput(b, '.grid input.bc-amt', 0, 20);
  check(await count(b, '.bc-card.bad') === 3, 'tampering block 1 breaks blocks 1-3');
  check(/Verification fails at block 1/.test(await text(b, '.bc-verdict')), 'verdict names block 1');
  check(await count(b, '.bc-link.bad') === 2, 'the hash pointers after it are marked');
  await shot(b, 'chain-tampered');
  // history: back restores, forward breaks again
  await b.eval(`document.querySelector('.adv-hist button[title="Back one step"]').click(); 1`);
  check(await count(b, '.bc-card.bad') === 0, 'back one step: valid again');
  await b.eval(`document.querySelector('.adv-hist button[title="Forward one step"]').click(); 1`);
  check(await count(b, '.bc-card.bad') === 3, 'forward: tampered again');
  // mine block 1 again: it is valid, block 2 now points at the old hash
  await press(b, /Mine it again/);
  await b.waitFor(`!document.querySelector('.adv-busy') && document.querySelectorAll('.bc-card.bad').length === 2`, 20000);
  check(await b.eval(`!document.querySelectorAll('.bc-card')[1].classList.contains('bad')`), 're-mined block 1 is valid');
  check(/block 2/.test(await text(b, '.bc-verdict')), 'now block 2 fails (stale prev pointer)');
  await b.eval(`document.querySelectorAll('.dock-pane:not([hidden]) .bc-card')[2].click(); 1`);
  await press(b, /Repair the rest/);
  await b.waitFor(`!document.querySelector('.adv-busy') && document.querySelectorAll('.bc-card.bad').length === 0`, 30000);
  check(/Mined blocks 2–3 again/.test(await b.eval(`document.querySelector('.adv-hl').textContent`)), 'repair mines the later blocks');
  // a new block from the pool: the contract rejects the overdraft
  await press(b, /Mine a block/);
  await b.waitFor(`document.querySelectorAll('.bc-card').length === 5 && !document.querySelector('.adv-busy')`, 20000);
  check(/rejected Carol → Alice 500/.test(await b.eval(`document.querySelector('.adv-hl').textContent`)), 'the contract rejects a transfer the balance does not cover');
  check(await count(b, '.adv-kpi') >= 4, 'mining shows attempts and time');
  // Merkle proof of the second transaction
  await b.eval(`document.querySelectorAll('.dock-pane:not([hidden]) .bc-card')[2].click(); 1`);
  await b.eval(`document.querySelectorAll('.bc-merkle .bc-mn.leaf')[1].dispatchEvent(new MouseEvent('click', { bubbles: true })); 1`);
  check(await count(b, '.bc-mn.proof') >= 2 && await count(b, '.bc-pv.ok') === 1, 'Merkle proof drawn and checked');
  await top(b, 700);
  await shot(b, 'chain-merkle');
  // forks and the longest-chain rule
  await b.eval(`[...document.querySelectorAll('.adv-seg button')].find((x) => x.textContent === 'Forks').click(); 1`);
  await press(b, /mine at once/);
  check(/disagree/.test(await text(b, '.bc-forks .bc-verdict')), 'two miners at once: a fork');
  await press(b, /^B mines/);
  check(/agree/.test(await text(b, '.bc-forks .bc-verdict')) && /Stale/.test(await text(b, '.bc-forks .bc-verdict')), 'longest chain wins, one block is stale');
  check(await count(b, '.bc-tb.stale') === 1, 'the stale block is drawn');
  await shot(b, 'chain-forks');
  await b.eval(`[...document.querySelectorAll('.adv-seg button')].find((x) => x.textContent === 'vs. Raft').click(); 1`);
  check(/Byzantine/.test(await text(b, '.bc-cmp')), 'comparison with Raft');
  await press(b, /Open the Raft cluster/);
  check(await b.eval('K.app.dock.active') === 'cluster', 'opens the cluster view');
  check(!errors(b).length, 'blockchain: no console errors ' + J(errors(b)));
  await b.close();
}

// ---- data cube -------------------------------------------------------------------------------------------------------------------------
{
  const b = await start(1440, 900);
  await b.eval(`K.app.openView('cube'); K.app.dock.toggleMax(true); 1`);
  await b.waitFor(`document.querySelector('.ox-xt')`, 15000);
  const fact = 'from booking b join performance f on f.perf_id = b.perf_id join production p on p.prod_id = f.prod_id join venue v on v.venue_code = f.venue_code';
  const n = (await sql1(b, 'select count(*) ' + fact))[0][0];
  const g = async () => +(await text(b, '.ox-g')).replace(/,/g, '');
  check(await g() === n, 'grand total = rows of the fact join (' + n + ')');
  const genres = (await sql1(b, 'select count(distinct p.genre) ' + fact))[0][0];
  check(await count(b, '.ox-xt tbody tr') === genres + 1, 'a row per genre and the all row');
  const bio = (await sql1(b, "select count(*) " + fact + " where p.genre = 'drama' and extract(year from f.perf_date) = 2025"))[0][0];
  const cell = await b.eval(`(() => { const tr = [...document.querySelectorAll('.ox-xt tbody tr')].find((r) => r.querySelector('th').textContent === 'drama'); const ths = [...document.querySelectorAll('.ox-xt thead th')]; const i = ths.findIndex((t) => t.textContent === '2025'); return tr.children[i].textContent; })()`);
  check(+cell === bio, 'cell drama × 2025 = ' + bio);
  await shot(b, 'cube-light');
  // pivot swaps the axes
  await press(b, /^Pivot$/);
  check(/^Time/.test(await text(b, '.ox-corner')), 'pivot puts time on the rows');
  await press(b, /^Pivot$/);
  // drill down into one genre: its productions, rolled up again
  await b.eval(`[...document.querySelectorAll('.ox-rh .ox-drill')].find((x) => x.textContent === 'opera').click(); 1`);
  const ops = (await sql1(b, "select count(distinct p.title) " + fact + " where p.genre = 'opera'"))[0][0];
  check(await count(b, '.ox-xt tbody tr') === ops + 1, 'drill down: one row per opera production (' + ops + ')');
  check(/production/.test(await text(b, '.ox-corner')), 'level is now production');
  await press(b, /▴ genre/);
  check(await count(b, '.ox-xt tbody tr') === genres + 1, 'roll up: genres again');
  // drill down on time to months
  await press(b, /▾ month/);
  check(await b.eval(`[...document.querySelectorAll('.ox-xt thead th')].some((t) => /^\\d{4}-\\d{2}$/.test(t.textContent))`), 'time drilled down to months');
  await press(b, /▴ year/);
  // dice: leave out 2024
  await b.eval(`[...document.querySelectorAll('.ox-chip')].find((x) => x.textContent === '2024').click(); 1`);
  const no24 = (await sql1(b, 'select count(*) ' + fact + ' where extract(year from f.perf_date) <> 2024'))[0][0];
  check(await g() === no24, 'dice without 2024: total ' + no24);
  check(/year <> 2024/.test(await text(b, '.adv-sqlbox')), 'the SQL has the filter');
  // the SQL behind the view runs and gives the same grand total
  await b.eval(`document.querySelector('.dock-pane:not([hidden]) .adv-sqlbox .adv-run').click(); 1`);
  const res = await b.eval(`(() => { const r = K.app.tab.run.results; const x = r[r.length - 1]; if (x.error) return x.error.message; const row = x.rows.find((row) => Number(row[3]) === 1 && Number(row[4]) === 1); return row ? Number(row[2]) : null; })()`);
  check(res === no24, 'the SQL computes the same grand total (' + res + ')');
  // the lattice: 16 group-bys, each with its query
  check(await count(b, '.ox-ln') === 16, 'a lattice of 2^4 group-bys');
  check(await count(b, '.ox-ln.used') === 4, 'the cross-tab uses four of them');
  await b.eval(`document.querySelectorAll('.ox-ln')[15].dispatchEvent(new MouseEvent('click', { bubbles: true })); 1`);
  check(/grouping sets \(\(\)\)/.test(await b.eval(`[...document.querySelectorAll('.dock-pane:not([hidden]) .adv-sqlbox')].map((x) => x.innerText).join('\\n')`)), 'the empty group-by has its own query');
  await top(b, 9999);
  await shot(b, 'cube-lattice');
  // another table: any columns as dimensions
  await b.eval(`(() => { const s = document.querySelector('.dock-pane:not([hidden]) .view-head select'); s.value = 'custom'; s.dispatchEvent(new Event('change')); return 1; })()`);
  await b.eval(`(() => { const s = [...document.querySelectorAll('.dock-pane:not([hidden]) .adv-body select')][0]; s.value = 'artist'; s.dispatchEvent(new Event('change')); return 1; })()`);
  for (const c of ['company_id', 'fee']) await b.eval(`(() => { const i = [...document.querySelectorAll('.ox-cp')].find((l) => l.textContent === ${J(c)}).querySelector('input'); i.checked = true; i.dispatchEvent(new Event('change')); return 1; })()`);
  check(await count(b, '.ox-xt') === 1 && +(await text(b, '.ox-g')).replace(/,/g, '') === (await sql1(b, 'select count(*) from artist'))[0][0], 'a cube over artist (company_id × fee)');
  check(await count(b, '.ox-ln') === 4, 'two dimensions: a lattice of 4');
  check(!errors(b).length, 'cube: no console errors ' + J(errors(b)));
  await b.close();
}

// ---- streams --------------------------------------------------------------------------------------------------------------------------
{
  const b = await start(1440, 900);
  await b.eval(`K.app.openView('stream'); K.app.dock.toggleMax(true); 1`);
  const arrived = async () => +(/(\d+) events? arrived/.exec(await b.eval(`document.querySelector('.adv-hl').textContent`)) || [0, -1])[1];
  const a0 = await arrived();
  check(a0 > 0, 'events have arrived at the start position (' + a0 + ')');
  check(await count(b, '.ds-ev') === a0, 'one mark per arrived event');
  await b.eval(`document.querySelector('.adv-hist button[title="Forward to the next arrival"]').click(); 1`);
  check(await arrived() > a0, 'stepping forward brings the next event');
  await b.eval(`document.querySelector('.adv-hist button[title="Back to the previous arrival"]').click(); 1`);
  check(await arrived() === a0, 'and back');
  check(await count(b, '.ds-wm') === 1, 'the watermark is drawn');
  check(await count(b, '.ds-win.open') >= 1 && await count(b, '.ds-win.done') >= 1, 'open and emitted windows');
  await shot(b, 'stream-tumbling');
  // to the end: the final watermark emits every window
  await b.eval(`document.querySelector('.adv-hist button[title="To the end of the stream"]').click(); 1`);
  check(await count(b, '.ds-win.open') === 0, 'at the end every window is emitted');
  const total = await b.eval(`[...document.querySelectorAll('.ds-res tbody tr')].reduce((a, tr) => a + Number(tr.children[1].textContent), 0)`);
  const dropped = await b.eval(`[...document.querySelectorAll('.ds-res tbody tr')].reduce((a, tr) => a + Number(tr.lastChild.textContent || 0), 0)`);
  const all = +(/\/ (\d+)/.exec(await text(b, '.adv-kpi')) || [0, 0])[1];
  check(total + dropped === all, 'tumbling windows: every event counted once or dropped (' + total + ' + ' + dropped + ' = ' + all + ')');
  // the SQL over the stream table: one row per non-empty window, the same counts plus the dropped ones
  await b.eval(`document.querySelector('.dock-pane:not([hidden]) .adv-sqlbox .adv-run').click(); 1`);
  const run = await lastRun(b);
  check(run && !run.some((x) => x.error), 'the stream SQL runs ' + J(run && run.filter((x) => x.error)));
  const sqlCounts = await b.eval(`(() => { const r = K.app.tab.run.results; return r[r.length - 1].rows.map((x) => Number(x[1])); })()`);
  check(sqlCounts.reduce((a, x) => a + x, 0) === all, 'SQL counts every event (' + sqlCounts.reduce((a, x) => a + x, 0) + ')');
  for (const kind of ['Hopping', 'Session']) {
    await b.eval(`[...document.querySelectorAll('.adv-seg button')].find((x) => x.textContent === ${J(kind)}).click(); 1`);
    check(await count(b, '.ds-win') > 0, kind + ' windows drawn');
    await b.eval(`document.querySelector('.dock-pane:not([hidden]) .adv-sqlbox .adv-run').click(); 1`);
    const r2 = await lastRun(b);
    check(r2 && !r2.some((x) => x.error) && r2[r2.length - 1].rows > 0, kind + ' SQL runs ' + J(r2 && r2.slice(-1)));
    if (kind === 'Session') {
      const winRows = await count(b, '.ds-res tbody tr');
      const drops = await b.eval(`Number(document.querySelectorAll('.adv-kpi')[3].querySelector('.v').textContent)`);
      if (!drops) check(r2[r2.length - 1].rows === winRows, 'session windows: SQL finds the same ' + winRows + ' sessions');
    }
    await shot(b, 'stream-' + kind.toLowerCase());
  }
  // a shorter watermark delay means more late events
  const late = async () => b.eval(`(() => { const k = [...document.querySelectorAll('.adv-kpi')]; return Number(k[2].querySelector('.v').textContent) + Number(k[3].querySelector('.v').textContent); })()`);
  await b.eval(`[...document.querySelectorAll('.adv-seg button')].find((x) => x.textContent === 'Tumbling').click(); 1`);
  const l2 = await late();
  await b.eval(`(() => { const s = [...document.querySelectorAll('.dock-pane:not([hidden]) select')].find((x) => x.closest('label') && /Watermark delay/.test(x.closest('label').textContent)); s.value = '6'; s.dispatchEvent(new Event('change')); return 1; })()`);
  check(await late() <= l2, 'a longer watermark delay: no more late events (' + l2 + ' → ' + await late() + ')');
  await b.eval(`document.querySelector('.adv-hist button[title="Play the stream"]').click(); 1`);
  await b.sleep(400);
  check(await b.eval(`!!document.querySelector('.adv-hist button[title="Pause"]')`), 'play runs the clock');
  await b.eval(`document.querySelector('.adv-hist button[title="Pause"]').click(); 1`);
  check(!errors(b).length, 'stream: no console errors ' + J(errors(b)));
  await b.close();
}

// ---- tuning --------------------------------------------------------------------------------------------------------------------------
{
  const b = await start(1440, 900);
  await b.eval(`K.app.openView('tuning'); K.app.dock.toggleMax(true); 1`);
  const sessions = await b.eval('K.app.db.sessions.length');
  const indexes = () => b.eval(`K.app.session.catalog.tables(['index']).map((r) => r.name).sort().join(',')`);
  const before = await indexes();
  await press(b, /Run the advisor/);
  await b.waitFor(`document.querySelector('.tu-bars')`, 60000);
  check(await count(b, '.tu-bar') === 7, 'a bar per query of the workload');
  check(await indexes() === before, 'the advisor leaves the database\'s indexes alone');
  check(await b.eval('K.app.db.sessions.length') === sessions, 'the advisor closes its session');
  check(await b.eval(`!K.app.db.sessions.some((s) => s.tx)`), 'no transaction left open');
  const rec = await b.eval(`[...document.querySelectorAll('.dock-pane:not([hidden]) .adv-sqlbox')].map((x) => x.innerText).join('\\n')`);
  check(/create index tune_patron_name on patron/.test(rec), 'recommends an index for the selective lookup by name');
  check(!/tune_production_genre|tune_performance_perf_date/.test(rec), 'not the unselective ones');
  check(/saving/i.test(await text(b, '.adv-kpis')), 'shows the saving');
  await shot(b, 'tuning-advisor');
  // measure, apply, measure again, drop
  await press(b, /Run the workload/);
  check(await count(b, '.tu-tot') === 1, 'measured page accesses');
  await press(b, /Apply to the database/);
  await b.waitFor(`K.app.session.catalog.tables(['index']).some((r) => r.name === 'tune_patron_name')`, 10000);
  check(true, 'apply creates the indexes');
  await press(b, /Run the workload/);
  check(await b.eval(`document.querySelectorAll('.tu-tot td.num').length`) === 2, 'a second run to compare');
  await press(b, /Drop them again/);
  await b.waitFor(`!K.app.session.catalog.tables(['index']).some((r) => r.name.startsWith('tune_'))`, 10000);
  check(await indexes() === before, 'dropped again');
  // at today's size nothing pays
  await b.eval(`(() => { const s = [...document.querySelectorAll('.dock-pane:not([hidden]) .view-head select')][1]; s.value = '1'; s.dispatchEvent(new Event('change')); return 1; })()`);
  await press(b, /Run the advisor/);
  await b.waitFor(`document.querySelector('.tu-bars')`, 60000);
  check(/No index pays/.test(await text(b, '.tu-res')), 'on the small tables no index pays for itself');
  // the benchmark
  await b.eval(`(() => { const s = [...document.querySelectorAll('.dock-pane:not([hidden]) select')].find((x) => x.closest('label') && /Transactions per run/.test(x.closest('label').textContent)); s.value = '10'; s.dispatchEvent(new Event('change')); return 1; })()`);
  await press(b, /Run the benchmark/);
  await b.waitFor(`document.querySelectorAll('.tu-bench tbody tr').length === 8 && !document.querySelector('.tu .adv-spin')`, 120000);
  const rows = await b.eval(`[...document.querySelectorAll('.tu-bench tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent))`);
  const tp = (iso, n) => +rows.find((r) => r[0] === iso && r[1] === String(n))[3];
  check(tp('read committed', 8) > tp('read committed', 1), 'READ COMMITTED: more clients, more throughput');
  check(+rows.find((r) => r[0] === 'serializable' && r[1] === '8')[4] > 0, 'SERIALIZABLE: aborts under contention');
  check(+rows.find((r) => r[0] === 'read committed' && r[1] === '8')[5] > 0, 'lock waits counted');
  check(await count(b, '.tu-line') === 2, 'throughput plotted for both isolation levels');
  check(!(await b.eval(`K.app.session.catalog.schema('bench', true)`)), 'the bench schema is dropped afterwards');
  check(await b.eval('K.app.db.sessions.length') === sessions, 'the benchmark closes its sessions');
  // the same numbers again (seeded)
  const again = await b.eval(`(() => { const t = document.querySelectorAll('.tu-bench tbody tr'); return [...t].map((tr) => tr.children[3].textContent).join(','); })()`);
  await press(b, /Run the benchmark/);
  await b.waitFor(`document.querySelectorAll('.tu-bench tbody tr').length === 8 && !document.querySelector('.tu .adv-spin')`, 120000);
  check(await b.eval(`[...document.querySelectorAll('.tu-bench tbody tr')].map((tr) => tr.children[3].textContent).join(',')`) === again, 'the benchmark is deterministic');
  await top(b, 99999);
  await shot(b, 'tuning-bench');
  check(!errors(b).length, 'tuning: no console errors ' + J(errors(b)));
  await b.close();
}

// ---- dark theme and phone width -------------------------------------------------------------------------------------------------------
for (const [w, hgt, theme] of [[1440, 900, 'dark'], [390, 844, 'dark'], [390, 844, 'light']]) {
  const b = await start(w, hgt, theme);
  for (const v of ['blockchain', 'tuning', 'cube', 'stream']) {
    await b.eval(`K.app.openView(${J(v)}); 1`);
    await b.sleep(300);
    const over = await b.eval(`(() => { const p = document.querySelector('.dock-pane:not([hidden])'); const body = p.querySelector('.adv-body'); return { page: document.documentElement.scrollWidth - innerWidth, body: body.scrollWidth - body.clientWidth }; })()`);
    check(over.page <= 0 && over.body <= 1, v + ' fits ' + w + 'px (' + J(over) + ')');
    check(await count(b, '.view-intro') === 1, v + ' has its explanation');
    await shot(b, v + '-' + w + '-' + theme);
  }
  check(!errors(b).length, w + 'px ' + theme + ': no console errors ' + J(errors(b)));
  await b.close();
}

console.log(fails ? fails + ' failed, ' + passes + ' passed' : 'all ' + passes + ' checks passed');
process.exit(fails ? 1 : 0);
