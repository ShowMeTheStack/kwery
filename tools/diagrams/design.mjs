// The design theory workbench: the decomposition trees of every preset (BCNF, 3NF and, where there are multivalued
// dependencies, 4NF), and each of the other tabs on a preset. The presets are read from the view itself.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../src/ui/views/design.js'), 'utf8');
const PRESETS = new Function('return ' + /const PRESETS = (\[[\s\S]*?\n  \]);/.exec(src)[1])();
const wait = (ms) => 'await new Promise((r) => setTimeout(r, ' + ms + '));';
// open the workbench maximized on a schema and a tab (afresh, so that it reads them); mode: the button of the decomposition to show
const open = (p, tab, mode) => "if (K.app.dock.open.some((o) => o.id === 'design')) K.app.dock.close('design'); localStorage.setItem('kwery.des.schema', " + JSON.stringify(JSON.stringify(p.schema)) + "); localStorage.setItem('kwery.des.deps', " + JSON.stringify(JSON.stringify(p.deps)) + "); localStorage.setItem('kwery.des.tab', " + JSON.stringify(JSON.stringify(tab)) + "); localStorage.setItem('kwery.des.folded', 'false');" +
  " K.app.dock.toggleMax(true); K.app.openView('design'); " + wait(400) +
  (mode ? " { const b = [...document.querySelectorAll('.th-view .seg button')].find((x) => x.textContent.startsWith(" + JSON.stringify(mode) + ")); if (b) b.click(); } " + wait(300) : '');
const ROOT = '.th-view:has(.de-tabbody)';
const scenarios = [];
for (const p of PRESETS) {
  scenarios.push({ name: 'design-' + p.id + '-bcnf', setup: open(p, 'decomp'), wait: 700, root: ROOT });
  scenarios.push({ name: 'design-' + p.id + '-3nf', setup: open(p, 'decomp', '3NF'), wait: 700, root: ROOT });
  if (/↠|->>/.test(p.deps)) scenarios.push({ name: 'design-' + p.id + '-4nf', setup: open(p, 'decomp', '4NF'), wait: 700, root: ROOT });
}
for (const tab of ['closure', 'proof', 'keys', 'cover', 'nf', 'lossless', 'pres', 'anom']) scenarios.push({ name: 'design-tab-' + tab, setup: open(PRESETS[0], tab), wait: 700, root: ROOT });
export default scenarios;
