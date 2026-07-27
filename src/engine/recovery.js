// Crash recovery: a crash (with a torn page if it hits a write), and restart by the basic algorithm (redo the log from the last checkpoint, then undo the incomplete
// transactions with an undo list) or by ARIES (analysis, redo repeating history, undo with compensation log
// records). Every pass records its steps (the record examined, what was done and why, page LSN comparisons,
// the tables before and after) for the recovery view, and emits them on the bus as 'recovery.step'.
// Also: archival dumps with log replay, a remote backup fed by log shipping, and shadow paging as a contrast.
(function (root) {
  'use strict';
  const K = root.K;
  const ST = () => K.XSTATUS;
  const PAGE = (r) => r.file !== undefined && r.block !== undefined && r.file !== null;
  const pkey = (file, block) => file + ':' + block;

  // ---- settings -------------------------------------------------------------------------------------------------------
  const DEFAULTS = {
    buffer_steal: true,      // may the buffer manager write a page holding uncommitted changes? (off: no-steal)
    buffer_force: false,     // are a transaction's pages written to disk before its commit record? (on: force)
    wal_rule: true,          // flush the log up to a page's LSN before writing the page
    full_page_writes: true,  // log a full image of a page with its first change after it was read or written
    page_checksums: true,    // keep pd_checksum, so a torn page can be detected
    wal_buffers: 65536,      // bytes of log buffer; a full buffer is flushed
    rollback_undo: false,    // undo an aborting transaction's changes on the pages (classic rollback), not just in the commit log
  };
  K.RECOVERY_DEFAULTS = DEFAULTS;
  // db.js defines DB_DEFAULTS after this file loads: add these settings when it does
  (function () {
    const add = (d) => { if (d && typeof d === 'object') for (const k in DEFAULTS) if (!(k in d)) d[k] = DEFAULTS[k]; return d; };
    if (K.DB_DEFAULTS) { add(K.DB_DEFAULTS); return; }
    let v;
    Object.defineProperty(K, 'DB_DEFAULTS', { configurable: true, enumerable: true, get: () => v, set: (x) => { v = add(x); } });
  })();
  /** a recovery setting: the running session's when it changed it from the default, else the database's */
  K.settingOf = (db, k) => {
    const s = K.currentSession;
    const dflt = K.DB_DEFAULTS && k in K.DB_DEFAULTS ? K.DB_DEFAULTS[k] : DEFAULTS[k];
    if (s && s.db === db && s.settings && k in s.settings && s.settings[k] !== dflt) return s.settings[k];
    return db && db.settings && k in db.settings ? db.settings[k] : dflt;
  };

  // ---- describing records -------------------------------------------------------------------------------------------
  function where(db, r) {
    const rel = r.rel && db.catalog.rel(r.rel);
    const name = rel ? rel.name : db.disk.files.has(r.file) ? db.disk.file(r.file).name : 'file ' + r.file;
    return name + '[' + r.block + (r.item ? ',' + r.item : '') + ']';
  }
  const tname = (r) => 'T' + (r.top || r.xid) + (r.top ? '/' + r.xid : '');
  /** a record in angle-bracket notation: <T5 start>, <T5, accounts[0,3], xmax 0 → 5>, <T5 commit> ... */
  function text(db, r) {
    const hdr = K.Tuple.header;
    switch (r.type) {
      case 'begin': return '<' + tname(r) + ' start>';
      case 'commit': return '<' + tname(r) + ' commit>';
      case 'abort': return r.sub ? '<' + tname(r) + ' abort> (subtransaction ' + r.xid + ', rollback to savepoint)' : '<' + tname(r) + ' abort>';
      case 'end': return '<' + tname(r) + ' end>';
      case 'dump': return '<dump>';
      case 'checkpoint': {
        const d = r.data || {};
        return '<checkpoint {' + (d.active || []).map((x) => 'T' + x).join(', ') + '}>' + (d.fuzzy ? ' fuzzy' : '') + (d.dpt && d.dpt.length ? ', ' + d.dpt.length + ' dirty page' + (d.dpt.length > 1 ? 's' : '') : '') + (d.endOfRecovery ? ' (end of recovery)' : '');
      }
      case 'heap.insert': return '<' + tname(r) + ', ' + where(db, r) + ', insert>' + (r.fpi ? ' +page image' : '');
      case 'heap.delete': case 'heap.update': case 'heap.lock': {
        const a = hdr(r.bytes), b = r.before ? hdr(r.before) : null;
        return '<' + tname(r) + ', ' + where(db, r) + ', ' + r.type.slice(5) + ': xmax ' + (b ? b.xmax : '?') + ' → ' + a.xmax + '>' + (r.fpi ? ' +page image' : '');
      }
      case 'clr': return '<' + tname(r) + ', ' + where(db, r) + ', ' + (r.action === 'invalidate' ? 'tuple invalid' : 'header restored') + '> CLR for LSN ' + r.undoes + ', UndoNextLSN ' + r.undoNext + (r.by === 'textbook' ? ' (redo-only)' : '');
      case 'btree.page': return '<' + where(db, r) + ', B+ tree page image>';
      case 'heap.prune': return '<' + where(db, r) + ', pruned page image>';
      case 'page.image': return '<' + where(db, r) + ', page image>';
      default: return '<' + (r.xid ? tname(r) + ', ' : '') + r.type + (PAGE(r) ? ', ' + where(db, r) : '') + '>';
    }
  }
  /** the log as the recovery view lists it */
  function records(db) {
    return db.wal.records.map((r) => ({ lsn: r.lsn, prevLsn: r.prevLsn || 0, type: r.type, xid: r.xid || null, top: r.top || r.xid || null, size: r.size, stable: r.lsn <= db.wal.flushedLsn, text: text(db, r), file: PAGE(r) ? r.file : null, block: PAGE(r) ? r.block : null, undoNext: r.undoNext, fpi: !!r.fpi }));
  }

  // ---- the trace of a restart -----------------------------------------------------------------------------------------
  class Trace {
    constructor(db, algorithm, opts) { this.db = db; this.algorithm = algorithm; this.opts = opts; this.steps = []; this.pass = null; this.problems = []; this.passes = {}; }
    begin(pass, info) { this.pass = pass; this.passes[pass] = Object.assign({ steps: [] }, info || {}); this.db.bus.emit('recovery.pass', Object.assign({ pass, algorithm: this.algorithm }, info || {})); }
    end(info) { Object.assign(this.passes[this.pass], info || {}); this.db.bus.emit('recovery.pass.end', Object.assign({ pass: this.pass }, info || {})); }
    step(o) {
      o.pass = this.pass; o.n = this.steps.length + 1;
      this.steps.push(o); this.passes[this.pass].steps.push(o);
      this.db.bus.emit('recovery.step', o);
      if (this.opts.crashAt && o.n >= this.opts.crashAt) { const e = new K.Crash('crash during recovery, at step ' + o.n); e.inRecovery = true; throw e; }
    }
    problem(msg) { this.problems.push(msg); this.db.bus.emit('recovery.problem', { message: msg }); }
  }
  const ttRows = (tt) => [...tt.values()].map((e) => Object.assign({}, e));
  const dptRows = (db, dpt) => [...dpt].map(([k, recLsn]) => { const [file, block] = k.split(':').map(Number); return { file, block, name: db.disk.files.has(file) ? db.disk.file(file).name : 'file ' + file, recLsn }; });

  // ---- crash ------------------------------------------------------------------------------------------------------------
  /** the database is down: memory is gone (buffer pool, log buffer, running transactions, their locks) */
  function down(db, info) {
    for (const tx of db.xact.active.values()) { try { db.locks.releaseAll(tx); } catch (e) { /* the lock table goes anyway */ } }
    for (const r of db.runners || []) if (!r.done) { r.done = true; r.error = new K.Crash('the database crashed'); r.waitingOn = null; r.session.waiting = null; }
    db.runners = [];
    db.crash();
    db.xact.active.clear();
    db.fsms.clear();
    db.disk.failing = false;
    db.buffers.recovering = false;
    db.down = info;
  }
  /**
   * a crash. opts.at: 'now' (power fails between two actions) or 'during-write' (it fails while a dirty page is
   * being written: the page is torn, half new and half old). opts.page {file, block} picks the page, else opts.pick
   * (an index into the dirty pages). Returns what was lost.
   */
  function crash(db, opts) {
    opts = opts || {};
    const at = opts.at || 'now';
    let torn = null;
    if (at === 'during-write') {
      const dirty = db.buffers.frames.filter((f) => f.block >= 0 && f.dirty);
      const f = opts.page ? db.buffers.frameOf(opts.page.file, opts.page.block) : dirty.length ? dirty[(opts.pick || 0) % dirty.length] : null;
      if (f) {
        db.disk.failing = opts.tearAt ? { tearAt: opts.tearAt } : true;
        try { db.buffers.write(f); } catch (e) { if (!e || !e.crash) throw e; torn = { file: f.file, block: f.block, name: db.disk.file(f.file).name }; }
        db.disk.failing = false;
      }
    }
    const lost = db.wal.records.filter((r) => r.lsn > db.wal.flushedLsn);
    const info = {
      at, torn, flushedLsn: db.wal.flushedLsn, lostRecords: lost.length, lostBytes: lost.reduce((n, r) => n + r.size, 0),
      running: [...db.xact.active.values()].filter((t) => t.xid).map((t) => t.xid), dirtyPages: db.buffers.dirtyPages().length,
    };
    down(db, info);
    db.bus.emit('recovery.crash', info);
    return info;
  }

  // ---- what the stable log says about every transaction ----------------------------------------------------------------
  function fatesOf(db) {
    const a = db.wal.archived;
    const tops = new Map(), parent = new Map(a ? a.parent : []), subAborted = new Set(a ? a.subAborted : []), commits = a ? a.commits.slice() : [];
    let max = a ? a.maxXid : 0;
    const top = (x) => { let e = tops.get(x); if (!e) tops.set(x, (e = { xid: x, xids: new Set(), fate: null })); return e; };
    if (a) { for (const [x, f] of a.tops) top(x).fate = f; for (const [s, t] of a.subs) top(t).xids.add(s); }
    for (const r of db.wal.records) {
      if (!r.xid) continue;
      const t = r.top || r.xid, e = top(t);
      max = Math.max(max, r.xid, t);
      if (r.top) e.xids.add(r.xid);
      if (r.parent) { parent.set(r.xid, r.parent); e.xids.add(r.parent); max = Math.max(max, r.parent); }
      if (r.ancestors) r.ancestors.forEach((x, k) => { parent.set(x, r.ancestors[k + 1] || t); e.xids.add(x); });
      if (r.type === 'commit') { e.fate = 'commit'; commits.push(t); }
      else if (r.type === 'abort') { if (r.sub) subAborted.add(r.xid); else if (e.fate !== 'commit') e.fate = 'abort'; }
    }
    const status = new Map();
    for (const e of tops.values()) {
      const c = e.fate === 'commit';
      status.set(e.xid, c ? ST().COMMITTED : ST().ABORTED);
      for (const x of e.xids) if (x !== e.xid) status.set(x, !c || subAborted.has(x) ? ST().ABORTED : ST().SUBCOMMITTED);
    }
    for (const x of parent.keys()) if (!status.has(x)) status.set(x, ST().ABORTED);
    return { status, parent, commits, next: max + 1, tops };
  }
  function rebuildClog(db, tr, ck) {
    const f = fatesOf(db);
    if (ck && ck.data && ck.data.nextXid) f.next = Math.max(f.next, ck.data.nextXid);
    db.xact.rebuild(f);
    const committed = [...f.tops.values()].filter((e) => e.fate === 'commit').map((e) => e.xid);
    const aborted = [...f.tops.values()].filter((e) => e.fate !== 'commit').map((e) => e.xid);
    tr.step({ action: 'clog', why: 'the commit log is rebuilt from the stable log: a transaction with a commit record committed, every other one aborted (its subtransactions share its fate unless rolled back to a savepoint)', committed, aborted, nextXid: db.xact.next });
    return f;
  }

  // ---- pages --------------------------------------------------------------------------------------------------------------
  /** look for torn pages (checksum mismatch) and pages ahead of the log (written in violation of the WAL rule) */
  function tornCheck(db, tr) {
    tr.begin('check');
    const torn = [], ahead = [];
    const last = db.wal.records.length ? db.wal.records[db.wal.records.length - 1].lsn : 0;
    for (const f of db.disk.files.values()) {
      f.blocks.forEach((b, i) => {
        if (!K.checksumOk(b)) { torn.push({ file: f.id, block: i, name: f.name }); tr.step({ action: 'torn', file: f.id, block: i, name: f.name, why: 'pd_checksum ' + (b[8] | (b[9] << 8)) + ' does not match the contents (' + K.pageChecksum(b) + '): the last write of this page was torn' }); return; }
        const lsn = new K.Page(b).lsn;
        if (lsn > last) { ahead.push({ file: f.id, block: i, name: f.name, pageLsn: lsn }); tr.step({ action: 'wal-violation', file: f.id, block: i, name: f.name, pageLsn: lsn, why: 'PageLSN ' + lsn + ' is past the end of the stable log (' + last + '): the page reached the disk before its log records, which the crash lost. The WAL rule was off.' }); tr.problem('page ' + f.name + '[' + i + '] holds changes whose log records were lost (WAL rule violated): they cannot be undone'); }
      });
    }
    if (!torn.length && !ahead.length) tr.step({ action: 'ok', why: 'every page checksum matches and no page is ahead of the log' });
    tr.end({ torn, ahead });
    return { torn, ahead };
  }
  /** pin the page a record is about (null if its file is gone); a torn page starts over as an empty page */
  function pinFor(db, ctx, tr, r) {
    if (!db.disk.files.has(r.file)) return null;
    db.disk.ensure(r.file, r.block);
    const f = db.buffers.pin(r.file, r.block);
    const k = pkey(r.file, r.block);
    if (ctx.torn.has(k) && !ctx.reset.has(k)) {
      f.buf.fill(0); f.corrupt = false; ctx.reset.add(k);
      tr.step({ action: 'reset', lsn: r.lsn, file: r.file, block: r.block, name: db.disk.file(r.file).name, why: 'the page is torn: redo starts from an empty page, and the full-page image logged with its first change after it was last written restores it' });
    }
    return f;
  }
  function redoOne(db, ctx, tr, r, unconditional) {
    const o = { lsn: r.lsn, record: text(db, r), type: r.type, file: r.file, block: r.block };
    const f = pinFor(db, ctx, tr, r);
    if (!f) { o.action = 'skip'; o.why = 'the file no longer exists (the table was dropped)'; tr.step(o); return; }
    const p = new K.Page(f.buf);
    o.pageLsn = p.lsn;
    if (!unconditional && p.lsn >= r.lsn) {
      db.buffers.unpin(f, false);
      o.action = 'skip'; o.cmp = 'PageLSN ' + p.lsn + ' ≥ LSN ' + r.lsn; o.why = 'the page already holds this change';
      tr.step(o); return;
    }
    o.cmp = unconditional ? 'PageLSN ' + p.lsn + (p.lsn >= r.lsn ? ' ≥ ' : ' < ') + 'LSN ' + r.lsn + ': redone regardless (redo is idempotent)' : 'PageLSN ' + p.lsn + ' < LSN ' + r.lsn;
    o.what = K.HeapRedo.redo(p, r);
    if (K.HeapRedo.imageOf(r)) ctx.imaged.add(pkey(r.file, r.block));
    if (f.recLsn === null) f.recLsn = r.lsn;
    db.buffers.unpin(f, true);
    o.action = 'redo'; o.pageLsnAfter = p.lsn;
    o.why = unconditional ? 'redo phase: every change from the checkpoint on is repeated' : 'repeating history: the change is not on the page yet';
    tr.step(o);
  }
  /** undo one record on its page, logging a compensation record; returns { what, clr } or { skip } */
  function undoOne(db, r, by) {
    if (!db.disk.files.has(r.file)) return { skip: 'the file no longer exists' };
    db.disk.ensure(r.file, r.block);
    const f = db.buffers.pin(r.file, r.block);
    const p = new K.Page(f.buf);
    const u = K.HeapRedo.undo(p, r);
    if (u.skip) { db.buffers.unpin(f, false); return u; }
    K.HeapRedo.place(p, r.item, u.bytes);
    const lsn = db.wal.log({ type: 'clr', xid: r.xid, rel: r.rel, file: r.file, block: r.block, item: r.item, bytes: u.bytes, undoes: r.lsn, undoNext: r.prevLsn || 0, action: u.action, by, recovery: true });
    if (lsn) p.lsn = lsn;
    db.buffers.unpin(f, true);
    return Object.assign(u, { clr: lsn });
  }
  function checkRepaired(db, ctx, tr) {
    for (const k of ctx.torn) {
      if (ctx.imaged.has(k)) continue;
      const [file, block] = k.split(':').map(Number);
      const name = db.disk.files.has(file) ? db.disk.file(file).name : 'file ' + file;
      if (!ctx.reset.has(k)) {
        // no record touched it: an empty page is all that can be said for it
        db.disk.ensure(file, block); const f = db.buffers.pin(file, block); f.buf.fill(0); db.buffers.unpin(f, true);
      }
      tr.problem('torn page ' + name + '[' + block + '] had no full-page image after the redo point: it was rebuilt only from the records redone' + (K.settingOf(db, 'full_page_writes') === false ? ' (full_page_writes is off)' : ''));
    }
  }

  // ---- ARIES --------------------------------------------------------------------------------------------------------------
  function aries(db, tr, ck, ctx, res) {
    const wal = db.wal, recs = wal.records;
    // analysis: from the checkpoint forward, rebuild the transaction table and the dirty page table
    const tt = new Map(), dpt = new Map();
    if (ck && ck.data) {
      for (const e of ck.data.txTable || (ck.data.active || []).map((x) => ({ xid: x, status: 'U', lastLsn: 0, undoNext: 0 }))) tt.set(e.xid, Object.assign({}, e));
      for (const d of ck.data.dpt || []) dpt.set(pkey(d.file, d.block), d.recLsn);
    }
    const before = { tt: ttRows(tt), dpt: dptRows(db, dpt) };
    tr.begin('analysis', { from: ck ? ck.lsn : recs.length ? recs[0].lsn : 0, before });
    let i = ck ? recs.indexOf(ck) : 0;
    if (ck) { tr.step({ lsn: ck.lsn, record: text(db, ck), type: 'checkpoint', action: 'start', why: 'the master record points at this checkpoint: its transaction table and dirty page table are where analysis starts', tt: ttRows(tt), dpt: dptRows(db, dpt) }); i++; }
    for (; i < recs.length; i++) {
      const r = recs[i];
      const o = { lsn: r.lsn, record: text(db, r), type: r.type, changes: [] };
      if (r.xid) {
        const t = r.top || r.xid;
        let e = tt.get(t);
        if (r.type === 'end') { if (e) { tt.delete(t); o.changes.push('T' + t + ' leaves the transaction table: it is finished'); } }
        else {
          if (!e) { tt.set(t, (e = { xid: t, status: 'U', lastLsn: 0, undoNext: 0 })); o.changes.push('T' + t + ' enters the transaction table'); }
          e.lastLsn = r.lsn;
          e.undoNext = r.type === 'clr' ? r.undoNext : r.lsn;
          if (r.type === 'commit') { e.status = 'C'; o.changes.push('T' + t + ' committed'); }
          else if (r.type === 'abort' && !r.sub) { e.status = 'A'; o.changes.push('T' + t + ' was rolling back'); }
          else o.changes.push('T' + t + ': LastLSN ' + r.lsn + (r.type === 'clr' ? ', UndoNextLSN ' + r.undoNext + ' (from the CLR)' : ''));
        }
      }
      if (PAGE(r)) {
        const k = pkey(r.file, r.block);
        if (!dpt.has(k)) { dpt.set(k, r.lsn); o.changes.push(where(db, r).replace(/,\d+\]$/, ']') + ' enters the dirty page table with recLSN ' + r.lsn); }
      }
      if (r.type === 'checkpoint') o.changes.push('a later checkpoint: analysis keeps its own tables');
      o.action = o.changes.length ? 'update' : 'none';
      o.why = o.changes.join('; ') || 'nothing for the tables';
      o.tt = ttRows(tt); o.dpt = dptRows(db, dpt);
      tr.step(o);
    }
    // torn pages are redone from their full-page image, whatever the dirty page table says
    for (const k of ctx.torn) if (!dpt.has(k)) { const lo = dpt.size ? Math.min(...dpt.values()) : ck ? ck.lsn : 1; dpt.set(k, lo); tr.step({ action: 'update', why: 'torn page ' + k + ' added to the dirty page table with recLSN ' + lo, dpt: dptRows(db, dpt) }); }
    const winners = [...tt.values()].filter((e) => e.status === 'C');
    for (const e of winners) { tt.delete(e.xid); wal.log({ xid: e.xid, type: 'end', recovery: true }); }
    const losers = [...tt.values()];
    const redoLsn = dpt.size ? Math.min(...dpt.values()) : 0;
    tr.end({ after: { tt: ttRows(tt), dpt: dptRows(db, dpt) }, redoLsn, losers: losers.map((e) => e.xid), winners: winners.map((e) => e.xid) });
    res.losers = losers.map((e) => e.xid); res.redoLsn = redoLsn;
    rebuildClog(db, tr, ck);

    // redo: from RedoLSN, every page change not known to be on disk is repeated, losers' included
    tr.begin('redo', { from: redoLsn });
    if (!redoLsn) tr.step({ action: 'none', why: 'the dirty page table is empty: every change is on disk' });
    else {
      const end = recs.length;
      for (let j = 0; j < end; j++) {
        const r = recs[j];
        if (r.lsn < redoLsn || !PAGE(r)) continue;
        const k = pkey(r.file, r.block), rec = dpt.get(k);
        if (rec === undefined) { tr.step({ lsn: r.lsn, record: text(db, r), type: r.type, file: r.file, block: r.block, action: 'skip', why: 'the page is not in the dirty page table: this change reached the disk before the checkpoint' }); continue; }
        if (r.lsn < rec) { tr.step({ lsn: r.lsn, record: text(db, r), type: r.type, file: r.file, block: r.block, action: 'skip', cmp: 'LSN ' + r.lsn + ' < recLSN ' + rec, why: 'the page was written after this change, before it was dirtied again' }); continue; }
        redoOne(db, ctx, tr, r, false);
      }
    }
    checkRepaired(db, ctx, tr);
    tr.end({});

    // undo: the losers' changes, newest first across all of them, each undone change logged as a CLR
    const toUndo = new Map(losers.map((e) => [e.xid, e.undoNext]));
    for (const e of losers) wal.lastByXid.set(e.xid, e.lastLsn);
    tr.begin('undo', { losers: losers.map((e) => ({ xid: e.xid, undoNext: e.undoNext })) });
    if (!toUndo.size) tr.step({ action: 'none', why: 'no transaction was running at the crash' });
    while (toUndo.size) {
      let xid = 0, lsn = -1;
      for (const [x, l] of toUndo) if (l > lsn) { lsn = l; xid = x; }
      const r = lsn ? wal.byLsn(lsn) : null;
      if (lsn && !r) { tr.problem('T' + xid + ': record ' + lsn + ' is not in the log'); toUndo.set(xid, 0); }
      else if (r) {
        const o = { lsn, record: text(db, r), type: r.type, xid, file: r.file, block: r.block, toUndo: [...toUndo].map(([x, l]) => ({ xid: x, undoNext: l })) };
        if (r.type === 'clr') { o.action = 'follow'; o.why = 'a compensation record: its change was already undone; continue at its UndoNextLSN ' + r.undoNext; toUndo.set(xid, r.undoNext); }
        else if (K.HeapRedo.undoable(r)) {
          const u = undoOne(db, r, 'aries');
          o.action = u.skip ? 'skip' : 'undo'; o.why = u.skip || u.what; o.clr = u.clr || null;
          toUndo.set(xid, r.prevLsn || 0);
        } else {
          o.action = 'skip';
          o.why = r.type === 'begin' ? 'the first record of T' + xid : r.type === 'abort' ? 'the rollback had begun' : 'nothing to undo for ' + r.type;
          toUndo.set(xid, r.prevLsn || 0);
        }
        tr.step(o);
      }
      if (toUndo.get(xid) === 0) {
        const e = wal.log({ xid, type: 'end', recovery: true });
        toUndo.delete(xid);
        tr.step({ action: 'end', xid, lsn: e, record: '<T' + xid + ' end>', why: 'all of T' + xid + "'s changes are undone" });
      }
    }
    tr.end({});
  }

  // ---- the basic redo-then-undo algorithm --------------------------------------------------------------------------------------------
  function textbook(db, tr, ck, ctx, res) {
    const wal = db.wal, recs = wal.records;
    const start = ck ? Math.min(ck.lsn, (ck.data && ck.data.redoLsn) || ck.lsn) : recs.length ? recs[0].lsn : 0;
    const undo = new Set();
    // records before the checkpoint are redone only on the pages it lists as dirty: every other page was on disk
    // with them, and redoing them would take the page back to before the checkpoint (fatal if it were then written)
    const ckDirty = new Set(((ck && ck.data && ck.data.dpt) || []).map((d) => pkey(d.file, d.block)));
    // redo phase: forward from the checkpoint, repeat every change; keep the undo list
    tr.begin('redo', { from: start });
    for (const r of recs) {
      if (r.lsn < start) continue;
      const before = [...undo];
      if (r === ck) { for (const x of (ck.data && ck.data.active) || []) undo.add(x); tr.step({ lsn: r.lsn, record: text(db, r), type: r.type, action: 'start', why: 'the last checkpoint: undo-list = L = {' + before.concat((ck.data && ck.data.active) || []).filter((x, i, a) => a.indexOf(x) === i).map((x) => 'T' + x).join(', ') + '}', undoList: [...undo] }); continue; }
      const t = r.top || r.xid;
      if (r.type === 'begin') { undo.add(t); tr.step({ lsn: r.lsn, record: text(db, r), type: r.type, action: 'list', why: 'T' + t + ' added to the undo-list', undoList: [...undo] }); continue; }
      if ((r.type === 'commit' || r.type === 'abort') && !r.sub) { undo.delete(t); tr.step({ lsn: r.lsn, record: text(db, r), type: r.type, action: 'list', why: 'T' + t + ' removed from the undo-list: it ' + (r.type === 'commit' ? 'committed' : 'was rolled back'), undoList: [...undo] }); continue; }
      if (PAGE(r)) {
        if (ck && r.lsn < ck.lsn && !ckDirty.has(pkey(r.file, r.block)) && !ctx.torn.has(pkey(r.file, r.block))) { tr.step({ lsn: r.lsn, record: text(db, r), type: r.type, file: r.file, block: r.block, action: 'skip', why: 'before the checkpoint, on a page the checkpoint did not list as dirty: the change is on disk' }); continue; }
        redoOne(db, ctx, tr, r, true); continue;
      }
      tr.step({ lsn: r.lsn, record: text(db, r), type: r.type, action: 'none', why: 'nothing to redo' });
    }
    checkRepaired(db, ctx, tr);
    tr.end({ undoList: [...undo] });
    res.losers = [...undo]; res.redoLsn = start;
    rebuildClog(db, tr, ck);

    // undo phase: backward from the end of the log, undo the records of transactions in the undo-list
    tr.begin('undo', { undoList: [...undo] });
    const lastOf = new Map();
    for (const r of recs) if (r.xid && undo.has(r.top || r.xid)) lastOf.set(r.top || r.xid, r.lsn);
    for (const [x, l] of lastOf) wal.lastByXid.set(x, l);
    if (!undo.size) tr.step({ action: 'none', why: 'the undo-list is empty' });
    for (let j = recs.length - 1; j >= 0 && undo.size; j--) {
      const r = recs[j];
      if (!r.xid) continue;
      const t = r.top || r.xid;
      if (!undo.has(t)) continue;
      const o = { lsn: r.lsn, record: text(db, r), type: r.type, xid: t, file: r.file, block: r.block };
      if (r.type === 'begin') {
        undo.delete(t);
        o.action = 'abort'; o.lsn2 = wal.log({ xid: t, type: 'abort', recovery: true }); o.why = 'reached <T' + t + ' start>: write <T' + t + ' abort> and take T' + t + ' off the undo-list';
      } else if (r.type === 'clr') { o.action = 'skip'; o.why = 'a redo-only record is never undone'; }
      else if (K.HeapRedo.undoable(r)) { const u = undoOne(db, r, 'textbook'); o.action = u.skip ? 'skip' : 'undo'; o.why = u.skip || u.what + '; a redo-only record is written'; o.clr = u.clr || null; }
      else { o.action = 'skip'; o.why = 'nothing to undo for ' + r.type; }
      o.undoList = [...undo];
      tr.step(o);
    }
    for (const t of undo) { wal.log({ xid: t, type: 'abort', recovery: true }); tr.step({ action: 'abort', xid: t, why: 'no start record left for T' + t + ' in the log: <T' + t + ' abort> written' }); }
    tr.end({});
  }

  // ---- the LSM memtable --------------------------------------------------------------------------------------------------
  // lsm.js keeps the memtable in memory and logs every put; its meta page (block 0, item 1, a row of 32-bit fields)
  // counts flushes in field 9. The puts after the last meta image whose flush count went up were never written to a
  // run: put them back in the memtable. A key is taken from the heap tuple the entry points to (redo has rebuilt it),
  // or decoded from the logged key text when the tuple is gone (a tombstone for a pruned tuple).
  const LSM_FLUSHES = 9;
  function decodeKey(text, t) {
    if (text === '\u0000N') return null;
    if (text === 'T' || text === 'F') return text === 'T';
    if (text[0] === 's') return text.slice(1);
    if (text[0] === 'n') return K.T.input(text.slice(1), t);
    throw new Error('undecodable key');
  }
  function replayLsm(db, tr) {
    const idxs = [...db.catalog.rels.values()].filter((r) => r.kind === 'index' && r.method === 'lsm');
    for (const ix of idxs) {
      // every flush and merge ends by writing the meta page: run or manifest pages logged and then a put (or the end
      // of the log) with no meta image between mean one was cut short, and the runs may have lost entries. Until a
      // later flush has made the repaired memtable durable, every put ever logged goes back in the memtable: the newest
      // put of each (key, TID) wins, so the memtable alone gives the right answer.
      let flushes = -1, pending = [], open = false, interrupted = false;
      const all = [];
      for (const r of db.wal.records) {
        if (r.file !== ix.file) continue;
        if (r.type === 'lsm.put') { if (open) { interrupted = true; open = false; } pending.push(r); all.push(r); continue; }
        const img = r.image || r.fpi;
        if (!img) continue;
        if (r.block !== 0) { open = true; continue; }
        open = false;
        const it = new K.Page(img.slice()).item(1);
        if (!it || it.length < (LSM_FLUSHES + 1) * 4) continue;
        const n = new DataView(it.buffer, it.byteOffset, it.byteLength).getUint32(LSM_FLUSHES * 4, true);
        if (n !== flushes) { if (flushes >= 0) { pending = []; interrupted = false; } flushes = n; }
      }
      if (open) interrupted = true;
      if (interrupted) pending = all;
      const rel = db.catalog.rel(ix.table);
      if (!rel || !db.disk.files.has(ix.file)) continue;
      const am = db.indexAm(ix);
      const heap = db.heap(rel);
      const mem = [];
      let lost = 0;
      for (const r of pending) {
        const d = r.data;
        let key = null;
        const t = d.tomb ? null : heap.fetch({ b: d.b, o: d.o });
        if (t) { key = am.keyOf(K.Tuple.deform(t.bytes, rel.cols, {}), {}); db.buffers.unpin(t.frame, false); }
        else { try { key = d.key.map((k, i) => decodeKey(k, ix.keyTypes[i])); } catch (e) { lost++; continue; } }
        const e = { key: key.map((v) => (v === undefined ? null : v)), b: d.b, o: d.o, tomb: !!d.tomb, seq: ++am.opSeq };
        let lo = 0, hi = mem.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (am.cmpE(mem[m], e) < 0) lo = m + 1; else hi = m; }
        if (lo < mem.length && am.cmpE(mem[lo], e) === 0) mem[lo] = e; else mem.splice(lo, 0, e);
      }
      am.memtable = mem;
      tr.step({ action: 'memtable', why: 'LSM index ' + ix.name + ': ' + mem.length + ' entr' + (mem.length === 1 ? 'y' : 'ies') + (interrupted ? ' (every put in the log: a flush or merge was cut short by the crash)' : ' logged since its last flush') + ' put back in the memtable' + (lost ? ' (' + lost + ' could not be decoded)' : '') });
    }
  }

  // ---- restart --------------------------------------------------------------------------------------------------------------
  /**
   * restart after a crash: rebuild the database from the disk and the stable log. opts.algorithm: 'aries' (default)
   * or 'textbook'. opts.checkpoint: false to skip the end-of-recovery checkpoint. opts.crashAt: crash again at that
   * step (opts.crashMode 'during-write' tears a page as it does). Returns { steps, passes, losers, problems, ... }.
   */
  function restart(db, opts) {
    opts = opts || {};
    const algorithm = opts.algorithm === 'textbook' ? 'textbook' : 'aries';
    if (!db.down) crash(db, { at: 'now' });
    const tr = new Trace(db, algorithm, opts);
    const res = { algorithm, steps: tr.steps, passes: tr.passes, problems: tr.problems, losers: [], crashed: null };
    db.bus.emit('recovery.start', { algorithm });
    db.buffers.recovering = true;
    const recBefore = db.wal.records.length;
    try {
      const { torn, ahead } = tornCheck(db, tr);
      res.torn = torn; res.ahead = ahead;
      const ctx = { torn: new Set(torn.map((t) => pkey(t.file, t.block))), reset: new Set(), imaged: new Set() };
      const ck = opts.checkpointLsn ? db.wal.byLsn(opts.checkpointLsn) : db.wal.lastCheckpoint();
      res.checkpoint = ck ? ck.lsn : 0;
      if (algorithm === 'textbook') textbook(db, tr, ck, ctx, res); else aries(db, tr, ck, ctx, res);
      tr.begin('finish');
      db.heaps.clear(); db.ams.clear(); db.fsms.clear();
      replayLsm(db, tr);
      db.wal.flush(undefined, 'end of recovery');
      if (opts.checkpoint !== false) {
        db.buffers.flushAll(true);
        const lsn = db.wal.log({ type: 'checkpoint', data: { endOfRecovery: true } });
        db.wal.flush(lsn, 'end-of-recovery checkpoint');
        db.lastCheckpoint = lsn;
        tr.step({ action: 'checkpoint', lsn, why: 'end-of-recovery checkpoint: the repaired pages are written, so the next crash starts from here' });
      } else tr.step({ action: 'none', why: 'the log is flushed; pages stay in the buffer pool' });
      tr.end({});
    } catch (e) {
      db.buffers.recovering = false;
      if (e && e.crash) { res.crashed = crash(db, { at: opts.crashMode || 'now', pick: opts.pick || 0 }); return res; }
      throw e;
    }
    db.buffers.recovering = false;
    db.heaps.clear(); db.fsms.clear();
    for (const [f, am] of db.ams) if (!(K.LSMTree && am instanceof K.LSMTree)) db.ams.delete(f);
    for (const s of db.sessions) { s.tx = null; s.waiting = null; }
    res.written = db.wal.records.slice(recBefore).map((r) => ({ lsn: r.lsn, text: text(db, r) }));
    db.down = null;
    db.bus.emit('recovery.done', { algorithm, losers: res.losers, problems: res.problems.length, steps: tr.steps.length });
    return res;
  }

  /** runtime rollback with rollback_undo on: undo the transaction's (or one subtransaction's) changes, newest first */
  function rollback(db, top, subXid) {
    const wal = db.wal;
    const inSub = (x) => { for (let y = x, n = 0; y && n < 1000; y = db.xact.parent.get(y), n++) if (y === subXid) return true; return false; };
    let lsn = wal.lastByXid.get(top) || 0;
    const done = [];
    while (lsn) {
      const r = wal.byLsn(lsn);
      if (!r || (subXid && !inSub(r.xid))) break;
      if (r.type === 'clr') { lsn = r.undoNext; continue; }
      if (K.HeapRedo.undoable(r)) done.push(Object.assign({ lsn: r.lsn }, undoOne(db, r, 'rollback')));
      lsn = r.prevLsn || 0;
    }
    db.bus.emit('recovery.rollback', { xid: top, sub: subXid || null, undone: done.filter((d) => !d.skip).length });
    return done;
  }

  /** a checkpoint: sharp (write every dirty page first) or fuzzy (ARIES: just log the two tables) */
  function checkpoint(db, opts) {
    opts = opts || {};
    if (!opts.fuzzy) db.buffers.flushAll(opts.all);
    const lsn = db.wal.log({ type: 'checkpoint', data: { fuzzy: !!opts.fuzzy } });
    db.wal.flush(lsn, opts.fuzzy ? 'fuzzy checkpoint' : 'checkpoint');
    db.lastCheckpoint = lsn;
    db.bus.emit('checkpoint', { lsn, fuzzy: !!opts.fuzzy });
    return db.wal.byLsn(lsn);
  }

  // ---- loss of non-volatile storage: archival dump and log replay ------------------------------------------------------
  /** an archival dump: every page written, a checkpoint, then a copy of the whole disk; the log goes on past it */
  function dump(db) {
    if (db.down) throw K.err(K.STATE.invalidTxnState, 'the database is down: restart it first');
    db.wal.flush(undefined, 'dump');
    db.buffers.flushAll(true);
    const ck = checkpoint(db, {});
    const disk = db.disk.snapshot();
    const lsn = db.wal.log({ type: 'dump', data: { checkpoint: ck.lsn } });
    db.wal.flush(lsn, 'dump');
    db.bus.emit('recovery.dump', { lsn: ck.lsn });
    return { lsn: ck.lsn, dumpLsn: lsn, disk, active: ck.data.active.slice() };
  }
  /** the disk fails: every block is gone (the log, on its own stable storage, survives) */
  function loseDisk(db) {
    if (!db.down) crash(db, { at: 'now' });
    for (const f of db.disk.files.values()) f.blocks = f.blocks.map(() => new Uint8Array(db.disk.pageSize));
    db.bus.emit('recovery.diskLost', {});
  }
  /** restore the most recent dump, then replay the log from it (redo, then undo of the incomplete transactions) */
  function restoreFromDump(db, d, opts) {
    if (!db.down) crash(db, { at: 'now' });
    const files = [...db.disk.files.values()].map((f) => ({ id: f.id, name: f.name, kind: f.kind }));
    const next = db.disk.nextFile;
    db.disk.restore(d.disk);
    for (const f of files) db.disk.ensure(f.id, undefined, f.name, f.kind);
    db.disk.nextFile = Math.max(db.disk.nextFile, next);
    db.bus.emit('recovery.restore', { lsn: d.lsn });
    return restart(db, Object.assign({}, opts || {}, { checkpointLsn: d.lsn }));
  }

  // ---- remote backup by log shipping -------------------------------------------------------------------------------------
  /**
   * a remote backup site: it starts from a copy of the primary's disk and receives the log as the primary flushes it
   * (opts.lag: hold back that many flushes, as an asynchronous one-safe backup would), redoing it on its own copy of
   * the pages. takeover() makes it the primary: a new database from its pages and log, restarted with ARIES.
   */
  class RemoteBackup {
    constructor(primary, opts) {
      opts = opts || {};
      this.primary = primary;
      this.lag = opts.lag || 0;
      primary.wal.flush(undefined, 'remote backup started');
      primary.buffers.flushAll(true);
      this.disk = primary.disk.snapshot();
      this.log = primary.wal.records.filter((r) => r.lsn <= primary.wal.flushedLsn);
      this.received = primary.wal.flushedLsn;
      this.applied = this.received;
      this.queue = [];
      this.history = [{ action: 'start', lsn: this.received }];
      this.off = primary.bus.on('wal.flush', () => this.ship());
    }
    /** the primary flushed its log: send what is new (it arrives after lag more flushes) */
    ship() {
      const w = this.primary.wal;
      const sent = w.records.filter((r) => r.lsn > (this.queue.length ? this.queue[this.queue.length - 1].upTo : this.received) && r.lsn <= w.flushedLsn);
      if (sent.length) this.queue.push({ upTo: sent[sent.length - 1].lsn, recs: sent });
      while (this.queue.length > this.lag) {
        const batch = this.queue.shift();
        this.log.push(...batch.recs);
        this.received = batch.upTo;
        this.history.push({ action: 'receive', records: batch.recs.length, lsn: batch.upTo });
      }
    }
    /** redo the received log on the backup's pages (PageLSN decides, as ARIES redo does) */
    apply() {
      const files = new Map(this.disk.files.map((f) => [f.id, f]));
      let n = 0;
      for (const r of this.log) {
        if (r.lsn <= this.applied || !PAGE(r)) continue;
        let f = files.get(r.file);
        if (!f) { f = { id: r.file, name: 'file ' + r.file, kind: 'heap', blocks: [] }; files.set(r.file, f); this.disk.files.push(f); this.disk.next = Math.max(this.disk.next, r.file + 1); }
        while (f.blocks.length <= r.block) f.blocks.push(new Uint8Array(this.disk.pageSize));
        const p = new K.Page(f.blocks[r.block]);
        if (p.lsn < r.lsn) { K.HeapRedo.redo(p, r); n++; }
      }
      if (this.log.length) this.applied = Math.max(this.applied, this.log[this.log.length - 1].lsn);
      this.history.push({ action: 'apply', redone: n, lsn: this.applied });
      return n;
    }
    /** the primary is gone: the backup takes over; transactions the backup has no commit record for are rolled back */
    takeover(opts) {
      this.off();
      this.apply();
      const p = this.primary;
      const db = new K.Database({ pageSize: p.disk.pageSize, frames: p.buffers.n, settings: Object.assign({}, p.settings) });
      db.disk.restore(this.disk);
      for (const f of this.disk.files) if (p.disk.files.has(f.id)) db.disk.file(f.id).name = p.disk.file(f.id).name;
      db.catalog = p.catalog.clone(); db.catalog.db = db;
      db.seqs = new Map([...p.seqs].map(([k, v]) => [k, Object.assign({}, v)]));
      db.xact.next = p.xact.next;
      db.wal.records = this.log.slice();
      db.wal.flushedLsn = this.received;
      db.wal.nextLsn = this.log.length ? this.log[this.log.length - 1].lsn + this.log[this.log.length - 1].size : 1;
      db.down = { at: 'takeover' };
      const result = restart(db, Object.assign({ algorithm: 'aries' }, opts || {}));
      this.history.push({ action: 'takeover', losers: result.losers });
      return { db, result };
    }
  }

  // ---- shadow paging, for contrast ---------------------------------------------------------------------------------------
  /**
   * shadow paging: no log. A transaction works on a copy of the page table; each page it writes is first copied to a
   * free block (copy on write) and the current page table points there, while the shadow page table on disk still
   * points to the old blocks. Commit writes the new page table and then switches the database pointer to it in one
   * atomic write; a crash before that leaves the shadow table, and the old pages, in force. Every step is in history.
   */
  class ShadowPaging {
    constructor(opts) {
      opts = opts || {};
      const values = opts.values || K.range(opts.pages || 6).map((i) => String.fromCharCode(65 + i));
      this.blocks = values.map((v) => ({ value: v, used: true }));
      for (let i = 0; i < (opts.spare || values.length); i++) this.blocks.push({ value: null, used: false });
      this.tables = [{ entries: values.map((v, i) => i) }]; // page tables written to disk
      this.pointer = 0;   // the database pointer: which page table on disk is the committed one
      this.current = null; this.copied = null; this.history = [];
      this.record('init', 'the database pointer points to page table 0; page i is in block i');
    }
    get shadow() { return this.tables[this.pointer].entries; }
    record(action, note) { this.history.push({ n: this.history.length, action, note, pointer: this.pointer, shadow: this.shadow.slice(), current: this.current ? this.current.slice() : null, blocks: this.blocks.map((b) => (b.used ? b.value : null)) }); }
    alloc() { const i = this.blocks.findIndex((b) => !b.used); if (i < 0) { this.blocks.push({ value: null, used: false }); return this.blocks.length - 1; } return i; }
    begin() {
      if (this.current) throw K.err(K.STATE.activeTxn, 'a transaction is already running');
      this.current = this.shadow.slice(); this.copied = new Set();
      this.record('begin', 'the current page table starts as a copy of the shadow page table');
    }
    read(page) { const t = this.current || this.shadow; return this.blocks[t[page]].value; }
    write(page, value) {
      if (!this.current) throw K.err(K.STATE.noActiveTxn, 'no transaction is running');
      if (!this.copied.has(page)) {
        const b = this.alloc(), old = this.current[page];
        this.blocks[b] = { value: this.blocks[old].value, used: true };
        this.current[page] = b; this.copied.add(page);
        this.record('copy', 'page ' + page + ' is copied from block ' + old + ' to free block ' + b + '; the current page table points to ' + b + ', the shadow still to ' + old);
      }
      this.blocks[this.current[page]].value = value;
      this.record('write', 'page ' + page + ' := ' + value + ' in block ' + this.current[page]);
    }
    commit() {
      if (!this.current) throw K.err(K.STATE.noActiveTxn, 'no transaction is running');
      const old = this.shadow.slice();
      this.tables.push({ entries: this.current.slice() });
      this.record('write-table', 'the pages are on disk; the current page table is written to disk as table ' + (this.tables.length - 1));
      this.pointer = this.tables.length - 1;
      for (const p of this.copied) this.blocks[old[p]].used = false;
      this.current = null; this.copied = null;
      this.record('commit', 'one atomic write: the database pointer now points to table ' + this.pointer + ', which becomes the shadow; the old blocks are free (garbage)');
    }
    abort() {
      if (!this.current) throw K.err(K.STATE.noActiveTxn, 'no transaction is running');
      for (const p of this.copied) this.blocks[this.current[p]].used = false;
      this.current = null; this.copied = null;
      this.record('abort', 'the current page table is dropped and its copied blocks freed: nothing to undo');
    }
    crash() {
      const lost = this.current ? [...this.copied].map((p) => this.current[p]) : [];
      for (const b of lost) this.blocks[b].used = false;
      this.current = null; this.copied = null;
      this.record('crash', 'memory is lost; the database pointer still names the shadow page table, so the database is as of the last commit' + (lost.length ? ' (blocks ' + lost.join(', ') + ' become garbage)' : ''));
    }
    state() { return { pointer: this.pointer, shadow: this.shadow.slice(), current: this.current ? this.current.slice() : null, values: this.shadow.map((b) => this.blocks[b].value) }; }
  }

  // ---- describe ----------------------------------------------------------------------------------------------------------
  function describe(db) {
    const ck = db.wal.lastCheckpoint();
    return {
      design: [
        'Log records are physiological: a heap record names a page and an item; redo writes the item bytes the record carries (the new tuple, or the tuple header after the change), undo puts back the before-image of the header or marks an inserted tuple invalid (XMIN_INVALID). B+ tree and other index pages, and pruned heap pages, are logged as whole page images and are redone physically.',
        'The LSM memtable is in memory only: at restart the lsm.put records logged since the index\'s last flush (its meta page counts flushes) are put back in the memtable.',
        'Indexes are not undone: an index entry left by a transaction that is rolled back points to a heap tuple no snapshot can see (its inserter aborted), so lookups skip it and VACUUM removes it, as in PostgreSQL. Undoing an index page image would also undo other transactions\' entries on the same page.',
        'Torn pages: every page written carries a checksum in pd_checksum; restart checks every page first. A torn page cannot be read, so (as PostgreSQL does with full_page_writes) the first change to a page after it was read or written logs an image of the whole page; redo starts the torn page from that image. With full_page_writes off a torn page is detected but cannot be repaired.',
        'The catalog is not on the simulated disk: it is treated as stable storage updated atomically at commit, so after a crash it holds exactly the committed DDL; the buffer pool, the heap and index caches and the free space maps are rebuilt from the disk.',
        'The commit log (clog) is rebuilt from the stable log: a transaction with a commit record committed, every other one aborted; MVCC visibility then hides the losers\' tuples even before undo has touched them. The xid counter never goes back.',
        'Normal rollback is PostgreSQL\'s: the abort record and the commit log make the transaction\'s tuples invisible, nothing on the pages is changed (set rollback_undo on to undo the pages with compensation records, the classic rollback). An abort or a commit is followed by an end record.',
        'Checkpoints: CHECKPOINT writes every dirty page (with buffer_steal off, pages holding uncommitted changes stay) and logs the transaction table and the dirty page table; Recovery.checkpoint(db, { fuzzy: true }) writes no page (ARIES fuzzy checkpoint). The basic redo-then-undo restart starts its redo at the oldest recLSN the checkpoint lists, ARIES at the smallest recLSN of the dirty page table analysis rebuilds.',
        'Log buffering: records wait in the log buffer until a commit, a full buffer (wal_buffers) or the WAL rule forces a flush; one flush writes every buffered record, so commits of several transactions can go to disk in one group.',
      ],
      settings: Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, K.settingOf(db, k)])),
      state: {
        down: !!db.down, nextLsn: db.wal.nextLsn, flushedLsn: db.wal.flushedLsn, buffered: db.wal.pending().length, checkpoint: ck ? ck.lsn : 0,
        dirtyPages: db.buffers.dirtyPages(), transactions: [...db.xact.active.values()].filter((t) => t.xid).map((t) => ({ xid: t.xid, lastLsn: db.wal.lastByXid.get(t.xid) || 0 })),
        violations: db.buffers.violations.slice(),
      },
    };
  }

  K.Recovery = { crash, restart, checkpoint, rollback, dump, loseDisk, restoreFromDump, describe, records, text, fates: fatesOf, RemoteBackup, DEFAULTS };
  K.RemoteBackup = RemoteBackup;
  K.ShadowPaging = ShadowPaging;
})(typeof window !== 'undefined' ? window : globalThis);
