// Runs every end-to-end browser test in this folder (each builds or uses the built index.html) and sums up.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const only = process.argv.slice(2);
const files = readdirSync(here).filter((f) => f.endsWith('.mjs') && f !== 'run.mjs' && (!only.length || only.some((o) => f.includes(o)))).sort();
let failed = 0;
for (const f of files) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [join(here, f)], { encoding: 'utf8', timeout: 20 * 60 * 1000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const last = out.trim().split('\n').filter(Boolean).pop() || '';
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log((ok ? 'ok   ' : 'FAIL ') + f.padEnd(18) + ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's  ' + last.slice(0, 120));
  if (!ok) console.log(out.split('\n').slice(-25).join('\n'));
}
console.log(failed ? failed + ' of ' + files.length + ' suites failed' : 'all ' + files.length + ' suites passed');
process.exit(failed ? 1 : 0);
