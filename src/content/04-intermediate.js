// Chapter 4: intermediate SQL. Join expressions, views, transactions, integrity constraints, data types and
// schemas, indexes and authorization.
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

  // three companies, two productions: the company that has staged nothing survives the left outer join with a null
  const outerFig = '<svg viewBox="0 0 580 136" width="580" role="img" aria-label="A left outer join pads the unmatched rows with nulls" style="max-width:100%;font:13px system-ui,sans-serif">' +
    '<g fill="none" stroke="currentColor" stroke-opacity=".5" data-audit="ignore">' +
    '<rect x="10" y="30" width="110" height="96"/><line x1="10" y1="54" x2="120" y2="54"/><line x1="10" y1="78" x2="120" y2="78"/><line x1="10" y1="102" x2="120" y2="102"/>' +
    '<rect x="150" y="30" width="170" height="72"/><line x1="150" y1="54" x2="320" y2="54"/><line x1="150" y1="78" x2="320" y2="78"/>' +
    '<rect x="360" y="30" width="210" height="96"/><line x1="360" y1="54" x2="570" y2="54"/><line x1="360" y1="78" x2="570" y2="78"/><line x1="360" y1="102" x2="570" y2="102"/><line x1="465" y1="30" x2="465" y2="126"/></g>' +
    '<g fill="currentColor"><text x="10" y="22" font-weight="600">company</text><text x="150" y="22" font-weight="600">production</text><text x="360" y="22" font-weight="600">company ⟕ production</text>' +
    '<text x="18" y="47">company_id</text><text x="18" y="71">C04</text><text x="18" y="95">C10</text><text x="18" y="119">C11</text>' +
    '<text x="158" y="47">prod_id, company_id</text><text x="158" y="71">PR108, C04</text><text x="158" y="95">PR133, C11</text>' +
    '<text x="368" y="47">company_id</text><text x="473" y="47">prod_id</text><text x="368" y="71">C04</text><text x="473" y="71">PR108</text><text x="368" y="95">C10</text><text x="368" y="119">C11</text><text x="473" y="119">PR133</text></g>' +
    '<rect x="466" y="79" width="103" height="22" fill="#e8a33d" fill-opacity=".3"/><text x="473" y="95" fill="currentColor" font-style="italic">null</text></svg>';

  lesson({
    id: 'int-joins', chapter: 4, title: 'Join expressions', minutes: 12,
    summary: 'NATURAL JOIN, JOIN ... USING and JOIN ... ON say in the from clause how relations fit together.',
    body: [
      'Chapter 3 joined relations by listing them in the from clause and putting the join condition in where. SQL also lets you write the join itself in the from clause, which keeps each condition next to the tables it connects.',
      { h: 'Natural join' },
      '`r natural join s` pairs the tuples that agree on all attributes with the same name, and keeps one copy of each such attribute. A production and the company that stages it share only `company_id`:',
      { sql: "select title, name as company, premiere\nfrom production natural join company\nwhere genre = 'opera'\norder by premiere;" },
      'The danger is the word *all*. Suppose you want every role in every production, with the production\'s title. `casting` leads to `artist` by person_id and to `production` by prod_id, so a chain of natural joins looks right:',
      { sql: 'select count(*) from casting;\nselect count(*) from casting natural join artist natural join production;' },
      { predict: { q: 'The second count is much smaller than the number of castings. Where did the other rows go?', options: ['artist and production both have company_id, so only artists cast by their own company survive', 'Roles with a null name are dropped', 'Natural join removes duplicate titles'], answer: 0, explain: 'The second natural join matches on prod_id *and* company_id, because both sides now have an attribute with that name. A guest from another company, and every freelance artist (whose company_id is null), is silently dropped. Nothing warns you.' }, sql: 'select count(*) from casting natural join artist join production using (prod_id);' },
      { h: 'join ... using' },
      '`join ... using (a1, a2, ...)` is a natural join on only the listed attributes. That is what the corrected count above did: the production was joined on `prod_id` alone. The leading roles of the musicals, with the person who plays each:',
      { sql: "select pe.given_name, pe.family_name, c.role_name, p.title\nfrom casting c join person pe using (person_id) join production p using (prod_id)\nwhere c.lead and p.genre = 'musical'\norder by p.title, c.role_name;" },
      { h: 'join ... on' },
      '`join ... on P` takes any predicate. Unlike `using`, it keeps both copies of the matched attributes, so you can match attributes with different names. `mentor` names two artists, `mentor_id` and `mentee_id`, and each must be looked up in `person` separately:',
      { sql: "select m.given_name || ' ' || m.family_name as mentor,\n       e.given_name || ' ' || e.family_name as mentee,\n       r.since\nfrom mentor r\n  join person m on m.person_id = r.mentor_id\n  join person e on e.person_id = r.mentee_id\norder by r.since;" },
      'For these joins, a condition in `on` means exactly the same as the same condition in `where`. These two return the same rows:',
      { sql: 'select p.title, f.perf_date, f.price from production p join performance f on f.prod_id = p.prod_id and f.price > 50;\nselect p.title, f.perf_date, f.price from production p join performance f on f.prod_id = p.prod_id where f.price > 50;' },
      'That stops being true for outer joins, in the next lesson.',
      { tip: 'The joins in this lesson are **inner joins**. You can write `inner join` instead of `join`; the word inner is optional.' },
    ],
  });

  lesson({
    id: 'int-outer', chapter: 4, title: 'Outer joins', minutes: 12,
    summary: 'An inner join drops the tuples that match nothing; an outer join keeps them and pads the missing side with nulls.',
    body: [
      'Some productions have never been performed: they are still in rehearsal, or not yet scheduled. An inner join of production with performance leaves them out, because there is nothing to pair them with:',
      { sql: 'select count(*) as productions,\n       (select count(distinct p.prod_id) from production p join performance f on f.prod_id = p.prod_id) as with_a_performance\nfrom production;' },
      'A **left outer join** keeps every tuple of the left relation. A left tuple with no match appears once, with nulls for the attributes of the right relation.',
      { svg: outerFig, caption: 'A left outer join of three companies with production: the company that has staged nothing survives, padded with null.' },
      { sql: 'select c.company_id, c.name, p.title\nfrom company c left outer join production p on p.company_id = c.company_id\norder by c.company_id, p.title;' },
      'The padded nulls are useful. The productions never performed are exactly the rows where the right side is null:',
      { sql: 'select p.prod_id, p.title, p.premiere\nfrom production p left outer join performance f on f.prod_id = p.prod_id\nwhere f.perf_id is null;' },
      { h: 'Right and full' },
      'A **right outer join** keeps every tuple of the right relation; `r right join s` is the same as `s left join r`. A **full outer join** keeps the unmatched tuples of both sides. Companies and artists make a good pair: some companies have no artists on their books, and some artists belong to no company.',
      { sql: 'select c.name as company, a.person_id as artist\nfrom company c full outer join artist a on a.company_id = c.company_id\nwhere c.company_id is null or a.person_id is null;', note: 'The companies with nobody (artist is null), and the freelance artists (company is null).' },
      { h: 'Counting with zeros' },
      'An outer join is the natural way to count things that may not exist. The number of productions of each company, including companies with none:',
      { sql: 'select c.name, count(p.prod_id) as productions\nfrom company c left join production p on p.company_id = c.company_id\ngroup by c.name\norder by productions, c.name;' },
      { predict: { q: 'Why `count(p.prod_id)` and not `count(*)`?', options: ['count(*) would count the padded row of a company with no productions as 1', 'count(*) does not work with group by', 'They are the same here'], answer: 0, explain: 'A company with no productions still produces one row in the outer join, with p.prod_id null. `count(*)` counts that row; `count(p.prod_id)` counts only non-null values, so it gives 0.' } },
      { h: 'on versus where' },
      'In an outer join, `on` decides which tuples match; `where` filters the result afterwards. That changes the answer. The opera productions with their performances in 2026, if any:',
      { sql: "select p.title, f.perf_date\nfrom production p left join performance f on f.prod_id = p.prod_id and f.perf_date >= date '2026-01-01'\nwhere p.genre = 'opera'\norder by p.title, f.perf_date;" },
      { predict: { q: 'Move `f.perf_date >= date \'2026-01-01\'` from on to where. What happens to an opera with no performance in 2026?', options: ['It disappears: its padded row has a null date, which fails the where test', 'It still appears once, padded with null', 'It appears once for every earlier performance'], answer: 0, explain: 'The padded row has f.perf_date null, and `null >= date \'2026-01-01\'` is unknown, so where removes it. The outer join has effectively become an inner join.' }, sql: "select p.title, f.perf_date\nfrom production p left join performance f on f.prod_id = p.prod_id\nwhere f.perf_date >= date '2026-01-01' and p.genre = 'opera'\norder by p.title, f.perf_date;" },
      { tip: '`natural left outer join` and `left outer join ... using (...)` also exist, and work as you would expect.' },
    ],
  });

  lesson({
    id: 'int-views', chapter: 4, title: 'Views', minutes: 14,
    summary: 'A view is a named query that behaves like a relation. Some views can be updated; a materialized view stores its result.',
    body: [
      'A **view** is a relation defined by a query. It stores no tuples of its own: whenever you use it, the database runs the query. Views hide data a user should not see, and give a name to a query you use often.',
      'An agency booking guest artists needs names and billing, but has no business knowing what anyone is paid:',
      { sql: 'drop view if exists artist_directory;\ncreate view artist_directory as\n  select a.person_id, p.given_name, p.family_name, a.billed_as, a.company_id\n  from artist a join person p using (person_id);\n\nselect * from artist_directory where company_id is null;' },
      'Fees are not in the view, so a user who may read only the view never sees one. A view can also summarize. The box-office takings of each production:',
      { sql: 'drop view if exists production_takings;\ncreate view production_takings (prod_id, bookings, seats_sold, takings) as\n  select f.prod_id, count(*), sum(b.seats), sum(b.paid)\n  from booking b join performance f on f.perf_id = b.perf_id\n  group by f.prod_id;\n\nselect * from production_takings order by takings desc limit 5;' },
      { predict: { q: 'Add 10 to what every patron paid for the first production\'s performances, then query production_takings again. Do its takings change?', options: ['Yes: the view is computed from booking each time it is used', 'No: the view kept the totals from when it was created', 'Only after the view is recreated'], answer: 0, explain: 'A view is its query, not a stored copy. Every use sees the current data.' }, sql: "begin;\nupdate booking set paid = paid + 10\nwhere perf_id in (select perf_id from performance where prod_id = (select min(prod_id) from performance));\nselect * from production_takings where prod_id = (select min(prod_id) from performance);\nrollback;" },
      { h: 'Materialized views' },
      'A **materialized view** does store its result, which makes it fast to read. The price is that it can go stale. PostgreSQL brings it up to date only when told, with `refresh materialized view`:',
      { sql: "drop materialized view if exists takings_mv;\ncreate materialized view takings_mv as\n  select f.prod_id, count(*) as bookings, sum(b.paid) as takings\n  from booking b join performance f on f.perf_id = b.perf_id group by f.prod_id;\n\nbegin;\nupdate booking set paid = paid + 10\nwhere perf_id in (select perf_id from performance where prod_id = (select min(prod_id) from performance));\nselect * from takings_mv where prod_id = (select min(prod_id) from performance);" },
      'The takings did not move. Refresh the view, and they do:',
      { sql: 'refresh materialized view takings_mv;\nselect * from takings_mv where prod_id = (select min(prod_id) from performance);\nrollback;' },
      { h: 'Updating through a view' },
      'Can you change data through a view? Only when the database can tell which base tuple to change. PostgreSQL allows it for a view over a single table, with no grouping, distinct, set operations or aggregates, whose columns are plain columns of that table. Lengthen every opera by an interval:',
      { sql: "drop view if exists opera_productions;\ncreate view opera_productions as\n  select prod_id, title, company_id, genre, runtime_min\n  from production\n  where genre = 'opera';\n\nbegin;\nupdate opera_productions set runtime_min = runtime_min + 15;\nselect title, runtime_min from production where genre = 'opera';\nrollback;" },
      'A view with an aggregate cannot be updated: which bookings would a new total belong to?',
      { sql: "insert into production_takings values ('PR999', 3, 6, 240);", fails: '55000' },
      { h: 'with check option' },
      'An insert through `opera_productions` could add a comedy, which then vanishes from the view it was added through. `with check option` forbids changes that would make a row fall outside the view:',
      { sql: "drop view if exists opera_checked;\ncreate view opera_checked as\n  select prod_id, title, company_id, genre\n  from production\n  where genre = 'opera'\nwith check option;" },
      { predict: { q: "What happens to `insert into opera_checked values ('PR900', 'Comic Turns', 'C01', 'comedy')`?", options: ['It fails: the new row would not satisfy the view\'s where clause', 'It succeeds, and the comedy appears in the view', 'It succeeds, but the comedy is invisible in the view'], answer: 0, explain: 'A comedy is outside the view. Without the check option the insert would succeed and the row would be invisible through the view; with it, the insert is rejected.' }, sql: "insert into opera_checked values ('PR900', 'Comic Turns', 'C01', 'comedy');", fails: '44000' },
      'Clean up the views of this lesson:',
      { sql: 'drop view artist_directory, production_takings, opera_productions, opera_checked;\ndrop materialized view takings_mv;' },
    ],
  });

  lesson({
    id: 'int-transactions', chapter: 4, title: 'Transactions', minutes: 12,
    summary: 'A transaction groups statements into one unit that either happens completely or not at all.',
    body: [
      'A patron trades 100 loyalty points for a free ticket. That takes two changes: take the points off the patron, and add a booking with nothing paid. If the system stopped between them, the patron would lose the points and get no seat. A **transaction** makes the two changes one unit: either both happen or neither does.',
      'In SQL a transaction starts with `begin` and ends with one of:',
      { list: ['`commit`: make the changes permanent and visible to others', '`rollback`: undo every change made since begin'] },
      'Without begin, each statement is a transaction of its own and commits by itself. This is called **autocommit**.',
      { sql: "begin;\nupdate patron set points = points - 100 where patron_id = 1;\ninsert into booking\n  select 5001, 1, min(perf_id), 1, 0.00, null\n  from performance\n  where perf_id not in (select perf_id from booking where patron_id = 1);\nselect points from patron where patron_id = 1;\nselect * from booking where booking_id = 5001;" },
      'Undo it:',
      { sql: 'rollback;\nselect points from patron where patron_id = 1;\nselect count(*) from booking where booking_id = 5001;' },
      { h: 'When a statement fails' },
      'If a statement inside a transaction fails, PostgreSQL marks the whole transaction as failed. Every later statement is refused until you end it.',
      { sql: 'begin;\nupdate patron set points = points - 100 where patron_id = 1;' },
      { sql: 'update patron set points = points - 1000000 where patron_id = 2;', fails: '23514', note: 'This violates the check that points are never negative.' },
      { predict: { q: 'Now run `select points from patron where patron_id = 1` in the same transaction. What happens?', options: ['An error: the transaction is aborted', 'It shows the reduced points', 'It shows the original points'], answer: 0, explain: 'After an error, the transaction can only be ended. Even a harmless select is refused, with "current transaction is aborted".' }, sql: 'select points from patron where patron_id = 1;', fails: '25P02' },
      { predict: { q: 'And what does `commit` do now?', options: ['It rolls back: a failed transaction cannot commit', 'It commits the first update', 'It reports an error and leaves the transaction open'], answer: 0, explain: 'Atomicity: the transaction failed, so none of it may take effect. PostgreSQL answers commit with ROLLBACK.' }, sql: 'commit;\nselect points from patron where patron_id = 1;' },
      { h: 'Savepoints' },
      'A **savepoint** marks a point inside a transaction that you can roll back to, without giving up the work before it.',
      { sql: 'begin;\nupdate patron set points = points - 100 where patron_id = 1;\nsavepoint after_points;\nupdate booking set paid = 0 where patron_id = 1;\nselect sum(paid) from booking where patron_id = 1;' },
      { sql: 'rollback to savepoint after_points;\nselect sum(paid) from booking where patron_id = 1;\nselect points from patron where patron_id = 1;\nrollback;' },
      'After `rollback to savepoint`, the bookings are back as they were and the points change remains, still uncommitted. The final rollback undoes that too.',
      { h: 'Other users' },
      'Until a transaction commits, other sessions do not see its changes. Try it: open a second tab with the + above the editor, run `begin` and an update in one tab, and query the same row in the other. The second tab sees the old value until the first commits. Chapter 17 explains the isolation levels that decide exactly what each side may see.',
      { tip: 'The status bar shows whether the current tab has a transaction open, and whether it has failed.' },
    ],
  });

  lesson({
    id: 'int-constraints', chapter: 4, title: 'Integrity constraints on a single relation', minutes: 12,
    summary: 'NOT NULL, UNIQUE and CHECK state conditions every tuple must satisfy; the database rejects any change that breaks one.',
    body: [
      'An **integrity constraint** is a condition that every legal instance of the database must satisfy. You declare it once, and the database checks every insert and update against it, so no program can forget.',
      'This lesson uses a scratch table of stops on a touring production: the town, the fee the host guarantees, a contact address, and the times of the load-in and of the curtain.',
      { sql: "drop table if exists tour_stop;\ncreate table tour_stop (\n  stop_code varchar(8) primary key,\n  town      varchar(30) not null,\n  guarantee numeric(8,2) check (guarantee > 0),\n  contact   varchar(40) unique,\n  load_in   time,\n  curtain   time,\n  constraint load_in_first check (load_in < curtain)\n);\n\ninsert into tour_stop values ('TS1', 'Wrenfield', 1800, 'barn@wrenfield.example', '14:00', '19:30');" },
      { h: 'not null' },
      '`not null` forbids the null value. A primary key implies not null for its attributes.',
      { sql: "insert into tour_stop values ('TS2', null, 2000, 'hall@oxlow.example', '13:00', '19:00');", fails: '23502' },
      { h: 'unique' },
      '`unique (A1, ..., An)` says no two tuples may agree on all of the listed attributes. The attributes form a candidate key, but unlike a primary key they may be null.',
      { sql: "insert into tour_stop values ('TS3', 'Oxlow', 2200, 'barn@wrenfield.example', '13:00', '19:00');", fails: '23505' },
      { predict: { q: 'Can two tour stops both have a null contact, given `contact` is unique?', options: ['Yes: two nulls are not considered equal by unique', 'No: that would be a duplicate', 'Only one tuple may have a null contact'], answer: 0, explain: 'A unique constraint is violated only when two tuples are equal on the attributes, and null = null is not true. So any number of tuples may have a null there.' }, sql: "insert into tour_stop values ('TS4', 'Fennick', 900, null, '15:00', '19:30');\ninsert into tour_stop values ('TS5', 'Halden', 1100, null, '15:00', '20:00');\nselect stop_code, contact from tour_stop;" },
      { h: 'check' },
      '`check (P)` requires every tuple to satisfy the predicate P. It may refer to several attributes of the tuple, like `load_in_first`. Giving a constraint a name, with `constraint name`, makes error messages clearer and lets you drop it later.',
      { sql: "insert into tour_stop values ('TS6', 'Oxlow', 2500, 'hall@oxlow.example', '20:00', '19:30');", fails: '23514' },
      { predict: { q: "Will `insert into tour_stop values ('TS7', 'Brack', null, 'yard@brack.example', null, '19:30')` be accepted?", options: ['Yes: the checks evaluate to unknown, and only false is rejected', 'No: the guarantee must be positive', 'No: the load-in time cannot be null'], answer: 0, explain: 'A check constraint rejects a tuple only if its predicate is false. `null > 0` and `null < time \'19:30\'` are unknown, not false, so the tuple passes. If nulls must be excluded, add not null as well.' }, sql: "insert into tour_stop values ('TS7', 'Brack', null, 'yard@brack.example', null, '19:30');\nselect * from tour_stop where stop_code = 'TS7';" },
      { h: 'Adding a constraint later' },
      '`alter table ... add constraint` adds a constraint to an existing table. The database first checks that every existing tuple satisfies it:',
      { sql: 'alter table tour_stop add constraint has_guarantee check (guarantee is not null);', fails: '23514', note: 'TS7 has no guarantee, so this fails.' },
      { sql: "delete from tour_stop where stop_code = 'TS7';\nalter table tour_stop add constraint has_guarantee check (guarantee is not null);\ndrop table tour_stop;" },
      { tip: 'The standard also describes **assertions**, constraints over the whole database (`create assertion`). Few systems implement them, PostgreSQL included; triggers, in chapter 5, do the same job.' },
    ],
  });

  lesson({
    id: 'int-fk', chapter: 4, title: 'Referential integrity and its actions', minutes: 15,
    summary: 'A foreign key keeps references valid. When a referenced tuple is deleted or its key changes, the constraint can refuse, cascade, set null or set a default.',
    body: [
      'A foreign key requires each value in the referencing attributes to appear as a key in the referenced relation. Inserting a dangling reference fails. The interesting question is what happens when the *referenced* tuple is deleted or its key is updated. The constraint can say, separately for `on delete` and `on update`:',
      { table: [['Action', 'What happens to the referencing tuples'], ['`no action` (the default)', 'the change is refused, at the end of the statement'], ['`restrict`', 'the change is refused, at once'], ['`cascade`', 'they are deleted too (on delete), or their reference is changed to the new key (on update)'], ['`set null`', 'their reference becomes null'], ['`set default`', 'their reference becomes the column default, which must itself exist']] },
      'The Theatre schema uses several of these. Deleting a venue deletes its stages (`on delete cascade`): a stage cannot exist without its building. Deleting a company sets its artists\' `company_id` to null (`on delete set null`): the artists stay, as freelancers. Deleting a production that has performances is refused (no action).',
      'Scratch tables to try each action: the costume store\'s racks, and the costumes hanging on them.',
      { sql: "drop table if exists costume;\ndrop table if exists rack;\ncreate table rack (\n  rack_code varchar(10) primary key,\n  label     varchar(30)\n);\ncreate table costume (\n  costume_id varchar(8) primary key,\n  rack_code  varchar(10) not null default 'STORE'\n             references rack on delete set default on update cascade\n);\ninsert into rack values ('STORE', 'Basement store'), ('R1', 'Gowns'), ('R2', 'Uniforms'), ('R3', 'Masks');\ninsert into costume values ('K01', 'R1'), ('K02', 'R1'), ('K03', 'R2'), ('K04', 'R3');" },
      { h: 'Refusing a dangling reference' },
      { sql: "insert into costume values ('K99', 'R9');", fails: '23503' },
      { h: 'on update cascade' },
      'The gowns rack gets a new code. The costumes follow:',
      { sql: "update rack set rack_code = 'GOWNS' where rack_code = 'R1';\nselect * from costume order by costume_id;" },
      { h: 'on delete set default' },
      { predict: { q: 'Delete the masks rack R3. What happens to costume K04?', options: ["Its rack_code becomes 'STORE', the column default", 'The costume is deleted', 'The delete is refused'], answer: 0, explain: 'The constraint says on delete set default. The default is STORE, and a STORE rack exists, so the reference stays valid.' }, sql: "delete from rack where rack_code = 'R3';\nselect * from costume order by costume_id;" },
      { h: 'cascade, set null and no action' },
      'Now replace the constraint with one that cascades deletes:',
      { sql: "alter table costume drop constraint costume_rack_code_fkey;\nalter table costume add constraint costume_rack_fk\n  foreign key (rack_code) references rack on delete cascade;\ndelete from rack where rack_code = 'R2';\nselect * from costume order by costume_id;" },
      'The uniform went with its rack. `set null` works the same way but sets the reference to null; it cannot be used here, because rack_code is declared not null.',
      'With `no action`, the default, deleting a rack that still holds costumes is refused:',
      { sql: 'alter table costume drop constraint costume_rack_fk;\nalter table costume add constraint costume_rack_fk\n  foreign key (rack_code) references rack;' },
      { sql: "delete from rack where rack_code = 'STORE';", fails: '23503' },
      { h: 'Deferring the check' },
      'Sometimes two tuples must refer to each other, and whichever you insert first refers to something that does not exist yet. Two leading roles that understudy each other are like that. Declaring the constraint `deferrable initially deferred` moves the check to commit time:',
      { sql: "drop table if exists cover;\ncreate table cover (\n  role_code  varchar(8) primary key,\n  covered_by varchar(8) references cover (role_code) deferrable initially deferred\n);\nbegin;\ninsert into cover values ('HERO', 'RIVAL');\ninsert into cover values ('RIVAL', 'HERO');\ncommit;\nselect * from cover;" },
      'Inside the transaction the first insert broke the constraint for a moment; by commit everything was consistent, so it was accepted. A transaction that is still inconsistent at commit is rolled back:',
      { sql: "begin;\ninsert into cover values ('MAID', 'NOBODY');" },
      { sql: 'commit;', fails: '23503' },
      { sql: 'drop table cover;\ndrop table costume;\ndrop table rack;' },
    ],
  });

  lesson({
    id: 'int-types', chapter: 4, title: 'Data types, defaults and schemas', minutes: 14,
    summary: 'Dates, times and intervals; default values; large objects; types and domains of your own; and schemas that group tables.',
    body: [
      { h: 'Dates and times' },
      { table: [['Type', 'Example'], ['`date`', "`date '2025-03-14'`"], ['`time`', "`time '19:30:00'`"], ['`timestamp`', "`timestamp '2025-03-14 19:30:00'`"], ['`interval`', "`interval '2 hours 25 minutes'`"]] },
      'Subtracting two dates gives a number of days; adding an interval to a timestamp gives a timestamp. `extract` takes a field out of a value.',
      { sql: "select date '2025-06-30' - date '2024-09-01' as days_in_season,\n       timestamp '2025-03-14 19:30' + interval '145 minutes' as curtain_down,\n       extract(dow from date '2025-03-14') as weekday,\n       current_date > date '2024-09-01' as season_started;" },
      { predict: { q: "What is `date '2025-02-28' + 1`?", options: ['2025-03-01, since 2025 is not a leap year', '2025-02-29', 'An error: you cannot add a number to a date'], answer: 0, explain: 'Adding an integer to a date adds days, and the calendar arithmetic knows which years are leap years.' }, sql: "select date '2025-02-28' + 1 as next_day, date '2024-02-28' + 1 as in_a_leap_year;" },
      'Arithmetic works on the stored data too. An interval can be multiplied by a number, so the minutes of a production\'s running time turn into the time the curtain comes down:',
      { sql: "select f.perf_id, p.title, f.start_time,\n       f.start_time + p.runtime_min * interval '1 minute' as ends\nfrom performance f join production p using (prod_id)\nwhere f.perf_date = (select min(perf_date) from performance);" },
      { h: 'Default values' },
      'A column can have a default, used when an insert does not give a value:',
      { sql: "drop table if exists rehearsal;\ncreate table rehearsal (\n  prod_id varchar(6) references production,\n  day     date default current_date,\n  starts  time default time '10:00',\n  length  interval default interval '3 hours',\n  primary key (prod_id, day)\n);\ninsert into rehearsal (prod_id) values ('PR101');\ninsert into rehearsal values ('PR102', date '2025-08-20', time '13:30', interval '150 minutes');\nselect prod_id, starts, length, starts + length as ends from rehearsal;" },
      { h: 'Large objects' },
      'The standard has `clob` and `blob` for large character and binary data. PostgreSQL uses `text`, which holds strings of any length, and `bytea` for bytes. A whole script or a scanned poster is a large value; it is usually kept outside the main record, and a program fetches it separately.',
      { sql: "select octet_length(repeat('Act one, scene one. ', 500)) as bytes, 'Curtain'::bytea as raw;" },
      { h: 'Types and domains of your own' },
      '`create type` defines a new type. An enumerated type lists its values in order, here the parts of an auditorium from the top down:',
      { sql: "drop table if exists seat_request;\ndrop type if exists seat_zone;\ncreate type seat_zone as enum ('gallery', 'circle', 'stalls', 'box');\ncreate table seat_request (perf_id integer references performance, zone seat_zone);\ninsert into seat_request values (1, 'stalls'), (1, 'box'), (2, 'gallery');\nselect * from seat_request where zone >= 'stalls';" },
      { predict: { q: "What does `insert into seat_request values (1, 'balcony')` do?", options: ['It fails: balcony is not a value of the type', "It stores 'balcony' as a new zone", 'It stores null'], answer: 0, explain: 'An enum accepts only the values in its definition.' }, sql: "insert into seat_request values (1, 'balcony');", fails: '22P02' },
      'A **domain** is a base type with constraints attached, reusable in many tables:',
      { sql: "drop table if exists voucher;\ndrop domain if exists ticket_price;\ncreate domain ticket_price as numeric(6,2) check (value >= 0);\ncreate table voucher (code varchar(10), worth ticket_price);\ninsert into voucher values ('GIFT25', 25.00);\nselect * from voucher;" },
      { sql: "insert into voucher values ('OOPS', -5);", fails: '23514' },
      { h: 'Schemas' },
      'A database holds **schemas**, and each schema holds tables, views and types. Two tables may share a name if they are in different schemas. The Theatre tables live in the schema `public`. A name is looked up along the `search_path`:',
      { sql: "drop schema if exists archive cascade;\ncreate schema archive;\ncreate table archive.performance as select * from performance where perf_date < date '2025-07-01';\nselect count(*) from archive.performance;\nselect count(*) from public.performance;" },
      { sql: 'show search_path;\nset search_path = archive, public;\nselect count(*) from performance;\nreset search_path;' },
      'With `archive` first on the path, the unqualified name `performance` meant `archive.performance`, the first season only. Clean up:',
      { sql: 'drop schema archive cascade;\ndrop table rehearsal, seat_request, voucher;\ndrop type seat_zone;\ndrop domain ticket_price;' },
    ],
  });

  lesson({
    id: 'int-indexes', chapter: 4, title: 'Index definition', minutes: 12,
    summary: 'CREATE INDEX builds a structure that finds tuples by an attribute without reading the whole table. Watch the plan change.',
    body: [
      'An **index** on an attribute lets the database find the tuples with a given value without scanning the relation. It changes nothing about the answers, only the cost of finding them: physical data independence again.',
      'The Theatre tables are too small for an index to matter. Make a bigger one: 20,000 ticket scans at the doors, each with the patron, the gate and the day.',
      { sql: "drop table if exists ticket_scan;\ncreate table ticket_scan (\n  scan_id   int primary key,\n  patron_id int,\n  gate      varchar(4),\n  scanned   date\n);\ninsert into ticket_scan\n  select g,\n         g * 7919 % 5000 + 1,\n         'G' || (g % 6 + 1),\n         date '2025-01-01' + (g % 300)\n  from generate_series(1, 20000) as g;\nanalyze ticket_scan;", note: '`generate_series(1, 20000)` produces the numbers 1 to 20000; the arithmetic turns each into a patron, a gate and a day.' },
      'Look up one patron\'s scans. With no index on patron_id, the only way is to read every page:',
      { sql: 'explain analyze\nselect * from ticket_scan where patron_id = 4242;' },
      { view: 'plan', label: 'See the plan' },
      'Now create an index on `patron_id`, refresh the statistics, and ask again:',
      { sql: 'create index ticket_scan_patron on ticket_scan (patron_id);\nanalyze ticket_scan;\nexplain analyze\nselect * from ticket_scan where patron_id = 4242;' },
      'The plan is now an **Index Scan**, and the page reads drop from hundreds to a handful.',
      { predict: { q: 'Will the planner use the index for `where patron_id >= 1`, which matches every scan?', options: ['No: reading the whole table in order is cheaper than following the index to every tuple', 'Yes: an index is always faster', 'Only if the index is unique'], answer: 0, explain: 'An index pays off when it leads to few tuples. To fetch nearly all of them, jumping from the index to each tuple\'s page costs more than one sequential pass. The planner compares estimated costs and chooses the sequential scan.' }, sql: 'explain\nselect count(*) from ticket_scan where patron_id >= 1;' },
      { h: 'Forcing the choice' },
      'You can tell the planner to avoid sequential scans when it can, which is handy for seeing an index used on a small table:',
      { sql: "set enable_seqscan = off;\nexplain select * from production where prod_id = 'PR101';\nreset enable_seqscan;" },
      'The index used there is `production_pkey`: declaring a primary key or a unique constraint creates an index automatically, which the database needs to check uniqueness quickly.',
      { h: 'Unique indexes and dropping' },
      '`create unique index` both speeds up lookups and enforces uniqueness. `drop index` removes an index; queries keep working, just more slowly.',
      { sql: 'create unique index ticket_scan_day on ticket_scan (scanned);', fails: '23505', note: 'Many scans fall on the same day, so an index on the day cannot be unique.' },
      { sql: 'drop index ticket_scan_patron;\ndrop table ticket_scan;' },
      { tip: 'Indexes are not free: every insert, update and delete must also change each index on the table. Chapter 14 opens up the B+-tree inside.' },
    ],
  });

  lesson({
    id: 'int-auth', chapter: 4, title: 'Authorization', minutes: 14,
    summary: 'Privileges say who may read or change what. GRANT gives them, REVOKE takes them back, and roles group them.',
    body: [
      'Each user of a database holds **privileges** on its objects: `select`, `insert`, `update` and `delete` on a relation, among others. The creator of a relation holds all privileges on it, and can pass them on.',
      'Kwery lets you create users (called **roles**) and act as one with `set role`. First, a role for Ana, who works at the box office. She may read patrons and bookings, and change the number of seats on a booking, nothing else:',
      { sql: 'drop role if exists usher_ana;\ncreate role usher_ana;\ngrant select on patron, booking to usher_ana;\ngrant update (seats) on booking to usher_ana;' },
      '`grant update (seats)` gives the update privilege on one attribute only. Now act as usher_ana:',
      { sql: 'set role usher_ana;\nselect current_user;\nselect count(*) from booking where rating is null;' },
      { predict: { q: 'Still acting as usher_ana, what happens with `select billed_as, fee from artist`?', options: ['Permission denied: usher_ana has no privilege on artist', 'It works: select on one table allows select on all', 'It returns only the columns usher_ana may see'], answer: 0, explain: 'Privileges are per relation. usher_ana was granted select on patron and booking only.' }, sql: 'select billed_as, fee from artist;', fails: '42501' },
      'Go back to being yourself:',
      { sql: 'set role none;\nselect current_user;' },
      { h: 'Roles' },
      'Granting privileges person by person gets out of hand. A **role** collects privileges; granting the role to a user gives them all. Roles can be granted to other roles too.',
      { sql: 'drop role if exists usher_ben;\ndrop role if exists box_office;\ncreate role box_office;\ngrant select on patron, booking, performance, production to box_office;\ncreate role usher_ben;\ngrant box_office to usher_ben;\nset role usher_ben;\nselect count(*) from performance where perf_date >= date \'2026-01-01\';\nset role none;' },
      { h: 'Views and authorization' },
      'A view can give access to exactly part of a relation. A casting agent looking for freelancers may see who they are, but not their fees or birth dates:',
      { sql: 'drop view if exists freelance_list;\ncreate view freelance_list as\n  select a.person_id, p.given_name, p.family_name, a.billed_as\n  from artist a join person p using (person_id)\n  where a.company_id is null;\ndrop role if exists casting_agent;\ncreate role casting_agent;\ngrant select on freelance_list to casting_agent;' },
      'casting_agent holds a privilege on the view and none on `artist` or `person`. A view runs with the privileges of its owner, so casting_agent can read the view:',
      { sql: 'set role casting_agent;\nselect * from freelance_list;' },
      'but a query on `artist` itself is refused:',
      { sql: 'select count(*) from artist;', fails: '42501' },
      { sql: 'set role none;' },
      { h: 'Passing privileges on' },
      'A privilege granted `with grant option` may be granted further by its holder. The grants form a graph from the owner outwards. Revoking a privilege with `cascade` also revokes the grants that depended on it; with `restrict`, the revoke fails if there are any.',
      { sql: 'drop role if exists artistic_director;\ncreate role artistic_director;\ngrant select on company to artistic_director with grant option;\nset role artistic_director;\ngrant select on company to usher_ana;\nset role none;\nset role usher_ana;\nselect count(*) from company;\nset role none;' },
      '`revoke` takes a privilege back:',
      { sql: 'revoke select on company from usher_ana;\nset role usher_ana;' },
      { sql: 'select count(*) from company;', fails: '42501' },
      'Clean up the roles and the view:',
      { sql: 'set role none;\ndrop owned by usher_ana, usher_ben, box_office, casting_agent, artistic_director;\ndrop view freelance_list;\ndrop role usher_ana, usher_ben, box_office, casting_agent, artistic_director;' },
    ],
  });

  // ---- exercises ----------------------------------------------------------------------------------------------------------
  const ex = (x) => C.exercise(Object.assign({ chapter: 4 }, x));
  const fix = (wrong, why) => ['A classmate wrote this query' + (why ? ' ' + why : '') + ':', { sql: wrong, run: false }, 'It does not do what was asked. Write a query that does.'];

  // join expressions
  ex({ id: 'int-x-natural-company', level: 1, title: 'Natural join',
    text: ['Using `natural join`, list the title of every production together with the name of the company that stages it.', '**Answer with** two columns, the title and the company name; one row per production; in any order.'],
    ref: 'select title, name from production natural join company',
    alts: ['select p.title, c.name from production p join company c on c.company_id = p.company_id'],
    wrongs: ['select title, name from production, company', 'select title, name from production natural join company where premiere is not null'],
    hints: ['production and company share exactly one attribute name.', 'natural join matches on company_id.', 'select title, name from production natural join company'] });

  ex({ id: 'int-x-using-march', level: 1, title: 'Join with using',
    text: ['List the date and the production title of every performance in March 2025. Use `join ... using`.', '**Answer with** two columns, the performance date and the title; one row per performance; in any order.'],
    ref: "select f.perf_date, p.title\nfrom performance f join production p using (prod_id)\nwhere f.perf_date between date '2025-03-01' and date '2025-03-31'",
    wrongs: ["select f.perf_date, p.title from performance f join production p using (prod_id) where extract(month from f.perf_date) = 3", "select f.perf_date, p.title from performance f join production p using (prod_id) where f.perf_date >= date '2025-03-01'"],
    hints: ['performance and production share prod_id.', 'join production p using (prod_id)', "select f.perf_date, p.title from performance f join production p using (prod_id) where f.perf_date between date '2025-03-01' and date '2025-03-31'"] });

  ex({ id: 'int-x-on-mentor', level: 1, title: 'Join with on',
    text: ['For every mentoring pair, give the full name of the mentor and the full name of the mentee, each written as the given name, a space and the family name. Use `join ... on`.', '**Answer with** two columns, the mentor\'s name and the mentee\'s name; one row per row of mentor; in any order.'],
    ref: "select m.given_name || ' ' || m.family_name, e.given_name || ' ' || e.family_name\nfrom mentor r\n  join person m on m.person_id = r.mentor_id\n  join person e on e.person_id = r.mentee_id",
    wrongs: ["select m.given_name || ' ' || m.family_name, e.given_name || ' ' || e.family_name from mentor r join person m on m.person_id = r.mentee_id join person e on e.person_id = r.mentor_id", "select m.given_name || ' ' || m.family_name, m.given_name || ' ' || m.family_name from mentor r join person m on m.person_id = r.mentor_id"],
    hints: ['mentor_id and mentee_id both refer to people, so person is needed twice.', 'Give the two copies of person different names, such as m and e.', "select m.given_name || ' ' || m.family_name, e.given_name || ' ' || e.family_name from mentor r join person m on m.person_id = r.mentor_id join person e on e.person_id = r.mentee_id"] });

  ex({ id: 'int-x-fix-natural-cast', level: 2, title: 'Fix: a natural join too many',
    text: fix('select role_name, title\nfrom casting natural join artist natural join production;', 'to list every role in every production with the production\'s title').concat(['**Answer with** two columns, the role name and the title; one row per row of casting; in any order.']),
    wrong: 'select role_name, title from casting natural join artist natural join production',
    ref: 'select c.role_name, p.title\nfrom casting c join production p on p.prod_id = c.prod_id',
    alts: ['select role_name, title from casting join production using (prod_id)'],
    hints: ['Which attributes do artist and production have in common?', 'The natural join also matches company_id, so guest and freelance artists vanish. And artist is not needed at all.', 'select c.role_name, p.title from casting c join production p on p.prod_id = c.prod_id'] });

  ex({ id: 'int-x-fix-seats', level: 2, title: 'Fix: two meanings of seats',
    text: fix('select booking_id, seats\nfrom booking natural join performance natural join stage;', 'to list every booking with the number of seats booked and the number of seats of the stage the performance is on').concat(['**Answer with** three columns, the booking ID, the seats booked and the seats of the stage; one row per booking; in any order.']),
    wrong: 'select booking_id, seats from booking natural join performance natural join stage',
    ref: 'select b.booking_id, b.seats, s.seats\nfrom booking b\n  join performance f on f.perf_id = b.perf_id\n  join stage s on s.venue_code = f.venue_code and s.stage_no = f.stage_no',
    alts: ['select b.booking_id, b.seats, s.seats from booking b join performance f using (perf_id) join stage s using (venue_code, stage_no)'],
    wrongs: ['select b.booking_id, b.seats, s.seats from booking b join performance f on f.perf_id = b.perf_id join stage s on s.venue_code = f.venue_code'],
    hints: ['Run it: why are there no rows?', 'booking and stage both have an attribute called seats, so the natural join demands that they be equal.', 'select b.booking_id, b.seats, s.seats from booking b join performance f on f.perf_id = b.perf_id join stage s on s.venue_code = f.venue_code and s.stage_no = f.stage_no'] });

  ex({ id: 'int-x-guest-artists', level: 2, title: 'Guest artists',
    text: ['Find the artists who belong to a company and were cast in a production staged by a different company. Give each such artist and production once.', '**Answer with** four columns: the artist\'s person ID, the artist\'s company ID, the producing company\'s ID and the production title; one row per artist and production; in any order.'],
    ref: 'select distinct a.person_id, a.company_id, p.company_id, p.title\nfrom casting c\n  join artist a on a.person_id = c.person_id\n  join production p on p.prod_id = c.prod_id\nwhere a.company_id <> p.company_id',
    wrongs: ['select distinct a.person_id, a.company_id, p.company_id, p.title from casting c join artist a on a.person_id = c.person_id join production p on p.prod_id = c.prod_id where a.company_id is distinct from p.company_id', 'select distinct a.person_id, a.company_id, p.company_id, p.title from casting c join artist a on a.person_id = c.person_id join production p on p.prod_id = c.prod_id where a.company_id <> p.company_id or a.company_id is null'],
    hints: ['Join casting with artist and with production, each on its own key.', 'Compare the two company IDs. A freelancer\'s null company makes the comparison unknown, which leaves them out by itself.', 'An artist may play two roles in one production: use distinct.'] });

  ex({ id: 'int-x-close-premieres', level: 3, title: 'Premieres close together',
    text: ['Find the pairs of productions of the same company whose premieres are at most 30 days apart, in either order. Give each pair once, with the smaller production ID first.', '**Answer with** two columns, the smaller and the larger production ID; in any order.'],
    ref: 'select a.prod_id, b.prod_id\nfrom production a join production b on a.company_id = b.company_id and a.prod_id < b.prod_id\nwhere abs(a.premiere - b.premiere) <= 30',
    wrongs: ['select a.prod_id, b.prod_id from production a join production b on a.company_id = b.company_id and a.prod_id <> b.prod_id where abs(a.premiere - b.premiere) <= 30', 'select a.prod_id, b.prod_id from production a join production b on a.company_id = b.company_id and a.prod_id < b.prod_id where abs(extract(month from a.premiere) - extract(month from b.premiere)) <= 1'],
    hints: ['Join production with itself on the company.', 'Subtracting two dates gives days; abs() makes the order of the premieres irrelevant.', 'select a.prod_id, b.prod_id from production a join production b on a.company_id = b.company_id and a.prod_id < b.prod_id where abs(a.premiere - b.premiere) <= 30'] });

  ex({ id: 'int-x-venue-titles', level: 2, title: 'What played where',
    text: ['List the distinct pairs (venue name, production title) such that the production was performed at that venue in the season that runs from September 2025 to June 2026.', '**Answer with** two columns, the venue name and the title; each pair once; in any order.'],
    ref: "select distinct v.venue_name, p.title\nfrom performance f\n  join venue v on v.venue_code = f.venue_code\n  join production p on p.prod_id = f.prod_id\nwhere f.perf_date between date '2025-09-01' and date '2026-06-30'",
    wrongs: ["select v.venue_name, p.title from performance f join venue v on v.venue_code = f.venue_code join production p on p.prod_id = f.prod_id where f.perf_date between date '2025-09-01' and date '2026-06-30'", "select distinct v.venue_name, p.title from performance f join venue v on v.venue_code = f.venue_code join production p on p.prod_id = f.prod_id where extract(year from f.perf_date) = 2025"],
    hints: ['performance links a production to a venue.', 'The season is a date range across two calendar years.', 'Use distinct: a production plays many nights at one venue.'] });

  ex({ id: 'int-x-local-patrons', level: 2, title: 'Patrons and their shows',
    text: ['For the patrons who live in Saltreach, list the distinct pairs (patron ID, production title) of productions they have booked.', '**Answer with** two columns, the patron ID and the title; each pair once; in any order.'],
    ref: "select distinct pa.patron_id, p.title\nfrom patron pa\n  join booking b on b.patron_id = pa.patron_id\n  join performance f on f.perf_id = b.perf_id\n  join production p on p.prod_id = f.prod_id\nwhere pa.city = 'Saltreach'",
    wrongs: ["select pa.patron_id, p.title from patron pa join booking b on b.patron_id = pa.patron_id join performance f on f.perf_id = b.perf_id join production p on p.prod_id = f.prod_id where pa.city = 'Saltreach'", "select distinct pa.patron_id, p.title from patron pa join booking b on b.patron_id = pa.patron_id join performance f on f.perf_id = b.perf_id join production p on p.prod_id = f.prod_id join venue v on v.venue_code = f.venue_code where v.city = 'Saltreach'"],
    hints: ['Four relations: patron, booking, performance and production.', 'The city is the patron\'s, not the venue\'s.', 'Use distinct: a patron may book two performances of one production.'] });

  // outer joins
  ex({ id: 'int-x-left-never', level: 1, title: 'Never performed, with an outer join',
    text: ['Using a left outer join, list every production that has never been performed.', '**Answer with** two columns, the production ID and the title; in any order.'],
    ref: 'select p.prod_id, p.title from production p left join performance f on f.prod_id = p.prod_id where f.perf_id is null',
    alts: ['select prod_id, title from production p where not exists (select * from performance f where f.prod_id = p.prod_id)'],
    wrongs: ['select p.prod_id, p.title from production p join performance f on f.prod_id = p.prod_id where f.perf_id is null', 'select prod_id, title from production where premiere is null'],
    hints: ['A left outer join keeps productions without performances, padded with nulls.', 'Those rows have a null in every performance attribute.', 'select p.prod_id, p.title from production p left join performance f on f.prod_id = p.prod_id where f.perf_id is null'] });

  ex({ id: 'int-x-perfs-2026', level: 2, title: 'Performances per production, with zeros',
    text: ['For every production, give the number of its performances in 2026 (0 if it has none).', '**Answer with** two columns, the production ID and the count; one row per production; in any order.'],
    ref: "select p.prod_id, count(f.perf_id)\nfrom production p left join performance f on f.prod_id = p.prod_id and f.perf_date >= date '2026-01-01'\ngroup by p.prod_id",
    wrongs: ["select p.prod_id, count(f.perf_id) from production p left join performance f on f.prod_id = p.prod_id where f.perf_date >= date '2026-01-01' group by p.prod_id", "select p.prod_id, count(*) from production p left join performance f on f.prod_id = p.prod_id and f.perf_date >= date '2026-01-01' group by p.prod_id"],
    hints: ['Start from production and keep every production with a left join.', 'Put the date condition in on, not in where.', 'count(f.perf_id) counts only real performances, so a padded row gives 0.'] });

  ex({ id: 'int-x-company-artists', level: 2, title: 'Artists per company, with zeros',
    text: ['Using an outer join, give every company\'s ID and its number of artists (0 if none).', '**Answer with** two columns, the company ID and the count; one row per company; in any order.'],
    ref: 'select c.company_id, count(a.person_id)\nfrom company c left join artist a on a.company_id = c.company_id\ngroup by c.company_id',
    wrongs: ['select c.company_id, count(*) from company c left join artist a on a.company_id = c.company_id group by c.company_id', 'select company_id, count(*) from artist group by company_id'],
    hints: ['Start from company.', 'Left join artist on company_id.', 'Count a.person_id, not *.'] });

  ex({ id: 'int-x-fix-outer-where', level: 2, title: 'Fix: an outer join that turned inner',
    text: fix("select c.company_id, count(p.prod_id)\nfrom company c left join production p on p.company_id = c.company_id\nwhere p.genre = 'drama'\ngroup by c.company_id;", 'to list every company with its number of dramas, showing 0 for companies with none').concat(['**Answer with** two columns, the company ID and the count; one row per company; in any order.']),
    wrong: "select c.company_id, count(p.prod_id) from company c left join production p on p.company_id = c.company_id where p.genre = 'drama' group by c.company_id",
    ref: "select c.company_id, count(p.prod_id)\nfrom company c left join production p on p.company_id = c.company_id and p.genre = 'drama'\ngroup by c.company_id",
    wrongs: ["select c.company_id, count(*) from company c left join production p on p.company_id = c.company_id and p.genre = 'drama' group by c.company_id"],
    hints: ['Which rows does the where clause remove?', 'The padded rows, and the rows of other genres, fail p.genre = \'drama\'.', 'Move the genre condition into the on clause.'] });

  ex({ id: 'int-x-fix-count-star', level: 2, title: 'Fix: counting padded rows',
    text: fix('select pa.patron_id, count(*)\nfrom patron pa left join booking b on b.patron_id = pa.patron_id\ngroup by pa.patron_id;', 'to count the bookings of every patron, showing 0 for a patron who has never booked').concat(['**Answer with** two columns, the patron ID and the count; one row per patron; in any order.']),
    wrong: 'select pa.patron_id, count(*) from patron pa left join booking b on b.patron_id = pa.patron_id group by pa.patron_id',
    ref: 'select pa.patron_id, count(b.booking_id)\nfrom patron pa left join booking b on b.patron_id = pa.patron_id\ngroup by pa.patron_id',
    wrongs: ['select patron_id, count(*) from booking group by patron_id'],
    hints: ['What does a patron with no bookings get?', 'Its one padded row is counted by count(*).', 'Count a column of booking instead: count(b.booking_id).'] });

  ex({ id: 'int-x-never-rated', level: 1, title: 'Never rated anything',
    text: ['Using an outer join, list the patrons who have never given a rating (they may have booked, but every booking is unrated, or they have no bookings at all).', '**Answer with** two columns, the patron ID and the name; in any order.'],
    ref: 'select pa.patron_id, pa.name\nfrom patron pa left join booking b on b.patron_id = pa.patron_id and b.rating is not null\nwhere b.booking_id is null',
    alts: ['select patron_id, name from patron pa where not exists (select * from booking b where b.patron_id = pa.patron_id and b.rating is not null)'],
    wrongs: ['select distinct pa.patron_id, pa.name from patron pa left join booking b on b.patron_id = pa.patron_id where b.rating is null', 'select pa.patron_id, pa.name from patron pa left join booking b on b.patron_id = pa.patron_id where b.booking_id is null'],
    hints: ['Only rated bookings count as a match.', 'Put b.rating is not null in the on clause, so unrated bookings do not match.', 'select pa.patron_id, pa.name from patron pa left join booking b on b.patron_id = pa.patron_id and b.rating is not null where b.booking_id is null'] });

  ex({ id: 'int-x-source-title', level: 2, title: 'Based on what',
    text: ['For every opera production, give its title and the title of the production it is based on. An opera that is based on nothing appears once, with null as the second title.', '**Answer with** two columns, the title and the source title; one row per opera; in any order.'],
    ref: "select p.title, s.title\nfrom production p left join production s on s.prod_id = p.based_on\nwhere p.genre = 'opera'",
    wrongs: ["select p.title, s.title from production p join production s on s.prod_id = p.based_on where p.genre = 'opera'", "select p.title, s.title from production p left join production s on s.based_on = p.prod_id where p.genre = 'opera'"],
    hints: ['production refers to itself through based_on: use two copies.', 'An inner join would drop the operas that are originals.', "select p.title, s.title from production p left join production s on s.prod_id = p.based_on where p.genre = 'opera'"] });

  ex({ id: 'int-x-mentee-count', level: 2, title: 'Mentees per artist',
    text: ['For every artist, give the person ID and the number of artists they mentor (0 if none).', '**Answer with** two columns, the person ID and the count; one row per artist; in any order.'],
    ref: 'select a.person_id, count(m.mentee_id)\nfrom artist a left join mentor m on m.mentor_id = a.person_id\ngroup by a.person_id',
    wrongs: ['select a.person_id, count(*) from artist a left join mentor m on m.mentor_id = a.person_id group by a.person_id', 'select a.person_id, count(m.mentor_id) from artist a left join mentor m on m.mentee_id = a.person_id group by a.person_id'],
    hints: ['Left join artist with mentor.', 'The artist is the mentor, so match mentor_id.', 'count(m.mentee_id) gives 0 for the padded rows.'] });

  ex({ id: 'int-x-stage-use', level: 2, title: 'Stage use',
    text: ['For every stage, give the venue code, the stage number and the number of performances on it in the calendar year 2025 (0 if none).', '**Answer with** three columns: venue code, stage number, count; one row per stage; in any order.'],
    ref: "select s.venue_code, s.stage_no, count(f.perf_id)\nfrom stage s left join performance f\n  on f.venue_code = s.venue_code and f.stage_no = s.stage_no\n and f.perf_date between date '2025-01-01' and date '2025-12-31'\ngroup by s.venue_code, s.stage_no",
    wrongs: ["select s.venue_code, s.stage_no, count(f.perf_id) from stage s left join performance f on f.venue_code = s.venue_code and f.perf_date between date '2025-01-01' and date '2025-12-31' group by s.venue_code, s.stage_no", "select s.venue_code, s.stage_no, count(f.perf_id) from stage s left join performance f on f.venue_code = s.venue_code and f.stage_no = s.stage_no where f.perf_date between date '2025-01-01' and date '2025-12-31' group by s.venue_code, s.stage_no"],
    hints: ['A stage is identified by venue_code and stage_no together.', 'The join condition has three parts: venue, stage number and the date range.', 'Count a performance attribute so idle stages show 0.'] });

  ex({ id: 'int-x-new-patrons-top', level: 2, title: 'Top marks, with zeros',
    text: ['For every patron who joined in 2025, give the number of their bookings rated 5 (0 if none).', '**Answer with** three columns: patron ID, name, count; one row per such patron; in any order.'],
    ref: "select pa.patron_id, pa.name, count(b.booking_id)\nfrom patron pa left join booking b on b.patron_id = pa.patron_id and b.rating = 5\nwhere pa.joined between date '2025-01-01' and date '2025-12-31'\ngroup by pa.patron_id, pa.name",
    wrongs: ["select pa.patron_id, pa.name, count(b.booking_id) from patron pa left join booking b on b.patron_id = pa.patron_id where b.rating = 5 and pa.joined between date '2025-01-01' and date '2025-12-31' group by pa.patron_id, pa.name", "select pa.patron_id, pa.name, count(*) from patron pa left join booking b on b.patron_id = pa.patron_id and b.rating = 5 where pa.joined between date '2025-01-01' and date '2025-12-31' group by pa.patron_id, pa.name"],
    hints: ['The rating condition goes in on, so patrons without such ratings survive.', 'The joining date is about the patron, so it can go in where.', 'left join booking b on b.patron_id = pa.patron_id and b.rating = 5, then count(b.booking_id)'] });

  ex({ id: 'int-x-right', level: 1, title: 'A right outer join',
    text: ['Using a right outer join with `production` on the left and `company` on the right, list every company name together with the titles of its productions; a company without productions appears once, with a null title.', '**Answer with** two columns, the company name and the title; in any order.'],
    ref: 'select c.name, p.title from production p right join company c on p.company_id = c.company_id',
    wrongs: ['select c.name, p.title from production p left join company c on p.company_id = c.company_id', 'select c.name, p.title from production p join company c on p.company_id = c.company_id'],
    hints: ['A right outer join keeps every tuple of the right relation.', 'Join on company_id.', 'select c.name, p.title from production p right join company c on p.company_id = c.company_id'] });

  ex({ id: 'int-x-full-company', level: 2, title: 'Both kinds of loner',
    text: ['Using a full outer join of company and artist, list every company name with the person ID of each of its artists. Companies without artists appear with a null person ID, and freelance artists with a null company name.', '**Answer with** two columns, the company name and the person ID; in any order.'],
    ref: 'select c.name, a.person_id from company c full outer join artist a on a.company_id = c.company_id',
    wrongs: ['select c.name, a.person_id from company c left join artist a on a.company_id = c.company_id', 'select c.name, a.person_id from company c right join artist a on a.company_id = c.company_id'],
    hints: ['A left join keeps only unmatched companies; a right join only unmatched artists.', 'full outer join keeps both.', 'select c.name, a.person_id from company c full outer join artist a on a.company_id = c.company_id'] });

  ex({ id: 'int-x-seasons', level: 3, title: 'Two seasons side by side',
    text: ['For every production performed in the 2024-25 season (September 2024 to June 2025) or the 2025-26 season (September 2025 to June 2026), give the number of its performances in each season (0 where there were none). Use a full outer join of two grouped subqueries.', '**Answer with** three columns: production ID, performances in 2024-25, performances in 2025-26; one row per production; in any order.'],
    ref: "select coalesce(a.prod_id, b.prod_id), coalesce(a.n, 0), coalesce(b.n, 0)\nfrom (select prod_id, count(*) as n from performance where perf_date between date '2024-09-01' and date '2025-06-30' group by prod_id) a\n  full outer join\n     (select prod_id, count(*) as n from performance where perf_date between date '2025-09-01' and date '2026-06-30' group by prod_id) b\n  on a.prod_id = b.prod_id",
    wrongs: ["select a.prod_id, coalesce(a.n, 0), coalesce(b.n, 0) from (select prod_id, count(*) as n from performance where perf_date between date '2024-09-01' and date '2025-06-30' group by prod_id) a full outer join (select prod_id, count(*) as n from performance where perf_date between date '2025-09-01' and date '2026-06-30' group by prod_id) b on a.prod_id = b.prod_id", "select a.prod_id, a.n, coalesce(b.n, 0) from (select prod_id, count(*) as n from performance where perf_date between date '2024-09-01' and date '2025-06-30' group by prod_id) a left join (select prod_id, count(*) as n from performance where perf_date between date '2025-09-01' and date '2026-06-30' group by prod_id) b on a.prod_id = b.prod_id"],
    hints: ['Count the performances per production in each season, in two subqueries.', 'A full outer join keeps productions that appear in only one of them.', 'coalesce picks the production ID from whichever side has it, and turns missing counts into 0.'] });

  ex({ id: 'int-x-long-and-short', level: 2, title: 'Long and short',
    text: ['List the companies that have at least one production running more than 150 minutes and at least one running less than 90 minutes.', '**Answer with** one column, the company ID; each company once; in any order.'],
    ref: 'select distinct a.company_id\nfrom production a join production b on a.company_id = b.company_id\nwhere a.runtime_min > 150 and b.runtime_min < 90',
    alts: ['select company_id from production where runtime_min > 150 intersect select company_id from production where runtime_min < 90'],
    wrongs: ['select distinct company_id from production where runtime_min > 150 or runtime_min < 90', 'select distinct company_id from production where runtime_min > 150'],
    hints: ['One production cannot be both long and short: you need two.', 'Join production with itself on the company, or intersect two queries.', 'select company_id from production where runtime_min > 150 intersect select company_id from production where runtime_min < 90'] });

  // views and transactions
  ex({ id: 'int-x-view-long', kind: 'dml', level: 1, title: 'Create a view',
    text: ['Create a view `long_show` with the ID, title and running time of every production that runs 150 minutes or more.', '**Answer with** the view `long_show (prod_id, title, runtime_min)`.'],
    ref: 'create view long_show as select prod_id, title, runtime_min from production where runtime_min >= 150',
    after: 'select * from long_show',
    wrongs: ['create view long_show as select prod_id, title, runtime_min from production where runtime_min > 150'],
    hints: ['create view name as query', 'The query selects three attributes from production.', 'create view long_show as select prod_id, title, runtime_min from production where runtime_min >= 150'] });

  ex({ id: 'int-x-view-takings', kind: 'dml', level: 2, title: 'A view with totals',
    text: ['Create a view `perf_takings (perf_id, bookings, takings)` giving, for every performance, the number of bookings and the total paid. A performance with no bookings shows 0 and 0.', '**Answer with** the view `perf_takings`, one row per performance.'],
    ref: 'create view perf_takings (perf_id, bookings, takings) as\nselect f.perf_id, count(b.booking_id), coalesce(sum(b.paid), 0)\nfrom performance f left join booking b on b.perf_id = f.perf_id\ngroup by f.perf_id',
    after: 'select * from perf_takings',
    wrongs: ['create view perf_takings (perf_id, bookings, takings) as select f.perf_id, count(b.booking_id), sum(b.paid) from performance f left join booking b on b.perf_id = f.perf_id group by f.perf_id', 'create view perf_takings (perf_id, bookings, takings) as select perf_id, count(*), sum(paid) from booking group by perf_id'],
    hints: ['Start from performance so every performance appears.', 'The sum of no values is null, not 0.', 'Left join booking, count(b.booking_id) and coalesce(sum(b.paid), 0).'] });

  ex({ id: 'int-x-view-cast-list', kind: 'dml', level: 2, title: 'A view over three tables',
    text: ['Create a view `cast_list (title, billed, role_name)` with one row per casting: the production title, the name the artist is billed under, and the role. Artists without a billing name are billed under their given name, a space and their family name.', '**Answer with** the view `cast_list`, one row per row of casting.'],
    ref: "create view cast_list (title, billed, role_name) as\nselect p.title, coalesce(a.billed_as, pe.given_name || ' ' || pe.family_name), c.role_name\nfrom casting c\n  join production p on p.prod_id = c.prod_id\n  join artist a on a.person_id = c.person_id\n  join person pe on pe.person_id = c.person_id",
    after: 'select * from cast_list',
    wrongs: ['create view cast_list (title, billed, role_name) as select p.title, a.billed_as, c.role_name from casting c join production p on p.prod_id = c.prod_id join artist a on a.person_id = c.person_id', "create view cast_list (title, billed, role_name) as select p.title, pe.given_name || ' ' || pe.family_name, c.role_name from casting c join production p on p.prod_id = c.prod_id join person pe on pe.person_id = c.person_id"],
    hints: ['The billing name is in artist, the person\'s names in person.', 'coalesce takes the first value that is not null.', "coalesce(a.billed_as, pe.given_name || ' ' || pe.family_name)"] });

  ex({ id: 'int-x-view-check', kind: 'dml', level: 2, title: 'Insert through a checked view',
    text: ['Create a view `dance_production` of all attributes of the dance productions, `with check option`. Then, through the view, add production PR190, titled Night Tides, by company C05, a dance premiering on 1 November 2026, running 80 minutes, based on nothing.', '**Answer with** the view and the new production in the production table.'],
    ref: "create view dance_production as select * from production where genre = 'dance' with check option;\ninsert into dance_production values ('PR190', 'Night Tides', 'C05', 'dance', date '2026-11-01', 80, null)",
    after: "select * from production where genre = 'dance'",
    wrongs: ["create view dance_production as select * from production where genre = 'dance' with check option", "insert into production values ('PR190', 'Night Tides', 'C05', 'dance', date '2026-01-11', 80, null)"],
    hints: ['Two statements, separated by a semicolon.', 'The view selects * from production with a where clause, then with check option.', "insert into dance_production values ('PR190', 'Night Tides', 'C05', 'dance', date '2026-11-01', 80, null)"] });

  ex({ id: 'int-x-matview', kind: 'dml', level: 2, title: 'A materialized view',
    text: ['Create a materialized view `city_patrons (city, patrons)` with the number of patrons in each city. Leave out patrons whose city is unknown.', '**Answer with** the materialized view, one row per known city.'],
    ref: 'create materialized view city_patrons (city, patrons) as\nselect city, count(*) from patron where city is not null group by city',
    after: 'select * from city_patrons',
    wrongs: ['create materialized view city_patrons (city, patrons) as select city, count(*) from patron group by city', 'create materialized view city_patrons (city, patrons) as select city, count(distinct name) from patron where city is not null group by city'],
    hints: ['create materialized view works like create view.', 'Group the patrons by city.', 'Filter out the null city in where.'] });

  ex({ id: 'int-x-move-points', kind: 'dml', level: 2, title: 'A transfer in one statement',
    text: ['Patron 1 gives 100 loyalty points to patron 2. Do it with a single update statement, so it happens all at once.', '**Answer with** the points of patrons 1 and 2 changed, and no one else\'s.'],
    ref: 'update patron\nset points = points + case patron_id when 1 then -100 else 100 end\nwhere patron_id in (1, 2)',
    after: 'select patron_id, points from patron',
    wrongs: ['update patron set points = points - 100 where patron_id = 1', 'update patron set points = points + case patron_id when 2 then -100 else 100 end where patron_id in (1, 2)'],
    hints: ['One update can change two rows.', 'A case expression chooses -100 or +100 per row.', 'update patron set points = points + case patron_id when 1 then -100 else 100 end where patron_id in (1, 2)'] });

  ex({ id: 'int-x-view-public', kind: 'dml', level: 1, title: 'A view that hides a column',
    text: ['Create a view `artist_public` showing the person ID, company ID and billing name of every artist, but not the fee.', '**Answer with** the view `artist_public (person_id, company_id, billed_as)`, one row per artist.'],
    ref: 'create view artist_public as select person_id, company_id, billed_as from artist',
    after: 'select * from artist_public',
    wrongs: ['create view artist_public as select * from artist', 'create view artist_public as select person_id, company_id, billed_as from artist where company_id is not null'],
    hints: ['A view can leave columns out.', 'create view artist_public as select ...', 'select person_id, company_id, billed_as from artist'] });

  // integrity constraints
  ex({ id: 'int-x-not-null', kind: 'dml', level: 1, title: 'Require a value',
    text: ['Change the company table so that `budget` may no longer be null.', '**Answer with** company.budget declared not null.'],
    ref: 'alter table company alter column budget set not null',
    after: "select column_name, is_nullable from information_schema.columns where table_name = 'company'",
    wrongs: ['alter table company alter column founded set not null', 'alter table company add check (budget is not null)'],
    hints: ['alter table ... alter column ...', 'The clause is set not null.', 'alter table company alter column budget set not null'] });

  ex({ id: 'int-x-unique-title', kind: 'dml', level: 2, title: 'A unique pair',
    text: ['Add a constraint named `production_title_unique` saying that one company may not have two productions with the same title. (Two different companies may use the same title.)', '**Answer with** the new constraint on production.'],
    ref: 'alter table production add constraint production_title_unique unique (company_id, title)',
    after: "select constraint_name, constraint_type from information_schema.table_constraints where table_name = 'production'",
    wrongs: ['alter table production add constraint production_title_unique unique (title)', 'alter table production add constraint production_title_unique primary key (company_id, title)'],
    hints: ['alter table production add constraint name ...', 'The constraint is on the pair of attributes.', 'unique (company_id, title)'] });

  ex({ id: 'int-x-check-price', kind: 'dml', level: 2, title: 'A check constraint',
    text: ['Add a constraint named `price_cap` to performance requiring the ticket price to be from 0 to 250, both included.', '**Answer with** the new check constraint on performance.'],
    ref: 'alter table performance add constraint price_cap check (price between 0 and 250)',
    after: "select c.constraint_name, k.check_clause from information_schema.table_constraints c join information_schema.check_constraints k on k.constraint_name = c.constraint_name where c.table_name = 'performance' and c.constraint_name = 'price_cap'",
    wrongs: ['alter table performance add constraint price_cap check (price < 250)', 'alter table performance add constraint price_cap check (price between 1 and 250)'],
    hints: ['A check constraint takes a predicate.', 'between includes both ends.', 'alter table performance add constraint price_cap check (price between 0 and 250)'] });

  ex({ id: 'int-x-default-time', kind: 'dml', level: 1, title: 'A default value',
    text: ["Most evening shows start at half past seven. Give the `start_time` attribute of performance the default value `'19:30'`.", '**Answer with** the default on performance.start_time.'],
    ref: "alter table performance alter column start_time set default '19:30'",
    after: "select column_name, column_default is not null from information_schema.columns where table_name = 'performance'",
    wrongs: ["alter table performance alter column perf_date set default current_date", "alter table performance alter column start_time drop not null"],
    hints: ['alter table ... alter column ...', 'set default value', "alter table performance alter column start_time set default '19:30'"] });

  ex({ id: 'int-x-delete-company', kind: 'dml', level: 1, title: 'What a delete sets off',
    text: ['Delete every company that has no productions. The foreign key from artist to company says `on delete set null`: before you check, predict what happens to those companies\' artists, then look.', '**Answer with** the companies gone; their artists stay, with a null company.'],
    ref: 'delete from company c where not exists (select * from production p where p.company_id = c.company_id)',
    alts: ['delete from company where company_id not in (select company_id from production)'],
    after: "select 'artist', person_id, company_id from artist union all select 'company', company_id, name from company",
    wrongs: ['delete from artist where company_id not in (select company_id from production)', 'update artist set company_id = null where company_id not in (select company_id from production)'],
    hints: ['A plain delete with a subquery is enough.', 'The database itself sets the company of the artists to null.', 'delete from company c where not exists (select * from production p where p.company_id = c.company_id)'] });

  ex({ id: 'int-x-fk-cascade', kind: 'dml', level: 3, title: 'Change a foreign-key action',
    text: ['The foreign key from `booking.perf_id` to performance is called `booking_perf_id_fkey` and refuses to delete a performance that has bookings. Replace it with one that deletes the bookings along with the performance, and then delete every performance before 1 January 2025.', '**Answer with** the performances and their bookings gone; the other bookings unchanged.'],
    ref: "alter table booking drop constraint booking_perf_id_fkey;\nalter table booking add foreign key (perf_id) references performance on delete cascade;\ndelete from performance where perf_date < date '2025-01-01'",
    after: 'select booking_id, perf_id from booking',
    wrongs: ["delete from performance where perf_date < date '2025-01-01'", "alter table booking add foreign key (perf_id) references performance on delete cascade; delete from performance where perf_date < date '2025-01-01'"],
    hints: ['A constraint cannot be altered; drop it and add a new one.', 'The new one says on delete cascade.', "Then delete from performance where perf_date < date '2025-01-01'; the bookings go too."] });

  // types and schemas
  ex({ id: 'int-x-curtain-down', level: 1, title: 'When the curtain comes down',
    text: ['For every performance in May 2025, give the performance ID, the start time and the time the show ends: the start time plus the production\'s running time in minutes. (Multiply `interval \'1 minute\'` by a number.)', '**Answer with** three columns: performance ID, start time, end time (a time); in any order.'],
    ref: "select f.perf_id, f.start_time, f.start_time + p.runtime_min * interval '1 minute'\nfrom performance f join production p using (prod_id)\nwhere f.perf_date between date '2025-05-01' and date '2025-05-31'",
    wrongs: ["select f.perf_id, f.start_time, f.start_time + p.runtime_min / 60 * interval '1 hour' from performance f join production p using (prod_id) where f.perf_date between date '2025-05-01' and date '2025-05-31'", "select f.perf_id, f.start_time, f.start_time + interval '2 hours' from performance f join production p using (prod_id) where f.perf_date between date '2025-05-01' and date '2025-05-31'"],
    hints: ['The running time is in production.runtime_min.', 'runtime_min * interval \'1 minute\' is an interval; a time plus an interval is a time.', "select f.perf_id, f.start_time, f.start_time + p.runtime_min * interval '1 minute' from performance f join production p using (prod_id) where f.perf_date between date '2025-05-01' and date '2025-05-31'"] });

  ex({ id: 'int-x-sundays', level: 1, title: 'Sunday shows',
    text: ['List the performances that took place on a Sunday. (`extract(dow from d)` is 0 for Sunday and 6 for Saturday.)', '**Answer with** two columns, the performance ID and the date; in any order.'],
    ref: 'select perf_id, perf_date from performance where extract(dow from perf_date) = 0',
    wrongs: ['select perf_id, perf_date from performance where extract(dow from perf_date) = 7', 'select perf_id, perf_date from performance where extract(dow from perf_date) = 1'],
    hints: ['extract pulls one field out of a date.', 'The day of the week is the field dow.', 'select perf_id, perf_date from performance where extract(dow from perf_date) = 0'] });

  ex({ id: 'int-x-lead-age', level: 2, title: 'Age at the premiere',
    text: ['For every leading role, give the person ID, the production title, and the artist\'s age in whole years on the day of the premiere (null where either date is unknown). `age(later, earlier)` gives an interval in years, months and days.', '**Answer with** three columns: person ID, title, age as a whole number; one row per leading role; in any order.'],
    ref: 'select c.person_id, p.title, extract(year from age(p.premiere, pe.birth_date))::int\nfrom casting c\n  join production p on p.prod_id = c.prod_id\n  join person pe on pe.person_id = c.person_id\nwhere c.lead',
    wrongs: ['select c.person_id, p.title, ((p.premiere - pe.birth_date) / 365)::int from casting c join production p on p.prod_id = c.prod_id join person pe on pe.person_id = c.person_id where c.lead', 'select c.person_id, p.title, (extract(year from p.premiere) - extract(year from pe.birth_date))::int from casting c join production p on p.prod_id = c.prod_id join person pe on pe.person_id = c.person_id where c.lead'],
    hints: ['The premiere is in production, the birth date in person.', 'Subtracting the birth year from the premiere year is wrong for anyone whose birthday comes later in the year.', 'extract(year from age(p.premiere, pe.birth_date))::int'] });

  ex({ id: 'int-x-dark-nights', level: 2, title: 'Dark nights',
    text: ['A night with no performance anywhere is a dark night. List the dark nights of October 2025, as values of type date. (`generate_series(start, stop, interval \'1 day\')` produces every day.)', '**Answer with** one column of dates; in any order.'],
    ref: "select g::date\nfrom generate_series(date '2025-10-01', date '2025-10-31', interval '1 day') as g\nwhere not exists (select * from performance f where f.perf_date = g::date)",
    wrongs: ["select g::date from generate_series(date '2025-10-01', date '2025-10-30', interval '1 day') as g where not exists (select * from performance f where f.perf_date = g::date)", "select distinct perf_date from performance where perf_date between date '2025-10-01' and date '2025-10-31'"],
    hints: ['The dark nights are not in any table: generate every day of the month.', 'Keep a day if no performance has that date.', "select g::date from generate_series(date '2025-10-01', date '2025-10-31', interval '1 day') as g where not exists (select * from performance f where f.perf_date = g::date)"] });

  ex({ id: 'int-x-season-year', level: 2, title: 'Which season',
    text: ['A season starts in September and is named after the year it starts in: a performance in March 2025 belongs to the 2024 season. For every performance, give its ID and the starting year of its season.', '**Answer with** two columns: performance ID and the season\'s year as a whole number; one row per performance; in any order.'],
    ref: "select perf_id, extract(year from perf_date - interval '8 months')::int from performance",
    alts: ['select perf_id, (case when extract(month from perf_date) >= 9 then extract(year from perf_date) else extract(year from perf_date) - 1 end)::int from performance'],
    wrongs: ['select perf_id, extract(year from perf_date)::int from performance', "select perf_id, extract(year from perf_date - interval '9 months')::int from performance"],
    hints: ['September to December belong to this year\'s season; January to August to last year\'s.', 'Shifting the date back by eight months moves September to January of the same year.', "select perf_id, extract(year from perf_date - interval '8 months')::int from performance"] });

  ex({ id: 'int-x-genre-order', level: 2, title: 'A chosen order',
    text: ['List the productions that premiered in 2025, musicals first, then operas, then all other genres in alphabetical order of the genre; within a genre, by title.', '**Answer with** three columns: genre, title, premiere; in that order.'],
    ref: "select genre, title, premiere from production\nwhere premiere between date '2025-01-01' and date '2025-12-31'\norder by case genre when 'musical' then 1 when 'opera' then 2 else 3 end, genre, title",
    wrongs: ["select genre, title, premiere from production where premiere between date '2025-01-01' and date '2025-12-31' order by genre, title", "select genre, title, premiere from production where premiere between date '2025-01-01' and date '2025-12-31' order by case genre when 'musical' then 1 when 'opera' then 2 else 3 end, title"],
    hints: ['Alphabetical order puts comedy and dance before musical.', 'order by can sort on an expression.', "order by case genre when 'musical' then 1 when 'opera' then 2 else 3 end, genre, title"] });

  ex({ id: 'int-x-archive', kind: 'dml', level: 2, title: 'A schema for old data',
    text: ['Create a schema `archive`, and in it a table `old_booking` holding a copy of all the bookings (all attributes of booking) for performances of the 2024-25 season, which ended on 30 June 2025.', '**Answer with** the table archive.old_booking with those bookings.'],
    ref: "create schema archive;\ncreate table archive.old_booking as\n  select b.* from booking b join performance f on f.perf_id = b.perf_id\n  where f.perf_date <= date '2025-06-30'",
    after: 'select booking_id, perf_id, paid from archive.old_booking',
    wrongs: ["create schema archive; create table archive.old_booking as select b.* from booking b join performance f on f.perf_id = b.perf_id where f.perf_date < date '2025-01-01'", 'create schema archive; create table archive.old_booking as select * from booking where perf_id < 100'],
    hints: ['create schema archive', 'create table ... as query copies the result of a query into a new table; the date is in performance.', "create table archive.old_booking as select b.* from booking b join performance f on f.perf_id = b.perf_id where f.perf_date <= date '2025-06-30'"] });

  ex({ id: 'int-x-index', kind: 'dml', level: 1, title: 'Create an index',
    text: ['Box-office queries often look up the bookings of one performance, patron by patron. Create an index named `booking_perf_idx` on booking, on the attributes perf_id and patron_id, in that order.', '**Answer with** the index booking_perf_idx.'],
    ref: 'create index booking_perf_idx on booking (perf_id, patron_id)',
    after: "select indexname, indexdef from pg_indexes where tablename = 'booking'",
    wrongs: ['create index booking_perf_idx on booking (patron_id, perf_id)', 'create index booking_perf_idx on booking (perf_id)'],
    hints: ['create index name on table (attributes)', 'The order of the attributes matters for the index.', 'create index booking_perf_idx on booking (perf_id, patron_id)'] });

  ex({ id: 'int-x-top-fee', level: 3, title: 'Best paid in each company',
    text: ['For each company, list the artist or artists with the highest fee in it. Join artist with a subquery that computes each company\'s highest fee. Freelance artists belong to no company and are left out.', '**Answer with** three columns: company ID, person ID, fee; ties all listed; in any order.'],
    ref: 'select a.company_id, a.person_id, a.fee\nfrom artist a\n  join (select company_id, max(fee) as top from artist group by company_id) m\n    on m.company_id = a.company_id and a.fee = m.top',
    wrongs: ['select a.company_id, a.person_id, a.fee from artist a join (select company_id, max(fee) as top from artist group by company_id) m on a.fee = m.top', 'select a.company_id, a.person_id, a.fee from artist a where a.fee = (select max(fee) from artist)'],
    hints: ['A grouped subquery gives one maximum per company.', 'Join it back to artist on the company and the fee.', 'Freelancers drop out by themselves: null = null is not true.'] });

  ex({ id: 'int-x-takings-venue', level: 2, title: 'Takings per venue, with zeros',
    text: ['For every venue, give the total paid for bookings of performances held there (0 for a venue where nothing has been booked).', '**Answer with** two columns, the venue code and the total; one row per venue; in any order.'],
    ref: 'select v.venue_code, coalesce(sum(b.paid), 0)\nfrom venue v\n  left join performance f on f.venue_code = v.venue_code\n  left join booking b on b.perf_id = f.perf_id\ngroup by v.venue_code',
    wrongs: ['select v.venue_code, sum(b.paid) from venue v left join performance f on f.venue_code = v.venue_code left join booking b on b.perf_id = f.perf_id group by v.venue_code', 'select v.venue_code, coalesce(sum(b.paid), 0) from venue v left join performance f on f.venue_code = v.venue_code join booking b on b.perf_id = f.perf_id group by v.venue_code'],
    hints: ['Two outer joins: venue to performance, then performance to booking.', 'If the second join were inner, the venues without bookings would disappear again.', 'The sum of nothing is null: coalesce(sum(b.paid), 0).'] });
})(typeof window !== 'undefined' ? window : globalThis);
