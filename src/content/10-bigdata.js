// Chapter 10: big data. Storage for big data (key-value and document stores, sharding), the MapReduce paradigm,
// algebraic operations in dataflow systems such as Spark, streaming data with windows, and graph data with
// recursive queries. Key-value stores and streams are modelled with ordinary tables; the cluster views show the
// distributed side. Exercises on graphs, streams and sharding, checked on the Theatre database.
(function (root) {
  'use strict';
  const C = root.K.Content;
  // the right answer of each prediction is listed first in the source; rotate the options by a hash of the
  // question so that it lands in a different place from one question to the next
  const mix = (l) => {
    for (const b of l.body || []) {
      if (!b || !b.predict) continue;
      const p = b.predict, n = p.options.length;
      let k = 0;
      for (const ch of p.q) k = (k * 31 + ch.charCodeAt(0)) >>> 0;
      k %= n;
      const right = p.options[p.answer];
      p.options = p.options.slice(k).concat(p.options.slice(0, k));
      p.answer = p.options.indexOf(right);
    }
    return l;
  };
  const lesson = (l) => C.lesson(mix(l));

  // ---- 10.1-10.2 storing big data ---------------------------------------------------------------------------------------
  lesson({
    id: 'big-storage', chapter: 10, title: 'Storing big data: key-value stores, documents and sharding', minutes: 13,
    summary: 'When data outgrows one machine it is split across many. Key-value and document stores offer a narrow interface that is easy to spread out; sharding decides which machine holds which key.',
    body: [
      'Web-scale applications brought data that is too big (**volume**), arrives too fast (**velocity**) and is too varied in shape (**variety**) for one database server. The answer is to spread it over many cheap machines. Files go into a **distributed file system** such as HDFS, which splits each file into large blocks and keeps copies of each block on several machines. Records go into **key-value stores** and **document stores**.',
      { h: 'A key-value store' },
      'A key-value store offers almost nothing but three operations: `put(key, value)`, `get(key)` and `delete(key)`. The value is opaque to the store, or in a **document store** a JSON document it can look inside. That narrow interface is what makes them easy to spread over thousands of machines. As a table:',
      { sql: "drop table if exists kv;\ncreate table kv (key text primary key, value jsonb);\n-- put: insert, or replace the value if the key exists\ninsert into kv values ('user:17', '{\"name\": \"Lina\", \"cart\": [\"mug\"]}')\n  on conflict (key) do update set value = excluded.value;\ninsert into kv values ('user:42', '{\"name\": \"Omar\", \"cart\": []}')\n  on conflict (key) do update set value = excluded.value;\ninsert into kv values ('user:17', '{\"name\": \"Lina\", \"cart\": [\"mug\", \"hoodie\"]}')\n  on conflict (key) do update set value = excluded.value;\n-- get\nselect value from kv where key = 'user:17';" },
      { predict: { q: 'How would you find every user with a hoodie in their cart, in a pure key-value store?', options: ['You cannot ask the store; you would have to get every key and look inside each value yourself', 'With a query on the value', 'With a secondary index the store keeps automatically'], answer: 0, explain: 'A pure key-value store can only look things up by key. Document stores add queries on fields and secondary indexes, which is why most systems today are somewhere in between. In SQL it is one line, because the database can see inside the value.' }, sql: "select key from kv where value -> 'cart' ? 'hoodie';" },
      'What these stores give up is as important as what they offer: usually no joins, no transactions across keys (or only limited ones), and often weaker consistency between replicas. They were called **NoSQL** for a while; many have since grown SQL-like query languages, and relational systems have grown JSON columns, so the line has blurred.',
      { h: 'Sharding' },
      'Splitting data across machines by key is called **partitioning** or **sharding**. With **hash partitioning**, a key goes to shard hash(key) mod n; with **range partitioning**, each shard holds a range of keys. Hash spreads keys evenly; ranges keep neighbouring keys together, which makes range scans cheap and also makes hot spots possible. Hash the patron ids into four shards:',
      { sql: "select (strpos('0123456789abcdef', left(md5(patron_id::text), 1)) - 1) % 4 as shard,\n       count(*) as patrons\nfrom patron\ngroup by shard\norder by shard;", note: 'The first hex digit of the MD5 hash, mod 4. Roughly even, never exactly.' },
      'Adding a machine is where plain mod-n hashing hurts. Count how many patrons would move if the cluster grew from four shards to five, with shard = patron_id mod n:',
      { sql: 'select count(*) filter (where patron_id % 4 <> patron_id % 5) as moved,\n       count(*) as patrons\nfrom patron;', note: 'Most keys move. **Consistent hashing** and systems that split and move individual key ranges (tablets) avoid that, moving only about a fifth of the data.' },
      { view: 'cluster', label: 'Watch a table being partitioned across nodes in the Cluster view' },
      { tip: 'In the Cluster view, pick the **Partitioning a table** scenario. Switch between hash and range partitioning, then add a node and watch which rows move. Chapter 21 covers partitioning and replication in detail.' },
      { sql: 'drop table kv;' },
    ],
  });

  // ---- 10.3 MapReduce --------------------------------------------------------------------------------------------------------
  const MAP_OUT = "drop table if exists map_out;\ncreate table map_out as\n  select c.split, word, 1 as one\n  from (select prod_id, title, ntile(4) over (order by prod_id) as split from production) as c,\n       regexp_split_to_table(lower(c.title), '[^a-z]+') as word\n  where word <> '';";
  lesson({
    id: 'big-mapreduce', chapter: 10, title: 'The MapReduce paradigm', minutes: 14,
    summary: 'A map function turns each input record into key-value pairs; the system groups the pairs by key across machines; a reduce function turns each group into a result. Run it on simulated workers, and in SQL.',
    body: [
      '**MapReduce** lets a programmer process a huge file on thousands of machines by writing two small functions, while the system handles distribution, the movement of data and failures.',
      { steps: [
        '**map(record)** is called on each input record and emits zero or more (key, value) pairs.',
        'The system **shuffles**: it sends every pair with the same key to the same machine and sorts them by key.',
        '**reduce(key, values)** is called once per key with all the values emitted for it, and produces the output.',
      ] },
      'The classic example counts words. map(line) emits (word, 1) for each word of the line; reduce(word, ones) emits (word, the number of ones). Over the production titles, the map phase in SQL is a table of pairs. The input is cut into four **splits**, one per map task:',
      { sql: MAP_OUT + "\nselect split, word, one from map_out order by split, word limit 10;" },
      'The reduce phase is a group by on the key:',
      { sql: 'select word, sum(one) as count\nfrom map_out\ngroup by word\norder by count desc, word\nlimit 8;' },
      'Every pair crosses the network in the shuffle, unless a **combiner** (a reduce run early, on each map task\'s own output) first adds up the pairs with the same key from the same split.',
      { predict: { q: 'The map phase emits 198 pairs for 120 different words. With a combiner, how many pairs cross the network?', options: ['One per distinct (split, word): between 120 and 198', 'Exactly 120, one per word', '4, one per split', 'Still 198'], answer: 0, explain: 'The combiner can only merge pairs that the same map task produced. A word that appears in two splits still sends one pair from each. With longer documents, where words repeat within a split, the saving is much larger.' }, sql: 'select count(*) as pairs_emitted,\n       count(distinct word) as distinct_words,\n       count(distinct (split, word)) as pairs_after_combiner\nfrom map_out;' },
      { h: 'On a cluster' },
      'The MapReduce view runs these jobs on simulated workers: a master assigns map tasks to idle workers, each map task writes its output partitioned by hash(key) mod R on the worker\'s local disk, and each of the R reduce tasks fetches its partition from every map task.',
      { view: 'mapreduce', label: 'Open the MapReduce view' },
      { steps: [
        'Choose the word-count job and play it. Watch the shuffle matrix fill: row = map task, column = reduce task.',
        'Untick **Combiner** and compare the counters: records shuffled goes up.',
        'Set **Failure** to *w1 crashes during the map phase*. The master notices the missing heartbeats and runs w1\'s map tasks again elsewhere, including ones that had finished, because their output was on w1\'s disk.',
        'Try the join job: a reduce-side join, where map tags each record with its table and reduce pairs the two sides for each key.',
      ] },
      'The same group by on a table in a parallel database does the same thing: partition by the grouping key, aggregate locally first (the combiner), then combine. MapReduce made that pattern available for arbitrary code over arbitrary files.',
      { sql: 'drop table map_out;' },
    ],
  });

  // ---- 10.4 algebraic operations ---------------------------------------------------------------------------------------------
  lesson({
    id: 'big-dataflow', chapter: 10, title: 'Beyond MapReduce: algebraic operations in dataflow systems', minutes: 12,
    summary: 'Systems such as Spark describe a job as a graph of operators on distributed collections: select, project, join, group, much like the relational algebra. Lazy evaluation and lineage let them plan the whole job and recover from failures.',
    body: [
      'Real jobs are rarely one map and one reduce. Chained MapReduce jobs write every intermediate result to the distributed file system and read it back, which is slow and tedious to program. **Dataflow** systems such as Apache Spark offer a library of operators on distributed collections (Spark calls them RDDs, and with a schema, DataFrames) and let a job be any graph of them.',
      { table: [['Dataflow operator', 'Relational algebra', 'SQL'], ['filter', 'selection σ', 'where'], ['map, select', 'projection Π (and computed attributes)', 'select list'], ['flatMap', 'no direct equivalent', 'a set-returning function, lateral'], ['join', 'join ⋈', 'join'], ['reduceByKey, groupBy, agg', 'aggregation γ', 'group by'], ['union, distinct', '∪, duplicate elimination', 'union, distinct']] },
      'So a Spark program like `artists.filter(fee > 1000).join(companies, "company_id").groupBy("city").count()` is a query plan written by hand. Here is the same thing in SQL, and the plan the database chose for it:',
      { sql: "select c.city, count(*) as well_paid\nfrom artist a join company c on c.company_id = a.company_id\nwhere a.fee > 1000\ngroup by c.city\norder by c.city;" },
      { sql: "explain\nselect c.city, count(*) as well_paid\nfrom artist a join company c on c.company_id = a.company_id\nwhere a.fee > 1000\ngroup by c.city;", note: 'A tree of operators: scans feeding a filter, a join, an aggregate. A dataflow graph is the same idea spread over a cluster.' },
      { h: 'Lazy evaluation and lineage' },
      'Spark operators do not run when they are called. They build up the graph, the job\'s **lineage**, and only an action that needs a result (count, collect, save) runs it. Knowing the whole graph lets the system plan it: operators that work partition by partition (filter, map) are **narrow** and are pipelined together in one **stage**; operators that need data from every partition (a join, reduceByKey) are **wide**, and a shuffle separates the stages.',
      { predict: { q: 'In the job filter → join → groupBy → count, where do new stages begin?', options: ['At the join and at the groupBy: both need a shuffle', 'At every operator', 'Only at count', 'Nowhere: it is one stage'], answer: 0, explain: 'filter is narrow and runs in the stage that reads the data. The join must bring matching keys together, and groupBy must bring each group together: each is a shuffle, so each starts a stage.' } },
      'Lineage is also how Spark survives failures. Instead of copying every intermediate result to other machines, it remembers how each partition was computed, and recomputes just the lost partitions from their parents when a worker dies.',
      { view: 'mapreduce', label: 'See the lineage graph in the MapReduce view' },
      { steps: ['In the MapReduce view, choose a job that groups the rows of a table by a key.', 'Scroll to **The same job as a Spark lineage graph**: each box is an RDD with its partitions, grey lines are narrow dependencies and coloured lines are shuffles.', 'Press **Lose worker w2 and run again**. Only the partitions w2 held are recomputed, and the result is the same.'] },
      'Because the operators are algebraic, systems such as Spark SQL and Hive let you skip the hand-written plan and write SQL; their optimizers produce the dataflow graph, just as a database produces its plan. Analysts tend to write SQL; engineers reach for the operator API when a step needs arbitrary code.',
    ],
  });

  // ---- 10.5 streaming data -----------------------------------------------------------------------------------------------------
  const READINGS = "drop table if exists reading;\ncreate table reading as\n  select timestamp '2026-03-02 08:00' + g * interval '1 minute' + ((g * 7) % 3) * interval '10 seconds' as at,\n         case when g % 2 = 0 then 'north' else 'south' end as sensor,\n         round((18 + 4 * sin(g / 9.0) + ((g * 13) % 5) / 5.0)::numeric, 1) as temp\n  from generate_series(0, 59) as g\n  where g not between 31 and 39;   -- the sensors were off for a while";
  lesson({
    id: 'big-streaming', chapter: 10, title: 'Streaming data and windows', minutes: 14,
    summary: 'A stream never ends, so a query over it must look at a window of recent data. Tumbling, sliding and session windows over a stream of sensor readings, written with SQL\'s grouping and window functions.',
    body: [
      'Some data arrives continuously: readings from sensors, clicks on a web site, trades on an exchange. A **data stream** is an unbounded sequence of such records, and a query over it runs **continuously**, producing results as data arrives. Since the stream never ends, an aggregate like an average only makes sense over a **window**: a finite slice of the stream.',
      'Two temperature sensors report about once a minute. A stored table stands in for the stream here; a streaming system would compute the same results as the records came in:',
      { sql: READINGS + "\nselect * from reading order by at limit 6;" },
      { h: 'Tumbling windows' },
      '**Tumbling** windows cut time into fixed, non-overlapping intervals: 08:00 to 08:15, 08:15 to 08:30, and so on. Every record belongs to exactly one window. `date_bin` puts each timestamp into its interval:',
      { predict: { q: 'The readings run from 08:00 to 09:00, with nothing between about 08:31 and 08:40. How many 15-minute tumbling windows contain readings?', options: ['4, one of them with far fewer readings', '3: the gap removes a window', '60'], answer: 0, explain: 'The gap falls inside the window from 08:30 to 08:45, which still has the readings at its edges. A window only disappears if no record at all falls into it.' }, sql: "select date_bin(interval '15 minutes', at, timestamp '2026-03-02') as window_start,\n       count(*) as readings,\n       round(avg(temp), 2) as avg_temp\nfrom reading\ngroup by window_start\norder by window_start;" },
      { h: 'Sliding windows' },
      'A **sliding** (or hopping) window moves with each record: the average of the last five minutes, recomputed for every reading. That is a window function with a frame defined by time:',
      { sql: "select at, sensor, temp,\n       round(avg(temp) over (order by at range between interval '5 minutes' preceding and current row), 2) as avg_last_5_min,\n       round(avg(temp) over (partition by sensor order by at rows between 2 preceding and current row), 2) as avg_last_3_of_sensor\nfrom reading\norder by at\nlimit 10;", note: 'The first frame is defined by time (range), the second by a count of rows, per sensor.' },
      { h: 'Session windows' },
      'A **session** window groups records separated by short gaps, and closes after a long silence. They suit user activity: a visit to a web site ends when the user has been idle for half an hour. Mark each record that follows a gap of more than three minutes, and number the sessions with a running sum:',
      { sql: "with marked as (\n  select at, temp,\n         case when at - lag(at) over (order by at) > interval '3 minutes' then 1 else 0 end as starts_new\n  from reading\n), numbered as (\n  select at, temp, sum(starts_new) over (order by at) as session\n  from marked\n)\nselect session, min(at) as began, max(at) as ended, count(*) as readings\nfrom numbered\ngroup by session\norder by session;" },
      { h: 'What a streaming system adds' },
      { list: ['**Event time and processing time**: a reading taken at 08:14 may arrive at 08:16. Windows should follow event time, so the system has to wait for late records, up to a limit called a **watermark**, before closing a window.', '**State**: a running aggregate keeps only what it needs (a sum and a count), not the whole stream.', '**Publish-subscribe** systems such as Kafka store streams durably, split into partitions, and let many consumers read them at their own pace.', '**Approximation**: some questions (distinct visitors, top items) are answered with small sketches when exact answers would need too much memory.'] },
      { sql: 'drop table reading;' },
    ],
  });

  // ---- 10.6 graph data ---------------------------------------------------------------------------------------------------------
  const FOLLOWS = "drop table if exists follows;\ncreate table follows (src text, dst text, primary key (src, dst));\ninsert into follows values\n  ('ana', 'ben'), ('ben', 'cai'), ('cai', 'ana'), ('cai', 'dev'),\n  ('dev', 'eli'), ('eli', 'dev'), ('fay', 'ana');";
  lesson({
    id: 'big-graph', chapter: 10, title: 'Graph data and path queries', minutes: 14,
    summary: 'A graph is vertices and edges, and relations store it well: one table of edges. Recursive queries follow paths of any length, with care for cycles. Graph databases and vertex-centric systems build on the same ideas.',
    body: [
      'Many data sets are networks: people following people, web pages linking to pages, roads joining towns, artists mentoring artists. A **graph** has **vertices** (nodes) and **edges** between them. In a relational database, the edges are a table with a source and a destination column.',
      'The Theatre data already has a graph: `mentor` is an edge from each mentor to each artist they mentor. Who taught the artist P1053, directly or through a chain of mentors?',
      { sql: "with recursive taught_by(person_id, depth) as (\n  select mentor_id, 1 from mentor where mentee_id = 'P1053'\n  union all\n  select m.mentor_id, t.depth + 1\n  from mentor m join taught_by t on m.mentee_id = t.person_id\n)\nselect t.person_id, p.family_name, min(t.depth) as shortest_chain\nfrom taught_by t join person p on p.person_id = t.person_id\ngroup by t.person_id, p.family_name\norder by shortest_chain, t.person_id;", note: 'The recursive part follows one more edge each round. min(depth) is the length of the shortest path.' },
      { h: 'Cycles' },
      'Mentoring never goes round in a circle: nobody is their own teacher\'s teacher. Social graphs do. A small follows graph, with two cycles:',
      { sql: FOLLOWS + "\nselect src, count(*) as following from follows group by src order by src;" },
      { predict: { q: 'The recursive query above uses union all. Run in the same style from ana over follows, what happens?', options: ['It never stops: ana → ben → cai → ana → ... produces new rows forever, each with a larger depth', 'It stops after visiting each person once', 'It returns no rows'], answer: 0, explain: 'Each round produces rows that differ from the earlier ones only in depth, so the recursion never runs dry. Kwery would stop it at its recursion limit with an error. Two cures follow.' } },
      'One cure is plain `union` without the depth: a row already found is not added again, so the recursion stops once nothing new is reachable. That answers reachability:',
      { sql: "with recursive reach(person) as (\n  select 'ana'::text\n  union\n  select f.dst from reach r join follows f on f.src = r.person\n)\nselect person from reach order by person;" },
      'To keep the path length, carry the path itself in an array and refuse to step onto a vertex already on it:',
      { sql: "with recursive walk(person, hops, path) as (\n  select dst, 1, ARRAY['ana', dst] from follows where src = 'ana'\n  union all\n  select f.dst, w.hops + 1, w.path || f.dst\n  from walk w join follows f on f.src = w.person\n  where not f.dst = any(w.path)\n)\nselect person, min(hops) as distance, (array_agg(array_to_string(path, ' → ') order by hops))[1] as a_shortest_path\nfrom walk\ngroup by person\norder by distance, person;" },
      { h: 'Ranking vertices' },
      '**PageRank** scores a vertex highly when highly scored vertices point to it. It is computed by iteration: every vertex starts with the same rank, and in each round passes its rank, split evenly, along its outgoing edges (with a small share given to everyone). One round in SQL:',
      { sql: "drop table if exists rank_now;\ncreate table rank_now as\n  select v, 1.0 / 6 as rank from (select src as v from follows union select dst from follows) as vs;\nupdate rank_now set rank = n.rank\nfrom (select x.v, 0.15 / 6 + 0.85 * coalesce(sum(p.rank / o.outdeg), 0) as rank\n      from rank_now x\n        left join follows f on f.dst = x.v\n        left join rank_now p on p.v = f.src\n        left join (select src, count(*) as outdeg from follows group by src) o on o.src = f.src\n      group by x.v) as n\nwhere rank_now.v = n.v;\nselect v, round(rank, 3) as rank from rank_now order by rank desc, v;", note: 'Run it a few more times (only the update and the select) and watch the ranks settle. Nobody follows fay, so her rank sinks to the minimum.' },
      { h: 'Graph systems' },
      '**Graph databases** such as Neo4j store edges next to their vertices and offer query languages built around patterns, for example Cypher\'s `(a)-[:FOLLOWS*1..3]->(b)`. For analytics over huge graphs, **vertex-centric** systems in the style of Google\'s Pregel run supersteps: every vertex reads messages from its neighbours, updates its value and sends new messages, exactly the rounds of the PageRank query above, spread over a cluster.',
      { sql: 'drop table rank_now, follows;' },
    ],
  });

  // ---- exercises -------------------------------------------------------------------------------------------------------------
  const ex = (x) => C.exercise(Object.assign({ chapter: 10, db: 'theatre' }, x));
  const STREAM = "with reading(at, sensor, temp) as (\n  select timestamp '2026-03-02 08:00' + g * interval '1 minute',\n         case when g % 3 = 0 then 'east' else 'west' end,\n         20 + (g * 7) % 11 - 5\n  from generate_series(0, 89) as g\n  where g % 17 <> 5\n)";

  ex({ id: 'big-x-reach', level: 2, title: 'Every source, however indirect',
    text: ['A production can be based on another production (the column based_on), which can itself be based on another. Return the prod_id of every production that PR156 is based on, directly or through a chain, each once.'],
    ref: "with recursive src(prod_id) as (\n  select based_on from production where prod_id = 'PR156' and based_on is not null\n  union\n  select p.based_on from production p join src s on p.prod_id = s.prod_id where p.based_on is not null\n)\nselect prod_id from src",
    wrongs: ["select based_on as prod_id from production where prod_id = 'PR156'"],
    hints: ['A recursive with: the base case is the production PR156 is based on.', 'The recursive step joins production with the productions found so far and takes what they are based on.', 'Stop at productions that are based on nothing (based_on is null).'] });

  ex({ id: 'big-x-distance', level: 3, title: 'Shortest chain of mentors',
    text: ['For the artist P1053, return every artist who taught them, directly or through a chain of mentors, together with the length of the shortest chain of mentor edges from that artist to P1053. A direct mentor has length 1.'],
    ref: "with recursive taught_by(person_id, depth) as (\n  select mentor_id, 1 from mentor where mentee_id = 'P1053'\n  union all\n  select m.mentor_id, t.depth + 1 from mentor m join taught_by t on m.mentee_id = t.person_id\n)\nselect person_id, min(depth) as distance\nfrom taught_by\ngroup by person_id",
    wrongs: ["with recursive taught_by(person_id, depth) as (\n  select mentor_id, 1 from mentor where mentee_id = 'P1053'\n  union all\n  select m.mentor_id, t.depth + 1 from mentor m join taught_by t on m.mentee_id = t.person_id\n)\nselect person_id, max(depth) as distance\nfrom taught_by\ngroup by person_id"],
    hints: ['Carry the depth in the recursion: 1 in the base case, depth + 1 in the recursive step.', 'An artist can be reached along several chains; you want the shortest.', 'Group the result by artist and take min(depth).'] });

  ex({ id: 'big-x-dependents', level: 2, title: 'Following edges the other way',
    text: ['Which artists were mentored by P1055, directly or through someone P1055 mentored? Return their person ids and family names.'],
    ref: "with recursive taught(person_id) as (\n  select mentee_id from mentor where mentor_id = 'P1055'\n  union\n  select m.mentee_id from mentor m join taught t on m.mentor_id = t.person_id\n)\nselect t.person_id, p.family_name\nfrom taught t join person p on p.person_id = t.person_id",
    wrongs: ["select m.mentee_id as person_id, p.family_name from mentor m join person p on p.person_id = m.mentee_id where m.mentor_id = 'P1055'"],
    hints: ['This walks the mentor edges forwards: from a mentor to the artists they taught.', 'Base case: mentor rows whose mentor_id is P1055. Recursive step: rows whose mentor_id is an artist already found.', 'Join the result with person for the family names.'] });

  ex({ id: 'big-x-degree', level: 1, title: 'Vertices with many edges',
    text: ['In the mentor graph, the out-degree of an artist is the number of artists they mentor directly. Return each artist with an out-degree of at least 2, with that degree.'],
    ref: 'select mentor_id, count(*) as out_degree\nfrom mentor\ngroup by mentor_id\nhaving count(*) >= 2',
    wrongs: ['select mentee_id, count(*) as out_degree from mentor group by mentee_id having count(*) >= 2'],
    hints: ['Each row of mentor is one edge from mentor_id to mentee_id.', 'Count the edges per source vertex.', 'Keep the groups with having count(*) >= 2.'] });

  ex({ id: 'big-x-index', level: 2, title: 'An inverted index, MapReduce style',
    text: ['Build what a MapReduce job that indexes production titles would output: map emits (word, prod_id) for each lowercase word of a title (split on anything that is not a letter, ignoring empty strings), and reduce collects the production ids of each word into a sorted array without repeats. Return word and the array.'],
    ref: "select word, array_agg(distinct prod_id order by prod_id) as productions\nfrom production, regexp_split_to_table(lower(title), '[^a-z]+') as word\nwhere word <> ''\ngroup by word",
    ordered: false,
    hints: ['The map side is regexp_split_to_table in the from clause.', 'The reduce side is a group by word.', 'array_agg(distinct prod_id order by prod_id) collects each word\'s productions.'] });

  ex({ id: 'big-x-shards', level: 1, title: 'Counting rows per shard',
    text: ['A cluster stores patrons on four shards by hash partitioning, with shard number `(strpos(\'0123456789abcdef\', left(md5(patron_id::text), 1)) - 1) % 4`. Return each shard number with the number of patrons on it, and the number of those patrons who have more than 200 points.'],
    ref: "select (strpos('0123456789abcdef', left(md5(patron_id::text), 1)) - 1) % 4 as shard,\n       count(*) as patrons,\n       count(*) filter (where points > 200) as over_200\nfrom patron\ngroup by shard",
    wrongs: ["select (strpos('0123456789abcdef', left(md5(patron_id::text), 1)) - 1) % 4 as shard, count(*) as patrons, count(*) filter (where points >= 200) as over_200 from patron group by shard"],
    hints: ['Group by the shard expression.', 'count(*) filter (where ...) counts only the rows that satisfy a condition.', 'Or use sum(case when points > 200 then 1 else 0 end).'] });

  ex({ id: 'big-x-tumbling', level: 2, title: 'Tumbling windows',
    text: ['A stream of readings is given in a `with` clause. Return, for each 20-minute tumbling window starting at 08:00, 08:20, 08:40 and so on, the start of the window, the number of readings and the maximum temperature.', { sql: STREAM + '\nselect * from reading;', run: false }],
    ref: STREAM + "\nselect date_bin(interval '20 minutes', at, timestamp '2026-03-02 08:00') as window_start,\n       count(*) as readings, max(temp) as max_temp\nfrom reading\ngroup by window_start",
    hints: ['Each reading belongs to exactly one window: compute its start and group by it.', "date_bin(interval '20 minutes', at, origin) gives the start of the 20-minute bin containing at.", 'Any origin on a 20-minute boundary works, such as timestamp \'2026-03-02 08:00\'.'] });

  ex({ id: 'big-x-sliding', level: 2, title: 'A sliding average per sensor',
    text: ['With the same stream, return every reading (at, sensor, temp) with the average temperature of the last three readings of the same sensor, including the current one, as a numeric rounded to 2 places. Order the rows by sensor and time.', { sql: STREAM + '\nselect * from reading;', run: false }],
    ref: STREAM + "\nselect at, sensor, temp,\n       round(avg(temp) over (partition by sensor order by at rows between 2 preceding and current row), 2) as avg_last_3\nfrom reading\norder by sensor, at",
    hints: ['A window function with partition by sensor and order by at.', 'The frame rows between 2 preceding and current row holds the last three readings.', 'round(avg(...) over (...), 2)'] });

  ex({ id: 'big-x-sessions', level: 3, ordered: false, title: 'Session windows',
    text: ['With the same stream, readings of the west sensor are grouped into sessions: a new session starts whenever more than 2 minutes have passed since the previous west reading. Return each session\'s first and last reading time and its number of readings.', { sql: STREAM + '\nselect * from reading;', run: false }],
    ref: STREAM + ",\nmarked as (\n  select at, case when at - lag(at) over (order by at) > interval '2 minutes' then 1 else 0 end as starts_new\n  from reading where sensor = 'west'\n),\nnumbered as (\n  select at, sum(starts_new) over (order by at) as session from marked\n)\nselect min(at) as began, max(at) as ended, count(*) as readings\nfrom numbered\ngroup by session",
    hints: ['lag(at) over (order by at) is the time of the previous reading.', 'Mark a reading with 1 when the gap before it is more than 2 minutes; a running sum of the marks numbers the sessions.', 'Group by the session number.'] });
})(typeof window !== 'undefined' ? window : globalThis);
