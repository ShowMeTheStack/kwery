// MapReduce (chapter 10) on simulated workers, and a Spark-style RDD model next to it. A master hands
// out map tasks over input splits; a map task partitions its output by hash(key) mod R on the worker's local disk
// (after the combiner, when there is one); reduce tasks fetch their partition from every map output over the
// network, sort by key, group and reduce. Workers send heartbeats; a worker that stops is declared dead, and its
// map tasks (finished or not, since their output sat on its disk) and its unfinished reduce task are run again.
(function (root) {
  'use strict';
  const K = root.K;
  const C = K.Cluster = K.Cluster || {};

  const hashKey = (k) => K.fnv(K.keyOf(k));
  const cmpKey = (a, b) => {
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    const x = K.keyOf(a), y = K.keyOf(b);
    return x < y ? -1 : x > y ? 1 : 0;
  };
  /** group [k, v] pairs by key, keys in sorted order: [[k, [v...]]] */
  function group(pairs) {
    const m = new Map();
    for (const [k, v] of pairs) { const kk = K.keyOf(k); let g = m.get(kk); if (!g) { g = [k, []]; m.set(kk, g); } g[1].push(v); }
    return [...m.values()].sort((a, b) => cmpKey(a[0], b[0]));
  }
  /** split records into n splits of nearly equal size, in order */
  function splits(records, n) {
    const out = [];
    const size = Math.ceil(records.length / n) || 1;
    for (let i = 0; i < n; i++) out.push(records.slice(i * size, (i + 1) * size));
    return out;
  }

  class Master extends C.Actor {
    constructor(id, job, opts) {
      super(id);
      this.job = job; this.opts = opts;
      this.state = {
        phase: 'map', clockStart: 0,
        maps: job.input.map((_, i) => ({ id: 'm' + i, split: i, status: 'idle', worker: null, attempts: 0 })),
        reduces: K.range(job.R).map((r) => ({ id: 'r' + r, part: r, status: 'idle', worker: null, attempts: 0 })),
        workers: {}, locations: {}, output: {}, history: [], counters: { mapInput: 0, mapOutput: 0, combined: 0, reexecuted: 0, failures: 0 },
      };
      for (const w of opts.workers) this.state.workers[w] = { alive: true, last: 0, busy: null };
    }
    onTimer(name) {
      if (name === 'start') { this.note('job.start', { maps: this.state.maps.length, reduces: this.state.reduces.length, workers: Object.keys(this.state.workers) }); this.schedule(); this.setTimer('check', this.opts.heartbeat); }
      if (name === 'check') { this.check(); if (this.state.phase !== 'done') this.setTimer('check', this.opts.heartbeat); }
    }
    task(id) { return (id[0] === 'm' ? this.state.maps : this.state.reduces).find((t) => t.id === id); }
    check() {
      for (const [w, ws] of Object.entries(this.state.workers)) {
        if (ws.alive && this.now - ws.last > this.opts.timeout) { this.note('worker.dead', { worker: w, lastHeartbeat: ws.last }); this.fail(w); }
      }
      this.schedule();
    }
    /** a worker is gone: its map outputs and its running reduce go back to idle */
    fail(w) {
      const s = this.state;
      s.workers[w].alive = false; s.workers[w].busy = null; s.counters.failures++;
      for (const t of s.maps) {
        if (t.worker === w && (t.status === 'running' || (t.status === 'done' && s.reduces.some((r) => r.status !== 'done')))) {
          const was = t.status;
          t.status = 'idle'; t.worker = null; delete s.locations[t.id];
          this.close(t.id, w, 'failed');
          this.note('task.reexecute', { task: t.id, worker: w, was });
          s.counters.reexecuted++;
        }
      }
      for (const t of s.reduces) if (t.worker === w && t.status === 'running') { t.status = 'idle'; t.worker = null; this.close(t.id, w, 'failed'); this.note('task.reexecute', { task: t.id, worker: w, was: 'running' }); s.counters.reexecuted++; }
      if (s.maps.some((t) => t.status !== 'done')) s.phase = 'map';
    }
    close(task, worker, status) { const h = this.state.history.slice().reverse().find((x) => x.task === task && x.worker === worker && x.end === null); if (h) { h.end = this.now; h.status = status; } }
    schedule() {
      const s = this.state;
      if (s.phase === 'done') return;
      const idle = Object.keys(s.workers).filter((w) => s.workers[w].alive && !s.workers[w].busy);
      for (const w of idle) {
        let t = s.maps.find((x) => x.status === 'idle');
        if (!t && s.maps.every((x) => x.status === 'done')) { s.phase = 'reduce'; t = s.reduces.find((x) => x.status === 'idle'); }
        if (!t) break;
        t.status = 'running'; t.worker = w; t.attempts++;
        s.workers[w].busy = t.id;
        s.history.push({ task: t.id, kind: t.id[0] === 'm' ? 'map' : 'reduce', worker: w, attempt: t.attempts, start: this.now, end: null, status: 'running' });
        this.note('task.assign', { task: t.id, worker: w, attempt: t.attempts });
        if (t.id[0] === 'm') this.send(w, 'map', { task: t.id, split: t.split });
        else this.send(w, 'reduce', { task: t.id, part: t.part, sources: Object.assign({}, s.locations) });
      }
    }
    onMessage(m) {
      const s = this.state, b = m.body;
      const ws = s.workers[m.from];
      if (m.type === 'hello') {
        if (ws.alive) { this.note('worker.restarted', { worker: m.from }); this.fail(m.from); }
        s.workers[m.from] = { alive: true, last: this.now, busy: null };
        this.schedule();
        return;
      }
      if (!ws) return;
      // a worker declared dead that is still sending heartbeats (it was only cut off) rejoins with nothing assigned
      if (!ws.alive) { if (m.type === 'hb') { s.workers[m.from] = { alive: true, last: this.now, busy: null }; this.note('worker.rejoin', { worker: m.from }); this.schedule(); } return; }
      ws.last = this.now;
      if (m.type === 'hb') return;
      const t = this.task(b.task);
      if (!t || t.worker !== m.from || t.status !== 'running') return;
      ws.busy = null;
      t.status = 'done';
      this.close(t.id, m.from, 'done');
      if (m.type === 'mapDone') {
        s.locations[t.id] = m.from;
        s.counters.mapInput += b.inRecords; s.counters.mapOutput += b.outRecords; s.counters.combined += b.combined;
        this.note('task.done', { task: t.id, worker: m.from, sizes: b.sizes });
        // reducers already running learn where a re-executed map's output now is
        for (const r of s.reduces) if (r.status === 'running') this.send(r.worker, 'location', { map: t.id, worker: m.from });
      } else {
        s.output[t.part] = b.output;
        this.note('task.done', { task: t.id, worker: m.from, records: b.output.length });
        if (s.reduces.every((x) => x.status === 'done')) { s.phase = 'done'; this.note('job.done', { time: this.now }); return; }
      }
      this.schedule();
    }
  }

  class Worker extends C.Actor {
    constructor(id, job, opts) { super(id); this.job = job; this.opts = opts; this.state = { local: {}, pending: null, reduce: null }; }
    start() { this.send(this.opts.master, 'hb', {}); this.setTimer('hb', this.opts.heartbeat); }
    onCrash() { this.state = { local: {}, pending: null, reduce: null }; }
    onRestart() { this.send(this.opts.master, 'hello', {}); this.setTimer('hb', this.opts.heartbeat); }
    onTimer(name, data) {
      const s = this.state;
      if (name === 'hb') { this.send(this.opts.master, 'hb', {}); this.setTimer('hb', this.opts.heartbeat); }
      if (name === 'mapDone' && s.pending && s.pending.task === data.task) {
        const p = s.pending; s.pending = null;
        s.local[p.task] = p.parts;
        this.send(this.opts.master, 'mapDone', { task: p.task, inRecords: p.inRecords, outRecords: p.outRecords, combined: p.combined, sizes: p.parts.map((x) => x.length) });
      }
      if (name === 'reduceDone' && s.reduce && s.reduce.task === data.task) {
        const out = s.reduce.output; s.reduce = null;
        this.send(this.opts.master, 'reduceDone', { task: data.task, output: out });
      }
    }
    runMap(task, split) {
      const job = this.job, R = job.R;
      const recs = job.input[split];
      const parts = K.range(R).map(() => []);
      let out = 0;
      for (const rec of recs) job.map(rec, (k, v) => { parts[hashKey(k) % R].push([k, v]); out++; });
      let combined = out;
      if (job.combiner && this.opts.combiner) {
        combined = 0;
        for (let r = 0; r < R; r++) {
          const c = [];
          for (const [k, vs] of group(parts[r])) job.combiner(k, vs, (k2, v2) => c.push([k2, v2]));
          parts[r] = c; combined += c.length;
        }
      }
      this.state.pending = { task, parts, inRecords: recs.length, outRecords: out, combined };
      this.setTimer('mapDone', this.opts.mapCost * recs.length + this.opts.taskStart, { task });
    }
    onMessage(m) {
      const s = this.state, b = m.body;
      if (m.type === 'map') this.runMap(b.task, b.split);
      else if (m.type === 'fetch') {
        const parts = s.local[b.map];
        if (parts) this.send(m.from, 'data', { task: b.task, map: b.map, part: b.part, records: parts[b.part] });
      } else if (m.type === 'reduce') {
        s.reduce = { task: b.task, part: b.part, got: {}, data: [], output: null };
        for (let i = 0; i < this.job.input.length; i++) {
          const mid = 'm' + i;
          if (b.sources[mid]) this.send(b.sources[mid], 'fetch', { task: b.task, map: mid, part: b.part });
        }
      } else if (m.type === 'location') {
        if (s.reduce && !s.reduce.got[b.map]) this.send(b.worker, 'fetch', { task: s.reduce.task, map: b.map, part: s.reduce.part });
      } else if (m.type === 'data') {
        const r = s.reduce;
        if (!r || r.task !== b.task || r.got[b.map]) return;
        r.got[b.map] = true;
        for (const x of b.records) r.data.push(x);
        if (Object.keys(r.got).length === this.job.input.length) {
          const out = [];
          for (const [k, vs] of group(r.data)) this.job.reduce(k, vs, (k2, v2) => out.push([k2, v2]));
          r.output = out;
          this.setTimer('reduceDone', this.opts.reduceCost * r.data.length + this.opts.taskStart, { task: r.task });
        }
      }
    }
  }

  /**
   * set up a job on a simulated cluster; job: { input: [[record]] (the splits), map(rec, emit), reduce(key, values, emit),
   * combiner(key, values, emit)?, R }. opts: workers (count), seed, latency, jitter, heartbeat, timeout, combiner (use the
   * job's combiner), mapCost/reduceCost per record, taskStart, failures [{ worker, at, restart }]
   */
  function setup(job, opts) {
    opts = Object.assign({ workers: 4, seed: 1, latency: 2, jitter: 1, heartbeat: 10, timeout: 30, combiner: true, mapCost: 0.05, reduceCost: 0.05, taskStart: 2, failures: [] }, opts || {});
    job = Object.assign({ R: 3 }, job);
    const net = new C.Net({ seed: opts.seed, latency: opts.latency, jitter: opts.jitter });
    const ws = K.range(opts.workers).map((i) => 'w' + (i + 1));
    const o = Object.assign({}, opts, { workers: ws, master: 'master' });
    const master = net.add('master', new Master('master', job, o));
    const workers = ws.map((w) => net.add(w, new Worker(w, job, o)));
    for (const w of workers) w.start();
    net.setTimer('master', 'start', 1);
    for (const f of opts.failures) { net.at(f.at, 'crash', f.worker); if (f.restart !== undefined) net.at(f.restart, 'restart', f.worker); }
    const done = () => master.state.phase === 'done';
    return {
      net, master, workers, job,
      step: () => net.step(), done,
      run(maxTime) { net.run((n) => done() || n.clock > (maxTime || 1e6)); return this.result(); },
      result() { return result(net, master, job); },
    };
  }
  function result(net, master, job) {
    const s = master.state;
    const byPartition = K.range(job.R).map((r) => s.output[r] || []);
    const output = [].concat(...byPartition).sort((a, b) => cmpKey(a[0], b[0]));
    const sends = net.trace.filter((e) => e.kind === 'send' && e.type === 'data');
    const stats = Object.assign({}, s.counters, {
      maps: s.maps.length, reduces: s.reduces.length, done: s.phase === 'done', time: net.clock,
      shuffleMessages: sends.length, shuffleRecords: sends.reduce((n, e) => n + e.body.records.length, 0), shuffleBytes: sends.reduce((n, e) => n + e.bytes, 0),
      messages: net.stats.sent, bytes: net.stats.bytes,
    });
    return { output, byPartition, stats, tasks: C.clone(s.history), trace: net.trace, net };
  }
  function run(job, opts) { return setup(job, opts).run(); }

  // ---- examples -----------------------------------------------------------------------------------------------
  const num = (v) => (v === null ? null : Number(v));
  const examples = {
    /** word count over lines of text */
    wordCount(lines, nSplits) {
      return {
        name: 'word count', R: 3, input: splits(lines, nSplits || 4),
        map: (line, emit) => { for (const w of String(line).toLowerCase().split(/[^a-z0-9']+/)) if (w) emit(w, 1); },
        combiner: (k, vs, emit) => emit(k, vs.reduce((a, b) => a + b, 0)),
        reduce: (k, vs, emit) => emit(k, vs.reduce((a, b) => a + b, 0)),
      };
    },
    /** equi-join of two tables (text rows): reduce side join, tagging each row with its table */
    join(left, right, lkey, rkey, nSplits) {
      const li = left.cols.findIndex((c) => c.name === lkey), ri = right.cols.findIndex((c) => c.name === rkey);
      const recs = left.rows.map((r) => ['L', r]).concat(right.rows.map((r) => ['R', r]));
      return {
        name: 'join ' + left.name + ' with ' + right.name + ' on ' + lkey, R: 3, input: splits(recs, nSplits || 4),
        map: ([t, row], emit) => { const k = row[t === 'L' ? li : ri]; if (k !== null) emit(k, [t, row]); },
        reduce: (k, vs, emit) => { const L = vs.filter((v) => v[0] === 'L'), R = vs.filter((v) => v[0] === 'R'); for (const l of L) for (const r of R) emit(k, l[1].concat(r[1])); },
      };
    },
    /** SELECT g, count(*), sum(x), avg(x) FROM t GROUP BY g, with a combiner carrying (count, sum, nonnull) */
    groupBy(table, gcol, xcol, nSplits) {
      const gi = table.cols.findIndex((c) => c.name === gcol), xi = table.cols.findIndex((c) => c.name === xcol);
      const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
      return {
        name: 'group ' + table.name + ' by ' + gcol, R: 3, input: splits(table.rows, nSplits || 4),
        map: (row, emit) => { const x = num(row[xi]); emit(row[gi], [1, x === null ? 0 : x, x === null ? 0 : 1]); },
        combiner: (k, vs, emit) => emit(k, vs.reduce(add)),
        reduce: (k, vs, emit) => { const [n, s, nn] = vs.reduce(add); emit(k, { count: n, sum: nn ? s : null, avg: nn ? s / nn : null }); },
      };
    },
  };

  // ---- Spark-style RDDs -----------------------------------------------------------------------------------------
  // An RDD is a lazy description: a source or an operator over parent RDDs. Narrow operators (map, filter, flatMap,
  // mapValues) work partition by partition and run pipelined in one stage; wide ones (reduceByKey, groupByKey, join,
  // distinct) need every parent partition, so they start a new stage behind a shuffle. Partition p lives on worker
  // p mod W. Lost partitions are recomputed from the lineage.
  const NARROW = new Set(['source', 'map', 'filter', 'flatMap', 'mapValues']);
  let rddIds = 0;
  class RDD {
    constructor(ctx, op, parents, f, n) { this.id = ++rddIds; this.ctx = ctx; this.op = op; this.parents = parents; this.f = f; this.n = n; this.cached = false; this.store = new Map(); this.name = op + '#' + this.id; }
    get wide() { return !NARROW.has(this.op); }
    narrow(op, f) { return new RDD(this.ctx, op, [this], f, this.n); }
    map(f) { return this.narrow('map', f); }
    filter(f) { return this.narrow('filter', f); }
    flatMap(f) { return this.narrow('flatMap', f); }
    mapValues(f) { return this.narrow('mapValues', f); }
    reduceByKey(f, n) { return new RDD(this.ctx, 'reduceByKey', [this], f, n || this.n); }
    groupByKey(n) { return new RDD(this.ctx, 'groupByKey', [this], null, n || this.n); }
    distinct(n) { return this.map((x) => [x, null]).reduceByKey((a) => a, n).map((kv) => kv[0]); }
    join(other, n) { return new RDD(this.ctx, 'join', [this, other], null, n || Math.max(this.n, other.n)); }
    cache() { this.cached = true; return this; }
    /** the stage DAG: each stage is a pipeline of narrow RDDs ending at a wide RDD or the result */
    stages() {
      const stages = [], memo = new Map();
      // a stage is rooted at an RDD and runs back through narrow parents; a wide RDD on the way reads a shuffle,
      // and the pipelines feeding that shuffle are stages of their own
      const stageOf = (r, writes) => {
        if (memo.has(r.id)) return memo.get(r.id);
        const st = { id: 0, rdds: [], ops: [], parents: [], shuffle: null, writesShuffle: writes };
        const walk = (x) => {
          st.rdds.unshift(x.id); st.ops.unshift(x.op);
          if (x.wide) { st.shuffle = x.op; for (const p of x.parents) st.parents.push(stageOf(p, true).id); }
          else if (x.parents.length) walk(x.parents[0]);
        };
        walk(r);
        st.id = stages.length; stages.push(st); memo.set(r.id, st);
        return st;
      };
      stageOf(this, false);
      return stages;
    }
    lineage() { const out = []; const seen = new Set(); const walk = (r, d) => { if (seen.has(r.id)) return; seen.add(r.id); out.push({ id: r.id, op: r.op, depth: d, parents: r.parents.map((p) => p.id), wide: r.wide, partitions: r.n, cached: r.cached }); r.parents.forEach((p) => walk(p, d + 1)); }; walk(this, 0); return out; }
    /** run the job: { result, stages, events, stats } */
    run() {
      const ctx = this.ctx;
      ctx.events = []; ctx.job = { shuffleRecords: 0, shuffleBytes: 0, shuffleMessages: 0, localRecords: 0, tasks: 0, recomputed: 0 };
      const parts = K.range(this.n).map((p) => ctx.compute(this, p));
      return { result: [].concat(...parts), stages: this.stages(), lineage: this.lineage(), events: ctx.events, stats: Object.assign({}, ctx.job) };
    }
    collect() { return this.run().result; }
    count() { return this.collect().length; }
  }

  class SparkContext {
    constructor(opts) { opts = opts || {}; this.W = opts.workers || 3; this.shuffles = new Map(); this.done = new Set(); this.events = []; this.job = null; }
    worker(p) { return 'w' + ((p % this.W) + 1); }
    parallelize(data, n) { n = n || this.W; const sp = splits(data, n); return new RDD(this, 'source', [], (p) => sp[p], n); }
    textFile(lines, n) { return this.parallelize(lines, n); }
    ev(e) { this.events.push(e); }
    compute(r, p) {
      if (r.store.has(p)) { this.ev({ kind: 'cache-hit', rdd: r.id, partition: p, worker: this.worker(p) }); return r.store.get(p); }
      const key = r.id + ':' + p;
      if (this.done.has(key)) { this.job.recomputed++; this.ev({ kind: 'recompute', rdd: r.id, op: r.op, partition: p, worker: this.worker(p) }); }
      let out;
      if (r.op === 'source') out = r.f(p).slice();
      else if (!r.wide) {
        const inp = this.compute(r.parents[0], p);
        out = r.op === 'map' ? inp.map(r.f) : r.op === 'filter' ? inp.filter(r.f) : r.op === 'flatMap' ? [].concat(...inp.map(r.f)) : inp.map(([k, v]) => [k, r.f(v)]);
      } else {
        const inputs = r.parents.map((par, i) => this.fetch(r, i, par, p));
        if (r.op === 'reduceByKey') out = group(inputs[0]).map(([k, vs]) => [k, vs.reduce(r.f)]);
        else if (r.op === 'groupByKey') out = group(inputs[0]);
        else {
          const tagged = inputs[0].map(([k, v]) => [k, [0, v]]).concat(inputs[1].map(([k, v]) => [k, [1, v]]));
          out = [];
          for (const [k, vs] of group(tagged)) { const a = vs.filter((x) => x[0] === 0), b = vs.filter((x) => x[0] === 1); for (const x of a) for (const y of b) out.push([k, [x[1], y[1]]]); }
        }
      }
      this.job.tasks++;
      this.ev({ kind: 'task', rdd: r.id, op: r.op, partition: p, worker: this.worker(p), records: out.length });
      this.done.add(key);
      if (r.cached) r.store.set(p, out);
      return out;
    }
    /** the shuffle files of parent i of wide RDD r, written by each parent partition on its worker; read bucket p */
    fetch(r, i, par, p) {
      const sk = r.id + ':' + i;
      let sh = this.shuffles.get(sk);
      if (!sh) { sh = { files: new Map() }; this.shuffles.set(sk, sh); }
      const out = [];
      for (let q = 0; q < par.n; q++) {
        if (!sh.files.has(q)) {
          let recs = this.compute(par, q);
          const buckets = K.range(r.n).map(() => []);
          for (const kv of recs) buckets[hashKey(kv[0]) % r.n].push(kv);
          // reduceByKey combines on the map side before writing
          if (r.op === 'reduceByKey') for (let b = 0; b < r.n; b++) buckets[b] = group(buckets[b]).map(([k, vs]) => [k, vs.reduce(r.f)]);
          sh.files.set(q, { worker: this.worker(q), buckets });
          this.ev({ kind: 'shuffle-write', rdd: r.id, parent: par.id, partition: q, worker: this.worker(q), records: buckets.reduce((n, b) => n + b.length, 0) });
        }
        const f = sh.files.get(q), b = f.buckets[p];
        if (f.worker !== this.worker(p)) {
          if (b.length) { this.job.shuffleMessages++; this.job.shuffleRecords += b.length; this.job.shuffleBytes += C.sizeOf(b); this.ev({ kind: 'shuffle-fetch', rdd: r.id, from: f.worker, to: this.worker(p), records: b.length, bytes: C.sizeOf(b) }); }
        } else this.job.localRecords += b.length;
        for (const x of b) out.push(x);
      }
      return out;
    }
    /** a worker fails: its cached partitions and shuffle files are gone */
    failWorker(w) {
      const lost = [];
      for (const sh of this.shuffles.values()) for (const [q, f] of sh.files) if (f.worker === w) { sh.files.delete(q); lost.push({ shuffle: true, partition: q }); }
      const seen = new Set();
      const visit = (r) => { if (seen.has(r.id)) return; seen.add(r.id); for (const p of [...r.store.keys()]) if (this.worker(p) === w) { r.store.delete(p); lost.push({ rdd: r.id, partition: p }); } r.parents.forEach(visit); };
      for (const r of this.rdds || []) visit(r);
      return lost;
    }
    /** RDDs whose caches failWorker should clear */
    track(...rdds) { this.rdds = (this.rdds || []).concat(rdds); return this; }
  }

  C.MapReduce = {
    setup, run, splits, group, examples, hashKey,
    Spark: SparkContext, RDD,
    describe() {
      return {
        name: 'MapReduce',
        text: 'The master splits the input into M map tasks and the output into R reduce partitions. A map task runs the map function '
          + 'on its split and partitions the emitted (key, value) pairs by hash(key) mod R on the worker\'s local disk; a combiner, when given, '
          + 'pre-reduces each partition there to cut the shuffle. After all maps finish, each reduce task fetches its partition from every map '
          + 'output (the shuffle), sorts and groups by key, and calls reduce. Workers send heartbeats; when one goes silent the master marks it dead '
          + 'and re-executes its map tasks, finished or not, because their output was on its disk, plus its unfinished reduce task. '
          + 'The Spark model chains operators lazily: narrow ones are pipelined inside a stage, wide ones end the stage with a shuffle, and lost '
          + 'partitions are rebuilt from the lineage.',
        traceNotes: ['job.start', 'task.assign', 'task.done', 'worker.dead', 'worker.restarted', 'task.reexecute', 'job.done'],
        messages: ['map', 'mapDone', 'reduce', 'fetch', 'data', 'location', 'reduceDone', 'hb', 'hello'],
      };
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
