// Chapter 5: advanced SQL. Using SQL from programs, functions and procedures, triggers, recursive queries,
// window functions, OLAP and ranking.
(function (root) {
  'use strict';
  const C = root.K.Content;
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


  lesson({
    id: 'adv-programs', chapter: 5, title: 'SQL from a program, and SQL injection', minutes: 14,
    summary: 'Programs send SQL to the database as text. Building that text from user input invites SQL injection; prepared statements keep data and code apart.',
    body: [
      'Most queries are not typed by people. The box-office website, the ticket scanner at the door and the nightly sales report all send their SQL through an interface such as JDBC for Java, the Python DB-API, or ODBC. The steps are always the same:',
      { steps: ['open a **connection** to the database server', 'send a statement, as text', 'read the result **one row at a time**, converting each value to the program\'s own types', 'close the connection'] },
      'The second step is where things go wrong, because the statement usually contains something a user typed. Here is a toy table of box-office staff logins:',
      { sql: "drop table if exists box_office_login;\ncreate table box_office_login (\n  username   varchar(20) primary key,\n  secret     varchar(20),\n  is_manager boolean\n);\ninsert into box_office_login values ('wren', 'curtain-up', false), ('tobias', 'm4tinee', false), ('admin', 'stalls#1', true);" },
      { h: 'Gluing input into the text' },
      'A careless login page builds the query by joining strings: `"select * from box_office_login where username = \'" + user + "\' and secret = \'" + pw + "\'"`. When Wren types her name and password, the text sent is harmless:',
      { sql: "select * from box_office_login where username = 'wren' and secret = 'curtain-up';" },
      'Now someone types `admin` as the username and, as the password, `x\' or \'1\' = \'1`. Glued in character by character, this reaches the database:',
      { predict: { q: 'How many rows does the glued query return?', options: ['All three logins: the input closed the string and added a condition of its own', 'None: the password is wrong', 'An error: the quotes do not match'], answer: 0, explain: 'The quote in the input ends the string literal early, and `or \'1\' = \'1\'` becomes part of the SQL. Because `and` binds tighter than `or`, the condition reads `(username = \'admin\' and secret = \'x\') or \'1\' = \'1\'`, which is true for every row. The page sees rows come back and lets the visitor in, quite possibly as the manager.' }, sql: "select * from box_office_login where username = 'admin' and secret = 'x' or '1' = '1';" },
      'This is **SQL injection**: input that changes the structure of the statement instead of only supplying values. It is one of the most common ways data leaks out of web applications, and the cure is simple.',
      { h: 'Prepared statements' },
      'A **prepared statement** sends the text once, with placeholders where the values go, and sends the values separately. A value can never turn into SQL, whatever characters it holds. PostgreSQL offers this in SQL itself with `prepare` and `execute`; program interfaces do the same with `?` or `%s` placeholders.',
      { sql: 'prepare staff_login (varchar, varchar) as\n  select username, is_manager from box_office_login\n  where username = $1 and secret = $2;\n\nexecute staff_login(\'wren\', \'curtain-up\');' },
      'Try the attack again. The input travels as a value, so its quotes are simply characters in a password (inside SQL text a quote in a string is written twice):',
      { sql: "execute staff_login('admin', 'x'' or ''1'' = ''1');", note: 'No rows: nobody has that odd password.' },
      { predict: { q: 'Why not just escape the quotes in the input yourself?', options: ['It is easy to miss a case (another quoting style, an encoding, one forgotten field); a placeholder leaves nothing to miss', 'Escaping is slower than preparing', 'Escaping changes the data that gets stored'], answer: 0, explain: 'Hand-made escaping has to be right in every place, for every kind of character, forever. A placeholder removes the question: the value never becomes part of the SQL text.' } },
      'There is a second gain: the database can parse and plan a prepared statement once and run it many times with different values, which matters for the ticket scanner that checks thousands of bookings an evening.',
      { tip: 'A program can also ask the database about its own structure through **metadata**, such as the `information_schema` views from chapter 1. That is how a general tool like this one discovers which tables exist.' },
      { sql: 'deallocate staff_login;\ndrop table box_office_login;' },
    ],
  });

  lesson({
    id: 'adv-functions', chapter: 5, title: 'Functions and procedures', minutes: 15,
    summary: 'Functions return values or tables and can be used inside queries; procedures are called on their own. Both can be written in SQL or in PL/pgSQL.',
    body: [
      'Some logic belongs in the database rather than in every program that talks to it: a figure many reports need, or a rule about how a booking is made. SQL can store such logic as **functions** and **procedures**.',
      { h: 'A function written in SQL' },
      'How many tickets has a production sold? The answer needs a join and a sum, so wrap it in a function of one parameter:',
      { sql: "create or replace function tickets_sold(p varchar)\n  returns integer\n  language sql\nas $$\n  select coalesce(sum(b.seats), 0)::integer\n  from booking b join performance f on f.perf_id = b.perf_id\n  where f.prod_id = p\n$$;\n\nselect prod_id, title, tickets_sold(prod_id) as tickets\nfrom production\nwhere company_id = 'C05'\norder by tickets desc;", note: 'The body sits between `$$` marks, so it may contain quotes freely.' },
      'A function can go anywhere an expression can, including the where clause:',
      { sql: 'select title from production\nwhere tickets_sold(prod_id) >= 150\norder by title;' },
      { predict: { q: 'How many times does that query call `tickets_sold`?', options: ['Once per production in the table, since the condition is tested for every row', 'Once in all', 'Once per production that passes the test'], answer: 0, explain: 'The where clause is evaluated for each production, and every evaluation calls the function, which runs its own join. Functions make queries short to write, not necessarily cheap to run.' } },
      'Why the `coalesce`? A production that has never been performed has no bookings, and the sum of nothing is null. A box-office report would rather print 0.',
      { h: 'Table functions' },
      'A function can return a whole relation, declared with `returns table (...)`, and then stand in the from clause. The playbill of one venue over a range of dates:',
      { sql: "create or replace function playbill(v varchar, d1 date, d2 date)\n  returns table (perf_date date, start_time time, title varchar)\n  language sql\nas $$\n  select f.perf_date, f.start_time, p.title\n  from performance f join production p on p.prod_id = f.prod_id\n  where f.venue_code = v and f.perf_date between d1 and d2\n  order by f.perf_date, f.start_time\n$$;\n\nselect * from playbill('RIV', date '2025-03-01', date '2025-03-31');" },
      { h: 'PL/pgSQL' },
      'For variables, conditions and loops, PostgreSQL has a procedural language, **PL/pgSQL**. (The SQL standard has its own, SQL/PSM; the ideas carry over, the spelling differs.) A function that turns a star rating into a word, with an explicit case for a booking nobody rated:',
      { sql: "create or replace function rating_word(r integer)\n  returns text\n  language plpgsql\nas $$\nbegin\n  if r is null then\n    return 'not rated';\n  elsif r >= 4 then\n    return 'loved it';\n  elsif r = 3 then\n    return 'fine';\n  else\n    return 'disappointed';\n  end if;\nend\n$$;\n\nselect rating_word(rating) as verdict, count(*)\nfrom booking\ngroup by rating_word(rating)\norder by count(*) desc;" },
      'A loop can hand back rows one at a time with `return next`. This one walks from a production to the one it was adapted from, and on to that one\'s source, until it reaches an original:',
      { sql: "create or replace function sources_of(start varchar)\n  returns table (step integer, source_id varchar, source_title varchar)\n  language plpgsql\nas $$\ndeclare\n  cur varchar := start;\nbegin\n  step := 0;\n  loop\n    select p.based_on into cur from production p where p.prod_id = cur;\n    exit when cur is null;\n    step := step + 1;\n    source_id := cur;\n    select p.title into source_title from production p where p.prod_id = cur;\n    return next;\n  end loop;\nend\n$$;\n\nselect * from sources_of('PR156');" },
      { h: 'Procedures' },
      'A **procedure** returns nothing and is run with `call`. It suits actions, such as booking seats after a check. `raise exception` stops it with an error, and the statement that called it fails as a whole.',
      { sql: "create or replace procedure book_seats(pat integer, perf integer, n integer)\n  language plpgsql\nas $$\nbegin\n  if exists (select * from booking b where b.patron_id = pat and b.perf_id = perf) then\n    raise exception 'patron % already has seats for performance %', pat, perf;\n  end if;\n  insert into booking\n    select (select max(booking_id) + 1 from booking), pat, perf, n, n * f.price, null\n    from performance f where f.perf_id = perf;\n  raise notice 'booked % seats for patron %', n, pat;\nend\n$$;\n\nbegin;\ncall book_seats(3, 1, 2);" },
      { predict: { q: 'Make the same call again in this transaction. What happens?', options: ['The procedure raises its exception and nothing more is inserted', 'A second booking is inserted', 'The first booking is undone and replaced'], answer: 0, explain: 'The check finds the booking made a moment ago and raises an error. The error also aborts the transaction, so end it with rollback.' }, sql: 'call book_seats(3, 1, 2);', fails: 'P0001' },
      { sql: 'rollback;\ndrop procedure book_seats;\ndrop function tickets_sold, playbill, rating_word, sources_of;' },
    ],
  });

  lesson({
    id: 'adv-triggers', chapter: 5, title: 'Triggers', minutes: 14,
    summary: 'A trigger runs a function automatically when rows are inserted, updated or deleted: to keep a log, enforce a rule or tidy data.',
    body: [
      'A **trigger** is an action the database performs by itself as a side effect of a change. You name the event (insert, update or delete, on which table), the moment (before or after the change), and the action.',
      { h: 'An audit log' },
      'Artists\' fees are negotiated and sensitive, so the theatre office wants a record of every change: whose fee, from what, to what, and who changed it. First the log table, then the trigger function:',
      { sql: "drop table if exists fee_audit;\ncreate table fee_audit (\n  changed_at timestamp default now(),\n  person_id  varchar(6),\n  old_fee    numeric(8,2),\n  new_fee    numeric(8,2),\n  changed_by text\n);\n\ncreate or replace function log_fee_change()\n  returns trigger\n  language plpgsql\nas $$\nbegin\n  insert into fee_audit (person_id, old_fee, new_fee, changed_by)\n  values (old.person_id, old.fee, new.fee, current_user);\n  return null;\nend\n$$;" },
      'Inside a row trigger, `old` is the row before the change and `new` the row after it. Attach the function to `artist`:',
      { sql: 'drop trigger if exists fee_change on artist;\ncreate trigger fee_change\n  after update of fee on artist\n  for each row\n  when (old.fee is distinct from new.fee)\n  execute function log_fee_change();' },
      { list: ['`after update of fee`: fire after an update that sets the fee column', '`for each row`: fire once for every changed row, not once for the statement', '`when (...)`: only if the fee really changed'] },
      { predict: { q: 'Run `update artist set fee = fee * 1.05 where company_id = \'C05\'`. How many rows appear in fee_audit?', options: ['4, one per artist of company C05', '1, one for the statement', '0, because the trigger waits for commit'], answer: 0, explain: 'A row-level trigger fires once for each row the statement changes. Company C05 has four artists, each fee changes, so the when condition holds four times.' }, sql: "update artist set fee = fee * 1.05 where company_id = 'C05';\nselect person_id, old_fee, new_fee, changed_by from fee_audit;" },
      'Take the raise back. Putting the fees back is an update too, so the trigger logs it as well:',
      { sql: "update artist set fee = a.old_fee\nfrom fee_audit a\nwhere artist.person_id = a.person_id and a.new_fee = artist.fee;\nselect person_id, old_fee, new_fee from fee_audit order by changed_at, person_id;" },
      { h: 'A before trigger that tidies data' },
      'A **before** trigger runs before the change is stored. It may alter `new`, or refuse the change by raising an error. Patrons type their city in all sorts of ways; store it trimmed and capitalised, and refuse a city made only of spaces:',
      { sql: "create or replace function tidy_city()\n  returns trigger\n  language plpgsql\nas $$\nbegin\n  new.city := initcap(trim(new.city));\n  if new.city = '' then\n    raise exception 'a city cannot be blank';\n  end if;\n  return new;\nend\n$$;\n\ndrop trigger if exists tidy_city on patron;\ncreate trigger tidy_city\n  before insert or update of city on patron\n  for each row\n  when (new.city is not null)\n  execute function tidy_city();" },
      { sql: "begin;\nupdate patron set city = '  saltreach ' where patron_id = 3;\nselect patron_id, name, city from patron where patron_id = 3;" },
      { sql: "update patron set city = '   ' where patron_id = 4;", fails: 'P0001', note: 'The trigger refuses it.' },
      { sql: 'rollback;' },
      { warn: 'Triggers act out of sight: a one-line update can set off far more than it seems to. Use them for logs and for rules that must hold whichever program makes the change, and prefer a constraint whenever a constraint can say the same thing.' },
      'Clean up: the triggers first, then their functions and the log.',
      { sql: 'drop trigger fee_change on artist;\ndrop trigger tidy_city on patron;\ndrop function log_fee_change, tidy_city;\ndrop table fee_audit;' },
    ],
  });

  lesson({
    id: 'adv-recursive', chapter: 5, title: 'Recursive queries', minutes: 14,
    summary: 'WITH RECURSIVE computes a result by repeating a query until nothing new appears: a whole chain of adaptations, or everyone in a mentoring line, however deep.',
    body: [
      'Some productions are adaptations or sequels of others: `production.based_on` names the source. A sequel of a sequel points to its own source, and so on back to an original. "Every production this one descends from" cannot be written with a fixed number of joins, because chains have different lengths. It is the **transitive closure** of based_on.',
      { sql: "select prod_id, title, based_on from production where prod_id = 'PR156';" },
      { h: 'with recursive' },
      'A recursive `with` has two parts joined by `union`: a **base query**, and a **recursive query** that refers to the relation being defined. Every source of PR156, near or far:',
      { sql: "with recursive source (prod_id) as (\n    select based_on from production where prod_id = 'PR156'      -- base\n  union\n    select p.based_on                                              -- recursive\n    from production p join source s on p.prod_id = s.prod_id\n    where p.based_on is not null\n)\nselect s.prod_id, p.title\nfrom source s join production p using (prod_id);" },
      { h: 'How it is computed' },
      'The database starts from the base query\'s rows, then runs the recursive query on the rows found in the previous round, adds whatever is new, and repeats until a round adds nothing: the **fixed point**. A chain of adaptations has one step per round. The mentoring relation is more interesting, because some artists have two mentors. Everyone in the line under artist P1019:',
      { sql: "with recursive line (person_id) as (\n    select mentee_id from mentor where mentor_id = 'P1019'\n  union\n    select m.mentee_id\n    from mentor m join line l on m.mentor_id = l.person_id\n)\nselect * from line order by person_id;" },
      { table: [['Round', 'Starts from', 'Finds', 'New'], ['base', '', 'P1007, P1010, P1051, P1074', 'P1007, P1010, P1051, P1074'], ['1', 'P1007, P1010, P1051, P1074', 'P1002, P1036, P1040, P1086', 'P1002, P1036, P1040, P1086'], ['2', 'P1002, P1036, P1040, P1086', 'P1053, P1010', 'P1053'], ['3', 'P1053', 'nothing', 'nothing: stop']] },
      { predict: { q: 'In round 2, P1040 leads to P1010. Why does P1010 not start another round?', options: ['P1010 is already in the result, and union adds only rows not seen before', 'P1010 mentors nobody', 'The recursion is limited to two rounds'], answer: 0, explain: 'With `union`, a row already in the result is not new, so it is neither added again nor explored again. That is what lets the computation end.' } },
      { h: 'union all and depth' },
      'With `union all`, rows seen before are kept and explored again. A depth column then shows every path: P1010 is reached directly, and again three steps down through P1051 and P1040.',
      { sql: "with recursive line (person_id, depth) as (\n    select mentee_id, 1 from mentor where mentor_id = 'P1019'\n  union all\n    select m.mentee_id, l.depth + 1\n    from mentor m join line l on m.mentor_id = l.person_id\n)\nselect person_id, min(depth) as nearest, count(*) as paths\nfrom line\ngroup by person_id\norder by nearest, person_id;" },
      { warn: 'If the data had a cycle (A mentors B, B mentors A), `union all` would never stop: each round would find the same rows again. `union` stops because nothing is new. Kwery, like other systems, also caps the number of rounds as a safety net.' },
      { h: 'The other direction' },
      'Turn the join around to find everything that grew out of one production: its adaptations, their adaptations, and so on.',
      { sql: "with recursive derived (prod_id) as (\n    select prod_id from production where based_on = 'PR108'\n  union\n    select p.prod_id\n    from production p join derived d on p.based_on = d.prod_id\n)\nselect d.prod_id, p.title, p.premiere\nfrom derived d join production p using (prod_id)\norder by p.premiere;" },
      { predict: { q: 'Each recursive query here is monotonic: adding rows to production can only add rows to its result. Would a `not exists` on the recursive relation keep that true?', options: ['No: with negation, a new row could remove a result row, and the fixed point is no longer well defined', 'Yes, not exists is always allowed', 'Only with union all'], answer: 0, explain: 'A recursive definition is guaranteed a sensible answer only when the recursive part is monotonic. That is why SQL forbids aggregation and negation over the recursive relation inside the recursive part.' } },
    ],
  });

  lesson({
    id: 'adv-windows', chapter: 5, title: 'Window functions', minutes: 14,
    summary: 'A window function computes over a set of rows related to the current one, without collapsing them as group by does: ranks, running totals, moving averages, the previous row.',
    body: [
      'An aggregate with group by turns each group into a single row. A **window function** computes the same kind of value but keeps every row and attaches the result to it. The `over (...)` clause says which rows make up each row\'s window. Every performance of two productions, next to the average ticket price of its production:',
      { sql: "select prod_id, perf_date, price,\n       round(avg(price) over (partition by prod_id), 2) as prod_avg\nfrom performance\nwhere prod_id in ('PR101', 'PR105')\norder by prod_id, perf_date;" },
      '`partition by` splits the rows into groups, and each row\'s window is its own group.',
      { h: 'Ranking' },
      '`rank()` numbers the rows of each partition in the order given. The artists of each company, by fee:',
      { sql: 'select company_id, person_id, fee,\n       rank() over (partition by company_id order by fee desc) as place\nfrom artist\nwhere company_id is not null\norder by company_id, place, person_id;' },
      'The best-paid artist of each company is then the row with place 1. A window function cannot be used in where (where is evaluated before windows are computed), so wrap the query:',
      { sql: 'select company_id, person_id, fee\nfrom (select company_id, person_id, fee,\n             rank() over (partition by company_id order by fee desc) as place\n      from artist where company_id is not null) as ranked\nwhere place = 1\norder by company_id;' },
      { h: 'Running totals' },
      'With `order by` inside over, an aggregate becomes cumulative: each row\'s window is every row up to it. Seats sold month by month, with the total so far:',
      { sql: "select to_char(f.perf_date, 'YYYY-MM') as month, sum(b.seats) as seats,\n       sum(sum(b.seats)) over (order by to_char(f.perf_date, 'YYYY-MM')) as so_far\nfrom booking b join performance f on f.perf_id = b.perf_id\ngroup by to_char(f.perf_date, 'YYYY-MM')\norder by month;", note: 'Windows are computed after grouping, so the inner `sum(b.seats)` is each month\'s total and the outer `sum(...) over` adds those up.' },
      { h: 'Frames' },
      'A **frame** narrows the window to rows near the current one. `rows between 1 preceding and 1 following` covers three rows: a moving average that smooths out a busy month.',
      { sql: "select to_char(f.perf_date, 'YYYY-MM') as month, sum(b.seats) as seats,\n       round(avg(sum(b.seats)) over (order by to_char(f.perf_date, 'YYYY-MM') rows between 1 preceding and 1 following), 1) as smoothed\nfrom booking b join performance f on f.perf_id = b.perf_id\ngroup by to_char(f.perf_date, 'YYYY-MM')\norder by month;" },
      { predict: { q: 'What is the smoothed value in the very first month?', options: ['The average of the first two months only: there is no row before it', 'The first month\'s own figure', 'Null'], answer: 0, explain: 'A frame takes the rows that exist. For the first month the frame holds that month and the next, so the average is over two values. The last month is treated the same way.' } },
      { h: 'The previous and the next row' },
      '`lag(x)` is the value of x in the previous row of the window order, `lead(x)` in the next one. The change in seats sold from one month to the next:',
      { sql: "select to_char(f.perf_date, 'YYYY-MM') as month, sum(b.seats) as seats,\n       sum(b.seats) - lag(sum(b.seats)) over (order by to_char(f.perf_date, 'YYYY-MM')) as change\nfrom booking b join performance f on f.perf_id = b.perf_id\ngroup by to_char(f.perf_date, 'YYYY-MM')\norder by month;" },
      'The first month has no previous row, so its change is null. Note also that the summer months, when nothing is on, are simply missing: `lag` looks at the previous row, not the previous calendar month.',
      { tip: 'When several window functions share a window, name it once: `... over w ... window w as (partition by company_id order by fee)`.' },
    ],
  });

  lesson({
    id: 'adv-olap', chapter: 5, title: 'OLAP: rollup, cube and grouping sets', minutes: 14,
    summary: 'Online analytical processing looks at totals along several dimensions at once. ROLLUP, CUBE and GROUPING SETS compute many groupings in one query.',
    body: [
      'The programme director wants totals along several **dimensions**: performances by genre, by season, by both, and overall. Each is a group by of its own, and the results are often laid out as a **cross-tab**, one dimension down the side, one across the top, totals in the margins.',
      'A season runs from autumn to early summer, so shift each date back six months and take the year: that is the year the season began. The detail, for two genres:',
      { sql: "select p.genre, extract(year from f.perf_date - interval '6 months') as season, count(*) as performances\nfrom performance f join production p using (prod_id)\nwhere p.genre in ('opera', 'comedy')\ngroup by p.genre, extract(year from f.perf_date - interval '6 months')\norder by p.genre, season;" },
      { h: 'rollup' },
      '`group by rollup (a, b)` computes the groupings (a, b), (a) and () together: the detail, a subtotal for each a, and a grand total. In a subtotal row, the attributes that were rolled up are null.',
      { sql: "select p.genre, extract(year from f.perf_date - interval '6 months') as season, count(*) as performances\nfrom performance f join production p using (prod_id)\nwhere p.genre in ('opera', 'comedy')\ngroup by rollup (p.genre, extract(year from f.perf_date - interval '6 months'))\norder by p.genre, season;" },
      { predict: { q: 'How many rows does `group by cube (...)` give for the same data?', options: ['9: four details, two genre totals, two season totals and one grand total', '7, the same as rollup', '4'], answer: 0, explain: 'cube computes every subset of its attributes: (genre, season), (genre), (season) and (). rollup leaves out (season) on its own, which here adds one total per season.' }, sql: "select p.genre, extract(year from f.perf_date - interval '6 months') as season, count(*) as performances\nfrom performance f join production p using (prod_id)\nwhere p.genre in ('opera', 'comedy')\ngroup by cube (p.genre, extract(year from f.perf_date - interval '6 months'))\norder by p.genre, season;" },
      { h: 'grouping sets' },
      '`grouping sets` lists exactly the groupings you want. Seats sold per venue and, separately, per start time, plus the overall total, but no venue-and-time detail:',
      { sql: "select f.venue_code, f.start_time, sum(b.seats) as seats\nfrom booking b join performance f on f.perf_id = b.perf_id\ngroup by grouping sets ((f.venue_code), (f.start_time), ())\norder by f.venue_code, f.start_time;" },
      { h: 'Which nulls are totals?' },
      'A subtotal row has a null where an attribute was rolled up. But real data has nulls too: some patrons never gave a city.',
      { sql: 'select city, count(*) as patrons\nfrom patron\ngroup by rollup (city)\norder by city;' },
      { predict: { q: 'The last two rows both show a null city. How can you tell which one is the grand total?', options: ['grouping(city) is 1 in the total row and 0 in the row of patrons without a city', 'The total is always the last row', 'They cannot be told apart'], answer: 0, explain: '`grouping(a)` returns 1 when a row is a total over a, and 0 when a holds a real value of the data, null or not.' }, sql: "select case when grouping(city) = 1 then 'all cities'\n            else coalesce(city, '(no city given)') end as city,\n       count(*) as patrons\nfrom patron\ngroup by rollup (city)\norder by grouping(city), city;" },
      { tip: 'With several attributes, `grouping(a, b)` returns a bit pattern: 1 when b is rolled up, 2 when a is, 3 when both are. It is handy for sorting the totals after the detail.' },
    ],
  });

  lesson({
    id: 'adv-ranking', chapter: 5, title: 'Ranking, ties and NTILE', minutes: 12,
    summary: 'rank, dense_rank and row_number differ only when values tie. ntile splits rows into buckets of equal size, and ties may land on either side of a boundary.',
    body: [
      'Three artists are paid exactly the same fee, 1850. Ranking by fee has to decide what to do with them. Look at the band of fees around theirs:',
      { sql: "select person_id, fee,\n       rank()       over (order by fee desc) as rank,\n       dense_rank() over (order by fee desc) as dense_rank,\n       row_number() over (order by fee desc, person_id) as row_number\nfrom artist\nwhere fee between 1700 and 2000\norder by fee desc, person_id;" },
      { table: [['Function', 'For a tie', 'After a tie'], ['`rank()`', 'the same number', 'skips: 1, 2, 3, 3, 3, 6'], ['`dense_rank()`', 'the same number', 'no gap: 1, 2, 3, 3, 3, 4'], ['`row_number()`', 'different numbers, in an order the database picks unless you break the tie', '1, 2, 3, 4, 5, 6']] },
      { predict: { q: 'A casting director wants "the three cheapest artists". Six artists share the lowest fee, 450. Which filter keeps everyone tied for a place in the top three?', options: ['rank() <= 3, which returns all six', 'row_number() <= 3', 'Both give the same here'], answer: 0, explain: 'rank() gives tied rows the same number, so all six artists at 450 have rank 1 and are kept. row_number() cuts arbitrarily inside the tie, so the answer would depend on the plan unless a unique column breaks the tie.' }, sql: "select person_id, fee from (\n  select person_id, fee, rank() over (order by fee) as r from artist\n) t where r <= 3\norder by fee, person_id;" },
      { h: 'Relative standing' },
      '`percent_rank()` is (rank − 1) / (rows − 1): 0 for the first row, 1 for the last. `cume_dist()` is the fraction of rows at or before the current one, ties included.',
      { sql: "select person_id, fee,\n       round(percent_rank() over (order by fee)::numeric, 3) as pct_rank,\n       round(cume_dist() over (order by fee)::numeric, 3) as cume\nfrom artist\norder by fee, person_id;" },
      { h: 'ntile' },
      '`ntile(n)` deals the ordered rows into n buckets as evenly as it can. The patrons by loyalty points, in quartiles:',
      { sql: 'select ntile(4) over (order by points, patron_id) as quartile, patron_id, name, points\nfrom patron\norder by points, patron_id;' },
      { predict: { q: '200 patrons go into 4 buckets of 50, and many patrons have the same number of points. Can two patrons with equal points land in different quartiles?', options: ['Yes: ntile cuts by position, not by value, so a run of equal values can straddle a boundary', 'No: tied rows always share a bucket', 'Only when the points are zero'], answer: 0, explain: 'ntile only counts rows, 50 to a bucket. If the 50th and 51st patrons have the same points they still go to different buckets. To keep ties together, cut by value instead, for example with percent_rank or cume_dist.' }, sql: 'select points, min(q) as from_bucket, max(q) as to_bucket, count(*) as patrons\nfrom (select points, ntile(4) over (order by points, patron_id) as q from patron) t\ngroup by points\nhaving min(q) <> max(q);' },
      { h: 'Nulls in rankings' },
      'When the ordering value is null, those rows sort last in ascending order and first in descending order, so a null can take first place without anyone meaning it to. Say `nulls first` or `nulls last` to decide. Ranking works per partition too: the artists of each company from youngest to oldest, the ones with no recorded birth date at the end:',
      { sql: "select a.company_id, a.person_id, p.birth_date,\n       dense_rank() over (partition by a.company_id order by p.birth_date desc nulls last) as youngest_first\nfrom artist a join person p using (person_id)\nwhere a.company_id in ('C05', 'C09')\norder by a.company_id, youngest_first, a.person_id;" },
    ],
  });

  // ---- exercises ----------------------------------------------------------------------------------------------------------
  const ex = (x) => C.exercise(Object.assign({ chapter: 5 }, x));
  const fix = (wrong, why) => ['A classmate wrote this query' + (why ? ' ' + why : '') + ':', { sql: wrong, run: false }, 'It does not do what was asked. Write a query that does.'];
  const MONTH = "to_char(f.perf_date, 'YYYY-MM')";

  // functions and procedures
  ex({ id: 'adv-x-fn-cast-size', kind: 'dml', level: 1, title: 'A function in SQL',
    text: ['Write a function `cast_size(p varchar)` in `language sql` that returns, as a `bigint`, how many roles have been cast in production p (the number of its rows in casting).',
      '**Answer with** the `create function` statement. The check then lists every production with `cast_size(prod_id)`, which must be 0 for a production with no casting.'],
    ref: 'create function cast_size(p varchar) returns bigint language sql as $$\n  select count(*) from casting where prod_id = p\n$$',
    after: 'select prod_id, cast_size(prod_id) from production',
    wrongs: ['create function cast_size(p varchar) returns bigint language sql as $$ select count(*) from casting where prod_id = p and lead $$',
      'create function cast_size(p varchar) returns bigint language sql as $$ select count(*) from casting $$'],
    hints: ['create function name(parameters) returns type language sql as $$ ... $$', 'The body is a single query returning one value; count(*) of no rows is 0.', 'create function cast_size(p varchar) returns bigint language sql as $$ select count(*) from casting where prod_id = p $$'] });

  ex({ id: 'adv-x-fn-takings', kind: 'dml', level: 2, title: 'Box-office takings',
    text: ['Write a function `takings(p varchar) returns numeric` giving the total amount paid for all bookings of all performances of production p. A production with no bookings must give 0, not null.',
      '**Answer with** the `create function` statement. The check lists every production with `takings(prod_id)`.'],
    ref: 'create function takings(p varchar) returns numeric language sql as $$\n  select coalesce(sum(b.paid), 0)\n  from booking b join performance f on f.perf_id = b.perf_id\n  where f.prod_id = p\n$$',
    after: 'select prod_id, takings(prod_id) from production',
    wrongs: ['create function takings(p varchar) returns numeric language sql as $$ select sum(b.paid) from booking b join performance f on f.perf_id = b.perf_id where f.prod_id = p $$',
      'create function takings(p varchar) returns numeric language sql as $$ select coalesce(sum(f.price), 0) from performance f where f.prod_id = p $$'],
    hints: ['The amount paid is in booking; the production is reached through performance.', 'The sum over no rows is null.', 'create function takings(p varchar) returns numeric language sql as $$ select coalesce(sum(b.paid), 0) from booking b join performance f on f.perf_id = b.perf_id where f.prod_id = p $$'] });

  ex({ id: 'adv-x-fn-bill', kind: 'dml', level: 2, title: 'A table function',
    text: ['Write a function `on_stage(v varchar, d1 date, d2 date)` that returns a table `(perf_id integer, title varchar)` of the performances at venue v whose date lies from d1 to d2, both days included.',
      '**Answer with** the `create function` statement. The check runs `select * from on_stage(\'RIV\', date \'2024-09-18\', date \'2024-12-31\')`.'],
    ref: 'create function on_stage(v varchar, d1 date, d2 date) returns table (perf_id integer, title varchar) language sql as $$\n  select f.perf_id, p.title\n  from performance f join production p on p.prod_id = f.prod_id\n  where f.venue_code = v and f.perf_date between d1 and d2\n$$',
    after: "select * from on_stage('RIV', date '2024-09-18', date '2024-12-31')",
    wrongs: ['create function on_stage(v varchar, d1 date, d2 date) returns table (perf_id integer, title varchar) language sql as $$ select f.perf_id, p.title from performance f join production p on p.prod_id = f.prod_id where f.venue_code = v and f.perf_date > d1 and f.perf_date < d2 $$',
      'create function on_stage(v varchar, d1 date, d2 date) returns table (perf_id integer, title varchar) language sql as $$ select f.perf_id, p.title from performance f join production p on p.prod_id = f.prod_id where f.perf_date between d1 and d2 $$'],
    hints: ['returns table (perf_id integer, title varchar)', 'between includes both ends; the title comes from production.', 'create function on_stage(v varchar, d1 date, d2 date) returns table (perf_id integer, title varchar) language sql as $$ select f.perf_id, p.title from performance f join production p on p.prod_id = f.prod_id where f.venue_code = v and f.perf_date between d1 and d2 $$'] });

  ex({ id: 'adv-x-fn-verdict', kind: 'dml', level: 2, title: 'A function with IF',
    text: ["Write a PL/pgSQL function `verdict(r integer) returns text` that returns 'unrated' for a null rating, 'poor' for 1 or 2, 'fair' for 3 and 'good' for 4 or 5.",
      '**Answer with** the `create function` statement. The check lists every booking with `verdict(rating)`.'],
    ref: "create function verdict(r integer) returns text language plpgsql as $$\nbegin\n  if r is null then return 'unrated';\n  elsif r <= 2 then return 'poor';\n  elsif r = 3 then return 'fair';\n  else return 'good';\n  end if;\nend\n$$",
    after: 'select booking_id, verdict(rating) from booking',
    wrongs: ["create function verdict(r integer) returns text language plpgsql as $$ begin if r <= 2 then return 'poor'; elsif r = 3 then return 'fair'; else return 'good'; end if; end $$",
      "create function verdict(r integer) returns text language plpgsql as $$ begin if r is null then return 'unrated'; elsif r < 2 then return 'poor'; elsif r = 3 then return 'fair'; else return 'good'; end if; end $$"],
    hints: ['language plpgsql, with begin ... end around the body.', 'Test for null first: a comparison with null is not true, so a null would fall through to else.', "create function verdict(r integer) returns text language plpgsql as $$ begin if r is null then return 'unrated'; elsif r <= 2 then return 'poor'; elsif r = 3 then return 'fair'; else return 'good'; end if; end $$"] });

  ex({ id: 'adv-x-fn-generation', kind: 'dml', level: 3, title: 'How many steps from the original',
    text: ['Write a function `generation(p varchar) returns integer` giving how many based_on steps lead from production p back to an original production: 0 for an original, 1 for a direct adaptation of an original, and so on.',
      '**Answer with** the `create function` statement. The check lists every production with `generation(prod_id)`.'],
    ref: 'create function generation(p varchar) returns integer language sql as $$\n  with recursive up (prod_id, n) as (\n      select based_on, 1 from production where prod_id = p and based_on is not null\n    union all\n      select x.based_on, u.n + 1 from production x join up u on x.prod_id = u.prod_id where x.based_on is not null\n  )\n  select coalesce(max(n), 0)::integer from up\n$$',
    after: 'select prod_id, generation(prod_id) from production',
    wrongs: ['create function generation(p varchar) returns integer language sql as $$ select case when based_on is null then 0 else 1 end from production where prod_id = p $$',
      'create function generation(p varchar) returns integer language sql as $$ with recursive up (prod_id, n) as (select based_on, 1 from production where prod_id = p and based_on is not null union all select x.based_on, u.n + 1 from production x join up u on x.prod_id = u.prod_id where x.based_on is not null) select max(n)::integer from up $$'],
    hints: ['A recursive with inside the function can climb the based_on chain.', 'Carry a step count that grows by one each round; the answer is the largest count.', 'An original has no rows in the recursion, so return coalesce(max(n), 0).'] });

  ex({ id: 'adv-x-proc-discount', kind: 'dml', level: 2, title: 'A procedure',
    text: ['Write a procedure `discount(p varchar, pct numeric)` that lowers the ticket price of every performance of production p by pct percent. Then call it to take 20 percent off PR101.',
      '**Answer with** the `create procedure` statement and the `call`, separated by a semicolon. The check lists every performance with its price.'],
    ref: "create procedure discount(p varchar, pct numeric) language sql as $$\n  update performance set price = price * (1 - pct / 100) where prod_id = p\n$$;\ncall discount('PR101', 20)",
    alts: ["create procedure discount(p varchar, pct numeric) language plpgsql as $$ begin update performance set price = price * (1 - pct / 100) where prod_id = p; end $$; call discount('PR101', 20)"],
    after: 'select perf_id, price from performance',
    wrongs: ["create procedure discount(p varchar, pct numeric) language sql as $$ update performance set price = price * pct / 100 where prod_id = p $$; call discount('PR101', 20)",
      "create procedure discount(p varchar, pct numeric) language sql as $$ update performance set price = price - pct where prod_id = p $$; call discount('PR101', 20)"],
    hints: ['create procedure ... language sql (or plpgsql) as $$ ... $$', 'pct percent off means multiplying by 1 - pct / 100.', "create procedure discount(p varchar, pct numeric) language sql as $$ update performance set price = price * (1 - pct / 100) where prod_id = p $$; call discount('PR101', 20)"] });

  ex({ id: 'adv-x-proc-points', kind: 'dml', level: 3, title: 'A procedure with a check',
    text: ['Write a PL/pgSQL procedure `award_points(p integer, n integer)` that adds n loyalty points to patron p, but raises an exception, changing nothing, if n is not positive or if there is no patron p. Then call it to give patron 5 a hundred points.',
      '**Answer with** the `create procedure` statement and the `call`. The check lists every patron with their points.'],
    ref: "create procedure award_points(p integer, n integer) language plpgsql as $$\nbegin\n  if n <= 0 or not exists (select * from patron where patron_id = p) then\n    raise exception 'cannot give % points to patron %', n, p;\n  end if;\n  update patron set points = points + n where patron_id = p;\nend\n$$;\ncall award_points(5, 100)",
    after: 'select patron_id, points from patron',
    wrongs: ["create procedure award_points(p integer, n integer) language plpgsql as $$ begin update patron set points = n where patron_id = p; end $$; call award_points(5, 100)",
      "create procedure award_points(p integer, n integer) language plpgsql as $$ begin if n <= 0 then raise exception 'no'; end if; update patron set points = points + n; end $$; call award_points(5, 100)"],
    hints: ['Check first: if n <= 0 or not exists (...) then raise exception ...; end if;', 'Then one update, restricted to patron p.', "Finish with call award_points(5, 100)."] });

  // triggers
  ex({ id: 'adv-x-trg-lapsed', kind: 'dml', level: 2, title: 'Remember who left',
    text: ['Create a table `lapsed_patron (patron_id integer, name varchar(40))` and a trigger that, after a patron is deleted, records the patron\'s ID and name in it. Then delete every patron who has never made a booking.',
      '**Answer with** the statements, separated by semicolons. The check lists the rows of lapsed_patron, each with the number of patrons left.'],
    ref: "create table lapsed_patron (patron_id integer, name varchar(40));\ncreate function note_lapsed() returns trigger language plpgsql as $$\nbegin\n  insert into lapsed_patron values (old.patron_id, old.name);\n  return null;\nend\n$$;\ncreate trigger patron_removed after delete on patron for each row execute function note_lapsed();\ndelete from patron p where not exists (select * from booking b where b.patron_id = p.patron_id)",
    after: 'select l.patron_id, l.name, (select count(*) from patron) from lapsed_patron l',
    wrongs: ["create table lapsed_patron (patron_id integer, name varchar(40)); create function note_lapsed() returns trigger language plpgsql as $$ begin insert into lapsed_patron values (old.patron_id, old.name); return null; end $$; create trigger patron_removed before delete on patron for each row execute function note_lapsed(); delete from patron p where not exists (select * from booking b where b.patron_id = p.patron_id)",
      "create table lapsed_patron (patron_id integer, name varchar(40)); create function note_lapsed() returns trigger language plpgsql as $$ begin insert into lapsed_patron values (old.patron_id, old.name); return null; end $$; create trigger patron_removed after delete on patron for each row execute function note_lapsed(); delete from patron where points = 0"],
    hints: ['A trigger function returns trigger and is written in plpgsql; in a delete trigger, old holds the deleted row.', 'Use an after trigger: a before trigger that returns null cancels the delete of that row.', 'create trigger ... after delete on patron for each row execute function ...; then delete from patron p where not exists (select * from booking b where b.patron_id = p.patron_id).'] });

  ex({ id: 'adv-x-trg-cap', kind: 'dml', level: 3, title: 'A fee cap',
    text: ['Create a trigger on artist that, before any insert or update, lowers a fee above 5000 to exactly 5000. Then raise the fee of every artist of company C06 by 40 percent.',
      '**Answer with** the statements, separated by semicolons. The check lists the C06 artists with their fees.'],
    ref: "create function cap_fee() returns trigger language plpgsql as $$\nbegin\n  if new.fee > 5000 then\n    new.fee := 5000;\n  end if;\n  return new;\nend\n$$;\ncreate trigger fee_cap before insert or update on artist for each row execute function cap_fee();\nupdate artist set fee = fee * 1.4 where company_id = 'C06'",
    after: "select person_id, fee from artist where company_id = 'C06'",
    wrongs: ["create function cap_fee() returns trigger language plpgsql as $$ begin if new.fee > 5000 then new.fee := 5000; end if; return new; end $$; create trigger fee_cap after insert or update on artist for each row execute function cap_fee(); update artist set fee = fee * 1.4 where company_id = 'C06'",
      "create function cap_fee() returns trigger language plpgsql as $$ begin if new.fee > 5000 then new.fee := 5000; end if; return null; end $$; create trigger fee_cap before insert or update on artist for each row execute function cap_fee(); update artist set fee = fee * 1.4 where company_id = 'C06'"],
    hints: ['Only a before trigger can change new before it is stored.', 'It must return new; returning null skips the change for that row.', 'Then run the update; the trigger caps the large fees.'] });

  ex({ id: 'adv-x-trg-sold', kind: 'dml', level: 3, title: 'Keeping a count up to date',
    text: ['Create a table `seats_sold (perf_id integer primary key, seats integer)` filled with the total seats booked for every performance that has bookings. Add a trigger that, after a booking is inserted, adds its seats to the count of its performance. Then insert booking 9000: patron 3, performance 16, 3 seats, paid 129.00, not rated.',
      '**Answer with** the statements, separated by semicolons. The check lists the rows of seats_sold.'],
    ref: "create table seats_sold (perf_id integer primary key, seats integer);\ninsert into seats_sold select perf_id, sum(seats) from booking group by perf_id;\ncreate function add_seats() returns trigger language plpgsql as $$\nbegin\n  update seats_sold set seats = seats + new.seats where perf_id = new.perf_id;\n  return null;\nend\n$$;\ncreate trigger booking_added after insert on booking for each row execute function add_seats();\ninsert into booking values (9000, 3, 16, 3, 129.00, null)",
    after: 'select perf_id, seats from seats_sold',
    wrongs: ["create table seats_sold (perf_id integer primary key, seats integer); insert into seats_sold select perf_id, sum(seats) from booking group by perf_id; create function add_seats() returns trigger language plpgsql as $$ begin update seats_sold set seats = seats + 1 where perf_id = new.perf_id; return null; end $$; create trigger booking_added after insert on booking for each row execute function add_seats(); insert into booking values (9000, 3, 16, 3, 129.00, null)",
      "create table seats_sold (perf_id integer primary key, seats integer); insert into seats_sold select perf_id, count(*) from booking group by perf_id; create function add_seats() returns trigger language plpgsql as $$ begin update seats_sold set seats = seats + new.seats where perf_id = new.perf_id; return null; end $$; create trigger booking_added after insert on booking for each row execute function add_seats(); insert into booking values (9000, 3, 16, 3, 129.00, null)"],
    hints: ['Create and fill the table with insert ... select ... group by perf_id.', 'The trigger function adds new.seats to the row for new.perf_id.', 'An after insert row trigger on booking, then the insert.'] });

  // recursive queries
  ex({ id: 'adv-x-rec-sources', level: 2, title: 'Every source',
    text: ['List every production that PR156 is based on, directly or through other adaptations.',
      '**Answer with** two columns, prod_id and title, one row per production, PR156 itself not included; any order.'],
    ref: "with recursive src (prod_id) as (\n    select based_on from production where prod_id = 'PR156' and based_on is not null\n  union\n    select p.based_on from production p join src s on p.prod_id = s.prod_id where p.based_on is not null\n)\nselect s.prod_id, p.title from src s join production p on p.prod_id = s.prod_id",
    wrongs: ["select q.prod_id, q.title from production p join production q on q.prod_id = p.based_on where p.prod_id = 'PR156'",
      "with recursive src (prod_id) as (select prod_id from production where prod_id = 'PR156' union select p.based_on from production p join src s on p.prod_id = s.prod_id where p.based_on is not null) select s.prod_id, p.title from src s join production p on p.prod_id = s.prod_id"],
    hints: ['Start from the source of PR156.', 'Then add the source of every production found so far, until there is none.', "with recursive src (prod_id) as (select based_on from production where prod_id = 'PR156' and based_on is not null union select p.based_on from production p join src s on p.prod_id = s.prod_id where p.based_on is not null) select s.prod_id, p.title from src s join production p on p.prod_id = s.prod_id"] });

  ex({ id: 'adv-x-rec-derived', level: 2, title: 'Everything that grew from one production',
    text: ['List every production derived from PR108: its adaptations, their adaptations, and so on.',
      '**Answer with** two columns, prod_id and title, each production once; any order.'],
    ref: "with recursive later (prod_id) as (\n    select prod_id from production where based_on = 'PR108'\n  union\n    select p.prod_id from production p join later l on p.based_on = l.prod_id\n)\nselect l.prod_id, p.title from later l join production p on p.prod_id = l.prod_id",
    wrongs: ["select prod_id, title from production where based_on = 'PR108'",
      "select p.prod_id, p.title from production p where p.based_on = 'PR108' or p.based_on in (select prod_id from production where based_on = 'PR108')"],
    hints: ['Follow based_on the other way: from a source to the productions that name it.', 'Base: the productions based on PR108. Recursive step: the productions based on one already found.', "with recursive later (prod_id) as (select prod_id from production where based_on = 'PR108' union select p.prod_id from production p join later l on p.based_on = l.prod_id) select l.prod_id, p.title from later l join production p on p.prod_id = l.prod_id"] });

  ex({ id: 'adv-x-rec-line', level: 2, title: 'A whole mentoring line',
    text: ['List every artist in the mentoring line under P1055: the artists P1055 mentors, the artists they mentor, and so on.',
      '**Answer with** one column, person_id, each artist once; any order.'],
    ref: "with recursive line (person_id) as (\n    select mentee_id from mentor where mentor_id = 'P1055'\n  union\n    select m.mentee_id from mentor m join line l on m.mentor_id = l.person_id\n)\nselect person_id from line",
    wrongs: ["with recursive line (person_id) as (select mentee_id from mentor where mentor_id = 'P1055' union all select m.mentee_id from mentor m join line l on m.mentor_id = l.person_id) select person_id from line",
      "select mentee_id from mentor where mentor_id = 'P1055'"],
    hints: ['Base: the direct mentees of P1055.', 'Recursive step: the mentees of anyone already in the line.', 'Some artists have two mentors in the same line, so use union, not union all, to list each once.'] });

  ex({ id: 'adv-x-rec-nearest', level: 3, title: 'How far down the line',
    text: ['For every artist in the mentoring line under P1055, give the smallest number of mentoring steps from P1055 to that artist (1 for a direct mentee).',
      '**Answer with** two columns, person_id and the number of steps, one row per artist; any order.'],
    ref: "with recursive line (person_id, d) as (\n    select mentee_id, 1 from mentor where mentor_id = 'P1055'\n  union all\n    select m.mentee_id, l.d + 1 from mentor m join line l on m.mentor_id = l.person_id\n)\nselect person_id, min(d) from line group by person_id",
    wrongs: ["with recursive line (person_id, d) as (select mentee_id, 1 from mentor where mentor_id = 'P1055' union all select m.mentee_id, l.d + 1 from mentor m join line l on m.mentor_id = l.person_id) select person_id, max(d) from line group by person_id",
      "with recursive line (person_id, d) as (select mentee_id, 1 from mentor where mentor_id = 'P1055' union all select m.mentee_id, l.d + 1 from mentor m join line l on m.mentor_id = l.person_id) select person_id, count(*) from line group by person_id"],
    hints: ['Carry a depth column that grows by one each round.', 'With a depth, two paths to the same artist are different rows, so use union all (the mentoring graph has no cycles).', 'Group by the artist and take the minimum depth.'] });

  ex({ id: 'adv-x-rec-line-size', level: 3, title: 'Counting a whole line',
    text: ['For every artist who mentors anyone, give the number of different artists in the line under them, directly or indirectly.',
      '**Answer with** two columns, the mentor\'s person_id and the count, one row per mentor; any order.'],
    ref: 'with recursive under (top_id, person_id) as (\n    select mentor_id, mentee_id from mentor\n  union\n    select u.top_id, m.mentee_id from under u join mentor m on m.mentor_id = u.person_id\n)\nselect top_id, count(*) from under group by top_id',
    wrongs: ['with recursive under (top_id, person_id) as (select mentor_id, mentee_id from mentor union all select u.top_id, m.mentee_id from under u join mentor m on m.mentor_id = u.person_id) select top_id, count(*) from under group by top_id',
      'select mentor_id, count(*) from mentor group by mentor_id'],
    hints: ['Compute the closure of mentor as pairs (top of the line, someone under them).', 'The recursive step extends a pair by one more mentoring step.', 'With union the pairs are distinct, so count(*) per top_id is the answer; union all would count an artist reached by two paths twice.'] });

  ex({ id: 'adv-x-rec-all-sources', level: 3, title: 'Seen the whole back story',
    text: ['Take every production that PR138 is based on, directly or indirectly. For each patron who has booked a performance of at least one of them, say whether that patron has booked performances of all of them.',
      '**Answer with** two columns, patron_id and a boolean (true when the patron saw every one of those productions), one row per such patron; any order.'],
    ref: "with recursive src (prod_id) as (\n    select based_on from production where prod_id = 'PR138' and based_on is not null\n  union\n    select p.based_on from production p join src s on p.prod_id = s.prod_id where p.based_on is not null\n),\nseen (patron_id, prod_id) as (\n  select distinct b.patron_id, f.prod_id from booking b join performance f on f.perf_id = b.perf_id\n)\nselect distinct s.patron_id,\n       not exists (select prod_id from src except select prod_id from seen t where t.patron_id = s.patron_id)\nfrom seen s where s.prod_id in (select prod_id from src)",
    wrongs: ["with recursive src (prod_id) as (select based_on from production where prod_id = 'PR138' and based_on is not null union select p.based_on from production p join src s on p.prod_id = s.prod_id where p.based_on is not null) select b.patron_id, count(distinct f.prod_id) >= 2 from booking b join performance f on f.perf_id = b.perf_id where f.prod_id in (select prod_id from src) group by b.patron_id",
      "select b.patron_id, bool_and(p.based_on is not null) from booking b join performance f on f.perf_id = b.perf_id join production p on p.prod_id = f.prod_id where f.prod_id in (select based_on from production where prod_id = 'PR138') group by b.patron_id"],
    hints: ['First compute the full set of sources with a recursive with.', '"Saw all of them" is the "nothing is missing" test: the sources, except the productions the patron booked, must be empty.', 'not exists (select prod_id from src except select ... for this patron), computed for each patron who booked any source.'] });

  ex({ id: 'adv-x-rec-saturdays', level: 1, title: 'Counting with recursion',
    text: ['Without generate_series, list the eight Saturdays starting on 6 September 2025, using with recursive. (Adding an integer to a date adds that many days.)',
      '**Answer with** one column of type date, eight rows; any order.'],
    ref: "with recursive sat (d) as (\n    select date '2025-09-06'\n  union all\n    select d + 7 from sat where d < date '2025-09-06' + 49\n)\nselect d from sat",
    wrongs: ["with recursive sat (d) as (select date '2025-09-06' union all select d + 7 from sat where d <= date '2025-09-06' + 49) select d from sat",
      "with recursive sat (d) as (select date '2025-09-06' union all select d + 1 from sat where d < date '2025-09-06' + 7) select d from sat"],
    hints: ['The base query is the first Saturday.', 'The recursive query adds 7 days while the date is before the eighth Saturday.', "with recursive sat (d) as (select date '2025-09-06' union all select d + 7 from sat where d < date '2025-09-06' + 49) select d from sat"] });

  // window functions
  ex({ id: 'adv-x-win-avg', level: 1, title: 'Next to the company average',
    text: ['For every artist, give the person ID, the company ID, the fee, and the average fee of the artist\'s company rounded to two decimals. Use a window function, so every artist keeps a row. (Freelance artists form a partition of their own.)',
      '**Answer with** four columns: person_id, company_id, fee, company average; one row per artist; any order.'],
    ref: 'select person_id, company_id, fee, round(avg(fee) over (partition by company_id), 2) from artist',
    wrongs: ['select person_id, company_id, fee, round(avg(fee) over (), 2) from artist',
      'select a.person_id, a.company_id, a.fee, round((select avg(b.fee) from artist b where b.company_id = a.company_id), 2) from artist a'],
    hints: ['avg(...) over (partition by ...)', 'partition by company_id makes each company a window, and puts the nulls together.', 'select person_id, company_id, fee, round(avg(fee) over (partition by company_id), 2) from artist'] });

  ex({ id: 'adv-x-win-rank', level: 2, title: 'Rank within the company',
    text: ['For every artist who belongs to a company, give the company ID, the person ID, and the rank of the artist\'s fee within the company, highest fee first; equal fees share a rank, with a gap after them.',
      '**Answer with** three columns: company_id, person_id, rank; one row per company artist; any order.'],
    ref: 'select company_id, person_id, rank() over (partition by company_id order by fee desc) from artist where company_id is not null',
    ordered: false,
    wrongs: ['select company_id, person_id, row_number() over (partition by company_id order by fee desc, person_id) from artist where company_id is not null',
      'select company_id, person_id, rank() over (partition by company_id order by fee desc) from artist',
      'select company_id, person_id, rank() over (partition by company_id order by fee) from artist where company_id is not null'],
    hints: ['rank() gives ties the same number and leaves a gap.', 'partition by company_id, order by fee desc.', 'select company_id, person_id, rank() over (partition by company_id order by fee desc) from artist where company_id is not null'] });

  ex({ id: 'adv-x-win-top2', level: 2, title: 'The two dearest nights',
    text: ['For each production, list its two most expensive performances. If several performances tie for a place, include them all.',
      '**Answer with** three columns: prod_id, perf_id, price; any order.'],
    ref: 'select prod_id, perf_id, price from (\n  select prod_id, perf_id, price, rank() over (partition by prod_id order by price desc) as r\n  from performance\n) t where r <= 2',
    ordered: false,
    wrongs: ['select prod_id, perf_id, price from (select prod_id, perf_id, price, row_number() over (partition by prod_id order by price desc) as r from performance) t where r <= 2',
      'select prod_id, perf_id, price from (select prod_id, perf_id, price, rank() over (order by price desc) as r from performance) t where r <= 2',
      'select prod_id, perf_id, price from (select prod_id, perf_id, price, dense_rank() over (partition by prod_id order by price desc) as r from performance) t where r <= 2'],
    hints: ['Rank within each production in a subquery.', 'A window function cannot appear in where, so filter in the outer query.', 'rank() keeps ties together; row_number() would cut through them, and dense_rank() would let in a third price.'] });

  ex({ id: 'adv-x-win-running', level: 2, title: 'A running total of seats',
    text: ['For each performance of PR101, in date order, give the performance ID, the date, the seats booked for it, and the running total of seats booked over the performances so far. Leave out performances with no bookings.',
      '**Answer with** four columns: perf_id, perf_date, seats, running total; ordered by date, then perf_id.'],
    ref: "select f.perf_id, f.perf_date, sum(b.seats),\n       sum(sum(b.seats)) over (order by f.perf_date, f.perf_id)\nfrom performance f join booking b on b.perf_id = f.perf_id\nwhere f.prod_id = 'PR101'\ngroup by f.perf_id, f.perf_date\norder by f.perf_date, f.perf_id",
    wrongs: ["select f.perf_id, f.perf_date, sum(b.seats), sum(count(*)) over (order by f.perf_date, f.perf_id) from performance f join booking b on b.perf_id = f.perf_id where f.prod_id = 'PR101' group by f.perf_id, f.perf_date order by f.perf_date, f.perf_id",
      "select f.perf_id, f.perf_date, sum(b.seats), sum(sum(b.seats)) over () from performance f join booking b on b.perf_id = f.perf_id where f.prod_id = 'PR101' group by f.perf_id, f.perf_date order by f.perf_date, f.perf_id"],
    hints: ['Group the bookings by performance first.', 'sum(sum(b.seats)) over (order by ...) adds up the group totals cumulatively.', "Order the window and the result the same way: perf_date, then perf_id."] });

  ex({ id: 'adv-x-win-lag', level: 2, title: 'Month on month',
    text: ['For each month in which there were performances with bookings, give the month as text `YYYY-MM`, the number of bookings for performances in that month, and the change from the previous such month (null for the first).',
      '**Answer with** three columns: month, bookings, change; ordered by month.'],
    ref: 'select ' + MONTH + ', count(*), count(*) - lag(count(*)) over (order by ' + MONTH + ')\nfrom booking b join performance f on f.perf_id = b.perf_id\ngroup by ' + MONTH + '\norder by ' + MONTH,
    wrongs: ['select ' + MONTH + ', count(*), count(*) - lead(count(*)) over (order by ' + MONTH + ') from booking b join performance f on f.perf_id = b.perf_id group by ' + MONTH + ' order by ' + MONTH,
      'select ' + MONTH + ', sum(b.seats), sum(b.seats) - lag(sum(b.seats)) over (order by ' + MONTH + ') from booking b join performance f on f.perf_id = b.perf_id group by ' + MONTH + ' order by ' + MONTH],
    hints: ["to_char(f.perf_date, 'YYYY-MM') gives the month; group by it.", 'lag(x) over (order by month) is the previous month\'s value.', 'Subtract it from this month\'s count.'] });

  ex({ id: 'adv-x-win-share', level: 2, title: 'Share of the total',
    text: ['For every company, give its ID, its budget, and its share of the total budget of all companies as a percentage, rounded to one decimal place.',
      '**Answer with** three columns: company_id, budget, share; one row per company; any order.'],
    ref: 'select company_id, budget, round(budget * 100 / sum(budget) over (), 1) from company',
    wrongs: ['select company_id, budget, round(budget * 100 / sum(budget) over (partition by city), 1) from company',
      'select c.company_id, c.budget, round(c.budget * 100 / sum(c.budget) over (), 1) from company c where exists (select * from production p where p.company_id = c.company_id)'],
    hints: ['over () makes the whole result one window.', 'sum(budget) over () is the total, repeated on every row.', 'select company_id, budget, round(budget * 100 / sum(budget) over (), 1) from company'] });

  ex({ id: 'adv-x-win-moving', level: 3, title: 'A three-month average',
    text: ['For each month with performances, give the month as text `YYYY-MM`, the number of performances in it, and the average number of performances over that month and the two months with performances before it (fewer at the start), rounded to two decimals.',
      '**Answer with** three columns: month, performances, average; ordered by month.'],
    ref: 'select ' + MONTH + ', count(*), round(avg(count(*)) over (order by ' + MONTH + ' rows between 2 preceding and current row), 2)\nfrom performance f group by ' + MONTH + ' order by ' + MONTH,
    wrongs: ['select ' + MONTH + ', count(*), round(avg(count(*)) over (order by ' + MONTH + ' rows between 1 preceding and 1 following), 2) from performance f group by ' + MONTH + ' order by ' + MONTH,
      'select ' + MONTH + ', count(*), round(avg(count(*)) over (order by ' + MONTH + '), 2) from performance f group by ' + MONTH + ' order by ' + MONTH],
    hints: ['Group the performances by month first.', 'A frame of rows between 2 preceding and current row covers three months.', 'The aggregate inside the window is count(*), each month\'s count.'] });

  ex({ id: 'adv-x-win-next', level: 2, title: 'The next night',
    text: ['For every performance of a production by company C01, give the production ID, the performance date, and the date of the next performance of the same production (null for its last one).',
      '**Answer with** three columns: prod_id, perf_date, next date; ordered by prod_id, then perf_date.'],
    ref: "select f.prod_id, f.perf_date, lead(f.perf_date) over (partition by f.prod_id order by f.perf_date, f.perf_id)\nfrom performance f\nwhere f.prod_id in (select prod_id from production where company_id = 'C01')\norder by f.prod_id, f.perf_date",
    wrongs: ["select f.prod_id, f.perf_date, lead(f.perf_date) over (order by f.prod_id, f.perf_date) from performance f where f.prod_id in (select prod_id from production where company_id = 'C01') order by f.prod_id, f.perf_date",
      "select f.prod_id, f.perf_date, lag(f.perf_date) over (partition by f.prod_id order by f.perf_date) from performance f where f.prod_id in (select prod_id from production where company_id = 'C01') order by f.prod_id, f.perf_date"],
    hints: ['lead(x) is the value in the next row of the window.', 'Partition by production, so the last night of one show does not point to the first of the next.', "lead(f.perf_date) over (partition by f.prod_id order by f.perf_date)"] });

  ex({ id: 'adv-x-win-gap', level: 2, title: 'Cheaper than the dearest night',
    text: ['For every performance, give its ID, its production, its price, and how much cheaper it is than the most expensive performance of the same production (0 for the most expensive).',
      '**Answer with** four columns: perf_id, prod_id, price, difference; one row per performance; any order.'],
    ref: 'select perf_id, prod_id, price, max(price) over (partition by prod_id) - price from performance',
    wrongs: ['select perf_id, prod_id, price, max(price) over () - price from performance',
      'select perf_id, prod_id, price, price - min(price) over (partition by prod_id) from performance'],
    hints: ['max(price) over (partition by prod_id) is the dearest price of the production.', 'Subtract the performance\'s own price.', 'select perf_id, prod_id, price, max(price) over (partition by prod_id) - price from performance'] });

  ex({ id: 'adv-x-win-top-tenth', level: 3, title: 'The top tenth',
    text: ['List the patrons in the top 10 percent by loyalty points: those whose `cume_dist()`, ordering by points from most to fewest, is at most 0.1. Patrons with equal points are in or out together.',
      '**Answer with** three columns: patron_id, name, points; any order.'],
    ref: 'select patron_id, name, points from (\n  select patron_id, name, points, cume_dist() over (order by points desc) as cd from patron\n) t where cd <= 0.1',
    ordered: false,
    wrongs: ['select patron_id, name, points from (select patron_id, name, points, percent_rank() over (order by points desc) as pr from patron) t where pr <= 0.1',
      'select patron_id, name, points from (select patron_id, name, points, ntile(10) over (order by points desc) as q from patron) t where q = 1'],
    hints: ['cume_dist() counts ties together, so tied patrons are in or out together.', 'Compute it in a subquery.', 'Filter with cd <= 0.1 in the outer query.'] });

  // OLAP
  ex({ id: 'adv-x-rollup', level: 2, title: 'Subtotals with rollup',
    text: ['Count the productions by company and genre, with a subtotal for each company and a grand total, using rollup. (In the subtotal rows the rolled-up attributes are null.)',
      '**Answer with** three columns: company_id, genre, count; any order.'],
    ref: 'select company_id, genre, count(*) from production group by rollup (company_id, genre)',
    wrongs: ['select company_id, genre, count(*) from production group by cube (company_id, genre)',
      'select company_id, genre, count(*) from production group by rollup (genre, company_id)'],
    hints: ['group by rollup (a, b) computes (a, b), (a) and ().', 'Here a is company_id and b is genre.', 'select company_id, genre, count(*) from production group by rollup (company_id, genre)'] });

  ex({ id: 'adv-x-cube', level: 2, title: 'Every combination with cube',
    text: ['Count the performances by venue and start time with cube: every combination of totals.',
      '**Answer with** three columns: venue_code, start_time, count; any order.'],
    ref: 'select venue_code, start_time, count(*) from performance group by cube (venue_code, start_time)',
    wrongs: ['select venue_code, start_time, count(*) from performance group by rollup (venue_code, start_time)',
      'select venue_code, start_time, count(*) from performance group by grouping sets ((venue_code), (start_time), ())'],
    hints: ['cube computes all subsets of its attributes.', 'Two attributes give four groupings.', 'select venue_code, start_time, count(*) from performance group by cube (venue_code, start_time)'] });

  ex({ id: 'adv-x-gsets', level: 2, title: 'Chosen groupings',
    text: ['Give the seats booked per venue and, separately, per genre of production, with no detail rows and no grand total.',
      '**Answer with** three columns: venue_code, genre, seats; any order.'],
    ref: 'select f.venue_code, p.genre, sum(b.seats)\nfrom booking b join performance f on f.perf_id = b.perf_id join production p on p.prod_id = f.prod_id\ngroup by grouping sets ((f.venue_code), (p.genre))',
    wrongs: ['select f.venue_code, p.genre, sum(b.seats) from booking b join performance f on f.perf_id = b.perf_id join production p on p.prod_id = f.prod_id group by grouping sets ((f.venue_code), (p.genre), ())',
      'select f.venue_code, p.genre, count(*) from booking b join performance f on f.perf_id = b.perf_id join production p on p.prod_id = f.prod_id group by grouping sets ((f.venue_code), (p.genre))'],
    hints: ['grouping sets lists exactly the groupings you want.', 'Two groupings: (venue_code) and (genre).', 'Leave out () if you want no grand total.'] });

  ex({ id: 'adv-x-grouping', level: 3, title: 'Telling totals from nulls',
    text: ["Count the companies by year founded with rollup, and show the year as text: the year itself, `unknown` for companies whose founding year is not recorded, and `all companies` in the grand total row.",
      '**Answer with** two columns: that label and the count; any order.'],
    ref: "select case when grouping(founded) = 1 then 'all companies' else coalesce(founded::text, 'unknown') end, count(*)\nfrom company group by rollup (founded)",
    wrongs: ["select coalesce(founded::text, 'unknown'), count(*) from company group by rollup (founded)",
      "select coalesce(founded::text, 'all companies'), count(*) from company group by rollup (founded)"],
    hints: ['The total row and the unknown-year row both have a null founded.', 'grouping(founded) is 1 only in the total row.', "case when grouping(founded) = 1 then 'all companies' else coalesce(founded::text, 'unknown') end"] });

  ex({ id: 'adv-x-rollup-months', level: 2, title: 'Seats per year and month',
    text: ['Sum the seats booked by year and month of the performance, with a subtotal for each year and a grand total, using rollup. Take the year and month with `extract`.',
      '**Answer with** three columns: year, month, seats; any order.'],
    ref: 'select extract(year from f.perf_date), extract(month from f.perf_date), sum(b.seats)\nfrom booking b join performance f on f.perf_id = b.perf_id\ngroup by rollup (extract(year from f.perf_date), extract(month from f.perf_date))',
    wrongs: ['select extract(year from f.perf_date), extract(month from f.perf_date), sum(b.seats) from booking b join performance f on f.perf_id = b.perf_id group by rollup (extract(month from f.perf_date), extract(year from f.perf_date))',
      'select extract(year from f.perf_date), extract(month from f.perf_date), count(*) from booking b join performance f on f.perf_id = b.perf_id group by rollup (extract(year from f.perf_date), extract(month from f.perf_date))'],
    hints: ['rollup (year, month) rolls the month up first, then the year.', 'You may group by expressions.', 'group by rollup (extract(year from f.perf_date), extract(month from f.perf_date))'] });

  // ranking and ntile
  ex({ id: 'adv-x-dense', level: 1, title: 'Dense ranking',
    text: ['Rank the productions by running time, longest first, with no gaps after ties. Leave out productions whose running time is not recorded.',
      '**Answer with** three columns: prod_id, runtime_min, rank; any order.'],
    ref: 'select prod_id, runtime_min, dense_rank() over (order by runtime_min desc) from production where runtime_min is not null',
    ordered: false,
    wrongs: ['select prod_id, runtime_min, rank() over (order by runtime_min desc) from production where runtime_min is not null',
      'select prod_id, runtime_min, dense_rank() over (order by runtime_min desc) from production'],
    hints: ['dense_rank leaves no gaps.', 'order by runtime_min desc inside over; filter the nulls in where.', 'select prod_id, runtime_min, dense_rank() over (order by runtime_min desc) from production where runtime_min is not null'] });

  ex({ id: 'adv-x-rownum', level: 2, title: 'Numbering the nights of a run',
    text: ['For the productions PR101, PR105 and PR112, number the performances of each production in the order they were given: by date, then start time, then performance ID, 1 for the opening night.',
      '**Answer with** three columns: prod_id, perf_id, number; any order.'],
    ref: "select prod_id, perf_id,\n       row_number() over (partition by prod_id order by perf_date, start_time, perf_id)\nfrom performance\nwhere prod_id in ('PR101', 'PR105', 'PR112')",
    ordered: false,
    wrongs: ["select prod_id, perf_id, row_number() over (order by perf_date, start_time, perf_id) from performance where prod_id in ('PR101', 'PR105', 'PR112')",
      "select prod_id, perf_id, row_number() over (partition by prod_id order by perf_id desc) from performance where prod_id in ('PR101', 'PR105', 'PR112')",
      "select prod_id, perf_id, rank() over (partition by prod_id order by price) from performance where prod_id in ('PR101', 'PR105', 'PR112')"],
    hints: ['row_number() numbers the rows of each partition.', 'Partition by the production; order by date, start time and performance ID.', "select prod_id, perf_id, row_number() over (partition by prod_id order by perf_date, start_time, perf_id) from performance where prod_id in ('PR101', 'PR105', 'PR112')"] });

  ex({ id: 'adv-x-ntile', level: 2, title: 'Quartiles',
    text: ['Split the patrons into four quartiles by loyalty points, fewest points in quartile 1, breaking ties by patron ID.',
      '**Answer with** three columns: patron_id, points, quartile; any order.'],
    ref: 'select patron_id, points, ntile(4) over (order by points, patron_id) from patron',
    ordered: false,
    wrongs: ['select patron_id, points, ntile(4) over (order by points desc, patron_id) from patron',
      'select patron_id, points, ntile(4) over (order by points, patron_id desc) from patron'],
    hints: ['ntile(4) deals the rows into four buckets.', 'The order inside over decides the buckets.', 'Add patron_id to the order so ties are broken the same way every time.'] });

  ex({ id: 'adv-x-third', level: 3, title: 'The third-highest fee',
    text: ['List the artists whose fee is the third-highest distinct fee (if two artists share the top fee, the next fee down is the second-highest).',
      '**Answer with** two columns: person_id, fee; any order.'],
    ref: 'select person_id, fee from (\n  select person_id, fee, dense_rank() over (order by fee desc nulls last) as r from artist\n) t where r = 3',
    ordered: false,
    wrongs: ['select person_id, fee from (select person_id, fee, rank() over (order by fee desc nulls last) as r from artist) t where r = 3',
      'select person_id, fee from (select person_id, fee, dense_rank() over (order by fee desc) as r from artist) t where r = 3',
      'select person_id, fee from artist order by fee desc nulls last limit 1 offset 2'],
    hints: ['"Distinct fees" means ties count once: that is dense_rank.', 'A null fee sorts first in descending order unless you say nulls last.', 'Filter r = 3 in an outer query.'] });

  ex({ id: 'adv-x-fix-ties', level: 2, title: 'Fix: a cheapest three that drops a tie',
    text: fix('select person_id, fee from (\n  select person_id, fee, row_number() over (order by fee) as r\n  from artist\n) t where r <= 3;', 'to list the artists in the first three places by fee, cheapest first, with everyone tied at a place included').concat(['**Answer with** two columns: person_id, fee; any order.']),
    wrong: 'select person_id, fee from (select person_id, fee, row_number() over (order by fee) as r from artist) t where r <= 3',
    wrongs: ['select person_id, fee from (select person_id, fee, dense_rank() over (order by fee) as r from artist) t where r <= 3'],
    ref: 'select person_id, fee from (\n  select person_id, fee, rank() over (order by fee) as r\n  from artist\n) t where r <= 3',
    ordered: false,
    hints: ['Several artists share the lowest fee. How many rows should there be?', 'row_number gives tied rows different numbers; dense_rank would let in the next fee too.', 'rank gives tied rows the same number and skips after them: replace row_number with rank.'] });
})(typeof window !== 'undefined' ? window : globalThis);
