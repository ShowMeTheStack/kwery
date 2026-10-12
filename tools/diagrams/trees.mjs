// Tree- and plan-shaped drawings: every index kind in the Index view (small, medium, stress, a recorded run, the
// large sample's B+ tree), the Index playground (every structure and preset, mid-step, both comparisons), the
// Bloom filter lab, the Plan view (simple and many-way joins), Query anatomy, the algebra trees (deep and wide,
// rules, from SQL), the processing lab (join bars, external sort) and the blockchain (chain, Merkle tree, forks).

// helpers run in the page before each scenario
const H = `
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pane = () => document.querySelector('.dock-pane:not([hidden])');
const until = async (f, ms) => { const t = Date.now(); while (!f()) { if (Date.now() - t > (ms || 20000)) throw new Error('timed out'); await wait(50); } };
const sample = async (id) => {
  const ok = () => K.app.settings.sample === id && K.app.session && K.app.session.catalog.lookup({ name: 'booking' });
  if (!ok() || K.app.restored) { K.app.settings.sample = id; K.app.saveSettings(); K.app.newDatabase(); }
  await until(ok, 60000);
};
const sql = (q) => { const s = K.app.db.session({ name: 'setup' }); try { s.exec(q); } finally { K.app.db.sessions = K.app.db.sessions.filter((x) => x !== s); } };
// views read their stored settings when they are made: close the ones the page reopened, so each starts fresh
const open = async (id, sel) => { for (const o of [...K.app.dock.open]) K.app.dock.close(o.id); K.app.dock.toggleMax(true); K.app.openView(id, sel); await wait(250); };
const index = async (name) => { const r = K.app.session.catalog.lookup({ name }); if (!r) throw new Error('no index ' + name); await open('index', { index: r.oid }); K.app.openView('index', { index: r.oid }); await wait(200); };
const pick = (sel, val) => { const e = [...pane().querySelectorAll(sel)].find((x) => [...x.options].some((o) => o.value === String(val))); if (!e) throw new Error('no select ' + sel + ' with ' + val); e.value = String(val); e.dispatchEvent(new Event('change', { bubbles: true })); };
const button = (sel, text) => { const b = [...pane().querySelectorAll(sel)].find((x) => x.textContent.trim().startsWith(text)); if (!b) throw new Error('no button ' + text); b.click(); };
`;
const S = (body) => H + body;

