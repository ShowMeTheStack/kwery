// Chapter 21: parallel and distributed storage. Partitioning a relation (round-robin, hash, range) and the skew
// each suffers, consistent hashing and rebalancing, replication with its lag and session guarantees, quorums and
// what a network partition forces a replicated system to give up.
(function (root) {
  'use strict';
  const C = root.K.Content;
  const kit = C.kit1726;
  const lesson = kit.lesson;
  // the "hash function" the lessons use in SQL: the first byte of the MD5 digest, 0 to 255
  const H = "get_byte(decode(md5(patron_id::text), 'hex'), 0)";

  lesson({
    id: 'dst-partitioning', chapter: 21, title: 'Partitioning a relation', minutes: 13,
    summary: 'Spreading the rows of one relation over several nodes: round-robin, hash and range partitioning, what each is good at, and the skew that can spoil all three.',
    body: [
      'A parallel database stores a large relation on many nodes so that many disks and processors can work on it at once. Splitting the rows of a relation this way is called **partitioning** (in a distributed setting, **sharding**). The question is which row goes where.',
      { def: 'Round-robin.', text: 'Deal the rows out like cards: row i goes to node i mod n. Every node gets almost exactly the same number of rows.' },
      { def: 'Hash partitioning.', text: 'Choose one or more **partitioning attributes**, and send a row to node h(key) mod n for a hash function h. All rows with the same key land on the same node.' },
      { def: 'Range partitioning.', text: 'Choose boundary values v1 < v2 < ...; a row whose key is at most v1 goes to the first node, between v1 and v2 to the second, and so on. Nearby keys land together.' },
      'You can try each one on the Theatre data without a cluster, by computing the node number in SQL. First, round-robin over the 1,100 rows of `booking`, in the order of their ids:',
      { sql: 'select node, count(*) as rows\nfrom (select row_number() over (order by booking_id) % 3 as node\n      from booking) t\ngroup by node order by node;' },
      'Now hash partitioning on the patron. As a hash function the lessons in this chapter use the first byte of the MD5 digest of the key, written as text, a number from 0 to 255:',
      { sql: 'select ' + H + ' % 3 as node, count(*) as rows\nfrom booking\ngroup by 1 order by 1;' },
      'And range partitioning on the performance, with boundaries 60 and 120 (performances are numbered in date order):',
      { sql: "select case when perf_id <= 60 then 'n1'\n            when perf_id <= 120 then 'n2'\n            else 'n3' end as node,\n       count(*) as rows\nfrom booking\ngroup by 1 order by 1;", note: 'Later performances sold more tickets, so the last range is the fullest.' },
      { h: 'Which queries each scheme helps' },
      'Round-robin is ideal for a query that reads the whole relation: every node scans a third and finishes at the same time. But a **point query** such as "the bookings of patron 17" must ask every node, since that patron\'s rows were dealt out to all of them:',
      { sql: "select count(distinct node) as nodes_holding_17\nfrom (select patron_id, row_number() over (order by booking_id) % 3 as node\n      from booking) t\nwhere patron_id = 17;" },
      { sql: "select count(distinct " + H + " % 3) as nodes_holding_17\nfrom booking\nwhere patron_id = 17;", note: 'Under hash partitioning on patron_id, all twelve of the patron\'s bookings are on one node.' },
      { predict: { q: 'Under the range partitioning on perf_id above, how many nodes must a query for performances 70 to 110 read?', options: ['One: n2 holds exactly 61 to 120', 'Two', 'All three, as with hashing'], answer: 0, explain: 'Range partitioning keeps a range of keys together, so a **range query** goes only to the nodes whose ranges overlap it. Hash partitioning scatters performances 70 to 110 over the nodes, and would have to ask all of them.' } },
      { h: 'Skew' },
      'A parallel scan takes as long as the slowest node. If one node holds much more than its share, the others sit idle while it finishes. That is **skew**. It comes in two kinds:',
      { list: ['**Attribute-value skew**: many rows share one key value, and every scheme that places rows by key must put them all on one node.', '**Partition skew**: the boundaries or the hash function just divide the keys badly, even though no single value is common.'] },
      'The hash partitioning on patron_id above already shows partition skew: 289, 448 and 363 rows, though no patron has more than a few dozen bookings. Now partition `booking` on the rating, which has only six values (1 to 5, and none yet):',
      { sql: "select " + H.replace('md5(patron_id::text)', "md5(coalesce(rating::text, 'none'))") + " % 3 as node, count(*) as rows\nfrom booking\ngroup by 1 order by 1;" },
      'Six values cannot be split evenly over three nodes: one node gets 751 rows and another only the 5 bookings rated 1. A common measure is **max / mean**: here 751 / 366.7, about 2.05, so a parallel scan runs about twice as long as a balanced one would, while one node sits almost idle.',
      { view: 'cluster', sel: { scenario: 'partition' }, label: 'Open the cluster view (choose Partitioning a table in the Scenario menu)' },
      { steps: ['Choose **Partitioning a table**, a large table such as **booking**, a key such as **patron_id**, and 3 nodes.', 'Try each Scheme in turn. The bars show the rows per node, and the note under them gives max/mean. Round-robin and equi-depth range come out almost perfect; plain hash is a little uneven.', 'Change the key to a column with few distinct values, such as **rating**. Hash is now far worse, and the table at the bottom says why: a few values hold most of the rows, more than any scheme can split.'] },
      { tip: 'Range boundaries chosen from a **histogram** (equi-depth, the same number of rows in each range) avoid most partition skew for range partitioning. They cannot fix attribute-value skew.' },
    ],
  });

  lesson({
    id: 'dst-rebalance', chapter: 21, title: 'Rebalancing and consistent hashing', minutes: 12,
    summary: 'When a node joins, h(key) mod n sends almost every row somewhere new. Consistent hashing moves only the rows the new node takes over; virtual nodes even out the shares.',
    body: [
      'A cluster grows. When a fourth or fifth node joins, some rows have to move to it. How many depends on the partitioning scheme, and moving rows is not free: each is read, sent over the network, written, and deleted at its old home, all while queries keep running.',
      'With hash partitioning, a row lives on node h(k) mod n. Count how many of the 194 patrons with bookings would change node when n goes from 4 to 5:',
      { sql: 'select count(*) as patrons,\n       count(*) filter (where ' + H + ' % 4 <> ' + H + ' % 5) as must_move\nfrom (select distinct patron_id from booking) s;' },
      { predict: { q: 'Ideally, a fifth node should take one fifth of the data, and nothing else should move. Hash mod n moves 148 of 194 patrons. Why so many?', options: ['Changing n changes h(k) mod n for most keys, even keys the new node does not take', 'MD5 is a poor hash function', 'The data is skewed'], answer: 0, explain: 'A key stays put only if h(k) mod 4 equals h(k) mod 5, which is true for few keys. Almost every key gets a new remainder, so rows shuffle between the old nodes too, not just onto the new one.' } },
      { h: 'Consistent hashing' },
      'Put the hash values on a circle, a **ring**: here 0 to 255, wrapping round. Each node is also hashed to a point on the ring. A key belongs to the first node point at or after its own position, going clockwise, wrapping past 255 back to the start.',
      { sql: "drop table if exists ring_points;\ncreate table ring_points (node text, pos int);\ninsert into ring_points values ('n1', 40), ('n2', 120), ('n3', 200);\nwith k as (select distinct patron_id, " + H + " as h from booking)\nselect coalesce((select node from ring_points p where p.pos >= k.h order by p.pos limit 1),\n                (select node from ring_points order by pos limit 1)) as node,\n       count(*) as patrons\nfrom k group by 1 order by 1;", note: 'n1 owns the arc from 201 round to 40, n2 from 41 to 120, n3 from 121 to 200.' },
      'Now node n4 joins at position 160. Only the keys between 121 and 160 change hands, all of them from n3 to n4. Nothing else moves:',
      { sql: "with k as (select distinct patron_id, " + H + " as h from booking)\nselect count(*) as moving_to_n4\nfrom k where h > 120 and h <= 160;\ninsert into ring_points values ('n4', 160);\nwith k as (select distinct patron_id, " + H + " as h from booking)\nselect coalesce((select node from ring_points p where p.pos >= k.h order by p.pos limit 1),\n                (select node from ring_points order by pos limit 1)) as node,\n       count(*) as patrons\nfrom k group by 1 order by 1;" },
      '32 patrons move instead of 148. The catch shows in the result: n4 took load from n3 alone, so n1 and n2 are now fuller than n3 and n4. One point per node gives uneven arcs.',
      { h: 'Virtual nodes' },
      'The fix is to give each node many points on the ring, called **virtual nodes**. Each node then owns many small arcs scattered round the ring, its share evens out, and a new node takes a little from every other node instead of a lot from one.',
      { view: 'cluster', sel: { scenario: 'partition' }, label: 'Open the cluster view (choose Partitioning a table in the Scenario menu)' },
      { steps: ['Choose **Partitioning a table**, booking, key patron_id, Scheme **Consistent hashing ring**, 3 nodes, **1 point** per node. The ring shows three uneven arcs; note max/mean.', 'Press **Add a node**. Read "The last change": the rows that moved all went to n4, far fewer than hash mod n would have moved. The red ticks on the ring are the moved keys.', 'Set **32 points** per node. Before the change max/mean is much closer to 1 than with one point. Add a node: n4 now takes rows from all three old nodes, instead of from a single neighbour.', 'Click a node and choose **Remove** to see the opposite: only the leaving node\'s rows move.'] },
      { sql: 'drop table ring_points;' },
      { tip: 'Range partitioning also rebalances cheaply: split the fullest range in two and move one half. Hash partitioning gets the same effect with a fixed, large number of **virtual partitions** that are dealt to nodes and moved whole.' },
    ],
  });

  lesson({
    id: 'dst-replication', chapter: 21, title: 'Replication: synchronous, asynchronous, and reading your own writes', minutes: 13,
    summary: 'Keeping copies of data on several nodes for availability and read throughput. Synchronous replication waits for every copy; asynchronous answers at once and lets replicas lag, which a session token can hide.',
    body: [
      'A node can fail, and with it every partition stored on it. So each partition is **replicated**: kept on two or three nodes. Replication also lets reads go to any copy, spreading the load.',
      'The simplest arrangement is **primary copy** replication. One replica is the **primary**: every write goes to it, it orders the writes in its log, and it ships the log to the other replicas, which apply it in the same order.',
      { def: 'Synchronous.', text: 'The primary answers the client only after every replica has applied the write. All copies agree, but each write waits for the slowest replica.' },
      { def: 'Asynchronous.', text: 'The primary answers at once and ships the write later. Writes are fast, but replicas **lag** behind, and if the primary fails, writes it had not shipped yet are lost.' },
      { h: 'A replica is a log, applied up to a point' },
      'Here is a primary\'s log of five writes, and how far each replica has applied it:',
      { sql: "drop table if exists primary_log, replica_state;\ncreate table primary_log (seq int primary key, key text, value text);\ninsert into primary_log values (1, 'k', 'v1'), (2, 'j', 'a'), (3, 'k', 'v2'), (4, 'j', 'b'), (5, 'k', 'v3');\ncreate table replica_state (replica text primary key, applied int);\ninsert into replica_state values ('P', 5), ('R1', 5), ('R2', 3);" },
      { sql: "select r.replica, r.applied,\n       (select max(seq) from primary_log) - r.applied as lag,\n       (select value from primary_log l\n        where l.key = 'k' and l.seq <= r.applied\n        order by l.seq desc limit 1) as k_reads_as\nfrom replica_state r order by r.replica;" },
      { predict: { q: 'A client has just written k = v3 (write 5) and now reads k. Its read happens to go to R2. What does it see?', options: ['v2: its own write is not there yet', 'v3', 'An error'], answer: 0, explain: 'R2 has applied only up to write 3, so it answers with v2. The client wrote v3 and then could not see it. That breaks **read-your-writes**, a guarantee users expect even when they accept some staleness from other people\'s writes.' } },
      'The cure is a **session token**: the client remembers the sequence number of its last write (5) and sends it with each read. A replica may answer only once it has applied that far; otherwise it waits, or the read goes elsewhere.',
      { sql: "select replica, applied >= 5 as may_answer_now\nfrom replica_state order by replica;" },
      { view: 'cluster', sel: { scenario: 'replication' }, label: 'Open the cluster view (choose Replication: sync and async in the Scenario menu)' },
      { steps: ['Choose **Replication: sync and async**, **Asynchronous**, Reads from **any copy**, no session token, R2 lag **+60**, seed 2. The client writes k eight times, reading it twice after each write.', 'Press play and watch the lag chart. In the client\'s session list, reads that miss the client\'s own write are marked: seven read-your-writes violations and one monotonic-read violation (a read older than an earlier one).', 'Tick **Session token** and run again: no violations. Some reads at R2 now wait (the card says "read waiting").', 'Switch to **Synchronous**: no violations either, but the whole script takes about three times as long (t 1,777 instead of 617), because every write waits for R2.', 'Try Reads from **one replica (sticky)**: monotonic reads hold, since one replica never goes backwards, but read-your-writes fails again and again.'] },
      { sql: 'drop table primary_log, replica_state;' },
      { tip: 'Many systems replicate **semi-synchronously**: the primary waits for one replica, not all. A failed primary then always has an up-to-date copy somewhere, at the price of one extra round trip per write.' },
    ],
  });

  lesson({
    id: 'dst-quorums-cap', chapter: 21, title: 'Quorums and the CAP theorem', minutes: 14,
    summary: 'Without a primary, writes and reads go to sets of replicas. If every read set overlaps every write set, reads see completed writes. And when the network splits, a replicated system must choose between consistency and availability.',
    body: [
      'Some systems have no primary. Each item is stored on N replicas; a client writes to all of them but counts the write done once **W** replicas confirm, and reads from replicas until **R** have answered, keeping the newest version among the answers.',
      'Why should a read find the latest write? Only if the R replicas it hears from include at least one of the W that stored the write. Count, for N = 5, how many sets of two replicas would miss a write stored on A and B (R = 2, W = 2):',
      { sql: "with r(id) as (values ('A'), ('B'), ('C'), ('D'), ('E'))\nselect count(*) as read_quorums,\n       count(*) filter (where x.id not in ('A', 'B') and y.id not in ('A', 'B')) as miss_the_write\nfrom r x join r y on x.id < y.id;" },
      'Three of the ten possible read quorums miss the write entirely. Now R = 3 and W = 3, with the write stored on A, B and C:',
      { sql: "with r(id) as (values ('A'), ('B'), ('C'), ('D'), ('E'))\nselect count(*) as read_quorums,\n       count(*) filter (where x.id not in ('A', 'B', 'C') and y.id not in ('A', 'B', 'C')\n                          and z.id not in ('A', 'B', 'C')) as miss_the_write\nfrom r x join r y on x.id < y.id join r z on y.id < z.id;" },
      'None: three readers out of five cannot avoid three writers out of five. The rule is **R + W > N**. Then every read quorum and every write quorum share a replica.',
      { predict: { q: 'N = 5 and W = 5 (every replica must confirm a write). What is the smallest R that still guarantees a read sees the last completed write?', options: ['1', '3', '5'], answer: 0, explain: 'R + W = 1 + 5 > 5. Every replica has every completed write, so any single one will do. The price is that a write fails if even one replica is down.' } },
      { view: 'cluster', sel: { scenario: 'quorum' }, label: 'Open the cluster view (choose Quorums: N, R, W in the Scenario menu)' },
      { steps: ['Choose **Quorums: N, R, W** with N = 5, R = 3, W = 3, seed 3, and play. Two clients read and write x; no read is stale.', 'Set R = 1 and W = 1 and play again: five stale reads, marked in red.', 'Try R = 2, W = 2 (2 + 2 ≤ 5): fewer stale reads, but still some. Then R = 2, W = 3: none.', 'With **Read repair** on, a reader that sees an old version at some replica sends it the newest one, so replicas catch up faster.'] },
      { h: 'Partitions and the CAP theorem' },
      'A **network partition** splits the nodes into groups that cannot talk to each other. The **CAP theorem** says that during a partition, a replicated system cannot be both **consistent** (every read sees the latest write, as if there were one copy) and **available** (every request to a live node gets an answer). It must give up one of them until the partition heals.',
      { view: 'cluster', sel: { scenario: 'cap' }, label: 'Open the cluster view (choose CAP: a partition in the Scenario menu)' },
      { steps: ['Choose **CAP: a partition** in **CP** mode and play. At t = 50 the network splits {A, B, c1} from {C, c2}. The primary A is on the majority side.', 'c1 writes x = left: fine. c2, cut off with C, tries to write x = right: refused (timeout). Its read is refused too. One value, but c2 got no service: consistent, not available.', 'Switch to **AP**, reconcile by **last writer wins**. Both writes are accepted; during the split c1 reads left and c2 reads right. After the heal everyone holds right, and c1\'s write is silently lost.', 'Reconcile by **version vectors** instead: after the heal the replicas keep both values as siblings, {left, right}, and the application must merge them.'] },
      { tip: 'Choosing AP means accepting **eventual consistency**: the replicas agree once the network heals and the conflicts are resolved. Many systems let you choose per request, by picking R and W.' },
    ],
  });

  // ---- exercises ------------------------------------------------------------------------------------------------------
  C.exercise({
    id: 'ex21-hash-sizes', chapter: 21, title: 'Rows per node under hash partitioning', level: 1,
    text: ['Suppose `artist` is hash partitioned on `person_id` over 3 nodes, a row going to node `get_byte(decode(md5(person_id), \'hex\'), 0) % 3`. Write a query that returns each node number and the number of artists stored there, ordered by node.'],
    hints: ['Compute the node number as an expression on each row.', 'Group by that expression, and count.', "select get_byte(decode(md5(person_id), 'hex'), 0) % 3 as node, count(*) as rows from artist group by 1 order by 1;"],
    ref: "select get_byte(decode(md5(person_id), 'hex'), 0) % 3 as node, count(*) as rows\nfrom artist\ngroup by 1\norder by 1;",
  });
  C.exercise({
    id: 'ex21-skew-ratio', chapter: 21, title: 'How much longer?', level: 1, kind: 'answer',
    text: ['`booking` is hash partitioned on patron_id over 4 nodes, which hold 413, 174, 259 and 254 rows. A parallel scan takes as long as its largest partition. How many times as long as a perfectly balanced scan does it take? Type the ratio max / mean, to two decimal places.'],
    hints: ['The mean is the total divided by 4.', 'The total is 1,100, so the mean is 275.', '1.50: the largest partition, 413, divided by the mean 275, is about 1.502, so the scan runs about 50% longer.'],
    solution: '1.50', alts: ['1.5', '1.502'], wrongs: ['2.37', '0.67'], ref: '413 / 275 = 1.50',
    check: kit.number(1.502, 0.011),
  });
  C.exercise({
    id: 'ex21-mod-move', chapter: 21, title: 'Adding a node under mod-n hashing', level: 2, kind: 'answer',
    text: ['Ten keys, 11 to 20, are placed on 4 nodes by k mod 4. A fifth node joins, and placement becomes k mod 5. How many of the ten keys are now on a different node? (Number the nodes 0 to 3, then 0 to 4.) Type the number.'],
    hints: ['For each key compare k mod 4 with k mod 5.', 'For 11: 3 and 1, it moves. For 20: 0 and 0, it stays.', '9: only 20 keeps its node; every other key gets a new remainder.'],
    solution: '9', wrongs: ['2', '8'], ref: '9 (only key 20 stays)',
    check: kit.number(9),
  });
  C.exercise({
    id: 'ex21-ring', chapter: 21, title: 'A key changes hands on the ring', level: 2, kind: 'answer',
    text: ['A consistent-hashing ring runs from 0 to 99 and wraps round. Node points are at 10 (n1), 40 (n2) and 70 (n3); a key belongs to the first point at or after its position, wrapping from 99 to 0. Keys sit at positions 5, 38, 41, 69 and 95. A new node n4 joins with its point at 55. Which keys move? Type their positions, separated by spaces.'],
    hints: ['Find each key\'s owner before: 5 goes to 10, 95 wraps round to 10.', 'n4 at 55 takes over the arc from 41 to 55, which n3 owned before.', '41: it was n3\'s and is now n4\'s; 69 stays with n3, and the others are on arcs n4 does not touch.'],
    solution: '41', wrongs: ['41 69', '38 41'], ref: '41',
    check: kit.numSet([41]),
  });
  C.exercise({
    id: 'ex21-quorum-choices', chapter: 21, title: 'Which quorums are safe?', level: 2, kind: 'answer',
    text: ['An item has N = 5 replicas. For each choice of (R, W), say whether every read is guaranteed to see the last completed write: (1, 5), (2, 3), (2, 2), (4, 1), (3, 2). Answer yes or no five times, in that order.'],
    hints: ['The rule is R + W > N.', 'Add them up: 6, 5, 4, 5, 5.', 'yes no no no no: only (1, 5) gives a sum above 5; the others sum to 5 or less, so a read quorum can miss the write quorum.'],
    solution: 'yes no no no no', wrongs: ['yes yes no yes yes', 'yes yes no no no'], ref: 'yes no no no no',
    check: kit.yesNoList([true, false, false, false, false]),
  });
  C.exercise({
    id: 'ex21-quorum-min', chapter: 21, title: 'The smallest read quorum', level: 1, kind: 'answer',
    text: ['N = 7 replicas, and a write is confirmed by W = 4 of them. What is the smallest R that guarantees a read sees every completed write? Type the number.'],
    hints: ['You need R + W > N.', 'R + 4 > 7.', '4: R = 4 gives 8 > 7; with R = 3 the three readers could be exactly the three replicas the write did not reach.'],
    solution: '4', wrongs: ['3', '7'], ref: '4',
    check: kit.number(4),
  });
})(typeof window !== 'undefined' ? window : globalThis);
