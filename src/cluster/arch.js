// Chapter 20's parallel architectures as small models. Throughput as processors are added follows a contention
// and coherency law (Gunther's universal scalability law): X(n) = n / (1 + sigma (n - 1) + kappa n (n - 1)), where
// sigma is the share of work serialised on something all processors share (the memory bus, the disk subsystem) and
// kappa the cost of keeping their views consistent (cache coherence, lock and buffer messages). On top of that the
// three brakes on speed-up: start-up cost, interference (the law above) and skew.
(function (root) {
  'use strict';
  const K = root.K;
  const C = K.Cluster = K.Cluster || {};

  const ARCH = {
    'shared-memory': {
      label: 'Shared memory', sigma: 0.04, kappa: 0.004, startup: 0.2, skew: 0.02,
      text: 'All processors share one memory over a bus or interconnect. Communication is cheap (a memory write), but the bus and '
        + 'cache coherence become the bottleneck beyond a few dozen processors.',
      shares: 'memory and disks',
    },
    'shared-disk': {
      label: 'Shared disk', sigma: 0.02, kappa: 0.0008, startup: 0.5, skew: 0.03,
      text: 'Each processor has its own memory; all reach all disks over a storage network. A failed processor is easy to replace, '
        + 'but the storage interconnect and the cross-node lock and buffer coherence limit scaling.',
      shares: 'disks',
    },
    'shared-nothing': {
      label: 'Shared nothing', sigma: 0.001, kappa: 0.000005, startup: 1, skew: 0.05,
      text: 'Each node has its own processor, memory and disks and talks to the others over the network. Only data that must cross '
        + 'nodes uses the network, so it scales to thousands of nodes; non-local access and data skew cost the most.',
      shares: 'nothing (only the network)',
    },
    hierarchical: {
      label: 'Hierarchical', sigma: 0.001, kappa: 0.000005, startup: 0.8, skew: 0.05, perNode: 8,
      text: 'Shared-memory nodes (several cores each) connected as a shared-nothing system: the top level shares nothing, inside a node '
        + 'everything is shared. Most large systems today are built this way.',
      shares: 'memory inside a node, nothing between nodes',
    },
  };

  const usl = (n, sigma, kappa) => n / (1 + sigma * (n - 1) + kappa * n * (n - 1));
  /** relative throughput of n processors: n for a perfectly scaling system */
  function throughput(arch, n, p) {
    p = Object.assign({}, ARCH[arch], p || {});
    if (arch === 'hierarchical') {
      const k = p.perNode, nodes = Math.ceil(n / k), cores = n / nodes;
      const sm = ARCH['shared-memory'];
      return usl(nodes, p.sigma, p.kappa) * usl(cores, sm.sigma, sm.kappa);
    }
    return usl(n, p.sigma, p.kappa);
  }
  // the expected largest of n partitions relative to the average grows slowly with n
  const skewFactor = (n, z) => 1 + z * Math.log2(Math.max(1, n));

  /**
   * speed-up and scale-up curves. opts: arch, maxNodes, work (time units on one processor), startup (per added
   * processor), skew, sigma, kappa. Returns { arch, params, points: [{ n, throughput, time, speedup, efficiency,
   * scaleupBatch, scaleupTx, linear }] }
   */
  function curves(opts) {
    opts = opts || {};
    const arch = opts.arch || 'shared-nothing';
    const p = Object.assign({}, ARCH[arch]);
    for (const k of ['sigma', 'kappa', 'startup', 'skew', 'perNode']) if (opts[k] !== undefined) p[k] = opts[k];
    const W = opts.work || 1000, max = opts.maxNodes || 64;
    const time = (n, work) => p.startup * n + (work / throughput(arch, n, p)) * skewFactor(n, p.skew);
    const t1 = time(1, W);
    const points = [];
    for (let n = 1; n <= max; n = n < 8 ? n + 1 : n < 32 ? n + 4 : n + 8) {
      const x = throughput(arch, n, p);
      const tn = time(n, W);
      points.push({
        n, throughput: x, time: tn, speedup: t1 / tn, efficiency: t1 / tn / n,
        scaleupBatch: t1 / time(n, W * n), scaleupTx: x / n, linear: n,
      });
    }
    return { arch, label: p.label, params: { sigma: p.sigma, kappa: p.kappa, startup: p.startup, skew: p.skew, work: W, perNode: p.perNode }, points };
  }
  function compare(opts) { return Object.keys(ARCH).map((a) => curves(Object.assign({}, opts, { arch: a }))); }
  /** where throughput peaks: beyond this, adding processors makes the system slower */
  function peak(arch, p, max) { let best = 1, bx = 0; for (let n = 1; n <= (max || 4096); n++) { const x = throughput(arch, n, p); if (x > bx) { bx = x; best = n; } } return { n: best, throughput: bx }; }

  /**
   * a small discrete simulation of contention: n processors each loop compute (think time) then one access to a
   * shared resource with a single server (the memory bus or disk controller for shared memory and shared disk; each
   * node's own disk for shared nothing). opts: arch, n, think, service, requests, seed.
   * Returns { throughput, utilization, avgWait, completed, timeline: [{ p, t, kind }] }
   */
  function simulate(opts) {
    opts = Object.assign({ arch: 'shared-memory', n: 4, think: 10, service: 1, requests: 200, seed: 1, timeline: 60 }, opts || {});
    const rng = new C.Rng(opts.seed);
    const shared = opts.arch !== 'shared-nothing';
    const servers = shared ? 1 : opts.n;
    const free = new Array(servers).fill(0);
    let busy = 0, wait = 0, done = 0, clock = 0;
    const timeline = [];
    // each processor's next request time
    const next = K.range(opts.n).map(() => rng.next() * opts.think * 2);
    while (done < opts.requests * opts.n) {
      let p = 0;
      for (let i = 1; i < opts.n; i++) if (next[i] < next[p]) p = i;
      const arrive = next[p];
      const sv = shared ? 0 : p;
      const start = Math.max(arrive, free[sv]);
      const svc = opts.service * (0.5 + rng.next());
      free[sv] = start + svc;
      busy += svc; wait += start - arrive; done++;
      clock = Math.max(clock, free[sv]);
      if (timeline.length < opts.timeline) timeline.push({ p, arrive, start, end: start + svc });
      next[p] = start + svc + opts.think * (0.5 + rng.next());
    }
    return { arch: opts.arch, n: opts.n, completed: done, throughput: done / clock, utilization: busy / (clock * servers), avgWait: wait / done, timeline };
  }

  /** interconnection networks: nodes with positions, links, diameter (hops), degree, bisection width */
  function topology(kind, n) {
    n = n || 8;
    const nodes = [], links = [];
    const add = (id, x, y, sw) => nodes.push({ id, x, y, switch: !!sw });
    if (kind === 'bus') {
      for (let i = 0; i < n; i++) add('p' + i, i / Math.max(1, n - 1), 0.3);
      add('bus', 0.5, 0.7, true);
      for (let i = 0; i < n; i++) links.push(['p' + i, 'bus', 1]);
    } else if (kind === 'ring') {
      for (let i = 0; i < n; i++) add('p' + i, 0.5 + 0.45 * Math.cos(2 * Math.PI * i / n), 0.5 + 0.45 * Math.sin(2 * Math.PI * i / n));
      for (let i = 0; i < n; i++) links.push(['p' + i, 'p' + ((i + 1) % n), 1]);
    } else if (kind === 'mesh') {
      const w = Math.ceil(Math.sqrt(n));
      for (let i = 0; i < n; i++) add('p' + i, (i % w) / Math.max(1, w - 1), Math.floor(i / w) / Math.max(1, Math.ceil(n / w) - 1));
      for (let i = 0; i < n; i++) { if ((i % w) + 1 < w && i + 1 < n) links.push(['p' + i, 'p' + (i + 1), 1]); if (i + w < n) links.push(['p' + i, 'p' + (i + w), 1]); }
    } else if (kind === 'hypercube') {
      const d = Math.max(1, Math.round(Math.log2(n))); n = 1 << d;
      for (let i = 0; i < n; i++) add('p' + i, ((i & 1) + ((i >> 2) & 1) * 2 + ((i >> 4) & 1) * 4) / 7, (((i >> 1) & 1) + ((i >> 3) & 1) * 2 + ((i >> 5) & 1) * 4) / 7);
      for (let i = 0; i < n; i++) for (let b = 0; b < d; b++) { const j = i ^ (1 << b); if (j > i) links.push(['p' + i, 'p' + j, 1]); }
    } else if (kind === 'tree' || kind === 'fat-tree') {
      // processors at the leaves of a binary tree of switches; a fat tree doubles link capacity at each level up
      const levels = Math.max(1, Math.ceil(Math.log2(n))); n = 1 << levels;
      for (let i = 0; i < n; i++) add('p' + i, (i + 0.5) / n, 1);
      let below = K.range(n).map((i) => 'p' + i);
      for (let l = 1; l <= levels; l++) {
        const up = [];
        for (let i = 0; i < below.length; i += 2) {
          const id = 's' + l + '.' + i / 2, cnt = below.length / 2;
          add(id, (i / 2 + 0.5) / cnt, 1 - l / levels, true);
          const cap = kind === 'fat-tree' ? 1 << (l - 1) : 1;
          links.push([below[i], id, cap], [below[i + 1], id, cap]);
          up.push(id);
        }
        below = up;
      }
    } else throw new Error('unknown topology ' + kind);
    const procs = nodes.filter((x) => !x.switch).map((x) => x.id);
    const adj = new Map(nodes.map((x) => [x.id, []]));
    for (const [a, b] of links) { adj.get(a).push(b); adj.get(b).push(a); }
    let diameter = 0, total = 0, pairs = 0;
    for (const s of procs) {
      const dist = new Map([[s, 0]]); const q = [s];
      while (q.length) { const u = q.shift(); for (const v of adj.get(u)) if (!dist.has(v)) { dist.set(v, dist.get(u) + 1); q.push(v); } }
      for (const t of procs) if (t !== s) { diameter = Math.max(diameter, dist.get(t)); total += dist.get(t); pairs++; }
    }
    const degree = Math.max(...procs.map((p) => adj.get(p).length));
    const bisection = { bus: 1, ring: 2, mesh: Math.ceil(Math.sqrt(n)), hypercube: n / 2, tree: 1, 'fat-tree': n / 2 }[kind];
    return { kind, n: procs.length, nodes, links, diameter, avgHops: pairs ? total / pairs : 0, degree, bisection, linkCount: links.length };
  }

  /** the boxes and lines of an architecture diagram: processors P, memories M, disks D, interconnect */
  function diagram(arch, n) {
    n = n || 4;
    const P = K.range(n).map((i) => 'P' + i);
    const parts = { processors: P, memories: [], disks: [], links: [], interconnect: arch === 'shared-memory' ? 'memory bus' : arch === 'shared-disk' ? 'storage network' : 'network' };
    if (arch === 'shared-memory') { parts.memories = ['M']; parts.disks = ['D0', 'D1']; P.forEach((p) => parts.links.push([p, 'bus'])); parts.links.push(['bus', 'M'], ['M', 'D0'], ['M', 'D1']); }
    else if (arch === 'shared-disk') { P.forEach((p, i) => { parts.memories.push('M' + i); parts.links.push([p, 'M' + i], [p, 'san']); }); parts.disks = ['D0', 'D1', 'D2']; parts.disks.forEach((d) => parts.links.push(['san', d])); }
    else if (arch === 'shared-nothing') { P.forEach((p, i) => { parts.memories.push('M' + i); parts.disks.push('D' + i); parts.links.push([p, 'M' + i], [p, 'D' + i], [p, 'net']); }); }
    else { const k = 2; for (let g = 0; g < Math.ceil(n / k); g++) { parts.memories.push('M' + g); parts.disks.push('D' + g); parts.links.push(['M' + g, 'D' + g], ['bus' + g, 'M' + g], ['bus' + g, 'net']); P.slice(g * k, g * k + k).forEach((p) => parts.links.push([p, 'bus' + g])); } }
    return Object.assign({ arch, label: ARCH[arch].label, shares: ARCH[arch].shares }, parts);
  }

  C.Arch = {
    ARCH, throughput, curves, compare, peak, simulate, topology, diagram, usl,
    describe() {
      return {
        name: 'Parallel architectures',
        text: 'Speed-up runs a fixed task on more processors (linear: n times faster); scale-up grows the task with the processors '
          + '(linear: the same time; batch scale-up for one large job, transaction scale-up for more transactions per second). Three things '
          + 'keep both below linear: start-up costs that grow with the number of processes, interference on shared resources, and skew, '
          + 'where the slowest partition decides the time. The models give each architecture a contention share sigma and a coherency cost '
          + 'kappa: X(n) = n / (1 + sigma (n - 1) + kappa n (n - 1)).',
        architectures: Object.entries(ARCH).map(([k, a]) => ({ id: k, label: a.label, sigma: a.sigma, kappa: a.kappa, shares: a.shares, text: a.text })),
        topologies: ['bus', 'ring', 'mesh', 'hypercube', 'tree', 'fat-tree'],
      };
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
