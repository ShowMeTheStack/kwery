// Checks the lessons, exercises and tours of chapters 17 to 26 (src/content/17-transactions.js ... 26-blockchain.js,
// and the tours in src/content/tours-more.js):
//   - every lesson's runnable SQL ({ sql } blocks and the SQL of { predict } questions) runs in order in a fresh
//     Theatre database, then a second time in the same database (a student may run a lesson twice), and the
//     Theatre tables hold the rows they started with afterwards
//   - a block marked { tab: 2 } (or 3) runs in a second (third) session, as the student runs it in a second editor
//     tab; blocks run with Session.start() and Database.step(), so a statement may wait for a lock while the other
//     tab goes on. A block marked { waits: true } must still be waiting right after it is run; { fails: 'SQLSTATE' }
//     must end with that error (true: any error), whenever it ends; every block must have ended when the lesson does
//   - a lesson leaves the settings it changes as it found them (concurrency control, deadlock handling, buffer
//     policies...), so the student's next lesson starts from the defaults
//   - lessons have minutes, a summary, at least two { sql } blocks and a { predict } question; the views they open
//     exist (the views still being built are only noted)
//   - every exercise has a level, a text, exactly three hints; ids are unique; an exercise with a custom check
//     accepts its worked solution (x.solution, or x.ref) and turns down its `wrongs`, a stray number, a stray query
//     and an empty answer, and its last hint gives the worked answer; an SQL exercise's reference runs and returns
//     rows on the database and on every altered copy
//   - every tour has steps with text, and its targets are CSS selectors (tests/e2e/tours.mjs checks them in a browser)
// Run: node tools/check-content-17-26.mjs [id-prefix ...] [--verbose]
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
K.SAMPLES = Object.assign(K.SAMPLES || {}, { theatre: { title: 'Theatre', sql: theatre } });

const MINE = ['17-transactions.js', '18-concurrency.js', '19-recovery.js', '20-architectures.js', '21-distributed-storage.js', '22-distributed-queries.js', '23-distributed-tx.js', '24-advanced-indexing.js', '25-tuning.js', '26-blockchain.js', 'tours-more.js'];
// views another engineer is building: a lesson may open them before they exist
const PENDING = new Set(['blockchain', 'tuning', 'cube', 'stream']);
const problems = [], notes = [];
const bad = (where, msg) => problems.push(where + ': ' + msg);
const seen = new Map();
let current = null;
const mine = new Set();
const C = K.Content = { chapters: new Map(), lessons: new Map(), exercises: new Map(), tours: new Map(), variants: {} };
const claim = (id, what) => { if (!id) bad(what, 'no id'); else if (seen.has(id)) bad(id, 'id used twice (' + seen.get(id) + ' and ' + what + ')'); else seen.set(id, what + ' in ' + current); };
C.chapter = (n, part, title, about) => { C.chapters.set(n, Object.assign(C.chapters.get(n) || { lessons: [], exercises: [] }, { n, part, title, about })); };
C.lesson = (l) => { claim(l.id, 'lesson'); if (MINE.includes(current)) mine.add(l.id); C.lessons.set(l.id, l); const ch = C.chapters.get(l.chapter); if (!ch) bad(l.id, 'chapter ' + l.chapter + ' does not exist'); else if (!ch.lessons.includes(l.id)) ch.lessons.push(l.id); };
C.exercise = (x) => { claim(x.id, 'exercise'); if (MINE.includes(current)) mine.add(x.id); C.exercises.set(x.id, Object.assign({ kind: 'sql', db: 'theatre' }, x)); const ch = C.chapters.get(x.chapter); if (!ch) bad(x.id, 'chapter ' + x.chapter + ' does not exist'); else if (!ch.exercises.includes(x.id)) ch.exercises.push(x.id); };
C.tour = (t) => { claim(t.id, 'tour'); if (MINE.includes(current)) mine.add(t.id); C.tours.set(t.id, t); };
const dir = path.join(root, 'src/content');
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort()) {
  current = f;
  try { vm.runInThisContext(fs.readFileSync(path.join(dir, f), 'utf8'), { filename: 'src/content/' + f }); } catch (e) { bad(f, 'does not load: ' + e.message); }
}
for (const f of MINE) if (!fs.existsSync(path.join(dir, f))) bad(f, 'missing');

