// Concurrency control for rows: which version a statement sees, and what happens when two transactions
// change the same row. The default is PostgreSQL's: multiversion reads that never wait, and writers that wait
// for a row's earlier writer to finish. Then, under READ COMMITTED, the statement carries on with the newest
// version (re-checking its WHERE clause); under REPEATABLE READ and SERIALIZABLE it fails with a serialization
// error, as snapshot isolation must.
(function (root) {
  'use strict';
  const K = root.K;
  const S = K.STATE;
  const IM = () => K.Tuple.IM;

  const rowTag = (rel, tid) => 'row:' + rel.file + ':' + tid.b + ':' + tid.o;
  const comboKey = (rel, tid) => rel.file + ':' + tid.b + ':' + tid.o;

  class MVCC {
    constructor(db) { this.db = db; }
    get x() { return this.db.xact; }
    /** is this version visible to the statement? (a generator, so other protocols can wait for read locks) */
    *visible(rel, tid, h, bytes, ctx) {
      const tx = ctx.tx;
      if (ctx.snap === 'any') return true;
      const r = this.x.satisfies(h, tx, ctx.snap, tx && tx.combo ? tx.combo.get(comboKey(rel, tid)) : undefined);
      if (ctx.traceVis) ctx.traceVis(rel, tid, h, r);
      // one event per version judged: only built when someone subscribes to mvcc.read by name
      if (ctx.db.bus.wants('mvcc.read')) ctx.db.bus.emit('mvcc.read', { tx: tx ? tx.id : null, xid: tx ? tx.xid : null, rel: rel.name, tid: '(' + tid.b + ',' + tid.o + ')', xmin: h.xmin, xmax: h.xmax, visible: r.visible, why: r.why });
      if (ctx.db.protocol && ctx.db.protocol.onRead) { const ok = yield* ctx.db.protocol.onRead(rel, tid, h, r, ctx); if (ok === false) return false; if (ok === true) return true; }
      if (tx && tx.isolation === 'serializable' && K.SSI) yield* K.SSI.onRead(ctx.db, rel, tid, h, r, ctx);
      return r.visible;
    }
    /** can visibility be decided without a protocol taking part (no waits, no read tracking)? then visibleNow is enough */
    plain(ctx) { return !ctx.db.protocol && !(ctx.tx && ctx.tx.isolation === 'serializable' && K.SSI) && !ctx.traceVis && ctx.snap !== 'any' && !ctx.db.bus.wants('mvcc.read'); }
    visibleNow(rel, tid, h, ctx) { const tx = ctx.tx; return this.x.satisfies(h, tx, ctx.snap, tx && tx.combo ? tx.combo.get(comboKey(rel, tid)) : undefined).visible; }
    /** wait until a transaction is no longer running */
    *waitXid(xid, ctx, what) {
      const top = this.x.top(xid);
      const holder = this.db.txOfXid(top);
      const tx = ctx.tx;
      const locks = this.db.locks;
      const limit = locks.timeout(tx);
      const since = K.Clock.now() / 1000;
      const late = () => limit > 0 && K.Clock.now() / 1000 - since >= limit;
      tx.waitXid = () => (holder ? [holder] : []);
      tx.waitXidWhat = { xid: top, what };
      try {
        while (this.x.inProgress(top)) {
          if (tx.killed) throw K.reportKilled(tx);
          // wait-die and wound-wait apply to waiting for a transaction as to waiting for a lock
          if (holder) locks.prevent(tx, [holder], what, 'ShareLock on transaction ' + top);
          if (!this.x.inProgress(top)) break;
          if (late()) { this.db.bus.emit('lock.timeout', { tx: tx.id, waitsFor: top, what }); throw K.err(S.lockNotAvailable, 'canceling statement due to lock timeout', { detail: 'Waited ' + limit + ' ms for transaction ' + top + ' (' + what + ').' }); }
          this.db.bus.emit('lock.wait', { tx: tx.id, xid: tx.xid, waitsFor: top, what });
          yield { signal: 'wait', tx, on: { xid: top, what, holders: holder ? [holder] : [] }, ready: () => !this.x.inProgress(top) || !!tx.killed || late(), why: 'waits for transaction ' + top + ' to finish (' + what + ')' };
        }
      } finally { tx.waitXid = null; tx.waitXidWhat = null; }
    }
    /**
     * before changing or locking the row version at tid: wait for whoever is changing it, then decide.
     * Returns { ok, tid } to go ahead on (possibly a newer) version, { gone } if the row was deleted, or
     * { moved: newTid } under READ COMMITTED when it was updated (the caller re-checks its conditions).
     */
    *prepareModify(rel, tid, ctx, mode, what) {
      const heap = this.db.heap(rel);
      const tx = ctx.tx;
      // the row lock first: a conflicting writer holds it until it ends
      if (this.db.protocol && this.db.protocol.onWrite) { const ok = yield* this.db.protocol.onWrite(rel, tid, ctx, mode); if (ok === false) return { gone: true }; }
      const got = yield* this.db.locks.acquire(tx, rowTag(rel, tid), 'row', mode, { what: 'row (' + tid.b + ',' + tid.o + ') of ' + rel.name, relName: rel.name, nowait: ctx.nowait, skipLocked: ctx.skipLocked });
      if (got === false) return false;
      for (;;) {
        const t = heap.fetch(tid);
        if (!t) return { gone: true };
        const h = K.Tuple.header(t.bytes);
        this.db.buffers.unpin(t.frame, false);
        const xmax = h.xmax && !(h.infomask & IM().XMAX_INVALID) ? h.xmax : 0;
        if (!xmax || this.x.aborted(xmax) || h.infomask & IM().XMAX_LOCK_ONLY) {
          // the write is going ahead: SSI checks the readers' SIREAD locks now, after any wait (as heap_update
          // does); a row lock (FOR UPDATE, FOR SHARE) is not a write and takes no part
          if (tx.isolation === 'serializable' && K.SSI && !ctx.locking) yield* K.SSI.onWrite(this.db, rel, tid, ctx);
          return { ok: true, tid, h };
        }
        if (tx.xids.has(xmax)) {
          // already changed by this transaction: by an earlier command it is gone; by this very command it is skipped
          return { gone: true, self: true };
        }
        if (this.x.inProgress(xmax)) { yield* this.waitXid(xmax, ctx, what || 'row (' + tid.b + ',' + tid.o + ') of ' + rel.name); continue; }
        // the other transaction committed its change
        const updated = !(h.ctid.b === tid.b && h.ctid.o === tid.o);
        // under the classic single-version protocols there is no snapshot to be stale: carry on with the newest version
        if (tx.isolation !== 'read committed' && tx.isolation !== 'read uncommitted' && !this.db.protocol) {
          this.db.bus.emit('cc.conflict', { tx: tx.id, rel: rel.name, tid, by: xmax });
          throw K.err(S.serialization, 'could not serialize access due to concurrent ' + (updated ? 'update' : 'delete'), { detail: 'Transaction ' + xmax + ' changed row (' + tid.b + ',' + tid.o + ') of ' + rel.name + ' after this transaction took its snapshot.' });
        }
        if (!updated) return { gone: true };
        this.db.bus.emit('cc.recheck', { tx: tx.id, rel: rel.name, from: tid, to: h.ctid });
        return { moved: h.ctid };
      }
    }
    /** the newest version of a row (following update chains to the version no committed transaction replaced) */
    latest(rel, tid) {
      const heap = this.db.heap(rel);
      for (let n = 0; n < 1000; n++) {
        const t = heap.fetch(tid);
        if (!t) return null;
        const h = K.Tuple.header(t.bytes);
        this.db.buffers.unpin(t.frame, false);
        const xmax = h.xmax && !(h.infomask & IM().XMAX_INVALID) && !(h.infomask & IM().XMAX_LOCK_ONLY) ? h.xmax : 0;
        if (!xmax || this.x.aborted(xmax) || (h.ctid.b === tid.b && h.ctid.o === tid.o)) return { tid, h };
        tid = h.ctid;
      }
      return null;
    }
    /** mark a version deleted (or replaced) by this transaction's current command */
    markDeleted(rel, tid, ctx, newTid) {
      const tx = ctx.tx;
      const xid = this.db.writeXid(ctx);
      const heap = this.db.heap(rel);
      heap.mark(tid, (bytes) => {
        const h = K.Tuple.header(bytes);
        // the header has one command id: when this transaction inserted the row too, keep the inserting one aside
        if (tx.xids.has(h.xmin)) { if (!tx.combo) tx.combo = new Map(); if (!tx.combo.has(comboKey(rel, tid))) tx.combo.set(comboKey(rel, tid), h.cid); }
        K.Tuple.setXmax(bytes, xid, newTid ? IM().UPDATED : 0);
        K.Tuple.setCid(bytes, tx.cid);
        if (newTid) K.Tuple.setCtid(bytes, newTid.b, newTid.o);
      }, { xid, type: newTid ? 'heap.update' : 'heap.delete', newTid: newTid || null });
      this.db.bus.emit(newTid ? 'heap.update' : 'heap.delete', { rel: rel.name, tid, newTid, xid });
      // the new version is the same data item for the classic protocols; for SSI it may land in index pages
      if (newTid && this.db.protocol && this.db.protocol.onReplace) this.db.protocol.onReplace(rel, tid, newTid, ctx);
      if (newTid && tx.isolation === 'serializable' && K.SSI && K.SSI.onNewVersion) K.SSI.onNewVersion(this.db, rel, tid, newTid, ctx);
    }
    /** SELECT ... FOR UPDATE / FOR SHARE: lock the version the statement saw (or its newest version under READ COMMITTED) */
    *lockRow(rel, tid, locking, ctx) {
      const mode = locking.mode || 'update';
      const c = Object.assign({}, ctx, { nowait: locking.wait === 'nowait', skipLocked: locking.wait === 'skip', locking: true });
      for (let n = 0; n < 100; n++) {
        const r = yield* this.prepareModify(rel, tid, c, mode, 'lock of row (' + tid.b + ',' + tid.o + ') of ' + rel.name);
        if (r === false) return false;
        if (r.gone) return !!r.self;
        if (r.ok) return true;
        tid = r.moved;
      }
      return false;
    }
  }

  K.MVCC = MVCC;
  K.rowTag = rowTag;
  K.comboKey = comboKey;
})(typeof window !== 'undefined' ? window : globalThis);
