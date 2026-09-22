// Chapter 22: parallel and distributed query processing. Parallel sort and the parallel join strategies
// (partitioned, broadcast, fragment-and-replicate), exchange operators and how a distributed plan is put together,
// and semijoin reduction between two sites.
(function (root) {
  'use strict';
  const C = root.K.Content;
  const kit = C.kit1726;
  const lesson = kit.lesson;
  const H = (col) => "get_byte(decode(md5(" + col + "), 'hex'), 0)";

  lesson({
    id: 'dq-sort-join', chapter: 22, title: 'Parallel sort and parallel join', minutes: 14,
    summary: 'Sorting by range-partitioning on the sort key, and the three ways to join relations spread over many nodes: partition both on the join key, broadcast the small one, or fragment and replicate.',
    body: [
      'A parallel database runs one query on many nodes at once. The two operations that need the most care are sorting and joining, because both need rows that start on different nodes to meet.',
      { h: 'Range-partitioning sort' },
      'To sort a relation spread over n nodes: choose n - 1 boundary values of the sort key, send every row to the node that owns its range, and let each node sort its own rows. Reading node 1, then node 2, and so on gives the whole relation in order, with no merge step.',
      'Good boundaries split the rows evenly. A node can find them from a **sample** of the key values, taking the quartiles for four nodes:',
      { sql: 'select percentile_disc(array[0.25, 0.5, 0.75]) within group (order by perf_id) as boundaries\nfrom booking;' },
      { sql: "with b as (select percentile_disc(array[0.25, 0.5, 0.75]) within group (order by perf_id) as v from booking)\nselect case when perf_id <= v[1] then 1\n            when perf_id <= v[2] then 2\n            when perf_id <= v[3] then 3\n            else 4 end as node,\n       count(*) as rows, min(perf_id) as first_key, max(perf_id) as last_key\nfrom booking, b\ngroup by 1 order by 1;", note: 'Each node gets about a quarter of the rows, and every key on node 1 is below every key on node 2.' },
      'The alternative is **parallel external sort-merge**: each node sorts the rows it already has, and the sorted runs are merged, by one node or by several in a range-partitioned way.',
      { h: 'Partitioned join' },
      'An equi-join r ⋈ s on r.A = s.B can be split by hashing both relations on the join attribute with the same function. Matching rows then have equal keys, so equal hashes, so they land on the same node: each node joins its own part of r with its own part of s, and the results together are the whole join.',
      { sql: 'select ' + H('a.company_id') + ' % 4 as node, count(*) as matches\nfrom artist a join company c on a.company_id = c.company_id\ngroup by 1 order by 1;', note: 'Hashing both sides on company_id: the matching pairs (one per artist with a company) are found on the four nodes separately, with no node needing another\'s rows.' },
      'Look at the counts: they are far from equal. With only 12 companies, a few hash values carry many artists. That is skew in the join, and the fullest node finishes last.',
      { h: 'Broadcast and fragment-and-replicate' },
      'If one relation is small, there is a cheaper way: leave the big one where it is and send a full copy of the small one to every node. Each node joins its part of the big relation with the whole small one. This **broadcast join** (asymmetric fragment-and-replicate) also works for any join condition, not just equality.',
      { predict: { q: 'company has 12 rows, artist has 45. In a broadcast join of the two, which one should be broadcast?', options: ['company, the smaller', 'artist, the larger', 'Both'], answer: 0, explain: 'Broadcasting copies a relation n - 1 times. Copying 12 rows to every node costs far less than copying 45, and the 45 can stay where they are.' } },
      '**Fragment-and-replicate** in general splits r into m fragments and s into k fragments, and uses m × k nodes arranged in a grid: node (i, j) joins fragment i of r with fragment j of s. Each fragment of r goes to k nodes and each fragment of s to m nodes. It is the most general method and ships the most data.',
      { view: 'dquery', label: 'Open the distributed query view' },
      { steps: ['In **Distributed query**, choose the Example **Join, repartitioned**, 4 nodes, placement **Mixed**, and press **Run on the cluster**. The plan badge says *join: repartition*; the stages show the exchange that sends rows to the node that owns their join key.', 'Press **Compare strategies**. Every strategy returns the same rows; compare the bytes each ships: the repartition join ships the least, fragment-and-replicate the most.', 'Choose **Join without an equality** and run it. No hashing can bring matching rows together for an inequality, so the planner broadcasts.', 'Choose **Parallel sort** and run: a sample stage, a range exchange, then a sort on each node.'] },
    ],
  });

  lesson({
    id: 'dq-exchange', chapter: 22, title: 'Exchange operators and distributed plans', minutes: 12,
    summary: 'An exchange operator is where rows change nodes. A distributed plan is an ordinary plan cut into fragments at its exchanges; aggregation splits into a local and a global part.',
    body: [
      'A parallel plan looks much like the plans of chapter 16, with one new kind of operator. An **exchange** operator takes the rows produced on each node and sends each row where the next operator needs it. Everything between two exchanges runs on each node independently, on local data.',
      { table: [['Exchange', 'Where each row goes', 'Used for'], ['hash repartition', 'node h(key) mod n', 'partitioned joins, grouping'], ['range repartition', 'the node owning its key range', 'parallel sort'], ['broadcast', 'every node', 'broadcast joins'], ['gather (merge)', 'one node', 'the final result, a top-k']] },
      'Because exchanges hide the data movement, the operators between them need not know they are part of a parallel plan. An exchange can also merge sorted inputs so that order is kept.',
      { h: 'Aggregation in two phases' },
      'Grouping looks like it needs every row of a group on one node. For many aggregates it does not. Each node first computes a **partial aggregate** of its own rows, a few numbers per group; only those cross the network, and one node combines them. Here artists are hash partitioned on person_id over 3 nodes; the partial sums and counts of their fees per node and company are:',
      { sql: 'select ' + H('person_id') + ' % 3 as node, company_id,\n       sum(fee) as partial_sum, count(fee) as partial_count\nfrom artist\nwhere company_id is not null\ngroup by 1, 2\norder by company_id, node;' },
      'And the combining step turns them into averages:',
      { sql: 'select company_id, round(sum(partial_sum) / sum(partial_count), 2) as avg_fee\nfrom (select ' + H('person_id') + ' % 3 as node, company_id,\n             sum(fee) as partial_sum, count(fee) as partial_count\n      from artist where company_id is not null group by 1, 2) p\ngroup by company_id\norder by company_id;' },
      { predict: { q: 'Could each node send its local average instead of a sum and a count, and the final step average those averages?', options: ['No: an average of averages weighs a node with one artist like a node with ten', 'Yes, it gives the same answer', 'Only if the nodes have the same number of rows overall'], answer: 0, explain: 'Sum, count, min and max combine directly; an average must travel as a sum and a count. When one node holds three artists of a company and another holds one, averaging their two averages counts the single artist three times too much.' } },
      'Some aggregates cannot be split at all. `count(distinct patron_id)` per performance needs to see every patron of a performance together, so the rows themselves must be repartitioned on the group key first.',
      { view: 'dquery', label: 'Open the distributed query view' },
      { steps: ['Choose the Example **Aggregation** and run it. The stages are: scan, partial aggregation on each node, a hash exchange of the partial groups, the final aggregation, then a range-partitioned sort. Press **Compare strategies**: two-phase aggregation ships fewer bytes than repartitioning the raw rows.', 'Choose **Aggregate that cannot be split**: there is no partial aggregation stage; the rows themselves are repartitioned on the group key, and the bytes shipped jump.', 'Choose **Join, co-located**: both tables are hashed on the join key, so the join needs no exchange at all. Compare strategies: the co-located plan ships a small fraction of what a broadcast would.', 'Open **Where the tables are** to see which tables are hashed on which key, and which small tables are replicated on every node.'] },
      { tip: 'Choosing where to put data is part of query optimization in a parallel database. Partitioning two tables that are often joined on the same key, as the co-located example does, turns their joins into local work.' },
    ],
  });

  lesson({
    id: 'dq-semijoin', chapter: 22, title: 'Semijoin reduction', minutes: 11,
    summary: 'When two relations live at different sites, ship the join column first, and send back only the rows that will find a partner.',
    body: [
      'In a distributed database the cost that matters most is often the data sent between sites. Suppose `booking` is stored at site S1 and `performance` at site S2, and S2 wants the bookings of performances at the Harbour Rooms: booking ⋈ σ venue_code = HAR (performance).',
      'Shipping all of booking to S2 is the obvious plan. Measure how much that is, using the length of each row\'s text as its size:',
      { sql: 'select count(*) as rows, sum(octet_length(b::text)) as bytes\nfrom booking b;' },
      'Most of those rows are of no use to S2. A **semijoin** r ⋉ s keeps the rows of r that have a partner in s. The **semijoin strategy** is:',
      { steps: ['S2 sends S1 just the join column of the performance rows it needs: the ids of the performances at the Harbour Rooms.', 'S1 computes booking ⋉ those ids and sends back only the matching rows.', 'S2 joins them with its performance rows.'] },
      { sql: "select perf_id from performance where venue_code = 'HAR';", note: 'Step 1: a handful of short values to ship.' },
      { sql: "select count(*) as rows, sum(octet_length(b::text)) as bytes\nfrom booking b\nwhere exists (select 1 from performance p\n              where p.perf_id = b.perf_id and p.venue_code = 'HAR');", note: 'Step 2: the semijoin at S1, written with EXISTS. A few dozen rows instead of 1,100.' },
      { predict: { q: 'Would the semijoin pay off for artist ⋈ company with no condition on company, artist at one site and company at the other?', options: ['Hardly: almost every artist has a company, so the reduction removes nearly nothing', 'Yes, it always ships less', 'It cannot be used there'], answer: 0, explain: 'A semijoin helps when few rows of r find a partner. Here all but the few freelance artists match, so the semijoin sends company\'s column one way and nearly all of artist back: more than just sending artist.' } },
      { view: 'dquery', label: 'Open the distributed query view' },
      { steps: ['Scroll to **Semijoin reduction** at the bottom of the Distributed query view and choose its first example. Three strategies are compared: shipping the small relation to the big one\'s site, shipping the big one to the small one\'s site, and the semijoin. Note how many rows the semijoin removed before anything was sent.', 'Choose the other examples in turn. When the condition on the second relation is selective, the semijoin is cheapest; when nearly every row has a partner, sending the relation whole wins.'] },
      { tip: 'A **Bloom filter** (chapter 24) is a compact stand-in for the column sent in step 1: a few bits per value, at the price of letting through some rows with no partner, which the final join removes.' },
    ],
  });

  // ---- exercises ------------------------------------------------------------------------------------------------------
  C.exercise({
    id: 'ex22-two-phase-avg', chapter: 22, title: 'Two-phase aggregation by hand', level: 2,
    text: ['Patrons are hash partitioned on `patron_id` over 4 nodes: a row is on node `get_byte(decode(md5(patron_id::text), \'hex\'), 0) % 4`. Compute the average `points` per city the way a parallel plan would: first a partial sum and count per node and city, then combine them. Return `city` and the average rounded to 2 decimals, ordered by `city` (patrons with no city form a group of their own).'],
    hints: ['In a subquery, group by the node expression and city, keeping sum(points) and count(points).', 'In the outer query, group by city and divide the sum of the sums by the sum of the counts. points is an integer: cast the sum to numeric, or the division drops the fraction.', "select city, round(sum(s)::numeric / sum(c), 2) as avg_points from (select get_byte(decode(md5(patron_id::text), 'hex'), 0) % 4 as node, city, sum(points) as s, count(points) as c from patron group by 1, 2) p group by city order by city;"],
    ref: "select city, round(sum(s)::numeric / sum(c), 2) as avg_points\nfrom (select get_byte(decode(md5(patron_id::text), 'hex'), 0) % 4 as node, city,\n             sum(points) as s, count(points) as c\n      from patron\n      group by 1, 2) p\ngroup by city\norder by city;",
  });
  C.exercise({
    id: 'ex22-broadcast-rows', chapter: 22, title: 'What a broadcast join ships', level: 1, kind: 'answer',
    text: ['r has 40,000 rows and s has 400 rows, each spread evenly over 4 nodes. A broadcast join sends every node a full copy of s. How many rows of s cross the network? Type the number.'],
    hints: ['Each node already has its own 100 rows of s.', 'Each node sends its 100 rows to the 3 other nodes.', '1200: 400 rows, each sent to 3 nodes; r does not move at all.'],
    solution: '1200', wrongs: ['1600', '30300'], ref: '400 × 3 = 1200',
    check: kit.number(1200),
  });
  C.exercise({
    id: 'ex22-semijoin-bytes', chapter: 22, title: 'The cost of a semijoin', level: 2, kind: 'answer',
    text: ['r is at site S1: 2,000 rows of 100 bytes. s is at S2, and the result is wanted at S2. The join column of s has 50 distinct values, each 8 bytes, and 150 rows of r have a partner in s. With the semijoin strategy, how many bytes cross the network in all (ignore message headers)? Type the number.'],
    hints: ['Two transfers: the distinct join values from S2 to S1, then the matching r rows from S1 to S2.', '50 × 8 bytes one way, 150 × 100 bytes the other.', '15400: 400 bytes of join values plus 15,000 bytes of matching rows, against 200,000 to ship r whole.'],
    solution: '15400', wrongs: ['15000', '200000'], ref: '50 × 8 + 150 × 100 = 15400',
    check: kit.number(15400),
  });
  C.exercise({
    id: 'ex22-fragment-replicate', chapter: 22, title: 'Fragment and replicate', level: 2, kind: 'answer',
    text: ['A fragment-and-replicate join splits r into 3 fragments and s into 4 fragments, on a grid of 3 × 4 = 12 nodes, where node (i, j) joins fragment i of r with fragment j of s. To how many nodes is each fragment of r sent? Type the number.'],
    hints: ['Fragment i of r must meet every fragment of s.', 'It goes to every node in row i of the grid: (i, 1), (i, 2), ...', '4: one node for each of the 4 fragments of s.'],
    solution: '4', wrongs: ['3', '12'], ref: '4',
    check: kit.number(4),
  });
  C.exercise({
    id: 'ex22-strategy', chapter: 22, title: 'Choosing a join strategy', level: 1, kind: 'answer',
    text: ['artist (45 rows) is hash partitioned on person_id over 4 nodes; company (12 rows) is hash partitioned on company_id. The query pairs each artist with every company whose budget is less than a hundred times the artist\'s fee: `company.budget < artist.fee * 100`. Which strategy can compute it: **repartition** (hash both sides on the join key), **broadcast**, or **co-located**? Type one word.'],
    hints: ['Hashing brings together rows with equal keys. Is this join on equality?', 'For an inequality, any artist may match any company.', 'broadcast: send company to every node and join it with each node\'s artists; no hash partitioning can split an inequality join.'],
    solution: 'broadcast', wrongs: ['repartition', 'co-located'], ref: 'broadcast',
    check: kit.choice(['broadcast'], ['broadcast', 'repartition', 'co-located']),
  });
})(typeof window !== 'undefined' ? window : globalThis);
