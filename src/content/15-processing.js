// Chapter 15: query processing. Measuring cost, selection, external sorting, the join algorithms, the other
// operations, and pipelining against materialization, on the engine's own operators.
(function (root) {
  'use strict';
  const K = root.K;
  const C = K.Content;
  const P = () => C.phys;
  const num = (truth, opts) => (app, a) => P().number(truth, opts)(app, a);

  // the two relations of the join lessons: r is small (11 pages), s is wide and larger than the buffer pool (140 pages)
  const RS = "drop table if exists r;\ndrop table if exists s;\ncreate table r as\n  select i as a, md5(i::text) as pad from generate_series(1, 600) i;\ncreate table s as\n  select i as id, (i % 600) + 1 as a, repeat('s', 400) as pad\n  from generate_series(1, 1260) i;\nanalyze r;\nanalyze s;\ncheckpoint;\nselect relname, relpages, reltuples from pg_class where relname in ('r', 's');";
  const BIG = "drop table if exists big;\ncreate table big as\n  select i as id, (i * 7919) % 2400 as r, i % 50 as grp, repeat('x', 950) as pad\n  from generate_series(1, 2400) i;\ncreate index big_id on big (id);\ncreate index big_r on big (r);\ncreate index big_grp on big (grp);\nanalyze big;\ncheckpoint;";
  /** the access path EXPLAIN shows first for a query, in a fresh database with BIG */
  const firstOp = (sql) => {
    const s = P().fresh(BIG);
    const top = s.exec('explain ' + sql)[0].rows.map((r) => r[0]);
    const line = top.find((l) => /Scan/.test(l)) || top[0];
    return line;
  };
  const pathOf = (text) => {
    const t = String(text || '').toLowerCase().replace(/--[^\n]*/g, ' ');
    if (/bitmap/.test(t)) return 'bitmap';
    if (/index\s*-?\s*only/.test(t)) return 'indexonly';
    if (/index/.test(t)) return 'index';
    if (/seq|sequential|linear|full\s*(table)?\s*scan|table\s*scan|file\s*scan/.test(t)) return 'seq';
    return null;
  };
  const pathCheck = (sql) => (app, a) => {
    const mine = pathOf(a);
    if (!mine) return { ok: false, message: 'Type the name of an access path, for example `Seq Scan`, `Index Scan` or `Bitmap Heap Scan`.' };
    const line = firstOp(sql);
    const truth = pathOf(line.replace(/using \S+|on \S+/g, ''));
    return mine === truth ? { ok: true, message: 'Right: the planner chose `' + line.trim().replace(/\s+\(cost.*$/, '').replace(/^->\s*/, '') + '`.' } : { ok: false, message: 'That is not the path the planner chooses. Estimate how many rows match, and how many blocks they lie on.' };
  };

  C.lesson({
    id: 'qp-cost', chapter: 15, title: 'Measuring the cost of a query', minutes: 10,
    summary: 'Query processing is parsing, optimizing and evaluating. Its cost is counted in block transfers and seeks, because the disk dominates; Kwery reports both for every run.',
    body: [
      'A query goes through three steps: **parsing and translation** into relational algebra, **optimization** into an evaluation plan (an algebra expression annotated with an algorithm for each operator), and **evaluation** of that plan. This chapter is about the algorithms; the next about choosing among them.',
      'The cost of an algorithm could include disk accesses, CPU time and, in a parallel system, communication. For a disk-based database the usual cost model counts only disk I/O, in two kinds:',
      { list: ['**block transfers**, t_T each (0.15 ms for a 4 KB block on Kwery\'s magnetic disk)', '**seeks**, t_S each (6 ms here): every time the next block read is not the one right after the last'] },
      'So an operation that transfers b blocks with S seeks costs b · t_T + S · t_S. The formulas usually assume the worst case: the buffer holds only the few blocks the algorithm needs, and nothing is already in memory. A real buffer pool often does better, which is why measured costs can be lower than the formula.',
      { def: 'Response time and resource consumption.', text: 'The time until the answer arrives can be shortened by using several disks at once, without reducing the total work. Optimizers usually minimize total resource consumption, which is what the formulas add up.' },
      { sql: "drop table if exists big;\ncreate table big as\n  select i as id, (i * 7919) % 2400 as r, repeat('x', 950) as pad\n  from generate_series(1, 2400) i;\ncheckpoint;\nselect relpages from pg_class where relname = 'big';" },
      'Read the whole table and look at the line **Simulated I/O**:',
      { sql: 'explain analyze select count(*) from big;', note: 'One seek and 600 transfers: 6 + 600 · 0.15 = 96 ms, exactly what the line reports. The **Buffer pool** line says all 600 were misses.' },
      { predict: { q: 'The table is 600 blocks; the buffer pool has fewer frames than that. Run the same statement again. What happens?', options: ['All 600 blocks are read from disk again', 'All 600 are buffer hits now', 'Half are hits'], answer: 0, explain: 'Under LRU, a scan larger than the pool evicts its own early blocks before it finishes, so the next scan finds none of the blocks it needs first. The cost formulas\' worst-case assumption is exactly right for such scans.' }, sql: 'explain analyze select count(*) from big;' },
      { view: 'plan', label: 'Open the plan view' },
      { steps: ['Run the statement once more with the plan view open and click the **Sequential scan** box.', 'The box below the tree shows the cost formula, t_S + b_r · t_T, with this table\'s numbers in it.', 'Estimated costs in plans are in the same milliseconds, plus a small CPU charge per row.'] },
      { tip: 'Settings can switch a new database to the SSD model, where t_S is 0.1 ms and t_T is a few microseconds. Run the same statements there to see how much the balance between seeks and transfers changes.' },
      { sql: 'drop table big;' },
    ],
  });

  C.lesson({
    id: 'qp-selection', chapter: 15, title: 'Selection: scans, index scans and bitmaps', minutes: 14,
    summary: 'A selection can scan the whole file, use an index once, or combine several indexes. Which is cheapest depends on how many rows match and where they lie.',
    body: [
      'The ways to evaluate a selection, with what each costs and how EXPLAIN names it. Each cost formula just counts the visits: every node of the index on the way down is one random block read (a seek and a transfer), and so is every record fetched from a place of its own; records that lie together cost one seek and then a transfer per block.',
      { table: [['Way', 'When', 'Cost (h_i: index height, b: blocks, n: matching records)', 'In EXPLAIN'],
        ['Linear scan', 'always possible', 't_S + b_r · t_T (half of the blocks on average for an equality on a key, stopping at the match)', 'Seq Scan'],
        ['Clustering index, equality on a key', 'one record', '(h_i + 1) · (t_T + t_S): one read per level, one for the record', 'Index Scan'],
        ['Clustering index, equality on a non-key', 'records in b consecutive blocks', 'h_i · (t_T + t_S) + t_S + b · t_T: down the tree, then one sweep', 'Index Scan'],
        ['Secondary index, equality', 'each record anywhere', '(h_i + n) · (t_T + t_S): every record its own random read', 'Index Scan'],
        ['Either index, a range', 'from the first match on, as above', 'as above, n = matching records', 'Index Scan'],
        ['Several indexes, intersecting pointers', 'a conjunction', 'one index pass each, then only the blocks in the intersection', 'Bitmap Heap Scan over BitmapAnd']] },
      'A **bitmap heap scan** is a middle way for secondary indexes: get all matching row pointers from the index first, sort them by block, then read each needed block once, in order. It avoids reading a block twice and turns random reads into a sweep across the file.',
      { sql: "drop table if exists big;\ncreate table big as\n  select i as id, (i * 7919) % 2400 as r, i % 50 as grp, repeat('x', 950) as pad\n  from generate_series(1, 2400) i;\ncreate index big_id on big (id);\ncreate index big_r on big (r);\ncreate index big_grp on big (grp);\nanalyze big;\ncheckpoint;", note: '`id` follows the file order (clustered), `r` is scrambled, `grp` cycles through 50 values.' },
      'Three selections, three different plans:',
      { sql: 'explain select pad from big where id between 101 and 140;\nexplain select pad from big where r < 400;\nexplain select pad from big where r < 300 and grp = 7;' },
      { predict: { q: 'The second query, `r < 400`, matches one row in six. Why does the planner not use the index on `r`?', options: ['400 random fetches cost far more than reading all 600 blocks in order', 'An index cannot be used for a range', 'The index on r is not up to date'], answer: 0, explain: '400 · (t_S + t_T) is about 2,460 ms against 96 ms for the whole file. A secondary index pays off only when very few rows match; a clustered one (the `id` query) pays off for whole ranges.' } },
      'The third query finds about 300 rows by `r` and 48 by `grp`, but only about 6 satisfy both. The bitmap scan intersects the two sets of row pointers and reads only those blocks.',
      { view: 'plan', label: 'Open the plan view' },
      { steps: ['Run the third query with the plan view open, then choose the tab **What the optimizer tried**.', 'The table **access paths for big** lists every path the planner costed: the sequential scan, an index scan and a bitmap scan per index, and the BitmapAnd.', 'The cheapest one is marked; compare its cost with the sequential scan\'s.'] },
      'A disjunction (`or`) would need the union of the pointer sets. Kwery\'s planner does not build that union; it reads the table instead:',
      { sql: 'explain select pad from big where r < 30 or grp = 7;' },
      { tip: 'Measure instead of trusting estimates: run any of these with `explain analyze` and compare the Simulated I/O lines.' },
      { sql: 'drop table big;' },
    ],
  });

  C.lesson({
    id: 'qp-sorting', chapter: 15, title: 'External sort-merge', minutes: 12,
    summary: 'Sorting a file larger than memory: sort it in memory-sized runs, then merge M − 1 runs at a time until one is left. The number of passes is a logarithm with a very large base.',
    body: [
      'Sorting is needed for ORDER BY, for merge joins, for duplicate elimination and grouping by sorting. A relation that fits in memory is sorted with quicksort. One that does not, with **external sort-merge**, given M blocks of memory:',
      { steps: ['**Create runs.** Read M blocks of the relation, sort them in memory, write them out as a sorted **run**. Repeat until the relation is used up: ⌈b_r / M⌉ runs.', '**Merge.** With one input block per run and one output block, merge M − 1 runs into one longer run. Each merge **pass** reduces the number of runs by a factor of M − 1.', 'Repeat merge passes until one run is left: ⌈log_(M−1)(b_r / M)⌉ passes.'] },
      'Each pass reads and writes every block once. With the run creation, and not counting the final write of the result:',
      { def: 'Block transfers.', text: 'b_r · (2 · ⌈log_(M−1)(b_r / M)⌉ + 1).' },
      { def: 'Seeks (one buffer block per run).', text: '2 · ⌈b_r / M⌉ + b_r · (2 · ⌈log_(M−1)(b_r / M)⌉ − 1). Giving each run several buffer blocks cuts the seeks at the cost of a smaller merge width.' },
      'In Kwery, M for sorts and joins is the setting `work_mem_pages`, 32 blocks by default. Make a relation and sort it with less and less memory:',
      { sql: "drop table if exists pile;\ncreate table pile as\n  select i as id, (i * 7919) % 8000 as r, i % 13 as grp\n  from generate_series(1, 8000) i;\nanalyze pile;\nexplain analyze select * from pile order by r;", note: 'The line **Sort Method** shows the runs and merge passes the cost model counted.' },
      { predict: { q: 'With `work_mem_pages = 8`, about 105 blocks to sort make 14 runs. How many merge passes follow?', options: ['2: merging 7 at a time gives 2 runs, then 1', '1: all 14 runs at once', '14'], answer: 0, explain: 'M − 1 = 7 runs merge at a time: 14 runs become 2 after one pass, and 1 after the second. ⌈log₇ 14⌉ = 2.' }, sql: 'set work_mem_pages = 8;\nexplain analyze select * from pile order by r;' },
      { sql: 'set work_mem_pages = 3;\nexplain analyze select * from pile order by r;\nreset work_mem_pages;', note: 'With three blocks, runs merge two at a time: 35 runs need 6 passes.' },
      { warn: 'One simplification in Kwery: the size of the sort input b is estimated from the number of rows and their declared columns (here about 105 blocks, while the table has 87 pages), so the runs follow the estimate. The runs are written to temporary pages and read back in each merge pass, and the Simulated I/O line counts those writes and reads too.' },
      'The logarithm has base M − 1, and M is normally hundreds or thousands of blocks. So even a very large relation needs one or two merge passes: with M = 1,000, one pass merges 999 runs of 1,000 blocks each, about a billion blocks of data.',
      { sql: 'drop table pile;' },
    ],
  });

  C.lesson({
    id: 'qp-nested-loops', chapter: 15, title: 'Joins: nested loops, block nested loops, indexed nested loops', minutes: 15,
    summary: 'The simplest joins compare every pair. Reading the outer relation a block at a time, or probing an index for each outer tuple, makes the same idea far cheaper.',
    body: [
      'To compute r ⋈θ s, the **nested-loop join** takes each tuple t_r of r (the **outer** relation), scans all of s (the **inner** relation) for tuples t_s satisfying θ, and outputs each matching pair. It works for any join condition. With only one block of each relation in memory, the worst case costs',
      { def: 'Nested loop.', text: 'n_r · b_s + b_r block transfers and n_r + b_r seeks.' },
      'If the smaller relation fits entirely in memory, use it as the inner one: then the cost drops to b_r + b_s transfers and 2 seeks.',
      { def: 'Block nested loop.', text: 'Take the outer relation a chunk of M − 2 blocks at a time, and scan the inner relation once per chunk: ⌈b_r / (M − 2)⌉ · b_s + b_r transfers and 2 · ⌈b_r / (M − 2)⌉ seeks. The outer relation should be the smaller one.' },
      { def: 'Indexed nested loop.', text: 'If the inner relation has an index on the join attribute, look each outer tuple up in it instead of scanning: b_r · (t_T + t_S) + n_r · c, where c is the cost of one lookup and fetch.' },
      'Two relations to join: `r` has 600 narrow rows on 11 pages, `s` has 1,260 wide rows on 140 pages, more than the buffer pool holds. Each `r` tuple matches two or three `s` tuples.',
      { sql: RS },
      'Kwery lets you force a join algorithm with `force_join` (the planner still chooses which input is the outer one). First the nested loop, with costs only, since it is slow to run:',
      { sql: "set force_join = 'NestLoopJoin';\nexplain select count(*) from r join s on r.a = s.a;", note: 'Its estimated cost is in the thousands of milliseconds.' },
      'Now the block nested loop with M = 6, so chunks of M − 2 = 4 blocks of `r`:',
      { predict: { q: 'How many times will the block nested loop scan `s`, and about how many blocks will it transfer in all?', options: ['3 scans: ⌈11 / 4⌉ · 140 + 11 = 431 blocks', '600 scans: once per tuple of r', '1 scan: 151 blocks'], answer: 0, explain: 'Eleven blocks of `r` in chunks of 4 make 3 chunks, and `s` is read once per chunk. The plan shows the inner scan with loops=3, and since `s` is larger than the buffer pool every rescan reads it from disk again: about 427 page reads.' }, sql: "set work_mem_pages = 6;\nset force_join = 'BlockNestLoopJoin';\nexplain analyze select count(*) from r join s on r.a = s.a;" },
      'Indexed nested loop needs an index on the inner relation\'s join attribute. Give both relations one, so either can be inner:',
      { sql: "create index s_a on s (a);\ncreate index r_a on r (a);\nset force_join = 'IndexNestLoopJoin';\nexplain analyze select count(*) from r join s on r.a = s.a;", note: 'Each of the 600 tuples of `r` descends the index on `s.a` and fetches its matches: many seeks, but no full scan of `s`.' },
      { view: 'plan', label: 'Open the plan view' },
      { steps: ['Run each forced join again with the plan view open and click the join box: the formula is filled in with b_r, b_s and n_r.', 'Note that the plan view\'s formula box assumes M = 32 for the block nested loop; with `work_mem_pages = 6` work it out by hand as above.', 'Compare the measured Simulated I/O of the three runs.'] },
      { warn: 'Kwery\'s tuple-at-a-time nested loop keeps the inner relation in memory after its first scan, so measured I/O is far below the formula\'s n_r · b_s. The formula is the worst case, when only one block of each relation fits.' },
      { sql: 'reset force_join;\nreset work_mem_pages;\ndrop table r;\ndrop table s;' },
    ],
  });

  C.lesson({
    id: 'qp-merge-hash', chapter: 15, title: 'Joins: merge join and hash join', minutes: 14,
    summary: 'For equi-joins there are much better ways: sort both inputs and merge them, or partition both by a hash function so that matching tuples land in the same partition.',
    body: [
      { h: 'Merge join' },
      'If both relations are sorted on the join attributes, one pass over each finds all matches: advance in the relation with the smaller current value, and when the values are equal, output the pairs of the two groups with that value (the group of the inner one must fit in memory).',
      { def: 'Merge join.', text: 'b_r + b_s block transfers, plus ⌈b_r / b_b⌉ + ⌈b_s / b_b⌉ seeks with b_b buffer blocks per relation; plus the cost of sorting any input not already sorted.' },
      { h: 'Hash join' },
      'Choose a hash function h on the join attributes. **Partition** both relations: each tuple goes to partition h(join value), written out to disk. Matching tuples now lie in partitions with the same number. Then, for each i, **build** an in-memory hash table on partition i of the smaller relation (the **build input**) and **probe** it with each tuple of partition i of the other (the **probe input**).',
      { def: 'Hash join.', text: '3 · (b_r + b_s) + 4 · n_h block transfers with n_h partitions: read and write both relations to partition them, read them again to join. If the build input fits in memory, no partitioning is needed and the cost is b_r + b_s.' },
      'If a build partition does not fit in memory, it is partitioned again with another hash function: **recursive partitioning**. If many tuples share one value, no hash function can split them: **hash-table overflow**, handled by an overflow strategy or by falling back to a block nested loop for that partition.',
      { sql: RS },
      { predict: { q: 'Which plan do you expect the planner to choose for `r ⋈ s` on `a`, left to itself?', options: ['A hash join with `r`, the smaller relation, as the build input', 'A merge join', 'A block nested loop'], answer: 0, explain: '`r` fits in memory easily, so the hash join reads each relation once: 151 blocks. Its hash table is built on `r`; EXPLAIN prints the build input under the **Hash** node.' }, sql: 'explain analyze select count(*) from r join s on r.a = s.a;' },
      { sql: "set force_join = 'MergeJoin';\nexplain analyze select count(*) from r join s on r.a = s.a;\nreset force_join;", note: 'The merge join also reads each relation once here. Neither input is stored in order, so each is sorted first; both fit in memory, so the plan shows quicksort.' },
      { steps: ['Open the plan view and click the **Hash join** box: the formula b_r + b_s, with the numbers, says the build input fits in memory.', 'Set `work_mem_pages` to 2 and explain the hash join again: the formula switches to the partitioned form 3 · (b_r + b_s) + 4 · n_h.'] },
      { view: 'plan', label: 'Open the plan view' },
      { h: 'Comparing them' },
      { table: [['Algorithm', 'Join conditions', 'Transfers (worst case)', 'Good when'],
        ['Nested loop', 'any', 'n_r · b_s + b_r', 'tiny inputs, or a non-equality condition'],
        ['Block nested loop', 'any', '⌈b_r / (M − 2)⌉ · b_s + b_r', 'the outer relation fits in memory or nearly'],
        ['Indexed nested loop', 'equality (or a range the index supports)', 'b_r + n_r · c', 'few outer tuples, an index on the inner'],
        ['Merge join', 'equality', 'b_r + b_s + sorting', 'inputs already sorted, or the output must be sorted'],
        ['Hash join', 'equality', '3 · (b_r + b_s) + 4 · n_h', 'large unsorted inputs']] },
      { tip: 'The same comparison on real data: switch to the **Theatre (large)** sample in Settings, where `patron` has 6,000 rows on 110 pages and `booking` 45,000 rows on 672 pages, and run `explain analyze select count(*) from patron p join booking b on p.patron_id = b.patron_id` under each `force_join`. The exercises of this chapter use those sizes.' },
      { sql: 'drop table r;\ndrop table s;' },
    ],
  });

  C.lesson({
    id: 'qp-other-ops', chapter: 15, title: 'Duplicates, projection, set operations, outer joins and aggregation', minutes: 10,
    summary: 'The remaining operators reuse the same two ideas, sorting and hashing: equal values brought together, either next to each other or into the same bucket.',
    body: [
      { list: ['**Duplicate elimination**: sort, and drop each tuple equal to the one before it; or hash, and keep a tuple only if its bucket does not already hold an equal one. Both can be folded into the run creation and merge passes of an external sort.', '**Projection**: project each tuple, then eliminate duplicates if the query says DISTINCT. SQL keeps duplicates otherwise.', '**Set operations** (∪, ∩, −): sort both inputs and merge them, or partition both with one hash function and, per partition, build a hash table on one and probe it with the other.', '**Outer joins**: a merge or hash join that also outputs, padded with nulls, the tuples of the preserved side that found no match.', '**Aggregation**: group by sorting or by hashing on the grouping attributes, keeping a running value per group (count, sum, min, max; the average from sum and count).'] },
      'Ask the planner how it does each:',
      { sql: 'explain select distinct city from patron;\nexplain select city, count(*), avg(points) from patron group by city;' },
      { predict: { q: 'With `enable_hashagg` off, how will the same grouping be done?', options: ['By sorting on city and aggregating each group as it goes by (GroupAggregate)', 'It cannot be done without hashing', 'By a nested loop over the cities'], answer: 0, explain: 'Grouping by sorting brings each group\'s tuples together, so one pass computes each group\'s aggregates. Kwery\'s GroupAggregate and Unique operators sort their input themselves.' }, sql: 'set enable_hashagg = off;\nexplain select city, count(*), avg(points) from patron group by city;\nexplain select distinct city from patron;\nreset enable_hashagg;' },
      'Set operations and outer joins:',
      { sql: 'explain select patron_id from patron except select patron_id from booking;\nexplain select city from patron union select city from venue;\nexplain select city from patron union all select city from venue;' },
      { sql: 'explain select p.name, b.perf_id from patron p left join booking b on p.patron_id = b.patron_id;\nexplain select p.name, b.perf_id from patron p full join booking b on p.patron_id = b.patron_id;' },
      { tip: '`union all` needs no duplicate elimination at all: the plan just appends one input to the other. When you know there are no duplicates, saying so saves a hash or a sort.' },
    ],
  });

  C.lesson({
    id: 'qp-pipelining', chapter: 15, title: 'Evaluating expressions: materialization and pipelining', minutes: 10,
    summary: 'An operator can write its whole result out for the next one to read, or pass each tuple on as soon as it is made. Pipelining saves the writes, and lets a query stop early.',
    body: [
      'A plan is a tree of operators. **Materialized evaluation** computes the lowest operators first, writes each result to a temporary relation, and feeds it to the operator above. The cost is the sum of the operators\' costs plus writing and reading every intermediate result.',
      '**Pipelined evaluation** passes tuples up as they are produced. Kwery\'s executor, like most, is **demand-driven**: each operator offers *open*, *next* and *close*; the top operator asks its child for the next tuple, which asks its own child, and so on. (A **producer-driven** pipeline pushes tuples upward into buffers instead.)',
      'Some operators cannot pass anything on before they have seen all their input: a **sort**, the **build** side of a hash join, a hash **aggregation**. These are **blocking** operators; they break the pipeline into stages.',
      'You can see demand-driven evaluation at work with a LIMIT, which simply stops asking:',
      { sql: 'explain analyze select * from booking limit 5;', note: 'The scan produced only the rows the Limit asked for and touched 1 page.' },
      { predict: { q: 'Now add `order by paid`. How many pages of `booking` must be read before the first row comes out?', options: ['All 17: the sort cannot output anything before it has seen every row', 'One, as before', 'Five'], answer: 0, explain: 'The sort is blocking. Only after its input is exhausted does it know which row is smallest. The Limit above it still stops after 5 rows, but the scan below has already read everything.' }, sql: 'explain analyze select * from booking order by paid limit 5;' },
      'A hash join is half blocking: the build input is read entirely first, then the probe input streams through.',
      { sql: 'explain analyze\nselect b.booking_id, p.name from booking b join patron p on p.patron_id = b.patron_id\nlimit 3;', note: 'The build side was read in full; the probe side only as far as needed.' },
      { view: 'plan', label: 'Open the plan view' },
      { steps: ['With the plan view open, run `select name, points from patron where points > 1000 order by name;`.', 'At the top of the dock set the step selector to **Step: tuples** and step forward: each step lights the operator that produced a row, and the edges count the rows that have passed.', 'Watch the scan and the selection pass rows up one at a time, and the sort take all of them before giving any back.'] },
      { tip: 'Pipelining is not always cheapest, though: an intermediate result used twice may be worth materializing once. Common table expressions are a place where that choice arises.' },
    ],
  });

  // ---- exercises -------------------------------------------------------------------------------------------------------------
  // The exercises use a disk of their own, different from Kwery's (t_S = 5 ms, t_T = 0.2 ms), and the sizes of the
  // Theatre (large) sample: patron 6,000 rows on 110 blocks, booking 45,000 rows on 672 blocks.
  const DISK = 'Take t_S = 5 ms and t_T = 0.2 ms.';
  C.exercise({
    id: 'ex15-seq', chapter: 15, level: 1, kind: 'number', title: 'A linear scan',
    text: ['In Theatre (large), `patron` occupies 110 contiguous blocks. ' + DISK + ' How many milliseconds does a linear scan of it cost?'],
    hints: ['Position the head once, then transfer every block.', 'Cost: t_S + b_r · t_T.', 'Worked answer: 5 + 110 · 0.2 = **27** ms.'],
    check: num(27, { tol: 0.01, why: (v) => (Math.abs(v - 22) < 0.01 ? 'Add the one seek at the start.' : null) }), solution: 27,
    wrongs: ['22', '577', '32'],
  });
  C.exercise({
    id: 'ex15-linear-key', chapter: 15, level: 1, kind: 'number', title: 'Looking for one patron by scanning',
    text: ['The same 110 blocks of `patron` are scanned for the one patron with a given `patron_id`, and the scan stops as soon as it finds the row. ' + DISK + ' On average, how many milliseconds does it take?'],
    hints: ['On average the row is half way through the file.', 'Cost: t_S + (b_r / 2) · t_T.', 'Worked answer: 5 + 55 · 0.2 = **16** ms.'],
    check: num(16, { tol: 0.01 }), solution: 16,
    wrongs: ['27', '11', '60'],
  });
  C.exercise({
    id: 'ex15-a2', chapter: 15, level: 1, kind: 'number', title: 'Equality on a key through a B+ tree',
    text: ['A B+ tree on `patron_id` of height h_i = 3 finds the single patron with a given id. Each node on the way down and the fetch of the row is a random read: a seek and a transfer. ' + DISK + ' How many milliseconds does it take?'],
    hints: ['Three node reads, plus one to fetch the row.', 'Cost: (h_i + 1) · (t_T + t_S).', 'Worked answer: 4 · 5.2 = **20.8** ms.'],
    check: num(20.8, { tol: 0.01, why: (v) => (Math.abs(v - 15.6) < 0.01 ? 'Fetching the row itself is one more random read.' : null) }), solution: 20.8,
    wrongs: ['15.6', '20', '16.4'],
  });
  C.exercise({
    id: 'ex15-a4', chapter: 15, level: 2, kind: 'number', title: 'A secondary index with many matches',
    text: ['In Theatre (large) a performance has about 19 bookings (45,000 bookings over 2,400 performances). A secondary B+ tree on `booking.perf_id`, of height 3, finds the 19 bookings of one performance, each on a different block. ' + DISK + ' What does the selection cost in milliseconds?'],
    hints: ['Descend the tree once, then fetch each booking with a seek of its own.', 'Cost: (h_i + n) · (t_T + t_S).', 'Worked answer: (3 + 19) · 5.2 = **114.4** ms.'],
    check: num(114.4, { tol: 0.01 }), solution: 114.4,
    wrongs: ['98.8', '19', '94.3'],
  });
  C.exercise({
    id: 'ex15-a3', chapter: 15, level: 2, kind: 'number', title: 'A clustering index on a non-key',
    text: ['Suppose `booking` were stored sorted on `perf_id`, with a clustering B+ tree of height 3 on it. The bookings of one busy performance then fill 4 consecutive blocks. ' + DISK + ' What does an equality selection on that `perf_id` cost, in milliseconds?'],
    hints: ['Descend the tree, then one seek to the first matching block and a transfer for each of the 4 blocks.', 'Cost: h_i · (t_T + t_S) + t_S + b · t_T.', 'Worked answer: 3 · 5.2 + 5 + 4 · 0.2 = **21.4** ms.'],
    check: num(21.4, { tol: 0.01 }), solution: 21.4,
    wrongs: ['15.6', '36.4', '16.8'],
  });
  C.exercise({
    id: 'ex15-path-bitmap', chapter: 15, level: 2, kind: 'text', title: 'Which access path? (1)',
    text: ['The checker builds the table of the selection lesson:', { sql: "create table big as\n  select i as id, (i * 7919) % 2400 as r, i % 50 as grp, repeat('x', 950) as pad\n  from generate_series(1, 2400) i;\ncreate index big_id on big (id);\ncreate index big_r on big (r);\ncreate index big_grp on big (grp);\nanalyze big;", run: false }, 'Which access path does the planner choose for `select pad from big where r < 300 and grp = 7`? Type its name (for example `Seq Scan`), then check. Reason first; run `explain` afterwards to confirm.'],
    hints: ['About 300 rows have r < 300, and 48 have grp = 7, each spread over the file.', 'Only about 6 rows satisfy both. Can the planner find those without fetching the others?', 'Worked answer: a **Bitmap Heap Scan** over a BitmapAnd of the two indexes.'],
    check: pathCheck('select pad from big where r < 300 and grp = 7'), solution: 'Bitmap Heap Scan', wrongs: ['Seq Scan', 'Index Scan'],
  });
  C.exercise({
    id: 'ex15-path-clustered', chapter: 15, level: 2, kind: 'text', title: 'Which access path? (2)',
    text: ['On the same table, which access path does the planner choose for `select pad from big where id between 101 and 400`? 300 rows match, the same number as `r < 300` matches. Type its name.'],
    hints: ['The rows were inserted in id order, four to a block.', 'The 300 matching rows lie on about 75 consecutive blocks.', 'Worked answer: an **Index Scan** using big_id: the index acts as a clustering index, so the fetches are nearly sequential.'],
    check: pathCheck('select pad from big where id between 101 and 400'), solution: 'Index Scan', wrongs: ['Seq Scan', 'Bitmap Heap Scan'],
  });
  C.exercise({
    id: 'ex15-sort-runs', chapter: 15, level: 1, kind: 'number', title: 'Initial runs',
    text: ['External sort-merge sorts the 672 blocks of `booking` (Theatre, large) on `paid`, with M = 9 blocks of memory. How many runs does the run-creation stage produce?'],
    hints: ['Each run is as long as memory: M blocks, sorted in memory and written out.', 'Divide and round up: the last run is shorter.', 'Worked answer: ⌈672 / 9⌉ = **75** runs.'],
    check: num(75, { why: (v) => (v === 74 ? 'Round up: the last few blocks make a run too.' : null) }), solution: 75,
    wrongs: ['74', '84', '9'],
  });
  C.exercise({
    id: 'ex15-sort-passes', chapter: 15, level: 2, kind: 'number', title: 'Merge passes',
    text: ['The 75 runs of the previous exercise are merged with M = 9 blocks of memory. How many merge passes are needed?'],
    hints: ['One block is kept for output, so M − 1 = 8 runs merge at a time.', 'After one pass: ⌈75 / 8⌉ = 10 runs. After two: ⌈10 / 8⌉ = 2.', 'Worked answer: the third pass merges the last 2 runs into 1: **3** passes.'],
    check: num(3, { why: (v) => (v === 2 ? 'Two passes leave 2 runs, not 1.' : null) }), solution: 3,
    wrongs: ['2', '4', '10'],
  });
  C.exercise({
    id: 'ex15-sort-transfers', chapter: 15, level: 2, kind: 'number', title: 'Transfers of the whole sort',
    text: ['For the same sort (672 blocks, M = 9, 3 merge passes), how many block transfers does external sort-merge take, not counting the final write of the result?'],
    hints: ['Run creation reads and writes every block once; so does each merge pass, except that the last pass\'s write is not counted.', 'That is one read and one write per stage, minus the last write: b_r · (2 · passes + 1).', 'Worked answer: 672 · (2 · 3 + 1) = **4,704** transfers.'],
    check: num(4704, { why: (v) => (v === 5376 ? 'Leave out the final write of the result.' : null) }), solution: 4704, solutionText: '4,704',
    wrongs: ['5376', '4032', '672'],
  });
  const SIZES = 'In the Theatre (large) sample, `patron` has n = 6,000 tuples on b = 110 blocks, and `booking` has n = 45,000 tuples on b = 672 blocks. They are joined on `patron_id`.';
  C.exercise({
    id: 'ex15-nlj', chapter: 15, level: 1, kind: 'number', title: 'Nested loop, worst case',
    text: [SIZES, 'How many block transfers does a nested-loop join with `patron` as the outer relation take in the worst case (one block of each relation in memory)?'],
    hints: ['For every patron, the whole of booking is read again.', 'Add the one reading of patron itself: n_patron · b_booking + b_patron.', 'Worked answer: 6000 · 672 + 110 = **4,032,110** transfers.'],
    check: num(4032110), solution: 4032110, solutionText: '4,032,110',
    wrongs: ['4950672', '4032000', '782'],
  });
  C.exercise({
    id: 'ex15-nlj-swap', chapter: 15, level: 2, kind: 'number', title: 'Nested loop the other way round',
    text: [SIZES, 'And with `booking` as the outer relation?'],
    hints: ['Now every booking reads all of patron.', 'n_booking · b_patron + b_booking.', 'Worked answer: 45000 · 110 + 672 = **4,950,672** transfers: more, because there are so many more bookings to loop over, even though patron is smaller to reread.'],
    check: num(4950672), solution: 4950672, solutionText: '4,950,672',
    wrongs: ['4032110', '4950000', '782'],
  });
  C.exercise({
    id: 'ex15-bnlj', chapter: 15, level: 2, kind: 'number', title: 'Block nested loop',
    text: [SIZES, 'With M = 12 blocks of memory, how many block transfers does a block nested-loop join with `patron` as the outer relation take?'],
    hints: ['Two blocks are kept for the inner scan and the output, so M − 2 = 10 blocks of patron are read at a time.', 'There are ⌈110 / 10⌉ = 11 chunks, and booking is read once per chunk.', 'Worked answer: 11 · 672 + 110 = **7,502** transfers.'],
    check: num(7502), solution: 7502, solutionText: '7,502',
    wrongs: ['7392', '6830', '782'],
  });
  C.exercise({
    id: 'ex15-bnlj-seeks', chapter: 15, level: 2, kind: 'number', title: 'Seeks of the block nested loop',
    text: [SIZES, 'With M = 12, how many seeks does the block nested-loop join (`patron` outer) need?'],
    hints: ['Each chunk needs one seek to read the chunk of patron and one to start scanning booking.', 'Formula: 2 · ⌈b_r / (M − 2)⌉.', 'Worked answer: 2 · 11 = **22** seeks.'],
    check: num(22), solution: 22,
    wrongs: ['11', '20', '24'],
  });
  C.exercise({
    id: 'ex15-merge', chapter: 15, level: 1, kind: 'number', title: 'Merge join of sorted inputs',
    text: [SIZES, 'Suppose both are already sorted on `patron_id`. How many block transfers does a merge join take?'],
    hints: ['Each block of each relation is read once.', 'No sorting is needed.', 'Worked answer: 110 + 672 = **782** transfers.'],
    check: num(782), solution: 782,
    wrongs: ['2346', '1564', '672'],
  });
  C.exercise({
    id: 'ex15-hash', chapter: 15, level: 2, kind: 'number', title: 'Partitioned hash join',
    text: [SIZES, 'Memory is too small to hold `patron`, so a hash join partitions both relations into n_h = 8 partitions (no recursive partitioning). Using 3 · (b_r + b_s) + 4 · n_h, how many block transfers does it take?'],
    hints: ['Partitioning reads both relations and writes them back out; the build and probe phase reads them once more: three times 782.', 'Each partition may end in a partly filled block, written and read once for each relation: 4 · n_h.', 'Worked answer: 3 · 782 + 4 · 8 = 2346 + 32 = **2,378** transfers.'],
    check: num(2378), solution: 2378, solutionText: '2,378',
    wrongs: ['2346', '2414', '782'],
  });
  C.exercise({
    id: 'ex15-inlj', chapter: 15, level: 3, kind: 'number', title: 'Indexed nested loop',
    text: [SIZES, '`patron` has a B+ tree on its key `patron_id`, of height 2, and every booking matches exactly one patron, so one lookup costs c = (2 + 1) · (t_T + t_S). ' + DISK + ' What does the indexed nested-loop join with `booking` as the outer relation cost, in milliseconds?'],
    hints: ['Reading booking costs b_booking · (t_T + t_S) in the worst case.', 'c = 3 · 5.2 = 15.6 ms, once per booking.', 'Worked answer: 672 · 5.2 + 45000 · 15.6 = 3,494.4 + 702,000 = **705,494.4** ms, over eleven minutes: this is why the planner prefers a hash join here.'],
    check: num(705494.4, { tol: 0.5 }), solution: 705494.4, solutionText: '705,494.4',
    wrongs: ['702000', '3494.4', '532494.4'],
  });
  C.exercise({
    id: 'ex15-force-merge', chapter: 15, level: 2, title: 'Make it a merge join',
    text: ['The checker creates two tables: a run of shows, each in one of twenty halls, and the halls.', { sql: "create table show_run as select i as run_id, i % 20 as hall_no from generate_series(1, 400) i;\ncreate table hall as select i as hall_no, 'Hall ' || i as hall_name from generate_series(0, 19) i;", run: false }, 'Write statements that end with a query listing `run_id` and `hall_name` for every show, such that the planner evaluates the join with a merge join. Use the `enable_*` settings (not `force_join`).'],
    hints: ['Without help the planner prefers a hash join here.', 'Switch off the algorithms you do not want: `set enable_hashjoin = off;` and the nested loops with `set enable_nestloop = off;`.', "For example: `set enable_hashjoin = off; set enable_nestloop = off; select r.run_id, h.hall_name from show_run r join hall h on r.hall_no = h.hall_no;`"],
    ref: 'set enable_hashjoin = off;\nset enable_nestloop = off;\nselect r.run_id, h.hall_name from show_run r join hall h on r.hall_no = h.hall_no;',
    check: (app, a) => (/force_join/i.test(a || '') ? { ok: false, message: 'Do it with the enable_* settings, not force_join.' } : P().sqlPlan({ setup: "create table show_run as select i as run_id, i % 20 as hall_no from generate_series(1, 400) i; create table hall as select i as hall_no, 'Hall ' || i as hall_name from generate_series(0, 19) i; analyze show_run; analyze hall", ref: 'select r.run_id, h.hall_name from show_run r join hall h on r.hall_no = h.hall_no', plan: /Merge Join/, planMessage: 'The rows are right, but the join is not a merge join yet.' })(app, a)),
    wrongs: ['select r.run_id, h.hall_name from show_run r join hall h on r.hall_no = h.hall_no;', "set force_join = 'MergeJoin'; select r.run_id, h.hall_name from show_run r join hall h on r.hall_no = h.hall_no;", 'select 1'],
  });
  C.exercise({
    id: 'ex15-agg', chapter: 15, level: 1, kind: 'text', title: 'Aggregation without hashing',
    text: ['With `set enable_hashagg = off`, which operator does EXPLAIN show for `select genre, count(*) from production group by genre`? Type its name as EXPLAIN prints it.'],
    hints: ['Without a hash table, groups must be brought together another way.', 'Sorting on genre puts each group\'s tuples next to each other.', 'Worked answer: **GroupAggregate**.'],
    check: (app, a) => {
      const s = P().theatre(app, 'set enable_hashagg = off');
      const top = s.exec('explain select genre, count(*) from production group by genre')[0].rows[0][0].replace(/\s+\(cost.*$/, '').trim();
      const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z]/g, '');
      return norm(a) && norm(a) === norm(top) ? { ok: true, message: 'Right: ' + top + '.' } : { ok: false, message: norm(a) ? 'Not that one. Run the EXPLAIN and read the top line.' : 'Type the operator name in the editor.' };
    },
    solution: 'GroupAggregate', wrongs: ['HashAggregate', 'Sort'],
  });
})(typeof window !== 'undefined' ? window : globalThis);
