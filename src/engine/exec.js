// The executor: one iterator per physical operator (the Volcano model: open, next, close), written as
// generators. A generator may also yield a WAIT signal when it must wait for a lock; signals pass up through
// every operator to the session, which parks the statement until the lock is granted.
(function (root) {
  'use strict';
  const K = root.K;
  const S = K.STATE;
  const T = () => K.T;
  const C = (e, layout) => K.Expr.compile(e, layout);

  const layoutOf = (cols) => new Map(cols.map((c, i) => [c.id, i]));
  const isSignal = (r) => r !== null && typeof r === 'object' && !Array.isArray(r) && r.signal;

  /** run a node: counts rows and loops (for EXPLAIN ANALYZE) and reports each row when tracing */
  function* run(n, ctx) {
    const rt = n.rt || (n.rt = { rows: 0, loops: 0, ms: 0, startups: 0, io: 0 });
    rt.loops++;
    const gen = OPS[n.op];
    if (!gen) throw K.err(S.internal, 'no executor for ' + n.op);
    const tracing = ctx.trace;
    if (tracing) ctx.trace.open(n);
    for (const r of gen(n, ctx)) {
      if (isSignal(r)) { yield r; continue; }
      rt.rows++;
      if (tracing) ctx.trace.row(n, r);
      yield r;
    }
    if (tracing) ctx.trace.close(n);
  }
  /** pull every row of a node into an array (passing signals up) */
  function* all(n, ctx) {
    const out = [];
    for (const r of run(n, ctx)) { if (isSignal(r)) { yield r; continue; } out.push(r); }
    return out;
  }
  /** run a plan to completion synchronously; a wait inside an expression's subquery restarts the statement */
  function drain(n, ctx) {
    const out = [];
    for (const r of run(n, ctx)) {
      if (isSignal(r)) { if (r.signal === 'wait') throw new K.WaitRestart(r); continue; }
      out.push(r);
    }
    return out;
  }
  class WaitRestart extends Error { constructor(sig) { super('wait'); this.sig = sig; } }
  K.WaitRestart = WaitRestart;

  // ---- scans --------------------------------------------------------------------------------------------------
  /** the output row of a scan: the table's columns, then the hidden system columns (ctid, xmin, xmax, tableoid) */
  function makeRow(n, vals, tid, h) {
    const cols = n.cols, row = new Array(cols.length);
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      if (c.attnum !== undefined) row[i] = vals[c.attnum];
      else if (c.sys === 'ctid') row[i] = '(' + tid.b + ',' + tid.o + ')';
      else if (c.sys === 'xmin') row[i] = BigInt(h.xmin);
      else if (c.sys === 'xmax') row[i] = BigInt(h.infomask & K.Tuple.IM.XMAX_INVALID ? 0 : h.xmax);
      else if (c.sys === 'tableoid') row[i] = n.rel.name;
      else row[i] = null;
    }
    row.tid = tid;
    row.rel = n.rel;
    return row;
  }
  function prepScan(n) {
    if (n.prepared) return;
    // system columns referenced by the query become extra output columns
    n.prepared = true;
    n.layout = layoutOf(n.cols);
    n.filterFn = n.filter ? C(n.filter, n.layout) : null;
  }
  const OPS = {};

  OPS.SeqScan = function* (n, ctx) {
    prepScan(n);
    const fast = ctx.cc.plain ? ctx.cc.plain(ctx) : false;
    // a protocol may lock the whole table (or its predicate) before reading it: phantoms, multiple granularity, SSI
    if (ctx.db.protocol && ctx.db.protocol.onScan) yield* ctx.db.protocol.onScan(n.rel, n, ctx);
    if (ctx.tx && ctx.tx.isolation === 'serializable' && K.SSI && K.SSI.onScan) yield* K.SSI.onScan(ctx.db, n.rel, n, ctx);
    const heap = ctx.db.heap(n.rel);
    const filter = n.filterFn;
    let sample = null;
    if (n.sample) sample = ctx.db.sampler(n.sample, ctx);
    for (const t of heap.scan(sample && sample.blocks ? { blocks: sample.blocks } : undefined)) {
      if (sample && !sample.keep(t.tid)) continue;
      const h = K.Tuple.header(t.bytes);
      const ok = fast ? ctx.cc.visibleNow(n.rel, t.tid, h, ctx) : yield* ctx.cc.visible(n.rel, t.tid, h, t.bytes, ctx);
      if (!ok) continue;
      const vals = K.Tuple.deform(t.bytes, n.rel.cols, ctx, n.need);
      const row = makeRow(n, vals, t.tid, h, ctx);
      if (filter && filter(row, ctx) !== true) continue;
      yield row;
    }
  };
  // index scans fetch the TIDs from the index, then each tuple from the heap
  OPS.IndexScan = function* (n, ctx) {
    prepScan(n);
    const fast = ctx.cc.plain ? ctx.cc.plain(ctx) : false;
    if (ctx.db.protocol && ctx.db.protocol.onIndexScan) yield* ctx.db.protocol.onIndexScan(n.rel, n, ctx);
    if (ctx.tx && ctx.tx.isolation === 'serializable' && K.SSI && K.SSI.onIndexScan) yield* K.SSI.onIndexScan(ctx.db, n.rel, n, ctx);
    const heap = ctx.db.heap(n.rel);
    const filter = n.filterFn;
    const am = ctx.db.indexAm(n.index);
    const bounds = n.bounds.map((b) => Object.assign({}, b, { v: Array.isArray(b.v) ? b.v.map((x) => C(x, n.layout)([], ctx)) : b.v ? C(b.v, n.layout)([], ctx) : undefined }));
    const seen = new Set();
    for (const tid of am.search(bounds, n.dir === 'backward')) {
      const key = tid.b + ':' + tid.o;
      if (n.bounds.some((b) => b.op === 'in')) { if (seen.has(key)) continue; seen.add(key); }
      const t = heap.fetch(tid);
      if (!t) continue;
      try {
        const h = K.Tuple.header(t.bytes);
        const ok = fast ? ctx.cc.visibleNow(n.rel, tid, h, ctx) : yield* ctx.cc.visible(n.rel, tid, h, t.bytes, ctx);
        if (!ok) continue;
        const vals = K.Tuple.deform(t.bytes, n.rel.cols, ctx, n.need);
        const row = makeRow(n, vals, tid, h, ctx);
        // the index condition is rechecked: the index may hold keys of versions this snapshot does not see
        if (!am.recheck(bounds, vals)) continue;
        if (filter && filter(row, ctx) !== true) continue;
        yield row;
      } finally { ctx.db.buffers.unpin(t.frame, false); }
    }
  };
  // an index-only scan reads values from the index; it still checks visibility (no visibility map here)
  OPS.IndexOnlyScan = function* (n, ctx) { yield* OPS.IndexScan(n, ctx); };
  // bitmap scan: TIDs from the index into a bitmap, then the heap block by block, each block read once
  OPS.BitmapScan = function* (n, ctx) {
    prepScan(n);
    const fast = ctx.cc.plain ? ctx.cc.plain(ctx) : false;
    for (const ix of n.indexes) {
      const info = { index: ix.index, bounds: ix.bounds, layout: n.layout };
      if (ctx.db.protocol && ctx.db.protocol.onIndexScan) yield* ctx.db.protocol.onIndexScan(n.rel, info, ctx);
      if (ctx.tx && ctx.tx.isolation === 'serializable' && K.SSI && K.SSI.onIndexScan) yield* K.SSI.onIndexScan(ctx.db, n.rel, info, ctx);
    }
    const heap = ctx.db.heap(n.rel);
    const filter = n.filterFn, recheck = n.recheck ? C(n.recheck, n.layout) : null;
    // each index gives a set of TIDs (block * 65536 + offset); BitmapAnd intersects them, BitmapOr unites them
    let tids = null;
    for (const ix of n.indexes) {
      const am = ctx.db.indexAm(ix.index);
      const bounds = ix.bounds.map((b) => Object.assign({}, b, { v: Array.isArray(b.v) ? b.v.map((x) => C(x, n.layout)([], ctx)) : b.v ? C(b.v, n.layout)([], ctx) : undefined }));
      if (n.bitmapOr && tids) { for (const tid of am.search(bounds)) tids.add(tid.b * 65536 + tid.o); continue; }
      const set = new Set();
      for (const tid of am.search(bounds)) if (!tids || tids.has(tid.b * 65536 + tid.o)) set.add(tid.b * 65536 + tid.o);
      tids = set;
    }
    const sorted = Float64Array.from(tids).sort();
    let nb = 0;
    for (let i = 0; i < sorted.length; i++) if (i === 0 || Math.floor(sorted[i] / 65536) !== Math.floor(sorted[i - 1] / 65536)) nb++;
    n.bitmap = { tids: sorted.length, blocks: nb };
    ctx.bus.emit('exec.bitmap', { rel: n.rel.name, tids: sorted.length, blocks: n.bitmap.blocks });
    for (const x of sorted) {
      const tid = { b: Math.floor(x / 65536), o: x % 65536 };
      const t = heap.fetch(tid);
      if (!t) continue;
      try {
        const h = K.Tuple.header(t.bytes);
        const ok = fast ? ctx.cc.visibleNow(n.rel, tid, h, ctx) : yield* ctx.cc.visible(n.rel, tid, h, t.bytes, ctx);
        if (!ok) continue;
        const row = makeRow(n, K.Tuple.deform(t.bytes, n.rel.cols, ctx, n.need), tid, h, ctx);
        if (recheck && recheck(row, ctx) !== true) continue;
        if (filter && filter(row, ctx) !== true) continue;
        yield row;
      } finally { ctx.db.buffers.unpin(t.frame, false); }
    }
  };
  OPS.Values = function* (n, ctx) {
    const fns = n.tuples.map((r) => r.map((e) => (e.k === 'default' ? () => K.DEFAULT : C(e, new Map()))));
    for (const r of fns) yield r.map((f) => f([], ctx));
  };
  OPS.Result = function* () { yield []; };
  OPS.Func = function* (n, ctx) { yield* ctx.db.srf.run(n, ctx); };
  OPS.SeqState = function* (n, ctx) { const s = ctx.db.seqState(n.rel); yield [s.last, 0n, s.called]; };
  OPS.Subquery = function* (n, ctx) { for (const r of run(n.children[0], ctx)) { if (isSignal(r)) { yield r; continue; } const vis = n.children[0].cols.filter((c) => !c.hidden).length; yield vis === r.length ? r : r.slice(0, vis); } };
  OPS.Filter = function* (n, ctx) {
    const f = C(n.cond, layoutOf(n.children[0].cols));
    for (const r of run(n.children[0], ctx)) { if (isSignal(r)) { yield r; continue; } if (f(r, ctx) === true) yield r; }
  };
  OPS.Project = function* (n, ctx) {
    const lay = layoutOf(n.children[0].cols);
    const fns = n.exprs.map((e) => C(e, lay));
    for (const r of run(n.children[0], ctx)) {
      if (isSignal(r)) { yield r; continue; }
      const out = new Array(fns.length);
      for (let i = 0; i < fns.length; i++) out[i] = fns[i](r, ctx);
      if (r.tid) { out.tid = r.tid; out.rel = r.rel; }
      yield out;
    }
  };

  /** a select list with set-returning functions: every input row gives as many rows as its longest function result */
  OPS.ProjectSet = function* (n, ctx) {
    const child = n.children[0];
    const lay = layoutOf(child.cols);
    if (!n.srfs) {
      n.srfs = [];
      const seen = new Set();
      const find = (x) => { if (!x || typeof x !== 'object') return; if (Array.isArray(x)) { x.forEach(find); return; } if (x.k === 'srfcall' && !seen.has(x.id)) { seen.add(x.id); n.srfs.push({ id: x.id, width: x.call.cols.length, func: { op: 'Func', calls: [Object.assign({}, x.call, { args: x.args, fns: undefined, scalar: x.call.scalar ? x.args[0] : undefined })], cols: x.call.cols, ordinality: false }, type: x.type }); } for (const k of ['l', 'r', 'e', 'a', 'b', 'items', 'args', 'whens', 'c', 'else', 'base']) if (x[k] && typeof x[k] === 'object' && x.k !== 'srfcall') find(x[k]); };
      find(n.exprs);
    }
    const fns = n.exprs.map((e) => C(e, lay));
    const ids = child.cols.map((c) => c.id);
    for (const r of run(child, ctx)) {
      if (isSignal(r)) { yield r; continue; }
      const outer = new Map(ctx.outer || []);
      ids.forEach((id, i) => outer.set(id, r[i]));
      const c2 = Object.assign({}, ctx, { outer });
      const results = n.srfs.map((s) => [...ctx.db.srf.run(s.func, c2)].map((row) => (s.width === 1 ? row[0] : new K.RowV(row, s.type))));
      const len = Math.max(0, ...results.map((x) => x.length));
      for (let i = 0; i < len; i++) {
        const vals = new Map(n.srfs.map((s, k) => [s.id, i < results[k].length ? results[k][i] : null]));
        const c3 = Object.assign({}, ctx, { srfVals: vals });
        yield fns.map((f) => f(r, c3));
      }
    }
  };

  // ---- joins ----------------------------------------------------------------------------------------------------
  const nulls = (n) => new Array(n).fill(null);
  /** the shared parts of a join: compiled condition on the concatenated row, and the outer-join padding */
  function joinPrep(n) {
    const [l, r] = n.children;
    const lay = layoutOf(l.cols.concat(r.cols));
    return { l, r, lw: l.cols.length, rw: r.cols.length, cond: n.cond ? C(n.cond, lay) : null, rest: n.restCond ? C(n.restCond, lay) : null, lay };
  }
  function emitJoin(jt, lr, rr) { return jt === 'semi' || jt === 'anti' ? lr : lr.concat(rr); }
  OPS.NestLoopJoin = function* (n, ctx) {
    const j = joinPrep(n);
    const jt = n.jtype;
    if (n.lateral) {
      // the right side reads the left row's columns: run it again for every left row
      const lids = j.l.cols.map((c) => c.id);
      for (const lr of run(j.l, ctx)) {
        if (isSignal(lr)) { yield lr; continue; }
        const outer = new Map(ctx.outer || []);
        lids.forEach((id, i) => outer.set(id, lr[i]));
        const c2 = Object.assign({}, ctx, { outer, cteCache: ctx.cteCache });
        c2.subplan = (m, r2, l2) => ctx.session.subplan(c2, m, r2, l2);
        let matched = false;
        for (const rr of run(j.r, c2)) {
          if (isSignal(rr)) { yield rr; continue; }
          const row = lr.concat(rr);
          if (j.cond && j.cond(row, c2) !== true) continue;
          matched = true;
          if (jt === 'semi') { yield lr; break; }
          if (jt === 'anti') break;
          yield row;
        }
        if (!matched && jt === 'left') yield lr.concat(nulls(j.rw));
        if (!matched && jt === 'anti') yield lr;
      }
      return;
    }
    // the plain nested loop: a base table on the inner side is scanned again for every outer row (its pages
    // come from the buffer pool or the disk each time); anything else is computed once and kept in memory
    const scanOf = (x) => (/Scan$/.test(x.op) && x.rel ? x : x.op === 'Filter' ? scanOf(x.children[0]) : null);
    const rescan = !!scanOf(j.r) && !(ctx.db.settingsOf(ctx).nestloop_materialize);
    const inner = rescan ? null : yield* all(j.r, ctx);
    let innerLen = inner ? inner.length : 0;
    const innerMatched = jt === 'right' || jt === 'full' ? [] : null;
    for (const lr of run(j.l, ctx)) {
      if (isSignal(lr)) { yield lr; continue; }
      let matched = false;
      const rows = rescan ? yield* all(j.r, ctx) : inner;
      innerLen = rows.length;
      for (let i = 0; i < rows.length; i++) {
        const rr = rows[i];
        const row = lr.concat(rr);
        if (j.cond && j.cond(row, ctx) !== true) continue;
        matched = true;
        if (innerMatched) innerMatched[i] = 1;
        if (jt === 'anti') break;
        if (jt === 'semi') { yield lr; break; }
        yield row;
      }
      if (!matched && (jt === 'left' || jt === 'full')) yield lr.concat(nulls(j.rw));
      if (!matched && jt === 'anti') yield lr;
    }
    if (innerMatched) { const last = inner || (yield* all(j.r, ctx)); for (let i = 0; i < last.length; i++) if (!innerMatched[i]) yield nulls(j.lw).concat(last[i]); }
    void innerLen;
  };
  /** block nested loop: read a block of outer rows, then scan the inner once for the whole block */
  OPS.BlockNestLoopJoin = function* (n, ctx) {
    const j = joinPrep(n);
    const jt = n.jtype;
    const perBlock = Math.max(1, (n.blockPages || 4) * Math.floor(ctx.db.disk.pageSize / Math.max(32, j.lw * 12)));
    const innerMatched = jt === 'right' || jt === 'full' ? new Map() : null;
    let block = [];
    let blockNo = 0;
    const flush = function* () {
      blockNo++;
      ctx.bus.emit('exec.block', { node: n, block: blockNo, rows: block.length });
      const matched = new Uint8Array(block.length);
      let i = 0;
      for (const rr of run(j.r, ctx)) {
        if (isSignal(rr)) { yield rr; continue; }
        const key = i++;
        for (let b = 0; b < block.length; b++) {
          const row = block[b].concat(rr);
          if (j.cond && j.cond(row, ctx) !== true) continue;
          if (innerMatched) innerMatched.set(key, rr);
          if (jt === 'semi' || jt === 'anti') { matched[b] = 1; continue; }
          matched[b] = 1;
          yield row;
        }
      }
      for (let b = 0; b < block.length; b++) {
        if (jt === 'semi' && matched[b]) yield block[b];
        if (!matched[b] && (jt === 'left' || jt === 'full')) yield block[b].concat(nulls(j.rw));
        if (!matched[b] && jt === 'anti') yield block[b];
      }
      block = [];
    };
    for (const lr of run(j.l, ctx)) {
      if (isSignal(lr)) { yield lr; continue; }
      block.push(lr);
      if (block.length >= perBlock) yield* flush();
    }
    if (block.length) yield* flush();
    if (innerMatched) {
      let i = 0;
      for (const rr of run(j.r, ctx)) { if (isSignal(rr)) { yield rr; continue; } if (!innerMatched.has(i++)) yield nulls(j.lw).concat(rr); }
    }
  };
  /** indexed nested loop: for each outer row, look the key up in the inner relation's index */
  OPS.IndexNestLoopJoin = function* (n, ctx) {
    const j = joinPrep(n);
    const jt = n.jtype;
    const r = j.r;
    const rel = r.rel;
    const heap = ctx.db.heap(rel);
    const am = ctx.db.indexAm(n.index);
    const keyFn = C(n.indexKey.l, layoutOf(j.l.cols));
    const rlay = layoutOf(r.cols);
    const innerFilter = n.innerFilter ? C(n.innerFilter, rlay) : null;
    const rest = n.restCond ? C(n.restCond, j.lay) : null;
    for (const lr of run(j.l, ctx)) {
      if (isSignal(lr)) { yield lr; continue; }
      const k = keyFn(lr, ctx);
      let matched = false;
      if (k !== null) {
        for (const tid of am.search([{ k: 0, op: '=', v: T().cast(k, n.indexKey.l.type, n.index.keyTypes[0], false, ctx) }])) {
          const t = heap.fetch(tid);
          if (!t) continue;
          let row = null;
          try {
            const h = K.Tuple.header(t.bytes);
            const ok = yield* ctx.cc.visible(rel, tid, h, t.bytes, ctx);
            if (!ok) continue;
            const vals = K.Tuple.deform(t.bytes, rel.cols, ctx);
            if (!am.recheck([{ k: 0, op: '=', v: T().cast(k, n.indexKey.l.type, n.index.keyTypes[0], false, ctx) }], vals)) continue;
            const rr = makeRow(r, vals, tid, h, ctx);
            if (innerFilter && innerFilter(rr, ctx) !== true) continue;
            row = lr.concat(rr);
          } finally { ctx.db.buffers.unpin(t.frame, false); }
          if (rest && rest(row, ctx) !== true) continue;
          matched = true;
          if (jt === 'semi') { yield lr; break; }
          if (jt === 'anti') break;
          yield row;
        }
      }
      if (!matched && jt === 'left') yield lr.concat(nulls(j.rw));
      if (!matched && jt === 'anti') yield lr;
    }
  };
  /** a hash key for join and grouping values: values equal under the comparison type get equal keys */
  function hashKey(vals, types) {
    let k = '';
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i];
      const t = types && types[i];
      k += (t && t.id === 'char' && typeof v === 'string' ? 's' + v.replace(/ +$/, '') : t && t.cat === 'N' && v !== null && typeof v !== 'number' ? K.Decimal.of(v).key() : t && t.cat === 'N' && typeof v === 'number' && !t.float ? 'd' + v + 'e0' : K.keyOf(v)) + '\u0001';
    }
    return k;
  }
  K.hashKey = hashKey;
  /** hash join: build a hash table on the inner (right) input, probe it with each outer row */
  OPS.HashJoin = function* (n, ctx) {
    const j = joinPrep(n);
    const jt = n.jtype;
    const llay = layoutOf(j.l.cols), rlay = layoutOf(j.r.cols);
    const lk = n.keys.map((k) => C(k.l, llay)), rk = n.keys.map((k) => C(k.r, rlay));
    const types = n.keys.map((k) => k.ctype);
    const table = new Map();
    const inner = [];
    let buckets = 0;
    for (const rr of run(j.r, ctx)) {
      if (isSignal(rr)) { yield rr; continue; }
      inner.push(rr);
      const kv = rk.map((f) => f(rr, ctx));
      if (kv.some((v) => v === null)) continue;
      const key = hashKey(kv, types);
      let b = table.get(key);
      if (!b) { b = []; table.set(key, b); buckets++; }
      b.push(inner.length - 1);
    }
    // a build input larger than work memory is partitioned first: both inputs are written to partition files
    // and read back, partition by partition (the probe side's pages are counted once it has been read)
    const M = workMem(ctx), br = pagesOf(inner.length, j.r.cols, ctx);
    const parts = br > M ? Math.ceil(br / M) : 0;
    let probeRows = 0;
    if (parts) for (let p = 0; p < parts; p++) { ctx.db.disk.temp('write', Math.ceil(br / parts), 'hash partition'); }
    n.hashInfo = { rows: inner.length, buckets, partitions: parts, pages: br };
    ctx.bus.emit('exec.hashbuilt', { node: n, rows: inner.length, buckets });
    const matched = jt === 'right' || jt === 'full' ? new Uint8Array(inner.length) : null;
    for (const lr of run(j.l, ctx)) {
      if (isSignal(lr)) { yield lr; continue; }
      probeRows++;
      const kv = lk.map((f) => f(lr, ctx));
      let any = false;
      if (!kv.some((v) => v === null)) {
        const b = table.get(hashKey(kv, types));
        if (b) for (const i of b) {
          const row = lr.concat(inner[i]);
          if (j.rest && j.rest(row, ctx) !== true) continue;
          any = true;
          if (matched) matched[i] = 1;
          if (jt === 'semi' || jt === 'anti') break;
          yield row;
        }
      }
      if (jt === 'semi' && any) yield lr;
      if (!any && (jt === 'left' || jt === 'full')) yield lr.concat(nulls(j.rw));
      if (!any && jt === 'anti') yield lr;
    }
    if (matched) for (let i = 0; i < inner.length; i++) if (!matched[i]) yield nulls(j.lw).concat(inner[i]);
    if (parts) {
      const bl = pagesOf(probeRows, j.l.cols, ctx);
      for (let p = 0; p < parts; p++) { ctx.db.disk.temp('write', Math.ceil(bl / parts), 'hash partition'); ctx.db.disk.temp('read', Math.ceil(br / parts), 'hash partition'); ctx.db.disk.temp('read', Math.ceil(bl / parts), 'hash partition'); }
      n.hashInfo.spill = { partitions: parts, pagesWritten: parts * (Math.ceil(br / parts) + Math.ceil(bl / parts)), pagesRead: parts * (Math.ceil(br / parts) + Math.ceil(bl / parts)) };
    }
  };
  /** merge join: sort both inputs on the keys, then advance through them together */
  OPS.MergeJoin = function* (n, ctx) {
    const j = joinPrep(n);
    const jt = n.jtype;
    const llay = layoutOf(j.l.cols), rlay = layoutOf(j.r.cols);
    const lk = n.keys.map((k) => C(k.l, llay)), rk = n.keys.map((k) => C(k.r, rlay));
    const types = n.keys.map((k) => k.ctype);
    const keyed = (rows, fns) => rows.map((r) => ({ r, k: fns.map((f) => f(r, ctx)) }));
    const cmpK = (a, b) => { for (let i = 0; i < a.length; i++) { if (a[i] === null || b[i] === null) return a[i] === null ? (b[i] === null ? 0 : 1) : -1; const c = T().compare(a[i], b[i], types[i]); if (c) return c; } return 0; };
    // an input the plan already sorts (a Sort below, or an index scan in key order) is not sorted again
    const L = keyed(yield* all(j.l, ctx), lk), R = keyed(yield* all(j.r, ctx), rk);
    if (!n.sortedL) L.sort((a, b) => cmpK(a.k, b.k));
    if (!n.sortedR) R.sort((a, b) => cmpK(a.k, b.k));
    ctx.bus.emit('exec.mergesorted', { node: n, left: L.length, right: R.length });
    const rMatched = new Uint8Array(R.length);
    let i = 0, k = 0;
    while (i < L.length) {
      const a = L[i];
      if (a.k.some((v) => v === null)) { if (jt === 'left' || jt === 'full') yield a.r.concat(nulls(j.rw)); i++; continue; }
      while (k < R.length && (R[k].k.some((v) => v === null) || cmpK(R[k].k, a.k) < 0)) k++;
      // the group of right rows with this key
      let e = k;
      while (e < R.length && !R[e].k.some((v) => v === null) && cmpK(R[e].k, a.k) === 0) e++;
      // every left row with the same key joins the same group
      let i2 = i;
      while (i2 < L.length && !L[i2].k.some((v) => v === null) && cmpK(L[i2].k, a.k) === 0) {
        let any = false;
        for (let m = k; m < e; m++) {
          const row = L[i2].r.concat(R[m].r);
          if (j.rest && j.rest(row, ctx) !== true) continue;
          any = true; rMatched[m] = 1;
          yield row;
        }
        if (!any && (jt === 'left' || jt === 'full')) yield L[i2].r.concat(nulls(j.rw));
        i2++;
      }
      i = i2;
    }
    if (jt === 'right' || jt === 'full') for (let m = 0; m < R.length; m++) if (!rMatched[m]) yield nulls(j.lw).concat(R[m].r);
  };

  // ---- sorting -------------------------------------------------------------------------------------------------------
  function sortCmp(keys, lay) {
    const idx = keys.map((k) => lay.get(k.id));
    return (a, b) => {
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i], x = a[idx[i]], y = b[idx[i]];
        if (x === null || y === null) {
          if (x === y) continue;
          const nullFirst = k.nulls === 'first';
          return x === null ? (nullFirst ? -1 : 1) : (nullFirst ? 1 : -1);
        }
        let c = T().compare(x, y, k.type);
        if (k.dir === 'desc') c = -c;
        if (c) return c;
      }
      return 0;
    };
  }
  K.sortCmp = sortCmp;
  /** the pages a set of rows fills (the planner's width estimate), and the work memory M in pages */
  // (a context without a disk, as in a bare evaluator, never spills)
  const pagesOf = (rows, cols, ctx) => (ctx.db && ctx.db.disk ? Math.max(1, Math.ceil((rows * (cols.length * 8 + 24)) / (ctx.db.disk.pageSize * 0.9))) : 0);
  const workMem = (ctx) => Math.max(3, (ctx.db && ctx.db.settingsOf ? ctx.db.settingsOf(ctx).work_mem_pages : 0) || 32);
  OPS.Sort = function* (n, ctx) {
    const rows = yield* all(n.children[0], ctx);
    const cmp = sortCmp(n.keys, layoutOf(n.children[0].cols));
    // a stable sort, so equal keys keep their input order
    const sorted = rows.map((r, i) => [r, i]).sort((a, b) => cmp(a[0], b[0]) || a[1] - b[1]).map((x) => x[0]);
    // more pages than work memory: external sort-merge. Its runs go to temporary files: each run is
    // written once, then every merge pass reads all of them (and writes the merged runs, except the last pass)
    const b = pagesOf(rows.length, n.cols, ctx), M = workMem(ctx);
    let spill = null;
    if (b > M) {
      let runs = Math.ceil(b / M), passes = 0, written = 0, read = 0;
      for (let r = 0; r < runs; r++) { const p = Math.min(M, b - r * M); ctx.db.disk.temp('write', p, 'sort run'); written += p; }
      while (runs > 1) {
        const next = Math.ceil(runs / (M - 1));
        for (let r = 0; r < runs; r++) { const p = Math.min(M * Math.pow(M - 1, passes), b - r * M * Math.pow(M - 1, passes)); ctx.db.disk.temp('read', p, 'sort merge'); read += p; }
        if (next > 1) { ctx.db.disk.temp('write', b, 'sort merge'); written += b; }
        runs = next; passes++;
      }
      spill = { runs: Math.ceil(b / M), passes, pagesWritten: written, pagesRead: read };
    }
    n.sortInfo = { rows: rows.length, alg: spill ? 'external merge' : 'quicksort', runs: spill ? spill.runs : 1, passes: spill ? spill.passes : 0, pages: b, spill };
    for (const r of sorted) yield r;
  };

  // ---- aggregation ---------------------------------------------------------------------------------------------------
  /** a running aggregate: state per group, with DISTINCT and ORDER BY inside the call handled by collecting inputs */
  function aggRunner(a, lay, ctx) {
    const args = a.args.map((e) => C(e, lay));
    const filter = a.filter ? C(a.filter, lay) : null;
    const order = a.order ? a.order.map((o) => ({ f: C(o.e, lay), dir: o.dir, nulls: o.nulls, type: o.e.type })) : null;
    const within = a.within ? a.within.map((o) => ({ f: C(o.e, lay), dir: o.dir, nulls: o.nulls, type: o.e.type })) : null;
    const def = a.def;
    const collect = a.distinct || order || within || def.collect;
    return {
      init() { return collect ? { items: [] } : { st: def.init ? def.init(a) : null }; },
      step(s, row) {
        if (filter && filter(row, ctx) !== true) return;
        const vals = args.map((f) => f(row, ctx));
        if (a.star) vals.length = 0;
        if (collect) { s.items.push({ vals, keys: (order || within || []).map((o) => o.f(row, ctx)) }); return; }
        if (def.strict !== false && vals.some((v) => v === null)) return;
        s.st = def.step(s.st, vals, ctx, a);
      },
      final(s) {
        if (collect) {
          let items = s.items;
          const ord = order || within;
          if (ord) items = items.map((x, i) => [x, i]).sort((p, q) => { for (let k = 0; k < ord.length; k++) { const x = p[0].keys[k], y = q[0].keys[k]; if (x === null || y === null) { if (x === y) continue; return (x === null) === (ord[k].nulls === 'first') ? -1 : 1; } let c = T().compare(x, y, ord[k].type); if (ord[k].dir === 'desc') c = -c; if (c) return c; } return p[1] - q[1]; }).map((p) => p[0]);
          // DISTINCT sorts its input, so an aggregate without ORDER BY sees the values in ascending order
          else if (a.distinct) items = items.slice().sort((p, q) => { for (let k = 0; k < p.vals.length; k++) { const x = p.vals[k], y = q.vals[k]; if (x === null || y === null) { if (x === y) continue; return x === null ? 1 : -1; } const c = T().compare(x, y, a.args[k].type); if (c) return c; } return 0; });
          if (a.distinct) { const seen = new Set(); items = items.filter((x) => { const k = hashKey(x.vals, a.args.map((e) => e.type)); if (seen.has(k)) return false; seen.add(k); return true; }); }
          if (within) return def.finalOrdered(items.map((x) => x.keys[0]), args.length ? items.length && items[0].vals : [], ctx, a, items);
          let st = def.init ? def.init(a) : null;
          for (const x of items) { if (def.strict !== false && x.vals.some((v) => v === null)) continue; st = def.step(st, x.vals, ctx, a); }
          return def.final ? def.final(st, ctx, a) : st;
        }
        return def.final ? def.final(s.st, ctx, a) : s.st;
      },
    };
  }
  K.aggRunner = aggRunner;
  OPS.Aggregate = function* (n, ctx) {
    const lay = layoutOf(n.children[0].cols);
    const gfns = n.groups.map((g) => C(g.e, lay));
    const gtypes = n.groups.map((g) => g.e.type);
    const runners = n.aggs.map((a) => (a.udf ? ctx.db.udfAgg(a, lay, ctx) : aggRunner(a, lay, ctx)));
    const sets = n.sets || [n.groups.map((_, i) => i)];
    // one hash table per grouping set
    const tables = sets.map(() => new Map());
    let any = false;
    for (const r of run(n.children[0], ctx)) {
      if (isSignal(r)) { yield r; continue; }
      any = true;
      const gv = gfns.map((f) => f(r, ctx));
      sets.forEach((set, si) => {
        const keyVals = set.map((i) => gv[i]);
        const key = hashKey(keyVals, set.map((i) => gtypes[i]));
        let g = tables[si].get(key);
        if (!g) { g = { gv, states: runners.map((x) => x.init()) }; tables[si].set(key, g); }
        runners.forEach((x, i) => x.step(g.states[i], r));
      });
    }
    for (let si = 0; si < sets.length; si++) {
      const set = new Set(sets[si]);
      // with no GROUP BY (or an empty grouping set) there is always one result row, even over no input
      if (!tables[si].size && (!n.groups.length || !sets[si].length) && (!any || !n.groups.length || !sets[si].length)) {
        if (n.groups.length && any) continue;
        tables[si].set('', { gv: n.groups.map(() => null), states: runners.map((x) => x.init()) });
      }
      const groupIds = new Set([...set].map((i) => n.groups[i].id));
      for (const g of tables[si].values()) {
        const out = n.groups.map((_, i) => (set.has(i) ? g.gv[i] : null)).concat(runners.map((x, i) => x.final(g.states[i])));
        if (n.sets) out.groupingSet = groupIds;
        yield out;
      }
    }
  };

  // ---- windows ----------------------------------------------------------------------------------------------------------
  OPS.Window = function* (n, ctx) { yield* ctx.db.windows.run(n, ctx, run, all, layoutOf); };

  // ---- distinct, limit, set operations ---------------------------------------------------------------------------------
  OPS.Distinct = function* (n, ctx) {
    const lay = layoutOf(n.children[0].cols);
    const types = n.children[0].cols.map((c) => c.type);
    const seen = new Set();
    if (n.on) {
      // DISTINCT ON: the first row of each group, in ORDER BY order (the input is sorted)
      const idx = n.on.map((id) => lay.get(id));
      for (const r of run(n.children[0], ctx)) {
        if (isSignal(r)) { yield r; continue; }
        const k = hashKey(idx.map((i) => r[i]), idx.map((i) => types[i]));
        if (seen.has(k)) continue;
        seen.add(k);
        yield r;
      }
      return;
    }
    const vis = n.cols.filter((c) => !c.hidden).length;
    for (const r of run(n.children[0], ctx)) {
      if (isSignal(r)) { yield r; continue; }
      const k = hashKey(r.slice(0, vis), types);
      if (seen.has(k)) continue;
      seen.add(k);
      yield r;
    }
  };
  OPS.Limit = function* (n, ctx) {
    const lim = n.limit ? C(n.limit, new Map())([], ctx) : null;
    const off = n.offset ? C(n.offset, new Map())([], ctx) : null;
    if (lim !== null && lim < 0) throw K.err('2201W', 'LIMIT must not be negative');
    if (off !== null && off < 0) throw K.err('2201X', 'OFFSET must not be negative');
    const L = lim === null ? Infinity : Number(lim), O = off === null ? 0 : Number(off);
    if (L === 0 && !n.withTies) return;
    let i = 0, out = 0, last = null;
    const cmp = n.withTies && n.sortKeys ? sortCmp(n.sortKeys.map((o) => ({ id: o.id, dir: o.dir, nulls: o.nulls || (o.dir === 'desc' ? 'first' : 'last'), type: (n.cols.find((c) => c.id === o.id) || {}).type })), layoutOf(n.children[0].cols)) : null;
    for (const r of run(n.children[0], ctx)) {
      if (isSignal(r)) { yield r; continue; }
      if (i++ < O) continue;
      if (out >= L) { if (cmp && last && cmp(last, r) === 0) { yield r; continue; } break; }
      out++; last = r;
      yield r;
      // stop without pulling another row (a row lock below must not be taken for a row not returned)
      if (out >= L && !cmp) return;
    }
  };
  OPS.SetOp = function* (n, ctx) {
    const [a, b] = n.children;
    const types = n.cols.map((c) => c.type);
    const op = n.setop, allRows = n.all;
    if (op === 'union') {
      const seen = allRows ? null : new Set();
      for (const side of [a, b]) for (const r of run(side, ctx)) {
        if (isSignal(r)) { yield r; continue; }
        if (seen) { const k = hashKey(r, types); if (seen.has(k)) continue; seen.add(k); }
        yield r;
      }
      return;
    }
    // INTERSECT and EXCEPT: count the right side's rows by key
    const counts = new Map();
    for (const r of run(b, ctx)) { if (isSignal(r)) { yield r; continue; } const k = hashKey(r, types); counts.set(k, (counts.get(k) || 0) + 1); }
    const emitted = new Map();
    for (const r of run(a, ctx)) {
      if (isSignal(r)) { yield r; continue; }
      const k = hashKey(r, types);
      const c = counts.get(k) || 0;
      if (op === 'intersect') {
        if (allRows) { if (c > 0) { counts.set(k, c - 1); yield r; } }
        else if (c > 0 && !emitted.has(k)) { emitted.set(k, 1); yield r; }
      } else {
        if (allRows) { if (c > 0) counts.set(k, c - 1); else yield r; }
        else if (c === 0 && !emitted.has(k)) { emitted.set(k, 1); yield r; }
      }
    }
  };

  // ---- common table expressions -----------------------------------------------------------------------------------------
  /**
   * a CTE is computed once per statement and shared by every reference to it; it is read lazily, so a
   * reference that stops early (LIMIT) stops an endless recursive CTE too
   */
  function* pullCte(st) {
    const x = st.it.next();
    if (x.done) st.done = true; else if (isSignal(x.value)) yield x.value; else st.rows.push(x.value);
  }
  OPS.CteScan = function* (n, ctx) {
    const cte = n.cte;
    let st = ctx.cteCache.get(cte);
    if (!st) { st = { rows: [], it: run(cte.phys || cte.plan, ctx), done: false }; ctx.cteCache.set(cte, st); }
    for (let i = 0; ; i++) {
      while (i >= st.rows.length && !st.done) yield* pullCte(st);
      if (i >= st.rows.length) return;
      yield st.rows[i];
    }
  };
  OPS.WorkTable = function* (n, ctx) { for (const r of ctx.workTables.get(n.cte) || []) yield r; };
  /** WITH RECURSIVE: start from the non-recursive term, then run the recursive term on the newest rows until none appear */
  OPS.RecursiveUnion = function* (n, ctx) {
    const [base, rec] = n.children;
    const types = n.cols.map((c) => c.type);
    const seen = n.all ? null : new Set();
    let work = [];
    let iter = 0;
    // SEARCH / CYCLE columns: computed from the row's keys and its parent's values (which the recursive term carries)
    const sc = n.search || n.cycle;
    const same = (a, b, ft) => a.values.every((v, i) => v !== null && b.values[i] !== null && T().compare(v, b.values[i], ft[i].type) === 0);
    const extend = (r, parent) => {
      const out = r.slice(0, n.nOrig);
      let cyc = false;
      if (n.search) {
        const k = n.search.keys.map((i) => r[i]);
        const prev = parent ? r[n.nOrig] : null;
        out.push(n.search.depth ? new K.ArrayV((prev ? prev.items : []).concat([new K.RowV(k, n.search.keyType)])) : new K.RowV([prev ? prev.values[0] + 1n : 0n].concat(k), n.search.type));
      }
      if (n.cycle) {
        const key = new K.RowV(n.cycle.keys.map((i) => r[i]), n.cycle.keyType);
        const path = parent ? r[r.length - 1].items : [];
        cyc = path.some((x) => same(x, key, n.cycle.keyType.fields));
        out.push(cyc ? n.cycle.mark : n.cycle.def, new K.ArrayV(path.concat([key])));
      }
      return { row: out, cyc };
    };
    for (let r of run(base, ctx)) {
      if (isSignal(r)) { yield r; continue; }
      if (sc) r = extend(r, false).row;
      if (seen) { const k = hashKey(r, types); if (seen.has(k)) continue; seen.add(k); }
      work.push(r);
      yield r;
    }
    const limit = ctx.db.settingsOf(ctx).max_recursion || 10000;
    while (work.length) {
      iter++;
      if (iter > limit) throw K.err('54001', 'recursive query "' + n.cte.name + '" ran ' + limit + ' iterations: is it missing a stopping condition? (Settings: max_recursion)');
      ctx.workTables.set(n.cte, work);
      ctx.bus.emit('exec.recursion', { cte: n.cte.name, iteration: iter, rows: work.length });
      const next = [];
      const out = yield* all(rec, ctx);
      for (let r of out) {
        let cyc = false;
        if (sc) ({ row: r, cyc } = extend(r, true));
        if (seen) { const k = hashKey(r, types); if (seen.has(k)) continue; seen.add(k); }
        // a row that closes a cycle is returned but not followed
        if (!cyc) next.push(r);
        yield r;
      }
      work = next;
    }
    n.iterations = iter;
  };

  OPS.LockRows = function* (n, ctx) {
    for (const r of run(n.children[0], ctx)) {
      if (isSignal(r)) { yield r; continue; }
      if (r.tid && r.rel) { const ok = yield* ctx.cc.lockRow(r.rel, r.tid, n.locking[0], ctx); if (!ok) continue; }
      yield r;
    }
  };
  OPS.Modify = function* (n, ctx) { yield* ctx.db.dml.run(n, ctx, run); };

  K.Exec = { run, all, drain, pullCte, OPS, layoutOf, isSignal, hashKey, sortCmp };
})(typeof window !== 'undefined' ? window : globalThis);
