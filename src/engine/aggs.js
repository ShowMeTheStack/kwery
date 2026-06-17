// The aggregate functions: count, sum, avg, min, max, the boolean and bitwise ones, string_agg, array_agg, the
// JSON aggregates, the statistics (stddev, variance, covariance, correlation, regression), and the ordered-set
// and hypothetical-set aggregates used with WITHIN GROUP. Result types and output scales follow PostgreSQL 17.
(function (root) {
  'use strict';
  const K = root.K;
  const S = K.STATE;
  const B = () => K.T.BASE;
  const D = () => K.Decimal;
  const base = (t) => (t && t.domain ? t.base : t);
  const agg = (name, def) => K.F.agg(name, def);

  // ---- numeric helpers: PostgreSQL's choice of result scale for division and square root ----------------------
  const p10 = (n) => 10n ** BigInt(n);
  /** the weight (in base-10000 digits) and the first base-10000 digit of a decimal, as PostgreSQL stores it */
  function weightFirst(x) {
    const a = x.d < 0n ? -x.d : x.d;
    if (a === 0n) return [0, 0n];
    const w = Math.floor((a.toString().length - 1 - x.s) / 4);
    const sh = x.s + 4 * w;
    return [w, sh >= 0 ? a / p10(sh) : a * p10(-sh)];
  }
  /** select_div_scale: at least 16 significant digits, and no less than either input's scale */
  function divScale(a, b) {
    const [w1, f1] = weightFirst(a), [w2, f2] = weightFirst(b);
    let q = w1 - w2;
    if (f1 <= f2) q--;
    return Math.min(Math.max(16 - q * 4, a.s, b.s, 0), 1000);
  }
  function roundDiv(a, b) {
    const neg = (a < 0n) !== (b < 0n);
    const x = a < 0n ? -a : a, y = b < 0n ? -b : b;
    let q = x / y;
    if ((x % y) * 2n >= y) q += 1n;
    return neg ? -q : q;
  }
  function numDiv(a, b, scale) {
    a = D().of(a); b = D().of(b);
    if (b.d === 0n) throw K.err(S.divisionByZero, 'division by zero');
    const r = scale === undefined ? divScale(a, b) : scale;
    const e = b.s + r - a.s;
    return new (D())(e >= 0 ? roundDiv(a.d * p10(e), b.d) : roundDiv(a.d, b.d * p10(-e)), r);
  }
  function isqrt(n) {
    if (n < 2n) return n;
    let x = BigInt(Math.floor(Math.sqrt(Number(n))));
    if (x === 0n) x = 1n;
    for (;;) { const y = (x + n / x) >> 1n; if (y >= x && y - x <= 1n) { x = y; break; } x = y; }
    while (x * x > n) x--;
    while ((x + 1n) * (x + 1n) <= n) x++;
    return x;
  }
  /** square root rounded to r digits after the point */
  function numSqrt(v, r) {
    const e = 2 * (r + 1) - v.s;
    const n = e >= 0 ? v.d * p10(e) : v.d / p10(-e);
    return new (D())((isqrt(n) + 5n) / 10n, r);
  }
  K.numDiv = numDiv;

  // ---- interval arithmetic exactly as PostgreSQL 17's interval_mul and interval_div ----------------------------
  const rint = (x) => K.T.roundHalfEven(x);
  const tsround = (x) => rint(x * 1e6) / 1e6;
  function ivScale(iv, f, div) {
    const op = (x) => (div ? x / f : x * f);
    const m = op(iv.months), month = Math.trunc(m);
    const dd = op(iv.days);
    let day = Math.trunc(dd);
    const mrd = tsround((m - month) * 30);
    let sec = tsround((dd - day + mrd - Math.trunc(mrd)) * 86400);
    if (Math.abs(sec) >= 86400) { day += Math.trunc(sec / 86400); sec -= Math.trunc(sec / 86400) * 86400; }
    day += Math.trunc(mrd);
    return new K.IntervalV(month, day, rint(op(iv.us) + sec * 1e6));
  }
  K.ivScale = ivScale;

  // ---- simple aggregates ----------------------------------------------------------------------------------------
  agg('count', {
    star: true,
    resolve(types, ast) { if ((!types.length && !(ast && ast.star)) || types.length > 1) return null; return { argTypes: [], ret: B().int8 }; },
    init: () => 0n,
    step: (s) => s + 1n,
    final: (s) => s,
  });

  agg('sum', {
    resolve(types) {
      if (types.length !== 1) return null;
      const t = base(types[0]);
      if (!t) return null;
      if (t.cat === 'N') {
        if (t.int && !t.big) return { argTypes: [t], ret: B().int8 };
        if (t.big) return { argTypes: [t], ret: B().numeric };
        if (t.float) return { argTypes: [t], ret: B()[t.id] };
        return { argTypes: [B().numeric], ret: B().numeric };
      }
      if (t.cat === 'T') return { argTypes: [t], ret: B().interval };
      return null;
    },
    init: () => null,
    step(s, [v], ctx, a) {
      const t = a.type;
      if (s === null) return t.id === 'int8' ? BigInt(v) : t.id === 'numeric' ? (typeof v === 'number' && Number.isNaN(v) ? NaN : D().of(v)) : v;
      if (t.id === 'int8') return K.F.checkInt(s + BigInt(v), t);
      if (t.id === 'numeric') { if (Number.isNaN(s) || typeof v === 'number' && Number.isNaN(v)) return NaN; return s.add(D().of(v)); }
      if (t.id === 'float4') return Math.fround(s + v);
      if (t.id === 'float8') return s + v;
      return s.add(v);
    },
    final: (s) => s,
  });

  agg('avg', {
    resolve(types) {
      if (types.length !== 1) return null;
      const t = base(types[0]);
      if (!t) return null;
      if (t.cat === 'N') {
        if (t.float) return { argTypes: [t], ret: B().float8 };
        return { argTypes: [t.int ? t : B().numeric], ret: B().numeric };
      }
      if (t.cat === 'T') return { argTypes: [t], ret: B().interval };
      return null;
    },
    init: () => ({ n: 0, sum: null }),
    step(s, [v], ctx, a) {
      const kind = a.type.id === 'float8' ? 'f' : a.type.id === 'interval' ? 'i' : 'n';
      const n = s.n + 1;
      if (kind === 'f') return { n, sum: (s.sum || 0) + v };
      if (kind === 'i') return { n, sum: s.sum ? s.sum.add(v) : v };
      if (typeof v === 'number' && Number.isNaN(v) || s.sum !== null && typeof s.sum === 'number') return { n, sum: NaN };
      return { n, sum: s.sum ? s.sum.add(D().of(v)) : D().of(v) };
    },
    final(s, ctx, a) {
      if (!s.n) return null;
      if (a.type.id === 'float8') return s.sum / s.n;
      if (a.type.id === 'interval') return ivScale(s.sum, s.n, true);
      if (typeof s.sum === 'number') return NaN;
      return numDiv(s.sum, D().of(s.n));
    },
  });

  function minmax(sign) {
    return {
      resolve(types) {
        if (types.length !== 1) return null;
        let t = types[0];
        if (!t || t.cat === 'P') t = B().text;
        const bt = base(t);
        if (bt.cat === 'B' || bt.cat === 'J') return null;
        // the result drops the type modifier (numeric(4,0) gives numeric); varchar values go through min(text)
        const ret = bt.id === 'varchar' ? B().text : bt.cat !== 'A' && K.T.BASE[bt.id] ? K.T.BASE[bt.id] : bt;
        return { argTypes: [t], ret };
      },
      init: () => null,
      // on a tie the newer value wins, as in PostgreSQL's numeric_larger and text_smaller
      step(s, [v], ctx, a) { if (s === null) return v; const c = K.T.compare(v, s, base(a.type)); return c * sign >= 0 ? v : s; },
      final: (s) => s,
    };
  }
  agg('min', minmax(-1));
  agg('max', minmax(1));

  const boolAgg = (and) => ({
    resolve(types) { if (types.length !== 1) return null; const t = base(types[0]); if (t && t.cat !== 'B' && t.cat !== 'P') return null; return { argTypes: [B().bool], ret: B().bool }; },
    init: () => null,
    step: (s, [v]) => (s === null ? v : and ? s && v : s || v),
    final: (s) => s,
  });
  agg('bool_and', boolAgg(true));
  agg('every', boolAgg(true));
  agg('bool_or', boolAgg(false));

  const bitAgg = (op) => ({
    resolve(types) { if (types.length !== 1) return null; const t = base(types[0]); if (!t || !t.int) return null; return { argTypes: [t], ret: B()[t.id] }; },
    init: () => null,
    step(s, [v], ctx, a) {
      if (s === null) return v;
      if (a.type.big) return BigInt.asIntN(64, op(BigInt(s), BigInt(v)));
      const r = op(s, v) | 0;
      return a.type.id === 'int2' ? (r << 16) >> 16 : r;
    },
    final: (s) => s,
  });
  agg('bit_and', bitAgg((a, b) => a & b));
  agg('bit_or', bitAgg((a, b) => a | b));
  agg('bit_xor', bitAgg((a, b) => a ^ b));

  agg('any_value', {
    resolve(types) { if (types.length !== 1) return null; const t = !types[0] || types[0].cat === 'P' ? B().text : types[0]; return { argTypes: [t], ret: t }; },
    init: () => ({ has: false, v: null }),
    step: (s, [v]) => (s.has ? s : { has: true, v }),
    final: (s) => s.v,
  });

  // the delimiter is the one given with each value, written before it (except before the first)
  agg('string_agg', {
    strict: false,
    resolve(types) {
      if (types.length !== 2) return null;
      const t = base(types[0]);
      if (t && t.cat === 'X') return { argTypes: [B().bytea, B().bytea], ret: B().bytea };
      if (t && t.cat !== 'S' && t.cat !== 'P') return null;
      return { argTypes: [B().text, B().text], ret: B().text };
    },
    init: () => null,
    step(s, [v, d]) {
      if (v === null) return s;
      if (s === null) return { parts: [v] };
      if (d !== null) s.parts.push(d);
      s.parts.push(v);
      return s;
    },
    final(s, ctx, a) {
      if (s === null) return null;
      if (a.type.id !== 'bytea') return s.parts.join('');
      const out = new Uint8Array(s.parts.reduce((n, p) => n + p.length, 0));
      let o = 0;
      for (const p of s.parts) { out.set(p, o); o += p.length; }
      return out;
    },
  });

  agg('array_agg', {
    strict: false,
    resolve(types) {
      if (types.length !== 1) return null;
      const t = !types[0] || types[0].cat === 'P' ? B().text : types[0];
      return { argTypes: [t], ret: base(t).cat === 'A' ? t : K.T.arrayOf(t) };
    },
    init: () => null,
    step(s, [v], ctx, a) {
      const arrays = base(a.args[0].type).cat === 'A';
      if (arrays) {
        if (v === null) throw K.err('22004', 'cannot accumulate null arrays');
        if (!v.items.length) throw K.err(S.arraySubscript, 'cannot accumulate empty arrays');
        if (s && s.length && s[0].dims().join('x') !== v.dims().join('x')) throw K.err(S.arraySubscript, 'cannot accumulate arrays of different dimensionality');
        v = new K.ArrayV(v.items);
      }
      if (s === null) s = [];
      s.push(v);
      return s;
    },
    final: (s) => (s === null ? null : new K.ArrayV(s.slice())),
  });

  // ---- JSON ---------------------------------------------------------------------------------------------------------
  const isoOf = (v, t) => {
    if (v instanceof K.DateV) return v.toString();
    if (v instanceof K.TimestampV) {
      if (!Number.isFinite(v.us)) return v.toString();
      let s = v.toString(K.ctxZone().zone);
      const bc = / BC$/.test(s);
      s = s.replace(/ BC$/, '').replace(' ', 'T');
      if (v.tz) s = s.replace(/([+-]\d\d)$/, '$1:00');
      return s + (bc ? ' BC' : '');
    }
    return K.T.output(v, t, K.ctxZone());
  };
  /** the compact JSON text of a SQL value, as to_json writes it */
  function jsonText(v, t) {
    if (v === null || v === undefined) return 'null';
    t = base(t);
    if (!t || t.cat === 'P') t = K.T.typeOfValue(v);
    switch (t.cat) {
      case 'N': {
        if (typeof v === 'number' && !Number.isFinite(v)) return '"' + K.T.output(v, t) + '"';
        return K.T.output(v, t);
      }
      case 'B': return v ? 'true' : 'false';
      case 'J': return K.T.output(v, t);
      case 'A': {
        const one = (x) => (x instanceof K.ArrayV ? '[' + x.items.map(one).join(',') + ']' : jsonText(x, t.elem));
        return one(v);
      }
      case 'C': {
        const fields = t.fields || (v.type && v.type.fields);
        return '{' + v.values.map((x, i) => JSON.stringify(fields && fields[i] ? fields[i].name : 'f' + (i + 1)) + ':' + jsonText(x, fields && fields[i] ? fields[i].type : null)).join(',') + '}';
      }
      case 'D': return JSON.stringify(isoOf(v, t));
      default: return JSON.stringify(K.T.output(v, t, K.ctxZone()));
    }
  }
  K.jsonText = jsonText;
  const structured = (t) => { t = base(t); return t && (t.cat === 'A' || t.cat === 'C'); };
  const jsonResult = (text, binary) => (binary ? K.T.jsonIn(text, true) : new K.JsonV(K.T.jsonIn(text, false).v, false, text));

  const jsonAgg = (binary) => ({
    strict: false,
    resolve(types) { if (types.length !== 1) return null; return { argTypes: [types[0] && types[0].cat === 'P' ? B().text : types[0]], ret: binary ? B().jsonb : B().json }; },
    init: () => null,
    step(s, [v], ctx, a) {
      const t = a.args[0].type;
      if (s === null) s = [];
      // json_agg starts each array or row element on a new line; jsonb is normalized anyway
      s.push((s.length ? ', ' + (v !== null && structured(t) && !binary ? '\n ' : '') : '') + jsonText(v, t));
      return s;
    },
    final: (s) => (s === null ? null : jsonResult('[' + s.join('') + ']', binary)),
  });
  agg('json_agg', jsonAgg(false));
  agg('jsonb_agg', jsonAgg(true));

  const jsonObjectAgg = (binary) => ({
    strict: false,
    resolve(types) { if (types.length !== 2) return null; return { argTypes: types.map((t) => (t && t.cat === 'P' ? B().text : t)), ret: binary ? B().jsonb : B().json }; },
    init: () => null,
    step(s, [k, v], ctx, a) {
      if (k === null) throw K.err(binary ? '22023' : '22004', binary ? 'field name must not be null' : 'null value not allowed for object key');
      if (s === null) s = [];
      const kt = base(a.args[0].type);
      const key = kt && kt.cat === 'S' ? k : K.T.output(k, kt, K.ctxZone());
      s.push(JSON.stringify(String(key)) + (binary ? ': ' : ' : ') + jsonText(v, a.args[1].type));
      return s;
    },
    final: (s) => (s === null ? null : jsonResult(binary ? '{' + s.join(', ') + '}' : '{ ' + s.join(', ') + ' }', binary)),
  });
  agg('json_object_agg', jsonObjectAgg(false));
  agg('jsonb_object_agg', jsonObjectAgg(true));

  // ---- statistics ---------------------------------------------------------------------------------------------------
  // exact inputs accumulate N, sum(X) and sum(X*X) as numerics; floats use the Youngs-Cramer algorithm, as PostgreSQL
  const isFloatArg = (a) => base(a.args[0].type).float;
  function numStat(kind) {
    const sample = /samp|^stddev$|^variance$/.test(kind), sqrt = /stddev/.test(kind);
    return {
      resolve(types) {
        if (types.length !== 1) return null;
        const t = base(types[0]);
        if (!t || t.cat !== 'N') return null;
        if (t.float) return { argTypes: [t], ret: B().float8 };
        return { argTypes: [t.int ? t : B().numeric], ret: B().numeric };
      },
      init: () => null,
      step(s, [v], ctx, a) {
        if (isFloatArg(a)) {
          if (s === null) s = { n: 0, sx: 0, sxx: 0 };
          const n = s.n + 1, sx = s.sx + v;
          let sxx = s.sxx;
          if (s.n > 0) {
            const tmp = K.fma(v, n, -sx);
            sxx += tmp * tmp / (n * s.n);
            if (!Number.isFinite(sx) || !Number.isFinite(sxx)) { if (Number.isFinite(s.sx) && Number.isFinite(v)) throw K.err(S.numericOutOfRange, 'value out of range: overflow'); sxx = NaN; }
          } else if (!Number.isFinite(v)) sxx = NaN;
          return { n, sx, sxx };
        }
        if (s === null) s = { n: 0n, sx: D().of(0), sxx: D().of(0), nan: false };
        if (typeof v === 'number' && Number.isNaN(v)) return Object.assign(s, { n: s.n + 1n, nan: true });
        const x = D().of(v);
        return { n: s.n + 1n, sx: s.sx.add(x), sxx: s.sxx.add(x.mul(x)), nan: s.nan };
      },
      final(s, ctx, a) {
        if (s === null) return null;
        if (isFloatArg(a)) {
          if (sample ? s.n <= 1 : s.n === 0) return null;
          const v = s.sxx / (sample ? s.n - 1 : s.n);
          return sqrt ? Math.sqrt(v) : v;
        }
        if (sample ? s.n <= 1n : s.n === 0n) return null;
        if (s.nan) return NaN;
        const N = new (D())(s.n, 0);
        const num = N.mul(s.sxx).sub(s.sx.mul(s.sx));
        if (num.d <= 0n) return D().of(0);
        const den = new (D())(sample ? s.n * (s.n - 1n) : s.n * s.n, 0);
        const r = divScale(num, den);
        const v = numDiv(num, den, r);
        return sqrt ? numSqrt(v, r) : v;
      },
    };
  }
  for (const k of ['stddev', 'stddev_samp', 'stddev_pop', 'variance', 'var_samp', 'var_pop']) agg(k, numStat(k));

  // two-variable statistics take (Y, X), in double precision
  function regr(fin, ret) {
    return {
      resolve(types) {
        if (types.length !== 2) return null;
        if (types.some((t) => t && base(t).cat !== 'N' && t.cat !== 'P')) return null;
        return { argTypes: [B().float8, B().float8], ret: B()[ret || 'float8'] };
      },
      init: () => ({ n: 0, sx: 0, sxx: 0, sy: 0, syy: 0, sxy: 0 }),
      step(s, [y, x]) {
        const n = s.n + 1, sx = s.sx + x, sy = s.sy + y;
        let { sxx, syy, sxy } = s;
        if (s.n > 0) {
          const tx = K.fma(x, n, -sx), ty = K.fma(y, n, -sy), sc = 1 / (n * s.n);
          sxx = K.fma(tx * tx, sc, sxx); syy = K.fma(ty * ty, sc, syy); sxy = K.fma(tx * ty, sc, sxy);
          if (!Number.isFinite(sx) || !Number.isFinite(sxx) || !Number.isFinite(sy) || !Number.isFinite(syy) || !Number.isFinite(sxy)) {
            if (!Number.isFinite(sx) || !Number.isFinite(sxx)) sxx = NaN;
            if (!Number.isFinite(sy) || !Number.isFinite(syy)) syy = NaN;
            sxy = NaN;
          }
        } else {
          if (!Number.isFinite(x)) { sxx = NaN; sxy = NaN; }
          if (!Number.isFinite(y)) { syy = NaN; sxy = NaN; }
        }
        return { n, sx, sxx, sy, syy, sxy };
      },
      final: (s) => fin(s),
    };
  }
  agg('covar_pop', regr((s) => (s.n < 1 ? null : s.sxy / s.n)));
  agg('covar_samp', regr((s) => (s.n < 2 ? null : s.sxy / (s.n - 1))));
  agg('corr', regr((s) => {
    if (s.n < 1 || s.sxx === 0 || s.syy === 0) return null;
    const p = s.sxx * s.syy;
    let r = p === 0 || !Number.isFinite(p) ? s.sxy / Math.sqrt(s.sxx) / Math.sqrt(s.syy) : s.sxy / Math.sqrt(p);
    if (r > 1) r = 1; else if (r < -1) r = -1;
    return r;
  }));
  agg('regr_count', regr((s) => BigInt(s.n), 'int8'));
  agg('regr_avgx', regr((s) => (s.n < 1 ? null : s.sx / s.n)));
  agg('regr_avgy', regr((s) => (s.n < 1 ? null : s.sy / s.n)));
  agg('regr_sxx', regr((s) => (s.n < 1 ? null : s.sxx)));
  agg('regr_syy', regr((s) => (s.n < 1 ? null : s.syy)));
  agg('regr_sxy', regr((s) => (s.n < 1 ? null : s.sxy)));
  agg('regr_slope', regr((s) => (s.n < 1 || s.sxx === 0 ? null : s.sxy / s.sxx)));
  agg('regr_intercept', regr((s) => (s.n < 1 || s.sxx === 0 ? null : (s.sy - s.sx * s.sxy / s.sxx) / s.n)));
  agg('regr_r2', regr((s) => {
    if (s.n < 1 || s.sxx === 0) return null;
    if (s.syy === 0) return 1;
    return (s.sxy * s.sxy) / (s.sxx * s.syy);
  }));

  // ---- ordered-set aggregates (WITHIN GROUP) --------------------------------------------------------------------
  // The result type of mode() and percentile_disc() is the type of the WITHIN GROUP expression, which is bound
  // after resolve() runs: the returned type object is filled in when withinType() sees that type.
  function late(within, ret) {
    const r = { id: 'unknown', name: 'unknown', cat: 'P', len: -1 };
    return {
      ret: r,
      withinType(t) {
        const w = within(t);
        for (const k of Object.keys(r)) delete r[k];
        if (!w) return null;
        Object.assign(r, ret(w));
        return w;
      },
    };
  }
  const anyType = (t) => (!t || t.cat === 'P' ? B().text : t);
  const fractionArg = (types) => {
    if (types.length !== 1) return null;
    const t = base(types[0]);
    if (t && t.cat === 'A') return { arr: true, argTypes: [K.T.arrayOf(B().float8)] };
    if (t && t.cat !== 'N' && t.cat !== 'P') return null;
    return { arr: false, argTypes: [B().float8] };
  };
  function checkFraction(p) {
    if (Number.isNaN(p) || p < 0 || p > 1) throw K.err(S.numericOutOfRange, 'percentile value ' + K.T.floatOut(p) + ' is not between 0 and 1');
    return p;
  }
  /** apply a per-fraction function to the direct argument: a single fraction or an array of them */
  function perFraction(direct, callNode, keys, f) {
    if (!direct) return null;
    const p = direct[0];
    if (p === null) return null;
    const vals = keys.filter((k) => k !== null);
    if (base(callNode.args[0].type).cat === 'A') {
      K.T.mapArray(p, checkFraction);
      return vals.length ? K.T.mapArray(p, (x) => f(vals, x)) : null;
    }
    checkFraction(p);
    return vals.length ? f(vals, p) : null;
  }
  const lerp = (lo, hi, pct) => (lo instanceof K.IntervalV ? lo.add(ivScale(hi.sub(lo), pct, false)) : K.fma(hi - lo, pct, lo));

  agg('percentile_cont', {
    ordered: true,
    resolve(types) {
      const f = fractionArg(types);
      if (!f) return null;
      return Object.assign({ argTypes: f.argTypes }, late((t) => (!base(t) || base(t).cat === 'N' || base(t).cat === 'P' ? B().float8 : base(t).id === 'interval' ? B().interval : null), (w) => (f.arr ? K.T.arrayOf(w) : w)));
    },
    finalOrdered(keys, direct, ctx, a) {
      return perFraction(direct, a, keys, (vals, p) => {
        const pos = p * (vals.length - 1), lo = Math.floor(pos), hi = Math.ceil(pos);
        return hi > lo ? lerp(vals[lo], vals[hi], K.fma(p, vals.length - 1, -lo)) : vals[lo];
      });
    },
  });
  agg('percentile_disc', {
    ordered: true,
    resolve(types) {
      const f = fractionArg(types);
      if (!f) return null;
      return Object.assign({ argTypes: f.argTypes }, late(anyType, (w) => (f.arr ? K.T.arrayOf(w) : w)));
    },
    finalOrdered(keys, direct, ctx, a) {
      return perFraction(direct, a, keys, (vals, p) => vals[Math.max(Math.ceil(p * vals.length), 1) - 1]);
    },
  });
  agg('mode', {
    ordered: true,
    resolve(types) { if (types.length) return null; return Object.assign({ argTypes: [] }, late(anyType, (w) => w)); },
    finalOrdered(keys, direct, ctx, a) {
      const t = a.within[0].e.type;
      let best = null, bestN = 0, cur = null, n = 0;
      for (const k of keys) {
        if (k === null) continue;
        if (n && K.T.compare(k, cur, base(t)) === 0) n++;
        else { cur = k; n = 1; }
        if (n > bestN) { best = cur; bestN = n; }
      }
      return best;
    },
  });

  // hypothetical-set aggregates: where would a row with these values fall among the group's rows?
  function hypothetical(fin, ret) {
    return {
      ordered: true,
      resolve(types) { if (!types.length) return null; return { argTypes: types.map(() => undefined), ret: B()[ret] }; },
      finalOrdered(keys, direct, ctx, a, items) {
        const ord = a.within;
        if (ord.length !== a.args.length) throw K.err(S.undefinedFunction, 'function ' + a.name + ' has ' + a.args.length + ' direct arguments but ' + ord.length + ' ordering columns');
        if (!items.length) return fin(1, 1, 0, 0);
        const h = direct.map((v, i) => K.T.cast(v, a.args[i].type, ord[i].e.type, false, ctx));
        const cmp = (x) => {
          for (let i = 0; i < ord.length; i++) {
            const p = x[i], q = h[i];
            if (p === null || q === null) { if (p === q) continue; return (p === null) === (ord[i].nulls === 'first') ? -1 : 1; }
            let c = K.T.compare(p, q, base(ord[i].e.type));
            if (ord[i].dir === 'desc') c = -c;
            if (c) return c;
          }
          return 0;
        };
        let before = 0, notAfter = 0, groups = 0, prev = null;
        const same = (x, y) => x.every((v, i) => (v === null || y[i] === null ? v === y[i] : K.T.compare(v, y[i], base(ord[i].e.type)) === 0));
        for (const it of items) {
          const c = cmp(it.keys);
          if (c < 0) { before++; if (!prev || !same(prev, it.keys)) groups++; prev = it.keys; }
          if (c <= 0) notAfter++;
        }
        return fin(before + 1, groups + 1, notAfter, items.length);
      },
    };
  }
  agg('rank', hypothetical((rank) => BigInt(rank), 'int8'));
  agg('dense_rank', hypothetical((rank, dense) => BigInt(dense), 'int8'));
  agg('percent_rank', hypothetical((rank, dense, le, n) => (n ? (rank - 1) / n : 0), 'float8'));
  agg('cume_dist', hypothetical((rank, dense, le, n) => (le + 1) / (n + 1), 'float8'));

  K.Aggs = { numDiv, divScale, numSqrt, ivScale, jsonText };
})(typeof window !== 'undefined' ? window : globalThis);
