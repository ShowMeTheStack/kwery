// Logging and recovery: small worked crashes with their expected redo and undo actions, the buffer policies,
// dumps, remote backup, shadow paging, and a crash torture test: random workloads in several sessions crash at
// random points (between statements, inside a statement, during a page write, during recovery itself), restart
// with each algorithm, and every table must hold exactly what the committed transactions wrote.
// node tests/recovery.mjs [seeds] [first seed]
import { load } from './load.mjs';
const K = load();
let pass = 0, fail = 0;
const eq = (a, b, what) => { if (JSON.stringify(a) === JSON.stringify(b)) pass++; else { fail++; console.log('FAIL ' + what + '\n  expected ' + JSON.stringify(b) + '\n  got      ' + JSON.stringify(a)); } };
const ok = (c, what) => eq(!!c, true, what);
const val = (r) => r.rows.map((row) => row.map((v, i) => (v === null ? null : K.T.output(v, r.cols[i].type))));
const q = (s, sql) => val(s.query(sql));
const R = K.Recovery;

// ---- two transfers, T0 and T1 (A = 4200, B = 3100, C = 860; T0 moves 300 from A to B, T1 takes 360 from C) ----
function bank(opts) {
  const db = new K.Database(Object.assign({ frames: 16 }, opts || {}));
  const s = db.session();
  s.exec("create table acct (name text primary key, bal int); insert into acct values ('A', 4200), ('B', 3100), ('C', 860); checkpoint");
  return { db, s };
}
const bals = (s) => q(s, 'select name, bal from acct order by name').map((r) => r[0] + '=' + r[1]).join(' ');
for (const algorithm of ['textbook', 'aries']) {
  // (a) the crash comes after <T0, B, 3100, 3400> is on stable storage, before <T0 commit>: undo T0
  {
    const { db, s } = bank();
    s.exec("begin; update acct set bal = 3900 where name = 'A'; update acct set bal = 3400 where name = 'B'");
    const t0 = s.tx.xid;
    db.wal.flush();
    R.crash(db);
    const r = R.restart(db, { algorithm });
    eq(r.losers, [t0], algorithm + ' (a): T0 is the one transaction to undo');
    eq(bals(s), 'A=4200 B=3100 C=860', algorithm + ' (a): A and B restored');
    eq(r.passes.undo.steps.filter((x) => x.action === 'undo').length, 4, algorithm + ' (a): two new versions invalidated, two headers restored');
    eq(r.passes.redo.steps.filter((x) => x.action === 'redo' && x.xid === undefined && /T\d+, acct/.test(x.record)).length > 0, true, algorithm + ' (a): T0 redone first (repeating history)');
    if (algorithm === 'textbook') {
      ok(r.passes.redo.steps.some((x) => x.action === 'list' && x.why === 'T' + t0 + ' added to the undo-list'), 'textbook (a): <T0 start> puts T0 on the undo-list');
      ok(r.passes.undo.steps.some((x) => x.action === 'abort' && x.xid === t0), 'textbook (a): <T0 abort> written at <T0 start>');
      ok(db.wal.records.some((x) => x.type === 'clr' && x.by === 'textbook'), 'textbook (a): redo-only records written');
    } else {
      ok(r.passes.undo.steps.some((x) => x.action === 'end' && x.xid === t0), 'aries (a): <T0 end> after its undo');
      ok(r.passes.analysis.after.tt.some((e) => e.xid === t0 && e.status === 'U'), 'aries (a): analysis finds T0 running');
    }
  }
  // (b) after <T1, C, 860, 500>, before <T1 commit>: redo T0, undo T1
  {
    const { db, s } = bank();
    s.exec("begin; update acct set bal = 3900 where name = 'A'; update acct set bal = 3400 where name = 'B'; commit");
    const t0 = db.xact.next - 1;
    s.exec("begin; update acct set bal = 500 where name = 'C'");
    const t1 = s.tx.xid;
    db.wal.flush();
    R.crash(db);
    const r = R.restart(db, { algorithm });
    eq(r.losers, [t1], algorithm + ' (b): only T1 is undone');
    eq(bals(s), 'A=3900 B=3400 C=860', algorithm + ' (b): T0 redone, T1 undone');
    eq(r.passes.undo.steps.filter((x) => x.action === 'undo').length, 2, algorithm + ' (b): T1 has two changes to undo');
    if (algorithm === 'textbook') ok(r.passes.redo.steps.some((x) => x.action === 'list' && x.why.startsWith('T' + t0 + ' removed')), 'textbook (b): <T0 commit> takes T0 off the undo-list');
  }
  // (c) after <T1 commit>: redo both, nothing to undo
  {
    const { db, s } = bank();
    s.exec("begin; update acct set bal = 3900 where name = 'A'; update acct set bal = 3400 where name = 'B'; commit");
    s.exec("begin; update acct set bal = 500 where name = 'C'; commit");
    R.crash(db);
    const r = R.restart(db, { algorithm });
    eq(r.losers, [], algorithm + ' (c): nothing to undo');
    eq(bals(s), 'A=3900 B=3400 C=500', algorithm + ' (c): both redone');
    ok(r.passes.redo.steps.filter((x) => x.action === 'redo').length >= 4, algorithm + ' (c): the changes were redone from the log');
  }
}
{ // ARIES: a crash during undo, then restart again: CLRs are followed and nothing is undone twice
  const { db, s } = bank();
  s.exec("begin; update acct set bal = 1 where name = 'A'; update acct set bal = 2 where name = 'B'; update acct set bal = 3 where name = 'C'");
  db.wal.flush();
  R.crash(db);
  const first = R.restart(db, { algorithm: 'aries' });
  const undoAt = first.passes.undo.steps.filter((x) => x.action === 'undo')[2].n;
  const { db: db2, s: s2 } = bank();
  s2.exec("begin; update acct set bal = 1 where name = 'A'; update acct set bal = 2 where name = 'B'; update acct set bal = 3 where name = 'C'");
  db2.wal.flush();
  R.crash(db2);
  const r1 = R.restart(db2, { algorithm: 'aries', crashAt: undoAt, crashMode: 'during-write' });
  ok(r1.crashed, 'aries: crashed during undo');
  const clrs = db2.wal.records.filter((x) => x.type === 'clr').length;
  eq(clrs, 3, 'aries: three CLRs reached the stable log before the crash (the torn write flushed the log first)');
  const r2 = R.restart(db2, { algorithm: 'aries' });
  ok(r2.passes.analysis.steps.some((x) => /from the CLR/.test(x.why)), 'aries: analysis takes the UndoNextLSN of the last CLR');
  eq(r2.passes.undo.losers[0].undoNext, db2.wal.records.filter((x) => x.type === 'clr')[2].undoNext, 'aries: undo resumes where the last CLR says');
  eq(r2.passes.undo.steps.filter((x) => x.action === 'undo').length, 3, 'aries: only the three changes not yet undone are undone');
  eq(bals(s2), 'A=4200 B=3100 C=860', 'aries: correct after a crash during recovery');
  ok(r2.passes.redo.steps.some((x) => x.action === 'redo' && x.type === 'clr'), 'aries: the CLRs are redone (repeating history)');
}
{ // ARIES redo skips by PageLSN and recLSN; the checkpoint's tables seed the analysis
  const { db, s } = bank();
  s.exec("begin; update acct set bal = 999 where name = 'A'");
  R.checkpoint(db, { fuzzy: true });
  s.exec('commit');
  s.exec('checkpoint');
  s.exec("update acct set bal = 998 where name = 'B'");
  R.crash(db);
  const r = R.restart(db, { algorithm: 'aries' });
  eq(bals(s), 'A=999 B=998 C=860', 'aries: committed work survives');
  ok(r.passes.analysis.before.tt.length === 0 && r.passes.analysis.before.dpt.length === 0, 'aries: the sharp checkpoint has an empty dirty page table');
  ok(r.passes.redo.steps.every((x) => x.action !== 'skip' || /recLSN|PageLSN|not in the dirty/.test(x.why + (x.cmp || ''))), 'aries: every skip is explained');
  const db2 = bank().db, s2 = db2.sessions[0];
  s2.exec("begin; update acct set bal = 5 where name = 'A'");
  const ck = R.checkpoint(db2, { fuzzy: true });
  ok(ck.data.txTable.length === 1 && ck.data.dpt.length > 0, 'fuzzy checkpoint logs the transaction table and dirty page table');
  db2.buffers.flushAll(true);
  s2.exec("update acct set bal = 6 where name = 'B'");
  R.crash(db2);
  const r2 = R.restart(db2, { algorithm: 'aries' });
  ok(r2.passes.analysis.before.tt.length === 1, 'aries: analysis starts from the fuzzy checkpoint\'s transaction table');
  ok(r2.passes.redo.steps.some((x) => x.action === 'skip' && /PageLSN/.test(x.cmp || '')), 'aries: pages already on disk are skipped by PageLSN');
  eq(bals(s2), 'A=4200 B=3100 C=860', 'aries: the transaction running over the fuzzy checkpoint is undone');
}
{ // savepoints: a committed transaction keeps what it did outside the savepoint it rolled back to
  for (const algorithm of ['textbook', 'aries']) for (const undo of [false, true]) {
    const { db, s } = bank();
    if (undo) s.exec('set rollback_undo = on');
    s.exec("begin; update acct set bal = 1 where name = 'A'; savepoint x; update acct set bal = 2 where name = 'B'; savepoint y; update acct set bal = 3 where name = 'C'; release y; rollback to x; update acct set bal = 4 where name = 'C'; commit");
    s.exec("begin; update acct set bal = 7 where name = 'B'; savepoint z; update acct set bal = 8 where name = 'A'; rollback to z");
    db.wal.flush();
    R.crash(db);
    R.restart(db, { algorithm });
    eq(bals(s), 'A=1 B=3100 C=4', algorithm + (undo ? ' with rollback_undo' : '') + ': savepoint rollbacks survive the crash');
  }
}
{ // a torn page is detected by its checksum and rebuilt from the full-page image
  for (const algorithm of ['textbook', 'aries']) {
    const { db, s } = bank();
    s.exec("update acct set bal = 1 where name = 'A'");
    const heap = db.catalog.lookup({ name: 'acct' }).file;
    const info = R.crash(db, { at: 'during-write', page: { file: heap, block: 0 } });
    ok(info.torn && info.torn.file === heap, algorithm + ': the heap page was torn');
    ok(!K.checksumOk(db.disk.file(heap).blocks[0]), algorithm + ': its checksum no longer matches');
    const r = R.restart(db, { algorithm });
    eq(r.torn.length, 1, algorithm + ': restart finds the torn page');
    ok(r.steps.some((x) => x.action === 'reset'), algorithm + ': the torn page is rebuilt');
    eq(r.problems, [], algorithm + ': and fully repaired from its image');
    eq(bals(s), 'A=1 B=3100 C=860', algorithm + ': the torn page is repaired');
  }
  const { db, s } = bank();
  s.exec('set full_page_writes = off');
  db.settings.full_page_writes = false;
  s.exec("update acct set bal = 1 where name = 'A'");
  R.crash(db, { at: 'during-write', page: { file: db.catalog.lookup({ name: 'acct' }).file, block: 0 } });
  const r = R.restart(db, { algorithm: 'aries' });
  ok(r.problems.some((p) => /torn page/.test(p)), 'without full-page writes a torn page is reported');
}
{ // WAL rule off: a page reaches the disk ahead of its log records, and restart says so
  const db = new K.Database({ frames: 3 });
  const s = db.session();
  s.exec('create table w (id int, pad text)');
  db.settings.wal_rule = false; db.settings.wal_buffers = 0;
  let violations = 0;
  db.bus.on('wal.violation', () => violations++);
  s.exec('begin');
  for (let i = 0; i < 60; i++) s.exec("insert into w values (" + i + ", repeat('x', 500))");
  ok(violations > 0, 'with wal_rule off pages are written ahead of the log');
  R.crash(db);
  const r = R.restart(db);
  ok(r.ahead.length > 0 && r.problems.length > 0, 'restart finds pages ahead of the stable log');
}
{ // no-steal keeps uncommitted changes off the disk; force writes a transaction's pages at commit
  const db = new K.Database({ frames: 12 });
  const s = db.session();
  s.exec('create table ns (id int primary key, pad text); checkpoint');
  db.settings.buffer_steal = false;
  let steals = 0;
  db.bus.on('buf.steal', () => steals++);
  s.exec('begin');
  for (let i = 0; i < 12; i++) s.exec('insert into ns values (' + i + ", repeat('y', 300))");
  const xid = s.tx.xid;
  s.exec('checkpoint');
  const onDisk = [];
  for (const f of db.disk.files.values()) for (const b of f.blocks) { const p = new K.Page(b.slice()); if (p.isNew() || f.kind !== 'heap') continue; for (let i = 1; i <= p.nslots; i++) { const it = p.item(i); if (it && K.Tuple.header(it).xmin === xid) onDisk.push(i); } }
  eq([steals, onDisk.length], [0, 0], 'no-steal: no page with uncommitted changes was written');
  let err = null;
  try { for (let i = 12; i < 400; i++) s.exec('insert into ns values (' + i + ", repeat('y', 300))"); } catch (e) { err = e; }
  eq(err && err.code, '53200', 'no-steal: a pool full of uncommitted pages is an error');
  s.exec('rollback');
  const db2 = new K.Database({ frames: 32 });
  const s2 = db2.session();
  s2.exec('create table fo (id int primary key, v int); checkpoint');
  db2.settings.buffer_force = true;
  s2.exec('begin; insert into fo values (1, 1), (2, 2); update fo set v = 3 where id = 1; commit');
  eq(db2.buffers.frames.filter((f) => f.dirty).length, 0, 'force: nothing is dirty after the commit');
  R.crash(db2);
  const r = R.restart(db2, { algorithm: 'aries' });
  eq(r.passes.redo.steps.filter((x) => x.action === 'redo').length, 0, 'force: the committed transaction needs no redo');
  eq(q(s2, 'select id, v from fo order by id'), [['1', '3'], ['2', '2']], 'force: contents after restart');
}
{ // group flush: several commits in one log write with synchronous_commit off; the unflushed ones are lost
  const db = new K.Database();
  const s = db.session();
  s.exec('create table g (id int)');
  s.exec('set synchronous_commit = off');
  for (let i = 0; i < 5; i++) s.exec('insert into g values (' + i + ')');
  let ev = null;
  db.bus.on('wal.flush', (e) => { ev = e; });
  s.exec('set synchronous_commit = on');
  s.exec('insert into g values (5)');
  eq(ev && ev.commits, 6, 'one flush writes six commit records');
  s.exec('set synchronous_commit = off');
  s.exec('insert into g values (6)');
  R.crash(db);
  R.restart(db);
  eq(q(s, 'select count(*) from g'), [['6']], 'the asynchronous commit whose record was not flushed is lost');
}
{ // DDL: committed tables are kept, uncommitted ones are gone
  for (const algorithm of ['textbook', 'aries']) {
    const db = new K.Database({ frames: 8 });
    const s = db.session(), s2 = db.session();
    s.exec('create table keep (id int primary key, v text); insert into keep values (1, \'one\')');
    s2.exec("insert into keep values (2, 'two')");
    s.exec('begin; create table gone (id int); insert into gone values (1); create index keep_v on keep (v)');
    s.exec('truncate keep');
    db.wal.flush();
    R.crash(db, { at: 'during-write' });
    R.restart(db, { algorithm });
    eq(q(s, 'select id, v from keep order by id'), [['1', 'one'], ['2', 'two']], algorithm + ': committed rows of a table whose TRUNCATE did not commit');
    let e = null; try { s.exec('select * from gone'); } catch (x) { e = x.code; }
    eq(e, '42P01', algorithm + ': the uncommitted CREATE TABLE is gone');
    s.exec('insert into keep values (3, \'three\')');
    let d = null; try { s.exec("insert into keep values (1, 'dup')"); } catch (x) { d = x.code; }
    eq(d, '23505', algorithm + ': the primary key index works after restart');
  }
}
{ // archival dump: the disk is lost, the dump is restored and the log replayed
  for (const algorithm of ['textbook', 'aries']) {
    const { db, s } = bank();
    const d = R.dump(db);
    s.exec("update acct set bal = 10 where name = 'A'; create table later (x int); insert into later values (42)");
    s.exec("begin; update acct set bal = 20 where name = 'B'");
    db.wal.flush();
    R.loseDisk(db);
    const r = R.restoreFromDump(db, d, { algorithm });
    eq(r.checkpoint, d.lsn, algorithm + ': replay starts at the dump');
    eq(bals(s), 'A=10 B=3100 C=860', algorithm + ': the dump plus the log give the committed state');
    eq(q(s, 'select x from later'), [['42']], algorithm + ': a table created after the dump is rebuilt from the log');
  }
}
{ // remote backup: the log is shipped as it is flushed; at takeover the backup undoes what did not commit
  const { db, s } = bank();
  const bk = new R.RemoteBackup(db);
  s.exec("update acct set bal = 11 where name = 'A'");
  s.exec("begin; update acct set bal = 22 where name = 'B'");
  db.wal.flush();
  bk.apply();
  const { db: nb, result } = bk.takeover();
  ok(result.losers.length === 1, 'takeover: the running transaction is rolled back');
  eq(bals(nb.session()), 'A=11 B=3100 C=860', 'takeover: the backup has every committed change');
  const late = bank();
  const bk2 = new R.RemoteBackup(late.db, { lag: 1 });
  late.s.exec("update acct set bal = 12 where name = 'A'");
  const t = bk2.takeover();
  eq(bals(t.db.session()), 'A=4200 B=3100 C=860', 'a lagging (one-safe) backup loses the last commit');
}
{ // shadow paging
  const sp = new K.ShadowPaging({ values: ['a', 'b', 'c', 'd'] });
  sp.begin(); sp.write(1, 'B'); sp.write(1, 'BB'); sp.write(3, 'D');
  eq(sp.state().values, ['a', 'b', 'c', 'd'], 'shadow paging: the shadow table still shows the old pages');
  eq(sp.read(1), 'BB', 'shadow paging: the transaction reads its copy');
  sp.crash();
  eq(sp.state().values, ['a', 'b', 'c', 'd'], 'shadow paging: a crash leaves the last committed state');
  sp.begin(); sp.write(0, 'A'); sp.commit();
  eq(sp.state().values, ['A', 'b', 'c', 'd'], 'shadow paging: commit switches the pointer');
  sp.begin(); sp.write(2, 'C'); sp.abort();
  eq(sp.state().values, ['A', 'b', 'c', 'd'], 'shadow paging: abort drops the copy');
  ok(sp.history.some((h) => h.action === 'copy') && sp.history.some((h) => h.action === 'commit'), 'shadow paging: the steps are recorded');
}
{ // describe and the log listing
  const { db } = bank();
  const d = R.describe(db);
  ok(d.design.some((x) => /Indexes are not undone/.test(x)) && d.design.some((x) => /torn/i.test(x)) && d.settings.buffer_steal === true, 'describe explains the design');
  ok(R.records(db).some((r) => r.text.startsWith('<checkpoint')), 'the log listing shows the records in the textbook notation');
  ok('buffer_steal' in K.DB_DEFAULTS && 'wal_rule' in db.settings, 'the recovery settings are database defaults');
}

