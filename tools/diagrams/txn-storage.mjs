// Transactions, recovery, storage, analytics and the page itself: each drawing in its busiest states
const P = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const click = (sel, re) => { const e = [...document.querySelectorAll(sel)].find((x) => !re || new RegExp(re).test(x.textContent)); if (!e) throw new Error('nothing to click: ' + sel + ' ' + re); e.click(); };
  const choose = (sel, value) => { const s = typeof sel === 'string' ? document.querySelector(sel) : sel; if (!s) throw new Error('no select ' + sel); s.value = value; s.dispatchEvent(new Event('change', { bubbles: true })); };
  const pane = () => document.querySelector('.dock-pane:not([hidden])');
  const fresh = () => { localStorage.clear(); K.app.newDatabase(); };
  const view = (id) => K.app.dock.open.find((o) => o.id === id).view;
  // bring a part into view by scrolling its pane down (scrollIntoView would also shift clipped ancestors sideways)
  const show = (sel) => {
    const e = document.querySelector(sel);
    for (let p = e && e.parentElement; p; p = p.parentElement) if (/(auto|scroll)/.test(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight) { p.scrollTop += e.getBoundingClientRect().top - p.getBoundingClientRect().top - 8; break; }
    document.querySelectorAll('.toast').forEach((t) => t.remove());
  };
`;
const max = (on) => 'K.app.dock.toggleMax(' + (on ? 'true' : 'false') + ');';

// ---- transactions ----------------------------------------------------------------------------------------------------------
// a scenario under a protocol, n steps in (a step whose tab waits is skipped), then one of the view's tabs
const txn = (id, n, tab, opts) => P + `
  fresh(); K.app.openView('txn'); ${max(!(opts && opts.side))} await sleep(150);
  ${opts && opts.proto ? `choose(document.querySelectorAll('.tx-sels select')[0], ${JSON.stringify(opts.proto)}); await sleep(50);` : ''}
  ${opts && opts.iso ? `choose(document.querySelectorAll('.tx-sels select')[1], ${JSON.stringify(opts.iso)});` : ''}
  ${opts && opts.dl ? `choose(document.querySelectorAll('.tx-sels select')[2], ${JSON.stringify(opts.dl)});` : ''}
  const v = view('txn');
  v.start(${JSON.stringify(id)}); await sleep(50);
  for (let k = 0; k < ${n}; k++) { const s0 = v.state.step; v.next(); if (v.state.step === s0) click('.tx-next .btn.icon[title="Skip this step"]'); await sleep(30); }
  click('.tx-tabs button[data-tab="${tab}"]'); await sleep(50);
  ${opts && opts.open ? "document.querySelectorAll('.dock-pane:not([hidden]) details').forEach((d) => { d.open = true; });" : ''}
  show(${JSON.stringify(tab === 'locks' ? '.dg-box' : tab === 'protocol' ? '.tx-pt, .tx-body .kv-card' : '.tx-body')});
`;
// n sessions, each holding row i and asking for row i+1: a waits-for cycle of length n that nobody breaks
const ring = (n, star) => P + `
  fresh(); K.app.openView('txn'); ${max(true)} await sleep(150);
  const s = K.app.db.session({ name: 'setup' });
  s.exec('create table acct (id int primary key, bal int); insert into acct select g, g * 100 from generate_series(1, ${n}) g;');
  K.app.db.sessions = K.app.db.sessions.filter((x) => x !== s);
  const tabs = [];
  for (let i = 1; i <= ${n}; i++) { const t = K.app.addTab('T' + i, '', true); tabs.push(t); t.session.exec("set enable_seqscan = off; set enable_bitmapscan = off; set deadlock_handling = 'timeout'; set deadlock_timeout = '1h'"); }
  for (let i = 0; i < ${n}; i++) K.app.runSql(tabs[i], 'begin; update acct set bal = bal + 1 where id = ' + (i + 1) + ';', 0);
  for (let i = 0; i < ${n}; i++) K.app.runSql(tabs[i], 'update acct set bal = bal + 1 where id = ' + (${star ? '1' : '(i + 1) % ' + n + ' + 1'}) + ';', 0);
  await sleep(100);
  click('.tx-tabs button[data-tab="locks"]'); await sleep(50); show('.dg-box');
`;

// ---- schedules ---------------------------------------------------------------------------------------------------------------
const sched = (text, proto) => P + `
  K.app.openView('schedule', { schedule: ${JSON.stringify(text)} }); ${max(true)} await sleep(150);
  ${proto ? `choose('.sw-sim select', ${JSON.stringify(proto)});` : ''}
  await sleep(50); show('.dg-box');
`;

// ---- recovery ----------------------------------------------------------------------------------------------------------------
const BASE = "create table account (name text primary key, balance int); insert into account values ('A', 4200), ('B', 3100), ('C', 860); checkpoint;";
const work = `
  K.app.addTab('Second', '', true);
  K.app.runSql(K.app.tabs[0], ${JSON.stringify(BASE)}, 0);
  K.app.runSql(K.app.tabs[0], "begin; update account set balance = 3900 where name = 'A'; update account set balance = 3400 where name = 'B'; commit;", 0);
  K.app.runSql(K.app.tabs[1], "begin; update account set balance = 500 where name = 'C'; insert into account values ('D', 7);", 0);
`;
const restart = (alg, pass) => P + `
  fresh(); K.app.openView('log'); ${max(true)} ${work}
  click('.lg-head .btn', 'Checkpoint');
  K.app.runSql(K.app.tabs[0], "update account set balance = balance + 1 where name = 'A';", 0);
  K.app.openView('recovery'); await sleep(100);
  click('.rc-tabs button', 'Crash and restart'); await sleep(50);
  document.querySelector('.rc-big').click(); await sleep(50);
  click('.rc-restart .seg button', ${JSON.stringify(alg)}); click('.rc-restart .btn', 'Restart'); await sleep(100);
  ${pass ? `click('.rc-pass', ${JSON.stringify(pass)}); await sleep(50);` : ''}
  show('.rc-trace');
`;
const rscen = (title, alg) => P + `
  fresh(); K.app.openView('recovery'); ${max(true)} await sleep(100);
  click('.rc-chip', '^' + ${JSON.stringify(title.replace(/[,]/g, '.'))} + '$'); click('.rc-scen .btn', '^Set up'); await sleep(50);
  ${alg ? `document.querySelectorAll('.rc-pred').forEach((p) => p.querySelectorAll('.seg button')[0].click());
  click('.rc-scen .btn', 'Crash as described'); await sleep(50);
  click('.rc-restart .seg button', ${JSON.stringify(alg)}); click('.rc-restart .btn', 'Restart'); await sleep(100); show('.rc-trace');` : 'show(".rc-scen");'}
`;

// ---- storage -----------------------------------------------------------------------------------------------------------------
const LONG = "create table notes (id int primary key, title text, body text); insert into notes select g, 'A rather long title for note number ' || g, repeat('lorem ipsum dolor sit amet ', 1 + g % 9) from generate_series(1, 400) g;";
const storage = (rel, extra) => P + `
  fresh(); ${max(false)} K.app.runText(${JSON.stringify(LONG)}); await sleep(100);
  const r = K.app.session.catalog.tables(['table', 'index']).find((t) => t.name === ${JSON.stringify(rel)});
  K.app.openView('storage', { rel: r.oid }); await sleep(150);
  ${extra || ''}
`;

export default [
  // transactions: the scenario list, then each scenario at its interesting steps
  { name: 'txn-scenarios', setup: txn('lost-update', 0, 'scenarios', { open: true }) },
  { name: 'txn-lost-update-wait', setup: txn('lost-update', 6, 'timeline') },
  { name: 'txn-lost-update-versions', setup: txn('lost-update', 9, 'versions') },
  { name: 'txn-dirty-read-2pl', setup: txn('dirty-read', 4, 'timeline', { proto: 'strict2pl' }) },
  { name: 'txn-unrepeatable-to', setup: txn('unrepeatable', 5, 'protocol', { proto: 'to' }) },
  { name: 'txn-phantom-occ', setup: txn('phantom', 5, 'protocol', { proto: 'occ' }) },
  { name: 'txn-write-skew-ssi', setup: txn('write-skew', 8, 'ssi', { iso: 'serializable' }) },
  { name: 'txn-deadlock-locks', setup: txn('deadlock', 5, 'locks') },
  { name: 'txn-deadlock-after', setup: txn('deadlock', 6, 'locks') },
  { name: 'txn-deadlock3-wait', setup: txn('deadlock3', 8, 'locks', { proto: '2pl' }) },
  { name: 'txn-deadlock3-found', setup: txn('deadlock3', 9, 'locks', { proto: 'strict2pl' }) },
  { name: 'txn-deadlock3-timeline', setup: txn('deadlock3', 12, 'timeline') },
  { name: 'txn-deadlock3-side', setup: txn('deadlock3', 9, 'locks', { side: true }) },
  { name: 'txn-cascade-2pl', setup: txn('cascade', 8, 'protocol', { proto: '2pl' }) },
  { name: 'txn-thomas', setup: txn('thomas', 8, 'protocol', { proto: 'thomas' }) },
  { name: 'txn-mvto', setup: txn('lost-update', 9, 'protocol', { proto: 'mvto' }) },
  { name: 'txn-mv2pl', setup: txn('write-skew', 9, 'protocol', { proto: 'mv2pl' }) },
  { name: 'txn-ring5', setup: ring(5) },
  { name: 'txn-ring8', setup: ring(8) },
  { name: 'txn-star4', setup: ring(4, true) },

  // schedules: presets, dense precedence graphs, protocol runs
  { name: 'sched-preset', setup: sched('r1(X) w1(X) r2(X) r1(Y) w2(X) w1(Y) c1 r2(Y) w2(Y) c2') },
  { name: 'sched-cycle2', setup: sched('r1(A) r2(A) w1(A) w2(A) c1 c2') },
  { name: 'sched-dense4', setup: sched('r1(A) w2(A) r3(B) w4(B) w1(B) r2(C) w3(C) r4(A) w1(C) w3(A) r2(B) w4(C) c1 c2 c3 c4', '2pl') },
  { name: 'sched-dense5', setup: sched('w1(A) r2(A) w2(B) r3(B) w3(C) r4(C) w4(D) r5(D) w5(E) r1(E) r1(F) w3(F) r2(G) w4(G) w5(H) r3(H) r1(I) w2(I) r2(J) w1(J) r4(K) w3(K) c1 c2 c3 c4 c5', 'to') },
  { name: 'sched-dense5-mvto', setup: sched('w1(A) r2(A) w2(B) r3(B) w3(C) r4(C) w4(D) r5(D) w5(E) r1(E) r2(F) w4(F) r5(G) w2(G) r1(H) w3(H) r3(I) w1(I) c1 c2 c3 c4 c5', 'mvto') },
  { name: 'sched-chain5', setup: sched('w1(A) r2(A) w2(B) r3(B) w3(C) r4(C) w4(D) r5(D) w5(E) r1(E) c1 c2 c3 c4 c5', 'validation') },

  // the log and recovery
  { name: 'log-records', setup: P + `fresh(); K.app.openView('log'); ${max(true)} ${work} K.app.runSql(K.app.tabs[0], "insert into account values ('${'Somebody with a very long name '.repeat(4)}', 123456789);", 0); click('.lg-head .btn', 'Checkpoint'); await sleep(100); show('.lg-list');` },
  { name: 'log-angle', setup: P + `fresh(); K.app.openView('log'); ${max(true)} ${work} click('.lg-head .btn', 'Checkpoint'); click('.lg-head .seg button', 'Angle-bracket'); await sleep(100); show('.lg-list');` },
  { name: 'log-side', setup: P + `fresh(); K.app.openView('log'); ${max(false)} ${work} click('.lg-head .btn', 'Checkpoint'); await sleep(100);` },
  { name: 'rec-crash-card', setup: P + `fresh(); K.app.openView('log'); ${max(true)} ${work} K.app.openView('recovery'); await sleep(100); click('.rc-tabs button', 'Crash and restart');` },
  { name: 'rec-basic', setup: restart('Redo then undo') },
  { name: 'rec-basic-redo', setup: restart('Redo then undo', 'Redo') },
  { name: 'rec-basic-undo', setup: restart('Redo then undo', 'Undo') },
  { name: 'rec-aries-analysis', setup: restart('ARIES', 'Analysis') },
  { name: 'rec-aries-redo', setup: restart('ARIES', 'Redo') },
  { name: 'rec-aries-undo', setup: restart('ARIES', 'Undo') },
  { name: 'rec-scen-checkpoint', setup: rscen('A checkpoint between') },
  ...[['ARIES', 'ARIES'], ['basic', 'Redo then undo']].flatMap(([tag, alg]) => [
    { name: 'rec-scen-checkpoint-' + tag, setup: rscen('A checkpoint between', alg) },
    { name: 'rec-scen-flush-' + tag, setup: rscen('Another commit flushes the log', alg) },
    { name: 'rec-scen-async-' + tag, setup: rscen('Commit without waiting for the log', alg) },
    { name: 'rec-scen-torn-' + tag, setup: rscen('Torn page', alg) },
    { name: 'rec-scen-torn-nofpw-' + tag, setup: rscen('Torn page, no full-page writes', alg) },
  ]),
  { name: 'rec-disk-loss', setup: P + `fresh(); K.app.openView('recovery'); ${max(true)} await sleep(100); click('.rc-tabs button', 'Disk loss'); click('.rc-steps .btn', 'Take a dump'); K.app.runText("insert into venue values ('NEW', 'New Pier Stage', 'Saltreach', 2026)"); await sleep(50); K.app.dock.renderActive(); click('.rc-steps .btn', 'Disk failure'); click('.rc-steps .btn', 'Restore'); await sleep(100); show('.rc-trace');` },
  { name: 'rec-backup', setup: P + `fresh(); K.app.openView('recovery'); ${max(true)} await sleep(100); click('.rc-tabs button', 'Remote backup'); click('.kv-card .seg button', '^1 flush$'); click('.kv-card .btn', 'Start the backup'); K.app.runText("insert into venue values ('NEW', 'New Pier Stage', 'Saltreach', 2026)"); await sleep(50); K.app.dock.renderActive(); await sleep(50); show('.rc-sites');` },
  { name: 'rec-shadow', setup: P + `fresh(); K.app.openView('recovery'); ${max(true)} await sleep(100); click('.rc-tabs button', 'Shadow paging'); click('.rc-sptools .btn', 'Begin'); choose('.rc-write select', '2'); document.querySelector('.rc-val').value = 'zebra'; click('.rc-sptools .btn', 'Write'); choose('.rc-write select', '5'); click('.rc-sptools .btn', 'Write'); await sleep(50); show('.rc-spwrap');` },
  { name: 'rec-shadow-commit', setup: P + `fresh(); K.app.openView('recovery'); ${max(true)} await sleep(100); click('.rc-tabs button', 'Shadow paging'); click('.rc-sptools .btn', 'Begin'); choose('.rc-write select', '2'); click('.rc-sptools .btn', 'Write'); click('.rc-sptools .btn', 'Commit'); await sleep(50); show('.rc-spwrap');` },

  // storage
  { name: 'storage-notes', setup: storage('notes') },
  { name: 'storage-notes-page', setup: storage('notes', "document.querySelectorAll('.st-pg')[3].click(); await sleep(50); document.querySelector('.st-slot').click(); await sleep(50);") + " show('.st-mapbox');" },
  { name: 'storage-notes-max', setup: storage('notes', max(true) + " document.querySelectorAll('.st-pg')[2].click(); await sleep(50);") + " show('.st-mapbox');" },
  { name: 'storage-index', setup: storage('notes_pkey', "document.querySelectorAll('.st-pg')[1].click(); await sleep(50);") + " show('.st-mapbox');" },
  { name: 'storage-booking', setup: P + `fresh(); ${max(false)} const r = K.app.session.catalog.tables().find((t) => t.name === 'booking'); K.app.openView('storage', { rel: r.oid }); await sleep(150);` },
  { name: 'buffer-8', setup: P + `fresh(); ${max(false)} K.app.runText('select * from booking'); K.app.openView('buffer'); await sleep(150);` },
  { name: 'buffer-128', setup: P + `localStorage.clear(); K.app.settings.frames = 128; K.app.newDatabase(); ${max(true)} K.app.runText('select * from booking; select * from patron'); K.app.openView('buffer'); await sleep(150);` },
  { name: 'buffer-experiment', setup: P + `fresh(); ${max(false)} K.app.openView('buffer'); await sleep(100); document.querySelector('.bp-exp .btn.primary').click(); await sleep(200); document.querySelector('.bp-exp').scrollIntoView();`, wait: 1500 },
  { name: 'disk-hdd', setup: P + `fresh(); ${max(false)} K.app.runText('select * from booking'); K.app.openView('disk'); await sleep(150); show('.dk-platter');` },
  { name: 'disk-ssd', setup: P + `fresh(); ${max(false)} K.app.openView('disk'); await sleep(100); document.querySelectorAll('.dk-head .seg button')[1].click(); for (let k = 0; k < 6; k++) document.querySelector('.dk-ftl .btn').click(); await sleep(50); show('.dk-ftl');` },
  { name: 'disk-raid5', setup: P + `fresh(); ${max(false)} K.app.openView('disk'); await sleep(100); document.querySelectorAll('.dk-head .seg button')[2].click(); click('.dk-raid .seg button', '^RAID 5$'); document.querySelectorAll('.dk-disk')[2].click(); await sleep(50); show('.dk-raid');` },
  { name: 'disk-raid0', setup: P + `fresh(); ${max(false)} K.app.openView('disk'); await sleep(100); document.querySelectorAll('.dk-head .seg button')[2].click(); click('.dk-raid .seg button', '^RAID 0$'); await sleep(50); show('.dk-raid');` },
  { name: 'disk-raid6', setup: P + `fresh(); ${max(true)} K.app.openView('disk'); await sleep(100); document.querySelectorAll('.dk-head .seg button')[2].click(); click('.dk-raid .seg button', '^RAID 6$'); document.querySelectorAll('.dk-disk')[0].click(); document.querySelectorAll('.dk-disk')[3].click(); await sleep(50); show('.dk-raid');` },
  { name: 'disk-raid10', setup: P + `fresh(); ${max(true)} K.app.openView('disk'); await sleep(100); document.querySelectorAll('.dk-head .seg button')[2].click(); click('.dk-raid .seg button', '^RAID 1'); await sleep(50); show('.dk-raid');` },
  { name: 'columns', setup: P + `fresh(); ${max(false)} K.app.openView('columns'); await sleep(150);` },

  // analytics and advanced
  { name: 'cube-theatre', setup: P + `fresh(); K.app.openView('cube'); ${max(true)} await sleep(300); show('.ox-lat');`, wait: 1500 },
  { name: 'cube-4d', setup: P + `fresh(); K.app.openView('cube'); ${max(true)} await sleep(300); choose(pane().querySelector('.view-head select'), 'custom'); await sleep(100); choose(pane().querySelectorAll('.adv-body select')[0], 'booking'); await sleep(100); for (const c of ['perf_id', 'seats', 'rating', 'patron_id']) { const i = [...document.querySelectorAll('.ox-cp')].find((l) => l.textContent === c).querySelector('input'); i.checked = true; i.dispatchEvent(new Event('change')); await sleep(50); } show('.ox-lat');`, wait: 1500 },
  { name: 'cube-side', setup: P + `fresh(); K.app.openView('cube'); ${max(false)} await sleep(300); show('.ox-lat');`, wait: 1500 },
  { name: 'stream-tumbling', setup: P + `fresh(); K.app.openView('stream'); ${max(true)} await sleep(100); click('.adv-seg button', '^Tumbling$'); document.querySelector('.adv-hist button[title="To the end of the stream"]').click(); show('.ds-tl');` },
  { name: 'stream-hopping', setup: P + `fresh(); K.app.openView('stream'); ${max(true)} await sleep(100); click('.adv-seg button', '^Hopping$'); document.querySelector('.adv-hist button[title="To the end of the stream"]').click(); show('.ds-tl');` },
  { name: 'stream-session', setup: P + `fresh(); K.app.openView('stream'); ${max(true)} await sleep(100); click('.adv-seg button', '^Session$'); document.querySelector('.adv-hist button[title="To the end of the stream"]').click(); show('.ds-tl');` },
  { name: 'stream-mid', setup: P + `fresh(); K.app.openView('stream'); ${max(true)} await sleep(100); click('.adv-seg button', '^Hopping$'); const r = document.querySelector('.ds-range'); r.value = String(+r.max * 0.45); r.dispatchEvent(new Event('input')); await sleep(50); show('.ds-tl');` },
  { name: 'stream-mid-session', setup: P + `fresh(); K.app.openView('stream'); ${max(true)} await sleep(100); click('.adv-seg button', '^Session$'); const r = document.querySelector('.ds-range'); r.value = String(+r.max * 0.6); r.dispatchEvent(new Event('input')); await sleep(50); show('.ds-tl');` },
  { name: 'stream-side', setup: P + `fresh(); K.app.openView('stream'); ${max(false)} await sleep(100); show('.ds-tl');` },
  { name: 'tuning-advisor', setup: P + `fresh(); K.app.openView('tuning'); ${max(true)} await sleep(100); click('.dock-pane:not([hidden]) button', 'Run the advisor'); for (let i = 0; i < 300 && !document.querySelector('.tu-bars'); i++) await sleep(100); click('.dock-pane:not([hidden]) button', 'Run the workload'); await sleep(300); show('.tu-bars');`, wait: 1000 },
  { name: 'program', setup: P + `fresh(); K.app.openView('program'); ${max(false)} await sleep(150); click('.dock-pane:not([hidden]) .btn', 'Run the program'); await sleep(100);` },
  { name: 'program-injection', setup: P + `fresh(); K.app.openView('program', { example: 'injection' }); ${max(true)} await sleep(150); click('.dock-pane:not([hidden]) .btn', 'Run the program'); await sleep(100);` },

  // the page itself
  { name: 'page-welcome', setup: P + `fresh(); await sleep(100); K.app.showWelcome();`, root: 'body' },
  { name: 'page-results', setup: P + `fresh(); K.app.dock.hideSheet(); K.app.runText("select a.*, c.name, c.city, c.budget, 'a long text value that goes on and on for a while' as note from artist a join company c using (company_id)"); await sleep(100);`, root: '.center' },
  { name: 'page-schema', setup: P + `fresh(); K.app.showPanel('schema'); await sleep(100); document.querySelectorAll('.side details').forEach((d) => { d.open = true; });`, root: '.side' },
  { name: 'page-timeline', setup: P + `fresh(); K.app.runText('select * from booking'); K.app.openView('buffer'); ${max(false)} await sleep(150);`, root: '.stepbar' },
  { name: 'page-lesson', setup: P + `fresh(); K.app.showPanel('learn'); await sleep(100); const ch = [...K.Content.chapters.values()].find((c) => c.lessons.length > 2); K.UI.Lessons.open(K.app, ch.lessons[1]); await sleep(150);`, root: 'body' },
  { name: 'page-lesson-txn', setup: P + `fresh(); K.app.showPanel('learn'); await sleep(100); const l = [...K.Content.lessons.values()].find((x) => (x.body || []).some((b) => b.svg)); K.UI.Lessons.open(K.app, l.id); await sleep(150);`, root: 'body' },
  { name: 'page-exercise', setup: P + `fresh(); K.app.showPanel('tasks'); await sleep(100); const x = [...K.Content.exercises.values()].find((e) => e.chapter === 3) || [...K.Content.exercises.values()][0]; K.UI.Exercises.open(K.app, x.id); await sleep(150);`, root: 'body' },
  { name: 'page-about', setup: P + `K.app.showAbout(); await sleep(100);`, root: '.dlg' },
  { name: 'page-author', setup: P + `K.app.showAbout(); await sleep(100); click('.dlg .seg button', 'author'); await sleep(100);`, root: '.dlg' },
];
