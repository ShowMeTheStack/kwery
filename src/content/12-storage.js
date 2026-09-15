// Chapter 12: physical storage systems. The storage hierarchy, magnetic disks and what an access costs, flash
// storage and RAID, with the simulated disk under the database and the disk view.
//
// This file also defines K.Content.phys, small helpers the exercises of chapters 12 to 16 share: reading a
// number from the editor, checking it, building a fresh database for a check, and comparing query results.
(function (root) {
  'use strict';
  const K = root.K;
  const C = K.Content;

  // ---- helpers for the exercises of chapters 12 to 16 -------------------------------------------------------------
  const P = C.phys = C.phys || {};
  /** the first number in an answer (comments dropped, 1,250 and 1_250 read as 1250, 12% as 0.12 when asked) */
  P.num = (text, opts) => {
    if (text === null || text === undefined) return null;
    const t = String(text).replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
    const m = /(-?\d[\d,_]*(?:\.\d+)?(?:e-?\d+)?|-?\.\d+)\s*(%)?/i.exec(t);
    if (!m) return null;
    let v = Number(m[1].replace(/[,_]/g, ''));
    if (!Number.isFinite(v)) return null;
    if (m[2] && opts && opts.percent) v /= 100;
    return v;
  };
  /** all the numbers in an answer, in order */
  P.nums = (text) => String(text || '').replace(/--[^\n]*/g, ' ').split(/[^0-9.\-]+/).filter((x) => /\d/.test(x)).map(Number).filter(Number.isFinite);
  const fmt = (v) => (Math.abs(v) >= 1000 && Number.isInteger(v) ? v.toLocaleString('en-US') : v !== 0 && Math.abs(v) < 0.01 ? String(Number(v.toPrecision(4))) : String(Math.round(v * 10000) / 10000));
  P.fmt = fmt;
  /**
   * a check for a numeric answer: truth is a number or a function of the app; tol is an absolute tolerance
   * (default: exact), rel a relative one. why(v, t) may explain a typical slip.
   */
  P.number = (truth, opts) => (app, answer) => {
    opts = opts || {};
    const v = P.num(answer, opts);
    if (v === null) return { ok: false, message: 'Type your answer in the editor as a number (for example `42`), then check it.' };
    const t = typeof truth === 'function' ? truth(app) : truth;
    const tol = Math.max(opts.tol || 0, opts.rel ? Math.abs(t) * opts.rel : 0, 1e-9);
    if (Math.abs(v - t) <= tol) return { ok: true, message: fmt(v) + ' is right.' + (opts.after ? ' ' + opts.after : '') };
    const why = opts.why ? opts.why(v, t) : null;
    return { ok: false, message: fmt(v) + ' is not it yet.' + (why ? ' ' + why : ' Check each number you put into the formula.') };
  };
  /** a check for a short word answer: each entry of accept is a regular expression a right answer matches */
  P.words = (accept, opts) => (app, answer) => {
    opts = opts || {};
    const a = String(answer || '').replace(/--[^\n]*/g, ' ').trim().toLowerCase();
    if (!a) return { ok: false, message: 'Type your answer in the editor, then check it.' };
    const list = typeof accept === 'function' ? accept(app) : accept;
    if (list.some((re) => re.test(a))) return { ok: true, message: 'Right.' + (opts.after ? ' ' + opts.after : '') };
    return { ok: false, message: opts.no || 'Not this one yet.' };
  };
  /** a new database of its own (so a check never depends on what the student changed), with a script run in it */
  P.fresh = (sql, opts) => {
    const db = new K.Database(opts && opts.db);
    const s = db.session({ name: 'checker' });
    if (sql) s.exec(sql);
    return s;
  };
  /** a new database with the Theatre sample in it (falls back to the student's database if the sample is missing) */
  P.theatre = (app, extra) => {
    const sample = K.SAMPLES && K.SAMPLES.theatre;
    const s = sample && sample.sql ? P.fresh(sample.sql) : app.db.session({ name: 'checker' });
    if (extra) s.exec(extra);
    return s;
  };
  P.rowsText = (r) => r.rows.map((row) => row.map((v, i) => (v === null || v === undefined ? '∅' : K.T.output(v, r.cols[i].type, { zone: 'UTC' }))).join('\u0001'));
  /** the last result with rows of a script */
  P.lastRows = (s, sql) => { const rs = s.exec(sql); for (let i = rs.length - 1; i >= 0; i--) if (rs[i].rows) return rs[i]; return null; };
  /** every operator of a physical plan, as EXPLAIN names it */
  P.planText = (s, plan) => (plan ? K.Explain.text(plan, { costs: false }, s) : '');
  /** an index structure of the playground with a script of operations applied ('insert 1 2 3; delete 2') */
  P.lab = (kind, options, script) => {
    const pg = K.IndexPlayground.make(kind, options);
    for (const part of String(script || '').split(';')) {
      const w = part.trim().split(/\s+/).filter(Boolean);
      if (!w.length) continue;
      const op = w.shift();
      const keys = w.map((x) => (/^-?\d+(\.\d+)?$/.test(x) ? Number(x) : x));
      if (op === 'bulkload') pg.bulkLoad(keys.slice(1), keys[0]);
      else for (const k of keys) pg[op](k);
    }
    return pg;
  };
  P.leaves = (pg) => pg.describe().nodes.filter((n) => n.leaf);
  /**
   * a check for an SQL answer that must give the reference's rows and whose plan must match a pattern: both run in a
   * fresh database (the Theatre sample if asked, and setup on top), so the check does not depend on the student's
   * tables. The reference runs first and is a query, so one database serves for both.
   */
  P.sqlPlan = (o) => (app, answer) => {
    if (!answer || !answer.trim()) return { ok: false, message: 'The editor is empty.' };
    const s2 = o.theatre ? P.theatre(app, o.setup) : P.fresh(o.setup);
    const ref = P.lastRows(s2, o.ref);
    let got;
    try { got = P.lastRows(s2, answer); } catch (e) { return { ok: false, message: 'Your statement fails: ' + e.message }; }
    if (!got) return { ok: false, message: 'Your answer does not return rows. It should end with a query.' };
    if (o.rows !== false) {
      if (got.cols.length !== ref.cols.length) return { ok: false, message: 'Your result has ' + got.cols.length + ' columns; the answer has ' + ref.cols.length + '.' };
      const a = P.rowsText(ref).sort(), b = P.rowsText(got).sort();
      if (a.length !== b.length || a.some((x, i) => x !== b[i])) return { ok: false, message: 'The rows are not right yet: your query gives ' + b.length + ', the answer ' + a.length + '.' };
    }
    const plan = P.planText(s2, got.plan);
    if (o.plan && !o.plan.test(plan)) return { ok: false, message: o.planMessage || 'The rows are right, but the plan does not do what the exercise asks.', details: ['Your plan:', ...plan.split('\n').map((l) => '`' + l.trim() + '`')] };
    if (o.notPlan && o.notPlan.test(plan)) return { ok: false, message: o.notPlanMessage || 'The rows are right, but the plan still does what the exercise asks you to avoid.', details: ['Your plan:', ...plan.split('\n').map((l) => '`' + l.trim() + '`')] };
    return { ok: true, message: o.okMessage || 'Right: the rows match, and so does the plan.' };
  };

  // ---- lessons ----------------------------------------------------------------------------------------------------
  C.lesson({
    id: 'storage-hierarchy', chapter: 12, title: 'The storage hierarchy', minutes: 8,
    summary: 'Fast memory is small and forgets; large storage is slow and remembers. A database lives on both, and moves data between them in blocks.',
    body: [
      'A computer has several kinds of storage, and they differ in three ways at once: how fast they are, how much they cost per byte, and whether they keep their contents when the power goes.',
      { table: [['Level', 'Typical access time', 'Survives power loss?', 'Role in a database'],
        ['CPU cache', 'a few nanoseconds', 'no', 'holds what the processor is working on right now'],
        ['Main memory (RAM)', 'about 100 nanoseconds', 'no', 'the buffer pool: copies of disk blocks being used'],
        ['Flash (SSD)', 'tens of microseconds', 'yes', 'the database files, or a cache in front of disks'],
        ['Magnetic disk', 'a few milliseconds', 'yes', 'the database files, the log, backups'],
        ['Tape, cloud archive', 'seconds to minutes', 'yes', 'archives and old backups']] },
      'The first two are **volatile** storage: they lose everything in a crash. The rest are **non-volatile**. Main memory is called **primary storage**, disks and flash **secondary storage**, and tape **tertiary storage**.',
      { def: 'Block.', text: 'The unit in which data moves between disk and memory. A block (also called a page) is a few kilobytes; reading one byte of a block costs the same as reading the whole block.' },
      'Kwery simulates this split. The tables live on a simulated disk, cut into blocks; queries work on copies of those blocks in a pool of memory frames. Ask for the block size:',
      { sql: 'show block_size;', note: 'Settings can change the page size, for a new database.' },
      'The catalog says how many blocks each table occupies:',
      { sql: "select relname, relpages\nfrom pg_class\nwhere relkind = 'r' and relnamespace = 'public'\norder by relpages desc;" },
      'Every block a query needs must be in memory first. `explain analyze` reports how many blocks were found in the buffer pool (hits) and how many had to come from the disk (misses):',
      { sql: 'explain analyze\nselect count(*) from booking;' },
      { predict: { q: 'Run exactly the same statement again at once. What will the buffer pool report?', options: ['All hits, no disk reads', 'The same number of disk reads as before', 'Twice as many disk reads'], answer: 0, explain: 'The blocks of `booking` were just read into memory frames and the pool is larger than the table, so a second read finds every block there. Memory is thousands of times faster than the disk; keeping the right blocks in memory is the buffer manager\'s job (chapter 13).' }, sql: 'explain analyze\nselect count(*) from booking;' },
      { h: 'Why the hierarchy shapes everything' },
      'A disk access costs milliseconds; a memory access costs a tenth of a microsecond. Because of that gap, of about a hundred thousand times, the cost of a query is counted in **block transfers** and **seeks**, and the CPU time is left out almost entirely. The rest of this part, and the next, are about touching as few blocks as possible.',
      { tip: 'The **Disk** view shows the simulated disk; the **Buffer pool** view shows the frames. Both record what the last statement did, step by step.' },
      { view: 'buffer', label: 'Open the buffer pool view' },
    ],
  });

  C.lesson({
    id: 'storage-disk', chapter: 12, title: 'Magnetic disks and the cost of an access', minutes: 12,
    summary: 'Seek, rotate, transfer: the access time of a disk block, with the numbers the cost model uses, and why sequential reads are so much cheaper than random ones.',
    body: [
      'A magnetic disk is a stack of spinning platters. Each surface is divided into concentric **tracks**, each track into **sectors**. A **read-write head** on an arm floats over each surface; all the arms move together, so the tracks under the heads at one time form a **cylinder**.',
      'Reading a block takes three steps:',
      { steps: ['**Seek**: move the arm to the right track. On average a few milliseconds.', '**Rotational latency**: wait until the block spins under the head. On average half a rotation: 4.17 ms at 7,200 revolutions per minute, 2 ms at 15,000.', '**Transfer**: read the bytes as they pass under the head. For one block, a small fraction of a millisecond.'] },
      { def: 'Access time.', text: 'Seek time plus rotational latency: what it costs to start reading at a new place. Cost formulas write it t_S, and write t_T for the time to transfer one block once the head is in place.' },
      'So reading b blocks at random positions costs b · (t_S + t_T), while reading b blocks that lie one after another costs only t_S + b · t_T: one seek, then the blocks stream off the track.',
      { h: 'The numbers Kwery uses' },
      'Kwery\'s magnetic disk spins at 7,200 revolutions per minute: t_S = 6 ms (1.83 ms of average seek and 4.17 ms of average rotation) and t_T = 0.15 ms for a 4 KB block (about 27 MB/s). A real disk of today transfers faster, but the ratio between random and sequential access is of the same order, and that ratio is what matters.',
      'Make a table large enough that it cannot stay in memory, and write it out to disk:',
      { sql: "drop table if exists big;\ncreate table big as\n  select i as id, (i * 7919) % 2400 as r, repeat('x', 950) as pad\n  from generate_series(1, 2400) i;\ncreate index big_r on big (r);\nanalyze big;\ncheckpoint;\nselect relpages from pg_class where relname = 'big';", note: 'Each row is about 1 KB, so four fit on a 4 KB page: 600 blocks, far more than the buffer pool holds. `r` is a scrambled copy of `id`, so rows with nearby values of `r` lie on blocks far apart.' },
      'A sequential scan reads every block in order:',
      { sql: 'explain analyze\nselect count(*) from big;', note: 'Look at the line **Simulated I/O**: 600 page reads, one seek, and close to 6 + 600 · 0.15 = 96 ms.' },
      'Now fetch 100 rows through the index on `r`. The index finds them quickly, but each row lies on a different block somewhere in the table:',
      { predict: { q: 'Which is cheaper on this disk: reading all 600 blocks in order, or fetching the blocks of 100 scattered rows one by one?', options: ['Reading all 600 blocks in order', 'Fetching the 100 rows one by one', 'About the same'], answer: 0, explain: 'Each scattered fetch pays for a new head position. The 100 rows sit on about 100 different blocks, and each block not already in memory is read with a seek of its own: in the simulator close to 500 ms (blocks that happen to share a track pay only the rotation), against 96 ms for the whole table read in order. Touching fewer blocks is not enough; how you touch them matters.' }, sql: 'set enable_seqscan = off;\nset enable_bitmapscan = off;\nexplain analyze\nselect count(pad) from big where r < 100;' },
      'The planner knows this, and left to itself it reads the whole table:',
      { sql: 'reset enable_seqscan;\nreset enable_bitmapscan;\nexplain\nselect count(pad) from big where r < 100;' },
      { view: 'disk', label: 'Open the disk view' },
      { steps: ['In the disk view choose the **Magnetic disk** tab.', 'Run the index query above again, with the view open.', 'Use the step buttons at the top of the dock to move the arm from access to access; each access is split into seek, rotation and transfer.', 'The card **The magnetic disk model** works out the random and sequential cost of reading the largest file.'] },
      { tip: 'Real disks have other tricks: the controller reorders requests to shorten seeks (the elevator algorithm), and a file system tries to keep a file\'s blocks close together. Kwery\'s model charges a seek whenever the next block is not the one right after the last.' },
      { sql: 'drop table big;' },
    ],
  });

  C.lesson({
    id: 'storage-flash-raid', chapter: 12, title: 'Flash storage and RAID', minutes: 12,
    summary: 'An SSD has no arm, but it cannot overwrite in place: pages, erase blocks and write amplification. Then RAID: striping for speed, mirroring and parity for surviving a failed disk.',
    body: [
      { h: 'Flash' },
      'An SSD stores bits in flash memory. Reading is electronic, so a random read costs about what a sequential one does: tens of microseconds, with no seek. In Kwery\'s SSD model a block costs 0.1 ms of latency plus its transfer, wherever it is.',
      'Writing is the hard part. Flash is written in **pages** of a few kilobytes, but a page that holds data cannot be overwritten. It must be erased first, and erasing works only on a whole **erase block** of many pages (64 in Kwery\'s model). So the SSD\'s **flash translation layer** (FTL) never updates in place: it writes the new version of a logical block to a free page, remaps the logical block to it, and marks the old page invalid.',
      'Eventually free pages run out. **Garbage collection** picks an erase block, copies its still-valid pages elsewhere, and erases it. Those copies are writes the database never asked for.',
      { def: 'Write amplification.', text: 'Pages physically written to flash divided by pages the host asked to write. 1.0 is ideal; random updates push it higher. Each erase block survives only a limited number of erases, so the FTL also spreads erases evenly (**wear leveling**).' },
      'Create a small table and change all of it; the checkpoint writes the changed pages to the device:',
      { sql: "drop table if exists flashy;\ncreate table flashy as\n  select i as id, repeat('x', 100) as v from generate_series(1, 2000) i;\ncheckpoint;\nupdate flashy set v = repeat('y', 100) where id % 7 = 0;\ncheckpoint;", note: 'The update touches rows on every page of the table, so every page is written again.' },
      { view: 'disk', label: 'Open the disk view, SSD tab' },
      { steps: ['Choose the **SSD** tab. If your database runs on the magnetic disk, the tab shows what the same accesses would cost on an SSD.', 'In the **Flash translation layer** card, press **Write 50 random blocks** a few times and watch write amplification and the invalid pages.', 'Press **Start again**, then **Write 50 in order** the same number of times, and compare.'] },
      { predict: { q: 'Which pattern of writes leads to more write amplification on flash?', options: ['Updates scattered at random over the device', 'The same number of updates to consecutive blocks', 'Neither: flash has no seek, so the pattern does not matter'], answer: 0, explain: 'Scattered updates leave a few invalid pages in many erase blocks, so garbage collection must copy many valid pages to reclaim each one. Consecutive updates invalidate whole erase blocks, which can be erased without copying.' } },
      { tip: 'Settings can switch the database to the SSD model; that applies to a new database. Then `explain analyze` reports the SSD\'s costs, and random index fetches are no longer a disaster.' },
      { h: 'RAID' },
      'A **redundant array of independent disks** makes several disks look like one. Two ideas, used alone or together:',
      { list: ['**Striping** spreads consecutive blocks over the disks, so a large read uses all of them at once.', '**Redundancy** stores extra information (a mirror copy, or parity) so that the data survives when a disk fails.'] },
      { table: [['Level', 'Idea', 'Usable space with n disks', 'Survives'],
        ['RAID 0', 'striping only', 'n', 'no failure'],
        ['RAID 1', 'every block on two (or more) disks', 'n / 2 for pairs', 'one failure per mirror set'],
        ['RAID 5', 'striping with one parity block per stripe, rotating among the disks', 'n − 1', 'one failure'],
        ['RAID 6', 'two independent check blocks (P and Q) per stripe', 'n − 2', 'two failures']] },
      'Parity is an exclusive or: P = D0 ⊕ D1 ⊕ D2. If the disk holding D1 fails, D1 = P ⊕ D0 ⊕ D2. Updating one block costs four accesses in RAID 5 (read the old block and the old parity, write both), which is why logs and other write-heavy data are often kept on RAID 1.',
      { steps: ['In the disk view choose the **RAID** tab, then **RAID 5** with 4 disks.', 'Click a block to see where its value comes from; click a P block to see the XOR.', 'Click a disk to fail it: its blocks are now computed from the others (degraded mode).', 'Fail a second disk and see what is lost. Then mend one and press **Replace and rebuild**.'] },
      { predict: { q: 'A RAID 5 array of 5 disks loses one disk, and during the rebuild a second disk fails. What happens?', options: ['Some data is lost', 'Nothing is lost: parity covers two failures', 'Nothing is lost, but the array becomes read-only'], answer: 0, explain: 'One parity block per stripe can recompute one missing block, not two. That risk during long rebuilds of large disks is the reason for RAID 6.' } },
      { sql: 'drop table flashy;\nselect count(*) from pg_class where relname = \'flashy\';' },
    ],
  });

  // ---- exercises -------------------------------------------------------------------------------------------------------
  // The exercises use a disk of their own, different from Kwery's: t_S = 5 ms and t_T = 0.2 ms per block. The block
  // counts come from the Theatre samples: in Theatre (large), booking fills 672 blocks and patron 110.
  const DISK = 'Take a disk with t_S = 5 ms (seek plus rotation) and t_T = 0.2 ms to transfer one block.';
  C.exercise({
    id: 'ex12-random-blocks', chapter: 12, level: 1, kind: 'number', title: 'Sixty scattered blocks',
    text: [DISK + ' A query fetches 60 bookings through a secondary index, and each lies on a different block somewhere in the file. How many milliseconds do the 60 block reads take? Type the number in the editor.'],
    hints: ['A block somewhere else on the disk means moving the head there first, then transferring the block.', 'One scattered block costs t_S + t_T = 5.2 ms.', 'Worked answer: 60 · (5 + 0.2) = **312** ms.'],
    check: P.number(312, { tol: 0.01, why: (v) => (v === 300 ? 'You left out the transfers.' : v === 17 ? 'Each scattered block needs its own seek, not just the first.' : null) }),
    solution: 312,
    wrongs: ['300', '17', '65'],
  });
  C.exercise({
    id: 'ex12-sequential-blocks', chapter: 12, level: 1, kind: 'number', title: 'The whole booking table in order',
    text: [DISK + ' In the Theatre (large) sample, `booking` fills 672 blocks that lie one after another. How many milliseconds does it take to read them all, in order?'],
    hints: ['The head moves into place once; after that the blocks pass under it one by one.', 'Sequential cost: t_S + b · t_T.', 'Worked answer: 5 + 672 · 0.2 = **139.4** ms.'],
    check: P.number(139.4, { tol: 0.01, why: (v) => (Math.abs(v - 3494.4) < 0.1 ? 'That is the cost if every block were scattered.' : Math.abs(v - 134.4) < 0.01 ? 'Add the one seek at the start.' : null) }),
    solution: 139.4,
    wrongs: ['3494.4', '134.4', '672'],
  });
  C.exercise({
    id: 'ex12-ratio', chapter: 12, level: 2, kind: 'number', title: 'How much faster is in order?',
    text: [DISK + ' Reading the 672 blocks of `booking` (Theatre, large) one at a time from scattered places takes how many times as long as reading them in order? Give the ratio to one decimal place.'],
    hints: ['Work out both costs: scattered b · (t_S + t_T), in order t_S + b · t_T.', 'Scattered: 672 · 5.2 = 3,494.4 ms. In order: 139.4 ms.', 'Worked answer: 3494.4 / 139.4 ≈ **25.1**.'],
    check: P.number(3494.4 / 139.4, { tol: 0.06 }),
    solution: 25.1,
    wrongs: ['5.2', '1', '24.1'],
  });
  C.exercise({
    id: 'ex12-rotation', chapter: 12, level: 1, kind: 'number', title: 'Rotational latency',
    text: ['A disk spins at 12,000 revolutions per minute. On average, how many milliseconds does it wait for the wanted block to come round under the head? Give two decimal places.'],
    hints: ['One revolution takes 60,000 ms divided by the revolutions per minute.', 'On average the block is half a revolution away.', 'Worked answer: 60000 / 12000 = 5 ms per revolution, half of it is **2.50** ms.'],
    check: P.number(2.5, { tol: 0.006, why: (v) => (Math.abs(v - 5) < 0.01 ? 'That is a whole revolution; on average you wait half of one.' : null) }),
    solution: 2.5, solutionText: '2.50',
    wrongs: ['5', '0.5', '10'],
  });
  C.exercise({
    id: 'ex12-transfer', chapter: 12, level: 2, kind: 'number', title: 'Transfer time of one block',
    text: ['A disk delivers 160 MB per second once the head is in place (take 1 MB = 1,000,000 bytes). How many milliseconds does one of Kwery\'s 4,096-byte blocks take to transfer? Give three decimal places.'],
    hints: ['Time = size / rate. Bytes divided by bytes per second gives seconds.', '4096 / 160,000,000 seconds; multiply by 1000 for milliseconds.', 'Worked answer: 4096 / 160,000,000 · 1000 = 0.0256, about **0.026** ms.'],
    check: P.number(4096 / 160000, { tol: 0.0006 }),
    solution: 0.026,
    wrongs: ['0.041', '2.56', '0.26'],
  });
  C.exercise({
    id: 'ex12-write-amp', chapter: 12, level: 2, kind: 'number', title: 'Write amplification',
    text: ['A night of ticket sales makes the database write 250 pages to an SSD. To free erase blocks for them, garbage collection moves 90 still-valid pages elsewhere. What is the write amplification? Give two decimal places.'],
    hints: ['Write amplification compares what reached the flash with what the database asked for.', 'The flash received the 250 pages and the 90 moved ones.', 'Worked answer: (250 + 90) / 250 = **1.36**.'],
    check: P.number(1.36, { tol: 0.006, why: (v) => (Math.abs(v - 0.36) < 0.01 ? 'Count the database\'s own 250 writes too.' : null) }),
    solution: 1.36,
    wrongs: ['0.36', '2.78', '1.9'],
  });
  C.exercise({
    id: 'ex12-raid-usable', chapter: 12, level: 1, kind: 'number', title: 'Usable space in RAID 6',
    text: ['An array is built from 10 disks of 6 TB each, organized as RAID 6. How many terabytes can hold data?'],
    hints: ['RAID 6 keeps two check blocks, P and Q, in every stripe.', 'Two disks\' worth of space goes to P and Q.', 'Worked answer: (10 − 2) · 6 = **48** TB.'],
    check: P.number(48, { why: (v) => (v === 54 ? 'That is RAID 5. RAID 6 gives up two disks.' : v === 30 ? 'That is mirroring.' : null) }),
    solution: 48,
    wrongs: ['54', '30', '60'],
  });
  C.exercise({
    id: 'ex12-raid-choice', chapter: 12, level: 2, kind: 'text', title: 'Where to put the log',
    text: ['Every booking a patron makes appends a few bytes to the write-ahead log, so the log takes a steady stream of small writes, and it must outlive the loss of any single disk. Of RAID 0, 1, 5 and 6, which level fits it best? Type the level, for example `RAID 0`.'],
    hints: ['One of the four levels loses data as soon as any disk fails.', 'With parity, a small write must read the old data and the old check blocks and write them back: four accesses for RAID 5, six for RAID 6.', 'Worked answer: **RAID 1**. A mirrored write is two writes at the same time, with nothing to read first.'],
    check: P.words([/^(raid\s*-?\s*)?1$/, /^raid\s*-?\s*1\b/, /^level\s*1$/, /mirror/], { no: 'Think about what one small write costs at each level, and which levels survive a failure.' }),
    solution: 'RAID 1', wrongs: ['RAID 5', '0', 'raid 6'],
  });
})(typeof window !== 'undefined' ? window : globalThis);
