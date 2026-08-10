// Tuple and domain relational calculus: parsers, a safety check, an evaluator over the same relations as the
// algebra, and the translation of a query to the algebra.
//   TRC: { t | ∃ s ∈ production (t[title] = s[title] ∧ s[runtime_min] > 150) }
//   DRC: { <t> | ∃ p, c, g, d, r, b (<p, t, c, g, d, r, b> ∈ production ∧ r > 150) }
// ASCII: exists, forall, in, and, or, not, implies (or =>), <x, y> for domain tuples, t.name as well as t[name].
//
// Safety: a query is evaluated only when it is range-restricted, the usual syntactic condition that guarantees
// safety (every value in the result, and every value a quantified variable takes, comes from a relation in the
// database or a constant in the query). The analysis orders the conjuncts of each ∧ so that a variable is bound
// (by a membership atom, or by var = expression over bound variables) before a negation, a comparison or ∀ needs
// it. Queries it cannot order are reported unsafe with the variable and the subformula at fault. Comparisons with
// NULL are not true, so their negations are (the calculus has no third truth value).
(function (root) {
  'use strict';
  const K = root.K;
  const A = K.Algebra;
  const SYNTAX = '42601';
  const fail = (msg, pos, extra) => { throw K.err(SYNTAX, msg, Object.assign({ pos }, extra || {})); };
  const unsafe = (msg, pos, extra) => { throw K.err(SYNTAX, msg, Object.assign({ pos, unsafe: true }, extra || {})); };

  // ---- parsing ---------------------------------------------------------------------------------------------------
  // formulas: { f: 'mem', rel, tvar (TRC) | terms (DRC), neg } { f: 'cmp', e (a scalar comparison) } { f: 'and'|'or', items }
  //   { f: 'not', e } { f: 'implies', l, r } { f: 'exists'|'forall', vars: [{ name, rel }], e } { f: 'bool', v }
  class CalcParser extends A.Parser {
    constructor(src) { super(src); }
    query() {
      const open = this.expect('{', '"{" to start a calculus query');
      let kind, head;
      if (this.is('<') || this.is('(')) {
        kind = 'drc';
        const close = this.cur.v === '<' ? '>' : ')';
        this.next();
        head = [];
        if (!this.is(close)) { do head.push(this.varName('a domain variable')); while (this.accept(',')); }
        this.expect(close, '"' + close + '" to close the result tuple');
      } else {
        kind = 'trc';
        head = this.varName('a tuple variable');
      }
      this.expect('|', '"|" between the result and the formula');
      this.kind = kind;
      const body = this.formula();
      this.expect('}', '"}" to close the query');
      if (this.cur.k !== 'eof') fail('unexpected ' + this.desc(this.cur) + ' after the end of the query', this.cur.pos);
      return { kind, head, body, pos: open.pos };
    }
    varName(what) { const c = this.cur; const n = this.ident(what); return { name: n, pos: c.pos }; }
    isSym(v) { return this.is(v) || this.isWord(v); }
    formula() {
      const l = this.orF();
      if (this.accept('implies') || this.acceptWord('implies')) return { f: 'implies', l, r: this.formula(), pos: l.pos };
      if (this.accept('iff')) { const r = this.formula(); return { f: 'and', items: [{ f: 'implies', l, r }, { f: 'implies', l: r, r: l }], pos: l.pos }; }
      return l;
    }
    orF() { const items = [this.andF()]; while (this.accept('or') || this.acceptWord('or')) items.push(this.andF()); return items.length === 1 ? items[0] : { f: 'or', items, pos: items[0].pos }; }
    andF() { const items = [this.unaryF()]; while (this.accept('and') || this.acceptWord('and')) items.push(this.unaryF()); return items.length === 1 ? items[0] : { f: 'and', items, pos: items[0].pos }; }
    unaryF() {
      const c = this.cur;
      if (this.accept('not') || this.acceptWord('not')) return { f: 'not', e: this.unaryF(), pos: c.pos };
      if (this.isSym('exists') || this.isSym('forall')) {
        const q = this.cur.k === 'sym' ? this.cur.v : this.word(this.cur);
        this.next();
        const vars = [];
        do {
          const v = this.varName('a variable after ' + (q === 'exists' ? '∃' : '∀'));
          if (this.accept('in') || this.acceptWord('in')) { v.rel = this.ident('a relation name'); }
          vars.push(v);
        } while (this.accept(','));
        this.accept(':'); this.accept('.');
        const e = this.unaryF();
        return { f: q, vars, e, pos: c.pos };
      }
      return this.atomF();
    }
    atomF() {
      const c = this.cur;
      if (c.k === 'sym' && c.v === '(') {
        const save = this.i;
        try {
          this.next();
          const f = this.formula();
          this.expect(')');
          // (a + b) > 3 is a comparison, not a parenthesized formula
          if (!(this.cur.k === 'sym' && ['=', '<>', '<', '>', '<=', '>=', '+', '-', '*', '/', '||'].includes(this.cur.v))) return f;
        } catch (e) { /* not a formula */ }
        this.i = save;
      }
      if (this.kind === 'drc' && c.k === 'sym' && c.v === '<') {
        this.next();
        const terms = [];
        do terms.push(this.term()); while (this.accept(','));
        this.expect('>', '">" to close the tuple');
        const neg = this.memOp();
        const rc = this.cur;
        return { f: 'mem', terms, rel: this.ident('a relation name'), relPos: rc.pos, neg, pos: c.pos };
      }
      const w = this.word(c);
      if ((w === 'true' || w === 'false') && !this.isCmpAfter()) { this.next(); return { f: 'bool', v: w === 'true', pos: c.pos }; }
      if (this.kind === 'trc' && c.k === 'id' && this.peek().k === 'sym' && (this.peek().v === 'in' || this.peek().v === 'notin') || this.kind === 'trc' && c.k === 'id' && this.word(this.peek()) === 'in') {
        this.next();
        const neg = this.memOp();
        const rc = this.cur;
        return { f: 'mem', tvar: c.v, rel: this.ident('a relation name'), relPos: rc.pos, neg, pos: c.pos };
      }
      const l = this.scalar();
      const o = this.cur;
      if (o.k === 'sym' && ['=', '<>', '<', '>', '<=', '>='].includes(o.v)) {
        this.next();
        const r = this.scalar();
        return { f: 'cmp', e: { k: 'cmp', op: o.v, l, r, pos: l.pos }, pos: l.pos };
      }
      if (this.isWord('is')) {
        this.next();
        const neg = !!(this.accept('not') || this.acceptWord('not'));
        if (!this.acceptWord('null')) fail('expected NULL after IS', this.cur.pos);
        return { f: 'cmp', e: { k: 'isnull', e: l, neg, pos: l.pos }, pos: l.pos };
      }
      fail('expected a comparison (=, ≠, <, ≤, >, ≥) or a membership (∈) but found ' + this.desc(o), o.pos);
    }
    isCmpAfter() { const n = this.peek(); return n.k === 'sym' && ['=', '<>', '<', '>', '<=', '>='].includes(n.v); }
    memOp() {
      if (this.accept('in') || this.acceptWord('in')) return false;
      if (this.accept('notin')) return true;
      fail('expected ∈ (in) but found ' + this.desc(this.cur), this.cur.pos);
    }
    term() {
      const c = this.cur;
      if (c.k === 'num' || c.k === 'str' || (c.k === 'sym' && c.v === '-')) return { c: this.literal(), pos: c.pos };
      const w = this.word(c);
      if (w === 'null' || w === 'true' || w === 'false') return { c: this.literal(), pos: c.pos };
      if (c.k === 'sym' && c.v === '_') { this.next(); return { any: true, pos: c.pos }; }
      return { v: this.ident('a variable or a constant'), pos: c.pos };
    }
    // t[name] in the tuple calculus
    primaryScalar() {
      const c = this.cur;
      const n = this.peek();
      if (this.kind === 'trc' && c.k === 'id' && n.k === 'sym' && n.v === '[') {
        this.next(); this.next();
        const a = this.ident('an attribute name');
        const r = this.expect(']', '"]" after the attribute name');
        return { k: 'attr', parts: [c.v, a], pos: c.pos, end: r.end };
      }
      return super.primaryScalar();
    }
  }
  const parse = (src) => new CalcParser(src).query();

  // ---- from the parsed query to core formulas over scalar variables --------------------------------------------------
  // core: { f: 'mem', rel, terms: [{ v } | { c } | { any }] } { f: 'cmp', e } (attribute refs name variables)
  //   { f: 'and'|'or', items } { f: 'not', e } { f: 'exists'|'forall', vars, e } { f: 'bool', v }
  function toCore(q, get) {
    let uid = 0;
    const relAttrs = (name, pos) => { const r = get(name); if (!r) K.err && fail('relation "' + name + '" does not exist', pos); return r.attrs; };
    if (q.kind === 'drc') {
      const scope = new Map(q.head.map((v) => [v.name, v.name]));
      const conv = (f, sc) => {
        switch (f.f) {
          case 'mem': {
            const attrs = relAttrs(f.rel, f.relPos);
            if (attrs.length !== f.terms.length) fail('relation ' + f.rel + ' has ' + attrs.length + ' attributes (' + attrs.join(', ') + ') but the tuple has ' + f.terms.length + ' values', f.pos);
            const m = { f: 'mem', rel: f.rel, terms: f.terms.map((t) => { if (t.v === undefined) return t; if (!sc.has(t.v)) unsafe('the variable ' + t.v + ' is neither in the result nor quantified', t.pos, { hint: 'Bind it with ∃ ' + t.v + ' (...).' }); return { v: sc.get(t.v), pos: t.pos }; }), pos: f.pos };
            return f.neg ? { f: 'not', e: m, pos: f.pos } : m;
          }
          case 'cmp': return { f: 'cmp', e: mapRefs(f.e, (r) => { if (r.parts.length !== 1) fail('the domain calculus has no tuple variables: ' + r.parts.join('.'), r.pos); if (!sc.has(r.parts[0])) unsafe('the variable ' + r.parts[0] + ' is neither in the result nor quantified', r.pos); return sc.get(r.parts[0]); }), pos: f.pos };
          case 'and': case 'or': return { f: f.f, items: f.items.map((x) => conv(x, sc)), pos: f.pos };
          case 'not': return { f: 'not', e: conv(f.e, sc), pos: f.pos };
          case 'implies': return { f: 'implies', l: conv(f.l, sc), r: conv(f.r, sc), pos: f.pos };
          case 'bool': return f;
          case 'exists': case 'forall': {
            const inner = new Map(sc);
            const vars = f.vars.map((v) => { if (v.rel) fail('in the domain calculus write ∃ x (<..., x, ...> ∈ r ∧ ...), not ∃ x ∈ r', v.pos); const u = v.name + (sc.has(v.name) ? '#' + (++uid) : ''); inner.set(v.name, u); return u; });
            return { f: f.f, vars, e: conv(f.e, inner), pos: f.pos, names: f.vars.map((v) => v.name) };
          }
        }
        fail('unknown formula', f.pos);
      };
      return { result: q.head.map((v) => v.name), names: q.head.map((v) => v.name), body: conv(q.body, scope) };
    }
    // TRC: each tuple variable becomes one variable per attribute, named t.attr
    const head = q.head.name;
    const schemas = new Map();
    // the schema of a variable: the relation of its first membership, else the attributes the query names
    const findSchema = (name, f) => {
      let rel = null; const used = [];
      const w = (x) => {
        if (!x || typeof x !== 'object') return;
        if (Array.isArray(x)) { x.forEach(w); return; }
        if (x.f === 'mem' && x.tvar === name && !rel) rel = x;
        if ((x.f === 'exists' || x.f === 'forall') && x.vars.some((v) => v.name === name)) return;
        if (x.k === 'attr' && x.parts.length === 2 && x.parts[0] === name && !used.includes(x.parts[1])) used.push(x.parts[1]);
        for (const k in x) if (k !== 'pos') w(x[k]);
      };
      w(f);
      return rel ? relAttrs(rel.rel, rel.relPos) : used;
    };
    schemas.set(head, findSchema(head, q.body));
    if (!schemas.get(head).length) unsafe('the result variable ' + head + ' is never constrained: name its attributes (' + head + '[A] = ...) or say ' + head + ' ∈ r', q.pos);
    const conv = (f, sc) => {
      const varOf = (r) => {
        if (r.parts.length !== 2) fail('in the tuple calculus write ' + 't[attribute] (or t.attribute), not ' + r.parts.join('.'), r.pos);
        const [t, a] = r.parts;
        if (!sc.has(t)) unsafe('the tuple variable ' + t + ' is neither the result nor quantified', r.pos);
        const v = sc.get(t);
        if (!v.attrs.includes(a)) fail('the tuple variable ' + t + ' has no attribute "' + a + '"' + (v.rel ? ' (' + t + ' ranges over ' + v.rel + ': ' + v.attrs.join(', ') + ')' : ''), r.pos);
        return v.id + '.' + a;
      };
      switch (f.f) {
        case 'mem': {
          if (!sc.has(f.tvar)) unsafe('the tuple variable ' + f.tvar + ' is neither the result nor quantified', f.pos);
          const v = sc.get(f.tvar);
          const attrs = relAttrs(f.rel, f.relPos);
          if (attrs.length !== v.attrs.length) fail(f.tvar + ' has ' + v.attrs.length + ' attributes (' + v.attrs.join(', ') + ') but ' + f.rel + ' has ' + attrs.length, f.pos);
          const m = { f: 'mem', rel: f.rel, terms: v.attrs.map((a) => ({ v: v.id + '.' + a })), pos: f.pos };
          return f.neg ? { f: 'not', e: m, pos: f.pos } : m;
        }
        case 'cmp': return { f: 'cmp', e: mapRefs(f.e, varOf), pos: f.pos };
        case 'and': case 'or': return { f: f.f, items: f.items.map((x) => conv(x, sc)), pos: f.pos };
        case 'not': return { f: 'not', e: conv(f.e, sc), pos: f.pos };
        case 'implies': return { f: 'implies', l: conv(f.l, sc), r: conv(f.r, sc), pos: f.pos };
        case 'bool': return f;
        case 'exists': case 'forall': {
          const inner = new Map(sc);
          const vars = [], ranges = [];
          for (const v of f.vars) {
            const attrs = v.rel ? relAttrs(v.rel, v.pos) : findSchema(v.name, f.e);
            const id = v.name + (sc.has(v.name) || v.name === head ? '#' + (++uid) : '');
            inner.set(v.name, { id, attrs, rel: v.rel });
            vars.push(...attrs.map((a) => id + '.' + a));
            if (v.rel) ranges.push({ f: 'mem', rel: v.rel, terms: attrs.map((a) => ({ v: id + '.' + a })), pos: v.pos });
          }
          let body = conv(f.e, inner);
          if (ranges.length) body = f.f === 'exists' ? { f: 'and', items: ranges.concat([body]), pos: f.pos } : { f: 'implies', l: ranges.length === 1 ? ranges[0] : { f: 'and', items: ranges }, r: body, pos: f.pos };
          return { f: f.f, vars, e: body, pos: f.pos, names: f.vars.map((v) => v.name) };
        }
      }
      fail('unknown formula', f.pos);
    };
    const sc = new Map([[head, { id: head, attrs: schemas.get(head), rel: null }]]);
    const attrs = schemas.get(head);
    return { result: attrs.map((a) => head + '.' + a), names: attrs, body: conv(q.body, sc) };
  }
  function mapRefs(e, fn) {
    if (!e || typeof e !== 'object') return e;
    if (Array.isArray(e)) return e.map((x) => mapRefs(x, fn));
    if (e.k === 'attr') return { k: 'attr', parts: [fn(e)], pos: e.pos, orig: e.parts.join('.') };
    const o = {};
    for (const k in e) o[k] = mapRefs(e[k], fn);
    return o;
  }
  const scalarVars = (e) => { const out = new Set(); const w = (x) => { if (!x || typeof x !== 'object') return; if (x.k === 'attr') { out.add(x.parts[0]); return; } for (const k in x) if (k !== 'pos') w(x[k]); }; w(e); return out; };
  function freeVars(f) {
    switch (f.f) {
      case 'mem': return new Set(f.terms.filter((t) => t.v !== undefined).map((t) => t.v));
      case 'cmp': return scalarVars(f.e);
      case 'and': case 'or': { const s = new Set(); for (const x of f.items) for (const v of freeVars(x)) s.add(v); return s; }
      case 'not': return freeVars(f.e);
      case 'implies': return new Set([...freeVars(f.l), ...freeVars(f.r)]);
      case 'exists': case 'forall': { const s = freeVars(f.e); for (const v of f.vars) s.delete(v); return s; }
      case 'bool': return new Set();
    }
    return new Set();
  }
  /** ¬f pushed inward where that helps the analysis: ¬(a ⇒ b) = a ∧ ¬b, ¬∀x P = ∃x ¬P, ... */
  function negate(f) {
    switch (f.f) {
      case 'not': return f.e;
      case 'implies': return { f: 'and', items: [f.l, negate(f.r)], pos: f.pos };
      case 'and': return { f: 'or', items: f.items.map(negate), pos: f.pos };
      case 'or': return { f: 'and', items: f.items.map(negate), pos: f.pos };
      case 'forall': return { f: 'exists', vars: f.vars, e: negate(f.e), pos: f.pos, names: f.names };
      case 'bool': return { f: 'bool', v: !f.v, pos: f.pos };
      default: return { f: 'not', e: f, pos: f.pos };
    }
  }

  // ---- safety analysis: a plan, or the reason the query is unsafe ----------------------------------------------------
  // plans: { p: 'mem', rel, terms } { p: 'test', e } { p: 'bind', v, e } { p: 'seq', items } { p: 'union', items, binds }
  //   { p: 'none', e: plan } (negation: no solution) { p: 'exists', vars, e: plan, binds } { p: 'bool', v }
  const subset = (a, b) => { for (const x of a) if (!b.has(x)) return false; return true; };
  const showVar = (v) => v.replace(/#\d+/g, '');
  function analyze(f, bound, notes) {
    switch (f.f) {
      case 'bool': return { plan: { p: 'bool', v: f.v }, bound };
      case 'mem': return { plan: { p: 'mem', rel: f.rel, terms: f.terms }, bound: new Set([...bound, ...f.terms.filter((t) => t.v !== undefined).map((t) => t.v)]) };
      case 'cmp': {
        const vs = scalarVars(f.e);
        if (subset(vs, bound)) return { plan: { p: 'test', e: f.e }, bound };
        const e = f.e;
        if (e.k === 'cmp' && e.op === '=') {
          for (const [x, y] of [[e.l, e.r], [e.r, e.l]]) if (x.k === 'attr' && !bound.has(x.parts[0]) && subset(scalarVars(y), bound)) return { plan: { p: 'bind', v: x.parts[0], e: y }, bound: new Set([...bound, x.parts[0]]) };
        }
        return null;
      }
      case 'and': {
        let cur = new Set(bound);
        const pending = f.items.slice();
        const items = [];
        // memberships first in written order, then whatever has become evaluable
        while (pending.length) {
          let k = -1, r = null;
          for (let i = 0; i < pending.length; i++) { r = analyze(pending[i], cur, notes); if (r) { k = i; break; } }
          if (k < 0) {
            const x = pending[0];
            const missing = [...freeVars(x)].filter((v) => !cur.has(v)).map(showVar);
            unsafe('unsafe: ' + missing.join(', ') + (missing.length > 1 ? ' are' : ' is') + ' not limited to values of a relation where ' + describe(x) + ' needs ' + (missing.length > 1 ? 'them' : 'it'), x.pos, { hint: 'Every variable must first appear in a membership (∈) or be equated to a bound value; a negation, ∀, ⇒ or a comparison other than = cannot produce values.', vars: missing });
          }
          items.push(r.plan);
          cur = r.bound;
          pending.splice(k, 1);
        }
        return { plan: { p: 'seq', items }, bound: cur };
      }
      case 'or': {
        const rs = f.items.map((x) => analyze(x, bound, notes));
        if (rs.some((r) => !r)) return null;
        let binds = null;
        for (const r of rs) binds = binds ? new Set([...binds].filter((v) => r.bound.has(v))) : new Set(r.bound);
        const differ = rs.some((r) => [...r.bound].some((v) => !binds.has(v)));
        if (differ) notes.push('The branches of ∨ bind different variables; only the ones every branch binds count as bound after it.');
        return { plan: { p: 'union', items: rs.map((r) => r.plan), binds: [...binds].filter((v) => !bound.has(v)) }, bound: binds };
      }
      case 'not': {
        if (!subset(freeVars(f.e), bound)) return null;
        const inner = f.e.f === 'not' ? analyze(f.e.e, bound, notes) : analyze(f.e, bound, notes);
        if (!inner) return null;
        return { plan: f.e.f === 'not' ? inner.plan : { p: 'none', e: inner.plan }, bound };
      }
      case 'implies': {
        if (!subset(freeVars(f), bound)) return null;
        return analyze({ f: 'not', e: { f: 'and', items: [f.l, negate(f.r)], pos: f.pos }, pos: f.pos }, bound, notes);
      }
      case 'forall': {
        if (!subset(freeVars(f), bound)) return null;
        return analyze({ f: 'not', e: { f: 'exists', vars: f.vars, e: negate(f.e), pos: f.pos, names: f.names }, pos: f.pos }, bound, notes);
      }
      case 'exists': {
        const inside = new Set([...bound].filter((v) => !f.vars.includes(v)));
        const r = analyze(f.e, inside, notes);
        if (!r) return null;
        const loose = f.vars.filter((v) => !r.bound.has(v));
        if (loose.length) unsafe('unsafe: the quantified variable' + (loose.length > 1 ? 's ' : ' ') + [...new Set(loose.map((v) => showVar(v).split('.')[0]))].join(', ') + (loose.length > 1 ? ' are' : ' is') + ' not limited to values of a relation', f.pos, { hint: 'Range it over a relation: ∃ s ∈ r (...) or ∃ x (<..., x, ...> ∈ r ∧ ...).' });
        const out = new Set([...r.bound].filter((v) => !f.vars.includes(v)));
        return { plan: { p: 'exists', vars: f.vars, e: r.plan, binds: [...out].filter((v) => !bound.has(v)) }, bound: out };
      }
    }
    fail('unknown formula', f.pos);
  }
  function describe(f) {
    switch (f.f) {
      case 'not': return 'the negation ¬(...)';
      case 'forall': return '∀ ' + (f.names || []).join(', ');
      case 'implies': return 'the implication ⇒';
      case 'cmp': return 'the comparison ' + A.scalarText(restore(f.e));
      case 'or': return 'the disjunction ∨';
      case 'exists': return '∃ ' + (f.names || []).join(', ');
      default: return 'a subformula';
    }
  }
  const restore = (e) => { const out = mapRefs(e, (r) => r.orig || showVar(r.parts[0])); const fix = (x) => { if (!x || typeof x !== 'object') return; if (x.k === 'attr') x.parts = x.parts[0].split('.'); for (const k in x) fix(x[k]); }; fix(out); return out; };

  // ---- evaluation ----------------------------------------------------------------------------------------------------
  function scalar(e, env) {
    switch (e.k) {
      case 'lit': return e.v;
      case 'attr': return env.get(e.parts[0]);
      case 'neg': { const v = scalar(e.e, env); return v === null ? null : -v; }
      case 'arith': {
        const a = scalar(e.l, env), b = scalar(e.r, env);
        if (a === null || b === null) return null;
        const x = Number(a), y = Number(b);
        if ((e.op === '/' || e.op === '%') && y === 0) throw K.err('22012', 'division by zero', { pos: e.pos });
        const v = e.op === '+' ? x + y : e.op === '-' ? x - y : e.op === '*' ? x * y : e.op === '/' ? x / y : x % y;
        return Number(v.toPrecision(15));
      }
      case 'fn': {
        const vs = e.args.map((x) => scalar(x, env));
        if (e.name === 'coalesce') return vs.find((v) => v !== null) ?? null;
        if (vs.some((v) => v === null)) return null;
        switch (e.name) {
          case 'upper': return String(vs[0]).toUpperCase();
          case 'lower': return String(vs[0]).toLowerCase();
          case 'length': return String(vs[0]).length;
          case 'abs': return Math.abs(vs[0]);
          case 'concat': return vs.map(String).join('');
          case 'round': { const m = Math.pow(10, vs[1] || 0); return Math.round(vs[0] * m) / m; }
        }
        throw K.err('42883', 'function ' + e.name + ' is not available in the calculus', { pos: e.pos });
      }
    }
    throw K.err(SYNTAX, 'cannot evaluate this expression', { pos: e.pos });
  }
  function truth(e, env) {
    if (e.k === 'isnull') return (scalar(e.e, env) === null) !== e.neg;
    if (e.k === 'like') { const a = scalar(e.e, env), b = scalar(e.pat, env); return a !== null && b !== null && A.compile({ k: 'like', e: { k: 'lit', v: a }, pat: { k: 'lit', v: b }, neg: e.neg }, [])() === true; }
    const a = scalar(e.l, env), b = scalar(e.r, env);
    if (a === null || b === null) return false;
    const d = A.compare(a, b, e.pos);
    switch (e.op) { case '=': return d === 0; case '<>': return d !== 0; case '<': return d < 0; case '>': return d > 0; case '<=': return d <= 0; default: return d >= 0; }
  }
  const nk = (v) => A.keyOf(A.numLike(v) ? Number(v) : v);
  function makeRunner(get) {
    const rels = new Map(), indexes = new Map();
    const rel = (name) => { if (!rels.has(name)) { const r = get(name); rels.set(name, A.rowKey ? dedupRows(r.rows) : r.rows); } return rels.get(name); };
    // rows of a relation whose given positions hold the given values, through a hash index per position set
    const lookup = (name, pos, vals) => {
      const rows = rel(name);
      if (!pos.length) return rows;
      const key = name + '\u0002' + pos.join(',');
      let idx = indexes.get(key);
      if (!idx) { idx = new Map(); for (const r of rows) { if (pos.some((p) => r[p] === null)) continue; const k = pos.map((p) => nk(r[p])).join('\u0001'); if (!idx.has(k)) idx.set(k, []); idx.get(k).push(r); } indexes.set(key, idx); }
      if (vals.some((v) => v === null)) return [];
      return idx.get(vals.map(nk).join('\u0001')) || [];
    };
    const stats = { tuples: 0 };
    function* run(p, env) {
      switch (p.p) {
        case 'bool': if (p.v) yield env; return;
        case 'test': if (truth(p.e, env)) yield env; return;
        case 'bind': { const v = scalar(p.e, env); const e2 = new Map(env); e2.set(p.v, v); yield e2; return; }
        case 'mem': {
          const pos = [], vals = [];
          p.terms.forEach((t, i) => { if (t.c !== undefined) { pos.push(i); vals.push(t.c); } else if (t.v !== undefined && env.has(t.v)) { pos.push(i); vals.push(env.get(t.v)); } });
          for (const r of lookup(p.rel, pos, vals)) {
            stats.tuples++;
            let e2 = null, ok = true;
            for (let i = 0; i < p.terms.length && ok; i++) {
              const t = p.terms[i];
              if (t.v === undefined) continue;
              const have = (e2 || env).has(t.v);
              if (have) { const v = (e2 || env).get(t.v); if (v === null || r[i] === null || A.compare(v, r[i]) !== 0) ok = false; }
              else { if (!e2) e2 = new Map(env); e2.set(t.v, r[i]); }
            }
            if (ok) yield e2 || env;
          }
          return;
        }
        case 'seq': {
          const step = function* (i, e) { if (i === p.items.length) { yield e; return; } for (const x of run(p.items[i], e)) yield* step(i + 1, x); };
          yield* step(0, env);
          return;
        }
        case 'union': {
          const seen = new Set();
          for (const b of p.items) for (const e2 of run(b, env)) {
            const out = new Map(env);
            for (const v of p.binds) out.set(v, e2.get(v));
            const k = p.binds.map((v) => nk(out.get(v))).join('\u0001');
            if (seen.has(k)) continue;
            seen.add(k);
            yield out;
          }
          return;
        }
        case 'none': { for (const x of run(p.e, env)) { void x; return; } yield env; return; }
        case 'exists': {
          if (!p.binds.length) { for (const x of run(p.e, env)) { void x; yield env; return; } return; }
          const seen = new Set();
          for (const e2 of run(p.e, env)) {
            const k = p.binds.map((v) => nk(e2.get(v))).join('\u0001');
            if (seen.has(k)) continue;
            seen.add(k);
            const out = new Map(env);
            for (const v of p.binds) out.set(v, e2.get(v));
            yield out;
          }
          return;
        }
      }
    }
    return { run, stats };
  }
  function dedupRows(rows) { const s = new Set(), out = []; for (const r of rows) { const k = A.rowKey(r); if (!s.has(k)) { s.add(k); out.push(r); } } return out; }

  /** check safety: { safe, reason, pos, hint, plan, notes } */
  function safety(input, src) {
    const get = A.source(src);
    try { const c = prepare(input, get); return { safe: true, plan: c.plan, notes: c.notes, kind: c.kind }; } catch (e) { if (e.unsafe) return { safe: false, reason: e.message, pos: e.pos, hint: e.hint }; throw e; }
  }
  function prepare(input, get) {
    const q = typeof input === 'string' ? parse(input) : input;
    const core = toCore(q, get);
    const notes = [];
    // wrapped in a conjunction, a formula that cannot be ordered is reported with the variables at fault
    const r = analyze(core.body.f === 'and' ? core.body : { f: 'and', items: [core.body], pos: core.body.pos }, new Set(), notes);
    const loose = core.result.filter((v) => !r.bound.has(v));
    if (loose.length) unsafe('unsafe: the result ' + (q.kind === 'trc' ? 'attribute' : 'variable') + (loose.length > 1 ? 's ' : ' ') + loose.map(showVar).join(', ') + (loose.length > 1 ? ' are' : ' is') + ' not limited to values of a relation, so the result could be infinite', q.pos, { hint: q.kind === 'trc' ? 'Say ' + q.head.name + ' ∈ r, or equate each ' + q.head.name + '[A] to an attribute of a tuple variable that ranges over a relation.' : 'Make each result variable appear in a membership <...> ∈ r.' });
    return { q, core, plan: r.plan, notes, kind: q.kind };
  }
  /**
   * Evaluate a TRC or DRC query (text) over a source. Returns { cols, rows, kind, plan, notes, text }.
   * Unsafe queries throw an error with unsafe: true, the position and a hint.
   */
  function evaluate(input, src) {
    const get = A.source(src);
    const { q, core, plan, notes } = prepare(input, get);
    const runner = makeRunner(get);
    const seen = new Set(), rows = [];
    for (const env of runner.run(plan, new Map())) {
      const row = core.result.map((v) => env.get(v));
      const k = A.rowKey(row);
      if (!seen.has(k)) { seen.add(k); rows.push(row); }
    }
    return { cols: core.names.slice(), rows, kind: q.kind, plan, notes, tuplesRead: runner.stats.tuples, text: planText(plan) };
  }
  /** the evaluation order the analysis chose, as indented lines */
  function planText(p, depth) {
    depth = depth || 0;
    const ind = '  '.repeat(depth);
    const v = showVar;
    switch (p.p) {
      case 'mem': return ind + 'for each tuple of ' + p.rel + ': ' + p.terms.map((t) => (t.v !== undefined ? v(t.v) : t.c !== undefined ? A.litText(t.c) : '_')).join(', ');
      case 'test': return ind + 'keep if ' + A.scalarText(restore(p.e));
      case 'bind': return ind + 'let ' + v(p.v) + ' = ' + A.scalarText(restore(p.e));
      case 'seq': return p.items.map((x) => planText(x, depth)).join('\n');
      case 'union': return ind + 'either\n' + p.items.map((x) => planText(x, depth + 1)).join('\n' + ind + 'or\n');
      case 'none': return ind + 'keep if there is no way to satisfy\n' + planText(p.e, depth + 1);
      case 'exists': return ind + 'keep if there exist ' + [...new Set(p.vars.map((x) => v(x).split('.')[0]))].join(', ') + ' such that\n' + planText(p.e, depth + 1);
      case 'bool': return ind + (p.v ? 'true' : 'false');
    }
    return '';
  }

  // ---- translation to the algebra -----------------------------------------------------------------------------------
  /**
   * The algebra of a safe calculus query, built from the plan: a membership is its relation with attributes renamed
   * to the variables, a conjunction a natural join (on the shared variables), a comparison a selection, a binding a
   * generalized projection, ∃ a projection, ∨ a union and a negation an antijoin. Returns { program, text, ascii }.
   */
  function toAlgebra(input, src) {
    const get = A.source(src);
    const { core, plan } = prepare(input, get);
    const names = new Map();
    const used = new Set();
    let tmp = 0;
    const an = (v) => {
      if (names.has(v)) return names.get(v);
      let b = showVar(v).replace(/\./g, '_').replace(/[^a-z0-9_]/gi, '_').toLowerCase();
      if (!A.isIdent(b)) b = 'v_' + b;
      let x = b, i = 2;
      while (used.has(x)) x = b + '_' + i++;
      used.add(x); names.set(v, x);
      return x;
    };
    const ren = (e) => mapRefs(e, (r) => an(r.parts[0]));
    const attr = (n) => ({ k: 'attr', parts: [n] });
    // cur: { e, vars: [variables in attribute order] } or null for the one-tuple relation with no attributes
    const unit = () => ({ e: { op: 'project', items: [], child: { op: 'const', rows: [[1]] } }, vars: [] });
    const proj = (cur, vars) => (vars.length === cur.vars.length && vars.every((v, i) => v === cur.vars[i]) ? cur : { e: { op: 'project', items: vars.map((v) => ({ e: attr(an(v)), as: null })), child: cur.e }, vars });
    const joinIn = (cur, nxt) => {
      if (!cur || !cur.vars.length && cur.e.op === 'project' && !cur.e.items.length) return nxt;
      const shared = cur.vars.filter((v) => nxt.vars.includes(v));
      // the natural join's attribute order: the shared ones, then the rest of each side
      if (shared.length) return { e: { op: 'join', left: cur.e, right: nxt.e, cond: null }, vars: shared.concat(cur.vars.filter((v) => !shared.includes(v)), nxt.vars.filter((v) => !shared.includes(v))) };
      return { e: { op: 'product', left: cur.e, right: nxt.e }, vars: cur.vars.concat(nxt.vars) };
    };
    const tr = (p, cur) => {
      switch (p.p) {
        case 'bool': return p.v ? (cur || unit()) : { e: { op: 'minus', left: (cur || unit()).e, right: (cur || unit()).e }, vars: (cur || unit()).vars };
        case 'mem': {
          // the relation with its attributes renamed to the variables; constants and repeated variables become σ
          const vars = [], conds = [], attrs = [];
          for (const t of p.terms) {
            if (t.v !== undefined && !vars.includes(t.v)) { vars.push(t.v); attrs.push(an(t.v)); continue; }
            const nm = '_' + (++tmp);
            attrs.push(nm);
            if (t.c !== undefined) conds.push({ k: 'cmp', op: '=', l: attr(nm), r: { k: 'lit', v: t.c } });
            else if (t.v !== undefined) conds.push({ k: 'cmp', op: '=', l: attr(nm), r: attr(an(t.v)) });
          }
          let e = { op: 'rename', rel: p.rel.replace(/[^a-z0-9_]/g, '_') + '_' + (++tmp), attrs, map: null, child: { op: 'rel', name: p.rel } };
          if (conds.length) e = { op: 'select', cond: conds.length === 1 ? conds[0] : { k: 'and', items: conds }, child: e };
          if (vars.length !== attrs.length) e = { op: 'project', items: vars.map((v) => ({ e: attr(an(v)), as: null })), child: e };
          return joinIn(cur, { e, vars });
        }
        case 'test': { const c = cur || unit(); return { e: { op: 'select', cond: ren(p.e), child: c.e }, vars: c.vars }; }
        case 'bind': { const c = cur || unit(); return { e: { op: 'project', items: c.vars.map((v) => ({ e: attr(an(v)), as: null })).concat([{ e: ren(p.e), as: an(p.v) }]), child: c.e }, vars: c.vars.concat([p.v]) }; }
        case 'seq': { let c = cur; for (const x of p.items) c = tr(x, c); return c || unit(); }
        case 'union': {
          const base = cur ? cur.vars : [];
          const keep = base.concat(p.binds);
          const parts = p.items.map((x) => proj(tr(x, cur), keep));
          return parts.slice(1).reduce((a, b) => ({ e: { op: 'union', left: a.e, right: b.e }, vars: keep }), parts[0]);
        }
        case 'none': {
          const c = cur || unit();
          const inner = proj(tr(p.e, c), c.vars);
          return { e: { op: 'minus', left: c.e, right: inner.e }, vars: c.vars };
        }
        case 'exists': {
          const base = cur ? cur.vars : [];
          const inner = tr(p.e, cur);
          return proj(inner, base.concat(p.binds));
        }
      }
      return cur;
    };
    const res = tr(plan, null);
    const final = { op: 'project', items: core.result.map((v, i) => ({ e: attr(an(v)), as: an(v) === core.names[i] ? null : core.names[i] })), child: res.e };
    const prog = { stmts: [], result: A.simplify ? A.simplify(final, get) : final };
    return { program: prog, text: A.programText(prog), ascii: A.programText(prog, 'ascii') };
  }

  A.Calculus = { parse, evaluate, safety, toAlgebra, planText, toCore, analyze };
})(typeof window !== 'undefined' ? window : globalThis);
