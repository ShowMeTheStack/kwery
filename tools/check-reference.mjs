// Checks the reference content in src/content/reference-*.js against the engine:
//   - every runnable example (statements, types, settings, functions) runs without an error in a fresh Theatre
//     database, then runs a second time in the same database (a student may press Run twice), and the Theatre
//     tables still hold the rows they started with; an entry marked { fails: 'SQLSTATE' } must fail with that code
//   - ids are unique; links name a lesson or a view that exists (a missing lesson is a warning: lessons are added
//     by other files); glossary cross-references name glossary entries
//   - every setting in SHOW ALL has an entry and every entry is a real setting; function descriptions name
//     functions, aggregates, window functions or set-returning functions of the registry
// Run: node tools/check-reference.mjs [id-prefix ...] [--verbose]
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';
import { load } from '../tests/load.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const K = load();
const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const only = args.filter((a) => !a.startsWith('--'));
const want = (id) => !only.length || only.some((o) => String(id).startsWith(o));
const problems = [], warnings = [];
const bad = (where, msg) => problems.push(where + ': ' + msg);
const warn = (where, msg) => warnings.push(where + ': ' + msg);

// the lessons (for links) and the reference content
const C = K.Content = { chapters: new Map(), lessons: new Map(), exercises: new Map(), tours: new Map(), variants: {} };
C.chapter = (n, part, title, about) => { C.chapters.set(n, Object.assign(C.chapters.get(n) || { lessons: [], exercises: [] }, { n, part, title, about })); };
C.lesson = (l) => { C.lessons.set(l.id, l); };
C.exercise = (x) => { C.exercises.set(x.id, x); };
C.tour = (t) => { C.tours.set(t.id, t); };
const dir = path.join(root, 'src/content');
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort()) vm.runInThisContext(fs.readFileSync(path.join(dir, f), 'utf8'), { filename: 'src/content/' + f });
const R = C.reference;
if (!R) { console.log('no reference content (K.Content.reference) was registered'); process.exit(1); }
const views = new Set();
for (const f of fs.readdirSync(path.join(root, 'src/ui/views')).filter((f) => f.endsWith('.js'))) for (const m of fs.readFileSync(path.join(root, 'src/ui/views', f), 'utf8').matchAll(/registerView\(\{\s*id:\s*'([\w-]+)'/g)) views.add(m[1]);
for (const f of ['lessons.js', 'reference.js']) { const p = path.join(root, 'src/ui', f); if (fs.existsSync(p)) for (const m of fs.readFileSync(p, 'utf8').matchAll(/registerView\(\{\s*id:\s*'([\w-]+)'/g)) views.add(m[1]); }

// ---- structure -------------------------------------------------------------------------------------------------
const seen = new Map();
const claim = (kind, id) => { const k = kind + ':' + id; if (!id) bad(kind, 'an entry has no id'); else if (seen.has(k)) bad(k, 'id used twice'); else seen.set(k, true); };
const glossIds = new Set((R.glossary || []).map((g) => g.id));
function links(where, list) {
  for (const l of list || []) {
    if (l.lesson && !C.lessons.has(l.lesson)) warn(where, 'lesson ' + l.lesson + ' does not exist (yet)');
    if (l.view && !views.has(l.view)) bad(where, 'view ' + l.view + ' does not exist');
    if (l.term && !glossIds.has(l.term)) bad(where, 'glossary term ' + l.term + ' does not exist');
    if (l.ref && !seen.has(l.ref)) bad(where, 'reference entry ' + l.ref + ' does not exist');
  }
}
for (const s of R.statements || []) { claim('statement', s.id); for (const k of ['name', 'group', 'syntax', 'about']) if (!s[k]) bad('statement:' + s.id, 'no ' + k); }
for (const t of R.types || []) { claim('type', t.id); for (const k of ['name', 'group', 'about']) if (!t[k]) bad('type:' + t.id, 'no ' + k); }
for (const g of R.glossary || []) { claim('term', g.id); for (const k of ['term', 'def']) if (!g[k]) bad('term:' + g.id, 'no ' + k); }
for (const s of R.settings || []) { claim('setting', s.name); if (!s.about) bad('setting:' + s.name, 'no about'); }
for (const s of R.statements || []) links('statement:' + s.id, s.see);
for (const t of R.types || []) links('type:' + t.id, t.see);
for (const s of R.settings || []) links('setting:' + s.name, s.see);
for (const g of R.glossary || []) { links('term:' + g.id, g.see); for (const r of g.related || []) if (!glossIds.has(r)) bad('term:' + g.id, 'related term ' + r + ' does not exist'); }

// settings: the entries and SHOW ALL agree
{
  const db = new K.Database(); const s = db.session();
  const names = new Set(s.exec('show all')[0].rows.map((r) => r[0]));
  const have = new Set((R.settings || []).map((x) => x.name));
  for (const n of names) if (!have.has(n)) bad('settings', n + ' (in SHOW ALL) has no entry');
  for (const n of have) if (!names.has(n)) bad('setting:' + n, 'is not a setting of SHOW ALL');
}
// function descriptions name real functions
{
  const known = new Set([...K.F.FUNCS.keys(), ...K.F.AGGS.keys(), ...K.F.WINS.keys(), ...(K.SRF.defs instanceof Map ? K.SRF.defs.keys() : Object.keys(K.SRF.defs))]);
  for (const n of Object.keys(R.functions || {})) if (!known.has(n)) bad('function:' + n, 'is not in the registry');
  for (const [g, list] of Object.entries(R.functionGroups || {})) for (const n of list) if (!known.has(n)) bad('function group ' + g, n + ' is not in the registry');
  const ops = new Set(K.F.OPS.keys());
  for (const n of Object.keys(R.operators || {})) if (!ops.has(n)) bad('operator:' + n, 'is not in the registry');
}

// ---- the examples run ------------------------------------------------------------------------------------------
const theatre = fs.readFileSync(path.join(root, 'src/data/theatre.sql'), 'utf8');
const base = new K.Database({ pageSize: 4096 });
base.session().exec(theatre);
base.session().exec('analyze');
base.buffers.flushAll();
const snap = K.Snapshot.save(base);
const tables = ['venue', 'stage', 'company', 'person', 'artist', 'production', 'performance', 'casting', 'patron', 'booking', 'mentor'];
const counts = (s) => tables.map((t) => t + '=' + s.exec('select count(*) from ' + t)[0].rows[0][0]).join(' ');
const before = counts(K.Snapshot.load(snap, {}).session());
let ran = 0;
function run(where, sql, fails) {
  if (!sql || !(want(where) || want(where.split(':')[1]))) return;
  const db = K.Snapshot.load(snap, {});
  const s = db.session({ name: 'reference' });
  s.exec("set timezone = 'UTC'");
  for (let pass = 1; pass <= 2; pass++) {
    let err = null, res = null;
    try { res = s.exec(sql); } catch (e) { err = e; }
    if (s.tx && !s.tx.implicit) { try { s.exec('rollback'); } catch (e) { /* none */ } if (!err) bad(where, 'leaves a transaction open'); }
    if (fails) { if (!err) bad(where, 'should fail with ' + fails + ' but ran'); else if (fails !== true && err.code !== fails) bad(where, 'should fail with ' + fails + ', failed with ' + err.code + ': ' + err.message); }
    else if (err) { bad(where, (pass === 2 ? 'second run: ' : '') + (err.code || 'JS') + ': ' + err.message + (err.code ? '' : '\n' + err.stack.split('\n').slice(0, 4).join('\n'))); break; }
    if (verbose && res && pass === 1) { const r = res[res.length - 1]; console.log(where + ': ' + r.tag + (r.rows ? ' (' + r.rows.length + ' rows)' : '')); }
  }
  let after;
  try { after = counts(s); } catch (e) { bad(where, 'leaves the session unable to count the Theatre tables: ' + e.message); after = counts(db.session()); }
  if (after !== before) bad(where, 'changes the Theatre tables: ' + after);
  ran++;
}
for (const s of R.statements || []) if (s.example && s.run !== false) run('statement:' + s.id, s.example, s.fails);
for (const t of R.types || []) if (t.example) run('type:' + t.id, t.example, t.fails);
for (const s of R.settings || []) if (s.example) run('setting:' + s.name, s.example, s.fails);
for (const [n, f] of Object.entries(R.functionExamples || {})) run('function:' + n, f);
for (const g of R.glossary || []) if (g.example) run('term:' + g.id, g.example);
// the psql commands, with the example the pane shows (a NAME is filled in with performance)
for (const [cmd] of K.Meta.HELP) run('psql:' + cmd.split(' ')[0], /\[NAME\]/.test(cmd) ? cmd.replace(/\s*\[.*$/, '') + ' performance' : cmd.replace(/\s*\[.*$/, ''));

for (const w of warnings) if (verbose) console.log('warning ' + w);
for (const p of problems) console.log('PROBLEM ' + p);
console.log(`reference: ${(R.statements || []).length} statements, ${(R.types || []).length} types, ${(R.settings || []).length} settings, ${(R.glossary || []).length} glossary terms, ${Object.keys(R.functions || {}).length} function descriptions; ${ran} examples run; ${problems.length} problems, ${warnings.length} warnings`);
process.exit(problems.length ? 1 : 0);
