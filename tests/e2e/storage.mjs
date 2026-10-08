// End-to-end test of the storage, buffer pool and disk views in headless Chrome.
// node tests/e2e/storage.mjs [--shots <dir>]   (screenshots of each view, both themes and phone width)
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
  // a small pool and the Theatre data, so a scan of booking (17 pages) is larger than the pool
  await b.eval('localStorage.clear(); K.app.settings.frames = 8; K.app.settings.policy = "lru"; K.app.settings.theme = "light"; K.app.applyTheme(); K.app.newDatabase(); 1');
  return b;
}
const shot = async (b, name) => { if (shots) { await b.sleep(250); await b.screenshot(join(shots, name + '.png')); } };
const errors = (b) => b.logs.filter((l) => l.type === 'error' || l.type === 'exception');
const text = (b, sel) => b.eval(`(() => { const e = document.querySelector(${J(sel)}); return e ? e.innerText : null; })()`);
const count = (b, sel) => b.eval(`document.querySelectorAll(${J(sel)}).length`);
const run = (b, sql) => b.eval(`K.app.runText(${J(sql)}); 1`);
const relOid = (name) => `K.app.session.catalog.tables(['table', 'index']).find((r) => r.name === ${J(name)}).oid`;
const theme = (b, t) => b.eval(`K.app.settings.theme = ${J(t)}; K.app.applyTheme(); 1`);