// ---- the Index view on real indexes -------------------------------------------------------------------------------
const ix = (name, ddl, extra) => S(`await sample('theatre'); sql(${JSON.stringify(ddl)}); await index(${JSON.stringify(name)}); ${extra || ''}`);
const series = (n, f) => Array.from({ length: n }, (_, i) => f(i + 1));
const index = [
  { name: 'ix-bplus-small', setup: ix('ex_bplus_k', "drop table if exists ex_bplus; create table ex_bplus (k int, v text); insert into ex_bplus select g, 'row ' || g from generate_series(1, 30) g; create index ex_bplus_k on ex_bplus (k) with (fanout = 4);") },
  { name: 'ix-bplus-medium', setup: ix('t_k', "drop table if exists t; create table t (k int, v text); insert into t select (g * 37) % 1000, 'r' from generate_series(1, 300) g; create index t_k on t (k) with (fanout = 5);") },
  { name: 'ix-bplus-deep', setup: ix('t_k', "drop table if exists t; create table t (k int, v text); insert into t select g, 'r' from generate_series(1, 400) g; create index t_k on t (k) with (fanout = 3);") },
  { name: 'ix-bplus-longkeys', setup: ix('t_k', "drop table if exists t; create table t (k text, v int); insert into t select 'production-' || md5(g::text), g from generate_series(1, 120) g; create index t_k on t (k) with (fanout = 6);") },
  { name: 'ix-bplus-composite', setup: ix('t_k', "drop table if exists t; create table t (a text, b int, c text); insert into t select 'Genre ' || (g % 7), g, 'Season-' || (g % 3) from generate_series(1, 200) g; create index t_k on t (a, b, c) with (fanout = 4);") },
  { name: 'ix-bplus-page', setup: ix('t_k', "drop table if exists t; create table t (k int, v text); insert into t select g, 'r' from generate_series(1, 3000) g; create index t_k on t (k);") },
  { name: 'ix-bplus-path', setup: ix('ex_bplus_k', "drop table if exists ex_bplus; create table ex_bplus (k int, v text); insert into ex_bplus select g, 'row ' || g from generate_series(1, 60) g; create index ex_bplus_k on ex_bplus (k) with (fanout = 4);", `
    K.app.runText('set enable_seqscan = off; select * from ex_bplus where k between 17 and 33');
    const tl = K.app.timeline; const v = tl.events.map((e, i) => [e, i]).filter(([e]) => e.type === 'btree.visit'); tl.go(v[v.length - 1][1] + 1); await wait(300);`) },
  { name: 'ix-bplus-split', setup: ix('ex_bplus_k', "drop table if exists ex_bplus; create table ex_bplus (k int, v text); insert into ex_bplus select g * 2, 'row ' || g from generate_series(1, 40) g; create index ex_bplus_k on ex_bplus (k) with (fanout = 4);", `
    K.app.runText("insert into ex_bplus values (17, 'a'), (19, 'b'), (21, 'c'), (23, 'd'), (25, 'e')");
    const tl = K.app.timeline; const i = tl.events.findIndex((e) => e.type === 'btree.split'); tl.go(i + 1); await wait(300);`) },
  { name: 'ix-bplus-large', setup: S(`await sample('theatre-large'); const t = K.app.session.catalog.lookup({ name: 'booking' }); const x = K.app.session.catalog.indexesOf(t)[0]; await index(x.name);`), wait: 1200 },
  { name: 'ix-bplus-large-patron', setup: S(`await sample('theatre-large'); const t = K.app.session.catalog.lookup({ name: 'patron' }); const x = K.app.session.catalog.indexesOf(t)[0]; await index(x.name);`), wait: 1200 },
  { name: 'ix-ehash-small', setup: ix('ex_ehash_k', "drop table if exists ex_ehash; create table ex_ehash (k int, v text); insert into ex_ehash select g * 7, 'row ' || g from generate_series(1, 16) g; create index ex_ehash_k on ex_ehash using hash (k) with (scheme = 'extendible', bucket_size = 3);") },
  { name: 'ix-ehash-stress', setup: ix('t_k', "drop table if exists t; create table t (k int, v text); insert into t select g * 13, 'r' from generate_series(1, 300) g; create index t_k on t using hash (k) with (scheme = 'extendible', bucket_size = 2);") },
  { name: 'ix-ehash-longkeys', setup: ix('t_k', "drop table if exists t; create table t (k text, v int); insert into t select 'patron-name-' || md5(g::text), g from generate_series(1, 40) g; create index t_k on t using hash (k) with (scheme = 'extendible', bucket_size = 4);") },
  { name: 'ix-lhash-small', setup: ix('ex_lhash_k', "drop table if exists ex_lhash; create table ex_lhash (k int, v text); insert into ex_lhash select g * 3, 'row ' || g from generate_series(1, 16) g; create index ex_lhash_k on ex_lhash using hash (k) with (scheme = 'linear', bucket_size = 3);") },
  { name: 'ix-lhash-stress', setup: ix('t_k', "drop table if exists t; create table t (k int, v text); insert into t select g * 11, 'r' from generate_series(1, 400) g; create index t_k on t using hash (k) with (scheme = 'linear', bucket_size = 2);") },
  { name: 'ix-shash-small', setup: ix('ex_shash_k', "drop table if exists ex_shash; create table ex_shash (k int, v text); insert into ex_shash select g * 5, 'row ' || g from generate_series(1, 16) g; create index ex_shash_k on ex_shash using hash (k) with (scheme = 'static', buckets = 4, bucket_size = 2);") },
  { name: 'ix-shash-chains', setup: ix('t_k', "drop table if exists t; create table t (k int, v text); insert into t select g, 'r' from generate_series(1, 120) g; create index t_k on t using hash (k) with (scheme = 'static', buckets = 3, bucket_size = 2);") },
  { name: 'ix-bitmap-small', setup: ix('ex_bitmap_genre', "drop table if exists ex_bitmap; create table ex_bitmap (id int, genre text); insert into ex_bitmap select g, case g % 4 when 0 then 'drama' when 1 then 'comedy' when 2 then 'opera' else 'dance' end from generate_series(1, 40) g; create index ex_bitmap_genre on ex_bitmap using bitmap (genre);") },
  { name: 'ix-bitmap-stress', setup: ix('t_k', "drop table if exists t; create table t (id int, k text); insert into t select g, 'Company of ' || (g % 60) || ' and something longer' from generate_series(1, 2000) g; create index t_k on t using bitmap (k);") },
  { name: 'ix-lsm-small', setup: ix('ex_lsm_k', "drop table if exists ex_lsm; create table ex_lsm (k int, v text); create index ex_lsm_k on ex_lsm using lsm (k) with (memtable_size = 4, size_ratio = 3, page_entries = 4, bloom_bits = 8); insert into ex_lsm select (g * 37) % 101, 'row ' || g from generate_series(1, 22) g;") },
  { name: 'ix-lsm-stress', setup: ix('t_k', "drop table if exists t; create table t (k int, v text); create index t_k on t using lsm (k) with (memtable_size = 8, size_ratio = 3, page_entries = 4, bloom_bits = 10); insert into t select (g * 7919) % 100003, 'r' from generate_series(1, 400) g;") },
  { name: 'ix-lsm-longkeys', setup: ix('t_k', "drop table if exists t; create table t (k text, v int); create index t_k on t using lsm (k) with (memtable_size = 6, size_ratio = 2, page_entries = 4, bloom_bits = 8); insert into t select 'customer-' || md5(g::text), g from generate_series(1, 40) g;") },
  { name: 'ix-lsm-probe', setup: ix('ex_lsm_k', "drop table if exists ex_lsm; create table ex_lsm (k int, v text); create index ex_lsm_k on ex_lsm using lsm (k) with (memtable_size = 4, size_ratio = 3, page_entries = 4, bloom_bits = 8); insert into ex_lsm select (g * 37) % 101, 'row ' || g from generate_series(1, 22) g;", `
    K.app.runText('set enable_seqscan = off; select * from ex_lsm where k = 37');
    const tl = K.app.timeline; const i = tl.events.findIndex((e) => e.type === 'lsm.bloom'); if (i >= 0) tl.go(i + 1); await wait(300);`) },
  { name: 'ix-rtree-small', setup: ix('ex_rtree_xy', "drop table if exists ex_rtree; create table ex_rtree (x float8, y float8); insert into ex_rtree select (g * 37) % 100, (g * 61) % 100 from generate_series(1, 24) g; create index ex_rtree_xy on ex_rtree using rtree (x, y) with (max_entries = 4);") },
  { name: 'ix-rtree-stress', setup: ix('t_k', "drop table if exists t; create table t (x float8, y float8); insert into t select (g * 37) % 1000, (g * 61) % 997 from generate_series(1, 300) g; create index t_k on t using rtree (x, y) with (max_entries = 5);") },
];

