// The classic concurrency-control protocols (chapter 18) as alternatives
// to PostgreSQL's multiversion scheme, chosen with SET concurrency_control = '<name>':
//   2pl, strict2pl, rigorous2pl  two-phase locking with S and X locks on rows (with upgrades) under intention
//                                locks on the database and its tables (multiple granularity)
//   to                           timestamp ordering, with Thomas' write rule when thomas_write_rule is on
//   occ                          validation: read phase, then validation and write phase at commit
//   mvto                         multiversion timestamp ordering
//   mv2pl                        multiversion two-phase locking: rigorous 2PL for updates, snapshots for READ ONLY
// The single-version protocols read the newest committed version of a row (or their own): their hooks override
// the snapshot's answer. Writes still go into the heap as new versions, which nobody else reads before commit;
// for validation that is exactly the deferred write phase of validation. Every decision (a lock requested, granted,
// waited for or released; a timestamp test; a validation test) is an event on db.bus named cc.<kind> and is kept
// in the transaction's history, for the transactions view.
(function (root) {
  'use strict';
  const K = root.K;
  const S = K.STATE;
  const IM = () => K.Tuple.IM;

  const DEFAULTS = { deadlock_handling: 'detect', thomas_write_rule: false, phantom_protection: false, lock_granularity: 'row' };
  const NAMES = ['mvcc', '2pl', 'strict2pl', 'rigorous2pl', 'to', 'occ', 'mvto', 'mv2pl'];
  const truthy = (v) => v === true || ['on', 'true', '1', 'yes'].includes(String(v).toLowerCase());
  const setting = (tx, name) => { const v = K.lockSetting(tx, name, DEFAULTS[name]); return typeof DEFAULTS[name] === 'boolean' ? truthy(v) : typeof v === 'string' ? v.toLowerCase() : v; };
  const vkey = (rel, tid) => rel.file + ':' + tid.b + ':' + tid.o;
  const deleterOf = (h, x) => (h.xmax && !(h.infomask & IM().XMAX_INVALID) && !(h.infomask & IM().XMAX_LOCK_ONLY) && !x.aborted(h.xmax) ? h.xmax : 0);
  // an UPDATE or DELETE reads each row it goes on to change: for timestamp ordering that pair is a write(Q)
  const modifying = (ctx) => /^\s*(update|delete|merge)\b/i.test((ctx.session && ctx.session.lastQuery) || '');
  const showKey = (key) => (key === null ? '+inf' : key.map((v) => (v === null ? 'null' : String(v))).join(','));

  /** pass a generator's wait signals through, telling onWait about each */
  function* relay(gen, onWait) {
    let r = gen.next();
    while (!r.done) {
      onWait(r.value);
      let sent, err = null, threw = false;
      try { sent = yield r.value; } catch (e) { err = e; threw = true; }
      r = threw ? gen.throw(err) : gen.next(sent);
    }
    return r.value;
  }
  function evalBounds(node, ctx) {
    const C = (e) => K.Expr.compile(e, node.layout)([], ctx);
    return node.bounds.map((b) => Object.assign({}, b, { v: Array.isArray(b.v) ? b.v.map(C) : b.v ? C(b.v) : undefined }));
  }

  class Protocol extends K.MVCC {
    constructor(db, name) {
      super(db);
      this.name = name;
      this.items = new Map();    // version (file:block:offset) -> data item
      this.byKey = new Map();    // item key -> item
      this.labels = new Map();   // label -> item key
      this.inserted = [];        // items for rows inserted by running transactions, until a reader meets them
      this.history = [];         // every read, write, commit and abort, in order
      this.txs = new Map();      // tx id -> the protocol's record of the transaction
      this.tsByXid = new Map();
      this.seq = 0;
      this.newItems = 0;
    }
    /** the protocol's record of a transaction, made at its first operation */
    st(tx) {
      let s = this.txs.get(tx.id);
      if (!s) {
        s = { id: tx.id, tx, ts: K.lockTs(tx), status: 'active', phase: 'growing', start: ++this.seq, events: [], reads: new Set(), writes: new Set(), deps: new Set(), pending: new Map(), wprev: [], wlog: [], lockPoint: null, held: 0, maxHeld: 0 };
        this.txs.set(tx.id, s);
        tx.cc = s;
        this.note(s, 'begin', { ts: s.ts });
        if (this.txs.size > 400) for (const [id, o] of this.txs) { if (this.txs.size <= 300) break; if (o.status !== 'active') this.txs.delete(id); }
      }
      return s;
    }
    note(s, kind, data) {
      const e = Object.assign({ seq: ++this.seq, tx: s.id, kind }, data || {});
      s.events.push(e);
      this.db.bus.emit('cc.' + kind, Object.assign({ protocol: this.name }, e));
      return e;
    }
    op(s, op, it, extra) {
      this.history.push(Object.assign({ seq: ++this.seq, tx: s.id, op, item: it ? it.label : null }, extra || {}));
      if (op === 'r') s.reads.add(it.key);
      if (op === 'w') s.writes.add(it.key);
    }
    abort(tx, err) { this.db.locks.abortNow(tx, err); return err; }

    // ---- data items: a row keeps its identity across versions --------------------------------------------------------
    labelOf(rel, vals) {
      const cols = rel.pk && rel.pk.length ? rel.pk : [rel.cols.findIndex((c) => !c.dropped)];
      try { return rel.name + '.' + cols.map((a) => (vals[a] === null || vals[a] === undefined ? 'null' : K.T.output(vals[a], rel.cols[a].type))).join('_').replace(/[^\w.-]+/g, '_'); } catch (e) { void e; return rel.name; }
    }
    unique(base, key) {
      let l = base, n = 1;
      while (this.labels.has(l) && this.labels.get(l) !== key) l = base + '#' + ++n;
      this.labels.set(l, key);
      return l;
    }
    valsAt(rel, tid) {
      const t = this.db.heap(rel).fetch(tid);
      if (!t) return null;
      try { return K.Tuple.deform(t.bytes, rel.cols, {}); } finally { this.db.buffers.unpin(t.frame, false); }
    }
    header(rel, tid) { const t = this.db.heap(rel).fetch(tid); if (!t) return null; const h = K.Tuple.header(t.bytes); this.db.buffers.unpin(t.frame, false); return h; }
    item(rel, tid, h) {
      const k = vkey(rel, tid);
      let it = this.items.get(k);
      if (it) return it;
      this.db.bus.muted++;
      let vals;
      try { vals = this.valsAt(rel, tid); } finally { this.db.bus.muted--; }
      const base = vals ? this.labelOf(rel, vals) : rel.name + '.' + tid.b + '_' + tid.o;
      // a row a running transaction inserted: the item it locked (or stamped) at the insert
      if (h) {
        const top = this.x.top(h.xmin);
        const i = this.inserted.findIndex((x) => x.file === rel.file && x.base === base && x.xid === top);
        if (i >= 0) { it = this.inserted[i]; this.inserted.splice(i, 1); this.items.set(k, it); return it; }
      }
      const key = 'item:' + k;
      it = { key, rel: rel.name, label: this.unique(base, key), r: 0, w: null };
      this.items.set(k, it);
      this.byKey.set(key, it);
      return it;
    }
    /** the item for a row about to be inserted (its TID comes later) */
    newItem(rel, vals, s) {
      const base = this.labelOf(rel, vals);
      const key = 'item:new:' + ++this.newItems;
      const it = { key, rel: rel.name, label: this.unique(base, key), base, file: rel.file, xid: s.tx.xid, r: 0, w: s.ts };
      this.byKey.set(key, it);
      this.inserted.push(it);
      if (this.inserted.length > 1000) this.inserted.shift();
      return it;
    }
    relItem(rel) {
      const k = 'rel:' + rel.file;
      let it = this.items.get(k);
      if (!it) { it = { key: 'item:' + k, rel: rel.name, label: rel.name, r: 0, w: 0, whole: true }; this.items.set(k, it); this.byKey.set(it.key, it); this.labels.set(rel.name, it.key); }
      return it;
    }
    onReplace(rel, tid, newTid) { this.items.set(vkey(rel, newTid), this.item(rel, tid)); }
    tsOfXid(xid) {
      if (!xid || xid < K.FIRST_XID) return 0;
      const top = this.x.top(xid);
      const t = this.db.txOfXid(top);
      if (t && this.txs.has(t.id)) return this.txs.get(t.id).ts;
      return this.tsByXid.get(top) || 0;
    }

    /** what a single-version reader makes of a version: the newest committed one, or its own */
    version(h, tx, ctx, rel, tid) {
      const x = this.x;
      const mine = (xid) => xid && tx.xids.has(xid) && !x.aborted(xid);
      if (h.infomask & IM().XMIN_INVALID || x.aborted(h.xmin)) return { dead: true, visible: false };
      const del = deleterOf(h, x);
      if (mine(h.xmin) || mine(del)) return { own: true, visible: x.satisfies(h, tx, ctx.snap, tx.combo ? tx.combo.get(K.comboKey(rel, tid)) : undefined).visible };
      if (x.inProgress(h.xmin)) return { visible: false, writer: x.top(h.xmin), inserting: true };
      if (!del) return { visible: true };
      if (x.inProgress(del)) return { visible: true, writer: x.top(del), deleting: true };
      return { dead: true, visible: false };
    }
    *waitFor(s, xid, ctx, what) {
      let done = false, failed = false;
      try { yield* relay(this.waitXid(xid, ctx, what), () => {}); done = true; } catch (e) { failed = true; throw this.abort(s.tx, e); } finally { if (!done && !failed) this.cancelled(s, what); }
    }
    /**
     * the statement was cancelled while we waited (the deadlock detector's error reaches the session's generator,
     * and the executor closes ours): the transaction is rolled back now, its locks released
     */
    cancelled(s, what) {
      if (s.tx.abortedNow) return;
      this.note(s, 'denied', { item: what, reason: 'the statement failed while waiting' });
      this.db.locks.abortNow(s.tx, K.err(S.deadlock, 'transaction rolled back while waiting for ' + what));
      // the session already has the statement's error
      s.tx.killedReported = true;
    }

    // ---- hooks every protocol shares ---------------------------------------------------------------------------------------
    onAbort(tx) {
      const s = this.txs.get(tx.id);
      if (!s || s.status !== 'active') return;
      s.status = 'aborted';
      s.phase = 'ended';
      if (tx.xid) this.tsByXid.set(tx.xid, s.ts);
      this.history.push({ seq: ++this.seq, tx: s.id, op: 'a' });
      this.note(s, 'abort', { reason: tx.killed ? tx.killed.message : null });
      this.afterAbort(s);
      // basic two-phase locking lets others read what we wrote: they go too (cascading rollback)
      for (const o of this.txs.values()) {
        if (o.status !== 'active' || !o.deps.has(s.id)) continue;
        this.note(o, 'cascade', { from: s.id });
        this.db.locks.abortNow(o.tx, K.err(S.serialization, 'transaction rolled back because transaction ' + s.id + ', whose uncommitted data it read, rolled back', { detail: 'Cascading rollback: transaction ' + o.id + ' read data that transaction ' + s.id + ' wrote and released before committing.', hint: 'Strict two-phase locking, which keeps exclusive locks until commit, avoids cascading rollbacks.' }));
      }
    }
    onEnd(tx, how) {
      const s = this.txs.get(tx.id);
      if (!s || s.status !== 'active' || how !== 'commit') return;
      s.status = 'committed';
      s.phase = 'ended';
      if (tx.xid) this.tsByXid.set(tx.xid, s.ts);
      this.history.push({ seq: ++this.seq, tx: s.id, op: 'c' });
      this.note(s, 'commit', {});
      this.afterCommit(s);
    }
    afterAbort() {}
    afterCommit() {}
    lockPoint() { return 'the ' + this.name + ' protocol takes no locks'; }

    /** the history as a schedule, for K.Schedule: r5(acct.1) w6(acct.1) c5 ... */
    schedule() { return this.history.map((h) => (h.op === 'c' || h.op === 'a' ? h.op + h.tx : h.op + h.tx + '(' + h.item + ')')).join(' '); }
    describe() {
      const label = (k) => (this.byKey.get(k) || { label: k }).label;
      const items = new Set(this.items.values());
      for (const it of this.inserted) items.add(it);
      return {
        protocol: this.name,
        transactions: [...this.txs.values()].map((s) => ({ id: s.id, ts: s.ts, status: s.status, phase: s.phase, start: s.start, lockPoint: s.lockPoint, validation: s.validation || null, finish: s.finish || null, commitTs: s.commitTs || null, reads: [...s.reads].map(label), writes: [...s.writes].map(label), maxLocks: s.maxHeld, events: s.events.slice() })),
        items: [...items].map((it) => ({ item: it.label, rts: it.r, wts: it.w })),
        history: this.history.slice(),
        schedule: this.schedule(),
        locks: this.db.locks.describe().filter((l) => l.kind === 'item' || l.kind === 'granular'),
        waitsFor: this.db.locks.waitsFor(),
      };
    }
  }

  // ---- two-phase locking ----------------------------------------------------------------------------------------------------
  /**
   * Locks on rows (item locks, S and X, upgraded in place) under intention locks on the database and the table.
   * release says what goes at the lock point a transaction declares with SELECT lock_point(): 'all' (basic 2PL),
   * 'shared' (strict 2PL: X locks stay to the end), 'none' (rigorous 2PL). Without a declared lock point every
   * lock is held to commit or abort.
   */
  class Locking extends Protocol {
    constructor(db, name, release) { super(db, name); this.release = release; }
    snapshotReader() { return false; }
    *lock(s, tag, kind, mode, what) {
      const L = this.db.locks;
      const e = L.locks.get(tag);
      if (e && L.holds(e, s.tx, mode)) return;
      if (s.phase === 'shrinking') {
        this.note(s, 'violation', { mode, item: what });
        throw this.abort(s.tx, K.err(S.invalidTxnState, 'two-phase locking violated: transaction ' + s.id + ' is in its shrinking phase', { detail: 'It passed its lock point and released locks, so it cannot acquire ' + mode + ' lock on ' + what + '.', hint: 'Declare the lock point (SELECT lock_point()) only after the last lock the transaction needs.' }));
      }
      this.note(s, 'request', { mode, item: what, lock: kind });
      let waited = false, done = false, failed = false;
      try {
        yield* relay(L.acquire(s.tx, tag, kind, mode, { what }), (sig) => { if (!waited) { waited = true; this.note(s, 'wait', { mode, item: what, holders: (sig.on.holders || []).map((h) => h.id) }); } });
        done = true;
      } catch (err) { failed = true; this.note(s, 'denied', { mode, item: what, reason: err.message }); throw this.abort(s.tx, err); }
      finally { if (!done && !failed) this.cancelled(s, mode + ' lock on ' + what); }
      const g = L.locks.get(tag);
      this.note(s, 'grant', { mode: g ? L.held(g, s.tx) : mode, item: what, lock: kind, waited });
      s.held = s.tx.locks ? [...s.tx.locks].filter((t) => t.startsWith('item:') || t.startsWith('gran:')).length : 0;
      s.maxHeld = Math.max(s.maxHeld, s.held);
    }
    tableTag(rel) { return 'gran:' + rel.oid; }
    tableMode(s, rel) { const e = this.db.locks.locks.get(this.tableTag(rel)); return e ? this.db.locks.held(e, s.tx) : null; }
    /** a lock on a table, after the intention lock on the database above it */
    *table(s, rel, mode) {
      yield* this.lock(s, 'gran:db', 'granular', mode === 'IS' || mode === 'S' ? 'IS' : 'IX', 'database');
      yield* this.lock(s, this.tableTag(rel), 'granular', mode, 'table ' + rel.name);
    }
    /** a lock on a row (or key), after the intention locks above it; a table lock in S or X covers its rows */
    *row(s, rel, tag, mode, what) {
      const tm = this.tableMode(s, rel);
      if (tm === 'X' || (mode === 'S' && (tm === 'S' || tm === 'SIX'))) return;
      yield* this.table(s, rel, mode === 'S' ? 'IS' : 'IX');
      yield* this.lock(s, tag, 'item', mode, what);
    }
    *onScan(rel, node, ctx) {
      const tx = ctx.tx;
      if (!tx || ctx.snap === 'any' || this.snapshotReader(tx)) return;
      const s = this.st(tx);
      // the whole table in S: under table granularity, and as the predicate lock of a scan without an index
      const whole = setting(tx, 'phantom_protection') || setting(tx, 'lock_granularity') === 'table';
      yield* this.table(s, rel, whole ? 'S' : 'IS');
    }
    *onIndexScan(rel, node, ctx) {
      const tx = ctx.tx;
      if (!tx || ctx.snap === 'any' || this.snapshotReader(tx)) return;
      const s = this.st(tx);
      yield* this.table(s, rel, 'IS');
      if (setting(tx, 'phantom_protection')) yield* this.nextKeyScan(s, rel, node, ctx);
    }
    *onRead(rel, tid, h, r, ctx) {
      const tx = ctx.tx;
      if (!tx || ctx.snap === 'any') return undefined;
      if (this.snapshotReader(tx)) return this.snapshotRead(rel, tid, h, ctx);
      const s = this.st(tx);
      let v = this.version(h, tx, ctx, rel, tid);
      if (v.dead) return false;
      const it = this.item(rel, tid, h);
      if (v.own) { if (v.visible) this.op(s, 'r', it); return v.visible; }
      yield* this.row(s, rel, it.key, 'S', it.label);
      // the version may have changed while we waited
      const h2 = this.header(rel, tid);
      if (!h2) return false;
      v = this.version(h2, tx, ctx, rel, tid);
      if (v.dead) return false;
      if (v.writer && !v.own) {
        // we hold S, so the writer gave up its X lock before committing (basic 2PL): we read its uncommitted data
        const w = this.db.txOfXid(v.writer);
        v.visible = !!v.inserting;
        if (w) { s.deps.add(w.id); this.note(s, 'dirty', { item: it.label, from: w.id }); }
      }
      if (v.visible) this.op(s, 'r', it);
      return v.visible;
    }
    *onWrite(rel, tid, ctx, mode) {
      const tx = ctx.tx;
      const s = this.st(tx);
      const it = this.item(rel, tid, this.header(rel, tid));
      const m = ctx.locking && (mode === 'share' || mode === 'key share') ? 'S' : 'X';
      yield* this.row(s, rel, it.key, m, it.label);
      if (!ctx.locking) this.op(s, 'w', it);
      return undefined;
    }
    *onInsert(rel, vals, ctx) {
      const tx = ctx.tx;
      const s = this.st(tx);
      if (setting(tx, 'phantom_protection')) yield* this.nextKeyInsert(s, rel, vals, ctx);
      // the new row is locked X from the start: a reader that meets it waits for the inserter
      const it = this.newItem(rel, vals, s);
      yield* this.row(s, rel, it.key, 'X', it.label);
      this.op(s, 'w', it);
    }
    *onCommit(tx, ctx) {
      const s = this.txs.get(tx.id);
      if (!s) return;
      // having read uncommitted data, we may commit only after its writer does (recoverability)
      for (const id of s.deps) {
        const d = this.txs.get(id);
        if (d && d.status === 'active' && d.tx.xid) { this.note(s, 'wait', { why: 'commit waits for transaction ' + id + ', whose uncommitted data it read' }); yield* this.waitFor(s, d.tx.xid, ctx, 'commit of transaction ' + id + ', whose uncommitted data this transaction read'); }
        if (tx.killed) throw K.reportKilled(tx);
      }
    }
    /** SELECT lock_point(): the transaction has all the locks it needs; what it may release, it releases now */
    lockPoint(tx) {
      const s = this.st(tx);
      if (s.phase === 'shrinking') return 'transaction ' + s.id + ' is already in its shrinking phase';
      s.phase = 'shrinking';
      s.lockPoint = this.seq + 1;
      const L = this.db.locks;
      const out = [];
      // bottom up: rows and keys first, then tables, then the database
      const order = (t) => (t.startsWith('item:') ? 0 : t === 'gran:db' ? 2 : 1);
      for (const tag of [...(tx.locks || [])].filter((t) => t.startsWith('item:') || t.startsWith('gran:')).sort((a, b) => order(a) - order(b))) {
        const e = L.locks.get(tag);
        if (!e) continue;
        const m = L.held(e, tx);
        if (this.release === 'all' || (this.release === 'shared' && (m === 'S' || m === 'IS'))) { L.release(tx, tag); out.push(m + '(' + e.what + ')'); this.note(s, 'release', { mode: m, item: e.what }); }
      }
      s.held = [...(tx.locks || [])].filter((t) => t.startsWith('item:') || t.startsWith('gran:')).length;
      this.note(s, 'lockpoint', { released: out.length });
      return 'lock point of transaction ' + s.id + ': ' + (out.length ? 'released ' + out.join(', ') : 'nothing released (' + (this.release === 'none' ? 'rigorous two-phase locking holds every lock to the end' : 'only exclusive locks are held') + ')');
    }

    // ---- phantoms: next-key locking on B+ tree leaves --------------------------------------------------------------------
    btrees(rel, ctx) { const cat = this.db.catalogOf(ctx); return cat.indexesOf(rel).map((ix) => ({ ix, am: this.db.indexAm(ix, cat) })).filter((x) => K.BTree && x.am instanceof K.BTree); }
    keyTag(ix, key) { return 'item:key:' + ix.file + ':' + showKey(key); }
    keyWhat(ix, key) { return ix.name + '[' + showKey(key) + ']'; }
    entries(am) { this.db.bus.muted++; try { return [...am.search([])]; } finally { this.db.bus.muted--; } }
    /** the keys a range covers and the next key after it, for each range of the bounds */
    rangeKeys(am, bounds, all) {
      const inb = bounds.find((b) => b.op === 'in');
      if (inb) return inb.v.filter((v) => v !== null).flatMap((v) => this.rangeKeys(am, bounds.map((b) => (b === inb ? { k: b.k, op: '=', v } : b)), all));
      this.db.bus.muted++;
      let hits;
      try { hits = [...am.search(bounds)].map((e) => e.key); } finally { this.db.bus.muted--; }
      const out = [];
      for (const k of hits) if (!out.some((o) => am.cmpKey(o, k) === 0)) out.push(k);
      let next;
      if (hits.length) {
        const max = hits.reduce((m, k) => (am.cmpKey(k, m) > 0 ? k : m), hits[0]);
        next = all.find((e) => am.cmpKey(e.key, max) > 0);
      } else {
        // an empty range: the first key at or after where the range would start
        const eq = [];
        for (let k = 0; k < am.nk; k++) { const b = bounds.find((x) => x.k === k && x.op === '='); if (!b) break; eq.push(b.v); }
        let probe = eq;
        for (const b of bounds.filter((x) => x.k === eq.length && ['<', '<=', '>', '>='].includes(x.op))) {
          const lower = ((b.op[0] === '<' ? 1 : -1) * (am.dirs ? am.dirs[eq.length] : 1)) < 0;
          if (lower && (probe === eq || am.cmpKey(eq.concat([b.v]), probe) > 0)) probe = eq.concat([b.v]);
        }
        next = all.find((e) => am.cmpKey(e.key.slice(0, probe.length), probe) >= 0);
      }
      out.push(next ? next.key : null);
      return out;
    }
    *nextKeyScan(s, rel, node, ctx) {
      const ix = node.index;
      const am = ix && this.db.indexAm(ix, this.db.catalogOf(ctx));
      let keys = null;
      if (am && K.BTree && am instanceof K.BTree) { try { keys = this.rangeKeys(am, evalBounds(node, ctx), this.entries(am)); } catch (e) { void e; keys = null; } }
      // without a B+ tree to lock the gaps of, lock the table
      if (!keys) { yield* this.table(s, rel, 'S'); return; }
      this.note(s, 'predicate', { index: ix.name, keys: keys.map(showKey), why: 'next-key locking: the keys in the range and the key after it' });
      for (const k of keys) yield* this.row(s, rel, this.keyTag(ix, k), 'S', this.keyWhat(ix, k));
    }
    *nextKeyInsert(s, rel, vals, ctx) {
      for (const { ix, am } of this.btrees(rel, ctx)) {
        const key = am.keyOf(vals, ctx);
        const next = this.entries(am).find((e) => am.cmpKey(e.key, key) > 0);
        const nk = next ? next.key : null;
        this.note(s, 'predicate', { index: ix.name, keys: [showKey(key), showKey(nk)], why: 'an insert locks its key and the next key in X mode' });
        yield* this.row(s, rel, this.keyTag(ix, nk), 'X', this.keyWhat(ix, nk));
        yield* this.row(s, rel, this.keyTag(ix, key), 'X', this.keyWhat(ix, key));
      }
    }
  }

  /** multiversion two-phase locking: updates under rigorous 2PL; READ ONLY transactions read a snapshot, without locks */
  class MV2PL extends Locking {
    constructor(db) { super(db, 'mv2pl', 'none'); this.counter = 0; }
    snapshotReader(tx) { return !!tx.readOnly; }
    snapshotRead(rel, tid, h, ctx) {
      const s = this.st(ctx.tx);
      if (!s.snap) { s.snap = this.x.snapshot(ctx.tx.xid || null); s.ts = this.counter; this.note(s, 'snapshot', { ts: this.counter, why: 'a read-only transaction reads the versions with the largest timestamp not above ts-counter = ' + this.counter }); }
      const ok = this.x.satisfies(h, ctx.tx, s.snap).visible;
      if (ok) this.op(s, 'r', this.item(rel, tid, h));
      return ok;
    }
    afterCommit(s) { if (!s.tx.readOnly && s.writes.size) { s.commitTs = ++this.counter; this.note(s, 'ts', { ts: s.commitTs, why: 'an update transaction stamps its versions with ts-counter + 1 at commit' }); } }
  }

  // ---- timestamp ordering -------------------------------------------------------------------------------------------------
  class TO extends Protocol {
    constructor(db) { super(db, 'to'); }
    wOf(it, h) { if (it.w === null) it.w = h ? this.tsOfXid(h.xmin) : 0; return it.w; }
    reject(s, detail, rule) {
      this.note(s, 'reject', { rule, detail });
      throw this.abort(s.tx, K.err(S.serialization, 'could not serialize access under timestamp ordering', { detail, hint: 'The transaction was rolled back. Run it again: it gets a new, later timestamp.' }));
    }
    readRule(s, it) {
      if (s.ts < it.w) this.reject(s, 'Transaction ' + s.id + ' (timestamp ' + s.ts + ') read ' + it.label + ', whose W-timestamp is ' + it.w + ': the value it needed is already overwritten.', 'TS(Ti) < W-timestamp(Q)');
      it.r = Math.max(it.r, s.ts);
      this.note(s, 'read', { item: it.label, rts: it.r, wts: it.w, rule: 'TS(Ti) >= W-timestamp(Q): read, R-timestamp(Q) := max(R-timestamp(Q), TS(Ti))' });
      this.op(s, 'r', it);
    }
    /** reads an UPDATE or DELETE made of rows it then did not change are reads after all */
    flush(s, ctx, all) {
      for (const [k, p] of s.pending) { if (!all && p.cid === s.tx.cid) continue; s.pending.delete(k); this.readRule(s, p.it); }
      void ctx;
    }
    *onRead(rel, tid, h, r, ctx) {
      const tx = ctx.tx;
      if (!tx || ctx.snap === 'any') return undefined;
      const s = this.st(tx);
      this.flush(s, ctx);
      let v = this.version(h, tx, ctx, rel, tid);
      if (v.dead) return false;
      const it = this.item(rel, tid, h);
      if (v.own) { if (v.visible) this.op(s, 'r', it); return v.visible; }
      this.wOf(it, h);
      if (!modifying(ctx) && s.ts < it.w) this.readRule(s, it);
      if (v.writer) {
        // the version's writer has not committed: wait for it (an older transaction), so nobody reads dirty data
        this.note(s, 'wait', { item: it.label, why: 'reads wait for the writer to commit (strict timestamp ordering)' });
        yield* this.waitFor(s, v.writer, ctx, 'commit of the writer of ' + it.label);
        const h2 = this.header(rel, tid);
        if (!h2) return false;
        v = this.version(h2, tx, ctx, rel, tid);
        if (v.dead) return false;
      }
      if (!v.visible) return false;
      if (modifying(ctx)) s.pending.set(it.key, { it, cid: tx.cid });
      else this.readRule(s, it);
      return v.visible;
    }
    *onWrite(rel, tid, ctx, mode) {
      const tx = ctx.tx;
      const s = this.st(tx);
      this.flush(s, ctx);
      const h = this.header(rel, tid);
      const it = this.item(rel, tid, h);
      this.wOf(it, h);
      void mode;
      if (ctx.locking) { s.pending.delete(it.key); this.readRule(s, it); return undefined; }
      s.pending.delete(it.key);
      if (s.ts < it.r) this.reject(s, 'Transaction ' + s.id + ' (timestamp ' + s.ts + ') wrote ' + it.label + ', which a younger transaction already read (R-timestamp ' + it.r + ').', 'TS(Ti) < R-timestamp(Q)');
      if (s.ts < it.w) {
        if (setting(tx, 'thomas_write_rule')) {
          this.note(s, 'ignore', { item: it.label, rts: it.r, wts: it.w, rule: "Thomas' write rule: TS(Ti) < W-timestamp(Q), the write is obsolete and ignored" });
          return false;
        }
        this.reject(s, 'Transaction ' + s.id + ' (timestamp ' + s.ts + ') wrote ' + it.label + ', which a younger transaction already wrote (W-timestamp ' + it.w + ').', 'TS(Ti) < W-timestamp(Q)');
      }
      if (it.w !== s.ts) s.wprev.push([it, it.w]);
      it.w = s.ts;
      this.note(s, 'write', { item: it.label, rts: it.r, wts: it.w, rule: 'TS(Ti) >= R-timestamp(Q) and >= W-timestamp(Q): write, W-timestamp(Q) := TS(Ti)' });
      this.op(s, 'w', it);
      return undefined;
    }
    *onInsert(rel, vals, ctx) {
      const s = this.st(ctx.tx);
      this.flush(s, ctx);
      if (setting(ctx.tx, 'phantom_protection')) {
        const t = this.relItem(rel);
        if (s.ts < t.r) this.reject(s, 'Transaction ' + s.id + ' (timestamp ' + s.ts + ') inserted into ' + rel.name + ', which a younger transaction already scanned (R-timestamp ' + t.r + ').', 'TS(Ti) < R-timestamp(relation)');
        t.w = Math.max(t.w, s.ts);
      }
      this.op(s, 'w', this.newItem(rel, vals, s));
    }
    *onScan(rel, node, ctx) {
      const tx = ctx.tx;
      if (!tx || ctx.snap === 'any') return;
      const s = this.st(tx);
      this.flush(s, ctx);
      if (setting(tx, 'phantom_protection')) this.readRule(s, this.relItem(rel));
    }
    *onIndexScan(rel, node, ctx) { yield* this.onScan(rel, node, ctx); }
    *onCommit(tx, ctx) { const s = this.txs.get(tx.id); if (s) this.flush(s, ctx, true); }
    afterAbort(s) { for (const [it, prev] of s.wprev.reverse()) if (it.w === s.ts) it.w = prev; }
  }

  // ---- validation (optimistic concurrency control) ----------------------------------------------------------------------------
  class OCC extends Protocol {
    constructor(db) { super(db, 'occ'); this.done = []; }
    *onRead(rel, tid, h, r, ctx) {
      const tx = ctx.tx;
      if (!tx || ctx.snap === 'any') return undefined;
      const s = this.st(tx);
      const v = this.version(h, tx, ctx, rel, tid);
      if (v.dead) return false;
      // another transaction's writes are local to it until its write phase: the database still has the old version
      if (v.visible) this.op(s, 'r', this.item(rel, tid, h));
      return v.visible;
    }
    *onWrite(rel, tid, ctx) {
      if (ctx.locking) return undefined;
      const s = this.st(ctx.tx);
      const it = this.item(rel, tid, this.header(rel, tid));
      if (!s.writes.has(it.key)) { s.writes.add(it.key); s.wlog.push(it); }
      this.note(s, 'buffer', { item: it.label, why: 'read phase: the write goes to the transaction\'s local copy' });
      return undefined;
    }
    *onInsert(rel, vals, ctx) {
      const s = this.st(ctx.tx);
      const it = this.newItem(rel, vals, s);
      s.writes.add(it.key);
      s.wlog.push(it);
      if (setting(ctx.tx, 'phantom_protection')) { const t = this.relItem(rel); if (!s.writes.has(t.key)) { s.writes.add(t.key); s.wlog.push(t); } }
    }
    *onScan(rel, node, ctx) {
      if (!ctx.tx || ctx.snap === 'any') return;
      if (setting(ctx.tx, 'phantom_protection')) this.op(this.st(ctx.tx), 'r', this.relItem(rel));
    }
    *onIndexScan(rel, node, ctx) { yield* this.onScan(rel, node, ctx); }
    /** the validation test against every transaction validated before us */
    *onCommit(tx) {
      const s = this.st(tx);
      s.validation = ++this.seq;
      const tests = [];
      const label = (k) => (this.byKey.get(k) || { label: k }).label;
      for (const k of this.done) {
        if (k.finish < s.start) { tests.push({ with: k.id, ok: true, rule: 'Finish(T' + k.id + ') < Start(T' + s.id + ')' }); continue; }
        const clash = [...k.writes].filter((x) => s.reads.has(x));
        if (!clash.length) { tests.push({ with: k.id, ok: true, rule: 'Start(T' + s.id + ') < Finish(T' + k.id + ') < Validation(T' + s.id + ') and T' + k.id + ' wrote nothing T' + s.id + ' read' }); continue; }
        tests.push({ with: k.id, ok: false, rule: 'T' + k.id + ' finished after T' + s.id + ' started and wrote ' + clash.map(label).join(', ') + ', which T' + s.id + ' read' });
        this.note(s, 'validate', { ok: false, tests });
        throw this.abort(tx, K.err(S.serialization, 'could not serialize access: validation failed', { detail: 'Transaction ' + s.id + ' read ' + clash.map(label).join(', ') + ', which transaction ' + k.id + ' wrote and committed after transaction ' + s.id + ' started.', hint: 'The transaction was rolled back. Run it again.' }));
      }
      this.note(s, 'validate', { ok: true, tests });
      // the write phase: the writes kept apart until now become the database's
      for (const it of s.wlog) this.op(s, 'w', it);
    }
    afterCommit(s) {
      s.finish = ++this.seq;
      this.done.push(s);
      let oldest = Infinity;
      for (const o of this.txs.values()) if (o.status === 'active') oldest = Math.min(oldest, o.start);
      this.done = this.done.filter((k) => k.finish > oldest);
    }
  }

  // ---- multiversion timestamp ordering -------------------------------------------------------------------------------------------
  class MVTO extends Protocol {
    constructor(db) { super(db, 'mvto'); this.rts = new Map(); }
    reject(s, detail) {
      this.note(s, 'reject', { rule: 'TS(Ti) < R-timestamp(Qk)', detail });
      throw this.abort(s.tx, K.err(S.serialization, 'could not serialize access under multiversion timestamp ordering', { detail, hint: 'The transaction was rolled back. Run it again: it gets a new, later timestamp.' }));
    }
    *onRead(rel, tid, h, r, ctx) {
      const tx = ctx.tx;
      if (!tx || ctx.snap === 'any') return undefined;
      const s = this.st(tx);
      const x = this.x;
      const mine = (xid) => xid && tx.xids.has(xid) && !x.aborted(xid);
      let w = 0;
      // the version Qk with the largest W-timestamp not above TS(Ti); a version still being written by an older
      // transaction is waited for, so nobody reads data that might roll back
      for (let round = 0; ; round++) {
        if (round > 100) return false;
        if (h.infomask & IM().XMIN_INVALID || x.aborted(h.xmin)) return false;
        const del = deleterOf(h, x);
        if (mine(h.xmin) || mine(del)) { const ok = x.satisfies(h, tx, ctx.snap, tx.combo ? tx.combo.get(K.comboKey(rel, tid)) : undefined).visible; if (ok) this.op(s, 'r', this.item(rel, tid, h), { version: s.ts }); return ok; }
        w = this.tsOfXid(h.xmin);
        if (w > s.ts) return false;
        if (x.inProgress(h.xmin)) { this.note(s, 'wait', { why: 'the version (W-timestamp ' + w + ') is not committed yet' }); yield* this.waitFor(s, h.xmin, ctx, 'commit of the version\'s writer'); h = this.header(rel, tid); if (!h) return false; continue; }
        if (del && this.tsOfXid(del) <= s.ts) {
          if (x.inProgress(del)) { this.note(s, 'wait', { why: 'the next version (W-timestamp ' + this.tsOfXid(del) + ') is not committed yet' }); yield* this.waitFor(s, del, ctx, 'commit of the next version\'s writer'); h = this.header(rel, tid); if (!h) return false; continue; }
          return false;
        }
        break;
      }
      const k = vkey(rel, tid);
      const rts = Math.max(this.rts.get(k) || 0, s.ts);
      this.rts.set(k, rts);
      const it = this.item(rel, tid, h);
      this.note(s, 'read', { item: it.label, version: w, rts, rule: 'reads the version with the largest W-timestamp <= TS(Ti); R-timestamp(Qk) := max(R-timestamp(Qk), TS(Ti))' });
      this.op(s, 'r', it, { version: w });
      return true;
    }
    *onWrite(rel, tid, ctx) {
      if (ctx.locking) return undefined;
      const tx = ctx.tx;
      const s = this.st(tx);
      const h = this.header(rel, tid);
      const it = this.item(rel, tid, h);
      const rts = this.rts.get(vkey(rel, tid)) || 0;
      const w = h ? this.tsOfXid(h.xmin) : 0;
      if (s.ts < rts) this.reject(s, 'Transaction ' + s.id + ' (timestamp ' + s.ts + ') wrote ' + it.label + ', but a younger transaction already read the version it replaces (R-timestamp ' + rts + ').');
      const del = h ? deleterOf(h, this.x) : 0;
      if (del && !tx.xids.has(del)) this.reject(s, 'Transaction ' + s.id + ' (timestamp ' + s.ts + ') wrote ' + it.label + ', which already has a later version.');
      this.note(s, 'write', { item: it.label, version: s.ts, replaces: w, rule: w === s.ts ? 'TS(Ti) = W-timestamp(Qk): overwrite' : 'a new version with W-timestamp = R-timestamp = TS(Ti)' });
      this.op(s, 'w', it, { version: s.ts });
      return undefined;
    }
    *onInsert(rel, vals, ctx) { const s = this.st(ctx.tx); this.op(s, 'w', this.newItem(rel, vals, s), { version: s.ts }); }
  }

  function make(name, db) {
    const n = String(name).toLowerCase().replace(/[\s_-]/g, '');
    switch (n) {
      case 'mvcc': return null;
      case '2pl': case 'basic2pl': return new Locking(db, '2pl', 'all');
      case 'strict2pl': return new Locking(db, 'strict2pl', 'shared');
      case 'rigorous2pl': return new Locking(db, 'rigorous2pl', 'none');
      case 'to': case 'timestamp': return new TO(db);
      case 'occ': case 'validation': return new OCC(db);
      case 'mvto': return new MVTO(db);
      case 'mv2pl': return new MV2PL(db);
    }
    throw K.err(S.invalidParameter, 'invalid value for parameter "concurrency_control": "' + name + '"', { hint: 'Available values: ' + NAMES.join(', ') + '.' });
  }

  // SELECT lock_point(): the transaction declares that it has acquired every lock it needs (two-phase locking)
  if (K.F) {
    K.F.fn('lock_point', { args: [], ret: 'text', volatile: true, fn: (v, ctx) => {
      const db = ctx && ctx.db, tx = ctx && ctx.tx;
      if (!db || !tx) return null;
      return db.protocol ? db.protocol.lockPoint(tx) : 'concurrency_control is mvcc: there is no lock point';
    } });
    // SELECT cc_schedule(): the history the protocol produced, as a schedule for the workbench
    K.F.fn('cc_schedule', { args: [], ret: 'text', volatile: true, fn: (v, ctx) => (ctx && ctx.db && ctx.db.protocol ? ctx.db.protocol.schedule() : null) });
  }

  K.Protocols = { make, names: NAMES, settings: DEFAULTS, Protocol, Locking, TO, OCC, MVTO, MV2PL };
})(typeof window !== 'undefined' ? window : globalThis);
