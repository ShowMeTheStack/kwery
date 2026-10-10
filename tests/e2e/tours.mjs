// End-to-end test of the guided tours in headless Chrome: every tour is started and walked to the end with its
// Next button; at each step the target must exist, be highlighted (it was there when the step showed), be visible
// and inside the window, and the callout must be on screen. No console errors.
// node tests/e2e/tours.mjs [tour-id ...] [--shots <dir>]   (a screenshot of every step of the tours)
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../../tools/cdp.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const si = args.indexOf('--shots');
const shots = si >= 0 ? args[si + 1] : null;
const only = args.filter((a, i) => !a.startsWith('--') && (si < 0 || i !== si + 1));
if (shots) mkdirSync(shots, { recursive: true });
execFileSync('node', [join(root, 'build.mjs')], { stdio: 'ignore' });

let fails = 0, passes = 0;
const check = (ok, what) => { if (ok) passes++; else { fails++; console.log('FAIL ' + what); } };
const J = JSON.stringify;

const b = await launch({ width: 1440, height: 900 });
try {
  await b.goto('');
  await b.waitFor('window.K && K.app && document.querySelector(".tab")', 30000);
  await b.eval('localStorage.clear(); K.app.settings.theme = "light"; K.app.applyTheme(); K.app.newDatabase(); 1');
  await b.sleep(300);
  const ids = (await b.eval('[...K.Content.tours.keys()]')).filter((id) => !only.length || only.includes(id));
  check(ids.length >= (only.length ? only.length : 7), 'tours found: ' + ids.join(', '));
  // what the current step shows: its target, whether it is highlighted and visible, and where the callout sits
  const state = (id, i) => b.eval(`(() => {
    const st = K.Content.tours.get(${J(id)}).steps[${i}];
    const box = document.querySelector('.tour');
    const t = st.target ? document.querySelector(st.target) : null;
    const r = t ? t.getBoundingClientRect() : null, br = box ? box.getBoundingClientRect() : null;
    const hidden = (e) => { for (let x = e; x; x = x.parentElement) { if (x.hidden) return true; const cs = getComputedStyle(x); if (cs.display === 'none' || cs.visibility === 'hidden') return true; } return false; };
    return {
      target: st.target || null, found: !!t, hi: !!(t && t.classList.contains('tour-hi')), hidden: t ? hidden(t) : null,
      size: r ? r.width > 0 && r.height > 0 : false, inView: r ? r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth : false,
      box: !!box, boxIn: br ? br.left >= 0 && br.top >= 0 && br.right <= innerWidth + 1 && br.bottom <= innerHeight + 1 : false,
      label: box ? box.querySelector('.tour-k').textContent : '',
    };
  })()`);
  for (const id of ids) {
    await b.eval(`document.querySelectorAll('.tour').forEach((e) => e.remove()); K.UI.Tour.start(K.app, ${J(id)}); 1`);
    const n = await b.eval(`K.Content.tours.get(${J(id)}).steps.length`);
    for (let i = 0; i < n; i++) {
      await b.sleep(350);
      const s = await state(id, i);
      const where = id + ' step ' + (i + 1) + ' (' + s.target + ')';
      check(s.box && s.label.endsWith((i + 1) + ' of ' + n), where + ': the callout is missing or on the wrong step: ' + s.label);
      check(s.boxIn, where + ': the callout is not inside the window');
      if (s.target) {
        check(s.found, where + ': no element matches the target');
        if (s.found) {
          check(s.hi, where + ': the target was not there when the step showed (not highlighted)');
          check(!s.hidden && s.size, where + ': the target is hidden or has no size');
          check(s.inView, where + ': the target is outside the window');
        }
      }
      if (shots && !id.startsWith('tour-first')) await b.screenshot(join(shots, id + '-' + (i + 1) + '.png'));
      await b.eval(`document.querySelector('.tour .btn.primary').click(); 1`);
    }
    check(await b.eval(`!document.querySelector('.tour')`), id + ': the tour does not close after its last step');
    // going back a step runs its before() again: the step must still find its target
    if (n > 2) {
      await b.eval(`K.UI.Tour.start(K.app, ${J(id)}); 1`);
      for (let i = 0; i < n - 1; i++) { await b.sleep(120); await b.eval(`document.querySelector('.tour .btn.primary').click(); 1`); }
      await b.sleep(250);
      await b.eval(`[...document.querySelectorAll('.tour .btn')].find((x) => x.textContent === 'Back').click(); 1`);
      await b.sleep(350);
      const s = await state(id, n - 2);
      check(!s.target || (s.found && s.hi && s.size), id + ': step ' + (n - 1) + ' after Back does not find its target ' + s.target);
      await b.eval(`[...document.querySelectorAll('.tour .btn')].find((x) => x.textContent === 'Close').click(); 1`);
    }
  }
  const errs = b.logs.filter((l) => l.type === 'error' || l.type === 'exception');
  for (const e of errs) console.log('console ' + e.type + ': ' + e.text.slice(0, 300));
  check(!errs.length, 'no console errors');
} finally { await b.close(); }
console.log(passes + ' checks passed, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