// ---- the Index playground ---------------------------------------------------------------------------------------------------
const labOpen = (kind, params) => S(`K.UI.store.set('lab.kind', ${JSON.stringify(kind)}); K.UI.store.set('lab.params.${kind}', ${JSON.stringify(params || {})}); await open('indexlab');`);
const cmd = (text, op) => `{ const i = pane().querySelector('.lab-in'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input')); button('.lab-ops .btn', ${JSON.stringify(op || 'Insert')}); await wait(100); }`;
const chip = (text) => `button('.lab-chip', ${JSON.stringify(text)}); await wait(100);`;
const last = `button('.lab-stepbar .btn[title="Last step"]', ''); await wait(150);`;
const stepTo = (f) => `{ const r = pane().querySelector('.lab-stepbar input[type=range]'); r.value = String(Math.round((${f}) * +r.max)); r.dispatchEvent(new Event('input')); await wait(150); }`;
const PRESETS = {
  bplus: ['Ten keys', 'Ascending 1…20', 'Then delete 21 26 33'], btree: ['Ten keys', 'Ascending 1…20', 'Then delete 44 14'],
  'static-hash': ['Twelve keys', 'Search 34'], 'extendible-hash': ['Twelve keys', 'Then delete 15 22 27'], 'linear-hash': ['Twelve keys', 'Search 60'],
  lsm: ['Twenty keys', 'Search 44', 'Delete 12'], bitmap: ['Income levels', 'Search L1', 'Range L1…L2'],
  rtree: ['Twelve points', 'Window (5,5)–(50,50)'], kdtree: ['Eight points', 'Range (15,15)–(65,70)'], quadtree: ['Eight points', 'Range (15,15)–(65,70)'],
};
const lab = [];
for (const [kind, list] of Object.entries(PRESETS)) {
  // every preset in turn, at the last step, and a mid-operation step of the first
  let acc = '';
  list.forEach((p, i) => {
    acc += chip(p);
    lab.push({ name: 'lab-' + kind + '-' + (i + 1), setup: labOpen(kind) + acc + last, wait: 900 });
  });
  lab.push({ name: 'lab-' + kind + '-mid', setup: labOpen(kind) + chip(list[0]) + stepTo('0.55'), wait: 900 });
}
const spatial = new Set(['rtree', 'kdtree', 'quadtree']);
for (const kind of Object.keys(PRESETS)) lab.push({ name: 'lab-' + kind + '-random', setup: labOpen(kind) + cmd(spatial.has(kind) ? 'random 60' : kind === 'bitmap' ? 'random 120' : 'random 120') + last, wait: 900 });
lab.push(
  { name: 'lab-bplus-fanout3-deep', setup: labOpen('bplus', { fanout: 3 }) + cmd('insert ' + series(80, (i) => i).join(' ')) + last, wait: 900 },
  { name: 'lab-bplus-fanout10', setup: labOpen('bplus', { fanout: 10 }) + cmd('insert ' + series(150, (i) => (i * 37) % 1000).join(' ')) + last, wait: 900 },
  { name: 'lab-bplus-split-pending', setup: labOpen('bplus', { fanout: 4 }) + chip('Ascending 1…20') + `{ const r = pane().querySelector('.lab-stepbar input[type=range]'); const items = [...pane().querySelectorAll('.lab-li')]; const k = items.findIndex((x) => /split/.test(x.textContent) && +x.querySelector('.n').textContent > 30); r.value = String(k >= 0 ? +items[k].querySelector('.n').textContent : 5); r.dispatchEvent(new Event('input')); await wait(150); }`, wait: 900 },
  { name: 'lab-btree-order3', setup: labOpen('btree', { order: 3 }) + cmd('insert ' + series(60, (i) => i).join(' ')) + last, wait: 900 },
  { name: 'lab-ehash-bs1', setup: labOpen('extendible-hash', { bucket_size: 1 }) + cmd('insert ' + series(30, (i) => i * 8).join(' ')) + last, wait: 900 },
  { name: 'lab-lsm-tiered', setup: labOpen('lsm', { memtable_size: 2, compaction: 'tiered', size_ratio: 2, bloom_bits: 10 }) + cmd('insert ' + series(60, (i) => (i * 37) % 101).join(' ')) + last, wait: 900 },
  { name: 'lab-quadtree-cap1-dense', setup: labOpen('quadtree', { capacity: 1 }) + cmd('insert (1,1) (2,2) (3,3) (4,4) (5,5) (6,6) (90,90) (91,92) (50,50) (51,49)') + last, wait: 900 },
  { name: 'lab-cmp-btree', setup: labOpen('bplus', { fanout: 4 }) + `button('.ix-head .seg button', 'B+ vs B-tree'); await wait(100);` + chip('8 14 21') + chip('search 38'), wait: 900 },
  { name: 'lab-cmp-btree-random', setup: labOpen('bplus', { fanout: 3 }) + `button('.ix-head .seg button', 'B+ vs B-tree'); await wait(100);` + cmd('random 60'), wait: 900 },
  { name: 'lab-cmp-lsm', setup: labOpen('bplus') + `button('.ix-head .seg button', 'LSM vs B+'); await wait(100);` + chip('random 500'), wait: 900 },
);

