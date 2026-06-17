// Window functions and the window executor. The input is read whole; for each distinct window (PARTITION BY and
// ORDER BY) the rows are sorted, split into partitions and peer groups, and each window function is computed
// over its frame (ROWS, RANGE or GROUPS, with EXCLUDE). Windows are evaluated in the order PostgreSQL's planner
// chooses, so that the rows come out in the order of the last sort, as they do there.
// The database object sets db.windows = K.Windows.
(function (root) {
  'use strict';
  const K = root.K;
  const S = K.STATE;
  const B = () => K.T.BASE;
  const D = () => K.Decimal;
  const base = (t) => (t && t.domain ? t.base : t);
  const win = (name, def) => K.F.win(name, def);
  const werr = (msg) => K.err(S.windowingError, msg);

  // ---- the window functions -----------------------------------------------------------------------------------
  // run(P, w, ctx) returns the values of one partition, in its sorted order. P describes the partition:
  // size, arg(k, j), peerStart(j), peerEnd(j), group(j), frame(j) (the positions in row j's frame).
  const noArgs = (ret) => (types) => (types.length ? null : { argTypes: [], ret: B()[ret] });
  const each = (P, f) => { const out = new Array(P.size); for (let j = 0; j < P.size; j++) out[j] = f(j); return out; };

  win('row_number', { resolve: noArgs('int8'), run: (P) => each(P, (j) => BigInt(j + 1)) });
  win('rank', { resolve: noArgs('int8'), run: (P) => each(P, (j) => BigInt(P.peerStart(j) + 1)) });
  win('dense_rank', { resolve: noArgs('int8'), run: (P) => each(P, (j) => BigInt(P.group(j) + 1)) });
  win('percent_rank', { resolve: noArgs('float8'), run: (P) => each(P, (j) => (P.size > 1 ? P.peerStart(j) / (P.size - 1) : 0)) });
  win('cume_dist', { resolve: noArgs('float8'), run: (P) => each(P, (j) => (P.peerEnd(j) + 1) / P.size) });
  win('ntile', {
    resolve: (types) => (types.length === 1 ? { argTypes: [B().int4], ret: B().int4 } : null),
    run(P) {
      const k = P.size ? P.arg(0, 0) : null;
      if (k === null) return each(P, () => null);
      if (k <= 0) throw K.err('22014', 'argument of ntile must be greater than zero');
      // PostgreSQL's ntile: the first (size % k) buckets get one row more
      const out = new Array(P.size);
      let tile = 1, inBucket = 0, boundary = Math.floor(P.size / k), rem = 0;
      if (boundary <= 0) boundary = 1; else { rem = P.size % k; if (rem) boundary++; }
      for (let j = 0; j < P.size; j++) {
        inBucket++;
        if (boundary < inBucket) {
          if (rem && tile === rem) { rem = 0; boundary--; }
          tile++; inBucket = 1;
        }
        out[j] = tile;
      }
      return out;
    },
  });

  function lagLead(sign) {
    return {
      resolve(types) {
        if (types.length < 1 || types.length > 3) return null;
        let t = !types[0] || types[0].cat === 'P' ? null : types[0];
        if (types.length === 3) t = K.T.common([types[0], types[2]], (sign < 0 ? 'lag' : 'lead') + ' types');
        if (!t) t = B().text;
        // the result has the argument's type without its modifier, so a default of 0 stays 0, not 0.00
        if (types.length === 3 && (t.cat === 'N' || t.cat === 'S') && !t.domain && B()[t.id]) t = B()[t.id];
        const want = [t, B().int4, t].slice(0, types.length);
        return { argTypes: want, ret: t };
      },
      run(P, w) {
        const ignore = w.nulls === 'ignore';
        return each(P, (j) => {
          const off = w.args.length > 1 ? P.arg(1, j) : 1;
          if (off === null) return null;
          const dflt = () => (w.args.length > 2 ? P.arg(2, j) : null);
          if (!ignore) {
            const t = j + sign * off;
            return t >= 0 && t < P.size ? P.arg(0, t) : dflt();
          }
          // IGNORE NULLS: count only rows whose value is not null
          if (off === 0) return P.arg(0, j);
          const step = sign * Math.sign(off);
          let left = Math.abs(off);
          for (let t = j + step; t >= 0 && t < P.size; t += step) {
            const v = P.arg(0, t);
            if (v !== null && --left === 0) return v;
          }
          return dflt();
        });
      },
    };
  }
  win('lag', lagLead(-1));
  win('lead', lagLead(1));

  const valueOf = (types) => (types[0] && types[0].cat === 'P' ? B().text : types[0]);
  /** the frame's positions, without the rows whose value is null when IGNORE NULLS is given */
  const framed = (P, w, j) => { const f = P.frame(j); return w.nulls === 'ignore' ? f.filter((p) => P.arg(0, p) !== null) : f; };
  win('first_value', {
    resolve: (types) => (types.length === 1 ? { argTypes: [valueOf(types)], ret: valueOf(types) } : null),
    run: (P, w) => each(P, (j) => { const f = framed(P, w, j); return f.length ? P.arg(0, f[0]) : null; }),
  });
  win('last_value', {
    resolve: (types) => (types.length === 1 ? { argTypes: [valueOf(types)], ret: valueOf(types) } : null),
    run: (P, w) => each(P, (j) => { const f = framed(P, w, j); return f.length ? P.arg(0, f[f.length - 1]) : null; }),
  });
  win('nth_value', {
    resolve: (types) => (types.length === 2 ? { argTypes: [valueOf(types), B().int4], ret: valueOf(types) } : null),
    run: (P, w) => each(P, (j) => {
      const k = P.arg(1, j);
      if (k === null) return null;
      if (k <= 0) throw K.err('22016', 'argument of nth_value must be greater than zero');
      const f = framed(P, w, j);
      return k <= f.length ? P.arg(0, f[k - 1]) : null;
    }),
  });

  // ---- frames --------------------------------------------------------------------------------------------------
  function checkFrame(fr) {
    const s = fr.start, e = fr.end;
    if (s.kind === 'unbounded' && s.dir === 'following') throw werr('frame start cannot be UNBOUNDED FOLLOWING');
    if (e.kind === 'unbounded' && e.dir === 'preceding') throw werr('frame end cannot be UNBOUNDED PRECEDING');
    if (s.kind === 'current' && e.kind === 'offset' && e.dir === 'preceding') throw werr('frame starting from current row cannot have preceding rows');
    if (s.kind === 'offset' && s.dir === 'following' && (e.kind === 'current' || e.kind === 'offset' && e.dir === 'preceding')) throw werr('frame starting from following row cannot have preceding rows');
  }
  /** a timestamp's microseconds moved by an interval: months on the calendar (clamping the day), then days, then time */
  function addInterval(us, iv, sign) {
    let days = Math.floor(us / K.US_DAY);
    const rest = us - days * K.US_DAY;
    if (iv.months) {
      let [y, m, d] = K.civilFromDays(days);
      let mm = m - 1 + sign * iv.months;
      y += Math.floor(mm / 12); mm = ((mm % 12) + 12) % 12; m = mm + 1;
      d = Math.min(d, K.monthDays(y, m));
      days = K.daysFromCivil(y, m, d);
    }
    return (days + sign * iv.days) * K.US_DAY + rest + sign * iv.us;
  }
  /**
   * RANGE offsets: a function (key, sign) => a comparable "target" and a function giving a row's comparable value,
   * for numbers (exact or float), dates and timestamps (interval offsets), times and intervals
   */
  function rangeMath(t, off) {
    t = base(t);
    if (!t) throw werr('RANGE with offset PRECEDING/FOLLOWING is not supported for this column type');
    const bad = () => werr('RANGE with offset PRECEDING/FOLLOWING is not supported for column type ' + K.T.sqlName(t) + ' and offset type ' + K.T.sqlName(K.T.typeOfValue(off)));
    if (t.cat === 'N') {
      if (off instanceof K.IntervalV) throw bad();
      if (t.float) { const o = Number(off instanceof K.Decimal ? off.toNumber() : off); return { val: (v) => v, move: (v, s) => v + s * o, cmp: (a, b) => K.T.compare(a, b) }; }
      const o = D().of(off);
      return { val: (v) => D().of(v), move: (v, s) => (s > 0 ? v.add(o) : v.sub(o)), cmp: (a, b) => a.cmp(b) };
    }
    if (t.cat === 'D' || t.cat === 'T') {
      if (!(off instanceof K.IntervalV)) throw bad();
      const num = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
      if (t.id === 'date') return { val: (v) => v.days * K.US_DAY, move: (v, s) => addInterval(v, off, s), cmp: num };
      if (t.id === 'time') return { val: (v) => v.us, move: (v, s) => v + s * off.us, cmp: num };
      if (t.cat === 'T') return { val: (v) => v.total(), move: (v, s) => v + s * off.total(), cmp: num };
      return { val: (v) => v.us, move: (v, s) => addInterval(v, off, s), cmp: num };
    }
    throw bad();
  }
  function offsetValue(b, fn, ctx, unit, keyType, which) {
    let v = fn([], ctx);
    if (v === null) throw K.err('22004', 'frame ' + which + ' offset must not be null');
    if (unit !== 'range') {
      v = Number(v);
      if (v < 0) throw K.err('22013', 'frame ' + which + ' offset must not be negative');
      return v;
    }
    if (typeof v === 'string') {
      const kt = base(keyType);
      v = kt && (kt.cat === 'D' || kt.cat === 'T') ? K.IntervalV.parse(v) : K.T.input(v, kt || B().numeric);
    }
    const neg = v instanceof K.IntervalV ? v.months < 0 || v.days < 0 || v.us < 0 : K.T.compare(v, 0) < 0;
    if (neg) throw K.err('22013', 'invalid preceding or following size in window function');
    return v;
  }

  // ---- ordering the windows the way PostgreSQL does ----------------------------------------------------------
  let uniqueKeys = 0;
  function exprKey(e) {
    try {
      return JSON.stringify(e, (k, v) => (k === 'pos' || k === 'def' || k === 'plan' || k === 'rt' || k === 'type' || k === 'ctype' ? undefined : typeof v === 'bigint' ? v.toString() + 'n' : v));
    } catch (er) { return 'unique:' + (++uniqueKeys); } // a cyclic tree: never equal to another window's
  }
  /** sort-clause numbers as PostgreSQL assigns them: for each window, ORDER BY first, then PARTITION BY */
  function sortClauses(specs) {
    const refs = new Map();
    const ref = (e) => { const k = exprKey(e); if (!refs.has(k)) refs.set(k, refs.size + 1); return refs.get(k); };
    for (const sp of specs) {
      const order = sp.order.map((o) => ({ ref: ref(o.e), desc: o.dir === 'desc', nf: o.nulls === 'first' }));
      const part = sp.partition.map((e) => {
        const r = ref(e), same = order.find((o) => o.ref === r);
        return same ? Object.assign({}, same) : { ref: r, desc: false, nf: false };
      });
      const list = part.slice();
      for (const o of order) if (!list.some((x) => x.ref === o.ref && x.desc === o.desc && x.nf === o.nf)) list.push(o);
      sp.clauses = list;
    }
  }
  /** common_prefix_cmp: windows whose sort is a prefix of another's come after it, so one sort serves both */
  function prefixCmp(a, b) {
    const x = a.clauses, y = b.clauses;
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      if (x[i].ref !== y[i].ref) return x[i].ref > y[i].ref ? -1 : 1;
      if (x[i].desc !== y[i].desc) return x[i].desc ? -1 : 1;
      if (x[i].nf !== y[i].nf) return x[i].nf ? -1 : 1;
    }
    return x.length > y.length ? -1 : x.length < y.length ? 1 : 0;
  }

  // ---- the executor --------------------------------------------------------------------------------------------
  const cmpVal = (x, y, t, desc, nullsFirst) => {
    if (x === null || y === null) { if (x === y) return 0; return (x === null) === nullsFirst ? -1 : 1; }
    const c = K.T.compare(x, y, t);
    return desc ? -c : c;
  };

  function* run(n, ctx, runNode, all, layoutOf) {
    const child = n.children[0];
    const rows = yield* all(child, ctx);
    const lay = layoutOf(child.cols);
    const C = (e) => K.Expr.compile(e, lay);
    const N = rows.length;
    const results = n.wins.map(() => new Array(N));
    // aggregates over frames run through the same runner as GROUP BY (the window's ORDER BY is not the call's)
    const runners = new Map();
    const runnerFor = (w) => { if (!runners.has(w)) runners.set(w, K.aggRunner(Object.assign({}, w, { order: null, within: null }), lay, ctx)); return runners.get(w); };

    // windows with the same PARTITION BY and ORDER BY share one sort
    const specs = [];
    n.wins.forEach((w, wi) => {
      if (w.isAgg && w.def.ordered) throw K.err('42809', 'OVER is not supported for ordered-set aggregate ' + w.name);
      if (w.distinct) throw K.err(S.featureNotSupported, 'DISTINCT is not implemented for window functions');
      if (!w.isAgg && w.filter) throw K.err(S.featureNotSupported, 'FILTER is not implemented for non-aggregate window functions');
      const key = exprKey({ p: w.partition, o: w.order.map((o) => [o.e, o.dir, o.nulls]) });
      let sp = specs.find((s) => s.key === key);
      if (!sp) { sp = { key, partition: w.partition, order: w.order, wins: [] }; specs.push(sp); }
      sp.wins.push(wi);
    });
    sortClauses(specs);
    const ordered = specs.map((s, i) => [s, i]).sort((a, b) => prefixCmp(a[0], b[0]) || a[1] - b[1]).map((x) => x[0]);

    let order = K.range(N);
    let lastPartitions = 0;
    const info = [];
    for (const sp of ordered) {
      const pf = sp.partition.map(C), of = sp.order.map((o) => C(o.e));
      const ptypes = sp.partition.map((e) => base(e.type)), otypes = sp.order.map((o) => base(o.e.type));
      const pk = new Array(N), ok = new Array(N);
      for (let i = 0; i < N; i++) { pk[i] = pf.map((f) => f(rows[i], ctx)); ok[i] = of.map((f) => f(rows[i], ctx)); }
      const pcmp = (a, b) => { for (let k = 0; k < pf.length; k++) { const c = cmpVal(pk[a][k], pk[b][k], ptypes[k], false, false); if (c) return c; } return 0; };
      const ocmp = (a, b) => { for (let k = 0; k < of.length; k++) { const o = sp.order[k]; const c = cmpVal(ok[a][k], ok[b][k], otypes[k], o.dir === 'desc', o.nulls === 'first'); if (c) return c; } return 0; };
      // a stable sort on the current order (so a later sort keeps the order of the earlier one among ties)
      const rank = new Array(N);
      order.forEach((r, i) => { rank[r] = i; });
      order = order.slice().sort((a, b) => pcmp(a, b) || ocmp(a, b) || rank[a] - rank[b]);

      let parts = 0;
      for (let s = 0; s < N;) {
        let e = s + 1;
        while (e < N && pcmp(order[s], order[e]) === 0) e++;
        parts++;
        const part = order.slice(s, e);
        for (const wi of sp.wins) {
          const vals = partition(n.wins[wi], part, ok, ocmp, sp, rows, C, ctx, otypes, runnerFor);
          for (let j = 0; j < part.length; j++) results[wi][part[j]] = vals[j];
        }
        s = e;
      }
      lastPartitions = parts;
      info.push({ partitions: parts, wins: sp.wins.length });
    }
    n.windowInfo = { rows: N, partitions: lastPartitions, sorts: ordered.length };
    if (ctx.bus) ctx.bus.emit('exec.window', { node: n, partitions: lastPartitions, rows: N, sorts: info });
    for (const i of order) {
      const out = rows[i].concat(results.map((r) => r[i]));
      yield out;
    }
  }

  /** compute one window call over one partition (part: row indices in sorted order) */
  function partition(w, part, ok, ocmp, sp, rows, C, ctx, otypes, runnerFor) {
    const size = part.length;
    // peer groups: rows equal on every ORDER BY key (all rows are peers without ORDER BY)
    const grp = new Array(size), gStart = [], gEnd = [];
    for (let j = 0; j < size; j++) {
      if (j === 0 || ocmp(part[j - 1], part[j]) !== 0) { gStart.push(j); if (j) gEnd.push(j - 1); }
      grp[j] = gStart.length - 1;
    }
    if (size) gEnd.push(size - 1);
    const G = gStart.length;
    const fns = w.args.map(C);
    const P = {
      size,
      arg: (k, j) => fns[k](rows[part[j]], ctx),
      peerStart: (j) => gStart[grp[j]],
      peerEnd: (j) => gEnd[grp[j]],
      group: (j) => grp[j],
      frame: null,
    };

    // the frame: default RANGE UNBOUNDED PRECEDING .. CURRENT ROW with ORDER BY, else the whole partition
    const fr = w.frame || (sp.order.length ? { unit: 'range', start: { kind: 'unbounded', dir: 'preceding' }, end: { kind: 'current' } } : { unit: 'rows', start: { kind: 'unbounded', dir: 'preceding' }, end: { kind: 'unbounded', dir: 'following' } });
    checkFrame(fr);
    const unit = fr.unit;
    const offs = {};
    for (const which of ['start', 'end']) {
      const b = fr[which];
      if (b.kind !== 'offset') continue;
      if (unit === 'range' && new Set(sp.order.map((o) => exprKey(o.e))).size !== 1) throw werr('RANGE with offset PRECEDING/FOLLOWING requires exactly one ORDER BY column');
      const v = offsetValue(b, C(b.e), ctx, unit, otypes[0], which === 'start' ? 'starting' : 'ending');
      offs[which] = unit === 'range' ? rangeMath(otypes[0], v) : v;
    }
    const desc = sp.order.length && sp.order[0].dir === 'desc';
    // the non-null stretch of the partition on the (single) RANGE key
    let nnFirst = 0, nnLast = size - 1;
    if (unit === 'range' && (offs.start || offs.end)) {
      while (nnFirst < size && ok[part[nnFirst]][0] === null) nnFirst++;
      while (nnLast >= 0 && ok[part[nnLast]][0] === null) nnLast--;
    }
    const rangeBound = (j, b, m, isStart) => {
      const kv = ok[part[j]][0];
      if (kv === null) return isStart ? gStart[grp[j]] : gEnd[grp[j]];
      // PRECEDING moves against the sort direction, FOLLOWING with it
      const s = (b.dir === 'preceding' ? -1 : 1) * (desc ? -1 : 1);
      const target = m.move(m.val(kv), s);
      const before = (p) => { const c = m.cmp(m.val(ok[part[p]][0]), target); return desc ? c > 0 : c < 0; };
      const after = (p) => { const c = m.cmp(m.val(ok[part[p]][0]), target); return desc ? c < 0 : c > 0; };
      if (isStart) { let p = nnFirst; while (p <= nnLast && before(p)) p++; return p <= nnLast ? p : size; }
      let p = nnLast; while (p >= nnFirst && after(p)) p--; return p >= nnFirst ? p : -1;
    };
    const bound = (j, b, isStart) => {
      if (b.kind === 'unbounded') return b.dir === 'preceding' ? 0 : size - 1;
      if (b.kind === 'current') return unit === 'rows' ? j : isStart ? gStart[grp[j]] : gEnd[grp[j]];
      const o = offs[isStart ? 'start' : 'end'];
      if (unit === 'rows') return j + (b.dir === 'preceding' ? -o : o);
      if (unit === 'groups') {
        const g = grp[j] + (b.dir === 'preceding' ? -o : o);
        if (isStart) return g < 0 ? 0 : g >= G ? size : gStart[g];
        return g < 0 ? -1 : g >= G ? size - 1 : gEnd[g];
      }
      return rangeBound(j, b, o, isStart);
    };
    const span = (j) => [Math.max(0, bound(j, fr.start, true)), Math.min(size - 1, bound(j, fr.end, false))];
    const excl = fr.exclude || null;
    const excluded = (j, p) => (excl === 'current row' ? p === j : excl === 'group' ? grp[p] === grp[j] : excl === 'ties' ? grp[p] === grp[j] && p !== j : false);
    P.frame = (j) => {
      const [s, e] = span(j);
      const out = [];
      for (let p = s; p <= e; p++) if (!excl || !excluded(j, p)) out.push(p);
      return out;
    };

    if (!w.isAgg) return w.def.run(P, w, ctx);

    // an aggregate over the frame: incremental when the frame starts at the partition's start
    const runner = runnerFor(w);
    const out = new Array(size);
    if (fr.start.kind === 'unbounded' && !excl) {
      const st = runner.init();
      let next = 0, lastE = -2, last = null;
      for (let j = 0; j < size; j++) {
        const e = Math.min(size - 1, bound(j, fr.end, false));
        if (e !== lastE) { while (next <= e) runner.step(st, rows[part[next++]]); last = runner.final(st); lastE = e; }
        out[j] = last;
      }
      return out;
    }
    let prev = null, prevVal = null;
    for (let j = 0; j < size; j++) {
      const [s, e] = span(j);
      if (!excl && prev && prev[0] === s && prev[1] === e) { out[j] = prevVal; continue; }
      const st = runner.init();
      for (const p of P.frame(j)) runner.step(st, rows[part[p]]);
      prevVal = out[j] = runner.final(st);
      prev = [s, e];
    }
    return out;
  }

  K.Windows = { run, addInterval };
})(typeof window !== 'undefined' ? window : globalThis);
