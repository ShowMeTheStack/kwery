// Chapter 14: indexing. Ordered indices, B+ trees (search, insertion, deletion, bulk loading), B-trees, static,
// extendible and linear hashing, bitmap indices, LSM trees with Bloom filters, and indices on several attributes.
(function (root) {
  'use strict';
  const K = root.K;
  const C = K.Content;
  const P = () => C.phys;
  const num = (truth, opts) => (app, a) => P().number(truth, opts)(app, a);
  /** a check that the answer lists exactly this set of numbers (in any order) */
  const numberSet = (truth, what) => (app, a) => {
    const got = [...new Set(P().nums(a))].sort((x, y) => x - y);
    const want = [...new Set(typeof truth === 'function' ? truth(app) : truth)].sort((x, y) => x - y);
    if (!got.length) return { ok: false, message: 'Type the ' + what + ' in the editor, separated by spaces or commas.' };
    if (got.length === want.length && got.every((x, i) => x === want[i])) return { ok: true, message: 'Right: ' + want.join(', ') + '.' };
    const extra = got.filter((x) => !want.includes(x)), missing = want.filter((x) => !got.includes(x));
    return { ok: false, message: 'Not yet: ' + (extra.length ? 'some of yours do not belong' : '') + (extra.length && missing.length ? ', and ' : '') + (missing.length ? UI_plural(missing.length) + ' missing' : '') + '.' };
  };
  const UI_plural = (n) => (n === 1 ? 'one is' : n + ' are');
  const ROOT = (pg) => { const d = pg.describe(); return d.nodes.find((n) => n.block === d.root); };
  const KEYS12 = '28 61 9 44 17 73 36 52 5 66 21 40';

  C.lesson({
    id: 'index-ordered', chapter: 14, title: 'Ordered indices', minutes: 12,
    summary: 'An index is a small sorted file that says where records are. Dense or sparse, clustering or secondary: the difference decides how many blocks a lookup reads.',
    body: [
      'Finding the bookings of one patron by reading every block of `booking` works, but it reads every block. An **index** is a separate, smaller structure that maps values of a **search key** to the places where records with that value are stored.',
      { def: 'Ordered index.', text: 'An index whose entries are kept sorted by the search key, so a lookup can binary-search it or descend a tree, and a range of keys lies together.' },
      { def: 'Clustering index.', text: 'An index on the attribute by which the file itself is sorted (also called a primary index). Records with nearby keys lie in the same or neighbouring blocks.' },
      { def: 'Secondary index.', text: 'An index on any other attribute (a nonclustering index). Records with nearby keys may lie anywhere in the file.' },
      { h: 'Dense and sparse' },
      'A **dense** index has an entry for every search-key value (in a secondary index: for every record). A **sparse** index has entries for only some values, typically the first key of each block. Sparse works only for a clustering index: to find key 57 you find the last entry not greater than 57, go to that block, and scan forward, which works only if the file is sorted. A sparse index is smaller; a dense one finds a record without scanning a block.',
      'When even the index is too large, index the index: a sparse **outer** index over the blocks of the **inner** index, and so on. That is a **multilevel index**, and the B+ tree of the next lessons is its self-balancing form.',
      { tip: 'Kwery\'s indexes, like PostgreSQL\'s, are dense secondary indexes: every row has an entry, and the table is a heap in no particular order. But a table loaded in key order behaves like a clustered one, and the planner notices it from the statistics (the column\'s **correlation** with the physical order).' },
      'Build a table whose `id` follows the physical order and whose `r` is scrambled, and index both:',
      { sql: "drop table if exists big;\ncreate table big as\n  select i as id, (i * 7919) % 2400 as r, repeat('x', 950) as pad\n  from generate_series(1, 2400) i;\ncreate index big_id on big (id);\ncreate index big_r on big (r);\nanalyze big;\ncheckpoint;", note: 'Four rows per page, 600 pages. Rows with ids 1 to 4 share page 0, 5 to 8 page 1, and so on.' },
      { predict: { q: 'Both conditions select 200 rows. Which can the index answer with fewer block reads: `id between 1001 and 1200` or `r between 1001 and 1200`?', options: ['`id`: its 200 rows are on about 50 neighbouring pages', '`r`: the index on r is just as good', 'Neither: an index reads every block anyway'], answer: 0, explain: 'The `id` index acts as a clustering index: the matching rows sit together, four to a page. The same number of `r` values is spread over about 200 different pages, each a random access. The planner uses the `id` index and refuses the `r` index.' }, sql: 'explain analyze select count(pad) from big where id between 1001 and 1200;\nexplain analyze select count(pad) from big where r between 1001 and 1200;' },
      'Compare the two **Simulated I/O** lines. Then make the planner use the secondary index anyway, and see what that costs:',
      { sql: 'set enable_seqscan = off;\nset enable_bitmapscan = off;\nexplain analyze select count(pad) from big where r between 1001 and 1200;\nreset enable_seqscan;\nreset enable_bitmapscan;' },
      { view: 'index', label: 'Open the index view' },
      { steps: ['Choose table `big` and index `big_r` in the two drop-downs at the top.', 'The tree is drawn level by level; the leaves hold (key, row pointer) pairs and are chained left to right.', 'Click a leaf entry and follow its pointer to the row in the storage view.'] },
      { tip: 'On the **Theatre (large)** sample (Settings), `booking` is loaded in `booking_id` order, so `booking_pkey` behaves like a clustering index, while the index on (patron_id, perf_id) is a secondary one: compare `select sum(paid) from booking where booking_id between 20001 and 20200` with the same sum `where patron_id between 101 and 120` there. (Ask for `paid`: a `count(*)` alone can be answered from the index without visiting the table.)' },
      { sql: 'drop table big;' },
    ],
  });

  C.lesson({
    id: 'index-bplus-search', chapter: 14, title: 'B+ trees: structure and search', minutes: 12,
    summary: 'A balanced tree of pages: every path from the root to a leaf has the same length, every node is at least half full, and a lookup reads one node per level.',
    body: [
      'A **B+ tree** of fan-out n is a multilevel index that keeps itself balanced as keys come and go:',
      { list: ['A **leaf** holds up to n − 1 (key, pointer) pairs, sorted, and a pointer to the next leaf, so the leaves form a sorted chain.', 'An **internal node** holds up to n pointers to children and n − 1 keys between them; the keys K1 < K2 < ... separate the subtrees: the subtree between Ki−1 and Ki holds the keys from Ki−1 up to just below Ki.', 'Every node except the root is at least half full: a leaf holds at least ⌈(n − 1)/2⌉ keys, an internal node at least ⌈n/2⌉ children.', 'All leaves are at the same depth.'] },
      'So a tree over K keys has height at most ⌈log⌈n/2⌉(K)⌉. Real nodes are disk blocks with fan-out in the hundreds: a million keys fit in three or four levels, and a lookup reads three or four blocks. To see the structure, Kwery lets you make the fan-out tiny.',
      { sql: "drop table if exists tiny;\ncreate table tiny (k int, label text);\ninsert into tiny select k, 'item ' || k\n  from (values (28), (61), (9), (44), (17), (73), (36), (52), (5), (66), (21), (40)) v(k);\ncreate index tiny_k on tiny (k) with (fanout = 4);\nselect relpages from pg_class where relname = 'tiny_k';", note: 'With `fanout = 4` a leaf holds at most 3 keys and an internal node at most 4 children. Every node is a page of its own (plus one meta page).' },
      { predict: { q: 'Twelve keys, leaves of at most 3 keys, internal nodes of at most 4 children. How many levels does the tree have?', options: ['3: leaves, one level of internal nodes, the root', '2: leaves and a root', '4'], answer: 0, explain: 'Twelve keys need at least 4 leaves, and splits leave leaves part full, so there are 5. A root can point to at most 4 children, so a level of internal nodes is needed between the leaves and the root. Open the index view to see it.' } },
      { view: 'index', label: 'Open the index view' },
      { steps: ['Choose table `tiny` and index `tiny_k` in the drop-downs.', 'Read the root: its key says which child to follow for smaller and larger keys.', 'Run the lookup below with the view open, then step through it with the step buttons at the top of the dock: the pages read are lit one level at a time.'] },
      { sql: "set enable_seqscan = off;\nexplain analyze select label from tiny where k = 36;", note: 'The table is so small that the planner would read it whole; switching sequential scans off makes it use the index, so you can watch.' },
      'To find key 36: at each internal node, find the first key greater than 36 and follow the pointer just to its left, or the last pointer if no key is greater. Here the root holds 44, so the search goes to the left child; that node holds 17 and 28, neither greater than 36, so it takes the last pointer and reaches the leaf [28, 36, 40]. Three pages, one per level. A **range** query finds the leaf of its low end the same way, then walks right along the leaf chain:',
      { sql: 'explain analyze select k, label from tiny where k between 15 and 50;\nreset enable_seqscan;' },
      { tip: 'Without the `fanout` option, nodes fill their 4 KB pages: a `bigint` key fits a few hundred to a page. Look at `pg_class.relpages` for `booking_pkey`, the index on the key of `booking`: 1,100 entries in about ten pages.' },
      { sql: 'drop table tiny;' },
    ],
  });

  C.lesson({
    id: 'index-bplus-insert', chapter: 14, title: 'B+ trees: insertion and splits', minutes: 12,
    summary: 'A key goes into its leaf; a full leaf splits in two and sends a separator up; a full parent splits in turn, and when the root splits the tree grows a level.',
    body: [
      'Insertion finds the leaf where the key belongs, exactly as a lookup does, and puts the key there in order. If the leaf has room, that is all.',
      'If the leaf is full (n − 1 keys already), it **splits**: the n keys are divided between the old leaf and a new one, the first ⌈n/2⌉ staying, and the first key of the new leaf is **copied** up into the parent as the separator between them. If the parent is full, it splits too, but an internal node **moves** its middle key up rather than copying it. A split of the root creates a new root above it, and that is the only way the tree gets taller, which is why all leaves stay at the same depth.',
      { view: 'indexlab', label: 'Open the index playground' },
      { steps: ['In the playground choose **B+ tree** with **Fan-out n** 4, and the **Step through** mode.', 'Type `28 61 9` and press **Insert**: one leaf, full.', 'Insert `44`. Step back and forward through the steps: the leaf splits into [9, 28] and [44, 61], and a root appears with separator 44.', 'Insert `17 73 36 52`, then `5 66 21 40`, one group at a time, reading the sentence under each step.'] },
      { predict: { q: 'With the 12 keys in, the leaf [28, 36, 40] is full. Where does inserting 33 lead?', options: ['The leaf splits into [28, 33] and [36, 40], and 36 is copied into the parent', 'The leaf splits into [28, 33, 36] and [40], and 40 moves up', 'The key goes into the leaf to its left, which has room'], answer: 0, explain: 'Four keys 28, 33, 36, 40: the first two stay, the other two go to the new leaf, and the new leaf\'s first key, 36, becomes the separator in the parent. The parent [*, 17, 28] has room for a third key, so the split stops there.' } },
      'The same thing happens inside the database. Make a table, index it with fan-out 4, and add a row while the index view is open:',
      { sql: "drop table if exists tiny;\ncreate table tiny (k int);\ninsert into tiny select k from (values (28), (61), (9), (44), (17), (73), (36), (52), (5), (66), (21), (40)) v(k);\ncreate index tiny_k on tiny (k) with (fanout = 4);" },
      { sql: 'insert into tiny values (33);', thenView: 'index', note: 'With the index view showing `tiny_k`, step through this insert: the split is drawn as it happens.' },
      { h: 'Insertion order matters' },
      'Splits leave both halves half full. If keys arrive in ascending order, every split happens at the right edge and the left half is never touched again, so nearly every leaf stays half full. Random order leaves leaves fuller on average (about two thirds). Compare the sizes of two indexes on the same 600 values:',
      { sql: "drop table if exists asc_keys;\ndrop table if exists mixed_keys;\ncreate table asc_keys as select i as k from generate_series(1, 600) i;\ncreate table mixed_keys as select (i * 211) % 600 as k from generate_series(1, 600) i;\ncreate index asc_keys_k on asc_keys (k) with (fanout = 4);\ncreate index mixed_keys_k on mixed_keys (k) with (fanout = 4);\nselect relname, relpages from pg_class where relname in ('asc_keys_k', 'mixed_keys_k');" },
      'The ascending one needs more pages for the same keys. The next lesson shows how bulk loading does better than both.',
      { sql: 'drop table tiny;\ndrop table asc_keys;\ndrop table mixed_keys;' },
    ],
  });

  C.lesson({
    id: 'index-bplus-delete', chapter: 14, title: 'Deletion, bulk loading, and B-trees', minutes: 14,
    summary: 'Deleting may leave a node less than half full: borrow from a sibling, or merge with it. Building a tree from sorted keys bottom up is far cheaper than inserting them. And the B-tree, which keeps each key only once.',
    body: [
      { h: 'Deletion' },
      'Deletion removes the entry from its leaf. If the leaf is still at least half full, that is all. Otherwise there are two repairs:',
      { list: ['**Redistribution**: if a neighbouring sibling has more than the minimum, move one entry across and fix the separator between them in the parent.', '**Coalescing**: if the sibling has only the minimum, merge the two nodes into one and delete the separator from the parent. The parent may now be under-full, and the same repair repeats one level up. If the root is left with a single child, that child becomes the root and the tree gets one level shorter.'] },
      { steps: ['In the index playground choose **B+ tree**, fan-out 4, and insert `' + KEYS12 + '`.', 'Delete `36`: its leaf [28, 36, 40] keeps two keys, enough.', 'Delete `52`: the leaf is left with [44] and borrows 61 from its right sibling [61, 66, 73]; the separator above becomes 66.', 'Delete `61`: now the sibling [66, 73] cannot spare a key, so the two leaves merge; their parent is left with a single child and merges with its sibling [17, 28], and the root disappears.'] },
      { view: 'indexlab', label: 'Open the index playground' },
      { predict: { q: 'After those three deletions, how many levels does the tree have?', options: ['2', '3', '1'], answer: 0, explain: 'The merges cascade up to the root, which is left with one child; that child becomes the root. Deletion is the only way a B+ tree gets shorter, just as a root split is the only way it gets taller.' } },
      'In the database, a `DELETE` does not remove index entries at once: other transactions may still need the old row, so the entries go when VACUUM removes the row. With the index option `textbook_delete = on`, VACUUM removes them with the classic algorithm of this lesson, and the index view shows the redistributions and merges:',
      { sql: "drop table if exists shrink;\ncreate table shrink (k int);\ninsert into shrink select k from (values (28), (61), (9), (44), (17), (73), (36), (52), (5), (66), (21), (40)) v(k);\ncreate index shrink_k on shrink (k) with (fanout = 4, textbook_delete = on);\ndelete from shrink where k in (36, 52, 61);\nvacuum shrink;", note: 'Step through the VACUUM in the index view to see the repairs.' },
      { h: 'Bulk loading' },
      'Inserting K keys one by one costs a root-to-leaf descent each, a random block access per key when the tree is larger than memory. When an index is built on an existing table there is a better way: sort the entries, fill the leaves left to right, then build each level of internal nodes from the first keys of the level below. Every block is written once, sequentially, and the fill factor decides how full the leaves are (full for a read-only index, less if inserts will follow). This is **bulk loading**.',
      { predict: { q: 'Bulk loading 600 keys into a tree of fan-out 4 with full leaves: how many leaves?', options: ['200', '300', '600'], answer: 0, explain: 'Full leaves hold n − 1 = 3 keys, so 600 / 3 = 200 leaves, against the 300 half-full leaves that ascending inserts produce.' } },
      { h: 'B-trees' },
      'A **B-tree** stores each key once: an internal node holds keys with their record pointers, and the subtrees between them. The keys in internal nodes do not appear again in the leaves, so the tree has slightly fewer entries, and a lookup sometimes stops above the leaves.',
      'The price: an internal node holds a record pointer with every key, so its fan-out is lower and the tree can be taller; deletion is more complicated, since a key may be in an internal node; and there is no simple chain of leaves for range scans. Nearly every system uses B+ trees.',
      { steps: ['In the playground choose the mode **B+ vs B-tree**.', 'Insert the same keys into both, for example `' + KEYS12 + '`.', 'Search for a key that sits in a B-tree internal node, and for one that sits in a leaf, and compare the pages each tree reads.'] },
      { sql: 'select relpages from pg_class where relname = \'shrink_k\';\ndrop table shrink;' },
    ],
  });

  C.lesson({
    id: 'index-hashing', chapter: 14, title: 'Static, extendible and linear hashing', minutes: 14,
    summary: 'A hash function sends each key straight to a bucket. The trouble is growth: overflow chains in static hashing, a doubling directory in extendible hashing, one split at a time in linear hashing.',
    body: [
      'A **hash index** computes h(K) for a search key K and goes straight to bucket h(K). An equality lookup reads one bucket, usually one block, whatever the size of the file. It cannot help with a range, because nearby keys hash to unrelated buckets.',
      { h: 'Static hashing' },
      'With a fixed number of buckets B, key K goes to bucket h(K) mod B. When a bucket fills, **overflow** blocks are chained to it, and a lookup must read the whole chain. A bad hash function, or many records with the same key, or simply growth, makes the chains long. Choosing B for the eventual size wastes space now; rebuilding with more buckets stops everything.',
      { h: 'Extendible hashing' },
      'Keep a **directory** of 2^i pointers, indexed by the first i bits of the hash value (i is the **global depth**). Several directory entries may point to the same bucket; each bucket records how many bits its keys really share (its **local depth**). When a bucket overflows:',
      { list: ['if its local depth is less than i, split it on its next bit and repoint half of the directory entries that pointed to it;', 'if its local depth equals i, first double the directory (i grows by one, every entry is copied), then split.'] },
      'Only one bucket is split at a time, and the directory, being small, can usually stay in memory.',
      { h: 'Linear hashing' },
      'Linear hashing grows without a directory. Buckets are split in a fixed round-robin order, one at a time, whenever the file becomes too full on average, whether or not the bucket being split is the one that overflowed (overflow blocks absorb the difference until its turn comes). A **split pointer** marks the next bucket to split; addresses below it use one more bit of the hash.',
      { view: 'indexlab', label: 'Open the index playground' },
      { steps: ['Choose **Static hashing** with 4 buckets of size 2 and insert `6 12 18 24 30 36 42 48 54 60 66 72`. Watch the overflow pages.', 'Choose **Extendible hashing** with bucket size 2 and insert the same keys. Find the steps where the directory doubles, and those where a bucket splits without doubling.', 'Choose **Linear hashing** and insert them again: the split pointer moves one bucket at a time.'] },
      { predict: { q: 'In extendible hashing, a bucket with local depth 2 overflows while the global depth is 3. What happens to the directory?', options: ['Nothing changes in size: the bucket splits on its third bit and some entries are repointed', 'It doubles to 16 entries', 'An overflow block is chained to the bucket'], answer: 0, explain: 'Two directory entries point to a bucket of local depth 2 when the global depth is 3. Splitting the bucket on its third bit gives each of those entries its own bucket. The directory only doubles when the overflowing bucket already uses all i bits.' } },
      'Kwery\'s `hash` access method implements all three schemes, chosen with the `scheme` option. The planner uses a hash index for equality only:',
      { sql: "drop table if exists kv;\ncreate table kv as select i as k, md5(i::text) as v from generate_series(1, 3000) i;\ncreate index kv_hash on kv using hash (k) with (scheme = 'extendible', bucket_size = 4);\nset enable_seqscan = off;\nexplain select v from kv where k = 1234;" },
      { sql: 'explain select v from kv where k between 10 and 20;\nreset enable_seqscan;', note: 'Even with sequential scans switched off, the range cannot use the hash index.' },
      { view: 'index', label: 'Open the index view on kv_hash' },
      { tip: 'In the index view, a hash index is drawn as its directory and buckets, with each key\'s hash bits. Extendible hashing shows the global and local depths; linear hashing shows the level and the split pointer.' },
      { sql: 'drop table kv;' },
    ],
  });

  C.lesson({
    id: 'index-bitmap', chapter: 14, title: 'Bitmap indices', minutes: 10,
    summary: 'For an attribute with few distinct values, one bit per record per value. Conditions on several attributes become AND and OR of bit strings, done a word at a time.',
    body: [
      'A **bitmap** for the value v of attribute A is a string of bits, one per record: bit i is 1 if record i has A = v. A **bitmap index** on A keeps one bitmap per distinct value. For an attribute with few values (a rating from 1 to 5, a genre, a number of seats), the bitmaps are small: a million records need 125 KB per value.',
      'Their strength is combining conditions. For `seat_row = \'D\' and night = 5`, AND the two bitmaps; for `or`, OR them; for `not`, complement (and AND with an existence bitmap so deleted records do not reappear). A 64-bit machine combines 64 records per instruction. Counting the 1 bits of the result answers `count(*)` without touching the table.',
      { def: 'Compression.', text: 'Sparse bitmaps (a value most records lack) are mostly zeros. Run-length schemes such as word-aligned hybrid (WAH) store long runs of zeros or ones as a single word and still allow AND and OR without decompressing.' },
      'A box office keeps one row per ticket sold: the seat row (A to J) and which of ten nights it was for. Both attributes have ten values. Give each a bitmap index:',
      { sql: "drop table if exists ticket;\ncreate table ticket as\n  select i as id, chr(65 + i % 10) as seat_row, 1 + (i / 7) % 10 as night, repeat('x', 150) as pad\n  from generate_series(1, 2000) i;\ncreate index ticket_row on ticket using bitmap (seat_row);\ncreate index ticket_night on ticket using bitmap (night);\nanalyze ticket;\nselect relname, relpages from pg_class where relname like 'ticket%';", note: 'Ten rows and ten nights: each bitmap index is a few pages, against more than a hundred for the table.' },
      { predict: { q: 'With sequential scans switched off, how will the planner answer `seat_row = \'D\' and night = 5`?', options: ['Read both bitmaps, AND them, then fetch only the blocks with a 1 bit', 'Use one bitmap and check the other condition on every row', 'Read the whole table anyway'], answer: 0, explain: 'The plan shows a BitmapAnd over two Bitmap Index Scans: about one ticket in a hundred is in row D on night 5, so only their blocks are read. Left to itself, the planner reads this small table sequentially, which is cheaper still.' }, sql: "set enable_seqscan = off;\nexplain analyze select count(*) from ticket where seat_row = 'D' and night = 5;\nreset enable_seqscan;" },
      { view: 'index', label: 'Open the index view on ticket_row' },
      { steps: ['Choose `ticket` and `ticket_row`: one row of bits per seat row, and below each the compressed words.', 'In the playground, choose **Bitmap index** and insert `drama comedy drama opera revue drama`, then search `drama` and look at the bits.'] },
      { tip: 'Kwery\'s planner combines indexes with AND (BitmapAnd), whether the indexes are bitmap indexes or B+ trees, as PostgreSQL does with its in-memory bitmaps. It does not combine them with OR: a disjunction is answered by a sequential scan.' },
      { sql: 'drop table ticket;' },
    ],
  });

  C.lesson({
    id: 'index-lsm-bloom', chapter: 14, title: 'Write-optimized indices: LSM trees and Bloom filters', minutes: 12,
    summary: 'A B+ tree pays a random write per insert. An LSM tree collects inserts in memory and writes them out in sorted runs, merging runs later; Bloom filters keep lookups from reading every run.',
    body: [
      'Each insert into a large B+ tree reads and writes a leaf somewhere on disk: a random I/O per insert. A system that ingests a stream of events cannot afford that. The **log-structured merge tree** (LSM tree) turns random writes into sequential ones:',
      { steps: ['New entries go into an in-memory tree, the **memtable**.', 'When the memtable is full, it is written out in one sequential pass as a sorted, immutable **run** on disk (level 0 or 1).', 'When a level holds too much, its runs are merged with the next level\'s in a sequential **compaction**, so each level is some size ratio larger than the one above.', 'A deletion is an entry too, a **tombstone**, which hides older entries until compaction drops them.'] },
      '**Leveled** compaction keeps one run per level (reads are cheaper); **tiered** compaction lets several runs pile up before merging them (writes are cheaper). Each entry is rewritten once per level it passes through: that is the LSM tree\'s own write amplification.',
      'A lookup must check the memtable and then each run from newest to oldest. To avoid reading runs that do not contain the key, each run keeps a **Bloom filter**.',
      { h: 'Bloom filters' },
      'A Bloom filter is a bit array of m bits and k hash functions. Inserting a key sets the k bits its hashes point to. A query computes the same k positions: if any bit is 0, the key is certainly absent; if all are 1, it is **possibly** present. There are no false negatives, but there can be false positives, with probability about (1 − e^(−kn/m))^k after n keys. The best k is (m / n) · ln 2.',
      { view: 'bloom', label: 'Open the Bloom filter lab' },
      { steps: ['Set **Bits m** to 64 and **Hash functions k** to 3. Add a few keys with one of the preset buttons, then query a key you did not add.', 'Press **+10 random keys** a few times and watch the measured false-positive rate climb towards the formula.', 'Press **Optimal k** and see the rate drop.'] },
      { predict: { q: 'A filter of 1,000 bits holds 100 keys. Which k gives the fewest false positives?', options: ['About 7', '1', 'As many as possible, say 50'], answer: 0, explain: '(m / n) · ln 2 = 10 · 0.693 ≈ 7. Fewer hash functions give each query too few bits to check; more fill the array with ones.' } },
      { h: 'In the database' },
      'Kwery has an `lsm` access method: a memtable, levels of runs, a Bloom filter per run.',
      { sql: "drop table if exists events;\ncreate table events (id int, kind text);\ncreate index events_lsm on events using lsm (id);\ninsert into events select i, 'click' from generate_series(1, 300) i;\nselect relpages from pg_class where relname = 'events_lsm';" },
      { sql: 'set enable_seqscan = off;\nexplain analyze select kind from events where id = 123;\nreset enable_seqscan;', note: 'In the index view, `events_lsm` shows the memtable, the runs of each level with their Bloom filters, and which runs a lookup skipped.' },
      { steps: ['In the playground choose the mode **LSM vs B+ writes** and press **random 500**: the chart compares the pages each structure wrote as the keys arrived.'] },
      { sql: 'drop table events;' },
    ],
  });

  C.lesson({
    id: 'index-multikey', chapter: 14, title: 'Indices on several attributes, and covering indices', minutes: 12,
    summary: 'An index on (a, b) is sorted by a, then by b. It helps a condition on a, or on a and b, but not one on b alone. And an index that holds every column a query needs can answer it alone.',
    body: [
      'A **composite search key** is a list of attributes, (a, b), ordered lexicographically: first by a, and among equal a by b. The entries of an index on (venue_code, perf_date) therefore lie in this order:',
      { table: [['venue_code', 'perf_date'], ['FER', '2026-05-30'], ['HAR', '2024-10-02'], ['HAR', '2025-01-18'], ['HAR', '2025-11-07'], ['HAR', '2026-02-21'], ['LAN', '2024-09-20']] },
      'All entries with venue_code = \'HAR\' are together, and among them the dates are sorted. So the index can find `venue_code = \'HAR\'` and also `venue_code = \'HAR\' and perf_date > date \'2025-06-01\'` (a contiguous stretch), but `perf_date = date \'2025-11-07\'` alone is scattered through the whole index, once under every venue.',
      { sql: "drop index if exists perf_venue_date;\ndrop index if exists perf_cover;\ncreate index perf_venue_date on performance (venue_code, perf_date);\nanalyze performance;\nset enable_seqscan = off;\nexplain select perf_id from performance where venue_code = 'HAR' and perf_date > date '2025-06-01';", note: 'Sequential scans are off so that the plan shows whether the index *can* be used. The **Index Cond** line lists both conditions.' },
      { predict: { q: 'With sequential scans still off, what plan does `select perf_id from performance where perf_date = date \'2025-03-14\'` get?', options: ['A sequential scan anyway: the index on (venue_code, perf_date) cannot find a date alone', 'An index scan with Index Cond perf_date = \'2025-03-14\'', 'A bitmap scan of the index'], answer: 0, explain: '`enable_seqscan = off` only discourages sequential scans; when no index matches, there is nothing else. To serve such queries you would add an index on perf_date, or on (perf_date, venue_code).' }, sql: "explain select perf_id from performance where perf_date = date '2025-03-14';" },
      'A range on the first attribute uses the index only for that range; the condition on the second attribute is then checked row by row:',
      { sql: "explain select perf_id from performance where venue_code < 'H' and perf_date = date '2025-03-14';\nreset enable_seqscan;", note: 'Look for **Index Cond** (used to search the index) and **Filter** or **Recheck** (checked afterwards).' },
      { h: 'Other ways to use several attributes' },
      { list: ['Two single-attribute indexes, each giving a set of row pointers, intersected (the BitmapAnd of the last lessons).', 'A **bitmap** index on each attribute, ANDed.', 'Spatial structures that treat (a, b) as a point: k-d trees, quadtrees and R-trees (chapter 24, and the playground).'] },
      { h: 'Covering indices' },
      'An index can store extra columns in its leaves without making them part of the key: `create index ... (venue_code) include (perf_date)`. If every column a query mentions is in the index, the query can be answered from the index alone, without fetching the rows: an **index-only scan**. That saves one random access per matching row, the largest part of a secondary index\'s cost.',
      { sql: "create index perf_cover on performance (venue_code) include (perf_date, perf_id);\nselect indexname, indexdef from pg_indexes where tablename = 'performance';" },
      { sql: "set enable_seqscan = off;\nexplain select perf_id, perf_date from performance where venue_code = 'HAR';\nreset enable_seqscan;", note: 'An **Index Only Scan**: the venue, the date and the id all come from the leaves of `perf_cover`, and no row of `performance` is read.' },
      { tip: 'The trade-off of every index: lookups get faster, but each insert, delete and key update must change the index too, and the index takes space. Index the attributes your queries search on, not every attribute.' },
      { sql: 'drop index perf_venue_date;\ndrop index perf_cover;' },
    ],
  });

  // ---- exercises -----------------------------------------------------------------------------------------------------
  C.exercise({
    id: 'ex14-sparse', chapter: 14, level: 1, kind: 'number', title: 'Entries of a sparse index',
    text: ['The 45,000 bookings of the Theatre (large) sample are stored sorted on `booking_id`, 67 to a block. A sparse index on `booking_id` has one entry per block. How many entries does it have?'],
    hints: ['First find how many blocks the file has; the last one is not full.', 'One entry per block.', 'Worked answer: ⌈45000 / 67⌉ = **672** entries.'],
    check: num(672, { why: (v) => (v === 45000 ? 'That would be a dense index.' : v === 671 ? 'Round up: the last, partly filled block needs an entry too.' : null) }), solution: 672,
    wrongs: ['45000', '671', '67'],
  });
  C.exercise({
    id: 'ex14-multilevel', chapter: 14, level: 2, kind: 'number', title: 'Levels of a multilevel index',
    text: ['A dense index on `patron_id` in `booking` (Theatre, large) has one entry for each of the 45,000 bookings and stores 60 entries per block. You build sparse outer indexes over it, level by level (60 entries per block too), until one level fits in a single block. Counting the dense index itself, how many levels are there?'],
    hints: ['The dense index has one entry per booking: how many blocks?', 'Each level above has one entry per block of the level below.', 'Worked answer: 45,000 / 60 = 750 blocks; ⌈750 / 60⌉ = 13 blocks; 13 entries fit in 1 block: **3** levels.'],
    check: num(3), solution: 3,
    wrongs: ['2', '4', '750'],
  });
  C.exercise({
    id: 'ex14-height-bound', chapter: 14, level: 2, kind: 'number', title: 'How tall can a B+ tree be?',
    text: ['A B+ tree on `booking_id` in Theatre (large) has fan-out n = 64 and holds the 45,000 keys. Using the bound ⌈log⌈n/2⌉(K)⌉, at most how many levels does a lookup descend?'],
    hints: ['⌈n/2⌉ = 32: every node but the root has at least 32 children.', 'log32(45,000) = ln(45,000) / ln(32).', 'Worked answer: 10.71 / 3.47 ≈ 3.09, rounded up: **4**. Just over 32³ = 32,768 keys, so a fourth level may be needed.'],
    check: num(4), solution: 4,
    wrongs: ['3', '5', '2'],
  });
  C.exercise({
    id: 'ex14-leaves', chapter: 14, level: 2, kind: 'number', title: 'Count the leaves',
    text: ['Insert these keys, in this order, into an empty B+ tree of fan-out 4 (a leaf holds at most 3 keys; a full leaf splits 2 + 2):', { p: '`20 6 33 41 2 13 27 9 36 17`' }, 'How many leaves does the tree have at the end? Work it out by hand first, then check it in the index playground.'],
    hints: ['After 20 6 33 the leaf [6, 20, 33] is full; 41 splits it into [6, 20] and [33, 41].', 'Keep going: 2 fills the left leaf, 13 splits it into [2, 6] and [13, 20], and so on.', 'Worked answer: the leaves end as [2, 6, 9], [13, 17], [20, 27], [33, 36, 41]: **4** leaves.'],
    check: num(() => P().leaves(P().lab('bplus', { fanout: 4 }, 'insert 20 6 33 41 2 13 27 9 36 17')).length), solution: 4,
    wrongs: ['5', '3', '10'],
  });
  C.exercise({
    id: 'ex14-root', chapter: 14, level: 2, kind: 'numbers', title: 'What the root holds',
    text: ['For the same tree (fan-out 4, keys `20 6 33 41 2 13 27 9 36 17` inserted in that order), which keys are in the root? Type them separated by spaces.'],
    hints: ['The root holds the separators between its children, here the leaves.', 'Each split copies the first key of the new leaf up.', 'Worked answer: the leaves start with 2, 13, 20 and 33, so the root holds **13 20 33**.'],
    check: numberSet(() => ROOT(P().lab('bplus', { fanout: 4 }, 'insert 20 6 33 41 2 13 27 9 36 17')).entries.filter((e) => e.key).map((e) => e.key[0]), 'keys'), solution: '13 20 33', wrongs: ['13 20', '2 13 20 33'],
  });
  C.exercise({
    id: 'ex14-ascending', chapter: 14, level: 2, kind: 'number', title: 'Ascending keys',
    text: ['Insert the keys 1, 2, 3, ..., 20 in ascending order into an empty B+ tree of fan-out 4. How many levels does the tree have at the end (leaves included)?'],
    hints: ['Every split happens at the right edge, leaving leaves of 2 keys: 10 leaves for 20 keys.', 'An internal node has at most 4 children, and internal splits also happen at the right edge.', 'Worked answer: 10 leaves under 3 internal nodes under a root: **3** levels.'],
    check: num(() => P().lab('bplus', { fanout: 4 }, 'insert ' + K.range(20).map((i) => i + 1).join(' ')).describe().levels), solution: 3,
    wrongs: ['2', '4', '10'],
  });
  C.exercise({
    id: 'ex14-delete', chapter: 14, level: 3, kind: 'number', title: 'After the deletions',
    text: ['A B+ tree of fan-out 4 gets the keys `5 10 15 20 25 30 35 40 45` inserted in that order. Then 45, 40 and 35 are deleted, in that order, with redistribution and coalescing (a leaf must keep at least 2 keys). How many leaves are left?'],
    hints: ['Build the tree first: ascending inserts leave leaves of 2 keys, and the last one has 3.', 'Deleting 45 and 40 leaves the last leaf with 35 alone. Can its left sibling spare a key?', 'Worked answer: the leaves were [5, 10] [15, 20] [25, 30] [35, 40, 45]; after the deletions [35] merges away: **3** leaves.'],
    check: num(() => P().leaves(P().lab('bplus', { fanout: 4 }, 'insert 5 10 15 20 25 30 35 40 45; delete 45 40 35')).length), solution: 3,
    wrongs: ['4', '2', '5'],
  });
  C.exercise({
    id: 'ex14-bulk-leaves', chapter: 14, level: 1, kind: 'number', title: 'Bulk-loaded leaves',
    text: ['The keys 1 to 50 are bulk loaded into a B+ tree of fan-out 4 with a fill factor of 100% (every leaf as full as it can be). How many leaves are there?'],
    hints: ['A leaf of fan-out 4 holds at most 3 keys.', 'Divide and round up.', 'Worked answer: ⌈50 / 3⌉ = **17** leaves.'],
    check: num(() => P().leaves(P().lab('bplus', { fanout: 4 }, 'bulkload 100 ' + K.range(50).map((i) => i + 1).join(' '))).length), solution: 17,
    wrongs: ['16', '25', '13'],
  });
  C.exercise({
    id: 'ex14-bulk-levels', chapter: 14, level: 2, kind: 'number', title: 'Bulk-loaded height',
    text: ['For the same bulk-loaded tree (keys 1 to 50, fan-out 4, full nodes), how many levels are there, counting the leaves?'],
    hints: ['17 leaves need ⌈17 / 4⌉ internal nodes above them.', 'Repeat until one node is left.', 'Worked answer: 17 leaves, then 5 nodes, then 2, then a root: **4** levels.'],
    check: num(() => P().lab('bplus', { fanout: 4 }, 'bulkload 100 ' + K.range(50).map((i) => i + 1).join(' ')).describe().levels), solution: 4,
    wrongs: ['3', '5', '2'],
  });
  C.exercise({
    id: 'ex14-btree-root', chapter: 14, level: 2, kind: 'numbers', title: 'A B-tree\'s root',
    text: ['Insert `20 6 33 41 2 13 27 9 36 17`, in that order, into an empty B-tree of order 4 (at most 3 keys per node; a full node splits around its middle key, which moves up). Which keys does the root hold at the end? Use the playground\'s **B-tree** to check.'],
    hints: ['Inserting 41 into [6, 20, 33] splits it: 33 moves up, leaving [6, 20] and [41].', 'Unlike a B+ tree, the key that moves up is not kept in a leaf. Inserting 13 into [2, 6, 20] sends 13 up the same way.', 'Worked answer: the root ends as **13 33**, over [2, 6, 9], [17, 20, 27] and [36, 41].'],
    check: numberSet(() => P().lab('btree', { order: 4 }, 'insert 20 6 33 41 2 13 27 9 36 17').describe().root.keys, 'keys'), solution: '13 33', wrongs: ['13 20 33', '20 33'],
  });
  C.exercise({
    id: 'ex14-static-overflow', chapter: 14, level: 1, kind: 'number', title: 'Overflow chains',
    text: ['A static hash file has 4 buckets, each a block of 2 entries, and uses h(K) = K mod 4. Overflow blocks also hold 2 entries. The keys `3 7 11 15 2 6 19` are inserted. How many overflow blocks are there?'],
    hints: ['Compute K mod 4 for each key.', 'Bucket 3 gets 3, 7, 11, 15 and 19; bucket 2 gets 2 and 6.', 'Worked answer: bucket 3 holds 2 entries and needs room for 3 more: **2** overflow blocks.'],
    check: num(2), solution: 2,
    wrongs: ['1', '3', '5'],
  });
  const EXT = 'Keys arrive with these first hash bits: A 0001, B 0110, C 1010, D 0011, E 1100, F 0010 (in that order). Buckets hold 2 entries. The directory starts with global depth 0: one entry pointing to one bucket.';
  C.exercise({
    id: 'ex14-extendible-depth', chapter: 14, level: 3, kind: 'number', title: 'Extendible hashing by hand',
    text: [EXT, 'After inserting all six keys, what is the global depth?'],
    hints: ['C overflows the single bucket: double to depth 1, split on the first bit: {A, B} and {C}.', 'D overflows {A, B}, whose local depth is 1 = global depth: double to depth 2; A and D start 00, B starts 01.', 'Worked answer: F (0010) overflows {A, D} (local depth 2 = global depth 2), so the directory doubles again: global depth **3**.'],
    check: num(3), solution: 3,
    wrongs: ['2', '4', '1'],
  });
  C.exercise({
    id: 'ex14-extendible-buckets', chapter: 14, level: 3, kind: 'number', title: 'How many buckets?',
    text: [EXT, 'After inserting all six keys, how many distinct buckets are there?'],
    hints: ['A split adds one bucket; a doubling of the directory adds none.', 'Count the splits: C, D and F each cause one (F\'s after the doubling).', 'Worked answer: buckets 000 {A}, 001 {D, F}, 01 {B}, 1 {C, E}: **4** buckets.'],
    check: num(4), solution: 4,
    wrongs: ['3', '5', '8'],
  });
  C.exercise({
    id: 'ex14-extendible-lab', chapter: 14, level: 2, kind: 'number', title: 'Extendible hashing in the playground',
    text: ['In the index playground, choose **Extendible hashing** with bucket size 2 and insert `104 117 125 131 142 158 163 176 189 195`. What is the global depth at the end? (The playground\'s hash function is FNV-1a, so read the answer off the structure rather than computing hashes by hand.)'],
    hints: ['The figures above the drawing show the global depth i.', 'You can also count the directory entries: there are 2^i of them.', 'Worked answer: the directory ends with 16 entries, global depth **4**.'],
    check: num(() => P().lab('extendible-hash', { bucket_size: 2 }, 'insert 104 117 125 131 142 158 163 176 189 195').describe().globalDepth), solution: 4,
    wrongs: ['3', '5', '16'],
  });
  C.exercise({
    id: 'ex14-linear-lab', chapter: 14, level: 2, kind: 'number', title: 'Linear hashing in the playground',
    text: ['In the playground choose **Linear hashing** with bucket size 2, 2 first buckets, and splits above 75% load. Insert the keys 1 to 12 (`1 2 3 4 5 6 7 8 9 10 11 12`). How many buckets are there at the end?'],
    hints: ['Each split adds exactly one bucket.', 'The figures above the drawing show the number of buckets, the level and the split pointer.', 'Worked answer: six splits, from 2 buckets to **8**.'],
    check: num(() => P().lab('linear-hash', { bucket_size: 2, buckets: 2, fillfactor: 75 }, 'insert ' + K.range(12).map((i) => i + 1).join(' ')).describe().nbuckets), solution: 8,
    wrongs: ['6', '12', '4'],
  });
  C.exercise({
    id: 'ex14-bitmap-and', chapter: 14, level: 1, kind: 'number', title: 'AND two bitmaps',
    text: ['Ten bookings. The bitmap for `rating = 5` is `1001101100` and the bitmap for `seats = 2` is `1100011010`. How many bookings satisfy both conditions?'],
    hints: ['AND the bitmaps position by position: a 1 only where both have a 1.', 'The result is 1000001000.', 'Worked answer: it has **2** ones.'],
    check: num(2, { why: (v) => (v === 8 ? 'That is the OR.' : null) }), solution: 2,
    wrongs: ['8', '4', '3'],
  });
  C.exercise({
    id: 'ex14-bitmap-size', chapter: 14, level: 1, kind: 'number', title: 'Size of a bitmap index',
    text: ['In Theatre (large), `booking.seats` takes 6 distinct values over 45,000 bookings. Without compression, how many bytes does a bitmap index on `seats` take (one bitmap per value, 8 bits per byte)?'],
    hints: ['One bitmap has one bit per booking.', 'There are 6 bitmaps.', 'Worked answer: 6 · 45,000 / 8 = **33,750** bytes.'],
    check: num(33750, { why: (v) => (v === 270000 ? 'That is in bits; divide by 8.' : v === 5625 ? 'That is one bitmap; there is one per value.' : null) }), solution: 33750, solutionText: '33,750',
    wrongs: ['270000', '5625', '45000'],
  });
  C.exercise({
    id: 'ex14-bloom-fp', chapter: 14, level: 2, kind: 'number', title: 'False positives',
    text: ['A Bloom filter has m = 1,200 bits and k = 8 hash functions, and holds n = 100 keys. Using (1 − e^(−kn/m))^k, what is the probability of a false positive? Give it as a decimal with four significant digits after the leading zeros, for example 0.01234.'],
    hints: ['kn/m = 800 / 1200 = 0.6667.', 'e^(−0.6667) ≈ 0.5134, so the base is 0.4866.', 'Worked answer: 0.4866^8 ≈ **0.003142**.'],
    check: num(Math.pow(1 - Math.exp(-8 * 100 / 1200), 8), { tol: 0.00003, percent: true }), solution: 0.003142,
    wrongs: ['0.4866', '0.03142', '0.0314'],
  });
  C.exercise({
    id: 'ex14-bloom-k', chapter: 14, level: 1, kind: 'number', title: 'The best number of hash functions',
    text: ['For a Bloom filter of m = 1,200 bits expected to hold n = 100 keys, what whole number of hash functions k gives the lowest false-positive rate?'],
    hints: ['The best k is (m / n) · ln 2.', '12 · 0.693 = 8.32.', 'Worked answer: round to **8**.'],
    check: num(8), solution: 8,
    wrongs: ['12', '7', '1'],
  });
  C.exercise({
    id: 'ex14-index-sizes', chapter: 14, level: 2, title: 'How big are the indexes?', db: 'theatre',
    text: ['Join `pg_indexes` with `pg_class` to list every index of the `public` schema: the table it belongs to, the index name, and its number of pages. Largest first; break ties by index name.'],
    hints: ['`pg_indexes` has `schemaname`, `tablename` and `indexname`; `pg_class` has `relname` and `relpages` for indexes too.', 'Join on `pg_class.relname = pg_indexes.indexname`.', "Order by `relpages desc, indexname`."],
    ref: "select i.tablename, i.indexname, c.relpages\nfrom pg_indexes i join pg_class c on c.relname = i.indexname\nwhere i.schemaname = 'public'\norder by c.relpages desc, i.indexname;",
    wrongs: ["select i.tablename, i.indexname, c.relpages from pg_indexes i join pg_class c on c.relname = i.indexname where i.schemaname = 'public' order by c.relpages, i.indexname;", "select i.tablename, i.indexname, c.relpages from pg_indexes i join pg_class c on c.relname = i.tablename where i.schemaname = 'public' order by c.relpages desc, i.indexname;"],
  });
  C.exercise({
    id: 'ex14-composite-which', chapter: 14, level: 2, kind: 'numbers', title: 'Which queries can use the index?',
    text: ['An index is created with `create index on performance (venue_code, price)`. Which of these WHERE clauses can use it to search the index (an Index Cond), rather than only to filter rows afterwards? Type their numbers.',
      { list: ["1. `venue_code = 'HAR'`", '2. `price > 50`', "3. `venue_code = 'HAR' and price > 50`", "4. `venue_code > 'L'`", "5. `price = 20 and venue_code = 'FER'`"] },
      'You can test each one: create the index, `set enable_seqscan = off`, and `explain` the query.'],
    hints: ['The index is sorted by venue_code first, and by price only among equal venue codes.', 'The order in which conditions are written does not matter; which attributes they constrain does.', 'Worked answer: **1 3 4 5**. Only 2, a condition on the second attribute alone, cannot search the index.'],
    check: numberSet((app) => {
      const s = P().theatre(app, 'create index perf_vp on performance (venue_code, price); set enable_seqscan = off');
      const qs = ["venue_code = 'HAR'", 'price > 50', "venue_code = 'HAR' and price > 50", "venue_code > 'L'", "price = 20 and venue_code = 'FER'"];
      return qs.map((q, i) => (/perf_vp/.test(s.exec('explain select perf_date from performance where ' + q)[0].rows.join('\n')) ? i + 1 : 0)).filter(Boolean);
    }, 'clause numbers'), solution: '1 3 4 5', solutionText: '1 3 4 5', wrongs: ['1 3', '1 2 3 4 5', '3'],
  });
  C.exercise({
    id: 'ex14-composite-sql', chapter: 14, level: 3, title: 'Make the index fit the query',
    text: ['A box office logs every ticket sold. The checker creates this table and switches sequential scans off:', { sql: "create table seat_sale as\n  select i as sale_id, i % 30 as perf_no, date '2025-01-01' + (i % 300) as sold_on\n  from generate_series(1, 3000) i;\nset enable_seqscan = off;", run: false }, 'Write a `create index` statement, followed by a query returning the `sale_id`s of the tickets for performance 12 sold between `2025-03-01` and `2025-03-31`, such that the query searches your index on both conditions (both appear in the Index Cond).'],
    hints: ['The equality condition should be on the first attribute of the index.', 'Put the range attribute second: `(perf_no, sold_on)`.', "For example: `create index sale_ps on seat_sale (perf_no, sold_on); select sale_id from seat_sale where perf_no = 12 and sold_on between date '2025-03-01' and date '2025-03-31';`"],
    ref: "create index sale_ps on seat_sale (perf_no, sold_on);\nselect sale_id from seat_sale\nwhere perf_no = 12 and sold_on between date '2025-03-01' and date '2025-03-31';",
    check: (app, a) => P().sqlPlan({ setup: "create table seat_sale as select i as sale_id, i % 30 as perf_no, date '2025-01-01' + (i % 300) as sold_on from generate_series(1, 3000) i; set enable_seqscan = off", ref: "select sale_id from seat_sale where perf_no = 12 and sold_on between date '2025-03-01' and date '2025-03-31'", plan: /Index Cond: \(\(perf_no = 12\) AND \(sold_on >=[^\n]*AND \(sold_on <=/, planMessage: 'The rows are right, but the plan does not search one index on both the performance and the dates. Check the Index Cond line of your plan.' })(app, a),
    wrongs: ["create index s1 on seat_sale (sold_on, perf_no); select sale_id from seat_sale where perf_no = 12 and sold_on between date '2025-03-01' and date '2025-03-31';", "create index s2 on seat_sale (perf_no); select sale_id from seat_sale where perf_no = 12 and sold_on between date '2025-03-01' and date '2025-03-31';", 'select 1'],
  });
})(typeof window !== 'undefined' ? window : globalThis);