// ---- the Bloom filter lab ------------------------------------------------------------------------------------------------
const bloom = [
  { name: 'bloom-default', setup: S(`K.UI.store.set('bloom.m', 64); K.UI.store.set('bloom.k', 3); await open('bloom'); const i = pane().querySelector('.lab-in'); i.value = 'Mozart Einstein Gold Katz Singh Crick'; i.dispatchEvent(new Event('input')); button('.lab-ops .btn', 'Insert'); await wait(150);`) },
  { name: 'bloom-big', setup: S(`K.UI.store.set('bloom.m', 1024); K.UI.store.set('bloom.k', 16); await open('bloom'); const i = pane().querySelector('.lab-in'); i.value = Array.from({ length: 120 }, (_, j) => 'key' + j).join(' '); i.dispatchEvent(new Event('input')); button('.lab-ops .btn', 'Insert'); await wait(150);`) },
];

// ---- plans --------------------------------------------------------------------------------------------------------------------
const plan = (smp, q) => S(`await sample(${JSON.stringify(smp)}); K.app.runText(${JSON.stringify(q)}); await open('plan'); K.app.openView('plan'); await wait(200);`);
const BIG = `select c.name, pr.title, count(distinct b.patron_id) as patrons, avg(pa.points) as points, max(f.price)
from company c join production pr on pr.company_id = c.company_id join performance f on f.prod_id = pr.prod_id
join booking b on b.perf_id = f.perf_id
join patron pa on pa.patron_id = b.patron_id join venue v on v.venue_code = f.venue_code
where c.budget > (select avg(budget) from company) and pa.points > 20 and pr.prod_id in (select prod_id from casting)
group by c.name, pr.title having count(*) > 1 order by patrons desc limit 20`;
const UNION = `select billed_as from artist where fee > (select avg(fee) from artist) union select p.name from patron p where exists (select 1 from booking b join performance f using (perf_id) where b.patron_id = p.patron_id and f.venue_code = 'GLA') order by 1`;
const plans = [
  { name: 'plan-simple', setup: plan('theatre', "select title from production where genre = 'opera'") },
  { name: 'plan-join', setup: plan('theatre', 'select p.family_name, c.prod_id from person p join casting c on p.person_id = c.person_id order by 1') },
  { name: 'plan-6way', setup: plan('theatre', BIG), wait: 1000 },
  { name: 'plan-6way-analyze', setup: plan('theatre', 'explain analyze ' + BIG), wait: 1000 },
  { name: 'plan-union-subq', setup: plan('theatre', UNION), wait: 1000 },
  { name: 'plan-6way-large', setup: plan('theatre-large', BIG), wait: 1500 },
  { name: 'plan-select-node', setup: plan('theatre', BIG) + `pane().querySelector('.pl-node.op-HashJoin, .pl-node').click(); await wait(200);`, wait: 1000 },
  { name: 'plan-stepping', setup: plan('theatre', 'select p.family_name, c.prod_id from person p join casting c on p.person_id = c.person_id') + `const tl = K.app.timeline; const r = tl.events.findIndex((e) => e.type === 'exec.row'); tl.go(r + 30); await wait(200);`, wait: 1000 },
  { name: 'plan-algebra-tab', setup: plan('theatre', BIG) + `button('.view-head .seg button', 'Algebra'); await wait(150);` },
  { name: 'plan-trace-tab', setup: plan('theatre', 'explain ' + BIG) + `button('.view-head .seg button', 'What the optimizer'); await wait(150);` },
  { name: 'anatomy', setup: S(`await sample('theatre'); K.app.runText(${JSON.stringify("select company_id, count(*) as n, avg(fee) from artist where fee > 500 and company_id is not null and billed_as is null group by company_id having count(*) > 1 order by n desc limit 5")}); await open('anatomy'); K.app.openView('anatomy'); await wait(300);`), wait: 1000 },
];

