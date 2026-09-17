// Checks the lessons and exercises of chapters 12 to 16 (src/content/12-storage.js ... 16-optimization.js):
//   - every lesson's runnable SQL ({ sql } blocks and the SQL of { predict } questions) runs in order in a fresh
//     Theatre database, then a second time in the same database (a student may run a lesson twice), and the
//     Theatre tables hold the rows they started with afterwards
//   - lessons have minutes, at least two { sql } blocks and a { predict } question; views exist; algebra
//     expressions given to the algebra view evaluate
//   - every exercise has a level, a text and exactly three hints; ids are unique
//   - an exercise with a custom check accepts its own worked solution (x.solution, or x.ref for SQL) and turns
//     down a wrong answer; an exercise without one has a reference query that runs and returns rows on the
//     database and on every altered copy
// Run: node tools/check-content-12-16.mjs [id-prefix ...] [--verbose]
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
const theatre = fs.readFileSync(path.join(root, 'src/data/theatre.sql'), 'utf8');
// the page has the sample databases in K.SAMPLES; some checks load the Theatre database from there
K.SAMPLES = Object.assign(K.SAMPLES || {}, { theatre: { title: 'Theatre', sql: theatre } });

const MINE = ['12-storage.js', '13-structures.js', '14-indexing.js', '15-processing.js', '16-optimization.js'];
const problems = [];
const bad = (where, msg) => problems.push(where + ': ' + msg);
const seen = new Map();
let current = null;
const mine = new Set();
const C = K.Content = { chapters: new Map(), lessons: new Map(), exercises: new Map(), tours: new Map(), variants: {} };
const claim = (id, what) => { if (!id) bad(what, 'no id'); else if (seen.has(id)) bad(id, 'id used twice (' + seen.get(id) + ' and ' + what + ')'); else seen.set(id, what + ' in ' + current); };
C.chapter = (n, part, title, about) => { C.chapters.set(n, Object.assign(C.chapters.get(n) || { lessons: [], exercises: [] }, { n, part, title, about })); };
C.lesson = (l) => { claim(l.id, 'lesson'); if (MINE.includes(current)) mine.add(l.id); C.lessons.set(l.id, l); const ch = C.chapters.get(l.chapter); if (!ch) bad(l.id, 'chapter ' + l.chapter + ' does not exist'); else if (!ch.lessons.includes(l.id)) ch.lessons.push(l.id); };
C.exercise = (x) => { claim(x.id, 'exercise'); if (MINE.includes(current)) mine.add(x.id); C.exercises.set(x.id, Object.assign({ kind: 'sql', db: 'theatre' }, x)); const ch = C.chapters.get(x.chapter); if (!ch) bad(x.id, 'chapter ' + x.chapter + ' does not exist'); else if (!ch.exercises.includes(x.id)) ch.exercises.push(x.id); };
C.tour = (t) => { C.tours.set(t.id, t); };
const dir = path.join(root, 'src/content');
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort()) {
  current = f;
  try { vm.runInThisContext(fs.readFileSync(path.join(dir, f), 'utf8'), { filename: 'src/content/' + f }); } catch (e) { bad(f, 'does not load: ' + e.message); }
}
for (const f of MINE) if (!fs.existsSync(path.join(dir, f))) bad(f, 'missing');

