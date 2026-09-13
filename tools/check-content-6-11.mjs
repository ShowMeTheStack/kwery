// Checks the lessons and exercises of chapters 6 to 11 beyond what tools/check-content.mjs does:
//   - an E-R model a lesson opens ({ view: 'er', sel: { text } }) parses, has no errors, and reduces to tables;
//     the design checker codes a lesson says it shows (sel.expect) are among the ones the checker reports
//   - a schema and dependencies a lesson opens in the design workbench ({ view: 'design', sel: { schema, deps } })
//     parse, and a preset or tab it names exists
//   - an exercise with its own check accepts its reference answer and rejects each of its `wrongs`
//   - every view a lesson opens is registered
// Then it runs tools/check-content.mjs on the same lessons and exercises, which runs every SQL block in a fresh
// Theatre database (twice) and every reference answer on the database and its altered copies.
// Run: node tools/check-content-6-11.mjs [--verbose]
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { load } from '../tests/load.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const K = load();
const verbose = process.argv.includes('--verbose');
const FILES = ['06-er.js', '07-design.js', '08-complex.js', '09-apps.js', '10-bigdata.js', '11-analytics.js'];
const theatre = fs.readFileSync(path.join(root, 'src/data/theatre.sql'), 'utf8');

const problems = [];
const bad = (where, msg) => problems.push(where + ': ' + msg);
const C = K.Content = { chapters: new Map(), lessons: new Map(), exercises: new Map(), tours: new Map(), variants: {} };
const mine = { lessons: [], exercises: [] };
let loading = null;
C.chapter = (n, part, title, about) => { C.chapters.set(n, Object.assign(C.chapters.get(n) || { lessons: [], exercises: [] }, { n, part, title, about })); };
C.lesson = (l) => { C.lessons.set(l.id, l); if (loading) mine.lessons.push(l); };
C.exercise = (x) => { x = Object.assign({ kind: 'sql', db: 'theatre' }, x); C.exercises.set(x.id, x); if (loading) mine.exercises.push(x); };
C.tour = () => {};
const dir = path.join(root, 'src/content');
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort()) {
  loading = FILES.includes(f) ? f : null;
  vm.runInThisContext(fs.readFileSync(path.join(dir, f), 'utf8'), { filename: 'src/content/' + f });
}
loading = null;
for (const f of FILES) if (!fs.existsSync(path.join(dir, f))) bad(f, 'missing');

