// Chapter 25: advanced application development. Tuning a database (finding the bottleneck, indexes, materialized
// views, statistics, the cost of every index on updates), benchmarks, and standards.
(function (root) {
  'use strict';
  const C = root.K.Content;
  const kit = C.kit1726;
  const lesson = kit.lesson;

  const VISIT = "drop table if exists visit;\ncreate table visit (id int primary key, patron_id int, page text, at_hour int, pad text);\ninsert into visit\n  select g, 1000 + (g * 7919) % 3000, 'p' || (g % 50), g % 24, repeat('x', 60)\n  from generate_series(1, 3000) g;\nanalyze visit;";

  lesson({
    id: 'tun-tuning', chapter: 25, title: 'Performance tuning: finding and fixing the bottleneck', minutes: 15,
    summary: 'Measure first, find the one part that limits the system, and fix that: an index for a slow query, a materialized view for a repeated aggregate, fresh statistics for a bad plan. Every fix has a price.',
    body: [
      'A system is only as fast as its slowest part. If the disk is busy 95% of the time and the processors 20%, a faster processor changes nothing. **Tuning** is the loop: measure, find the **bottleneck**, remove it, measure again, and see where the bottleneck has moved.',
      'The knobs come at several levels:',
      { list: ['**hardware**: more memory for the buffer pool, faster disks or SSDs, more processors', '**database parameters**: buffer pool size, checkpoint interval, log buffering', '**physical design**: indexes, materialized views, partitioning, clustering', '**schema**: denormalizing a hot join, splitting a wide table', '**transactions**: shorter transactions, fewer conflicts, batching small updates'] },
      'This lesson works the physical-design level, because that is where most everyday tuning happens. Here is a table of page visits, large enough for the difference to show:',
      { sql: VISIT + "\nselect relname, relpages from pg_class where relname like 'visit%';" },
      { h: 'A missing index' },
      'One patron\'s visits to the box office website. Without an index, every page of the table is read:',
      { sql: 'explain analyze select count(*) from visit where patron_id = 1234;', note: 'Count the pages the scan touched: the buffer pool line adds up hits (found in memory) and misses (read from disk). Every page of the table is there.' },
      { predict: { q: 'Add an index on `patron_id` and run the same query. What happens to the number of pages touched?', options: ['It falls to a handful', 'It halves', 'It stays the same: the planner still reads the whole table'], answer: 0, explain: 'The query matches one or two rows. The index leads straight to them: a few index pages and one or two heap pages, instead of every page of the table.' }, sql: 'create index visit_patron on visit (patron_id);\nexplain analyze select count(*) from visit where patron_id = 1234;' },
      { h: 'The price of an index' },
      'Every index must be kept up to date on each insert, update and delete of its column. An index that no query uses only costs. Update the column twice, once with an index on it and once without:',
      { sql: "create index visit_hour on visit (at_hour);\nexplain analyze update visit set at_hour = (at_hour + 1) % 24 where id <= 600;", note: 'Note the page writes: the heap and the index on at_hour both change.' },
      { sql: 'drop index visit_hour;\nexplain analyze update visit set at_hour = (at_hour + 1) % 24 where id <= 600;', note: 'Fewer page writes without the index on the updated column.' },
      'So the choice of indexes is a trade-off over the whole **workload**: how often each query runs, how often each column changes. An **index advisor** (the tuning wizards of commercial systems) takes a sample workload, tries candidate indexes in the optimizer\'s cost model without building them, and proposes the set with the lowest total cost.',
      { view: 'tuning', label: 'Open the Tuning view (index advisor and benchmark)' },
      { steps: ['In the Tuning view, pick the **Workload** *Box office (lookups)*. Each query carries a `-- weight` line: how often it runs.', 'Press **Run the workload** under *Measured on this database* to count the pages each query touches now.', 'Press **Run the advisor**. *Candidate indexes* lists every index it priced, with its size in pages and its benefit; *Recommendation* gives the set it would build. Change **Plan for** to *100× larger* and run it again: on bigger tables more indexes pay for themselves.', 'Press **Apply to the database**, then **Run the workload** again and compare the two runs. Drop the indexes afterwards (the view shows their names) if you want the database as it was.'] },
      { h: 'A repeated aggregate' },
      'A dashboard that shows visits per page every few seconds aggregates the whole table each time. A **materialized view** stores the answer once; reading it reads a few rows. The price: it must be refreshed (or maintained) when the table changes, and between refreshes it is stale.',
      { sql: "drop materialized view if exists visits_per_page;\ncreate materialized view visits_per_page as\n  select page, count(*) as visits from visit group by page;\nexplain analyze select * from visits_per_page where page = 'p7';" },
      { sql: "insert into visit values (3001, 1234, 'p7', 9, 'x');\nselect visits from visits_per_page where page = 'p7';\nrefresh materialized view visits_per_page;\nselect visits from visits_per_page where page = 'p7';", note: 'The first count is stale; after the refresh it includes the new visit.' },
      { h: 'Statistics' },
      'The optimizer chooses plans from statistics about each column: the number of distinct values, the most common values, a histogram. Stale statistics give bad estimates and bad plans; `analyze` refreshes them.',
      { sql: "select attname, n_distinct\nfrom pg_stats\nwhere tablename = 'visit'\norder by attname;" },
      { sql: 'drop materialized view visits_per_page;\ndrop table visit;' },
    ],
  });

  lesson({
    id: 'tun-bench', chapter: 25, title: 'Benchmarks and standards', minutes: 10,
    summary: 'A benchmark is a fixed workload everyone runs the same way, so that systems can be compared. Standards let the same application talk to different systems.',
    body: [
      'Claims like "our database is fast" mean nothing without a workload. A **benchmark** fixes the workload: the data, the mix of transactions or queries, the rules for running them, and the metric to report.',
      { h: 'The TPC benchmarks' },
      'The Transaction Processing Performance Council (TPC) defines the benchmarks most often quoted:',
      { table: [['Benchmark', 'Workload', 'Metric'], ['TPC-C', 'Order entry: new orders, payments, deliveries, stock checks, on warehouses and districts', 'new-order transactions per minute (tpmC), and price per tpmC'], ['TPC-E', 'A brokerage firm: trades, account lookups, market feeds', 'transactions per second'], ['TPC-H', 'Decision support: 22 ad hoc queries over a sales warehouse', 'queries per hour at a database size'], ['TPC-DS', 'Decision support with a richer schema and many more queries', 'queries per hour']] },
      'TPC-C is the classic OLTP benchmark. Its mix is fixed (new orders about 45%, payments about 43%, and three small kinds of transaction), every transaction has a response-time limit, and only the new-order transactions are counted in tpmC: a system cannot score by doing only the cheap ones.',
      { predict: { q: 'A system runs a TPC-C-like mix for 10 minutes and completes 40,000 transactions, 45% of them new orders. What is its tpmC?', options: ['1,800', '4,000', '18,000'], answer: 0, explain: '45% of 40,000 is 18,000 new orders, in 10 minutes: 1,800 per minute. The other 22,000 transactions are required work, but they are not counted.' }, sql: 'select 40000 * 0.45 / 10 as tpmc;' },
      { view: 'tuning', label: 'Open the Tuning view and run its benchmark' },
      { steps: ['In the Tuning view, scroll to *Benchmark: new-order transactions*. Open *One transaction* to read what each client runs: a small TPC-C-like new order.', 'Press **Run the benchmark**. It runs the transactions from 1, 2, 4 and 8 clients, under READ COMMITTED and under SERIALIZABLE, and plots commits per step, aborts and lock waits.', 'Find where throughput stops growing as clients are added, and compare the aborts of the two isolation levels: serializable buys its guarantee with retries.'] },
      { h: 'One transaction of a mix' },
      'A new-order-like transaction for the Theatre: a patron books two seats for a performance, and the patron earns loyalty points for it. It is short, touches a few rows by key, and must never leave a booking without its points. Here it is, rolled back so the data stays as it is:',
      { sql: "begin;\ninsert into booking values (9001, 17, 150, 2, 64.00, null);\nupdate patron set points = points + 64 where patron_id = 17;\nselect patron_id, points from patron where patron_id = 17;\nrollback;" },
      'Benchmarks of this kind measure **throughput** and **response time** together: more clients raise throughput until some resource saturates, and then only the waiting time grows.',
      'When a system runs several kinds of work, an average of throughputs can mislead. If two transaction kinds run at 100 and at 1 per second, running one of each takes 1.01 seconds: the fair average rate is the **harmonic mean**, 2 / (1/100 + 1/1) ≈ 1.98 per second, not the arithmetic mean of 50.5.',
      { sql: 'select 2 / (1.0 / 100 + 1.0 / 1) as harmonic_mean,\n       (100 + 1) / 2.0 as arithmetic_mean;' },
      { h: 'Standards' },
      'Standards let one application, and one programmer\'s knowledge, move between systems.',
      { list: ['**SQL** is an ANSI and ISO standard: SQL-86 and SQL-89, the much larger SQL-92, SQL:1999 (recursive queries, triggers, object-relational types), SQL:2003 (window functions, XML), and later editions adding temporal tables (2011), JSON (2016) and property-graph queries (2023). Every product implements a dialect: the core of the standard plus extensions.', '**ODBC** and **JDBC** are standard call interfaces: a program opens a connection, sends SQL and reads results the same way whichever database is behind the driver.', '**Distributed transactions** have a standard too: the X/Open XA interface, which carries two-phase commit between a transaction manager and the databases (chapter 23).'] },
      { tip: 'Kwery follows PostgreSQL\'s dialect, which keeps close to the SQL standard. The Reference panel says, for each statement, what is standard and what is an extension.' },
    ],
  });

  // ---- exercises --------------------------------------------------------------------------------------------------
  C.exercise({
    id: 'ex25-index-fit', chapter: 25, level: 2, kind: 'dml', title: 'The index this query needs',
    text: ['This query runs thousands of times a day:', { sql: "select perf_id, price\nfrom performance\nwhere prod_id = 'PR101' and perf_date >= date '2024-10-20';", run: false }, 'Create the one B+ tree index on `performance` that lets it find exactly the rows it needs in one index range scan: an equality on the first column, then a range on the second. Write the CREATE INDEX statement in the editor; any index name will do.'],
    hints: ['The equality column should come first, so that its matching entries are contiguous in the index.', 'Within one prod_id, entries are then ordered by the second column, so a range on it is one stretch of leaves.', "create index performance_prod_date on performance (prod_id, perf_date);"],
    ref: 'create index performance_prod_date on performance (prod_id, perf_date);',
    after: "select regexp_replace(indexdef, '^.* USING ', '') as definition from pg_indexes where tablename = 'performance' and indexname <> 'performance_pkey';",
  });
  C.exercise({
    id: 'ex25-tpmc', chapter: 25, level: 1, kind: 'answer', title: 'Reading a benchmark result',
    text: ['A TPC-C-like run lasts 30 minutes. The system completes 120,000 transactions; 44% of them are new orders. The hardware and software cost 270,000 dollars.', 'What is the price per tpmC, in dollars? Type one number, rounded to the nearest dollar.'],
    hints: ['Count only the new-order transactions.', '0.44 · 120,000 = 52,800 new orders in 30 minutes: 1,760 per minute.', '270,000 / 1,760 ≈ 153 dollars per tpmC.'],
    solution: '153', wrongs: ['68', '2.25', '4000'], ref: 'tpmC = 0.44 · 120,000 / 30 = 1,760; price per tpmC = 270,000 / 1,760 ≈ 153 dollars.',
    check: kit.number(153.4, 0.6),
  });
  C.exercise({
    id: 'ex25-harmonic', chapter: 25, level: 2, kind: 'answer', title: 'Averaging throughputs',
    text: ['A system runs two kinds of transaction, one at 200 per second and one at 50 per second, in equal numbers.', 'What is its throughput, in transactions per second, for the mix? Type one number with one decimal.'],
    hints: ['Time how long one transaction of each kind takes together.', '1/200 + 1/50 = 0.005 + 0.02 = 0.025 seconds for two transactions.', 'Two transactions per 0.025 seconds is the harmonic mean: 80.0 per second (not 125).'],
    solution: '80.0', wrongs: ['125', '100', '62.5'], ref: '2 / (1/200 + 1/50) = 2 / 0.025 = 80.0 transactions per second.',
    check: kit.number(80, 0.05),
  });
})(typeof window !== 'undefined' ? window : globalThis);
