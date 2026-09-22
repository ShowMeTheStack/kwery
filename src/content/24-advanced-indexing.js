// Chapter 24: advanced indexing techniques. Bloom filters and how to size them, LSM trees and write
// amplification, bitmap indices, and the spatial indices: k-d trees, quadtrees and R-trees.
(function (root) {
  'use strict';
  const C = root.K.Content;
  const kit = C.kit1726;
  const lesson = kit.lesson;

  lesson({
    id: 'aix-bloom', chapter: 24, title: 'Bloom filters: sizing them and using them', minutes: 12,
    summary: 'A Bloom filter answers "certainly not here" or "maybe here" from a few bits per key. Choose the bits per key for the false-positive rate you can live with, and watch an LSM index use its filters.',
    body: [
      'Chapter 14 met the Bloom filter as a helper of the LSM tree. Here we look at it as a tool in its own right, and ask the question an engineer actually faces: **how many bits do I need?**',
      { def: 'Bloom filter.', text: 'An array of m bits, all 0 at first, and k hash functions. Inserting a key sets the k bits its hashes name. A lookup checks the same k bits: one 0 proves the key was never inserted; all 1s means the key may be there.' },
      'Two facts follow from that definition. There are **no false negatives**: an inserted key always finds its own bits set. And a plain Bloom filter **cannot delete**: clearing a key\'s bits could clear bits another key also uses. (A *counting* Bloom filter keeps a small counter instead of each bit, so a delete can decrement it.)',
      { h: 'The false-positive rate' },
      'After n keys, a given bit is still 0 with probability about e^(−kn/m). A key that was never inserted is a false positive when all k of its bits happen to be 1:',
      { def: 'p ≈ (1 − e^(−kn/m))^k', text: 'and the k that makes p smallest is k = (m/n) · ln 2.' },
      'Put the best k back into the formula and something useful falls out: the bits you need per key depend only on the rate you want, not on how many keys there are.',
      { def: 'm/n ≈ −ln p / (ln 2)²', text: '≈ 1.44 · log₂(1/p). About 4.8 bits per key for 10%, 9.6 for 1%, 14.4 for 0.1%.' },
      { predict: { q: 'You have a filter giving 1% false positives with the best k. You want 0.1% instead, for the same keys. Roughly how much bigger must the filter be?', options: ['About 1.5 times (from 9.6 to 14.4 bits per key)', '10 times', '100 times'], answer: 0, explain: 'Each factor of 10 in the rate costs a fixed number of bits per key, 1.44 · log₂ 10 ≈ 4.8. Going from 1% to 0.1% adds 4.8 bits to the 9.6 per key: half as big again, not ten times.' }, sql: "select round((-ln(0.01) / (ln(2) ^ 2))::numeric, 2) as bits_for_1_percent,\n       round((-ln(0.001) / (ln(2) ^ 2))::numeric, 2) as bits_for_0_1_percent;" },
      'The same arithmetic in a table: for a few target rates, the bits per key and the number of hash functions.',
      { sql: "select p as target_rate,\n       round((-ln(p) / (ln(2) ^ 2))::numeric, 1) as bits_per_key,\n       round(-ln(p) / ln(2)) as hash_functions\nfrom (values (0.1), (0.01), (0.001), (0.0001)) as t(p);" },
      { h: 'Try it in the lab' },
      { view: 'bloom', label: 'Open the Bloom filter lab' },
      { steps: ['Set **Bits m** to 128 and **Hash functions k** to 1. Press **+10 random keys** twice, so n = 20.', 'Read **FP by formula** and **FP measured**. Then press **Optimal k**: with m/n = 6.4, k becomes 4, and both rates drop.', 'Press **find a false positive**: the lab searches for a key that was never inserted but finds all its bits set. The verdict shows its k positions.', 'Set k to 12 and look at the chart **Choosing k**: too many hash functions fill the array with ones, and the rate rises again.'] },
      { h: 'Where filters save work' },
      'A filter pays off wherever a lookup is expensive and most lookups miss. Three places in this course:',
      { list: ['each sorted run of an **LSM tree** keeps a filter, so a lookup skips runs that cannot hold the key', 'a **distributed semijoin** (chapter 22) can ship a filter of join keys instead of the keys themselves', 'a **hash join** can test probe rows against a filter of the build side before touching the hash table'] },
      'Here is the first one in the engine. The table holds only even ids, and its LSM index keeps a Bloom filter of 10 bits per key in every run.',
      { sql: "drop table if exists reading;\ncreate table reading (id int, val int);\ninsert into reading select 2 * g, g % 100 from generate_series(1, 2000) g;\ncreate index reading_lsm on reading using lsm (id)\n  with (memtable_size = 16, size_ratio = 3, bloom_bits = 10);\nset enable_seqscan = off;\nexplain analyze select val from reading where id = 778;", note: 'A key that is there: the scan reads the pages of the run that holds it. Note the buffer hits.' },
      { sql: 'explain analyze select val from reading where id = 777;\nreset enable_seqscan;', note: '777 is odd, so it is in no run. The filters say so, and the scan reads fewer pages than for 778.' },
      { tip: 'Open the **Index** view on `reading_lsm` to see the runs, each with its own filter, and the measured false-positive rate of each.' },
      { sql: 'drop table reading;' },
    ],
  });

  lesson({
    id: 'aix-lsm', chapter: 24, title: 'LSM trees and write amplification', minutes: 12,
    summary: 'An LSM tree writes each entry several times as it moves down the levels, but always in big sequential batches. Count the page writes against a B+ tree on the same inserts.',
    body: [
      'Every index pays for its inserts in page writes. A B+ tree changes a leaf in place: with many random keys, nearly every insert dirties a different leaf, and each dirty leaf is eventually written whole, though it gained one entry. An LSM tree takes the opposite bet.',
      { steps: ['Inserts go to the **memtable** in memory.', 'A full memtable is written out as one sorted **run**: many entries per page, written sequentially.', 'Runs are **merged** into the next level when a level is too big. Each merge reads and rewrites entries.'] },
      { def: 'Write amplification.', text: 'The bytes (or pages) actually written to storage, divided by the bytes the application asked to write. For an LSM tree it counts every rewrite of an entry during merges.' },
      'An entry that sinks to the bottom of a tree with L levels has been written roughly once per level. With **leveled** compaction a merge into a level also rewrites the entries already there, so each level costs about the size ratio r in rewrites; with **tiered** (stepped-merge) compaction a level collects r runs and merges them once, so each entry is written about once per level. Tiered writes less and reads more, because a lookup may have to look in r runs per level.',
      { predict: { q: 'A B+ tree writes one page of 100 entries for each random insert. An LSM tree writes each entry 4 times in all, in pages of 100 entries. How many times fewer pages does the LSM tree write per insert?', options: ['25 times fewer', '4 times more', '100 times fewer'], answer: 0, explain: 'The LSM tree writes 4 entries\' worth per insert, which is 4/100 = 0.04 pages. The B+ tree writes 1 page. 1 / 0.04 = 25. Writing more often is fine when every write is a full page of useful data.' } },
      { h: 'Race them in the playground' },
      { view: 'indexlab', label: 'Open the index playground' },
      { steps: ['At the top, choose the mode **LSM vs B+ writes**.', 'Leave the parameters as they are and press the chip **random 500** next to **Try:**. The chart shows the pages each structure has written as the keys arrived.', 'Change **Compaction** from leveled to tiered and press **random 500** again. The LSM line drops: fewer rewrites per entry.', 'Press **Start over**, then the chip **ascending 1…200**. With keys in order, the B+ tree only ever changes its rightmost leaf, and its curve flattens: write amplification depends on the key order too.'] },
      { h: 'The same in SQL' },
      'Two LSM indexes on the same column, one leveled and one tiered, with a small memtable so that many merges happen:',
      { sql: "drop table if exists tick;\ncreate table tick (id int, v int);\ncreate index tick_leveled on tick using lsm (v)\n  with (memtable_size = 16, compaction = 'leveled', size_ratio = 3);\ncreate index tick_tiered on tick using lsm (id)\n  with (memtable_size = 16, compaction = 'tiered', size_ratio = 3);\ninsert into tick select g, (g * 7919) % 2003 from generate_series(1, 1500) g;\nselect relname, relpages from pg_class where relname like 'tick%' order by relname;", note: 'The tiered index may end up with more pages: it keeps several runs per level until they are merged.' },
      { predict: { q: 'Which lookup has to look in more places: one through the leveled index or one through the tiered index?', options: ['The tiered one: a level can hold several runs', 'The leveled one: it has more levels', 'Neither: both read exactly one run'], answer: 0, explain: 'Leveled compaction keeps one run per level, so a lookup checks at most one run per level. Tiered keeps up to r runs per level. Bloom filters reduce the cost of the extra runs, which is one reason LSM trees and Bloom filters travel together.' }, sql: "set enable_seqscan = off;\nexplain analyze select count(*) from tick where id = 700;\nexplain analyze select count(*) from tick where v = 700;\nreset enable_seqscan;" },
      'Real systems tune exactly these knobs: the memtable size, the size ratio, leveled or tiered (or leveled below and tiered above), and the bits per key of the filters.',
      { sql: 'drop table tick;' },
    ],
  });

  lesson({
    id: 'aix-bitmap-spatial', chapter: 24, title: 'Bitmap indices and spatial indices', minutes: 15,
    summary: 'Bitmaps combine conditions with AND and OR on bits. For points in the plane, k-d trees, quadtrees and R-trees split space so a window query skips most of it.',
    body: [
      { h: 'Bitmaps, combined' },
      'A bitmap index keeps, for each value of a column, one bit per row. Its strength shows when a query has several conditions on low-cardinality columns: the database ANDs, ORs and NOTs whole bitmaps, a machine word at a time, and only then fetches rows.',
      { table: [['Row', '0', '1', '2', '3', '4', '5', '6', '7'], ['genre = opera', '1', '0', '0', '1', '0', '1', '1', '0'], ['city = Saltreach', '1', '1', '0', '0', '0', '1', '1', '1'], ['opera AND Saltreach', '1', '0', '0', '0', '0', '1', '1', '0']] },
      { predict: { q: 'Using the table above, which rows does `genre = opera AND NOT city = Saltreach` select?', options: ['Row 3 only', 'Rows 0, 5 and 6', 'Rows 1, 2, 4 and 7'], answer: 0, explain: 'NOT Saltreach is 0 0 1 1 1 0 0 0. AND it with the opera bitmap 1 0 0 1 0 1 1 0 and only position 3 is 1 in both.' } },
      'In the engine, a table of ticket sales with two low-cardinality columns, the seat row (A to L) and the day of the week, and a bitmap index on each:',
      { sql: "drop table if exists sale;\ncreate table sale (id int primary key, seat_row text, day text, pad text);\ninsert into sale\n  select g, chr(65 + g % 12), 'day ' || (1 + g % 7), repeat('x', 80)\n  from generate_series(1, 2000) g;\ncreate index sale_row_bm on sale using bitmap (seat_row);\ncreate index sale_day_bm on sale using bitmap (day);\nanalyze sale;\nselect relname, relpages from pg_class\nwhere relname in ('sale', 'sale_row_bm', 'sale_day_bm');", note: 'Twelve rows and seven days: each bitmap index is far smaller than the table, and the one with fewer values is smaller still.' },
      { sql: "set enable_seqscan = off;\nexplain analyze select count(*) from sale\nwhere seat_row = 'C' and day = 'day 6';\nreset enable_seqscan;\ndrop table sale;", note: 'Look for **BitmapAnd** in the plan: the two bitmaps are combined before a single row is read, and only the pages holding matches are visited.' },
      { h: 'Points in the plane' },
      'A B+ tree orders keys on one line. Two-dimensional data, such as the position of a sensor or a shop, has no single order that keeps nearby points together. Spatial indices split **space** instead:',
      { def: 'k-d tree.', text: 'A binary tree. Each level splits on one coordinate, alternating x and y, at the point stored in the node: points with a smaller coordinate go left, the others right.' },
      { def: 'Quadtree.', text: 'Each node is a square; when it holds more points than its capacity, it splits into four equal quadrants (SW, SE, NW, NE). The splits follow space, not the data.' },
      { def: 'R-tree.', text: 'Like a B+ tree, but each entry holds a minimum bounding rectangle of everything below it. Rectangles may overlap; a node splits when it has more than M entries. It stores rectangles as easily as points.' },
      'A **range query** (a window) visits only the nodes whose region meets the window. In a k-d tree, at a node splitting on x at value v, the left subtree is searched only if the window starts left of v, the right one only if it reaches v or beyond.',
      { svg: '<svg viewBox="0 0 220 220" width="220" height="220" role="img" aria-label="A k-d tree splitting the plane at x = 40, then y = 70 on the left and y = 30 on the right"><rect x="10" y="10" width="200" height="200" fill="none" stroke="currentColor" stroke-opacity="0.5"/><line x1="90" y1="10" x2="90" y2="210" stroke="currentColor"/><line x1="10" y1="70" x2="90" y2="70" stroke="currentColor" stroke-dasharray="4 3"/><line x1="90" y1="150" x2="210" y2="150" stroke="currentColor" stroke-dasharray="4 3"/><rect x="50" y="40" width="90" height="90" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-dasharray="2 2"/><circle cx="90" cy="110" r="4" fill="currentColor"/><circle cx="60" cy="70" r="4" fill="currentColor"/><circle cx="150" cy="150" r="4" fill="currentColor"/><circle cx="30" cy="170" r="4" fill="currentColor"/><circle cx="130" cy="50" r="4" fill="currentColor"/><text x="94" y="106" font-size="10" fill="currentColor">(40,50)</text><text x="64" y="66" font-size="10" fill="currentColor">(25,70)</text><text x="154" y="146" font-size="10" fill="currentColor">(70,30)</text><text x="34" y="166" font-size="10" fill="currentColor">(10,20)</text><text x="134" y="46" font-size="10" fill="currentColor">(60,80)</text></svg>', caption: 'A k-d tree: the root (40, 50) splits on x; below it the plane is split on y. The shaded window is a range query: the subtrees whose region it misses are never visited.' },
      { view: 'indexlab', label: 'Open the index playground' },
      { steps: ['Choose the mode **Step through** and, in the structure menu, **k-d tree**. Press the chip **Eight points** to insert eight points, then the chip **Range (15,15)–(65,70)**. Step through the search: each step names the node and why a subtree is skipped.', 'Switch the structure to **Quadtree** and press its own **Eight points** chip (a different set of points). Set **Points per square** to 1 and to 3: fewer splits with a larger capacity.', 'Switch to **R-tree**, press **Twelve points**, then **Window (5,5)–(50,50)**. Click on the plane to add points and watch rectangles grow, and a node split when it passes M entries.'] },
      { predict: { q: 'In a k-d tree, the root splits on x at 40. A window query asks for x between 50 and 90. Which subtrees of the root does it search?', options: ['Only the right one', 'Only the left one', 'Both'], answer: 0, explain: 'Every point in the left subtree has x < 40, and the window starts at 50: nothing on the left can match. Only the right subtree (x ≥ 40) can.' } },
      { h: 'An R-tree in SQL' },
      'The engine\'s `rtree` method indexes two numeric columns as a point. A window query on both ranges uses it:',
      { sql: "drop table if exists spot;\ncreate table spot (id int primary key, x float8, y float8);\ninsert into spot select g, (g * 37) % 100, (g * 61) % 100 from generate_series(1, 800) g;\ncreate index spot_xy on spot using rtree (x, y);\nanalyze spot;\nset enable_seqscan = off;\nexplain analyze select count(*) from spot\nwhere x between 10 and 20 and y between 30 and 40;\nreset enable_seqscan;", note: 'The Index Cond holds both ranges: the window.' },
      { sql: 'drop table spot;' },
    ],
  });

  // ---- exercises --------------------------------------------------------------------------------------------------
  C.exercise({
    id: 'ex24-bloom-rate', chapter: 24, level: 2, kind: 'answer', title: 'A filter for a run of keys',
    text: ['A sorted run of an LSM tree holds n = 125 keys. Its Bloom filter has m = 1,000 bits and k = 4 hash functions.', 'What is its false-positive rate, by the formula (1 − e^(−kn/m))^k? Type it in the editor as a percentage with one decimal, for example `12.3`, and check it.'],
    hints: ['First compute kn/m.', 'kn/m = 4 · 125 / 1000 = 0.5, and e^(−0.5) ≈ 0.6065, so one bit is 1 with probability about 0.3935.', 'All four bits must be 1: 0.3935^4 ≈ 0.024, that is 2.4 percent.'],
    solution: '2.4', wrongs: ['39.3', '0.4', '6.1'], ref: '(1 − e^(−4·125/1000))^4 = (1 − 0.6065)^4 = 0.3935^4 ≈ 0.024: 2.4 percent.',
    check: kit.number(2.4, 0.1),
  });
  C.exercise({
    id: 'ex24-bloom-bits', chapter: 24, level: 2, kind: 'answer', title: 'Bits per key for one percent',
    text: ['You want each run\'s filter to give a 1% false-positive rate, and you will use the best number of hash functions.', 'How many bits per key does the filter need? Type the number with one decimal, for example `7.5`.'],
    hints: ['With the best k, m/n = −ln p / (ln 2)².', 'ln 0.01 = −4.605, and (ln 2)² = 0.4805.', '4.605 / 0.4805 ≈ 9.6 bits per key (with k = 7 hash functions).'],
    solution: '9.6', wrongs: ['6.6', '14.4', '4.8'], ref: 'm/n = −ln 0.01 / (ln 2)² = 4.605 / 0.4805 ≈ 9.6 bits per key.',
    check: kit.number(9.6, 0.15),
  });
  C.exercise({
    id: 'ex24-lsm-amp', chapter: 24, level: 2, kind: 'answer', title: 'Pages written per insert',
    text: ['A stream of random inserts goes into two indexes on the same column.', 'The B+ tree is too big for memory: each insert ends up costing one leaf page write. The LSM tree has a memtable and three levels on disk; each entry is written once when the memtable is flushed and once more each time it is merged into the next level, until it reaches the bottom level, level 3. Its pages hold 200 entries.', 'How many times fewer page writes per insert does the LSM tree do than the B+ tree? Type one number.'],
    hints: ['How many times is one entry written in the LSM tree? The flush writes it to level 1; then it is merged into level 2 and into level 3.', 'Three writes of one entry, in pages of 200 entries, is 3/200 = 0.015 pages per insert.', 'The B+ tree writes 1 page per insert, so the LSM tree writes 1 / 0.015 ≈ 66.7 times fewer pages: about 67.'],
    solution: '67', alts: ['66.7', '66.67'], wrongs: ['200', '3', '50'], ref: 'LSM: 3 writes per entry / 200 entries per page = 0.015 pages per insert. B+ tree: 1. Ratio 1 / 0.015 ≈ 67.',
    check: kit.number(66.7, 0.5),
  });
  C.exercise({
    id: 'ex24-bitmap-not', chapter: 24, level: 1, kind: 'answer', title: 'AND with a NOT',
    text: ['Eight rows of `production`, numbered 0 to 7. The bitmap of `genre = \'opera\'` is 1 1 0 0 0 0 1 1 and the bitmap of `runtime_min > 150` is 1 0 0 1 0 1 1 0.', 'Which rows run longer than 150 minutes and are not operas? Type their numbers, for example `2 4`.'],
    hints: ['Complement the opera bitmap first.', 'NOT opera is 0 0 1 1 1 1 0 0.', 'AND it with 1 0 0 1 0 1 1 0: 0 0 0 1 0 1 0 0, so rows 3 5.'],
    solution: '3 5', wrongs: ['0 6', '0 3 5 6', '3'], ref: 'NOT opera = 00111100; AND 10010110 = 00010100: rows 3 and 5.',
    check: kit.numSet([3, 5]),
  });
  C.exercise({
    id: 'ex24-kd-visit', chapter: 24, level: 3, kind: 'answer', title: 'A window query on a k-d tree',
    text: ['Insert these points, in this order, into an empty k-d tree that splits on x at the root and then alternates: (40,50), (25,70), (70,30), (10,20), (30,90), (60,80), (85,10). A point goes left when its coordinate on the node\'s axis is smaller than the node\'s, right otherwise.', 'Now run the window query x from 20 to 65, y from 40 to 85. A subtree is searched only if the window can reach into it. How many nodes (points) does the search visit? Type one number.', 'You can check yourself in the index playground: structure k-d tree, insert the points, then `range (20,40) (65,85)`.'],
    hints: ['Draw the tree first. (25,70) and (70,30) are the root\'s children; they split on y.', '(10,20) is the left child of (25,70) and (30,90) its right child; (85,10) is the left child of (70,30) and (60,80) its right child.', 'At (70,30) the window\'s y starts at 40, which is not below 30, so the left subtree (85,10) is skipped. Every other node is visited: 6.'],
    solution: '6', wrongs: ['7', '3', '4'], ref: 'Visited: (40,50), (25,70), (10,20), (30,90), (70,30), (60,80) = 6 nodes; (85,10) is skipped. Found: (40,50), (25,70), (60,80).',
    check: kit.number(6),
  });
})(typeof window !== 'undefined' ? window : globalThis);
