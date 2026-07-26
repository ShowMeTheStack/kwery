// Ready-made concurrency scenarios for the transactions view: the classic anomalies of chapter 17 and the
// protocol demonstrations of chapter 18, each a script per tab with the order to run the statements in, a
// question to answer before the interesting step, and what to expect under each protocol and isolation level.
// Data only (no DOM), so the tests can run the same scripts against the engine.
(function (root) {
  'use strict';
  const K = root.K;
  const UI = K.UI = K.UI || {};

  const ACCT = 'drop table if exists acct; create table acct (id int primary key, bal int); insert into acct values (1, 100), (2, 200);';
  const ACCT3 = 'drop table if exists acct; create table acct (id int primary key, bal int); insert into acct values (1, 100), (2, 200), (3, 300);';
  const STANDBY = "drop table if exists standby; create table standby (name text primary key, ready boolean); insert into standby values ('mara', true), ('tomas', true);";
  // each UPDATE then reads only its own row (an index scan), so the classic protocols lock just that row
  const BY_KEY = 'set enable_seqscan = off; set enable_bitmapscan = off;';
  const LOCKING = ['2pl', 'strict2pl', 'rigorous2pl', 'mv2pl'];

  const SCENARIOS = [
    {
      id: 'lost-update', title: 'Lost update', table: 'acct', row: 1,
      about: 'Two transactions read the same balance, compute a new one from what they read, and write it back. Under a weak scheme the second write silently replaces the first: one withdrawal is lost.',
      setup: ACCT, tabs: 2,
      steps: [[0, 'begin;'], [1, 'begin;'], [0, 'select bal from acct where id = 1;', 'T1 reads 100'], [1, 'select bal from acct where id = 1;', 'T2 reads 100 too'],
        [0, 'update acct set bal = 90 where id = 1;', 'T1 withdraws 10 from what it read'], [1, 'update acct set bal = 80 where id = 1;', 'T2 withdraws 20 from what it read'],
        [0, 'commit;'], [1, 'commit;'], [0, 'select bal from acct where id = 1;', 'the final balance']],
      predict: { step: 5, q: 'What happens to T2\'s UPDATE, and what is the final balance?', options: ['It waits, then the balance is 80 (T1\'s withdrawal is lost)', 'It fails, and the balance is 90', 'A deadlock: one of them is rolled back', 'It goes ahead at once'] },
      outcomes: [
        { when: { cc: 'mvcc', iso: 'read committed' }, text: 'T2\'s UPDATE waits for T1\'s row lock. When T1 commits, T2 re-reads the newest version and overwrites it: the final balance is 80 and T1\'s withdrawal is lost. READ COMMITTED allows the lost update.' },
        { when: { cc: 'mvcc' }, text: 'T2\'s UPDATE waits for T1. When T1 commits, T2 fails with "could not serialize access due to concurrent update" (first updater wins): the final balance is 90. Snapshot isolation prevents the lost update.' },
        { when: { cc: LOCKING }, text: 'Both hold S locks on the row. T1\'s UPDATE needs X and waits for T2; T2\'s UPDATE needs X and waits for T1: a cycle in the wait-for graph. The deadlock detector rolls T2 back, T1 goes on: the final balance is 90.' },
        { when: { cc: 'to' }, text: 'T1 is older. Its write comes after the younger T2 read the row (TS(T1) < R-timestamp), so T1 is rolled back; T2 writes 80. Nothing is lost: T1 must run again with a new timestamp.' },
        { when: { cc: 'occ' }, text: 'Validation lets both run their read phase. T2\'s UPDATE waits only for the row T1 is changing, and goes on when T1 validates and commits 90. At its COMMIT T2 fails validation, because T1 wrote what T2 read: the final balance is 90.' },
        { when: { cc: 'mvto' }, text: 'T1 tries to replace a version the younger T2 already read (TS(T1) < R-timestamp of the version): T1 is rolled back. T2 writes its version: the final balance is 80, and T1 must retry.' },
      ],
    },
    {
      id: 'dirty-read', title: 'Dirty read', table: 'acct', row: 1,
      about: 'T1 changes a row and later rolls back. Can T2 read the value T1 wrote before T1 decides? Reading uncommitted data is a dirty read; if T1 aborts, T2 has seen a value that never existed.',
      setup: ACCT, tabs: 2,
      steps: [[0, 'begin;'], [0, 'update acct set bal = 0 where id = 1;', 'T1 writes 0, not committed'], [1, 'begin;'], [1, 'select bal from acct where id = 1;', 'T2 reads the row'], [0, 'rollback;', 'T1 aborts'], [1, 'select bal from acct where id = 1;'], [1, 'commit;']],
      predict: { step: 3, q: 'What will T2\'s SELECT return?', options: ['0 (T1\'s uncommitted value)', '100, at once', '100, after waiting for T1 to finish', 'An error'] },
      outcomes: [
        { when: { cc: 'mvcc' }, text: 'T2 reads 100 at once: its snapshot does not include the uncommitted transaction T1, and readers never wait for writers. PostgreSQL never shows dirty data, even under READ UNCOMMITTED.' },
        { when: { cc: 'occ' }, text: 'T1\'s write lives in its private copy until its write phase, so T2 reads the database value, 100, without waiting.' },
        { when: { cc: ['2pl', 'strict2pl', 'rigorous2pl', 'mv2pl', 'to', 'mvto'] }, text: 'T2 waits: the row is locked X by T1 (or, under timestamp ordering, its writer has not committed). When T1 rolls back, T2 goes on and reads 100.' },
      ],
    },
    {
      id: 'unrepeatable', title: 'Non-repeatable read', table: 'acct', row: 1,
      about: 'T1 reads a row twice. Between the two reads T2 updates the row and commits. If T1\'s second read sees the new value, its read was not repeatable.',
      setup: ACCT, tabs: 2,
      steps: [[0, 'begin;'], [0, 'select bal from acct where id = 1;', 'T1 reads 100'], [1, 'update acct set bal = 50 where id = 1;', 'T2 updates and commits (autocommit)'], [0, 'select bal from acct where id = 1;', 'T1 reads again'], [0, 'commit;']],
      predict: { step: 3, q: 'What will T1\'s second SELECT return?', options: ['50', '100', 'An error'] },
      outcomes: [
        { when: { cc: 'mvcc', iso: 'read committed' }, text: 'T1 reads 50: under READ COMMITTED each statement takes a new snapshot, and T2 committed in between. The read is not repeatable.' },
        { when: { cc: 'mvcc' }, text: 'T1 reads 100 again: the whole transaction reads from the snapshot taken at its first statement, so T2\'s committed update is invisible to it.' },
        { when: { cc: LOCKING }, text: 'T1 holds an S lock on the row, so T2\'s UPDATE waits. T1 reads 100 again, and T2 goes on only when T1 commits.' },
        { when: { cc: 'to' }, text: 'T2 is younger and writes at once (W-timestamp := TS(T2)). T1\'s second read comes too late: TS(T1) < W-timestamp, so T1 is rolled back.' },
        { when: { cc: 'occ' }, text: 'T1\'s second read sees 50, the newest committed value. At COMMIT, T1 fails validation: T2 finished after T1 started and wrote what T1 read.' },
        { when: { cc: 'mvto' }, text: 'T1 keeps reading the version whose W-timestamp is the largest not above TS(T1): 100. T2\'s newer version is for younger transactions.' },
      ],
    },
    {
      id: 'phantom', title: 'Phantom', table: 'acct', row: 1,
      about: 'T1 counts the rows that satisfy a predicate twice; in between, T2 inserts a new row that satisfies it. Locking the rows T1 read does not stop the insert: the new row is a phantom.',
      setup: ACCT, tabs: 2,
      steps: [[0, 'begin;'], [0, 'select count(*) from acct where bal > 50;', 'T1 counts 2'], [1, 'insert into acct values (3, 300);', 'T2 inserts a matching row (autocommit)'], [0, 'select count(*) from acct where bal > 50;', 'T1 counts again'], [0, 'commit;']],
      predict: { step: 3, q: 'What will T1\'s second count return?', options: ['2', '3', 'An error'] },
      outcomes: [
        { when: { cc: 'mvcc', iso: 'read committed' }, text: 'T1 counts 3: the new statement\'s snapshot sees T2\'s committed insert. The phantom appears.' },
        { when: { cc: 'mvcc' }, text: 'T1 counts 2 again: its snapshot was taken before T2 committed. In PostgreSQL neither REPEATABLE READ nor SERIALIZABLE shows phantoms.' },
        { when: { cc: LOCKING, phantom: true }, text: 'With phantom_protection on, T1\'s scan locks the table (or the index range) in S, so T2\'s insert, which needs IX, waits until T1 commits. T1 counts 2 again.' },
        { when: { cc: LOCKING }, text: 'T1 locked the two rows it read, but the new row did not exist then: T2\'s insert takes no lock T1 holds, and T1 counts 3. Run SET phantom_protection = on in every tab to lock the predicate (the relation or next keys) as well.' },
        { when: { cc: 'to' }, text: 'T1\'s rescan meets the row the younger T2 inserted: its W-timestamp is TS(T2) > TS(T1), so reading it would read from T1\'s future, and T1 is rolled back.' },
        { when: { cc: 'occ' }, text: 'T1 counts 3 and commits unless phantom_protection is on, when the relation counts as an item T2 wrote and T1 fails validation.' },
        { when: { cc: 'mvto' }, text: 'T1 counts 2: the new row\'s version has a W-timestamp above TS(T1), so T1 does not read it.' },
      ],
    },
    {
      id: 'write-skew', title: 'Write skew (understudies on standby)', table: 'standby', row: 'mara',
      about: 'The rule: at least one understudy must be on standby for tonight\'s show. Mara and Tomas both check that two are on standby, then each takes the night off. Neither write conflicts with the other, but together they break the rule. Snapshot isolation allows it; serializable snapshot isolation does not.',
      setup: STANDBY, tabs: 2, suggest: { iso: 'serializable' },
      steps: [[0, 'begin;'], [1, 'begin;'], [0, 'select count(*) from standby where ready;', 'Mara sees 2 on standby'], [1, 'select count(*) from standby where ready;', 'Tomas sees 2 on standby'],
        [0, "update standby set ready = false where name = 'mara';"], [1, "update standby set ready = false where name = 'tomas';"], [0, 'commit;'], [1, 'commit;'], [0, 'select * from standby;', 'who is on standby now?']],
      predict: { step: 7, q: 'Will Tomas\'s COMMIT succeed?', options: ['Yes: nobody is on standby', 'No: a serialization failure', 'It never gets there (a deadlock earlier)'] },
      outcomes: [
        { when: { cc: 'mvcc', iso: 'serializable' }, text: 'SSI records rw-antidependencies: T1 read the row T2 wrote and T2 read the row T1 wrote, two rw edges in a row, a dangerous structure. When T1 commits first, T2 fails at COMMIT with "could not serialize access due to read/write dependencies". Tomas is still on standby.' },
        { when: { cc: 'mvcc' }, text: 'Both COMMITs succeed: they wrote different rows, so snapshot isolation sees no conflict. Nobody is on standby. This is write skew; switch the isolation level to SERIALIZABLE and run it again.' },
        { when: { cc: LOCKING }, text: 'Each count holds S locks on both rows. T1\'s UPDATE waits for T2\'s S lock on mara; T2\'s UPDATE then waits for T1\'s S lock on tomas: deadlock. T2 is rolled back, T1 commits; Tomas is still on standby.' },
        { when: { cc: 'to' }, text: 'T1 (older) writes mara after the younger T2 read it: T1 is rolled back at its UPDATE. T2 commits; Mara stays on standby.' },
        { when: { cc: 'occ' }, text: 'T1 validates first and commits. T2 fails validation: T1 wrote mara, which T2 read. Tomas stays on standby.' },
        { when: { cc: 'mvto' }, text: 'T1 replaces the version of mara that the younger T2 read: T1 is rolled back, T2 commits.' },
      ],
    },
    {
      id: 'deadlock', title: 'Deadlock', table: 'acct', row: 1,
      about: 'T1 updates row 1 and then row 2; T2 updates row 2 and then row 1. Each ends up waiting for the other: a cycle in the wait-for graph. Something has to give: detection rolls back a victim, the timestamp schemes prevent the cycle.',
      setup: ACCT, tabSetup: BY_KEY, tabs: 2,
      steps: [[0, 'begin;'], [1, 'begin;'], [0, 'update acct set bal = bal - 10 where id = 1;', 'T1 locks row 1'], [1, 'update acct set bal = bal - 20 where id = 2;', 'T2 locks row 2'],
        [0, 'update acct set bal = bal + 10 where id = 2;', 'T1 needs row 2: it waits for T2'], [1, 'update acct set bal = bal + 20 where id = 1;', 'T2 needs row 1: it waits for T1'], [0, 'commit;'], [1, 'rollback;']],
      predict: { step: 5, q: 'What happens when T2 asks for row 1?', options: ['It waits for ever', 'Deadlock: T2 is rolled back, T1 goes on', 'T1 is rolled back'] },
      outcomes: [
        { when: { dl: 'wait-die' }, text: 'Wait-die: the older T1 may wait for the younger T2 (step 5). When the younger T2 asks for the row the older T1 holds, it dies at once: rolled back without a cycle ever forming. T1 goes on.' },
        { when: { dl: 'wound-wait' }, text: 'Wound-wait: at step 5 the older T1 asks for the row the younger T2 holds and wounds it: T2 is rolled back on the spot and T1 goes on. T2 learns of it at its next statement.' },
        { when: { dl: 'timeout' }, text: 'Timeout: nobody looks for cycles. Each wait ends after deadlock_timeout (1 s); step again after a second and the waiting statement is cancelled.' },
        { when: { cc: 'mvto' }, text: 'Under multiversion timestamp ordering T1 never waits: row 2 already has a version written by the younger T2, so T1\'s write is rejected and T1 is rolled back at step 5.' },
        { when: {}, text: 'T2\'s request closes the cycle T1 -> T2 -> T1 in the wait-for graph. The detector rolls back the transaction whose wait closed it (T2, "deadlock detected"), and T1\'s UPDATE goes on.' },
      ],
    },
    {
      id: 'deadlock3', title: 'Three-way deadlock', table: 'acct', row: 1, tabs: 3,
      about: 'Three transactions, each holding one row and asking for the next one\'s: the wait-for graph has a cycle of length three, T1 -> T2 -> T3 -> T1.',
      setup: ACCT3, tabSetup: BY_KEY,
      steps: [[0, 'begin;'], [1, 'begin;'], [2, 'begin;'], [0, 'update acct set bal = 1 where id = 1;'], [1, 'update acct set bal = 2 where id = 2;'], [2, 'update acct set bal = 3 where id = 3;'],
        [0, 'update acct set bal = 1 where id = 2;', 'T1 waits for T2'], [1, 'update acct set bal = 2 where id = 3;', 'T2 waits for T3'], [2, 'update acct set bal = 3 where id = 1;', 'T3 waits for T1: a cycle'], [2, 'rollback;'], [1, 'commit;'], [0, 'commit;']],
      predict: { step: 8, q: 'Which transaction fails when T3 asks for row 1?', options: ['T1', 'T2', 'T3', 'None: they all wait'] },
      outcomes: [
        { when: { dl: 'wait-die' }, text: 'Wait-die: T1 waits for the younger T2 and T2 for the younger T3, but T3 (the youngest) dies when it asks for T1\'s row.' },
        { when: { dl: 'wound-wait' }, text: 'Wound-wait: T1 wounds T2 at step 7 and goes on; T2 learns of its rollback at its next statement. T3 then waits for T1 (a younger transaction waits for an older one), so its ROLLBACK at step 10 has to be skipped: it goes on when T1 commits. No cycle ever forms.' },
        { when: { cc: 'mvto' }, text: 'Nobody waits under multiversion timestamp ordering: T1 and T2 each try to replace a row a younger transaction has already written, and are rolled back at once; T3 goes on.' },
        { when: { cc: ['mvcc', '2pl', 'strict2pl', 'rigorous2pl', 'mv2pl'], iso: 'read committed' }, text: 'T3\'s request closes the cycle T1 -> T2 -> T3 -> T1, and T3 is the victim. T2 then gets row 3; when T2 commits, T1 gets row 2.' },
        { when: { cc: LOCKING }, text: 'T3\'s request closes the cycle T1 -> T2 -> T3 -> T1, and T3 is the victim. T2 then gets row 3; when T2 commits, T1 gets row 2.' },
        { when: {}, text: 'T3\'s request closes the cycle T1 -> T2 -> T3 -> T1, and T3 is the victim; T2 then gets row 3. When T2 commits, T1 is woken but fails: under snapshot isolation (concurrent update), timestamp ordering or validation it cannot go on with a row a later transaction changed.' },
      ],
    },
    {
      id: 'cascade', title: 'Cascading rollback (basic 2PL)', table: 'acct', row: 1,
      about: 'Basic two-phase locking may release exclusive locks after the lock point, before commit. Another transaction can then read the uncommitted value; when the writer aborts, the reader must abort too.',
      setup: ACCT, tabs: 2, require: { cc: ['2pl', 'strict2pl', 'rigorous2pl'], use: { cc: '2pl' } },
      steps: [[0, 'begin;'], [0, 'update acct set bal = 5 where id = 1;', 'T1 writes 5 under an X lock'], [0, 'select lock_point();', 'T1 declares its lock point and releases what it may'], [1, 'begin;'],
        [1, 'select bal from acct where id = 1;', 'T2 reads the row'], [0, 'rollback;', 'T1 aborts'], [1, 'select bal from acct where id = 1;'], [1, 'rollback;']],
      predict: { step: 4, q: 'What will T2\'s SELECT return?', options: ['5 (T1\'s uncommitted value)', '100', 'It waits'] },
      outcomes: [
        { when: { cc: '2pl' }, text: 'Basic 2PL released T1\'s X lock at the lock point, so T2 reads 5, uncommitted data. When T1 rolls back, T2 is rolled back with it (a cascading rollback): its next statement fails.' },
        { when: { cc: 'strict2pl' }, text: 'Strict 2PL releases only S locks at the lock point; the X lock stays to the end. T2 waits, and after T1 rolls back it reads 100. No cascade.' },
        { when: { cc: 'rigorous2pl' }, text: 'Rigorous 2PL releases nothing before the end: T2 waits and then reads 100.' },
      ],
    },
    {
      id: 'thomas', title: 'Thomas\' write rule', table: 'acct', row: 1,
      about: 'Under timestamp ordering an older transaction that writes an item a younger one already wrote is too late. Basic TO rolls it back; Thomas\' write rule just ignores the obsolete write, because no one could ever read it.',
      setup: ACCT, tabs: 2, require: { cc: ['to'], use: { cc: 'to', thomas: true } },
      steps: [[0, 'begin;'], [0, 'select bal from acct where id = 1;', 'T1 (older) reads: R-timestamp := TS(T1)'], [1, 'begin;'], [1, 'update acct set bal = 2 where id = 1;', 'T2 (younger) writes: W-timestamp := TS(T2)'], [1, 'commit;'],
        [0, 'update acct set bal = 1 where id = 1;', 'T1 writes: TS(T1) < W-timestamp'], [0, 'commit;'], [0, 'select bal from acct where id = 1;']],
      predict: { step: 5, q: 'What happens to T1\'s UPDATE?', options: ['It overwrites T2\'s value', 'It is ignored (UPDATE 0)', 'T1 is rolled back'] },
      outcomes: [
        { when: { thomas: true }, text: 'TS(T1) < W-timestamp(acct.1): the write is obsolete. Thomas\' write rule ignores it (UPDATE 0) and T1 commits; the balance stays 2, as in the serial order T1, T2.' },
        { when: {}, text: 'Basic timestamp ordering rolls T1 back: TS(T1) < W-timestamp. Turn on Thomas\' write rule (protocol "TO + Thomas") and run it again.' },
      ],
    },
  ];

  /** does a setting { cc, iso, dl, thomas, phantom } match an outcome's condition? */
  function matches(when, cfg) {
    for (const [k, v] of Object.entries(when || {})) {
      if (Array.isArray(v) ? !v.includes(cfg[k]) : cfg[k] !== v) return false;
    }
    return true;
  }
  const outcome = (sc, cfg) => sc.outcomes.find((o) => matches(o.when, cfg)) || null;

  UI.TxnScenarios = { list: SCENARIOS, matches, outcome };
})(typeof window !== 'undefined' ? window : globalThis);