const want = (id) => mine.has(id) && (!only.length || only.some((o) => id.startsWith(o)));
const VIEWS = new Set(['lesson', 'exercise']);
for (const d of ['src/ui', 'src/ui/views']) for (const f of fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith('.js'))) for (const m of fs.readFileSync(path.join(root, d, f), 'utf8').matchAll(/registerView\(\{\s*id:\s*'([\w-]+)'/g)) VIEWS.add(m[1]);
const text = (r) => r.rows.map((row) => row.map((v, i) => (v === null || v === undefined ? '∅' : K.T.output(v, r.cols[i].type, { zone: 'UTC' }))).join('\u0001'));
const tables = ['venue', 'stage', 'company', 'person', 'artist', 'production', 'performance', 'casting', 'patron', 'booking', 'mentor'];
function fresh() { const db = new K.Database(); const s = db.session({ name: 'Query 1' }); s.exec("set timezone = 'UTC'"); s.exec(theatre); return { db, s }; }
const counts = (s) => tables.map((t) => t + ' ' + s.query('select count(*) from ' + t).rows[0][0]).join(', ');
const base = fresh();
const baseCounts = counts(base.s);
// the settings a lesson may change and must put back
const SETTINGS = ['concurrency_control', 'thomas_write_rule', 'deadlock_handling', 'phantom_protection', 'default_transaction_isolation', 'buffer_steal', 'buffer_force', 'wal_rule', 'full_page_writes', 'synchronous_commit', 'enable_seqscan', 'enable_indexscan', 'enable_bitmapscan', 'enable_hashjoin', 'enable_mergejoin', 'enable_nestloop'];
const settingsOf = (s) => { const out = {}; for (const k of SETTINGS) { try { out[k] = String(s.query('show ' + k).rows[0][0]); } catch (e) { /* not a setting here */ } } return out; };
const baseSettings = settingsOf(base.s);

function runnable(l) {
  const out = [];
  for (const b of l.body || []) {
    if (b && b.sql && !b.predict && b.run !== false) out.push(b);
    if (b && b.predict && b.sql) out.push({ sql: b.sql, fails: b.fails, tab: b.tab, waits: b.waits });
  }
  return out;
}
const rowsOf = (res) => { const out = []; for (const r of res || []) { if (r.rows) { out.push('   ' + r.cols.map((c) => c.name).join(' | ') + '  (' + r.rows.length + ' rows)'); for (const t of text(r).slice(0, 14)) out.push('   ' + t.replace(/\u0001/g, ' | ')); } else out.push('   ' + (r.tag || '')); } return out.join('\n'); };
/** run a lesson's blocks, each in its tab's session; returns the number of blocks */
function runLesson(l, db, sessions, pass) {
  const ses = (n) => { if (!sessions[n - 1]) sessions[n - 1] = db.session({ name: 'Query ' + n }); return sessions[n - 1]; };
  const runs = [];
  let n = 0;
  const finish = (x) => {
    const r = x.runner;
    if (x.reported || !r.done) return;
    x.reported = true;
    const err = r.error;
    if (x.b.fails) { if (!err) bad(x.where, 'should fail but ran: ' + x.b.sql.split('\n')[0]); else if (x.b.fails !== true && err.code !== x.b.fails) bad(x.where, 'fails with ' + err.code + ' (' + err.message + '), expected ' + x.b.fails); }
    else if (err) bad(x.where, 'error ' + err.code + ': ' + err.message + '\n    ' + x.b.sql.replace(/\n/g, '\n    '));
    if (verbose && pass === 1) console.log('-- ' + x.where + (x.b.tab ? ' [tab ' + x.b.tab + ']' : '') + (x.waited ? ' (after waiting)' : '') + '\n' + x.b.sql + '\n' + (err ? '   ERROR ' + err.code + ': ' + err.message : rowsOf(r.results)));
  };
  for (const b of runnable(l)) {
    n++;
    const where = l.id + ' block ' + n + (pass > 1 ? ' (second run)' : '');
    const s = ses(b.tab || 1);
    const busy = runs.find((x) => x.s === s && !x.runner.done);
    if (busy) { bad(where, 'tab ' + (b.tab || 1) + ' is still waiting for ' + busy.where + ', so this block cannot run yet'); continue; }
    const t0 = Date.now();
    const x = { b, s, where, runner: s.start(b.sql.trim()) };
    runs.push(x);
    db.step();
    const ms = Date.now() - t0;
    if (ms > 4000) bad(where, 'takes ' + ms + ' ms: too slow for a lesson');
    if (b.waits && x.runner.done) bad(where, 'should wait for a lock but ran at once');
    if (!b.waits && !x.runner.done) { x.waited = true; bad(where, 'waits for a lock (mark it { waits: true } if it should): ' + (x.runner.waitingOn && x.runner.waitingOn.why)); }
    if (!x.runner.done) x.waited = true;
    for (const y of runs) finish(y);
  }
  db.step();
  for (const y of runs) { finish(y); if (!y.runner.done) { bad(y.where, 'still waiting when the lesson ends'); y.runner.cancel(); } }
  return n;
}
function cleanup(db, sessions) {
  for (const r of db.runners || []) if (!r.done) r.cancel();
  db.step();
  for (const s of sessions) if (s) { try { s.exec('rollback'); } catch (e) { /* none open */ } }
  for (const g of (() => { try { return sessions[0].query('select gid from pg_prepared_xacts').rows.map((r) => r[0]); } catch (e) { return []; } })()) { try { sessions[0].exec("rollback prepared '" + g + "'"); } catch (e) { /* gone */ } }
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
    if (b && b.view) { if (PENDING.has(b.view) && !VIEWS.has(b.view)) notes.push(l.id + ': opens the ' + b.view + ' view, which does not exist yet'); else if (!VIEWS.has(b.view)) bad(l.id, 'unknown view ' + b.view); }
    if (b && b.thenView && !VIEWS.has(b.thenView)) bad(l.id, 'unknown view ' + b.thenView);
    if (b && typeof b === 'object' && !['p', 'h', 'list', 'steps', 'tip', 'warn', 'def', 'table', 'sql', 'predict', 'view', 'svg'].some((k) => k in b)) bad(l.id, 'unknown block ' + JSON.stringify(b).slice(0, 80));
    if (b && b.table && b.table.some((r) => r.length !== b.table[0].length)) bad(l.id, 'a table row has the wrong number of cells');
    if (b && b.tab && !(b.note || '').match(/tab\s*\d/i) && !b.predict) bad(l.id, 'a block for tab ' + b.tab + ' should say so in its note');
  }
  const { db, s } = fresh();
  const sessions = [s];
  if (l.setup) { try { s.exec(l.setup); } catch (e) { bad(l.id, 'setup fails: ' + e.message); } }
  nBlocks += runLesson(l, db, sessions, 1);
  cleanup(db, sessions);
  const after1 = settingsOf(s);
  for (const k of Object.keys(baseSettings)) if (after1[k] !== baseSettings[k]) bad(l.id, 'leaves ' + k + ' = ' + after1[k] + ' (it was ' + baseSettings[k] + '): put it back at the end');
  runLesson(l, db, sessions, 2);
  cleanup(db, sessions);
  const after = counts(s);
  if (after !== baseCounts) bad(l.id, 'the Theatre tables changed: ' + after);
}

// ---- exercises ----------------------------------------------------------------------------------------------------
let nEx = 0;
const byChapter = {};
// the database is made only when a check asks for it
// one database per exercise, shared by its checks; the time spent making it is not counted against the check
let shared = null, making = 0;
const appOf = () => ({ get db() { if (!shared) { const t = Date.now(); shared = fresh().db; making += Date.now() - t; } return shared; } });
for (const x of C.exercises.values()) {
  if (!want(x.id)) continue;
  nEx++;
  byChapter[x.chapter] = (byChapter[x.chapter] || 0) + 1;
  if (!x.title) bad(x.id, 'no title');
  if (![1, 2, 3].includes(x.level)) bad(x.id, 'level must be 1, 2 or 3');
  if (!x.text) bad(x.id, 'no text');
  if (!Array.isArray(x.hints) || x.hints.length !== 3) bad(x.id, 'needs exactly three hints');
  for (const b of [].concat(x.text || [])) if (b && b.view && !VIEWS.has(b.view) && !PENDING.has(b.view)) bad(x.id, 'unknown view ' + b.view);
  if (x.check) {
    shared = null; making = 0;
    const sol = x.solution !== undefined ? String(x.solution) : x.ref;
    if (sol === undefined) { bad(x.id, 'a custom check needs a solution (or ref) to test it with'); continue; }
    if (!x.ref) bad(x.id, 'no worked answer (ref)');
    const t0 = Date.now();
    let v;
    try { v = x.check(appOf(), sol); } catch (e) { bad(x.id, 'check throws on the solution: ' + e.stack); continue; }
    if (!v || !v.ok) bad(x.id, 'check turns down its own solution ' + JSON.stringify(sol).slice(0, 80) + ': ' + (v && v.message));
    for (const alt of [].concat(x.alts || [])) { let va; try { va = x.check(appOf(), alt); } catch (e) { bad(x.id, 'check throws on an alternative: ' + e.message); continue; } if (!va || !va.ok) bad(x.id, 'check turns down the alternative answer ' + JSON.stringify(alt) + ': ' + (va && va.message)); }
    const wrongs = [].concat(x.wrongs || []).concat(['-98765', 'select 1']);
    if (!x.wrongs || !x.wrongs.length) bad(x.id, 'give at least one plausible wrong answer in `wrongs`');
    for (const w of wrongs) {
      let vw;
      try { vw = x.check(appOf(), w); } catch (e) { bad(x.id, 'check throws on a wrong answer: ' + e.message); continue; }
      if (vw && vw.ok) bad(x.id, 'check accepts a wrong answer: ' + w);
      if (vw && !vw.ok && !vw.message) bad(x.id, 'check says nothing about the wrong answer ' + w);
    }
    try { const ve = x.check(appOf(), ''); if (ve && ve.ok) bad(x.id, 'check accepts an empty answer'); } catch (e) { bad(x.id, 'check throws on an empty answer: ' + e.message); }
    const ms = Date.now() - t0 - making;
    if (ms > 6000) bad(x.id, 'checking takes ' + ms + ' ms');
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

// ---- tours ------------------------------------------------------------------------------------------------------------
let nTours = 0;
for (const t of C.tours.values()) {
  if (!want(t.id)) continue;
  nTours++;
  if (!t.title) bad(t.id, 'no title');
  if (!Array.isArray(t.steps) || t.steps.length < 3) bad(t.id, 'a tour needs at least three steps');
  for (const [i, st] of (t.steps || []).entries()) {
    if (!st.text) bad(t.id, 'step ' + (i + 1) + ' has no text');
    if (st.target && /[{}]|^\s*$/.test(st.target)) bad(t.id, 'step ' + (i + 1) + ': the target is not a CSS selector: ' + st.target);
    if (st.before && typeof st.before !== 'function') bad(t.id, 'step ' + (i + 1) + ': before must be a function');
  }
}

const per = (o) => Object.entries(o).map(([c, n]) => 'ch ' + c + ': ' + n).join(', ');
console.log(nLessons + ' lessons (' + per(lessonsBy) + '; ' + nBlocks + ' runnable blocks), ' + nEx + ' exercises (' + per(byChapter) + '), ' + nTours + ' tours');
if (notes.length) console.log('\nNotes:\n' + [...new Set(notes)].map((p) => '- ' + p).join('\n'));
if (problems.length) { console.log('\n' + problems.length + ' problems:\n' + problems.map((p) => '- ' + p).join('\n')); process.exit(1); }
console.log('All content checks pass.');
