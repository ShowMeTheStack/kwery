// Built-in JSON: to_json/to_jsonb, the json(b)_build_* constructors, json_object, the -> ->> #> #>> @> <@ ? ?| ?&
// || - #- operators, jsonb_set/jsonb_insert, strip_nulls, jsonb_pretty, row_to_json, array_to_json, a subset of
// SQL/JSON path (jsonb_path_*), and __isjson for IS JSON.
(function (root) {
  'use strict';
  const K = root.K;
  const F = K.F;
  const B = K.T.BASE;
  const Dec = K.Decimal;
  const JsonV = K.JsonV;
  const TEXTS = K.T.arrayOf(B.text);
  const err = (code, msg, extra) => K.err(code, msg, extra);
  const isObj = (x) => x instanceof Map;
  const typeName = (x) => (x === null ? 'null' : isObj(x) ? 'object' : Array.isArray(x) ? 'array' : typeof x === 'string' ? 'string' : typeof x === 'boolean' ? 'boolean' : 'number');

  // ---- SQL values to JSON --------------------------------------------------------------------------------------------
  const keyOrder = (a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
  /** a jsonb object: keys ordered by length then bytewise, as PostgreSQL stores them */
  const sortMap = (m) => new Map([...m.entries()].sort((a, b) => keyOrder(a[0], b[0])));
  const str = (s) => JSON.stringify(s);
  function isoText(v, t, ctx) {
    const o = K.T.output(v, t, ctx);
    if (!Number.isFinite(v.us !== undefined ? v.us : v.days)) return o;
    if (t.id === 'timestamp') return o.replace(' ', 'T');
    if (t.id === 'timestamptz') return o.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
    return o;
  }
  /** the text of a json value (its original text for json, the canonical text for jsonb) */
  const jsonText = (v) => (v.binary ? K.jsonOut(v.v, true) : v.text !== undefined ? v.text : K.jsonOut(v.v, false));
  /** a SQL value as compact JSON text, as to_json writes it */
  function jtext(v, t, ctx, pretty) {
    if (v === null || v === undefined) return 'null';
    if (!t || t.cat === 'P') t = K.T.typeOfValue(v);
    if (t.domain) t = t.base;
    switch (t.cat) {
      case 'N':
        if (typeof v === 'number' && !Number.isFinite(v)) return str(K.T.output(v, t));
        return K.T.output(v, t);
      case 'B': return v ? 'true' : 'false';
      case 'J': return jsonText(v);
      case 'A': return arrText(v, t.elem || K.T.typeOfValue(v).elem, ctx, pretty);
      case 'C': return rowText(v, t, ctx, pretty);
      case 'D': return str(isoText(v, t, ctx));
      default: return str(K.T.output(v, t, ctx));
    }
  }
  function arrText(a, et, ctx, pretty) {
    const one = (x) => (x instanceof K.ArrayV ? '[' + x.items.map(one).join(',') + ']' : jtext(x, et, ctx));
    return '[' + a.items.map(one).join(pretty ? ',\n ' : ',') + ']';
  }
  function rowText(r, t, ctx, pretty) {
    const fields = (r.type && r.type.fields) || (t && t.fields) || r.values.map((_, i) => ({ name: 'f' + (i + 1) }));
    return '{' + r.values.map((x, i) => str(fields[i] ? fields[i].name : 'f' + (i + 1)) + ':' + jtext(x, fields[i] && fields[i].type, ctx)).join(pretty ? ',\n ' : ',') + '}';
  }
  const mkJson = (text) => K.T.jsonIn(text, false);
  const mkJsonb = (model) => new JsonV(model, true);
  /** a SQL value as a jsonb model */
  const jmodel = (v, t, ctx) => (v === null ? null : t && t.cat === 'J' && v.binary ? v.v : K.T.jsonIn(jtext(v, t, ctx), true).v);
  K.Json = { jtext, jmodel, sortMap, jsonText };

  F.fn('to_json', { args: ['anyelement'], ret: 'json', fn: (v, ctx, info) => mkJson(jtext(v[0], info.at[0], ctx)) });
  F.fn('to_jsonb', { args: ['anyelement'], ret: 'jsonb', fn: (v, ctx, info) => mkJsonb(jmodel(v[0], info.at[0], ctx)) });
  F.fn('row_to_json', { args: ['anyrow', 'bool'], minArgs: 1, ret: 'json', fn: (v, ctx, info) => mkJson(rowText(v[0], info.at[0], ctx, v[1] === true)) });
  F.fn('array_to_json', { args: ['anyarray', 'bool'], minArgs: 1, ret: 'json', fn: (v, ctx, info) => mkJson(arrText(v[0], info.at[0].elem, ctx, v[1] === true)) });

  function keyText(v, t, ctx, i) {
    if (v === null) throw err('22004', 'null value not allowed for object key');
    const c = t && t.cat !== 'P' ? (t.domain ? t.base.cat : t.cat) : K.T.typeOfValue(v).cat;
    if (c === 'A' || c === 'C' || c === 'J') throw err('22023', 'key value must be scalar, not array, composite, or json');
    if (typeof v === 'string') return v;
    const j = jtext(v, t, ctx);
    return j[0] === '"' ? JSON.parse(j) : j;
  }
  const evenArgs = (v) => { if (v.length % 2) throw err('22023', 'argument list must have even number of elements', { hint: 'The arguments of json_build_object() must consist of alternating keys and values.' }); };
  F.fn('json_build_object', { args: ['any'], variadic: true, minArgs: 0, strict: false, ret: 'json', fn: (v, ctx, info) => {
    evenArgs(v);
    const parts = [];
    for (let i = 0; i < v.length; i += 2) parts.push(str(keyText(v[i], info.at[i], ctx, i)) + ' : ' + jtext(v[i + 1], info.at[i + 1], ctx));
    return mkJson('{' + parts.join(', ') + '}');
  } });
  F.fn('jsonb_build_object', { args: ['any'], variadic: true, minArgs: 0, strict: false, ret: 'jsonb', fn: (v, ctx, info) => {
    if (v.length % 2) throw err('22023', 'argument list must have even number of elements', { hint: 'The arguments of jsonb_build_object() must consist of alternating keys and values.' });
    const m = new Map();
    for (let i = 0; i < v.length; i += 2) { if (v[i] === null) throw err('22023', 'argument ' + (i + 1) + ': key must not be null'); const k = keyText(v[i], info.at[i], ctx, i); m.delete(k); m.set(k, jmodel(v[i + 1], info.at[i + 1], ctx)); }
    return mkJsonb(sortMap(m));
  } });
  F.fn('json_build_array', { args: ['any'], variadic: true, minArgs: 0, strict: false, ret: 'json', fn: (v, ctx, info) => mkJson('[' + v.map((x, i) => jtext(x, info.at[i], ctx)).join(', ') + ']') });
  F.fn('jsonb_build_array', { args: ['any'], variadic: true, minArgs: 0, strict: false, ret: 'jsonb', fn: (v, ctx, info) => mkJsonb(v.map((x, i) => jmodel(x, info.at[i], ctx))) });

  /** json_object's argument forms: one flat or two-column array, or separate key and value arrays */
  function objectPairs(v) {
    if (v.length === 2) {
      const ks = v[0].items, vs = v[1].items;
      if (ks.some((x) => x instanceof K.ArrayV) || vs.some((x) => x instanceof K.ArrayV)) throw err('2202E', 'wrong number of array subscripts');
      if (ks.length !== vs.length) throw err('2202E', 'mismatched array dimensions');
      return ks.map((k, i) => [k, vs[i]]);
    }
    const a = v[0].items;
    if (!a.length) return [];
    if (a[0] instanceof K.ArrayV) {
      if (a.some((r) => r.items.length !== 2)) throw err('2202E', 'array must have two columns');
      return a.map((r) => [r.items[0], r.items[1]]);
    }
    if (a.length % 2) throw err('2202E', 'array must have even number of elements');
    const out = [];
    for (let i = 0; i < a.length; i += 2) out.push([a[i], a[i + 1]]);
    return out;
  }
  const nullKey = (k) => { if (k === null) throw err('22004', 'null value not allowed for object key'); return k; };
  F.fn('json_object', { args: [TEXTS, TEXTS], minArgs: 1, ret: 'json', fn: (v) => mkJson('{' + objectPairs(v).map(([k, x]) => str(nullKey(k)) + ' : ' + (x === null ? 'null' : str(x))).join(', ') + '}') });
  F.fn('jsonb_object', { args: [TEXTS, TEXTS], minArgs: 1, ret: 'jsonb', fn: (v) => { const m = new Map(); for (const [k, x] of objectPairs(v)) { m.delete(nullKey(k)); m.set(k, x); } return mkJsonb(sortMap(m)); } });

  // ---- reading json text with positions, so json (not jsonb) results keep their original text ------------------------
  const spanCache = new WeakMap();
  function spans(j) {
    let n = spanCache.get(j);
    if (n) return n;
    const s = jsonText(j);
    let i = 0;
    const ws = () => { while (i < s.length && ' \t\n\r'.includes(s[i])) i++; };
    const val = () => {
      ws();
      const start = i, c = s[i];
      if (c === '{') {
        i++; const pairs = []; ws();
        if (s[i] === '}') { i++; return { t: 'object', start, end: i, pairs }; }
        for (;;) { ws(); const k = val(); ws(); i++; pairs.push([JSON.parse(s.slice(k.start, k.end)), val()]); ws(); if (s[i++] === ',') continue; return { t: 'object', start, end: i, pairs }; }
      }
      if (c === '[') {
        i++; const items = []; ws();
        if (s[i] === ']') { i++; return { t: 'array', start, end: i, items }; }
        for (;;) { items.push(val()); ws(); if (s[i++] === ',') continue; return { t: 'array', start, end: i, items }; }
      }
      if (c === '"') { i++; while (s[i] !== '"') i += s[i] === '\\' ? 2 : 1; i++; return { t: 'string', start, end: i }; }
      const m = /^(-?\d[\d.eE+-]*|true|false|null)/.exec(s.slice(i));
      i += m[0].length;
      return { t: m[0] === 'null' ? 'null' : m[0] === 'true' || m[0] === 'false' ? 'boolean' : 'number', start, end: i };
    };
    n = val();
    n.src = s;
    spanCache.set(j, n);
    return n;
  }
  const spanText = (root_, n) => root_.src.slice(n.start, n.end);
  const spanJson = (root_, n) => { const t = spanText(root_, n); const j = new JsonV(K.T.jsonIn(t, false).v, false, t); spanCache.set(j, Object.assign({}, n, { src: root_.src })); return j; };
  /** one step into json text: a key of an object (the last one, when keys repeat) or an index of an array */
  function spanStep(n, k) {
    if (n.t === 'object' && typeof k === 'string') { let r = null; for (const [key, x] of n.pairs) if (key === k) r = x; return r; }
    if (n.t === 'array') { let i = typeof k === 'number' ? k : /^-?\d+$/.test(k) ? +k : NaN; if (Number.isNaN(i)) return null; if (i < 0) i += n.items.length; return n.items[i] || null; }
    return null;
  }
  const spanAsText = (r, n) => (n === null || n.t === 'null' ? null : n.t === 'string' ? JSON.parse(spanText(r, n)) : spanText(r, n));

  // ---- jsonb navigation ---------------------------------------------------------------------------------------------------
  function step(x, k) {
    if (isObj(x) && typeof k === 'string') return x.has(k) ? x.get(k) : undefined;
    if (Array.isArray(x)) { let i = typeof k === 'number' ? k : /^-?\d+$/.test(k) ? +k : NaN; if (Number.isNaN(i)) return undefined; if (i < 0) i += x.length; return i >= 0 && i < x.length ? x[i] : undefined; }
    return undefined;
  }
  const asText = (x) => (x === null || x === undefined ? null : typeof x === 'string' ? x : K.jsonOut(x, true));
  const pathItems = (a) => a.items.map((x, i) => { if (x instanceof K.ArrayV) throw err('2202E', 'wrong number of array subscripts'); return x; });
  function getPath(j, path, text) {
    const ks = pathItems(path);
    if (j.binary) {
      let x = j.v;
      for (const k of ks) { if (k === null) return null; x = step(x, k); if (x === undefined) return null; }
      return text ? asText(x) : mkJsonb(x);
    }
    const r = spans(j);
    let n = r;
    for (const k of ks) { if (k === null) return null; n = spanStep(n, k); if (!n) return null; }
    return text ? spanAsText(r, n) : spanJson(r, n);
  }
  function arrow(j, k, text) {
    // a jsonb scalar is stored as a one-element array, so -> 0 and -> -1 reach it
    if (j.binary && typeof k === 'number' && (k === 0 || k === -1) && !isObj(j.v) && !Array.isArray(j.v)) return text ? asText(j.v) : mkJsonb(j.v);
    if (j.binary) { const x = step(j.v, k); return x === undefined ? null : text ? asText(x) : mkJsonb(x); }
    const r = spans(j), n = spanStep(r, k);
    return n ? (text ? spanAsText(r, n) : spanJson(r, n)) : null;
  }
  for (const t of ['json', 'jsonb']) {
    F.op('->', [{ args: [t, 'text'], ret: t, fn: (v) => arrow(v[0], v[1], false) }, { args: [t, 'int4'], ret: t, fn: (v) => arrow(v[0], v[1], false) }]);
    F.op('->>', [{ args: [t, 'text'], ret: 'text', fn: (v) => arrow(v[0], v[1], true) }, { args: [t, 'int4'], ret: 'text', fn: (v) => arrow(v[0], v[1], true) }]);
    F.op('#>', { args: [t, TEXTS], ret: t, fn: (v) => getPath(v[0], v[1], false) });
    F.op('#>>', { args: [t, TEXTS], ret: 'text', fn: (v) => getPath(v[0], v[1], true) });
    F.fn(t + '_extract_path', { args: [t, 'text'], variadic: true, ret: t, fn: (v) => getPath(v[0], new K.ArrayV(v.slice(1)), false) });
    F.fn(t + '_extract_path_text', { args: [t, 'text'], variadic: true, ret: 'text', fn: (v) => getPath(v[0], new K.ArrayV(v.slice(1)), true) });
    F.fn(t + '_typeof', { args: [t], ret: 'text', fn: (v) => (v[0].binary ? typeName(v[0].v) : spans(v[0]).t) });
    F.fn(t + '_array_length', { args: [t], ret: 'int4', fn: (v) => {
      const x = v[0].binary ? v[0].v : null, n = v[0].binary ? null : spans(v[0]);
      const kind = n ? n.t : typeName(x);
      if (kind === 'array') return n ? n.items.length : x.length;
      throw err('22023', kind === 'object' ? 'cannot get array length of a non-array' : 'cannot get array length of a scalar');
    } });
  }

  // ---- jsonb operators ---------------------------------------------------------------------------------------------------
  const same = (a, b) => typeName(a) === typeName(b) && K.T.jsonCmp(a, b) === 0;
  function contains(a, b, top) {
    if (isObj(a) && isObj(b)) { for (const [k, x] of b) { if (!a.has(k) || !contains(a.get(k), x, false)) return false; } return true; }
    if (Array.isArray(a) && Array.isArray(b)) return b.every((e) => a.some((x) => (isObj(e) || Array.isArray(e) ? (isObj(x) || Array.isArray(x)) && contains(x, e, false) : same(x, e))));
    if (Array.isArray(a) && top && !isObj(b)) return a.some((x) => same(x, b));
    if (isObj(a) || isObj(b) || Array.isArray(a) || Array.isArray(b)) return false;
    return same(a, b);
  }
  const hasKey = (x, k) => (isObj(x) ? x.has(k) : Array.isArray(x) ? x.some((e) => e === k) : x === k);
  F.op('@>', { args: ['jsonb', 'jsonb'], ret: 'bool', fn: (v) => contains(v[0].v, v[1].v, true) });
  F.op('<@', { args: ['jsonb', 'jsonb'], ret: 'bool', fn: (v) => contains(v[1].v, v[0].v, true) });
  F.op('?', { args: ['jsonb', 'text'], ret: 'bool', fn: (v) => hasKey(v[0].v, v[1]) });
  F.op('?|', { args: ['jsonb', TEXTS], ret: 'bool', fn: (v) => v[1].items.some((k) => k !== null && hasKey(v[0].v, k)) });
  F.op('?&', { args: ['jsonb', TEXTS], ret: 'bool', fn: (v) => v[1].items.every((k) => k === null || hasKey(v[0].v, k)) });
  function concat(a, b) {
    if (isObj(a) && isObj(b)) { const m = new Map(a); for (const [k, x] of b) { m.delete(k); m.set(k, x); } return sortMap(m); }
    return [...(Array.isArray(a) ? a : [a]), ...(Array.isArray(b) ? b : [b])];
  }
  F.op('||', { args: ['jsonb', 'jsonb'], ret: 'jsonb', fn: (v) => mkJsonb(concat(v[0].v, v[1].v)) });
  const scalarDelete = () => err('22023', 'cannot delete from scalar');
  function delKeys(x, keys) {
    if (isObj(x)) { const m = new Map(x); for (const k of keys) m.delete(k); return m; }
    if (Array.isArray(x)) return x.filter((e) => !(typeof e === 'string' && keys.includes(e)));
    throw scalarDelete();
  }
  F.op('-', [
    { args: ['jsonb', 'text'], ret: 'jsonb', fn: (v) => mkJsonb(delKeys(v[0].v, [v[1]])) },
    { args: ['jsonb', TEXTS], ret: 'jsonb', fn: (v) => mkJsonb(delKeys(v[0].v, v[1].items.filter((k) => k !== null))) },
    { args: ['jsonb', 'int4'], ret: 'jsonb', fn: (v) => {
      const x = v[0].v;
      if (isObj(x)) throw err('22023', 'cannot delete from object using integer index');
      if (!Array.isArray(x)) throw scalarDelete();
      let i = v[1]; if (i < 0) i += x.length;
      return mkJsonb(x.filter((_, k) => k !== i));
    } },
  ]);
  const pathIndex = (k, pos) => { if (!/^\s*-?\d+\s*$/.test(k)) throw err('22P02', 'path element at position ' + pos + ' is not an integer: "' + k + '"'); return parseInt(k, 10); };
  function deletePath(x, ks, d) {
    if (d >= ks.length) return x;
    const k = ks[d];
    if (k === null) throw err('22004', 'path element at position ' + (d + 1) + ' is null');
    if (isObj(x)) {
      if (!x.has(k)) return x;
      const m = new Map(x);
      if (d === ks.length - 1) m.delete(k); else m.set(k, deletePath(x.get(k), ks, d + 1));
      return m;
    }
    if (Array.isArray(x)) {
      let i = pathIndex(k, d + 1); if (i < 0) i += x.length;
      if (i < 0 || i >= x.length) return x;
      const a = x.slice();
      if (d === ks.length - 1) a.splice(i, 1); else a[i] = deletePath(x[i], ks, d + 1);
      return a;
    }
    return x;
  }
  F.op('#-', { args: ['jsonb', TEXTS], ret: 'jsonb', fn: (v) => { if (!isObj(v[0].v) && !Array.isArray(v[0].v)) throw err('22023', 'cannot delete path in scalar'); return mkJsonb(deletePath(v[0].v, pathItems(v[1]), 0)); } });

  /** jsonb_set and jsonb_insert walk the same way; mode is 'set' (create or not) or 'before'/'after' */
  function setPath(x, ks, d, nv, mode, create) {
    const k = ks[d];
    if (k === null) throw err('22004', 'path element at position ' + (d + 1) + ' is null');
    const last = d === ks.length - 1;
    if (isObj(x)) {
      const m = new Map(x);
      if (x.has(k)) {
        if (last) { if (mode !== 'set') throw err('22023', 'cannot replace existing key', { hint: 'Try using the function jsonb_set to replace key value.' }); m.set(k, nv); }
        else m.set(k, setPath(x.get(k), ks, d + 1, nv, mode, create));
        return m;
      }
      if (last && (mode !== 'set' || create)) { m.set(k, nv); return sortMap(m); }
      return x;
    }
    if (Array.isArray(x)) {
      let i = pathIndex(k, d + 1);
      const n = x.length;
      if (i < 0) i += n;
      const a = x.slice();
      if (last) {
        if (mode === 'set') {
          if (i >= 0 && i < n) a[i] = nv;
          else if (create) { if (i < 0) a.unshift(nv); else a.push(nv); }
          return a;
        }
        if (i < 0) a.unshift(nv);
        else if (i >= n) a.push(nv);
        else a.splice(mode === 'after' ? i + 1 : i, 0, nv);
        return a;
      }
      if (i >= 0 && i < n) a[i] = setPath(x[i], ks, d + 1, nv, mode, create);
      return a;
    }
    return x;
  }
  const scalarSet = (x) => { if (!isObj(x) && !Array.isArray(x)) throw err('22023', 'cannot set path in scalar'); };
  F.fn('jsonb_set', { args: ['jsonb', TEXTS, 'jsonb', 'bool'], minArgs: 3, ret: 'jsonb', fn: (v) => {
    scalarSet(v[0].v);
    const ks = pathItems(v[1]);
    if (!ks.length) return v[0];
    return mkJsonb(setPath(v[0].v, ks, 0, v[2].v, 'set', v.length > 3 ? v[3] : true));
  } });
  F.fn('jsonb_set_lax', { args: ['jsonb', TEXTS, 'jsonb', 'bool', 'text'], minArgs: 3, strict: false, ret: 'jsonb', fn: (v) => {
    if (v[0] === null || v[1] === null || v[3] === null || v[4] === null) return null;
    const how = v.length > 4 ? v[4] : 'use_json_null';
    if (!['raise_exception', 'use_json_null', 'delete_key', 'return_target'].includes(how)) throw err('22023', 'null_value_treatment must be "delete_key", "return_target", "use_json_null", or "raise_exception"');
    let nv = v[2];
    if (nv === null) {
      if (how === 'raise_exception') throw err('22004', 'JSON value must not be null', { detail: 'Exception was raised because null_value_treatment is "raise_exception".', hint: 'To avoid, either change the null_value_treatment argument or ensure that an SQL NULL is not passed.' });
      if (how === 'return_target') return v[0];
      if (how === 'delete_key') { if (!isObj(v[0].v) && !Array.isArray(v[0].v)) throw err('22023', 'cannot delete path in scalar'); return mkJsonb(deletePath(v[0].v, pathItems(v[1]), 0)); }
      nv = mkJsonb(null);
    }
    scalarSet(v[0].v);
    const ks = pathItems(v[1]);
    if (!ks.length) return v[0];
    return mkJsonb(setPath(v[0].v, ks, 0, nv.v, 'set', v.length > 3 ? v[3] : true));
  } });
  F.fn('jsonb_insert', { args: ['jsonb', TEXTS, 'jsonb', 'bool'], minArgs: 3, ret: 'jsonb', fn: (v) => {
    scalarSet(v[0].v);
    const ks = pathItems(v[1]);
    if (!ks.length) return v[0];
    return mkJsonb(setPath(v[0].v, ks, 0, v[2].v, v.length > 3 && v[3] ? 'after' : 'before', true));
  } });

  // strip_nulls: object fields whose value is null go; nulls in arrays stay
  const strip = (x) => (isObj(x) ? new Map([...x].filter(([, e]) => e !== null).map(([k, e]) => [k, strip(e)])) : Array.isArray(x) ? x.map(strip) : x);
  F.fn('jsonb_strip_nulls', { args: ['jsonb'], ret: 'jsonb', fn: (v) => mkJsonb(strip(v[0].v)) });
  F.fn('json_strip_nulls', { args: ['json'], ret: 'json', fn: (v) => {
    const r = spans(v[0]);
    const out = (n) => {
      if (n.t === 'object') return '{' + n.pairs.filter(([, x]) => x.t !== 'null').map(([k, x]) => str(k) + ':' + out(x)).join(',') + '}';
      if (n.t === 'array') return '[' + n.items.map(out).join(',') + ']';
      return spanText(r, n);
    };
    return mkJson(out(r));
  } });
  function pretty(x, ind) {
    const pad = '    '.repeat(ind + 1), end = '    '.repeat(ind);
    if (isObj(x)) return x.size ? '{\n' + [...x].map(([k, e]) => pad + str(k) + ': ' + pretty(e, ind + 1)).join(',\n') + '\n' + end + '}' : '{\n' + end + '}';
    if (Array.isArray(x)) return x.length ? '[\n' + x.map((e) => pad + pretty(e, ind + 1)).join(',\n') + '\n' + end + ']' : '[\n' + end + ']';
    return K.jsonOut(x, true);
  }
  F.fn('jsonb_pretty', { args: ['jsonb'], ret: 'text', fn: (v) => pretty(v[0].v, 0) });

  // IS JSON [VALUE | OBJECT | ARRAY | SCALAR]; the binder marks IS NOT JSON on the call node
  F.fn('__isjson', { args: ['text', 'text'], ret: 'bool', fn: (v, ctx, info) => {
    let r;
    try {
      const j = K.T.jsonIn(v[0], false).v;
      r = v[1] === 'object' ? isObj(j) : v[1] === 'array' ? Array.isArray(j) : v[1] === 'scalar' ? !isObj(j) && !Array.isArray(j) : true;
    } catch (e) { if (!e.code) throw e; r = false; }
    return info && info.node && info.node.wrapNot ? !r : r;
  } });

  // ---- SQL/JSON path: a working subset -------------------------------------------------------------------------------------
  // $ @ $var, .key ."key" .* [n] [n to m] [last] [*], ? (filter), == != <> < <= > >= && || !, exists(), like_regex,
  // starts with, is unknown, + - * / %, and the methods size() type() double() abs() floor() ceiling() keyvalue()
  function lexPath(s) {
    const toks = [];
    for (let i = 0; i < s.length;) {
      const c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === '"') {
        let j = i + 1;
        while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
        if (j >= s.length) throw pathErr('unterminated quoted string');
        toks.push({ t: 'str', v: JSON.parse(s.slice(i, j + 1)) }); i = j + 1; continue;
      }
      const m = /^(\d+(\.\d*)?([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?)/.exec(s.slice(i));
      if (m && !(c === '.' && /[a-zA-Z_*"]/.test(s[i + 1] || ''))) { toks.push({ t: 'num', v: Dec.parse(m[0]) }); i += m[0].length; continue; }
      const w = /^\$?[a-zA-Z_][a-zA-Z_0-9]*/.exec(s.slice(i));
      if (w) { toks.push(w[0][0] === '$' ? { t: 'var', v: w[0].slice(1) } : { t: 'id', v: w[0] }); i += w[0].length; continue; }
      const o = ['==', '!=', '<>', '<=', '>=', '&&', '||', '$', '@', '.', '[', ']', '(', ')', '{', '}', ',', '*', '?', '<', '>', '!', '+', '-', '/', '%'].find((x) => s.startsWith(x, i));
      if (!o) throw pathErr('syntax error at or near "' + c + '" of jsonpath input');
      toks.push({ t: 'op', v: o }); i += o.length;
    }
    return toks;
  }
  const pathErr = (m) => err('42601', m);
  function parsePath(s) {
    const toks = lexPath(s);
    let i = 0, strict = false;
    const peek = (v, k = 0) => toks[i + k] && (toks[i + k].t === 'op' || toks[i + k].t === 'id') && toks[i + k].v === v;
    const eat = (v) => { if (peek(v)) { i++; return true; } return false; };
    const need = (v) => { if (!eat(v)) throw pathErr('syntax error at ' + (toks[i] ? 'or near "' + (toks[i].v.toString()) + '"' : 'end') + ' of jsonpath input'); };
    if (peek('strict')) { strict = true; i++; } else if (peek('lax')) i++;
    const orE = () => { let l = andE(); while (eat('||')) l = { k: 'or', l, r: andE() }; return l; };
    const andE = () => { let l = notE(); while (eat('&&')) l = { k: 'and', l, r: notE() }; return l; };
    const notE = () => (eat('!') ? { k: 'not', e: notE() } : cmpE());
    const cmpE = () => {
      if (peek('exists') && peek('(', 1)) { i += 2; const e = orE(); need(')'); return { k: 'exists', e }; }
      const l = addE();
      for (const o of ['==', '!=', '<>', '<=', '>=', '<', '>']) if (eat(o)) return { k: 'cmp', op: o === '<>' ? '!=' : o, l, r: addE() };
      if (eat('like_regex')) { const p = toks[i++]; let flags = ''; if (eat('flag')) flags = toks[i++].v; return { k: 'like', e: l, re: K.pgRegex(p.v, flags) }; }
      if (peek('starts') && peek('with', 1)) { i += 2; return { k: 'starts', e: l, r: addE() }; }
      if (peek('is') && peek('unknown', 1)) { i += 2; return { k: 'isunk', e: l }; }
      return l;
    };
    const addE = () => { let l = mulE(); for (;;) { if (eat('+')) l = { k: 'ar', op: '+', l, r: mulE() }; else if (eat('-')) l = { k: 'ar', op: '-', l, r: mulE() }; else return l; } };
    const mulE = () => { let l = unE(); for (;;) { const o = ['*', '/', '%'].find((x) => peek(x)); if (!o) return l; i++; l = { k: 'ar', op: o, l, r: unE() }; } };
    const unE = () => { if (eat('-')) return { k: 'neg', e: unE() }; if (eat('+')) return unE(); return postE(); };
    const postE = () => {
      let base;
      const t = toks[i];
      if (!t) throw pathErr('syntax error at end of jsonpath input');
      if (eat('$')) base = { k: 'root' };
      else if (eat('@')) base = { k: 'cur' };
      else if (t.t === 'var') { i++; base = { k: 'var', name: t.v }; }
      else if (t.t === 'num') { i++; base = { k: 'lit', v: t.v }; }
      else if (t.t === 'str') { i++; base = { k: 'lit', v: t.v }; }
      else if (peek('true')) { i++; base = { k: 'lit', v: true }; }
      else if (peek('false')) { i++; base = { k: 'lit', v: false }; }
      else if (peek('null')) { i++; base = { k: 'lit', v: null }; }
      else if (peek('last')) { i++; base = { k: 'last' }; }
      else if (eat('(')) { base = orE(); need(')'); }
      else throw pathErr('syntax error at or near "' + t.v + '" of jsonpath input');
      const steps = [];
      for (;;) {
        if (eat('.')) {
          if (eat('*')) {
            if (!eat('*')) { steps.push({ k: 'anykey' }); continue; }
            // .** or .**{n} or .**{n to m}: every value at those nesting levels
            let lo = 0, hi = Infinity;
            if (eat('{')) {
              const lvl = () => { if (eat('last')) return Infinity; const t = toks[i++]; if (!t || t.t !== 'num') throw pathErr('syntax error at or near "' + (t ? t.v : '') + '" of jsonpath input'); return Number(t.v.trunc(0).d); };
              lo = hi = lvl();
              if (eat('to')) hi = lvl();
              need('}');
            }
            steps.push({ k: 'anypath', lo, hi });
            continue;
          }
          const n = toks[i++];
          if (!n) throw pathErr('syntax error at end of jsonpath input');
          if (n.t === 'id' && peek('(')) { i++; need(')'); steps.push({ k: 'method', name: n.v }); continue; }
          steps.push({ k: 'key', name: String(n.v) });
          continue;
        }
        if (eat('[')) {
          if (eat('*')) { need(']'); steps.push({ k: 'anyidx' }); continue; }
          const subs = [];
          do { const a = addE(); let b = null; if (eat('to')) b = addE(); subs.push([a, b]); } while (eat(','));
          need(']');
          steps.push({ k: 'idx', subs });
          continue;
        }
        if (eat('?')) { need('('); const f = orE(); need(')'); steps.push({ k: 'filter', f }); continue; }
        break;
      }
      return steps.length ? { k: 'path', base, steps } : base;
    };
    const e = orE();
    if (i < toks.length) throw pathErr('syntax error at or near "' + toks[i].v + '" of jsonpath input');
    return { e, strict };
  }
  const pathCache = new Map();
  /** evaluate a path: a sequence of JSON values (booleans for predicates, with null as unknown) */
  function evalPath(src, json, vars, silent) {
    let p = pathCache.get(src);
    if (!p) { p = parsePath(src); if (pathCache.size > 200) pathCache.clear(); pathCache.set(src, p); }
    const strict = p.strict;
    const fail = (m) => {
      const code = /does not contain key|member accessor/.test(m) ? '2203A' : /array accessor/.test(m) ? '22039' : /subscript is out of bounds/.test(m) ? '22033'
        : /variable/.test(m) ? '42704' : '22038';
      const e = err(code, m); e.pathErr = true; throw e;
    };
    const ev = (n, cur, lastIdx) => {
      switch (n.k) {
        case 'root': return [json];
        case 'cur': return [cur];
        case 'lit': return [n.v];
        case 'last': if (lastIdx === undefined) fail('LAST is allowed only in array subscripts'); return [new Dec(BigInt(lastIdx), 0)];
        case 'var': {
          if (!vars || !isObj(vars) || !vars.has(n.name)) fail('could not find jsonpath variable "' + n.name + '"');
          return [vars.get(n.name)];
        }
        case 'path': {
          let seq = ev(n.base, cur, lastIdx);
          for (const s of n.steps) seq = seq.flatMap((x) => stepPath(s, x, lastIdx));
          return seq;
        }
        case 'neg': return ev(n.e, cur, lastIdx).map((x) => { if (!(x instanceof Dec)) fail('operand of unary jsonpath operator - is not a numeric value'); return x.neg(); });
        case 'ar': {
          const a = ev(n.l, cur, lastIdx), b = ev(n.r, cur, lastIdx);
          if (a.length !== 1 || !(a[0] instanceof Dec)) fail('left operand of jsonpath operator ' + n.op + ' is not a single numeric value');
          if (b.length !== 1 || !(b[0] instanceof Dec)) fail('right operand of jsonpath operator ' + n.op + ' is not a single numeric value');
          return [K.F.arith(n.op, a[0], b[0], B.numeric)];
        }
        default: return [pred(n, cur, lastIdx)];
      }
    };
    const unwrap = (seq) => seq.flatMap((x) => (Array.isArray(x) && !strict ? x : [x]));
    const pred = (n, cur, lastIdx) => {
      switch (n.k) {
        case 'and': { const a = pred(n.l, cur, lastIdx); if (a === false) return false; const b = pred(n.r, cur, lastIdx); return a === null || b === null ? (b === false ? false : null) : b; }
        case 'or': { const a = pred(n.l, cur, lastIdx); if (a === true) return true; const b = pred(n.r, cur, lastIdx); return a === null || b === null ? (b === true ? true : null) : b; }
        case 'not': { const a = pred(n.e, cur, lastIdx); return a === null ? null : !a; }
        case 'isunk': return pred(n.e, cur, lastIdx) === null;
        case 'exists': try { return ev(n.e, cur, lastIdx).length > 0; } catch (e) { if (e.pathErr) return null; throw e; }
        case 'cmp': {
          let a, b;
          try { a = unwrap(ev(n.l, cur, lastIdx)); b = unwrap(ev(n.r, cur, lastIdx)); } catch (e) { if (e.pathErr) return null; throw e; }
          let unknown = false;
          for (const x of a) for (const y of b) {
            const r = cmp(n.op, x, y);
            if (r === true) return true;
            if (r === null) unknown = true;
          }
          return unknown ? null : false;
        }
        case 'like': { let found = false; for (const x of unwrap(ev(n.e, cur, lastIdx))) { if (typeof x !== 'string') return null; n.re.lastIndex = 0; if (n.re.test(x)) found = true; } return found; }
        case 'starts': { const p = ev(n.r, cur, lastIdx)[0]; let found = false; for (const x of unwrap(ev(n.e, cur, lastIdx))) { if (typeof x !== 'string' || typeof p !== 'string') return null; if (x.startsWith(p)) found = true; } return found; }
        default: { const r = ev(n, cur, lastIdx); return r.length === 1 && typeof r[0] === 'boolean' ? r[0] : null; }
      }
    };
    const cmp = (o, x, y) => {
      const tx = typeName(x), ty = typeName(y);
      if (tx === 'object' || tx === 'array' || ty === 'object' || ty === 'array') return null;
      if (tx === 'null' || ty === 'null') { const eq = tx === ty; return o === '==' ? eq : o === '!=' ? !eq : false; }
      if (tx !== ty) return null;
      const c = tx === 'number' ? x.cmp(y) : tx === 'string' ? (x < y ? -1 : x > y ? 1 : 0) : x === y ? 0 : x ? 1 : -1;
      if (tx === 'boolean' && o !== '==' && o !== '!=') return null;
      return o === '==' ? c === 0 : o === '!=' ? c !== 0 : o === '<' ? c < 0 : o === '<=' ? c <= 0 : o === '>' ? c > 0 : c >= 0;
    };
    const stepPath = (s, x, lastIdx) => {
      switch (s.k) {
        case 'key':
          if (isObj(x)) { if (x.has(s.name)) return [x.get(s.name)]; if (strict) fail('JSON object does not contain key "' + s.name + '"'); return []; }
          if (Array.isArray(x) && !strict) return x.flatMap((e) => stepPath(s, e, lastIdx));
          if (strict) fail('jsonpath member accessor can only be applied to an object');
          return [];
        case 'anykey':
          if (isObj(x)) return [...x.values()];
          if (Array.isArray(x) && !strict) return x.flatMap((e) => (isObj(e) ? [...e.values()] : []));
          if (strict) fail('jsonpath wildcard member accessor can only be applied to an object');
          return [];
        case 'anypath': {
          const out = [];
          const walk = (v, lvl) => {
            if (lvl > s.hi) return;
            if (lvl >= s.lo) out.push(v);
            if (isObj(v)) for (const e of v.values()) walk(e, lvl + 1);
            else if (Array.isArray(v)) for (const e of v) walk(e, lvl + 1);
          };
          walk(x, 0);
          return out;
        }
        case 'anyidx':
          if (Array.isArray(x)) return x;
          if (strict) fail('jsonpath wildcard array accessor can only be applied to an array');
          return [x];
        case 'idx': {
          const arr = Array.isArray(x) ? x : strict ? fail('jsonpath array accessor can only be applied to an array') : [x];
          const out = [];
          const num = (e) => { const r = ev(e, x, arr.length - 1); if (r.length !== 1 || !(r[0] instanceof Dec)) fail('jsonpath array subscript is not a single numeric value'); return Number(r[0].trunc(0).d); };
          for (const [a, b] of s.subs) {
            const from = num(a), to = b ? num(b) : from;
            if (strict && (from < 0 || to >= arr.length || from > to)) fail('jsonpath array subscript is out of bounds');
            for (let k = Math.max(from, 0); k <= Math.min(to, arr.length - 1); k++) out.push(arr[k]);
          }
          return out;
        }
        case 'filter': {
          const items = Array.isArray(x) && !strict ? x : [x];
          return items.filter((e) => pred(s.f, e, lastIdx) === true);
        }
        case 'method': {
          const m = s.name;
          if (m === 'size') return [new Dec(BigInt(Array.isArray(x) ? x.length : 1), 0)];
          if (m === 'type') return [typeName(x)];
          const items = Array.isArray(x) && !strict ? x : [x];
          if (m === 'keyvalue') return items.flatMap((e) => { if (!isObj(e)) fail('jsonpath item method .keyvalue() can only be applied to an object'); return [...e].map(([k, v]) => sortMap(new Map([['key', k], ['value', v], ['id', new Dec(0n, 0)]]))); });
          return items.map((e) => {
            let d = e;
            if (m === 'double' && typeof e === 'string') { if (!/^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(e)) fail('argument "' + e + '" of jsonpath item method .double() is invalid for type double precision'); d = Dec.parse(e.trim()); }
            if (!(d instanceof Dec)) fail('jsonpath item method .' + m + '() can only be applied to a numeric value');
            if (m === 'double' || m === 'number') return d;
            if (m === 'abs') return d.abs();
            if (m === 'floor') return d.floor();
            if (m === 'ceiling') return d.ceil();
            fail('jsonpath item method .' + m + '() is not supported');
            return null;
          });
        }
      }
      return [];
    };
    try { return ev(p.e, json, undefined); } catch (e) { if (silent && e.pathErr) return null; throw e; }
  }
  const varsOf = (v) => (v.length > 2 && v[2] ? v[2].v : null);
  const silentOf = (v) => v.length > 3 && v[3] === true;
  const pathArgs = { args: ['jsonb', 'text', 'jsonb', 'bool'], minArgs: 2 };
  F.fn('jsonb_path_exists', Object.assign({}, pathArgs, { ret: 'bool', fn: (v) => { const r = evalPath(v[1], v[0].v, varsOf(v), silentOf(v)); return r === null ? null : r.length > 0; } }));
  F.fn('jsonb_path_match', Object.assign({}, pathArgs, { ret: 'bool', fn: (v) => {
    const r = evalPath(v[1], v[0].v, varsOf(v), silentOf(v));
    if (r === null) return null;
    if (r.length === 1 && (typeof r[0] === 'boolean' || r[0] === null)) return r[0];
    if (silentOf(v)) return null;
    throw err('22038', 'single boolean result is expected');
  } }));
  F.op('@?', { args: ['jsonb', 'text'], ret: 'bool', fn: (v) => { const r = evalPath(v[1], v[0].v, null, true); return r === null ? null : r.length > 0; } });
  F.op('@@', { args: ['jsonb', 'text'], ret: 'bool', fn: (v) => { const r = evalPath(v[1], v[0].v, null, true); return r && r.length === 1 && typeof r[0] === 'boolean' ? r[0] : null; } });
  F.fn('jsonb_path_query_first', Object.assign({}, pathArgs, { ret: 'jsonb', fn: (v) => { const r = evalPath(v[1], v[0].v, varsOf(v), silentOf(v)); return r && r.length ? mkJsonb(r[0]) : null; } }));
  F.fn('jsonb_path_query_array', Object.assign({}, pathArgs, { ret: 'jsonb', fn: (v) => { const r = evalPath(v[1], v[0].v, varsOf(v), silentOf(v)); return r === null ? null : mkJsonb(r); } }));
  K.Json.evalPath = evalPath;
})(typeof window !== 'undefined' ? window : globalThis);