// ---- crash torture ----------------------------------------------------------------------------------------------------
function rng(seed) { let x = (seed * 2654435761) >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }
const TABLES = ['t1', 't2', 't3', 't4', 't5'];
// t1, t3: B+ tree primary keys, t3 a secondary B+ tree; t4: hash on v and LSM on id; t5: bitmap on v (eight values)
const LOOKUPS = { t1: ['id'], t3: ['id', 'v'], t4: ['v', 'id'], t5: ['v'] };
function torture(seed) {
  const rnd = rng(seed);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const chance = (p) => rnd() < p;
  const noSteal = chance(0.2);
  // no-steal needs room for every running transaction's pages
  const db = new K.Database({ frames: (noSteal ? 16 : 5) + Math.floor(rnd() * 8) });
  const syncOff = chance(0.15);
  db.settings.buffer_steal = !noSteal;
  db.settings.buffer_force = chance(0.2);
  db.settings.rollback_undo = chance(0.3);
  db.settings.wal_buffers = pick([0, 3000, 20000, 65536]);
  const NS = 3;
  const sess = K.range(NS).map((i) => ({ s: db.session({ name: 's' + i }), id: i, tx: null, next: 1 }));
  const admin = db.session({ name: 'admin' });
  admin.exec('create table t1 (id int primary key, v int, pad text); create table t2 (id int, v int, pad text); create table t3 (id int primary key, v int, pad text); create index t3_v on t3 (v); create table t4 (id int, v int, pad text); create index t4_h on t4 using hash (v); create index t4_l on t4 using lsm (id) with (memtable_size = ' + (2 + Math.floor(rnd() * 10)) + '); create table t5 (id int, v int, pad text); create index t5_b on t5 using bitmap (v)');
  if (syncOff) for (const x of sess) x.s.exec('set synchronous_commit = off');
  let base = new Map(TABLES.map((t) => [t, new Map()]));     // durable committed state
  let recent = [];                                            // commits not yet known durable: { lsn, changes }
  let commitLsn = 0;
  db.bus.on('wal.append', (r) => { if (r.type === 'commit') commitLsn = r.lsn; });
  const committed = () => { const m = new Map([...base].map(([t, rows]) => [t, new Map(rows)])); for (const c of recent) apply(m, c.changes); return m; };
  const apply = (m, changes) => { for (const [k, row] of changes) { const [t, id] = k.split(':'); if (row === null) m.get(t).delete(+id); else m.get(t).set(+id, row); } };
  const view = (x) => { const m = committed(); if (x.tx) apply(m, x.tx.changes); return m; };
  const mine = (x, t) => [...view(x).get(t).keys()].filter((id) => id % NS === x.id);
  const pad = () => 'p'.repeat(20 + Math.floor(rnd() * 300));
  const finish = (x, change) => { if (change && change.size) recent.push({ lsn: commitLsn, changes: change }); };
  let log = [], lsmBroken = false;
  /** run one statement for a session; returns false if the database crashed */
  const run = (x, sql, onOk) => {
    log.push(x.s.name + ': ' + sql.slice(0, 80));
    try { x.s.exec(sql); } catch (e) {
      if (e && e.crash) { if (process.env.DEBUG) console.log('crash in ' + sql.slice(0, 60) + '\n' + e.stack.split('\n').slice(1, 12).join('\n')); return false; }
      if (x.tx) x.tx.failed = true;
      // lsm.js empties the memtable before the new run is written: an error inside a flush loses entries (reported)
      if (e.code === '53200' && /LSMTree/.test(e.stack || '')) lsmBroken = true;
      if (process.env.DEBUG && e.code !== '23505') console.log('error in ' + sql.slice(0, 50) + ': ' + e.message.slice(0, 60) + '\n' + (e.stack || '').split('\n').slice(1, 8).join('\n'));
      return e;
    }
    if (onOk) onOk();
    return true;
  };
  const step = () => {
    const x = pick(sess);
    if (x.tx && x.tx.failed) { const r = run(x, 'rollback', () => { x.tx = null; }); return r; }
    const t = pick(TABLES);
    const r = rnd();
    const stage = x.tx ? x.tx.changes : new Map();
    const commitSingle = () => { if (!x.tx) finish(x, stage); };
    if (!x.tx && r < 0.15) return run(x, 'begin', () => { x.tx = { changes: new Map(), sps: [] }; });
    if (x.tx && r < 0.12) return run(x, 'commit', () => { finish(x, x.tx.changes); x.tx = null; });
    if (x.tx && r < 0.18) return run(x, 'rollback', () => { x.tx = null; });
    if (x.tx && r < 0.24) { const name = 'sp' + x.tx.sps.length; return run(x, 'savepoint ' + name, () => x.tx.sps.push({ name, changes: new Map(x.tx.changes) })); }
    if (x.tx && x.tx.sps.length && r < 0.29) { const i = Math.floor(rnd() * x.tx.sps.length); const sp = x.tx.sps[i]; return run(x, 'rollback to ' + sp.name, () => { x.tx.sps.length = i + 1; x.tx.changes = new Map(sp.changes); }); }
    if (x.tx && x.tx.sps.length && r < 0.32) { const i = Math.floor(rnd() * x.tx.sps.length); return run(x, 'release ' + x.tx.sps[i].name, () => { x.tx.sps.length = i; }); }
    if (r < 0.34 && !x.tx) return run(x, pick(['checkpoint', 'vacuum']));
    if (r < 0.36) { const ck = () => { try { R.checkpoint(db, { fuzzy: true }); return true; } catch (e) { if (e.crash) return false; throw e; } }; return ck(); }
    const ids = mine(x, t);
    if (r < 0.62 || !ids.length) {
      const id = (x.next++) * NS + x.id, v = Math.floor(rnd() * (t === 't5' ? 8 : 1000)), p = pad();
      return run(x, 'insert into ' + t + ' values (' + id + ', ' + v + ", '" + p + "')", () => { stage.set(t + ':' + id, [v, p]); commitSingle(); });
    }
    if (r < 0.66 && !x.tx && (t === 't1' || t === 't3')) {
      const id = pick(ids);
      const res = run(x, 'insert into ' + t + ' values (' + id + ", 0, 'dup')");
      if (res === false) return false;
      if (res === true || res.code !== '23505') { console.log('seed ' + seed + ': duplicate key not caught: ' + (res === true ? 'inserted' : res.message)); fail++; }
      return true;
    }
    if (r < 0.82) {
      const id = pick(ids), v = Math.floor(rnd() * (t === 't5' ? 8 : 1000)), np = chance(0.5) ? pad() : null;
      const old = view(x).get(t).get(id);
      return run(x, 'update ' + t + ' set v = ' + v + (np ? ", pad = '" + np + "'" : '') + ' where id = ' + id, () => { stage.set(t + ':' + id, [v, np || old[1]]); commitSingle(); });
    }
    if (r < 0.9) {
      const id = pick(ids);
      return run(x, 'delete from ' + t + ' where id = ' + id, () => { stage.set(t + ':' + id, null); commitSingle(); });
    }
    const vw = view(x).get(t);
    return run(x, 'update ' + t + ' set v = v + 1 where id % ' + NS + ' = ' + x.id, () => { for (const id of ids) stage.set(t + ':' + id, [vw.get(id)[0] + 1, vw.get(id)[1]]); commitSingle(); });
  };
  const check = (when, algorithm) => {
    const exp = committed();
    const s = admin;
    for (const t of TABLES) {
      const want = [...exp.get(t)].sort((a, b) => a[0] - b[0]).map(([id, [v, p]]) => [String(id), String(v), p]);
      const got = q(s, 'select id, v, pad from ' + t + ' order by id');
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        fail++;
        console.log('FAIL seed ' + seed + ' ' + when + ' (' + algorithm + '): table ' + t + ' has ' + got.length + ' rows, expected ' + want.length);
        const gi = new Map(got.map((r) => [r[0], r])), wi = new Map(want.map((r) => [r[0], r]));
        for (const [k, r] of wi) if (!gi.has(k)) console.log('  missing ' + k + ' v=' + r[1]); else if (JSON.stringify(gi.get(k)) !== JSON.stringify(r)) console.log('  differs ' + k + ': got v=' + gi.get(k)[1] + ' want v=' + r[1]);
        for (const [k, r] of gi) if (!wi.has(k)) console.log('  extra ' + k + ' v=' + r[1]);
        console.log('  settings steal=' + db.settings.buffer_steal + ' force=' + db.settings.buffer_force + ' undo=' + db.settings.rollback_undo + ' syncOff=' + syncOff);
        console.log('  last statements:\n    ' + log.slice(-12).join('\n    '));
        if (process.env.DEBUG) {
          const rel = db.catalog.lookup({ name: t }), heap = db.heap(rel);
          for (const x of heap.scan()) { const h = K.Tuple.header(x.bytes); const vals = K.Tuple.deform(x.bytes, rel.cols); console.log('   tuple (' + x.tid.b + ',' + x.tid.o + ') id=' + vals[0] + ' v=' + vals[1] + ' xmin ' + h.xmin + ' ' + db.xact.status(h.xmin) + ' xmax ' + h.xmax + ' ' + (h.xmax ? db.xact.status(h.xmax) : '') + ' mask ' + h.infomask.toString(16) + ' ctid ' + h.ctid.b + ',' + h.ctid.o); }
          for (const r of db.wal.records) if (r.file === rel.file || (r.xid && !r.file)) console.log('   ' + r.lsn + ' ' + R.text(db, r) + ' prev ' + r.prevLsn + ' xid ' + r.xid + ' top ' + r.top + ' parent ' + r.parent);
          console.log('   parents', JSON.stringify([...db.xact.parent]), JSON.stringify([...db.xact.clog]));
        }
        return false;
      }
      pass++;
      if (t === 't1' || t === 't3') {
        s.exec('set enable_seqscan = off');
        const ix = q(s, 'select id from ' + t + ' where id >= 0 order by id').map((r) => r[0]);
        s.exec('set enable_seqscan = on');
        eq(ix, want.map((r) => r[0]), 'seed ' + seed + ' ' + when + ': index scan of ' + t);
      }
      // point lookups through each index (some keys present, one absent)
      s.exec('set enable_seqscan = off');
      for (const col of LOOKUPS[t] || []) {
        if (t === 't4' && col === 'id' && lsmBroken) continue;
        const keys = want.length ? K.range(3).map(() => want[Math.floor(rnd() * want.length)][col === 'id' ? 0 : 1]) : [];
        keys.push(col === 'id' ? '-1' : '-7');
        for (const k of keys) {
          const exp = want.filter((r) => r[col === 'id' ? 0 : 1] === k).map((r) => r[0]);
          const gotK = q(s, 'select id from ' + t + ' where ' + col + ' = ' + k + ' order by id').map((r) => r[0]);
          eq(gotK, exp, 'seed ' + seed + ' ' + when + ': lookup ' + t + '.' + col + ' = ' + k);
        }
      }
      s.exec('set enable_seqscan = on');
    }
    if (exp.get('t3').size) { const [id, [v]] = [...exp.get('t3')][Math.floor(rnd() * exp.get('t3').size)]; s.exec('set enable_seqscan = off'); const got = q(s, 'select id from t3 where v = ' + v + ' and id = ' + id); s.exec('set enable_seqscan = on'); eq(got, [[String(id)]], 'seed ' + seed + ' ' + when + ': secondary index lookup'); }
    return true;
  };
  for (let cycle = 0; cycle < 3; cycle++) {
    const n = 20 + Math.floor(rnd() * 80);
    let crashed = false;
    for (let i = 0; i < n && !crashed; i++) {
      // sometimes the power fails inside the next statement, at the next page write
      if (chance(0.03)) db.disk.failing = chance(0.5) ? true : { tearAt: 512 * (1 + Math.floor(rnd() * 7)) };
      if (step() === false) crashed = true;
    }
    const at = crashed ? 'in a statement' : pick(['now', 'during-write']);
    // before the crash the database must agree with the oracle too (else the workload, not recovery, is wrong)
    if (!crashed && process.env.PRECHECK) { const f = db.disk.failing; db.disk.failing = false; const good = check('before crash ' + (cycle + 1), '-'); db.disk.failing = f; if (!good) return; }
    const flushed = R.crash(db, { at: crashed ? 'now' : at, pick: Math.floor(rnd() * 10) }).flushedLsn;
    // the commits whose records reached stable storage are the durable ones
    const durable = recent.filter((c) => c.lsn <= flushed);
    for (const c of durable) apply(base, c.changes);
    recent = [];
    for (const x of sess) x.tx = null;
    const algorithm = pick(['textbook', 'aries']);
    let res = R.restart(db, chance(0.25) ? { algorithm, crashAt: 1 + Math.floor(rnd() * 80), crashMode: pick(['now', 'during-write']), pick: Math.floor(rnd() * 5), checkpoint: chance(0.7) } : { algorithm, checkpoint: chance(0.8) });
    let tries = 0;
    while (res.crashed && tries++ < 3) res = R.restart(db, { algorithm: pick(['textbook', 'aries']) });
    if (process.env.DEBUG) console.log('seed ' + seed + ' cycle ' + cycle + ': crash ' + at + ', ' + res.algorithm + ', torn ' + JSON.stringify(res.torn) + ', losers ' + res.losers + ', settings steal=' + db.settings.buffer_steal + ' force=' + db.settings.buffer_force + ' undo=' + db.settings.rollback_undo + ' frames=' + db.buffers.n + '\n  ' + log.slice(-8).join('\n  '));
    if (process.env.DEBUG) for (const st of res.steps) if (st.action === 'memtable') console.log('   ', st.why);
    if (process.env.DEBUG > 1) for (const st of res.steps) if (st.file === 2 || st.action === 'reset' || st.pass === 'check') console.log('   ', st.pass, st.lsn, st.action, st.record || '', st.cmp || '', st.why);
    if (res.problems.length) { fail++; console.log('FAIL seed ' + seed + ': recovery problems: ' + res.problems.join('; ')); return; }
    if (!check('after crash ' + (cycle + 1) + ' (' + at + ')', algorithm)) return;
    log = [];
  }
}
const seeds = +(process.argv[2] || 300), first = +(process.argv[3] || 1);
const t0 = Date.now();
for (let seed = first; seed < first + seeds; seed++) {
  try { torture(seed); } catch (e) { fail++; console.log('FAIL seed ' + seed + ': ' + (e.stack || e)); }
}
console.log('torture: ' + seeds + ' seeds in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