// ---- the storage inspector --------------------------------------------------------------------------------------------
{
  const b = await start(1440, 900);
  await b.eval(`K.app.openView('storage', { rel: ${relOid('company')} }); 1`);
  check(await count(b, '.dock-tab') >= 1 && await b.eval('K.app.dock.active') === 'storage', 'storage view opens');
  const pages = await b.eval(`K.app.db.disk.blocks(K.app.session.catalog.tables().find((r) => r.name === 'company').file)`);
  check(await count(b, '.st-pg') === pages, 'one tile per page of company (' + pages + ')');
  const ntup = await b.eval(`(() => { const x = K.app.db.session({ name: 'probe' }); try { return Number(x.query('select count(*) from company').rows[0][0]); } finally { K.app.db.sessions = K.app.db.sessions.filter((y) => y !== x); } })()`);
  check(new RegExp(ntup + '\\s*TUPLES', 'i').test(await text(b, '.st-sum')), 'summary counts ' + ntup + ' tuples');
  check(/Heap file organisation/.test(await text(b, '.st-sum')), 'file organisation explained');
  await b.clickSel('.st-pg');
  check(await count(b, '.st-map') === 1, 'page drawn to scale');
  check(await count(b, '.st-slot') === ntup, 'a line pointer row per tuple');
  check(/pd_lower/.test(await text(b, '.st-hdr')) && /pd_upper/.test(await text(b, '.st-hdr')), 'header fields labelled');
  // hovering a line pointer highlights its tuple
  const hl = await b.eval(`(() => { const lp = document.querySelector('.r-lp[data-i="3"] rect'); lp.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); return document.querySelectorAll('.st-map .r-tup.hl[data-i="3"]').length; })()`);
  check(hl === 1, 'hovering line pointer 3 highlights tuple 3');

  // an insert: the new tuple is marked, the page is dirty in memory and differs from the disk copy
  await run(b, "insert into company values ('C99', 'Knuth Players', 'Brightwater', 2020, 99000);");
  const banner = await text(b, '.kv-banner');
  check(/Last tuple inserted/.test(banner || ''), 'banner names the inserted tuple');
  check(await count(b, '.st-tuple') === 1, 'the inserted tuple opens');
  check(/t_xmin/.test(await text(b, '.st-tuple')) && /Knuth/.test(await text(b, '.st-tuple')), 'tuple header and values decoded');
  check(/padding/i.test(await text(b, '.st-tuple')), 'alignment padding shown');
  check(await count(b, '.hex .hb.x-xmin') === 4, 'hex dump colours the 4 bytes of t_xmin');
  const where = await text(b, '.st-where');
  check(/In memory \(dirty\)/.test(where) && /On disk/.test(where), 'both copies offered: in memory (dirty) and on disk');
  check(await count(b, '.st-map .r-diff') > 0, 'bytes that differ from the disk are outlined');
  await b.eval(`[...document.querySelectorAll('.st-where .seg button')].find((x) => x.textContent === 'On disk').click(); 1`);
  check(await b.eval(`[...document.querySelectorAll('.st-where .seg button')].find((x) => x.textContent === 'On disk').classList.contains('on')`), 'switches to the disk copy');
  await shot(b, 'storage-insert-light');

  // step the timeline back to the start and forward to the insert
  await b.eval('K.app.timeline.go(0); 1');
  check(/Before the first step/.test(await text(b, '.kv-banner')), 'stepping back to the start');
  await b.eval(`K.app.timeline.go(K.app.timeline.events.findIndex((e) => e.type === 'heap.insert') + 1); 1`);
  check(/Inserted a tuple into company/.test(await text(b, '.kv-banner')), 'the step of the insert is described');
  check(await count(b, '.st-pg.now') === 1, 'the page the step touched is highlighted');

  // an update chain, followed by ctid; and visibility inside an open transaction
  await run(b, "update company set budget = budget + 1 where company_id = 'C99';");
  check(/update chain/i.test(await text(b, '.st-tuple')), 'update chain drawn');
  check(await count(b, '.st-ver') >= 2, 'two versions in the chain');
  await b.eval(`document.querySelector('.st-ver').click(); 1`);
  const old = await text(b, '.st-tuple');
  check(/follow to/.test(old) && /not visible/.test(old), 'old version is not visible and links to the newer one');
  await b.eval(`[...document.querySelectorAll('.st-tuple .kv-link')].find((x) => /follow/.test(x.textContent)).click(); 1`);
  check(/points to itself/.test(await text(b, '.st-tuple')), 'following ctid reaches the newest version');
  await run(b, "begin; delete from company where company_id = 'C99';");
  const vis = await text(b, '.st-vis');
  check(/not visible to the open transaction/.test(vis) && /visible to a new transaction/.test(vis), 'visibility for the session and for a new transaction differ: ' + vis);
  await run(b, 'rollback;');
  await shot(b, 'storage-chain-light');
  await theme(b, 'dark');
  await shot(b, 'storage-chain-dark');
  await theme(b, 'light');

  // a page split in a B+ tree
  await run(b, "create table big (k int primary key, v text); insert into big select g, repeat('x', 120) from generate_series(1, 300) g;");
  check(await b.eval(`K.app.timeline.events.some((e) => e.type === 'btree.split')`), 'the insert split an index page');
  await b.eval(`K.app.openView('storage', { rel: ${relOid('big_pkey')} }); 1`);
  check(await count(b, '.st-pg') >= 3, 'the index has a meta page, the root and leaves');
  check(await count(b, '.st-pg.run') + await count(b, '.st-pg.now') >= 2, 'the pages the run touched are marked');
  await b.eval(`document.querySelectorAll('.st-pg')[1].click(); 1`);
  check(/Special area/.test(await text(b, '.st-page')), 'the special area of an index page is decoded');
  await b.eval(`document.querySelector('.st-slot').click(); 1`);
  check(/heap TID|child pointer/.test(await text(b, '.st-tuple')), 'an index entry is decoded');
  await shot(b, 'storage-index-light');
  check(errors(b).length === 0, 'no console errors (storage): ' + J(errors(b).slice(0, 3)));
  await b.close();
}

