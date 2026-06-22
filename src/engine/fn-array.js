// Built-in array functions: array_length/lower/upper/ndims/dims, cardinality, append/prepend/cat, remove/replace,
// array_position(s), array_to_string, string_to_array, array_fill, trim_array, array_shuffle/array_sample, and the
// array operators @> <@ && ||.
(function (root) {
  'use strict';
  const K = root.K;
  const F = K.F;
  const B = K.T.BASE;
  const A = K.ArrayV;
  const INT4S = K.T.arrayOf(B.int4);
  const err = (code, msg, extra) => K.err(code, msg, extra);
  const flat = (a) => K.Expr.flat(a);
  const dims = (a) => (a.items.length ? a.dims() : []);
  const ndims = (a) => dims(a).length;
  const arrT = (w, i) => (w[i] && w[i].cat === 'A' ? w[i] : K.T.arrayOf(B.text));
  const elemOf = (t) => (t && t.cat === 'A' ? t.elem : null);
  /** NULL-aware equality, as IS NOT DISTINCT FROM */
  const same = (x, y, t) => (x === null || y === null ? x === y : K.T.compare(x, y, t) === 0);
  /** a value given where an element is expected, in the element type */
  const asElem = (v, from, et, ctx) => (v === null || !et || (from && from.id === et.id) ? v : K.T.cast(v, from && from.cat !== 'P' ? from : null, et, false, ctx));

  const dimArg = (a, d, f) => { const ds = dims(a); return d < 1 || d > ds.length ? null : f(ds, d); };
  F.fn('array_length', { args: ['anyarray', 'int4'], ret: 'int4', fn: (v) => dimArg(v[0], v[1], (ds, d) => ds[d - 1]) });
  F.fn('array_lower', { args: ['anyarray', 'int4'], ret: 'int4', fn: (v) => dimArg(v[0], v[1], (ds, d) => (d === 1 ? v[0].lower : 1)) });
  F.fn('array_upper', { args: ['anyarray', 'int4'], ret: 'int4', fn: (v) => dimArg(v[0], v[1], (ds, d) => (d === 1 ? v[0].lower : 1) + ds[d - 1] - 1) });
  F.fn('array_ndims', { args: ['anyarray'], ret: 'int4', fn: (v) => ndims(v[0]) || null });
  F.fn('array_dims', { args: ['anyarray'], ret: 'text', fn: (v) => { const ds = dims(v[0]); return ds.length ? ds.map((n, i) => '[' + (i ? 1 : v[0].lower) + ':' + ((i ? 1 : v[0].lower) + n - 1) + ']').join('') : null; } });
  F.fn('cardinality', { args: ['anyarray'], ret: 'int4', fn: (v) => (v[0].items.length ? dims(v[0]).reduce((a, b) => a * b, 1) : 0) });

  const oneDim = (a) => { if (a && ndims(a) > 1) throw err('22000', 'argument must be empty or one-dimensional array'); };
  function append(a, e) {
    if (a === null) return new A([e]);
    oneDim(a);
    return new A(a.items.concat([e]), a.items.length ? a.lower : 1);
  }
  function prepend(e, a) {
    if (a === null) return new A([e]);
    oneDim(a);
    return new A([e].concat(a.items), a.items.length ? a.lower : 1);
  }
  function cat(a, b) {
    if (a === null) return b;
    if (b === null) return a;
    const da = dims(a), db = dims(b);
    if (!da.length) return b;
    if (!db.length) return a;
    if (da.length === db.length) {
      if (da.slice(1).join() !== db.slice(1).join()) throw err('2202E', 'cannot concatenate incompatible arrays', { detail: 'Arrays with differing element dimensions are not compatible for concatenation.' });
      return new A(a.items.concat(b.items), a.lower);
    }
    if (da.length === db.length + 1) {
      if (da.slice(1).join() !== db.join()) throw err('2202E', 'cannot concatenate incompatible arrays', { detail: 'Arrays with differing dimensions are not compatible for concatenation.' });
      return new A(a.items.concat([new A(b.items)]), a.lower);
    }
    if (db.length === da.length + 1) {
      if (db.slice(1).join() !== da.join()) throw err('2202E', 'cannot concatenate incompatible arrays', { detail: 'Arrays with differing dimensions are not compatible for concatenation.' });
      return new A([new A(a.items)].concat(b.items), b.lower);
    }
    throw err('2202E', 'cannot concatenate incompatible arrays', { detail: 'Arrays of ' + da.length + ' and ' + db.length + ' dimensions are not compatible for concatenation.' });
  }
  F.fn('array_append', { args: ['anyarray', 'anyelement'], strict: false, ret: (w) => arrT(w, 0), fn: (v, ctx, info) => append(v[0], asElem(v[1], info.at[1], elemOf(info.rt), ctx)) });
  F.fn('array_prepend', { args: ['anyelement', 'anyarray'], strict: false, ret: (w) => arrT(w, 1), fn: (v, ctx, info) => prepend(asElem(v[0], info.at[0], elemOf(info.rt), ctx), v[1]) });
  F.fn('array_cat', { args: ['anyarray', 'anyarray'], strict: false, ret: (w) => arrT(w, 0), fn: (v) => cat(v[0], v[1]) });
  // || with an element on one side: the element side is 'any' so that an unknown literal such as '{3,4}' can be an array, as in PostgreSQL
  const elemOrArray = (v, from, at, ctx) => {
    if (v !== null && typeof v === 'string' && (!from || from.cat === 'P') && v.trim().startsWith('{')) return { arr: K.T.input(v, at, ctx) };
    if (v instanceof A) return { arr: v };
    return { el: asElem(v, from, at.elem, ctx) };
  };
  F.op('||', [
    { args: ['anyarray', 'anyarray'], strict: false, ret: (w) => arrT(w, 0), fn: (v) => cat(v[0], v[1]) },
    { args: ['anyarray', 'any'], strict: false, ret: (w) => arrT(w, 0), fn: (v, ctx, info) => { const r = elemOrArray(v[1], info.at[1], info.rt, ctx); return 'arr' in r ? cat(v[0], r.arr) : append(v[0], r.el); } },
    { args: ['any', 'anyarray'], strict: false, ret: (w) => arrT(w, 1), fn: (v, ctx, info) => { const r = elemOrArray(v[0], info.at[0], info.rt, ctx); return 'arr' in r ? cat(r.arr, v[1]) : prepend(r.el, v[1]); } },
  ]);

  F.fn('array_remove', { args: ['anyarray', 'anyelement'], strict: false, ret: (w) => arrT(w, 0), fn: (v, ctx, info) => {
    if (v[0] === null) return null;
    if (ndims(v[0]) > 1) throw err('0A000', 'removing elements from multidimensional arrays is not supported');
    const et = elemOf(info.at[0]), x = asElem(v[1], info.at[1], et, ctx);
    const items = v[0].items.filter((e) => !same(e, x, et));
    return new A(items, items.length ? v[0].lower : 1);
  } });
  F.fn('array_replace', { args: ['anyarray', 'anyelement', 'anyelement'], strict: false, ret: (w) => arrT(w, 0), fn: (v, ctx, info) => {
    if (v[0] === null) return null;
    const et = elemOf(info.at[0]), from = asElem(v[1], info.at[1], et, ctx), to = asElem(v[2], info.at[2], et, ctx);
    const map = (a) => new A(a.items.map((e) => (e instanceof A ? map(e) : same(e, from, et) ? to : e)), a.lower);
    return map(v[0]);
  } });
  const searchable = (a) => { if (ndims(a) > 1) throw err('0A000', 'searching for elements in multidimensional arrays is not supported'); };
  F.fn('array_position', { args: ['anyarray', 'anyelement', 'int4'], minArgs: 2, strict: false, ret: 'int4', fn: (v, ctx, info) => {
    if (v[0] === null) return null;
    searchable(v[0]);
    if (v.length > 2 && v[2] === null) throw err('22004', 'initial position must not be null');
    const a = v[0], et = elemOf(info.at[0]), x = asElem(v[1], info.at[1], et, ctx);
    const start = v.length > 2 ? Math.max(v[2] - a.lower, 0) : 0;
    for (let i = start; i < a.items.length; i++) if (same(a.items[i], x, et)) return i + a.lower;
    return null;
  } });
  F.fn('array_positions', { args: ['anyarray', 'anyelement'], strict: false, ret: () => INT4S, fn: (v, ctx, info) => {
    if (v[0] === null) return null;
    searchable(v[0]);
    const a = v[0], et = elemOf(info.at[0]), x = asElem(v[1], info.at[1], et, ctx);
    const out = [];
    a.items.forEach((e, i) => { if (same(e, x, et)) out.push(i + a.lower); });
    return new A(out);
  } });
  F.fn('array_to_string', { args: ['anyarray', 'text', 'text'], minArgs: 2, strict: false, ret: 'text', fn: (v, ctx, info) => {
    if (v[0] === null || v[1] === null) return null;
    const et = elemOf(info.at[0]), ns = v.length > 2 ? v[2] : null;
    const out = [];
    for (const e of flat(v[0])) { if (e === null) { if (ns !== null) out.push(ns); } else out.push(typeof e === 'string' ? e : K.T.output(e, et, ctx)); }
    return out.join(v[1]);
  } });
  F.fn('string_to_array', { args: ['text', 'text', 'text'], minArgs: 2, strict: false, ret: () => K.T.arrayOf(B.text), fn: (v) => {
    const [s, d] = v, ns = v.length > 2 ? v[2] : null;
    if (s === null) return null;
    if (s === '') return new A([]);
    const parts = d === null ? Array.from(s) : d === '' ? [s] : s.split(d);
    return new A(parts.map((p) => (ns !== null && p === ns ? null : p)));
  } });
  F.fn('array_fill', { args: ['anyelement', INT4S, INT4S], minArgs: 2, strict: false, ret: 'anyarray', fn: (v) => {
    if (v[1] === null || (v.length > 2 && v[2] === null)) throw err('22004', 'dimension array or low bound array cannot be null');
    const ds = v[1].items, lbs = v.length > 2 ? v[2].items : null;
    if (ds.some((x) => x === null)) throw err('22004', 'dimension values cannot be null');
    if (lbs && lbs.length !== ds.length) throw err('2202E', 'wrong number of array subscripts', { detail: 'Low bound array has different size than dimensions array.' });
    if (!ds.length) return new A([]);
    if (ds.some((n) => n < 0)) throw err('2202E', 'array size exceeds the maximum allowed (134217727)');
    if (ds.some((n) => n === 0)) return new A([]);
    const build = (k) => new A(Array.from({ length: ds[k] }, () => (k === ds.length - 1 ? v[0] : build(k + 1))));
    const r = build(0);
    if (lbs) r.lower = lbs[0];
    return r;
  } });
  F.fn('trim_array', { args: ['anyarray', 'int4'], ret: (w) => arrT(w, 0), fn: (v) => {
    const n = v[0].items.length;
    if (v[1] < 0 || v[1] > n) throw err('2202E', 'number of elements to trim must be between 0 and ' + n);
    return new A(v[0].items.slice(0, n - v[1]));
  } });
  const shuffle = (items) => { const a = items.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(K.rng.next() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  F.fn('array_shuffle', { args: ['anyarray'], volatile: true, ret: (w) => arrT(w, 0), fn: (v) => new A(shuffle(v[0].items), v[0].lower) });
  F.fn('array_sample', { args: ['anyarray', 'int4'], volatile: true, ret: (w) => arrT(w, 0), fn: (v) => {
    const n = v[0].items.length;
    if (v[1] < 0 || v[1] > n) throw err('22023', 'sample size must be between 0 and ' + n);
    return new A(shuffle(v[0].items).slice(0, v[1]));
  } });

  // containment and overlap: elements compared by equality, NULLs never match
  const elems = (a) => flat(a).filter((x) => x !== null);
  const containsAll = (a, b, t) => { const xs = elems(a); return flat(b).every((y) => y !== null && xs.some((x) => K.T.compare(x, y, t) === 0)); };
  F.op('@>', { args: ['anyarray', 'anyarray'], ret: 'bool', fn: (v, ctx, info) => containsAll(v[0], v[1], elemOf(info.at[0])) });
  F.op('<@', { args: ['anyarray', 'anyarray'], ret: 'bool', fn: (v, ctx, info) => containsAll(v[1], v[0], elemOf(info.at[0])) });
  F.op('&&', { args: ['anyarray', 'anyarray'], ret: 'bool', fn: (v, ctx, info) => { const xs = elems(v[0]), t = elemOf(info.at[0]); return elems(v[1]).some((y) => xs.some((x) => K.T.compare(x, y, t) === 0)); } });
})(typeof window !== 'undefined' ? window : globalThis);
