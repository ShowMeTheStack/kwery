// Chapter 19: the recovery system. Failures and storage, the log and write-ahead logging, checkpoints, the two-pass
// restart algorithm, ARIES, buffer policies, the loss of the disk and remote backups, and shadow paging as a contrast.
(function (root) {
  'use strict';
  const K = root.K;
  const C = K.Content;
  const kit = C.kit1726;
  const lesson = kit.lesson;

  // the small table the lessons crash and recover
  const ACCOUNT = "drop table if exists account;\ncreate table account (member text primary key, balance int);\ninsert into account values ('Ruiz', 640), ('Sato', 1180), ('Tamm', 425);\ncheckpoint;";

  lesson({
    id: 'rec-failures', chapter: 19, title: 'What can fail, and what survives', minutes: 8,
    summary: 'Failures come in kinds: a transaction fails, the system crashes, a disk dies. Each kind loses a different kind of storage, and recovery is built on what survives.',
    body: [
      'A recovery scheme has one job: after any failure, the database holds the effects of every committed transaction and of no other. That is atomicity and durability, kept even when things break. To design it, first sort the failures by what they destroy.',
      { h: 'Kinds of failure' },
      { def: 'Transaction failure.', text: 'One transaction cannot go on. A *logical error* comes from the transaction itself: bad input, a violated constraint, a value not found. A *system error* comes from the system: a deadlock victim, a serialization failure. Only that transaction is rolled back; the rest of the system carries on.' },
      { def: 'System crash.', text: 'Power fails, the operating system panics, a bug stops the server. Everything in main memory is lost: the buffer pool, the log buffer, the state of every running transaction. What is on disk stays. This assumption, that a crash never corrupts the disk, is called *fail-stop*.' },
      { def: 'Disk failure.', text: 'A head crash or a dead controller destroys some or all of the data on a disk. Recovery then needs a copy kept elsewhere: an archival dump and the log, or a remote backup.' },
      'Here is a logical error in action. The second statement breaks the primary key, so the whole transaction is rolled back, the first insert with it:',
      { sql: ACCOUNT + "\nbegin;\ninsert into account values ('Ueno', 50);\ninsert into account values ('Ruiz', 1);", fails: '23505', note: 'The duplicate key ends the transaction: it can only be rolled back now.' },
      { sql: "rollback;\nselect * from account order by member;", note: 'Ueno\'s account is gone too: a failed transaction leaves no trace.' },
      { h: 'Kinds of storage' },
      { table: [['Storage', 'Survives a crash?', 'Survives a disk failure?', 'Examples'], ['Volatile', 'no', 'no', 'main memory, caches, the buffer pool, the log buffer'], ['Non-volatile', 'yes', 'no', 'disks, flash, a battery-backed cache'], ['Stable', 'yes', 'yes', 'an idea: approximated by keeping copies on independent devices, ideally at more than one site']] },
      'Stable storage cannot exist exactly; nothing survives every disaster. It is approximated by writing each block to two (or more) devices, one after the other, so that a failure during a write leaves at least one good copy. The log is the one structure that must live on stable storage, because every other repair depends on it.',
      { predict: { q: 'Where does a log record live right after an UPDATE writes it, before anything else happens?', options: ['In the log buffer, in main memory', 'On stable storage already', 'On the data page, next to the row'], answer: 0, explain: 'A record goes to the log buffer first, which is volatile. It reaches stable storage when the log is flushed: at a commit, when the buffer fills, or when the write-ahead rule forces it. A crash before that loses it.' } },
      'Kwery keeps its settings for all of this where you can read them:',
      { sql: "select name, setting\nfrom pg_settings\nwhere name in ('synchronous_commit', 'full_page_writes', 'page_checksums', 'buffer_steal', 'buffer_force', 'wal_rule');" },
      'Open the crash view now. It shows what a crash would lose at this moment: the records in the log buffer, the dirty pages in the buffer pool, the open transactions. Leave the buttons alone for now; the next lessons use them.',
      { view: 'recovery', label: 'Open the crash and recovery view' },
      { sql: 'drop table account;' },
    ],
  });

  lesson({
    id: 'rec-wal', chapter: 19, title: 'The log and write-ahead logging', minutes: 12,
    summary: 'Every change is described in the log before the changed page may reach the disk. With that rule, a crash can always be repaired: redo what committed, undo what did not.',
    body: [
      'An update changes a page in the buffer pool. The page goes back to disk later, at a moment the buffer manager chooses. If the system crashes in between, the disk holds the old page; if it crashes after, the disk may hold a change of a transaction that never committed. Neither is acceptable without a way to fix it. The fix is the **log**: a sequence of records describing every change, kept on stable storage.',
      { def: 'Update log record.', text: 'In the classic notation `<Ti, Xj, V1, V2>`: transaction Ti changed data item Xj from the old value V1 to the new value V2. The old value makes **undo** possible, the new value makes **redo** possible.' },
      { def: 'Other records.', text: '`<Ti start>` when Ti begins, `<Ti commit>` when it commits, `<Ti abort>` when it is rolled back.' },
      'Each record has a **log sequence number** (LSN), its place in the log. Every page remembers the LSN of the last record that changed it, its **PageLSN**.',
      { sql: ACCOUNT },
      'Now change a row inside a transaction and leave it open:',
      { sql: "begin;\nupdate account set balance = balance - 100 where member = 'Ruiz';" },
      { view: 'log', label: 'Open the log view' },
      'In the log view, switch to **Angle-bracket notation**. The newest records are at the bottom. A line splits the log in two: above it, what has reached stable storage; below it, the log buffer, which a crash would lose. Your update is below the line.',
      'Kwery stores rows as PostgreSQL does, with versions. So one UPDATE shows as two records on the page: the insert of the new version (balance 540) and the old version\'s header getting an `xmax`. Together they are the one classic record `<T, Ruiz, 640, 540>`. Each record names its page and item, such as `account[0,4]`: block 0, item 4. Records of this kind, physical about the page and logical inside it, are called *physiological*.',
      { predict: { q: 'Now you commit. What happens to the records below the line?', options: ['They are flushed to stable storage before COMMIT returns', 'They stay in the buffer until a checkpoint', 'Only the commit record is flushed; the update record waits'], answer: 0, explain: 'A transaction is committed when its commit record is on stable storage. Before that record can be written, every earlier record of the transaction must be there too; one flush writes the whole buffer, in order. So COMMIT waits for the flush, and the line moves below the commit record.' }, sql: 'commit;' },
      { h: 'The rules' },
      { list: ['Log records reach stable storage in the order they were created.', 'A transaction enters the committed state only after its `<T commit>` record is on stable storage.', 'Before `<T commit>` is written, all of T\'s other records must be on stable storage.', '**The write-ahead rule**: before a page is written to disk, every log record describing a change on that page must be on stable storage (the log is flushed up to the page\'s PageLSN).'] },
      'The last rule is what makes undo possible: if a change reached the disk, its record, with the old value, is in the log. The log view\'s card **The write-ahead rule** lists each page written and whether the log had to be flushed first. A checkpoint writes every dirty page, so try one with a transaction open:',
      { sql: "begin;\nupdate account set balance = 0 where member = 'Tamm';\ncheckpoint;", note: 'Look at the write-ahead rule card: the page of account was written, and the log was flushed first.' },
      { sql: "rollback;\nselect member, balance from account order by member;" },
      { tip: 'There is also *deferred* modification, where nothing is written to the database before commit. Kwery, like most systems, uses *immediate* modification: pages may change, and even reach the disk, while the transaction runs, so the log must allow undo.' },
      { sql: 'drop table account;' },
    ],
  });

  lesson({
    id: 'rec-checkpoints', chapter: 19, title: 'Checkpoints', minutes: 10,
    summary: 'Without checkpoints, restart would read the whole log. A checkpoint writes the dirty pages and records which transactions were running, so restart can start there.',
    body: [
      'After a crash, which records must be looked at? In principle all of them, from the very first. That is slow, and most of the work would be wasted: changes made long ago are on disk already. A **checkpoint** bounds the work.',
      'The simplest kind of checkpoint does three things while no update runs:',
      { steps: ['flush every log record in main memory to stable storage', 'write every dirty page in the buffer pool to disk', 'write a record `<checkpoint L>` to stable storage, where L lists the transactions running at that moment'] },
      'After it, every change made before the checkpoint is on disk. Restart only needs the records from the checkpoint on, plus the earlier records of the transactions in L (they may need undo).',
      { sql: ACCOUNT },
      'Start a transaction in a second tab (the `+` next to the editor tab) and leave it running:',
      { sql: "begin;\nupdate account set balance = 390 where member = 'Tamm';", tab: 2, note: 'In tab 2. Its transaction stays open.' },
      'Back in tab 1, take a checkpoint:',
      { sql: 'checkpoint;', note: 'In tab 1.' },
      { view: 'log', label: 'Open the log view' },
      { predict: { q: 'What does the new checkpoint record list as running?', options: ['The transaction of tab 2', 'Nothing: a checkpoint waits until no transaction runs', 'Every transaction since the last checkpoint'], answer: 0, explain: 'L names the transactions that were active when the checkpoint was taken: here the one in tab 2. Restart will put it on its undo-list from the start, because some of its changes are now on disk.' } },
      'The checkpoint also wrote the page holding tab 2\'s uncommitted change. Writing uncommitted data to disk is allowed under the *steal* policy, which Kwery uses by default. So if the system crashed now, restart would have to undo Tamm = 390 on the disk.',
      'Kwery\'s checkpoint record also carries the transaction table and the dirty page table, which ARIES uses. Its log view has a **Fuzzy** button too: a fuzzy checkpoint writes no page at all, only the two tables, so updates never have to stop. Restart then begins redo at the oldest recLSN in the dirty page table instead of at the checkpoint.',
      { sql: 'rollback;', tab: 2, note: 'In tab 2.' },
      { sql: "select * from account order by member;\ndrop table account;", note: 'In tab 1.' },
    ],
  });

  lesson({
    id: 'rec-textbook', chapter: 19, title: 'Restart: redo, then undo', minutes: 14,
    summary: 'The two-pass algorithm scans forward from the checkpoint repeating every change and building an undo-list, then scans backward undoing the transactions on that list.',
    body: [
      'Restart after a crash has two phases.',
      { def: 'Redo phase.', text: 'Scan the log forward from the last checkpoint. Repeat every update record, whoever wrote it (this is called *repeating history*). Keep an undo-list: it starts as the checkpoint\'s L; `<Ti start>` adds Ti; `<Ti commit>` and `<Ti abort>` remove it.' },
      { def: 'Undo phase.', text: 'Scan the log backward. For each update record of a transaction on the undo-list, put back the old value and write a *redo-only* record `<Ti, Xj, V1>` saying so. On reaching `<Ti start>`, write `<Ti abort>` and take Ti off the list. Stop when the list is empty.' },
      'Redo first, undo second. Redo brings every page to the state it had at the crash; undo then rolls back exactly the transactions that did not finish. Redo is safe to repeat (it writes values, it does not add them), so it does not matter whether a change was already on disk.',
      'Set up a crash. First the table, then a transaction in tab 2 that will not finish:',
      { sql: ACCOUNT, note: 'In tab 1.' },
      { sql: "begin;\nupdate account set balance = 380 where member = 'Tamm';", tab: 2, note: 'In tab 2. Leave it open.' },
      'Then a transfer in tab 1 that commits:',
      { sql: "begin;\nupdate account set balance = balance - 75 where member = 'Ruiz';\nupdate account set balance = balance + 75 where member = 'Sato';\ncommit;", note: 'In tab 1. Its commit flushes the whole log buffer, tab 2\'s record with it.' },
      { predict: { q: 'The system crashes now. Which transactions are on the undo-list when the redo phase ends?', options: ['Only the one in tab 2', 'Both', 'Neither: the crash already threw away tab 2\'s work'], answer: 0, explain: 'The checkpoint listed nobody. The redo scan meets `<start>` of both transactions, then `<commit>` of the transfer, which takes it off. Tab 2\'s transaction has a start and an update in the stable log but no commit: it stays on the list, and undo rolls it back.' } },
      { view: 'recovery', label: 'Open the crash and recovery view' },
      { steps: ['On the **Crash and restart** tab, press **Crash now**. The view lists what was lost and which transactions were running.', 'Choose **Redo then undo (basic)** and press **Restart**.', 'Step through the passes. In **Redo**, each step says which record it repeats and shows the undo-list beside it. Note that tab 2\'s update to Tamm is redone too.', 'In **Undo**, the record of tab 2\'s update is undone (Tamm back to 425) with a redo-only record, and `<T abort>` is written when its start record is reached.'] },
      'After the restart, look at the rows. Tab 2\'s session lost its transaction in the crash, so its ROLLBACK just says there is none.',
      { sql: 'rollback;', tab: 2, note: 'In tab 2: after the crash there is nothing left to roll back.' },
      { sql: 'select * from account order by member;', note: 'In tab 1: Ruiz = 565 and Sato = 1255 survive; Tamm is 425 again.' },
      { warn: 'If you skipped the crash, the last query shows the same rows for a different reason: tab 2 rolled back by hand. Do the crash to see the passes.' },
      { sql: 'drop table account;' },
    ],
  });

  lesson({
    id: 'rec-aries', chapter: 19, title: 'ARIES, pass by pass', minutes: 15,
    summary: 'ARIES adds three ideas: LSNs on pages so redo can skip work, a dirty page table rebuilt by an analysis pass, and compensation log records so undo is never undone twice.',
    body: [
      'ARIES restarts in three passes.',
      { def: 'Analysis.', text: 'From the last checkpoint, scan forward and rebuild two tables: the **transaction table** (each running transaction with its LastLSN, the LSN of its newest record) and the **dirty page table** (each page that may differ from disk, with its recLSN, the first record that dirtied it). Transactions with a commit record are winners; the rest are losers. RedoLSN is the smallest recLSN.' },
      { def: 'Redo.', text: 'From RedoLSN, repeat history. A record is skipped if its page is not in the dirty page table, if its LSN is below the page\'s recLSN, or if the page\'s PageLSN shows the change is already there. Otherwise it is applied and PageLSN is set to its LSN.' },
      { def: 'Undo.', text: 'Roll back all losers together, always taking the largest LSN still to undo. Each undone change is logged as a **compensation log record** (CLR) carrying an UndoNextLSN: the next record of that transaction to undo. A CLR itself is never undone.' },
      'The PageLSN test is the key saving: the two-pass algorithm redoes everything since the checkpoint, ARIES only what is missing from the page.',
      { sql: ACCOUNT, note: 'In tab 1.' },
      { sql: "begin;\nupdate account set balance = 380 where member = 'Tamm';", tab: 2, note: 'In tab 2. Leave it open.' },
      { sql: "update account set balance = balance - 75 where member = 'Ruiz';\nupdate account set balance = balance + 75 where member = 'Sato';", note: 'In tab 1: two transactions of one statement each, both committed.' },
      { predict: { q: 'After the crash, the dirty page table that analysis rebuilds holds the account page. Its recLSN is the LSN of which record?', options: ['Tab 2\'s update of Tamm, the first change after the checkpoint', 'The last update, of Sato', 'The checkpoint record itself'], answer: 0, explain: 'recLSN is the first record that dirtied the page since it was last written. The checkpoint wrote every page, so the first change after it, tab 2\'s, made the page dirty again. RedoLSN is that LSN: nothing before it needs redo.' } },
      { view: 'recovery', label: 'Open the crash and recovery view' },
      { steps: ['On **Crash and restart**, press **Crash now**.', 'Choose **ARIES** and press **Restart**.', '**Analysis**: step from the checkpoint. Watch the transaction table gain each transaction and lose the committed ones, and the dirty page table gain the account page and its index page. The pass ends with RedoLSN, the winners and the losers.', '**Redo**: each step compares the record\'s LSN with the PageLSN. The pages were not written after the checkpoint, so every record is redone, the loser\'s included.', '**Undo**: tab 2\'s update and its new version are undone, newest first, each with a CLR whose UndoNextLSN points to the next record to undo. When it reaches the first record, an `<end>` record closes the transaction.'] },
      'Now the reason for CLRs. Suppose the system crashed again in the middle of undo. The next restart would redo the CLRs written so far (they are ordinary redo records), and undo would continue from the newest CLR\'s UndoNextLSN, never undoing the same change twice. However many times restart is interrupted, the work it does is bounded.',
      { sql: 'rollback;', tab: 2, note: 'In tab 2: after the crash its transaction is gone.' },
      { sql: "select * from account order by member;\ndrop table account;", note: 'In tab 1: Ruiz = 565, Sato = 1255, Tamm = 425.' },
      { tip: 'Kwery logs index pages as whole page images and never undoes them: an index entry left by a loser points to a tuple nobody can see, and VACUUM removes it later. That is why the dirty page table also holds `account_pkey`.' },
    ],
  });

  lesson({
    id: 'rec-buffer', chapter: 19, title: 'Buffer policies: steal, force and the WAL rule', minutes: 12,
    summary: 'Whether uncommitted pages may reach the disk, and whether committed pages must, decides whether recovery needs undo, redo, or both.',
    body: [
      'Two choices of the buffer manager shape the whole recovery scheme.',
      { table: [['Policy', 'Means', 'Consequence for recovery'], ['**steal**', 'a page holding uncommitted changes may be written to disk', 'undo is needed'], ['no-steal', 'such pages stay in memory until commit', 'no undo on disk, but every running transaction\'s pages must fit in the pool'], ['force', 'all pages a transaction changed are written before its commit', 'no redo for committed work, but each commit pays for random writes'], ['**no-force**', 'commit writes only the log; pages go later', 'redo is needed']] },
      'Nearly every real system chooses steal and no-force: the most freedom for the buffer manager, and commits that cost one sequential log write. The price is that recovery needs both undo and redo, which is exactly what the log provides. Kwery starts with steal and no-force too.',
      { sql: ACCOUNT },
      { h: 'No-steal' },
      { sql: "set buffer_steal = off;\nbegin;\nupdate account set balance = 410 where member = 'Tamm';\ncheckpoint;", note: 'With no-steal, the checkpoint must leave the page with the uncommitted change in memory.' },
      { view: 'log', label: 'Open the log view' },
      { predict: { q: 'Open the log view and look at the dirty page table. Is the account page still dirty after the checkpoint?', options: ['Yes: no-steal kept it in memory', 'No: a checkpoint writes every dirty page'], answer: 0, explain: 'Under no-steal a page holding an uncommitted change may not be written, not even by a checkpoint. The page stays dirty until the transaction ends. A crash now would need no undo on disk for it.' } },
      { sql: 'rollback;\nreset buffer_steal;' },
      { h: 'Force' },
      { sql: "set buffer_force = on;\nupdate account set balance = 700 where member = 'Ruiz';", note: 'The commit (this statement commits on its own) now writes the changed pages first.' },
      'In the log view\'s write-ahead rule card, the pages of account were written at the commit. A crash now would need no redo for this transaction.',
      { sql: 'reset buffer_force;' },
      { h: 'Breaking the WAL rule' },
      'The write-ahead rule is what lets steal be safe. Turn it off for one transaction and let a checkpoint write a page whose records are still in the log buffer:',
      { sql: "set wal_rule = off;\nbegin;\nupdate account set balance = 1 where member = 'Sato';\ncheckpoint;", note: 'The write-ahead rule card now shows the pages written ahead of the log, marked violated.' },
      'A crash now would leave on disk a change whose log record never reached stable storage. Restart could neither undo it (there is no old value) nor know it was there. Kwery\'s restart detects pages that are ahead of the log and says so.',
      { sql: 'rollback;\nreset wal_rule;' },
      { h: 'Commits that do not wait' },
      '`synchronous_commit = off` lets COMMIT return before its commit record is flushed. The database stays consistent after a crash, but the last few commits can vanish. The scenario **Commit without waiting for the log** on the **Crash and restart** tab of the recovery view shows it.',
      { sql: "select name, setting from pg_settings\nwhere name in ('buffer_steal', 'buffer_force', 'wal_rule', 'synchronous_commit');\ndrop table account;", note: 'Everything is back to the defaults.' },
      { tip: 'Shadow paging, in the next lesson, is the extreme of no-steal: it never overwrites a page in place at all.' },
    ],
  });

  lesson({
    id: 'rec-disk-backup', chapter: 19, title: 'Losing the disk: dumps, remote backups, shadow paging', minutes: 14,
    summary: 'When the disk itself is lost, the database is rebuilt from an archival dump and the log, or a remote backup takes over. Shadow paging shows recovery without any log.',
    body: [
      { h: 'Archival dumps' },
      'A crash loses memory. A disk failure loses the database. To survive it, the system periodically copies the whole database to other storage: an **archival dump**. The procedure is a checkpoint followed by a copy of every page, and a `<dump>` record in the log. After a disk failure, restore the latest dump and replay the log since then: redo all changes, then undo the transactions that never committed.',
      { sql: "drop table if exists sale;\ncreate table sale (id int primary key, amount int);\ninsert into sale select g, g * 10 from generate_series(1, 20) g;" },
      { view: 'recovery', label: 'Open the crash and recovery view' },
      { steps: ['Go to the **Disk loss** tab and press **Take a dump**.', 'Run the next SQL block: it changes rows after the dump and commits.', 'Press **Disk failure**: every block of the disk is gone; the log survives on its own device.', 'Choose ARIES and press **Restore**. The table compares row counts at the dump, before the failure, and after restore and replay.'] },
      { sql: "insert into sale values (21, 999);\ndelete from sale where id <= 5;", note: 'Run this after taking the dump.' },
      { predict: { q: 'After restore and replay, how many rows does sale have?', options: ['16: the dump\'s 20, plus one insert, minus five deletes', '20: what the dump held', '0: the disk is gone'], answer: 0, explain: 'The dump gives the state at its checkpoint; the log since then holds the committed insert and delete, and replay redoes them. Committed work survives the loss of the disk because the log was on separate stable storage.' }, sql: 'select count(*) from sale;' },
      { h: 'Remote backup' },
      'A dump is hours old. A **remote backup** site stays close behind: it starts from a copy of the database, receives the log as the primary flushes it, and redoes it on its own pages. If the primary site fails, the backup runs restart (undoing what had not committed) and takes over.',
      { list: ['**One-safe**: a commit is confirmed once its record is on the primary\'s log. Fast, but the last commits may not have reached the backup when the primary dies.', '**Two-very-safe**: confirmed only when both sites have logged it. Nothing confirmed is lost, but if the backup is down nothing can commit.', '**Two-safe**: like two-very-safe while both sites are up; when the backup is down, the primary goes on alone.'] },
      { steps: ['On the **Remote backup** tab, choose a lag of **1 flush** and press **Start the backup**.', 'Run the next block twice: each run commits and ships log records, which arrive one flush late.', 'Press **Primary fails: take over** and read which commits the backup never received.'] },
      { sql: "update sale set amount = amount + 1 where id = 21;", note: 'Run it twice with the backup started.' },
      { h: 'Shadow paging, for contrast' },
      'Shadow paging recovers without a log. Pages are never overwritten. A transaction copies each page it changes to a free block and records the new location in a *current* page table kept in memory; the *shadow* page table on disk still points to the old blocks. Commit writes the current table to disk and then switches the database pointer to it in one atomic write.',
      { steps: ['On the **Shadow paging** tab, press **Begin**, write a value to page 1 with **Write**, and step through the history.', 'Press **Crash** before committing: the pointer still names the shadow table, so the old values are all there. Nothing to undo, nothing to redo.', 'Try again and **Commit**: the pointer moves, and the old blocks become garbage.'] },
      'It is simple, but costly: every commit writes a page table, changed pages scatter over the disk and lose their order, old blocks must be collected, and concurrent transactions are hard to support. Log-based recovery won for these reasons; the idea survives in copy-on-write file systems and in some single-user stores.',
      { sql: 'drop table sale;' },
    ],
  });

  // ---- exercises ----------------------------------------------------------------------------------------------------
  const pre = (lines) => '`' + lines.join('`, `') + '`';
  // the log of the restart exercises
  const TB = ['1 <T1 start>', '2 <T1, X, 40, 55>', '3 <T2 start>', '4 <T2, Y, 300, 280>', '5 <T1 commit>', '6 <checkpoint {T2}>', '7 <T3 start>', '8 <T3, X, 55, 70>', '9 <T2, Z, 12, 18>', '10 <T4 start>', '11 <T4, Y, 280, 260>', '12 <T3 commit>', '13 <T4, Z, 18, 25>'];
  const tbText = { table: [['Line', 'Record']].concat(TB.map((l) => { const i = l.indexOf(' '); return [l.slice(0, i), '`' + l.slice(i + 1) + '`']; })) };
  const tbIntro = 'The system crashes with this stable log; nothing after line 13 reached stable storage. Restart uses the two-pass algorithm of this chapter (redo from the last checkpoint, then undo).';

  C.exercise({
    id: 'ex19-failure-kinds', chapter: 19, title: 'Name the failure', level: 1, kind: 'answer',
    text: ['Classify each event as a logical error (L), a system error (S), a system crash (C) or a disk failure (D):', { list: ['1. The building loses power for a minute.', '2. A withdrawal would make a balance negative, and a check constraint stops it.', '3. A disk controller fails and its disk cannot be read.', '4. Two transactions wait for each other and the system rolls one back.'] }, 'Type four letters in the order of the events, for example `C L D S`.'],
    hints: ['Ask what is lost: one transaction, all of main memory, or data on disk.', 'A logical error is the transaction\'s own fault; a system error is the system stopping a transaction for its own reasons.', 'The answer is C L D S: power loss is a crash, the check constraint a logical error, the controller a disk failure, the deadlock victim a system error.'],
    solution: 'C L D S', wrongs: ['C S D L', 'D L C S', 'C L D'],
    ref: 'C L D S. (1) A power failure loses main memory: a system crash. (2) The transaction\'s own data breaks a rule: a logical error. (3) Data on disk is lost: a disk failure. (4) The system ends a transaction that could have run: a system error.',
    check: (app, answer) => {
      const t = kit.norm(answer);
      if (!t) return kit.no('The editor is empty: type four letters there.');
      const got = (t.match(/\b[lscd]\b/g) || []);
      if (got.length !== 4) return kit.no('Type four letters, one per event, each L, S, C or D.');
      const right = ['c', 'l', 'd', 's'];
      const n = got.filter((g, i) => g === right[i]).length;
      return n === 4 ? kit.ok('Right: C L D S.') : kit.no(n + ' of 4 right. Think about what each event destroys.');
    },
  });

  C.exercise({
    id: 'ex19-wal-rules', chapter: 19, title: 'Which steps break the logging rules?', level: 2, kind: 'answer',
    text: ['A system logs as described in this chapter. Which of these steps break a write-ahead logging rule?', { list: ['1. T1 updates page P; the record (LSN 50) goes to the log buffer and P is changed in the buffer pool.', '2. The log is flushed up to LSN 40.', '3. The buffer manager writes P, whose PageLSN is 50, to disk.', '4. T2\'s commit record (LSN 70) is in the log buffer, and COMMIT returns to T2\'s client.', '5. The log is flushed up to LSN 80; then page Q, with PageLSN 75, is written to disk.', '6. The record at LSN 90 is written to the stable log while the record at LSN 85 is still in the buffer.'] }, 'Type the step numbers, for example `2 5`, or `none`.'],
    hints: ['Recall the four rules: records reach stable storage in order; commit only after the commit record is stable; a transaction\'s records before its commit record; and no page before the records that changed it.', 'Step 3 writes a page whose newest record is not yet stable. Step 6 writes records out of order.', 'The answer is 3 4 6: step 3 breaks the write-ahead rule, step 4 declares a commit before its record is stable, step 6 writes the log out of order.'],
    solution: '3 4 6', wrongs: ['3 6', '3', '1 3 4 6'],
    ref: '3 4 6. Step 3 writes P (PageLSN 50) when the log is stable only to 40. Step 4 tells the client T2 committed while <T2 commit> is still volatile. Step 6 puts LSN 90 on stable storage before LSN 85. Steps 1, 2 and 5 are allowed.',
    check: kit.numSet([3, 4, 6]),
  });

  C.exercise({
    id: 'ex19-policies', chapter: 19, title: 'Undo, redo, or both?', level: 2, kind: 'answer',
    text: ['For each pair of buffer policies, does crash recovery need **undo**, and does it need **redo**?', { list: ['1. steal, no-force', '2. steal, force', '3. no-steal, no-force', '4. no-steal, force'] }, 'Answer with eight yes/no words: undo and redo for 1, then for 2, 3 and 4. For example `yes no yes no no yes no no`.'],
    hints: ['Steal lets uncommitted changes reach the disk: someone must take them back.', 'No-force lets a transaction commit before its pages are on disk: someone must put them there.', 'The answer is yes yes yes no no yes no no: steal needs undo, no-force needs redo.'],
    solution: 'yes yes yes no no yes no no', wrongs: ['yes yes no yes yes no no no', 'yes yes yes yes yes yes no no'],
    ref: 'yes yes / yes no / no yes / no no. Undo is needed exactly when steal is allowed, redo exactly when force is not. Steal with no-force needs both, which is why ARIES does both.',
    check: kit.yesNoList([true, true, true, false, false, true, false, false], ['undo 1', 'redo 1', 'undo 2', 'redo 2', 'undo 3', 'redo 3', 'undo 4', 'redo 4']),
  });

  C.exercise({
    id: 'ex19-undo-list', chapter: 19, title: 'The undo-list after redo', level: 2, kind: 'answer',
    text: [tbIntro, tbText, 'Which transactions are on the undo-list when the redo phase ends? Type them, for example `T1 T3`.'],
    hints: ['The redo phase starts at the last checkpoint, with the undo-list set to the checkpoint\'s list.', 'Then `<Ti start>` adds Ti; `<Ti commit>` removes Ti. T1 committed before the checkpoint and does not matter.', 'The answer is T2 T4: the list starts as {T2}, gains T3 (line 7) and T4 (line 10), and loses T3 (line 12).'],
    solution: 'T2 T4', wrongs: ['T4', 'T2 T3 T4', 'T1 T2 T4'],
    ref: 'T2 T4. Start at line 6 with L = {T2}. Line 7 adds T3, line 10 adds T4, line 12 removes T3. T2 and T4 never committed: they are the losers.',
    check: kit.txSet(['T2', 'T4'], 'on the undo-list'),
  });

  C.exercise({
    id: 'ex19-redo-lines', chapter: 19, title: 'What does redo repeat?', level: 2, kind: 'answer',
    text: [tbIntro, tbText, 'Which lines does the redo phase repeat (apply to the database)? Type the line numbers, for example `2 4`.'],
    hints: ['The redo phase starts at the checkpoint, not at the beginning of the log.', 'It repeats every update record from there on, whether its transaction committed or not.', 'The answer is 8 9 11 13: the four update records after the checkpoint, losers included.'],
    solution: '8 9 11 13', wrongs: ['8', '8 13', '2 4 8 9 11 13', '4 8 9 11 13'],
    ref: '8 9 11 13. Lines 2 and 4 are before the checkpoint, so their pages were written by it. From line 6 on, the two-pass algorithm repeats every update, those of T2 and T4 too (repeating history); undo takes the losers\' changes back afterwards.',
    check: kit.numSet([8, 9, 11, 13]),
  });

  C.exercise({
    id: 'ex19-final-values', chapter: 19, title: 'The values after restart', level: 3, kind: 'answer',
    text: [tbIntro, tbText, 'What are X, Y and Z when restart is over? Type three numbers in that order, for example `55 280 18`.'],
    hints: ['Only T1 and T3 committed. Their last writes decide X.', 'Undo runs backward through T2\'s and T4\'s records, putting back each old value, down to the start records (line 4 is before the checkpoint but still undone).', 'The answer is 70 300 12: X keeps T3\'s 70; Y goes 260 to 280 to 300; Z goes 25 to 18 to 12.'],
    solution: '70 300 12', wrongs: ['70 280 18', '55 300 12', '70 280 12'],
    ref: '70 300 12. After redo, X = 70, Y = 260, Z = 25. Undo scans backward: line 13 sets Z = 18, line 11 sets Y = 280, line 9 sets Z = 12, line 4 sets Y = 300. X is untouched: its last writer, T3, committed.',
    check: kit.numSet([70, 300, 12], { ordered: true }),
  });

  C.exercise({
    id: 'ex19-undo-records', chapter: 19, title: 'What the undo phase writes', level: 2, kind: 'answer',
    text: [tbIntro, tbText, 'How many log records does the undo phase write in all (redo-only records and abort records)? Type one number.'],
    hints: ['Each undone update writes one redo-only record `<Ti, Xj, V>`.', 'Each loser also gets an `<Ti abort>` when its start record is reached.', 'The answer is 6: four redo-only records (lines 13, 11, 9 and 4) and two abort records (T4, then T2).'],
    solution: '6', wrongs: ['4', '5', '8'],
    ref: '6, in this order: <T4, Z, 18>, <T4, Y, 280>, <T4 abort>, <T2, Z, 12>, <T2, Y, 300>, <T2 abort>.',
    check: kit.number(6),
  });

  C.exercise({
    id: 'ex19-redo-lsn', chapter: 19, title: 'Where ARIES starts redo', level: 1, kind: 'answer',
    text: ['After the analysis pass, the dirty page table is:', { table: [['Page', 'recLSN'], ['P3', '140'], ['P7', '95'], ['P1', '120']] }, 'The last checkpoint record is at LSN 130. At which LSN does the redo pass start? Type one number.'],
    hints: ['Redo must reach the oldest change that might be missing from a page.', 'recLSN is the first record that dirtied a page since it was last written.', 'The answer is 95: RedoLSN is the smallest recLSN in the dirty page table, which can be older than the checkpoint.'],
    solution: '95', wrongs: ['130', '140', '120'],
    ref: '95. RedoLSN = min(recLSN) = 95 (page P7). It is before the checkpoint: a fuzzy checkpoint does not write pages, so P7 may still miss changes from LSN 95 on.',
    check: kit.number(95),
  });

  C.exercise({
    id: 'ex19-aries-redo', chapter: 19, title: 'Which records does ARIES redo?', level: 3, kind: 'answer',
    text: ['The log from RedoLSN on (every record is an update):', { table: [['LSN', 'Transaction', 'Page'], ['95', 'T1', 'P7'], ['100', 'T2', 'P1'], ['110', 'T1', 'P3'], ['120', 'T2', 'P1'], ['130', 'T3', 'P7'], ['140', 'T3', 'P3'], ['150', 'T2', 'P3']] }, 'The dirty page table after analysis: P7 recLSN 95, P1 recLSN 120, P3 recLSN 140. The PageLSNs on disk: P7 95, P1 100, P3 110.', 'Which records does the redo pass apply? Type their LSNs, for example `100 130`.'],
    hints: ['A record is skipped when its LSN is below its page\'s recLSN.', 'It is also skipped when the page, read from disk, already has PageLSN at least the record\'s LSN.', 'The answer is 120 130 140 150: 95 is on P7 already (PageLSN 95); 100 and 110 are below their pages\' recLSN; the rest are missing from their pages.'],
    solution: '120 130 140 150', wrongs: ['95 100 110 120 130 140 150', '130 140 150', '120 130 150'],
    ref: '120 130 140 150. LSN 95: PageLSN of P7 is 95, already there. LSN 100 and 110: below the recLSN of P1 (120) and P3 (140), so those changes reached the disk. LSN 120: P1 has PageLSN 100 < 120, redo. LSN 130: P7 has 95 < 130, redo. LSN 140 and 150: P3 has 110, then 140 after the first redo, redo both.',
    check: kit.numSet([120, 130, 140, 150]),
  });

  C.exercise({
    id: 'ex19-clr', chapter: 19, title: 'A crash during undo', level: 3, kind: 'answer',
    text: ['The stable log at a crash (each update notes its transaction\'s previous record):', { table: [['LSN', 'Record'], ['200', 'T5 updates P2 (first record of T5)'], ['210', 'T6 updates P4 (first record of T6)'], ['220', 'T5 updates P4, prevLSN 200'], ['230', 'T5 updates P9, prevLSN 220']] }, 'Neither transaction committed. Restart begins and undo writes two CLRs: LSN 240 compensating 230 (UndoNextLSN 220), and LSN 250 compensating 220 (UndoNextLSN 200). Then the system crashes again.', 'In the second restart, which records does the undo pass undo, in order? Type their LSNs, for example `230 220`.'],
    hints: ['After analysis, a transaction\'s next record to undo comes from its last record: for a CLR, its UndoNextLSN.', 'T5\'s last record is the CLR 250, so its next is 200. T6\'s last record is 210.', 'The answer is 210 200: undo always takes the largest LSN still to undo, and 230 and 220 are never undone again.'],
    solution: '210 200', wrongs: ['200 210', '230 220 210 200', '220 210 200'],
    ref: '210 200. T5: its newest record is CLR 250, whose UndoNextLSN is 200. T6: its newest record is 210. Undo takes the largest first, 210 (a CLR at 260), then 200 (a CLR at 270), and both transactions end. The CLRs keep 230 and 220 from being undone twice.',
    check: kit.numSet([210, 200], { ordered: true }),
  });

  // computed: three sessions, a commit that does not wait for the log, a crash, ARIES
  const STOCK = "create table stock (item text primary key, qty int); insert into stock values ('pen', 40), ('ink', 15), ('pad', 8); checkpoint;";
  function stockLosers() {
    const db = new K.Database();
    const s = [1, 2, 3].map((i) => db.session({ name: 'T' + i }));
    const xid = (x) => String(x.query('select txid_current()').rows[0][0]);
    const name = {};
    s[0].exec(STOCK);
    s[0].exec("set synchronous_commit = off; begin; update stock set qty = qty - 5 where item = 'pen'"); name[xid(s[0])] = 'T1';
    s[1].exec("begin; update stock set qty = qty + 10 where item = 'ink'"); name[xid(s[1])] = 'T2';
    s[1].exec('commit');
    s[0].exec('commit');
    s[2].exec("begin; update stock set qty = 0 where item = 'pad'"); name[xid(s[2])] = 'T3';
    K.Recovery.crash(db);
    const res = K.Recovery.restart(db, { algorithm: 'aries' });
    return res.losers.map((x) => name[String(x)] || 'T?');
  }
  C.exercise({
    id: 'ex19-who-is-undone', chapter: 19, title: 'Who does undo roll back?', level: 3, kind: 'answer',
    text: ['Three sessions work on `stock` (pen 40, ink 15, pad 8), just after a checkpoint, in this order:', { steps: ['T1 runs `set synchronous_commit = off`, begins, and takes 5 pens.', 'T2 begins, adds 10 ink, and commits (a normal, synchronous commit).', 'T1 commits; COMMIT returns at once.', 'T3 begins and sets pad to 0.', 'The system crashes.'] }, 'ARIES restarts the database. Which transactions does the undo pass roll back? Type them, for example `T1 T2`, or `none`.'],
    hints: ['A flush writes the whole log buffer. What did T2\'s commit flush?', 'T1\'s commit record was still in the buffer at the crash. T3\'s records were never flushed at all.', 'The answer is T1: its update reached the stable log with T2\'s commit, but its commit record did not, so it is a loser. T3 has no record in the stable log, so there is nothing to undo.'],
    solution: 'T1', wrongs: ['T1 T3', 'T3', 'none'],
    ref: 'T1. T2\'s commit flushed the buffer, T1\'s update with it. T1\'s own commit did not wait, and the crash lost its commit record: analysis finds T1 without a commit and undo rolls it back. T3 left no record on stable storage; its change is simply lost. Only T2 survives: ink 25, pen 40, pad 8.',
    check: (app, answer) => kit.txSet(stockLosers(), 'rolled back by undo')(app, answer),
  });

  C.exercise({
    id: 'ex19-safety', chapter: 19, title: 'How safe is the backup?', level: 1, kind: 'answer',
    text: ['A primary confirms a commit only after the remote backup has logged it, but when the backup is unreachable it goes on committing alone. Is it one-safe, two-safe or two-very-safe? Type one of those words.'],
    hints: ['One-safe never waits for the backup.', 'Two-very-safe always waits, so nothing commits while the backup is down.', 'The answer is two-safe: it waits for the backup while both sites are up, and runs alone otherwise.'],
    solution: 'two-safe', wrongs: ['two-very-safe', 'one-safe'],
    ref: 'two-safe. It behaves like two-very-safe while both sites are up and like one-safe while the backup is down, trading a small risk for availability.',
    check: (app, answer) => {
      const t = kit.norm(answer).replace(/[\s_]+/g, '-');
      if (!t) return kit.no('The editor is empty: type one-safe, two-safe or two-very-safe.');
      const kinds = ['two-very-safe', 'two-safe', 'one-safe'].filter((k) => new RegExp('(^|[^a-z-])' + k + '($|[^a-z-])').test(t));
      if (kinds.length !== 1) return kit.no('Type exactly one of: one-safe, two-safe, two-very-safe.');
      return kinds[0] === 'two-safe' ? kit.ok('Right: two-safe.') : kit.no('Not ' + kinds[0] + '. What does it do while the backup is down?');
    },
  });

  C.exercise({
    id: 'ex19-shadow', chapter: 19, title: 'Shadow paging and a crash', level: 1, kind: 'answer',
    text: ['Under shadow paging, a transaction changes pages 1 and 3. Its current page table has been written to disk, and then the system crashes before the database pointer is switched to it. After the restart, does the database hold the **old** or the **new** values of pages 1 and 3? Type `old` or `new`.'],
    hints: ['The database pointer decides which page table is the database.', 'Writing a page table to disk is not the commit; switching the pointer is.', 'The answer is old: the pointer still names the shadow page table, which points to the old blocks.'],
    solution: 'old', wrongs: ['new'],
    ref: 'old. Commit is the single atomic write of the database pointer. It never happened, so the shadow page table is still in force; the new blocks and the new table are garbage.',
    check: kit.choice(['old'], ['old', 'new']),
  });
})(typeof window !== 'undefined' ? window : globalThis);
