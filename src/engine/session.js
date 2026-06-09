// A session is one connection: its settings, its current transaction, prepared statements and cursors. It
// runs statements: parse, bind, plan, execute. Execution is a generator, so a statement that must wait for a
// lock pauses there; several sessions can then be run side by side, step by step, to show what concurrency
// control does. Statements outside BEGIN ... COMMIT run in a transaction of their own.
(function (root) {
  'use strict';
  const K = root.K;
  const S = K.STATE;
  const B = () => K.T.BASE;
  const T = () => K.T;

  // settings that take one of a few names (checked on SET, as PostgreSQL checks its enum parameters)
  const CHOICES = { deadlock_handling: ['detect', 'wait-die', 'wound-wait', 'timeout'], lock_granularity: ['row', 'table'], buffer_policy: ['lru', 'mru', 'clock', 'fifo', 'lru2'], default_transaction_isolation: ['serializable', 'repeatable read', 'read committed', 'read uncommitted'] };
  // settings of the database as a whole (the buffer manager, the log, the concurrency protocol): a SET changes them
  // for every session, since the page a checkpoint writes may have been dirtied by any transaction
  const dbWide = (k) => k === 'concurrency_control' || k === 'buffer_policy' || !!(K.RECOVERY_DEFAULTS && k in K.RECOVERY_DEFAULTS);
  const MS_SETTINGS = ['statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout'];
  const ISO = { 'read uncommitted': 'read committed', 'read committed': 'read committed', 'repeatable read': 'repeatable read', serializable: 'serializable' };
  const DDL = new Set(['createTable', 'createIndex', 'createView', 'createSequence', 'createType', 'createDomain', 'createSchema', 'createRoutine', 'createTrigger', 'createRole', 'createAssertion', 'createPolicy', 'cluster', 'alterTable', 'alterSequence', 'alterType', 'alterDomain', 'alterRole', 'drop', 'truncate', 'rename', 'comment', 'grant', 'revoke', 'refresh']);

  /** the result of one statement */
  class Result {
    constructor(tag, cols, rows) { this.tag = tag; this.cols = cols || null; this.rows = rows || null; this.notices = []; }
    get rowCount() { return this.rows ? this.rows.length : this.count || 0; }
  }

  let nextTx = 1;

  class Session {
    constructor(db, opts) {
      opts = opts || {};
      this.db = db;
      this.id = opts.internal ? 0 : db.nextSession++;
      this.name = opts.name || 'session ' + this.id;
      this.user = opts.user || 'kwery';
      this.sessionUser = this.user;
      this.settings = Object.assign({}, db.settings);
      this.tx = null;
      this.prepared = new Map();
      this.cursors = new Map();
      this.vars = new Map();
      this.seqCurr = new Map();
      this.lastSeq = null;
      this.notices = [];
      this.waiting = null;
      this.lastQuery = '';
      this.sessionDefaults = {};
    }
    // ---- what the binder and planner ask of a session -----------------------------------------------------------
    get catalog() { return (this.tx && this.tx.catalog) || this.db.catalog; }
    tempSchemaName() { return 'pg_temp_' + this.id; }
    /** the search path: this session's temporary schema first (when it has one), the setting, then pg_catalog */
    searchPath() { const t = this.tempSchemaName(); const p = this.searchPath0(); return this.catalog.schemas.has(t) ? [t].concat(p) : p; }
    searchPath0() { return String(this.settings.search_path).split(',').map((x) => x.trim().replace(/^"|"$/g, '')).filter(Boolean).map((x) => (x === '$user' ? this.user : x)).concat(['pg_catalog']).filter((x, i, a) => a.indexOf(x) === i); }
    role() { return this.catalog.roles.get(this.user) || { superuser: false, member: new Set() }; }
    superuser() { return !!this.role().superuser; }
    readOnly() { return !!(this.tx && this.tx.readOnly); }
    notice(msg, level) { this.notices.push({ level: level || 'NOTICE', message: msg }); this.db.bus.emit('session.notice', { session: this.id, level: level || 'NOTICE', message: msg }); }
    state() { return this.waiting || (this.tx && this.tx.implicit) || this.running ? 'active' : this.tx ? (this.tx.failed ? 'idle in transaction (aborted)' : 'idle in transaction') : 'idle'; }
    currentXid() { return this.tx && this.tx.xid ? BigInt(this.tx.xid) : null; }
    /** the roles a user acts as: itself, the groups it belongs to, and PUBLIC */
    roles(user) { const out = new Set([user || this.user, 'public']); let grew = true; while (grew) { grew = false; for (const r of this.catalog.roles.values()) if (!out.has(r.name) && [...out].some((m) => r.member.has(m))) { out.add(r.name); grew = true; } } return out; }
    /** may the user (or asUser: a view's owner, whose rights a view's query runs with) do priv on rel? cols narrows it to columns */
    checkPrivilege(rel, priv, pos, asUser, cols) {
      const user = asUser || this.user;
      const role = this.catalog.roles.get(user);
      if ((role && role.superuser) || rel.owner === user || !rel.acl) return;
      const mine = this.roles(user);
      const grants = rel.acl.filter((a) => mine.has(a.grantee) && (a.priv === priv || (priv === 'usage' && (a.priv === 'select' || a.priv === 'update'))));
      if (grants.some((a) => !a.cols)) return;
      if (cols && cols.length && cols.every((c) => grants.some((a) => a.cols && a.cols.includes(c)))) return;
      if (cols && cols.length && grants.length) { const c = cols.find((x) => !grants.some((a) => a.cols && a.cols.includes(x))); throw K.err(S.insufficientPrivilege, 'permission denied for ' + (rel.kind === 'view' ? 'view ' : 'table ') + rel.name, { pos, detail: 'No ' + priv.toUpperCase() + ' privilege on column "' + c + '".' }); }
      throw K.err(S.insufficientPrivilege, 'permission denied for ' + (rel.kind === 'sequence' ? 'sequence ' : rel.kind === 'view' ? 'view ' : 'table ') + rel.name, { pos });
    }
    /** does the user hold priv on some columns of rel (but maybe not the whole table)? */
    hasColumnGrant(rel, priv, asUser) { const mine = this.roles(asUser || this.user); return !!rel.acl && rel.acl.some((a) => a.cols && a.priv === priv && mine.has(a.grantee)); }
    cursor(name) { const c = this.cursors.get(name); if (!c) throw K.err(S.invalidCursor, 'cursor "' + name + '" does not exist'); return c; }
    varType(name) { const v = this.vars.get(name); return v ? v.type : null; }

    // ---- running SQL ----------------------------------------------------------------------------------------------
    /** run a script: every statement, in order; an error stops the script. Returns the results */
    exec(sql, opts) {
      opts = opts || {};
      const results = [];
      const gen = this.run(sql, opts);
      for (;;) {
        let r;
        try { r = gen.next(); } catch (e) { if (opts.collectErrors) { results.push(Object.assign(new Result('ERROR'), { error: e })); break; } throw e; }
        if (r.done) { results.push(...r.value); break; }
        const sig = r.value;
        if (sig.signal === 'wait') {
          if (sig.ready && sig.ready()) continue;
          // nobody else can run here: in this synchronous mode a wait would never end
          const e = K.err(S.lockNotAvailable, 'statement would wait: ' + sig.why, { detail: 'Use Session.start() and Database.step() to run several sessions at once.' });
          try { gen.throw(e); } catch (x) { if (opts.collectErrors) { results.push(Object.assign(new Result('ERROR'), { error: x })); break; } throw x; }
        }
      }
      return results;
    }
    /** one statement, its result (or an exception) */
    query(sql, params) { const r = this.exec(sql, { params }); return r[r.length - 1]; }
    /** start a script that may have to wait: returns a runner the database steps with the others */
    start(sql, opts) {
      const runner = new Runner(this, this.run(sql, opts || {}), sql);
      this.db.runners = (this.db.runners || []).filter((r) => !r.done).concat([runner]);
      return runner;
    }
    *run(sql, opts) {
      opts = opts || {};
      K.currentSession = this;
      // psql's backslash commands may sit between statements
      if (typeof sql === 'string' && K.Meta && /^\s*\\/m.test(sql)) {
        const results = [];
        for (const piece of K.Meta.split(sql)) {
          if (piece.meta) { const r = K.Meta.run(this, piece.meta); r.text = piece.meta; results.push(r); continue; }
          results.push(...(yield* this.run(piece.sql, opts)));
        }
        return results;
      }
      const stmts = typeof sql === 'string' ? K.parse(sql) : [].concat(sql);
      const results = [];
      for (const st of stmts) {
        this.notices = [];
        this.lastQuery = st.text || '';
        let r;
        try { r = yield* this.statement(st, opts.params || [], opts); } catch (e) { if (e && typeof e === 'object') { e.results = results; e.stmt = st; } throw e; }
        r.notices = this.notices;
        r.text = st.text;
        results.push(r);
        this.db.bus.emit('session.result', { session: this.id, tag: r.tag, rows: r.rows ? r.rows.length : 0 });
      }
      return results;
    }
    /** run one parsed statement: transaction control here, everything else inside a transaction */
    *statement(st, params, opts) {
      K.currentSession = this;
      switch (st.type) {
        case 'begin': return this.begin(st);
        case 'commit': return yield* this.commit(st);
        case 'rollback': return this.rollback(st);
        case 'savepoint': return this.savepoint(st);
        case 'release': return this.release(st);
        case 'rollbackTo': return this.rollbackTo(st);
        case 'setTransaction': return this.setTransaction(st);
        case 'set': return this.set(st);
        case 'show': return this.show(st);
        case 'reset': return this.reset(st);
        case 'prepare': {
          if (this.prepared.has(st.name)) throw K.err('42P05', 'prepared statement "' + st.name + '" already exists');
          let n = st.types ? st.types.length : 0;
          const walk = (x) => { if (!x || typeof x !== 'object') return; if (x.k === 'param' && typeof x.n === 'number') n = Math.max(n, x.n); for (const v of Object.values(x)) walk(v); };
          walk(st.stmt);
          this.prepared.set(st.name, { stmt: st.stmt, text: st.text, nparams: n, types: st.types ? st.types.map((t) => this.db.ddl.typeOf(t, this.catalog, this)) : [] });
          return new Result('PREPARE');
        }
        case 'deallocate': if (st.name === null) this.prepared.clear(); else if (!this.prepared.delete(st.name)) throw K.err('26000', 'prepared statement "' + st.name + '" does not exist'); return new Result('DEALLOCATE');
        case 'discard': {
          const what = st.what === 'temporary' ? 'temp' : st.what;
          if (what === 'all') {
            if (this.tx && !this.tx.implicit) throw K.err(S.activeTxn, 'DISCARD ALL cannot run inside a transaction block');
            this.user = this.sessionUser || 'kwery';
            this.settings = Object.assign({}, this.db.settings);
            this.prepared.clear(); this.cursors.clear();
          }
          if (what === 'all' || what === 'sequences') { this.seqCurr.clear(); this.lastSeq = null; }
          return new Result('DISCARD ' + what.toUpperCase());
        }
        case 'noop': return new Result(st.tag || (st.what === 'extension' ? 'CREATE EXTENSION' : 'OK'));
        case 'checkpoint': return this.checkpoint();
        case 'prepareTx': return yield* this.prepareTx(st);
        case 'commitPrepared': case 'rollbackPrepared': return yield* this.finishPrepared(st);
        case 'setRole': if (st.name && !this.catalog.roles.has(st.name)) throw K.err(S.undefinedObject, 'role "' + st.name + '" does not exist'); this.user = st.name || this.sessionUser || 'kwery'; return new Result('SET');
      }
      // a transaction another one rolled back (wound-wait, a cascading rollback) learns it at its next statement
      // a wounded transaction (wound-wait) is told so once; any other one learns it as an aborted transaction
      if (this.tx && this.tx.killed && this.tx.killed.tellVictim && !this.tx.killedReported) { this.tx.failed = true; throw K.reportKilled(this.tx); }
      if (this.tx && (this.tx.failed || this.tx.killed)) { this.tx.failed = true; throw K.err(S.inFailedTxn, 'current transaction is aborted, commands ignored until end of transaction block', this.tx.killed ? { detail: 'It was rolled back: ' + this.tx.killed.message } : undefined); }
      const implicit = !this.tx;
      if (implicit) this.beginTx(true);
      const tx = this.tx;
      try {
        const r = yield* this.inTx(st, params, opts);
        if (implicit) yield* this.commitTx(tx);
        else tx.cid++;
        return r;
      } catch (e) {
        if (e && e.crash) throw e;
        if (implicit) this.abortTx(tx);
        else if (this.tx === tx) {
          tx.failed = true; tx.cid++;
          if (!tx.savepoints.length && !tx.abortedEarly) {
            tx.abortedEarly = true;
            if (tx.xid) { this.db.wal.log({ xid: tx.xid, type: 'abort' }); for (const x of tx.xids) this.db.xact.setStatus(x, K.XSTATUS.ABORTED); }
            if (this.db.protocol && this.db.protocol.onAbort) this.db.protocol.onAbort(tx);
            if (K.SSI && K.SSI.onEnd) K.SSI.onEnd(this.db, tx, 'abort');
            this.db.locks.releaseAll(tx);
          }
        }
        this.waiting = null;
        throw e;
      }
    }
    /** a statement inside a transaction */
    *inTx(st, params, opts) {
      const tx = this.tx;
      // the snapshot: per statement under READ COMMITTED, per transaction above it
      if (!tx.snapshot || tx.isolation === 'read committed') tx.snapshot = this.db.xact.snapshot(tx.xid || null);
      const ctx = this.ctx(params, opts);
      if (DDL.has(st.type)) {
        const tag = yield* this.db.ddl.run(st, ctx);
        if (st.type === 'createTable' && st.as) return Object.assign(new Result(tag.split(' ')[0] === 'SELECT' ? tag : 'SELECT'), { count: +tag.split(' ')[1] || 0, tag });
        return new Result(tag);
      }
      switch (st.type) {
        case 'select': case 'values': case 'setop': case 'insert': case 'update': case 'delete':
          if (st.into && st.type === 'select') return yield* this.selectInto(st, ctx);
          return yield* this.runQuery(st, ctx);
        case 'merge': return yield* this.merge(st, ctx);
        case 'explain': return yield* this.explain(st, ctx);
        case 'execute': return yield* this.executePrepared(st, ctx);
        case 'analyze': return this.analyze(st, ctx);
        case 'vacuum': return this.vacuum(st, ctx);
        case 'lock': return yield* this.lockTable(st, ctx);
        case 'declareCursor': return this.declareCursor(st, ctx);
        case 'fetch': return this.fetchCursor(st, ctx);
        case 'closeCursor': if (st.name === null) this.cursors.clear(); else { this.cursor(st.name); this.cursors.delete(st.name); } return new Result('CLOSE CURSOR');
        case 'call': return yield* this.call(st, ctx);
        case 'do': return yield* this.doBlock(st, ctx);
        case 'copy': return yield* this.copy(st, ctx);
        case 'setConstraints': {
          const m = tx.conModes || (tx.conModes = { all: null, names: new Map() });
          if (st.names) {
            for (const n of st.names) {
              const name = typeof n === 'string' ? n : n.name;
              const cons = this.catalog.tables(['table']).flatMap((r) => r.constraints).filter((c) => c.name === name && (c.kind === 'foreign' || c.kind === 'unique' || c.kind === 'primary'));
              if (!cons.length) throw K.err(S.undefinedObject, 'constraint "' + name + '" does not exist');
              if (cons.some((c) => !c.deferrable)) throw K.err('42809', 'constraint "' + name + '" is not deferrable');
              m.names.set(name, st.mode);
            }
          } else { m.all = st.mode; m.names.clear(); }
          // constraints made immediate are checked now
          if (st.mode === 'immediate' && tx.deferred && tx.deferred.length) {
            const now = tx.deferred.filter((ev) => !this.db.dml.deferredNow(ev.c || ev.rel.constraints.find((c) => c.index === ev.ix.oid), tx));
            tx.deferred = tx.deferred.filter((ev) => !now.includes(ev));
            yield* this.db.dml.runAfter(ctx, now);
          }
          return new Result('SET CONSTRAINTS');
        }
      }
      throw K.err(S.featureNotSupported, st.type + ' is not supported');
    }
    /** the execution context of one statement */
    ctx(params, opts, txArg) {
      const tx = txArg || this.tx;
      const ctx = {
        db: this.db, session: this, tx, snap: tx.snapshot, cc: this.db.protocol || this.db.cc, bus: this.db.bus, params: params || [], zone: this.settings.timezone,
        outer: null, cteCache: new Map(), workTables: new Map(), vars: this.vars, afterQueue: [], subCache: new Map(), trace: opts && opts.trace || null,
        txStart: tx.start, stmtStart: K.Clock ? K.Clock.now() : Date.now(), rowCount: 0,
      };
      ctx.subplan = (n, row, layout) => this.subplan(ctx, n, row, layout);
      ctx.callUdf = (n, args) => this.callUdf(ctx, n, args);
      ctx.callUdfSet = (n, args) => this.callUdf(ctx, n, args, true);
      ctx.checkDomain = (v, t) => this.db.checkDomainValue(v, t, ctx);
      return ctx;
    }
    /** bind and plan a query (used by EXPLAIN, views and cursors too) */
    plan(st, opts) {
      opts = opts || {};
      const b = new K.Binder(this);
      if (opts.paramTypes) b.paramTypes = opts.paramTypes;
      if (opts.paramNames) b.paramNames = opts.paramNames;
      const logical = b.query(st, null);
      const p = new K.Planner(this, b);
      const phys = p.plan(logical);
      return { plan: phys, binder: b, planner: p, logical };
    }
    bindOnly(st, cat) { void cat; return new K.Binder(this).query(st, null); }
    *runQuery(st, ctx, opts) {
      const { plan, planner, logical } = this.plan(st, { paramTypes: opts && opts.paramTypes || ctx.params.map((v) => (v === null ? B().unknown : T().typeOfValue(v))) });
      ctx.planner = planner;
      const rows = [];
      for (const r of K.Exec.run(plan, ctx)) { if (K.Exec.isSignal(r)) { this.waiting = r; yield r; this.waiting = null; continue; } rows.push(r.length > plan.cols.length ? r.slice(0, plan.cols.length) : r); }
      for (const cte of logical.dmlCtes || []) {
        let st = ctx.cteCache.get(cte);
        if (!st) { if (!cte.phys) cte.phys = planner.physical(planner.rewrite(cte.plan)); st = { rows: [], it: K.Exec.run(cte.phys, ctx), done: false }; ctx.cteCache.set(cte, st); }
        while (!st.done) for (const r of K.Exec.pullCte(st)) { this.waiting = r; yield r; this.waiting = null; }
      }
      yield* this.db.dml.runAfter(ctx);
      yield* this.checkAssertions(ctx, plan);
      const vis = plan.cols.filter((c) => !c.hidden);
      const out = rows.map((r) => (r.length === vis.length ? Array.from(r) : r.slice(0, vis.length)));
      if (st.type === 'insert' || st.type === 'update' || st.type === 'delete') {
        const verb = st.type.toUpperCase();
        const tag = verb + ' ' + (st.type === 'insert' ? '0 ' : '') + (plan.count !== undefined ? plan.count : ctx.rowCount);
        const r = new Result(tag, st.returning ? vis.map((c) => ({ name: c.name, type: c.type })) : null, st.returning ? out : null);
        r.count = plan.count !== undefined ? plan.count : ctx.rowCount;
        r.plan = plan;
        return r;
      }
      const r = new Result('SELECT ' + out.length, vis.map((c) => ({ name: c.name, type: c.type })), out);
      r.plan = plan;
      return r;
    }
    *runQueryForDDL(q, ctx) { const r = yield* this.runQuery(q, Object.assign({}, ctx, { cteCache: new Map(), workTables: new Map() })); return { cols: r.cols, rows: r.rows }; }
    *selectInto(st, ctx) {
      const q = Object.assign({}, st, { into: null });
      return yield* this.inTx({ type: 'createTable', name: st.into.name, cols: [], constraints: [], as: q, temp: st.into.temp, pos: st.pos }, ctx.params);
    }

    // ---- subqueries and functions inside expressions ----------------------------------------------------------------
    /** run a subquery for one outer row: correlated ones see the outer row's values through ctx.outer */
    subplan(ctx, n, row, layout) {
      if (!n.phys) n.phys = (ctx.planner || new K.Planner(this, new K.Binder(this))).plan(n.plan);
      let outer = ctx.outer;
      if (n.outerRefs && n.outerRefs.length) {
        outer = new Map(ctx.outer || []);
        // above a grouping, a grouped column is read from its group key (outerMap)
        for (const id of n.outerRefs) { const i = layout.get(n.outerMap && n.outerMap.has(id) ? n.outerMap.get(id) : id); if (i !== undefined) outer.set(id, row[i]); }
      }
      let rows = n.outerRefs && n.outerRefs.length ? null : ctx.subCache.get(n);
      if (!rows) {
        const c = Object.assign({}, ctx, { outer, cteCache: n.outerRefs && n.outerRefs.length ? new Map() : ctx.cteCache, workTables: ctx.workTables });
        c.subplan = (m, r2, l2) => this.subplan(c, m, r2, l2);
        // EXISTS stops at the first row
        rows = [];
        for (const r of K.Exec.run(n.phys, c)) {
          if (K.Exec.isSignal(r)) { if (r.signal === 'wait' && !(r.ready && r.ready())) throw K.err(S.lockNotAvailable, 'a subquery would have to wait: ' + r.why, { hint: 'Kwery cannot pause inside an expression; run the subquery as its own statement.' }); continue; }
          rows.push(r);
          if (n.kind === 'exists' || (n.kind === 'scalar' && rows.length > 1)) break;
        }
        if (!n.outerRefs || !n.outerRefs.length) ctx.subCache.set(n, rows);
      }
      switch (n.kind) {
        case 'scalar':
          if (rows.length > 1) throw K.err(S.cardinality, 'more than one row returned by a subquery used as an expression');
          return rows.length ? rows[0][0] : null;
        case 'row':
          if (rows.length > 1) throw K.err(S.cardinality, 'more than one row returned by a subquery used as an expression');
          return rows.length ? new K.RowV(rows[0].slice(0, n.type.fields.length), n.type) : new K.RowV(n.type.fields.map(() => null), n.type);
        case 'exists': return rows.length > 0;
        case 'array': return new K.ArrayV(rows.map((r) => r[0]));
      }
      // x IN (subquery), x op ANY / ALL (subquery): three-valued
      const lay = layout;
      if (!n.testFn) n.testFn = n.rowTest ? n.tests.map((t) => K.Expr.compile(t.e, lay)) : K.Expr.compile(n.test, lay);
      const cmp = K.Expr.CMP[n.op === '!=' ? '<>' : n.op];
      const any = n.kind === 'in' || n.kind === 'any' || n.kind === 'some';
      let unknown = false, result = !any;
      const tv = n.rowTest ? n.testFn.map((f) => f(row, ctx)) : n.testFn(row, ctx);
      for (const r of rows) {
        let c;
        if (n.rowTest) {
          let u = false, decided = null;
          // = and <> look at every pair; <, <=, >, >= stop at the first pair that is NULL (unknown) or unequal
          const ordered = n.op !== '=' && n.op !== '<>' && n.op !== '!=';
          for (let i = 0; i < tv.length; i++) { if (tv[i] === null || r[i] === null) { u = true; if (ordered) break; continue; } const k = T().compare(tv[i], r[i], n.tests[i].ctype); if (k !== 0) { decided = cmp(k); break; } }
          c = decided !== null ? decided : u ? null : cmp(0);
        } else c = tv === null || r[0] === null ? null : n.like ? K.Expr.likeRe(String(r[0]), '\\', n.like.ci).test(tv) !== n.like.neg : cmp(T().compare(tv, r[0], n.ctype));
        if (c === null) { unknown = true; continue; }
        if (any && c) { result = true; break; }
        if (!any && !c) { result = false; break; }
      }
      if (any && !result && unknown) result = null;
      if (!any && result && unknown) result = null;
      if (n.neg) return result === null ? null : !result;
      return result;
    }
    /** call a user-defined function: SQL functions run their statements, PL/pgSQL ones run in the procedural engine */
    callUdf(ctx, n, args, wantSet) {
      try { return this.callUdf0(ctx, n, args, wantSet); } catch (e) { if (e instanceof RangeError) throw K.err('54001', 'stack depth limit exceeded', { hint: 'A function is calling itself too deeply.' }); throw e; }
    }
    callUdf0(ctx, n, args, wantSet) {
      const f = n.fn || n.udf;
      if (f.strict && args.some((v) => v === null)) return wantSet ? [] : null;
      const depth = (ctx.udfDepth || 0) + 1;
      if (depth > 1000) throw K.err('54001', 'stack depth limit exceeded', { hint: 'A function is calling itself without end.' });
      const c = Object.assign({}, ctx, { outer: null, cteCache: new Map(), workTables: new Map(), udfDepth: depth, subCache: new Map(), params: args });
      c.subplan = (m, r2, l2) => this.subplan(c, m, r2, l2);
      // calls made inside this function count one level deeper
      c.callUdf = (m, a2) => this.callUdf(c, m, a2);
      c.callUdfSet = (m, a2) => this.callUdf(c, m, a2, true);
      if (f.lang !== 'sql') {
        if (!K.PSM) throw K.err(S.featureNotSupported, 'language ' + f.lang + ' is not available');
        return K.PSM.call(f, args, c, this, wantSet);
      }
      const ins = f.params.filter((p) => p.mode !== 'out');
      const paramTypes = ins.map((p) => p.type);
      const paramNames = new Map(ins.map((p, i) => [p.name, i + 1]).filter(([k]) => k));
      const stmts = f.parsedBody || (f.parsedBody = K.parse(f.body));
      let last = null;
      for (const st of stmts) {
        const { plan } = this.plan(st, { paramTypes, paramNames });
        c.planner = null;
        const rows = [];
        for (const r of K.Exec.run(plan, c)) { if (K.Exec.isSignal(r)) { if (r.signal === 'wait' && !(r.ready && r.ready())) throw K.err(S.lockNotAvailable, 'function ' + f.name + ' would wait: ' + r.why); continue; } rows.push(r); }
        const gen = this.db.dml.runAfter(c);
        for (let x = gen.next(); !x.done; x = gen.next()) { /* no waits expected */ }
        last = { plan, rows };
      }
      if (f.kind === 'procedure') return null;
      if (!last) return wantSet ? [] : null;
      const rt = f.retType;
      const vis = last.plan.cols.filter((x) => !x.hidden).length;
      const conv = (r) => {
        if (rt && rt.cat === 'C' && rt.fields && (vis > 1 || f.returnsTable || wantSet)) return wantSet ? r.slice(0, vis).map((v, i) => (rt.fields[i] ? T().cast(v, null, rt.fields[i].type, false, c) : v)) : new K.RowV(r.slice(0, vis), rt);
        return T().cast(r[0], last.plan.cols[0].type, rt, false, c);
      };
      if (wantSet) return last.rows.map((r) => { const v = conv(r); return Array.isArray(v) ? v : [v]; });
      if (!last.rows.length) return null;
      return conv(last.rows[0]);
    }

    // ---- transactions ---------------------------------------------------------------------------------------------
    beginTx(implicit, modes) {
      modes = modes || {};
      const iso = ISO[modes.isolation || this.settings.default_transaction_isolation] || 'read committed';
      this.tx = {
        id: nextTx++, session: this, xid: 0, xids: new Set(), cid: 0, snapshot: null, implicit, isolation: iso, readOnly: modes.readOnly !== undefined ? modes.readOnly : !!this.settings.default_transaction_read_only,
        savepoints: [], catalog: null, failed: false, startSettings: Object.assign({}, this.settings), start: K.Clock ? K.Clock.now() : Date.now(), locks: new Set(), deferred: [], setLocal: {},
      };
      this.db.xact.active.set(this.tx.id, this.tx);
      this.db.bus.emit('xact.begin', { tx: this.tx.id, session: this.id, isolation: iso, implicit });
      return this.tx;
    }
    /** a transaction gets an id only when it first writes (as in PostgreSQL); a savepoint's work gets a subtransaction id */
    assignXid(tx) {
      if (tx.readOnly) throw K.err(S.readOnlyTxn, 'cannot execute this statement in a read-only transaction');
      if (!tx.xid) { tx.xid = this.db.xact.assign(); tx.xids.add(tx.xid); this.db.wal.log({ xid: tx.xid, type: 'begin' }); }
      const sp = tx.savepoints[tx.savepoints.length - 1];
      if (sp) {
        if (!sp.xid) { const parent = tx.savepoints.length > 1 ? this.assignSub(tx, tx.savepoints.length - 2) : tx.xid; sp.xid = this.db.xact.assign(parent); tx.xids.add(sp.xid); }
        return sp.xid;
      }
      return tx.xid;
    }
    assignSub(tx, i) { const sp = tx.savepoints[i]; if (!sp.xid) { const parent = i > 0 ? this.assignSub(tx, i - 1) : tx.xid; sp.xid = this.db.xact.assign(parent); tx.xids.add(sp.xid); } return sp.xid; }
    /** DDL works on the transaction's own copy of the catalog; one DDL transaction at a time */
    *catalogForWrite(ctx) {
      const tx = ctx.tx;
      if (!tx.catalog) {
        yield* this.db.locks.acquire(tx, 'catalog', 'item', 'X', { what: 'the system catalog' });
        tx.catalog = this.db.catalog.clone();
        tx.catalogBase = this.db.catalog;
      }
      if (tx.readOnly) throw K.err(S.readOnlyTxn, 'cannot execute DDL in a read-only transaction');
      return tx.catalog;
    }
    *commitTx(tx) {
      if (!tx.snapshot) tx.snapshot = this.db.xact.snapshot(tx.xid || null);
      const ctx = this.ctx([], {}, tx);
      // deferred constraints are checked now
      if (tx.deferred && tx.deferred.length) { try { yield* this.db.dml.runAfter(ctx, tx.deferred); } catch (e) { this.abortTx(tx); throw e; } }
      if (this.db.protocol && this.db.protocol.onCommit) { try { yield* this.db.protocol.onCommit(tx, ctx); } catch (e) { this.abortTx(tx); throw e; } }
      if (tx.isolation === 'serializable' && K.SSI && K.SSI.onCommit) { try { yield* K.SSI.onCommit(this.db, tx, ctx); } catch (e) { this.abortTx(tx); throw e; } }
      if (tx.xid) {
        const lsn = this.db.wal.log({ xid: tx.xid, type: 'commit' });
        // the commit is durable once its log record is on stable storage
        if (this.settings.synchronous_commit !== false && this.settings.synchronous_commit !== 'off') this.db.wal.flush(lsn, 'commit of transaction ' + tx.xid);
        for (const sp of tx.xids) if (sp !== tx.xid && !this.db.xact.aborted(sp)) this.db.xact.setStatus(sp, K.XSTATUS.SUBCOMMITTED);
        this.db.xact.setStatus(tx.xid, K.XSTATUS.COMMITTED);
      }
      if (tx.catalog) { this.db.wal.flush(undefined, 'catalog change committed'); this.db.catalog = tx.catalog; this.db.exprCache.clear(); }
      this.endTx(tx, 'commit');
    }
    abortTx(tx) {
      if (tx.abortedEarly) { this.endTx(tx, 'abort'); return; }
      if (tx.xid) {
        this.db.wal.log({ xid: tx.xid, type: 'abort' });
        for (const x of tx.xids) this.db.xact.setStatus(x, K.XSTATUS.ABORTED);
      }
      if (this.db.protocol && this.db.protocol.onAbort) this.db.protocol.onAbort(tx);
      if (K.SSI && K.SSI.onEnd) K.SSI.onEnd(this.db, tx, 'abort');
      this.endTx(tx, 'abort');
    }
    endTx(tx, how) {
      if (how === 'commit' && K.SSI && K.SSI.onEnd) K.SSI.onEnd(this.db, tx, 'commit');
      if (how === 'commit' && this.db.protocol && this.db.protocol.onEnd) this.db.protocol.onEnd(tx, 'commit');
      this.db.locks.releaseAll(tx);
      this.db.xact.active.delete(tx.id);
      for (const [name, c] of this.cursors) if (!c.hold) this.cursors.delete(name);
      // settings changed by SET are transactional: an aborted transaction puts them back
      if (how === 'abort' && tx.session === this && this.tx === tx) this.restoreSettings(tx.startSettings);
      else for (const [k, v] of Object.entries(tx.setLocal || {})) this.settings[k] = v;
      if (this.tx === tx) this.tx = null;
      this.db.bus.emit('xact.' + how, { tx: tx.id, xid: tx.xid, session: this.id });
    }
    restoreSettings(saved) { for (const k of Object.keys(saved)) if (!dbWide(k)) this.settings[k] = saved[k]; }
    lost() { if (this.tx) { this.db.xact.active.delete(this.tx.id); this.tx = null; } this.cursors.clear(); }
    begin(st) {
      if (this.tx) { this.notice('there is already a transaction in progress', 'WARNING'); return new Result('BEGIN'); }
      this.beginTx(false, st.modes);
      return new Result('BEGIN');
    }
    *commit(st) {
      if (!this.tx) { this.notice('there is no transaction in progress', 'WARNING'); return new Result('COMMIT'); }
      const tx = this.tx;
      // wounded by another transaction and not told yet: the commit fails with the reason
      if (tx.killed && tx.killed.tellVictim && !tx.killedReported) { this.abortTx(tx); throw K.reportKilled(tx); }
      if (tx.failed) { this.abortTx(tx); if (st.chain) this.beginTx(false, { isolation: tx.isolation, readOnly: tx.readOnly }); return new Result('ROLLBACK'); }
      yield* this.commitTx(tx);
      if (st.chain) this.beginTx(false, { isolation: tx.isolation, readOnly: tx.readOnly });
      return new Result('COMMIT');
    }
    /**
     * PREPARE TRANSACTION 'gid': the first phase of two-phase commit. The transaction's work is made durable and
     * it leaves the session, still holding its locks, until COMMIT PREPARED or ROLLBACK PREPARED decides it
     */
    *prepareTx(st) {
      const tx = this.tx;
      if (!tx || tx.implicit) throw K.err(S.noActiveTxn, 'PREPARE TRANSACTION can only be used in transaction blocks');
      if (tx.failed) { this.abortTx(tx); return new Result('ROLLBACK'); }
      const prep = this.db.preparedTx || (this.db.preparedTx = new Map());
      if (prep.has(st.gid)) throw K.err(S.duplicateObject, 'transaction identifier "' + st.gid + '" is already in use');
      if (tx.catalog) throw K.err(S.featureNotSupported, 'cannot PREPARE a transaction that has changed the catalog in Kwery');
      const ctx = this.ctx([], {}, tx);
      if (tx.deferred && tx.deferred.length) { try { yield* this.db.dml.runAfter(ctx, tx.deferred); tx.deferred = []; } catch (e) { this.abortTx(tx); throw e; } }
      if (tx.xid) { const lsn = this.db.wal.log({ xid: tx.xid, type: 'prepare', data: { gid: st.gid } }); this.db.wal.flush(lsn, 'prepare of transaction ' + tx.xid); }
      tx.prepared = { gid: st.gid, at: K.Clock.now(), owner: this.user };
      prep.set(st.gid, tx);
      this.db.bus.emit('xact.prepare', { tx: tx.id, xid: tx.xid, gid: st.gid });
      this.tx = null;
      return new Result('PREPARE TRANSACTION');
    }
    *finishPrepared(st) {
      if (this.tx && !this.tx.implicit) throw K.err(S.activeTxn, (st.type === 'commitPrepared' ? 'COMMIT' : 'ROLLBACK') + ' PREPARED cannot run inside a transaction block');
      const prep = this.db.preparedTx || new Map();
      const tx = prep.get(st.gid);
      if (!tx) throw K.err(S.undefinedObject, 'prepared transaction with identifier "' + st.gid + '" does not exist');
      prep.delete(st.gid);
      if (st.type === 'commitPrepared') { yield* this.commitTx(tx); return new Result('COMMIT PREPARED'); }
      this.abortTx(tx);
      return new Result('ROLLBACK PREPARED');
    }
    rollback(st) {
      if (!this.tx) { this.notice('there is no transaction in progress', 'WARNING'); return new Result('ROLLBACK'); }
      const tx = this.tx;
      this.abortTx(tx);
      if (st.chain) this.beginTx(false, { isolation: tx.isolation, readOnly: tx.readOnly });
      return new Result('ROLLBACK');
    }
    savepoint(st) {
      if (!this.tx) throw K.err(S.noActiveTxn, 'SAVEPOINT can only be used in transaction blocks');
      if (this.tx.failed) throw K.err(S.inFailedTxn, 'current transaction is aborted, commands ignored until end of transaction block');
      this.tx.savepoints.push({ name: st.name, xid: 0, catalog: this.tx.catalog ? this.tx.catalog.clone() : null, hadCatalog: !!this.tx.catalog, cid: this.tx.cid, deferred: (this.tx.deferred || []).length, settings: Object.assign({}, this.settings) });
      this.tx.cid++;
      this.db.bus.emit('xact.savepoint', { tx: this.tx.id, name: st.name });
      return new Result('SAVEPOINT');
    }
    findSavepoint(name) {
      if (!this.tx) throw K.err(S.noActiveTxn, (name ? 'ROLLBACK TO SAVEPOINT' : 'RELEASE SAVEPOINT') + ' can only be used in transaction blocks');
      for (let i = this.tx.savepoints.length - 1; i >= 0; i--) if (this.tx.savepoints[i].name === name) return i;
      if (!this.tx.implicit) this.tx.failed = true;
      throw K.err('3B001', 'savepoint "' + name + '" does not exist');
    }
    release(st) {
      const i = this.findSavepoint(st.name);
      if (this.tx.failed) throw K.err(S.inFailedTxn, 'current transaction is aborted, commands ignored until end of transaction block');
      // the released savepoints' work becomes part of the enclosing level
      this.tx.savepoints.length = i;
      return new Result('RELEASE');
    }
    rollbackTo(st) {
      const i = this.findSavepoint(st.name);
      const tx = this.tx;
      const sp = tx.savepoints[i];
      // everything done since the savepoint is undone: its subtransactions abort
      for (let k = i; k < tx.savepoints.length; k++) if (tx.savepoints[k].xid) this.db.xact.setStatus(tx.savepoints[k].xid, K.XSTATUS.ABORTED);
      if (sp.xid) this.db.wal.log({ xid: sp.xid, type: 'abort', sub: true });
      tx.savepoints.length = i + 1;
      sp.xid = 0;
      if (sp.hadCatalog) tx.catalog = sp.catalog.clone(); else tx.catalog = null;
      if (tx.deferred) tx.deferred.length = Math.min(tx.deferred.length, sp.deferred);
      this.restoreSettings(sp.settings);
      tx.failed = false;
      tx.cid++;
      this.db.bus.emit('xact.rollbackto', { tx: tx.id, name: st.name });
      return new Result('ROLLBACK');
    }
    setTransaction(st) {
      if (st.session) { if (st.modes.isolation) this.settings.default_transaction_isolation = st.modes.isolation; if (st.modes.readOnly !== undefined) this.settings.default_transaction_read_only = st.modes.readOnly; return new Result('SET'); }
      if (!this.tx || this.tx.implicit) { this.notice('SET TRANSACTION can only be used in transaction blocks', 'WARNING'); return new Result('SET'); }
      if (st.modes.isolation) {
        if (this.tx.snapshot) throw K.err(S.activeTxn, 'SET TRANSACTION ISOLATION LEVEL must be called before any query');
        this.tx.isolation = ISO[st.modes.isolation];
      }
      if (st.modes.readOnly !== undefined) this.tx.readOnly = st.modes.readOnly;
      return new Result('SET');
    }
    // ---- settings ------------------------------------------------------------------------------------------------------
    settingKey(name) {
      const n = K.lower(name);
      const alias = { 'transaction isolation level': 'transaction_isolation', time_zone: 'timezone', 'time zone': 'timezone', names: 'client_encoding', schema: 'search_path' };
      return alias[n] || n;
    }
    set(st) {
      const k = this.settingKey(st.name);
      const choices = CHOICES[k];
      if (choices && st.value !== null) {
        if (!choices.includes(K.lower(String(st.value)))) throw K.err(S.invalidParameter, 'invalid value for parameter "' + k + '": "' + st.value + '"', { hint: 'Available values: ' + choices.join(', ') + '.' });
        st = Object.assign({}, st, { value: K.lower(String(st.value)) });
      }
      if (!(k in this.settings) && !k.includes('.')) throw K.err(S.undefinedParameter, 'unrecognized configuration parameter "' + st.name + '"');
      if (['server_version', 'server_encoding', 'lc_collate', 'integer_datetimes', 'block_size', 'max_connections'].includes(k)) throw K.err(S.cantChangeRuntimeParam, 'parameter "' + k + '" cannot be changed now');
      let v = st.value === null ? this.db.settings[k] : st.value;
      if (k === 'transaction_isolation') { if (!this.tx || this.tx.implicit) return new Result('SET'); return this.setTransaction({ modes: { isolation: K.lower(v) } }); }
      if (typeof this.db.settings[k] === 'boolean') { const s = K.lower(String(v)); if (!['on', 'off', 'true', 'false', '1', '0', 'yes', 'no'].includes(s)) throw K.err(S.invalidParameter, 'parameter "' + k + '" requires a Boolean value'); v = ['on', 'true', '1', 'yes'].includes(s); }
      else if (typeof this.db.settings[k] === 'number') {
        // times may carry a unit, as in PostgreSQL: '1s', '250ms', '2min'
        const m = /^\s*(-?[\d.]+)\s*(ms|s|min|h)?\s*$/i.exec(String(v));
        const n = m ? Number(m[1]) * ({ ms: 1, s: 1000, min: 60000, h: 3600000 }[K.lower(m[2] || '')] || 1) : NaN;
        if (!Number.isFinite(n)) throw K.err(S.invalidParameter, 'invalid value for parameter "' + k + '": "' + v + '"');
        v = n;
      }
      if (k === 'timezone' && v !== null) {
        // a number of hours or an interval east of Greenwich is kept in PostgreSQL's POSIX spelling, <+05:30>-05:30
        if (st.numeric || st.interval) {
          const sec = st.interval ? Math.round(K.IntervalV.parse(v).us / 1e6) : Math.round(Number(v) * 3600);
          if (!Number.isFinite(sec)) throw K.err(S.invalidParameter, 'invalid value for parameter "TimeZone": "' + v + '"');
          const hm = (x) => { const a = Math.abs(x), h = String(Math.floor(a / 3600)).padStart(2, '0'), m = Math.floor(a / 60) % 60; return h + (m ? ':' + String(m).padStart(2, '0') : ''); };
          v = '<' + (sec < 0 ? '-' : '+') + hm(sec) + '>' + (sec > 0 ? '-' : '+') + hm(sec);
        } else if (K.Zone && !K.Zone.valid(v)) throw K.err(S.invalidParameter, 'invalid value for parameter "TimeZone": "' + v + '"');
      }
      // the protocol belongs to the database: only a change of protocol replaces it (and its history)
      if (k === 'concurrency_control' && String(v) !== (this.db.protocol ? this.db.protocol.name : 'mvcc')) {
        if (this.db.sessions.some((x) => x !== this && x.tx)) throw K.err(S.activeTxn, 'cannot change the concurrency control protocol while other transactions are running');
        this.db.protocol = v === 'mvcc' || !K.Protocols ? null : K.Protocols.make(String(v), this.db);
        this.db.settings.concurrency_control = v;
        for (const x of this.db.sessions) x.settings.concurrency_control = v;
      }
      if (dbWide(k)) { this.setDbWide(k, v); return new Result('SET'); }
      if (st.local && this.tx && !this.tx.implicit) { if (!(k in this.tx.setLocal)) this.tx.setLocal[k] = this.settings[k]; }
      this.settings[k] = v;
      return new Result('SET');
    }
    show(st) {
      if (st.name === 'all') return new Result('SHOW', [{ name: 'name', type: B().text }, { name: 'setting', type: B().text }], Object.keys(this.settings).filter((k) => !/[A-Z]/.test(k)).sort().map((k) => [k, this.showValue(k)]));
      const k = this.settingKey(st.name);
      if (k === 'transaction_isolation') return new Result('SHOW', [{ name: 'transaction_isolation', type: B().text }], [[this.tx ? this.tx.isolation : this.settings.default_transaction_isolation]]);
      if (!(k in this.settings)) throw K.err(S.undefinedParameter, 'unrecognized configuration parameter "' + st.name + '"');
      return new Result('SHOW', [{ name: k === 'timezone' ? 'TimeZone' : k, type: B().text }], [[this.showValue(k)]]);
    }
    showValue(k) {
      const v = this.settings[k];
      // times are kept in milliseconds and shown in the largest unit that divides them, as PostgreSQL does
      if (MS_SETTINGS.includes(k) && typeof v === 'number' && v) { const u = [['d', 86400000], ['h', 3600000], ['min', 60000], ['s', 1000], ['ms', 1]].find(([, n]) => v % n === 0); if (u) return v / u[1] + u[0]; } return v === true ? 'on' : v === false ? 'off' : v === null ? '' : String(v); }
    reset(st) {
      if (st.name === 'all') { this.settings = Object.assign({}, this.db.settings); return new Result('RESET'); }
      if (K.lower(st.name) === 'role' || K.lower(st.name) === 'session authorization') { this.user = this.sessionUser || 'kwery'; return new Result('RESET'); }
      const k = this.settingKey(st.name);
      if (dbWide(k)) { const d = K.DB_DEFAULTS && k in K.DB_DEFAULTS ? K.DB_DEFAULTS[k] : K.RECOVERY_DEFAULTS && k in K.RECOVERY_DEFAULTS ? K.RECOVERY_DEFAULTS[k] : this.db.settings[k]; if (k !== 'concurrency_control') this.setDbWide(k, d); return new Result('RESET'); }
      this.settings[k] = this.db.settings[k];
      return new Result('RESET');
    }
    setDbWide(k, v) {
      if (k === 'buffer_policy') this.db.buffers.setPolicy(v);
      this.db.settings[k] = v;
      for (const x of this.db.sessions) x.settings[k] = v;
      this.settings[k] = v;
    }

    // ---- utility statements ---------------------------------------------------------------------------------------------
    *executePrepared(st, ctx) {
      const p = this.prepared.get(st.name);
      if (!p) throw K.err('26000', 'prepared statement "' + st.name + '" does not exist');
      if (p.nparams !== undefined && st.args.length !== p.nparams) throw K.err(S.syntax, 'wrong number of parameters for prepared statement "' + st.name + '"', { detail: 'Expected ' + p.nparams + ' parameters but got ' + st.args.length + '.' });
      const argTypes = [];
      const args = st.args.map((a, i) => {
        const b = new K.Binder(this);
        let e = b.expr(a, new K.Scope(null), {});
        if (p.types[i]) e = K.Expr.coerce(e, p.types[i], false, 'parameter $' + (i + 1));
        argTypes.push(e.type);
        return K.Expr.compile(e, new Map())([], ctx);
      });
      const c = Object.assign({}, ctx, { params: args });
      c.subplan = (n, r, l) => this.subplan(c, n, r, l);
      return yield* this.runQuery(p.stmt, c, { paramTypes: p.types.length ? p.types : args.map((v, i) => (v === null || argTypes[i].id === 'unknown' ? B().unknown : argTypes[i].cat === 'P' ? T().typeOfValue(v) : argTypes[i])) });
    }
    *lockTable(st, ctx) {
      if (this.tx.implicit) throw K.err(S.noActiveTxn, 'LOCK TABLE can only be used in transaction blocks');
      for (const n of st.names) {
        const rel = this.catalog.lookup(n, this.searchPath(), ['table', 'view', 'matview']);
        if (!rel) throw K.err(S.undefinedTable, 'relation "' + n.name + '" does not exist');
        const mode = K.lower(st.mode);
        if (!K.LOCK_MODES.TABLE.includes(mode)) throw K.err(S.syntax, 'unrecognized lock mode "' + st.mode + '"');
        yield* this.db.locks.acquire(this.tx, 'table:' + rel.oid, 'table', mode, { what: 'relation ' + rel.name, nowait: st.nowait });
      }
      return new Result('LOCK TABLE');
    }
    checkpoint() {
      // write every dirty page and log a checkpoint record: recovery starts its redo pass here
      const dirty = this.db.buffers.dirtyPages();
      const active = [...this.db.xact.active.values()].filter((t) => t.xid).map((t) => t.xid);
      this.db.buffers.flushAll();
      const lsn = this.db.wal.log({ type: 'checkpoint', data: { active, dirty: dirty.length } });
      this.db.wal.flush(lsn, 'checkpoint');
      this.db.lastCheckpoint = lsn;
      this.db.bus.emit('checkpoint', { lsn, pages: dirty.length });
      return new Result('CHECKPOINT');
    }
    /** ANALYZE: sample each table, and keep per column the null fraction, distinct count, most common values and an equi-depth histogram */
    analyze(st, ctx) {
      const rels = st.tables.length ? st.tables.map((n) => { const r = this.catalog.lookup(n, this.searchPath(), ['table', 'matview']); if (!r) throw K.err(S.undefinedTable, 'relation "' + n.name + '" does not exist'); return r; }) : this.catalog.tables(['table', 'matview']).filter((r) => !this.catalog.schema(r.schema).system);
      for (const rel of rels) {
        const rows = [...this.db.liveRows(rel, ctx)].map((r) => r.vals);
        const cols = rel.cols.map((c, a) => {
          if (c.dropped) return null;
          const vals = rows.map((r) => r[a]);
          const nn = vals.filter((v) => v !== null && v !== undefined);
          const counts = new Map();
          for (const v of nn) { const k = K.keyOf(v); const e = counts.get(k); if (e) e.n++; else counts.set(k, { v, n: 1 }); }
          const nd = counts.size;
          const sorted = [...counts.values()].sort((x, y) => y.n - x.n);
          // as PostgreSQL with default_statistics_target = 100: up to 100 most common values and 100 histogram buckets
          const target = this.settings.default_statistics_target || 100;
          // when every value occurs more than once and they all fit, all of them are kept (PostgreSQL's "track all")
          const all = nd <= target && sorted.every((x) => x.n > 1);
          const mcv = sorted.filter((x) => all || (x.n > 1 && x.n / Math.max(1, rows.length) > 1 / Math.max(1, nd) * 1.25)).slice(0, target).map((x) => ({ v: x.v, freq: x.n / rows.length }));
          const mcvKeys = new Set(mcv.map((m) => K.keyOf(m.v)));
          const rest = nn.filter((v) => !mcvKeys.has(K.keyOf(v))).sort((x, y) => T().compare(x, y, c.type));
          const nb = Math.min(target, rest.length - 1);
          const hist = nb > 1 ? K.range(nb + 1).map((i) => rest[Math.round((i * (rest.length - 1)) / nb)]) : [];
          // correlation between the physical order of the rows and the order of the values (1: stored in key order)
          const pairs = [];
          vals.forEach((v, i) => { if (v !== null && v !== undefined) pairs.push([v, i]); });
          pairs.sort((p, q) => T().compare(p[0], q[0], c.type) || p[1] - q[1]);
          let correlation = 0;
          if (pairs.length > 1) {
            const n = pairs.length, mx = (n - 1) / 2;
            const my = pairs.reduce((acc, p) => acc + p[1], 0) / n;
            let sxy = 0, sxx = 0, syy = 0;
            pairs.forEach((p, k) => { const dx = k - mx, dy = p[1] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; });
            correlation = sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
          }
          return { nullFrac: rows.length ? (rows.length - nn.length) / rows.length : 0, ndistinct: nd, mcv, hist, correlation, width: 8 };
        });
        this.db.stats.set(rel.oid, { rows: rows.length, pages: this.db.disk.blocks(rel.file), cols, at: this.db.clock() });
        this.db.live.set(rel.oid, rows.length);
        this.db.bus.emit('analyze', { rel: rel.name, rows: rows.length });
      }
      return new Result('ANALYZE');
    }
    /** VACUUM: versions no transaction can see any more are removed from the heap and the indexes */
    vacuum(st, ctx) {
      if (!this.tx.implicit) throw K.err(S.activeTxn, 'VACUUM cannot run inside a transaction block');
      const rels = st.tables.length ? st.tables.map((n) => this.catalog.lookup(n, this.searchPath(), ['table', 'matview'])) : this.catalog.tables(['table', 'matview']);
      const horizon = this.db.xact.horizon();
      let total = 0;
      for (const rel of rels) {
        if (!rel) continue;
        const heap = this.db.heap(rel);
        const dead = new Set();
        for (const t of heap.scan()) { const h = K.Tuple.header(t.bytes); if (this.db.xact.deadToAll(h, horizon)) dead.add(t.tid.b + ':' + t.tid.o); }
        for (const ix of this.catalog.indexesOf(rel)) { const am = this.db.indexAm(ix); if (am.vacuum) am.vacuum((tid) => dead.has(tid.b + ':' + tid.o)); }
        let removed = 0;
        for (let b = 0; b < heap.nblocks(); b++) removed += heap.prune(b, (bytes, tid) => dead.has(tid.b + ':' + tid.o));
        total += removed;
        this.db.bus.emit('vacuum', { rel: rel.name, removed, horizon });
        if (st.full) { /* VACUUM FULL rewrites the table compactly */ const g = this.db.ddl.rewrite(rel, ctx, this.catalog, this, (v) => v); for (let x = g.next(); !x.done; x = g.next()); }
        if (st.analyze) this.analyze({ tables: [{ schema: rel.schema, name: rel.name }] }, ctx);
      }
      const r = new Result('VACUUM');
      r.removed = total;
      return r;
    }
    declareCursor(st, ctx) {
      if (this.tx.implicit && !st.hold) throw K.err(S.noActiveTxn, 'DECLARE CURSOR can only be used in transaction blocks');
      if (this.cursors.has(st.name)) throw K.err('42P03', 'cursor "' + st.name + '" already exists');
      const { plan, planner } = this.plan(st.query);
      const c = Object.assign({}, ctx);
      c.planner = planner;
      c.subplan = (n, r, l) => this.subplan(c, n, r, l);
      const cols = plan.cols.filter((x) => !x.hidden);
      // a cursor reads its rows lazily; going backwards uses the rows already read
      const it = K.Exec.run(plan, c);
      const cur = { name: st.name, scroll: st.scroll, hold: st.hold, cols, buf: [], pos: 0, done: false, it, plan,
        pull() { for (;;) { const x = this.it.next(); if (x.done) { this.done = true; return null; } if (K.Exec.isSignal(x.value)) continue; this.buf.push(x.value); return x.value; } },
        currentTid(rel) { const r = this.buf[this.pos - 1]; if (!r || !r.tid || r.rel.oid !== rel.oid) throw K.err('24000', 'cursor "' + this.name + '" is not positioned on a row'); return '(' + r.tid.b + ',' + r.tid.o + ')'; } };
      if (st.hold) { while (!cur.done) cur.pull(); }
      this.cursors.set(st.name, cur);
      return new Result('DECLARE CURSOR');
    }
    fetchCursor(st) {
      const c = this.cursor(st.name);
      const rows = [];
      const at = (i) => { while (c.buf.length < i && !c.done) c.pull(); return i >= 1 && i <= c.buf.length ? c.buf[i - 1] : null; };
      const forward = (n) => { for (let k = 0; k < n; k++) { const r = at(c.pos + 1); if (!r) { c.pos = c.buf.length + 1; break; } c.pos++; rows.push(r); } };
      const backward = (n) => { if (!c.scroll) throw K.err('55000', 'cursor can only scan forward', { hint: 'Declare it with SCROLL option to enable backward scan.' }); for (let k = 0; k < n; k++) { if (c.pos <= 1) { c.pos = 0; break; } c.pos--; rows.push(at(c.pos)); } };
      switch (st.dir) {
        case 'next': forward(1); break;
        case 'prior': backward(1); break;
        case 'first': c.pos = 0; forward(1); break;
        case 'last': while (!c.done) c.pull(); if (c.buf.length) { c.pos = c.buf.length; rows.push(c.buf[c.pos - 1]); } break;
        case 'absolute': { const n = st.count < 0 ? (() => { while (!c.done) c.pull(); return c.buf.length + 1 + st.count; })() : st.count; const r = at(n); c.pos = r ? n : n <= 0 ? 0 : c.buf.length + 1; if (r) rows.push(r); break; }
        case 'relative': { const n = c.pos + st.count; const r = at(n); c.pos = r ? n : n <= 0 ? 0 : c.buf.length + 1; if (r && st.count !== 0) rows.push(r); else if (st.count === 0 && r) rows.push(r); break; }
        case 'forward': if (st.count < 0) backward(-st.count); else forward(st.count); break;
        case 'backward': backward(st.count); break;
      }
      if (st.move) { const r = new Result('MOVE ' + rows.length); r.count = rows.length; return r; }
      return new Result('FETCH ' + rows.length, c.cols.map((x) => ({ name: x.name, type: x.type })), rows.map((r) => Array.from(r).slice(0, c.cols.length)));
    }
    *call(st, ctx) {
      const list = this.catalog.userFuncs(st.name.name).filter((f) => f.kind === 'procedure');
      if (!list.length) throw K.err(S.undefinedFunction, 'procedure ' + st.name.name + '() does not exist', { hint: 'No procedure matches the given name and argument types. You might need to add explicit type casts.' });
      const b = new K.Binder(this);
      const args = st.args.map((a) => b.expr(a.expr || a, new K.Scope(null), {}));
      const f = list.find((x) => x.params.filter((p) => p.mode !== 'out').length >= args.length) || list[0];
      const ins = f.params.filter((p) => p.mode !== 'out');
      const vals = ins.map((p, i) => (args[i] ? K.Expr.compile(K.Expr.coerce(args[i], p.type, false), new Map())([], ctx) : p.default ? K.Expr.compile(b.expr(p.default, new K.Scope(null), {}), new Map())([], ctx) : null));
      const r = this.callUdf(ctx, { fn: f }, vals);
      yield* this.db.dml.runAfter(ctx);
      if (r && r instanceof K.RowV && f.params.some((p) => p.mode === 'inout' || p.mode === 'out')) {
        const outs = f.params.filter((p) => p.mode === 'inout' || p.mode === 'out');
        return new Result('CALL', outs.map((p) => ({ name: p.name, type: p.type })), [r.values]);
      }
      return new Result('CALL');
    }
    *doBlock(st, ctx) {
      if (!K.PSM) throw K.err(S.featureNotSupported, 'DO blocks need the procedural language module');
      const f = { name: 'inline_code_block', kind: 'procedure', params: [], retType: null, lang: 'plpgsql', body: st.body, bodyPos: st.bodyPos };
      f.compiled = K.PSM.compile(f, this);
      K.PSM.call(f, [], ctx, this, false);
      yield* this.db.dml.runAfter(ctx);
      return new Result('DO');
    }
    /** COPY ... FROM STDIN takes its data from opts.copyData; COPY ... TO STDOUT returns the text */
    *copy(st, ctx) {
      const fmt = K.lower(st.opts.format || 'text');
      const delim = st.opts.delimiter || (fmt === 'csv' ? ',' : '\t');
      const nul = st.opts.null !== null && st.opts.null !== undefined ? st.opts.null : fmt === 'csv' ? '' : '\\N';
      if (st.dir === 'to') {
        const q = st.query || { type: 'select', targets: st.cols ? st.cols.map((c) => ({ expr: { k: 'col', parts: [c] } })) : [{ star: true }], from: [{ kind: 'table', name: st.table }] };
        const r = yield* this.runQuery(q, ctx);
        const esc = (s) => (fmt === 'csv' ? (/[",\n\r]/.test(s) || s.includes(delim) ? '"' + s.replace(/"/g, '""') + '"' : s) : s.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n'));
        const lines = r.rows.map((row) => row.map((v, i) => (v === null ? nul : esc(T().output(v, r.cols[i].type, ctx)))).join(delim));
        if (st.opts.header && st.opts.header !== 'false') lines.unshift(r.cols.map((c) => c.name).join(delim));
        const out = new Result('COPY ' + r.rows.length);
        out.count = r.rows.length; out.copyText = lines.join('\n') + (lines.length ? '\n' : '');
        return out;
      }
      const rel = this.catalog.lookup(st.table, this.searchPath(), ['table']);
      if (!rel) throw K.err(S.undefinedTable, 'relation "' + st.table.name + '" does not exist');
      const data = ctx.copyData || (this.copyData || '');
      const cols = st.cols ? st.cols.map((n) => rel.cols.findIndex((c) => c.name === n)) : rel.cols.map((c, i) => (c.dropped ? -1 : i)).filter((i) => i >= 0);
      const lines = data.split(/\r?\n/).filter((l, i, a) => l !== '' || i < a.length - 1).filter((l) => l !== '\\.');
      if (st.opts.header && st.opts.header !== 'false') lines.shift();
      let n = 0;
      const parseCsv = (line) => { const out = []; let cur = '', q = false, quoted = false; for (let i = 0; i < line.length; i++) { const ch = line[i]; if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; } else if (ch === '"') { q = true; quoted = true; } else if (ch === delim) { out.push(!quoted && cur === nul ? null : cur); cur = ''; quoted = false; } else cur += ch; } out.push(!quoted && cur === nul ? null : cur); return out; };
      for (const line of lines) {
        const parts = fmt === 'csv' ? parseCsv(line) : line.split(delim).map((p) => (p === nul ? null : p.replace(/\\(.)/g, (m, c) => ({ t: '\t', n: '\n', r: '\r', '\\': '\\' }[c] || c))));
        if (parts.length !== cols.length) throw K.err('22P04', parts.length < cols.length ? 'missing data for column "' + rel.cols[cols[parts.length]].name + '"' : 'extra data after last expected column', { detail: 'COPY ' + rel.name + ', line ' + (n + 1) + ': "' + line + '"' });
        const vals = new Array(rel.cols.length).fill(null);
        cols.forEach((a, i) => { vals[a] = parts[i] === null ? null : T().input(parts[i], rel.cols[a].type, ctx); });
        // the defaults of columns COPY does not name
        const b = new K.Binder(this);
        const defs = this.db.dml.bindDefaults(b, rel);
        rel.cols.forEach((c, a) => { if (!cols.includes(a) && !c.dropped) { if (c.identity && c.seq) vals[a] = this.db.castTo(this.db.sequenceNext(this.catalog.rel(c.seq), ctx), c.type, ctx); else if (defs[a]) vals[a] = K.Expr.compile(defs[a], new Map())([], ctx); } });
        yield* this.db.dml.insertRow(rel, vals, ctx);
        n++;
      }
      yield* this.db.dml.runAfter(ctx);
      const r = new Result('COPY ' + n);
      r.count = n;
      return r;
    }
    *merge(st, ctx) {
      if (!K.Merge) throw K.err(S.featureNotSupported, 'MERGE is not supported');
      return yield* K.Merge.run(this, st, ctx);
    }
    *explain(st, ctx) {
      const inner = st.stmt;
      const { plan, planner } = this.plan(inner);
      if (st.opts.analyze) {
        ctx.planner = planner;
        const t0 = K.now();
        this.db.disk.resetStats(); this.db.buffers.resetStats();
        for (const r of K.Exec.run(plan, ctx)) { if (K.Exec.isSignal(r)) { yield r; continue; } }
        yield* this.db.dml.runAfter(ctx);
        plan.totalMs = K.now() - t0;
        plan.io = Object.assign({}, this.db.disk.stats);
        plan.bufStats = Object.assign({}, this.db.buffers.stats);
      }
      const text = K.Explain ? K.Explain.text(plan, st.opts, this) : JSON.stringify(plan.op);
      const r = new Result('EXPLAIN', [{ name: 'QUERY PLAN', type: B().text }], text.split('\n').map((l) => [l]));
      r.plan = plan;
      r.trace = planner.trace;
      return r;
    }
    /** CREATE ASSERTION conditions are checked after statements that change a table they read */
    *checkAssertions(ctx, plan) {
      const cat = this.catalog;
      if (!cat.assertions.size || !plan || plan.op !== 'Modify') return;
      for (const a of cat.assertions.values()) {
        if (!a.deps.has(plan.rel.oid)) continue;
        if (!(yield* this.checkAssertion(a, ctx))) throw K.err(S.checkViolation, 'assertion "' + a.name + '" is violated');
      }
    }
    *checkAssertion(a, ctx) {
      const c = Object.assign({}, ctx, { cteCache: new Map(), subCache: new Map(), snap: this.db.xact.snapshot(ctx.tx.xid || null), tx: Object.assign({}, ctx.tx, { cid: Infinity }) });
      c.subplan = (n, r, l) => this.subplan(c, n, r, l);
      const r = yield* this.runQuery({ type: 'select', targets: [{ expr: a.check, alias: 'ok' }], from: [] }, c);
      return r.rows[0][0] !== false;
    }
  }

  /** a script running in a session that may wait; the database steps all runners */
  class Runner {
    constructor(session, gen, sql) { this.session = session; this.gen = gen; this.sql = sql; this.done = false; this.results = null; this.error = null; this.waitingOn = null; }
    /** run until the script ends or must wait; returns 'done', 'waiting' or 'error' */
    step() {
      if (this.done) return this.error ? 'error' : 'done';
      if (this.waitingOn && !(this.waitingOn.ready && this.waitingOn.ready())) return 'waiting';
      K.currentSession = this.session;
      let input;
      for (;;) {
        let r;
        try { r = input ? this.gen.throw(input) : this.gen.next(); } catch (e) { this.finish(null, e); return 'error'; }
        input = null;
        if (r.done) { this.finish(r.value, null); return 'done'; }
        const sig = r.value;
        if (sig.signal !== 'wait') continue;
        if (sig.ready && sig.ready()) continue;
        this.waitingOn = sig;
        this.session.waiting = sig;
        // a wait that closes a cycle in the wait-for graph is a deadlock: this transaction is the one that fails
        const cycle = this.session.db.locks.deadlock(sig.tx);
        if (cycle) {
          const lines = cycle.map((t, i) => { const nxt = cycle[(i + 1) % cycle.length]; const w = this.session.db.locks.waiting.get(t); return 'Process ' + t.session.id + ' waits for ' + (w ? w.mode + ' lock on ' + w.what : 'ShareLock on transaction ' + (nxt.xid || '?')) + '; blocked by process ' + nxt.session.id + '.'; });
          this.session.db.bus.emit('lock.deadlock', { cycle: cycle.map((t) => t.id) });
          input = K.err(S.deadlock, 'deadlock detected', { detail: lines.join('\n'), hint: 'See server log for query details.' });
          this.waitingOn = null; this.session.waiting = null;
          this.session.db.locks.waiting.delete(sig.tx);
          continue;
        }
        return 'waiting';
      }
    }
    /** stop a script that is waiting (a deadlock victim chosen elsewhere, or a cancelled statement) */
    cancel(err) {
      if (this.done) return;
      const e = err || K.err(S.queryCanceled, 'canceling statement due to user request');
      this.waitingOn = null; this.session.waiting = null;
      try { const r = this.gen.throw(e); if (r.done) this.finish(r.value, null); else this.finish(null, e); } catch (x) { this.finish(null, x); }
    }
    finish(results, error) { this.done = true; this.results = results; this.error = error; this.waitingOn = null; this.session.waiting = null; this.session.db.bus.emit('runner.done', { session: this.session.id, error: error ? error.message : null }); }
  }
  /** step every runnable runner until all are done or waiting */
  K.Database.prototype.step = function (maxRounds) {
    const runners = (this.runners || []).filter((r) => !r.done);
    for (let round = 0; round < (maxRounds || 1000); round++) {
      let progressed = false;
      for (const r of runners) { if (r.done) continue; const before = r.waitingOn; const st = r.step(); if (st !== 'waiting' || before !== r.waitingOn) progressed = true; }
      if (!progressed) break;
    }
    return runners.map((r) => ({ session: r.session.id, state: r.done ? (r.error ? 'error' : 'done') : 'waiting', error: r.error, why: r.waitingOn ? r.waitingOn.why : null }));
  };

  K.Session = Session;
  K.Result = Result;
  K.Runner = Runner;
})(typeof window !== 'undefined' ? window : globalThis);
