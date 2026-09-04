// Checks the lessons and exercises in src/content against the engine:
//   - every lesson's runnable SQL (its { sql } blocks and the SQL of its { predict } questions) runs in order in a
//     fresh Theatre database; a block marked { fails: 'SQLSTATE' } must fail with that code (true: any error);
//     then the whole lesson runs a second time in the same database, so a student can run it again, and the
//     Theatre tables must hold the rows they started with
//   - every exercise's reference answer runs and returns rows on the database and on every altered copy
//     (inside BEGIN ... ROLLBACK, as the exercise checker does); DML exercises run their `after` query
//   - a "fix this query" exercise's `wrong` query, and each of an exercise's `wrongs` (plausible wrong answers),
//     must give a different result from the reference on the database or on at least one altered copy
//   - ids are unique, chapters exist, exercises have three hints, predictions have a valid answer
//   - a lesson with blocks for a second editor tab ({ tab: 2 }) runs each block in its tab's session with
//     Session.start() and Database.step(), so a statement may wait for a lock while the other tab goes on; a block
//     marked { waits: true } must wait when run, and every block must have ended by the end of the lesson
// Run: node tools/check-content.mjs [lesson-or-exercise-id-prefix ...] [--verbose]
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

// ---- the content registry, as in src/ui/lessons.js, but noticing a repeated id -----------------------------------
const problems = [];
const bad = (where, msg) => problems.push(where + ': ' + msg);
const seen = new Map();
const C = K.Content = { chapters: new Map(), lessons: new Map(), exercises: new Map(), tours: new Map(), variants: {} };
const claim = (id, what) => { if (!id) bad(what, 'no id'); else if (seen.has(id)) bad(id, 'id used twice (' + seen.get(id) + ' and ' + what + ')'); else seen.set(id, what); };
C.chapter = (n, part, title, about) => { C.chapters.set(n, Object.assign(C.chapters.get(n) || { lessons: [], exercises: [] }, { n, part, title, about })); };
C.lesson = (l) => { claim(l.id, 'lesson'); C.lessons.set(l.id, l); const ch = C.chapters.get(l.chapter); if (!ch) bad(l.id, 'chapter ' + l.chapter + ' does not exist'); else if (!ch.lessons.includes(l.id)) ch.lessons.push(l.id); };
C.exercise = (x) => { claim(x.id, 'exercise'); C.exercises.set(x.id, Object.assign({ kind: 'sql', db: 'theatre' }, x)); const ch = C.chapters.get(x.chapter); if (!ch) bad(x.id, 'chapter ' + x.chapter + ' does not exist'); else if (!ch.exercises.includes(x.id)) ch.exercises.push(x.id); };
C.tour = (t) => { C.tours.set(t.id, t); };
const dir = path.join(root, 'src/content');
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort()) vm.runInThisContext(fs.readFileSync(path.join(dir, f), 'utf8'), { filename: 'src/content/' + f });