// ---- algebra trees -----------------------------------------------------------------------------------------------------------
const alg = (mode, expr, extra) => S(`await sample('theatre'); K.UI.store.set('alg.mode', ${JSON.stringify(mode)}); K.UI.store.set('alg.expr', ${JSON.stringify(expr)}); ${extra || ''} await open('algebra'); await wait(300);`);
const DEEP = "π[person_id](σ[fee > 1000](ρ[x](π[person_id, fee, company_id](σ[company_id ≠ 'C02'](σ[fee < 20000](π[person_id, company_id, billed_as, fee](σ[person_id ≠ 'P0'](artist)))))))) ∪ π[person_id](σ[home_city = 'Saltreach'](person))";
const WIDE = "π[prod_id](performance) ∪ π[prod_id](production) ∪ π[prod_id](casting) ∪ π[prod_id](σ[lead](casting)) ∪ π[prod_id](σ[genre = 'opera'](production)) ∪ π[prod_id](σ[runtime_min > 120](production)) ∪ π[prod_id](σ[venue_code = 'GLA'](performance)) ∪ π[prod_id](σ[price > 40](performance))";
const LONG = "π[family_name, title, role_name, venue_code, perf_date](σ[genre = 'drama' ∧ runtime_min ≥ 90 ∧ lead ∧ price > 20](person ⋈ casting ⋈ performance ⋈ π[prod_id, title, genre, runtime_min](production)))";
const FROMSQL = "select p.name, count(*) from patron p join booking b on p.patron_id = b.patron_id join performance f on b.perf_id = f.perf_id join production pr on pr.prod_id = f.prod_id where pr.genre = 'drama' and exists (select 1 from booking x where x.patron_id = p.patron_id and x.rating = 5) and p.name not in (select billed_as from artist where billed_as is not null) group by p.name having count(*) > 1";
const algebra = [
  { name: 'alg-default', setup: alg('eval', "π[family_name, role_name](σ[company_id = 'C08'](artist) ⋈ person ⋈ casting)") },
  { name: 'alg-deep', setup: alg('eval', DEEP), wait: 1000 },
  { name: 'alg-wide', setup: alg('eval', WIDE), wait: 1000 },
  { name: 'alg-long-labels', setup: alg('eval', LONG), wait: 1000 },
  { name: 'alg-assign', setup: alg('eval', "operas ← σ[genre = 'opera'](production)\ndances ← σ[genre = 'dance'](production)\nπ[title](operas ⋈ performance) ∪ π[title](dances ⋈ performance)"), wait: 1000 },
  { name: 'alg-stepped', setup: alg('eval', WIDE) + `const b = [...pane().querySelectorAll('.th-step .btn')]; b[2].click(); await wait(100); b[2] && pane().querySelectorAll('.th-step .btn')[2].click(); await wait(100); pane().querySelectorAll('.th-step .btn')[2].click(); await wait(150);`, wait: 1000 },
  { name: 'alg-rules', setup: alg('rules', "π[family_name, title](σ[genre = 'opera' ∧ fee > 2000](person ⋈ artist ⋈ casting ⋈ π[prod_id, title, genre](production)))"), wait: 1000 },
  { name: 'alg-rules-deep', setup: alg('rules', DEEP), wait: 1000 },
  { name: 'alg-from-sql', setup: alg('from', '', `K.UI.store.set('alg.sql', ${JSON.stringify(FROMSQL)});`), wait: 1200 },
  { name: 'alg-division', setup: alg('eval', "π[venue_code, genre](performance ⋈ π[prod_id, genre](production)) ÷ π[genre](σ[genre = 'opera' ∨ genre = 'musical'](production))"), wait: 1000 },
];

