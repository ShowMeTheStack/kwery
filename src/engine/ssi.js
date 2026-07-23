// Serializable Snapshot Isolation, as PostgreSQL implements it for SERIALIZABLE (Cahill, Röhm and Fekete;
// Ports and Grittner; src/backend/storage/lmgr/predicate.c). Each serializable transaction reads from its
// snapshot as under REPEATABLE READ, and also leaves SIREAD locks on what it read: a whole relation for a
// sequential scan, the B+ tree leaf pages an index scan visited, and each heap tuple it fetched, promoted to
// the page and then the relation when there are many. SIREAD locks block nobody. They record rw-antidependencies:
// T1 -rw-> T2 when T1 read a version that T2 replaced, or did not see a row T2 inserted (T1 must come first in
// any equivalent serial order). A cycle in the serialization graph always contains two consecutive rw edges
// T1 -rw-> T2 -rw-> T3, with T3 the first of the three to commit (Fekete et al.); when such a dangerous structure
// appears one transaction is cancelled with SQLSTATE 40001, as PostgreSQL does. Committed transactions are kept,
// with their locks and conflicts, until no transaction that overlapped them is running.
(function (root) {
  'use strict';
  const K = root.K;
  const S = K.STATE;
  const IM = () => K.Tuple.IM;

  const MSG = 'could not serialize access due to read/write dependencies among transactions';
  const HINT = 'The transaction might succeed if retried.';
  const failure = (reason) => K.err(S.serialization, MSG, { detail: 'Reason code: ' + reason, hint: HINT });
  // PostgreSQL's limits: max_pred_locks_per_transaction 64, max_pred_locks_per_relation -2 (meaning 64 / 2),
  // max_pred_locks_per_page 2; a parent is taken once a transaction holds more child locks than the threshold
  const LIMITS = { max_pred_locks_per_transaction: 64, max_pred_locks_per_relation: -2, max_pred_locks_per_page: 2 };

  function state(db) {
    if (!db.ssi) db.ssi = { sx: new Map(), locks: new Map(), seq: 0, finished: [] };
    return db.ssi;
  }
  const limit = (db, k) => { const v = db.settings[k]; return typeof v === 'number' ? v : LIMITS[k]; };
  function threshold(db, t) {
    if (t.kind === 'page') return limit(db, 'max_pred_locks_per_page') - 1;
    const r = limit(db, 'max_pred_locks_per_relation');
    return r < 0 ? Math.floor(limit(db, 'max_pred_locks_per_transaction') / -r) - 1 : r;
  }

  // ---- lock targets: a relation (heap or index), a page of one, a heap tuple -----------------------------------
  const relT = (file, name) => ({ kind: 'relation', file, name, key: 'r:' + file, label: name });
  const pageT = (file, name, b) => ({ kind: 'page', file, name, block: b, key: 'p:' + file + ':' + b, label: name + ' page ' + b });
  const tupT = (file, name, b, o) => ({ kind: 'tuple', file, name, block: b, off: o, key: 't:' + file + ':' + b + ':' + o, label: name + ' (' + b + ',' + o + ')' });
  const parentOf = (t) => (t.kind === 'tuple' ? pageT(t.file, t.name, t.block) : t.kind === 'page' ? relT(t.file, t.name) : null);
  const under = (t, p) => t.file === p.file && (p.kind === 'relation' ? t.kind !== 'relation' : p.kind === 'page' && t.kind === 'tuple' && t.block === p.block);

  // ---- serializable transactions ----------------------------------------------------------------------------------
  const isRO = (s) => s.readOnly || s.implicitRO;
  const label = (s) => 'T' + s.id + (s.tx.xid ? ' (xid ' + s.tx.xid + ')' : '');
  function emit(db, type, data) { db.bus.emit('ssi.' + type, data); }

  function create(db, tx) {
    const st = state(db);
    const s = {
      id: tx.id, tx, snap: tx.snapshot, readOnly: !!tx.readOnly, implicitRO: false, doomed: false, prepared: false, committed: false, roSafe: false, roUnsafe: false,
      conflictOut: false, outCommitted: [], didWrite: false, prepareSeq: 0, commitSeq: 0, finishedBefore: 0,
      out: new Set(), in: new Set(), locks: new Map(), unsafe: new Set(), unsafeFor: new Set(),
    };
    if (s.readOnly) {
      // a READ ONLY transaction can only be hurt by read-write transactions running now; if each of them commits
      // without a conflict out to a transaction committed before our snapshot, ours is a safe snapshot
      for (const o of st.sx.values()) if (!o.committed && !o.doomed && !isRO(o)) { s.unsafe.add(o); o.unsafeFor.add(s); }
      if (!s.unsafe.size) { tx.ssiOptOut = true; emit(db, 'safe', { tx: tx.id, why: 'read-only with no concurrent read-write serializable transaction: it runs as REPEATABLE READ' }); return null; }
    }
    st.sx.set(tx.id, s);
    emit(db, 'begin', { tx: tx.id, readOnly: s.readOnly, xmin: s.snap.xmin });
    return s;
  }
  /** the transaction's SSI state, registering it (and any serializable transaction that took its snapshot earlier) */
  function register(db, tx) {
    const st = state(db);
    const s = st.sx.get(tx.id);
    if (s) return s;
    if (tx.ssiOptOut || !tx.snapshot) return null;
    // PostgreSQL registers at snapshot time; we do it on first use, so register the others that started before
    for (const o of [...db.xact.active.values()].sort((a, b) => a.id - b.id)) if (o !== tx && o.id < tx.id && o.isolation === 'serializable' && o.snapshot && !o.ssiOptOut && !o.abortedNow && !st.sx.has(o.id)) create(db, o);
    return create(db, tx);
  }
  function needed(db, ctx) {
    const tx = ctx && ctx.tx;
    if (!tx || db.protocol || tx.isolation !== 'serializable' || tx.ssiOptOut || ctx.snap === 'any') return null;
    const s = register(db, tx);
    if (s && s.roSafe) { releaseSafe(db, s); return null; }
    return s;
  }
  const sxOfXid = (db, xid) => { for (const s of state(db).sx.values()) if (s.tx.xid === xid) return s; return null; };
  /** was other's commit before s took its snapshot? (other committed with an xid s's snapshot counts as finished) */
  const before = (db, other, s) => other.committed && !!other.tx.xid && db.xact.visibleIn(other.tx.xid, s.snap);
  const concurrent = (s, xid) => xid >= s.snap.xmin && (xid >= s.snap.xmax || s.snap.xip.has(xid));

  // ---- SIREAD locks --------------------------------------------------------------------------------------------------
  function covered(s, t) { if (s.locks.has(t.key)) return true; for (let p = parentOf(t); p; p = parentOf(p)) if (s.locks.has(p.key)) return true; return false; }
  function addLock(db, s, t) {
    const st = state(db);
    s.locks.set(t.key, t);
    let e = st.locks.get(t.key);
    if (!e) { e = { target: t, holders: new Set() }; st.locks.set(t.key, e); }
    e.holders.add(s);
  }
  function dropLock(db, s, key) {
    const st = state(db);
    s.locks.delete(key);
    const e = st.locks.get(key);
    if (e) { e.holders.delete(s); if (!e.holders.size) st.locks.delete(key); }
  }
  function acquire(db, s, t) {
    if (covered(s, t)) return;
    addLock(db, s, t);
    emit(db, 'lock', { tx: s.id, kind: t.kind, target: t.label });
    // promotion: to the coarsest ancestor whose count of this transaction's locks below it passed its threshold
    let promote = null;
    for (let p = parentOf(t); p; p = parentOf(p)) {
      let n = 0;
      for (const l of s.locks.values()) if (under(l, p)) n++;
      if (n > threshold(db, p)) promote = p;
    }
    if (promote) {
      emit(db, 'promote', { tx: s.id, from: t.kind, to: promote.kind, target: promote.label });
      acquire(db, s, promote);
      return;
    }
    if (t.kind !== 'tuple') for (const l of [...s.locks.values()]) if (under(l, t)) dropLock(db, s, l.key);
  }

  // ---- rw-conflicts and the dangerous structure -------------------------------------------------------------------
  function flag(db, reader, writer, me, what, how) {
    reader.out.add(writer);
    writer.in.add(reader);
    emit(db, 'rw', { reader: reader.id, writer: writer.id, what, how, edge: 'T' + reader.id + ' -rw-> T' + writer.id, label: 'rw-dependency: T' + reader.id + ' read ' + (what || 'data') + ' that T' + writer.id + ' ' + (how === 'in' ? 'then wrote' : 'wrote concurrently') });
    check(db, reader, writer, me);
  }
  /** OnConflict_CheckForSerializationFailure: did the new edge reader -rw-> writer complete a dangerous structure? */
  function check(db, reader, writer, me) {
    let bad = false, why = '';
    // R -rw-> W -rw-> T2, W already committed with a conflict out: T2 committed before W
    if (writer.committed && writer.conflictOut) { bad = true; why = 'T' + writer.id + ' committed with a conflict out to a transaction that committed before it'; }
    // R -rw-> W -rw-> T2 with T2 prepared first, unless the reader or the writer committed before T2,
    // or the reader is read-only and took its snapshot before T2 committed
    if (!bad) {
      for (const t2 of writer.out) {
        if (t2.prepared && (!reader.committed || t2.prepareSeq <= reader.commitSeq) && (!writer.committed || t2.prepareSeq <= writer.commitSeq) && (!isRO(reader) || before(db, t2, reader))) { bad = true; why = 'T' + reader.id + ' -rw-> T' + writer.id + ' -rw-> T' + t2.id + ', and T' + t2.id + ' committed first'; break; }
      }
    }
    // T0 -rw-> R -rw-> W with W committed (prepared) first, unless T0 committed before W or is read-only and overlaps it
    if (!bad && writer.prepared && !isRO(reader)) {
      for (const t0 of reader.in) {
        if (!t0.doomed && (!t0.committed || t0.commitSeq >= writer.prepareSeq) && (!isRO(t0) || before(db, writer, t0))) { bad = true; why = 'T' + t0.id + ' -rw-> T' + reader.id + ' -rw-> T' + writer.id + ', and T' + writer.id + ' committed first'; break; }
      }
    }
    if (!bad) return;
    emit(db, 'dangerous', { reader: reader.id, writer: writer.id, why });
    // cancel the writer if it is us; if the writer has already committed, the reader (us) has to go;
    // otherwise doom the writer: it fails at its next read, write or commit
    if (me === writer) { cancel(db, me, 'Canceled on identification as a pivot, during write.', why); }
    if (writer.prepared) { cancel(db, me, 'Canceled on conflict out to pivot ' + (writer.tx.xid || writer.id) + ', during read.', why); }
    doom(db, writer, why);
  }
  function doom(db, s, why) { if (s.doomed) return; s.doomed = true; emit(db, 'doom', { tx: s.id, why }); }
  /** fail this transaction: it is released at once (PostgreSQL releases on the error, not at ROLLBACK) */
  function cancel(db, s, reason, why) {
    emit(db, 'fail', { tx: s.id, reason, why: why || null });
    const e = failure(reason);
    s.doomed = true;
    release(db, s, false);
    throw e;
  }

  /** CheckForSerializableConflictOut: we read a version written by xid, which our snapshot does not include */
  function conflictOut(db, me, xid, what) {
    if (me.doomed) cancel(db, me, 'Canceled on identification as a pivot, during conflict out checking.');
    const w = sxOfXid(db, xid);
    if (!w || w === me || w.doomed) return;
    // a read-only transaction comes first in the serial order unless the writer had a conflict out to a
    // transaction that committed before our snapshot
    if (isRO(me) && w.committed && (!w.conflictOut || !w.outCommitted.some((c) => before(db, c, me)))) return;
    if (!concurrent(me, xid)) return;
    if (me.out.has(w)) return;
    flag(db, me, w, me, what, 'out');
  }
  /** HeapCheckForSerializableConflictOut: which transaction, if any, wrote what this version shows or hides */
  function checkTuple(db, me, h, visible, what) {
    const x = db.xact;
    const xmin = h.xmin;
    if (h.infomask & IM().XMIN_INVALID || x.aborted(xmin)) return;
    const del = h.xmax && !(h.infomask & IM().XMAX_INVALID) && !(h.infomask & IM().XMAX_LOCK_ONLY) && !x.aborted(h.xmax) ? h.xmax : 0;
    let xid;
    if (x.inProgress(xmin)) xid = xmin;                                    // insert in progress
    else if (!del) { if (visible) return; xid = xmin; }                    // live: we see it, or its inserter is too new
    else if (x.inProgress(del)) xid = visible ? del : xmin;                // delete in progress
    else { if (x.top(del) < me.snap.xmin) return; xid = visible ? del : xmin; } // recently dead
    xid = x.top(xid);
    if (xid < me.snap.xmin || me.tx.xids.has(xid)) return;
    conflictOut(db, me, xid, what);
  }
  /** CheckForSerializableConflictIn: we are writing; any reader holding a SIREAD lock on a target -rw-> us */
  function conflictIn(db, me, targets) {
    if (me.doomed) cancel(db, me, 'Canceled on identification as a pivot, during conflict in checking.');
    me.didWrite = true;
    const st = state(db);
    for (const t of targets) {
      const e = st.locks.get(t.key);
      if (!e) continue;
      for (const r of [...e.holders]) {
        if (r === me || r.doomed) continue;
        if (r.committed && !(me.snap.xmin < r.finishedBefore)) continue;
        if (r.out.has(me)) continue;
        flag(db, r, me, me, t.label, 'in');
      }
    }
  }

  // ---- end of transaction ----------------------------------------------------------------------------------------------
  /** PreCommit_CheckForSerializationFailure: a pivot reading from us and read by another live transaction is doomed */
  function preCommit(db, s) {
    if (s.doomed) cancel(db, s, 'Canceled on identification as a pivot, during commit attempt.');
    for (const near of s.in) {
      if (near.committed || near.doomed) continue;
      for (const far of near.in) {
        if (far === s || (!far.committed && !isRO(far) && !far.doomed)) {
          if (near.prepared) cancel(db, s, 'Canceled on commit attempt with conflict in from prepared pivot.');
          doom(db, near, 'T' + far.id + ' -rw-> T' + near.id + ' -rw-> T' + s.id + ', and T' + s.id + ' commits first');
          break;
        }
      }
    }
    s.prepareSeq = ++state(db).seq;
    s.prepared = true;
  }
  function unlink(s) {
    for (const w of s.out) w.in.delete(s);
    for (const r of s.in) r.out.delete(s);
    s.out.clear(); s.in.clear();
  }
  function dropAllLocks(db, s) { for (const k of [...s.locks.keys()]) dropLock(db, s, k); }
  function forget(db, s) {
    const st = state(db);
    dropAllLocks(db, s);
    unlink(s);
    for (const o of s.unsafe) o.unsafeFor.delete(s);
    s.unsafe.clear();
    st.sx.delete(s.id);
    st.finished = st.finished.filter((f) => f !== s);
  }
  /** ReleasePredicateLocks */
  function release(db, s, commit) {
    const st = state(db);
    if (!st.sx.has(s.id)) return;
    if (commit) {
      s.committed = true;
      s.commitSeq = ++st.seq;
      if (!s.didWrite) s.implicitRO = true;
      s.finishedBefore = db.xact.next;
    } else { s.doomed = true; s.prepared = false; }
    if (s.readOnly) { for (const o of s.unsafe) o.unsafeFor.delete(s); s.unsafe.clear(); }
    for (const w of [...s.out]) {
      if (commit && !isRO(s) && w.committed) { s.conflictOut = true; s.outCommitted.push(w); }
      if (!commit || w.committed) { s.out.delete(w); w.in.delete(s); }
    }
    for (const r of [...s.in]) if (!commit || r.committed || isRO(r)) { s.in.delete(r); r.out.delete(s); }
    if (!s.readOnly) {
      // read-only transactions waiting to learn whether their snapshot is safe
      for (const ro of [...s.unsafeFor]) {
        if (commit && s.didWrite && s.conflictOut && s.outCommitted.some((c) => before(db, c, ro))) {
          ro.roUnsafe = true;
          for (const o of ro.unsafe) o.unsafeFor.delete(ro);
          ro.unsafe.clear();
          emit(db, 'unsafe', { tx: ro.id, because: s.id });
        } else {
          ro.unsafe.delete(s);
          if (!ro.unsafe.size && !ro.roUnsafe) { ro.roSafe = true; emit(db, 'safe', { tx: ro.id, why: 'every concurrent read-write transaction finished without making its snapshot unsafe' }); }
        }
      }
      s.unsafeFor.clear();
    }
    emit(db, commit ? 'commit' : 'abort', { tx: s.id });
    if (commit) st.finished.push(s); else forget(db, s);
  }
  /** a read-only transaction known to be safe drops its locks and conflicts and runs on as REPEATABLE READ */
  function releaseSafe(db, s) {
    forget(db, s);
    s.tx.ssiOptOut = true;
    emit(db, 'release', { tx: s.id, why: 'safe snapshot' });
  }
  /** ClearOldPredicateLocks: committed transactions no running serializable transaction overlaps are forgotten */
  function clearOld(db, ending) {
    const st = state(db);
    let xmin = Infinity, writable = false;
    for (const t of db.xact.active.values()) {
      if (t === ending || t.isolation !== 'serializable' || !t.snapshot || t.ssiOptOut || t.abortedNow) continue;
      xmin = Math.min(xmin, t.snapshot.xmin);
      if (!t.readOnly) writable = true;
    }
    for (const f of [...st.finished]) {
      if (f.finishedBefore <= xmin) { forget(db, f); emit(db, 'release', { tx: f.id, why: 'no running transaction overlaps it' }); }
      // with only read-only transactions left nobody can write against these locks, but the conflicts still count
      else if (!writable && f.locks.size) { dropAllLocks(db, f); emit(db, 'release', { tx: f.id, why: 'locks only: no read-write transaction is running' }); }
    }
  }

  // ---- index pages -------------------------------------------------------------------------------------------------------
  const isBtree = (am) => K.BTree && am instanceof K.BTree;
  /** the leaf pages a B+ tree search with these bounds visits (counted through the tree's own pin) */
  function leafPages(db, am, bounds, backward) {
    const blocks = new Set();
    const pin = am.pin;
    am.pin = function (b) { const n = pin.call(this, b); if (n.leaf) blocks.add(b); return n; };
    db.bus.muted++;
    let any = false;
    try { for (const e of am.search(bounds, backward)) { void e; any = true; } } finally { am.pin = pin; db.bus.muted--; }
    return { blocks: [...blocks], any };
  }
  function evalBounds(node, ctx) {
    const C = (e) => K.Expr.compile(e, node.layout)([], ctx);
    return node.bounds.map((b) => Object.assign({}, b, { v: Array.isArray(b.v) ? b.v.map(C) : b.v ? C(b.v) : undefined }));
  }
  function emptyIndex(db, am) { db.bus.muted++; try { for (const e of am.search([])) { void e; return false; } return true; } finally { db.bus.muted--; } }
  /** the leaf page a key goes into */
  function leafFor(db, am, key, tid) {
    db.bus.muted++;
    try { const { leaf } = am.descend(key, tid); const b = leaf.block; am.unpin(leaf, false); return b; } finally { db.bus.muted--; }
  }
  function indexTargets(db, rel, vals, tid, ctx, only) {
    const cat = db.catalogOf(ctx);
    const out = [];
    for (const ix of cat.indexesOf(rel)) {
      if (only && !only(ix)) continue;
      const am = db.indexAm(ix, cat);
      if (isBtree(am)) { try { out.push(pageT(ix.file, ix.name, leafFor(db, am, am.keyOf(vals, ctx), tid))); } catch (e) { void e; } }
      out.push(relT(ix.file, ix.name));
    }
    return out;
  }
  function fetchVals(db, rel, tid, ctx) {
    const t = db.heap(rel).fetch(tid);
    if (!t) return null;
    try { return K.Tuple.deform(t.bytes, rel.cols, ctx); } finally { db.buffers.unpin(t.frame, false); }
  }

  // ---- the hooks the executor calls for SERIALIZABLE transactions ------------------------------------------------------
  K.SSI = {
    /** every version a scan examines: rw-conflicts out, then a tuple SIREAD lock on the versions it sees */
    *onRead(db, rel, tid, h, r, ctx) {
      const s = needed(db, ctx);
      if (!s) return;
      if (s.doomed) cancel(db, s, 'Canceled on identification as a pivot, during conflict out checking.');
      // a version this transaction wrote needs no SIREAD lock: its write covers it
      if (r.visible && !ctx.tx.xids.has(h.xmin)) acquire(db, s, tupT(rel.file, rel.name, tid.b, tid.o));
      checkTuple(db, s, h, r.visible, rel.name + ' (' + tid.b + ',' + tid.o + ')');
    },
    /** a sequential scan reads the whole relation, so it locks the whole relation */
    *onScan(db, rel, node, ctx) {
      const s = needed(db, ctx);
      if (s) acquire(db, s, relT(rel.file, rel.name));
    },
    /** an index scan locks the B+ tree leaf pages it visits (the relation, for an empty index or another method) */
    *onIndexScan(db, rel, node, ctx) {
      const s = needed(db, ctx);
      if (!s || !node.index) return;
      const ix = node.index;
      const am = db.indexAm(ix, db.catalogOf(ctx));
      if (!isBtree(am)) { acquire(db, s, relT(ix.file, ix.name)); return; }
      let pages;
      try { pages = leafPages(db, am, evalBounds(node, ctx), node.dir === 'backward'); } catch (e) { void e; acquire(db, s, relT(ix.file, ix.name)); return; }
      if (!pages.any && emptyIndex(db, am)) { acquire(db, s, relT(ix.file, ix.name)); return; }
      for (const b of pages.blocks) acquire(db, s, pageT(ix.file, ix.name, b));
    },
    /** an UPDATE or DELETE of the version at tid, after any wait for its row lock */
    *onWrite(db, rel, tid, ctx) {
      const s = needed(db, ctx);
      if (!s) return;
      conflictIn(db, s, [tupT(rel.file, rel.name, tid.b, tid.o), pageT(rel.file, rel.name, tid.b), relT(rel.file, rel.name)]);
    },
    /** an INSERT: the relation (somebody's sequential scan) and the index leaf pages the new keys go into */
    *onInsert(db, rel, tid, vals, ctx) {
      const s = needed(db, ctx);
      if (!s) return;
      conflictIn(db, s, [relT(rel.file, rel.name)].concat(indexTargets(db, rel, vals, tid, ctx)));
    },
    /** an UPDATE's new version: its index entries are inserts, unless the key did not change (a HOT update) */
    onNewVersion(db, rel, oldTid, newTid, ctx) {
      const s = needed(db, ctx);
      if (!s) return;
      const nv = fetchVals(db, rel, newTid, ctx), ov = fetchVals(db, rel, oldTid, ctx);
      if (!nv) return;
      const cat = db.catalogOf(ctx);
      const changed = (ix) => { const am = db.indexAm(ix, cat); return !ov || !am.cmpKey || am.cmpKey(am.keyOf(nv, ctx), am.keyOf(ov, ctx)) !== 0; };
      const targets = indexTargets(db, rel, nv, newTid, ctx, (ix) => { try { return changed(ix); } catch (e) { void e; return true; } });
      if (targets.length) conflictIn(db, s, targets);
    },
    *onCommit(db, tx) {
      if (db.protocol) return;
      const s = state(db).sx.get(tx.id);
      if (!s) return;
      if (s.roSafe) { releaseSafe(db, s); return; }
      preCommit(db, s);
    },
    onEnd(db, tx, how) {
      if (!db.ssi) return;
      const s = state(db).sx.get(tx.id);
      if (s) release(db, s, how === 'commit');
      clearOld(db, tx);
    },
    /** for the transactions view: every serializable transaction, its flags, conflicts and SIREAD locks */
    describe(db) {
      const st = state(db);
      return {
        transactions: [...st.sx.values()].map((s) => ({
          tx: s.id, xid: s.tx.xid || null, label: label(s), readOnly: isRO(s), declaredReadOnly: s.readOnly, doomed: s.doomed, prepared: s.prepared, committed: s.committed,
          safe: s.roSafe, unsafe: s.roUnsafe, conflictOut: s.conflictOut, didWrite: s.didWrite,
          out: [...s.out].map((o) => o.id), in: [...s.in].map((o) => o.id), locks: [...s.locks.values()].map((t) => ({ kind: t.kind, target: t.label })),
        })),
        locks: [...st.locks.values()].map((e) => ({ kind: e.target.kind, target: e.target.label, holders: [...e.holders].map((h) => h.id) })),
        edges: [...st.sx.values()].flatMap((s) => [...s.out].map((w) => ({ from: s.id, to: w.id }))),
      };
    },
    MESSAGE: MSG,
    HINT,
  };
})(typeof window !== 'undefined' ? window : globalThis);
