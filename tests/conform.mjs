// Runs SQL files against Kwery and against a local PostgreSQL (through its Unix socket only) and compares the
// results row by row. Each file runs in a fresh database loaded with the Theatre sample data.
//   node tests/conform.mjs [file-or-pattern ...] [--verbose] [--no-pg-cache]
// PostgreSQL's answers are cached in tests/sql/.expected so the suite also runs where there is no server.
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { load } from './load.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const K = load();
const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const refresh = args.includes('--refresh');
const only = args.filter((a) => !a.startsWith('--'));
const PG = '/opt/homebrew/opt/postgresql@17/bin';
const SOCK = path.join(process.env.HOME, '.kwery-pg/sock');
const SEP = '\x1f';
const dir = path.join(root, 'tests/sql');
const cacheDir = path.join(dir, '.expected');
fs.mkdirSync(cacheDir, { recursive: true });
const theatre = fs.readFileSync(path.join(root, 'src/data/theatre.sql'), 'utf8');
// a cached answer holds for the same file on the same sample data
const dataHash = createHash('sha1').update(theatre).digest('hex').slice(0, 16);

/** split a file into statements: each ends with ; at the end of a line (dollar-quoted bodies are kept whole) */
function split(src) {
  const out = [];
  let cur = '', dollar = null;
  for (const line of src.split('\n')) {
    if (!cur.trim() && (line.startsWith('--') || !line.trim())) continue;
    cur += line + '\n';
    const m = line.match(/\$[A-Za-z_]*\$/g);
    if (m) for (const d of m) dollar = dollar === d ? null : dollar || d;
    if (!dollar && /;\s*(--.*)?$/.test(line)) { out.push(cur.trim()); cur = ''; }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const ordered = (sql) => /\border\s+by\b[^()]*$/i.test(sql.replace(/\([^()]*\)/g, '()').replace(/\([^()]*\)/g, '()').replace(/\([^()]*\)/g, '()')) || /--\s*ordered/.test(sql);

function pgRun(file, stmts) {
  const key = path.basename(file) + '.json';
  const cached = path.join(cacheDir, key);
  const src = fs.readFileSync(file, 'utf8');
  if (!refresh && fs.existsSync(cached)) { const c = JSON.parse(fs.readFileSync(cached, 'utf8')); if (c.src === src && c.data === dataHash) return c.out; }
  const db = 'kwery_conf_' + process.pid;
  const env = Object.assign({}, process.env, { PGHOST: SOCK, PGPORT: '5544' });
  execFileSync(PG + '/dropdb', ['--if-exists', db], { env, stdio: 'ignore' });
  execFileSync(PG + '/createdb', ['-T', 'template0', '-E', 'UTF8', '--locale=C', db], { env });
  const script = ['set client_min_messages = warning;', 'set timezone = \'UTC\';', theatre, ...stmts.map((s, i) => '\\echo @@@' + i + '\n' + s)].join('\n');
  const tmp = path.join(cacheDir, '.script-' + process.pid + '.sql');
  fs.writeFileSync(tmp, script);
  let text;
  // errors go to stderr: merge it into stdout so each error lands after its marker
  try { text = execFileSync('/bin/sh', ['-c', '"$0" -X -q -A -t -F "$1" -P null=NULL -v VERBOSITY=sqlstate -d "$2" -f "$3" 2>&1', PG + '/psql', SEP, db, tmp], { env, encoding: 'utf8', maxBuffer: 1 << 28 }); }
  catch (e) { text = (e.stdout || '') + (e.stderr || ''); }
  fs.unlinkSync(tmp);
  const res = [];
  const parts = text.split(/^@@@(\d+)\n?/m);
  for (let i = 1; i < parts.length; i += 2) {
    const body = parts[i + 1] || '';
    const err = body.match(/ERROR:\s+([0-9A-Z]{5})/);
    res[+parts[i]] = err ? { error: err[1] } : { rows: body.split('\n').filter((l, k, a) => !(l === '' && k === a.length - 1)) };
  }
  fs.writeFileSync(cached, JSON.stringify({ src, data: dataHash, out: res }));
  execFileSync(PG + '/dropdb', ['--if-exists', db], { env });
  return res;
}

function kwRun(stmts) {
  const db = new K.Database();
  const s = db.session();
  s.exec("set timezone = 'UTC'");
  s.exec(theatre);
  const res = [];
  for (const sql of stmts) {
    try {
      const rs = s.exec(sql);
      const r = rs[rs.length - 1];
      if (!r.rows) { res.push({ rows: [] }); continue; }
      // psql prints a value with newlines across several lines; split the same way to compare
      res.push({ rows: r.rows.map((row) => row.map((v, i) => (v === null || v === undefined ? 'NULL' : K.T.output(v, r.cols[i].type, { zone: s.settings.timezone }))).join(SEP)).flatMap((l) => l.split('\n')) });
    } catch (e) {
      res.push({ error: e.code || 'JSERR', message: e.message, stack: e.code ? null : e.stack });
    }
  }
  return res;
}

let pass = 0, fail = 0;
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).filter((f) => !only.length || only.some((o) => f.includes(o))).sort();
for (const f of files) {
  const file = path.join(dir, f);
  const stmts = split(fs.readFileSync(file, 'utf8'));
  const exp = pgRun(file, stmts);
  const got = kwRun(stmts);
  let fp = 0, ff = 0;
  stmts.forEach((sql, i) => {
    const e = exp[i] || { rows: [] }, g = got[i];
    let ok;
    if (e.error || g.error) ok = e.error === g.error;
    else {
      const a = ordered(sql) ? e.rows : e.rows.slice().sort(), b = ordered(sql) ? g.rows : g.rows.slice().sort();
      ok = a.length === b.length && a.every((x, k) => x === b[k]);
    }
    if (ok) { fp++; return; }
    ff++;
    console.log('\n--- ' + f + ' #' + (i + 1) + '\n' + sql);
    if (e.error || g.error) console.log('  expected ' + (e.error ? 'error ' + e.error : e.rows.length + ' rows') + ', got ' + (g.error ? 'error ' + g.error + ': ' + g.message : g.rows.length + ' rows'));
    if (g.stack) console.log(g.stack.split('\n').slice(0, 5).join('\n'));
    if (!e.error && !g.error) {
      const a = ordered(sql) ? e.rows : e.rows.slice().sort(), b = ordered(sql) ? g.rows : g.rows.slice().sort();
      const show = (r) => r.replace(new RegExp(SEP, 'g'), ' | ');
      let shown = 0;
      for (let k = 0; k < Math.max(a.length, b.length) && shown < (verbose ? 1000 : 6); k++) if (a[k] !== b[k]) { console.log('  row ' + (k + 1) + ': pg  ' + (a[k] === undefined ? '-' : show(a[k])) + '\n         kw  ' + (b[k] === undefined ? '-' : show(b[k]))); shown++; }
      if (a.length !== b.length) console.log('  pg ' + a.length + ' rows, kwery ' + b.length + ' rows');
    }
  });
  pass += fp; fail += ff;
  console.log(f + ': ' + fp + ' passed' + (ff ? ', ' + ff + ' FAILED' : ''));
}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
