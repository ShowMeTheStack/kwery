// The lock manager: table locks in PostgreSQL's eight modes, row locks in its four, the classic shared
// and exclusive locks on data items (for two-phase locking), and the intention modes of multiple-granularity
// locking (IS, IX, S, SIX, X on the database and its tables). A request that conflicts with a lock another
// transaction holds waits; the waits form a wait-for graph, and a cycle in it is a deadlock. The setting
// deadlock_handling chooses what happens instead of waiting forever: 'detect' (the wait-for graph, the
// default), 'wait-die', 'wound-wait' (timestamp-based prevention schemes) or 'timeout'.
(function (root) {
  'use strict';
  const K = root.K;
  const S = K.STATE;

  // table lock modes, weakest first, and which modes each conflicts with (PostgreSQL's table 13.2)
  const TABLE = ['access share', 'row share', 'row exclusive', 'share update exclusive', 'share', 'share row exclusive', 'exclusive', 'access exclusive'];
  const TCONF = {
    'access share': ['access exclusive'],
    'row share': ['exclusive', 'access exclusive'],
    'row exclusive': ['share', 'share row exclusive', 'exclusive', 'access exclusive'],
    'share update exclusive': ['share update exclusive', 'share', 'share row exclusive', 'exclusive', 'access exclusive'],
    share: ['row exclusive', 'share update exclusive', 'share row exclusive', 'exclusive', 'access exclusive'],
    'share row exclusive': ['row exclusive', 'share update exclusive', 'share', 'share row exclusive', 'exclusive', 'access exclusive'],
    exclusive: ['row share', 'row exclusive', 'share update exclusive', 'share', 'share row exclusive', 'exclusive', 'access exclusive'],
    'access exclusive': TABLE.slice(),
  };
  // row lock modes (SELECT ... FOR KEY SHARE / SHARE / NO KEY UPDATE / UPDATE; UPDATE and DELETE take the last two)
  const RCONF = {
    'key share': ['update'],
    share: ['no key update', 'update'],
    'no key update': ['share', 'no key update', 'update'],
    update: ['key share', 'share', 'no key update', 'update'],
  };
  // the lock-compatibility matrix of shared and exclusive locks: S with S only
  const ICONF = { S: ['X'], X: ['S', 'X'] };
  // multiple granularity: intention shared, intention exclusive, shared,
  // shared and intention exclusive, exclusive
  const GMODES = ['IS', 'IX', 'S', 'SIX', 'X'];
  const GCONF = { IS: ['X'], IX: ['S', 'SIX', 'X'], S: ['IX', 'SIX', 'X'], SIX: ['IX', 'S', 'SIX', 'X'], X: ['IS', 'IX', 'S', 'SIX', 'X'] };
  // the least mode at least as strong as both (holding S and asking for IX means holding SIX)
  const gsup = (a, b) => { if (!a) return b; if (!b || a === b) return a; if (a === 'X' || b === 'X') return 'X'; if (a === 'IS') return b; if (b === 'IS') return a; return 'SIX'; };
  const MATRIX = { table: TCONF, row: RCONF, item: ICONF, granular: GCONF };
  const conflicts = (kind, a, b) => (MATRIX[kind] || ICONF)[a].includes(b);
  const STRENGTH = { 'key share': 0, share: 1, 'no key update': 2, update: 3, S: 0, X: 1 };

  // settings are per session; a missing one falls back to the database's, then to the default
  const setting = (tx, name, dflt) => { const s = tx && tx.session && tx.session.settings; const v = s && s[name] !== undefined ? s[name] : tx && tx.session && tx.session.db.settings[name]; return v === undefined || v === null ? dflt : v; };
  /** a duration setting in milliseconds: a number, or text such as '1s', '250ms', '2min' */
  function millis(v) {
    if (typeof v === 'number') return v;
    const m = /^\s*([\d.]+)\s*(ms|s|min|h)?\s*$/i.exec(String(v || ''));
    if (!m) return 0;
    return Number(m[1]) * ({ ms: 1, s: 1000, min: 60000, h: 3600000 }[(m[2] || 'ms').toLowerCase()]);
  }
  /** a transaction's timestamp for wait-die and wound-wait: when it began (each transaction has its own) */
  const tsOf = (tx) => (tx.lockTs !== undefined ? tx.lockTs : tx.id);
  const now = () => (K.Clock ? K.Clock.now() : Date.now() * 1000) / 1000;

  class LockManager {
    constructor(db) {
      this.db = db;
      this.locks = new Map();   // tag -> { tag, kind, what, granted: [{ tx, mode }], queue: [{ tx, mode }] }
      this.waiting = new Map(); // tx -> { tag, mode, holders }
    }
    entry(tag, kind, what) { let e = this.locks.get(tag); if (!e) { e = { tag, kind, what, granted: [], queue: [] }; this.locks.set(tag, e); } return e; }
    held(e, tx) { const g = e.granted.find((x) => x.tx === tx); return g ? g.mode : null; }
    /** the transactions whose locks block tx getting mode on e */
    blockers(e, tx, mode) {
      const out = [];
      for (const g of e.granted) if (g.tx !== tx && conflicts(e.kind, mode, g.mode)) out.push(g.tx);
      // first come, first served: a waiter ahead in the queue with a conflicting request goes first, except
      // that a transaction already holding the lock (an upgrade) goes ahead of the queue, as in PostgreSQL
      if (e.kind !== 'table' && e.granted.some((g) => g.tx === tx)) return out;
      for (const q of e.queue) { if (q.tx === tx) break; if (conflicts(e.kind, mode, q.mode) && !out.includes(q.tx)) out.push(q.tx); }
      return out;
    }
    holds(e, tx, mode) {
      return e.granted.some((g) => g.tx === tx && (g.mode === mode
        || (e.kind === 'table' ? TABLE.indexOf(g.mode) >= TABLE.indexOf(mode) && TCONF[g.mode].length >= TCONF[mode].length
          : e.kind === 'granular' ? gsup(g.mode, mode) === g.mode : STRENGTH[g.mode] >= STRENGTH[mode])));
    }
    policy(tx) { return String(setting(tx, 'deadlock_handling', 'detect')).toLowerCase(); }
    /** how long a request may wait, in milliseconds (0: for ever) */
    timeout(tx) {
      const t = millis(setting(tx, 'lock_timeout', 0));
      if (t > 0) return t;
      return this.policy(tx) === 'timeout' ? millis(setting(tx, 'deadlock_timeout', '1s')) || 1000 : 0;
    }
    /**
     * the deadlock-prevention schemes, applied when tx finds its request blocked by holders: wait-die rolls the
     * requester back when it is younger than a holder; wound-wait rolls back every younger holder. Returns the
     * holders still in the way.
     */
    prevent(tx, holders, what, mode) {
      const p = this.policy(tx);
      if (p === 'wait-die') {
        const older = holders.filter((h) => tsOf(h) < tsOf(tx));
        if (older.length) {
          const h = older[0];
          const e = K.err(S.deadlock, 'transaction rolled back to prevent a deadlock (wait-die)', { detail: 'Transaction ' + tx.id + ' (timestamp ' + tsOf(tx) + ') requested ' + mode + ' lock on ' + what + ', held by older transaction ' + h.id + ' (timestamp ' + tsOf(h) + '); a younger transaction does not wait for an older one, it dies.', hint: 'Run the transaction again.' });
          this.db.bus.emit('cc.die', { tx: tx.id, ts: tsOf(tx), holder: h.id, holderTs: tsOf(h), what, mode });
          throw e;
        }
      } else if (p === 'wound-wait') {
        for (const h of holders) {
          if (tsOf(tx) >= tsOf(h) || h.killed) continue;
          // the wounded transaction learns it at its next statement (or at once, if it is waiting)
          const e = K.err(S.deadlock, 'transaction ' + h.id + ' was wounded by older transaction ' + tx.id + ' and rolled back (wound-wait)', { detail: 'Transaction ' + h.id + ' (timestamp ' + tsOf(h) + ') held a lock on ' + what + ' that older transaction ' + tx.id + ' (timestamp ' + tsOf(tx) + ') requested in ' + mode + ' mode. Under wound-wait an older transaction does not wait for a younger one: it wounds it.', hint: 'Run the transaction again.' });
          e.tellVictim = true;
          this.db.bus.emit('cc.wound', { tx: tx.id, ts: tsOf(tx), victim: h.id, victimTs: tsOf(h), what, mode });
          this.abortNow(h, e);
        }
        return holders.filter((h) => !h.killed);
      }
      return holders;
    }
    /**
     * acquire a lock (a generator: it yields a wait signal while the lock is not available).
     * tag names the object: 'table:<oid>', 'row:<file>:<block>:<item>', 'item:<name>', 'gran:<name>'
     */
    *acquire(tx, tag, kind, mode, opts) {
      opts = opts || {};
      const e = this.entry(tag, kind, opts.what || tag);
      if (this.holds(e, tx, mode)) return true;
      // a granular request asks for the least mode covering what it holds and what it wants
      const want = kind === 'granular' ? gsup(this.held(e, tx), mode) : mode;
      const what = opts.what || tag;
      let queued = false;
      const limit = this.timeout(tx);
      const since = now();
      const leave = () => { if (queued) e.queue = e.queue.filter((q) => q.tx !== tx); queued = false; this.waiting.delete(tx); };
      let granted = false;
      // a statement cancelled while it waits (a deadlock victim) leaves the queue
      try {
        for (;;) {
          if (tx.killed) { leave(); throw K.reportKilled(tx); }
          let b = this.blockers(e, tx, want);
          if (b.length) b = this.prevent(tx, b, what, want);
          if (!b.length) b = this.blockers(e, tx, want);
          if (!b.length) break;
          if (opts.nowait) { leave(); throw K.err(S.lockNotAvailable, 'could not obtain lock on ' + (kind === 'row' ? 'row in relation "' + (opts.relName || '') + '"' : what)); }
          if (opts.skipLocked) { leave(); return false; }
          if (limit && now() - since >= limit) { leave(); this.db.bus.emit('lock.timeout', { tx: tx.id, tag, mode: want, what }); throw K.err(S.lockNotAvailable, 'canceling statement due to lock timeout', { detail: 'Waited ' + limit + ' ms for ' + want + ' lock on ' + what + '.' }); }
          if (!queued) { e.queue.push({ tx, mode: want }); queued = true; }
          this.waiting.set(tx, { tag, mode: want, kind, holders: b, what });
          this.db.bus.emit('lock.wait', { tx: tx.id, xid: tx.xid, tag, mode: want, holders: b.map((h) => h.id), what });
          yield { signal: 'wait', tx, on: { lock: tag, mode: want, what, holders: b }, ready: () => !!tx.killed || !this.blockers(e, tx, want).length || (limit > 0 && now() - since >= limit), why: 'waits for ' + want + ' lock on ' + what };
        }
        granted = true;
      } finally { if (!granted && queued) leave(); }
      leave();
      // upgrade in place: keep only the strongest mode a transaction holds on a row, item or granule
      if (kind === 'granular') e.granted = e.granted.filter((g) => g.tx !== tx);
      else if (kind !== 'table') e.granted = e.granted.filter((g) => g.tx !== tx || STRENGTH[g.mode] > STRENGTH[want]);
      if (!this.holds(e, tx, want)) e.granted.push({ tx, mode: want });
      if (!tx.locks) tx.locks = new Set();
      tx.locks.add(tag);
      this.db.bus.emit('lock.grant', { tx: tx.id, xid: tx.xid, tag, mode: want, what });
      return true;
    }
    /** record a lock as held without asking (a row a transaction inserted is its own from the start) */
    grantDirect(tx, tag, kind, mode, what) {
      const e = this.entry(tag, kind, what || tag);
      if (this.holds(e, tx, mode)) return;
      e.granted = e.granted.filter((g) => g.tx !== tx);
      e.granted.push({ tx, mode });
      if (!tx.locks) tx.locks = new Set();
      tx.locks.add(tag);
      this.db.bus.emit('lock.grant', { tx: tx.id, xid: tx.xid, tag, mode, what: what || tag });
    }
    /** release one lock (early release, for the non-two-phase protocols) */
    release(tx, tag) {
      const e = this.locks.get(tag);
      if (!e) return;
      e.granted = e.granted.filter((g) => g.tx !== tx);
      if (tx.locks) tx.locks.delete(tag);
      if (!e.granted.length && !e.queue.length) this.locks.delete(tag);
      this.db.bus.emit('lock.release', { tx: tx.id, tag });
    }
    /** at commit or abort: every lock goes (strict two-phase locking) */
    releaseAll(tx) {
      for (const tag of [...(tx.locks || [])]) this.release(tx, tag);
      for (const e of this.locks.values()) e.queue = e.queue.filter((q) => q.tx !== tx);
      this.waiting.delete(tx);
      if (tx.locks) tx.locks.clear();
    }
    /**
     * roll a transaction back at once (a deadlock victim, a wounded transaction, a failed timestamp test):
     * its work is undone and its locks released now, as PostgreSQL does on any error; the session still has to
     * say ROLLBACK, and until then its statements fail. A transaction parked on a lock wakes up and fails.
     */
    abortNow(tx, err) {
      if (!tx || tx.abortedNow) return;
      tx.abortedNow = true;
      tx.killed = err;
      tx.failed = true;
      for (const x of tx.xids || []) if (!this.db.xact.aborted(x)) this.db.xact.setStatus(x, K.XSTATUS.ABORTED);
      if (this.db.protocol && this.db.protocol.onAbort) this.db.protocol.onAbort(tx);
      if (K.SSI && K.SSI.onEnd) K.SSI.onEnd(this.db, tx, 'abort');
      this.releaseAll(tx);
      this.db.bus.emit('cc.rollback', { tx: tx.id, xid: tx.xid, reason: err ? err.message : null });
    }
    /** a waiting transaction that is part of a cycle in the wait-for graph: returns the cycle, or null */
    deadlock(tx) {
      // with deadlock_handling = 'timeout' nobody looks for cycles: waits simply time out
      if (this.policy(tx) === 'timeout') return null;
      const edges = (t) => { const w = this.waiting.get(t) || (t.waitXid ? { holders: t.waitXid() } : null); return w ? w.holders : []; };
      const path = [];
      const seen = new Set();
      const dfs = (t) => {
        if (t === tx && path.length) return true;
        if (seen.has(t)) return false;
        seen.add(t);
        path.push(t);
        for (const h of edges(t)) if (dfs(h)) return true;
        path.pop();
        return false;
      };
      return dfs(tx) ? path.slice() : null;
    }
    /** the wait-for graph: an edge from each waiting transaction to each transaction it waits for */
    waitsFor() {
      const out = [];
      for (const [t, w] of this.waiting) for (const h of w.holders) out.push({ from: t.id, to: h.id, what: w.what, mode: w.mode });
      // a writer waiting for another transaction to finish (a row it changes, a key it inserts) waits on that
      // transaction's xid, as PostgreSQL's ShareLock on a transactionid
      for (const s of this.db.sessions || []) {
        const t = s.tx;
        if (!t || !t.waitXid || this.waiting.has(t)) continue;
        for (const h of t.waitXid()) out.push({ from: t.id, to: h.id, what: t.waitXidWhat ? t.waitXidWhat.what : 'transaction ' + h.xid, mode: 'ShareLock', xid: t.waitXidWhat ? t.waitXidWhat.xid : h.xid });
      }
      return out;
    }
    describe() {
      // pid: the session running the transaction; a prepared transaction belongs to no session
      const pid = (tx) => (tx.session && !tx.prepared ? tx.session.id : null);
      return [...this.locks.values()].map((e) => ({ tag: e.tag, kind: e.kind, what: e.what, granted: e.granted.map((g) => ({ tx: g.tx.id, xid: g.tx.xid, mode: g.mode, pid: pid(g.tx) })), queue: e.queue.map((q) => ({ tx: q.tx.id, xid: q.tx.xid, mode: q.mode, pid: pid(q.tx) })) }));
    }
  }

  /** the error a transaction rolled back by another one gets: once as itself, then as an aborted transaction */
  K.reportKilled = (tx) => { tx.killedReported = true; return tx.killed; };
  K.LockManager = LockManager;
  K.LOCK_MODES = { TABLE, TCONF, RCONF, ICONF, GMODES, GCONF, gsup };
  K.lockSetting = setting;
  K.lockMillis = millis;
  K.lockTs = tsOf;
})(typeof window !== 'undefined' ? window : globalThis);