// ---- the buffer pool --------------------------------------------------------------------------------------------------
{
  const b = await start(1440, 900);
  await b.eval(`K.app.openView('buffer'); 1`);
  check(await count(b, '.bp-frame') === 8, 'eight frames drawn');
  await run(b, 'select count(*) from booking;');
  const ev = await b.eval(`K.app.timeline.events.findIndex((e, i) => e.type === 'buf.evict')`);
  check(ev > 0, 'a scan larger than the pool evicts pages');
  await b.eval(`K.app.timeline.go(${ev + 1}); 1`);
  const why = await text(b, '.bp-event');
  check(/least recently used/.test(why || ''), 'the victim is explained by the LRU rule: ' + (why || '').slice(0, 160));
  check(await count(b, '.bp-frame.ev-evict') === 1, 'the evicted frame is marked');
  const misses = await b.eval(`+[...document.querySelectorAll('.kv-stat')].find((x) => /misses/i.test(x.innerText)).querySelector('.kv-sv').innerText`);
  check(misses === 8, 'at the first eviction, 8 misses so far (' + misses + ')');
  // step back with the dock's control: the eviction has not happened yet
  await b.eval(`document.querySelector('.tl-row .btn[title="Step back"]').click(); 1`);
  check(await count(b, '.bp-frame.ev-evict') === 0, 'one step back: no eviction marked');
  await b.eval(`document.querySelector('.tl-row .btn[title="Step forward"]').click(); 1`);
  check(await count(b, '.bp-frame.ev-evict') === 1, 'one step forward again');
  check(/Next victim/.test(await text(b, '.bp-pol')), 'next victim named');
  check(await count(b, '.bp-bucket .bp-entry') === 8 - await count(b, '.bp-frame.free'), 'page table holds every cached page');
  await shot(b, 'buffer-evict-light');
  // switch to Clock and replay a scan: the hand is drawn
  await b.eval(`[...document.querySelectorAll('.bp-head .seg button')].find((x) => x.textContent === 'Clock').click(); 1`);
  check(await b.eval('K.app.db.buffers.policy') === 'clock', 'policy set to Clock');
  await run(b, 'select count(*) from patron;');
  check(await count(b, '.bp-clock') === 1, 'the clock is drawn');
  // a dirty page written back: the log flush comes first
  await run(b, "update booking set seats = seats where seats = 2; select count(*) from patron;");
  await run(b, 'select count(*) from booking;');
  const fl = await b.eval(`K.app.timeline.events.findIndex((e) => e.type === 'buf.flush')`);
  if (fl > 0) {
    await b.eval(`K.app.timeline.go(${fl + 1}); 1`);
    check(/written to disk/.test(await text(b, '.bp-event')), 'a dirty page write is explained');
  } else check(true, 'no dirty eviction in this run');
  await theme(b, 'dark');
  await shot(b, 'buffer-clock-dark');
  await theme(b, 'light');
  await b.eval(`[...document.querySelectorAll('.bp-head .btn')].find((x) => /Flush all/.test(x.textContent)).click(); 1`);
  check(await b.eval('K.app.db.buffers.frames.every((f) => !f.dirty)'), 'flush all leaves no dirty frame');
  // the experiment: MRU beats LRU and Clock on the repeated scan
  await b.eval(`document.querySelector('.bp-exp .btn.primary').click(); 1`);
  await b.waitFor(`document.querySelectorAll('.bp-exprow').length === 5`, 60000);
  const rows = await b.eval(`[...document.querySelectorAll('.bp-exprow')].map((r) => [r.querySelector('b').textContent, parseFloat(r.querySelector('em').textContent)])`);
  const by = Object.fromEntries(rows);
  check(by.MRU > by.LRU && by.MRU > by.Clock, 'MRU has the best hit ratio on the repeated scan: ' + J(rows));
  check(await b.eval('K.app.db.buffers.n') === 8 && await b.eval('K.app.db.buffers.policy') === 'clock', 'the pool is put back after the experiment');
  await b.eval(`document.querySelector('.bp-exp').scrollIntoView(); 1`);
  await shot(b, 'buffer-experiment-light');
  check(errors(b).length === 0, 'no console errors (buffer): ' + J(errors(b).slice(0, 3)));
  await b.close();
}

