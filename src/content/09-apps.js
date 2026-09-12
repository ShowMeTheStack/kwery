// Chapter 9: application development. How applications are built around a database, how a program talks to it
// (the Programs view runs small programs against this database through a JDBC-like API), SQL injection and
// prepared statements, round trips and the N+1 problem, transactions and connection pools, and application
// security. Some exercises ask for the SQL text a program should prepare, and run it with hostile input.
(function (root) {
  'use strict';
  const K = root.K;
  const C = K.Content;
  // the right answer of each prediction is listed first in the source; rotate the options by a hash of the
  // question so that it lands in a different place from one question to the next
  const mix = (l) => {
    for (const b of l.body || []) {
      if (!b || !b.predict) continue;
      const p = b.predict, n = p.options.length;
      let k = 0;
      for (const ch of p.q) k = (k * 31 + ch.charCodeAt(0)) >>> 0;
      k %= n;
      const right = p.options[p.answer];
      p.options = p.options.slice(k).concat(p.options.slice(0, k));
      p.answer = p.options.indexOf(right);
    }
    return l;
  };
  const lesson = (l) => C.lesson(mix(l));
  const PROGRAMS = { view: 'program', label: 'Open the Programs view' };
  const pick = (title) => 'In the Programs view, choose **' + title + '** in the menu at the top (Restore the example brings back the original code if you have changed it), then press **Run the program**.';

  // ---- 9.1-9.2 architectures and the API ------------------------------------------------------------------------------
  lesson({
    id: 'app-arch', chapter: 9, title: 'Application architectures and database APIs', minutes: 12,
    summary: 'Most users reach a database through an application. The usual layers, and the few calls a program makes to send SQL and read results.',
    body: [
      'A patron who books seats for a performance never types SQL. A web page or a phone app collects what they want, and a program on a server turns it into queries. Most database applications are built in layers:',
      { table: [['Layer', 'Runs', 'Does'], ['presentation (front end)', 'in the browser or on the phone', 'shows pages and forms, sends requests over HTTP, often receives JSON back'], ['application (business logic)', 'on application servers', 'checks requests, applies the rules of the business, decides which queries to run'], ['data access', 'in the application server', 'connects to the database, sends SQL, maps rows to the program\'s objects'], ['database', 'on database servers', 'stores the data, runs the queries, keeps transactions apart']] },
      'HTTP is **stateless**: each request stands alone. To know that two requests come from the same logged-in user, the application gives the browser a **session** identifier, usually in a cookie, and keeps the session\'s data on the server. The database sees none of this; it sees queries from the application.',
      { h: 'Talking to the database' },
      'Every language has an interface for sending SQL: JDBC in Java, the DB-API in Python, ODBC in C and many others. They follow the same pattern:',
      { steps: ['open a **connection** to the database server, with a user name and password', 'create a **statement** with the SQL text, and execute it', 'iterate over the **result set**, one row at a time, converting each column to a value of the program\'s language', 'close the result set, the statement and the connection'] },
      'Kwery has a small API of that shape for JavaScript. Run its first example:',
      PROGRAMS,
      { p: pick('Queries and result sets') + ' It runs a query, prints the column names and types from the result\'s **metadata**, then asks the database which tables and columns it has.' },
      'A program\'s query is ordinary SQL, and anything it sends can be run here as well. A query of the kind such a program sends, the artists of one company with their fees:',
      { sql: "select p.given_name, p.family_name, a.fee\nfrom artist a join person p on p.person_id = a.person_id\nwhere a.company_id = 'C02'\norder by p.family_name;" },
      { predict: { q: 'The example program calls db.query once, db.tables once and db.columns once. How many round trips to the database does it report?', options: ['3: every call that needs the database is one round trip', '1: the calls are sent together', '11: one per table'], answer: 0, explain: 'Each call sends a request to the server and waits for the answer. Metadata calls are round trips too: the API answers them by querying the catalog. The last line of the program\'s output counts them.' } },
      'Metadata is how generic tools (a report builder, an admin console, Kwery\'s own schema panel) work with databases they have never seen. Behind a call such as `db.columns(\'artist\')` is a catalog query like this one:',
      { sql: "select column_name, data_type, is_nullable\nfrom information_schema.columns\nwhere table_name = 'artist'\norder by ordinal_position;" },
      { h: 'Other ways in' },
      'Programs can also **embed** SQL in their source, with a precompiler turning it into API calls (embedded SQL), or avoid writing SQL at all through an **object-relational mapping** (ORM) library that maps classes to tables and generates the queries. ORMs save a lot of code; the lesson on round trips shows what they can cost when used carelessly.',
      { tip: 'Business logic can also live in the database, as functions, procedures and triggers (chapter 5). That puts a rule in one place for every application, at the price of tying it to one database system.' },
    ],
  });

  // ---- 9.4-9.8 prepared statements and injection ---------------------------------------------------------------------
  lesson({
    id: 'app-injection', chapter: 9, title: 'Prepared statements and SQL injection', minutes: 13,
    summary: 'Pasting user input into SQL text lets the input rewrite the query. Parameters keep values out of the SQL text, and identifiers that must vary come from a fixed list.',
    body: [
      'A login form checks a name and a password. The careless way to build the query pastes the input into the SQL text. Try it:',
      PROGRAMS,
      { p: pick('SQL injection on a login form') + ' First log in as ada with the right password, hopper77. Then type the password `\' or \'1\' = \'1` and run it again.' },
      'The program printed the SQL it sent. With that password the text becomes:',
      { sql: "select 'the text sent' as what,\n       'select count(*) as n from app_user where login = ''ada'' and password = '''' or ''1'' = ''1''' as sql;", note: 'A query that shows the text. Read the condition: the input closed the string, and `or \'1\' = \'1\'` is true for every row.' },
      { predict: { q: 'and binds tighter than or. What does the condition `login = \'ada\' and password = \'\' or \'1\' = \'1\'` amount to?', options: ['true for every row, so the count is the number of users', 'true only for ada', 'false for every row'], answer: 0, explain: 'It reads (login = \'ada\' and password = \'\') or (\'1\' = \'1\'). The second part is always true, so every row matches and the login succeeds without the password.' } },
      'That is **SQL injection**: input that changes the structure of a statement. The fix is to send the SQL text with **placeholders** and the values separately, as a **prepared statement**. The database parses the text once, before it sees any value, so a value can never become SQL. In SQL itself:',
      { sql: "prepare company_shows (text) as\n  select count(*) as n\n  from production p join company c on c.company_id = p.company_id\n  where c.name = $1;\nexecute company_shows('Saltreach Farceurs');\nexecute company_shows(''' or ''1'' = ''1');" },
      'The second execute passes the hostile text as a value: no company has that name, so the count is 0. Now run the safe version of the login in the Programs view:',
      { p: pick('The same login, done safely') + ' The same hostile password is rejected.' },
      { h: 'What cannot be a parameter' },
      'Placeholders stand for values only. A table name, a column name or a sort direction cannot be a parameter. A page that lets the user choose the sort column must still not paste the input in. Two safe patterns:',
      { list: ['check the input against a fixed list of allowed column names in the program, and use the one from the list', 'quote it as an identifier, so that it can only ever be read as one name: `format(\'%I\', input)` or `quote_ident(input)`'] },
      { sql: "select format('select billed_as from artist order by %I', 'fee') as fine,\n       format('select billed_as from artist order by %I', 'fee; drop table artist') as harmless;", note: 'The second becomes one strange, quoted column name, which simply does not exist.' },
      { h: 'Other injections' },
      'The same mistake appears wherever a program builds code from input: HTML pages that echo input (**cross-site scripting**), shell commands, and file paths. **Second-order** injection stores harmless-looking input and pastes it into a query later, so input from the database deserves the same care as input from a form. The rule is always the same: keep data and code apart.',
      { sql: 'deallocate company_shows;' },
    ],
  });

  // ---- 9.4 round trips, N+1, transactions, pooling ---------------------------------------------------------------------
  lesson({
    id: 'app-roundtrips', chapter: 9, title: 'Round trips, transactions and connection pools', minutes: 14,
    summary: 'Every query a program sends costs a round trip. Loops that send one query per row are slow; one set-oriented query is fast. Transactions group a program\'s statements, and pools share connections.',
    body: [
      'A query sent from a program travels over the network to the database server, runs, and the answer travels back. On a local network that round trip costs around half a millisecond, often far more than running a small query. A program that sends many tiny queries spends most of its time waiting.',
      { h: 'The N+1 queries problem' },
      'A page lists rows of one table with a count from another: companies with their number of productions, say. The natural loop runs one query for the list, then one more per row of it:',
      PROGRAMS,
      { p: pick('The N+1 queries problem') + ' Set the network delay to 5 ms and run it again.' },
      { predict: { q: 'There are 12 companies. How many round trips does such a loop make?', options: ['13: one for the list and one per company', '12', '2', '1'], answer: 0, explain: 'One query fetches the N companies, then N more fetch a count each: N + 1 = 13. With ten thousand rows it would be ten thousand and one, and an ORM that loads related objects lazily produces exactly this pattern without anyone writing the loop.' } },
      'The second half of the example asks the same question in one query, which is the cure: let the database do the work, set at a time.',
      { sql: 'select c.name, count(p.prod_id) as productions\nfrom company c left join production p on p.company_id = c.company_id\ngroup by c.company_id, c.name\norder by c.name;', note: 'One round trip, whatever the number of companies. The left join keeps a company with no productions, with a count of 0.' },
      'When a program really must send many statements (loading a file, say), **batching** sends them together, and a single multi-row insert does the same within SQL:',
      { sql: "drop table if exists visit_log;\ncreate table visit_log (page text, at timestamp);\ninsert into visit_log values\n  ('/shows', timestamp '2026-10-01 09:00'), ('/venues', timestamp '2026-10-01 09:01'),\n  ('/shows', timestamp '2026-10-01 09:03'), ('/login', timestamp '2026-10-01 09:04');\nselect page, count(*) from visit_log group by page order by page;", note: 'Four rows, one statement, one round trip.' },
      { h: 'Transactions from a program' },
      'Most interfaces start in **autocommit** mode: each statement is its own transaction. To make several statements one unit, the program turns that off or begins a transaction, and ends it with commit or rollback, also when something goes wrong in the program itself.',
      { p: pick('Transactions from a program') + ' The first transfer commits. A transfer that would leave a balance below zero is noticed by the program, which rolls back, so the first update of that transfer is undone.' },
      'The same pattern in SQL:',
      { sql: "begin;\nupdate company set budget = budget - 10000 where company_id = 'C03';\nselect company_id, budget from company where company_id = 'C03';\nrollback;\nselect company_id, budget from company where company_id = 'C03';", note: 'Inside the transaction the budget is 10000 lower; after the rollback it is as before.' },
      { warn: 'Never keep a transaction open while waiting for a person (to confirm a form, say). It holds locks or old versions the whole time and gets in everyone else\'s way. Read, show the page, and do the change in a new short transaction that checks nothing changed in between.' },
      { h: 'Connection pooling' },
      'Opening a connection is expensive: a network handshake, authentication, and a server process or thread to set up. A web application handles thousands of short requests a second and cannot open a connection for each. It keeps a **connection pool**: a set of open connections that requests borrow and give back. The pool also caps how many queries run on the database at once. The price: a connection given back must be clean, with no open transaction and no session settings left behind for the next borrower.',
      { sql: 'drop table visit_log;' },
    ],
  });

  // ---- 9.8 application security --------------------------------------------------------------------------------------------
  lesson({
    id: 'app-security', chapter: 9, title: 'Application security', minutes: 13,
    summary: 'Who may see what can be enforced in the database or in the application. Passwords are stored as salted hashes, never as text. And a few attacks every web application must expect.',
    body: [
      'A database has its own users, roles and privileges (chapter 4). But a web application usually connects as **one** database user for all of its thousands of people. The database then cannot tell the people apart, and every rule about who sees what has to be enforced by the application.',
      { table: [['Enforced in', 'Strengths', 'Weaknesses'], ['the database (grants, views, roles)', 'holds for every program and every ad hoc query; checked in one place', 'needs a database identity per person or role; row-level rules need extra features'], ['the application', 'knows the application\'s own users and rules; fine-grained', 'every program must get it right; a bug or a direct connection bypasses it']] },
      'Many applications combine the two: a few database roles with limited privileges (one for the public site, one for staff tools), and fine-grained checks in the application. A role for the public cast pages, which may read the names artists are billed under but not their fees:',
      { sql: "drop view if exists artist_directory;\ncreate view artist_directory as\n  select billed_as, company_id from artist where billed_as is not null;\ndrop role if exists web_public;\ncreate role web_public;\ngrant select on artist_directory to web_public;" },
      { predict: { q: 'Acting as web_public, what happens to `select billed_as, fee from artist`?', options: ['It fails with permission denied', 'It returns names with null fees', 'It returns all the columns'], answer: 0, explain: 'web_public was granted the view only. The base table is out of reach, so even a bug or an injection in the public site cannot read fees through this connection.' }, sql: 'set role web_public;\nselect billed_as, fee from artist;', fails: '42501' },
      { sql: "reset role;\nset role web_public;\nselect * from artist_directory where company_id = 'C02';\nreset role;", note: 'The view works for web_public.' },
      { h: 'Storing passwords' },
      'An application that stores its users\' passwords as text exposes all of them the day the table leaks. It should store a **hash**: the result of a one-way function. At login it hashes what was typed and compares hashes. Each user also gets a random **salt**, mixed in before hashing, so that two users with the same password have different hashes and precomputed tables of common passwords are useless.',
      { sql: "drop table if exists app_login;\ncreate table app_login (login text primary key, salt text, pw_hash text);\ninsert into app_login values\n  ('ada', 'k3P9', encode(sha256(('k3P9' || 'hopper77')::bytea), 'hex')),\n  ('ben', 'Q7xz', encode(sha256(('Q7xz' || 'hopper77')::bytea), 'hex'));\nselect login, salt, left(pw_hash, 16) || '...' as pw_hash from app_login;", note: 'Same password, different hashes, because the salts differ.' },
      'Checking a login recomputes the hash with the stored salt:',
      { sql: "select login,\n       pw_hash = encode(sha256((salt || 'hopper77')::bytea), 'hex') as password_ok\nfrom app_login\nwhere login = 'ada';" },
      { warn: 'SHA-256 is fast, which is bad for passwords: an attacker with the table can try billions of guesses a second. Real systems use deliberately slow, salted password hashing functions such as bcrypt, scrypt or Argon2, from a well-tested library. The idea is the one shown here; the function is not.' },
      { h: 'Other things to get right' },
      { list: ['**Encryption in transit**: connections to the database and to the browser use TLS, so passwords and data cannot be read on the network.', '**Encryption at rest**: disks and backups are encrypted, so a stolen disk is useless.', '**Cross-site scripting**: text from users is escaped before it is put into a page.', '**Cross-site request forgery**: a request that changes something must carry a token the application issued, so another site cannot trigger it with the user\'s cookie.', '**Audit trails**: a log of who changed what and when, written by triggers or by the application, to find out what happened after the fact.'] },
      { sql: 'drop table app_login;\ndrop view artist_directory;\ndrop role web_public;' },
    ],
  });

  // ---- exercises ---------------------------------------------------------------------------------------------------------------
  const ex = (x) => C.exercise(Object.assign({ chapter: 9, db: 'theatre' }, x));
  const outText = (r) => r.rows.map((row) => row.map((v, i) => (v === null || v === undefined ? '∅' : K.T.output(v, r.cols[i].type, { zone: 'UTC' }))).join('\u0001')).sort();
  /**
   * a check for "the SQL text a program should prepare": the answer must use the placeholders $1..$n and must not
   * contain the test values themselves; it is run with every set of test inputs (one of them hostile) and must
   * give the same rows as the reference with the same inputs
   */
  function paramCheck(n, tests) {
    return function (app, answer) {
      let sql = String(answer || '').trim().replace(/;\s*$/, '');
      if (!sql) return { ok: false, message: 'The editor is empty.' };
      if (/;/.test(sql.replace(/'(?:[^']|'')*'/g, ''))) return { ok: false, message: 'Write one statement only: the program prepares a single query.' };
      for (let i = 1; i <= n; i++) if (!new RegExp('\\$' + i + '(?!\\d)').test(sql)) return { ok: false, message: 'Your query does not use the placeholder $' + i + '. Each value the user types must reach the query as a parameter.' };
      for (const t of tests) for (const v of t) if (typeof v === 'string' && v.length > 2 && sql.toLowerCase().includes(v.toLowerCase())) return { ok: false, message: 'Your query contains the value ' + v + ' itself. The values come in as parameters; the query text must work for any input.' };
      const s = app.db.session({ name: 'checker' });
      try {
        for (const params of tests) {
          let ref, got;
          s.exec('begin');
          try {
            ref = s.exec(this.ref, { params });
            try { got = s.exec(sql, { params }); } catch (e) { return { ok: false, message: 'With the input ' + JSON.stringify(params) + ' your query fails: ' + e.message }; }
          } finally { s.exec('rollback'); }
          ref = ref[ref.length - 1]; got = got[got.length - 1];
          if (!got.rows) return { ok: false, message: 'That statement does not return rows.' };
          if (got.cols.length !== ref.cols.length) return { ok: false, message: 'Your result has ' + got.cols.length + ' columns; the answer has ' + ref.cols.length + '.', details: ['Expected columns like: ' + ref.cols.map((c) => c.name).join(', ')] };
          const a = outText(ref), b = outText(got);
          if (a.length !== b.length || a.some((x, i) => x !== b[i])) return { ok: false, message: 'With the input ' + JSON.stringify(params) + ' your query gives ' + b.length + ' rows and the answer ' + a.length + (a.length === b.length ? ', but some rows differ.' : '.') };
        }
        return { ok: true, message: 'Your statement gives the right rows for every input tried, including ' + JSON.stringify(tests[tests.length - 1]) + '.' };
      } finally { app.db.sessions = app.db.sessions.filter((z) => z !== s); }
    };
  }
  const PARAM_NOTE = { tip: 'Write the statement with `$1` (and `$2`) where the typed values go. Running it in the editor fails, because nothing supplies the parameters; **Check my answer** runs it with several inputs, one of them hostile.' };

  ex({ id: 'app-x-param-cast', level: 1, title: 'A search box, safely',
    text: ['A page lets a visitor type an artist\'s family name and lists the roles that artist plays. Write the SQL text the program should prepare: prod_id, title and role_name of every casting of the artists whose family name is the parameter `$1`.', PARAM_NOTE],
    ref: 'select c.prod_id, pr.title, c.role_name\nfrom casting c\n  join person p on p.person_id = c.person_id\n  join production pr on pr.prod_id = c.prod_id\nwhere p.family_name = $1',
    check: paramCheck(1, [['Iyer'], ['Moreau'], ["x' or '1' = '1"]]),
    wrongs: ["select c.prod_id, pr.title, c.role_name from casting c join person p on p.person_id = c.person_id join production pr on pr.prod_id = c.prod_id where p.family_name = 'Iyer'", 'select c.prod_id, pr.title from casting c join person p on p.person_id = c.person_id join production pr on pr.prod_id = c.prod_id where p.family_name = $1', 'select c.prod_id, pr.title, c.role_name from casting c join person p on p.person_id = c.person_id join production pr on pr.prod_id = c.prod_id where p.family_name = $1 or true'],
    hints: ['The query joins casting with person (for the name) and production (for the title).', 'Where the name goes, write $1, with no quotes around it: the placeholder is a value, not text inside a string.', 'select c.prod_id, pr.title, c.role_name from casting c join person p on p.person_id = c.person_id join production pr on pr.prod_id = c.prod_id where p.family_name = $1'] });

  ex({ id: 'app-x-param-patrons', level: 2, title: 'Two parameters',
    text: ['A box-office tool lists the patrons of a city who have at least a given number of loyalty points. Write the query with `$1` for the city and `$2` for the minimum points, returning patron_id, name and points.', PARAM_NOTE],
    ref: 'select patron_id, name, points\nfrom patron\nwhere city = $1 and points >= $2',
    check: paramCheck(2, [['Vantmoor', 310], ['Easterholm', 420], ["Saltreach' or ''='", 0]]),
    wrongs: ["select patron_id, name, points from patron where city = 'Vantmoor' and points >= 310", 'select patron_id, name, points from patron where city = $1 and points > $2', 'select patron_id, name, points from patron where city = $2 and points >= $1'],
    hints: ['Number the placeholders in the order the program passes the values: the city first.', 'At least means >=.', 'select patron_id, name, points from patron where city = $1 and points >= $2'] });

  ex({ id: 'app-x-param-prefix', level: 3, title: 'A name prefix as a parameter',
    text: ['A search box finds patrons whose name starts with what was typed. Write the query with `$1` for the typed text, returning patron_id and name. The typed text is a value: build the comparison from it inside the query, and make sure that typing a `%` or `_` does not act as a wildcard.', PARAM_NOTE],
    ref: "select patron_id, name\nfrom patron\nwhere left(name, length($1)) = $1",
    check: paramCheck(1, [['Ma'], ['D'], ['%'], ["' or 1=1 --"]]),
    wrongs: ["select patron_id, name from patron where name like $1 || '%'", "select patron_id, name from patron where name like 'Ma%'", 'select patron_id, name from patron where name = $1'],
    hints: ["`name like $1 || '%'` is safe from injection, but a typed % matches every name.", 'Compare the start of the name with the typed text directly instead of building a pattern.', 'left(name, length($1)) = $1, or starts_with(name, $1) where available.'] });

  ex({ id: 'app-x-nplus1', level: 1, title: 'One query instead of N+1',
    text: ['A program prints, for each company, the number of productions it has staged. It runs `select company_id from company`, then for each company `select count(*) from production where company_id = $1`. Write one query that gives the same two columns: every company id, with its count (0 for a company with no productions).'],
    ref: 'select c.company_id, count(p.prod_id) as productions\nfrom company c left join production p on p.company_id = c.company_id\ngroup by c.company_id',
    wrongs: ['select c.company_id, count(*) as productions from company c join production p on p.company_id = c.company_id group by c.company_id', 'select c.company_id, count(*) as productions from company c left join production p on p.company_id = c.company_id group by c.company_id'],
    hints: ['Join company with production and group by company.', 'An inner join drops a company with no productions; the loop would have printed 0 for it.', 'count(p.prod_id) counts only the matched productions, so it gives 0 where the left join found none; count(*) would give 1.'] });

  ex({ id: 'app-x-company-names', level: 2, title: 'Fetching related rows in one go',
    text: ['A page lists every artist with the name of their company. The first version of the program fetched the artists, then looked up each company with its own query. Write one query returning each artist\'s person_id and family name and the company\'s name, with null for a freelance artist.'],
    ref: 'select a.person_id, p.family_name, c.name as company\nfrom artist a\n  join person p on p.person_id = a.person_id\n  left join company c on c.company_id = a.company_id',
    wrongs: ['select a.person_id, p.family_name, c.name as company from artist a join person p on p.person_id = a.person_id join company c on c.company_id = a.company_id'],
    hints: ['Two joins: artist to person for the name, artist to company for the company.', 'The join with company must be an outer join, or the freelance artists disappear.', 'select a.person_id, p.family_name, c.name from artist a join person p on p.person_id = a.person_id left join company c on c.company_id = a.company_id'] });

  ex({ id: 'app-x-transfer', kind: 'dml', level: 2, title: 'A transfer in one statement',
    text: ['Move 5000 of budget from company C02 to company C04. A program could run two updates in a transaction; do it with a single `update` statement, which is atomic on its own, and change no other company.'],
    ref: "update company\nset budget = budget + case company_id when 'C04' then 5000 when 'C02' then -5000 end\nwhere company_id in ('C02', 'C04')",
    after: 'select company_id, budget from company order by company_id',
    wrongs: ["update company set budget = budget + case company_id when 'C04' then 5000 when 'C02' then -5000 end", "update company set budget = budget + case company_id when 'C02' then 5000 when 'C04' then -5000 end where company_id in ('C02', 'C04')"],
    hints: ['One update can change several rows, each in its own way.', 'A case expression can give +5000 for one company and -5000 for the other.', 'Restrict the update with where company_id in (...), or the case gives null for every other company.'] });

  ex({ id: 'app-x-directory', kind: 'dml', level: 1, title: 'A view for the public site',
    text: ['Create a view `artist_directory` for a public web page: every artist\'s person_id, billed_as and company_id, but not the fee.'],
    ref: 'create view artist_directory as\n  select person_id, billed_as, company_id from artist',
    after: 'select * from artist_directory',
    hints: ['create view name as select ...', 'List the columns the page may see.', 'create view artist_directory as select person_id, billed_as, company_id from artist'] });

  ex({ id: 'app-x-hash', level: 2, title: 'Checking salted password hashes',
    text: ['A login table is given in a `with` clause. Each row has a salt and the hex SHA-256 hash of the salt followed by the password. Return the logins whose password is `tulip-42`.', { sql: "with app_login(login, salt, pw_hash) as (\n  select 'amira', 'Zq81', encode(sha256('Zq81tulip-42'::bytea), 'hex') union all\n  select 'boris', 'Lm0P', encode(sha256('Lm0Px9!q'::bytea), 'hex') union all\n  select 'carla', 'tT5e', encode(sha256('tT5etulip-42'::bytea), 'hex')\n)\nselect * from app_login;", run: false }],
    ref: "with app_login(login, salt, pw_hash) as (\n  select 'amira', 'Zq81', encode(sha256('Zq81tulip-42'::bytea), 'hex') union all\n  select 'boris', 'Lm0P', encode(sha256('Lm0Px9!q'::bytea), 'hex') union all\n  select 'carla', 'tT5e', encode(sha256('tT5etulip-42'::bytea), 'hex')\n)\nselect login\nfrom app_login\nwhere pw_hash = encode(sha256((salt || 'tulip-42')::bytea), 'hex')",
    hints: ['You cannot undo a hash: compute the hash of the candidate password and compare.', 'Each row has its own salt; put it in front of the password before hashing.', "where pw_hash = encode(sha256((salt || 'tulip-42')::bytea), 'hex')"] });
})(typeof window !== 'undefined' ? window : globalThis);
