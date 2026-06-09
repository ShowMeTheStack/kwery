// The database: the disk, the buffer pool, the log, the transaction manager, the lock manager and the catalog,
// and the services the other parts share (heaps and index access methods by relation, sequences, compiled
// table expressions for defaults and constraints, system views). Sessions (session.js) run statements on it.
(function (root) {
  'use strict';
  const K = root.K;
  const S = K.STATE;
  const B = () => K.T.BASE;
  const T = () => K.T;

  // the OIDs PostgreSQL gives its built-in types
  const TYPE_OIDS = { bool: 16, bytea: 17, name: 19, int8: 20, int2: 21, int4: 23, text: 25, json: 114, float4: 700, float8: 701, char: 1042, varchar: 1043, date: 1082, time: 1083, timestamp: 1114, timestamptz: 1184, interval: 1186, numeric: 1700, regclass: 2205, uuid: 2950, jsonb: 3802, record: 2249 };
  const DEFAULTS = {
    search_path: '"$user", public', timezone: 'UTC', datestyle: 'ISO, MDY', intervalstyle: 'postgres', client_encoding: 'UTF8',
    transaction_isolation: 'read committed', default_transaction_isolation: 'read committed', default_transaction_read_only: false,
    enable_seqscan: true, enable_indexscan: true, enable_indexonlyscan: true, enable_bitmapscan: true, enable_nestloop: true,
    enable_hashjoin: true, enable_mergejoin: true, enable_hashagg: true, enable_sort: true, join_collapse_limit: 8, bushy: false,
    enable_decorrelation: true, enable_column_pruning: true, nestloop_materialize: false, default_statistics_target: 100,
    work_mem_pages: 32, max_recursion: 10000, statement_timeout: 0, lock_timeout: 0, synchronous_commit: true, standard_conforming_strings: true,
    extra_float_digits: 1, application_name: 'kwery', server_version: '17.0', server_encoding: 'UTF8', lc_collate: 'C', integer_datetimes: true,
    concurrency_control: 'mvcc', force_join: null, visualSort: false, deadlock_timeout: '1s', max_connections: 100, block_size: 4096,
  };

  class Database {
    constructor(opts) {
      opts = opts || {};
      this.bus = opts.bus || new K.Bus();
      this.disk = new K.Disk({ pageSize: opts.pageSize || 4096, model: opts.disk || 'hdd', bus: this.bus });
      this.wal = new K.WAL(this);
      this.buffers = new K.BufferPool(this.disk, { frames: opts.frames || 128, policy: opts.policy || 'lru', bus: this.bus });
      this.buffers.wal = this.wal;
      this.xact = new K.XactManager(this);
      this.locks = new K.LockManager(this);
      this.cc = new K.MVCC(this);
      this.catalog = new K.Catalog(this);
      this.ddl = new K.DDL(this);
      this.dml = new K.DML(this);
      this.srf = K.SRF || null;
      this.windows = K.Windows || null;
      this.triggers = K.Triggers ? new K.Triggers(this) : null;
      this.protocol = null;
      this.settings = Object.assign({}, DEFAULTS, K.Protocols ? K.Protocols.settings : {}, opts.settings || {}, { block_size: this.disk.pageSize });
      this.sessions = [];
      this.nextSession = 1;
      this.heaps = new Map();       // file -> Heap
      this.ams = new Map();         // file -> index access method
      this.fsms = new Map();        // file -> free space per block
      this.live = new Map();        // oid -> approximate live rows (for the planner before ANALYZE)
      this.stats = new Map();       // oid -> statistics from ANALYZE
      this.seqs = new Map();        // oid -> sequence state
      this.exprCache = new Map();
      this.startTime = K.Clock ? K.Clock.now() : Date.now();
      this.logicalClock = 0;
    }
    get searchPath() { return K.currentSession ? K.currentSession.searchPath() : ['public']; }
    clock() { return ++this.logicalClock; }
    newFile(name, kind) { return this.disk.createFile(name, kind); }
    session(opts) { const s = new K.Session(this, opts); this.sessions.push(s); return s; }
    /** end a session: its open transaction rolls back and its temporary objects are dropped */
    closeSession(s) {
      try { if (s.tx && !s.tx.implicit) s.exec('rollback'); } catch (e) { /* the session is going away */ }
      const t = s.tempSchemaName();
      if (this.catalog.schemas.has(t)) { s.user = s.sessionUser || 'kwery'; try { s.exec('drop schema ' + t + ' cascade'); } catch (e) { /* nothing else to undo */ } }
      this.sessions = this.sessions.filter((x) => x !== s);
    }
    settingsOf(ctx) { return ctx && ctx.session ? ctx.session.settings : this.settings; }
    catalogOf(ctx) { return ctx && ctx.session ? ctx.session.catalog : this.catalog; }

    // ---- storage by relation ------------------------------------------------------------------------------------
    heap(rel) {
      let h = this.heaps.get(rel.file);
      if (!h) {
        h = new K.Heap(this, rel);
        const fsm = this.fsms.get(rel.file) || [];
        this.fsms.set(rel.file, fsm);
        h.fsm = () => fsm;
        this.heaps.set(rel.file, h);
      }
      h.rel = rel;
      return h;
    }
    /** the access method of an index: a B+ tree, a hash index, a bitmap ... */
    indexAm(idx, cat) {
      let am = this.ams.get(idx.file);
      const make = K.INDEX_AMS && K.INDEX_AMS[idx.method];
      if (!am) {
        if (idx.method === 'btree' || !make) am = new K.BTree(this, this.withKeyFn(idx, cat));
        else am = make(this, this.withKeyFn(idx, cat));
        this.ams.set(idx.file, am);
      }
      am.idx = this.withKeyFn(idx, cat);
      return am;
    }
    /** expression indexes compute their key from the row */
    withKeyFn(idx, cat) {
      if (idx.keys.every((k) => k.attnum !== undefined) || idx.keyFn) return idx;
      const rel = (cat || this.catalog).rel(idx.table);
      const fns = idx.keys.map((k) => (k.attnum !== undefined ? null : this.tableExpr(K.currentSession || this.internalSession(), rel, k.expr, 'index expression', {})));
      Object.defineProperty(idx, 'keyFn', { value: (vals, ctx) => idx.keys.map((k, i) => (fns[i] ? fns[i](vals, ctx) : vals[k.attnum])), enumerable: false, configurable: true });
      return idx;
    }
    internalSession() { if (!this._internal) { this._internal = new K.Session(this, { name: 'internal', internal: true }); } return this._internal; }
    noteLive(rel, d) { this.live.set(rel.oid, Math.max(0, (this.live.get(rel.oid) || 0) + d)); }
    liveOf(rel) { return this.live.get(rel.oid) || 0; }
    statsOf(rel) { return this.stats.get(rel.oid) || null; }
    writeXid(ctx) { return ctx.session.assignXid(ctx.tx); }
    txOfXid(xid) { for (const s of this.sessions.concat(this._internal ? [this._internal] : [])) if (s.tx && s.tx.xids && s.tx.xids.has(xid)) return s.tx; return null; }

    /**
     * a compiled expression over a table's row (defaults, CHECK constraints, generated columns, index
     * expressions, partial index predicates): a function (vals, ctx) of the row's values by column number
     */
    tableExpr(session, rel, ast, what, opts) {
      opts = opts || {};
      const cat = session.catalog;
      const key = rel.oid + ':' + cat.version + ':' + what + ':' + JSON.stringify(ast, (k, v) => (k === 'pos' ? undefined : typeof v === 'bigint' ? String(v) : v));
      const hit = this.exprCache.get(key);
      if (hit) return hit;
      const b = new K.Binder(session);
      const scope = new K.Scope(null);
      const lay = new Map();
      if (!opts.noCols) {
        const cols = [];
        rel.cols.forEach((c, i) => { if (!c.dropped) { const id = b.id(); cols.push({ id, name: c.name, type: c.type, attnum: i, table: rel.name }); lay.set(id, i); } });
        scope.items.push({ name: rel.name, cols, rel });
      }
      const noSub = { noAgg: 'aggregate functions are not allowed in ' + what + 's', noWin: 'window functions are not allowed in ' + what + 's' };
      let e = b.expr(ast, scope, noSub);
      let hasSub = false;
      b.walk(e, (x) => { if (x.k === 'sub') hasSub = true; }, true);
      if (hasSub) throw K.err(S.featureNotSupported, 'cannot use subquery in ' + what);
      if (opts.bool) e = b.boolExpr(ast, scope, what.toUpperCase(), noSub);
      if (opts.type) e = this.dml.assign(e, opts.type, what, b);
      let constant = true;
      b.walk(e, (x) => { if (x.k === 'col' || (x.k === 'call' && x.def.volatile) || x.k === 'udf') constant = false; }, true);
      const f = K.Expr.compile(e, lay);
      f.type = e.type;
      f.constant = constant;
      f.bound = e;
      if (this.exprCache.size > 2000) this.exprCache.clear();
      this.exprCache.set(key, f);
      return f;
    }
    /** a domain's CHECK constraint, compiled with VALUE as its one column */
    domainCheck(session, t, c) {
      const rel = { oid: 'domain:' + t.id, name: t.name, cols: [{ name: 'value', type: t.base }] };
      return this.tableExpr(session, rel, c.expr, 'check constraint', { bool: true });
    }
    checkDomainValue(v, t, ctx) {
      if (v === null) return;
      for (const c of t.checks || []) {
        const f = this.domainCheck(ctx.session || this.internalSession(), t, c);
        if (f([v], ctx) === false) throw K.err(S.checkViolation, 'value for domain ' + t.name + ' violates check constraint "' + c.name + '"');
      }
    }
    castTo(v, t, ctx) { return T().cast(v, T().typeOfValue(v), t, false, ctx); }

    /** rows of a table for DDL: those this transaction sees, or (all) every version some transaction might still see */
    *liveRows(rel, ctx, all) {
      const heap = this.heap(rel);
      const horizon = this.xact.horizon();
      for (const t of heap.scan()) {
        const h = K.Tuple.header(t.bytes);
        if (all) { if (this.xact.deadToAll(h, horizon) || this.xact.aborted(h.xmin)) continue; }
        else if (!this.xact.satisfies(h, ctx.tx, ctx.snap || this.xact.snapshot(ctx.tx && ctx.tx.xid)).visible) continue;
        yield { tid: t.tid, vals: K.Tuple.deform(t.bytes, rel.cols, ctx), h };
      }
    }
    /** rows visible to a fresh snapshot (with this transaction's own changes so far), for referential actions */
    *visibleRows(rel, ctx) {
      const snap = this.xact.snapshot(ctx.tx.xid || null);
      const tx = Object.assign({}, ctx.tx, { cid: Infinity });
      const heap = this.heap(rel);
      for (const t of heap.scan()) {
        const h = K.Tuple.header(t.bytes);
        if (!this.xact.satisfies(h, tx, snap).visible) continue;
        yield { tid: t.tid, vals: K.Tuple.deform(t.bytes, rel.cols, ctx), h };
      }
    }

    // ---- sequences (not transactional: a value handed out is never given back) ----------------------------------
    seqState(rel) {
      let st = this.seqs.get(rel.oid);
      if (!st) {
        st = { last: rel.seq.start, called: false, log: 0, restart(v) { this.last = v; this.called = false; } };
        this.seqs.set(rel.oid, st);
      }
      return st;
    }
    seqRel(name, ctx) {
      if (name && typeof name === 'object' && name.kind === 'sequence') return name;
      const s = String(name);
      const parts = s.replace(/"/g, '').split('.');
      const qn = parts.length > 1 ? { schema: parts[0], name: parts[1] } : { name: parts[0].toLowerCase() === parts[0] || s.includes('"') ? parts[0] : parts[0].toLowerCase() };
      const rel = this.catalogOf(ctx).lookup(qn, ctx && ctx.session ? ctx.session.searchPath() : ['public'], ['sequence']);
      if (!rel) throw K.err(S.undefinedTable, 'relation "' + s + '" does not exist');
      return rel;
    }
    sequenceNext(name, ctx) {
      const rel = this.seqRel(name, ctx);
      if (ctx && ctx.session) ctx.session.checkPrivilege(rel, 'usage');
      const q = rel.seq, st = this.seqState(rel);
      let v;
      if (!st.called) v = st.last;
      else {
        v = st.last + q.inc;
        if (v > q.max || v < q.min) {
          if (!q.cycle) throw K.err('2200H', 'nextval: reached ' + (v > q.max ? 'maximum' : 'minimum') + ' value of sequence "' + rel.name + '" (' + (v > q.max ? q.max : q.min) + ')');
          v = q.inc > 0n ? q.min : q.max;
        }
      }
      st.last = v; st.called = true;
      if (ctx && ctx.session) { ctx.session.lastSeq = { rel, v }; ctx.session.seqCurr.set(rel.oid, v); }
      this.bus.emit('seq.next', { seq: rel.name, value: v });
      return v;
    }
    sequenceCurr(name, ctx) {
      const rel = this.seqRel(name, ctx);
      const v = ctx.session.seqCurr.get(rel.oid);
      if (v === undefined) throw K.err('55000', 'currval of sequence "' + rel.name + '" is not yet defined in this session');
      return v;
    }
    sequenceSet(name, value, isCalled, ctx) {
      const rel = this.seqRel(name, ctx), q = rel.seq, v = BigInt(value);
      if (v > q.max || v < q.min) throw K.err('22003', 'setval: value ' + v + ' is out of bounds for sequence "' + rel.name + '" (' + q.min + '..' + q.max + ')');
      const st = this.seqState(rel);
      st.last = v; st.called = isCalled !== false;
      if (st.called) { ctx.session.seqCurr.set(rel.oid, v); ctx.session.lastSeq = { rel, v }; }
      return v;
    }
    sequenceLast(ctx) { const l = ctx.session.lastSeq; if (!l) throw K.err('55000', 'lastval is not yet defined in this session'); return l.v; }

    // ---- TABLESAMPLE -------------------------------------------------------------------------------------------------
    sampler(spec, ctx) {
      const pct = Number(K.Expr.compile(spec.args[0], new Map())([], ctx));
      const seed = spec.seed ? Number(K.Expr.compile(spec.seed, new Map())([], ctx)) : Math.random() * 1e9;
      let x = Math.floor(seed) >>> 0 || 1;
      const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
      if (spec.method === 'system') { const keep = new Map(); return { keep: (tid) => { if (!keep.has(tid.b)) keep.set(tid.b, rnd() * 100 < pct); return keep.get(tid.b); } }; }
      return { keep: () => rnd() * 100 < pct };
    }

    // ---- system views: information_schema and pg_catalog, built from the catalog when a query names them --------
    systemView(qn, session) {
      const name = qn.name, schema = qn.schema;
      const def = K.SYSVIEWS && (K.SYSVIEWS[(schema || 'pg_catalog') + '.' + name] || (!schema && K.SYSVIEWS['information_schema.' + name] && null));
      if (!def) return null;
      return (binder) => {
        const r = def(session, this);
        const cols = r.cols.map(([n, t]) => ({ id: binder.id(), name: n, type: typeof t === 'string' ? B()[t] || T().byName(t) : t }));
        return { op: 'Values', tuples: r.rows.map((row) => row.map((v, i) => K.cst(v, cols[i].type))), cols, children: [], system: name };
      };
    }

    // ---- crashes ------------------------------------------------------------------------------------------------------
    /** a power failure: the buffer pool and the unflushed log are gone; running transactions are lost */
    crash() {
      this.buffers.lose();
      this.wal.lose();
      for (const s of this.sessions) s.lost();
      this.heaps.clear(); this.ams.clear();
      this.bus.emit('db.crash', {});
    }
  }

  // system views as functions of (session, db) returning { cols: [[name, type]], rows }
  const yesno = (b) => (b ? 'YES' : 'NO');
  const baseType = (t) => { while (t && t.domain) t = t.base; return t; };
  K.SYSVIEWS = {
    'information_schema.tables': (s) => ({
      cols: [['table_catalog', 'text'], ['table_schema', 'text'], ['table_name', 'text'], ['table_type', 'text']],
      rows: s.catalog.tables(['table', 'view', 'matview']).filter((r) => r.kind !== 'matview').map((r) => ['kwery', r.schema, r.name, r.kind === 'view' ? 'VIEW' : r.temp ? 'LOCAL TEMPORARY' : 'BASE TABLE']),
    }),
    // a domain column shows its underlying type, as PostgreSQL's information_schema does
    'information_schema.columns': (s) => ({
      cols: [['table_catalog', 'text'], ['table_schema', 'text'], ['table_name', 'text'], ['column_name', 'text'], ['ordinal_position', 'int4'], ['column_default', 'text'], ['is_nullable', 'text'], ['data_type', 'text'], ['character_maximum_length', 'int4'], ['numeric_precision', 'int4'], ['numeric_scale', 'int4'], ['is_identity', 'text'], ['is_generated', 'text']],
      // ordinal_position is the attribute number, so dropped columns leave gaps; a quoted default shows its cast
      rows: s.catalog.tables(['table', 'view', 'matview']).flatMap((r) => r.cols.map((c, n) => [c, n + 1]).filter(([c]) => !c.dropped).map(([c, n, ty = baseType(c.type)]) => ['kwery', r.schema, r.name, c.name, n, c.default && c.default.k === 'lit' && c.default.type === 'str' && c.type.cat !== 'P' ? "'" + String(c.default.v).replace(/'/g, "''") + "'::" + (c.type.id === 'char' ? 'bpchar' : c.type.name) : c.defaultText || null, yesno(!c.notNull), ty.cat === 'A' ? 'ARRAY' : ty.cat === 'E' || ty.cat === 'C' && ty.id !== 'record' ? 'USER-DEFINED' : ty.name, ty.n !== undefined ? ty.n : null, ty.cat === 'N' ? (ty.p !== undefined ? ty.p : ty.id === 'int2' ? 16 : ty.id === 'int4' ? 32 : ty.id === 'int8' ? 64 : ty.id === 'float4' ? 24 : ty.id === 'float8' ? 53 : null) : null, ty.id === 'numeric' && ty.s !== undefined ? ty.s : ty.int ? 0 : null, yesno(!!c.identity), c.generated ? 'ALWAYS' : 'NEVER'])),
    }),
    'information_schema.table_constraints': (s) => ({
      cols: [['constraint_schema', 'text'], ['constraint_name', 'text'], ['table_schema', 'text'], ['table_name', 'text'], ['constraint_type', 'text'], ['is_deferrable', 'text'], ['initially_deferred', 'text']],
      rows: s.catalog.tables(['table']).flatMap((r) => r.constraints.map((c) => [r.schema, c.name, r.schema, r.name, { primary: 'PRIMARY KEY', unique: 'UNIQUE', check: 'CHECK', foreign: 'FOREIGN KEY' }[c.kind], yesno(c.deferrable), yesno(c.deferred)])),
    }),
    'information_schema.key_column_usage': (s) => ({
      cols: [['constraint_schema', 'text'], ['constraint_name', 'text'], ['table_schema', 'text'], ['table_name', 'text'], ['column_name', 'text'], ['ordinal_position', 'int4'], ['position_in_unique_constraint', 'int4']],
      rows: s.catalog.tables(['table']).flatMap((r) => r.constraints.filter((c) => c.kind !== 'check').flatMap((c) => c.cols.map((a, i) => [r.schema, c.name, r.schema, r.name, r.cols[a].name, i + 1, c.kind === 'foreign' ? i + 1 : null]))),
    }),
    'information_schema.referential_constraints': (s) => ({
      cols: [['constraint_schema', 'text'], ['constraint_name', 'text'], ['unique_constraint_schema', 'text'], ['unique_constraint_name', 'text'], ['match_option', 'text'], ['update_rule', 'text'], ['delete_rule', 'text']],
      rows: s.catalog.tables(['table']).flatMap((r) => r.constraints.filter((c) => c.kind === 'foreign').map((c) => { const ref = s.catalog.rel(c.refRel); const ix = s.catalog.rel(c.refIndex); return [r.schema, c.name, ref ? ref.schema : null, ix ? ix.name : null, c.match === 'full' ? 'FULL' : 'NONE', c.onUpdate.toUpperCase(), c.onDelete.toUpperCase()]; })),
    }),
    'information_schema.views': (s) => ({ cols: [['table_schema', 'text'], ['table_name', 'text'], ['view_definition', 'text']], rows: s.catalog.tables(['view']).map((r) => [r.schema, r.name, r.queryText]) }),
    'information_schema.schemata': (s) => ({ cols: [['catalog_name', 'text'], ['schema_name', 'text'], ['schema_owner', 'text']], rows: [...s.catalog.schemas.values()].map((x) => ['kwery', x.name, x.owner]) }),
    'information_schema.sequences': (s) => ({ cols: [['sequence_schema', 'text'], ['sequence_name', 'text'], ['data_type', 'text'], ['start_value', 'text'], ['minimum_value', 'text'], ['maximum_value', 'text'], ['increment', 'text'], ['cycle_option', 'text']], rows: s.catalog.tables(['sequence']).map((r) => [r.schema, r.name, r.seq.as.name, String(r.seq.start), String(r.seq.min), String(r.seq.max), String(r.seq.inc), yesno(r.seq.cycle)]) }),
    'information_schema.routines': (s) => ({ cols: [['routine_schema', 'text'], ['routine_name', 'text'], ['routine_type', 'text'], ['data_type', 'text'], ['external_language', 'text']], rows: [...s.catalog.funcs.values()].flat().map((f) => [f.schema, f.name, f.kind.toUpperCase(), f.retType ? f.retType.name : null, f.lang.toUpperCase()]) }),
    'information_schema.triggers': (s) => ({ cols: [['trigger_name', 'text'], ['event_manipulation', 'text'], ['event_object_table', 'text'], ['action_timing', 'text'], ['action_orientation', 'text']], rows: s.catalog.tables(['table', 'view']).flatMap((r) => r.triggers.flatMap((t) => t.events.map((e) => [t.name, e.event.toUpperCase(), r.name, t.timing.toUpperCase(), t.forEach.toUpperCase()]))) }),
    'information_schema.table_privileges': (s) => ({
      cols: [['grantor', 'text'], ['grantee', 'text'], ['table_catalog', 'text'], ['table_schema', 'text'], ['table_name', 'text'], ['privilege_type', 'text'], ['is_grantable', 'text']],
      rows: s.catalog.tables(['table', 'view', 'matview']).filter((r) => !s.catalog.schema(r.schema).system).flatMap((r) => [['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger'].map((p) => [r.owner, r.owner, 'kwery', r.schema, r.name, p.toUpperCase(), 'YES'])].flat().concat((r.acl || []).filter((a) => !a.cols).map((a) => [a.grantor, a.grantee === 'public' ? 'PUBLIC' : a.grantee, 'kwery', r.schema, r.name, a.priv.toUpperCase(), yesno(a.grantOption)]))),
    }),
    'information_schema.column_privileges': (s) => ({
      cols: [['grantor', 'text'], ['grantee', 'text'], ['table_schema', 'text'], ['table_name', 'text'], ['column_name', 'text'], ['privilege_type', 'text'], ['is_grantable', 'text']],
      rows: s.catalog.tables(['table', 'view']).flatMap((r) => (r.acl || []).filter((a) => a.cols).flatMap((a) => a.cols.map((c) => [a.grantor, a.grantee, r.schema, r.name, c, a.priv.toUpperCase(), yesno(a.grantOption)]))),
    }),
    'information_schema.check_constraints': (s) => ({ cols: [['constraint_schema', 'text'], ['constraint_name', 'text'], ['check_clause', 'text']], rows: s.catalog.tables(['table']).flatMap((r) => r.constraints.filter((c) => c.kind === 'check').map((c) => [r.schema, c.name, c.text])) }),
    'pg_catalog.pg_constraint': (s) => ({ cols: [['conname', 'text'], ['contype', 'text'], ['conrelid', 'regclass'], ['confrelid', 'regclass'], ['condeferrable', 'bool'], ['condeferred', 'bool'], ['confupdtype', 'text'], ['confdeltype', 'text']], rows: s.catalog.tables(['table']).flatMap((r) => r.constraints.map((c) => { const ref = c.refRel ? s.catalog.rel(c.refRel) : null; const act = (x) => ({ 'no action': 'a', restrict: 'r', cascade: 'c', 'set null': 'n', 'set default': 'd' }[x] || ' '); return [c.name, { primary: 'p', unique: 'u', check: 'c', foreign: 'f' }[c.kind], r.name, ref ? ref.name : '-', !!c.deferrable, !!c.deferred, c.kind === 'foreign' ? act(c.onUpdate) : ' ', c.kind === 'foreign' ? act(c.onDelete) : ' ']; })) }),
    'pg_catalog.pg_trigger': (s) => ({ cols: [['tgname', 'text'], ['tgrelid', 'regclass'], ['tgfoid', 'text'], ['tgenabled', 'text']], rows: s.catalog.tables(['table', 'view']).flatMap((r) => r.triggers.map((t) => [t.name, r.name, t.func, t.enabled ? 'O' : 'D'])) }),
    'pg_catalog.pg_proc': (s) => ({ cols: [['proname', 'text'], ['pronamespace', 'text'], ['prokind', 'text'], ['prolang', 'text'], ['prorettype', 'text'], ['proretset', 'bool'], ['pronargs', 'int2'], ['prosrc', 'text']], rows: [...s.catalog.funcs.values()].flat().map((f) => [f.name, f.schema, f.kind === 'procedure' ? 'p' : f.aggregate ? 'a' : 'f', f.lang, f.retType ? K.T.sqlName(f.retType) : 'void', !!f.setof, f.params.filter((p) => p.mode !== 'out').length, f.body]) }),
    'pg_catalog.pg_tables': (s) => ({ cols: [['schemaname', 'text'], ['tablename', 'text'], ['tableowner', 'text'], ['hasindexes', 'bool'], ['hastriggers', 'bool']], rows: s.catalog.tables(['table']).map((r) => [r.schema, r.name, r.owner, r.indexes.length > 0, r.triggers.length > 0 || r.constraints.some((c) => c.kind === 'foreign') || !!(r.referencedBy && r.referencedBy.length)]) }),
    'pg_catalog.pg_views': (s) => ({ cols: [['schemaname', 'text'], ['viewname', 'text'], ['viewowner', 'text'], ['definition', 'text']], rows: s.catalog.tables(['view']).map((r) => [r.schema, r.name, r.owner, ' ' + r.queryText + ';']) }),
    'pg_catalog.pg_matviews': (s) => ({ cols: [['schemaname', 'text'], ['matviewname', 'text'], ['ispopulated', 'bool'], ['definition', 'text']], rows: s.catalog.tables(['matview']).map((r) => [r.schema, r.name, !!r.populated, ' ' + r.queryText + ';']) }),
    'pg_catalog.pg_indexes': (s) => ({ cols: [['schemaname', 'text'], ['tablename', 'text'], ['indexname', 'text'], ['indexdef', 'text']], rows: s.catalog.tables(['index']).map((ix) => { const t = s.catalog.rel(ix.table); return [ix.schema, t ? t.name : null, ix.name, 'CREATE ' + (ix.unique ? 'UNIQUE ' : '') + 'INDEX ' + ix.name + ' ON ' + ix.schema + '.' + (t ? t.name : '?') + ' USING ' + ix.method + ' (' + ix.keys.map((k) => (k.attnum !== undefined ? t.cols[k.attnum].name : '(' + k.name + ')') + (k.dir === 'desc' ? ' DESC' : '')).join(', ') + ')' + (ix.whereText ? ' WHERE ' + ix.whereText : '')]; }) }),
    'pg_catalog.pg_sequences': (s, db) => ({ cols: [['schemaname', 'text'], ['sequencename', 'text'], ['start_value', 'int8'], ['min_value', 'int8'], ['max_value', 'int8'], ['increment_by', 'int8'], ['cycle', 'bool'], ['last_value', 'int8']], rows: s.catalog.tables(['sequence']).map((r) => { const st = db.seqs.get(r.oid); return [r.schema, r.name, r.seq.start, r.seq.min, r.seq.max, r.seq.inc, r.seq.cycle, st && st.called ? st.last : null]; }) }),
    'pg_catalog.pg_roles': (s) => ({ cols: [['rolname', 'text'], ['rolsuper', 'bool'], ['rolcanlogin', 'bool']], rows: [...s.catalog.roles.values()].filter((r) => r.name !== 'public').map((r) => [r.name, !!r.superuser, !!r.login]) }),
    'pg_catalog.pg_namespace': (s) => ({ cols: [['nspname', 'text'], ['nspowner', 'text']], rows: [...s.catalog.schemas.values()].map((x) => [x.name, x.owner]) }),
    'pg_catalog.pg_class': (s, db) => ({ cols: [['oid', 'int4'], ['relname', 'text'], ['relnamespace', 'text'], ['relkind', 'text'], ['relpages', 'int4'], ['reltuples', 'float8'], ['relfilenode', 'int4']], rows: [...s.catalog.rels.values()].map((r) => [r.oid, r.name, r.schema, { table: 'r', index: 'i', view: 'v', matview: 'm', sequence: 'S' }[r.kind] || 'r', r.file ? db.disk.files.has(r.file) ? db.disk.blocks(r.file) : 0 : 0, db.stats.get(r.oid) ? db.stats.get(r.oid).rows : -1, r.file || 0]) }),
    'pg_catalog.pg_type': (s) => ({ cols: [['oid', 'int4'], ['typname', 'text'], ['typnamespace', 'text'], ['typtype', 'text'], ['typcategory', 'text']], rows: Object.values(K.T.BASE).filter((t) => t.cat !== 'P').map((t) => [TYPE_OIDS[t.id] || null, t.id === 'char' ? 'bpchar' : t.id, 'pg_catalog', 'b', t.cat]).concat([...s.catalog.types.values()].map((t) => [t.oid, t.name, t.schema, t.domain ? 'd' : t.cat === 'E' ? 'e' : 'c', t.cat])) }),
    'pg_catalog.pg_enum': (s) => ({ cols: [['enumtypid', 'text'], ['enumsortorder', 'float4'], ['enumlabel', 'text']], rows: [...s.catalog.types.values()].filter((t) => t.cat === 'E' && !t.domain).flatMap((t) => t.labels.map((l, i) => [t.name, i + 1, l])) }),
    'pg_catalog.pg_prepared_statements': (s) => ({ cols: [['name', 'text'], ['statement', 'text'], ['from_sql', 'bool']], rows: [...s.prepared].map(([n, p]) => [n, p.text || null, true]) }),
    'pg_catalog.pg_settings': (s) => ({ cols: [['name', 'text'], ['setting', 'text']], rows: Object.keys(s.settings).filter((k) => !/[A-Z]/.test(k)).sort().map((k) => [k, s.settings[k] === null ? null : s.showValue(k)]) }),
    'pg_catalog.pg_locks': (s, db) => ({ cols: [['locktype', 'text'], ['relation', 'text'], ['tuple', 'text'], ['virtualtransaction', 'text'], ['transactionid', 'int8'], ['mode', 'text'], ['granted', 'bool'], ['pid', 'int4']], rows: db.locks.describe().flatMap((l) => l.granted.map((g) => [l.kind === 'table' ? 'relation' : l.kind === 'row' ? 'tuple' : 'object', l.what, l.kind === 'row' ? l.tag.split(':').slice(2).join(',') : null, String(g.tx), g.xid ? BigInt(g.xid) : null, l.kind === 'table' ? l.what && modeName(g.mode) : g.mode, true, g.pid]).concat(l.queue.map((q) => [l.kind === 'table' ? 'relation' : 'tuple', l.what, null, String(q.tx), q.xid ? BigInt(q.xid) : null, l.kind === 'table' ? modeName(q.mode) : q.mode, false, q.pid])))
      // SERIALIZABLE transactions' predicate locks, as PostgreSQL lists them
      .concat(db.ssi ? [...db.ssi.locks.values()].flatMap((e) => [...e.holders].map((h) => [e.target.kind, e.target.name, e.target.kind === 'tuple' ? e.target.block + ',' + e.target.off : e.target.kind === 'page' ? String(e.target.block) : null, String(h.id), h.tx && h.tx.xid ? BigInt(h.tx.xid) : null, 'SIReadLock', true, h.tx && h.tx.session && !h.tx.prepared && !h.committed ? h.tx.session.id : null])) : []) }),
    'pg_catalog.pg_prepared_xacts': (s, db) => ({ cols: [['transaction', 'int8'], ['gid', 'text'], ['owner', 'text'], ['database', 'text']], rows: [...(db.preparedTx || new Map()).values()].map((tx) => [tx.xid ? BigInt(tx.xid) : null, tx.prepared.gid, tx.prepared.owner, 'kwery']) }),
    'pg_catalog.pg_stat_activity': (s, db) => ({ cols: [['pid', 'int4'], ['usename', 'text'], ['application_name', 'text'], ['state', 'text'], ['backend_xid', 'int8'], ['wait_event_type', 'text'], ['query', 'text']], rows: db.sessions.map((x) => [x.id, x.user, x.name, x.state(), x.tx && x.tx.xid ? BigInt(x.tx.xid) : null, x.waiting ? 'Lock' : null, x.lastQuery || '']) }),
    'pg_catalog.pg_stats': (s, db) => ({ cols: [['schemaname', 'text'], ['tablename', 'text'], ['attname', 'text'], ['null_frac', 'float4'], ['n_distinct', 'float4'], ['most_common_vals', 'text'], ['most_common_freqs', 'text'], ['histogram_bounds', 'text'], ['correlation', 'float4']], rows: s.catalog.tables(['table', 'matview']).flatMap((r) => { const st = db.stats.get(r.oid); if (!st) return []; return r.cols.map((c, i) => [c, i]).filter(([c, i]) => !c.dropped && st.cols[i]).map(([c, i]) => { const cs = st.cols[i]; const out = (v) => K.T.output(v, c.type); return [r.schema, r.name, c.name, cs.nullFrac, cs.ndistinct, cs.mcv && cs.mcv.length ? '{' + cs.mcv.map((m) => out(m.v)).join(',') + '}' : null, cs.mcv && cs.mcv.length ? '{' + cs.mcv.map((m) => m.freq.toPrecision(4).replace(/\.?0+$/, '')).join(',') + '}' : null, cs.hist && cs.hist.length ? '{' + cs.hist.map(out).join(',') + '}' : null, cs.correlation === undefined ? null : Math.fround(cs.correlation)]; }); }) }),
  };
  // privileges and sizes, as functions
  if (K.F) {
    const rel = (ctx, name) => { const r = ctx.db.catalogOf(ctx).lookup(String(name).includes('.') ? { schema: String(name).split('.')[0], name: String(name).split('.')[1] } : { name: String(name) }, ctx.session.searchPath()); if (!r) throw K.err(S.undefinedTable, 'relation "' + name + '" does not exist'); return r; };
    const can = (ctx, user, name, privs) => { const r = rel(ctx, name); return String(privs).toLowerCase().split(',').some((p) => { try { ctx.session.checkPrivilege(r, p.trim().replace(/ with grant option$/, ''), undefined, user); return true; } catch (e) { return false; } }); };
    K.F.fn('has_table_privilege', [{ args: ['text', 'text'], ret: 'bool', fn: ([t, p], ctx) => can(ctx, ctx.session.user, t, p) }, { args: ['text', 'text', 'text'], ret: 'bool', fn: ([u, t, p], ctx) => can(ctx, u, t, p) }]);
    K.F.fn('obj_description', [{ args: ['text'], ret: 'text', fn: ([t], ctx) => rel(ctx, t).comment || null }, { args: ['text', 'text'], ret: 'text', fn: ([t, c], ctx) => (c === 'pg_class' ? rel(ctx, t).comment || null : null) }]);
    K.F.fn('col_description', { args: ['text', 'int4'], ret: 'text', fn: ([t, n], ctx) => { const c = rel(ctx, t).cols[n - 1]; return c && !c.dropped && c.comment || null; } });
    K.F.fn('pg_relation_size', { args: ['text'], ret: 'int8', fn: ([t], ctx) => { const r = rel(ctx, t); return BigInt(r.file && ctx.db.disk.files.has(r.file) ? ctx.db.disk.blocks(r.file) * ctx.db.disk.pageSize : 0); } });
    K.F.fn('pg_total_relation_size', { args: ['text'], ret: 'int8', fn: ([t], ctx) => { const r = rel(ctx, t); const cat = ctx.db.catalogOf(ctx); const pages = [r].concat(cat.indexesOf(r)).reduce((a, x) => a + (x.file && ctx.db.disk.files.has(x.file) ? ctx.db.disk.blocks(x.file) : 0), 0); return BigInt(pages * ctx.db.disk.pageSize); } });
    K.F.fn('pg_table_size', { args: ['text'], ret: 'int8', fn: ([t], ctx) => { const r = rel(ctx, t); return BigInt(r.file && ctx.db.disk.files.has(r.file) ? ctx.db.disk.blocks(r.file) * ctx.db.disk.pageSize : 0); } });
  }
  const modeName = (m) => m.split(' ').map((w) => w[0].toUpperCase() + w.slice(1)).join('') + 'Lock';

  K.Database = Database;
  K.DB_DEFAULTS = DEFAULTS;
})(typeof window !== 'undefined' ? window : globalThis);