const want = (id) => !only.length || only.some((o) => id.startsWith(o));
// the views a lesson may open: every id registered with UI.registerView in the UI sources
const VIEWS = new Set(['plan', 'storage', 'erd', 'algebra', 'schema', 'buffer', 'locks', 'wal', 'index', 'lesson', 'exercise', 'tx', 'pages', 'heap']);
for (const d of ['src/ui', 'src/ui/views']) for (const f of fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith('.js'))) for (const m of fs.readFileSync(path.join(root, d, f), 'utf8').matchAll(/registerView\(\{\s*id:\s*'([\w-]+)'/g)) VIEWS.add(m[1]);
// views still being built: a lesson may already open them
const PENDING_VIEWS = new Set(['blockchain', 'tuning', 'cube', 'stream']);
const text = (r) => r.rows.map((row) => row.map((v, i) => (v === null || v === undefined ? '∅' : K.T.output(v, r.cols[i].type, { zone: 'UTC' }))).join('\u0001'));
const tables = ['venue', 'stage', 'company', 'person', 'artist', 'production', 'performance', 'casting', 'patron', 'booking', 'mentor'];

// one database with the Theatre data; a fresh one is made by replaying the script (cheap enough)
function fresh() { const db = new K.Database(); const s = db.session(); s.exec("set timezone = 'UTC'"); s.exec(theatre); return { db, s }; }
const counts = (s) => tables.map((t) => t + ' ' + s.query('select count(*) from ' + t).rows[0][0]).join(', ');
const base = fresh();
const baseCounts = counts(base.s);

// the blocks of a lesson that a student can run, in order
function runnable(l) {
  const out = [];
  for (const b of l.body || []) {
    if (b && b.sql && !b.predict && b.run !== false) out.push({ sql: b.sql, fails: b.fails, tab: b.tab, waits: b.waits });
    if (b && b.predict && b.sql) out.push({ sql: b.sql, fails: b.fails, tab: b.tab, waits: b.waits, predict: true });
  }
  return out;
}
// a lesson in several tabs: each block in its tab's session, stepped together
function runTabs(l, s, pass) {
  const db = s.db, sessions = [s], runs = [];
  const ses = (n) => sessions[n - 1] || (sessions[n - 1] = db.session({ name: 'Query ' + n }));
  const end = (x) => {
    if (x.seen || !x.r.done) return;
    x.seen = true;
    const err = x.r.error;
    if (x.b.fails) { if (!err) bad(x.where, 'should fail but ran: ' + x.b.sql.split('\n')[0]); else if (x.b.fails !== true && err.code !== x.b.fails) bad(x.where, 'fails with ' + err.code + ' (' + err.message + '), expected ' + x.b.fails); }
    else if (err) bad(x.where, 'error ' + err.code + ': ' + err.message + '\n    ' + x.b.sql.replace(/\n/g, '\n    '));
  };
  let n = 0;
  for (const b of runnable(l)) {
    n++;
    const where = l.id + ' block ' + n + (pass > 1 ? ' (second run)' : '');
    const se = ses(b.tab || 1);
    if (runs.some((x) => x.se === se && !x.r.done)) { bad(where, 'tab ' + (b.tab || 1) + ' is still waiting, so this block cannot run yet'); continue; }
    const x = { b, se, where, r: se.start(b.sql.trim()) };
    runs.push(x);
    db.step();
    if (b.waits && x.r.done) bad(where, 'should wait for a lock but ran at once');
    if (!b.waits && !x.r.done) bad(where, 'waits for a lock (mark it { waits: true } if it should)');
    runs.forEach(end);
  }
  db.step();
  for (const x of runs) { end(x); if (!x.r.done) { bad(x.where, 'still waiting when the lesson ends'); x.r.cancel(); } }
  for (const o of sessions.slice(1)) { try { o.exec('rollback'); } catch (e) { /* none open */ } }
  return n;
}
function runLesson(l, s, pass) {
  if ((l.body || []).some((b) => b && (b.tab || b.waits))) return runTabs(l, s, pass);
  let n = 0;
  for (const b of runnable(l)) {
    n++;
    let err = null, res = null;
    try { res = s.exec(b.sql.trim()); } catch (e) { err = e; }
    const where = l.id + ' block ' + n + (pass > 1 ? ' (second run)' : '');
    if (b.fails) {
      if (!err) bad(where, 'should fail but ran: ' + b.sql.split('\n')[0]);
      else if (b.fails !== true && err.code !== b.fails) bad(where, 'fails with ' + err.code + ' (' + err.message + '), expected ' + b.fails);
    } else if (err) bad(where, 'error ' + err.code + ': ' + err.message + '\n    ' + b.sql.replace(/\n/g, '\n    '));
    if (verbose && pass === 1) {
      console.log('-- ' + where + '\n' + b.sql);
      if (err) console.log('   ERROR ' + err.code + ': ' + err.message);
      else for (const r of res) {
        if (r.rows) { console.log('   ' + r.cols.map((c) => c.name).join(' | ') + '  (' + r.rows.length + ' rows)'); for (const t of text(r).slice(0, 8)) console.log('   ' + t.replace(/\u0001/g, ' | ')); }
        else console.log('   ' + (r.tag || ''));
        for (const m of r.notices || []) console.log('   NOTICE ' + (m.message || m));
      }
    }
  }
  return n;
}

let nLessons = 0, nBlocks = 0;
for (const l of C.lessons.values()) {
  if (!want(l.id)) continue;
  nLessons++;
  if (!l.title) bad(l.id, 'no title');
  if (!l.minutes) bad(l.id, 'no minutes');
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
    if (b && b.view && !VIEWS.has(b.view) && !PENDING_VIEWS.has(b.view)) bad(l.id, 'unknown view ' + b.view);
    if (b && typeof b === 'object' && !['p', 'h', 'list', 'steps', 'tip', 'warn', 'def', 'table', 'sql', 'predict', 'view', 'svg'].some((k) => k in b)) bad(l.id, 'unknown block ' + JSON.stringify(b).slice(0, 80));
  }
  const { s } = fresh();
  if (l.setup) { try { s.exec(l.setup); } catch (e) { bad(l.id, 'setup fails: ' + e.message); } }
  nBlocks += runLesson(l, s, 1);
  // algebra expressions shown in the lesson evaluate on the same data
  for (const b of l.body || []) if (b && b.view === 'algebra' && b.sel && b.sel.expr) { try { const r = K.Algebra.evaluate(b.sel.expr, s); if (verbose) console.log('-- algebra ' + b.sel.expr + ': ' + r.rows.length + ' tuples'); } catch (e) { bad(l.id, 'algebra ' + b.sel.expr + ': ' + e.message); } }
  try { s.exec('rollback'); } catch (e) { /* none open */ }
  try { s.exec('set role none'); } catch (e) { /* none set */ }
  runLesson(l, s, 2);
  try { s.exec('rollback'); } catch (e) { /* none open */ }
  try { s.exec('set role none'); s.exec('reset search_path'); } catch (e) { /* fine */ }
  const after = counts(s);
  if (after !== baseCounts) bad(l.id, 'the Theatre tables changed: ' + after);
}

// ---- exercises ---------------------------------------------------------------------------------------------------------
const s = base.s;
let nEx = 0;
const byChapter = {};
const lastOrderBy = (sql) => { let t = sql; for (let i = 0; i < 6; i++) t = t.replace(/\([^()]*\)/g, ''); return /\border\s+by\b/i.test(t); };
for (const x of C.exercises.values()) {
  if (!want(x.id)) continue;
  nEx++;
  byChapter[x.chapter] = (byChapter[x.chapter] || 0) + 1;
  if (!x.title) bad(x.id, 'no title');
  if (![1, 2, 3].includes(x.level)) bad(x.id, 'level must be 1, 2 or 3');
  if (!x.text) bad(x.id, 'no text');
  if (!Array.isArray(x.hints) || x.hints.length !== 3) bad(x.id, 'needs exactly three hints');
  // exercises checked some other way (an E-R design, say) are only checked for their shape
  if (x.check || (x.kind !== 'sql' && x.kind !== 'dml')) continue;
  if (!x.ref) { bad(x.id, 'no reference answer'); continue; }
  if (x.kind === 'dml' && !x.after) bad(x.id, 'a dml exercise needs an after query');
  const ordered = x.ordered !== undefined ? x.ordered : /\border\s+by\b/i.test(x.ref);
  if (x.kind === 'sql' && ordered && x.ordered === undefined && !lastOrderBy(x.ref)) bad(x.id, 'the reference has ORDER BY only inside parentheses (a window?): set ordered explicitly');
  const variants = [null].concat(x.variants || C.variants[x.db] || []);
  const results = [];
  for (let vi = 0; vi < variants.length; vi++) {
    const where = x.id + (vi ? ' on variant ' + vi : '');
    s.exec('begin');
    try {
      if (variants[vi]) { try { s.exec(variants[vi]); } catch (e) { bad(where, 'the variant fails: ' + e.message); continue; } }
      let r;
      try {
        if (x.kind === 'dml') { s.exec('savepoint before_answer'); s.exec(x.ref); r = s.query(x.after); }
        else { const rs = s.exec(x.ref); r = rs[rs.length - 1]; }
      } catch (e) { bad(where, 'reference fails: ' + e.code + ' ' + e.message); continue; }
      if (!r.rows) { bad(where, 'reference returns no result set'); continue; }
      if (!r.rows.length) bad(where, 'reference returns no rows');
      const t = text(r);
      results.push(ordered ? t : t.slice().sort());
      if (verbose && vi === 0) { console.log('-- ' + x.id + ' (' + r.rows.length + ' rows)'); for (const z of t.slice(0, 6)) console.log('   ' + z.replace(/\u0001/g, ' | ')); }
      // each wrong answer runs from the state before the answer; an error counts as rejected
      const wrongs = [].concat(x.wrong || [], x.wrongs || []);
      if (x.kind !== 'dml' && (wrongs.length || x.alts)) s.exec('savepoint before_answer');
      wrongs.forEach((wq, wi) => {
        let w = null;
        try {
          s.exec('rollback to savepoint before_answer');
          if (x.kind === 'dml') { s.exec(wq); w = s.query(x.after); }
          else { const rs = s.exec(wq); w = rs[rs.length - 1]; }
        } catch (e) { w = { err: e }; }
        const wt = w.err || !w.rows ? null : (ordered ? text(w) : text(w).slice().sort());
        ((x._wrongDiffers = x._wrongDiffers || [])[wi] = x._wrongDiffers[wi] || []).push(!wt || JSON.stringify(wt) !== JSON.stringify(ordered ? t : t.slice().sort()));
      });
      if (x.alts) for (const a of x.alts) {
        let at;
        try {
          s.exec('rollback to savepoint before_answer');
          if (x.kind === 'dml') { s.exec(a); at = text(s.query(x.after)); }
          else { const rs = s.exec(a); at = text(rs[rs.length - 1]); }
        } catch (e) { bad(where, 'an alternative answer fails: ' + e.message); continue; }
        if (JSON.stringify(ordered ? at : at.slice().sort()) !== JSON.stringify(ordered ? t : t.slice().sort())) bad(where, 'an alternative answer differs from the reference: ' + a.split('\n')[0]);
      }
    } finally { s.exec('rollback'); }
  }
  if (x._wrongDiffers) [].concat(x.wrong || [], x.wrongs || []).forEach((wq, wi) => { if (!x._wrongDiffers[wi].some(Boolean)) bad(x.id, 'a wrong answer gives the right result everywhere: ' + wq.replace(/\s+/g, ' ').slice(0, 100)); });
  // the variants should matter to at least one exercise in five; note those where nothing changes
  if (verbose && results.length > 1 && results.every((r) => JSON.stringify(r) === JSON.stringify(results[0]))) console.log('   (' + x.id + ': same result on every variant)');
}

const chCount = Object.entries(byChapter).map(([c, n]) => 'ch ' + c + ': ' + n).join(', ');
console.log(nLessons + ' lessons (' + nBlocks + ' runnable blocks), ' + nEx + ' exercises' + (chCount ? ' (' + chCount + ')' : ''));
if (problems.length) { console.log('\n' + problems.length + ' problems:\n' + problems.map((p) => '- ' + p).join('\n')); process.exit(1); }
console.log('All content checks pass.');
