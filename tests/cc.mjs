// Concurrency: several sessions stepped side by side, checked against what PostgreSQL does in the same schedule.
import { load } from './load.mjs';
const K = load();
let pass = 0, fail = 0;
const eq = (a, b, what) => { if (JSON.stringify(a) === JSON.stringify(b)) pass++; else { fail++; console.log('FAIL ' + what + '\n  expected ' + JSON.stringify(b) + '\n  got      ' + JSON.stringify(a)); } };
const val = (r) => r.rows.map((row) => row.map((v, i) => (v === null ? null : K.T.output(v, r.cols[i].type))));
function setup() {
  const db = new K.Database();
  const a = db.session({ name: 'A' }), b = db.session({ name: 'B' });
  a.exec('create table acct (id int primary key, bal int); insert into acct values (1, 100), (2, 200)');
  return { db, a, b };
}
// run steps: [session, sql] in order; a step that blocks stays pending while later steps run
function schedule(db, steps) {
  const out = [];
  const runners = [];
  for (const [s, sql] of steps) {
    const r = s.start(sql);
    runners.push(r);
    db.step();
    out.push(r);
  }
  db.step();
  return out.map((r) => (r.done ? (r.error ? { error: r.error.code, msg: r.error.message } : r.results.map((x) => (x.rows ? val(x) : x.tag))) : 'waiting'));
}
{ // lost update prevented under READ COMMITTED: B waits for A, then re-reads the new balance
  const { db, a, b } = setup();
  const r = schedule(db, [[a, 'begin'], [b, 'begin'], [a, 'update acct set bal = bal - 10 where id = 1'], [b, 'update acct set bal = bal - 20 where id = 1'], [a, 'commit'], [b, 'commit'], [a, 'select bal from acct where id = 1']]);
  eq(r[3], ['UPDATE 1'], 'RC: B update finishes after A commits');
  eq(r[6], [[['70']]], 'RC: both updates applied');
}
{ // REPEATABLE READ: the second updater fails
  const { db, a, b } = setup();
  const r = schedule(db, [[a, 'begin isolation level repeatable read'], [b, 'begin isolation level repeatable read'], [b, 'select * from acct'], [a, 'update acct set bal = 0 where id = 1'], [b, 'update acct set bal = 1 where id = 1'], [a, 'commit'], [b, 'rollback']]);
  eq(r[4].error, '40001', 'RR: concurrent update is a serialization failure');
}
{ // READ COMMITTED sees committed changes at each statement; REPEATABLE READ does not
  const { db, a, b } = setup();
  const r = schedule(db, [[a, 'begin'], [b, 'begin isolation level repeatable read'], [a, 'select bal from acct where id = 2'], [b, 'select bal from acct where id = 2'], [a, 'update acct set bal = 999 where id = 2'], [a, 'select bal from acct where id = 2'], [b, 'select bal from acct where id = 2'], [a, 'commit'], [b, 'select bal from acct where id = 2'], [b, 'commit'], [b, 'select bal from acct where id = 2']]);
  eq([r[6], r[8], r[10]], [[[['200']]], [[['200']]], [[['999']]]], 'RR snapshot stays; later transaction sees the commit');
  eq(r[5], [[['999']]], 'a transaction sees its own update');
}
{ // deadlock: A locks 1 then 2, B locks 2 then 1
  const { db, a, b } = setup();
  const r = schedule(db, [[a, 'begin'], [b, 'begin'], [a, 'update acct set bal = 1 where id = 1'], [b, 'update acct set bal = 2 where id = 2'], [a, 'update acct set bal = 1 where id = 2'], [b, 'update acct set bal = 2 where id = 1'], [a, 'commit'], [b, 'rollback']]);
  eq(r[5].error, '40P01', 'deadlock detected for the transaction closing the cycle');
  eq(r[4], ['UPDATE 1'], 'the other transaction goes on');
}
{ // unique key inserted by an uncommitted transaction: the second inserter waits, then fails
  const { db, a, b } = setup();
  const r = schedule(db, [[a, 'begin'], [a, 'insert into acct values (3, 0)'], [b, 'insert into acct values (3, 1)'], [a, 'commit']]);
  eq(r[2].error, '23505', 'waits, then duplicate key after the first commits');
  const { db: db2, a: a2, b: b2 } = setup();
  const r2 = schedule(db2, [[a2, 'begin'], [a2, 'insert into acct values (3, 0)'], [b2, 'insert into acct values (3, 1)'], [a2, 'rollback'], [b2, 'select bal from acct where id = 3']]);
  eq(r2[2], ['INSERT 0 1'], 'waits, then succeeds after the first rolls back');
  eq(r2[4], [[['1']]], 'the second insert is the one stored');
}
{ // SELECT FOR UPDATE blocks a writer; NOWAIT fails at once
  const { db, a, b } = setup();
  const r = schedule(db, [[a, 'begin'], [a, 'select * from acct where id = 1 for update'], [b, 'update acct set bal = 5 where id = 1'], [b, 'select * from acct where id = 1 for update nowait'], [a, 'commit']]);
  eq(r[2], ['UPDATE 1'], 'writer waited for FOR UPDATE, then went on');
  void r;
  const { db: d2, a: a2, b: b2 } = setup();
  const r2 = schedule(d2, [[a2, 'begin'], [a2, 'select * from acct where id = 1 for update'], [b2, 'select * from acct where id = 1 for update nowait']]);
  eq(r2[2].error, '55P03', 'NOWAIT reports lock not available');
}
{ // a DELETE waiting on an UPDATE that commits: under READ COMMITTED it rechecks the WHERE on the new version
  const { db, a, b } = setup();
  const r = schedule(db, [[a, 'begin'], [a, 'update acct set bal = 500 where id = 1'], [b, 'delete from acct where bal = 100'], [a, 'commit'], [b, 'select count(*) from acct']]);
  eq(r[2], ['DELETE 0'], 'EvalPlanQual: the new version no longer matches');
  eq(r[4], [[['2']]], 'nothing deleted');
}
{ // DDL is transactional and invisible to others until commit
  const { db, a, b } = setup();
  const r = schedule(db, [[a, 'begin'], [a, 'create table t2 (x int)'], [a, 'insert into t2 values (1)'], [b, 'select count(*) from acct'], [a, 'rollback'], [b, 'select * from t2']]);
  eq(r[5].error, '42P01', 'rolled-back CREATE TABLE leaves no table');
}
{ // an insert waiting for the inserter of the same key appears in the wait-for graph (a wait on its xid); mvcc.read events
  const { db, a, b } = setup();
  const r = schedule(db, [[a, 'begin'], [b, 'begin'], [a, 'insert into acct values (5, 0)'], [b, 'insert into acct values (5, 1)']]);
  eq(r[3], 'waiting', 'B waits for A');
  const w = db.locks.waitsFor();
  eq(w.length === 1 && w[0].from === b.tx.id && w[0].to === a.tx.id && w[0].mode === 'ShareLock' && w[0].xid === a.tx.xid, true, 'waitsFor includes the xid wait');
  schedule(db, [[a, 'commit'], [b, 'commit']]);
  eq(db.locks.waitsFor(), [], 'no waits after both commit');
  const seen = [];
  const off = db.bus.on('mvcc.read', (d) => seen.push(d));
  b.exec('select * from acct');
  off();
  eq(seen.length >= 2 && seen.every((d) => d.rel === 'acct' && typeof d.visible === 'boolean'), true, 'mvcc.read reports each version judged');
}
{ // SKIP LOCKED with LIMIT: the locked row is skipped and the next one taken (LockRows runs below Limit)
  const { db, a, b } = setup();
  a.exec('create table jobs (id int primary key); insert into jobs values (1), (2), (3)');
  const q = 'select * from jobs order by id limit 1 for update skip locked';
  const r = schedule(db, [[a, 'begin'], [a, q], [b, 'begin'], [b, q], [b, 'select * from jobs order by id limit 2 for update skip locked'], [a, 'commit'], [b, 'commit']]);
  eq([r[1], r[3], r[4]], [[[['1']]], [[['2']]], [[['2'], ['3']]]], 'each worker gets the next free job');
  const r2 = schedule(db, [[a, 'begin'], [a, 'select * from jobs where id = 1 for update'], [b, 'select * from jobs order by id for update nowait'], [a, 'rollback']]);
  eq(r2[2].error, '55P03', 'NOWAIT fails on a locked row');
}
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