const want = (id) => mine.has(id) && (!only.length || only.some((o) => id.startsWith(o)));
const VIEWS = new Set(fs.readdirSync(path.join(root, 'src/ui/views')).filter((f) => f.endsWith('.js')).flatMap((f) => [...fs.readFileSync(path.join(root, 'src/ui/views', f), 'utf8').matchAll(/registerView\(\{\s*id:\s*'([^']+)'/g)].map((m) => m[1])).concat(['lesson', 'exercise']));
const text = (r) => r.rows.map((row) => row.map((v, i) => (v === null || v === undefined ? '∅' : K.T.output(v, r.cols[i].type, { zone: 'UTC' }))).join('\u0001'));
const tables = ['venue', 'stage', 'company', 'person', 'artist', 'production', 'performance', 'casting', 'patron', 'booking', 'mentor'];
function fresh() { const db = new K.Database(); const s = db.session(); s.exec("set timezone = 'UTC'"); s.exec(theatre); return { db, s }; }
const counts = (s) => tables.map((t) => t + ' ' + s.query('select count(*) from ' + t).rows[0][0]).join(', ');
const base = fresh();
const baseCounts = counts(base.s);

function runnable(l) {
  const out = [];
  for (const b of l.body || []) {
    if (b && b.sql && !b.predict && b.run !== false) out.push({ sql: b.sql, fails: b.fails });
    if (b && b.predict && b.sql) out.push({ sql: b.sql, fails: b.fails });
  }
  return out;
}
function runLesson(l, s, pass) {
  let n = 0;
  for (const b of runnable(l)) {
    n++;
    let err = null, res = null;
    const t0 = Date.now();
    try { res = s.exec(b.sql.trim()); } catch (e) { err = e; }
    const ms = Date.now() - t0;
    const where = l.id + ' block ' + n + (pass > 1 ? ' (second run)' : '');
    if (ms > 4000) bad(where, 'takes ' + ms + ' ms: too slow for a lesson');
    if (b.fails) { if (!err) bad(where, 'should fail but ran'); else if (b.fails !== true && err.code !== b.fails) bad(where, 'fails with ' + err.code + ', expected ' + b.fails); }
    else if (err) bad(where, 'error ' + err.code + ': ' + err.message + '\n    ' + b.sql.replace(/\n/g, '\n    '));
    if (verbose && pass === 1) {
      console.log('-- ' + where + ' (' + ms + ' ms)\n' + b.sql);
      if (err) console.log('   ERROR ' + err.code + ': ' + err.message);
      else for (const r of res) {
        if (r.rows) { console.log('   ' + r.cols.map((c) => c.name).join(' | ') + '  (' + r.rows.length + ' rows)'); for (const t of text(r).slice(0, 14)) console.log('   ' + t.replace(/\u0001/g, ' | ')); }
        else console.log('   ' + (r.tag || ''));
      }
    }
  }
  return n;
}

let nLessons = 0, nBlocks = 0;
const lessonsBy = {};
for (const l of C.lessons.values()) {
  if (!want(l.id)) continue;
  nLessons++;
  lessonsBy[l.chapter] = (lessonsBy[l.chapter] || 0) + 1;
  if (!l.title) bad(l.id, 'no title');
  if (!l.minutes) bad(l.id, 'no minutes');
  if (!l.summary) bad(l.id, 'no summary');
  const sqls = (l.body || []).filter((b) => b && b.sql && !b.predict).length;
  const preds = (l.body || []).filter((b) => b && b.predict);
  if (sqls < 2) bad(l.id, 'fewer than two runnable { sql } blocks');
  if (!preds.length) bad(l.id, 'no { predict } question');
  for (const b of preds) {
    const p = b.predict;
    if (!p.q || !Array.isArray(p.options) || p.options.length < 2) bad(l.id, 'a prediction needs a question and options');
    else if (!(p.answer >= 0 && p.answer < p.options.length)) bad(l.id, 'prediction answer out of range: ' + p.q);
    if (!p.explain) bad(l.id, 'prediction without an explanation: ' + p.q);
  }
  for (const b of l.body || []) {
    if (b && b.view && !VIEWS.has(b.view)) bad(l.id, 'unknown view ' + b.view);
    if (b && b.thenView && !VIEWS.has(b.thenView)) bad(l.id, 'unknown view ' + b.thenView);
    if (b && typeof b === 'object' && !['p', 'h', 'list', 'steps', 'tip', 'warn', 'def', 'table', 'sql', 'predict', 'view', 'svg'].some((k) => k in b)) bad(l.id, 'unknown block ' + JSON.stringify(b).slice(0, 80));
    if (b && b.table && b.table.some((r) => r.length !== b.table[0].length)) bad(l.id, 'a table row has the wrong number of cells');
  }
  const { s } = fresh();
  if (l.setup) { try { s.exec(l.setup); } catch (e) { bad(l.id, 'setup fails: ' + e.message); } }
  nBlocks += runLesson(l, s, 1);
  for (const b of l.body || []) if (b && b.view === 'algebra' && b.sel && b.sel.expr) { try { K.Algebra.evaluate(b.sel.expr, s); } catch (e) { bad(l.id, 'algebra ' + b.sel.expr + ': ' + e.message); } }
  try { s.exec('rollback'); } catch (e) { /* none open */ }
  runLesson(l, s, 2);
  try { s.exec('rollback'); } catch (e) { /* none open */ }
  const after = counts(s);
  if (after !== baseCounts) bad(l.id, 'the Theatre tables changed: ' + after);
}

// ---- exercises ----------------------------------------------------------------------------------------------------
let nEx = 0;
const byChapter = {};
const appOf = () => ({ db: fresh().db });
for (const x of C.exercises.values()) {
  if (!want(x.id)) continue;
  nEx++;
  byChapter[x.chapter] = (byChapter[x.chapter] || 0) + 1;
  if (!x.title) bad(x.id, 'no title');
  if (![1, 2, 3].includes(x.level)) bad(x.id, 'level must be 1, 2 or 3');
  if (!x.text) bad(x.id, 'no text');
  if (!Array.isArray(x.hints) || x.hints.length !== 3) bad(x.id, 'needs exactly three hints');
  if (x.check) {
    const sol = x.solution !== undefined ? String(x.solution) : x.ref;
    if (sol === undefined) { bad(x.id, 'a custom check needs a solution (or ref) to test it with'); continue; }
    const app0 = appOf();
    const t0 = Date.now();
    let v;
    try { v = x.check(app0, sol); } catch (e) { bad(x.id, 'check throws on the solution: ' + e.stack); continue; }
    const ms = Date.now() - t0;
    if (!v || !v.ok) bad(x.id, 'check turns down its own solution ' + JSON.stringify(sol).slice(0, 80) + ': ' + (v && v.message));
    const wrongs = [].concat(x.wrongs || ['-98765', 'select 1']);
    for (const w of wrongs) {
      let vw;
      try { vw = x.check(appOf(), w); } catch (e) { bad(x.id, 'check throws on a wrong answer: ' + e.message); continue; }
      if (vw && vw.ok) bad(x.id, 'check accepts a wrong answer: ' + w);
    }
    try { const ve = x.check(appOf(), ''); if (ve && ve.ok) bad(x.id, 'check accepts an empty answer'); } catch (e) { bad(x.id, 'check throws on an empty answer: ' + e.message); }
    if (ms > 4000) bad(x.id, 'checking an answer takes ' + ms + ' ms');
    if (verbose) console.log('-- ' + x.id + ': solution ' + JSON.stringify(sol).slice(0, 60) + ' -> ' + v.message + ' (' + ms + ' ms)');
    if (x.kind !== 'sql' && x.kind !== 'dml' && x.solution !== undefined && !String(x.hints[2] || '').includes(String(x.solutionText || x.solution))) bad(x.id, 'the last hint should give the worked answer (' + (x.solutionText || x.solution) + ')');
    continue;
  }
  if (x.kind !== 'sql' && x.kind !== 'dml') { bad(x.id, 'kind ' + x.kind + ' without a check'); continue; }
  if (!x.ref) { bad(x.id, 'no reference answer'); continue; }
  const s = base.s;
  const variants = [null].concat(x.variants || C.variants[x.db] || []);
  for (let vi = 0; vi < variants.length; vi++) {
    const where = x.id + (vi ? ' on variant ' + vi : '');
    s.exec('begin');
    try {
      if (variants[vi]) s.exec(variants[vi]);
      let r;
      try {
        if (x.kind === 'dml') { s.exec(x.ref); r = s.query(x.after); }
        else { const rs = s.exec(x.ref); r = rs[rs.length - 1]; }
      } catch (e) { bad(where, 'reference fails: ' + e.code + ' ' + e.message); continue; }
      if (!r.rows) { bad(where, 'reference returns no result set'); continue; }
      if (!r.rows.length) bad(where, 'reference returns no rows');
      if (verbose && vi === 0) { console.log('-- ' + x.id + ' (' + r.rows.length + ' rows)'); for (const z of text(r).slice(0, 6)) console.log('   ' + z.replace(/\u0001/g, ' | ')); }
    } finally { s.exec('rollback'); }
  }
}

const per = (o) => Object.entries(o).map(([c, n]) => 'ch ' + c + ': ' + n).join(', ');
console.log(nLessons + ' lessons (' + per(lessonsBy) + '; ' + nBlocks + ' runnable blocks), ' + nEx + ' exercises (' + per(byChapter) + ')');
if (problems.length) { console.log('\n' + problems.length + ' problems:\n' + problems.map((p) => '- ' + p).join('\n')); process.exit(1); }
console.log('All content checks pass.');
