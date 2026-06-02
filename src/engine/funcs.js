// The registry of built-in functions, operators, aggregates and window functions, and how a call is matched
// to one of them (overload resolution, with PostgreSQL's preference for exact matches, then implicit casts,
// and unknown literals taking the type the function wants).
(function (root) {
  'use strict';
  const K = root.K;
  const S = K.STATE;
  const B = () => K.T.BASE;

  const FUNCS = new Map();   // name -> [def]
  const OPS = new Map();     // op -> [def]
  const AGGS = new Map();    // name -> def
  const WINS = new Map();    // name -> def

  // an argument spec is a type id ('int4'), a category ('N', 'S', 'D', 'any', 'anyarray', 'anyelement'), or a type object
  function fn(name, specs) { for (const s of [].concat(specs)) { const l = FUNCS.get(name) || []; l.push(Object.assign({ name, strict: true }, s)); FUNCS.set(name, l); } }
  function op(o, specs) { for (const s of [].concat(specs)) { const l = OPS.get(o) || []; l.push(Object.assign({ name: o, strict: true }, s)); OPS.set(o, l); } }
  function agg(name, def) { AGGS.set(name, Object.assign({ name }, def)); }
  function win(name, def) { WINS.set(name, Object.assign({ name }, def)); }

  /** how well an argument of type t fits a spec: 3 exact, 2 same category, 1 implicit cast, 0 no */
  function fit(t, spec, poly) {
    if (spec === 'any') return 1;
    if (!t) return 1;
    // unknown literal or NULL: fits anything, weakly; between otherwise equal overloads a quoted literal prefers text
    if (t.cat === 'P') return spec === 'anyarray' ? 0.5 : (t.id === 'unknown' || t.id === 'null') && (spec === 'text' || spec === 'S' || typeof spec === 'object' && spec.cat === 'S') ? 1.005 : 1;
    if (spec === 'anyelement') { if (poly.elem && poly.elem.id !== t.id && !K.T.implicit(t, poly.elem)) return 0; return 2; }
    if (spec === 'anyarray') return t.cat === 'A' ? 2 : 0;
    if (spec === 'anyenum') return t.cat === 'E' ? 3 : 0;
    if (spec === 'anyrow') return t.cat === 'C' ? 2 : 0;
    if (typeof spec === 'object') return t.id === spec.id ? 3 : K.T.implicit(t, spec) ? 1 : 0;
    if (spec.length === 1) { const base = t.domain ? t.base : t; return base.cat === spec ? 2 : 0; }
    const st = B()[spec];
    if (!st) return 0;
    const base = t.domain ? t.base : t;
    if (base.id === st.id) return 3;
    if (K.T.implicit(base, st)) return 1 + (base.cat === st.cat ? 0.5 - Math.abs((base.rank || 0) - (st.rank || 0)) * 0.01 : 0);
    return 0;
  }
  /** choose the best overload for the argument types; returns { def, argTypes (wanted), ret } or null */
  function resolve(list, types, what) {
    let best = null, bestScore = -1, tie = false;
    for (const d of list || []) {
      const args = d.args || [];
      const variadic = d.variadic;
      if (!variadic && args.length !== types.length) { if (!(d.minArgs !== undefined && types.length >= d.minArgs && types.length <= args.length)) continue; }
      if (variadic && types.length < args.length - 1) continue;
      const poly = {};
      let score = 0, ok = true;
      for (let i = 0; i < types.length; i++) {
        const spec = variadic && i >= args.length - 1 ? args[args.length - 1] : args[i];
        if (spec === 'anyelement' && types[i] && types[i].cat !== 'P' && !poly.elem) poly.elem = types[i].domain ? types[i].base : types[i];
        if (spec === 'anyarray' && types[i] && types[i].cat === 'A' && !poly.elem) poly.elem = types[i].elem;
        const f = fit(types[i], spec, poly);
        if (!f) { ok = false; break; }
        score += f;
      }
      if (!ok) continue;
      if (score > bestScore) { best = d; bestScore = score; tie = false; best.poly = poly; }
      else if (score === bestScore) tie = true;
    }
    if (!best) return null;
    if (tie && what) {
      // an ambiguity among equally good overloads: prefer one whose categories match unknown args as text
      void what;
    }
    const poly = best.poly || {};
    const want = types.map((t, i) => {
      const args = best.args || [];
      const spec = best.variadic && i >= args.length - 1 ? args[args.length - 1] : args[i];
      if (spec === 'anyelement') return poly.elem || (t && t.cat !== 'P' ? t : B().text);
      if (spec === 'anyarray') return t && t.cat === 'A' ? t : poly.elem ? K.T.arrayOf(poly.elem) : K.T.arrayOf(B().text);
      if (spec === 'any' || spec === 'anyenum' || spec === 'anyrow') return t;
      if (typeof spec === 'object') return spec;
      if (spec && spec.length === 1) return t && t.cat !== 'P' ? t : spec === 'N' ? B().numeric : spec === 'S' ? B().text : spec === 'D' ? B().timestamp : B().text;
      return B()[spec];
    });
    let ret = best.ret;
    if (typeof ret === 'function') ret = ret(want, poly);
    else if (ret === 'anyelement') ret = poly.elem || want[0];
    else if (ret === 'anyarray') ret = poly.elem ? K.T.arrayOf(poly.elem) : want[0];
    else if (typeof ret === 'string') ret = B()[ret] || K.T.byName(ret);
    return { def: best, argTypes: want, ret };
  }

  // ---- numbers: the arithmetic of mixed types ---------------------------------------------------------------
  const isInt = (t) => t && t.int;
  /** the result type of + - * / between two numeric types: the wider one, as PostgreSQL promotes */
  function numResult(a, b) {
    if (!a || a.cat !== 'N') return b && b.cat === 'N' ? b : B().numeric;
    if (!b || b.cat !== 'N') return a;
    // real mixed with anything but real becomes double precision, the preferred type of the category
    if ((a.id === 'float4') !== (b.id === 'float4') && (a.id === 'float4' ? b : a).id !== 'float8') return B().float8;
    return (a.rank || 0) >= (b.rank || 0) ? strip(a) : strip(b);
  }
  const strip = (t) => (t.id === 'numeric' ? B().numeric : B()[t.id] || t);
  function checkInt(v, t) {
    if (t.big) { if (v > t.max || v < t.min) throw K.err(S.numericOutOfRange, 'bigint out of range'); return v; }
    if (!Number.isFinite(v) || v > t.max || v < t.min) throw K.err(S.numericOutOfRange, (t.id === 'int2' ? 'smallint' : 'integer') + ' out of range');
    return v;
  }
  /** apply an arithmetic operator to two values already converted to type t */
  function arith(o, a, b, t) {
    if (t.big) {
      a = BigInt(a); b = BigInt(b);
      switch (o) {
        case '+': return checkInt(a + b, t);
        case '-': return checkInt(a - b, t);
        case '*': return checkInt(a * b, t);
        case '/': if (b === 0n) throw K.err(S.divisionByZero, 'division by zero'); return checkInt(a / b, t);
        case '%': if (b === 0n) throw K.err(S.divisionByZero, 'division by zero'); return a % b;
      }
    }
    if (t.int) {
      switch (o) {
        case '+': return checkInt(a + b, t);
        case '-': return checkInt(a - b, t);
        case '*': { const r = a * b; if (!Number.isSafeInteger(r)) throw K.err(S.numericOutOfRange, (t.id === 'int2' ? 'smallint' : 'integer') + ' out of range'); return checkInt(r, t); }
        case '/': if (b === 0) throw K.err(S.divisionByZero, 'division by zero'); return checkInt(Math.trunc(a / b), t);
        case '%': if (b === 0) throw K.err(S.divisionByZero, 'division by zero'); return a % b;
      }
    }
    if (t.float) {
      let r;
      switch (o) {
        case '+': r = a + b; break;
        case '-': r = a - b; break;
        case '*': r = a * b; break;
        case '/': if (b === 0) throw K.err(S.divisionByZero, 'division by zero'); r = a / b; break;
        case '%': throw K.err(S.undefinedFunction, 'operator does not exist: double precision % double precision');
      }
      if (t.id === 'float4') r = Math.fround(r);
      if (!Number.isFinite(r) && Number.isFinite(a) && Number.isFinite(b)) throw K.err(S.numericOutOfRange, 'value out of range: overflow');
      if (r === 0 && (o === '*' || o === '/') && a !== 0 && Number.isFinite(b) && (o === '/' || b !== 0)) throw K.err(S.numericOutOfRange, 'value out of range: underflow');
      return r;
    }
    // numeric
    if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
    if (a === Infinity || a === -Infinity || b === Infinity || b === -Infinity) {
      // numeric infinities follow IEEE rules, except that division by zero is still an error
      const x = typeof a === 'number' ? a : K.Decimal.of(a).toNumber(), y = typeof b === 'number' ? b : K.Decimal.of(b).toNumber();
      if ((o === '/' || o === '%') && y === 0) throw K.err(S.divisionByZero, 'division by zero');
      if (o === '%' && Number.isFinite(x)) return K.Decimal.of(a);
      const r = o === '+' ? x + y : o === '-' ? x - y : o === '*' ? x * y : o === '/' ? x / y : NaN;
      return Number.isFinite(r) ? K.Decimal.of(0) : r;
    }
    a = K.Decimal.of(a); b = K.Decimal.of(b);
    switch (o) {
      case '+': return a.add(b);
      case '-': return a.sub(b);
      case '*': return a.mul(b);
      case '/': return a.div(b);
      case '%': return a.mod(b);
    }
    throw K.err(S.internal, 'bad operator ' + o);
  }

  K.F = { FUNCS, OPS, AGGS, WINS, fn, op, agg, win, resolve, fit, numResult, arith, checkInt, isInt };
})(typeof window !== 'undefined' ? window : globalThis);