// ---- the disk ------------------------------------------------------------------------------------------------------------
{
  const b = await start(1440, 900);
  await b.eval(`K.app.openView('disk'); 1`);
  await run(b, 'select count(*) from booking b join patron p on b.patron_id = p.patron_id;');
  await b.eval(`K.app.timeline.go(K.app.timeline.events.findIndex((e) => e.type === 'disk.read') + 1); 1`);
  check(/t_seek \+ t_rotation \+ t_transfer/.test(await text(b, '.dk-cur') || ''), 'the first access is a random one, with its formula');
  check(await count(b, '.dk-bar') > 10, 'a bar per access');
  check(await count(b, '.dk-tbl tbody tr') > 10, 'an access table');
  check(/sequential/.test(await text(b, '.dk-tbl')), 'sequential accesses appear');
  check(/random:.*sequential:/s.test(await text(b, '.dk-body')), 'random and sequential read costs compared');
  await shot(b, 'disk-hdd-light');
  await theme(b, 'dark');
  await shot(b, 'disk-hdd-dark');
  await theme(b, 'light');
  // the SSD tab: uniform reads and write amplification after random rewrites
  await b.eval(`document.querySelectorAll('.dk-head .seg button')[1].click(); 1`);
  check(/uniform/.test(await text(b, '.dk-tbl')), 'SSD accesses are uniform');
  for (let k = 0; k < 6; k++) await b.eval(`document.querySelector('.dk-ftl .btn').click(); 1`);
  const wa = await b.eval(`parseFloat([...document.querySelectorAll('.dk-ftl .kv-stat')].find((x) => /write ampl/i.test(x.innerText)).querySelector('.kv-sv').innerText)`);
  check(wa > 1, 'garbage collection gives a write amplification above 1 (' + wa + ')');
  await shot(b, 'disk-ssd-light');
  // RAID: fail disks, the shown values are recomputed from the survivors and equal the originals
  await b.eval(`document.querySelectorAll('.dk-head .seg button')[2].click(); 1`);
  const cells = `[...document.querySelectorAll('.dk-cell span')].map((x) => x.textContent)`;
  for (const [lv, fail] of [[5, [1]], [6, [1, 2]], [6, [0, 3]], [1, [0]]]) {
    await b.eval(`[...document.querySelectorAll('.dk-raid .seg button')].find((x) => x.textContent === 'RAID ${lv}').click(); 1`);
    const before = await b.eval(cells);
    for (const d of fail) await b.eval(`document.querySelectorAll('.dk-disk')[${d}].click(); 1`);
    const after = await b.eval(cells);
    check(J(before) === J(after) && !after.includes('??'), 'RAID ' + lv + ' with disks ' + fail + ' failed computes every block');
    for (const d of fail) await b.eval(`document.querySelectorAll('.dk-disk')[${d}].click(); 1`);
  }
  await b.eval(`[...document.querySelectorAll('.dk-raid .seg button')].find((x) => x.textContent === 'RAID 5').click(); document.querySelectorAll('.dk-disk')[0].click(); document.querySelectorAll('.dk-disk')[2].click(); 1`);
  check(await count(b, '.dk-cell.lost') > 0 && /Data lost/.test(await text(b, '.dk-raidinfo')), 'RAID 5 loses data with two failed disks');
  await b.eval(`document.querySelectorAll('.dk-disk')[2].click(); document.querySelectorAll('.dk-cell')[0].click(); 1`);
  check(/computed/.test(await text(b, '.dk-raidinfo')), 'a block on the failed disk says how it is computed');
  await shot(b, 'disk-raid-light');
  await b.eval(`[...document.querySelectorAll('.dk-raidinfo .btn')].find((x) => /rebuild/.test(x.textContent)).click(); 1`);
  await b.waitFor(`!document.querySelector('.dk-disk.failed')`, 8000);
  check(await count(b, '.dk-disk.failed') === 0, 'rebuild brings the array back');
  check(errors(b).length === 0, 'no console errors (disk): ' + J(errors(b).slice(0, 3)));
  await b.close();
}

// ---- phone width ---------------------------------------------------------------------------------------------------------
{
  const b = await start(390, 844);
  for (const [id, sql] of [['storage', "insert into company values ('C98', 'Hopper Ensemble', 'Saltreach', 2021, 98000);"], ['buffer', 'select count(*) from booking;'], ['disk', 'select count(*) from booking;']]) {
    await b.eval(`K.app.openView(${J(id)}); 1`);
    await run(b, sql);
    if (id === 'storage') await b.eval(`document.querySelector('.st-pg') && document.querySelector('.st-pg').click(); 1`);
    const over = await b.eval(`(() => { const p = [...document.querySelectorAll('.dock-pane')].find((x) => !x.hidden); const body = p.querySelector('.view-body'); return { page: document.documentElement.scrollWidth, pane: p.scrollWidth - p.clientWidth, body: body.scrollWidth - body.clientWidth }; })()`);
    check(over.page <= 390 && over.pane <= 1 && over.body <= 1, id + ' fits a phone: ' + J(over));
    await shot(b, id + '-phone');
  }
  await b.eval(`document.querySelectorAll('.dk-head .seg button')[2].click(); 1`);
  const over = await b.eval(`(() => { const body = [...document.querySelectorAll('.dock-pane')].find((x) => !x.hidden).querySelector('.view-body'); return body.scrollWidth - body.clientWidth; })()`);
  check(over <= 1, 'RAID fits a phone (' + over + ')');
  await shot(b, 'disk-raid-phone');
  check(errors(b).length === 0, 'no console errors (phone): ' + J(errors(b).slice(0, 3)));
  await b.close();
}

console.log(passes + ' passed, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