// ---- the processing lab -------------------------------------------------------------------------------------------------------
const qp = (body) => S(`await sample('theatre'); ${body}`);
const qplab = [
  { name: 'qplab-join', setup: qp(`K.UI.store.set('qplab.tab', 'join'); K.UI.store.set('qplab.frames', 8); await open('qplab'); button('.qpl-row .btn', 'Run with'); await until(() => pane().querySelector('.qpl-t'), 30000); await wait(200);`), wait: 1000 },
  { name: 'qplab-sort-booking', setup: qp(`K.UI.store.set('qplab.tab', 'sort'); K.UI.store.set('qplab.sortRel', 'booking'); K.UI.store.set('qplab.M', 3); await open('qplab'); for (let i = 0; i < 6; i++) { button('.qpl-row .btn', 'Next pass'); await wait(60); }`), wait: 900 },
  { name: 'qplab-sort-small', setup: qp(`K.UI.store.set('qplab.tab', 'sort'); K.UI.store.set('qplab.sortRel', 'company'); K.UI.store.set('qplab.M', 16); await open('qplab');`), wait: 900 },
  { name: 'qplab-sort-large', setup: S(`await sample('theatre-large'); K.UI.store.set('qplab.tab', 'sort'); K.UI.store.set('qplab.sortRel', 'booking'); K.UI.store.set('qplab.M', 4); await open('qplab'); for (let i = 0; i < 6; i++) { button('.qpl-row .btn', 'Next pass'); await wait(60); }`), wait: 1500 },
];

