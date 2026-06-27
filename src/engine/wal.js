// The write-ahead log. Every change to a page is described by a log record before the page may reach the
// disk. Records get a log sequence number (LSN): their byte offset in the log. The log buffer is flushed to
// stable storage at commit, when it fills (wal_buffers bytes), and whenever the buffer manager is about to write
// a page whose LSN is past the flushed point; a flush writes every buffered record, of every transaction, in one
// group. A crash loses the unflushed tail. Recovery (ARIES and the basic redo-then-undo algorithm) is in recovery.js.
//
// Record formats (every record also has lsn, size, and when it belongs to a transaction xid, prevLsn):
//   begin        { xid }                                   first write of a transaction
//   heap.insert  { xid, rel, file, block, item, bytes }    bytes: the new tuple. Redo puts it at that item;
//                                                          undo marks it invalid (XMIN_INVALID)
//   heap.delete, heap.update, heap.lock  { ..., item, bytes, before }   a tuple header changed in place:
//                                                          bytes after, before the old item. Redo writes bytes, undo before
//   heap.prune, btree.page, page.image  { file, block, image }   a whole page (redo only)
//   clr          { xid, undoes, undoNext, file, block, item, bytes, action }   compensation: written while undoing,
//                                                          redo-only; undoNext is the next record of the transaction to undo
//   commit, abort { xid } (abort with sub: a savepoint's subtransaction), end { xid }: the transaction is finished
//   checkpoint   { data: { active, txTable, dpt, redoLsn, nextXid, fuzzy } }
// A record of a subtransaction carries top (its top-level transaction), parent, and when savepoints nest ancestors
// (the subtransactions between parent and top); prevLsn chains every record of
// the top-level transaction, so undo follows one chain per transaction. The first change to a page after the page
// was read or written carries fpi, an image of the whole page after the change (full_page_writes): if the next
// write of that page is torn, redo starts again from this image.
(function (root) {
  'use strict';
  const K = root.K;
  const setting = (db, k, dflt) => (K.settingOf ? K.settingOf(db, k) : db && db.settings && db.settings[k] !== undefined ? db.settings[k] : dflt);
  const PAGE = (r) => r.file !== undefined && r.block !== undefined && r.file !== null;

  class WAL {
    constructor(db) {
      this.db = db;
      this.records = [];        // every record, flushed or not, in LSN order
      this.nextLsn = 1;         // LSN 0 means "none"
      this.flushedLsn = 0;      // records with lsn <= flushedLsn survive a crash
      this.lastByXid = new Map(); // top-level xid -> LSN of its last record (the prevLSN chain)
      this.touched = new Map(); // top-level xid -> pages it changed, for buffer_force
      this.enabled = true;
      this.archived = null;     // fates of transactions whose records were truncated away
      this.stats = { records: 0, bytes: 0, flushes: 0, groups: 0 };
    }
    /** the transaction a page record without an xid (an index page) is done for: the running statement's */
    owner(r) {
      if (r.xid) return r.top || r.xid;
      const s = K.currentSession;
      return s && s.db === this.db && s.tx && s.tx.xid ? s.tx.xid : 0;
    }
    /** append a record; returns its LSN */
    log(rec) {
      if (!this.enabled) return 0;
      const db = this.db;
      const r = Object.assign({}, rec);
      delete r.recovery;
      if (r.xid && db.xact) {
        const top = db.xact.top(r.xid);
        if (top !== r.xid) {
          r.top = top; r.parent = db.xact.parent.get(r.xid);
          // savepoints nest: the parent may be a subtransaction that wrote nothing itself, so the record names them all
          if (r.parent !== top) { r.ancestors = []; for (let p = r.parent; p && p !== top; p = db.xact.parent.get(p)) r.ancestors.push(p); }
        }
      }
      const owner = this.owner(r);
      if (!rec.recovery && r.xid && !r.sub) {
        if (r.type === 'commit') this.beforeCommit(owner);
        if (r.type === 'abort') this.beforeAbort(owner, r);
      }
      if (!rec.recovery && r.xid && r.sub && r.type === 'abort' && setting(db, 'rollback_undo', false) && K.Recovery) K.Recovery.rollback(db, owner, r.xid);
      if (r.type === 'checkpoint') r.data = Object.assign({}, r.data || {}, this.checkpointData(r.data && r.data.fuzzy));
      const f = PAGE(r) && db.buffers ? db.buffers.frameOf(r.file, r.block) : null;
      if (f && !r.image && !f.fpi && setting(db, 'full_page_writes', true) !== false) r.fpi = f.buf.slice();
      if (f && (r.image || r.fpi)) f.fpi = true;
      r.lsn = this.nextLsn;
      r.size = this.sizeOf(r);
      if (r.xid) { r.prevLsn = this.lastByXid.get(owner) || 0; this.lastByXid.set(owner, r.lsn); }
      this.nextLsn += r.size;
      this.records.push(r);
      this.stats.records++; this.stats.bytes += r.size;
      if (f) db.buffers.noteRecord(f, r, owner);
      if (PAGE(r) && owner) { let t = this.touched.get(owner); if (!t) this.touched.set(owner, (t = new Set())); t.add(r.file + ':' + r.block); }
      db.bus.emit('wal.append', r);
      if ((r.type === 'commit' || r.type === 'abort') && !r.sub && !rec.recovery) {
        this.touched.delete(owner);
        this.lastByXid.delete(owner);
        // the transaction is over: commit processing (or its rollback) is complete
        const e = { xid: r.xid, type: 'end' };
        e.lsn = this.nextLsn; e.size = this.sizeOf(e); e.prevLsn = r.lsn;
        this.nextLsn += e.size; this.records.push(e); this.stats.records++; this.stats.bytes += e.size;
        db.bus.emit('wal.append', e);
      }
      const limit = setting(db, 'wal_buffers', 65536);
      if (limit && this.nextLsn - 1 - this.flushedLsn > limit) this.flush(undefined, 'the log buffer (' + limit + ' bytes) is full');
      return r.lsn;
    }
    /** buffer_force: every page the transaction changed goes to disk before its commit record is written */
    beforeCommit(owner) {
      const db = this.db;
      if (setting(db, 'buffer_force', false) !== true) return;
      const pages = this.touched.get(owner);
      if (!pages) return;
      for (const k of pages) {
        const [file, block] = k.split(':').map(Number);
        const f = db.buffers.frameOf(file, block);
        if (f && f.dirty) {
          for (const x of f.xids) if (x !== owner && db.xact.inProgress(x)) db.bus.emit('buf.force.steal', { file, block, xid: x });
          db.buffers.write(f);
        }
      }
      db.bus.emit('buf.force', { xid: owner, pages: pages.size });
    }
    /** rollback_undo: undo the transaction's changes on the pages now (with compensation records), as the basic algorithm rolls back */
    beforeAbort(owner) {
      if (setting(this.db, 'rollback_undo', false) && K.Recovery) K.Recovery.rollback(this.db, owner, null);
    }
    /** the tables a checkpoint record keeps: the running transactions and the dirty pages (ARIES) */
    checkpointData(fuzzy) {
      const db = this.db;
      const txTable = [];
      for (const tx of db.xact.active.values()) {
        if (!tx.xid) continue;
        const last = this.lastByXid.get(tx.xid) || 0;
        const r = last ? this.byLsn(last) : null;
        txTable.push({ xid: tx.xid, status: 'U', lastLsn: last, undoNext: r && r.type === 'clr' ? r.undoNext : last });
      }
      const dpt = db.buffers.dirtyPages().filter((p) => p.recLsn !== null && p.recLsn !== undefined).map((p) => ({ file: p.file, block: p.block, recLsn: p.recLsn }));
      const redoLsn = dpt.reduce((m, p) => Math.min(m, p.recLsn), this.nextLsn);
      return { active: txTable.map((t) => t.xid), txTable, dpt, dirty: dpt.length, redoLsn, nextXid: db.xact.next, fuzzy: !!fuzzy };
    }
    /** a rough byte size: a 24-byte header plus the data carried, as WAL records are sized */
    sizeOf(r) {
      let n = 24;
      if (r.bytes) n += r.bytes.length;
      if (r.image) n += r.image.length;
      if (r.fpi) n += r.fpi.length;
      if (r.before) n += r.before.length;
      if (r.data) n += JSON.stringify(r.data).length;
      return n;
    }
    /** write the log to stable storage up to (and including) lsn: all the buffered records before it go in one group */
    flush(lsn, why) {
      const upTo = lsn === undefined ? this.nextLsn - 1 : lsn;
      if (upTo <= this.flushedLsn) return;
      let n = 0, bytes = 0, commits = 0, last = null;
      for (let i = this.records.length - 1; i >= 0; i--) {
        const r = this.records[i];
        if (r.lsn <= this.flushedLsn) break;
        if (r.lsn > upTo) continue;
        if (!last) last = r;
        n++; bytes += r.size; if (r.type === 'commit') commits++;
      }
      const from = this.flushedLsn;
      this.flushedLsn = last ? last.lsn : upTo;
      this.stats.flushes++; if (commits > 1) this.stats.groups++;
      this.db.bus.emit('wal.flush', { lsn: this.flushedLsn, from, records: n, bytes, commits, why: why || 'flush' });
    }
    /** records not yet on stable storage: the log buffer */
    pending() { return this.records.filter((r) => r.lsn > this.flushedLsn); }
    /** a crash: the records not yet flushed are gone */
    lose() {
      const kept = this.records.filter((r) => r.lsn <= this.flushedLsn);
      const lost = this.records.length - kept.length;
      this.records = kept;
      this.nextLsn = kept.length ? kept[kept.length - 1].lsn + kept[kept.length - 1].size : Math.max(1, this.flushedLsn + 1);
      this.lastByXid = new Map();
      this.touched = new Map();
      this.db.bus.emit('wal.lost', { lost });
    }
    byLsn(lsn) { let lo = 0, hi = this.records.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; const r = this.records[m]; if (r.lsn === lsn) return r; if (r.lsn < lsn) lo = m + 1; else hi = m - 1; } return null; }
    /** the last checkpoint record on stable storage (the master record points at it) */
    lastCheckpoint() { for (let i = this.records.length - 1; i >= 0; i--) { const r = this.records[i]; if (r.type === 'checkpoint' && r.lsn <= this.flushedLsn) return r; } return null; }
    /**
     * drop records no longer needed (before the last checkpoint's redo point), as a log archive would. The fates of
     * the transactions they describe are kept, so the commit log can still be rebuilt from what remains.
     */
    truncate(beforeLsn) {
      const gone = this.records.filter((r) => r.lsn < beforeLsn);
      if (!gone.length) return;
      const a = this.archived || { tops: new Map(), subs: new Map(), subAborted: new Set(), parent: new Map(), commits: [], maxXid: 0 };
      for (const r of gone) {
        if (!r.xid) continue;
        const top = r.top || r.xid;
        a.maxXid = Math.max(a.maxXid, r.xid, top);
        if (!a.tops.has(top)) a.tops.set(top, null);
        if (r.top) a.subs.set(r.xid, top);
        if (r.parent) { a.parent.set(r.xid, r.parent); a.subs.set(r.parent, top); }
        if (r.ancestors) r.ancestors.forEach((x, k) => { a.parent.set(x, r.ancestors[k + 1] || top); a.subs.set(x, top); });
        if (r.type === 'commit') { a.tops.set(top, 'commit'); a.commits.push(top); }
        else if (r.type === 'abort') { if (r.sub) a.subAborted.add(r.xid); else if (a.tops.get(top) !== 'commit') a.tops.set(top, 'abort'); }
      }
      this.archived = a;
      this.records = this.records.filter((r) => r.lsn >= beforeLsn);
    }
  }

  K.WAL = WAL;
  K.WAL.isPage = PAGE;
})(typeof window !== 'undefined' ? window : globalThis);
