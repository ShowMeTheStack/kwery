// The chapters, in the order of the companion text (Database System Concepts, 7th edition), and the altered
// copies of the sample databases that exercises are also checked on.
(function (root) {
  'use strict';
  const C = root.K.Content;
  const parts = [
    [1, 'Introduction', 'Introduction', 'What a database system is, the levels of abstraction, and the parts of the system Kwery lets you watch.'],
    [2, 'Part 1: Relational languages', 'Introduction to the relational model', 'Relations, schemas, keys, and the relational algebra.'],
    [3, 'Part 1: Relational languages', 'Introduction to SQL', 'Defining tables, querying them, NULLs, aggregates, subqueries and changing data.'],
    [4, 'Part 1: Relational languages', 'Intermediate SQL', 'Joins, views, transactions, integrity constraints, types and authorization.'],
    [5, 'Part 1: Relational languages', 'Advanced SQL', 'Functions, procedures and triggers, recursive queries, window functions and OLAP.'],
    [6, 'Part 2: Database design', 'Database design using the E-R model', 'Entity sets, relationship sets, cardinalities, weak entities, specialization, and turning a diagram into tables.'],
    [7, 'Part 2: Database design', 'Relational database design', 'Functional dependencies, normal forms and decomposition.'],
    [8, 'Part 3: Application design and development', 'Complex data types', 'JSON, arrays, composite types, spatial and text data.'],
    [9, 'Part 3: Application design and development', 'Application development', 'Talking to the database from a program, safely.'],
    [10, 'Part 4: Big data analytics', 'Big data', 'Key-value and document stores, MapReduce, streams and graphs.'],
    [11, 'Part 4: Big data analytics', 'Data analytics', 'Warehouses, star schemas, OLAP and a first look at data mining.'],
    [12, 'Part 5: Storage management and indexing', 'Physical storage systems', 'Disks, SSDs and RAID: where the data lives and what an access costs.'],
    [13, 'Part 5: Storage management and indexing', 'Data storage structures', 'Records on slotted pages, files of pages, and the buffer manager.'],
    [14, 'Part 5: Storage management and indexing', 'Indexing', 'Ordered indices, B+ trees, hashing, bitmap indices and write-optimized structures.'],
    [15, 'Part 6: Query processing and optimization', 'Query processing', 'Selection, sorting, the join algorithms and how operators are pipelined.'],
    [16, 'Part 6: Query processing and optimization', 'Query optimization', 'Equivalence rules, statistics, cost estimates and choosing join orders.'],
    [17, 'Part 7: Transaction management', 'Transactions', 'ACID, schedules, serializability, recoverability and isolation levels.'],
    [18, 'Part 7: Transaction management', 'Concurrency control', 'Locking, deadlocks, timestamps, validation, multiversion schemes and snapshot isolation.'],
    [19, 'Part 7: Transaction management', 'Recovery system', 'The log, write-ahead logging, checkpoints, and recovering from a crash with ARIES.'],
    [20, 'Part 8: Parallel and distributed databases', 'Database-system architectures', 'Centralized, client-server, parallel and distributed systems.'],
    [21, 'Part 8: Parallel and distributed databases', 'Parallel and distributed storage', 'Partitioning, sharding and replication.'],
    [22, 'Part 8: Parallel and distributed databases', 'Parallel and distributed query processing', 'Parallel sorts and joins, exchange operators and distributed plans.'],
    [23, 'Part 8: Parallel and distributed databases', 'Parallel and distributed transaction processing', 'Two-phase commit, distributed concurrency control and consensus.'],
    [24, 'Part 9: Advanced topics', 'Advanced indexing techniques', 'Bloom filters, LSM trees, bitmaps and spatial indices.'],
    [25, 'Part 9: Advanced topics', 'Advanced application development', 'Tuning, benchmarks and standards.'],
    [26, 'Part 9: Advanced topics', 'Blockchain databases', 'Hash chains, Merkle trees, consensus, and how a blockchain compares with a replicated database.'],
  ];
  for (const [n, part, title, about] of parts) C.chapter(n, part, title, about);

  // altered copies of the Theatre database: an exercise's answer must also be right on each of these. Each one adds
  // the kind of row a query can get wrong without anyone noticing on the sample data.
  C.variants.theatre = [
    // fees changed (so no answer can be read off the sample), an artist with no company, no fee and no billing name,
    // two artists and two patrons who share a name, and a fee tied with the highest
    "update artist set fee = fee * 1.15 + 35 where person_id < 'P1050';\n" +
    "insert into person values ('P9001', 'Mara', 'Quell', null, null), ('P9002', 'Mara', 'Quell', date '1990-04-02', 'Saltreach');\n" +
    "insert into artist values ('P9001', null, null, null);\n" +
    "insert into artist select 'P9002', min(company_id), 'Mara Quell', max(fee) from artist;\n" +
    "insert into casting select 'P9001', max(prod_id), 'The Stranger', false from performance;\n" +
    "insert into casting select 'P9002', min(prod_id), 'The Ferryman', true from performance;\n" +
    "insert into patron select 901, name, city, date '2024-02-11', 40 from patron where patron_id = 1;\n" +
    "insert into patron values (902, 'Noor Halden', null, date '2026-06-01', 0)",
    // every rating of one production gone, the five-star ratings gone, a company with no artists and no productions
    "update booking set rating = null where perf_id in (select perf_id from performance where prod_id = (select min(prod_id) from performance where perf_date >= date '2025-01-01'));\n" +
    "delete from booking where rating = 5;\n" +
    "insert into company values ('C13', 'Wrenfield Players', 'Wrenfield', null, 90000)",
    // a production never performed with the title of another, a venue where nothing is on any more, one more freelance
    // artist, and a ticket price shared by many performances
    "insert into production select 'PR199', title, (select max(company_id) from company), 'drama', null, null, prod_id from production where prod_id = (select min(prod_id) from production);\n" +
    "insert into casting select person_id, 'PR199', 'The Keeper', true from artist where person_id = (select min(person_id) from artist);\n" +
    "insert into casting select person_id, 'PR199', 'The Daughter', false from artist where person_id = (select max(person_id) from artist);\n" +
    "delete from booking where perf_id in (select perf_id from performance where venue_code = (select venue_code from performance group by venue_code order by count(*), venue_code limit 1));\n" +
    "delete from performance where perf_id not in (select perf_id from booking) and venue_code = (select venue_code from performance group by venue_code order by count(*), venue_code limit 1);\n" +
    "update artist set company_id = null where person_id = (select min(person_id) from artist where company_id is not null);\n" +
    "update performance set price = 40.00 where perf_id between 60 and 75",
    // a longer chain of adaptations and a longer line of mentors, a new venue with nothing on, more seats on the arena
    // stages, and the bookings of one performance moved to another
    "insert into production with recursive d (id, n) as (select prod_id, 0 from production where based_on is null union all select p.prod_id, d.n + 1 from production p join d on p.based_on = d.id) select 'PR198', 'The Last Knot', (select min(company_id) from company), 'musical', date '2026-09-01', 130, id from d order by n desc, id limit 1;\n" +
    "insert into person values ('P9003', 'Ines', 'Varga', date '1999-02-14', 'Wrenfield'), ('P9004', 'Teo', 'Varga', null, 'Wrenfield');\n" +
    "insert into artist values ('P9003', null, null, 700.00), ('P9004', null, null, 650.00);\n" +
    "insert into mentor with recursive d (id, n) as (select mentor_id, 0 from mentor where mentor_id not in (select mentee_id from mentor) union all select m.mentee_id, d.n + 1 from mentor m join d on m.mentor_id = d.id) select id, 'P9003', date '2010-01-01' from d order by n desc, id limit 1;\n" +
    "insert into mentor values ('P9003', 'P9004', date '2015-06-01');\n" +
    "update stage set seats = seats + 25 where kind = 'arena';\n" +
    "insert into venue values ('WRE', 'Wrenfield Barn', 'Wrenfield', null);\n" +
    "insert into stage values ('WRE', 1, 90, 'studio');\n" +
    "update booking set perf_id = 2 where perf_id = 6 and patron_id not in (select patron_id from booking where perf_id = 2)",
  ];
  C.variantNotes = [
    'fees changed, an artist with no company and no fee, two artists and two patrons who share a name',
    'all ratings of one production gone, no five-star ratings, a company with no artists and no productions',
    'a production never performed that repeats a title, no performances at one venue, one more freelance artist, tied prices',
    'a longer chain of adaptations and of mentors, a new venue with nothing on, bookings moved between performances',
  ];
})(typeof window !== 'undefined' ? window : globalThis);
