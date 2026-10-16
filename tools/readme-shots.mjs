// The screenshots in the README: node tools/readme-shots.mjs [name] (builds first; writes docs/images/*.png)
import { launch } from './cdp.mjs';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import txnScenarios from './diagrams/txn-storage.mjs';
import clusterScenarios from './diagrams/cluster.mjs';
const scen = (list, name) => list.find((x) => x.name === name).setup;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv.includes('--no-build')) execSync('node build.mjs', { cwd: root, stdio: 'ignore' });
mkdirSync(join(root, 'docs/images'), { recursive: true });
const out = (n) => join(root, 'docs/images', n + '.png');
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));

const Q1 = 'select c.name, count(*) as artists, round(avg(a.fee), 2) as average\nfrom company c join artist a on a.company_id = c.company_id\nwhere a.fee > 1000\ngroup by c.name\norder by average desc;';
const setQ = (q) => 'K.app.editor.setValue(' + JSON.stringify(q) + '); K.app.tab.text = K.app.editor.getValue();';
// [file, script run in the page before the shot, size, wait ms]
const SHOTS = [
  ['workbench', setQ(Q1) + "K.app.openView('plan'); K.app.run('current');", [1600, 950]],
  ['plan', setQ(Q1) + "K.app.openView('plan'); K.app.explain(true); setTimeout(() => { const n = document.querySelectorAll('.pl-node')[2]; if (n) n.click(); }, 400);", [1600, 950], 900],
  ['anatomy', setQ("select genre, count(*) as n\nfrom production\nwhere runtime_min > 90 and genre <> 'revue'\ngroup by genre\nhaving count(*) > 1\norder by n desc;") + "K.app.openView('anatomy'); K.app.run('current'); setTimeout(() => { const s = document.querySelectorAll('.anat-step')[1]; if (s) s.scrollIntoView(); }, 300);", [1600, 950], 800],
  ['storage', "K.app.dock.toggleMax(true); K.app.openView('storage', { rel: K.app.session.catalog.lookup({ name: 'booking' }).oid }); setTimeout(() => { const t = document.querySelectorAll('.st-pg')[2]; if (t) t.click(); }, 400);", [1600, 950], 900],
  ['buffer', "K.app.openView('buffer'); K.app.runText('select count(*) from booking b join patron p on b.patron_id = p.patron_id');", [1600, 950], 900],
  ['index', "K.app.runText(\"create table demo_keys (k int primary key, v text); insert into demo_keys select g, 'v' || g from generate_series(1, 60) g; create index demo_btree on demo_keys (k) with (fanout = 4)\"); setTimeout(() => { const s = K.app.session.catalog; K.app.dock.toggleMax(true); K.app.openView('index', { index: s.lookup({ name: 'demo_btree' }).oid }); }, 300);", [1600, 950], 1200],
  ['indexlab', "K.app.dock.toggleMax(true); K.app.openView('indexlab');", [1600, 950], 900],
  ['txn', scen(txnScenarios, 'txn-deadlock3-found'), [1600, 950], 900],
  ['schedule', "K.app.dock.toggleMax(true); K.app.openView('schedule');", [1600, 950], 900],
  ['recovery', scen(txnScenarios, 'rec-aries-redo'), [1600, 950], 900],
  ['log', "K.app.runText(\"begin; update artist set fee = fee + 100 where company_id = 'C08'; commit\"); K.app.dock.toggleMax(true); K.app.openView('log');", [1600, 950], 900],
  ['er', "K.app.dock.toggleMax(true); K.app.openView('er');", [1600, 950], 1200],
  ['erd', "K.app.dock.toggleMax(true); K.app.openView('erd');", [1600, 950], 1200],
  ['algebra', "K.app.dock.toggleMax(true); K.app.openView('algebra');", [1600, 950], 900],
  ['design', "K.app.dock.toggleMax(true); K.app.openView('design');", [1600, 950], 900],
  ['cluster', scen(clusterScenarios, 'ck-raft-partition'), [1600, 950], 1200],
  ['blockchain', "K.app.dock.toggleMax(true); K.app.openView('blockchain');", [1600, 950], 1200],
  ['cube', "K.app.dock.toggleMax(true); K.app.openView('cube');", [1600, 950], 1500],
  ['qplab', "K.app.openView('qplab'); setTimeout(() => document.querySelector('.qpl .btn.primary').click(), 200);", [1600, 950], 9000],
  ['lesson', "K.app.showPanel('learn'); const ch = [...K.Content.chapters.values()].find((c) => c.n === 3); K.UI.Lessons.open(K.app, ch.lessons[5] || ch.lessons[0]);", [1600, 950], 700],
  ['exercise', "K.app.showPanel('tasks'); const ch = [...K.Content.chapters.values()].find((c) => c.n === 3); K.UI.Exercises.open(K.app, ch.exercises[3]);", [1600, 950], 700],
  ['dark', setQ(Q1) + "K.app.settings.theme = 'dark'; K.app.applyTheme(); K.app.openView('plan'); K.app.run('current');", [1600, 950], 700],
  ['phone', setQ(Q1) + "K.app.run('current');", [390, 844], 700],
];

for (const [name, js, size, wait] of SHOTS) {
  if (only.length && !only.includes(name)) continue;
  const b = await launch({ width: size[0], height: size[1], mobile: size[0] < 600 });
  try {
    await b.goto('');
    await b.waitFor('!!(window.K && K.app && document.querySelector(".tab"))', 30000);
    if (name !== 'dark') await b.eval("K.app.settings.theme = 'light'; K.app.applyTheme(); 1");
    await b.eval('(async () => { ' + js + ' })().then(() => 1)');
    await b.sleep(wait || 600);
    await b.screenshot(out(name));
    const errs = b.logs.filter((l) => l.type === 'error' || l.type === 'exception');
    console.log(name + (errs.length ? '  (' + errs.length + ' console errors: ' + errs[0].text.slice(0, 120) + ')' : ''));
  } finally { await b.close(); }
}