const VIEWS = new Set();
for (const d of ['src/ui', 'src/ui/views']) for (const f of fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith('.js'))) for (const m of fs.readFileSync(path.join(root, d, f), 'utf8').matchAll(/registerView\(\{\s*id:\s*'([\w-]+)'/g)) VIEWS.add(m[1]);
const DESIGN_TABS = ['closure', 'proof', 'keys', 'cover', 'nf', 'decomp', 'lossless', 'pres', 'anom'];
const DESIGN_PRESETS = [...fs.readFileSync(path.join(root, 'src/ui/views/design.js'), 'utf8').matchAll(/\{ id: '([\w-]+)', title: '/g)].map((m) => m[1]);

function viewBlock(where, b) {
  if (!VIEWS.has(b.view)) bad(where, 'unknown view ' + b.view);
  const sel = b.sel || {};
  if (b.view === 'er' && sel.text) {
    const p = K.ER.tryParse(sel.text);
    if (p.error) { bad(where, 'E-R model does not parse: ' + p.error.message); return; }
    const errs = K.ER.errors(p.model);
    if (errs.length) bad(where, 'E-R model has errors: ' + errs.map((e) => e.message).join('; '));
    else { try { K.ER.toRelational(p.model); } catch (e) { bad(where, 'E-R model does not reduce: ' + e.message); } }
    const codes = K.ER.check(p.model).map((x) => x.code).concat(K.ER.validate(p.model).map((x) => x.code));
    for (const c of [].concat(sel.expect || [])) if (!codes.includes(c)) bad(where, 'the design checker does not report ' + c + ' (it reports ' + (codes.join(', ') || 'nothing') + ')');
    if (verbose) console.log('-- ' + where + ' E-R model: ' + p.model.entities.length + ' entity sets, checks: ' + (codes.join(', ') || 'none'));
  }
  if (b.view === 'design') {
    if (sel.schema) { try { const P = K.Normal.problem(sel.schema, sel.deps || ''); if (verbose) console.log('-- ' + where + ' design: ' + P.attrs.join(',') + ', keys ' + K.Normal.keys(P).keys.map((k) => k.join(',')).join(' ')); } catch (e) { bad(where, 'design schema does not parse: ' + e.message); } }
    if (sel.preset && !DESIGN_PRESETS.includes(sel.preset)) bad(where, 'no design preset ' + sel.preset);
    if (sel.tab && !DESIGN_TABS.includes(sel.tab)) bad(where, 'no design tab ' + sel.tab);
  }
}
for (const l of mine.lessons) {
  if (l.chapter < 6 || l.chapter > 11) bad(l.id, 'chapter ' + l.chapter + ' is not one of 6 to 11');
  (l.body || []).forEach((b, i) => { if (b && b.view) viewBlock(l.id + ' block ' + (i + 1), b); });
  const words = JSON.stringify(l.body).match(/!(?=[\s"'])/g);
  if (words) bad(l.id, 'an exclamation mark in the text');
}

// exercises checked by a function of their own: the reference must pass and each wrong answer must fail
function fakeApp() { const db = new K.Database(); const s = db.session(); s.exec("set timezone = 'UTC'"); s.exec(theatre); db.sessions = db.sessions.filter((x) => x !== s); return { db }; }
for (const x of mine.exercises) {
  for (const b of [].concat(x.text || [])) if (b && b.view) viewBlock(x.id, b);
  if (!x.check) continue;
  const app = fakeApp();
  let r;
  try { r = x.check(app, x.ref); } catch (e) { r = { ok: false, message: 'threw ' + e.message }; }
  if (!r.ok) bad(x.id, 'its own check rejects the reference answer: ' + r.message);
  for (const w of x.wrongs || []) {
    let v;
    try { v = x.check(app, w); } catch (e) { v = { ok: false }; }
    if (v.ok) bad(x.id, 'its own check accepts a wrong answer: ' + w.split('\n')[0]);
    else if (verbose) console.log('-- ' + x.id + ' rejects: ' + v.message);
  }
  if (!(x.wrongs || []).length) bad(x.id, 'an exercise with its own check should list wrong answers it rejects');
}

const counts = {};
for (const l of mine.lessons) counts[l.chapter] = counts[l.chapter] || { l: 0, x: 0 }, counts[l.chapter].l++;
for (const x of mine.exercises) counts[x.chapter] = counts[x.chapter] || { l: 0, x: 0 }, counts[x.chapter].x++;
console.log('chapters 6-11: ' + Object.entries(counts).map(([c, n]) => 'ch ' + c + ' ' + n.l + ' lessons, ' + n.x + ' exercises').join('; '));

// the general checks, on the same ids
const ids = mine.lessons.map((l) => l.id).concat(mine.exercises.map((x) => x.id));
const run = spawnSync(process.execPath, [path.join(root, 'tools/check-content.mjs'), ...ids, ...(verbose ? ['--verbose'] : [])], { encoding: 'utf8', maxBuffer: 64 << 20 });
const out = (run.stdout || '') + (run.stderr || '');
const lines = out.split('\n');
const ownIds = new Set(ids);
// check-content also reports problems elsewhere (another writer's ids); keep the ones about these files
let general = lines;
const at = lines.findIndex((s) => /^\d+ problems:/.test(s));
if (at >= 0) {
  const rest = [];
  for (let i = at + 1; i < lines.length; i++) {
    const m = /^- ([\w-]+)/.exec(lines[i]);
    if (m && [...ownIds].some((id) => m[1] === id)) { rest.push(lines[i]); for (let j = i + 1; j < lines.length && !lines[j].startsWith('- '); j++) rest.push(lines[j]); }
  }
  for (const r of rest) if (r.startsWith('- ')) problems.push('check-content ' + r.slice(2)); else if (r.trim()) problems.push('    ' + r.trim());
  general = lines.slice(0, at);
}
console.log(general.filter((s) => s.trim()).join('\n'));
if (problems.length) { console.log('\n' + problems.length + ' problems:\n' + problems.map((p) => (p.startsWith('    ') ? p : '- ' + p)).join('\n')); process.exit(1); }
console.log('All chapter 6-11 checks pass.');
