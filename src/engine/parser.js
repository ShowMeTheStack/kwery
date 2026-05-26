// The SQL parser: tokens to a syntax tree. Recursive descent, with PostgreSQL's operator precedence.
// Statements: queries (SELECT, VALUES, set operations, WITH), DML (INSERT, UPDATE, DELETE, MERGE), DDL (tables,
// indexes, views, sequences, types, domains, schemas, functions, procedures, triggers, roles), transaction
// control, privileges, EXPLAIN, utility statements. Procedural bodies are parsed by psm.js.
(function (root) {
  'use strict';
  const K = root.K;
  const SYN = K.STATE.syntax;

  class Parser {
    constructor(src) { this.src = src; this.toks = K.lex(src); this.i = 0; }
    get tok() { return this.toks[this.i]; }
    peek(k) { return this.toks[this.i + (k || 0)]; }
    fail(msg, tok) {
      const t = tok || this.tok;
      const near = t.t === 'eof' ? 'end of input' : '"' + this.src.slice(t.pos, t.end) + '"';
      throw K.err(SYN, msg || 'syntax error at or near ' + near, { pos: t.pos });
    }
    isKw(w, k) { const t = this.peek(k); return t.t === 'id' && !t.quoted && t.v === w; }
    isOp(o, k) { const t = this.peek(k); return t.t === 'op' && t.v === o; }
    eatKw(...ws) { for (let k = 0; k < ws.length; k++) if (!this.isKw(ws[k], k)) return false; this.i += ws.length; return true; }
    eatOp(o) { if (this.isOp(o)) { this.i++; return true; } return false; }
    kw(...ws) { for (const w of ws) if (!this.eatKw(w)) this.fail('syntax error at or near ' + (this.tok.t === 'eof' ? 'end of input' : '"' + this.src.slice(this.tok.pos, this.tok.end) + '"') + ': expected ' + w.toUpperCase()); }
    op(o) { if (!this.eatOp(o)) this.fail('syntax error at or near ' + (this.tok.t === 'eof' ? 'end of input' : '"' + this.src.slice(this.tok.pos, this.tok.end) + '"') + ': expected "' + o + '"'); }
    oneOf(...ws) { for (const w of ws) if (this.isKw(w)) { this.i++; return w; } return null; }
    /** a name: an identifier that is not reserved, or any quoted identifier */
    name(what) {
      const t = this.tok;
      if (t.t === 'id' && (t.quoted || !K.RESERVED.has(t.v))) { this.i++; return t.v; }
      this.fail(t.t === 'eof' ? 'syntax error at end of input: expected ' + (what || 'a name') : 'syntax error at or near "' + this.src.slice(t.pos, t.end) + '"' + (t.t === 'id' && K.RESERVED.has(t.v) ? ': ' + t.v.toUpperCase() + ' is a reserved word; write it in double quotes to use it as a name' : ''));
    }
    /** a column label after AS may be any word, even a reserved one */
    label() { const t = this.tok; if (t.t === 'id') { this.i++; return t.v; } return this.name('a column label'); }
    canName(k) { const t = this.peek(k); return t.t === 'id' && (t.quoted || !K.RESERVED.has(t.v)); }
    qname() { const parts = [this.name()]; while (this.isOp('.') && this.peek(1).t === 'id') { this.i++; parts.push(this.label()); } return parts.length === 1 ? { name: parts[0] } : parts.length === 2 ? { schema: parts[0], name: parts[1] } : { catalog: parts[0], schema: parts[1], name: parts[2] }; }
    nameList() { const out = [this.name()]; while (this.eatOp(',')) out.push(this.name()); return out; }
    parenNames() { this.op('('); const n = this.nameList(); this.op(')'); return n; }
    pos() { return this.tok.pos; }

    // ---- statements -------------------------------------------------------------------------------------------
    script() {
      const out = [];
      while (this.tok.t !== 'eof') {
        if (this.eatOp(';')) continue;
        const start = this.tok.pos;
        const s = this.statement();
        s.pos = start;
        s.text = this.src.slice(start, this.tok.t === 'eof' ? this.src.length : this.tok.pos).trim();
        out.push(s);
        if (!this.eatOp(';') && this.tok.t !== 'eof') this.fail();
      }
      return out;
    }
    statement() {
      const t = this.tok;
      if (this.isOp('(')) return this.queryStmt();
      if (t.t !== 'id') this.fail();
      switch (t.v) {
        case 'select': case 'values': case 'with': case 'table': return this.queryStmt();
        case 'insert': return this.insert();
        case 'update': return this.update();
        case 'delete': return this.delete_();
        case 'merge': return this.merge();
        case 'create': return this.create();
        case 'alter': return this.alter();
        case 'drop': return this.drop();
        case 'truncate': return this.truncate();
        case 'begin': case 'start': return this.begin();
        case 'commit': case 'end': if (this.isKw('prepared', 1)) { this.i += 2; const g = this.tok; if (g.t !== 'str') this.fail(); this.i++; return { type: 'commitPrepared', gid: g.v }; } this.i++; this.eatKw('work') || this.eatKw('transaction'); if (this.eatKw('and')) { const no = this.eatKw('no'); this.kw('chain'); return { type: 'commit', chain: !no }; } return { type: 'commit' };
        case 'abort': case 'rollback': return this.rollback();
        case 'savepoint': this.i++; return { type: 'savepoint', name: this.name() };
        case 'release': this.i++; this.eatKw('savepoint'); return { type: 'release', name: this.name() };
        case 'set': return this.set();
        case 'reset': this.i++; return { type: 'reset', name: this.eatKw('all') ? 'all' : this.settingName() };
        case 'show': this.i++; return { type: 'show', name: this.eatKw('all') ? 'all' : this.settingName() };
        case 'explain': return this.explain();
        case 'analyze': case 'analyse': this.i++; this.eatKw('verbose'); return { type: 'analyze', tables: this.canName() ? [this.qname()] : [] };
        case 'vacuum': { this.i++; const o = { type: 'vacuum', full: false, analyze: false }; for (;;) { if (this.eatKw('full')) o.full = true; else if (this.eatKw('analyze')) o.analyze = true; else if (this.eatKw('verbose') || this.eatKw('freeze')) { /* accepted */ } else break; } o.tables = this.canName() ? [this.qname()] : []; return o; }
        case 'checkpoint': this.i++; return { type: 'checkpoint' };
        case 'cluster': { this.i++; this.eatKw('verbose'); const st = { type: 'cluster', table: null, index: null, pos: t.pos }; if (this.canName()) { st.table = this.qname(); if (this.eatKw('using')) st.index = this.name(); } return st; }
        case 'lock': return this.lock();
        case 'grant': return this.grant(true);
        case 'revoke': return this.grant(false);
        case 'comment': return this.comment();
        case 'copy': return this.copy();
        case 'prepare': if (this.isKw('transaction', 1)) { this.i += 2; const g = this.tok; if (g.t !== 'str') this.fail(); this.i++; return { type: 'prepareTx', gid: g.v }; } return this.prepare();
        case 'execute': { this.i++; const name = this.name(); const args = this.eatOp('(') ? this.exprList(')') : []; return { type: 'execute', name, args }; }
        case 'deallocate': this.i++; this.eatKw('prepare'); return { type: 'deallocate', name: this.eatKw('all') ? null : this.name() };
        case 'declare': return this.declareCursor();
        case 'fetch': case 'move': return this.fetch();
        case 'close': this.i++; return { type: 'closeCursor', name: this.eatKw('all') ? null : this.name() };
        case 'call': { this.i++; const name = this.qname(); this.op('('); const args = this.isOp(')') ? [] : this.callArgs(); this.op(')'); return { type: 'call', name, args }; }
        case 'do': { this.i++; let lang = 'plpgsql'; if (this.eatKw('language')) lang = this.name(); const body = this.tok; if (body.t !== 'str') this.fail(); this.i++; if (this.eatKw('language')) lang = this.name(); return { type: 'do', lang, body: body.v, bodyPos: body.pos }; }
        case 'refresh': { this.i++; this.kw('materialized', 'view'); const conc = this.eatKw('concurrently'); const name = this.qname(); let data = true; if (this.eatKw('with')) { data = !this.eatKw('no'); this.kw('data'); } return { type: 'refresh', name, concurrently: conc, data }; }
        case 'listen': case 'notify': case 'unlisten': this.i++; return { type: 'noop', what: t.v, name: this.canName() ? this.name() : null };
        case 'discard': this.i++; return { type: 'discard', what: this.oneOf('all', 'plans', 'sequences', 'temp', 'temporary') };
      }
      this.fail('syntax error at or near "' + this.src.slice(t.pos, t.end) + '"');
    }
    settingName() { const parts = [this.label()]; while (this.eatOp('.')) parts.push(this.label()); let n = parts.join('.'); if (n === 'time' && this.eatKw('zone')) n = 'timezone'; else if (n === 'transaction' && this.eatKw('isolation', 'level')) n = 'transaction_isolation'; return n; }

    // ---- queries ----------------------------------------------------------------------------------------------------
    queryStmt() {
      const q = this.query();
      // SELECT ... INTO new_table (outside procedures) makes a table
      return q;
    }
    query() {
      let w = null;
      if (this.isKw('with')) w = this.withClause();
      if (w && (this.isKw('insert') || this.isKw('update') || this.isKw('delete'))) { const d = this.isKw('insert') ? this.insert() : this.isKw('update') ? this.update() : this.delete_(); d.with = w; return d; }
      let q = this.setExpr();
      if (this.isKw('order')) { this.kw('order', 'by'); q = this.wrapForOrder(q); q.order = this.orderList(); }
      this.limitClause(q);
      if (this.isKw('for')) this.locking(q);
      if (w) { if (q.with) q = { type: 'select', targets: [{ star: true }], from: [{ kind: 'sub', query: q, alias: { name: 'q' } }] }; q.with = w; }
      return q;
    }
    /** ORDER BY and LIMIT bind to the whole set operation, not its last branch */
    wrapForOrder(q) { return q; }
    limitClause(q) {
      for (;;) {
        if (this.eatKw('limit')) { q.limit = this.eatKw('all') ? null : this.expr(); continue; }
        if (this.eatKw('offset')) { q.offset = this.expr(); this.eatKw('row') || this.eatKw('rows'); continue; }
        if (this.eatKw('fetch')) {
          this.oneOf('first', 'next');
          q.limit = this.isKw('row') || this.isKw('rows') ? { k: 'lit', v: 1, type: 'int' } : this.primary();
          this.oneOf('row', 'rows');
          if (this.eatKw('with', 'ties')) q.withTies = true; else this.kw('only');
          continue;
        }
        break;
      }
    }
    locking(q) {
      q.locking = [];
      while (this.eatKw('for')) {
        let mode;
        if (this.eatKw('update')) mode = 'update';
        else if (this.eatKw('no', 'key', 'update')) mode = 'no key update';
        else if (this.eatKw('share')) mode = 'share';
        else if (this.eatKw('key', 'share')) mode = 'key share';
        else if (this.eatKw('read', 'only')) { q.readOnly = true; continue; }
        else this.fail();
        const l = { mode, of: [] };
        if (this.eatKw('of')) l.of = this.nameList();
        if (this.eatKw('nowait')) l.wait = 'nowait'; else if (this.eatKw('skip', 'locked')) l.wait = 'skip';
        q.locking.push(l);
      }
    }
    withClause() {
      this.kw('with');
      const rec = this.eatKw('recursive');
      const ctes = [];
      do {
        const name = this.name();
        const cols = this.isOp('(') ? this.parenNames() : null;
        this.kw('as');
        let mat = null;
        if (this.eatKw('materialized')) mat = true; else if (this.eatKw('not', 'materialized')) mat = false;
        this.op('(');
        const q = this.isKw('insert') ? this.insert() : this.isKw('update') ? this.update() : this.isKw('delete') ? this.delete_() : this.query();
        this.op(')');
        const c = { name, cols, query: q, materialized: mat };
        if (this.isKw('search')) { this.i++; const depth = this.oneOf('depth', 'breadth'); this.kw('first', 'by'); c.search = { depth: depth === 'depth', by: this.nameList() }; this.kw('set'); c.search.set = this.name(); }
        if (this.isKw('cycle')) { this.i++; c.cycle = { cols: this.nameList() }; this.kw('set'); c.cycle.set = this.name(); if (this.eatKw('to')) { c.cycle.to = this.expr(); this.kw('default'); c.cycle.def = this.expr(); } this.kw('using'); c.cycle.using = this.name(); }
        ctes.push(c);
      } while (this.eatOp(','));
      return { recursive: rec, ctes };
    }
    // UNION/EXCEPT bind looser than INTERSECT
    setExpr() {
      let l = this.setTerm();
      for (;;) {
        const op = this.isKw('union') ? 'union' : this.isKw('except') ? 'except' : null;
        if (!op) break;
        const pos = this.pos(); this.i++;
        const all = !!this.eatKw('all'); if (!all) this.eatKw('distinct');
        const r = this.setTerm();
        l = { type: 'setop', op, all, left: l, right: r, pos };
      }
      return l;
    }
    setTerm() {
      let l = this.simpleQuery();
      while (this.isKw('intersect')) {
        const pos = this.pos(); this.i++;
        const all = !!this.eatKw('all'); if (!all) this.eatKw('distinct');
        const r = this.simpleQuery();
        l = { type: 'setop', op: 'intersect', all, left: l, right: r, pos };
      }
      return l;
    }
    simpleQuery() {
      if (this.isOp('(')) {
        this.i++;
        const q = this.query();
        this.op(')');
        q.parens = true;
        return q;
      }
      if (this.isKw('values')) return this.values();
      if (this.isKw('table')) { this.i++; const name = this.qname(); return { type: 'select', targets: [{ star: true }], from: [{ kind: 'table', name }] }; }
      return this.select();
    }
    values() {
      const pos = this.pos();
      this.kw('values');
      const rows = [];
      do { this.op('('); rows.push(this.exprList(')', true)); } while (this.eatOp(','));
      return { type: 'values', rows, pos };
    }
    select() {
      const pos = this.pos();
      this.kw('select');
      const q = { type: 'select', pos, targets: [], from: [] };
      if (this.eatKw('distinct')) { q.distinct = true; if (this.eatKw('on')) { this.op('('); q.distinctOn = this.exprList(')'); } }
      else this.eatKw('all');
      if (!this.isTargetEnd()) {
        do q.targets.push(this.target()); while (this.eatOp(','));
      }
      if (this.eatKw('into')) { q.into = { temp: !!(this.eatKw('temporary') || this.eatKw('temp')), unlogged: this.eatKw('unlogged'), names: [] }; this.eatKw('table'); q.into.name = this.qname(); }
      if (this.eatKw('from')) { do q.from.push(this.fromItem()); while (this.eatOp(',')); }
      if (this.eatKw('where')) q.where = this.expr();
      if (this.eatKw('group', 'by')) { if (this.eatKw('distinct')) q.groupDistinct = true; else this.eatKw('all'); q.groupBy = this.groupList(); }
      if (this.eatKw('having')) q.having = this.expr();
      if (this.eatKw('window')) {
        q.windows = [];
        do { const name = this.name(); this.kw('as'); this.op('('); q.windows.push({ name, spec: this.windowSpec() }); } while (this.eatOp(','));
      }
      return q;
    }
    isTargetEnd() { return this.tok.t === 'eof' || this.isOp(')') || this.isOp(';') || ['from', 'where', 'group', 'having', 'order', 'limit', 'offset', 'union', 'intersect', 'except', 'window', 'into', 'fetch', 'for'].some((w) => this.isKw(w)); }
    target() {
      const pos = this.pos();
      if (this.isOp('*')) { this.i++; return { star: true, pos }; }
      if (this.canName() && this.isOp('.', 1) && this.isOp('*', 2)) { const t = this.name(); this.i += 2; return { star: true, table: t, pos }; }
      if (this.canName() && this.isOp('.', 1) && this.canName(2) && this.isOp('.', 3) && this.isOp('*', 4)) { const s = this.name(); this.i++; const t = this.name(); this.i += 2; return { star: true, schema: s, table: t, pos }; }
      const e = this.expr();
      let alias = null;
      if (this.eatKw('as')) alias = this.label();
      else if (this.tok.t === 'id' && (this.tok.quoted || !K.RESERVED.has(this.tok.v)) && !this.isTargetEnd()) alias = this.name();
      return { expr: e, alias, pos, text: this.src.slice(pos, this.peek(-1).end) };
    }
    groupList() {
      const out = [];
      do {
        if (this.isOp('(') && this.isOp(')', 1)) { this.i += 2; out.push({ k: 'emptyset' }); continue; }
        if (this.eatKw('rollup')) { this.op('('); out.push({ k: 'rollup', items: this.groupItems() }); continue; }
        if (this.eatKw('cube')) { this.op('('); out.push({ k: 'cube', items: this.groupItems() }); continue; }
        if (this.eatKw('grouping', 'sets')) { this.op('('); out.push({ k: 'sets', items: this.groupList_inner() }); this.op(')'); continue; }
        out.push(this.expr());
      } while (this.eatOp(','));
      return out;
    }
    groupList_inner() { const out = []; do { if (this.isOp('(') && this.isOp(')', 1)) { this.i += 2; out.push({ k: 'emptyset' }); } else if (this.eatKw('rollup')) { this.op('('); out.push({ k: 'rollup', items: this.groupItems() }); } else if (this.eatKw('cube')) { this.op('('); out.push({ k: 'cube', items: this.groupItems() }); } else out.push(this.expr()); } while (this.eatOp(',')); return out; }
    /** items of ROLLUP/CUBE: expressions or parenthesised groups of them */
    groupItems() { const out = []; do { out.push(this.expr()); } while (this.eatOp(',')); this.op(')'); return out; }
    orderList() {
      const out = [];
      do {
        const e = this.expr();
        const o = { expr: e, dir: 'asc' };
        if (this.eatKw('asc')) o.dir = 'asc'; else if (this.eatKw('desc')) o.dir = 'desc';
        else if (this.eatKw('using')) { const t = this.tok; this.i++; o.dir = t.v === '>' ? 'desc' : 'asc'; }
        if (this.eatKw('nulls')) { o.nulls = this.oneOf('first', 'last'); if (!o.nulls) this.fail(); }
        out.push(o);
      } while (this.eatOp(','));
      return out;
    }

    // ---- FROM -------------------------------------------------------------------------------------------------------
    fromItem() {
      let l = this.fromPrimary();
      for (;;) {
        const pos = this.pos();
        if (this.eatKw('cross', 'join')) { l = { kind: 'join', jtype: 'cross', left: l, right: this.fromPrimary(), pos }; continue; }
        const natural = this.eatKw('natural');
        let jt = null;
        if (this.eatKw('join') || this.eatKw('inner', 'join')) jt = 'inner';
        else if (this.eatKw('left')) { this.eatKw('outer'); this.kw('join'); jt = 'left'; }
        else if (this.eatKw('right')) { this.eatKw('outer'); this.kw('join'); jt = 'right'; }
        else if (this.eatKw('full')) { this.eatKw('outer'); this.kw('join'); jt = 'full'; }
        else if (natural) this.fail();
        if (!jt) break;
        const r = this.fromPrimary();
        const j = { kind: 'join', jtype: jt, natural, left: l, right: r, pos };
        if (!natural) {
          if (this.eatKw('on')) j.on = this.expr();
          else if (this.eatKw('using')) { j.using = this.parenNames(); if (this.eatKw('as')) j.usingAlias = this.name(); }
          else this.fail('syntax error: ' + jt.toUpperCase() + ' JOIN needs ON or USING');
        }
        l = j;
      }
      return l;
    }
    fromPrimary() {
      const pos = this.pos();
      const lateral = this.eatKw('lateral');
      if (this.isOp('(')) {
        // a subquery, or a parenthesised join
        let k = 1;
        while (this.isOp('(', k)) k++;
        if (this.isKw('select', k) || this.isKw('values', k) || this.isKw('with', k) || this.isKw('table', k)) {
          this.op('('); const q = this.query(); this.op(')');
          const alias = this.alias(true);
          return { kind: 'sub', query: q, alias, lateral, pos };
        }
        this.op('(');
        const j = this.fromItem();
        this.op(')');
        const alias = this.alias(false);
        if (alias) j.alias = alias;
        return j;
      }
      if (this.isKw('rows', 0) && this.isKw('from', 1)) {
        this.i += 2; this.op('(');
        const fns = []; do fns.push(this.expr()); while (this.eatOp(','));
        this.op(')');
        const ord = this.eatKw('with', 'ordinality');
        return { kind: 'func', calls: fns, ordinality: ord, alias: this.alias(false), lateral, pos };
      }
      const only = this.eatKw('only');
      // a function in FROM: generate_series(...), unnest(...), json_each(...)
      if (this.canName() && (this.isOp('(', 1) || (this.isOp('.', 1) && this.canName(2) && this.isOp('(', 3)))) {
        const call = this.primary();
        const ord = this.eatKw('with', 'ordinality');
        const alias = this.alias(false, true);
        return { kind: 'func', calls: [call], ordinality: ord, alias, lateral, pos };
      }
      const name = this.qname();
      if (this.isOp('*')) this.i++; // inheritance marker, accepted
      const t = { kind: 'table', name, only, pos };
      t.alias = this.alias(false);
      if (this.eatKw('tablesample')) { const method = this.name(); this.op('('); const args = this.exprList(')'); t.sample = { method, args }; if (this.eatKw('repeatable')) { this.op('('); t.sample.seed = this.expr(); this.op(')'); } }
      return t;
    }
    /** AS alias (col, ...); for functions the column list may carry types */
    alias(required, withTypes) {
      let name = null;
      if (this.eatKw('as')) name = this.name();
      else if (this.canName() && !['join', 'inner', 'left', 'right', 'full', 'cross', 'natural', 'on', 'using', 'where', 'group', 'order', 'limit', 'having', 'window', 'union', 'except', 'intersect', 'offset', 'fetch', 'for', 'returning', 'set', 'tablesample', 'when', 'then', 'with'].includes(this.tok.v)) name = this.name();
      if (!name) { if (required) return { name: null }; return null; }
      const a = { name };
      if (this.isOp('(')) {
        this.i++;
        a.cols = [];
        if (withTypes) a.types = [];
        do {
          a.cols.push(this.name());
          if (withTypes && !this.isOp(',') && !this.isOp(')')) a.types.push(this.typeName()); else if (withTypes) a.types.push(null);
        } while (this.eatOp(','));
        this.op(')');
      }
      return a;
    }

    // ---- DML ---------------------------------------------------------------------------------------------------
    insert() {
      const pos = this.pos();
      this.kw('insert', 'into');
      const table = this.qname();
      const s = { type: 'insert', table, pos };
      if (this.eatKw('as')) s.alias = this.name();
      if (this.isOp('(') && !this.isKw('select', 1) && !this.isKw('values', 1) && !this.isKw('with', 1)) {
        // a target column may name a field of a composite column: (id, c.r, c.i)
        this.op('(');
        s.cols = []; s.colFields = [];
        do { s.cols.push(this.name()); const f = []; while (this.eatOp('.')) f.push(this.name()); s.colFields.push(f.length ? f : null); } while (this.eatOp(','));
        this.op(')');
        if (!s.colFields.some(Boolean)) delete s.colFields;
      }
      if (this.eatKw('overriding')) { s.overriding = this.oneOf('system', 'user'); this.kw('value'); }
      if (this.eatKw('default', 'values')) s.defaults = true;
      else s.source = this.query();
      if (this.eatKw('on', 'conflict')) {
        const c = {};
        if (this.isOp('(')) { this.i++; c.target = []; do { c.target.push(this.isOp('(') ? (this.i++, this.expr()) : { k: 'col', parts: [this.name()] }); if (this.peek(-1).v === ')' && false) this.i++; } while (this.eatOp(',')); this.op(')'); if (this.eatKw('where')) c.targetWhere = this.expr(); }
        else if (this.eatKw('on', 'constraint')) c.constraint = this.name();
        this.kw('do');
        if (this.eatKw('nothing')) c.action = 'nothing';
        else { this.kw('update', 'set'); c.action = 'update'; c.set = this.setList(); if (this.eatKw('where')) c.where = this.expr(); }
        s.onConflict = c;
      }
      if (this.eatKw('returning')) s.returning = this.returning();
      return s;
    }
    returning() { const out = []; do out.push(this.target()); while (this.eatOp(',')); return out; }
    setList() {
      const out = [];
      do {
        if (this.isOp('(')) {
          const cols = this.parenNames();
          this.op('=');
          const isRow = this.eatKw('row');
          let e;
          if (this.isOp('(') && (this.isKw('select', 1) || this.isKw('with', 1))) { this.op('('); e = { k: 'sub', query: this.query() }; this.op(')'); }
          else { const pos = this.pos(); this.op('('); e = { k: 'row', items: this.exprList(')', true), pos }; if (!isRow && e.items.length === 1) e.plain = true; }
          out.push({ cols, expr: e });
        } else {
          const col = this.name();
          const path = [];
          for (;;) {
            if (this.isOp('.')) { this.i++; path.push({ field: this.label() }); continue; }
            if (this.isOp('[')) { this.i++; const lo = this.expr(); let hi; if (this.eatOp(':')) hi = this.expr(); this.op(']'); path.push({ idx: lo, hi }); continue; }
            break;
          }
          this.op('=');
          const e = this.isKw('default') ? (this.i++, { k: 'default' }) : this.expr();
          out.push({ col, path: path.length ? path : null, expr: e });
        }
      } while (this.eatOp(','));
      return out;
    }
    update() {
      const pos = this.pos();
      this.kw('update');
      const only = this.eatKw('only');
      const table = this.qname();
      const s = { type: 'update', table, only, pos };
      const a = this.alias(false); if (a) s.alias = a.name;
      this.kw('set');
      s.set = this.setList();
      if (this.eatKw('from')) { s.from = []; do s.from.push(this.fromItem()); while (this.eatOp(',')); }
      if (this.eatKw('where')) { if (this.eatKw('current', 'of')) s.currentOf = this.name(); else s.where = this.expr(); }
      if (this.eatKw('returning')) s.returning = this.returning();
      return s;
    }
    delete_() {
      const pos = this.pos();
      this.kw('delete', 'from');
      const only = this.eatKw('only');
      const table = this.qname();
      const s = { type: 'delete', table, only, pos };
      const a = this.alias(false); if (a) s.alias = a.name;
      if (this.eatKw('using')) { s.using = []; do s.using.push(this.fromItem()); while (this.eatOp(',')); }
      if (this.eatKw('where')) { if (this.eatKw('current', 'of')) s.currentOf = this.name(); else s.where = this.expr(); }
      if (this.eatKw('returning')) s.returning = this.returning();
      return s;
    }
    merge() {
      const pos = this.pos();
      this.kw('merge', 'into');
      const target = this.qname();
      const s = { type: 'merge', table: target, pos, whens: [] };
      const a = this.alias(false); if (a) s.alias = a.name;
      this.kw('using');
      s.source = this.fromPrimary();
      this.kw('on');
      s.on = this.expr();
      while (this.eatKw('when')) {
        const w = { matched: !this.eatKw('not') };
        this.kw('matched');
        if (!w.matched && this.eatKw('by')) { w.by = this.oneOf('source', 'target'); }
        if (this.eatKw('and')) w.cond = this.expr();
        this.kw('then');
        if (this.eatKw('update', 'set')) { w.action = 'update'; w.set = this.setList(); }
        else if (this.eatKw('delete')) w.action = 'delete';
        else if (this.eatKw('do', 'nothing')) w.action = 'nothing';
        else if (this.eatKw('insert')) {
          w.action = 'insert';
          if (this.isOp('(')) w.cols = this.parenNames();
          if (this.eatKw('default', 'values')) w.defaults = true;
          else { this.kw('values'); this.op('('); w.values = this.exprList(')', true); }
        } else this.fail();
        s.whens.push(w);
      }
      if (this.eatKw('returning')) s.returning = this.returning();
      return s;
    }

    // ---- DDL ---------------------------------------------------------------------------------------------------
    create() {
      const pos = this.pos();
      this.kw('create');
      const orReplace = this.eatKw('or', 'replace');
      const temp = !!(this.eatKw('temporary') || this.eatKw('temp') || (this.eatKw('local') && (this.eatKw('temporary') || this.eatKw('temp'))) || (this.eatKw('global') && (this.eatKw('temporary') || this.eatKw('temp'))));
      const unlogged = this.eatKw('unlogged');
      if (this.eatKw('table')) return Object.assign(this.createTable(), { temp, unlogged, pos });
      if (this.isKw('unique') || this.isKw('index')) return this.createIndex(pos);
      if (this.eatKw('materialized', 'view')) return this.createView(true, orReplace, pos);
      if (this.eatKw('recursive', 'view')) { const v = this.createView(false, orReplace, pos, true); return v; }
      if (this.eatKw('view')) return Object.assign(this.createView(false, orReplace, pos), { temp });
      if (this.eatKw('sequence')) return this.createSequence(pos, temp);
      if (this.eatKw('schema')) { const ine = this.eatKw('if', 'not', 'exists'); let name = this.canName() ? this.name() : null; let auth = null; if (this.eatKw('authorization')) auth = this.name(); return { type: 'createSchema', name: name || auth, ifNotExists: ine, pos }; }
      if (this.eatKw('type')) return this.createType(pos);
      if (this.eatKw('domain')) return this.createDomain(pos);
      if (this.eatKw('function')) return this.createRoutine('function', orReplace, pos);
      if (this.eatKw('procedure')) return this.createRoutine('procedure', orReplace, pos);
      if (this.isKw('constraint') || this.isKw('trigger')) return this.createTrigger(orReplace, pos);
      if (this.eatKw('role') || this.eatKw('user') || this.eatKw('group')) return this.createRole(pos, this.peek(-1).v === 'user');
      if (this.eatKw('policy')) return this.createPolicy(pos);
      if (this.eatKw('rule')) this.fail('CREATE RULE is not supported: use a trigger');
      if (this.eatKw('extension')) { const ine = this.eatKw('if', 'not', 'exists'); return { type: 'noop', what: 'extension', name: this.name(), ifNotExists: ine }; }
      if (this.eatKw('assertion')) { const name = this.name(); this.kw('check'); this.op('('); const e = this.expr(); this.op(')'); return { type: 'createAssertion', name, check: e, pos }; }
      if (this.eatKw('database')) this.fail('Kwery has one database per workspace; use CREATE SCHEMA to group tables');
      this.fail();
    }
    /** CREATE POLICY name ON table [AS PERMISSIVE|RESTRICTIVE] [FOR cmd] [TO roles] [USING (e)] [WITH CHECK (e)] */
    createPolicy(pos) {
      const st = { type: 'createPolicy', name: this.name(), pos, permissive: true, cmd: 'all', roles: ['public'], using: null, check: null };
      this.kw('on'); st.table = this.qname();
      if (this.eatKw('as')) st.permissive = this.oneOf('permissive', 'restrictive') === 'permissive';
      if (this.eatKw('for')) st.cmd = this.oneOf('all', 'select', 'insert', 'update', 'delete');
      if (this.eatKw('to')) { st.roles = []; do st.roles.push(this.eatKw('public') ? 'public' : this.eatKw('current_user') || this.eatKw('session_user') ? '$current' : this.name()); while (this.eatOp(',')); }
      if (this.eatKw('using')) { this.op('('); st.using = this.expr(); this.op(')'); }
      if (this.eatKw('with', 'check')) { this.op('('); st.check = this.expr(); this.op(')'); }
      return st;
    }
    createTable() {
      const ine = this.eatKw('if', 'not', 'exists');
      const name = this.qname();
      const s = { type: 'createTable', name, ifNotExists: ine, cols: [], constraints: [] };
      if (this.eatKw('of')) { s.ofType = this.qname(); }
      if (this.eatKw('partition', 'of')) { s.partitionOf = this.qname(); s.bound = this.partBound(); return s; }
      if (this.isOp('(')) {
        this.i++;
        if (!this.isOp(')')) {
          do {
            if (this.isKw('constraint') || this.isKw('primary') || this.isKw('unique') || this.isKw('check') || this.isKw('foreign') || this.isKw('exclude')) s.constraints.push(this.tableConstraint());
            else if (this.eatKw('like')) { const like = { name: this.qname(), including: [], excluding: [] }; while (this.isKw('including') || this.isKw('excluding')) { const inc = this.oneOf('including', 'excluding'); (inc === 'including' ? like.including : like.excluding).push(this.label()); } s.like = like; }
            else s.cols.push(this.columnDef());
          } while (this.eatOp(','));
        }
        this.op(')');
      }
      if (this.eatKw('inherits')) s.inherits = (this.op('('), this.qnameList());
      if (this.eatKw('partition', 'by')) { const strategy = this.oneOf('range', 'list', 'hash'); this.op('('); const keys = []; do keys.push(this.expr()); while (this.eatOp(',')); this.op(')'); s.partitionBy = { strategy, keys }; }
      if (this.eatKw('with')) { if (this.isOp('(')) { this.i++; while (!this.isOp(')')) this.i++; this.i++; } else this.kw('oids'); }
      if (this.eatKw('on', 'commit')) { s.onCommit = this.eatKw('drop') ? 'drop' : this.eatKw('delete', 'rows') ? 'delete' : (this.kw('preserve', 'rows'), 'preserve'); }
      if (this.eatKw('as')) {
        s.as = this.query();
        if (this.eatKw('with')) { s.withData = !this.eatKw('no'); this.kw('data'); }
      }
      if (!s.as && !s.partitionOf && !s.ofType && !this.peek(-1)) this.fail();
      return s;
    }
    qnameList() { const out = [this.qname()]; while (this.eatOp(',')) out.push(this.qname()); this.op(')'); return out; }
    partBound() {
      if (this.eatKw('default')) return { def: true };
      this.kw('for', 'values');
      if (this.eatKw('in')) { this.op('('); return { inList: this.exprList(')') }; }
      if (this.eatKw('from')) { this.op('('); const from = this.exprList(')'); this.kw('to'); this.op('('); const to = this.exprList(')'); return { from, to }; }
      if (this.eatKw('with')) { this.op('('); this.kw('modulus'); const m = +this.tok.v; this.i++; this.op(','); this.kw('remainder'); const r = +this.tok.v; this.i++; this.op(')'); return { modulus: m, remainder: r }; }
      this.fail();
    }
    columnDef() {
      const pos = this.pos();
      const name = this.name('a column name');
      const c = { name, pos, constraints: [] };
      c.type = this.typeName();
      for (;;) {
        const cpos = this.pos();
        let cname = null;
        if (this.eatKw('constraint')) cname = this.name();
        if (this.eatKw('not', 'null')) c.constraints.push({ kind: 'notnull', name: cname, pos: cpos });
        else if (this.eatKw('null')) c.constraints.push({ kind: 'null', name: cname, pos: cpos });
        else if (this.eatKw('primary', 'key')) c.constraints.push({ kind: 'primary', name: cname, pos: cpos });
        else if (this.eatKw('unique')) { const k = { kind: 'unique', name: cname, pos: cpos }; if (this.eatKw('nulls')) { k.nullsDistinct = !this.eatKw('not'); this.kw('distinct'); } c.constraints.push(k); }
        else if (this.eatKw('check')) { this.op('('); const tp = this.pos(); const e = this.expr(); const text = this.src.slice(tp, this.tok.pos).trim(); this.op(')'); const k = { kind: 'check', expr: e, name: cname, pos: cpos, text }; if (this.eatKw('no', 'inherit')) k.noInherit = true; c.constraints.push(k); }
        else if (this.eatKw('default')) { const dp = this.pos(); c.default = this.expr(); c.defaultText = this.src.slice(dp, this.tok.pos).trim(); }
        else if (this.eatKw('references')) c.constraints.push(Object.assign({ kind: 'foreign', name: cname, pos: cpos, cols: [name] }, this.referencesTail()));
        else if (this.eatKw('generated')) {
          if (c.identity) c.multiIdentity = true;
          if (this.eatKw('always')) { if (this.eatKw('as', 'identity')) { c.identity = 'always'; this.identityOpts(c); } else { this.kw('as'); this.op('('); const gp = this.pos(); c.generated = this.expr(); c.generatedText = this.src.slice(gp, this.tok.pos).trim(); this.op(')'); this.kw('stored'); } }
          else { this.kw('by', 'default', 'as', 'identity'); c.identity = 'by default'; this.identityOpts(c); }
        }
        else if (this.eatKw('collate')) c.collate = this.name();
        else if (this.isKw('deferrable') || this.isKw('initially') || this.isKw('not') && this.isKw('deferrable', 1)) { const last = c.constraints[c.constraints.length - 1]; this.deferrability(last || {}); }
        else break;
      }
      return c;
    }
    identityOpts(c) { if (this.isOp('(')) { this.i++; c.seqOpts = this.sequenceOpts(true); this.op(')'); } }
    deferrability(k) {
      for (;;) {
        if (this.eatKw('not', 'deferrable')) { if (k.deferred) this.fail('constraint declared INITIALLY DEFERRED must be DEFERRABLE'); k.deferrable = false; k.notDeferrable = true; }
        else if (this.eatKw('deferrable')) k.deferrable = true;
        else if (this.eatKw('initially', 'deferred')) { if (k.notDeferrable) this.fail('constraint declared INITIALLY DEFERRED must be DEFERRABLE'); k.deferred = true; k.deferrable = true; }
        else if (this.eatKw('initially', 'immediate')) k.deferred = false;
        else break;
      }
    }
    referencesTail() {
      const r = { refTable: this.qname(), refCols: null, onDelete: 'no action', onUpdate: 'no action', match: 'simple' };
      if (this.isOp('(')) r.refCols = this.parenNames();
      for (;;) {
        if (this.eatKw('match')) { r.match = this.oneOf('full', 'partial', 'simple'); continue; }
        if (this.eatKw('on', 'delete')) { r.onDelete = this.refAction(); if (this.isOp('(') && /^set /.test(r.onDelete)) r.setCols = this.parenNames(); continue; }
        if (this.eatKw('on', 'update')) { r.onUpdate = this.refAction(); if (this.isOp('(') && /^set /.test(r.onUpdate)) throw K.err(K.STATE.featureNotSupported, 'a column list with ' + r.onUpdate.toUpperCase() + ' is only supported for ON DELETE actions', { pos: this.tok.pos }); continue; }
        if (this.isKw('deferrable') || this.isKw('initially') || (this.isKw('not') && this.isKw('deferrable', 1))) { this.deferrability(r); continue; }
        break;
      }
      return r;
    }
    refAction() {
      if (this.eatKw('cascade')) return 'cascade';
      if (this.eatKw('restrict')) return 'restrict';
      if (this.eatKw('no', 'action')) return 'no action';
      if (this.eatKw('set', 'null')) return 'set null';
      if (this.eatKw('set', 'default')) return 'set default';
      this.fail();
    }
    tableConstraint() {
      const pos = this.pos();
      let name = null;
      if (this.eatKw('constraint')) name = this.name();
      let k;
      if (this.eatKw('primary', 'key')) k = { kind: 'primary', cols: this.parenNames() };
      else if (this.eatKw('unique')) { k = { kind: 'unique' }; if (this.eatKw('nulls')) { k.nullsDistinct = !this.eatKw('not'); this.kw('distinct'); } k.cols = this.parenNames(); }
      else if (this.eatKw('check')) { this.op('('); const tp = this.pos(); k = { kind: 'check', expr: this.expr() }; k.text = this.src.slice(tp, this.tok.pos).trim(); this.op(')'); }
      else if (this.eatKw('foreign', 'key')) { const cols = this.parenNames(); this.kw('references'); k = Object.assign({ kind: 'foreign', cols }, this.referencesTail()); }
      else if (this.eatKw('exclude')) { this.eatKw('using') && this.name(); this.op('('); const items = []; do { const e = this.expr(); this.kw('with'); const o = this.tok.v; this.i++; items.push({ expr: e, op: o }); } while (this.eatOp(',')); this.op(')'); k = { kind: 'exclude', items }; if (this.eatKw('where')) { this.op('('); k.where = this.expr(); this.op(')'); } }
      else this.fail();
      if (this.eatKw('include')) k.include = this.parenNames();
      this.deferrability(k);
      k.name = name; k.pos = pos;
      return k;
    }
    createIndex(pos) {
      const unique = this.eatKw('unique');
      this.kw('index');
      const conc = this.eatKw('concurrently');
      const ine = this.eatKw('if', 'not', 'exists');
      const name = this.isKw('on') ? null : this.name();
      this.kw('on');
      const only = this.eatKw('only');
      const table = this.qname();
      let method = 'btree';
      if (this.eatKw('using')) method = this.name();
      this.op('(');
      const cols = [];
      do {
        const c = {};
        if (this.isOp('(')) { this.i++; c.expr = this.expr(); this.op(')'); }
        else if (this.canName() && (this.isOp(',', 1) || this.isOp(')', 1) || this.isKw('asc', 1) || this.isKw('desc', 1) || this.isKw('nulls', 1) || this.isKw('collate', 1) || (this.peek(1).t === 'id' && !this.isOp('(', 1)))) c.col = this.name();
        else c.expr = this.primary();
        if (this.eatKw('collate')) c.collate = this.name();
        if (this.canName() && !['asc', 'desc', 'nulls'].includes(this.tok.v)) c.opclass = this.name();
        if (this.eatKw('asc')) c.dir = 'asc'; else if (this.eatKw('desc')) c.dir = 'desc';
        if (this.eatKw('nulls')) c.nulls = this.oneOf('first', 'last');
        cols.push(c);
      } while (this.eatOp(','));
      this.op(')');
      const s = { type: 'createIndex', name, table, method: K.lower(method), cols, unique, ifNotExists: ine, concurrently: conc, only, pos };
      if (this.eatKw('include')) s.include = this.parenNames();
      if (this.eatKw('nulls')) { s.nullsDistinct = !this.eatKw('not'); this.kw('distinct'); }
      if (this.eatKw('with')) { this.op('('); s.options = {}; do { const k = this.label(); this.op('='); if (this.tok.t === 'id' && !this.isOp('(', 1)) { const w = this.tok.v; this.i++; s.options[k] = { k: 'lit', v: w === 'on' || w === 'true' ? 'true' : w === 'off' || w === 'false' ? 'false' : w, type: 'str' }; } else s.options[k] = this.primary(); } while (this.eatOp(',')); this.op(')'); }
      if (this.eatKw('where')) { const wp = this.pos(); s.where = this.expr(); s.whereText = this.src.slice(wp, this.tok.pos).trim(); }
      return s;
    }
    createView(materialized, orReplace, pos, recursive) {
      const ine = this.eatKw('if', 'not', 'exists');
      const name = this.qname();
      const cols = this.isOp('(') ? this.parenNames() : null;
      if (this.eatKw('with') && this.isOp('(')) { this.i++; while (!this.isOp(')')) this.i++; this.i++; }
      this.kw('as');
      const q = this.query();
      const s = { type: 'createView', name, cols, query: q, materialized, orReplace, ifNotExists: ine, recursive: !!recursive, pos };
      s.queryText = this.src.slice(q.pos !== undefined ? q.pos : pos, this.tok.pos).trim();
      if (this.eatKw('with')) {
        if (materialized) { s.withData = !this.eatKw('no'); this.kw('data'); }
        else { s.check = this.oneOf('cascaded', 'local') || 'cascaded'; this.kw('check', 'option'); }
      }
      return s;
    }
    createSequence(pos, temp) {
      const ine = this.eatKw('if', 'not', 'exists');
      const name = this.qname();
      return { type: 'createSequence', name, ifNotExists: ine, temp, opts: this.sequenceOpts(), pos };
    }
    sequenceOpts(inParens) {
      const o = {};
      for (;;) {
        if (this.eatKw('as')) { o.as = this.typeName(); continue; }
        if (this.eatKw('increment')) { this.eatKw('by'); o.increment = this.signedInt(); continue; }
        if (this.eatKw('minvalue')) { o.min = this.signedInt(); continue; }
        if (this.eatKw('maxvalue')) { o.max = this.signedInt(); continue; }
        if (this.eatKw('no', 'minvalue')) { o.min = null; continue; }
        if (this.eatKw('no', 'maxvalue')) { o.max = null; continue; }
        if (this.eatKw('start')) { this.eatKw('with'); o.start = this.signedInt(); continue; }
        if (this.eatKw('restart')) { this.eatKw('with'); o.restart = this.tok.t === 'int' || this.isOp('-') ? this.signedInt() : true; continue; }
        if (this.eatKw('cache')) { o.cache = this.signedInt(); continue; }
        if (this.eatKw('no', 'cycle')) { o.cycle = false; continue; }
        if (this.eatKw('cycle')) { o.cycle = true; continue; }
        if (this.eatKw('owned', 'by')) { o.ownedBy = this.eatKw('none') ? null : this.qname(); continue; }
        break;
      }
      return o;
    }
    signedInt() { const neg = this.eatOp('-'); this.eatOp('+'); const t = this.tok; if (t.t !== 'int') this.fail(); this.i++; const v = BigInt(t.v); return neg ? -v : v; }
    createType(pos) {
      const name = this.qname();
      this.kw('as');
      if (this.eatKw('enum')) { this.op('('); const labels = []; if (!this.isOp(')')) do { const t = this.tok; if (t.t !== 'str') this.fail(); this.i++; labels.push(t.v); } while (this.eatOp(',')); this.op(')'); return { type: 'createType', name, kind: 'enum', labels, pos }; }
      if (this.eatKw('range')) { this.op('('); this.kw('subtype'); this.op('='); const sub = this.typeName(); while (!this.isOp(')')) this.i++; this.op(')'); return { type: 'createType', name, kind: 'range', subtype: sub, pos }; }
      this.op('(');
      const fields = [];
      if (!this.isOp(')')) do { const n = this.name(); fields.push({ name: n, type: this.typeName() }); } while (this.eatOp(','));
      this.op(')');
      return { type: 'createType', name, kind: 'composite', fields, pos };
    }
    createDomain(pos) {
      const name = this.qname();
      this.eatKw('as');
      const base = this.typeName();
      const s = { type: 'createDomain', name, base, checks: [], notNull: false, pos };
      for (;;) {
        let cname = null;
        if (this.eatKw('constraint')) cname = this.name();
        if (this.eatKw('default')) { const dp = this.pos(); s.default = this.expr(); s.defaultText = this.src.slice(dp, this.tok.pos).trim(); continue; }
        if (this.eatKw('not', 'null')) { s.notNull = true; continue; }
        if (this.eatKw('null')) continue;
        if (this.eatKw('check')) { this.op('('); const tp = this.pos(); const e = this.expr(); s.checks.push({ name: cname, expr: e, text: this.src.slice(tp, this.tok.pos).trim() }); this.op(')'); continue; }
        if (this.eatKw('collate')) { this.name(); continue; }
        break;
      }
      return s;
    }
    createRoutine(kind, orReplace, pos) {
      const name = this.qname();
      this.op('(');
      const params = [];
      if (!this.isOp(')')) {
        do {
          const p = { mode: 'in' };
          const m = this.oneOf('in', 'out', 'inout', 'variadic');
          if (m) p.mode = m;
          // name type, or just type
          if (this.canName() && !this.isOp(',', 1) && !this.isOp(')', 1) && !this.isOp('=', 1) && !this.isKw('default', 1) && !(this.isOp('(', 1)) && !this.isOp('[', 1) && !this.isOp('.', 1) && !(this.peek(1).t === 'id' && ['precision', 'varying', 'with', 'without', 'zone'].includes(this.peek(1).v))) p.name = this.name();
          p.type = this.typeName();
          if (this.eatKw('default') || this.eatOp('=')) p.default = this.expr();
          params.push(p);
        } while (this.eatOp(','));
      }
      this.op(')');
      const s = { type: 'createRoutine', kind, name, params, orReplace, pos, lang: 'sql', volatility: 'volatile', strict: false };
      for (;;) {
        if (this.eatKw('returns')) {
          if (this.eatKw('table')) { this.op('('); s.returnsTable = []; do { const n = this.name(); s.returnsTable.push({ name: n, type: this.typeName() }); } while (this.eatOp(',')); this.op(')'); }
          else { if (this.eatKw('setof')) s.setof = true; s.returns = this.typeName(); }
          continue;
        }
        if (this.eatKw('language')) { s.lang = K.lower(this.label()); continue; }
        if (this.eatKw('as')) { const t = this.tok; if (t.t !== 'str') this.fail(); this.i++; s.body = t.v; s.bodyPos = t.pos + (t.dollar ? this.src.slice(t.pos).indexOf('$', 1) + 1 : 1); if (this.eatOp(',')) { this.i++; } continue; }
        if (this.isKw('begin') && s.body === undefined) {
          // BEGIN ATOMIC ... END (SQL standard body), or a SQL/PSM BEGIN ... END block; END IF, END WHILE ... close inner statements
          const atomic = this.eatKw('begin', 'atomic');
          if (!atomic) this.i++;
          const start = this.peek(-1).end; let depth = 1;
          while (this.tok.t !== 'eof' && depth) { if (this.isKw('end') && ['if', 'while', 'for', 'repeat', 'loop'].some((w) => this.isKw(w, 1))) { this.i += 2; continue; } if (this.isKw('begin') || this.isKw('case')) depth++; if (this.isKw('end')) depth--; if (depth) this.i++; }
          const end = this.tok.pos; this.kw('end'); s.body = this.src.slice(start, end); s.bodyPos = start; s.atomic = true; if (!atomic) s.psmBody = true; continue;
        }
        if (this.eatKw('return') && kind === 'function') { const e = this.expr(); s.body = 'select ' + this.src.slice(e.pos === undefined ? 0 : e.pos, this.tok.pos); s.returnExpr = e; continue; }
        const v = this.oneOf('immutable', 'stable', 'volatile'); if (v) { s.volatility = v; continue; }
        if (this.eatKw('strict') || this.eatKw('returns', 'null', 'on', 'null', 'input')) { s.strict = true; continue; }
        if (this.eatKw('called', 'on', 'null', 'input')) continue;
        if (this.eatKw('security')) { s.security = this.oneOf('definer', 'invoker'); continue; }
        if (this.eatKw('parallel')) { this.name(); continue; }
        if (this.eatKw('leakproof') || this.eatKw('not', 'leakproof')) continue;
        if (this.eatKw('cost') || this.eatKw('rows')) { this.i++; continue; }
        if (this.eatKw('set')) { this.settingName(); if (!this.eatKw('to')) this.op('='); this.expr(); continue; }
        break;
      }
      if (s.body === undefined) this.fail('a function needs a body: AS $$ ... $$');
      return s;
    }
    createTrigger(orReplace, pos) {
      const constraint = this.eatKw('constraint');
      this.kw('trigger');
      const name = this.name();
      let timing;
      if (this.eatKw('before')) timing = 'before'; else if (this.eatKw('after')) timing = 'after'; else { this.kw('instead', 'of'); timing = 'instead of'; }
      const events = [];
      do {
        const e = this.oneOf('insert', 'update', 'delete', 'truncate');
        if (!e) this.fail();
        const ev = { event: e };
        if (e === 'update' && this.eatKw('of')) ev.cols = this.nameList();
        events.push(ev);
      } while (this.eatKw('or'));
      this.kw('on');
      const table = this.qname();
      const s = { type: 'createTrigger', name, timing, events, table, orReplace, constraint, forEach: 'statement', pos };
      if (this.eatKw('from')) this.qname();
      this.deferrability(s);
      if (this.eatKw('referencing')) {
        s.referencing = {};
        while (this.isKw('old') || this.isKw('new')) { const which = this.oneOf('old', 'new'); this.kw('table'); this.eatKw('as'); s.referencing[which] = this.name(); }
      }
      if (this.eatKw('for')) { this.eatKw('each'); s.forEach = this.oneOf('row', 'statement'); }
      if (this.eatKw('when')) { this.op('('); s.when = this.expr(); this.op(')'); }
      this.kw('execute');
      if (!this.eatKw('function')) this.kw('procedure');
      s.func = this.qname();
      this.op('(');
      s.args = this.isOp(')') ? [] : this.exprList(')');
      if (!s.args.length && this.peek(-1).v === ')') { /* consumed */ } else if (!this.peek(-1) || this.peek(-1).v !== ')') this.op(')');
      return s;
    }
    createRole(pos, isUser) {
      const name = this.name();
      const s = { type: 'createRole', name, login: isUser, ifNotExists: false, pos, opts: {} };
      this.eatKw('with');
      for (;;) {
        if (this.eatKw('login')) s.login = true; else if (this.eatKw('nologin')) s.login = false;
        else if (this.eatKw('superuser')) s.opts.superuser = true; else if (this.eatKw('nosuperuser')) s.opts.superuser = false;
        else if (this.eatKw('createdb') || this.eatKw('nocreatedb') || this.eatKw('createrole') || this.eatKw('nocreaterole') || this.eatKw('inherit') || this.eatKw('noinherit')) { /* accepted */ }
        else if (this.eatKw('password')) { if (this.tok.t === 'str' || this.isKw('null')) this.i++; }
        else if (this.eatKw('in', 'role') || this.eatKw('in', 'group')) s.inRole = this.nameList();
        else break;
      }
      return s;
    }
    alter() {
      const pos = this.pos();
      this.kw('alter');
      if (this.eatKw('table')) {
        const ie = this.eatKw('if', 'exists');
        const only = this.eatKw('only');
        const name = this.qname();
        if (this.eatKw('rename')) {
          if (this.eatKw('to')) return { type: 'alterTable', name, ifExists: ie, actions: [{ a: 'renameTable', to: this.name() }], pos };
          if (this.eatKw('constraint')) { const from = this.name(); this.kw('to'); return { type: 'alterTable', name, ifExists: ie, actions: [{ a: 'renameConstraint', from, to: this.name() }], pos }; }
          this.eatKw('column');
          const from = this.name(); this.kw('to');
          return { type: 'alterTable', name, ifExists: ie, actions: [{ a: 'renameColumn', from, to: this.name() }], pos };
        }
        if (this.eatKw('set', 'schema')) return { type: 'alterTable', name, ifExists: ie, actions: [{ a: 'setSchema', schema: this.name() }], pos };
        if (this.eatKw('attach', 'partition')) { const part = this.qname(); return { type: 'alterTable', name, actions: [{ a: 'attachPartition', part, bound: this.partBound() }], pos }; }
        if (this.eatKw('detach', 'partition')) return { type: 'alterTable', name, actions: [{ a: 'detachPartition', part: this.qname() }], pos };
        const actions = [];
        do actions.push(this.alterAction()); while (this.eatOp(','));
        return { type: 'alterTable', name, only, ifExists: ie, actions, pos };
      }
      if (this.eatKw('sequence')) { const ie = this.eatKw('if', 'exists'); const name = this.qname(); if (this.eatKw('rename', 'to')) return { type: 'rename', kind: 'sequence', name, to: this.name() }; return { type: 'alterSequence', name, ifExists: ie, opts: this.sequenceOpts(), pos }; }
      if (this.eatKw('index')) { const ie = this.eatKw('if', 'exists'); const name = this.qname(); this.kw('rename', 'to'); return { type: 'rename', kind: 'index', name, to: this.name(), ifExists: ie, pos }; }
      if (this.eatKw('view') || this.eatKw('materialized', 'view')) { const ie = this.eatKw('if', 'exists'); const name = this.qname(); if (this.eatKw('rename', 'to')) return { type: 'rename', kind: 'view', name, to: this.name(), ifExists: ie, pos }; if (this.eatKw('rename', 'column')) { const from = this.name(); this.kw('to'); return { type: 'alterTable', name, actions: [{ a: 'renameColumn', from, to: this.name() }], pos }; } this.fail(); }
      if (this.eatKw('type')) {
        const name = this.qname();
        if (this.eatKw('add', 'value')) { const ine = this.eatKw('if', 'not', 'exists'); const v = this.tok; this.i++; const s = { type: 'alterType', name, a: 'addValue', value: v.v, ifNotExists: ine, pos }; if (this.eatKw('before')) { s.before = this.tok.v; this.i++; } else if (this.eatKw('after')) { s.after = this.tok.v; this.i++; } return s; }
        if (this.eatKw('rename', 'value')) { const from = this.tok.v; this.i++; this.kw('to'); const to = this.tok.v; this.i++; return { type: 'alterType', name, a: 'renameValue', from, to, pos }; }
        if (this.eatKw('rename', 'to')) return { type: 'rename', kind: 'type', name, to: this.name(), pos };
        if (this.eatKw('add', 'attribute')) { const n = this.name(); return { type: 'alterType', name, a: 'addAttribute', field: { name: n, type: this.typeName() }, pos }; }
        this.fail();
      }
      if (this.eatKw('domain')) { const name = this.qname(); const s = { type: 'alterDomain', name, pos }; if (this.eatKw('set', 'not', 'null')) s.a = 'setNotNull'; else if (this.eatKw('drop', 'not', 'null')) s.a = 'dropNotNull'; else if (this.eatKw('add')) { let cn = null; if (this.eatKw('constraint')) cn = this.name(); this.kw('check'); this.op('('); s.a = 'addCheck'; s.check = { name: cn, expr: this.expr() }; this.op(')'); } else if (this.eatKw('drop', 'constraint')) { s.a = 'dropConstraint'; s.cname = this.name(); } else if (this.eatKw('set', 'default')) { s.a = 'setDefault'; s.expr = this.expr(); } else if (this.eatKw('drop', 'default')) s.a = 'dropDefault'; else this.fail(); return s; }
      if (this.eatKw('schema')) { const name = this.name(); this.kw('rename', 'to'); return { type: 'rename', kind: 'schema', name: { name }, to: this.name(), pos }; }
      if (this.eatKw('function') || this.eatKw('procedure')) { const name = this.qname(); if (this.isOp('(')) { this.i++; let d = 1; while (d) { if (this.isOp('(')) d++; if (this.isOp(')')) d--; this.i++; } } this.kw('rename', 'to'); return { type: 'rename', kind: 'function', name, to: this.name(), pos }; }
      if (this.eatKw('role') || this.eatKw('user')) { const name = this.name(); const s = { type: 'alterRole', name, pos, opts: {} }; this.eatKw('with'); if (this.eatKw('rename', 'to')) s.rename = this.name(); else while (this.tok.t === 'id') { s.opts[this.tok.v] = true; this.i++; if (this.tok.t === 'str') this.i++; } return s; }
      if (this.eatKw('trigger')) { const name = this.name(); this.kw('on'); const table = this.qname(); this.kw('rename', 'to'); return { type: 'rename', kind: 'trigger', name: { name }, table, to: this.name(), pos }; }
      if (this.eatKw('default', 'privileges')) { while (this.tok.t !== 'eof' && !this.isOp(';')) this.i++; return { type: 'noop', what: 'default privileges' }; }
      this.fail();
    }
    alterAction() {
      if (this.eatKw('add')) {
        if (this.isKw('constraint') || this.isKw('primary') || this.isKw('unique') || this.isKw('check') || this.isKw('foreign') || this.isKw('exclude')) { const k = this.tableConstraint(); if (this.eatKw('not', 'valid')) k.notValid = true; return { a: 'addConstraint', constraint: k }; }
        this.eatKw('column');
        const ine = this.eatKw('if', 'not', 'exists');
        return { a: 'addColumn', col: this.columnDef(), ifNotExists: ine };
      }
      if (this.eatKw('drop')) {
        if (this.eatKw('constraint')) { const ie = this.eatKw('if', 'exists'); const name = this.name(); return { a: 'dropConstraint', name, ifExists: ie, cascade: this.dropBehavior() }; }
        this.eatKw('column');
        const ie = this.eatKw('if', 'exists');
        const name = this.name();
        return { a: 'dropColumn', name, ifExists: ie, cascade: this.dropBehavior() };
      }
      if (this.eatKw('alter')) {
        this.eatKw('column');
        const col = this.name();
        if (this.eatKw('set', 'data', 'type') || this.eatKw('type')) { const type = this.typeName(); let using = null; if (this.eatKw('using')) using = this.expr(); return { a: 'alterType', col, type, using }; }
        if (this.eatKw('set', 'default')) { const dp = this.pos(); const expr = this.expr(); return { a: 'setDefault', col, expr, text: this.src.slice(dp, this.tok.pos).trim() }; }
        if (this.eatKw('drop', 'default')) return { a: 'dropDefault', col };
        if (this.eatKw('set', 'not', 'null')) return { a: 'setNotNull', col };
        if (this.eatKw('drop', 'not', 'null')) return { a: 'dropNotNull', col };
        if (this.eatKw('add', 'generated')) { const how = this.eatKw('always') ? 'always' : (this.kw('by', 'default'), 'by default'); this.kw('as', 'identity'); const c = {}; this.identityOpts(c); return { a: 'addIdentity', col, how, seqOpts: c.seqOpts }; }
        if (this.eatKw('drop', 'identity')) { this.eatKw('if', 'exists'); return { a: 'dropIdentity', col }; }
        if (this.eatKw('restart')) { this.eatKw('with'); return { a: 'restartIdentity', col, restart: this.tok.t === 'int' || this.isOp('-') ? this.signedInt() : true }; }
        if (this.isKw('set') && (this.isKw('generated', 1) || this.isKw('increment', 1))) { this.i++; if (this.eatKw('generated')) { const how = this.eatKw('always') ? 'always' : (this.kw('by', 'default'), 'by default'); return { a: 'setIdentity', col, how }; } return { a: 'setIdentity', col, seqOpts: this.sequenceOpts() }; }
        if (this.eatKw('set', 'statistics')) { this.signedInt(); return { a: 'noop' }; }
        if (this.eatKw('set', 'storage')) { this.name(); return { a: 'noop' }; }
        this.fail();
      }
      if (this.eatKw('owner', 'to')) { this.name(); return { a: 'noop' }; }
      if (this.eatKw('enable') || this.eatKw('disable')) { const en = this.peek(-1).v === 'enable'; if (this.eatKw('trigger')) { const t = this.eatKw('all') ? 'all' : this.eatKw('user') ? 'user' : this.name(); return { a: 'enableTrigger', name: t, enable: en }; } if (this.eatKw('row', 'level', 'security')) return { a: 'rls', enable: en }; this.fail(); }
      if (this.eatKw('force', 'row', 'level', 'security')) return { a: 'rls', force: true };
      if (this.eatKw('no', 'force', 'row', 'level', 'security')) return { a: 'rls', force: false };
      if (this.eatKw('validate', 'constraint')) return { a: 'validateConstraint', name: this.name() };
      if (this.eatKw('set')) { if (this.eatKw('logged') || this.eatKw('unlogged') || this.eatKw('without', 'oids')) return { a: 'noop' }; if (this.eatKw('without', 'cluster')) return { a: 'clusterOn', index: null }; if (this.isOp('(')) { this.i++; while (!this.isOp(')')) this.i++; this.i++; return { a: 'noop' }; } }
      if (this.eatKw('cluster', 'on')) return { a: 'clusterOn', index: this.name() };
      this.fail();
    }
    dropBehavior() { if (this.eatKw('cascade')) return true; this.eatKw('restrict'); return false; }
    drop() {
      const pos = this.pos();
      this.kw('drop');
      let kind = null;
      for (const k of [['materialized', 'view'], ['table'], ['view'], ['index'], ['sequence'], ['schema'], ['type'], ['domain'], ['function'], ['procedure'], ['trigger'], ['role'], ['user'], ['group'], ['extension'], ['owned'], ['assertion'], ['rule'], ['policy']]) {
        if (this.eatKw(...k)) { kind = k.join(' '); break; }
      }
      if (!kind) this.fail();
      if (kind === 'materialized view') kind = 'matview';
      if (kind === 'user' || kind === 'group') kind = 'role';
      if (kind === 'owned') { this.kw('by'); this.nameList(); this.dropBehavior(); return { type: 'noop', what: 'drop owned', tag: 'DROP OWNED' }; }
      const conc = this.eatKw('concurrently');
      const ie = this.eatKw('if', 'exists');
      const names = [];
      let table = null;
      if (kind === 'trigger' || kind === 'policy') { names.push({ name: this.name() }); this.kw('on'); table = this.qname(); }
      else if (kind === 'role' || kind === 'extension') { do names.push({ name: this.name() }); while (this.eatOp(',')); }
      else do {
        const n = this.qname();
        if ((kind === 'function' || kind === 'procedure') && this.isOp('(')) { this.i++; n.argTypes = []; if (!this.isOp(')')) do { this.oneOf('in', 'out', 'inout', 'variadic'); if (this.canName() && !this.isOp(',', 1) && !this.isOp(')', 1) && this.peek(1).t === 'id' && !['precision', 'varying'].includes(this.peek(1).v)) this.name(); n.argTypes.push(this.typeName()); } while (this.eatOp(',')); this.op(')'); }
        names.push(n);
      } while (this.eatOp(','));
      return { type: 'drop', kind, names, table, ifExists: ie, cascade: this.dropBehavior(), concurrently: conc, pos };
    }
    truncate() {
      const pos = this.pos();
      this.kw('truncate');
      this.eatKw('table');
      const names = [];
      do { this.eatKw('only'); names.push(this.qname()); } while (this.eatOp(','));
      let restart = false;
      if (this.eatKw('restart', 'identity')) restart = true; else this.eatKw('continue', 'identity');
      return { type: 'truncate', names, restart, cascade: this.dropBehavior(), pos };
    }

    // ---- transactions and the rest -----------------------------------------------------------------------------------
    txnModes() {
      const m = {};
      do {
        if (this.eatKw('isolation', 'level')) {
          if (this.eatKw('serializable')) m.isolation = 'serializable';
          else if (this.eatKw('repeatable', 'read')) m.isolation = 'repeatable read';
          else if (this.eatKw('read', 'committed')) m.isolation = 'read committed';
          else if (this.eatKw('read', 'uncommitted')) m.isolation = 'read uncommitted';
          else this.fail();
        } else if (this.eatKw('read', 'only')) m.readOnly = true;
        else if (this.eatKw('read', 'write')) m.readOnly = false;
        else if (this.eatKw('deferrable')) m.deferrable = true;
        else if (this.eatKw('not', 'deferrable')) m.deferrable = false;
        else break;
      } while (this.eatOp(',') || this.tok.t === 'id' && ['isolation', 'read', 'deferrable', 'not'].includes(this.tok.v));
      return m;
    }
    begin() {
      if (this.eatKw('start')) this.kw('transaction'); else { this.kw('begin'); this.eatKw('work') || this.eatKw('transaction'); }
      return { type: 'begin', modes: this.txnModes() };
    }
    rollback() {
      if (this.isKw('prepared', 1)) { this.i += 2; const g = this.tok; if (g.t !== 'str') this.fail(); this.i++; return { type: 'rollbackPrepared', gid: g.v }; }
      this.i++;
      this.eatKw('work') || this.eatKw('transaction');
      if (this.eatKw('to')) { this.eatKw('savepoint'); return { type: 'rollbackTo', name: this.name() }; }
      if (this.eatKw('and')) { const no = this.eatKw('no'); this.kw('chain'); return { type: 'rollback', chain: !no }; }
      return { type: 'rollback' };
    }
    set() {
      this.kw('set');
      if (this.eatKw('transaction')) { if (this.eatKw('snapshot')) { this.i++; return { type: 'noop' }; } return { type: 'setTransaction', modes: this.txnModes() }; }
      if (this.eatKw('session', 'characteristics', 'as', 'transaction')) return { type: 'setTransaction', session: true, modes: this.txnModes() };
      if (this.eatKw('constraints')) { const names = this.eatKw('all') ? null : this.nameList(); const mode = this.oneOf('deferred', 'immediate'); return { type: 'setConstraints', names, mode }; }
      if (this.eatKw('role')) return { type: 'setRole', name: this.eatKw('none') ? null : this.name() };
      if (this.eatKw('session', 'authorization')) return { type: 'setRole', name: this.eatKw('default') ? null : this.name() };
      const local = this.eatKw('local'); this.eatKw('session');
      const name = this.settingName();
      if (name === 'timezone') { if (!this.eatKw('to')) this.eatOp('='); if (this.eatKw('local') || this.eatKw('default')) return { type: 'set', name, value: null, local }; if (this.eatKw('interval')) { const iv = this.tok.v; this.i++; return { type: 'set', name, value: String(iv), interval: true, local }; } const v = this.tok; this.i++; let val = v.v; if (v.t === 'op' && (v.v === '+' || v.v === '-')) { val = v.v + this.tok.v; this.i++; } return { type: 'set', name, value: String(val), numeric: v.t !== 'str' && v.t !== 'id', local }; }
      if (!this.eatKw('to')) this.op('=');
      if (this.eatKw('default')) return { type: 'set', name, value: null, local };
      const vals = [];
      do { const t = this.tok; if (t.t === 'eof' || this.isOp(';')) break; this.i++; vals.push(t.v); } while (this.eatOp(','));
      return { type: 'set', name, value: vals.join(', '), local };
    }
    explain() {
      this.kw('explain');
      const o = { analyze: false, verbose: false, costs: true, buffers: false, format: 'text' };
      if (this.isOp('(')) {
        this.i++;
        do { const k = this.label(); let v = true; if (this.tok.t === 'id' && !this.isOp(',') && !this.isOp(')')) { const w = this.tok.v; this.i++; v = !['false', 'off', '0'].includes(w) ? (k === 'format' ? w : true) : false; } o[k] = v; } while (this.eatOp(','));
        this.op(')');
      } else {
        if (this.eatKw('analyze') || this.eatKw('analyse')) o.analyze = true;
        if (this.eatKw('verbose')) o.verbose = true;
      }
      const stmt = this.statement();
      return { type: 'explain', opts: o, stmt };
    }
    lock() {
      this.kw('lock');
      this.eatKw('table');
      const names = [];
      do { this.eatKw('only'); names.push(this.qname()); } while (this.eatOp(','));
      let mode = 'access exclusive';
      if (this.eatKw('in')) {
        const words = [];
        while (!this.isKw('mode')) { words.push(this.tok.v); this.i++; }
        this.kw('mode');
        mode = words.join(' ');
      }
      return { type: 'lock', names, mode, nowait: this.eatKw('nowait') };
    }
    grant(isGrant) {
      const pos = this.pos();
      this.i++;
      const s = { type: isGrant ? 'grant' : 'revoke', pos };
      if (!isGrant && this.eatKw('grant', 'option', 'for')) s.grantOptionOnly = true;
      // privileges on objects, or role membership
      const privs = [];
      if (this.eatKw('all')) { this.eatKw('privileges'); privs.push({ priv: 'all' }); }
      else {
        do {
          const t = this.tok;
          if (t.t !== 'id') this.fail();
          this.i++;
          const p = { priv: t.v };
          if (this.isOp('(')) p.cols = this.parenNames();
          privs.push(p);
        } while (this.eatOp(','));
      }
      if (this.eatKw('on')) {
        let kind = 'table';
        if (this.eatKw('all', 'tables', 'in', 'schema')) { kind = 'all tables'; }
        else if (this.eatKw('table')) kind = 'table';
        else if (this.eatKw('sequence')) kind = 'sequence';
        else if (this.eatKw('schema')) kind = 'schema';
        else if (this.eatKw('function') || this.eatKw('procedure') || this.eatKw('routine')) kind = 'function';
        else if (this.eatKw('database')) kind = 'database';
        else if (this.eatKw('type') || this.eatKw('domain')) kind = 'type';
        const objs = [];
        do { const n = this.qname(); if (kind === 'function' && this.isOp('(')) { this.i++; let d = 1; while (d) { if (this.isOp('(')) d++; if (this.isOp(')')) d--; this.i++; } } objs.push(n); } while (this.eatOp(','));
        s.privs = privs; s.kind = kind; s.objects = objs;
        if (isGrant) this.kw('to'); else this.kw('from');
        s.roles = [];
        do { this.eatKw('group'); s.roles.push(this.eatKw('public') ? 'public' : this.name()); } while (this.eatOp(','));
        if (isGrant && this.eatKw('with', 'grant', 'option')) s.grantOption = true;
        if (this.eatKw('granted', 'by')) this.name();
        if (!isGrant) s.cascade = this.dropBehavior();
        return s;
      }
      // GRANT role TO role
      s.kind = 'role';
      s.granted = privs.map((p) => p.priv);
      if (isGrant) this.kw('to'); else this.kw('from');
      s.roles = this.nameList();
      if (isGrant && this.eatKw('with', 'admin', 'option')) s.adminOption = true;
      if (!isGrant) s.cascade = this.dropBehavior();
      return s;
    }
    comment() {
      this.kw('comment', 'on');
      const kind = this.label();
      let name;
      if (kind === 'column') { name = this.qname(); } else name = this.qname();
      this.kw('is');
      const t = this.tok; this.i++;
      return { type: 'comment', kind, name, comment: t.t === 'str' ? t.v : null };
    }
    copy() {
      this.kw('copy');
      const s = { type: 'copy' };
      if (this.isOp('(')) { this.i++; s.query = this.query(); this.op(')'); }
      else { s.table = this.qname(); if (this.isOp('(')) s.cols = this.parenNames(); }
      if (this.eatKw('from')) s.dir = 'from'; else { this.kw('to'); s.dir = 'to'; }
      if (this.eatKw('stdin') || this.eatKw('stdout')) s.target = 'stdio';
      else { const t = this.tok; this.i++; s.target = t.v; }
      this.eatKw('with');
      s.opts = { format: 'text', header: false, delimiter: null, null: null };
      if (this.isOp('(')) {
        this.i++;
        do { const k = this.label(); let v = true; if (this.tok.t === 'str' || (this.tok.t === 'id' && !this.isOp(',') && !this.isOp(')'))) { v = this.tok.v; this.i++; } s.opts[k] = v; } while (this.eatOp(','));
        this.op(')');
      } else {
        for (;;) {
          if (this.eatKw('csv')) s.opts.format = 'csv';
          else if (this.eatKw('header')) s.opts.header = true;
          else if (this.eatKw('delimiter')) { this.eatKw('as'); s.opts.delimiter = this.tok.v; this.i++; }
          else if (this.eatKw('null')) { this.eatKw('as'); s.opts.null = this.tok.v; this.i++; }
          else if (this.eatKw('binary')) s.opts.format = 'binary';
          else break;
        }
      }
      return s;
    }
    prepare() {
      this.kw('prepare');
      const name = this.name();
      let types = null;
      if (this.isOp('(')) { this.i++; types = []; do types.push(this.typeName()); while (this.eatOp(',')); this.op(')'); }
      this.kw('as');
      return { type: 'prepare', name, types, stmt: this.statement() };
    }
    declareCursor() {
      this.kw('declare');
      const name = this.name();
      const s = { type: 'declareCursor', name, scroll: false, hold: false };
      for (;;) {
        if (this.eatKw('binary') || this.eatKw('insensitive') || this.eatKw('asensitive')) continue;
        if (this.eatKw('no', 'scroll')) { s.scroll = false; continue; }
        if (this.eatKw('scroll')) { s.scroll = true; continue; }
        break;
      }
      this.kw('cursor');
      if (this.eatKw('with', 'hold')) s.hold = true; else this.eatKw('without', 'hold');
      this.kw('for');
      s.query = this.query();
      return s;
    }
    fetch() {
      const move = this.tok.v === 'move';
      this.i++;
      const s = { type: 'fetch', move, dir: 'next', count: 1 };
      if (this.eatKw('next')) s.dir = 'next';
      else if (this.eatKw('prior')) s.dir = 'prior';
      else if (this.eatKw('first')) s.dir = 'first';
      else if (this.eatKw('last')) s.dir = 'last';
      else if (this.eatKw('absolute')) { s.dir = 'absolute'; s.count = Number(this.signedInt()); }
      else if (this.eatKw('relative')) { s.dir = 'relative'; s.count = Number(this.signedInt()); }
      else if (this.eatKw('all')) { s.dir = 'forward'; s.count = Infinity; }
      else if (this.eatKw('forward')) { s.dir = 'forward'; s.count = this.eatKw('all') ? Infinity : this.tok.t === 'int' ? Number(this.signedInt()) : 1; }
      else if (this.eatKw('backward')) { s.dir = 'backward'; s.count = this.eatKw('all') ? Infinity : this.tok.t === 'int' ? Number(this.signedInt()) : 1; }
      else if (this.tok.t === 'int' || this.isOp('-')) { s.dir = 'forward'; s.count = Number(this.signedInt()); }
      this.eatKw('from') || this.eatKw('in');
      s.name = this.name();
      return s;
    }

    // ---- types --------------------------------------------------------------------------------------------------------
    typeName() {
      const pos = this.pos();
      let name;
      const t = this.tok;
      if (t.t !== 'id') this.fail('syntax error: expected a type name');
      // multi-word type names
      const two = (a, b) => this.isKw(a) && this.isKw(b, 1);
      if (two('double', 'precision')) { this.i += 2; name = 'double precision'; }
      else if (two('character', 'varying') || two('char', 'varying')) { this.i += 2; name = 'varchar'; }
      else if (two('national', 'character')) { this.i += 2; name = this.eatKw('varying') ? 'varchar' : 'char'; }
      else if (this.isKw('bit') && this.isKw('varying', 1)) { this.i += 2; name = 'varbit'; }
      else if (this.isKw('character') && this.isKw('large', 1) && this.isKw('object', 2)) { this.i += 3; name = 'clob'; }
      else if (this.isKw('binary') && this.isKw('large', 1) && this.isKw('object', 2)) { this.i += 3; name = 'blob'; }
      else {
        this.i++;
        name = t.v;
        if (this.isOp('.') && this.peek(1).t === 'id') { this.i++; name = name + '.' + this.tok.v; this.i++; }
      }
      const mods = [];
      if (this.isOp('(')) {
        this.i++;
        do { const neg = this.eatOp('-'); const m = this.tok; if (m.t !== 'int') this.fail('type modifiers must be integers'); this.i++; mods.push(neg ? -m.v : +m.v); } while (this.eatOp(','));
        this.op(')');
      }
      if ((name === 'time' || name === 'timestamp') && (this.isKw('with') || this.isKw('without'))) {
        const w = this.tok.v; this.i++; this.kw('time', 'zone');
        if (w === 'with') name = name === 'time' ? 'timetz' : 'timestamptz';
      }
      let field;
      if (name === 'interval') { const f = this.oneOf('year', 'month', 'day', 'hour', 'minute', 'second'); field = f; if (f && this.eatKw('to')) field = f + ' to ' + this.oneOf('month', 'hour', 'minute', 'second'); if (this.isOp('(') && /second$/.test(field || '')) { this.i++; mods.push(+this.tok.v); this.i++; this.op(')'); } }
      let dims = 0;
      for (;;) {
        // int[][] and int[3] are all just int[]: PostgreSQL does not enforce declared dimensions
        if (this.isOp('[')) { this.i++; if (this.tok.t === 'int') this.i++; this.op(']'); dims = 1; continue; }
        if (this.eatKw('array')) { if (this.isOp('[')) { this.i++; this.i++; this.op(']'); } dims = 1; continue; }
        break;
      }
      return field ? { name, mods, dims, pos, field } : { name, mods, dims, pos };
    }

    // ---- expressions ----------------------------------------------------------------------------------------------------
    exprList(close, allowDefault) {
      const out = [];
      if (close && this.isOp(close)) { this.i++; return out; }
      do out.push(allowDefault && this.isKw('default') ? (this.i++, { k: 'default' }) : this.expr()); while (this.eatOp(','));
      if (close) this.op(close);
      return out;
    }
    expr() { return this.orExpr(); }
    orExpr() { let l = this.andExpr(); while (this.isKw('or')) { const pos = this.pos(); this.i++; l = { k: 'or', l, r: this.andExpr(), pos }; } return l; }
    andExpr() { let l = this.notExpr(); while (this.isKw('and')) { const pos = this.pos(); this.i++; l = { k: 'and', l, r: this.notExpr(), pos }; } return l; }
    notExpr() { if (this.isKw('not')) { const pos = this.pos(); this.i++; return { k: 'not', e: this.notExpr(), pos }; } return this.isExpr(); }
    isExpr() {
      let l = this.cmpExpr();
      for (;;) {
        const pos = this.pos();
        if (this.isKw('is')) {
          this.i++;
          const neg = this.eatKw('not');
          if (this.eatKw('null')) l = { k: 'isnull', e: l, neg, pos };
          else if (this.eatKw('true')) l = { k: 'istruth', e: l, v: true, neg, pos };
          else if (this.eatKw('false')) l = { k: 'istruth', e: l, v: false, neg, pos };
          else if (this.eatKw('unknown')) l = { k: 'isnull', e: l, neg, pos, unknown: true };
          else if (this.eatKw('distinct', 'from')) l = { k: 'distinct', l, r: this.cmpExpr(), neg, pos };
          else if (this.eatKw('document')) l = { k: 'istruth', e: { k: 'lit', v: true }, v: true, neg, pos };
          else if (this.eatKw('json')) { let what = null; for (const w of ['value', 'array', 'object', 'scalar']) if (this.eatKw(w)) what = w; this.eatKw('with', 'unique', 'keys') || this.eatKw('without', 'unique', 'keys'); l = { k: 'isjson', e: l, what, neg, pos }; }
          else if (this.eatKw('of')) { this.op('('); const types = []; do types.push(this.typeName()); while (this.eatOp(',')); this.op(')'); l = { k: 'isof', e: l, types, neg, pos }; }
          else if (this.isKw('normalized') || this.isKw('nfc')) { this.oneOf('nfc', 'nfd', 'nfkc', 'nfkd'); this.kw('normalized'); l = { k: 'istruth', e: { k: 'lit', v: true }, v: true, neg, pos }; }
          else this.fail();
          continue;
        }
        if (this.eatKw('isnull')) { l = { k: 'isnull', e: l, neg: false, pos }; continue; }
        if (this.eatKw('notnull')) { l = { k: 'isnull', e: l, neg: true, pos }; continue; }
        break;
      }
      return l;
    }
    cmpExpr() {
      let l = this.predExpr();
      for (;;) {
        const t = this.tok;
        if (t.t === 'op' && ['=', '<', '>', '<=', '>=', '<>', '!='].includes(t.v)) {
          this.i++;
          const op = t.v === '!=' ? '<>' : t.v;
          const q = this.oneOf('any', 'some', 'all');
          if (q) {
            l = Object.assign({ k: 'quant', op, e: l, q: q === 'some' ? 'any' : q, pos: t.pos }, this.quantArg());
            continue;
          }
          l = { k: 'op', op, l, r: this.predExpr(), pos: t.pos };
          continue;
        }
        break;
      }
      return l;
    }
    /** the parenthesized right side of op ANY/ALL: a subquery (in any number of parentheses) or an array */
    quantArg() {
      this.op('(');
      let r = null;
      if (this.isKw('select') || this.isKw('with') || this.isKw('values')) r = { query: this.query() };
      else if (this.isOp('(')) { const i = this.i; try { r = { query: this.query() }; if (!this.isOp(')')) r = null; } catch (e) { r = null; } if (!r) this.i = i; }
      if (!r) r = { array: this.expr() };
      this.op(')');
      return r;
    }
    predExpr() {
      let l = this.otherOpExpr();
      for (;;) {
        const pos = this.pos();
        const neg = this.isKw('not') && (this.isKw('in', 1) || this.isKw('like', 1) || this.isKw('ilike', 1) || this.isKw('between', 1) || this.isKw('similar', 1));
        if (neg) this.i++;
        if (this.eatKw('between')) {
          const sym = this.eatKw('symmetric'); if (!sym) this.eatKw('asymmetric');
          const lo = this.otherOpExpr(); this.kw('and'); const hi = this.otherOpExpr();
          l = { k: 'between', e: l, lo, hi, neg, sym, pos };
          continue;
        }
        if (this.eatKw('in')) {
          this.op('(');
          if (this.isKw('select') || this.isKw('with') || this.isKw('values')) { const q = this.query(); this.op(')'); l = { k: 'in', e: l, query: q, neg, pos }; }
          else l = { k: 'in', e: l, list: this.exprList(')'), neg, pos };
          continue;
        }
        if (this.isKw('like') || this.isKw('ilike')) {
          const ci = this.tok.v === 'ilike'; this.i++;
          const q = this.isOp('(', 1) && this.oneOf('any', 'some', 'all');
          if (q) {
            this.op('(');
            const r = this.isKw('select') || this.isKw('with') || this.isKw('values') ? { query: this.query() } : { array: this.expr() };
            this.op(')');
            l = Object.assign({ k: 'quant', op: ci ? '~~*' : '~~', like: { ci, neg }, e: l, q: q === 'some' ? 'any' : q, pos }, r);
            continue;
          }
          const pat = this.otherOpExpr();
          let esc = null; if (this.eatKw('escape')) esc = this.otherOpExpr();
          l = { k: 'like', e: l, pat, esc, neg, ci, pos };
          continue;
        }
        if (this.eatKw('similar', 'to')) {
          const pat = this.otherOpExpr();
          let esc = null; if (this.eatKw('escape')) esc = this.otherOpExpr();
          l = { k: 'like', e: l, pat, esc, neg, similar: true, pos };
          continue;
        }
        if (neg) this.fail();
        if (this.isKw('overlaps')) { this.i++; l = { k: 'fn', name: 'overlaps', args: [l, this.otherOpExpr()], pos }; continue; }
        break;
      }
      return l;
    }
    // operators that are not arithmetic or comparison: ||, ->, @>, ~, &&, ... all at one precedence, left to right
    otherOpExpr() {
      let l = this.addExpr();
      for (;;) {
        const t = this.tok;
        if (t.t === 'op' && ['||', '->', '->>', '#>', '#>>', '@>', '<@', '@?', '@@', '?', '?|', '?&', '~', '~*', '!~', '!~*', '~~', '!~~', '~~*', '!~~*', '&&', '<<', '>>', '&', '|', '#', '@', '^@', '#-'].includes(t.v)) {
          this.i++;
          const q = this.isOp('(', 1) && this.oneOf('any', 'some', 'all');
          if (q) { l = Object.assign({ k: 'quant', op: t.v, e: l, q: q === 'some' ? 'any' : q, pos: t.pos }, this.quantArg()); continue; }
          l = { k: 'op', op: t.v, l, r: this.addExpr(), pos: t.pos };
          continue;
        }
        if (this.isKw('at') && this.isKw('time', 1) && this.isKw('zone', 2)) { const pos = this.pos(); this.i += 3; l = { k: 'fn', name: 'timezone', args: [this.addExpr(), l], pos }; continue; }
        if (this.isKw('at') && this.isKw('local', 1)) { const pos = this.pos(); this.i += 2; l = { k: 'fn', name: 'timezone', args: [{ k: 'fn', name: 'current_setting', args: [{ k: 'lit', v: 'timezone', type: 'str' }] }, l], pos }; continue; }
        if (this.isKw('collate')) { this.i++; this.name(); continue; }
        break;
      }
      return l;
    }
    addExpr() {
      let l = this.mulExpr();
      while (this.isOp('+') || this.isOp('-')) { const t = this.tok; this.i++; l = { k: 'op', op: t.v, l, r: this.mulExpr(), pos: t.pos }; }
      return l;
    }
    mulExpr() {
      let l = this.powExpr();
      while (this.isOp('*') || this.isOp('/') || this.isOp('%')) { const t = this.tok; this.i++; l = { k: 'op', op: t.v, l, r: this.powExpr(), pos: t.pos }; }
      return l;
    }
    powExpr() {
      let l = this.unaryExpr();
      while (this.isOp('^')) { const t = this.tok; this.i++; l = { k: 'op', op: '^', l, r: this.unaryExpr(), pos: t.pos }; }
      return l;
    }
    unaryExpr() {
      const t = this.tok;
      if (t.t === 'op' && (t.v === '-' || t.v === '+')) {
        this.i++;
        const e = this.unaryExpr();
        if (t.v === '-' && e.k === 'lit' && (e.type === 'int' || e.type === 'num') && !String(e.v).startsWith('-')) return Object.assign({}, e, { v: '-' + e.v, pos: t.pos });
        return t.v === '-' ? { k: 'neg', e, pos: t.pos } : e;
      }
      if (t.t === 'op' && (t.v === '~' || t.v === '@' || t.v === '|/' || t.v === '||/')) { this.i++; return { k: 'un', op: t.v, e: this.unaryExpr(), pos: t.pos }; }
      return this.postfix(this.primary());
    }
    /** ::type casts, [subscripts] and slices, and .field access, which bind tightest */
    postfix(e) {
      for (;;) {
        if (this.isOp('::')) { const pos = this.pos(); this.i++; e = { k: 'cast', e, type: this.typeName(), pos, colon: true }; continue; }
        if (this.isOp('[')) {
          // ARRAY[...][i] needs parentheses, as in PostgreSQL
          if (e.k === 'array' && !e.paren) this.fail();
          const pos = this.pos(); this.i++;
          let lo = null, hi = null, slice = false;
          if (!this.isOp(':')) lo = this.expr();
          if (this.eatOp(':')) { slice = true; if (!this.isOp(']')) hi = this.expr(); }
          this.op(']');
          e = { k: 'idx', e, lo, hi, slice, pos };
          continue;
        }
        if (this.isOp('.') && (e.k !== 'col' || e.paren) && (this.peek(1).t === 'id' || this.isOp('*', 1))) {
          const pos = this.pos(); this.i++;
          if (this.eatOp('*')) { e = { k: 'fieldstar', e, pos }; continue; }
          e = { k: 'field', e, name: this.label(), pos };
          continue;
        }
        break;
      }
      return e;
    }
    primary() {
      const t = this.tok;
      const pos = t.pos;
      if (t.t === 'int') { this.i++; return { k: 'lit', v: t.v, type: 'int', pos }; }
      if (t.t === 'num') { this.i++; return { k: 'lit', v: t.v, type: 'num', pos }; }
      if (t.t === 'str') { this.i++; if (t.bits === 'x') return { k: 'cast', e: { k: 'lit', v: '\\x' + t.v, type: 'str', pos }, type: { name: 'bytea', mods: [] }, pos }; if (t.bits === 'b') return { k: 'lit', v: t.v, type: 'bits', pos }; return { k: 'lit', v: t.v, type: 'str', pos }; }
      if (t.t === 'param') { this.i++; return { k: 'param', n: t.v, pos }; }
      if (t.t === 'op' && t.v === '(') {
        this.i++;
        if (this.isKw('select') || this.isKw('with') || this.isKw('values')) { const q = this.query(); this.op(')'); return { k: 'sub', query: q, pos }; }
        const e = this.expr();
        if (this.isOp(',')) { const items = [e]; while (this.eatOp(',')) items.push(this.expr()); this.op(')'); return { k: 'row', items, pos, implicit: true }; }
        this.op(')');
        return Object.assign({}, e, { paren: true });
      }
      if (t.t === 'op' && t.v === ':' && this.peek(1).t === 'id') { this.i++; const n = this.name(); return { k: 'var', name: n, pos }; }
      if (t.t !== 'id') this.fail();
      const w = t.quoted ? null : t.v;
      // keyword-led expressions
      switch (w) {
        case 'null': this.i++; return { k: 'lit', v: null, type: 'null', pos };
        case 'true': this.i++; return { k: 'lit', v: true, type: 'bool', pos };
        case 'false': this.i++; return { k: 'lit', v: false, type: 'bool', pos };
        case 'default': this.i++; return { k: 'default', pos };
        case 'case': return this.caseExpr();
        case 'cast': case 'try_cast': { this.i++; this.op('('); const e = this.expr(); this.kw('as'); const type = this.typeName(); this.op(')'); return { k: 'cast', e, type, pos, tryCast: w === 'try_cast' }; }
        case 'exists': { this.i++; this.op('('); const q = this.query(); this.op(')'); return { k: 'exists', query: q, pos }; }
        case 'not': this.i++; return { k: 'not', e: this.expr(), pos };
        case 'array': {
          this.i++;
          if (this.isOp('(')) { this.i++; const q = this.query(); this.op(')'); return { k: 'array', query: q, pos }; }
          return this.arrayLit(pos);
        }
        case 'row': if (this.isOp('(', 1)) { this.i += 2; return { k: 'row', items: this.exprList(')'), pos }; } break;
        case 'interval': {
          // INTERVAL '1' DAY, INTERVAL(0) '1.5 s', INTERVAL '1.678' SECOND(1)
          const mods = [];
          let k = 1;
          if (this.peek(1).t === 'op' && this.peek(1).v === '(' && this.peek(2).t === 'int' && this.peek(4).t === 'str') { mods.push(+this.peek(2).v); k = 4; }
          if (this.peek(k).t !== 'str') break;
          this.i += k; const s = this.tok.v; this.i++;
          let field = null; const f = this.oneOf('year', 'month', 'day', 'hour', 'minute', 'second');
          if (f) { field = f; if (this.eatKw('to')) field = f + ' to ' + this.oneOf('month', 'hour', 'minute', 'second'); if (/second$/.test(field) && this.isOp('(')) { this.i++; mods.push(+this.tok.v); this.i++; this.op(')'); } }
          return { k: 'cast', e: { k: 'lit', v: s, type: 'str', pos }, type: { name: 'interval', mods, field }, pos };
        }
        case 'current_date': case 'current_time': case 'current_timestamp': case 'localtime': case 'localtimestamp': {
          this.i++;
          let prec = null;
          if (this.isOp('(') && this.peek(1).t === 'int') { this.i++; prec = +this.tok.v; this.i++; this.op(')'); }
          return { k: 'fn', name: w, args: prec === null ? [] : [{ k: 'lit', v: String(prec), type: 'int' }], pos, special: true };
        }
        case 'current_user': case 'session_user': case 'user': case 'current_role': case 'current_schema': case 'current_catalog':
          this.i++; if (w === 'current_schema' && this.isOp('(')) { this.i += 2; } return { k: 'fn', name: w === 'user' ? 'current_user' : w, args: [], pos, special: true };
        case 'extract': {
          this.i++; this.op('(');
          const f = this.tok; this.i++;
          this.kw('from');
          const e = this.expr(); this.op(')');
          return { k: 'fn', name: 'extract', args: [{ k: 'lit', v: f.v, type: 'str' }, e], pos };
        }
        case 'position': {
          if (!this.isOp('(', 1)) break;
          this.i += 2;
          const a = this.otherOpExpr(); this.kw('in'); const b = this.expr(); this.op(')');
          return { k: 'fn', name: 'position', args: [a, b], pos };
        }
        case 'substring': {
          if (!this.isOp('(', 1)) break;
          this.i += 2;
          const s = this.expr();
          if (this.eatOp(',')) { const args = [s, ...this.exprList(')')]; return { k: 'fn', name: 'substring', args, pos }; }
          let from = null, len = null, similar = null;
          if (this.eatKw('from')) from = this.expr();
          if (this.eatKw('for')) len = this.expr();
          if (this.eatKw('similar')) { similar = this.expr(); this.kw('escape'); const esc = this.expr(); this.op(')'); return { k: 'fn', name: 'substring_similar', args: [s, similar, esc], pos }; }
          this.op(')');
          return { k: 'fn', name: 'substring', args: [s, from || { k: 'lit', v: '1', type: 'int' }].concat(len ? [len] : []), pos };
        }
        case 'overlay': {
          if (!this.isOp('(', 1)) break;
          this.i += 2;
          const s = this.expr(); this.kw('placing'); const p = this.expr(); this.kw('from'); const f = this.expr();
          let len = null; if (this.eatKw('for')) len = this.expr();
          this.op(')');
          return { k: 'fn', name: 'overlay', args: [s, p, f].concat(len ? [len] : []), pos };
        }
        case 'trim': {
          if (!this.isOp('(', 1)) break;
          this.i += 2;
          let side = 'both';
          const sd = this.oneOf('both', 'leading', 'trailing'); if (sd) side = sd;
          let chars = null, s;
          if (this.eatKw('from')) s = this.expr();
          else {
            const a = this.expr();
            if (this.eatKw('from')) { chars = a; s = this.expr(); }
            else if (this.eatOp(',')) { s = a; chars = this.expr(); }
            else s = a;
          }
          this.op(')');
          return { k: 'fn', name: side === 'both' ? 'btrim' : side === 'leading' ? 'ltrim' : 'rtrim', args: chars ? [s, chars] : [s], pos };
        }
        case 'grouping': if (this.isOp('(', 1)) { this.i += 2; return { k: 'grouping', args: this.exprList(')'), pos }; } break;
        case 'any': case 'some': case 'all': break;
      }
      // type 'literal': date '2024-01-01', timestamp '...', numeric '1.5', point '...'
      if (this.peek(1).t === 'str' && !t.quoted) {
        const typeWords = ['date', 'time', 'timestamp', 'timestamptz', 'boolean', 'bool', 'integer', 'int', 'int4', 'int8', 'bigint', 'smallint', 'numeric', 'decimal', 'real', 'float', 'float8', 'float4', 'text', 'varchar', 'char', 'bytea', 'json', 'jsonb', 'uuid', 'money', 'inet', 'xml'];
        if (typeWords.includes(w)) { this.i++; const s = this.tok.v; this.i++; return { k: 'cast', e: { k: 'lit', v: s, type: 'str', pos }, type: { name: w, mods: [] }, pos }; }
      }
      if ((w === 'timestamp' || w === 'time') && (this.isKw('with', 1) || this.isKw('without', 1)) && this.peek(4) && this.peek(4).t === 'str') {
        const type = this.typeName(); const s = this.tok.v; this.i++;
        return { k: 'cast', e: { k: 'lit', v: s, type: 'str', pos }, type, pos };
      }
      if (w === 'double' && this.isKw('precision', 1) && this.peek(2).t === 'str') { this.i += 2; const s = this.tok.v; this.i++; return { k: 'cast', e: { k: 'lit', v: s, type: 'str', pos }, type: { name: 'double precision', mods: [] }, pos }; }
      // a name: column, qualified column, or a function call
      if (!t.quoted && K.RESERVED.has(t.v) && !this.isOp('(', 1)) this.fail();
      this.i++;
      const parts = [t.v];
      while (this.isOp('.') && (this.peek(1).t === 'id')) { this.i++; parts.push(this.tok.v); this.i++; }
      // t.* inside an expression is the whole row of t (in the select list it expands, see target)
      if (this.isOp('.') && this.isOp('*', 1) && parts.length === 1) { this.i += 2; return { k: 'col', parts, pos, wholeRow: true }; }
      if (this.isOp('(')) return this.funcCall(parts, pos);
      return { k: 'col', parts, pos };
    }
    arrayLit(pos) {
      this.op('[');
      const items = [];
      if (!this.isOp(']')) {
        do {
          if (this.isOp('[')) items.push(this.arrayLit(this.pos()));
          else items.push(this.expr());
        } while (this.eatOp(','));
      }
      this.op(']');
      return { k: 'array', items, pos };
    }
    caseExpr() {
      const pos = this.pos();
      this.kw('case');
      let base = null;
      if (!this.isKw('when')) base = this.expr();
      const whens = [];
      while (this.eatKw('when')) { const c = this.expr(); this.kw('then'); whens.push({ c, r: this.expr() }); }
      if (!whens.length) this.fail('CASE needs at least one WHEN');
      let els = null;
      if (this.eatKw('else')) els = this.expr();
      this.kw('end');
      return { k: 'case', base, whens, else: els, pos };
    }
    callArgs() {
      const out = [];
      do {
        if (this.canName() && (this.isOp('=>', 1) || this.isOp(':=', 1))) { const n = this.name(); this.i++; out.push({ named: n, e: this.expr() }); }
        else if (this.eatKw('variadic')) out.push({ variadic: true, e: this.expr() });
        else out.push(this.expr());
      } while (this.eatOp(','));
      return out;
    }
    funcCall(parts, pos) {
      this.op('(');
      const f = { k: 'fn', name: parts[parts.length - 1], schema: parts.length > 1 ? parts[parts.length - 2] : null, args: [], pos };
      if (this.isOp('*')) { this.i++; f.star = true; this.op(')'); }
      else if (this.isOp(')')) this.i++;
      else {
        if (this.eatKw('distinct')) f.distinct = true; else this.eatKw('all');
        const raw = this.callArgs();
        f.args = raw.map((a) => (a.named ? a.e : a.variadic ? a.e : a));
        if (raw.some((a) => a.named)) f.named = raw.map((a) => a.named || null);
        if (raw.some((a) => a.variadic)) f.variadic = true;
        if (this.eatKw('order', 'by')) f.order = this.orderList();
        if (this.eatKw('separator')) f.separator = this.expr();
        if (this.eatKw('on', 'null')) { this.oneOf('null', 'absent'); }
        if (this.eatKw('null', 'on', 'null') || this.eatKw('absent', 'on', 'null')) { f.absentOnNull = this.peek(-3).v === 'absent'; }
        if (this.eatKw('returning')) f.returning = this.typeName();
        this.op(')');
      }
      if (this.eatKw('within', 'group')) { this.op('('); this.kw('order', 'by'); f.withinGroup = this.orderList(); this.op(')'); }
      if (this.eatKw('filter')) { this.op('('); this.kw('where'); f.filter = this.expr(); this.op(')'); }
      if (this.eatKw('respect', 'nulls')) f.nulls = 'respect'; else if (this.eatKw('ignore', 'nulls')) f.nulls = 'ignore';
      if (this.eatKw('over')) {
        if (this.isOp('(')) { this.i++; f.over = this.windowSpec(); }
        else f.over = { ref: this.name(), bare: true };
      }
      return f;
    }
    windowSpec() {
      const w = {};
      if (this.canName() && !['partition', 'order', 'rows', 'range', 'groups'].includes(this.tok.v)) w.ref = this.name();
      if (this.eatKw('partition', 'by')) w.partition = this.exprList();
      if (this.eatKw('order', 'by')) w.order = this.orderList();
      const unit = this.oneOf('rows', 'range', 'groups');
      if (unit) {
        w.frame = { unit };
        const bound = () => {
          if (this.eatKw('unbounded')) { const d = this.oneOf('preceding', 'following'); return { kind: 'unbounded', dir: d }; }
          if (this.eatKw('current', 'row')) return { kind: 'current' };
          const e = this.expr(); const d = this.oneOf('preceding', 'following'); if (!d) this.fail(); return { kind: 'offset', e, dir: d };
        };
        if (this.eatKw('between')) { w.frame.start = bound(); this.kw('and'); w.frame.end = bound(); }
        else { w.frame.start = bound(); w.frame.end = { kind: 'current' }; }
        if (this.eatKw('exclude')) { if (this.eatKw('current', 'row')) w.frame.exclude = 'current row'; else if (this.eatKw('group')) w.frame.exclude = 'group'; else if (this.eatKw('ties')) w.frame.exclude = 'ties'; else { this.kw('no', 'others'); w.frame.exclude = null; } }
      }
      this.op(')');
      return w;
    }
  }

  K.Parser = Parser;
  /** parse a whole script into statements */
  K.parse = (src) => new Parser(src).script();
  /** parse one expression (defaults, checks, generated columns kept as text in the catalog) */
  K.parseExpr = (src) => { const p = new Parser(src); const e = p.expr(); if (p.tok.t !== 'eof') p.fail(); return e; };
})(typeof window !== 'undefined' ? window : globalThis);
