// Chapter 20: database-system architectures. Centralized and client-server systems, parallel systems and what their
// processors share, distributed systems, and how speed-up and scale-up are measured and why they fall short.
(function (root) {
  'use strict';
  const K = root.K;
  const C = K.Content;
  const kit = C.kit1726;
  const lesson = kit.lesson;

  lesson({
    id: 'arch-systems', chapter: 20, title: 'From one machine to many', minutes: 12,
    summary: 'Centralized, client-server, parallel and distributed systems, and the four ways a parallel system can share its hardware: memory, disks, nothing, or a mix.',
    body: [
      { h: 'Centralized and client-server' },
      'A **centralized** database system runs on one computer. Today that computer has several cores, so even a "single" server runs many transactions at once; what makes it centralized is that it does not split one query across machines or spread the data over them.',
      'Most centralized systems are used as **servers**: client programs connect over a network, send SQL, and get results back. The server keeps one process (or thread) per connection. Kwery works the same way. Each editor tab is a client with its own server session:',
      { sql: 'select pid, usename, application_name, state\nfrom pg_stat_activity;', note: 'In tab 1. Each row is a connected client.' },
      'Open a second tab with the `+` next to the editor tab and run the same query there. Now there are two sessions, and each sees the other:',
      { sql: 'select pid, application_name, state, query\nfrom pg_stat_activity;', tab: 2, note: 'In tab 2. The session that runs the query is active; the other is idle.' },
      'Inside the server, the work is split among processes that share memory: the buffer pool, the lock table and the log buffer live in shared memory, and every server process uses them. That is why the lock manager can see that one tab waits for another.',
      { h: 'Parallel systems' },
      'A **parallel** database system runs one database on many processors and disks to go faster than any one machine could. The architectures differ in what the processors share.',
      { table: [['Architecture', 'Shares', 'Strength', 'Limit'], ['Shared memory', 'memory and disks', 'communication is a memory write', 'the bus and cache coherence saturate after a few dozen processors'], ['Shared disk', 'disks only', 'a failed node is easy to replace: the data is still reachable', 'the storage network and cross-node locking'], ['Shared nothing', 'nothing but the network', 'scales to thousands of nodes', 'data on another node must be shipped; skew'], ['Hierarchical', 'memory inside a node, nothing between nodes', 'how most large systems are built', 'the costs of both levels']] },
      { view: 'arch', label: 'Open the architectures view' },
      'In the view, pick each architecture with the buttons at the top and read what it shares. Then scroll to **Interconnection networks**: bus, ring, mesh, hypercube, tree and fat tree, with their diameter (the most hops between two processors) and bisection width (how many links must be cut to split the machine in half).',
      { predict: { q: 'With 8 processors, which network has the smallest diameter: a ring, a 2-D mesh or a hypercube?', options: ['The hypercube', 'The ring', 'The mesh'], answer: 0, explain: 'A hypercube of 8 = 2^3 processors joins two processors when their numbers differ in one bit, so any processor is at most 3 hops away. The ring needs up to 4 hops, and so does the mesh. (A bus has diameter 1 or 2, but every message shares one link.)' } },
      { h: 'Distributed systems' },
      'A **distributed** database system spreads the data over sites that may be far apart, often owned by different groups, linked by a wide-area network. The differences from a parallel system are of degree, but they matter: messages are slow and may be lost, sites fail on their own, and sites may want to keep control of their own data (local autonomy). Chapters 21 to 23 deal with storing data over many sites, querying it, and committing transactions that touch several sites.',
      'A small taste of why placement matters: if the rows of `booking` were spread over four nodes by the patron, each node would hold about a quarter of them.',
      { sql: 'select mod(patron_id, 4) as node, count(*) as bookings\nfrom booking\ngroup by 1\norder by 1;', note: 'In tab 1.' },
    ],
  });

  lesson({
    id: 'arch-speedup', chapter: 20, title: 'Speed-up and scale-up', minutes: 12,
    summary: 'Adding processors should make a task faster (speed-up) or let a bigger task finish in the same time (scale-up). Start-up costs, interference and skew keep both below linear.',
    body: [
      'Two measures say how well a parallel system uses more hardware.',
      { def: 'Speed-up.', text: 'The same task on a system N times larger. If it takes T_S on the small system and T_L on the large one, the speed-up is T_S / T_L. It is **linear** when it equals N.' },
      { def: 'Scale-up.', text: 'A task N times larger on a system N times larger. If the small task takes T_S on the small system and the large task T_L on the large system, the scale-up is T_S / T_L. It is **linear** when it equals 1.' },
      'Scale-up comes in two flavors: **batch** scale-up, where one job grows (a bigger table to scan), and **transaction** scale-up, where more users submit more small transactions at the same rate each.',
      { h: 'Why it falls short' },
      { list: ['**Start-up costs**: starting thousands of processes can take longer than the work they do.', '**Interference**: processors wait for what they share, such as the memory bus, the disks or a lock.', '**Skew**: the work is never split exactly evenly, and a parallel step ends when its slowest part ends.'] },
      'Skew is easy to see in real data. Spread the bookings by the company that staged the production, one company per node, and compare the largest share with the average:',
      { sql: "select c.name as company, count(*) as bookings\nfrom booking b\n  join performance p on p.perf_id = b.perf_id\n  join production pr on pr.prod_id = p.prod_id\n  join company c on c.company_id = pr.company_id\ngroup by c.name\norder by bookings desc;" },
      { sql: "select max(n) as largest, round(avg(n), 1) as average, round(max(n) / avg(n), 2) as slowdown\nfrom (select count(*) as n\n      from booking b\n        join performance p on p.perf_id = b.perf_id\n        join production pr on pr.prod_id = p.prod_id\n      group by pr.company_id) per_node;", note: 'The busiest node has this many times the average work: a parallel scan over these nodes is that much slower than a perfect split.' },
      { view: 'arch', label: 'Open the architectures view' },
      'The view plots speed-up and scale-up for each architecture as the processors grow. Use the arrows to change n, and the sliders to make start-up costs and skew larger or smaller.',
      { predict: { q: 'Shared memory reaches its best speed-up at about 15 processors. What happens to its speed-up from 32 to 64 processors?', options: ['It falls: more processors make it slower', 'It keeps growing, more slowly', 'It stays flat'], answer: 0, explain: 'Every processor added makes the others wait longer for the shared bus and keeps more caches coherent. Past the peak, the waiting grows faster than the added work, and the system gets slower in absolute terms. Shared nothing keeps climbing much longer.' } },
      'Below the charts, **Interference at n** simulates processors that compute and then need a shared resource. Raise n: under shared memory and shared disk the shared resource saturates and the waits grow, while under shared nothing each node uses its own disk.',
      { tip: 'A useful rule of thumb (Amdahl\'s law): if a fraction p of a task can run in parallel and the rest cannot, n processors give at most a speed-up of 1 / ((1 − p) + p / n). With p = 0.9 the speed-up can never pass 10, however many processors you add.' },
    ],
  });

  // ---- exercises ----------------------------------------------------------------------------------------------------
  C.exercise({
    id: 'ex20-speedup', chapter: 20, title: 'Measure a speed-up', level: 1, kind: 'answer',
    text: ['A report takes 150 seconds on a 4-node shared-nothing system. On 12 nodes, holding the same data, it takes 60 seconds. What is the speed-up? Type one number (decimals are fine).'],
    hints: ['Speed-up compares the same task on the small and the large system.', 'Speed-up = time on the small system / time on the large system.', 'The answer is 2.5: 150 / 60. Linear would be 3, since the system grew three times.'],
    solution: '2.5', wrongs: ['3', '0.4', '90'],
    ref: '2.5 = 150 / 60. The system is 3 times larger, so linear speed-up would be 3; this one reaches 2.5 / 3, about 83% of linear.',
    check: kit.number(2.5, 0.01),
  });

  C.exercise({
    id: 'ex20-scaleup', chapter: 20, title: 'Measure a scale-up', level: 2, kind: 'answer',
    text: ['Loading 10 million rows takes 40 minutes on 2 nodes. Loading 40 million rows on 8 nodes takes 50 minutes. What is the batch scale-up? Type one number.'],
    hints: ['Scale-up compares a task N times bigger on a system N times bigger. Here N = 4.', 'Scale-up = time of the small task on the small system / time of the large task on the large system.', 'The answer is 0.8: 40 / 50. Linear scale-up would be 1.'],
    solution: '0.8', wrongs: ['1.25', '4', '3.2'],
    ref: '0.8 = 40 / 50. Both the data and the nodes grew four times; linear scale-up would keep the time at 40 minutes, a scale-up of 1.',
    check: kit.number(0.8, 0.01),
  });

  C.exercise({
    id: 'ex20-amdahl', chapter: 20, title: 'The part that will not split', level: 2, kind: 'answer',
    text: ['A query spends 10% of its time in a step that runs on one processor only (gathering and sorting the final answer); the other 90% splits perfectly. What is the best speed-up 9 processors can give? Type one number.'],
    hints: ['On n processors the serial part still takes its full time; the parallel part takes 1/n of its time.', 'Time on 9 processors, as a fraction of the time on one: 0.1 + 0.9 / 9.', 'The answer is 5: 1 / (0.1 + 0.1) = 5, far from the linear 9.'],
    solution: '5', wrongs: ['9', '10', '8.1'],
    ref: '5. On 9 processors the time is 0.1 + 0.9 / 9 = 0.2 of the original, so the speed-up is 1 / 0.2 = 5. However many processors are added, it stays below 1 / 0.1 = 10.',
    check: kit.number(5, 0.01),
  });

  C.exercise({
    id: 'ex20-which-arch', chapter: 20, title: 'Name the architecture', level: 1, kind: 'answer',
    text: ['A cluster has 200 machines. Each has its own processors, memory and disks, and the machines talk only by sending messages over the network. Which architecture is this? Type `shared memory`, `shared disk`, `shared nothing` or `hierarchical`.'],
    hints: ['Ask what two machines have in common besides the network.', 'Each machine owns its memory and its disks.', 'The answer is shared nothing: only the network is shared.'],
    solution: 'shared nothing', wrongs: ['shared disk', 'shared memory'],
    ref: 'shared nothing. No memory or disk is reachable by two machines; data on another machine is reached only through messages. (If each machine had many cores sharing its memory, one could also call it hierarchical; the top level is still shared nothing.)',
    check: (app, answer) => {
      const t = kit.norm(answer).replace(/[-_]+/g, ' ');
      if (!t) return kit.no('The editor is empty: type the name of an architecture.');
      const named = ['shared memory', 'shared disk', 'shared nothing', 'hierarchical'].filter((a) => t.includes(a));
      if (named.length !== 1) return kit.no('Type exactly one of: shared memory, shared disk, shared nothing, hierarchical.');
      return named[0] === 'shared nothing' ? kit.ok('Right: shared nothing.') : kit.no('Not ' + named[0] + '. What do two machines share here?');
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
