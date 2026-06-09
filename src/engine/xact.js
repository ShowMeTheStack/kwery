// Transactions: ids, the commit log (what became of every transaction), subtransactions for savepoints,
// snapshots, and the rules that decide which version of a row a transaction sees (multiversion concurrency
// control, as in PostgreSQL). Locking protocols for the classic schemes live in locks.js and cc.js.
(function (root) {
  'use strict';
  const K = root.K;
  const IM = () => K.Tuple.IM;

  const STATUS = { INPROGRESS: 'in progress', COMMITTED: 'committed', ABORTED: 'aborted', SUBCOMMITTED: 'sub-committed' };
  const FIRST_XID = 3; // 1 = bootstrap, 2 = frozen, as in PostgreSQL

  class XactManager {
    constructor(db) {
      this.db = db;
      this.next = FIRST_XID;
      this.clog = new Map();       // xid -> status
      this.parent = new Map();     // subtransaction xid -> parent xid
      this.active = new Map();     // top-level xid -> transaction object
      this.commitSeq = 0;          // commit order, for snapshot isolation conflict checks
      this.commitOrder = new Map();
    }
    /** assign a new xid (top-level, or a subtransaction under parent) */
    assign(parent) {
      const xid = this.next++;
      this.clog.set(xid, STATUS.INPROGRESS);
      if (parent) this.parent.set(xid, parent);
      this.db.bus.emit('xact.assign', { xid, parent: parent || null });
      return xid;
    }
    top(xid) { while (this.parent.has(xid)) xid = this.parent.get(xid); return xid; }
    /** the effective fate of an xid: a sub-committed subtransaction shares its top transaction's fate */
    status(xid) {
      if (xid === 2 || xid === 1) return STATUS.COMMITTED;
      let s = this.clog.get(xid);
      if (s === undefined) return xid < this.next ? STATUS.ABORTED : STATUS.INPROGRESS;
      // a subtransaction under a rolled-back savepoint is aborted, even one released before the rollback
      if (s === STATUS.INPROGRESS || s === STATUS.SUBCOMMITTED) for (let p = this.parent.get(xid); p; p = this.parent.get(p)) if (this.clog.get(p) === STATUS.ABORTED) return STATUS.ABORTED;
      while (s === STATUS.SUBCOMMITTED) { xid = this.parent.get(xid); s = this.clog.get(xid); }
      return s;
    }
    setStatus(xid, s) { this.clog.set(xid, s); if (s === STATUS.COMMITTED) this.commitOrder.set(xid, ++this.commitSeq); this.db.bus.emit('xact.status', { xid, status: s }); }
    committed(xid) { return this.status(xid) === STATUS.COMMITTED; }
    aborted(xid) { return this.status(xid) === STATUS.ABORTED; }
    inProgress(xid) { return this.status(xid) === STATUS.INPROGRESS; }
    /** a snapshot: every xid below xmin is finished, every xid at or above xmax had not started, and xip lists the running ones between */
    snapshot(self) {
      const running = [];
      for (const [xid, s] of this.clog) if (s === STATUS.INPROGRESS || s === STATUS.SUBCOMMITTED && this.inProgress(this.top(xid))) running.push(xid);
      const xmax = this.next;
      const xmin = running.length ? Math.min(...running) : xmax;
      const snap = { xmin, xmax, xip: new Set(running.filter((x) => !self || this.top(x) !== this.top(self))), taken: this.commitSeq };
      this.db.bus.emit('xact.snapshot', { xmin, xmax, xip: [...snap.xip] });
      return snap;
    }
    /** is xid's work visible in snapshot s? (committed before the snapshot was taken) */
    visibleIn(xid, s) {
      if (xid < FIRST_XID) return true;
      if (xid >= s.xmax) return false;
      if (s.xip.has(xid) || s.xip.has(this.top(xid))) return false;
      return this.committed(xid);
    }
    /**
     * HeapTupleSatisfiesMVCC: is this row version visible to transaction tx (with its snapshot and command id)?
     * Returns { visible, why } so the transactions view can say why a version was or was not seen.
     */
    satisfies(h, tx, snap, cmin) {
      const mine = (x) => x && tx && tx.xids.has(x) && !this.aborted(x);
      // who inserted it
      if (h.infomask & IM().XMIN_INVALID || this.aborted(h.xmin)) return { visible: false, why: 'inserted by transaction ' + h.xmin + ', which aborted' };
      const deleter = h.xmax !== 0 && !(h.infomask & IM().XMAX_INVALID) && !(h.infomask & IM().XMAX_LOCK_ONLY) && !this.aborted(h.xmax) ? h.xmax : 0;
      if (mine(h.xmin)) {
        // the tuple header has one command id: the inserting command's, unless this transaction also deleted it,
        // when the header holds the deleting command's and the inserting one is kept aside (a "combo" id)
        const ins = cmin !== undefined ? cmin : deleter && mine(deleter) ? 0 : h.cid;
        if (ins >= tx.cid) return { visible: false, why: 'inserted by this statement (command ' + ins + '), which does not see its own changes' };
      } else if (!this.visibleIn(h.xmin, snap)) {
        return { visible: false, why: this.inProgress(h.xmin) ? 'inserted by transaction ' + h.xmin + ', which has not committed' : 'inserted by transaction ' + h.xmin + ', which committed after the snapshot was taken' };
      }
      // who deleted it
      if (!deleter) return { visible: true, why: h.xmax && this.aborted(h.xmax) ? 'deleted by transaction ' + h.xmax + ', which aborted' : 'live' };
      if (mine(deleter)) return h.cid >= tx.cid ? { visible: true, why: 'deleted by this statement, which still sees it' } : { visible: false, why: 'deleted earlier in this transaction' };
      if (!this.visibleIn(deleter, snap)) return { visible: true, why: this.inProgress(deleter) ? 'being deleted by transaction ' + deleter + ', not yet committed' : 'deleted by transaction ' + deleter + ' after the snapshot' };
      return { visible: false, why: 'deleted by transaction ' + deleter };
    }
    /** for VACUUM: a version is dead when its deleter committed before every running snapshot */
    deadToAll(h, horizon) {
      if (h.infomask & IM().XMIN_INVALID || this.aborted(h.xmin)) return true;
      if (h.xmax === 0 || h.infomask & IM().XMAX_LOCK_ONLY || this.aborted(h.xmax)) return false;
      return this.committed(h.xmax) && h.xmax < horizon;
    }
    /** the oldest xmin of any running transaction's snapshot: versions deleted before it can go */
    horizon() {
      let h = this.next;
      for (const tx of this.active.values()) { if (tx.snapshot) h = Math.min(h, tx.snapshot.xmin); h = Math.min(h, tx.xid || h); }
      return h;
    }
    /**
     * after a crash: the commit log as the stable log tells it. fates: { status: Map xid -> status, parent: Map,
     * commits: [xid in commit order], next }. The xid counter never goes back (PostgreSQL keeps it in pg_control).
     */
    rebuild(f) {
      this.clog = new Map(f.status);
      this.parent = new Map(f.parent);
      this.active.clear();
      this.commitOrder = new Map(); this.commitSeq = 0;
      for (const x of f.commits) this.commitOrder.set(x, ++this.commitSeq);
      this.next = Math.max(this.next, f.next || FIRST_XID);
      this.db.bus.emit('xact.rebuilt', { next: this.next, xids: this.clog.size });
    }
    describe() { return { next: this.next, clog: [...this.clog.entries()].map(([x, s]) => ({ xid: x, status: s, parent: this.parent.get(x) || null })) }; }
  }

  K.XactManager = XactManager;
  K.XSTATUS = STATUS;
  K.FIRST_XID = FIRST_XID;
})(typeof window !== 'undefined' ? window : globalThis);
