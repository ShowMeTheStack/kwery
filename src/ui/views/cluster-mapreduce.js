// The MapReduce view: word count, a reduce-side join and a group-by over Theatre data on simulated workers
// (K.Cluster.MapReduce). It plays the job: the master handing out map tasks, the map outputs partitioned by
// hash(key) mod R on each worker's disk (the shuffle matrix), the reducers fetching their column, a worker failure
// and the re-execution it causes; it compares the shuffle with and without the combiner, and draws the Spark-style
// lineage graph of the same job with its stages, and what a lost worker costs there.
(function (root) {
  'use strict';
  const K = root.K;
  const UI = K.UI;
  const { h, s } = UI;
  const C = () => K.Cluster;

  const JOBS = [['words', 'Word count over production titles'], ['join', 'Join artist ⋈ company'], ['group', 'Average fee per company'], ['bookings', 'Bookings per performance (booking)']];
  const FAILS = [['none', 'no failure'], ['map', 'w1 crashes during the map phase'], ['after', 'a worker crashes after its maps finished'], ['restart', 'w2 crashes and comes back']];

  function jobOf(o) {
    const M = C().MapReduce, u = UI.CK.theatre(), T = u.tables;
    let job;
    if (o.job === 'words') job = M.examples.wordCount(T.production.rows.map((r) => r[T.production.cols.findIndex((c) => c.name === 'title')]), o.maps);
    else if (o.job === 'join') job = M.examples.join(T.artist, T.company, 'company_id', 'company_id', o.maps);
    else if (o.job === 'group') job = M.examples.groupBy(T.artist, 'company_id', 'fee', o.maps);
    else job = M.examples.groupBy(T.booking, 'perf_id', 'seats', o.maps);
    return Object.assign(job, { R: o.R });
  }
  const outText = (o, kv) => {
    const [k, v] = kv;
    if (o.job === 'words') return k + ': ' + v;
    if (o.job === 'join') return k + ': ' + v[2] + ' (' + v[v.length - 3] + ')';
    if (o.job === 'group') return (k === null ? 'null' : k) + ': ' + v.count + ' artists, avg ' + (v.avg === null ? '–' : Math.round(v.avg));
    return 'performance ' + k + ': ' + v.count + ' bookings';
  };

  function create(app, el) {
    const CK = UI.CK;
    const o = Object.assign({ job: 'words', workers: 4, maps: 6, R: 3, combiner: true, fail: 'none', seed: 1 }, UI.store.get('mr.opts', {}));
    if (!JOBS.some((j) => j[0] === o.job)) o.job = 'words';
    const body = h('div.view-body.ck-body');
    el.appendChild(body);
    let stage = null, token = 0;
    const set = (k, v) => { o[k] = v; UI.store.set('mr.opts', o); start(); };

    function start() {
      const my = ++token;
      if (stage) { stage.destroy(); stage = null; }
      body.innerHTML = '';
      body.appendChild(CK.about('MapReduce runs a map function over input splits and a reduce function over every key\'s values. The master gives each idle worker a map task; the map output is partitioned by hash(key) mod R on that worker\'s local disk (after the combiner, which pre-reduces it there); when every map is done, each reduce task fetches its partition from every map output (the shuffle), groups by key and reduces. A worker that stops sending heartbeats is declared dead and its map tasks run again, finished or not, because their output was on its disk.'));
      body.appendChild(h('div.ck-controls',
        CK.select('Job', JOBS, o.job, (v) => set('job', v)),
        CK.select('Workers', [3, 4, 5, 6].map((n) => [n, n + ' workers']), o.workers, (v) => set('workers', v)),
        CK.select('Map tasks', [3, 4, 6, 8].map((n) => [n, 'M = ' + n]), o.maps, (v) => set('maps', v)),
        CK.select('Reduce tasks', [2, 3, 4].map((n) => [n, 'R = ' + n]), o.R, (v) => set('R', v)),
        CK.check('Combiner', o.combiner, (v) => set('combiner', v), 'Pre-reduce each map output partition on the map worker'),
        CK.select('Failure', FAILS, o.fail, (v) => set('fail', v)),
        CK.select('', [1, 2, 3, 4, 5].map((n) => [n, 'seed ' + n]), o.seed, (v) => set('seed', v), 'Random seed')));
      const host = h('div.ck-host');
      body.appendChild(host);
      CK.later(host, 'Loading the Theatre data…', () => {
        if (my !== token) return;
        host.innerHTML = '';
        stage = CK.stage({ el: host });
        stage.load(jobSrc(), 0);
        body.appendChild(combinerBox());
        body.appendChild(sparkBox());
      });
    }

    function failures() {
      const M = C().MapReduce;
      if (o.fail === 'map') return [{ worker: 'w1', at: 3 }];
      if (o.fail === 'restart') return [{ worker: 'w2', at: 4, restart: 50 }];
      if (o.fail === 'after') {
        // find, in a run without failures, the worker whose map finished last, and crash it just then
        const dry = M.run(jobOf(o), { workers: o.workers, seed: o.seed, combiner: o.combiner });
        const ends = dry.tasks.filter((t) => t.kind === 'map');
        const last = ends.reduce((a, b) => (b.end > a.end ? b : a));
        return [{ worker: last.worker, at: last.end + 0.001, restart: last.end + 100 }];
      }
      return [];
    }
    function jobSrc() {
      const M = C().MapReduce;
      const fails = failures();
      const wids = K.range(o.workers).map((i) => 'w' + (i + 1));
      return CK.liveSrc({
        base: 10, horizon: 400, chunk: 300, maxFrames: 8000,
        hideMsg: (m) => m.type === 'hb',
        quiet: (ev) => ev.every((e) => e.type === 'hb' || (e.kind === 'timer' && e.name === 'hb') || (e.kind === 'timer' && e.name === 'check' && ev.length === 1)),
        make: () => M.setup(jobOf(o), { workers: o.workers, seed: o.seed, combiner: o.combiner, failures: fails }),
        done: (sim) => sim.done(),
        capture(sim) {
          const ms = sim.master.state;
          const matrix = ms.maps.map((t) => { const loc = ms.locations[t.id]; const parts = loc && sim.net.node(loc).state.local[t.id]; return parts ? parts.map((p) => p.length) : null; });
          const got = ms.reduces.map((r) => {
            if (r.status === 'done') return ms.maps.map(() => true);
            const w = r.worker && sim.net.node(r.worker), rs = w && w.state.reduce;
            return ms.maps.map((t) => !!(rs && rs.task === r.id && rs.got[t.id]));
          });
          const local = {};
          for (const w of wids) local[w] = Object.keys(sim.net.node(w).state.local);
          const out = ms.phase === 'done' ? [].concat(...Object.values(ms.output)) : [];
          return {
            phase: ms.phase, maps: ms.maps.map((t) => Object.assign({}, t)), reduces: ms.reduces.map((t) => Object.assign({}, t)),
            workers: JSON.parse(JSON.stringify(ms.workers)), matrix, got, local, hist: ms.history.map((x) => Object.assign({}, x)), counters: Object.assign({}, ms.counters), out: out.slice(0, 400).map((kv) => C().clone(kv)), outN: out.length,
          };
        },
        // the master and the workers on one ellipse around the network hub: task assignments and the shuffle between
        // workers all go along the sender's spoke and the receiver's
        layout: (f, w) => ({ height: wids.length > 4 ? 400 : 340, nodes: CK.circle(['master'].concat(wids), { narrow: w < 520 }).concat([{ id: CK.HUB, x: 0.5, y: 0.5, kind: 'hub' }]), links: CK.spokes(['master'].concat(wids)) }),
        card(id, f) {
          const st = f.s;
          if (id === 'master') {
            const md = st.maps.filter((t) => t.status === 'done').length, rd = st.reduces.filter((t) => t.status === 'done').length;
            return { title: 'master', badge: st.phase, badgeCls: st.phase === 'done' ? 'ok' : 'acc', cls: 'lead', lines: [B('maps', md + '/' + st.maps.length), B('reduces', rd + '/' + st.reduces.length)] };
          }
          const w = st.workers[id];
          const busy = w && w.busy;
          return { title: id, badge: w && !w.alive ? 'declared dead' : busy ? busy : 'idle', badgeCls: w && !w.alive ? 'bad' : busy ? 'acc' : '', cls: busy ? 'hot' : '', lines: [busy ? (busy[0] === 'm' ? 'mapping split ' + busy.slice(1) : 'reducing partition ' + busy.slice(1)) : 'waiting', B('on disk', st.local[id].join(' ') || '–')] };
        },
        note(e) {
          const d = e.data || {};
          switch (e.what) {
            case 'job.start': return 'the job starts: ' + d.maps + ' map tasks, ' + d.reduces + ' reduce tasks';
            case 'task.assign': return 'master gives ' + d.task + ' to ' + d.worker + (d.attempt > 1 ? ' (attempt ' + d.attempt + ')' : '');
            case 'task.done': return d.worker + ' finished ' + d.task + (d.sizes ? ': partitions of ' + d.sizes.join(', ') + ' records on its disk' : ': ' + d.records + ' output records');
            case 'worker.dead': return 'master: no heartbeat from ' + d.worker + ' since t ' + Math.round(d.lastHeartbeat) + ', declared dead';
            case 'task.reexecute': return 'master: ' + d.task + ' must run again (it was ' + d.was + ' on ' + d.worker + ')';
            case 'worker.restarted': return d.worker + ' is back (its disk is empty)';
            case 'worker.rejoin': return d.worker + ' rejoins';
            case 'job.done': return 'the job is done at t ' + Math.round(d.time);
          }
          return undefined;
        },
        panel(el2, f, rec, i) {
          const st = f.s;
          const chip = (t) => h('span.mr-chip.' + t.status + (t.attempts > 1 ? '.again' : ''), { title: t.id + ': ' + t.status + (t.worker ? ' on ' + t.worker : '') + ', attempt ' + t.attempts }, t.id + (t.worker ? ' ' + t.worker : '') + (t.attempts > 1 ? ' ×' + t.attempts : ''));
          el2.appendChild(CK.section('Tasks', h('div.mr-chips', st.maps.map(chip)), h('div.mr-chips', st.reduces.map(chip))));
          // the shuffle: map output i, partition r
          const tbl = h('table.mr-matrix', h('thead', h('tr', h('th', ''), K.range(o.R).map((r) => h('th', 'r' + r)))),
            h('tbody', st.maps.map((t, mi) => h('tr', h('th', t.id), K.range(o.R).map((r) => { const sz = st.matrix[mi]; const g = st.got[r] && st.got[r][mi]; return h('td' + (g ? '.got' : sz ? '.has' : st.hist.some((x) => x.task === t.id && x.status === 'failed') && t.status !== 'done' ? '.lost' : ''), { title: sz ? sz[r] + ' records for reduce ' + r + (g ? ', fetched' : '') : 'no output on any disk' }, sz ? String(sz[r]) : g ? '✓' : '·'); })))));
          el2.appendChild(CK.section('The shuffle', h('p.ck-note', 'Row i is map task i\'s output, split into R partitions by hash(key) mod ' + o.R + '; column r is what reduce task r fetches. Blue: on the map worker\'s disk; green: fetched by the reducer.'), h('div', { style: { overflowX: 'auto' } }, tbl)));
          el2.appendChild(CK.section('Timeline', gantt(st, f, rec, wids, el2.clientWidth)));
          const data = rec.msgs.filter((m) => m.type === 'data' && m.f1 <= i && m.fate === 'deliver');
          const recs = data.reduce((n, m) => n + (m.body ? m.body.records.length : 0), 0), byt = data.reduce((n, m) => n + m.bytes, 0);
          const c = st.counters;
          el2.appendChild(CK.section('Counters', h('div.ck-kv', h('span', h('b', CK.num(c.mapInput)), ' input records mapped'), h('span', h('b', CK.num(c.mapOutput)), ' pairs emitted'), h('span', h('b', CK.num(c.combined)), ' after the combiner'), h('span', h('b', CK.num(recs)), ' records shuffled'), h('span', h('b', CK.bytes(byt)), ' shuffled'), h('span', h('b', String(c.reexecuted)), ' tasks re-executed'))));
          if (st.phase === 'done') el2.appendChild(CK.section('Output (' + st.outN + ' keys)', h('ul.ck-loglist.wrap', st.out.slice(0, 14).map((kv) => h('li', outText(o, kv)))), st.outN > 14 ? h('p.ck-note', 'and ' + (st.outN - 14) + ' more') : null));
        },
      });
    }
    const B = (l, v) => h('span', l + ' ', h('b', String(v)));
    /** the task timeline, drawn at the panel's width (w) so that its text keeps its size */
    function gantt(st, f, rec, wids, w) {
      const W = Math.round(Math.max(300, Math.min(760, w || 520))), lane = 20, H = wids.length * lane + 22, L = 34;
      const t1 = Math.max(1, rec.frames[rec.last].t, f.t);
      const X = (t) => L + ((W - L - 6) * t) / t1;
      const svg = s('svg', { class: 'mr-gantt', viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': 'task timeline per worker' });
      wids.forEach((w, i) => { svg.appendChild(s('rect', { x: L, y: i * lane + 2, width: W - L - 6, height: lane - 4, class: 'lane', rx: 3, 'data-audit': 'group' })); svg.appendChild(s('text', { x: 2, y: i * lane + 14, text: w, class: 'lab' })); });
      for (const x of st.hist) {
        const i = wids.indexOf(x.worker); if (i < 0) continue;
        const end = x.end === null ? f.t : x.end;
        const g = s('g', {}, s('rect', { x: X(x.start), y: i * lane + 3, width: Math.max(1.5, X(end) - X(x.start)), height: lane - 6, class: 'bar ' + x.kind + (x.status === 'failed' || st.hist.some((y) => y.task === x.task && y.attempt > x.attempt) ? ' failed' : x.status === 'running' ? ' running' : '') }, s('title', { text: x.task + ' on ' + x.worker + ': ' + x.status + ', t ' + Math.round(x.start) + '–' + Math.round(end) })));
        if (X(end) - X(x.start) > 22) g.appendChild(s('text', { x: X(x.start) + 3, y: i * lane + 14, text: x.task, style: 'fill: #fff' }));
        svg.appendChild(g);
      }
      svg.appendChild(s('line', { x1: X(f.t), y1: 0, x2: X(f.t), y2: H - 18, class: 'now', 'data-audit': 'overlap-ok' }));
      svg.appendChild(s('text', { x: L, y: H - 4, text: 't 0', class: 'lab' }));
      svg.appendChild(s('text', { x: W - 6, y: H - 4, text: 't ' + Math.round(t1), class: 'lab', 'text-anchor': 'end' }));
      return h('div', svg, h('div.ck-legend', h('span', h('i.c0'), 'map'), h('span', h('i.c2'), 'reduce'), h('span', h('i', { style: { background: 'var(--bad)' } }), 'lost to a failure')));
    }
    function combinerBox() {
      const M = C().MapReduce;
      const job = jobOf(o);
      if (!job.combiner) return CK.section('The combiner', h('p.ck-note', 'A join has no combiner: every tagged row has to reach the reducer of its key.'));
      const on = M.run(jobOf(o), { workers: o.workers, seed: o.seed, combiner: true }), off = M.run(jobOf(o), { workers: o.workers, seed: o.seed, combiner: false });
      return CK.section('The combiner, on and off',
        CK.bars([{ label: 'records, with', value: on.stats.shuffleRecords, cls: 'c4' }, { label: 'records, without', value: off.stats.shuffleRecords, cls: 'c1' }]),
        CK.bars([{ label: 'bytes, with', value: on.stats.shuffleBytes, note: CK.bytes(on.stats.shuffleBytes), cls: 'c4' }, { label: 'bytes, without', value: off.stats.shuffleBytes, note: CK.bytes(off.stats.shuffleBytes), cls: 'c1' }]),
        h('p.ck-note', 'Without the combiner every emitted pair crosses the network (' + CK.num(off.stats.mapOutput) + ' of them); with it each map task sends one pair per key and partition. Same output either way: ' + (JSON.stringify(on.output) === JSON.stringify(off.output) ? 'yes' : 'no') + '.'));
    }

    // ---- Spark-style lineage ----
    function sparkBox() {
      const M = C().MapReduce, T = UI.CK.theatre().tables;
      const box = h('div');
      const sc = new M.Spark({ workers: Math.min(o.workers, 4) });
      let rdd, what;
      if (o.job === 'words') { const ti = T.production.cols.findIndex((c) => c.name === 'title'); rdd = sc.textFile(T.production.rows.map((r) => r[ti]), o.maps).flatMap((l) => String(l).toLowerCase().split(/[^a-z0-9']+/).filter(Boolean)).map((w) => [w, 1]).reduceByKey((a, b) => a + b); what = 'textFile → flatMap(words) → map(w ⇒ (w, 1)) → reduceByKey(+)'; }
      else if (o.job === 'join') { rdd = sc.parallelize(T.artist.rows, o.maps).filter((r) => r[1] !== null).map((r) => [r[1], r]).join(sc.parallelize(T.company.rows, 2).map((r) => [r[0], r]), o.R); what = 'artist.map(by company) join company.map(by company)'; }
      else { const t = o.job === 'group' ? T.artist : T.booking, gi = o.job === 'group' ? 1 : 2; rdd = sc.parallelize(t.rows, o.maps).filter((r) => r[gi] !== null).map((r) => [r[gi], 1]).reduceByKey((a, b) => a + b, o.R); what = 'parallelize → filter → map(row ⇒ (key, 1)) → reduceByKey(+)'; }
      sc.track(rdd);
      const r1 = rdd.run();
      let r2 = null;
      const draw = () => {
        box.innerHTML = '';
        const kids = [h('p.ck-note', 'In Spark the same job is a chain of operators on RDDs, evaluated lazily: ' + what + '. Narrow operators work partition by partition and are pipelined inside one stage; a wide one (reduceByKey, join) needs every parent partition, so it ends the stage with a shuffle. A lost partition is recomputed from this lineage.'), dagDraw(rdd)];
        const st = (r, label) => h('div.ck-box', h('h4', label), h('div.ck-kv', h('span', h('b', String(r.stats.tasks)), ' tasks'), h('span', h('b', CK.num(r.stats.shuffleRecords)), ' records fetched across workers'), h('span', h('b', String(r.stats.recomputed)), ' recomputed'), h('span', h('b', String(r.events.filter((e) => e.kind === 'shuffle-write').length)), ' shuffle files written')));
        kids.push(h('div.ck-cols', st(r1, 'first run'), r2 ? st(r2, 'after losing w2') : null));
        if (!r2) kids.push(h('div.dq-bar', UI.btn('crash', 'Lose worker w2 and run again', 'w2\'s shuffle files and cached partitions are gone', () => { sc.failWorker('w2'); r2 = rdd.run(); draw(); }, 'small')));
        else kids.push(CK.ok(JSON.stringify(r2.result.map((x) => JSON.stringify(x)).sort()) === JSON.stringify(r1.result.map((x) => JSON.stringify(x)).sort()), 'Only the shuffle files w2 held are written again (from recomputed parent partitions); the other workers\' files are reused, and the result is the same ' + UI.plural(r1.result.length, 'record') + '.'));
        box.appendChild(CK.section('The same job as a Spark lineage graph', ...kids));
      };
      draw();
      return box;
    }
    function dagDraw(rdd) {
      const stages = rdd.stages(), lin = rdd.lineage();
      const byId = new Map(lin.map((x) => [x.id, x]));
      const stageOf = new Map();
      stages.forEach((st, i) => st.rdds.forEach((id) => stageOf.set(id, i)));
      // stages in columns by how many shuffles lie before them; stages that feed the same later stage stand one above
      // the other, so that a wide dependency never passes over another stage's boxes
      const colW = 190, rowH = 34, top = 26, bw = 160, gap = 12;
      const col = stages.map(() => 0);
      stages.forEach((st, i) => { for (const id of st.rdds) for (const p of byId.get(id).parents) { const j = stageOf.get(p); if (j !== undefined && j !== i) col[i] = Math.max(col[i], col[j] + 1); } });
      const pos = new Map(), box = [], used = [];
      stages.forEach((st, i) => {
        const c = col[i], y0 = used[c] || 4, hh = top + st.rdds.length * rowH + 6;
        box[i] = { x: 4 + c * colW, y: y0, h: hh };
        st.rdds.forEach((id, j) => pos.set(id, { x: 10 + c * colW, y: y0 + top - 4 + j * rowH }));
        used[c] = y0 + hh + gap;
      });
      const H = Math.max(...used) - gap + 4, W = 10 + (Math.max(...col) + 1) * colW;
      // drawn at its own size: on a narrow screen the box scrolls rather than shrinking the text
      const svg = s('svg', { class: 'mr-dag', viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, role: 'img', 'aria-label': 'lineage graph in ' + stages.length + ' stages' });
      stages.forEach((st, i) => { const b = box[i]; svg.appendChild(s('rect', { x: b.x, y: b.y, width: colW - 14, height: b.h, rx: 8, class: 'stage', 'data-audit': 'group' })); svg.appendChild(s('text', { x: b.x + 8, y: b.y + 14, text: 'stage ' + i + (st.shuffle ? ', after a shuffle' : ''), class: 'lab' })); });
      for (const x of lin) for (const p of x.parents) {
        const a = pos.get(p), b = pos.get(x.id); if (!a || !b) continue;
        const wide = stageOf.get(p) !== stageOf.get(x.id);
        svg.appendChild(s('path', { d: wide ? 'M' + (a.x + bw) + ' ' + (a.y + 12) + ' C ' + (a.x + bw + 18) + ' ' + (a.y + 12) + ', ' + (b.x - 18) + ' ' + (b.y + 12) + ', ' + b.x + ' ' + (b.y + 12) : 'M' + (a.x + bw / 2) + ' ' + (a.y + 24) + ' L ' + (b.x + bw / 2) + ' ' + b.y, class: wide ? 'wide' : 'nar' }, s('title', { text: wide ? 'wide dependency: a shuffle' : 'narrow dependency' })));
      }
      for (const [id, p] of pos) {
        const x = byId.get(id);
        svg.appendChild(s('g', { class: 'rdd' + (x.cached ? ' cached' : '') }, s('rect', { x: p.x, y: p.y, width: bw, height: 24, rx: 6 }), s('text', { x: p.x + 8, y: p.y + 16, text: x.op + ' (' + x.partitions + ' parts)' })));
      }
      return h('div', { style: { overflowX: 'auto' } }, svg, h('div.ck-legend', h('span', h('i.line', { style: { background: 'var(--muted)' } }), 'narrow: pipelined'), h('span', h('i.line', { style: { background: 'var(--ck1)' } }), 'wide: shuffle')));
    }
    start();
    return {
      render() { if (stage) stage.redraw(); },
      destroy() { token++; if (stage) stage.destroy(); },
      set(k, v) { set(k, v); },
      get stage() { return stage; },
    };
  }
  UI.registerView({ id: 'mapreduce', title: 'MapReduce', icon: 'grid', group: 'Distributed', order: 62, create });
})(typeof window !== 'undefined' ? window : globalThis);
