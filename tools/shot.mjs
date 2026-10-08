// Screenshot the built page: node tools/shot.mjs out.png [width height] [--js "expr"] [--dark]
import { launch } from './cdp.mjs';
const args = process.argv.slice(2);
const out = args[0] || 'shot.png';
const w = +args[1] || 1440, hgt = +args[2] || 900;
const ji = args.indexOf('--js');
const js = ji >= 0 ? args[ji + 1] : null;
const b = await launch({ width: w, height: hgt, mobile: w < 600 });
try {
  await b.goto('');
  await b.waitFor('window.K && K.app && document.querySelector(".tab")', 20000);
  if (args.includes('--dark')) await b.eval('K.app.settings.theme = "dark"; K.app.applyTheme(); 1');
  if (js) { const r = await b.eval(js); if (r !== undefined) console.log('js:', JSON.stringify(r).slice(0, 2000)); }
  await b.sleep(600);
  await b.screenshot(out);
  for (const l of b.logs) if (l.type === 'error' || l.type === 'exception') console.log(l.type + ': ' + l.text);
} finally { await b.close(); }
