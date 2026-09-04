// Chapter 1: what a database system is, seen through Kwery itself.
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
    id: 'intro-first-query', chapter: 1, title: 'Your first query', minutes: 5,
    summary: 'A query asks the database for data; the database works out how to get it. Run one and look underneath.',
    body: [
      'The Theatre database is loaded. It describes a small world of theatre companies, the productions they put on, the venues and stages where each performance takes place, the artists cast in the productions, and the patrons who book seats and sometimes rate what they saw. Each of these is a **table**: a set of rows that all have the same columns.',
      { sql: 'select title, genre, runtime_min\nfrom production\nwhere runtime_min > 150\norder by runtime_min desc, title;', note: 'Press Run. The rows appear below the editor.' },
      'You described the rows you wanted: the productions that run longer than two and a half hours, longest first. You did not say how to find them. Working that out is the database\'s job, and the **Plan** view on the right shows what it decided: read the table, keep the rows that pass the test, sort what is left.',
      { predict: { q: 'How many rows does `select count(*) from production` return?', options: ['One row, holding the number of productions', 'One row per production', 'No rows, if the table were empty'], answer: 0, explain: '`count(*)` is an aggregate: it folds all the rows into a single number. The answer is always one row, even for an empty table, where the number is 0.' }, sql: 'select count(*) from production;' },
      'Now ask something of another table. Which patrons have collected more than 1000 loyalty points?',
      { sql: 'select name, city, points\nfrom patron\nwhere points > 1000\norder by points desc, name;' },
      { tip: 'Each tab above the editor is a **session** of its own, as if a second person had connected. In later chapters two tabs let you watch two transactions get in each other\'s way.' },
      { view: 'plan', label: 'Open the plan view' },
    ],
  });

  lesson({
    id: 'intro-abstraction', chapter: 1, title: 'Levels of abstraction and data independence', minutes: 10,
    summary: 'A database hides how data is stored behind tables, and can hide tables behind views. Changing a lower level does not break the levels above.',
    body: [
      'A **database management system** (DBMS) is software that keeps a body of related data and lets many programs and people store, find and change it. Think of what happens without one. The box office keeps bookings in one spreadsheet, the marketing team keeps patrons\' addresses in another, and every company keeps its own cast list.',
      { list: ['A patron moves to another city. One sheet is corrected, the other is not, and now nobody knows which city is right.', 'The director asks which patrons rated every production of one company. Nobody planned for that question, so someone writes a script.', 'The power fails halfway through moving a party of six to a later performance. Their seats are now sold twice, or not at all.', 'Two clerks sell the last pair of seats at the same moment, to different people.', 'The accountant must see artists\' fees; the ushers must not. A spreadsheet is either shared or it is not.'] },
      'A DBMS deals with all of this once, for every program that uses it. The first idea that makes it possible is **abstraction**: each user sees only as much of the system as their work needs.',
      { h: 'Three levels' },
      { def: 'Physical level.', text: 'How the data really sits in storage: pages of bytes, where each row lives on its page, and the index structures that point into them.' },
      { def: 'Logical level.', text: 'What is stored and how it fits together: the tables, their columns and types, and the rules the data must obey.' },
      { def: 'View level.', text: 'The slice of the database that one group of users works with, possibly reshaped. A view can leave out columns (the fees, say) or combine several tables into one.' },
      'Most of the time you work at the logical level. Kwery also lets you look below it. Every row has a hidden column, `ctid`, that tells where it is stored: the page number and the slot on that page.',
      { sql: 'select ctid, company_id, name\nfrom company;', note: '(0,3) means page 0, slot 3.' },
      { view: 'storage', label: 'Open the storage view to see the pages themselves' },
      'The database describes its own logical level in a **data dictionary** (also called the catalog), and you can query it like any table:',
      { sql: "select column_name, data_type\nfrom information_schema.columns\nwhere table_name = 'artist';" },
      'And this is the view level: a view of the artists without their fees. Someone who may read only this view never sees what an artist is paid.',
      { sql: 'create view artist_public as\n  select person_id, company_id, billed_as\n  from artist;\n\nselect * from artist_public\nwhere company_id is null;' },
      { h: 'Data independence' },
      '**Physical data independence** means that how data is stored can change without the programs that use it changing. An index is a physical structure; create one and ask the same question again.',
      { sql: "create index production_genre_idx on production (genre);\nset enable_seqscan = off;\nselect title from production\nwhere genre = 'opera';", note: '`set enable_seqscan = off` tells the planner to avoid reading the whole table where it can, so even on this small table it uses the new index.' },
      { predict: { q: 'With the index in place, does the query return the same rows as before?', options: ['Yes, exactly the same rows', 'Fewer rows, because the index covers only some of them', 'The same rows, but only after the query is rewritten to name the index'], answer: 0, explain: 'The index changes how the rows are found, never which rows are the answer, and the query did not change at all. In the plan view the scan now goes through `production_genre_idx`.' }, sql: "explain select title from production\nwhere genre = 'opera';" },
      '**Logical data independence** is the same promise one level up: the tables can change (a column added, a table split in two) while the views that programs rely on keep working. It is harder to achieve, and views are the main tool for it.',
      'Put everything back as it was:',
      { sql: 'reset enable_seqscan;\ndrop index production_genre_idx;\ndrop view artist_public;' },
    ],
  });

  lesson({
    id: 'intro-parts', chapter: 1, title: 'The parts of a database system', minutes: 10,
    summary: 'The query processor, the storage manager and the transaction manager, and where each one lives in Kwery.',
    body: [
      'A database system is a few cooperating parts rather than one program. Kwery is built the same way, and each part has a view of its own. Follow one query through them.',
      { table: [['Part', 'Its job', 'In Kwery'], ['Query processor', 'Turns SQL text into an answer: checks it, picks a way to compute it, computes it', 'the lexer, parser, binder, planner and executor'], ['Storage manager', 'Keeps the data in pages on disk, decides which pages stay in memory, keeps the indexes up to date', 'the disk, the pages, the buffer pool, the heap files and the index structures'], ['Transaction manager', 'Makes a group of changes happen completely or not at all, keeps concurrent users from tripping over each other, and brings the data back after a crash', 'transactions, locks, the write-ahead log and recovery']] },
      { h: 'The query processor' },
      'Your SQL text is first split into words and checked against the grammar. Then every name in it is looked up in the catalog: does a table `performance` exist, does it have a column `perf_date`? Statements that define data, such as `create table`, end there, by recording something new in the catalog. A query goes on to the **planner**, which considers several ways of computing the answer and keeps the cheapest it finds, and then to the **executor**, which carries the plan out.',
      'Ask for the plan without running the query:',
      { sql: "explain\nselect p.title, f.perf_date\nfrom production p join performance f on f.prod_id = p.prod_id\nwhere f.price > 50;" },
      'Each line is an operator, and the lines indented under it feed it rows. The executor runs the tree from the leaves up.',
      { view: 'plan', label: 'See the plan as a tree' },
      { h: 'The storage manager' },
      'Below the query processor sits the storage manager. It hands out pages of data, keeps the most useful ones in a **buffer pool** in memory, reads the others from the (simulated) disk, and maintains every index whenever a row changes. It also refuses changes that break a declared rule, such as a negative ticket price.',
      '`explain analyze` runs the query and reports what the storage manager had to do: how many pages it found in the buffer pool (hits) and how many it had to read from disk.',
      { sql: 'explain analyze\nselect count(*) from booking;' },
      { predict: { q: 'Run the same `explain analyze` a second time. What happens to the number of pages read from disk?', options: ['It drops, to zero or close to it: the pages are now in memory', 'It doubles, because the pages are read twice', 'It is always the same as the first time'], answer: 0, explain: 'The buffer pool keeps recently used pages in memory. The second scan of a small table finds them there, so they count as hits rather than disk reads.' }, sql: 'explain analyze\nselect count(*) from booking;' },
      { h: 'The transaction manager' },
      'A **transaction** is a piece of work that happens completely or not at all. Here is one that cancels every booking in the database, and then thinks better of it:',
      { sql: 'begin;\ndelete from booking;\nselect count(*) from booking;' },
      'Inside the transaction the table is empty. Now undo it:',
      { sql: 'rollback;\nselect count(*) from booking;' },
      'The transaction manager made the delete vanish as though it had never been run. It also keeps other sessions from seeing half-finished work, and, with its log, it can bring committed changes back after a crash. Chapters 17 to 19 take each of these apart.',
      { tip: 'The status bar at the bottom shows whether the current tab has a transaction open.' },
    ],
  });

  lesson({
    id: 'intro-users', chapter: 1, title: 'Database users and the administrator', minutes: 6,
    summary: 'Who works with a database, how close each of them gets to SQL, and what the database administrator looks after.',
    body: [
      'Many people depend on the Theatre database, and they meet it from very different distances.',
      { list: ['A **patron** booking two seats on a website never sees a line of SQL. A form collects the choice, and a program sends the queries.', 'The **developer** who wrote that booking site puts SQL inside code, in Python, Java or JavaScript. Chapter 5 shows how to do that without letting a visitor rewrite the query.', 'An **analyst** asking which genres sell best on weekday evenings writes queries directly. So do you, in this editor.'] },
      'Every session runs as some database user. Kwery starts you as the user `kwery`:',
      { sql: 'select current_user;' },
      { h: 'The database administrator' },
      'Someone has to look after the database itself: the **database administrator**, or DBA. In the theatre network that person:',
      { list: ['decides which tables exist and what their columns and rules are, and writes the DDL', 'chooses how the data is stored and which indexes are built, by watching which queries are slow', 'decides who may read or change what: the box office sees bookings but not artists\' fees', 'keeps the system healthy: backups, free space, and fresh statistics for the planner'] },
      'Two small examples of the last duty. `analyze` refreshes the statistics the planner uses to estimate costs, and the catalog then holds the new row count:',
      { sql: "analyze booking;\nselect relname, reltuples\nfrom pg_class\nwhere relname = 'booking';" },
      'The DBA can also see who is connected and what they are running:',
      { sql: 'select pid, usename, application_name, query\nfrom pg_stat_activity;', note: 'Open a second tab and run this again: there are now two sessions.' },
      { predict: { q: 'A patron complains that the "my bookings" page is slow, and the cause is a missing index. In the usual division of work, who adds it?', options: ['The DBA', 'The patron, by asking differently', 'Nobody: the database adds indexes by itself'], answer: 0, explain: 'Choosing storage structures and indexes is part of the DBA\'s work. The query in the booking site does not change at all: that is physical data independence again.' } },
      'In Kwery you get to play every one of these parts. In chapter 4 you will create users and decide what each of them may see.',
    ],
  });
})(typeof window !== 'undefined' ? window : globalThis);
