// Chapter 23: parallel and distributed transaction processing. Two-phase commit (in the cluster view and with
// PREPARE TRANSACTION in two tabs), what blocks it and three-phase commit, distributed deadlock detection, and
// consensus with Raft and Paxos.
(function (root) {
  'use strict';
  const C = root.K.Content;
  const kit = C.kit1726;
  const lesson = kit.lesson;

  lesson({
    id: 'dtx-2pc', chapter: 23, title: 'Two-phase commit', minutes: 14,
    summary: 'A transaction that changes data at several sites must commit everywhere or nowhere. Two-phase commit gets every site to promise first, then tells them all the same decision.',
    body: [
      'A **distributed transaction** reads and writes data at more than one site. Each site runs a **transaction manager** that logs and recovers the work done there; the site where the transaction started also runs the **transaction coordinator**, which decides when the whole thing commits.',
      'Committing locally at each site is not enough. Suppose a transfer takes 30 from an account at site 1 and adds 30 to an account at site 2. If site 1 commits and site 2 crashes before it does, the money is gone. Atomicity has to hold across sites.',
      { h: 'The protocol' },
      { def: 'Phase 1, voting.', text: 'The coordinator writes `<prepare T>` to its log and sends PREPARE to every participant. A participant that can commit forces `<ready T>` to its own log, together with T\'s changes, and votes yes. From then on it has given up the right to abort on its own. A participant that cannot commit logs `<no T>` and votes no.' },
      { def: 'Phase 2, decision.', text: 'If every vote is yes, the coordinator forces `<commit T>` to its log; that log write is the moment T commits. Otherwise it logs `<abort T>`. It sends the decision to every participant, which logs it, finishes, and acknowledges. When all have acknowledged, the coordinator logs `<end T>`.' },
      { h: 'One participant, by hand' },
      'Kwery has one database, but the first phase of a participant is a real SQL statement. `PREPARE TRANSACTION \'name\'` ends the transaction without committing it: its changes and its locks are saved under a global name, and survive until somebody runs `COMMIT PREPARED` or `ROLLBACK PREPARED` with that name, from any session.',
      { sql: "drop table if exists acct_site2;\ncreate table acct_site2 (id int primary key, balance int check (balance >= 0));\ninsert into acct_site2 values (1, 100);", note: 'In tab 1. This table plays the part of site 2.' },
      { sql: "begin;\nupdate acct_site2 set balance = balance + 30 where id = 1;\nprepare transaction 'transfer-7';", note: 'In tab 1. This is the participant voting yes: its change is safely logged, but not committed.' },
      { sql: "select gid, transaction from pg_prepared_xacts;\nselect balance from acct_site2;", note: 'In tab 1. The session is no longer in a transaction, yet the prepared transaction lives on. The balance still reads 100: nothing is committed.' },
      'Now another transaction wants the same row. Open a second tab with the **+** next to the editor tab, and run this there.',
      { sql: 'update acct_site2 set balance = balance - 5 where id = 1;', tab: 2, waits: true, note: 'In tab 2. It waits.' },
      { predict: { q: 'Tab 2 waits for the prepared transaction. What would let it go on?', options: ['`COMMIT PREPARED` or `ROLLBACK PREPARED` of transfer-7, from any session', 'Closing tab 1', 'Nothing until the database restarts', 'Tab 2 times out after a second and goes on'], answer: 0, explain: 'A prepared transaction keeps its row locks until its fate is decided. Closing the session that prepared it changes nothing; that is the point, since a prepared participant must survive even a crash. Only the decision releases the locks.' } },
      { sql: "commit prepared 'transfer-7';", note: 'In tab 1. The coordinator\'s decision arrives. Tab 2\'s update now finishes.' },
      { sql: 'select balance from acct_site2;', note: 'In tab 1. 100 + 30 - 5 = 125: tab 2 re-read the committed row before subtracting.' },
      { h: 'A no vote' },
      'A participant votes no when it cannot do its part, for instance because a constraint fails. Here the check constraint refuses a negative balance:',
      { sql: 'begin;\nupdate acct_site2 set balance = balance - 1000 where id = 1;', fails: '23514', note: 'In tab 1. The update fails, and the transaction can only roll back.' },
      { sql: "prepare transaction 'transfer-8';", note: 'In tab 1. PREPARE on a failed transaction rolls it back (the tag is ROLLBACK): this participant votes no, and the coordinator will abort T everywhere.' },
      { sql: "select count(*) as prepared from pg_prepared_xacts;\ndrop table acct_site2;", note: 'In tab 1. Nothing is left prepared; the table goes.' },
      { h: 'The whole protocol on a cluster' },
      { view: 'cluster', sel: { scenario: '2pc' }, label: 'Open the cluster view (choose Two-phase commit in the Scenario menu)' },
      { steps: ['Choose **Two-phase commit** in the Scenario menu, with **2PC**, Failure **no failure** and 3 participants.', 'Press play. The coordinator C ships each participant its part of a transfer: P1 gives 20, P2 and P3 receive 10 each. Each participant runs a real UPDATE in an open transaction.', 'Watch PREPARE go out, the `<ready T1>` records appear in the participants\' logs, the yes votes come back, and then `<commit T1>` in C\'s log before any COMMIT message leaves.', 'Set Failure to **a participant votes no**. P2\'s update breaks its check constraint, it votes no, and every participant rolls back: all balances stay at 100.'] },
      { tip: 'The commit point is the coordinator\'s log write of `<commit T>`, not any message. A crash just after that write still ends in commit, because the coordinator will find the record when it restarts.' },
    ],
  });

  lesson({
    id: 'dtx-failures', chapter: 23, title: 'Failures in 2PC, blocking, and three-phase commit', minutes: 14,
    summary: 'What each site does when a participant, the coordinator, a message or the network fails during two-phase commit, why a participant can be stuck holding locks, and how three-phase commit avoids that under crashes.',
    body: [
      'Every rule for handling failures in two-phase commit follows from one fact: after a participant has logged `<ready T>`, it does not know the decision and is not allowed to guess.',
      { h: 'A participant restarts' },
      'When a participant comes back after a crash, it reads its log for each transaction T:',
      { list: ['`<commit T>` in the log: redo T.', '`<abort T>` in the log: undo T.', '`<ready T>` and no decision: it must ask. It asks the coordinator, or other participants, and meanwhile holds T\'s locks again.', 'no `<ready T>` at all: it never voted, so the coordinator cannot have decided commit. It undoes T.'] },
      { h: 'The coordinator fails' },
      'If the coordinator crashes, the participants try to decide among themselves. If one of them has `<commit T>` or `<abort T>`, everyone follows it. If one of them has not even logged `<ready T>`, nobody can have committed, so they abort. But if every live participant has `<ready T>` and nothing more, they must wait for the coordinator. That is the **blocking problem**: they hold their locks while they wait, and other transactions queue behind those locks.',
      { view: 'cluster', sel: { scenario: '2pc' }, label: 'Open the cluster view (choose Two-phase commit in the Scenario menu)' },
      { steps: ['Choose Failure **coordinator crashes before deciding** and untick **Crashed nodes come back**. Press play.', 'C crashes with every yes vote in hand. P1, P2 and P3 each time out, ask, and get no answer: the run ends with all three blocked, balances unchanged, locks held.', 'Tick **Crashed nodes come back** again. C restarts about 150 time units later, finds no decision in its log, and aborts: everyone rolls back.', 'Now try **coordinator crashes after logging commit**. With restarts on, C comes back, finds `<commit T1>`, and everyone commits.', 'Try **coordinator sends COMMIT to one, then crashes**. P2 and P3 are blocked only until they ask P1, which knows the outcome: all three commit.'] },
      { predict: { q: 'Failure **participant crashes before voting**, with restarts off. What happens to the transfer?', options: ['C times out waiting for P2\'s vote and aborts; P1 and P3 roll back', 'Everyone waits for P2 forever', 'P1 and P3 commit, P2 is left behind', 'C commits, because two of three said yes'], answer: 0, explain: 'A missing vote counts as no. The coordinator can abort safely, because P2 never promised anything. P2, when it does come back, finds no `<ready T>` and undoes its part on its own.' } },
      { h: 'Watching locks held by a blocked participant' },
      'The same blocking is easy to see with prepared transactions. A prepared transaction is a participant that voted yes and has not heard back.',
      { sql: "drop table if exists seats;\ncreate table seats (flight text, seat text primary key, holder text);\ninsert into seats values ('KW12', '14A', null), ('KW12', '14B', null);\nbegin;\nupdate seats set holder = 'Rahman' where seat = '14A';\nprepare transaction 'booking-31';", note: 'In tab 1. A participant votes yes and then hears nothing.' },
      { sql: "select seat, holder from seats where seat = '14A' for update nowait;", tab: 2, fails: '55P03', note: 'In tab 2. Another booking cannot even look at seat 14A with a lock: NOWAIT reports the lock at once instead of waiting.' },
      { sql: "select seat, holder from seats order by seat;", tab: 2, note: 'In tab 2. Plain reads still work: they read the last committed version, so 14A is still free.' },
      { sql: "rollback prepared 'booking-31';\nselect count(*) as still_prepared from pg_prepared_xacts;\ndrop table seats;", note: 'In tab 1. Here the decision is abort. In a real system an administrator sometimes has to make this call by hand, which is why `pg_prepared_xacts` exists.' },
      { h: 'Three-phase commit' },
      'Three-phase commit adds a round between the vote and the commit. When every vote is yes, the coordinator first sends PRECOMMIT; participants record it and acknowledge; only then does it send COMMIT. The new state means that no participant can be in doubt while another has already committed. If the coordinator fails, the remaining participants elect a new one, which can always finish: if any of them got PRECOMMIT, commit; if none did, abort.',
      { steps: ['Switch the scenario to **3PC**. Choose **coordinator crashes before PRECOMMIT**: the participants abort on their own, nobody blocks.', 'Choose **PRECOMMIT reaches one, coordinator crashes**: the participants learn that one of them was precommitted, and all commit.', 'Choose the **partition** failure: PRECOMMIT reaches P1 only, C crashes, and the network splits P1 from the others. Each side finishes on its own rules: P1 commits, P2 and P3 abort. The outcome is not atomic.'] },
      { warn: '3PC assumes a crash is the only kind of failure and that a node can tell a crashed site from a slow one. A network partition breaks that assumption, which is why practical systems use 2PC with a highly available coordinator, often itself replicated by a consensus protocol.' },
    ],
  });

  lesson({
    id: 'dtx-deadlock', chapter: 23, title: 'Distributed deadlock detection', minutes: 11,
    summary: 'Each site sees only its own waits. A deadlock can span sites with no cycle at any one of them, so the local wait-for graphs have to be put together, and doing that late can show a cycle that never existed.',
    body: [
      'Locking works the same way at each site of a distributed database: each site has a lock manager, and a transaction waits when a lock it needs is held by another. The trouble is that the **wait-for graph** is spread out. At site S1, T2 may wait for T1; at site S2, T1 may wait for T2. Neither site has a cycle. Together they do.',
      { h: 'Building the global graph' },
      'A central **deadlock-detection coordinator** collects each site\'s local wait-for graph from time to time, takes their union, and looks for a cycle. Here are two sites\' reports, as tables:',
      { sql: "drop table if exists wfg_report;\ncreate table wfg_report (site text, waiter text, holder text);\ninsert into wfg_report values\n  ('S1', 'T2', 'T1'),\n  ('S2', 'T1', 'T2'),\n  ('S2', 'T3', 'T1');\nselect site, waiter || ' waits for ' || holder as edge\nfrom wfg_report order by site, waiter;" },
      { predict: { q: 'Does either site on its own have a cycle in its wait-for graph?', options: ['No: S1 has one edge, S2 has two edges with no loop', 'Yes, S2 does', 'Yes, both do'], answer: 0, explain: 'S2 has T1 -> T2 and T3 -> T1, a path but not a cycle. Only the union, with S1\'s T2 -> T1, closes the loop T1 -> T2 -> T1.' } },
      'A recursive query finds every transaction that can reach itself through the union of the reports, which is exactly the set of transactions on a cycle:',
      { sql: "with recursive reach (start, cur, path) as (\n  select waiter, holder, waiter || ' -> ' || holder from wfg_report\n  union\n  select r.start, w.holder, r.path || ' -> ' || w.holder\n  from reach r join wfg_report w on w.waiter = r.cur\n  where r.start <> r.cur and length(r.path) < 60\n)\nselect start as deadlocked, path from reach\nwhere start = cur\norder by start;" },
      'T3 is not on the cycle: it waits for T1, and will go on once the cycle is broken. The detector picks a victim on the cycle, often the youngest transaction, and has it rolled back at every site where it runs.',
      { h: 'In the cluster view' },
      { view: 'cluster', sel: { scenario: 'deadlock' }, label: 'Open the cluster view (choose Distributed deadlock in the Scenario menu)' },
      { steps: ['Choose **Distributed deadlock** and **A global deadlock**, then press play.', 'T1 updates item 1 at S1, T2 updates item 2 at S2; then T1 wants item 2 at S2 and T2 wants item 1 at S1. Each engine shows one waiting statement and no cycle.', 'The detector D collects the local graphs every 40 time units. Its first collection, complete at about t = 53, already shows T1 -> T2 -> T1, and it aborts T2, the younger. T1 then finishes and commits at both sites.'] },
      { h: 'False cycles' },
      'Reports take time to travel. Suppose S1 reports that T1 waits for T2, then T2 releases its lock at S1 and S1 sends the removal of that edge over a slow link. Meanwhile T2 asks for something T1 holds at S2, and S2\'s report arrives first. For a moment the detector holds both T1 -> T2 and T2 -> T1: a **false cycle**. It aborts a transaction that was never deadlocked.',
      { steps: ['Switch the scenario to **A false cycle** and play it.', 'Watch the true wait-for graph and D\'s graph side by side: at t = 61 D\'s graph has a cycle while the true graph never had one.'] },
      { tip: 'A false cycle costs an unnecessary rollback, never a wrong result. Missing a real deadlock would be worse: the transactions would wait for ever. Detectors are built to err on the side of a false alarm.' },
      { sql: 'drop table wfg_report;' },
    ],
  });

  lesson({
    id: 'dtx-consensus', chapter: 23, title: 'Consensus: Raft and Paxos', minutes: 15,
    summary: 'Replicas agree on one sequence of commands, even when some of them crash or the network splits, as long as a majority can talk. Raft elects a leader and copies its log; Paxos chooses a value with numbered ballots.',
    body: [
      'Two-phase commit blocks when its coordinator fails. Replication with a fixed primary loses writes when the primary fails. Both need the same missing piece: a way for several nodes to **agree** on something, a decision or the next command, while any minority of them may be down. That is the **consensus** problem.',
      'Every protocol here rests on **majorities**. Any two majorities of the same set of nodes share at least one node, so a decision taken by one majority is always seen by any later majority.',
      { sql: 'select n as servers,\n       n / 2 + 1 as majority,\n       n - (n / 2 + 1) as can_fail\nfrom generate_series(1, 7) as g(n);' },
      { predict: { q: 'Going from 3 servers to 4, how many failures can the group survive?', options: ['Still 1: a majority of 4 is 3', '2', 'None'], answer: 0, explain: 'A majority of 4 is 3, so only one server may fail, the same as with 3 servers. That is why groups usually have an odd number of members.' } },
      { h: 'Raft' },
      'In Raft each server is a **follower**, a **candidate** or the **leader**. Time is split into numbered **terms**. A follower that hears nothing from a leader before its election timer runs out becomes a candidate: it starts a new term, votes for itself and asks the others. Each server votes at most once per term, so at most one candidate can win a majority. The winner sends heartbeats that keep the others\' timers from running out.',
      'The leader appends each client command to its **log** and sends it to the followers. An entry is **committed** once a majority stores it; then every server applies it to its state, in log order.',
      { view: 'cluster', sel: { scenario: 'raft' }, label: 'Open the cluster view (choose Raft in the Scenario menu)' },
      { steps: ['Choose **Raft** with 5 servers and seed 1, and press play.', 's2\'s timer runs out first, at t = 150. It asks for votes in term 1 and becomes leader at about t = 175, then commits entry 1 once a majority has it.', 'The client\'s commands x = 1 and y = 2 arrive at t = 400 and t = 560 and become entries 2 and 3.', 'Press **Crash the leader**. The followers\' timers run out; one of them wins term 2 and takes over. Press **Restart crashed servers**: s2 comes back as a follower in the new term and catches up.', 'Press **Cut off the leader**: the leader, one follower and the client end up on the small side. The leader can still take commands but cannot commit them, while the three on the other side elect a leader of their own. Press **Heal the network**: the old leader sees the higher term and steps down, and any entries it could not commit are replaced by the new leader\'s.'] },
      'The rule for committing is a count over the servers. Here is a log replicated to five servers, one row per entry a server stores:',
      { sql: "drop table if exists raft_log;\ncreate table raft_log (server text, idx int, term int, cmd text);\ninsert into raft_log values\n  ('s1', 1, 1, 'x=1'), ('s1', 2, 1, 'y=2'), ('s1', 3, 2, 'x=5'), ('s1', 4, 2, 'z=0'),\n  ('s2', 1, 1, 'x=1'), ('s2', 2, 1, 'y=2'), ('s2', 3, 2, 'x=5'),\n  ('s3', 1, 1, 'x=1'), ('s3', 2, 1, 'y=2'),\n  ('s4', 1, 1, 'x=1'),\n  ('s5', 1, 1, 'x=1'), ('s5', 2, 1, 'y=2'), ('s5', 3, 2, 'x=5');\nselect idx, count(*) as stored_on,\n       count(*) >= 5 / 2 + 1 as committed\nfrom raft_log group by idx order by idx;", note: 's1 is the leader of term 2.' },
      'Entry 3 is on s1, s2 and s5: three of five, a majority, so it is committed even though s3 and s4 do not have it yet. Entry 4 has only reached the leader: it is not committed, and if s1 crashed now it could be lost without harm, because no client was told it succeeded.',
      { h: 'Paxos' },
      'Paxos chooses a single value. **Proposers** suggest values, **acceptors** vote, **learners** find out what was chosen. Each attempt has a **ballot number**, unique and ordered.',
      { list: ['Prepare: a proposer sends prepare(n). An acceptor that has not promised a higher ballot promises to ignore lower ones, and reports the proposal it has accepted, if any.', 'Accept: with promises from a majority, the proposer sends accept(n, v). The value v is not free: it must be the value of the highest-numbered proposal any of those acceptors reported, and only if none reported one may it use its own.', 'A value is chosen once a majority accepts the same ballot.'] },
      'That second rule is what makes Paxos safe: once a value is chosen, any later majority contains an acceptor that accepted it, so every later ballot proposes it again.',
      { sql: "drop table if exists promises;\ncreate table promises (acceptor text, accepted_ballot numeric, accepted_value text);\ninsert into promises values ('a1', 1.1, 'A'), ('a2', null, null), ('a3', 1.2, 'B');\nselect coalesce(\n  (select accepted_value from promises\n   where accepted_ballot is not null\n   order by accepted_ballot desc limit 1),\n  'my own value') as must_propose;", note: 'A proposer with ballot 2.1 got these three promises.' },
      { steps: ['Choose **Paxos (single decree)** with 3 acceptors and 2 proposers starting **at the same time**. p1 starts ballot 1.1 with value A, p2 ballot 1.2 with value B.', 'Ballot 1.2 is higher, so acceptors that promised it reject p1\'s accept. B is chosen with ballot 1.2.', 'Set Start to **one after another**: p1 gets A chosen before p2 begins, and p2 learns A instead of proposing B.'] },
      { sql: 'drop table raft_log;\ndrop table promises;' },
      { tip: 'Raft is what you get when you run Paxos-style agreement over and over, once per log entry, with a stable leader so that the prepare round is needed only after an election. Both need a live majority: with half the nodes gone, they wait rather than risk two different answers.' },
    ],
  });

  // ---- exercises ------------------------------------------------------------------------------------------------------
  C.exercise({
    id: 'ex23-2pc-after-commit', chapter: 23, title: '2PC: the coordinator crashes after its decision', level: 1, kind: 'answer',
    text: ['A coordinator gets yes votes from all three participants, forces `<commit T>` to its log, and crashes before sending any COMMIT message. It restarts an hour later. What is the final outcome of T at the participants?', 'Type **commit** or **abort** in the editor, then check.'],
    hints: ['The commit point is a log write, not a message.', 'On restart the coordinator reads its log and finds `<commit T>`. Participants that asked in the meantime got no answer and stayed blocked.', 'commit: the decision was made when `<commit T>` reached the coordinator\'s stable log; after restart it sends COMMIT, and the blocked participants finish.'],
    solution: 'commit', wrongs: ['abort'], ref: 'commit (the forced <commit T> record is the commit point)',
    check: kit.choice(['commit'], ['commit', 'abort']),
  });
  C.exercise({
    id: 'ex23-2pc-blocking', chapter: 23, title: 'Which failures block?', level: 2, kind: 'answer',
    text: ['Under two-phase commit, with every site using the usual recovery rules, which of these failures can leave a live participant **blocked** (in doubt, holding its locks) for as long as the coordinator stays down?',
      { list: ['(a) A participant crashes before it votes.', '(b) The coordinator crashes after receiving every yes vote, before logging a decision.', '(c) The coordinator crashes before sending PREPARE.', '(d) The coordinator crashes after sending COMMIT to one participant only, and that participant is up.'] },
      'Answer yes or no for each, in order: for example `no yes no no`.'],
    hints: ['A participant is blocked only if it has logged `<ready T>` and cannot find out the decision.', 'In (a) and (c) nobody has voted yes... or nobody has been asked. In (d) one participant knows the decision, and the others can ask it.', 'no yes no no: only in (b) are all live participants in the ready state with no site that knows the decision.'],
    solution: 'no yes no no', wrongs: ['no yes no yes', 'yes yes no no'], ref: 'no yes no no',
    check: kit.yesNoList([false, true, false, false], ['a', 'b', 'c', 'd']),
  });
  C.exercise({
    id: 'ex23-participant-restart', chapter: 23, title: 'A participant restarts', level: 1, kind: 'answer',
    text: ['A participant restarts after a crash. Its log holds, for three transactions:', { list: ['T5: `<T5 start>`, updates, `<ready T5>`, `<commit T5>`', 'T6: `<T6 start>`, updates, `<ready T6>`', 'T7: `<T7 start>`, updates'] },
      'For which transaction must it ask the coordinator (or another site) before it can finish? Name it, as T5, T6 or T7.'],
    hints: ['With a decision in the log, the site knows what to do.', 'Without `<ready T>` the site never voted yes, so it may abort on its own.', 'T6: it voted yes (`<ready T6>`) and has no decision, so it is in doubt; T5 is redone and T7 undone.'],
    solution: 'T6', wrongs: ['T7', 'T6 T7'], ref: 'T6',
    check: kit.txSet(['T6'], 'in doubt'),
  });
  C.exercise({
    id: 'ex23-global-wfg', chapter: 23, title: 'A global wait-for graph', level: 2, kind: 'answer',
    text: ['Three sites report their local wait-for graphs (an edge Ti -> Tj means Ti waits for Tj):', { list: ['S1: T1 -> T2, T4 -> T5', 'S2: T2 -> T3, T5 -> T1', 'S3: T3 -> T1, T6 -> T4'] },
      'Which transactions are on a cycle of the global graph? List them, for example `T1 T4`, or write none.'],
    hints: ['Draw all six edges in one graph.', 'Follow T1: T1 -> T2 -> T3 -> T1. Then follow T4 and T6.', 'T1 T2 T3: the cycle is T1 -> T2 -> T3 -> T1. T4 -> T5 -> T1 leads into the cycle without being on it, and T6 waits for T4.'],
    solution: 'T1 T2 T3', wrongs: ['T1 T2 T3 T4 T5', 'none'], ref: 'T1 T2 T3',
    check: kit.txSet(['T1', 'T2', 'T3'], 'on the cycle'),
  });
  C.exercise({
    id: 'ex23-raft-failures', chapter: 23, title: 'How many failures?', level: 1, kind: 'answer',
    text: ['A Raft group has 7 servers. How many of them can crash at the same time with the rest still able to elect a leader and commit new entries? Type the number.'],
    hints: ['Electing a leader and committing both need a majority of all 7, not of the live ones.', 'A majority of 7 is 4.', '3: with 7 - 3 = 4 servers up, a majority is still there; with 4 down, only 3 remain.'],
    solution: '3', wrongs: ['4', '6'], ref: '3',
    check: kit.number(3),
  });
  C.exercise({
    id: 'ex23-raft-commit', chapter: 23, title: 'The commit index', level: 2, kind: 'answer',
    text: ['A Raft leader of term 4 has 5 servers in its group (itself included). The highest log index each server is known to store is: leader 9, s2 8, s3 7, s4 5, s5 4. All entries from index 5 on were created in term 4. Up to which index can the leader mark entries as committed? Type the number.'],
    hints: ['An entry is committed when a majority, here 3 servers, stores it.', 'Sort the indexes: 9, 8, 7, 5, 4. Which is the largest index that at least three servers have reached?', '7: the leader, s2 and s3 all store index 7, and it was created in the current term.'],
    solution: '7', wrongs: ['9', '5'], ref: '7',
    check: kit.number(7),
  });
  C.exercise({
    id: 'ex23-paxos-value', chapter: 23, title: 'Which value may a Paxos proposer send?', level: 2, kind: 'answer',
    text: ['A proposer wants the value Z and runs prepare with ballot 5.2 against five acceptors. Three of them promise, reporting what they have accepted: one reports (ballot 3.1, value X), one reports (ballot 4.3, value Y), one reports nothing. Which value must it send in accept(5.2, v)? Type X, Y or Z.'],
    hints: ['The proposer is not free to choose when some promiser has accepted a proposal.', 'Among the reported proposals, take the one with the highest ballot.', 'Y: ballot 4.3 is higher than 3.1, so the proposer must propose Y; only with no reports at all could it send its own Z.'],
    solution: 'Y', wrongs: ['Z', 'X'], ref: 'Y',
    check: kit.choice(['y'], ['x', 'y', 'z']),
  });
})(typeof window !== 'undefined' ? window : globalThis);
