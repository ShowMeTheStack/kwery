// Chapter 13: data storage structures. Records and their layout, the slotted page, heap files and free space,
// the buffer manager and its replacement policies, column stores, and the data dictionary.
(function (root) {
  'use strict';
  const K = root.K;
  const C = K.Content;
  const P = () => C.phys;

  /** the stored length of the first row of a new table, read from the line pointer on its page */
  function tupleLength(ddl, insert, name) {
    const s = P().fresh(ddl + ';' + insert + '; checkpoint');
    const rel = s.catalog.lookup({ name }, ['public']);
    const page = new K.Page(s.db.disk.file(rel.file).blocks[0]);
    return page.lp(1).len;
  }
  /** misses of a reference string under a replacement policy (lru or mru), with n frames */
  function misses(policy, n, refs) {
    const frames = [];   // pages, most recently used last
    let miss = 0;
    for (const p of refs) {
      const i = frames.indexOf(p);
      if (i >= 0) { frames.splice(i, 1); frames.push(p); continue; }
      miss++;
      if (frames.length >= n) { if (policy === 'lru') frames.shift(); else frames.pop(); }
      frames.push(p);
    }
    return miss;
  }
  C.phys.misses = misses;

  C.lesson({
    id: 'records-layout', chapter: 13, title: 'Fixed- and variable-length records', minutes: 10,
    summary: 'A file is a sequence of blocks, and a block holds records. Fixed-length records are easy to place; variable-length ones need a little directory of where each value is.',
    body: [
      'The database stores each relation in a **file**, and the file is a sequence of blocks. The simplest arrangement puts one record after another, all of the same length.',
      { h: 'Fixed-length records' },
      'If every record takes n bytes, record i starts at byte n · i, and a block of B bytes holds ⌊B / n⌋ records (a record should not straddle two blocks, or reading it would cost two block accesses).',
      'Deleting is the awkward part. Shifting all later records up costs too much, so systems either move the last record into the hole, or keep a **free list**: the file header points to the first free slot, and each free slot points to the next.',
      { h: 'Variable-length records' },
      'Real records vary: `varchar` values have different lengths, and NULLs take no room. A variable-length record is usually laid out in two parts:',
      { list: ['a fixed part first: for each variable-length attribute an (offset, length) pair, the fixed-length attributes themselves, and a **null bitmap** with one bit per attribute', 'the variable-length values after it, in the order the pairs point to'] },
      'Kwery stores rows as PostgreSQL does, which is a close relative of this layout: a header, a null bitmap when the row has a NULL, then the values in column order, each variable-length value carrying its own length in front.',
      'Compare a fixed-width `char(8)` seat label with a `varchar(8)` one:',
      { sql: "drop table if exists code_fixed;\ndrop table if exists code_var;\ncreate table code_fixed (stage_no int, code char(8));\ncreate table code_var (stage_no int, code varchar(8));\ninsert into code_fixed values (1, 'RIV-2'), (2, 'BALC-114');\ninsert into code_var values (1, 'RIV-2'), (2, 'BALC-114');\nselect ctid, stage_no, code from code_var;", note: 'The `ctid` (0,1) says: block 0, slot 1.' },
      { view: 'storage', label: 'Open the storage view' },
      { steps: ['In the storage view, choose `code_fixed` in the drop-down at the top, then click page 0.', 'Click the first tuple: the view lists its header fields, then each value with its offset and size.', 'Do the same for `code_var` and compare the lengths of the two rows.'] },
      { predict: { q: 'The label `RIV-2` has 5 characters. How much room does its value take in `code_fixed` compared with `code_var`?', options: ['More in `code_fixed`: char(8) pads the value to 8 characters', 'The same: both store 5 characters', 'More in `code_var`: varchar needs a length field and char does not'], answer: 0, explain: 'A `char(8)` value is always stored padded with spaces to 8 characters. Both kinds of value carry a length in front in this layout, so `varchar` wins whenever the value is shorter than the maximum.' }, sql: "select code, octet_length(code) as chars, length(code || '|') as with_bar\nfrom code_fixed;" },
      'Notice that `octet_length` reports 8 for `RIV-2`: the padding spaces really are stored. Yet SQL treats the trailing spaces of a `char` value as insignificant, so they vanish as soon as the value becomes text: `with_bar` is 6, not 9.',
      { tip: 'Large values (long text, images) are often stored apart from the row, in a separate file of large objects, and the row keeps only a pointer. Kwery keeps every value in the row, so a row must fit on one page; the error message suggests a larger page size in Settings.' },
      { sql: 'drop table code_fixed;\ndrop table code_var;' },
    ],
  });

  C.lesson({
    id: 'records-slotted-page', chapter: 13, title: 'The slotted page, NULLs and alignment', minutes: 12,
    summary: 'Inside a block: a header, an array of slots that grows down, free space, and records that grow up from the end. Then the bytes of one record: header, null bitmap, padding.',
    body: [
      'How are variable-length records arranged within a block? Almost every system uses the **slotted-page** structure:',
      { list: ['a **header** at the start of the block, recording where the free space begins and ends', 'an array of **slots** (line pointers) after it, one per record, each holding the record\'s offset and length', '**free space** in the middle', 'the **records** themselves, packed from the end of the block towards the middle'] },
      'The slot array grows down and the records grow up; the block is full when they meet. Anything outside the page refers to a record by (block, slot), never by its byte offset, so a record can move within its page (to close a gap) by updating only its slot.',
      { def: 'Kwery\'s page.', text: 'A 24-byte header (`pd_lower` ends the slot array, `pd_upper` starts the records, plus the page\'s log sequence number and a checksum), 4-byte line pointers, and the rows. This is PostgreSQL\'s layout.' },
      'Make a small table and look at its only page:',
      { sql: "drop table if exists pets;\ncreate table pets (id int, name varchar(20), born date);\ninsert into pets values\n  (1, 'Rex', date '2019-04-02'),\n  (2, 'Tiberius', null),\n  (3, null, date '2021-11-30');\nselect ctid, * from pets;" },
      { view: 'storage', label: 'Open the storage view' },
      { steps: ['Choose `pets` in the drop-down and click page 0. The page is drawn to scale: the header, the three line pointers, the free space, and the rows at the end.', 'Click row 1, then row 2: each row starts with a 23-byte header (`t_xmin`, `t_xmax`, `t_ctid`, flags, `t_hoff`).', 'Row 2 and row 3 have the flag **HASNULL** and a null bitmap; row 1 has none.'] },
      { h: 'The null bitmap and alignment' },
      'A row with a NULL carries one bit per column, 1 for present and 0 for NULL. The NULL value itself takes no bytes at all. Here the bitmap fits in byte 23, the last byte of the header, so `t_hoff` (where the data starts) stays at 24.',
      'Values are also **aligned**: a `smallint` starts at a multiple of 2, an `int` or `date` (4 bytes) at a multiple of 4, a `bigint` or `timestamp` (8 bytes) at a multiple of 8. The gap left before an aligned value is padding. So the order of the columns changes the size of a row.',
      { sql: "drop table if exists order_a;\ndrop table if exists order_b;\ncreate table order_a (a smallint, b bigint, c smallint, d bigint);\ncreate table order_b (b bigint, d bigint, a smallint, c smallint);\ninsert into order_a select i, i, i, i from generate_series(1, 1000) i;\ninsert into order_b select i, i, i, i from generate_series(1, 1000) i;\nselect relname, relpages from pg_class\nwhere relname in ('order_a', 'order_b');" },
      { predict: { q: 'In `order_a` each row is header (24 bytes), smallint, bigint, smallint, bigint. How long is one row?', options: ['56 bytes: 24, then 2 bytes, 6 of padding, 8, 2, 6 of padding, 8', '44 bytes: 24 + 2 + 8 + 2 + 8, no padding', '64 bytes: every column padded to 8'], answer: 0, explain: 'The first bigint must start at a multiple of 8, so after the smallint at bytes 24-25 the bigint waits until byte 32; the same happens again for the second pair. In `order_b` the two bigints come first, no padding is needed, and the row is 44 bytes. Check the lengths of the rows in the storage view.' } },
      'A designer cannot always choose the column order, but the rule of thumb is simple: wider fixed-length types first, then narrower ones, then the variable-length ones.',
      { sql: 'drop table pets;\ndrop table order_a;\ndrop table order_b;' },
    ],
  });

  C.lesson({
    id: 'records-heap-files', chapter: 13, title: 'Heap files, free space and VACUUM', minutes: 10,
    summary: 'A heap file keeps records in no order and puts a new one wherever there is room. Finding that room is the free-space map\'s job; making room is VACUUM\'s.',
    body: [
      'How records are spread over the blocks of a file is the **file organization**. The common ones:',
      { list: ['**Heap file**: a record goes anywhere there is space. The usual default.', '**Sequential file**: records kept in the order of a search key, with overflow blocks for insertions that do not fit in place.', '**Multitable clustering**: records of several relations that join together stored in the same blocks.', '**B+ tree file** and **hashing file**: the records themselves stored in an index structure (chapter 14).'] },
      'Kwery\'s tables are heap files. To place a new row it needs a block with enough free space, without reading every block to find one. It keeps a **free-space map**: for each block, how much room is left. A new row goes to the last block if it fits, otherwise to any block the map says is roomy enough, otherwise to a new block at the end.',
      { h: 'Deleted rows still take room' },
      'In a system with multiversion concurrency control (chapter 18) a deleted row cannot vanish at once: another transaction may still need to see it. The row stays on its page, marked deleted, until **VACUUM** finds it is dead to everyone and frees its space.',
      'Two identical tables; delete half of each, vacuum only the second, then insert fifty new rows into each:',
      { sql: "drop table if exists notes_a;\ndrop table if exists notes_b;\ncreate table notes_a (id int, body varchar(200));\ncreate table notes_b (id int, body varchar(200));\ninsert into notes_a select i, repeat('n', 150) from generate_series(1, 100) i;\ninsert into notes_b select i, repeat('n', 150) from generate_series(1, 100) i;\nselect relname, relpages from pg_class where relname like 'notes_%';" },
      { predict: { q: 'After deleting the even ids from both, vacuuming `notes_b` only and inserting 50 rows into each, which table has more pages?', options: ['`notes_a`: its deleted rows still occupy their space, so the new rows go to new pages', '`notes_b`: VACUUM adds pages', 'Neither: both stay at their size'], answer: 0, explain: 'VACUUM turned the dead rows of `notes_b` into free space and recorded it in the free-space map, so its new rows went into the holes. `notes_a` had no free space it could use and had to grow.' }, sql: "delete from notes_a where id % 2 = 0;\ndelete from notes_b where id % 2 = 0;\nvacuum notes_b;\ninsert into notes_a select i, repeat('m', 150) from generate_series(101, 150) i;\ninsert into notes_b select i, repeat('m', 150) from generate_series(101, 150) i;\nselect relname, relpages from pg_class where relname like 'notes_%';" },
      'Where did the new rows of `notes_b` land? Their `ctid`s show blocks that already existed:',
      { sql: 'select ctid, id from notes_b where id > 140;' },
      { view: 'storage', label: 'Open the storage view' },
      { steps: ['Choose `notes_a` and click a page: the deleted rows are still there, shaded as dead.', 'Choose `notes_b`: freed line pointers have been reused by the new rows.', 'The bar of pages at the top shows how full each page is and how much of it is dead; hold the mouse over a page to see what the free-space map records for it.'] },
      { tip: 'An UPDATE in this design writes a new version of the row and leaves the old one for VACUUM, so heavy updating also needs vacuuming. `vacuum full` goes further and rewrites the table compactly, giving pages back.' },
      { sql: 'drop table notes_a;\ndrop table notes_b;' },
    ],
  });

  C.lesson({
    id: 'records-buffer', chapter: 13, title: 'The buffer manager', minutes: 12,
    summary: 'A fixed number of memory frames hold copies of disk blocks. Pins keep a block in place while it is used, dirty bits say what must be written back, and a replacement policy decides what to throw out.',
    body: [
      'Programs that use the database never read the disk directly. They ask the **buffer manager** for a block. If the block is in one of its frames (a **hit**), it hands back the frame. If not (a **miss**), it picks a frame to reuse, writes the frame\'s old block to disk first if it was changed, reads the requested block into it, and hands that back.',
      { def: 'Pinned.', text: 'A block in use is pinned: its frame cannot be reused until every user has unpinned it. A pin count of 2 means two operators are reading the page at that moment.' },
      { def: 'Dirty.', text: 'A block changed in memory and not yet written back. Before a dirty block is written, the log records describing the change must be on disk (the write-ahead rule of chapter 19).' },
      'Change some rows and look at the pool:',
      { sql: "drop table if exists counters;\ncreate table counters as select i as id, 0 as hits from generate_series(1, 3000) i;\ncheckpoint;\nupdate counters set hits = hits + 1 where id <= 500;", note: 'The update dirties the first few pages of `counters`.' },
      { view: 'buffer', label: 'Open the buffer pool view' },
      { steps: ['The frames are drawn as a grid; dirty frames are marked, and each shows which block of which file it holds.', 'Step back and forward through the update with the step buttons at the top of the dock: watch each hit, miss and victim, and the sentence saying why the policy chose that victim.'] },
      'A checkpoint writes every dirty page:',
      { sql: 'checkpoint;\nexplain analyze select count(*) from counters;' },
      { h: 'Which frame to reuse' },
      'The usual policy is **least recently used** (LRU): reuse the frame whose block was used longest ago, on the bet that the recent past predicts the near future. Operating systems do roughly this. A database can do better, because the query processor knows its own access pattern.',
      'Take a nested-loop join whose inner relation is a little larger than the buffer pool. Each pass over the inner relation reads its blocks in the same order. Under LRU, the block thrown out is always the one the next pass needs soonest, so every request misses. **Most recently used** (MRU) throws out the block just finished with, which is exactly the one needed last on the next pass.',
      { predict: { q: 'A relation of 6 blocks is scanned 3 times in a row with 4 frames. How many of the 18 requests miss under LRU?', options: ['All 18', '6, the first pass only', '12'], answer: 0, explain: 'When block 5 arrives, LRU throws out block 1; block 6 throws out block 2; then the second pass asks for block 1, which is gone, and throws out block 3, and so on: the policy is always one step behind. MRU misses 10 of the 18 on the same pattern.' } },
      { steps: ['In the buffer pool view, find the card with the replacement-policy experiment: it runs the same block nested-loop join under each policy, with an inner relation larger than the pool.', 'Choose a pool of 8 frames and press **Run under every policy**.', 'Compare the hit ratios. Then try 32 frames: once the inner relation fits, the policy hardly matters.'] },
      'The other policies in the view: **Clock** approximates LRU cheaply with one reference bit per frame; **FIFO** ignores use entirely; **LRU-2** judges a block by its second-to-last use, so one long scan cannot push out blocks used again and again.',
      { tip: 'Settings choose the policy for the whole database, and the number of frames for a new database. Other tools, such as forcing a block out at once after use (toss-immediate) or pinning the root of an index permanently, are what a real query processor would request.' },
      { sql: 'drop table counters;\nselect count(*) from pg_class where relname = \'counters\';' },
    ],
  });

  C.lesson({
    id: 'records-columns-catalog', chapter: 13, title: 'Column stores and the data dictionary', minutes: 10,
    summary: 'Storing a table column by column makes analytic queries read less. And the database describes its own tables in tables you can query.',
    body: [
      { h: 'Row stores and column stores' },
      'Everything so far stores a row\'s values together: a **row-oriented** store. A **column-oriented** store keeps each column in its own file instead. A query that reads 2 columns of a 20-column table then reads about a tenth of the data, values of one type sit together and compress well, and the CPU can process them in tight loops.',
      'The price: fetching or inserting one whole row touches every column file. So column stores suit analysis (warehouses, chapter 11) and row stores suit transactions. Some systems keep both.',
      'Kwery is a row store, but you can see the effect by keeping one column apart in a table of its own:',
      { sql: "drop table if exists wide;\ndrop table if exists wide_rating;\ncreate table wide as\n  select i as id, repeat('a', 40) as a, repeat('b', 40) as b, repeat('c', 40) as c, 1 + i % 5 as rating\n  from generate_series(1, 3000) i;\ncreate table wide_rating as select rating from wide;\ncheckpoint;\nselect relname, relpages from pg_class where relname in ('wide', 'wide_rating');" },
      { predict: { q: '`select avg(rating)` needs one column. Roughly how many times as many blocks does it read from `wide` as from `wide_rating`?', options: ['About 5 times as many', 'The same: it needs the same values', 'About 100 times as many'], answer: 0, explain: 'A row store must read whole rows to get at one column, so it reads all 131 blocks of `wide`, against 27 for the rating column on its own (which still pays a 24-byte header per row; a real column store would pack the values far tighter).' }, sql: 'explain analyze select avg(rating) from wide;\nexplain analyze select avg(rating) from wide_rating;' },
      { h: 'The data dictionary' },
      'A database must know its own schema: the relations, their attributes and types, the constraints, the indexes, the users and what they may do, and statistics about sizes. It keeps all this in the **data dictionary** (or **system catalog**), and keeps it in relations, so that it can query it like anything else.',
      'The SQL standard defines a portable view of it, `information_schema`:',
      { sql: "select table_name, table_type\nfrom information_schema.tables\nwhere table_schema = 'public'\norder by table_name;" },
      { sql: "select column_name, data_type, is_nullable\nfrom information_schema.columns\nwhere table_name = 'performance'\norder by ordinal_position;" },
      'Each system also has its own, more physical catalog. Kwery provides PostgreSQL\'s names: `pg_class` (every relation and index, with its size in pages), `pg_indexes`, `pg_tables`, `pg_views`, `pg_matviews`, `pg_stats` (the statistics of chapter 16) and `pg_settings`:',
      { sql: "select c.relname, c.relkind, c.relpages\nfrom pg_class c\nwhere c.relname like 'booking%' or c.relname like 'patron%';" },
      { sql: "select indexname, indexdef\nfrom pg_indexes\nwhere tablename = 'booking';" },
      { tip: 'psql\'s backslash commands work too: `\\d booking` describes a table, `\\di` lists indexes. They are answered from the same catalog.' },
      { sql: 'drop table wide;\ndrop table wide_rating;' },
    ],
  });

  // ---- exercises ---------------------------------------------------------------------------------------------------
  C.exercise({
    id: 'ex13-per-block', chapter: 13, level: 1, kind: 'number', title: 'Records per block',
    text: ['A box-office file keeps each ticket as a fixed-length record of 56 bytes, in blocks of 4,096 bytes. No record may span two blocks. How many records fit in one block?'],
    hints: ['Divide the block size by the record size.', 'Round down: a part of a record does not fit.', 'Worked answer: ⌊4096 / 56⌋ = **73**.'],
    check: P_number(73, (v) => (v === 74 ? 'Round down, not up.' : null)),
    solution: 73,
    wrongs: ['74', '72', '4096'],
  });
  C.exercise({
    id: 'ex13-blocks', chapter: 13, level: 1, kind: 'number', title: 'Blocks for a file',
    text: ['The same file (73 records of 56 bytes per 4 KB block) holds one record for each of the 45,000 bookings of the Theatre (large) sample. How many blocks does it occupy?'],
    hints: ['Divide the number of records by the records per block.', 'Round up: the last block is partly empty.', 'Worked answer: ⌈45000 / 73⌉ = **617**.'],
    check: P_number(617, (v) => (v === 616 ? 'Round up: the last records need a block too.' : null)),
    solution: 617,
    wrongs: ['616', '45000', '600'],
  });
  C.exercise({
    id: 'ex13-tuple-varchar', chapter: 13, level: 2, kind: 'number', title: 'The length of one row',
    text: ['In Kwery\'s layout a row has a 23-byte header (rounded up to 24 when there is no null bitmap), an `int` takes 4 bytes aligned to 4, and a `varchar` value takes a 4-byte length plus one byte per character, aligned to 4.', { sql: "create table tag (id int, label varchar(10));\ninsert into tag values (7, 'kiwi2');", run: false }, 'How many bytes long is the stored row (the length its line pointer records)? You can check your reasoning in the storage view.'],
    hints: ['The data starts at byte 24. The int takes bytes 24 to 27.', 'The varchar starts at byte 28 (already a multiple of 4): 4 bytes of length and 5 characters.', 'Worked answer: 24 + 4 + 4 + 5 = **37** bytes.'],
    check: (app, a) => P().number(() => tupleLength('create table tag (id int, label varchar(10))', "insert into tag values (7, 'kiwi2')", 'tag'))(app, a),
    solution: 37,
    wrongs: ['33', '41', '40'],
  });
  C.exercise({
    id: 'ex13-null-bitmap', chapter: 13, level: 2, kind: 'number', title: 'A row with a NULL',
    text: ['A table has ten `int` columns. One row has a NULL in its last column and values in the other nine. The header is 23 bytes, then the null bitmap (one bit per column, whole bytes), and the data starts at the next multiple of 8. How long is the row, in bytes?', { sql: 'create table ten (c1 int, c2 int, c3 int, c4 int, c5 int, c6 int, c7 int, c8 int, c9 int, c10 int);\ninsert into ten values (1, 2, 3, 4, 5, 6, 7, 8, 9, null);', run: false }],
    hints: ['Ten bits need two bytes of bitmap: 23 + 2 = 25.', 'Round 25 up to a multiple of 8: the data starts at byte 32. The NULL takes no bytes.', 'Worked answer: 32 + 9 · 4 = **68** bytes.'],
    check: (app, a) => P().number(() => tupleLength('create table ten (c1 int, c2 int, c3 int, c4 int, c5 int, c6 int, c7 int, c8 int, c9 int, c10 int)', 'insert into ten values (1, 2, 3, 4, 5, 6, 7, 8, 9, null)', 'ten'), { why: (v) => (v === 64 ? 'The bitmap needs two bytes, and the data then starts at 32, not 24.' : v === 72 ? 'A NULL value takes no room in the row.' : null) })(app, a),
    solution: 68,
    wrongs: ['64', '72', '76'],
  });
  C.exercise({
    id: 'ex13-column-order', chapter: 13, level: 3, kind: 'number', title: 'Saving bytes by reordering',
    text: ['A table is declared as `(flag boolean, amount bigint, qty smallint, total bigint)`. A boolean takes 1 byte (no alignment), a smallint 2 (aligned to 2), a bigint 8 (aligned to 8); the data starts at byte 24.', 'If the columns are reordered to make the row as short as possible, how many bytes shorter is each row? Compare the lengths the line pointers record.'],
    hints: ['As declared: flag at 24, amount waits until 32, qty at 40-41, total waits until 48 and ends at 56.', 'Best order: the bigints first (24-39), then qty (40-41), then flag (42): length 43.', 'Worked answer: 56 − 43 = **13** bytes.'],
    check: (app, a) => P().number(() => tupleLength('create table o1 (flag boolean, amount bigint, qty smallint, total bigint)', 'insert into o1 values (true, 1, 2, 3)', 'o1') - tupleLength('create table o2 (amount bigint, total bigint, qty smallint, flag boolean)', 'insert into o2 values (1, 3, 2, true)', 'o2'))(app, a),
    solution: 13,
    wrongs: ['8', '0', '16'],
  });
  C.exercise({
    id: 'ex13-slots', chapter: 13, level: 1, kind: 'number', title: 'How many rows on a page',
    text: ['A slotted page of 4,096 bytes has a 24-byte header. Every patron row takes 60 bytes (alignment included) plus a 4-byte line pointer. How many rows fit on the page?'],
    hints: ['Each row costs its 60 bytes and its 4-byte slot.', 'The room for rows and slots is 4096 − 24 bytes.', 'Worked answer: ⌊4072 / 64⌋ = **63** rows.'],
    check: P_number(63, (v) => (v === 67 ? 'Each row also needs its 4-byte line pointer.' : v === 68 ? 'Leave room for the header and the line pointers.' : null)),
    solution: 63,
    wrongs: ['67', '68', '64'],
  });
  C.exercise({
    id: 'ex13-lru', chapter: 13, level: 2, kind: 'number', title: 'Counting LRU misses',
    text: ['A buffer pool has 3 frames, empty at first, and uses LRU. The blocks are requested in this order:', { p: '`4 7 2 4 9 7 3 4 2 9`' }, 'How many of the 10 requests are misses?'],
    hints: ['Keep the frames ordered by last use; on a miss with all frames full, the block used longest ago goes.', 'The first three requests fill the pool. 4 is then a hit and becomes the most recent.', 'Worked answer: misses on 4, 7, 2, 9, 7, 3, 4, 2, 9: **9** misses; only the second 4 is a hit.'],
    check: P_number(() => misses('lru', 3, [4, 7, 2, 4, 9, 7, 3, 4, 2, 9])),
    solution: 9,
    wrongs: ['10', '8', '6'],
  });
  C.exercise({
    id: 'ex13-mru', chapter: 13, level: 3, kind: 'number', title: 'MRU on a repeated scan',
    text: ['A relation of 5 blocks (1 to 5) is scanned 3 times in a row, so the requests are 1 2 3 4 5 1 2 3 4 5 1 2 3 4 5. The pool has 3 frames, empty at first. How many requests miss under MRU, which replaces the most recently used unpinned block?'],
    hints: ['Under LRU every one of the 15 requests would miss. MRU keeps the oldest blocks and keeps replacing the newest.', 'First pass: 1, 2, 3 fill the pool; 4 replaces 3; 5 replaces 4. The pool is {1, 2, 5}.', 'Worked answer: 5 misses in the first pass, 2 in each later pass (3 and 4 in the second, 2 and 3 in the third): **9** misses in all.'],
    check: P_number(() => misses('mru', 3, [1, 2, 3, 4, 5, 1, 2, 3, 4, 5, 1, 2, 3, 4, 5]), (v) => (v === 15 ? 'That is LRU. Under MRU the blocks loaded first stay.' : null)),
    solution: 9,
    wrongs: ['15', '5', '11'],
  });
  C.exercise({
    id: 'ex13-dictionary', chapter: 13, level: 1, title: 'Ask the data dictionary',
    db: 'theatre',
    text: ['Using `information_schema.columns`, list the name and data type of every column of the `production` table, in the order the columns were declared.'],
    hints: ['`information_schema.columns` has one row per column of every table, with `table_name`, `column_name`, `data_type` and `ordinal_position`.', 'Filter on the table name.', "Order by `ordinal_position`."],
    ref: "select column_name, data_type\nfrom information_schema.columns\nwhere table_name = 'production'\norder by ordinal_position;",
    wrongs: ["select column_name, data_type from information_schema.columns where table_name = 'production' order by column_name;", "select column_name from information_schema.columns where table_name = 'production' order by ordinal_position;", "select column_name, data_type from information_schema.columns where table_name = 'performance' order by ordinal_position;"],
  });
  C.exercise({
    id: 'ex13-largest', chapter: 13, level: 2, title: 'The largest tables', db: 'theatre',
    text: ['Using `pg_class`, give the name and number of pages of the three tables of the `public` schema that occupy the most pages, largest first; break ties by name. Count tables only (their `relkind` is `r`), not indexes.'],
    hints: ['`pg_class` has `relname`, `relkind`, `relnamespace` (the schema name here) and `relpages`.', "Keep the rows with `relkind = 'r'` and `relnamespace = 'public'`.", 'Order by pages descending, then by name, and take three rows.'],
    ref: "select relname, relpages\nfrom pg_class\nwhere relkind = 'r' and relnamespace = 'public'\norder by relpages desc, relname\nlimit 3;",
    wrongs: ["select relname, relpages from pg_class where relkind = 'r' and relnamespace = 'public' order by relpages desc, relname limit 2;", "select relname, relpages from pg_class where relkind = 'r' and relnamespace = 'public' order by relpages, relname limit 3;", "select relname, relpages from pg_class where relkind = 'r' and relnamespace = 'public' order by relpages desc, relname;"],
  });

  function P_number(truth, why) { return (app, a) => P().number(truth, { why })(app, a); }
})(typeof window !== 'undefined' ? window : globalThis);
