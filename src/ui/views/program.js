// Programs that use the database (Ch. 5 and 9): a small JDBC-like API in JavaScript, run against the workbench's
// database in a session of its own. Round trips are counted and given a simulated network delay, so the cost of
// a chatty program (the N+1 queries problem) shows; a toy login form shows SQL injection, and its fix.
(function (root) {
  'use strict';
  const K = root.K;
  const UI = K.UI;
  const { h } = UI;

  const EXAMPLES = {
    basics: { title: 'Queries and result sets', code: `// db.query runs one statement and returns { columns, rows }.
const rs = db.query("select billed_as, fee from artist where company_id = 'C08' order by billed_as");
print('columns:', rs.columns.map((c) => c.name + ' ' + c.type).join(', '));
for (const row of rs.rows) print(row.billed_as, row.fee);

// Metadata: what tables are there, and what columns does one have?
print('tables:', db.tables().join(', '));
print('artist has', db.columns('artist').map((c) => c.name).join(', '));` },
    prepared: { title: 'Prepared statements', code: `// A prepared statement is parsed once; its parameters ($1, $2 ...) are values, never SQL text.
const byGenre = db.prepare('select count(*) as n, avg(runtime_min) as avg from production where genre = $1');
for (const g of ['drama', 'opera', 'dance']) {
  const r = byGenre.execute([g]).rows[0];
  print(g.padEnd(8), r.n, 'productions, average', r.avg, 'minutes');
}
print('round trips so far:', db.roundTrips);` },
    injection: { title: 'SQL injection on a login form', form: true, code: `// A login check that builds the SQL text by pasting the user's input in.
// Type a name, or try the password  ' or '1' = '1  and see what happens.
db.execute('create table if not exists app_user (login text primary key, password text)');
db.execute("insert into app_user values ('ada', 'hopper77') on conflict do nothing");

const login = form.login, password = form.password;
const sql = "select count(*) as n from app_user where login = '" + login + "' and password = '" + password + "'";
print('the SQL text sent:', sql);
const ok = db.query(sql).rows[0].n > 0;
print(ok ? 'LOGGED IN' : 'rejected');` },
    safe: { title: 'The same login, done safely', form: true, code: `// The fix: the input travels as a parameter, so it can only ever be a value.
db.execute('create table if not exists app_user (login text primary key, password text)');
db.execute("insert into app_user values ('ada', 'hopper77') on conflict do nothing");

const check = db.prepare('select count(*) as n from app_user where login = $1 and password = $2');
const ok = check.execute([form.login, form.password]).rows[0].n > 0;
print(ok ? 'LOGGED IN' : 'rejected');
// (A real application also stores a salted hash of the password, never the password itself.)` },
    nplus1: { title: 'The N+1 queries problem', code: `// One query for the companies, then one more query per company: N+1 round trips.
db.resetCounters();
const companies = db.query('select company_id, name from company order by company_id').rows;
for (const c of companies) {
  const n = db.query('select count(*) as n from production where company_id = $1', [c.company_id]).rows[0].n;
  print(c.name.padEnd(30), n);
}
print('round trips:', db.roundTrips, 'simulated time:', db.elapsedMs.toFixed(1), 'ms');

// The same answer in one round trip, with a join and GROUP BY.
db.resetCounters();
const all = db.query('select c.company_id, c.name, count(p.prod_id) as n from company c left join production p using (company_id) group by c.company_id, c.name order by 1').rows;
print('one query:', all.length, 'rows,', db.roundTrips, 'round trip,', db.elapsedMs.toFixed(1), 'ms');` },
    txn: { title: 'Transactions from a program', code: `// Move money between two companies' budgets atomically: both updates or neither.
function transfer(from, to, amount) {
  db.begin();
  try {
    db.query('update company set budget = budget - $1 where company_id = $2', [amount, from]);
    const left = db.query('select budget from company where company_id = $1', [from]).rows[0].budget;
    if (Number(left) <= 0) throw new Error(from + ' would have no budget left');
    db.query('update company set budget = budget + $1 where company_id = $2', [amount, to]);
    db.commit();
    print('moved', amount, 'from', from, 'to', to);
  } catch (e) {
    db.rollback();
    print('rolled back:', e.message);
  }
}
transfer('C01', 'C05', 25000);
transfer('C05', 'C01', 10000000);` },
  };

  function create(app, el) {
    let ex = UI.store.get('program.example', 'basics');
    let code = UI.store.get('program.code.' + ex, EXAMPLES[ex].code);
    const latency = { v: UI.store.get('program.latency', 2) };
    el.appendChild(h('div.view-intro', h('b', 'Programs talk to the database through an API. '), 'Each call is a round trip over the network to the server, so a program pays for every query it sends. Here a small JDBC-like API runs your JavaScript against this database, in a session of its own, and counts the round trips.'));
    const head = h('div.view-head');
    const ta = h('textarea.prog-code', { spellcheck: 'false', 'aria-label': 'Program', oninput: (e) => { code = e.target.value; UI.store.set('program.code.' + ex, code); } });
    const formBox = h('div.prog-form');
    const out = h('pre.prog-out');
    const body = h('div.view-body.prog', ta, formBox, h('div.prog-tools', UI.btn('run', 'Run the program', null, () => runIt(), 'primary'), h('label.prog-lat', 'Network delay per round trip ', h('select.inp', { onchange: (e) => { latency.v = +e.target.value; UI.store.set('program.latency', latency.v); } }, [0, 1, 2, 5, 20, 50].map((v) => h('option', { value: String(v), selected: v === latency.v }, v + ' ms'))))), out);
    el.appendChild(head); el.appendChild(body);
    const form = { login: 'ada', password: '' };
    const drawForm = () => {
      formBox.innerHTML = '';
      if (!EXAMPLES[ex].form) return;
      formBox.appendChild(h('div.login', h('div.login-t', 'Sign in'),
        h('label', 'Login', h('input.inp', { value: form.login, oninput: (e) => { form.login = e.target.value; } })),
        h('label', 'Password', h('input.inp', { value: form.password, placeholder: "try  ' or '1' = '1", oninput: (e) => { form.password = e.target.value; } }))));
    };
    const runIt = () => {
      out.textContent = '';
      const lines = [];
      const print = (...a) => { lines.push(a.map((x) => (typeof x === 'object' && x !== null ? JSON.stringify(x, (k, v) => (typeof v === 'bigint' ? Number(v) : v)) : String(x))).join(' ')); };
      const s = app.db.session({ name: 'program' });
      const api = makeApi(s, latency, print);
      const t0 = K.now();
      try { new Function('db', 'print', 'form', '"use strict";\n' + code)(api, print, Object.assign({}, form)); }
      catch (e) { lines.push((e.code ? 'SQL error ' + e.code + ': ' : 'Error: ') + e.message); }
      finally { if (s.tx) s.abortTx(s.tx); app.db.closeSession(s); }
      lines.push('', '— ' + UI.plural(api.roundTrips, 'round trip') + ' to the database, ' + api.elapsedMs.toFixed(1) + ' ms of simulated network time, ' + (K.now() - t0).toFixed(1) + ' ms in all');
      out.textContent = lines.join('\n');
      app.emit('schema');
    };
    const view = {
      /** a lesson can open the view on one of the examples: openView('program', { example: 'injection' }) */
      onSelect(sel) { if (sel && sel.example && EXAMPLES[sel.example]) { ex = sel.example; UI.store.set('program.example', ex); code = UI.store.get('program.code.' + ex, EXAMPLES[ex].code); ta.value = code; drawForm(); } },
      render() {
        head.innerHTML = '';
        head.appendChild(h('select.inp', { 'aria-label': 'Example', onchange: (e) => { ex = e.target.value; UI.store.set('program.example', ex); code = UI.store.get('program.code.' + ex, EXAMPLES[ex].code); ta.value = code; drawForm(); } }, Object.entries(EXAMPLES).map(([k, v]) => h('option', { value: k, selected: k === ex }, v.title))));
        head.appendChild(UI.btn('refresh', 'Restore the example', null, () => { code = EXAMPLES[ex].code; ta.value = code; UI.store.del('program.code.' + ex); }, 'ghost'));
        head.appendChild(UI.btn('info', 'The API', null, () => UI.dialog('The database API', h('pre.prog-api', API_DOC), { wide: true }), 'ghost'));
        if (ta.value !== code) ta.value = code;
        drawForm();
      },
    };
    return view;
  }

  const API_DOC = `db.query(sql, params?)        run one statement; returns { columns: [{ name, type }], rows: [{ col: value }], count }
db.execute(sql, params?)      run one statement; returns the number of rows changed
db.prepare(sql)               a prepared statement: .execute(params) runs it, .close() frees it
db.begin(), db.commit(), db.rollback()
db.tables()                   the table names
db.columns(table)             [{ name, type, nullable }]
db.roundTrips, db.elapsedMs   counters; db.resetCounters()
print(...values)              write a line of output
form.login, form.password     what is typed in the form (the login examples)`;

  /** the API object a program gets */
  function makeApi(s, latency, print) {
    void print;
    const api = { roundTrips: 0, elapsedMs: 0 };
    const trip = () => { api.roundTrips++; api.elapsedMs += latency.v; };
    const conv = (v, t) => (v === null || v === undefined ? null : typeof v === 'bigint' ? Number(v) : t && (t.cat === 'S' || t.cat === 'B' || (t.cat === 'N' && !(v instanceof K.Decimal))) ? v : UI.valueText(v, t));
    const shape = (r) => ({ columns: (r.cols || []).map((c) => ({ name: c.name, type: K.T.sqlName(c.type) })), rows: (r.rows || []).map((row) => { const o = {}; (r.cols || []).forEach((c, i) => { o[c.name] = conv(row[i], c.type); }); return o; }), count: r.count !== undefined ? r.count : r.rows ? r.rows.length : 0 });
    const run = (sql, params) => { trip(); const rs = s.exec(sql, { params: (params || []).map((p) => (typeof p === 'number' && !Number.isInteger(p) ? K.Decimal.parse(String(p)) : p)) }); return rs[rs.length - 1]; };
    api.query = (sql, params) => shape(run(sql, params));
    api.execute = (sql, params) => { const r = run(sql, params); return r.count !== undefined ? r.count : r.rows ? r.rows.length : 0; };
    let n = 0;
    api.prepare = (sql) => {
      const name = 'p' + ++n;
      trip();
      const text = sql;
      return { execute: (params) => shape(run(text, params)), close: () => trip(), name };
    };
    api.begin = () => { run('begin'); };
    api.commit = () => { run('commit'); };
    api.rollback = () => { run('rollback'); };
    api.tables = () => { trip(); return s.catalog.tables(['table']).filter((r) => !s.catalog.schema(r.schema).system).map((r) => r.name).sort(); };
    api.columns = (t) => { trip(); const r = s.catalog.lookup({ name: t }, s.searchPath()); if (!r) throw new Error('no table ' + t); return r.cols.filter((c) => !c.dropped).map((c) => ({ name: c.name, type: K.T.sqlName(c.type), nullable: !c.notNull })); };
    api.resetCounters = () => { api.roundTrips = 0; api.elapsedMs = 0; };
    return api;
  }

  UI.registerView({ id: 'program', title: 'Programs', icon: 'terminal', group: 'Applications', order: 80, create });
})(typeof window !== 'undefined' ? window : globalThis);
