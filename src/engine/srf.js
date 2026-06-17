// Functions in FROM: the set-returning built-ins (generate_series, unnest, generate_subscripts, the JSON
// expanders, regexp_matches, regexp_split_to_table, string_to_table), user functions returning SETOF or TABLE,
// and any scalar function, which gives one row. ROWS FROM (...) zips several calls side by side, padding the
// shorter ones with NULLs; WITH ORDINALITY adds a row number. The database object sets db.srf = K.SRF.
(function (root) {
  'use strict';
  const K = root.K;
  const S = K.STATE;
  const B = () => K.T.BASE;
  const D = () => K.Decimal;
  const base = (t) => (t && t.domain ? t.base : t);
  const DEFS = new Map();
  const def = (name, d) => DEFS.set(name, Object.assign({ name }, d));
  const one = (name, type) => [{ name, type }];
  const fail = (code, msg) => { throw K.err(code, msg); };

  // ---- generate_series ---------------------------------------------------------------------------------------
  const series = (t, stepT) => [{ args: [t, t], ret: t }, { args: [t, t, stepT || t], ret: t }];
  /** timestamp (or timestamptz, in the session's zone) plus an interval, the calendar way */
  function tsPlus(v, iv, zone) {
    if (!Number.isFinite(v.us)) return v;
    if (!v.tz) return new K.TimestampV(K.Windows.addInterval(v.us, iv, 1), false);
    return new K.TimestampV(K.DT.addIv(v.us, iv, 1, zone), true);
  }
  def('generate_series', {
    overloads: [].concat(series('int4'), series('int8'), series('numeric'), series('timestamptz', 'interval'), series('timestamp', 'interval')),
    pick(types) {
      // date arguments go to the timestamptz version, which PostgreSQL prefers among the datetime types
      if (types.some((t) => t && base(t).id === 'date') && types.length === 3) return { argTypes: [B().timestamptz, B().timestamptz, B().interval], ret: B().timestamptz };
      return null;
    },
    cols: (r) => one('generate_series', r.ret),
    est(vals) {
      if (vals.some((v) => v === undefined)) return 1000;
      const [a, b, s] = vals;
      if (typeof a === 'number' && typeof b === 'number') return Math.max(0, Math.floor((b - a) / (s || 1)) + 1);
      return 1000;
    },
    *rows([a, b, step], c, ctx) {
      const t = c.ret;
      if (t.cat === 'D') {
        if (step === undefined) fail(S.undefinedFunction, 'function generate_series(' + K.T.sqlName(t) + ', ' + K.T.sqlName(t) + ') does not exist');
        const sign = step.total() > 0 ? 1 : step.total() < 0 ? -1 : 0;
        if (!sign) fail(S.invalidParameter, 'step size cannot equal zero');
        if (!Number.isFinite(a.us)) fail(S.invalidParameter, 'start value cannot be infinity');
        if (!Number.isFinite(b.us)) fail(S.invalidParameter, 'stop value cannot be infinity');
        const zone = (ctx.settings && ctx.settings.timezone) || K.ctxZone().zone;
        for (let v = a; sign > 0 ? v.us <= b.us : v.us >= b.us; v = tsPlus(v, step, zone)) yield [v];
        return;
      }
      if (t.id === 'numeric') {
        if ([a, b, step].some((x) => typeof x === 'number' && Number.isNaN(x))) fail(S.invalidParameter, (Number.isNaN(a) ? 'start' : Number.isNaN(b) ? 'stop' : 'step size') + ' value cannot be NaN');
        const st = step === undefined ? D().of(1) : D().of(step);
        if (st.isZero()) fail(S.invalidParameter, 'step size cannot equal zero');
        const up = st.sign() > 0;
        for (let v = D().of(a); up ? v.cmp(b) <= 0 : v.cmp(b) >= 0; v = v.add(st)) yield [v];
        return;
      }
      if (t.big) {
        const st = step === undefined ? 1n : BigInt(step);
        if (st === 0n) fail(S.invalidParameter, 'step size cannot equal zero');
        for (let v = BigInt(a); st > 0n ? v <= b : v >= b; v += st) { yield [v]; if (v + st > t.max || v + st < t.min) return; }
        return;
      }
      const st = step === undefined ? 1 : step;
      if (st === 0) fail(S.invalidParameter, 'step size cannot equal zero');
      for (let v = a; st > 0 ? v <= b : v >= b; v += st) { yield [v]; if (v + st > t.max || v + st < t.min) return; }
    },
  });

  // ---- arrays --------------------------------------------------------------------------------------------------
  const elemOf = (t) => { t = base(t); while (t && t.cat === 'A') t = base(t.elem); return t; };
  const flatten = (a) => { const out = []; const walk = (x) => { for (const v of x.items) if (v instanceof K.ArrayV) walk(v); else out.push(v); }; walk(a); return out; };
  const polyFail = () => fail(S.datatypeMismatch, 'could not determine polymorphic type because input has type unknown');
  def('unnest', {
    resolve(types) {
      if (!types.length) return null;
      if (types.some((t) => !t || t.cat === 'P')) polyFail();
      if (types.some((t) => base(t).cat !== 'A')) return null;
      return { argTypes: types, ret: elemOf(types[0]) };
    },
    cols: (r) => r.argTypes.map((t) => ({ name: 'unnest', type: elemOf(t) })),
    strict: false,
    est: (vals) => Math.max(1, ...vals.map((v) => (v instanceof K.ArrayV ? flatten(v).length : 10))),
    *rows(vals) {
      const lists = vals.map((v) => (v === null ? [] : flatten(v)));
      const n = Math.max(0, ...lists.map((l) => l.length));
      for (let i = 0; i < n; i++) yield lists.map((l) => (i < l.length ? l[i] : null));
    },
  });
  def('generate_subscripts', {
    resolve(types) {
      if (types.length < 2 || types.length > 3) return null;
      if (!types[0] || types[0].cat === 'P') polyFail();
      if (base(types[0]).cat !== 'A') return null;
      return { argTypes: [types[0], B().int4, B().bool].slice(0, types.length), ret: B().int4 };
    },
    cols: () => one('generate_subscripts', B().int4),
    *rows([a, dim, rev]) {
      const dims = a.items.length ? a.dims() : [];
      if (dim < 1 || dim > dims.length) return;
      const lo = dim === 1 ? a.lower : 1, hi = lo + dims[dim - 1] - 1;
      if (rev) for (let i = hi; i >= lo; i--) yield [i];
      else for (let i = lo; i <= hi; i++) yield [i];
    },
  });

  // ---- JSON ----------------------------------------------------------------------------------------------------
  /** the top-level items of a JSON text as raw substrings: json keeps its text, duplicate keys and key order */
  function rawItems(text) {
    let i = 0;
    const ws = () => { while (i < text.length && /\s/.test(text[i])) i++; };
    const skipValue = () => {
      ws();
      const st = i;
      let depth = 0;
      for (; i < text.length; i++) {
        const c = text[i];
        if (c === '"') { i++; while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++; } if (!depth) { i++; break; } continue; }
        if (c === '{' || c === '[') depth++;
        else if (c === '}' || c === ']') { if (!depth) break; depth--; if (!depth) { i++; break; } }
        else if (!depth && (c === ',' || /\s/.test(c))) break;
      }
      return text.slice(st, i).trim();
    };
    ws();
    const open = text[i];
    const out = [];
    if (open !== '{' && open !== '[') return null;
    i++; ws();
    if (text[i] === (open === '{' ? '}' : ']')) return out;
    for (;;) {
      ws();
      if (open === '{') {
        const k = skipValue(); ws(); i++; // the colon
        out.push([JSON.parse(k), skipValue()]);
      } else out.push([null, skipValue()]);
      ws();
      if (text[i] === ',') { i++; continue; }
      break;
    }
    return out;
  }
  const kindOf = (m) => (m === null ? 'null' : Array.isArray(m) ? 'array' : m instanceof Map ? 'object' : 'scalar');
  /** the items of a json or jsonb value: [key, JsonV, text-or-null] */
  function jsonItems(v, want, fname) {
    const k = kindOf(v.v), a = k === 'array' ? 'an array' : 'a scalar';
    if (want === 'keys' && k !== 'object') fail(S.invalidParameter, 'cannot call ' + fname + ' on ' + a);
    if (want === 'object' && k !== 'object') fail(S.invalidParameter, v.binary ? 'cannot call ' + fname + ' on a non-object' : k === 'array' ? 'cannot deconstruct an array as an object' : 'cannot deconstruct a scalar');
    if (want === 'array' && k !== 'array') fail(S.invalidParameter, v.binary ? 'cannot extract elements from ' + (k === 'object' ? 'an object' : 'a scalar') : 'cannot call ' + fname + ' on ' + (k === 'object' ? 'a non-array' : 'a scalar'));
    if (want === 'keys') want = 'object';
    const asText = (m, raw) => (m === null ? null : typeof m === 'string' ? m : raw !== undefined ? raw : K.jsonOut(m, true));
    if (v.binary) {
      const entries = want === 'object' ? [...v.v.entries()] : v.v.map((x) => [null, x]);
      return entries.map(([key, m]) => [key, new K.JsonV(m, true), asText(m)]);
    }
    const raw = rawItems(v.text !== undefined ? v.text : K.jsonOut(v.v, false));
    return raw.map(([key, r]) => { const j = K.T.jsonIn(r, false); return [key, j, asText(j.v, r)]; });
  }
  const jsonArg = (id) => (types) => {
    if (types.length !== 1) return null;
    const t = base(types[0]);
    if (t && t.cat !== 'P' && t.id !== id) return null;
    return { argTypes: [B()[id]], ret: B()[id] };
  };
  for (const id of ['json', 'jsonb']) {
    def(id + '_each', { resolve: jsonArg(id), cols: () => [{ name: 'key', type: B().text }, { name: 'value', type: B()[id] }], *rows([v]) { for (const [k, j] of jsonItems(v, 'object', id + '_each')) yield [k, j]; } });
    def(id + '_each_text', { resolve: jsonArg(id), cols: () => [{ name: 'key', type: B().text }, { name: 'value', type: B().text }], *rows([v]) { for (const [k, , t] of jsonItems(v, 'object', id + '_each_text')) yield [k, t]; } });
    def(id + '_array_elements', { resolve: jsonArg(id), cols: () => one('value', B()[id]), *rows([v]) { for (const [, j] of jsonItems(v, 'array', id + '_array_elements')) yield [j]; } });
    def(id + '_array_elements_text', { resolve: jsonArg(id), cols: () => one('value', B().text), *rows([v]) { for (const [, , t] of jsonItems(v, 'array', id + '_array_elements_text')) yield [t]; } });
    def(id + '_object_keys', { resolve: jsonArg(id), cols: () => one(id + '_object_keys', B().text), *rows([v]) { for (const [k] of jsonItems(v, 'keys', id + '_object_keys')) yield [k]; } });
    def(id + '_to_record', { resolve: jsonArg(id), cols: recordCols, *rows([v], c, ctx) { if (kindOf(v.v) !== 'object') fail(S.invalidParameter, 'cannot call populate_composite on ' + (kindOf(v.v) === 'array' ? 'an array' : 'a scalar')); yield recordRow(v.v, c.cols, ctx); } });
    def(id + '_to_recordset', {
      resolve: jsonArg(id), cols: recordCols,
      *rows([v], c, ctx) {
        if (kindOf(v.v) !== 'array') fail(S.invalidParameter, 'cannot call ' + id + '_to_recordset on a non-array');
        for (const m of v.v) { if (kindOf(m) !== 'object') fail(S.invalidParameter, 'argument of ' + id + '_to_recordset must be an array of objects'); yield recordRow(m, c.cols, ctx); }
      },
    });
  }
  def('jsonb_path_query', {
    resolve: (types) => (types.length < 2 || types.length > 4 ? null : { argTypes: [B().jsonb, B().text, B().jsonb, B().bool].slice(0, types.length), ret: B().jsonb }),
    cols: () => one('jsonb_path_query', B().jsonb),
    *rows([v, p, vars, silent]) { for (const m of K.Json.evalPath(p, v.v, vars ? vars.v : null, silent === true) || []) yield [new K.JsonV(m, true)]; },
  });
  /** functions returning record take their columns from the alias: AS x(a int, b text) */
  function recordCols(r, args, binder, ast, alias) {
    if (!alias || !alias.cols || !alias.types || alias.types.some((t) => !t)) fail(S.syntax, 'a column definition list is required for functions returning "record"');
    return alias.cols.map((name, i) => ({ name, type: binder.typeOf(alias.types[i]) }));
  }
  /** a JSON value converted to a column's type, as json_populate_record does */
  function fromJson(m, t, ctx) {
    if (m === null || m === undefined) return null;
    const bt = base(t);
    if (bt.cat === 'J') { const text = K.jsonOut(m, bt.id === 'jsonb'); return K.T.jsonIn(text, bt.id === 'jsonb'); }
    if (typeof m === 'string') return K.T.input(m, t, K.ctxZone());
    if (bt.cat === 'A' && Array.isArray(m)) return new K.ArrayV(m.map((x) => (Array.isArray(x) ? fromJson(x, t, ctx) : fromJson(x, bt.elem, ctx))));
    if (bt.cat === 'C' && m instanceof Map && bt.fields) return new K.RowV(bt.fields.map((f) => fromJson(m.get(f.name), f.type, ctx)), bt);
    return K.T.input(K.jsonOut(m, true), t, K.ctxZone());
  }
  const recordRow = (obj, cols, ctx) => cols.map((c) => fromJson(obj.get(c.srcName || c.name), c.type, ctx));

  // ---- text ----------------------------------------------------------------------------------------------------
  /** a PostgreSQL (POSIX ARE) regular expression as a JavaScript one: the common extensions translated */
  function pgRegex(pat, flags, global) {
    let f = 'u', newline = false;
    for (const ch of flags || '') {
      if (ch === 'g') { if (!global) fail(S.invalidParameter, 'regexp_split_to_table() does not support the "global" option'); }
      else if (ch === 'i') { if (!f.includes('i')) f += 'i'; }
      else if (ch === 'c') f = f.replace('i', '');
      else if (ch === 'n' || ch === 'w') newline = true;
      else if (ch === 'p' || ch === 's' || ch === 'x' || ch === 'q' || ch === 't' || ch === 'e' || ch === 'b') { /* accepted, close enough */ }
      else fail(S.invalidParameter, 'invalid regular expression option: "' + ch + '"');
    }
    f += newline ? 'm' : 's';
    const classes = { alpha: '\\p{L}', digit: '0-9', alnum: '\\p{L}0-9', upper: '\\p{Lu}', lower: '\\p{Ll}', space: '\\s', punct: '\\p{P}', xdigit: '0-9A-Fa-f', word: '\\w', blank: ' \\t', cntrl: '\\p{Cc}', print: '\\P{Cc}', graph: '\\p{L}\\p{N}\\p{P}\\p{S}' };
    let src = pat.replace(/\[:(\w+):\]/g, (m, c) => classes[c] || m).replace(/\\y/g, '\\b').replace(/\\m/g, '\\b(?=\\w)').replace(/\\M/g, '\\b(?<=\\w)').replace(/\\A/g, '^').replace(/\\Z/g, '$');
    try { return new RegExp(src, f + 'g'); }
    catch (e) {
      try { src = src.replace(/\\p\{\w+\}|\\P\{\w+\}/g, '\\w'); return new RegExp(src, f.replace('u', '') + 'g'); }
      catch (e2) { fail('2201B', 'invalid regular expression: ' + e2.message.replace(/^Invalid regular expression: /, '')); }
    }
    return null;
  }
  /** the matches PostgreSQL's regexp functions see; ignoreDegenerate drops empty matches at the ends and after a match */
  function matches(str, re, global, ignoreDegenerate) {
    const out = [];
    let start = 0, prevEnd = 0;
    while (start <= str.length) {
      re.lastIndex = start;
      const m = re.exec(str);
      if (!m) break;
      const so = m.index, eo = so + m[0].length;
      if (!ignoreDegenerate || (so < str.length && eo > prevEnd)) { out.push(m); prevEnd = eo; }
      if (!global) break;
      start = eo + (so === eo ? 1 : 0);
    }
    return out;
  }
  const textArgs = (min, max, ret) => (types) => {
    if (types.length < min || types.length > max) return null;
    if (types.some((t) => t && base(t).cat !== 'S' && t.cat !== 'P')) return null;
    return { argTypes: types.map(() => B().text), ret };
  };
  def('regexp_matches', {
    resolve: textArgs(2, 3, null),
    cols: () => one('regexp_matches', K.T.arrayOf(B().text)),
    *rows([s, p, flags]) {
      const g = (flags || '').includes('g');
      for (const m of matches(s, pgRegex(p, flags, true), g, false)) yield [new K.ArrayV(m.length > 1 ? m.slice(1).map((x) => (x === undefined ? null : x)) : [m[0]])];
    },
  });
  def('regexp_split_to_table', {
    resolve: textArgs(2, 3, null),
    cols: () => one('regexp_split_to_table', B().text),
    *rows([s, p, flags]) {
      let prev = 0;
      for (const m of matches(s, pgRegex(p, flags, false), true, true)) { yield [s.slice(prev, m.index)]; prev = m.index + m[0].length; }
      yield [s.slice(prev)];
    },
  });
  def('string_to_table', {
    resolve: textArgs(2, 3, null),
    strict: false,
    cols: () => one('string_to_table', B().text),
    *rows([s, d, nullStr]) {
      if (s === null) return;
      let parts;
      if (d === null) parts = [...s];
      else if (d === '') parts = s === '' ? [] : [s];
      else parts = s === '' ? [] : s.split(d);
      for (const x of parts) yield [nullStr !== undefined && nullStr !== null && x === nullStr ? null : x];
    },
  });

  // ---- binding -------------------------------------------------------------------------------------------------
  const FROM_OPTS = { noAgg: 'aggregate functions are not allowed in functions in FROM', noWin: 'window functions are not allowed in functions in FROM' };
  const undefinedFn = (name, args) => fail(S.undefinedFunction, 'function ' + name + '(' + args.map((a) => K.T.sqlName(a.type)).join(', ') + ') does not exist');
  const typeOf = (t, binder) => (t && t.cat ? t : binder.typeOf(t));
  // a single scalar function named by an alias takes the alias as its column name; ROWS FROM with several
  // functions does not, so a second call under the same alias undoes the renaming of the first
  const aliasUse = new WeakMap();
  function nameByAlias(bound, binder, alias, scalar) {
    if (!alias || !alias.name) return bound;
    let u = aliasUse.get(alias);
    if (!u || u.binder !== binder || u.done) { u = { binder, calls: [] }; aliasUse.set(alias, u); }
    if (u.calls.length) {
      for (const c of u.calls) if (c.renamed) { c.cols[0].name = c.renamed; c.renamed = null; }
      u.calls.push(bound);
      return bound;
    }
    u.calls.push(bound);
    if (scalar && bound.cols.length === 1 && !alias.cols) { bound.renamed = bound.cols[0].name; bound.cols[0] = Object.assign({}, bound.cols[0], { name: alias.name }); }
    return bound;
  }

  /** the columns of other FROM items (or enclosing queries) a call's arguments use: a LATERAL dependency */
  function colRefs(exprs) {
    const ids = new Set();
    const walk = (x) => {
      if (!x || typeof x !== 'object') return;
      if (Array.isArray(x)) { x.forEach(walk); return; }
      if ((x.k === 'col' || x.k === 'outer') && x.id !== undefined) ids.add(x.id);
      if (x.k === 'sub') { for (const id of x.outerRefs || []) ids.add(id); return; }
      for (const k of Object.keys(x)) if (k !== 'type' && k !== 'ctype' && k !== 'def' && k !== 'fn') walk(x[k]);
    };
    walk(exprs);
    return [...ids];
  }
  /** argOpts: how the arguments bind in the select list (aggregates there are computed before the function runs) */
  function bind(binder, ast, scope, alias, argOpts) {
    const b = bindCall(binder, ast, scope, alias, argOpts || FROM_OPTS);
    b.outerRefs = colRefs(b.scalar ? [b.scalar] : b.args);
    return b;
  }
  function bindCall(binder, ast, scope, alias, argOpts) {
    const name = ast.name;
    // user functions returning SETOF or TABLE
    const udfs = binder.cat.userFuncs(name).filter((f) => !f.aggregate && f.kind !== 'procedure' && (!ast.schema || f.schema === ast.schema));
    if (udfs.some((f) => f.setof || f.returnsTable)) {
      const args = ast.args.map((a) => binder.expr(a, scope, argOpts));
      const cands = udfs.map((f) => ({ name, args: f.params.filter((p) => p.mode !== 'out').map((p) => p.type), minArgs: f.params.filter((p) => p.mode !== 'out' && p.default === undefined).length, ret: f.retType, udf: f, variadic: f.params.some((p) => p.mode === 'variadic') }));
      const r = K.F.resolve(cands, args.map((a) => a.type), name);
      if (r && (r.def.udf.setof || r.def.udf.returnsTable)) {
        const f = r.def.udf;
        const bargs = args.map((a, i) => K.Expr.coerce(a, r.argTypes[i]));
        let cols;
        const outs = f.params.filter((p) => p.mode === 'out' || p.mode === 'inout' || p.mode === 'table');
        if (f.returnsTable && f.returnsTable.length) cols = f.returnsTable.map((c) => ({ name: c.name, type: typeOf(c.type, binder) }));
        else if (outs.length > 1) cols = outs.map((p) => ({ name: p.name, type: typeOf(p.type, binder) }));
        else {
          const rt = r.ret && r.ret.cat ? r.ret : f.retType ? typeOf(f.retType, binder) : B().text;
          if (base(rt).cat === 'C' && base(rt).fields) cols = base(rt).fields.map((x) => ({ name: x.name, type: x.type }));
          else if (rt.id === 'record' && alias && alias.types) cols = recordCols(null, bargs, binder, ast, alias);
          else cols = one(name, rt);
        }
        const node = { k: 'udf', fn: f, args: bargs, type: r.ret, name, setof: true };
        return nameByAlias({ name, udf: f, node, args: bargs, cols, estRows: f.rows || 1000 }, binder, alias, cols.length === 1 && !f.returnsTable && !outs.length);
      }
    }
    const d = DEFS.get(name);
    if (d && (!ast.schema || ast.schema === 'pg_catalog')) {
      const args = ast.args.map((a) => binder.expr(a, scope, argOpts));
      const types = args.map((a) => a.type);
      const r = (d.pick && d.pick(types)) || (d.resolve ? d.resolve(types, ast) : K.F.resolve(d.overloads, types, name));
      if (!r) undefinedFn(name, args);
      const bargs = args.map((a, i) => (r.argTypes[i] ? K.Expr.coerce(a, r.argTypes[i]) : a));
      const call = { name, def: d, args: bargs, ret: r.ret, argTypes: r.argTypes };
      call.cols = d.cols(r, bargs, binder, ast, alias);
      call.estRows = d.est ? d.est(bargs.map((a) => (a.k === 'const' ? a.v : undefined))) : call.cols.length > 2 ? 1 : 100;
      return nameByAlias(call, binder, alias, call.cols.length === 1 && !/^json[b]?_to_record/.test(name));
    }
    // anything else is an ordinary function call, giving one row (a composite result gives its fields as columns)
    const e = binder.expr(ast, scope, FROM_OPTS);
    const t = base(e.type);
    const composite = t && t.cat === 'C' && t.fields;
    const cols = composite ? t.fields.map((f) => ({ name: f.name, type: f.type })) : one(name, e.type);
    return nameByAlias({ name, scalar: e, composite: !!composite, cols, estRows: 1 }, binder, alias, !composite);
  }

  // ---- running -------------------------------------------------------------------------------------------------
  const asRow = (v, width) => (Array.isArray(v) ? v : v instanceof K.RowV && width > 1 ? v.values : v instanceof K.RowV && width === 1 && v.values.length === 1 ? v.values : [v]);
  /** the rows of one bound call, as an iterator of arrays */
  function* callRows(c, ctx) {
    if (!c.fns) c.fns = (c.scalar ? [c.scalar] : c.args).map((a) => K.Expr.compile(a, new Map()));
    const vals = c.fns.map((f) => f([], ctx));
    if (c.scalar) {
      const v = vals[0];
      yield c.composite ? (v === null ? c.cols.map(() => null) : v.values) : [v];
      return;
    }
    if (c.udf) {
      const rows = ctx.callUdfSet(c.node, vals) || [];
      for (const r of rows) yield asRow(r, c.cols.length);
      return;
    }
    if (c.def.strict !== false && vals.some((v) => v === null)) return;
    yield* c.def.rows(vals, c, ctx);
  }
  function* run(n, ctx) {
    const its = n.calls.map((c) => callRows(c, ctx));
    const widths = n.calls.map((c) => c.cols.length);
    const done = its.map(() => false);
    let ord = 0n, count = 0;
    for (;;) {
      const row = [];
      let any = false;
      for (let i = 0; i < its.length; i++) {
        let r = null;
        if (!done[i]) { const x = its[i].next(); if (x.done) done[i] = true; else { r = x.value; any = true; } }
        if (r) for (let k = 0; k < widths[i]; k++) row.push(r[k] === undefined ? null : r[k]);
        else for (let k = 0; k < widths[i]; k++) row.push(null);
      }
      if (!any) break;
      if (n.ordinality) row.push(++ord);
      count++;
      yield row;
    }
    if (ctx.bus) ctx.bus.emit('exec.func', { node: n, rows: count });
  }

  K.SRF = { bind, run, defs: DEFS, pgRegex, matches };
})(typeof window !== 'undefined' ? window : globalThis);
