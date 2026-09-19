// Chapter 18: concurrency control. Two-phase locking and its variants, deadlocks, multiple granularity, phantoms,
// timestamp ordering, validation, multiversion schemes, snapshot isolation, serializable snapshot isolation, and
// MVCC as PostgreSQL does it. Most lessons use two editor tabs: a block marked "In tab 2" is run in the second tab.
(function (root) {
  'use strict';
  const K = root.K;
  const C = K.Content;
  const kit = C.kit1726;
  const lesson = kit.lesson;

  // a small table of accounts, made again at the start of each lesson
  const ACCT = 'drop table if exists acct;\ncreate table acct (id int primary key, owner text, bal int);\ninsert into acct values (1, \'Ada\', 100), (2, \'Ben\', 200), (3, \'Cleo\', 300);';
  const CREW = "drop table if exists crew;\ncreate table crew (name text primary key, post text, on_post boolean);\ninsert into crew values ('Ravi', 'fly rail', true), ('Mona', 'fly rail', true), ('Tess', 'fly rail', true);";
  const LOCKS = "select relation, mode, granted, pid\nfrom pg_locks\nwhere locktype = 'object';";

  // ---- 18.1 two-phase locking -----------------------------------------------------------------------------------
  lesson({
    id: 'cc-2pl', chapter: 18, title: 'Locks and two-phase locking', minutes: 15,
    summary: 'Shared and exclusive locks, the growing and shrinking phases, the lock point, and why strict and rigorous two-phase locking hold some locks to the end.',
    body: [
      'A **lock-based protocol** makes a transaction ask for a lock on a data item before it touches it. There are two modes. A **shared** lock (S) lets the holder read the item. An **exclusive** lock (X) lets it read and write. Many transactions may share an item; only one may hold it exclusively.',
      { table: [['Requested', 'Another holds S', 'Another holds X'], ['S', 'granted', 'waits'], ['X', 'waits', 'waits']] },
      'Kwery normally runs PostgreSQL\'s multiversion scheme, where readers never wait. To watch locks at work, switch it to two-phase locking. The data items are the rows of a small table. `enable_seqscan = off` makes each statement find its row through the primary key, so it locks only that row.',
      { sql: ACCT + "\nset concurrency_control = '2pl';\nset enable_seqscan = off;", note: 'In tab 1. The protocol is a setting of the whole database, so it holds for every tab.' },
      'Open a second editor tab with the **+** next to the editor tab, and run this there once:',
      { sql: 'set enable_seqscan = off;', tab: 2, note: 'In tab 2.' },
      'Now let tab 1 read one row and change another, and list the locks it holds:',
      { sql: 'begin;\nselect bal from acct where id = 1;\nupdate acct set bal = bal - 30 where id = 2;\n' + LOCKS, note: 'In tab 1. Look for S on acct.1 and X on acct.2. The IS and IX locks above them come in a later lesson.' },
      { sql: 'select bal from acct where id = 1;', tab: 2, note: 'In tab 2. S is compatible with S: tab 2 reads 100 at once.' },
      { predict: { q: 'In tab 2, read row 2, which tab 1 has updated and still holds in X mode. What happens?', options: ['Tab 2 waits until tab 1 ends', 'Tab 2 reads 200 at once', 'Tab 2 reads 170 at once', 'Tab 2 gets an error'], answer: 0, explain: 'An S request conflicts with an X lock held by another transaction, so tab 2 waits. Run `commit;` in tab 1 and tab 2 goes on and reads 170.' }, sql: 'select bal from acct where id = 2;', tab: 2, waits: true },
      { sql: 'commit;', note: 'In tab 1. Tab 2 now gets its row: 170.' },
      { h: 'Two phases and the lock point' },
      'Locking alone does not give serializable schedules: a transaction that unlocks an item and later locks another can let a second transaction slip in between. The **two-phase locking protocol** (2PL) forbids that. Each transaction has a **growing phase**, in which it may acquire locks but release none, then a **shrinking phase**, in which it may release locks but acquire none.',
      'The moment a transaction acquires its last lock is its **lock point**. Ordering transactions by their lock points gives an equivalent serial order. Kwery lets a transaction declare its lock point with `select lock_point()`. Under basic 2PL every lock is released there. After it, asking for a new lock breaks the protocol:',
      { sql: 'begin;\nselect bal from acct where id = 1;\nselect lock_point();\nupdate acct set bal = 0 where id = 3;', fails: '25000', note: 'In tab 1. The update fails: the transaction is in its shrinking phase.' },
      { sql: 'rollback;', note: 'In tab 1.' },
      { h: 'Basic 2PL can cascade' },
      'Basic 2PL may release an X lock before the transaction commits. Another transaction can then read a value that may still be rolled back. Watch it happen:',
      { sql: 'begin;\nupdate acct set bal = 5 where id = 1;\nselect lock_point();', note: 'In tab 1. The X lock on row 1 is released at the lock point, before any commit.' },
      { sql: 'begin;\nselect bal from acct where id = 1;', tab: 2, note: 'In tab 2. It reads 5, a value tab 1 has not committed.' },
      { sql: 'rollback;', note: 'In tab 1. The value 5 never existed.' },
      { sql: 'select bal from acct where id = 1;', tab: 2, fails: '25P02', note: 'In tab 2. Its transaction was rolled back along with tab 1: a cascading rollback.' },
      { sql: 'rollback;', tab: 2, note: 'In tab 2.' },
      { table: [['Variant', 'What it releases at the lock point', 'Schedules it produces'], ['Basic 2PL', 'every lock', 'conflict serializable; cascading rollbacks possible'], ['Strict 2PL', 'S locks only; X locks wait for commit or abort', 'serializable and cascadeless'], ['Rigorous 2PL', 'nothing: every lock is held to the end', 'serializable; commit order is the serial order']] },
      'Run the same steps under strict 2PL.',
      { sql: "set concurrency_control = 'strict2pl';\nbegin;\nupdate acct set bal = 5 where id = 1;\nselect lock_point();", note: 'In tab 1. Only shared locks go at the lock point.' },
      { sql: 'begin;\nselect bal from acct where id = 1;', tab: 2, waits: true, note: 'In tab 2. It waits for the X lock, which strict 2PL keeps.' },
      { sql: 'rollback;', note: 'In tab 1. Tab 2 now reads 100, a committed value, and nothing cascades.' },
      { sql: 'commit;\nreset enable_seqscan;', tab: 2, note: 'In tab 2.' },
      { sql: "set concurrency_control = 'mvcc';\nreset enable_seqscan;\ndrop table acct;", note: 'In tab 1: back to the usual scheme.' },
      { tip: 'The schedule workbench runs any schedule under each variant and shows the lock and unlock operations it inserts. Pick **Basic 2PL** or **Strict 2PL** in its protocol menu.' },
      { view: 'schedule', sel: { schedule: 'w1(A) r2(A) w2(B) a1 c2' }, label: 'Open this schedule in the workbench' },
      { view: 'txn', sel: { scenario: 'cascade' }, label: 'Or replay the cascade as a scenario' },
    ],
  });

  // ---- 18.2 deadlocks -------------------------------------------------------------------------------------------
  lesson({
    id: 'cc-deadlock', chapter: 18, title: 'Deadlocks: detection and prevention', minutes: 14,
    summary: 'Two transactions each wait for the other. Detect the cycle and roll back a victim, or prevent it with wait-die, wound-wait or timeouts.',
    body: [
      'Two-phase locking does not prevent **deadlock**: a set of transactions in which each waits for a lock another one holds. Nobody can move, so the system must break the cycle by rolling a transaction back. There are two broad approaches: detect deadlocks after they form, or prevent them from forming.',
      { sql: ACCT, note: 'In tab 1.' },
      { h: 'Detection' },
      'The lock manager keeps a **wait-for graph**: an edge Ti → Tj when Ti waits for a lock Tj holds. A deadlock is a cycle in that graph. Create one. Each tab updates one row, then the other tab\'s row.',
      { sql: 'begin;\nupdate acct set bal = bal - 10 where id = 1;', note: 'In tab 1. It holds row 1.' },
      { sql: 'begin;\nupdate acct set bal = bal - 20 where id = 2;', tab: 2, note: 'In tab 2. It holds row 2.' },
      { sql: 'update acct set bal = bal + 10 where id = 2;', waits: true, note: 'In tab 1. It waits for tab 2: the edge T1 → T2.' },
      { predict: { q: 'Tab 2 now asks for row 1. What happens?', options: ['A deadlock is detected and tab 2 is rolled back; tab 1 goes on', 'Both wait for ever', 'Tab 1 is rolled back; tab 2 goes on', 'Tab 2 gets row 1 at once'], answer: 0, explain: 'The new edge T2 → T1 closes a cycle. Kwery, like PostgreSQL, picks the transaction whose request closed the cycle as the **victim**: tab 2 gets "deadlock detected", and tab 1\'s waiting update finishes.' }, sql: 'update acct set bal = bal + 20 where id = 1;', tab: 2, fails: '40P01' },
      { sql: 'commit;', note: 'In tab 1.' },
      { sql: 'rollback;', tab: 2, note: 'In tab 2. Its work is lost; an application would run it again.' },
      'Choosing a victim is a policy. A system may pick the transaction that has done the least work, holds the fewest locks, or has been rolled back least often. The last point matters: a transaction that is always the victim **starves**.',
      { h: 'Prevention with timestamps' },
      'Each transaction gets a timestamp when it begins; a smaller timestamp means **older**. When Ti asks for an item Tj holds:',
      { table: [['Scheme', 'Ti older than Tj', 'Ti younger than Tj'], ['Wait-die (non-preemptive)', 'Ti waits', 'Ti dies (rolled back)'], ['Wound-wait (preemptive)', 'Ti wounds Tj: Tj is rolled back', 'Ti waits']] },
      'In both, only older transactions are allowed to wait for younger ones, or only younger for older, so no cycle can form. In the schemes as usually described, a rolled-back transaction keeps its old timestamp when it restarts, so it grows older and is not rolled back for ever. Kwery cannot tell a restart from a new transaction, so each transaction gets a timestamp of its own when it begins.',
      'Try wait-die. The setting belongs to each session, so set it in both tabs. This time tab 2 begins first, so it is the older one.',
      { sql: "set deadlock_handling = 'wait-die';\nbegin;\nupdate acct set bal = bal - 20 where id = 2;", tab: 2, note: 'In tab 2 (older).' },
      { sql: "set deadlock_handling = 'wait-die';\nbegin;\nupdate acct set bal = bal - 10 where id = 1;", note: 'In tab 1 (younger).' },
      { sql: 'update acct set bal = bal + 20 where id = 1;', tab: 2, waits: true, note: 'In tab 2. The older transaction may wait for the younger one.' },
      { sql: 'update acct set bal = bal + 10 where id = 2;', fails: '40P01', note: 'In tab 1. The younger one asks for what the older holds: it dies at once, before any cycle exists.' },
      { sql: 'rollback;', note: 'In tab 1. Tab 2\'s update goes ahead.' },
      { sql: 'commit;', tab: 2, note: 'In tab 2.' },
      'Timestamps follow the order in which transactions begin. Next, tab 1 begins first, so its new transaction is the older one.',
      'Now wound-wait, with the same moves.',
      { sql: "set deadlock_handling = 'wound-wait';\nbegin;\nupdate acct set bal = bal - 10 where id = 1;", note: 'In tab 1 (older: it begins first).' },
      { sql: "set deadlock_handling = 'wound-wait';\nbegin;\nupdate acct set bal = bal - 20 where id = 2;", tab: 2, note: 'In tab 2 (younger).' },
      { predict: { q: 'Under wound-wait, the older tab 1 asks for row 2, which the younger tab 2 holds. What happens?', options: ['Tab 2 is rolled back and tab 1 gets the row at once', 'Tab 1 waits for tab 2', 'Tab 1 is rolled back', 'A deadlock is detected later'], answer: 0, explain: 'An older transaction never waits for a younger one under wound-wait: it wounds it. Tab 2 is rolled back on the spot, and finds out at its next statement.' }, sql: 'update acct set bal = bal + 10 where id = 2;' },
      { sql: 'select bal from acct where id = 1;', tab: 2, fails: '40P01', note: 'In tab 2. Its transaction was wounded and rolled back while it sat idle; this first statement reports that. Any further statement gets 25P02 until ROLLBACK.' },
      { sql: "rollback;\nreset deadlock_handling;", tab: 2, note: 'In tab 2.' },
      { sql: "commit;\nreset deadlock_handling;\nselect * from acct order by id;", note: 'In tab 1.' },
      { h: 'Timeouts' },
      'The simplest scheme of all: a transaction that has waited longer than some limit gives up and rolls back. It needs no graph and no timestamps, but the limit is hard to choose. Too short, and transactions that were only slow are rolled back; too long, and a real deadlock wastes time. In Kwery, `deadlock_handling = \'timeout\'` waits `deadlock_timeout` (1 s). Try it in the transactions view: pick **Timeout** in the deadlock menu, set up the deadlock scenario, and step again after a second.',
      { view: 'txn', sel: { scenario: 'deadlock' }, label: 'Set up the deadlock scenario in the transactions view' },
      { tip: 'The **Locks** tab of the transactions view draws the wait-for graph as it changes. The three-way deadlock scenario shows a cycle of length three.' },
      { sql: 'drop table acct;', note: 'In tab 1.' },
    ],
  });

  // ---- 18.3 multiple granularity --------------------------------------------------------------------------------
  lesson({
    id: 'cc-granularity', chapter: 18, title: 'Multiple granularity: IS, IX, S, SIX, X', minutes: 12,
    summary: 'Locks on the database, on tables and on rows, tied together by intention locks, so that a whole table can be locked without checking every row.',
    body: [
      'Locking every row is fine for a transaction that touches a few rows, and wasteful for one that reads a whole table. The **multiple-granularity** scheme lets a transaction lock a node of a tree (the database, a table, a row) and so implicitly lock everything below it.',
      'The difficulty is the other direction: before granting S on a whole table, the lock manager must know that nobody holds X on any row of it. **Intention locks** answer that without searching. Before locking a node, a transaction locks every ancestor in an intention mode.',
      { def: 'IS (intention shared).', text: 'Some descendant will be locked in S.' },
      { def: 'IX (intention exclusive).', text: 'Some descendant will be locked in X (or S).' },
      { def: 'SIX (shared and intention exclusive).', text: 'The node itself is locked in S, and some descendant will be locked in X. Typical of a transaction that reads a whole table and updates a few rows.' },
      { table: [['Requested \\ held', 'IS', 'IX', 'S', 'SIX', 'X'], ['IS', 'yes', 'yes', 'yes', 'yes', 'no'], ['IX', 'yes', 'yes', 'no', 'no', 'no'], ['S', 'yes', 'no', 'yes', 'no', 'no'], ['SIX', 'yes', 'no', 'no', 'no', 'no'], ['X', 'no', 'no', 'no', 'no', 'no']] },
      'Locks are taken from the root down and released from the leaves up. Kwery\'s two-phase locking uses exactly this tree: the database, then each table, then each row.',
      { sql: ACCT + "\nset concurrency_control = '2pl';\nset enable_seqscan = off;", note: 'In tab 1.' },
      { sql: 'begin;\nupdate acct set bal = 0 where id = 1;\n' + LOCKS, note: 'In tab 1. IX on the database, IX on the table, X on row 1.' },
      { sql: 'set enable_seqscan = off;\nbegin;\nselect bal from acct where id = 3;\n' + LOCKS, tab: 2, note: 'In tab 2. IS and IX are compatible, so tab 2 locks the table in IS and row 3 in S beside tab 1.' },
      { sql: 'commit;', note: 'In tab 1.' },
      { sql: 'commit;', tab: 2, note: 'In tab 2.' },
      { h: 'SIX at work' },
      'Ask for table-level locks on scans: `lock_granularity = \'table\'` makes a scan of the whole table lock it in S instead of locking row by row. Then update one row in the same transaction.',
      { sql: "set lock_granularity = 'table';\nbegin;\nselect sum(bal) from acct;\nupdate acct set bal = 0 where id = 1;\n" + LOCKS, note: 'In tab 1. Holding S on the table and asking for IX gives SIX.' },
      { predict: { q: 'Tab 1 holds SIX on the table. In tab 2, a transaction reads row 3 (asking for IS on the table, S on the row). Does it wait?', options: ['No: IS is compatible with SIX', 'Yes: SIX blocks every other lock', 'Yes: S on the row conflicts with S on the table'], answer: 0, explain: 'SIX conflicts only with modes that might write under it or that need the whole table unchanged. IS is compatible with it, so tab 2 reads 300 at once.' }, sql: 'begin;\nselect bal from acct where id = 3;', tab: 2 },
      { sql: 'update acct set bal = 1 where id = 3;', tab: 2, waits: true, note: 'In tab 2. Writing needs IX on the table, which conflicts with SIX: it waits.' },
      { sql: 'commit;\nreset lock_granularity;', note: 'In tab 1. Tab 2\'s update now goes ahead.' },
      { sql: 'commit;\nreset enable_seqscan;', tab: 2, note: 'In tab 2.' },
      { h: 'Table locks in PostgreSQL' },
      'PostgreSQL has its own eight table lock modes, with names like ACCESS SHARE (taken by every SELECT) and ROW EXCLUSIVE (taken by every UPDATE). LOCK TABLE takes one explicitly. Back under the usual scheme, a SHARE lock lets others read but makes every writer wait:',
      { sql: "set concurrency_control = 'mvcc';\nreset enable_seqscan;\nbegin;\nlock table acct in share mode;\nselect locktype, relation, mode from pg_locks where locktype = 'relation';", note: 'In tab 1.' },
      { sql: "update acct set owner = 'Bea' where id = 2;", tab: 2, waits: true, note: 'In tab 2. It needs ROW EXCLUSIVE, which conflicts with SHARE.' },
      { sql: 'commit;', note: 'In tab 1. Tab 2\'s update goes ahead.' },
      { sql: 'drop table acct;', note: 'In tab 1.' },
      { tip: 'Many systems also **escalate**: when a transaction holds too many row locks on one table, they are traded for a single table lock, saving memory at the cost of concurrency.' },
    ],
  });

  // ---- 18.4 phantoms --------------------------------------------------------------------------------------------
  lesson({
    id: 'cc-phantom', chapter: 18, title: 'Insertions, deletions and phantoms', minutes: 13,
    summary: 'A row that did not exist cannot be locked. Lock the relation, or lock index ranges with next-key locking, so that inserts cannot slip under a predicate.',
    body: [
      'A **delete** needs an X lock on the row, like a write. An **insert** creates a row that its transaction holds in X until the end. Neither is surprising. The trouble is a row that does not exist yet.',
      'A transaction that reads every row satisfying a condition locks the rows it found. A second transaction can still insert a new row that satisfies the condition: no lock conflicts, because the first transaction never locked that row. If the first reads again it finds a **phantom**. The conflict is about a *predicate*, not about any row.',
      { sql: 'drop table if exists acct;\ncreate table acct (id int primary key, bal int);\ninsert into acct values (10, 100), (20, 200), (30, 300), (40, 400);\nset concurrency_control = \'2pl\';', note: 'In tab 1.' },
      { sql: 'begin;\nselect count(*) from acct where bal > 150;', note: 'In tab 1. Three rows, now locked in S.' },
      { sql: 'insert into acct values (50, 500);', tab: 2, note: 'In tab 2. Nothing it needs is locked, so it commits at once.' },
      { predict: { q: 'Tab 1 counts again, inside the same transaction. What does it get?', options: ['4: the new row is a phantom', '3: two-phase locking makes the read repeatable', 'It waits for tab 2'], answer: 0, explain: 'Tab 1 locked the three rows it read, and the new row was not among them. Two-phase locking on rows does not protect a predicate, so the count changes inside one transaction.' }, sql: 'select count(*) from acct where bal > 150;' },
      { sql: 'commit;\ndelete from acct where id = 50;', note: 'In tab 1.' },
      { h: 'Locking the relation' },
      'The bluntest fix treats the relation itself as a data item: a scan locks the whole table in S, and an insert must lock the table in IX. Kwery does this when `phantom_protection` is on and the scan reads the whole table.',
      { sql: 'set phantom_protection = on;\nbegin;\nselect count(*) from acct where bal > 150;\n' + LOCKS, note: 'In tab 1. S on the table.' },
      { sql: 'set phantom_protection = on;\ninsert into acct values (50, 500);', tab: 2, waits: true, note: 'In tab 2. The insert needs IX on the table and waits.' },
      { sql: 'select count(*) from acct where bal > 150;\ncommit;', note: 'In tab 1. Still 3, and once tab 1 commits the insert goes ahead.' },
      { h: 'Next-key locking' },
      'Locking the whole table stops every insert, even those far from the predicate. **Index locking** does better: a scan through a B+ tree locks the leaf entries it covers, and an insert must lock the entries where the new key goes. The common form is **next-key locking**: a range scan locks every key in the range *and the key just after it*; an insert locks its own key and the key after it in X. Any insert into the scanned range must touch a locked key.',
      { sql: 'drop table acct;\ncreate table acct (id int primary key, bal int);\ninsert into acct values (10, 100), (20, 200), (30, 300), (40, 400);\nset enable_seqscan = off;\nbegin;\nselect id from acct where id between 15 and 25;\n' + LOCKS, note: 'In tab 1. Keys 20 (in the range) and 30 (the next key) are locked in S.' },
      { sql: 'insert into acct values (45, 450);', tab: 2, note: 'In tab 2. Its next key is the end of the index, which nobody locked: no wait.' },
      { predict: { q: 'Tab 2 now inserts id 27, just outside the range tab 1 read. Does it wait?', options: ['Yes: the next key after 27 is 30, which tab 1 locked', 'No: 27 is outside the range tab 1 read'], answer: 0, explain: 'Inserting 27 locks key 30 in X, and tab 1 holds S on 30 as its next key. Next-key locking is a little more cautious than the predicate itself: it also blocks some inserts just past the range.' }, sql: 'insert into acct values (27, 270);', tab: 2, waits: true },
      { sql: 'commit;\nselect id from acct order by id;', note: 'In tab 1. Tab 2\'s insert finishes once tab 1 commits.' },
      { sql: 'set phantom_protection = off;', tab: 2, note: 'In tab 2.' },
      { sql: "set phantom_protection = off;\nreset enable_seqscan;\nset concurrency_control = 'mvcc';\ndrop table acct;", note: 'In tab 1.' },
      { tip: 'Under PostgreSQL\'s snapshot isolation the second count would still be 3: the snapshot hides the committed insert. The phantom scenario in the transactions view compares the protocols.' },
      { view: 'txn', sel: { scenario: 'phantom' }, label: 'Set up the phantom scenario' },
    ],
  });

  // ---- 18.5 timestamp ordering -----------------------------------------------------------------------------------
  lesson({
    id: 'cc-timestamp', chapter: 18, title: 'Timestamp ordering and Thomas\' write rule', minutes: 13,
    summary: 'Fix the serial order in advance, by start time, and roll back any operation that arrives too late for it. Thomas\' write rule ignores writes nobody can ever read.',
    body: [
      'Locking finds a serial order as the transactions run. **Timestamp ordering** fixes it in advance: each transaction Ti gets a timestamp TS(Ti) when it begins, and the schedule must be equivalent to the serial schedule in timestamp order. No transaction ever waits for a lock; an operation that would break the order is refused, and its transaction rolls back and restarts with a new timestamp.',
      'For each data item Q the system keeps **W-timestamp(Q)**, the largest timestamp of a transaction that wrote Q, and **R-timestamp(Q)**, the largest of one that read it.',
      { table: [['Ti asks to', 'Refused when', 'Otherwise'], ['read Q', 'TS(Ti) < W-timestamp(Q): a younger transaction already overwrote Q', 'read, and R-timestamp(Q) := max(R-timestamp(Q), TS(Ti))'], ['write Q', 'TS(Ti) < R-timestamp(Q) (a younger one already read Q) or TS(Ti) < W-timestamp(Q)', 'write, and W-timestamp(Q) := TS(Ti)']] },
      { sql: ACCT + "\nset concurrency_control = 'to';", note: 'In tab 1. Kwery takes a transaction\'s timestamp at BEGIN.' },
      { sql: 'begin;\nselect bal from acct where id = 1;', note: 'In tab 1 (T1, older). R-timestamp(acct.1) := TS(T1).' },
      { sql: 'begin;\nupdate acct set bal = 2 where id = 2;\ncommit;', tab: 2, note: 'In tab 2 (T2, younger). Its write is not too late: TS(T2) is above both timestamps of row 2.' },
      { predict: { q: 'Now the older T1 writes row 2. What happens?', options: ['T1 is rolled back: a younger transaction already wrote the row', 'T1 waits for T2', 'T1 overwrites T2\'s value', 'The write is ignored'], answer: 0, explain: 'TS(T1) < W-timestamp(acct.2) = TS(T2). In the serial order T1 comes first, so T2\'s write should be the one that survives. Basic timestamp ordering rolls T1 back.' }, sql: 'update acct set bal = 1 where id = 2;', fails: '40001' },
      { sql: 'rollback;', note: 'In tab 1.' },
      'Reads can be too late as well. Here the older transaction begins, a younger one writes row 2 and commits, and then the older one reads it:',
      { sql: 'begin;', note: 'In tab 1 (T1, older).' },
      { sql: 'begin;\nupdate acct set bal = 222 where id = 2;\ncommit;', tab: 2, note: 'In tab 2 (T2, younger).' },
      { sql: 'select bal from acct where id = 2;', fails: '40001', note: 'In tab 1. TS(T1) < W-timestamp: the value it should read has been overwritten, so T1 is rolled back.' },
      { sql: 'rollback;', note: 'In tab 1.' },
      'Timestamp ordering guarantees conflict serializability and freedom from deadlock, since nobody waits. It does not by itself prevent cascading rollbacks; Kwery\'s version keeps writes invisible until commit, which makes its schedules recoverable.',
      { h: 'Thomas\' write rule' },
      'Look again at the first rejection. T1 wanted to write row 2 after the younger T2 had written it, but nobody had read T1\'s value. In the serial order T1, T2, T1\'s write would be overwritten by T2\'s at once. It is **obsolete**, and can simply be skipped. That is **Thomas\' write rule**: when TS(Ti) < W-timestamp(Q), ignore the write instead of rolling back. (A write that a younger transaction has already *read past* is still refused.)',
      { sql: "set thomas_write_rule = on;\nbegin;\nselect bal from acct where id = 3;", note: 'In tab 1 (T1, older).' },
      { sql: 'set thomas_write_rule = on;\nbegin;\nupdate acct set bal = 2 where id = 1;\ncommit;', tab: 2, note: 'In tab 2 (T2, younger).' },
      { sql: 'update acct set bal = 1 where id = 1;\ncommit;\nselect bal from acct where id = 1;', note: 'In tab 1. UPDATE 0: the write is ignored, T1 commits, and the balance is T2\'s 2.' },
      'Thomas\' rule accepts some schedules that are not conflict serializable but are view serializable, because the ignored write is a blind write nobody reads. The schedule below is one: T1 → T2 on A and T2 → T1 on B form a cycle, yet with T1\'s write of B skipped it is equivalent to T1, T2.',
      { sql: 'reset thomas_write_rule;', tab: 2, note: 'In tab 2.' },
      { sql: "reset thomas_write_rule;\nset concurrency_control = 'mvcc';\ndrop table acct;", note: 'In tab 1.' },
      { view: 'schedule', sel: { schedule: 'r1(A) w2(B) w2(A) c2 w1(B) c1' }, label: 'Try it in the schedule workbench: pick Timestamp ordering, then TO + Thomas\' rule' },
    ],
  });

  // ---- 18.6 validation ------------------------------------------------------------------------------------------
  lesson({
    id: 'cc-validation', chapter: 18, title: 'Validation: optimistic concurrency control', minutes: 11,
    summary: 'Let transactions run freely on private copies and check at commit whether they got in each other\'s way. Cheap when conflicts are rare.',
    body: [
      'When most transactions do not conflict, locking and timestamp checks are overhead. The **validation** protocol, also called **optimistic concurrency control**, checks only once, at the end. Each transaction runs in three phases:',
      { steps: ['**Read phase.** It reads data and keeps its writes in a private workspace. Nothing it writes is visible.', '**Validation phase.** At commit, it checks whether it may go on without breaking serializability.', '**Write phase.** If it passed, its writes go to the database. Otherwise it is rolled back.'] },
      'Each transaction records StartTS (when it began), ValidationTS (when it validated) and FinishTS (when its writes were done). Transactions are serialized in ValidationTS order. Ti passes validation if, for every Tk with an earlier ValidationTS, one of these holds:',
      { list: ['Tk finished before Ti started (FinishTS(Tk) < StartTS(Ti)), or', 'Tk finished before Ti validated, and the items Tk wrote do not overlap the items Ti read.'] },
      { sql: ACCT + "\nset concurrency_control = 'occ';", note: 'In tab 1.' },
      { sql: 'begin;\nselect bal from acct where id = 1;', note: 'In tab 1 (T1). It reads 100.' },
      { sql: 'begin;\nupdate acct set bal = 50 where id = 1;', tab: 2, note: 'In tab 2 (T2). Its write stays private.' },
      { sql: 'select bal from acct where id = 1;', note: 'In tab 1. Still 100: T2\'s write is in its workspace.' },
      { sql: 'commit;', tab: 2, note: 'In tab 2. T2 validates first; nobody validated before it, so it passes and writes 50.' },
      { predict: { q: 'T1 now writes row 2 and commits. Does it pass validation?', options: ['No: T2 validated first, finished after T1 started, and wrote row 1, which T1 read', 'Yes: T1 never wrote row 1', 'Yes: T2 committed, so there is no conflict left'], answer: 0, explain: 'T2 did not finish before T1 started, and T2\'s write set {row 1} meets T1\'s read set {row 1}. T1 read a value that is now stale, so it fails validation and is rolled back.' }, sql: 'update acct set bal = bal + 1 where id = 2;\ncommit;', fails: '40001' },
      { sql: 'select * from acct order by id;', note: 'In tab 1. Row 1 is 50 and row 2 is unchanged: T1 left no trace.' },
      'When the read and write sets do not meet, both commit, in any order, with no waiting at all:',
      { sql: 'begin;\nselect bal from acct where id = 2;', note: 'In tab 1.' },
      { sql: 'begin;\nselect bal from acct where id = 2;\nupdate acct set bal = 9 where id = 1;', tab: 2, note: 'In tab 2.' },
      { sql: 'commit;', note: 'In tab 1. It wrote nothing: it validates trivially.' },
      { sql: 'commit;', tab: 2, note: 'In tab 2. T1 wrote nothing it read, so it passes too.' },
      'Validation never waits and never deadlocks, and a transaction that fails has written nothing, so nothing cascades. The price is wasted work: a long transaction can run to the end only to fail. It suits workloads where conflicts are rare, such as mostly-read systems.',
      { sql: "set concurrency_control = 'mvcc';\ndrop table acct;", note: 'In tab 1.' },
      { view: 'schedule', sel: { schedule: 'r1(A) r2(B) w2(A) c2 w1(B) c1' }, label: 'Open a schedule in the workbench and pick Validation' },
    ],
  });

  // ---- 18.7 multiversion schemes --------------------------------------------------------------------------------
  lesson({
    id: 'cc-multiversion', chapter: 18, title: 'Multiversion timestamp ordering and multiversion 2PL', minutes: 13,
    summary: 'Keep old versions of each item, so that a read can be served from the right version instead of being refused or made to wait.',
    body: [
      'In timestamp ordering a read is refused when a younger transaction has already overwritten the item. If the old value were still around, the read could simply use it. **Multiversion** schemes keep several versions Q1, Q2, ... of each item, so a reader picks the version that fits it.',
      { h: 'Multiversion timestamp ordering' },
      'Each version Qk carries the timestamp of the transaction that wrote it, W-timestamp(Qk), and the largest timestamp of a transaction that read it, R-timestamp(Qk). For a transaction Ti, let Qk be the version with the largest W-timestamp not above TS(Ti):',
      { list: ['**read(Q)** returns Qk. It is never refused and never waits.', '**write(Q)** is refused (Ti rolls back) if TS(Ti) < R-timestamp(Qk): a younger transaction already read Qk and should have seen Ti\'s value. Otherwise Ti creates a new version (or overwrites Qk if Ti wrote it).'] },
      { sql: ACCT + "\nset concurrency_control = 'mvto';", note: 'In tab 1.' },
      { sql: 'begin;\nselect bal from acct where id = 1;', note: 'In tab 1 (T1, older). It reads 100.' },
      { sql: 'begin;\nupdate acct set bal = 77 where id = 1;\ncommit;', tab: 2, note: 'In tab 2 (T2, younger). A new version of row 1, stamped TS(T2).' },
      { predict: { q: 'T1 reads row 1 again. Under single-version timestamp ordering it would be rolled back. Under MVTO?', options: ['It reads 100, the version written before TS(T1)', 'It reads 77', 'It is rolled back'], answer: 0, explain: 'T1 reads the version with the largest W-timestamp not above TS(T1): the original 100. The version 77 belongs to T1\'s future in the serial order.' }, sql: 'select bal from acct where id = 1;' },
      { sql: 'commit;\nselect bal from acct where id = 1;', note: 'In tab 1. A new transaction is younger than T2 and sees 77.' },
      'Writes can still fail. Here the younger transaction reads a row, then the older one tries to write it:',
      { sql: 'begin;', note: 'In tab 1 (T1, older).' },
      { sql: 'begin;\nselect bal from acct where id = 3;', tab: 2, note: 'In tab 2 (T2, younger). R-timestamp of the version := TS(T2).' },
      { sql: 'update acct set bal = 1 where id = 3;', fails: '40001', note: 'In tab 1. TS(T1) < R-timestamp: T2 should have seen this write, so T1 is rolled back.' },
      { sql: 'rollback;', note: 'In tab 1.' },
      { sql: 'commit;', tab: 2, note: 'In tab 2.' },
      { h: 'Multiversion two-phase locking' },
      'MVTO never makes readers wait but may roll writers back. **Multiversion two-phase locking** splits the work by kind. **Update transactions** follow rigorous 2PL and hold every lock to the end. **Read-only transactions** take no locks at all: each reads a consistent snapshot, the versions committed before it started, kept apart by a counter that update transactions stamp at commit.',
      { sql: "set concurrency_control = 'mv2pl';\nbegin read only;\nselect bal from acct where id = 1;", note: 'In tab 1. A read-only transaction.' },
      { sql: 'update acct set bal = 88 where id = 1;', tab: 2, note: 'In tab 2. No locks to wait for: it commits at once.' },
      { sql: 'select bal from acct where id = 1;\ncommit;', note: 'In tab 1. Still 77: its snapshot does not move.' },
      'An ordinary transaction that reads is an update transaction, and it locks:',
      { sql: 'begin;\nselect bal from acct where id = 1;', note: 'In tab 1. S lock on row 1, held to the end (rigorous).' },
      { sql: 'update acct set bal = 5 where id = 1;', tab: 2, waits: true, note: 'In tab 2. It waits for tab 1.' },
      { sql: 'commit;', note: 'In tab 1. Tab 2\'s update goes ahead.' },
      { sql: "set concurrency_control = 'mvcc';\ndrop table acct;", note: 'In tab 1.' },
      'Old versions cost space. A version can be removed once no running transaction could ever need it: when a newer version exists whose timestamp is older than every active transaction. In PostgreSQL that is the job of VACUUM, the subject of the last lesson of this chapter.',
    ],
  });

  // ---- 18.8 snapshot isolation ----------------------------------------------------------------------------------
  lesson({
    id: 'cc-snapshot', chapter: 18, title: 'Snapshot isolation and write skew', minutes: 13,
    summary: 'Every transaction reads from a snapshot and the first updater of a row wins. Fast and free of most anomalies, but not serializable: write skew slips through.',
    body: [
      '**Snapshot isolation** is the multiversion scheme most systems use. A transaction reads from a snapshot of the committed data as of its start, so readers never wait and never block writers. When two concurrent transactions update the same row, only the first one may commit (**first updater wins**; some systems check at commit, **first committer wins**). In PostgreSQL this is the REPEATABLE READ level.',
      { sql: ACCT + '\n' + CREW, note: 'In tab 1.' },
      { h: 'Lost updates are prevented' },
      { sql: 'begin isolation level repeatable read;\nselect bal from acct where id = 1;', note: 'In tab 1.' },
      { sql: 'begin isolation level repeatable read;\nselect bal from acct where id = 1;', tab: 2, note: 'In tab 2. Both read 100.' },
      { sql: 'update acct set bal = bal - 10 where id = 1;', note: 'In tab 1.' },
      { sql: 'update acct set bal = bal - 20 where id = 1;', tab: 2, waits: true, fails: '40001', note: 'In tab 2. It waits for tab 1 to decide. When tab 1 commits, it fails: "could not serialize access due to concurrent update".' },
      { sql: 'commit;', note: 'In tab 1.' },
      { sql: 'rollback;', tab: 2, note: 'In tab 2. The application would retry from the start, and read 90.' },
      { h: 'Write skew' },
      'Snapshot isolation checks only rows that both transactions **write**. Two transactions that each read what the other writes, and write different rows, are never stopped. A theatre needs at least two crew on the fly rail while a show is running. Ravi, Mona and Tess are rostered tonight, and Ravi and Mona each ask to leave early:',
      { sql: "begin isolation level repeatable read;\nselect count(*) from crew where post = 'fly rail' and on_post;", note: 'In tab 1 (Ravi). Three on the rail, so one may go.' },
      { sql: "begin isolation level repeatable read;\nselect count(*) from crew where post = 'fly rail' and on_post;", tab: 2, note: 'In tab 2 (Mona). Three in her snapshot as well.' },
      { sql: "update crew set on_post = false where name = 'Ravi';", note: 'In tab 1.' },
      { sql: "update crew set on_post = false where name = 'Mona';", tab: 2, note: 'In tab 2. A different row: no wait.' },
      { sql: 'commit;', note: 'In tab 1.' },
      { predict: { q: 'Mona now commits. What happens?', options: ['It commits: only Tess is left on the rail', 'It fails with a serialization error', 'It waits for Ravi'], answer: 0, explain: 'The two transactions wrote different rows, so first-updater-wins has nothing to say. Each checked the rule in its own snapshot and both commit. No serial order gives this result: in either order the second to ask would have seen only two on the rail and stayed. This anomaly is **write skew**.' }, sql: 'commit;', tab: 2 },
      { sql: 'select * from crew;', note: 'In tab 1. The rule is broken.' },
      'One fix in the application is to turn the read into a write conflict: read the rows with `select ... for update`, which locks them. The second request then waits for the first and, at REPEATABLE READ, fails when the first commits.',
      { sql: "update crew set on_post = true;\nbegin isolation level repeatable read;\nselect * from crew where post = 'fly rail' and on_post for update;", note: 'In tab 1.' },
      { sql: "begin isolation level repeatable read;\nselect * from crew where post = 'fly rail' and on_post for update;", tab: 2, waits: true, fails: '40001', note: 'In tab 2. It waits for tab 1\'s row locks, then fails when tab 1 commits.' },
      { sql: "update crew set on_post = false where name = 'Ravi';\ncommit;", note: 'In tab 1.' },
      { sql: 'rollback;', tab: 2, note: 'In tab 2. Mona stays on the rail.' },
      { sql: 'drop table acct;\ndrop table crew;', note: 'In tab 1.' },
      'The other fix needs no change to the application: ask for SERIALIZABLE, which in PostgreSQL adds a check for exactly this pattern. That is the next lesson.',
      { view: 'txn', sel: { scenario: 'write-skew' }, label: 'Set up the write-skew scenario' },
    ],
  });

  // ---- 18.9 SSI -------------------------------------------------------------------------------------------------
  lesson({
    id: 'cc-ssi', chapter: 18, title: 'Serializable snapshot isolation', minutes: 12,
    summary: 'PostgreSQL\'s SERIALIZABLE keeps snapshot isolation and adds a watch for rw-dependencies, rolling a transaction back when two of them line up.',
    body: [
      'Write skew happens because of **rw-antidependencies**: T1 reads a version, and a concurrent T2 writes a newer version of the same thing. Then T1 must come before T2 in any equivalent serial order, though T2 committed and T1 did not see it. Every snapshot isolation anomaly needs at least two such edges in a row, T1 → T2 → T3 (T1 and T3 may be the same), with the middle transaction, the **pivot**, part of both.',
      '**Serializable snapshot isolation** (SSI) runs exactly as snapshot isolation, and in addition records reads (as SIREAD locks on the rows, pages or relations read) to find rw-antidependencies. When it sees two in a row among concurrent transactions, a **dangerous structure**, it rolls one of them back. PostgreSQL uses it for SERIALIZABLE.',
      { sql: CREW, note: 'In tab 1.' },
      { sql: "begin isolation level serializable;\nselect count(*) from crew where post = 'fly rail' and on_post;\nupdate crew set on_post = false where name = 'Ravi';", note: 'In tab 1 (Ravi).' },
      { sql: "begin isolation level serializable;\nselect count(*) from crew where post = 'fly rail' and on_post;\nupdate crew set on_post = false where name = 'Mona';", tab: 2, note: 'In tab 2 (Mona).' },
      { sql: 'commit;', note: 'In tab 1. Ravi commits.' },
      { predict: { q: 'Mona commits. What happens at SERIALIZABLE?', options: ['A serialization failure: Mona is rolled back', 'It commits, as under REPEATABLE READ', 'It waits for Ravi'], answer: 0, explain: 'Mona read the row Ravi wrote, and Ravi read the row Mona wrote: rw edges both ways between two concurrent transactions. That is a dangerous structure, and the one still running fails with "could not serialize access due to read/write dependencies among transactions".' }, sql: 'commit;', tab: 2, fails: '40001' },
      { sql: 'select * from crew;', note: 'In tab 1. Mona is still on the rail. Her application should retry; it would then see only two on the rail, and keep her there.' },
      { h: 'False positives' },
      'SSI is conservative. It does not check for a real cycle, only for two rw edges in a row, and it records reads at whatever granularity the scan used: a sequential scan marks the whole relation as read. So it sometimes rolls back a transaction that was harmless. Here each of the two reads and writes only their own row:',
      { sql: "update crew set on_post = true;\nbegin isolation level serializable;\nselect on_post from crew where name = 'Ravi';\nupdate crew set on_post = false where name = 'Ravi';", note: 'In tab 1. The table is tiny, so the read is a sequential scan.' },
      { sql: "begin isolation level serializable;\nselect on_post from crew where name = 'Mona';\nupdate crew set on_post = false where name = 'Mona';", tab: 2, note: 'In tab 2.' },
      { sql: 'commit;', note: 'In tab 1.' },
      { sql: 'commit;', tab: 2, fails: '40001', note: 'In tab 2. It fails, though the two transactions touched different rows: each scan read the whole relation.' },
      'Read through the index instead, so that only the row itself is marked as read, and both commit:',
      { sql: "update crew set on_post = true;\nset enable_seqscan = off;\nbegin isolation level serializable;\nselect on_post from crew where name = 'Ravi';\nupdate crew set on_post = false where name = 'Ravi';", note: 'In tab 1.' },
      { sql: "set enable_seqscan = off;\nbegin isolation level serializable;\nselect on_post from crew where name = 'Mona';\nupdate crew set on_post = false where name = 'Mona';", tab: 2, note: 'In tab 2.' },
      { sql: 'commit;', note: 'In tab 1.' },
      { sql: 'commit;\nreset enable_seqscan;', tab: 2, note: 'In tab 2. This time it commits.' },
      { sql: 'reset enable_seqscan;\ndrop table crew;', note: 'In tab 1.' },
      'The rules for applications are simple. Run at SERIALIZABLE, and be ready to retry any transaction that fails with SQLSTATE 40001. Declaring a transaction READ ONLY helps: a read-only transaction can be the start of a dangerous structure but rarely its pivot, and PostgreSQL can often let it run without any checks.',
      { tip: 'The **SSI** tab of the transactions view draws the rw edges between serializable transactions as they are found. Set up the write-skew scenario at SERIALIZABLE and watch the dangerous structure appear.' },
      { view: 'txn', sel: { txnTab: 'ssi' }, label: 'Open the SSI tab of the transactions view' },
    ],
  });

  // ---- 18.10 MVCC in practice -----------------------------------------------------------------------------------
  lesson({
    id: 'cc-mvcc', chapter: 18, title: 'MVCC in practice: xmin, xmax, ctid and VACUUM', minutes: 12,
    summary: 'See the versions PostgreSQL-style MVCC keeps in the table itself, how a snapshot picks among them, and how VACUUM reclaims the dead ones.',
    body: [
      'PostgreSQL keeps old versions in the table itself. Each row version (a **tuple**) carries two transaction ids in its header: **xmin**, the transaction that created it, and **xmax**, the transaction that deleted or replaced it (0 if none). An UPDATE never changes a tuple in place: it marks the old one with its xmax and inserts a new one. **ctid** is a tuple\'s address: (page, slot).',
      { sql: 'drop table if exists counter;\ncreate table counter (id int primary key, n int);\ninsert into counter values (1, 0), (2, 0);\nselect xmin, xmax, ctid, * from counter;', note: 'In tab 1. Both tuples were made by the same transaction and nobody has replaced them.' },
      { sql: 'begin;\nupdate counter set n = 10 where id = 1;\nselect txid_current();\nselect xmin, xmax, ctid, * from counter;', note: 'In tab 1. Tab 1 sees its new tuple of row 1: a new ctid, and xmin is its own transaction id.' },
      { predict: { q: 'Tab 2 looks at the table while tab 1 is still open. What does it see for row 1?', options: ['The old tuple, n = 0, with xmax set to tab 1\'s transaction id', 'The new tuple, n = 10', 'Both tuples', 'Nothing: the row is locked'], answer: 0, explain: 'Tab 1 has not committed, so tab 2\'s snapshot shows the old tuple. Its xmax already names tab 1\'s transaction, but a deleter that has not committed does not count. Both tuples are on the page; each snapshot sees exactly one of them.' }, sql: 'select xmin, xmax, ctid, * from counter;', tab: 2 },
      { sql: 'commit;', note: 'In tab 1.' },
      { sql: 'select xmin, xmax, ctid, * from counter;', tab: 2, note: 'In tab 2. Now the new tuple.' },
      'The visibility rule, roughly: a tuple is visible to a snapshot when its xmin committed before the snapshot was taken, and its xmax is 0, aborted, or did not commit before the snapshot. A rolled-back delete leaves its xmax behind, and the tuple stays visible, because the deleter aborted:',
      { sql: 'begin;\ndelete from counter where id = 2;\nrollback;\nselect xmin, xmax, ctid, * from counter;', note: 'In tab 1. Row 2 is back, with a non-zero xmax.' },
      { h: 'Dead tuples and VACUUM' },
      'An old tuple that no snapshot can see any more is **dead**. Nothing removes it at once: readers that started earlier might still need it. **VACUUM** later finds dead tuples and frees their space for new ones. Watch the table grow. A bigger table makes it visible:',
      { sql: "drop table if exists big;\ncreate table big (id int primary key, n int, pad text);\ninsert into big select g, 0, repeat('x', 100) from generate_series(1, 60) g;\nselect pg_relation_size('big');", note: 'In tab 1. The size in bytes.' },
      { sql: "update big set n = n + 1;\nselect pg_relation_size('big');", note: 'In tab 1. Every row got a new tuple; the old ones are still there, dead.' },
      { sql: "vacuum big;\nupdate big set n = n + 1;\nselect pg_relation_size('big');", note: 'In tab 1. After VACUUM, the new tuples reuse the space of the dead ones: the size does not change.' },
      { sql: "update big set n = n + 1;\nselect pg_relation_size('big');", note: 'In tab 1. No VACUUM this time, and the table grows again.' },
      'VACUUM also matters for another reason: transaction ids are finite (32 bits in PostgreSQL), and old xmin values must be **frozen** before the counter wraps around. PostgreSQL runs autovacuum in the background for both jobs; a long-running transaction holds it back, because the tuples it might still see cannot be removed.',
      { sql: 'drop table counter;\ndrop table big;', note: 'In tab 1.' },
      { tip: 'The **Versions** tab of the transactions view shows each row\'s chain of tuples with their xmin and xmax, and the **Storage** view shows the dead tuples on their pages.' },
      { view: 'txn', sel: { txnTab: 'versions' }, label: 'Open the Versions tab' },
    ],
  });

  // ---- exercises ------------------------------------------------------------------------------------------------
  const ANS = (ex) => 'Type your answer in the editor, ' + ex + ', and check it.';
  const ex = (x) => C.exercise(Object.assign({ chapter: 18, kind: 'answer' }, x));
  const TS3 = { ts: { 1: 1, 2: 2, 3: 3 } };

  ex({
    id: 'ex18-2pl-victim', title: 'Upgrading locks under 2PL', level: 1,
    text: ['Two transactions run this schedule under basic two-phase locking with deadlock detection. A read needs an S lock and a write an X lock; a transaction that already holds S asks to upgrade it.', { p: '`r1(A) r2(A) w1(A) w2(A) c1 c2`' }, 'When the detector finds a cycle it rolls back the youngest transaction in it (the one that started last). Which transactions are rolled back? ' + ANS('such as `T1` or `none`')],
    hints: ['Both reads get S locks on A: S is compatible with S.', 'T1 wants X on A and waits for T2\'s S lock; then T2 wants X on A and waits for T1\'s S lock. That is a cycle.', 'The cycle T1 → T2 → T1 has T2 as its youngest member, so the answer is T2.'],
    solution: 'T2', wrongs: ['T1', 'none', 'T1 T2'], check: kit.aborted('r1(A) r2(A) w1(A) w2(A) c1 c2', '2pl', { deadlock: 'detect' }),
    ref: 'T2. Both hold S on A, both ask to upgrade to X, and each waits for the other: a deadlock. The youngest, T2, is rolled back and T1 goes on.',
  });
  ex({
    id: 'ex18-3way-detect', title: 'A three-way deadlock', level: 2,
    text: ['Three transactions run this schedule under strict two-phase locking with deadlock detection; the victim is the youngest transaction in the cycle. Timestamps follow the transaction numbers.', { p: '`r1(A) r2(B) r3(C) w1(B) w2(C) w3(A) c1 c2 c3`' }, 'Which transactions are rolled back? ' + ANS('such as `T1` or `T1, T3`')],
    hints: ['Write down who holds what after the three reads, then who waits for whom after each write.', 'T1 waits for T2 (B), T2 waits for T3 (C), T3 waits for T1 (A): the cycle closes at w3(A).', 'The youngest in the cycle is T3, so the answer is T3.'],
    solution: 'T3', wrongs: ['T1', 'T2', 'T1, T2'], check: kit.aborted('r1(A) r2(B) r3(C) w1(B) w2(C) w3(A) c1 c2 c3', 'strict2pl', { deadlock: 'detect' }),
    ref: 'T3. After the reads T1 holds S(A), T2 holds S(B), T3 holds S(C). w1(B) waits for T2, w2(C) waits for T3, w3(A) waits for T1: the cycle T1 → T2 → T3 → T1. Its youngest member, T3, is the victim; then T2 gets C and T1 gets B.',
  });
  ex({
    id: 'ex18-3way-wound', title: 'The same schedule under wound-wait', level: 2,
    text: ['Run the schedule of the previous exercise under strict two-phase locking with **wound-wait**. TS(T1) < TS(T2) < TS(T3), so T1 is the oldest.', { p: '`r1(A) r2(B) r3(C) w1(B) w2(C) w3(A) c1 c2 c3`' }, 'Which transactions are rolled back? ' + ANS('such as `T3` or `none`')],
    hints: ['Under wound-wait, an older transaction asking for a lock a younger one holds wounds (rolls back) the younger one; a younger one asking an older one waits.', 'At w1(B) the older T1 asks for B, which the younger T2 holds: T2 is wounded and its locks are released.', 'Then w3(A): the younger T3 waits for the older T1, which can finish. Only T2 is rolled back: the answer is T2.'],
    solution: 'T2', wrongs: ['T3', 'T1', 'T2, T3'], check: kit.aborted('r1(A) r2(B) r3(C) w1(B) w2(C) w3(A) c1 c2 c3', 'strict2pl', { deadlock: 'wound-wait' }),
    ref: 'T2. At w1(B) the older T1 wounds T2, which holds B. T3 later waits for T1 at w3(A), younger waiting for older, which wound-wait allows. T1 commits, then T3 gets A and commits. No cycle ever forms, and the victim is a different transaction than under detection.',
  });
  ex({
    id: 'ex18-waitdie', title: 'Who waits under wait-die?', level: 1,
    text: ['Under strict two-phase locking with **wait-die**, with TS(T1) < TS(T2), this schedule runs:', { p: '`r2(A) r1(B) w1(A) w2(B) c1 c2`' }, 'Which transactions are rolled back? ' + ANS('such as `T1` or `none`')],
    hints: ['Wait-die: an older transaction may wait for a younger one; a younger one that asks for what an older one holds dies.', 'At w1(A), T1 (older) asks for A, held by T2 (younger): T1 waits.', 'At w2(B), T2 (younger) asks for B, held by the older T1: T2 dies. The answer is T2.'],
    solution: 'T2', wrongs: ['T1', 'none'], check: kit.aborted('r2(A) r1(B) w1(A) w2(B) c1 c2', 'strict2pl', { deadlock: 'wait-die', ts: { 1: 1, 2: 2 } }),
    ref: 'T2. T1 waits for T2 at w1(A), which wait-die allows because T1 is older. T2 then asks for B, held by the older T1, and dies. T1 gets A and commits.',
  });
  ex({
    id: 'ex18-to', title: 'Timestamp ordering: a write that comes too late', level: 2,
    text: ['Under basic timestamp ordering with TS(T1) = 1, TS(T2) = 2 and TS(T3) = 3:', { p: '`r1(Q) r3(Q) w2(Q) c1 c2 c3`' }, 'Which transactions are rolled back? ' + ANS('such as `T1` or `none`')],
    hints: ['Track R-timestamp(Q) and W-timestamp(Q) as you go. Both start at 0.', 'After r1(Q) and r3(Q), R-timestamp(Q) = 3.', 'w2(Q): TS(T2) = 2 < R-timestamp(Q) = 3, so a younger transaction already read Q and T2 is rolled back. The answer is T2.'],
    solution: 'T2', wrongs: ['T3', 'none', 'T1'], check: kit.aborted('r1(Q) r3(Q) w2(Q) c1 c2 c3', 'to', TS3),
    ref: 'T2. R-timestamp(Q) becomes 1, then 3. When T2 writes, TS(T2) = 2 < 3: T3 has read a value that, in timestamp order, T2 should have produced first. T2 is rolled back.',
  });
  ex({
    id: 'ex18-thomas', title: 'Thomas\' write rule', level: 2,
    text: ['With TS(T1) = 1, TS(T2) = 2, TS(T3) = 3, this schedule runs under timestamp ordering **with Thomas\' write rule**:', { p: '`w2(A) w1(A) r3(A) c1 c2 c3`' }, 'Which transactions are rolled back? ' + ANS('such as `T1` or `none`')],
    hints: ['After w2(A), W-timestamp(A) = 2.', 'w1(A): TS(T1) = 1 < W-timestamp(A) = 2, and nobody read A in between. Basic TO would roll T1 back; Thomas\' rule ignores the obsolete write.', 'r3(A) reads T2\'s value, which is fine for TS 3. Nobody is rolled back: the answer is none.'],
    solution: 'none', wrongs: ['T1', 'T3'], check: kit.aborted('w2(A) w1(A) r3(A) c1 c2 c3', 'thomas', TS3),
    ref: 'none. T1\'s write is obsolete: in the serial order T1, T2, T3 it would be overwritten by T2 before anyone read it. Thomas\' write rule skips it and T1 commits. (Without the rule, T1 would be rolled back.)',
  });
  ex({
    id: 'ex18-occ', title: 'Validation', level: 2,
    text: ['Under the validation protocol (writes are private until commit; a transaction validates when it commits):', { p: '`r1(A) r2(A) w1(A) w2(A) c1 c2`' }, 'Which transactions are rolled back? ' + ANS('such as `T1` or `none`')],
    hints: ['T1 validates first, at c1. Nobody validated before it.', 'T2 validates at c2. T1 finished after T2 started, so the write set of T1 must not meet the read set of T2.', 'T1 wrote A and T2 read A: T2 fails validation. The answer is T2.'],
    solution: 'T2', wrongs: ['T1', 'none', 'T1 T2'], check: kit.aborted('r1(A) r2(A) w1(A) w2(A) c1 c2', 'validation'),
    ref: 'T2. T1 validates first and passes. T2 started before T1 finished, and T1\'s write set {A} meets T2\'s read set {A}: T2 read a stale A, so it fails validation and its private write is thrown away.',
  });
  ex({
    id: 'ex18-mvto', title: 'Multiversion timestamp ordering', level: 2,
    text: ['Under multiversion timestamp ordering with TS(T1) = 1 and TS(T2) = 2:', { p: '`r1(A) r2(A) w2(A) w1(A) c1 c2`' }, 'Which transactions are rolled back? ' + ANS('such as `T2` or `none`')],
    hints: ['Both reads read the initial version A0; its R-timestamp becomes 2.', 'w2(A) makes a new version with W-timestamp 2: fine. w1(A) would replace the version T1 should write over, A0.', 'TS(T1) = 1 < R-timestamp(A0) = 2: T2 read A0 and should have seen T1\'s write. T1 is rolled back: the answer is T1.'],
    solution: 'T1', wrongs: ['T2', 'none'], check: kit.aborted('r1(A) r2(A) w2(A) w1(A) c1 c2', 'mvto'),
    ref: 'T1. Reads never fail under MVTO, but T1\'s write does: the version it would follow, A0, was already read by the younger T2 (R-timestamp 2 > 1). Basic single-version TO would also roll back T1 here; under 2PL the same schedule deadlocks.',
  });
  ex({
    id: 'ex18-cascadeless', title: 'Which variants are cascadeless?', level: 1,
    text: ['For each variant of two-phase locking, does it guarantee that no cascading rollback can happen? Answer for **basic 2PL, strict 2PL and rigorous 2PL**, in that order. ' + ANS('such as `yes, no, no`')],
    hints: ['A cascading rollback needs a transaction to read a value written by one that has not yet committed.', 'Which variants keep X locks until the transaction ends?', 'Basic 2PL may release X locks at the lock point; strict and rigorous hold them to the end. The answer is no, yes, yes.'],
    solution: 'no, yes, yes', wrongs: ['yes, yes, yes', 'no, no, yes'], check: kit.yesNoList([false, true, true], ['basic', 'strict', 'rigorous']),
    ref: 'no, yes, yes. Basic 2PL can release an X lock before commit, so another transaction may read an uncommitted value and must roll back with its writer. Strict 2PL keeps X locks to the end, and rigorous 2PL keeps every lock to the end, so both give cascadeless schedules.',
  });
  ex({
    id: 'ex18-six', title: 'Compatibility with SIX', level: 2,
    text: ['T1 holds a table in SIX mode. T2 asks for the same table in **IS**, then (separately) in **IX**, then in **S**, then in **SIX**. For each request, is it granted at once? ' + ANS('four words, such as `yes, yes, no, no`')],
    hints: ['SIX means: the whole table is read (S), and some rows below will be written (IX).', 'Anything that writes below the table conflicts with T1\'s S part; anything that reads the whole table conflicts with T1\'s IX part.', 'Only IS is compatible with SIX. The answer is yes, no, no, no.'],
    solution: 'yes, no, no, no', wrongs: ['yes, yes, no, no', 'no, no, no, no'], check: kit.yesNoList([true, false, false, false], ['IS', 'IX', 'S', 'SIX']),
    ref: 'yes, no, no, no. IS is compatible with SIX: T2 will only read some rows, which T1\'s S part allows, and T1 locks the rows it writes. IX conflicts with the S part, S conflicts with the IX part, and SIX conflicts with both.',
  });
  ex({
    id: 'ex18-intention', title: 'The lock on the table', level: 1,
    text: ['Under multiple-granularity locking, a transaction updates a single row of `booking`. In which mode does it lock the table `booking` itself? ' + ANS('one of `IS`, `IX`, `S`, `SIX`, `X`')],
    hints: ['The row is locked in X. Before that, every ancestor must be locked in an intention mode.', 'The intention mode for a descendant that will be locked in X is the exclusive one.', 'The table is locked in IX (and the database above it in IX too).'],
    solution: 'IX', wrongs: ['X', 'IS', 'SIX'], check: kit.choice(['ix'], ['is', 'ix', 's', 'six', 'x']),
    ref: 'IX. The row is locked in X; its parent, the table, and the database above that are locked in IX, announcing an exclusive lock further down without blocking other transactions that lock other rows.',
  });
  ex({
    id: 'ex18-nextkey', title: 'Next-key locking', level: 3,
    text: ['A table has a B+ tree index on `k`, holding the keys 10, 20, 30 and 40. Under next-key locking, T1 runs `select * from t where k between 15 and 25` and stays open. T2 then tries, one at a time, to insert the keys **12, 27, 35 and 45**. A scan locks every key in its range and the next key after the range; an insert locks the next key after its own key in X. Which of T2\'s inserts must wait? ' + ANS('the keys, such as `12 35`, or `none`')],
    hints: ['The range 15 to 25 contains the key 20. The next key after it is 30. So T1 holds S on 20 and 30.', 'For each insert, find the smallest existing key above it: 12 → 20, 27 → 30, 35 → 40, 45 → the end of the index.', 'Inserts whose next key is 20 or 30 wait: the answer is 12 27.'],
    solution: '12 27', solutionText: '12 27', wrongs: ['27', '12 27 35', 'none'], check: kit.numSet([12, 27]),
    ref: '12 27. T1 locks 20 (in the range) and 30 (the next key). Inserting 12 must lock its next key, 20; inserting 27 must lock 30: both conflict. 35 locks 40 and 45 locks the end of the index, which nobody holds. Note that 12 and 27 are outside the range T1 read: next-key locking blocks a little more than the predicate needs.',
  });
  ex({
    id: 'ex18-skew', title: 'Where does write skew get through?', level: 2,
    text: ['Two of the fly-rail crew each check that three are on the rail, then each takes themselves off, as in the write-skew lesson. In Kwery (as in PostgreSQL), do **both** transactions commit at READ COMMITTED, at REPEATABLE READ, and at SERIALIZABLE? ' + ANS('three words, such as `no, no, yes`')],
    hints: ['At READ COMMITTED and REPEATABLE READ, only concurrent writes to the same row are stopped.', 'The two crew members write different rows.', 'SSI at SERIALIZABLE finds the rw-dependencies both ways and rolls one back. The answer is yes, yes, no.'],
    solution: 'yes, yes, no', wrongs: ['no, no, no', 'yes, no, no'], check: kit.yesNoList([true, true, false], ['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE']),
    ref: 'yes, yes, no. Neither READ COMMITTED nor snapshot isolation (REPEATABLE READ) checks anything when two transactions write different rows, so both commit and only one is left on the rail. Serializable snapshot isolation sees each transaction read what the other wrote, a dangerous structure, and rolls one back.',
  });
  ex({
    id: 'ex18-pivot', title: 'The pivot of a dangerous structure', level: 2,
    text: ['Three concurrent transactions under SSI. T1 reads a row that T2 later writes, and T2 reads a row that T3 later writes. So there are rw-antidependencies T1 → T2 and T2 → T3. Which transaction is the **pivot** of this dangerous structure? ' + ANS('one of `T1`, `T2`, `T3`')],
    hints: ['A dangerous structure is two rw-antidependency edges in a row.', 'The pivot is the transaction with an rw edge coming in and an rw edge going out.', 'T2 has T1 → T2 in and T2 → T3 out: the pivot is T2.'],
    solution: 'T2', wrongs: ['T1', 'T3'], check: kit.choice(['t2'], ['t1', 't2', 't3']),
    ref: 'T2. It is the one in the middle, with an rw edge in (from T1) and out (to T3). PostgreSQL usually resolves the structure by rolling back the pivot, unless it has already committed.',
  });
  ex({
    id: 'ex18-versions', title: 'Reading a tuple header', level: 2,
    text: ['In a PostgreSQL-style table, transaction 40 inserted a row and committed. Transaction 52 updated the row and committed. Then transaction 57 deleted the row and **rolled back**. Now a new transaction reads the row. What are the **xmin and xmax** of the tuple it sees? ' + ANS('two numbers, xmin first, such as `40 52`')],
    hints: ['The update by 52 created a new tuple, so the visible tuple was created by 52.', 'The delete by 57 wrote its xid into that tuple\'s xmax. The rollback does not erase it.', 'The tuple is visible because 57 aborted. The answer is 52 57.'],
    solution: '52 57', wrongs: ['40 52', '52 0', '40 57'], check: kit.numSet([52, 57], { ordered: true }),
    ref: '52 57. Transaction 52 made the current tuple (xmin 52) and set xmax 52 on the one made by 40. Transaction 57 set xmax 57 on the current tuple; after its rollback the tuple keeps that xmax, but since 57 aborted, the tuple is still visible. You saw the same thing in the lesson on MVCC in practice.',
  });

  // the box office's call list: lock the unclaimed rows and skip what another caller holds
  const QUEUE_ALL = "select p.patron_id, p.name from patron p\nwhere not exists (select 1 from booking b\n                  where b.patron_id = p.patron_id and b.rating is not null)\norder by p.patron_id";
  const QUEUE = QUEUE_ALL + '\nfor update of p skip locked;';
  const rowsText = (r) => r.rows.map((row) => row.map((v, i) => (v === null ? 'NULL' : K.T.output(v, r.cols[i].type))).join('|'));
  ex({
    id: 'ex18-skip-locked', title: 'A call list for the box office', level: 3, kind: 'sql',
    text: ['The box office wants to phone every patron who has never rated a performance, to ask for feedback. Several callers work at once, each in their own session. Each runs one query, inside a transaction, that returns the `patron_id` and `name` of the patrons with no rated booking, ordered by `patron_id`, and **locks** the rows it returns, so that no other caller can take them. A row another caller has already locked must be **skipped**, not waited for.',
      'Write the query in the editor and check it. The check runs it once alone, then again while another session holds the first patron\'s row.'],
    hints: ['Start from the patrons with no rated booking: `not exists (select 1 from booking b where b.patron_id = p.patron_id and b.rating is not null)`.', 'Lock the rows a SELECT returns with `for update`; `for update of p` names the table whose rows are locked.', 'Add `skip locked` at the end:\n' + QUEUE],
    ref: QUEUE,
    wrongs: [QUEUE_ALL + '\nfor update of p;', QUEUE_ALL + '\nfor update of p nowait;'],
    check(app, answer) {
      const t = kit.norm(answer);
      if (!t) return kit.no('The editor is empty: write your query there, then check it.');
      if (!/^(select|with)\b/.test(t)) return kit.no('The answer should be one SELECT query.');
      const db = app.db;
      const a = db.session({ name: 'caller A' }), b = db.session({ name: 'caller B' });
      try {
        const want = rowsText(a.query(QUEUE_ALL));
        let got;
        b.exec('begin');
        try { got = b.exec(answer); } catch (e) { return kit.no('Your query fails: ' + e.message); } finally { b.exec('rollback'); }
        got = got[got.length - 1];
        if (!got || !got.rows) return kit.no('That statement does not return rows.');
        if (got.cols.length !== 2) return kit.no('Return two columns: patron_id and name.');
        if (JSON.stringify(rowsText(got)) !== JSON.stringify(want)) return kit.no('Run alone, your query should return the ' + want.length + ' patrons who never rated a booking, ordered by patron_id; it returns ' + got.rows.length + ' rows' + (got.rows.length === want.length ? ' that differ' : '') + '.');
        if (!/\bfor\s+(update|no\s+key\s+update)\b/.test(t)) return kit.no('The query returns the right rows but locks none of them: another caller could take the same patrons.');
        // caller A holds the first patron; B must skip that row, not wait and not fail
        a.exec('begin');
        a.exec('select patron_id from patron where patron_id = ' + Number(want[0].split('|')[0]) + ' for update');
        b.exec('begin');
        try { got = b.exec(answer); } catch (e) { return kit.no(e.code === '55P03' ? 'While another caller holds the first patron, your query ' + (/would wait/.test(e.message) ? 'waits for that row' : 'fails instead of going on') + ': skip locked rows instead.' : 'Your query fails: ' + e.message); } finally { b.exec('rollback'); a.exec('rollback'); }
        got = got[got.length - 1];
        if (JSON.stringify(rowsText(got)) !== JSON.stringify(want.slice(1))) return kit.no('While another caller holds the first patron, your query should return the other ' + (want.length - 1) + ' patrons; it returns ' + got.rows.length + '.');
        return kit.ok('Right: each caller locks the patrons it returns, and skips the ones another caller holds.');
      } finally { db.sessions = db.sessions.filter((x) => x !== a && x !== b); }
    },
  });

  // rows changed by the current transaction
  const MINE = 'select patron_id, name from patron\nwhere xmin::text = txid_current()::text\norder by patron_id;';
  ex({
    id: 'ex18-my-rows', title: 'The rows my transaction changed', level: 2, kind: 'sql',
    text: ['Inside a transaction, write a query that lists the `patron_id` and `name` of every patron whose current version was written by **this transaction**, ordered by `patron_id`. Use the system column `xmin` and the function `txid_current()`.',
      'To try it, run `begin;` and an update such as `update patron set points = points + 10 where patron_id <= 5;` first, then your query, then `rollback;`. The check runs your query after changes of its own.'],
    hints: ['Every row version records in `xmin` the transaction that wrote it.', '`txid_current()` returns the id of the current transaction. Compare the two; casting both to text is the safe way.', 'One answer:\n' + MINE],
    ref: MINE,
    wrongs: ['select patron_id, name from patron order by patron_id;', 'select patron_id, name from patron where xmax::text = txid_current()::text order by patron_id;'],
    check(app, answer) {
      const t = kit.norm(answer);
      if (!t) return kit.no('The editor is empty: write your query there, then check it.');
      if (!/^(select|with)\b/.test(t)) return kit.no('The answer should be one SELECT query.');
      const s = app.db.session({ name: 'checker' });
      const tries = [['patron_id % 7 = 3'], ['city is null', 'patron_id between 40 and 49']];
      try {
        for (const conds of tries) {
          s.exec('begin');
          try {
            for (const c of conds) s.exec('update patron set points = points + 1 where ' + c);
            const want = rowsText(s.query(MINE));
            let got;
            try { got = s.exec(answer); } catch (e) { return kit.no('Your query fails: ' + e.message); }
            got = got[got.length - 1];
            if (!got || !got.rows) return kit.no('That statement does not return rows.');
            if (got.cols.length !== 2) return kit.no('Return two columns: patron_id and name.');
            if (JSON.stringify(rowsText(got)) !== JSON.stringify(want)) return kit.no('After the check updated the patrons where ' + conds.join(' and where ') + ', your query should return those ' + want.length + ' rows, ordered by patron_id; it returns ' + got.rows.length + '.');
          } finally { s.exec('rollback'); }
        }
        return kit.ok('Right: the rows whose xmin is this transaction are the ones it has written.');
      } finally { app.db.sessions = app.db.sessions.filter((x) => x !== s); }
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
