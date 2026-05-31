// The buffer manager: a fixed number of frames holding disk blocks, a page table to find them, pin counts so
// a page in use is never evicted, dirty bits, and a choice of replacement policy (LRU, MRU, Clock, FIFO,
// LRU-2). Before a dirty page is written, the log is flushed up to the page's LSN: the write-ahead rule.
//
// For recovery each frame also keeps: recLsn, the LSN of the first log record that dirtied it since it was read
// or last written (ARIES's dirty page table is the set of frames with a recLsn); fpi, whether a full-page image
// of it has been logged since then; and xids, the transactions whose changes it holds (for the no-steal policy).
// The policies are settings: buffer_steal (may a page with uncommitted changes be written?), buffer_force (are a
// transaction's pages written at commit?), wal_rule (turn it off to see what breaks), page_checksums.
(function (root) {
  'use strict';
  const K = root.K;
  const setting = (db, k, dflt) => (K.settingOf ? K.settingOf(db, k) : db && db.settings && db.settings[k] !== undefined ? db.settings[k] : dflt);

  class BufferPool {
    constructor(disk, opts) {
      opts = opts || {};
      this.disk = disk;
      this.bus = opts.bus || disk.bus;
      this.n = opts.frames || 64;
      this.policy = opts.policy || 'lru';
      this.frames = [];
      this.table = new Map();   // "file:block" -> frame index
      this.tick = 0;            // logical clock for LRU stamps
      this.seq = 0;             // orders pins and log records, to spot changes nobody logged
      this.hand = 0;            // the Clock policy's hand
      this.fifo = [];
      this.stats = { hits: 0, misses: 0, evictions: 0, flushes: 0 };
      this.wal = null;          // set by the database: the log to flush before writing a page
      this.recovering = false;  // restart replays changes without logging them
      this.violations = [];     // pages written ahead of the log while wal_rule was off
      for (let i = 0; i < this.n; i++) this.frames.push(this.blank(i));
    }
    get db() { return this.wal ? this.wal.db : null; }
    blank(i) { return { i, file: 0, block: -1, buf: new Uint8Array(this.disk.pageSize), pins: 0, dirty: false, used: 0, hist: [], ref: false, loaded: 0, recLsn: null, fpi: false, xids: new Set(), pinSeq: 0, logSeq: 0, corrupt: false }; }
    key(file, block) { return file + ':' + block; }
    resize(n) {
      this.flushAll(true);
      this.n = n; this.frames = []; this.table.clear(); this.fifo = []; this.hand = 0;
      for (let i = 0; i < n; i++) this.frames.push(this.blank(i));
      this.bus.emit('buf.resize', { frames: n });
    }
    setPolicy(p) { if (!['lru', 'mru', 'clock', 'fifo', 'lru2'].includes(p)) throw K.err(K.STATE.invalidParameter, 'unknown replacement policy ' + p); this.policy = p; this.bus.emit('buf.policy', { policy: p }); }
    frameOf(file, block) { const fi = this.table.get(this.key(file, block)); return fi === undefined ? null : this.frames[fi]; }
    /** pin a page and return its frame; reads it from disk on a miss (possibly evicting another page) */
    pin(file, block, opts) {
      const k = this.key(file, block);
      let fi = this.table.get(k);
      let f;
      // quiet reads (a view drawing an index) look at a page without counting, reordering or loading anything
      if (this.quiet) {
        if (fi !== undefined) { f = this.frames[fi]; f.pins++; return f; }
        const buf = new Uint8Array(this.disk.pageSize);
        const df = this.disk.files.get(file);
        if (df && df.blocks[block]) buf.set(df.blocks[block]);
        return { i: -1, file, block, buf, pins: 1, dirty: false, temp: true, hist: [] };
      }
      if (fi !== undefined) {
        f = this.frames[fi];
        this.stats.hits++;
        this.bus.emit('buf.hit', { frame: fi, file, block });
      } else {
        fi = this.victim();
        f = this.frames[fi];
        if (f.block >= 0) this.evict(f);
        f.file = file; f.block = block; f.dirty = false; f.hist = []; f.loaded = ++this.tick;
        f.recLsn = null; f.fpi = false; f.xids = new Set(); f.corrupt = false;
        if (opts && opts.fresh) f.buf.fill(0);
        else {
          this.disk.read(file, block, f.buf);
          if (!K.checksumOk(f.buf)) { f.corrupt = true; this.bus.emit('page.corrupt', { file, block, frame: fi }); }
        }
        this.table.set(k, fi);
        this.fifo.push(fi);
        this.stats.misses++;
        this.bus.emit('buf.miss', { frame: fi, file, block });
      }
      f.pins++;
      f.used = ++this.tick;
      f.pinSeq = ++this.seq;
      f.ref = true;
      f.hist.unshift(this.tick); if (f.hist.length > 2) f.hist.length = 2;
      return f;
    }
    unpin(f, dirty) {
      if (f.temp) return;
      if (this.quiet && !dirty) { f.pins--; return; }
      if (f.pins <= 0) throw K.err(K.STATE.internal, 'unpin of an unpinned page');
      // a change no log record describes (an access method that does not log): log the whole page, so redo can restore it
      if (dirty && !this.recovering && this.wal && this.wal.enabled && f.logSeq < f.pinSeq) {
        const lsn = this.wal.log({ type: 'page.image', file: f.file, block: f.block, image: f.buf.slice() });
        if (lsn) new K.Page(f.buf).lsn = lsn;
      }
      f.pins--;
      if (dirty) { if (!f.dirty) this.bus.emit('buf.dirty', { frame: f.i, file: f.file, block: f.block }); f.dirty = true; }
      this.bus.emit('buf.unpin', { frame: f.i, file: f.file, block: f.block, pins: f.pins });
    }
    /** the log has a new record for a page in a frame: remember it for the dirty page table and the no-steal rule */
    noteRecord(f, rec, owner) {
      f.logSeq = ++this.seq;
      if (f.recLsn === null) f.recLsn = rec.lsn;
      if (owner) f.xids.add(owner);
    }
    /** a new block at the end of a file, pinned and zeroed */
    extend(file) { const block = this.disk.extend(file); return this.pin(file, block, { fresh: true }); }
    /** does the frame hold changes of a transaction still running? (no-steal must not write it) */
    uncommitted(f) {
      const db = this.db;
      if (!db || !f.xids.size) return false;
      for (const x of f.xids) if (db.xact.inProgress(x)) return true;
      return false;
    }
    evictable(f) { return f.pins === 0 && (!f.dirty || this.recovering || setting(this.db, 'buffer_steal', true) !== false || !this.uncommitted(f)); }
    victim() {
      const free = this.frames.findIndex((f) => f.block < 0);
      if (free >= 0) return free;
      const cand = this.frames.filter((f) => this.evictable(f));
      if (!cand.length) {
        if (this.frames.some((f) => f.pins === 0)) throw K.err(K.STATE.outOfMemory, 'no buffer frame can be freed: with buffer_steal off, the ' + this.frames.filter((f) => f.pins === 0).length + ' unpinned pages all hold changes of transactions that have not committed. Commit, increase the buffer pool, or allow steal.');
        throw K.err(K.STATE.outOfMemory, 'all ' + this.n + ' buffer frames are pinned: no page can be evicted. Increase the buffer pool size.');
      }
      let v;
      switch (this.policy) {
        case 'mru': v = cand.reduce((a, b) => (b.used > a.used ? b : a)); break;
        case 'fifo': { v = null; for (const i of this.fifo) { const f = this.frames[i]; if (f.block >= 0 && this.evictable(f)) { v = f; break; } } if (!v) v = cand[0]; break; }
        case 'clock': {
          for (let k = 0; k < this.n * 3; k++) {
            const f = this.frames[this.hand];
            this.hand = (this.hand + 1) % this.n;
            if (!this.evictable(f)) continue;
            if (f.ref) { f.ref = false; continue; }
            v = f; break;
          }
          if (!v) v = cand[0];
          break;
        }
        case 'lru2': v = cand.reduce((a, b) => ((b.hist[1] || 0) < (a.hist[1] || 0) || ((b.hist[1] || 0) === (a.hist[1] || 0) && b.used < a.used) ? b : a)); break;
        default: v = cand.reduce((a, b) => (b.used < a.used ? b : a));
      }
      if (v.dirty && this.uncommitted(v)) this.bus.emit('buf.steal', { frame: v.i, file: v.file, block: v.block, xids: [...v.xids] });
      return v.i;
    }
    evict(f) {
      if (f.dirty) this.write(f);
      this.table.delete(this.key(f.file, f.block));
      this.fifo = this.fifo.filter((i) => i !== f.i);
      this.stats.evictions++;
      this.bus.emit('buf.evict', { frame: f.i, file: f.file, block: f.block });
      f.block = -1; f.file = 0; f.dirty = false; f.recLsn = null; f.fpi = false; f.xids = new Set();
    }
    /** write a dirty frame: first force the log up to the page's LSN (unless wal_rule is off: then note the violation) */
    write(f) {
      const p = new K.Page(f.buf);
      const lsn = p.lsn;
      const db = this.db;
      if (this.wal && lsn > this.wal.flushedLsn) {
        if (setting(db, 'wal_rule', true) !== false) this.wal.flush(lsn, 'the page ' + this.disk.file(f.file).name + ' block ' + f.block + ' is about to be written');
        else {
          const v = { file: f.file, block: f.block, name: this.disk.file(f.file).name, pageLsn: lsn, flushedLsn: this.wal.flushedLsn };
          this.violations.push(v);
          this.bus.emit('wal.violation', v);
        }
      }
      K.setChecksum(f.buf, setting(db, 'page_checksums', true) !== false);
      this.disk.write(f.file, f.block, f.buf);
      f.dirty = false; f.recLsn = null; f.fpi = false; f.xids = new Set();
      this.stats.flushes++;
      this.bus.emit('buf.flush', { frame: f.i, file: f.file, block: f.block, lsn });
    }
    flushPage(file, block) { const fi = this.table.get(this.key(file, block)); if (fi !== undefined && this.frames[fi].dirty) this.write(this.frames[fi]); }
    /** write every dirty page; under no-steal the pages holding uncommitted changes stay (unless all is set) */
    flushAll(all) {
      const noSteal = !all && !this.recovering && setting(this.db, 'buffer_steal', true) === false;
      for (const f of this.frames) {
        if (f.block < 0 || !f.dirty) continue;
        if (noSteal && this.uncommitted(f)) { this.bus.emit('buf.nosteal', { frame: f.i, file: f.file, block: f.block, xids: [...f.xids] }); continue; }
        this.write(f);
      }
    }
    /** drop a file's pages (DROP TABLE, TRUNCATE) without writing them */
    forget(file) {
      for (const f of this.frames) if (f.file === file && f.block >= 0) { this.table.delete(this.key(f.file, f.block)); this.fifo = this.fifo.filter((i) => i !== f.i); f.block = -1; f.file = 0; f.dirty = false; f.pins = 0; f.recLsn = null; f.fpi = false; f.xids = new Set(); }
    }
    /** a crash: every frame's contents are lost */
    lose() { for (let i = 0; i < this.n; i++) this.frames[i] = this.blank(i); this.table.clear(); this.fifo = []; this.hand = 0; this.bus.emit('buf.lost', {}); }
    /** the dirty page table: every page changed since it was read, with the first LSN that changed it */
    dirtyPages() { return this.frames.filter((f) => f.block >= 0 && (f.dirty || f.recLsn !== null)).map((f) => ({ file: f.file, block: f.block, lsn: new K.Page(f.buf).lsn, recLsn: f.recLsn })); }
    resetStats() { this.stats = { hits: 0, misses: 0, evictions: 0, flushes: 0 }; }
    describe() {
      return { n: this.n, policy: this.policy, hand: this.hand, stats: Object.assign({}, this.stats), violations: this.violations.slice(), frames: this.frames.map((f) => ({ i: f.i, file: f.file, block: f.block, pins: f.pins, dirty: f.dirty, used: f.used, ref: f.ref, recLsn: f.recLsn, pageLsn: f.block >= 0 ? new K.Page(f.buf).lsn : null, xids: [...f.xids], corrupt: f.corrupt, name: f.block >= 0 && this.disk.files.has(f.file) ? this.disk.file(f.file).name : null })) };
    }
  }

  K.BufferPool = BufferPool;
})(typeof window !== 'undefined' ? window : globalThis);
