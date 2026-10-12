// Checks the geometry of every diagram: node tools/check-diagrams.mjs [--no-build] [--shots DIR] [--narrow] [filter...]
// Each scenario (tools/diagrams/*.mjs) opens a view in a given state; tools/diagram-audit.js then reports shapes that
// overlap, edges that cross or run through shapes and labels, and labels that collide or are cut off. Exits 1 on any
// problem. --shots writes a screenshot of each scenario; --narrow also checks each scenario at phone width.
import { launch } from './cdp.mjs';
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const shotsAt = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;
const filters = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--shots');
if (!flag('--no-build')) execSync('node build.mjs', { cwd: root, stdio: 'ignore' });
if (shotsAt) mkdirSync(shotsAt, { recursive: true });
const audit = readFileSync(join(root, 'tools/diagram-audit.js'), 'utf8');

// scenarios: [{ name, setup: string of JS run in the page, wait?: ms, root?: CSS selector (default: the visible dock pane), size?: [w, h] }]
const scenarios = [];
const dir = join(root, 'tools/diagrams');
for (const f of readdirSync(dir).filter((x) => x.endsWith('.mjs')).sort()) {
  const m = await import(pathToFileURL(join(dir, f)).href);
  for (const s of m.default) scenarios.push(Object.assign({ file: f }, s));
}
const chosen = scenarios.filter((s) => !filters.length || filters.some((f) => s.name.includes(f) || s.file.includes(f)));
const sizes = [[1440, 900]].concat(flag('--narrow') ? [[390, 844]] : []);

let problems = 0;
const PANE = 'document.querySelector(".dock-pane:not([hidden])")';
for (const size of sizes) {
  const b = await launch({ width: size[0], height: size[1], mobile: size[0] < 600 });
  try {
    for (const s of chosen) {
      const sz = s.size || size;
      if (s.size && size !== sizes[0]) continue;
      await b.send('Emulation.setDeviceMetricsOverride', { width: sz[0], height: sz[1], deviceScaleFactor: 1, mobile: sz[0] < 600 });
      await b.goto('');
      await b.waitFor('!!(window.K && K.app && document.querySelector(".tab"))', 30000);
      await b.eval("K.app.settings.theme = 'light'; K.app.applyTheme(); 1");
      let err = null;
      try { await b.eval('(async () => { ' + s.setup + ' })().then(() => 1)'); } catch (e) { err = e.message; }
      await b.sleep(s.wait || 700);
      if (err) { problems++; console.log('FAIL ' + s.name + ' @' + sz[0] + ': setup failed: ' + err.slice(0, 200)); continue; }
      const res = await b.eval(audit + '\n;JSON.stringify(KweryAudit.run(' + (s.root ? 'document.querySelector(' + JSON.stringify(s.root) + ')' : PANE) + ' || document.body, ' + JSON.stringify(s.opts || {}) + '))');
      const list = JSON.parse(res);
      const errs = b.logs.filter((l) => l.type === 'error' || l.type === 'exception');
      b.logs.length = 0;
      if (shotsAt) await b.screenshot(join(shotsAt, s.name.replace(/[^\w.-]+/g, '_') + '-' + sz[0] + '.png'));
      const bad = list.length + errs.length;
      problems += bad;
      console.log((bad ? 'FAIL ' : 'ok   ') + s.name + ' @' + sz[0] + (bad ? ': ' + list.length + ' problems' + (errs.length ? ', ' + errs.length + ' console errors' : '') : ''));
      for (const p of list.slice(0, flag('--all') ? 1e9 : 25)) console.log('     ' + p.kind.padEnd(19) + p.msg + (p.a ? '  [' + p.a + (p.b ? ' | ' + p.b : '') + ']' : ''));
      if (list.length > 25 && !flag('--all')) console.log('     … and ' + (list.length - 25) + ' more (--all)');
      for (const e of errs.slice(0, 3)) console.log('     console: ' + e.text.slice(0, 200));
    }
  } finally { await b.close(); }
}
console.log(problems ? problems + ' problems' : 'no problems');
process.exit(problems ? 1 : 0);
