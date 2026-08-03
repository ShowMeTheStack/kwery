// Snapshots of a whole database: the disk's pages, the catalog, the commit log, sequences and statistics, as
// plain JSON. The page is built with the sample database already loaded this way (so it opens at once), and
// a database can be kept in the browser between visits and brought back exactly, dead tuples and all.
(function (root) {
  'use strict';
  const K = root.K;

  const b64 = {
    enc(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return typeof btoa === 'function' ? btoa(s) : Buffer.from(u8).toString('base64'); },
    dec(str) { if (typeof atob !== 'function') return new Uint8Array(Buffer.from(str, 'base64')); const s = atob(str); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; },
  };
  /** pages that are all zero beyond a point are stored without their tail */
  const packBlock = (u8) => { let n = u8.length; while (n > 0 && u8[n - 1] === 0) n--; const head = u8.subarray(0, 24); void head; return [n, b64.enc(u8.subarray(0, n))]; };

  // ---- generic values: Maps, Sets, BigInts, bytes and type descriptors ---------------------------------------
  function isType(v) { return v && typeof v === 'object' && typeof v.cat === 'string' && typeof v.id === 'string' && 'len' in v; }
  function enc(v, ctx) {
    if (v === null || v === undefined || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v === undefined ? { $u: 1 } : v;
    if (typeof v === 'bigint') return { $b: v.toString() };
    if (typeof v === 'function') return { $u: 1 };
    if (v instanceof Uint8Array) return { $x: b64.enc(v) };
    if (v instanceof Map) return { $m: [...v].map(([k, x]) => [enc(k, ctx), enc(x, ctx)]) };
    if (v instanceof Set) return { $s: [...v].map((x) => enc(x, ctx)) };
    if (Array.isArray(v)) return v.map((x) => enc(x, ctx));
    if (v instanceof K.Decimal) return { $d: v.toString() };
    if (K.DateV && v instanceof K.DateV) return { $date: v.days };
    if (K.TimestampV && v instanceof K.TimestampV) return { $ts: v.us, tz: v.tz };
    if (K.IntervalV && v instanceof K.IntervalV) return { $iv: [v.months, v.days, v.us] };
    if (K.TimeV && v instanceof K.TimeV) return { $tm: v.us };
    if (v instanceof K.ArrayV) return { $arr: enc(v.items, ctx), lower: v.lower };
    if (v instanceof K.RowV) return { $row: enc(v.values, ctx), type: enc(v.type, ctx) };
    if (v instanceof K.JsonV) return { $json: K.T.output(v, { cat: 'J', id: v.binary ? 'jsonb' : 'json' }), binary: v.binary };
    if (isType(v)) {
      if (v.cat === 'A') return { $t: 'array', elem: enc(v.elem, ctx) };
      if (ctx && ctx.userTypes && v.schema && ctx.userTypes.has(v.schema + '.' + v.name) && !ctx.inType) return { $t: 'user', key: v.schema + '.' + v.name };
      const out = {};
      for (const k of Object.keys(v)) out[k] = k === 'base' || k === 'elem' || k === 'fields' ? enc(v[k], ctx) : enc(v[k], ctx);
      return { $t: 'plain', v: out };
    }
    const out = {};
    for (const k of Object.keys(v)) { if (k === 'db' || k === '_setupDone' || k === 'compiled' || k === 'phys' || k === 'rt' || k === 'testFn') continue; out[k] = enc(v[k], ctx); }
    return out;
  }
  function dec(v, ctx) {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => dec(x, ctx));
    if ('$u' in v) return undefined;
    if ('$b' in v) return BigInt(v.$b);
    if ('$x' in v) return b64.dec(v.$x);
    if ('$m' in v) return new Map(v.$m.map(([k, x]) => [dec(k, ctx), dec(x, ctx)]));
    if ('$s' in v) return new Set(v.$s.map((x) => dec(x, ctx)));
    if ('$d' in v) return K.Decimal.parse(v.$d);
    if ('$date' in v) return new K.DateV(v.$date);
    if ('$ts' in v) return new K.TimestampV(v.$ts, v.tz);
    if ('$iv' in v) return new K.IntervalV(v.$iv[0], v.$iv[1], v.$iv[2]);
    if ('$tm' in v) return new K.TimeV(v.$tm);
    if ('$arr' in v) return new K.ArrayV(dec(v.$arr, ctx), v.lower);
    if ('$row' in v) return new K.RowV(dec(v.$row, ctx), dec(v.type, ctx));
    if ('$json' in v) return K.T.jsonIn(v.$json, v.binary);
    if ('$t' in v) {
      if (v.$t === 'array') return K.T.arrayOf(dec(v.elem, ctx));
      if (v.$t === 'user') return ctx.userTypes.get(v.key) || (ctx.pending && ctx.pending(v.key));
      const t = {};
      for (const k of Object.keys(v.v)) { const x = dec(v.v[k], ctx); if (x !== undefined) t[k] = x; }
      return t;
    }
    const out = {};
    for (const k of Object.keys(v)) { const x = dec(v[k], ctx); if (x !== undefined) out[k] = x; }
    return out;
  }

  /** a snapshot of the database as it is on disk (the buffer pool is written out first) */
  function save(db) {
    // dirty pages are taken from the buffer pool as they are, without writing them (saving must not change what the views show)
    const dirty = new Map();
    for (const fr of db.buffers.frames) if (fr.block >= 0 && fr.dirty) dirty.set(fr.file + ':' + fr.block, fr.buf);
    const cat = db.catalog;
    const userTypes = new Map(cat.types);
    const ctx = { userTypes };
    const types = [...cat.types].map(([k, t]) => [k, enc(t, Object.assign({}, ctx, { inType: true }))]);
    const relObj = (r) => enc(r, ctx);
    return {
      format: 'kwery-db-1',
      pageSize: db.disk.pageSize,
      disk: { next: db.disk.nextFile, files: [...db.disk.files.values()].map((f) => { const blocks = f.blocks.slice(); for (const [k, buf] of dirty) { const [fid, b] = k.split(':').map(Number); if (fid === f.id) blocks[b] = buf; } return { id: f.id, name: f.name, kind: f.kind, blocks: blocks.map((u) => packBlock(u || new Uint8Array(db.disk.pageSize))) }; }) },
      catalog: {
        nextOid: cat.nextOid, version: cat.version, types,
        schemas: [...cat.schemas.values()].map((s) => ({ name: s.name, owner: s.owner, system: s.system, acl: enc(s.acl, ctx), objects: [...s.objects.keys()] })),
        rels: [...cat.rels.values()].map(relObj),
        funcs: [...cat.funcs].map(([k, l]) => [k, l.map((f) => enc(f, ctx))]),
        roles: [...cat.roles.values()].map((r) => enc(r, ctx)),
        assertions: [...cat.assertions.values()].map((a) => enc(a, ctx)),
      },
      xact: { next: db.xact.next, clog: [...db.xact.clog], parent: [...db.xact.parent], commitSeq: db.xact.commitSeq, commitOrder: [...db.xact.commitOrder] },
      wal: { nextLsn: db.wal.nextLsn, flushedLsn: Math.max(db.wal.flushedLsn, db.wal.nextLsn - 1) },
      seqs: [...db.seqs].map(([oid, s]) => [oid, { last: s.last.toString(), called: s.called }]),
      live: [...db.live], stats: enc([...db.stats], ctx), fsms: [...db.fsms].map(([f, a]) => [f, a]),
      settings: db.settings,
    };
  }

  /** a database from a snapshot */
  function load(snap, opts) {
    opts = opts || {};
    if (!snap || snap.format !== 'kwery-db-1') throw K.err(K.STATE.invalidParameter, 'not a Kwery database snapshot');
    const db = new K.Database(Object.assign({ pageSize: snap.pageSize }, opts, { pageSize: snap.pageSize }));
    const d = db.disk;
    d.nextFile = snap.disk.next;
    d.files = new Map(snap.disk.files.map((f) => [f.id, { id: f.id, name: f.name, kind: f.kind, blocks: f.blocks.map(([n, s]) => { const u = new Uint8Array(snap.pageSize); if (n) u.set(b64.dec(s).subarray(0, n)); return u; }) }]));
    const cat = db.catalog;
    cat.nextOid = snap.catalog.nextOid;
    // user types first (they may refer to one another), then everything that uses them
    const userTypes = new Map();
    const raw = new Map(snap.catalog.types);
    const ctx = { userTypes };
    ctx.pending = (key) => { if (!userTypes.has(key) && raw.has(key)) { const t = {}; userTypes.set(key, t); Object.assign(t, dec(raw.get(key), ctx)); } return userTypes.get(key); };
    for (const k of raw.keys()) ctx.pending(k);
    cat.types = userTypes;
    cat.schemas = new Map();
    for (const s of snap.catalog.schemas) cat.schemas.set(s.name, { name: s.name, owner: s.owner, system: s.system, acl: dec(s.acl, ctx) || [], objects: new Map() });
    cat.rels = new Map();
    for (const r0 of snap.catalog.rels) { const r = dec(r0, ctx); cat.rels.set(r.oid, r); const sc = cat.schemas.get(r.schema); if (sc) sc.objects.set(r.name, r); }
    cat.funcs = new Map(snap.catalog.funcs.map(([k, l]) => [k, l.map((f) => dec(f, ctx))]));
    for (const l of cat.funcs.values()) for (const f of l) if (f.lang !== 'sql' && K.PSM && K.PSM.compile) { try { f.compiled = K.PSM.compile(f, db.internalSession()); } catch (e) { /* compiled again when called */ } }
    cat.roles = new Map(snap.catalog.roles.map((r) => { const x = dec(r, ctx); return [x.name, x]; }));
    cat.assertions = new Map(snap.catalog.assertions.map((a) => { const x = dec(a, ctx); return [x.name, x]; }));
    cat.version = snap.catalog.version + 1;
    const x = db.xact;
    // transactions that were running when the snapshot was taken did not commit: they count as aborted
    x.next = snap.xact.next; x.clog = new Map(snap.xact.clog.map(([xid, st]) => [xid, st === K.XSTATUS.INPROGRESS ? K.XSTATUS.ABORTED : st])); x.parent = new Map(snap.xact.parent); x.commitSeq = snap.xact.commitSeq; x.commitOrder = new Map(snap.xact.commitOrder);
    db.wal.nextLsn = snap.wal.nextLsn; db.wal.flushedLsn = snap.wal.flushedLsn;
    // the snapshot keeps no log records, so the fate of every transaction so far goes into the log's archive: a later
    // crash and restart rebuilds the commit log from it (otherwise the snapshot's rows would count as never committed)
    const arch = { tops: new Map(), subs: new Map(), subAborted: new Set(), parent: new Map(), commits: [], maxXid: 0 };
    const topOf = (xid) => { let y = xid, n = 0; while (x.parent.has(y) && n++ < 1000) y = x.parent.get(y); return y; };
    for (const [xid, st] of x.clog) {
      const top = topOf(xid);
      arch.maxXid = Math.max(arch.maxXid, xid);
      if (top !== xid) { arch.subs.set(xid, top); arch.parent.set(xid, x.parent.get(xid)); if (st === K.XSTATUS.ABORTED) arch.subAborted.add(xid); continue; }
      arch.tops.set(xid, st === K.XSTATUS.COMMITTED ? 'commit' : 'abort');
    }
    arch.commits = [...arch.tops].filter(([, f]) => f === 'commit').map(([xid]) => xid).sort((p, q) => (x.commitOrder.get(p) || 0) - (x.commitOrder.get(q) || 0));
    db.wal.archived = arch;
    for (const [oid, s] of snap.seqs) { const rel = cat.rel(oid); if (rel) { const st = db.seqState(rel); st.last = BigInt(s.last); st.called = s.called; } }
    db.live = new Map(snap.live);
    db.stats = new Map(dec(snap.stats, ctx));
    db.fsms = new Map(snap.fsms);
    if (snap.settings) Object.assign(db.settings, snap.settings, opts.settings || {});
    db.disk.resetStats();
    return db;
  }

  K.Snapshot = { save, load, b64 };
})(typeof window !== 'undefined' ? window : globalThis);
