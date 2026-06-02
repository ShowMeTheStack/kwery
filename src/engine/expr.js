// Expressions: binding (names to columns, types worked out, operators and functions chosen, casts inserted)
// and compiling (a bound tree becomes a JavaScript closure over a row layout). NULL is the unknown value of
// three-valued logic; most operators return NULL when an argument is NULL, and AND/OR follow the truth tables.
(function (root) {
  'use strict';
  const K = root.K;
  const S = K.STATE;
  const B = () => K.T.BASE;
  const T = () => K.T;

  // ---- helpers to build bound nodes ----------------------------------------------------------------------------
  const cst = (v, type) => ({ k: 'const', v, type });
  const isUnknown = (n) => n.k === 'const' && n.type && n.type.cat === 'P';
  /** make a bound node produce type t: unknown literals are typed now, others get a cast node */
  function coerce(n, t, explicit, what) {
    if (!t || t.cat === 'P' && t.id !== 'unknown') return n;
    if (n.type && n.type.id === t.id && (t.cat !== 'S' || t.n === undefined || n.type.n === t.n) && (t.id !== 'numeric' || t.p === undefined) && !(t.cat === 'T' && (t.field || t.prec !== undefined)) && t.cat !== 'A') return n;
    if (n.type && t.cat === 'A' && n.type.cat === 'A' && n.type.elem.id === t.elem.id) return n;
    if (n.k === 'const') {
      if (n.v === null) return cst(null, t);
      // a domain's checks run when the value is cast, where the session can evaluate them
      if (isUnknown(n) && hasDomain(t)) return { k: 'cast', e: n, type: t, explicit: !!explicit, pos: n.pos };
      if (isUnknown(n)) return { k: 'const', v: T().input(n.v, t, K.ctxZone()), type: t, from: n };
      // a constant cast implicitly is folded now, as the planner would (an error here is reported at once)
      if (!explicit && n.type && T().implicit(n.type, t) && t.cat !== 'A' && t.cat !== 'C') return { k: 'const', v: T().cast(n.v, n.type, t, false, K.ctxZone()), type: t, from: n };
    }
    if (!explicit && n.type && n.type.cat !== 'P' && !T().implicit(n.type, t) && !(n.type.cat === 'S' && t.cat === 'S')) {
      throw K.err(S.datatypeMismatch, (what || 'value') + ' is of type ' + T().sqlName(n.type) + ' but ' + T().sqlName(t) + ' is expected', { hint: 'You will need to rewrite or cast the expression.', pos: n.pos });
    }
    return { k: 'cast', e: n, type: t, explicit: !!explicit, pos: n.pos };
  }
  const hasDomain = (t) => !!t && (t.domain || (t.cat === 'A' && hasDomain(t.elem)));
  K.coerce = coerce;
  K.cst = cst;
  K.ctxZone = () => (K.currentSession && K.currentSession.settings ? { zone: K.currentSession.settings.timezone } : { zone: 'UTC' });

  // ---- operators --------------------------------------------------------------------------------------------------
  const CMP = { '=': (c) => c === 0, '<>': (c) => c !== 0, '<': (c) => c < 0, '>': (c) => c > 0, '<=': (c) => c <= 0, '>=': (c) => c >= 0 };
  const ARITH = new Set(['+', '-', '*', '/', '%']);

  /** the type both sides of a comparison are compared in */
  /** a type without its modifier: comparisons and operators work on numeric, not numeric(8,2) */
  const noMod = (t) => (t && !t.domain && (t.cat === 'N' || t.cat === 'S' || t.cat === 'D') && B()[t.id] && (t.p !== undefined || t.n !== undefined || t.prec !== undefined) ? (t.id === 'char' ? Object.assign({}, B().char, { n: undefined }) : B()[t.id]) : t);
  const elemId = (t) => { let e = t.elem; while (e && e.cat === 'A') e = e.elem; return e ? (e.domain ? e.base.id : e.id) : null; };
  function compareType(a, b, op) { return noMod(compareType0(a, b, op)); }
  function compareType0(a, b, op) {
    if (isUnknown(a) && isUnknown(b)) return B().text;
    if (isUnknown(a) || a.type.cat === 'P') return b.type.cat === 'P' ? B().text : b.type;
    if (isUnknown(b) || b.type.cat === 'P') return a.type;
    // arrays are not coerced to another element type implicitly: int[] = numeric[] has no operator
    if (a.type.cat === 'A' && b.type.cat === 'A' && elemId(a.type) !== elemId(b.type)) throw K.err(S.undefinedFunction, 'operator does not exist: ' + T().sqlName(a.type) + ' ' + op + ' ' + T().sqlName(b.type), { hint: 'No operator matches the given name and argument types. You might need to add explicit type casts.', pos: a.pos });
    // mixed numeric types compare in the type their arithmetic would use (numeric = real compares as double)
    if (a.type.cat === 'N' && b.type.cat === 'N' && !a.type.domain && !b.type.domain) return K.F.numResult(a.type, b.type);
    // char against text compares as text (text is the preferred string type): trailing blanks then count
    if (a.type.cat === 'S' && b.type.cat === 'S' && (a.type.id === 'char' && b.type.id === 'text' || a.type.id === 'text' && b.type.id === 'char')) return B().text;
    try { return T().common([a.type, b.type], 'operator ' + op + ' between'); }
    catch (e) {
      // dates against timestamps, strings against enums, json against jsonb...
      throw K.err(S.undefinedFunction, 'operator does not exist: ' + T().sqlName(a.type) + ' ' + op + ' ' + T().sqlName(b.type), { hint: 'No operator matches the given name and argument types. You might need to add explicit type casts.', pos: a.pos });
    }
  }

  /** bind a binary operator; returns a bound node */
  function bindOp(o, a, b, pos) {
    if (CMP[o]) {
      if (a.type && a.type.cat === 'C' || b.type && b.type.cat === 'C') return bindRowCompare(o, a, b, pos);
      // a regclass (kept as a name) compared with an OID column compares the relation's OID
      const rc = (x, y) => x.type && x.type.id === 'regclass' && y.type && y.type.cat === 'N';
      if (rc(a, b)) a = { k: 'cast', e: a, type: B().int4, explicit: true, pos };
      else if (rc(b, a)) b = { k: 'cast', e: b, type: B().int4, explicit: true, pos };
      // a transaction id has only = and <>, with another xid or an integer (xideq, xideqint4)
      if (a.type && a.type.id === 'xid' || b.type && b.type.id === 'xid') {
        const ok = (x) => isUnknown(x) || x.type.cat === 'P' || x.type.id === 'xid' || x.type.id === 'int4' || x.type.id === 'int2';
        if ((o !== '=' && o !== '<>') || !ok(a) || !ok(b)) throw K.err(S.undefinedFunction, 'operator does not exist: ' + T().sqlName(a.type) + ' ' + o + ' ' + T().sqlName(b.type), { hint: 'No operator matches the given name and argument types. You might need to add explicit type casts.', pos });
        const xt = B().xid, xc = (x) => (x.type.id === 'xid' ? x : isUnknown(x) || x.type.cat === 'P' ? coerce(x, xt) : { k: 'cast', e: x, type: xt, explicit: true, pos });
        return { k: 'cmp', op: o, l: xc(a), r: xc(b), ctype: xt, type: B().bool, pos };
      }
      const t = compareType(a, b, o);
      if (t && t.id === 'json') throw K.err(S.undefinedFunction, 'operator does not exist: json ' + o + ' json', { hint: 'No operator matches the given name and argument types. You might need to add explicit type casts.', pos });
      return { k: 'cmp', op: o, l: coerce(a, t), r: coerce(b, t), ctype: t, type: B().bool, pos };
    }
    if (ARITH.has(o) || o === '^') {
      if (isUnknown(a) && isUnknown(b) || o === '+' && a.type && b.type && a.type.id === 'time' && b.type.id === 'time') throw K.err(S.ambiguousFunction, 'operator is not unique: ' + T().sqlName(a.type) + ' ' + o + ' ' + T().sqlName(b.type), { hint: 'Could not choose a best candidate operator. You might need to add explicit type casts.', pos });
      // dates and intervals first: date + int, date - date, timestamp - interval, interval * number ...
      // an untyped literal next to a typed operand is first tried as that operand's type, as PostgreSQL does
      const same = isUnknown(a) !== isUnknown(b) && K.F.OPS.get(o) && K.F.resolve(K.F.OPS.get(o), isUnknown(a) ? [b.type, b.type] : [a.type, a.type]);
      const dt = same && same.def.args && same.def.args[0] === same.def.args[1] ? same : K.F.OPS.get(o) && K.F.resolve(K.F.OPS.get(o), [a.type, b.type]);
      const numeric = (n) => n.type && (n.type.cat === 'N' || n.type.domain && n.type.base.cat === 'N');
      if (o !== '^' && (numeric(a) || isUnknown(a)) && (numeric(b) || isUnknown(b)) && !(dt && dt.def.special)) {
        let t;
        if (isUnknown(a) && isUnknown(b)) t = B().numeric;
        else if (isUnknown(a)) t = K.F.numResult(b.type.domain ? b.type.base : b.type);
        else if (isUnknown(b)) t = K.F.numResult(a.type.domain ? a.type.base : a.type);
        else t = K.F.numResult(a.type.domain ? a.type.base : a.type, b.type.domain ? b.type.base : b.type);
        if (isUnknown(a) && /[.eE]/.test(String(a.v))) t = t.int ? B().numeric : t;
        if (isUnknown(b) && /[.eE]/.test(String(b.v))) t = t.int ? B().numeric : t;
        return { k: 'arith', op: o, l: coerce(a, t), r: coerce(b, t), type: t, pos };
      }
      if (dt) return { k: 'call', def: dt.def, args: [coerce(a, dt.argTypes[0]), coerce(b, dt.argTypes[1])], type: dt.ret, name: o, pos };
      throw K.err(S.undefinedFunction, 'operator does not exist: ' + T().sqlName(a.type) + ' ' + o + ' ' + T().sqlName(b.type), { hint: 'No operator matches the given name and argument types. You might need to add explicit type casts.', pos });
    }
    if (o === '||') {
      // array concatenation, else string concatenation (anything with text)
      if (a.type && a.type.cat === 'A' || b.type && b.type.cat === 'A') {
        // an untyped literal next to an array is read as an array, as PostgreSQL resolves anyarray || unknown
        if (isUnknown(b) && a.type.cat === 'A') b = coerce(b, a.type);
        else if (isUnknown(a) && b.type.cat === 'A') a = coerce(a, b.type);
        const d = K.F.resolve(K.F.OPS.get('||'), [a.type, b.type]);
        if (d) return { k: 'call', def: d.def, args: [coerce(a, d.argTypes[0]), coerce(b, d.argTypes[1])], type: d.ret, name: o, pos };
      }
      if (a.type && a.type.cat === 'X' && b.type && b.type.cat === 'X') { const d = K.F.resolve(K.F.OPS.get('||'), [a.type, b.type]); if (d) return { k: 'call', def: d.def, args: [a, b], type: d.ret, name: o, pos }; }
      if (a.type && a.type.cat === 'J' && isUnknown(b)) b = coerce(b, a.type);
      else if (b.type && b.type.cat === 'J' && isUnknown(a)) a = coerce(a, b.type);
      if (a.type && a.type.cat === 'J' && b.type && b.type.cat === 'J') { const d = K.F.resolve(K.F.OPS.get('||'), [a.type, b.type]); if (d) return { k: 'call', def: d.def, args: [a, b], type: d.ret, name: o, pos }; }
      if (a.type && a.type.cat !== 'S' && a.type.cat !== 'P' && b.type && b.type.cat !== 'S' && b.type.cat !== 'P') throw K.err(S.undefinedFunction, 'operator does not exist: ' + T().sqlName(a.type) + ' || ' + T().sqlName(b.type), { pos });
      return { k: 'concat', l: coerce(a, B().text, true), r: coerce(b, B().text, true), type: B().text, pos };
    }
    // everything else through the operator registry: ->, ->>, @>, ~, &&, ...
    const list = K.F.OPS.get(o);
    const d = list && K.F.resolve(list, [a.type, b.type]);
    if (!d) throw K.err(S.undefinedFunction, 'operator does not exist: ' + T().sqlName(a.type) + ' ' + o + ' ' + T().sqlName(b.type), { hint: 'No operator matches the given name and argument types. You might need to add explicit type casts.', pos });
    return { k: 'call', def: d.def, args: [coerce(a, d.argTypes[0]), coerce(b, d.argTypes[1])], type: d.ret, name: o, pos };
  }
  /** (a, b) = (c, d), (a, b) < (c, d): compared field by field, left to right */
  function bindRowCompare(o, a, b, pos) {
    const la = a.k === 'row' ? a.items : null, lb = b.k === 'row' ? b.items : null;
    if (la && lb) {
      if (la.length !== lb.length) throw K.err(S.syntax, 'unequal number of entries in row expressions', { pos });
      if (!la.length) throw K.err(S.featureNotSupported, 'cannot compare rows of zero length', { pos });
      const pairs = la.map((x, i) => bindOp(o === '<>' ? '=' : o.replace('=', '') === '' ? '=' : o, x, lb[i], pos));
      const eqs = la.map((x, i) => bindOp('=', x, lb[i], pos));
      return { k: 'rowcmp', op: o, pairs, eqs, type: B().bool, pos };
    }
    const t = a.type.cat === 'C' ? a.type : b.type;
    return { k: 'cmp', op: o, l: a, r: b, ctype: t, type: B().bool, pos };
  }

  // ---- compile: bound node -> closure (row, ctx) => value ---------------------------------------------------------
  /**
   * layout maps a column id to its index in the input row. Outer references read ctx.outer (a Map).
   * Subqueries run through ctx.subplan(node, row).
   */
  function compile(n, layout) {
    const c = (x) => compile(x, layout);
    switch (n.k) {
      case 'const': { const v = n.v; return () => v; }
      case 'col': {
        const i = layout.get(n.id);
        if (i === undefined) {
          // not in this row: it must be a value an enclosing query passed down
          const id = n.id;
          return (row, ctx) => { if (ctx.outer && ctx.outer.has(id)) return ctx.outer.get(id); throw K.err(S.internal, 'column ' + (n.name || id) + ' is not available here'); };
        }
        return (row) => row[i];
      }
      case 'outer': { const id = n.id; return (row, ctx) => (ctx.outer && ctx.outer.has(id) ? ctx.outer.get(id) : null); }
      case 'param': { const i = n.n - 1, t = n.type; return (row, ctx) => { const p = ctx.params; if (!p || i >= p.length) throw K.err(S.undefinedObject, 'there is no parameter $' + (i + 1)); return t && t.cat !== 'P' ? T().cast(p[i], null, t, false, ctx) : p[i]; }; }
      case 'var': { const name = n.name; return (row, ctx) => { const v = ctx.vars && ctx.vars.get(name); if (v === undefined) throw K.err(S.undefinedObject, 'variable "' + name + '" does not exist'); return v.value; }; }
      case 'cast': {
        const e = c(n.e), from = n.e.type, to = n.type, ex = n.explicit, tryC = n.tryCast;
        return (row, ctx) => { const v = e(row, ctx); try { return T().cast(v, from, to, ex, ctx); } catch (er) { if (tryC) return null; if (er.code && !er.pos) er.pos = n.pos; throw er; } };
      }
      case 'cmp': {
        const l = c(n.l), r = c(n.r), test = CMP[n.op], t = n.ctype;
        return (row, ctx) => { const a = l(row, ctx); if (a === null) return null; const b = r(row, ctx); if (b === null) return null; return test(T().compare(a, b, t)); };
      }
      case 'rowcmp': {
        const pairs = n.pairs.map(c), eqs = n.eqs.map(c), o = n.op;
        return (row, ctx) => {
          if (o === '=' || o === '<>') {
            let unknown = false;
            for (const e of eqs) { const v = e(row, ctx); if (v === false) return o === '<>'; if (v === null) unknown = true; }
            return unknown ? null : o === '=';
          }
          // <, <=, >, >=: the first pair that is not equal decides
          for (let i = 0; i < pairs.length; i++) {
            const eq = eqs[i](row, ctx);
            if (eq === null) return null;
            if (!eq) return pairs[i](row, ctx);
          }
          return o === '<=' || o === '>=';
        };
      }
      case 'arith': {
        const l = c(n.l), r = c(n.r), o = n.op, t = n.type;
        return (row, ctx) => { const a = l(row, ctx); if (a === null) return null; const b = r(row, ctx); if (b === null) return null; try { return K.F.arith(o, a, b, t); } catch (e) { if (!e.pos) e.pos = n.pos; throw e; } };
      }
      case 'neg': {
        const e = c(n.e), t = n.type;
        return (row, ctx) => { const v = e(row, ctx); if (v === null) return null; if (typeof v === 'bigint') return K.F.checkInt(-v, t); if (typeof v === 'number') return t.int ? K.F.checkInt(-v, t) : -v; if (v instanceof K.Decimal) return v.neg(); if (v instanceof K.IntervalV) return v.neg(); return -v; };
      }
      case 'concat': { const l = c(n.l), r = c(n.r); return (row, ctx) => { const a = l(row, ctx); if (a === null) return null; const b = r(row, ctx); if (b === null) return null; return a + b; }; }
      case 'and': {
        const items = n.items.map(c);
        return (row, ctx) => { let unknown = false; for (const f of items) { const v = f(row, ctx); if (v === false) return false; if (v === null) unknown = true; } return unknown ? null : true; };
      }
      case 'or': {
        const items = n.items.map(c);
        return (row, ctx) => { let unknown = false; for (const f of items) { const v = f(row, ctx); if (v === true) return true; if (v === null) unknown = true; } return unknown ? null : false; };
      }
      case 'not': { const e = c(n.e); return (row, ctx) => { const v = e(row, ctx); return v === null ? null : !v; }; }
      case 'isnull': {
        const e = c(n.e), neg = n.neg, row_ = n.e.type && n.e.type.cat === 'C';
        return (row, ctx) => {
          const v = e(row, ctx);
          // for a row value, IS NULL means every field is null, IS NOT NULL means every field is not null
          if (row_ && v instanceof K.RowV) return neg ? v.values.every((x) => x !== null) : v.values.every((x) => x === null);
          return neg ? v !== null : v === null;
        };
      }
      case 'istruth': { const e = c(n.e), want = n.v, neg = n.neg; return (row, ctx) => { const v = e(row, ctx); const r = v === want; return neg ? !r : r; }; }
      case 'distinct': {
        const l = c(n.l), r = c(n.r), t = n.ctype, neg = n.neg;
        return (row, ctx) => { const a = l(row, ctx), b = r(row, ctx); let d; if (a === null || b === null) d = a !== b; else d = T().compare(a, b, t) !== 0; return neg ? !d : d; };
      }
      case 'case': {
        const base = n.base ? c(n.base) : null, t = n.ctype;
        const whens = n.whens.map((w) => [c(w.c), c(w.r)]), els = n.else ? c(n.else) : () => null;
        if (base) return (row, ctx) => { const b = base(row, ctx); for (const [w, r] of whens) { const v = w(row, ctx); if (b !== null && v !== null && T().compare(b, v, t) === 0) return r(row, ctx); } return els(row, ctx); };
        return (row, ctx) => { for (const [w, r] of whens) if (w(row, ctx) === true) return r(row, ctx); return els(row, ctx); };
      }
      case 'coalesce': { const items = n.items.map(c); return (row, ctx) => { for (const f of items) { const v = f(row, ctx); if (v !== null) return v; } return null; }; }
      case 'nullif': { const a = c(n.a), b = c(n.b), t = n.ctype; return (row, ctx) => { const x = a(row, ctx), y = b(row, ctx); if (x !== null && y !== null && T().compare(x, y, t) === 0) return null; return x; }; }
      case 'greatest': case 'least': {
        const items = n.items.map(c), t = n.type, g = n.k === 'greatest';
        return (row, ctx) => { let best = null; for (const f of items) { const v = f(row, ctx); if (v === null) continue; if (best === null || (g ? T().compare(v, best, t) > 0 : T().compare(v, best, t) < 0)) best = v; } return best; };
      }
      case 'inlist': {
        const e = c(n.e), items = n.items.map(c), t = n.ctype, neg = n.neg;
        // a constant list becomes a hash set for speed
        // where equal values always have equal keys (not char(n), whose trailing spaces do not count)
        const keyed = ['N', 'D', 'B', 'U', 'E'].includes(t.cat) || (t.cat === 'S' && t.id !== 'char');
        const consts = n.items.filter((x) => x.k === 'const');
        const set = keyed && consts.length === n.items.length ? new Set(consts.filter((x) => x.v !== null).map((x) => K.keyOf(x.v))) : null;
        const hasNull = consts.some((x) => x.v === null);
        return (row, ctx) => {
          const v = e(row, ctx);
          if (v === null) return null;
          if (set) return set.has(K.keyOf(v)) ? !neg : hasNull ? null : neg;
          let unknown = false;
          for (const f of items) { const x = f(row, ctx); if (x === null) { unknown = true; continue; } if (T().compare(v, x, t) === 0) return !neg; }
          return unknown ? null : neg;
        };
      }
      case 'like': {
        const e = c(n.e), p = c(n.pat), esc = n.esc ? c(n.esc) : null, neg = n.neg, ci = n.ci, similar = n.similar;
        let cache = new Map();
        return (row, ctx) => {
          const v = e(row, ctx); if (v === null) return null;
          const pat = p(row, ctx); if (pat === null) return null;
          const es = esc ? esc(row, ctx) : '\\';
          const key = pat + '\u0000' + es;
          let re = cache.get(key);
          if (!re) { re = similar ? similarRe(pat, es) : likeRe(pat, es, ci); if (cache.size > 200) cache = new Map(); cache.set(key, re); }
          const r = re.test(String(v));
          return neg ? !r : r;
        };
      }
      case 'quant': {
        if (n.pred) {
          // x ~ ANY (array) and other operators: the predicate reads each element through its qelem
          const cell = { v: null };
          const mark = (x) => { if (!x || typeof x !== 'object' || x.type === x) return; if (x.k === 'qelem') x.cell = cell; for (const k of ['l', 'r', 'e', 'args', 'items']) if (x[k]) (Array.isArray(x[k]) ? x[k] : [x[k]]).forEach(mark); };
          mark(n.pred);
          const pred = c(n.pred), arr = c(n.arr), any = n.q === 'any';
          return (row, ctx) => {
            const a = arr(row, ctx);
            if (a === null) return null;
            let unknown = false;
            for (const x of flat(a)) {
              cell.v = x;
              const r = pred(row, ctx);
              if (r === null) { unknown = true; continue; }
              if (any && r) return true;
              if (!any && !r) return false;
            }
            return unknown ? null : !any;
          };
        }
        // x op ANY (array), x op ALL (array)
        const e = c(n.e), arr = c(n.arr), cmp = CMP[n.op], t = n.ctype, any = n.q === 'any', like = n.like;
        return (row, ctx) => {
          const v = e(row, ctx); const a = arr(row, ctx);
          if (a === null) return null;
          const items = flat(a);
          if (!items.length) return !any;
          if (v === null) return null;
          let unknown = false;
          for (const x of items) {
            if (x === null) { unknown = true; continue; }
            const r = like ? likeRe(x, '\\', like.ci).test(v) !== like.neg : cmp(T().compare(v, x, t));
            if (any && r) return true;
            if (!any && !r) return false;
          }
          return unknown ? null : !any;
        };
      }
      case 'sub': return (row, ctx) => ctx.subplan(n, row, layout);
      case 'qelem': { const cell = n.cell; return () => cell.v; }
      case 'call': {
        const args = n.args.map(c), f = n.def.fn, strict = n.def.strict !== false, rt = n.type, at = n.args.map((a) => a.type);
        if (n.def.lazy) return (row, ctx) => f(args.map((g) => () => g(row, ctx)), ctx, { rt, at, row });
        if (n.spread) {
          const et = at[at.length - 1].elem, flat = (a) => a.items.flatMap((x) => (x instanceof K.ArrayV ? flat(x) : [x]));
          return (row, ctx) => {
            const vals = args.map((g) => g(row, ctx)), last = vals.pop();
            if (last === null && !n.def.nullVariadicEmpty) return null;
            const items = last === null ? [] : flat(last);
            if (strict && (vals.includes(null) || items.includes(null))) return null;
            try { return f(vals.concat(items), ctx, { rt, at: at.slice(0, -1).concat(items.map(() => et)), node: n }); } catch (e) { if (e.code && e.pos === undefined) e.pos = n.pos; throw e; }
          };
        }
        return (row, ctx) => {
          const vals = new Array(args.length);
          for (let i = 0; i < args.length; i++) { const v = args[i](row, ctx); if (v === null && strict) return null; vals[i] = v; }
          try { return f(vals, ctx, { rt, at, node: n }); } catch (e) { if (e.code && e.pos === undefined) e.pos = n.pos; throw e; }
        };
      }
      case 'udf': return (row, ctx) => ctx.callUdf(n, n.args.map((a) => compile(a, layout)(row, ctx)));
      case 'row': { const items = n.items.map(c), t = n.type; return (row, ctx) => new K.RowV(items.map((f) => f(row, ctx)), t); }
      case 'array': {
        const items = n.items.map(c);
        return (row, ctx) => {
          const vals = items.map((f) => f(row, ctx));
          // ARRAY[ARRAY[1,2],ARRAY[3,4]] is a 2-D array
          if (vals.some((v) => v instanceof K.ArrayV) && !vals.every((v) => v instanceof K.ArrayV)) throw K.err(S.arraySubscript, 'multidimensional arrays must have array expressions with matching dimensions');
          if (vals.length && vals.every((v) => v instanceof K.ArrayV)) {
            const d = vals[0].dims().join('x');
            if (!vals.every((v) => v.dims().join('x') === d)) throw K.err(S.arraySubscript, 'multidimensional arrays must have array expressions with matching dimensions');
          }
          return new K.ArrayV(vals);
        };
      }
      case 'idx': {
        if (n.dims) {
          const e = c(n.e), ds = n.dims.map((d) => ({ lo: d.lo ? c(d.lo) : null, hi: d.hi ? c(d.hi) : null, slice: d.slice }));
          return (row, ctx) => {
            const v = e(row, ctx);
            if (v === null) return null;
            const b = [];
            for (const d of ds) {
              const lo = d.slice ? (d.lo ? d.lo(row, ctx) : undefined) : 1, hi = d.slice ? (d.hi ? d.hi(row, ctx) : undefined) : d.lo(row, ctx);
              if (lo === null || hi === null) return null;
              b.push([lo, hi]);
            }
            let empty = false;
            const cut = (x, k) => {
              if (k === b.length) return x;
              if (!(x instanceof K.ArrayV)) { empty = true; return null; }
              const lo = Math.max(b[k][0] === undefined ? x.lower : Number(b[k][0]), x.lower), hi = Math.min(b[k][1] === undefined ? x.lower + x.items.length - 1 : Number(b[k][1]), x.lower + x.items.length - 1);
              if (lo > hi) { empty = true; return null; }
              return new K.ArrayV(x.items.slice(lo - x.lower, hi - x.lower + 1).map((y) => cut(y, k + 1)));
            };
            const out = cut(v, 0);
            return empty ? new K.ArrayV([]) : out;
          };
        }
        if (n.subs) {
          // fewer subscripts than the array has dimensions give NULL, as in PostgreSQL
          const e = c(n.e), subs = n.subs.map(c);
          return (row, ctx) => {
            let v = e(row, ctx);
            for (const s of subs) {
              if (!(v instanceof K.ArrayV)) return null;
              const i = s(row, ctx);
              if (i === null) return null;
              const k = Number(i) - v.lower;
              v = k >= 0 && k < v.items.length ? v.items[k] : null;
            }
            return v instanceof K.ArrayV ? null : v;
          };
        }
        const e = c(n.e), lo = n.lo ? c(n.lo) : null, hi = n.hi ? c(n.hi) : null, slice = n.slice, json = n.e.type && n.e.type.cat === 'J';
        return (row, ctx) => {
          const v = e(row, ctx);
          if (v === null) return null;
          if (json) {
            const k = lo(row, ctx); if (k === null) return null;
            const x = v.v;
            if (Array.isArray(x)) { let i = Number(k); if (i < 0) i += x.length; return i >= 0 && i < x.length ? new K.JsonV(x[i], v.binary) : null; }
            if (x instanceof Map) return x.has(String(k)) ? new K.JsonV(x.get(String(k)), v.binary) : null;
            return null;
          }
          if (!(v instanceof K.ArrayV)) throw K.err(S.datatypeMismatch, 'cannot subscript type ' + T().sqlName(n.e.type) + ' because it does not support subscripting');
          if (slice) {
            const a = lo ? lo(row, ctx) : v.lower, b = hi ? hi(row, ctx) : v.lower + v.items.length - 1;
            if (a === null || b === null) return null;
            const s = Math.max(Number(a), v.lower), t2 = Math.min(Number(b), v.lower + v.items.length - 1);
            return new K.ArrayV(s > t2 ? [] : v.items.slice(s - v.lower, t2 - v.lower + 1));
          }
          const i = lo(row, ctx); if (i === null) return null;
          const k = Number(i) - v.lower;
          const out = k >= 0 && k < v.items.length ? v.items[k] : null;
          return out instanceof K.ArrayV ? null : out;
        };
      }
      case 'field': {
        const e = c(n.e), idx = n.index;
        return (row, ctx) => { const v = e(row, ctx); if (v === null) return null; return v.values[idx]; };
      }
      case 'default': return () => { throw K.err(S.syntax, 'DEFAULT is not allowed in this context', { pos: n.pos }); };
      case 'grouping': { const bits = n.bits; return (row, ctx) => { const set = row.groupingSet || ctx.groupingSet; if (!set) return 0; let r = 0; for (const id of bits) r = (r << 1) | (set.has(id) ? 0 : 1); return r; }; }
      case 'srfcall': { const id = n.id; return (row, ctx) => (ctx.srfVals ? ctx.srfVals.get(id) : null); }
      case 'ctid': { const i = layout.get(n.id); return (row) => row[i]; }
    }
    throw K.err(S.internal, 'cannot compile expression kind ' + n.k);
  }
  const flat = (a) => { const out = []; const walk = (x) => { for (const v of x.items) if (v instanceof K.ArrayV) walk(v); else out.push(v); }; walk(a); return out; };

  /** LIKE pattern to a regular expression: % any run, _ one character, the escape character quotes the next */
  function likeRe(pat, esc, ci) {
    if (esc && cpLen(esc) > 1) throw K.err('22025', 'invalid escape string', { hint: 'Escape string must be empty or one character.' });
    let re = '^';
    for (let i = 0; i < pat.length; i++) {
      const ch = pat[i];
      if (esc && ch === esc) {
        i++;
        if (i >= pat.length) {
          // like PostgreSQL, a trailing escape is only an error once the match gets that far with text left over
          const pre = new RegExp(re, 's');
          return { test: (v) => { const m = pre.exec(ci ? asciiDown(v) : v); if (m && m[0].length < v.length) throw K.err('22025', 'LIKE pattern must not end with escape character'); return false; } };
        }
        re += reEsc(ci ? asciiDown(pat[i]) : pat[i]);
        continue;
      }
      if (ch === '%') re += '[\\s\\S]*?';
      else if (ch === '_') re += '[\\s\\S]';
      else re += reEsc(ci ? asciiDown(ch) : ch);
    }
    // ILIKE folds ASCII letters only, as the C locale of the reference cluster does
    const r = new RegExp(re + '$', 's');
    return ci ? { test: (v) => r.test(asciiDown(v)) } : r;
  }
  const asciiDown = (s) => s.replace(/[A-Z]+/g, (x) => x.toLowerCase());
  const cpLen = (s) => Array.from(s).length;
  /** a SIMILAR TO pattern body as a JavaScript regular expression, translated the way PostgreSQL's similar_escape does */
  function similarBody(pat, esc) {
    let re = '';
    for (let i = 0; i < pat.length; i++) {
      const ch = pat[i];
      if (esc && ch === esc) { i++; re += reEsc(pat[i] || ''); continue; }
      if (ch === '[') {
        // a bracket expression is copied as it is
        let j = i + 1;
        if (pat[j] === '^') j++;
        if (pat[j] === ']') j++;
        while (j < pat.length && pat[j] !== ']') j = pat[j] === '[' && pat[j + 1] === ':' && pat.indexOf(':]', j + 2) > 0 ? pat.indexOf(':]', j + 2) + 2 : j + 1;
        re += pat.slice(i, j + 1).replace(/\\/g, '\\\\').replace(/\[(?!:)/g, (m, k) => (k === 0 ? m : '\\['));
        i = j;
        continue;
      }
      if (ch === '%') re += '[\\s\\S]*';
      else if (ch === '_') re += '[\\s\\S]';
      else if (ch === '(') re += '(?:';
      else if (ch === '.' || ch === '^' || ch === '$' || ch === '\\' || ch === '/') re += '\\' + ch;
      else re += ch;
    }
    return re;
  }
  /** SIMILAR TO: SQL regular expressions (| * + ? {} [] () with % and _ as in LIKE) */
  function similarRe(pat, esc) {
    if (esc && cpLen(esc) > 1) throw K.err('22025', 'invalid escape string', { hint: 'Escape string must be empty or one character.' });
    try { return new RegExp('^(?:' + similarBody(pat, esc) + ')$', 's'); }
    catch (e) { throw K.err('2201B', 'invalid regular expression: ' + String(e.message).replace(/^.*: /, '').toLowerCase()); }
  }
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');

  K.Expr = { coerce, compile, bindOp, compareType, likeRe, similarRe, similarBody, CMP, isUnknown, flat };
})(typeof window !== 'undefined' ? window : globalThis);