// ---- the blockchain --------------------------------------------------------------------------------------------------------------
const chain = (tab, body) => S(`K.UI.store.set('chain.tab', ${JSON.stringify(tab)}); await open('blockchain'); ${body || ''}`);
const addTx = (n) => `{ const sel = pane().querySelector('.bc-form select'); pick('.bc-form select', 'Alice'); const a = pane().querySelector('.bc-form input'); a.value = '1'; a.dispatchEvent(new Event('input')); for (let j = 0; j < ${n}; j++) { button('.bc-form .btn', 'Add'); await wait(30); } }`;
const blockchain = [
  { name: 'chain-default', setup: chain('chain'), wait: 900 },
  { name: 'chain-merkle-8', setup: chain('chain', `pick('.adv-head select, .adv-sec select', '1'); await wait(100); ${addTx(9)} button('.btn', 'Mine a block'); await until(() => !pane().querySelector('.adv-busy'), 30000); await wait(200);`), wait: 900 },
  { name: 'chain-tampered', setup: chain('chain', `const amt = pane().querySelector('.bc-amt'); amt.value = '999'; amt.dispatchEvent(new Event('change', { bubbles: true })); await wait(150);`), wait: 900 },
  { name: 'chain-forks', setup: chain('forks', `button('.btn', 'A and B mine at once'); await wait(150); button('.btn', 'B mines'); await wait(150); button('.btn', 'A and B mine at once'); await wait(150); button('.btn', 'A mines'); await wait(150); button('.btn', 'A and B mine at once'); await wait(150);`), wait: 900 },
];

export default [...index, ...lab, ...bloom, ...plans, ...algebra, ...qplab, ...blockchain];
