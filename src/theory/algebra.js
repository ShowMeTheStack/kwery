// Relational algebra in its usual notation: a parser for the Unicode notation and an ASCII form, a printer,
// schema inference and an evaluator that keeps every intermediate result for the stepping view.
//
// Relations are sets by default (every operator removes duplicates); { bag: true } evaluates with multiset
// semantics instead. NULL follows the usual convention: a selection or join condition that is unknown counts as false,
// while projection, union, intersection, difference and duplicate elimination treat two NULLs as the same value;
// aggregates skip NULLs (count(*) counts rows).
//
// Expression AST (relations): { op, pos, end, ... }
//   rel(name) const(rows) select(cond) project(items: [{ e, as }]) rename(rel, attrs, map) group(groups, aggs)
//   sort(keys) distinct  union minus intersect product divide (left, right)
//   join ljoin rjoin fjoin semijoin antijoin (left, right, cond: null for the natural form)
// Scalar AST: { k: 'attr', parts } { k: 'lit', v } { k: 'cmp', op, l, r } { k: 'and'|'or', items } { k: 'not', e }
//   { k: 'arith', op, l, r } { k: 'neg', e } { k: 'isnull', e, neg } { k: 'like', e, pat, neg } { k: 'fn', name, args }
// A program is { stmts: [{ name, attrs, expr }], result }: assignments (temp ← E) and a final expression.
(function (root) {
  'use strict';
  const K = root.K = root.K || {};
  const SYNTAX = '42601';
  const fail = (msg, pos, extra) => { throw K.err ? K.err(SYNTAX, msg, Object.assign({ pos }, extra || {})) : Object.assign(new Error(msg), { pos }); };
  const failc = (code, msg, pos, extra) => { throw K.err(code, msg, Object.assign({ pos }, extra || {})); };

  // ---- lexer (shared with the calculus parsers) ------------------------------------------------------------------
  // Unicode symbols and their ASCII spellings, mapped to one canonical name each
  const SYM = {
    'σ': 'select', 'π': 'project', 'Π': 'project', 'ρ': 'rename', 'γ': 'group', 'Γ': 'group', 'ℊ': 'group', '𝒢': 'group', 'τ': 'sort', 'δ': 'distinct',
    '∪': 'union', '∩': 'intersect', '−': 'minus', '×': 'product', '⋈': 'join', '⨝': 'join', '⟕': 'ljoin', '⟖': 'rjoin', '⟗': 'fjoin',
    '⋉': 'semijoin', '⋊': 'rsemijoin', '▷': 'antijoin', '⊳': 'antijoin', '▹': 'antijoin', '÷': 'divide', '←': 'assign', '→': 'arrow', '↦': 'arrow',
    '∧': 'and', '∨': 'or', '¬': 'not', '≠': '<>', '≤': '<=', '≥': '>=', '∈': 'in', '∉': 'notin', '∃': 'exists', '∀': 'forall', '⇒': 'implies',
    '⟨': '<', '⟩': '>', '〈': '<', '〉': '>',
  };
  const WORDS = {
    select: 'select', sigma: 'select', project: 'project', pi: 'project', rename: 'rename', rho: 'rename', group: 'group', gamma: 'group',
    sort: 'sort', tau: 'sort', distinct: 'distinct', delta: 'distinct', dedup: 'distinct',
    union: 'union', intersect: 'intersect', minus: 'minus', except: 'minus', diff: 'minus', difference: 'minus', cross: 'product', times: 'product', product: 'product',
    join: 'join', njoin: 'join', natjoin: 'join', ljoin: 'ljoin', leftjoin: 'ljoin', rjoin: 'rjoin', rightjoin: 'rjoin', fjoin: 'fjoin', fulljoin: 'fjoin', outerjoin: 'fjoin',
    semijoin: 'semijoin', lsemijoin: 'semijoin', rsemijoin: 'rsemijoin', antijoin: 'antijoin', divide: 'divide', divideby: 'divide',
  };
  const LOGIC = { and: 'and', or: 'or', not: 'not', is: 'is', null: 'null', like: 'like', as: 'as', true: 'true', false: 'false', in: 'in', exists: 'exists', forall: 'forall', implies: 'implies', asc: 'asc', desc: 'desc' };

  const UNARY_SYMS = new Set(['select', 'project', 'rename', 'group', 'sort', 'join', 'ljoin', 'rjoin', 'fjoin', 'semijoin', 'rsemijoin', 'antijoin']);
  /** tokens: { k: 'id'|'num'|'str'|'sym'|'word'|'eof', v, pos, end, raw } */
  function lex(src) {
    const out = [];
    let i = 0;
    const n = src.length;
    while (i < n) {
      const c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === '-' && src[i + 1] === '-') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') { const j = src.indexOf('*/', i + 2); if (j < 0) fail('unterminated comment', i); i = j + 2; continue; }
      const start = i;
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
        while (i < n && /[0-9]/.test(src[i])) i++;
        if (src[i] === '.' && /[0-9]/.test(src[i + 1] || '')) { i++; while (i < n && /[0-9]/.test(src[i])) i++; }
        if (/[eE]/.test(src[i] || '') && /[-+0-9]/.test(src[i + 1] || '')) { i++; if (/[-+]/.test(src[i])) i++; while (i < n && /[0-9]/.test(src[i])) i++; }
        out.push({ k: 'num', v: Number(src.slice(start, i)), raw: src.slice(start, i), pos: start, end: i });
        continue;
      }
      if (c === '\'' || c === '"' || c === '“' || c === '‘' || c === '”' || c === '’') {
        const close = c === '“' ? '”' : c === '‘' ? '’' : c === '”' ? '”' : c === '’' ? '’' : c;
        let s = '';
        i++;
        for (;;) {
          if (i >= n) fail('unterminated string literal', start);
          if (src[i] === close) { if (src[i + 1] === close && close !== '”' && close !== '’') { s += close; i += 2; continue; } i++; break; }
          s += src[i++];
        }
        out.push({ k: 'str', v: s, pos: start, end: i });
        continue;
      }
      if (c === '`') {
        const j = src.indexOf('`', i + 1);
        if (j < 0) fail('unterminated quoted name', i);
        out.push({ k: 'id', v: src.slice(i + 1, j), quoted: true, pos: start, end: j + 1 });
        i = j + 1;
        continue;
      }
      if (c === '\\' && /[a-zA-Z]/.test(src[i + 1] || '')) {
        // LaTeX-style names: \sigma, \pi, \bowtie, \cup ...
        let j = i + 1; while (j < n && /[a-zA-Z]/.test(src[j])) j++;
        const w = src.slice(i + 1, j);
        const TEX = { sigma: 'select', pi: 'project', rho: 'rename', gamma: 'group', mathcal: null, tau: 'sort', delta: 'distinct', cup: 'union', cap: 'intersect', setminus: 'minus', times: 'product', bowtie: 'join', Join: 'join', ltimes: 'semijoin', rtimes: 'rsemijoin', triangleright: 'antijoin', rhd: 'antijoin', div: 'divide', leftarrow: 'assign', gets: 'assign', rightarrow: 'arrow', to: 'arrow', land: 'and', wedge: 'and', lor: 'or', vee: 'or', neg: 'not', lnot: 'not', neq: '<>', ne: '<>', leq: '<=', le: '<=', geq: '>=', ge: '>=', in: 'in', notin: 'notin', exists: 'exists', forall: 'forall', implies: 'implies', Rightarrow: 'implies', langle: '<', rangle: '>' };
        if (TEX[w]) { out.push({ k: 'sym', v: TEX[w], pos: start, end: j, raw: src.slice(i, j) }); i = j; continue; }
        if (w === 'setminus' || w === 'minus') { out.push({ k: 'sym', v: 'minus', pos: start, end: j }); i = j; continue; }
        fail('unknown symbol \\' + w, start);
      }
      // σ_{...}: an underscore right after an operator starts a subscript
      const prev = out[out.length - 1];
      if (c === '_' && (!/[A-Za-z0-9]/.test(src[i + 1] || '') || (prev && prev.k === 'sym' && prev.end === i && UNARY_SYMS.has(prev.v)))) { out.push({ k: 'sym', v: '_', pos: i, end: i + 1 }); i++; continue; }
      if (/[A-Za-z_À-ɏ]/.test(c) && !SYM[c]) {
        while (i < n && /[A-Za-z0-9_$À-ɏ]/.test(src[i])) i++;
        let w = src.slice(start, i);
        if (w.endsWith('_') && WORDS[w.slice(0, -1).toLowerCase()] && /[[{]/.test(src[i] || '')) { out.push({ k: 'id', v: w.slice(0, -1).toLowerCase(), raw: w.slice(0, -1), pos: start, end: i - 1 }); out.push({ k: 'sym', v: '_', pos: i - 1, end: i }); continue; }
        // some aggregates are spelled with a hyphen: count-distinct(person_id)
        const m = /^-distinct\b/i.exec(src.slice(i));
        if (m && /^(count|sum|avg|average|min|max)$/i.test(w)) { w += '_distinct'; i += m[0].length; }
        out.push({ k: 'id', v: w.toLowerCase(), raw: w, pos: start, end: i });
        continue;
      }
      const two = src.slice(i, i + 2), three = src.slice(i, i + 3);
      if (three === '<->') { out.push({ k: 'sym', v: 'iff', pos: start, end: i + 3 }); i += 3; continue; }
      const OPS2 = { '<-': 'assign', ':=': 'assign', '->': 'arrow', '=>': 'implies', '<=': '<=', '>=': '>=', '<>': '<>', '!=': '<>', '||': '||', '&&': 'and', '|>': 'antijoin', '><': 'join' };
      if (three === '->>') { out.push({ k: 'sym', v: '->>', pos: start, end: i + 3 }); i += 3; continue; }
      if (OPS2[two]) { out.push({ k: 'sym', v: OPS2[two], pos: start, end: i + 2 }); i += 2; continue; }
      const cp = src.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      if (SYM[ch]) { out.push({ k: 'sym', v: SYM[ch], pos: start, end: i + ch.length, raw: ch }); i += ch.length; continue; }
      if ('()[]{},;.=<>+-*/%|:_!&~^'.includes(c)) { out.push({ k: 'sym', v: c === '!' ? 'not' : c === '~' ? 'not' : c, pos: start, end: i + 1 }); i++; continue; }
      fail('unexpected character "' + ch + '"', start);
    }
    out.push({ k: 'eof', v: null, pos: n, end: n });
    return out;
  }

  // ---- parser ------------------------------------------------------------------------------------------------------
  const BIN = {
    union: 1, minus: 1, intersect: 2, product: 3, join: 3, ljoin: 3, rjoin: 3, fjoin: 3, semijoin: 3, rsemijoin: 3, antijoin: 3, divide: 3,
  };
  const UNARY = new Set(['select', 'project', 'rename', 'group', 'sort', 'distinct']);
  const AGGS = new Set(['count', 'sum', 'avg', 'average', 'min', 'max']);
  const SCALAR_FNS = new Set(['upper', 'lower', 'length', 'abs', 'round', 'floor', 'ceil', 'coalesce', 'substr', 'substring', 'trim', 'concat', 'mod']);

  class Parser {
    constructor(src) { this.src = src; this.t = lex(src); this.i = 0; }
    get cur() { return this.t[this.i]; }
    peek(o) { return this.t[this.i + (o || 1)] || this.t[this.t.length - 1]; }
    next() { return this.t[this.i++]; }
    // the canonical operator name of a token, or null: symbols, and words that name operators
    opOf(tok) {
      if (!tok) return null;
      if (tok.k === 'sym') return tok.v;
      if (tok.k === 'id' && !tok.quoted) return WORDS[tok.v] || null;
      return null;
    }
    word(tok) { return tok && tok.k === 'id' && !tok.quoted ? (LOGIC[tok.v] || null) : null; }
    is(v) { const c = this.cur; return c.k === 'sym' && c.v === v; }
    isWord(w) { return this.word(this.cur) === w; }
    accept(v) { if (this.is(v)) { return this.next(); } return null; }
    acceptWord(w) { if (this.isWord(w)) return this.next(); return null; }
    expect(v, what) {
      if (this.is(v)) return this.next();
      const c = this.cur;
      fail('expected ' + (what || '"' + v + '"') + ' but found ' + this.desc(c), c.pos);
    }
    desc(c) { return c.k === 'eof' ? 'the end of the input' : c.k === 'str' ? 'the string "' + c.v + '"' : '"' + this.src.slice(c.pos, c.end) + '"'; }
    ident(what) {
      const c = this.cur;
      if (c.k !== 'id') fail('expected ' + (what || 'a name') + ' but found ' + this.desc(c), c.pos);
      this.i++;
      return c.v;
    }

    program() {
      const stmts = [];
      let result = null;
      while (this.cur.k !== 'eof') {
        while (this.accept(';'));
        if (this.cur.k === 'eof') break;
        const st = this.statement();
        if (st.name) { stmts.push(st); result = null; } else { if (result) fail('two expressions without an assignment between them; separate statements with ";" or assign the first one (temp ← ...)', st.expr.pos); result = st.expr; }
        if (!this.accept(';') && this.cur.k !== 'eof' && !this.startsStatement()) fail('unexpected ' + this.desc(this.cur) + ' after the end of an expression', this.cur.pos);
      }
      if (!stmts.length && !result) fail('the expression is empty', 0);
      return { stmts, result };
    }
    // a new statement starts with a name (temp ← ...) or on a new line
    startsStatement() {
      const prev = this.t[this.i - 1];
      if (prev && this.src.slice(prev.end, this.cur.pos).includes('\n') && (this.startsOperand() || this.cur.k === 'id')) return true;
      return this.cur.k === 'id' && !WORDS[this.cur.v];
    }
    /** name ← expr, name(a, b) ← expr, or an expression */
    statement() {
      const c = this.cur;
      if (c.k === 'id' && !WORDS[c.v]) {
        const save = this.i;
        this.i++;
        let attrs = null;
        if (this.is('(') && this.cur.pos === c.end) { this.i++; attrs = this.nameList(); this.expect(')'); }
        if (this.accept('assign')) {
          const expr = this.expr(0);
          return { name: c.v, attrs, expr, pos: c.pos };
        }
        this.i = save;
      }
      return { expr: this.expr(0) };
    }
    nameList() { const a = [this.ident('an attribute name')]; while (this.accept(',')) a.push(this.ident('an attribute name')); return a; }

    expr(minPrec) {
      let left = this.unary();
      for (;;) {
        const o = this.opOf(this.cur);
        const op = o === '-' ? 'minus' : o === '/' ? 'divide' : o;
        const p = op && BIN[op];
        if (!p || p < minPrec) break;
        const tok = this.next();
        let cond = null;
        if (op === 'join' || op === 'ljoin' || op === 'rjoin' || op === 'fjoin' || op === 'semijoin' || op === 'rsemijoin' || op === 'antijoin') cond = this.joinCond();
        const right = this.expr(p + 1);
        let node = { op, left, right, pos: left.pos, end: right.end, oppos: tok.pos };
        if (cond) node.cond = cond;
        else if (op !== 'product' && op !== 'divide' && BIN[op] === 3) node.cond = null;
        if (op === 'rsemijoin') node = { op: 'semijoin', left: right, right: left, cond: node.cond, pos: node.pos, end: node.end, oppos: tok.pos, flipped: true };
        left = node;
      }
      return left;
    }
    /** the subscript of a join: [θ], {θ}, _{θ}, _θ or nothing (natural join) */
    joinCond() {
      const us = this.accept('_');
      if (this.is('[') || this.is('{')) {
        const close = this.cur.v === '[' ? ']' : '}';
        // ⋈ {(1, 2)} would be a constant relation, not a condition
        if (close === '}' && this.peek().k === 'sym' && this.peek().v === '(' && !us) return null;
        this.next();
        const c = this.cond();
        this.expect(close, '"' + close + '" to close the join condition');
        return c;
      }
      if (us) { return this.cond(); }
      // a condition written plainly after the symbol (R ⋈ a = b S): only if a comparison follows and an operand after it
      const save = this.i;
      try {
        const c = this.cond();
        if ((c.k === 'cmp' || c.k === 'and' || c.k === 'or' || c.k === 'not' || c.k === 'isnull' || c.k === 'like') && this.startsOperand()) return c;
      } catch (e) { /* not a condition */ }
      this.i = save;
      return null;
    }
    startsOperand() {
      const c = this.cur;
      if (c.k === 'id') return !LOGIC[c.v] || !!WORDS[c.v];
      if (c.k === 'sym') return c.v === '(' || c.v === '{' || UNARY.has(c.v);
      return false;
    }
    unary() {
      const c = this.cur;
      const op = this.opOf(c);
      if (op && UNARY.has(op)) {
        this.next();
        return this.unaryOp(op, c);
      }
      if (c.k === 'sym' && c.v === '(') {
        this.next();
        const e = this.expr(0);
        const r = this.expect(')', '")" to close the parenthesis opened at ' + c.pos);
        e.paren = true;
        return Object.assign(e, { pos: c.pos, end: r.end });
      }
      if (c.k === 'sym' && c.v === '{') return this.constRel();
      if (c.k === 'id') {
        // the prefix form of aggregation: company_id γ avg(fee) (artist)
        const g = this.prefixGroup();
        if (g) return g;
        if (LOGIC[c.v] && !WORDS[c.v]) fail('expected a relation but found the keyword "' + c.raw + '"', c.pos);
        this.next();
        // namePos survives the parenthesis around an operand overwriting pos, so errors point at the name
        return { op: 'rel', name: c.v, pos: c.pos, end: c.end, namePos: c.pos };
      }
      if (c.k === 'eof') fail('the expression ends where a relation is expected', c.pos);
      fail('expected a relation, an operator such as σ or π, or "(" but found ' + this.desc(c), c.pos);
    }
    prefixGroup() {
      let j = this.i;
      const t = this.t;
      for (;;) {
        if (t[j].k !== 'id') return null;
        j++;
        if (t[j].k === 'sym' && t[j].v === '.' && t[j + 1].k === 'id') j += 2;
        if (t[j].k === 'sym' && t[j].v === ',') { j++; continue; }
        break;
      }
      if (this.opOf(t[j]) !== 'group') return null;
      const groups = [];
      do groups.push(this.attrRef()); while (this.accept(','));
      const tok = this.next();
      const node = this.unaryOp('group', tok, groups);
      node.pos = groups[0].pos;
      return node;
    }
    /** the parameter of σ π ρ γ τ: in [..], {..}, _{..}, or written plainly before the operand */
    param(fn) {
      this.accept('_');
      if (this.is('[') || this.is('{')) {
        const open = this.next();
        const close = open.v === '[' ? ']' : '}';
        const r = fn(true);
        this.expect(close, '"' + close + '" to close the subscript opened at ' + open.pos);
        return r;
      }
      this.plain = true;
      try { return fn(false); } finally { this.plain = false; }
    }
    operand(opTok) {
      const c = this.cur;
      if (c.k === 'sym' && c.v === '(') {
        this.next();
        const e = this.expr(0);
        const r = this.expect(')', '")" to close the operand of ' + (opTok.raw || opTok.v));
        e.paren = true;
        return Object.assign(e, { pos: c.pos, end: r.end });
      }
      if (c.k === 'eof') fail('the operator ' + this.src.slice(opTok.pos, opTok.end) + ' needs an operand', c.pos);
      return this.unary();
    }
    unaryOp(op, tok, prefixGroups) {
      let node;
      switch (op) {
        case 'select': {
          const cond = this.param(() => this.cond());
          node = { op, cond };
          break;
        }
        case 'project': {
          const items = this.param(() => this.projItems());
          node = { op, items };
          break;
        }
        case 'rename': node = Object.assign({ op }, this.param(() => this.renameSpec())); break;
        case 'group': {
          const items = (this.is('[') || this.is('{') || this.is('_')) || !this.startsOperandForGroup() ? this.param(() => this.groupItems()) : [];
          const groups = (prefixGroups || []).slice(), aggs = [];
          for (const it of items) { if (it.agg) aggs.push(it); else groups.push(it.e); }
          node = { op, groups, aggs };
          break;
        }
        case 'sort': node = { op, keys: this.param(() => this.sortKeys()) }; break;
        case 'distinct': node = { op }; break;
      }
      const child = this.operand(tok);
      return Object.assign(node, { child, pos: tok.pos, end: child.end });
    }
    startsOperandForGroup() { return this.is('('); }
    projItems() {
      const items = [];
      do {
        const p = this.cur.pos;
        const e = this.scalar();
        let as = null;
        if (this.acceptWord('as') || this.accept('arrow')) as = this.ident('a name for the projected value');
        else if (this.is('assign')) fail('write the new name after the expression: expr → name (or expr as name)', this.cur.pos);
        items.push({ e, as, pos: p });
      } while (this.accept(','));
      return items;
    }
    renameSpec() {
      const c = this.cur;
      // ρ[a → b, c → d] / ρ[b ← a]: attribute renames
      const nxt = this.peek();
      if (c.k === 'id' && nxt.k === 'sym' && (nxt.v === 'arrow' || nxt.v === 'assign' || (nxt.k === 'id' && nxt.v === 'as'))) return { rel: null, attrs: null, map: this.renameMap() };
      if (c.k === 'id' && nxt.k === 'id' && nxt.v === 'as' && !nxt.quoted) return { rel: null, attrs: null, map: this.renameMap() };
      const name = this.ident('a relation name');
      let attrs = null;
      if (this.is('(') && (!this.plain || this.cur.pos === c.end)) { this.next(); attrs = this.nameList(); this.expect(')'); }
      return { rel: name, attrs, map: null };
    }
    renameMap() {
      const map = [];
      do {
        const p = this.cur.pos;
        const a = this.ident('an attribute name');
        if (this.accept('arrow') || this.acceptWord('as')) map.push({ from: a, to: this.ident('the new attribute name'), pos: p });
        else if (this.accept('assign')) map.push({ from: this.ident('the old attribute name'), to: a, pos: p });
        else fail('expected → or ← in an attribute rename', this.cur.pos);
      } while (this.accept(','));
      return map;
    }
    groupItems() {
      const items = [];
      const one = () => {
        const c = this.cur;
        const p = c.pos;
        if (c.k === 'id' && this.isAggName(c.v) && this.peek().k === 'sym' && this.peek().v === '(') {
          const a = this.aggCall();
          if (this.acceptWord('as') || this.accept('arrow')) a.as = this.ident('a name for the aggregate');
          a.pos = p;
          items.push(a);
        } else {
          const e = this.attrRef();
          if (this.acceptWord('as') || this.accept('arrow')) fail('only aggregates can be named in γ; rename grouping attributes with ρ', this.t[this.i - 1].pos);
          items.push({ e });
        }
      };
      one();
      while (this.accept(',') || this.accept(';')) one();
      return items;
    }
    isAggName(v) { return AGGS.has(v) || /^(count|sum|avg|average|min|max)_distinct$/.test(v); }
    aggCall() {
      const tok = this.next();
      let fn = tok.v, distinct = false;
      if (/_distinct$/.test(fn)) { fn = fn.replace(/_distinct$/, ''); distinct = true; }
      if (fn === 'average') fn = 'avg';
      this.expect('(');
      if (this.isWord('distinct') || (this.cur.k === 'id' && this.cur.v === 'distinct')) { this.next(); distinct = true; }
      let arg = null;
      if (this.accept('*')) { if (fn !== 'count') fail(fn + '(*) is not an aggregate; only count(*) counts rows', tok.pos); }
      else arg = this.scalar();
      this.expect(')', '")" to close ' + tok.raw + '(');
      return { agg: true, fn, arg, distinct, as: null, pos: tok.pos };
    }
    sortKeys() {
      const keys = [];
      do {
        const e = this.scalar();
        let dir = 'asc';
        if (this.acceptWord('desc')) dir = 'desc'; else this.acceptWord('asc');
        keys.push({ e, dir });
      } while (this.accept(','));
      return keys;
    }
    constRel() {
      const open = this.expect('{');
      const rows = [];
      if (!this.is('}')) {
        do {
          this.expect('(', 'a tuple in parentheses');
          const r = [this.literal()];
          while (this.accept(',')) r.push(this.literal());
          this.expect(')');
          if (rows.length && r.length !== rows[0].length) fail('all tuples of a constant relation must have the same number of values', open.pos);
          rows.push(r);
        } while (this.accept(','));
      }
      const close = this.expect('}');
      if (!rows.length) fail('a constant relation needs at least one tuple', open.pos);
      return { op: 'const', rows, pos: open.pos, end: close.end };
    }
    literal() {
      const c = this.cur;
      const neg = this.accept('-');
      const d = this.cur;
      if (d.k === 'num') { this.next(); return neg ? -d.v : d.v; }
      if (neg) fail('expected a number', d.pos);
      if (c.k === 'str') { this.next(); return c.v; }
      const w = this.word(c);
      if (w === 'null') { this.next(); return null; }
      if (w === 'true' || w === 'false') { this.next(); return w === 'true'; }
      fail('expected a constant (a number, a string or null) but found ' + this.desc(c), c.pos);
    }

    // ---- conditions and scalar expressions ----
    cond() { return this.orExpr(); }
    orExpr() {
      const first = this.andExpr();
      const items = [first];
      while (this.accept('or') || this.acceptWord('or')) items.push(this.andExpr());
      return items.length === 1 ? first : { k: 'or', items, pos: first.pos };
    }
    andExpr() {
      const first = this.notExpr();
      const items = [first];
      while (this.accept('and') || this.acceptWord('and')) items.push(this.notExpr());
      return items.length === 1 ? first : { k: 'and', items, pos: first.pos };
    }
    notExpr() {
      const c = this.cur;
      if (this.accept('not') || this.acceptWord('not')) return { k: 'not', e: this.notExpr(), pos: c.pos };
      return this.cmpExpr();
    }
    cmpExpr() {
      const l = this.scalar();
      const c = this.cur;
      if (c.k === 'sym' && ['=', '<>', '<', '>', '<=', '>='].includes(c.v)) {
        this.next();
        const r = this.scalar();
        return { k: 'cmp', op: c.v, l, r, pos: l.pos };
      }
      if (this.isWord('is')) {
        this.next();
        const neg = !!(this.accept('not') || this.acceptWord('not'));
        if (!this.acceptWord('null')) fail('expected NULL after IS', this.cur.pos);
        return { k: 'isnull', e: l, neg, pos: l.pos };
      }
      if (this.isWord('like') || (this.isWord('not') && this.word(this.peek()) === 'like')) {
        const neg = !!this.acceptWord('not');
        this.next();
        return { k: 'like', e: l, pat: this.scalar(), neg, pos: l.pos };
      }
      return l;
    }
    scalar() { return this.addExpr(); }
    addExpr() {
      let l = this.mulExpr();
      for (;;) {
        const c = this.cur;
        if (c.k === 'sym' && (c.v === '+' || c.v === '-' || c.v === '||' || (c.v === 'minus' && !this.plain))) {
          this.next();
          const r = this.mulExpr();
          l = c.v === '||' ? { k: 'fn', name: 'concat', args: [l, r], op: '||', pos: l.pos } : { k: 'arith', op: c.v === 'minus' ? '-' : c.v, l, r, pos: l.pos };
        } else return l;
      }
    }
    mulExpr() {
      let l = this.unaryScalar();
      for (;;) {
        const c = this.cur;
        if (c.k === 'sym' && (c.v === '*' || c.v === '/' || c.v === '%')) { this.next(); l = { k: 'arith', op: c.v, l, r: this.unaryScalar(), pos: l.pos }; } else return l;
      }
    }
    unaryScalar() {
      const c = this.cur;
      if (c.k === 'sym' && c.v === '-') { this.next(); return { k: 'neg', e: this.unaryScalar(), pos: c.pos }; }
      if (c.k === 'sym' && c.v === '+') { this.next(); return this.unaryScalar(); }
      return this.primaryScalar();
    }
    primaryScalar() {
      const c = this.cur;
      if (c.k === 'num') { this.next(); return { k: 'lit', v: c.v, pos: c.pos, end: c.end }; }
      if (c.k === 'str') { this.next(); return { k: 'lit', v: c.v, pos: c.pos, end: c.end }; }
      if (c.k === 'sym' && c.v === '(') {
        this.next();
        const e = this.cond();
        this.expect(')', '")" to close the parenthesis opened at ' + c.pos);
        return e;
      }
      if (c.k === 'id') {
        const w = this.word(c);
        if (w === 'null') { this.next(); return { k: 'lit', v: null, pos: c.pos }; }
        if (w === 'true' || w === 'false') { this.next(); return { k: 'lit', v: w === 'true', pos: c.pos }; }
        const nx = this.peek();
        // a call: the name touches its "(" (in the plain form a space separates a condition from the operand)
        if (nx.k === 'sym' && nx.v === '(' && (!this.plain || nx.pos === c.end) && (SCALAR_FNS.has(c.v) || this.isAggName(c.v))) {
          if (this.isAggName(c.v)) fail('aggregate ' + c.raw + '() is only allowed in γ', c.pos, { hint: 'Compute it with γ first, e.g. γ[' + c.raw + '(...) as v](E), then compare v.' });
          this.next(); this.next();
          const args = [];
          if (!this.is(')')) { do args.push(this.scalar()); while (this.accept(',')); }
          this.expect(')', '")" to close ' + c.raw + '(');
          return { k: 'fn', name: c.v, args, pos: c.pos };
        }
        if (nx.k === 'sym' && nx.v === '(' && (!this.plain || nx.pos === c.end) && !this.plain) fail('unknown function ' + c.raw + '()', c.pos);
        return this.attrRef();
      }
      fail('expected a value or an attribute but found ' + this.desc(c), c.pos);
    }
    attrRef() {
      const c = this.cur;
      if (c.k !== 'id') fail('expected an attribute name but found ' + this.desc(c), c.pos);
      this.next();
      const parts = [c.v];
      let end = c.end;
      if (this.is('.') && this.peek().k === 'id') { this.next(); const d = this.next(); parts.push(d.v); end = d.end; }
      return { k: 'attr', parts, pos: c.pos, end };
    }
  }
  const parse = (src) => new Parser(src).program();
  /** parse a single expression (no assignments) */
  const parseExpr = (src) => { const p = parse(src); if (p.stmts.length) fail('expected an expression, not an assignment', 0); return p.result; };

  // ---- printing ------------------------------------------------------------------------------------------------------
  const SYMBOLS = {
    unicode: { select: 'σ', project: 'π', rename: 'ρ', group: 'γ', sort: 'τ', distinct: 'δ', union: '∪', minus: '−', intersect: '∩', product: '×', join: '⋈', ljoin: '⟕', rjoin: '⟖', fjoin: '⟗', semijoin: '⋉', antijoin: '▷', divide: '÷', assign: '←', arrow: '→', and: '∧', or: '∨', not: '¬', '<>': '≠', '<=': '≤', '>=': '≥' },
    ascii: { select: 'select', project: 'project', rename: 'rename', group: 'group', sort: 'sort', distinct: 'distinct', union: 'union', minus: 'minus', intersect: 'intersect', product: 'cross', join: 'join', ljoin: 'ljoin', rjoin: 'rjoin', fjoin: 'fjoin', semijoin: 'semijoin', antijoin: 'antijoin', divide: 'divide', assign: '<-', arrow: '->', and: 'and', or: 'or', not: 'not', '<>': '<>', '<=': '<=', '>=': '>=' },
  };
  const isIdent = (s) => /^[a-z_][a-z0-9_$]*$/.test(s) && !WORDS[s] && !LOGIC[s];
  const nameOut = (s) => (isIdent(s) ? s : '`' + s + '`');
  function litText(v, style) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    const q = style === 'ascii' ? '\'' : '"';
    return q + String(v).split(q).join(q + q) + q;
  }
  const SPREC = { or: 1, and: 2, not: 3, cmp: 4, isnull: 4, like: 4, '+': 5, '-': 5, '||': 5, '*': 6, '/': 6, '%': 6, neg: 7 };
  function scalarText(e, style, parent) {
    const S = SYMBOLS[style || 'unicode'];
    const t = (x, p) => scalarText(x, style, p);
    let s, p;
    switch (e.k) {
      case 'lit': return litText(e.v, style);
      case 'attr': return e.parts.map(nameOut).join('.');
      case 'and': case 'or': p = SPREC[e.k]; s = e.items.map((x) => t(x, p)).join(' ' + S[e.k] + ' '); break;
      case 'not': p = SPREC.not; s = S.not + (style === 'ascii' ? ' ' : '') + (['cmp', 'isnull', 'like', 'and', 'or'].includes(e.e.k) ? '(' + t(e.e, 0) + ')' : t(e.e, p)); break;
      case 'cmp': p = SPREC.cmp; s = t(e.l, p + 1) + ' ' + (S[e.op] || e.op) + ' ' + t(e.r, p + 1); break;
      case 'isnull': p = SPREC.isnull; s = t(e.e, p + 1) + (e.neg ? ' is not null' : ' is null'); break;
      case 'like': p = SPREC.like; s = t(e.e, p + 1) + (e.neg ? ' not like ' : ' like ') + t(e.pat, p + 1); break;
      case 'arith': p = SPREC[e.op]; s = t(e.l, p) + ' ' + e.op + ' ' + t(e.r, p + 1); break;
      case 'neg': p = SPREC.neg; s = '-' + t(e.e, p); break;
      case 'fn': if (e.op === '||') { p = SPREC['||']; s = t(e.args[0], p) + ' || ' + t(e.args[1], p + 1); break; } return e.name + '(' + e.args.map((x) => t(x, 0)).join(', ') + ')';
      default: return '?';
    }
    return parent !== undefined && p < parent ? '(' + s + ')' : s;
  }
  function aggText(a, style) {
    return a.fn + '(' + (a.distinct ? 'distinct ' : '') + (a.arg ? scalarText(a.arg, style) : '*') + ')' + (a.as ? ' ' + (style === 'ascii' ? 'as' : SYMBOLS.unicode.arrow) + ' ' + nameOut(a.as) : '');
  }
  /** the subscript of an operator node, as text */
  function subscript(n, style) {
    const arrow = style === 'ascii' ? ' as ' : ' ' + SYMBOLS.unicode.arrow + ' ';
    switch (n.op) {
      case 'select': return scalarText(n.cond, style);
      case 'project': return n.items.map((it) => scalarText(it.e, style) + (it.as ? arrow + nameOut(it.as) : '')).join(', ');
      case 'rename': return n.map ? n.map.map((m) => nameOut(m.from) + (style === 'ascii' ? ' -> ' : ' → ') + nameOut(m.to)).join(', ') : nameOut(n.rel) + (n.attrs ? '(' + n.attrs.map(nameOut).join(', ') + ')' : '');
      case 'group': return n.groups.map((g) => scalarText(g, style)).concat(n.aggs.map((a) => aggText(a, style))).join(', ');
      case 'sort': return n.keys.map((k) => scalarText(k.e, style) + (k.dir === 'desc' ? ' desc' : '')).join(', ');
      default: return n.cond ? scalarText(n.cond, style) : '';
    }
  }
  /** an expression as text; style 'unicode' (default) or 'ascii'. Parses back to the same tree */
  function toText(n, style) {
    style = style || 'unicode';
    const S = SYMBOLS[style];
    const rec = (x, ctx) => {
      if (x.op === 'rel') return nameOut(x.name);
      if (x.op === 'const') return '{' + x.rows.map((r) => '(' + r.map((v) => litText(v, style)).join(', ') + ')').join(', ') + '}';
      if (UNARY.has(x.op)) {
        const sub = subscript(x, style);
        return S[x.op] + (x.op === 'distinct' ? '' : '[' + sub + ']') + '(' + rec(x.child, 0) + ')';
      }
      const p = BIN[x.op];
      const sub = x.cond ? '[' + scalarText(x.cond, style) + ']' : '';
      const s = rec(x.left, p) + ' ' + S[x.op] + sub + ' ' + rec(x.right, p + 1);
      return ctx > p ? '(' + s + ')' : s;
    };
    return rec(n, 0);
  }
  function programText(prog, style) {
    const S = SYMBOLS[style || 'unicode'];
    const lines = prog.stmts.map((s) => nameOut(s.name) + (s.attrs ? '(' + s.attrs.map(nameOut).join(', ') + ')' : '') + ' ' + S.assign + ' ' + toText(s.expr, style));
    if (prog.result) lines.push(toText(prog.result, style));
    return lines.join('\n');
  }
  /** a tree for display: { op, symbol, sub, text, children } */
  function toTree(n, style) {
    style = style || 'unicode';
    const S = SYMBOLS[style];
    if (n.op === 'rel') return { op: 'rel', symbol: n.name, sub: '', text: n.name, children: [], node: n };
    if (n.op === 'const') return { op: 'const', symbol: toText(n, style), sub: '', text: toText(n, style), children: [], node: n };
    const kids = UNARY.has(n.op) ? [n.child] : [n.left, n.right];
    return { op: n.op, symbol: S[n.op], sub: subscript(n, style), text: toText(n, style), children: kids.map((k) => toTree(k, style)), node: n };
  }

  // ---- values ----------------------------------------------------------------------------------------------------------
  /** an engine value as a plain JavaScript value: numbers, strings, booleans or null */
  function plain(v, type) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'bigint') return Number(v);
    if (K.Decimal && v instanceof K.Decimal) return v.toNumber();
    if (v && typeof v.toNumber === 'function' && type && type.cat === 'N') return v.toNumber();
    if (K.T && type) { try { return K.T.output(v, type); } catch (e) { /* fall through */ } }
    return String(v);
  }
  const keyOf = (v) => (v === null ? '\u0000N' : typeof v === 'number' ? 'n' + (Object.is(v, -0) ? 0 : v) : typeof v === 'boolean' ? (v ? 'T' : 'F') : 's' + v);
  const rowKey = (r) => r.map(keyOf).join('\u0001');
  const numLike = (s) => typeof s === 'string' && /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/.test(s);
  /** compare two non-null values: <0, 0, >0 */
  function compare(a, b, pos) {
    if (typeof a === typeof b) { if (typeof a === 'string') return a < b ? -1 : a > b ? 1 : 0; return a < b ? -1 : a > b ? 1 : 0; }
    if (typeof a === 'number' && numLike(b)) return a - Number(b);
    if (typeof b === 'number' && numLike(a)) return Number(a) - b;
    failc('42883', 'cannot compare ' + typeof a + ' ' + litText(a) + ' with ' + typeof b + ' ' + litText(b), pos);
  }
  function like(s, p) {
    let re = '^';
    for (const ch of p) re += ch === '%' ? '.*' : ch === '_' ? '.' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(re + '$', 's').test(s);
  }

  // ---- relation sources: a Kwery session, a map of relations, or a function -------------------------------------------
  /**
   * src: a Session (relations are read with SELECT * FROM name), { name: { cols: [names or {name}], rows } },
   * or (name) => relation. Returns a function name -> { attrs: [names], rows } (or null), cached.
   */
  function source(src) {
    if (src && src.__algebraSource) return src;
    const cache = new Map();
    let get;
    if (!src) get = () => null;
    else if (typeof src === 'function') get = src;
    else if (typeof src.query === 'function' && src.db) {
      get = (name) => {
        let r;
        try { r = src.query('SELECT * FROM ' + quoteSql(name)); } catch (e) { if (e.code === '42P01' || e.code === '3F000') return null; throw e; }
        return { attrs: r.cols.map((c) => c.name), rows: r.rows.map((row) => row.map((v, i) => plain(v, r.cols[i].type))), types: r.cols.map((c) => c.type) };
      };
    } else {
      const lower = new Map(Object.keys(src).map((k) => [k.toLowerCase(), src[k]]));
      get = (name) => {
        const r = lower.get(name);
        if (!r) return null;
        const attrs = (r.cols || r.attrs).map((c) => (typeof c === 'string' ? c : c.name).toLowerCase());
        return { attrs, rows: r.rows.map((row) => (Array.isArray(row) ? row.map((v) => plain(v)) : attrs.map((a) => plain(row[a])))) };
      };
    }
    const f = (name) => { if (!cache.has(name)) cache.set(name, get(name)); return cache.get(name); };
    f.__algebraSource = true;
    return f;
  }
  const quoteSql = (s) => (/^[a-z_][a-z0-9_]*$/.test(s) && !SQL_RESERVED.has(s) ? s : '"' + s.replace(/"/g, '""') + '"');
  const SQL_RESERVED = new Set(['all', 'and', 'any', 'as', 'asc', 'between', 'by', 'case', 'check', 'column', 'constraint', 'create', 'cross', 'current_date', 'default', 'desc', 'distinct', 'do', 'else', 'end', 'except', 'false', 'for', 'foreign', 'from', 'full', 'grant', 'group', 'having', 'in', 'inner', 'intersect', 'into', 'is', 'join', 'left', 'like', 'limit', 'natural', 'not', 'null', 'offset', 'on', 'only', 'or', 'order', 'outer', 'primary', 'references', 'right', 'select', 'table', 'then', 'to', 'true', 'union', 'unique', 'user', 'using', 'when', 'where', 'with', 'window', 'year', 'month', 'day', 'time', 'timestamp', 'interval', 'value', 'values']);

  // ---- schemas -----------------------------------------------------------------------------------------------------------
  // an attribute: { name, quals: [relation names that qualify it] }
  const attr = (name, quals) => ({ name, quals: quals || [] });
  const qualName = (a) => (a.quals.length ? a.quals[0] + '.' + a.name : a.name);
  /** the display names of a schema: the bare name where it is unique, r.a where it is not */
  function displayNames(attrs) {
    return attrs.map((a, i) => {
      const dup = attrs.some((b, j) => j !== i && b.name === a.name);
      if (!dup) return a.name;
      const q = a.quals.find((x) => !attrs.some((b, j) => j !== i && b.name === a.name && b.quals.includes(x)));
      return q ? q + '.' + a.name : a.name;
    });
  }
  /** find the attribute a reference names; errors for unknown and ambiguous names */
  function resolve(attrs, ref, where) {
    const [q, n] = ref.parts.length === 2 ? ref.parts : [null, ref.parts[0]];
    const hits = [];
    attrs.forEach((a, i) => { if (a.name === n && (!q || a.quals.includes(q))) hits.push(i); });
    if (hits.length === 1) return hits[0];
    const list = displayNames(attrs).join(', ');
    const label = ref.parts.join('.');
    if (!hits.length) {
      const sameName = attrs.filter((a) => a.name === n);
      if (q && sameName.length) failc('42703', 'attribute "' + label + '" does not exist' + (where ? ' in ' + where : '') + ': no relation named "' + q + '" provides "' + n + '"', ref.pos, { hint: 'Available: ' + list + '. A rename ρ changes the relation name that qualifies attributes.' });
      failc('42703', 'attribute "' + label + '" does not exist' + (where ? ' in ' + where : ''), ref.pos, { hint: 'Available attributes: ' + list });
    }
    const quals = hits.map((i) => attrs[i].quals[0]).filter(Boolean);
    const distinctQuals = quals.filter((x, i) => quals.indexOf(x) === i);
    failc('42702', 'attribute reference "' + label + '" is ambiguous' + (where ? ' in ' + where : ''), ref.pos, {
      hint: distinctQuals.length === hits.length ? 'Qualify it: ' + distinctQuals.map((x) => x + '.' + n).join(' or ') : 'Both operands come from the same relation name; rename one of them first, e.g. ρ[t](' + (quals[0] || 'r') + ').',
    });
  }
  const freshAttrs = (attrs) => attrs.map((a) => attr(a.name, a.quals.slice()));
  /** attribute names of an aggregate or generalized projection item without "as" */
  const itemName = (e) => (e.k === 'attr' ? e.parts[e.parts.length - 1] : scalarText(e, 'ascii'));
  const aggName = (a) => a.as || (a.fn + (a.distinct ? '_distinct' : '') + (a.arg ? '_' + itemName(a.arg).replace(/[^a-z0-9_]/g, '') : ''));

  /** the attributes shared by name (for natural joins and division); errors when a shared name is ambiguous on one side */
  function common(la, ra, n, what) {
    const names = [];
    for (const a of la) if (ra.some((b) => b.name === a.name) && !names.includes(a.name)) names.push(a.name);
    for (const nm of names) {
      const cl = la.filter((a) => a.name === nm).length, cr = ra.filter((a) => a.name === nm).length;
      if (cl > 1 || cr > 1) failc('42702', 'the ' + what + ' is ambiguous: attribute "' + nm + '" occurs ' + Math.max(cl, cr) + ' times in the ' + (cl > 1 ? 'left' : 'right') + ' operand', n.oppos !== undefined ? n.oppos : n.pos, { hint: 'Project or rename the duplicate attributes away first.' });
    }
    return names;
  }

  /** schema inference for a node with an environment of assigned variables; returns attrs */
  function schemaOf(n, src, env) {
    src = source(src);
    env = env || new Map();
    const s = (x) => schemaOf(x, src, env);
    switch (n.op) {
      case 'rel': {
        if (env.has(n.name)) return freshAttrs(env.get(n.name));
        const r = src(n.name);
        if (!r) failc('42P01', 'relation "' + n.name + '" does not exist', n.namePos !== undefined ? n.namePos : n.pos);
        return r.attrs.map((a) => attr(a, [n.name]));
      }
      case 'const': return n.rows[0].map((_, i) => attr('column' + (i + 1)));
      case 'select': case 'sort': case 'distinct': {
        const a = s(n.child);
        if (n.op === 'select') checkScalar(n.cond, a, 'σ');
        if (n.op === 'sort') for (const k of n.keys) checkScalar(k.e, a, 'τ');
        return a;
      }
      case 'project': {
        const a = s(n.child);
        return n.items.map((it) => {
          checkScalar(it.e, a, 'π');
          if (!it.as && it.e.k === 'attr') { const b = a[resolve(a, it.e, 'π')]; return attr(b.name, b.quals.slice()); }
          return attr(it.as || itemName(it.e));
        });
      }
      case 'rename': {
        const a = s(n.child);
        if (n.map) {
          const out = freshAttrs(a);
          for (const m of n.map) { const i = resolve(out, { parts: [m.from], pos: m.pos }, 'ρ'); out[i].name = m.to; }
          return out;
        }
        if (n.attrs && n.attrs.length !== a.length) failc(SYNTAX, 'ρ[' + n.rel + '(…)] names ' + n.attrs.length + ' attributes but its operand has ' + a.length, n.pos);
        return a.map((x, i) => attr(n.attrs ? n.attrs[i] : x.name, [n.rel]));
      }
      case 'group': {
        const a = s(n.child);
        const out = n.groups.map((g) => { const b = a[resolve(a, g, 'γ')]; return attr(b.name, b.quals.slice()); });
        for (const ag of n.aggs) { if (ag.arg) checkScalar(ag.arg, a, 'γ'); out.push(attr(aggName(ag))); }
        return out;
      }
      case 'union': case 'minus': case 'intersect': {
        const l = s(n.left), r = s(n.right);
        if (l.length !== r.length) failc(SYNTAX, 'the operands of ' + SYMBOLS.unicode[n.op] + ' are not union-compatible: the left has ' + l.length + ' attributes (' + displayNames(l).join(', ') + '), the right ' + r.length + ' (' + displayNames(r).join(', ') + ')', n.oppos !== undefined ? n.oppos : n.pos);
        return l.map((x) => attr(x.name, x.quals.slice()));
      }
      case 'product': return freshAttrs(s(n.left)).concat(freshAttrs(s(n.right)));
      case 'join': case 'ljoin': case 'rjoin': case 'fjoin': {
        const l = s(n.left), r = s(n.right);
        if (n.cond) { const all = freshAttrs(l).concat(freshAttrs(r)); checkScalar(n.cond, all, 'the join condition'); return all; }
        const names = common(l, r, n, 'natural join');
        const out = names.map((nm) => { const a = l.find((x) => x.name === nm), b = r.find((x) => x.name === nm); return attr(nm, a.quals.concat(b.quals.filter((q) => !a.quals.includes(q)))); });
        return out.concat(freshAttrs(l.filter((x) => !names.includes(x.name))), freshAttrs(r.filter((x) => !names.includes(x.name))));
      }
      case 'semijoin': case 'antijoin': {
        const l = s(n.left), r = s(n.right);
        if (n.cond) checkScalar(n.cond, freshAttrs(l).concat(freshAttrs(r)), 'the join condition');
        else common(l, r, n, n.op === 'semijoin' ? 'semijoin' : 'antijoin');
        return freshAttrs(l);
      }
      case 'divide': {
        const l = s(n.left), r = s(n.right);
        divCheck(n, l, r);
        return freshAttrs(l.filter((a) => !r.some((b) => b.name === a.name)));
      }
    }
    failc(SYNTAX, 'unknown operator ' + n.op, n.pos);
  }
  function divCheck(n, l, r) {
    common(l, r, n, 'division');
    for (const b of r) if (!l.some((a) => a.name === b.name)) failc(SYNTAX, 'in r ÷ s every attribute of s must be an attribute of r; "' + b.name + '" is not', n.oppos !== undefined ? n.oppos : n.pos, { hint: 'r has ' + displayNames(l).join(', ') });
    if (l.length === r.length) failc(SYNTAX, 'in r ÷ s the schema of s must be a proper subset of the schema of r', n.oppos !== undefined ? n.oppos : n.pos);
  }
  function checkScalar(e, attrs, where) {
    const walk = (x) => {
      if (!x) return;
      switch (x.k) {
        case 'attr': resolve(attrs, x, where); return;
        case 'and': case 'or': x.items.forEach(walk); return;
        case 'not': case 'neg': case 'isnull': walk(x.e); return;
        case 'like': walk(x.e); walk(x.pat); return;
        case 'cmp': case 'arith': walk(x.l); walk(x.r); return;
        case 'fn': x.args.forEach(walk); return;
      }
    };
    walk(e);
  }

  // ---- scalar evaluation -------------------------------------------------------------------------------------------------
  /** compile a scalar expression against a schema: row => value (conditions return true, false or null) */
  function compile(e, attrs, where) {
    const c = (x) => compile(x, attrs, where);
    switch (e.k) {
      case 'lit': { const v = e.v; return () => v; }
      case 'attr': { const i = resolve(attrs, e, where); return (r) => r[i]; }
      case 'and': { const fs = e.items.map(c); return (r) => { let u = false; for (const f of fs) { const v = f(r); if (v === false) return false; if (v === null) u = true; } return u ? null : true; }; }
      case 'or': { const fs = e.items.map(c); return (r) => { let u = false; for (const f of fs) { const v = f(r); if (v === true) return true; if (v === null) u = true; } return u ? null : false; }; }
      case 'not': { const f = c(e.e); return (r) => { const v = f(r); return v === null ? null : !v; }; }
      case 'isnull': { const f = c(e.e); return (r) => (f(r) === null) !== e.neg; }
      case 'like': { const f = c(e.e), g = c(e.pat); return (r) => { const a = f(r), b = g(r); if (a === null || b === null) return null; return like(String(a), String(b)) !== e.neg; }; }
      case 'cmp': {
        const f = c(e.l), g = c(e.r), op = e.op;
        return (r) => {
          const a = f(r), b = g(r);
          if (a === null || b === null) return null;
          const d = compare(a, b, e.pos);
          return op === '=' ? d === 0 : op === '<>' ? d !== 0 : op === '<' ? d < 0 : op === '>' ? d > 0 : op === '<=' ? d <= 0 : d >= 0;
        };
      }
      case 'arith': {
        const f = c(e.l), g = c(e.r), op = e.op;
        return (r) => {
          let a = f(r), b = g(r);
          if (a === null || b === null) return null;
          if (numLike(a)) a = Number(a);
          if (numLike(b)) b = Number(b);
          if (typeof a !== 'number' || typeof b !== 'number') failc('42883', 'arithmetic ' + op + ' needs numbers, not ' + litText(a) + ' and ' + litText(b), e.pos);
          if ((op === '/' || op === '%') && b === 0) failc('22012', 'division by zero', e.pos);
          const v = op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : op === '/' ? a / b : a % b;
          // decimal inputs: drop the binary floating point noise (110300 * 1.1 is 121330, not 121330.00000000001)
          return Number.isFinite(v) ? Number(v.toPrecision(15)) : v;
        };
      }
      case 'neg': { const f = c(e.e); return (r) => { const v = f(r); return v === null ? null : -v; }; }
      case 'fn': {
        const fs = e.args.map(c);
        const strict = (fn) => (r) => { const v = fs.map((f) => f(r)); return v.some((x) => x === null) ? null : fn(...v); };
        switch (e.name) {
          case 'upper': return strict((s) => String(s).toUpperCase());
          case 'lower': return strict((s) => String(s).toLowerCase());
          case 'length': return strict((s) => String(s).length);
          case 'trim': return strict((s) => String(s).trim());
          case 'abs': return strict((x) => Math.abs(x));
          case 'round': return strict((x, d) => { const m = Math.pow(10, d || 0); return Math.round(x * m) / m; });
          case 'floor': return strict(Math.floor);
          case 'ceil': return strict(Math.ceil);
          case 'mod': return strict((a, b) => a % b);
          case 'substr': case 'substring': return strict((s, a, b) => String(s).substr(a - 1, b === undefined ? undefined : b));
          case 'concat': return e.op === '||' ? strict((a, b) => String(a) + String(b)) : (r) => fs.map((f) => f(r)).filter((x) => x !== null).join('');
          case 'coalesce': return (r) => { for (const f of fs) { const v = f(r); if (v !== null) return v; } return null; };
        }
        failc('42883', 'unknown function ' + e.name, e.pos);
      }
    }
    failc(SYNTAX, 'cannot evaluate this expression', e.pos);
  }

  // ---- the evaluator -------------------------------------------------------------------------------------------------------
  function dedup(rows) {
    const seen = new Set(), out = [];
    for (const r of rows) { const k = rowKey(r); if (!seen.has(k)) { seen.add(k); out.push(r); } }
    return out;
  }
  const truthy = (v) => v === true;

  function aggregate(fn, distinct, vals) {
    let v = vals.filter((x) => x !== null);
    if (distinct) { const seen = new Set(); v = v.filter((x) => { const k = keyOf(x); if (seen.has(k)) return false; seen.add(k); return true; }); }
    switch (fn) {
      case 'count': return v.length;
      case 'sum': return v.length ? v.reduce((a, b) => a + Number(b), 0) : null;
      case 'avg': return v.length ? v.reduce((a, b) => a + Number(b), 0) / v.length : null;
      case 'min': return v.length ? v.reduce((a, b) => (compare(a, b) <= 0 ? a : b)) : null;
      case 'max': return v.length ? v.reduce((a, b) => (compare(a, b) >= 0 ? a : b)) : null;
    }
    failc('42883', 'unknown aggregate ' + fn);
  }

  /**
   * Evaluate a program or expression (text or AST) over a source (see source()).
   * opts: { bag: false, maxRows: 2e6, steps: true }
   * Returns { attrs, cols (display names), rows, steps: [{ id, op, symbol, sub, text, cols, rows, count, children, assign }], program }
   */
  function evaluate(input, src, opts) {
    opts = opts || {};
    const bag = !!opts.bag;
    const maxRows = opts.maxRows || 2e6;
    const prog = typeof input === 'string' ? parse(input) : input.stmts ? input : { stmts: [], result: input };
    const get = source(src);
    const env = new Map();     // variable -> { attrs, rows }
    const steps = [];
    const keepSteps = opts.steps !== false;
    let nextId = 1;
    const set = (rows) => (bag ? rows : dedup(rows));
    const record = (n, attrs, rows, kids, extra) => {
      const id = nextId++;
      if (keepSteps) {
        const tree = n.op === 'rel' || n.op === 'const' ? null : n;
        steps.push(Object.assign({ id, op: n.op, symbol: n.op === 'rel' ? n.name : SYMBOLS.unicode[n.op] || n.op, sub: tree ? subscript(n, 'unicode') : '', text: toText(n), cols: displayNames(attrs), attrs, rows, count: rows.length, children: kids, node: n }, extra || {}));
      }
      return id;
    };
    const guard = (n, count) => { if (count > maxRows) failc('54000', 'the result of ' + (SYMBOLS.unicode[n.op] || n.op) + ' would have ' + count + ' tuples, more than the limit of ' + maxRows, n.oppos !== undefined ? n.oppos : n.pos, { hint: 'Select or project before taking a product.' }); };

    // returns { attrs, rows, id }
    const ev = (n) => {
      switch (n.op) {
        case 'rel': {
          if (env.has(n.name)) { const v = env.get(n.name); const attrs = v.attrs.map((a) => attr(a.name, [n.name])); return { attrs, rows: v.rows, id: record(n, attrs, v.rows, [], { variable: true }) }; }
          const r = get(n.name);
          if (!r) failc('42P01', 'relation "' + n.name + '" does not exist', n.namePos !== undefined ? n.namePos : n.pos, { hint: 'Assign it first (' + n.name + ' ← ...) or check the spelling.' });
          const attrs = r.attrs.map((a) => attr(a, [n.name]));
          const rows = set(r.rows);
          return { attrs, rows, id: record(n, attrs, rows, []) };
        }
        case 'const': {
          const attrs = n.rows[0].map((_, i) => attr('column' + (i + 1)));
          const rows = set(n.rows.map((r) => r.slice()));
          return { attrs, rows, id: record(n, attrs, rows, []) };
        }
        case 'select': {
          const c = ev(n.child);
          const f = compile(n.cond, c.attrs, 'σ');
          const rows = c.rows.filter((r) => truthy(f(r)));
          return { attrs: c.attrs, rows, id: record(n, c.attrs, rows, [c.id]) };
        }
        case 'project': {
          const c = ev(n.child);
          const attrs = schemaOfItems(n, c.attrs);
          const fs = n.items.map((it) => compile(it.e, c.attrs, 'π'));
          const rows = set(c.rows.map((r) => fs.map((f) => f(r))));
          return { attrs, rows, id: record(n, attrs, rows, [c.id]) };
        }
        case 'rename': {
          const c = ev(n.child);
          let out;
          if (n.map) { out = freshAttrs(c.attrs); for (const m of n.map) out[resolve(out, { parts: [m.from], pos: m.pos }, 'ρ')].name = m.to; }
          else { if (n.attrs && n.attrs.length !== c.attrs.length) failc(SYNTAX, 'ρ[' + n.rel + '(…)] names ' + n.attrs.length + ' attributes but its operand has ' + c.attrs.length, n.pos); out = c.attrs.map((x, i) => attr(n.attrs ? n.attrs[i] : x.name, [n.rel])); }
          return { attrs: out, rows: c.rows, id: record(n, out, c.rows, [c.id]) };
        }
        case 'distinct': {
          const c = ev(n.child);
          const rows = dedup(c.rows);
          return { attrs: c.attrs, rows, id: record(n, c.attrs, rows, [c.id]) };
        }
        case 'sort': {
          const c = ev(n.child);
          const fs = n.keys.map((k) => ({ f: compile(k.e, c.attrs, 'τ'), d: k.dir === 'desc' ? -1 : 1 }));
          const rows = c.rows.slice().sort((a, b) => {
            for (const { f, d } of fs) {
              const x = f(a), y = f(b);
              if (x === null && y === null) continue;
              if (x === null) return d;         // NULLs sort last ascending, first descending, as in SQL
              if (y === null) return -d;
              const r = compare(x, y);
              if (r) return r * d;
            }
            return 0;
          });
          return { attrs: c.attrs, rows, id: record(n, c.attrs, rows, [c.id]), sorted: true };
        }
        case 'group': {
          const c = ev(n.child);
          const gi = n.groups.map((g) => resolve(c.attrs, g, 'γ'));
          const attrs = gi.map((i) => attr(c.attrs[i].name, c.attrs[i].quals.slice())).concat(n.aggs.map((a) => attr(aggName(a))));
          const fs = n.aggs.map((a) => (a.arg ? compile(a.arg, c.attrs, 'γ') : () => 1));
          const groups = new Map();
          for (const r of c.rows) {
            const k = gi.map((i) => keyOf(r[i])).join('\u0001');
            if (!groups.has(k)) groups.set(k, { key: gi.map((i) => r[i]), rows: [] });
            groups.get(k).rows.push(r);
          }
          // without grouping attributes an empty input still gives one tuple (count 0, the others null), as in SQL
          if (!gi.length && !groups.size) groups.set('', { key: [], rows: [] });
          const rows = [];
          for (const g of groups.values()) rows.push(g.key.concat(n.aggs.map((a, j) => aggregate(a.fn, a.distinct, g.rows.map((r) => fs[j](r))))));
          const out = set(rows);
          return { attrs, rows: out, id: record(n, attrs, out, [c.id]) };
        }
        case 'union': case 'minus': case 'intersect': {
          const l = ev(n.left), r = ev(n.right);
          if (l.attrs.length !== r.attrs.length) schemaOf(n, get, env);
          let rows;
          if (n.op === 'union') rows = set(l.rows.concat(r.rows));
          else {
            const counts = new Map();
            for (const x of r.rows) { const k = rowKey(x); counts.set(k, (counts.get(k) || 0) + 1); }
            rows = [];
            for (const x of l.rows) {
              const k = rowKey(x), m = counts.get(k) || 0;
              if (n.op === 'intersect') { if (m > 0) { rows.push(x); if (bag) counts.set(k, m - 1); } }
              else if (m > 0) { if (bag) counts.set(k, m - 1); } else rows.push(x);
            }
            rows = set(rows);
          }
          const attrs = freshAttrs(l.attrs);
          return { attrs, rows, id: record(n, attrs, rows, [l.id, r.id]) };
        }
        case 'product': {
          const l = ev(n.left), r = ev(n.right);
          guard(n, l.rows.length * r.rows.length);
          const attrs = freshAttrs(l.attrs).concat(freshAttrs(r.attrs));
          const rows = [];
          for (const a of l.rows) for (const b of r.rows) rows.push(a.concat(b));
          return { attrs, rows, id: record(n, attrs, rows, [l.id, r.id]) };
        }
        case 'join': case 'ljoin': case 'rjoin': case 'fjoin': case 'semijoin': case 'antijoin': return join(n);
        case 'divide': {
          const l = ev(n.left), r = ev(n.right);
          divCheck(n, l.attrs, r.attrs);
          const out = freshAttrs(l.attrs.filter((a) => !r.attrs.some((b) => b.name === a.name)));
          const outIdx = l.attrs.map((a, i) => (r.attrs.some((b) => b.name === a.name) ? -1 : i)).filter((i) => i >= 0);
          const sIdx = r.attrs.map((b) => l.attrs.findIndex((a) => a.name === b.name));
          const need = new Set(r.rows.map((x) => rowKey(x)));
          const have = new Map();
          for (const x of l.rows) {
            const k = rowKey(outIdx.map((i) => x[i]));
            if (!have.has(k)) have.set(k, { t: outIdx.map((i) => x[i]), s: new Set() });
            have.get(k).s.add(rowKey(sIdx.map((i) => x[i])));
          }
          const rows = [];
          for (const g of have.values()) { let all = true; for (const k of need) if (!g.s.has(k)) { all = false; break; } if (all) rows.push(g.t); }
          return { attrs: out, rows, id: record(n, out, rows, [l.id, r.id]) };
        }
      }
      failc(SYNTAX, 'unknown operator ' + n.op, n.pos);
    };
    const schemaOfItems = (n, attrs) => n.items.map((it) => {
      if (!it.as && it.e.k === 'attr') { const b = attrs[resolve(attrs, it.e, 'π')]; return attr(b.name, b.quals.slice()); }
      return attr(it.as || itemName(it.e));
    });
    const join = (n) => {
      const l = ev(n.left), r = ev(n.right);
      const semi = n.op === 'semijoin' || n.op === 'antijoin';
      let attrs, match, lw = l.attrs.length, rw = r.attrs.length;
      let shape;     // builds the output tuple of a matching pair
      let lpad, rpad;
      if (n.cond) {
        const all = freshAttrs(l.attrs).concat(freshAttrs(r.attrs));
        const f = compile(n.cond, all, 'the join condition');
        attrs = semi ? freshAttrs(l.attrs) : all;
        match = (a, b) => truthy(f(a.concat(b)));
        shape = (a, b) => a.concat(b);
        lpad = (a) => a.concat(new Array(rw).fill(null));
        rpad = (b) => new Array(lw).fill(null).concat(b);
        // equalities between an attribute of each side make a hash join; the whole condition is still checked
        const eqs = [];
        for (const c of n.cond.k === 'and' ? n.cond.items : [n.cond]) {
          if (c.k !== 'cmp' || c.op !== '=' || c.l.k !== 'attr' || c.r.k !== 'attr') continue;
          const i = resolve(all, c.l), j = resolve(all, c.r);
          if (i < lw && j >= lw) eqs.push([i, j - lw]); else if (j < lw && i >= lw) eqs.push([j, i - lw]);
        }
        if (eqs.length) {
          const idx = new Map();
          const key = (row, ks) => ks.map((x) => keyOf(numKey(row[x]))).join('\u0001');
          const lk = eqs.map((e) => e[0]), rk = eqs.map((e) => e[1]);
          for (const b of r.rows) { if (rk.some((x) => b[x] === null)) continue; const k = key(b, rk); if (!idx.has(k)) idx.set(k, []); idx.get(k).push(b); }
          return finish(n, l, r, attrs, semi, (a) => (lk.some((x) => a[x] === null) ? [] : (idx.get(key(a, lk)) || []).filter((b) => match(a, b))), shape, lpad, rpad);
        }
      } else {
        const names = common(l.attrs, r.attrs, n, semi ? (n.op === 'semijoin' ? 'semijoin' : 'antijoin') : 'natural join');
        const li = names.map((nm) => l.attrs.findIndex((a) => a.name === nm)), ri = names.map((nm) => r.attrs.findIndex((a) => a.name === nm));
        const lrest = l.attrs.map((_, i) => i).filter((i) => !li.includes(i)), rrest = r.attrs.map((_, i) => i).filter((i) => !ri.includes(i));
        attrs = semi ? freshAttrs(l.attrs) : names.map((nm, j) => { const a = l.attrs[li[j]], b = r.attrs[ri[j]]; return attr(nm, a.quals.concat(b.quals.filter((q) => !a.quals.includes(q)))); }).concat(lrest.map((i) => attr(l.attrs[i].name, l.attrs[i].quals.slice())), rrest.map((i) => attr(r.attrs[i].name, r.attrs[i].quals.slice())));
        // equality as in a comparison: a NULL on either side matches nothing
        match = (a, b) => li.every((x, j) => a[x] !== null && b[ri[j]] !== null && compare(a[x], b[ri[j]]) === 0);
        shape = (a, b) => li.map((x) => a[x]).concat(lrest.map((i) => a[i]), rrest.map((i) => b[i]));
        lpad = (a) => li.map((x) => a[x]).concat(lrest.map((i) => a[i]), rrest.map(() => null));
        rpad = (b) => ri.map((x) => b[x]).concat(lrest.map(() => null), rrest.map((i) => b[i]));
        // natural joins hash on the shared attributes
        if (names.length) {
          const idx = new Map();
          r.rows.forEach((b, j) => { if (ri.some((x) => b[x] === null)) return; const k = ri.map((x) => keyOf(numKey(b[x]))).join('\u0001'); if (!idx.has(k)) idx.set(k, []); idx.get(k).push(j); });
          const cands = (a) => { if (li.some((x) => a[x] === null)) return []; return idx.get(li.map((x) => keyOf(numKey(a[x]))).join('\u0001')) || []; };
          return finish(n, l, r, attrs, semi, (a) => cands(a).map((j) => r.rows[j]).filter((b) => match(a, b)), shape, lpad, rpad);
        }
      }
      return finish(n, l, r, attrs, semi, (a) => r.rows.filter((b) => match(a, b)), shape, lpad, rpad);
    };
    const numKey = (v) => (numLike(v) ? Number(v) : v);
    const finish = (n, l, r, attrs, semi, matches, shape, lpad, rpad) => {
      const rows = [];
      const rightUsed = new Set();
      for (const a of l.rows) {
        const ms = matches(a);
        if (n.op === 'semijoin') { if (ms.length) rows.push(a); continue; }
        if (n.op === 'antijoin') { if (!ms.length) rows.push(a); continue; }
        for (const b of ms) { rows.push(shape(a, b)); rightUsed.add(b); }
        if (!ms.length && (n.op === 'ljoin' || n.op === 'fjoin')) rows.push(lpad(a));
        if (rows.length > maxRows) guard(n, rows.length);
      }
      if (n.op === 'rjoin' || n.op === 'fjoin') for (const b of r.rows) if (!rightUsed.has(b)) rows.push(rpad(b));
      const out = set(rows);
      return { attrs, rows: out, id: record(n, attrs, out, [l.id, r.id]) };
    };

    for (const st of prog.stmts) {
      const v = ev(st.expr);
      let attrs = v.attrs;
      if (st.attrs) {
        if (st.attrs.length !== attrs.length) failc(SYNTAX, st.name + '(' + st.attrs.join(', ') + ') names ' + st.attrs.length + ' attributes but the expression has ' + attrs.length, st.pos);
        attrs = st.attrs.map((a) => attr(a));
      }
      env.set(st.name, { attrs: attrs.map((a) => attr(a.name, [st.name])), rows: v.rows });
      if (keepSteps) steps.push({ id: nextId++, op: 'assign', symbol: '←', sub: '', assign: st.name, text: st.name + (st.attrs ? '(' + st.attrs.join(', ') + ')' : '') + ' ← ' + toText(st.expr), cols: displayNames(attrs), attrs, rows: v.rows, count: v.rows.length, children: [v.id] });
    }
    let res;
    if (prog.result) res = ev(prog.result);
    else { const last = prog.stmts[prog.stmts.length - 1]; const v = env.get(last.name); res = { attrs: v.attrs, rows: v.rows }; }
    return { attrs: res.attrs, cols: displayNames(res.attrs), rows: res.rows, steps, program: prog };
  }

  // ---- comparing results ------------------------------------------------------------------------------------------------
  const normNum = (v) => (typeof v === 'number' ? Number(v.toPrecision(12)) : numLike(v) ? Number(Number(v).toPrecision(12)) : v);
  /**
   * Compare two results ({ cols, rows }) as sets (or bags with { bag: true }). Columns are matched by name when
   * both have the same names, otherwise by position. Returns { equal, byName, missing: rows, extra: rows }.
   */
  function sameResult(a, b, opts) {
    opts = opts || {};
    const ca = a.cols.map((c) => String(c).split('.').pop()), cb = b.cols.map((c) => String(c).split('.').pop());
    if (ca.length !== cb.length) return { equal: false, reason: 'different number of attributes: ' + ca.length + ' and ' + cb.length, missing: [], extra: [] };
    let perm = ca.map((_, i) => i);
    const byName = !opts.positional && ca.slice().sort().join() === cb.slice().sort().join() && new Set(ca).size === ca.length;
    if (byName) perm = ca.map((c) => cb.indexOf(c));
    const ka = (r) => r.map((v) => keyOf(normNum(v))).join('\u0001');
    const kb = (r) => perm.map((j) => keyOf(normNum(r[j]))).join('\u0001');
    const count = (rows, k) => { const m = new Map(); for (const r of rows) { const x = k(r); m.set(x, (m.get(x) || 0) + 1); } return m; };
    const ma = count(a.rows, ka), mb = count(b.rows, kb);
    const missing = [], extra = [];
    for (const r of b.rows) { const x = kb(r); if (!ma.has(x) || (opts.bag && ma.get(x) < mb.get(x))) { missing.push(perm.map((j) => r[j])); ma.set(x, Infinity); } }
    for (const r of a.rows) { const x = ka(r); if (!mb.has(x) || (opts.bag && mb.get(x) < ma.get(x))) { extra.push(r); mb.set(x, Infinity); } }
    return { equal: !missing.length && !extra.length, byName, missing, extra };
  }

  /** walk every relational node of an expression: fn(node, path) where path is the list of child keys */
  function walk(n, fn, path) {
    path = path || [];
    fn(n, path);
    if (n.child) walk(n.child, fn, path.concat('child'));
    if (n.left) walk(n.left, fn, path.concat('left'));
    if (n.right) walk(n.right, fn, path.concat('right'));
  }
  const clone = (x) => JSON.parse(JSON.stringify(x));

  K.Algebra = Object.assign(K.Algebra || {}, {
    lex, parse, parseExpr, Parser, toText, programText, toTree, scalarText, subscript, litText, nameOut, isIdent,
    evaluate, schemaOf, source, resolve, displayNames, compile, compare, plain, keyOf, rowKey, sameResult, walk, clone, quoteSql,
    attr, qualName, aggName, itemName, SYMBOLS, BIN, UNARY, AGGS, common, numLike,
  });
})(typeof window !== 'undefined' ? window : globalThis);
