// Concurrency-control protocols and SSI: multi-session schedules with the waits, rollbacks and final values
// each protocol must produce. The SERIALIZABLE, REPEATABLE READ and READ COMMITTED schedules were run against
// PostgreSQL 17 with two or three psql sessions; the expected results (and SSI's reason codes) are what it did.
import { load } from './load.mjs';
const K = load();
let pass = 0, fail = 0;
const eq = (a, b, what) => { if (JSON.stringify(a) === JSON.stringify(b)) pass++; else { fail++; console.log('FAIL ' + what + '\n  expected ' + JSON.stringify(b) + '\n  got      ' + JSON.stringify(a)); } };
const ok = (c, what) => eq(!!c, true, what);
const val = (r) => r.rows.map((row) => row.map((v, i) => (v === null ? null : K.T.output(v, r.cols[i].type))));

const ACCT = 'create table acct (id int primary key, bal int); insert into acct values (1, 100), (2, 200)';
// understudies: at least one must stay on standby for the night's show (the write-skew example)
const STANDBY = "create table standby (name text primary key, ready boolean, night int); insert into standby values ('mara', true, 1), ('tomas', true, 1)";
/** a database with sessions A, B, C under a protocol (and extra settings run in each session) */
function setup(sql, proto, extra) {
  K.Clock.frozen = 1e15;
  const db = new K.Database({ settings: K.Protocols.settings });
  db.session({ name: 'setup' }).exec(sql);
  const s = {};
  for (const n of ['A', 'B', 'C']) { s[n] = db.session({ name: n }); if (proto) s[n].exec("set concurrency_control = '" + proto + "'"); if (extra) s[n].exec(extra); }
  const events = [];
  db.bus.on('*', (d, t) => { if (t.startsWith('cc.') || t.startsWith('ssi.')) events.push(Object.assign({ type: t }, d)); });
  return { db, s, events };
}
// steps: [session name, sql] run in order (a step that blocks stays pending while later ones run), or a function
function schedule(env, steps) {
  const out = [];
  for (const st of steps) {
    if (typeof st === 'function') { st(env); env.db.step(); out.push(null); continue; }
    const r = env.s[st[0]].start(st[1]);
    env.db.step();
    out.push(r);
  }
  env.db.step();
  return out.map((r) => (r === null ? null : r.done ? (r.error ? { error: r.error.code, msg: r.error.message, detail: r.error.detail, hint: r.error.hint } : r.results.map((x) => (x.rows ? val(x) : x.tag))) : 'waiting'));
}
const q = (env, sql) => val(env.db.session().query(sql));
const later = (ms) => () => { K.Clock.frozen += ms * 1000; };
const cs = (env) => K.Schedule.conflictSerializable(env.db.protocol.schedule(), 'committed').serializable;

// ---- the lost update ------------------------------------------------------------------------------------------------
const LOST = [['A', 'begin'], ['B', 'begin'], ['A', 'select bal from acct where id = 1'], ['B', 'select bal from acct where id = 1'], ['A', 'update acct set bal = 90 where id = 1'], ['B', 'update acct set bal = 80 where id = 1'], ['A', 'commit'], ['B', 'commit']];
{
  const e = setup(ACCT);
  const r = schedule(e, LOST);
  eq(r[5], ['UPDATE 1'], 'MVCC READ COMMITTED: the second updater waits, then overwrites');
  eq(q(e, 'select bal from acct where id = 1'), [['80']], 'MVCC READ COMMITTED: the lost update happens (as in PostgreSQL)');
}
for (const iso of ['repeatable read', 'serializable']) {
  const e = setup(ACCT, null, 'set default_transaction_isolation = \'' + iso + "'");
  const r = schedule(e, LOST);
  eq([r[5].error, r[5].msg], ['40001', 'could not serialize access due to concurrent update'], 'MVCC ' + iso + ': first updater wins');
  eq(q(e, 'select bal from acct where id = 1'), [['90']], 'MVCC ' + iso + ': A\'s update stands');
}
for (const p of ['2pl', 'strict2pl', 'rigorous2pl', 'mv2pl']) {
  const e = setup(ACCT, p);
  const r = schedule(e, LOST);
  eq(r[4], ['UPDATE 1'], p + ': A\'s upgrade to X waited, then went on when B was rolled back');
  eq(r[5].error, '40P01', p + ': both upgrade S to X: deadlock, B is the victim');
  eq(r[7], ['ROLLBACK'], p + ': B\'s COMMIT is a rollback');
  eq(q(e, 'select bal from acct where id = 1'), [['90']], p + ': no lost update');
  ok(e.events.some((x) => x.type === 'cc.wait' && x.mode === 'X' && x.item === 'acct.1'), p + ': the X request on acct.1 waited');
  ok(cs(e), p + ': the history is conflict serializable');
}
{
  const e = setup(ACCT, '2pl', "set deadlock_handling = 'wait-die'");
  const r = schedule(e, LOST);
  eq([r[4], r[5].error, r[5].msg], [['UPDATE 1'], '40P01', 'transaction rolled back to prevent a deadlock (wait-die)'], 'wait-die: the older A waits, the younger B dies');
  eq(q(e, 'select bal from acct where id = 1'), [['90']], 'wait-die: final value');
  ok(e.events.some((x) => x.type === 'cc.die'), 'wait-die: a die event');
}
{
  const e = setup(ACCT, '2pl', "set deadlock_handling = 'wound-wait'");
  const r = schedule(e, LOST);
  eq(r[4], ['UPDATE 1'], 'wound-wait: the older A wounds B and goes on');
  eq([r[5].error, /was wounded by older transaction/.test(r[5].msg)], ['40P01', true], 'wound-wait: B was rolled back while idle; its next statement says it was wounded');
  eq(r[7], ['ROLLBACK'], 'wound-wait: B commits as a rollback');
  eq(q(e, 'select bal from acct where id = 1'), [['90']], 'wound-wait: final value');
  // B's next transaction has its own (new, older-than-A's-next) timestamp: now B wounds A
  const r2 = schedule(e, [['B', 'begin'], ['A', 'begin'], ['A', 'update acct set bal = 1 where id = 1'], ['B', 'update acct set bal = 2 where id = 1'], ['B', 'commit'], ['A', 'commit']]);
  eq([r2[3], r2[5].error], [['UPDATE 1'], '40P01'], 'wound-wait: timestamps are per transaction, not per tab');
  ok(e.events.some((x) => x.type === 'cc.wound'), 'wound-wait: a wound event');
}
{
  const e = setup(ACCT, '2pl', "set deadlock_handling = 'timeout'; set lock_timeout = 100");
  const r = schedule(e, LOST.slice(0, 6).concat([later(150), ['B', 'commit'], ['A', 'rollback']]));
  eq(r[4].error, '55P03', 'timeout: no deadlock detection; the first waiter times out');
  eq(r[4].msg, 'canceling statement due to lock timeout', 'timeout: PostgreSQL\'s message');
  eq(r[5], ['UPDATE 1'], 'timeout: the other goes on once the timed-out transaction is rolled back');
  eq(q(e, 'select bal from acct where id = 1'), [['80']], 'timeout: final value');
}
{
  const e = setup(ACCT, 'to');
  const r = schedule(e, LOST);
  eq(r[4].error, '40001', 'TO: A writes acct.1 after the younger B read it: rolled back');
  ok(/R-timestamp/.test(r[4].detail), 'TO: the reason names the R-timestamp');
  eq(r[5], ['UPDATE 1'], 'TO: B writes');
  eq(q(e, 'select bal from acct where id = 1'), [['80']], 'TO: final value');
  ok(cs(e), 'TO: the history is conflict serializable');
}
{
  const e = setup(ACCT, 'occ');
  const r = schedule(e, LOST);
  eq([r[4], r[5], r[6]], [['UPDATE 1'], ['UPDATE 1'], ['COMMIT']], 'validation: both write in their read phase, A validates first');
  eq([r[7].error, r[7].msg], ['40001', 'could not serialize access: validation failed'], 'validation: B fails, A wrote what B read');
  eq(q(e, 'select bal from acct where id = 1'), [['90']], 'validation: final value');
  ok(e.events.some((x) => x.type === 'cc.validate' && x.ok === false), 'validation: a failed validation event');
  ok(cs(e), 'validation: the history is conflict serializable');
}
{
  const e = setup(ACCT, 'mvto');
  const r = schedule(e, LOST);
  eq(r[4].error, '40001', 'MVTO: A replaces a version the younger B read: rolled back');
  eq(r[5], ['UPDATE 1'], 'MVTO: B writes a new version');
  eq(q(e, 'select bal from acct where id = 1'), [['80']], 'MVTO: final value');
}

// ---- dirty read ----------------------------------------------------------------------------------------------------------
const DIRTY = [['A', 'begin'], ['A', 'update acct set bal = 0 where id = 1'], ['B', 'begin'], ['B', 'select bal from acct where id = 1'], ['A', 'rollback'], ['B', 'select bal from acct where id = 1'], ['B', 'commit']];
{
  const e = setup(ACCT);
  const r = schedule(e, DIRTY);
  eq([r[3], r[5]], [[[['100']]], [[['100']]]], 'MVCC: no dirty read, and no waiting');
}
for (const p of ['2pl', 'strict2pl', 'rigorous2pl', 'to', 'mvto', 'mv2pl']) {
  const e = setup(ACCT, p);
  const r = schedule(e, DIRTY);
  eq([r[3], r[5]], [[[['100']]], [[['100']]]], p + ': B waits for A\'s write to end, then reads the committed value');
  ok(e.events.some((x) => x.type === 'cc.wait'), p + ': B waited');
}
{
  const e = setup(ACCT, 'occ');
  const r = schedule(e, DIRTY);
  eq([r[3], r[5]], [[[['100']]], [[['100']]]], 'validation: A\'s write is local to A, B reads the database');
  ok(!e.events.some((x) => x.type === 'cc.wait'), 'validation: nobody waits');
}
{ // basic 2PL lets go of X at the lock point: a dirty read, then a cascading rollback
  const e = setup(ACCT, '2pl');
  const r = schedule(e, [['A', 'begin'], ['A', 'update acct set bal = 5 where id = 1'], ['A', 'select lock_point()'], ['B', 'begin'], ['B', 'select bal from acct where id = 1'], ['A', 'rollback'], ['B', 'select bal from acct where id = 1'], ['B', 'rollback']]);
  ok(/released/.test(r[2][0][0][0]), 'basic 2PL: lock_point() releases the locks');
  eq(r[4], [[['5']]], 'basic 2PL: B reads A\'s uncommitted value');
  eq([r[6].error, /rolled back/.test(r[6].detail || '')], ['25P02', true], 'basic 2PL: A rolls back, so B is rolled back too (the detail says why)');
  ok(e.events.some((x) => x.type === 'cc.cascade' && x.from === e.events.find((y) => y.type === 'cc.lockpoint').tx), 'basic 2PL: a cascading rollback event');
  eq(q(e, 'select bal from acct where id = 1'), [['100']], 'basic 2PL: nothing of A remains');
}
{ // strict 2PL keeps X: the reader waits even after the lock point
  const e = setup(ACCT, 'strict2pl');
  const r = schedule(e, [['A', 'begin'], ['A', 'update acct set bal = 5 where id = 1'], ['A', 'select lock_point()'], ['B', 'select bal from acct where id = 1'], ['A', 'commit']]);
  ok(/released S\(acct.2\)/.test(r[2][0][0][0]) && !/X\(/.test(r[2][0][0][0]), 'strict 2PL: the lock point releases S locks only');
  eq(r[3], [[['5']]], 'strict 2PL: B waited for the commit');
  const e2 = setup(ACCT, 'strict2pl');
  const r2 = schedule(e2, [['A', 'begin'], ['A', 'select bal from acct where id = 1'], ['A', 'select lock_point()'], ['A', 'update acct set bal = 1 where id = 1']]);
  eq([r2[3].error, r2[3].msg], ['25000', 'two-phase locking violated: transaction ' + e2.events.find((x) => x.type === 'cc.lockpoint').tx + ' is in its shrinking phase'], 'a lock after the lock point violates two-phase locking');
  const e3 = setup(ACCT, 'rigorous2pl');
  const r3 = schedule(e3, [['A', 'begin'], ['A', 'select bal from acct where id = 1'], ['A', 'select lock_point()'], ['B', 'update acct set bal = 1 where id = 1'], ['A', 'commit']]);
  ok(/nothing released/.test(r3[2][0][0][0]), 'rigorous 2PL: nothing is released before the end');
  eq(r3[3], ['UPDATE 1'], 'rigorous 2PL: the writer waited for the commit');
}

// ---- unrepeatable read ------------------------------------------------------------------------------------------------------
const UNREP = [['A', 'begin'], ['A', 'select bal from acct where id = 1'], ['B', 'update acct set bal = 50 where id = 1'], ['A', 'select bal from acct where id = 1'], ['A', 'commit']];
{
  const e = setup(ACCT);
  eq(schedule(e, UNREP)[3], [[['50']]], 'MVCC READ COMMITTED: the second read sees the committed update');
  const e2 = setup(ACCT, null, "set default_transaction_isolation = 'repeatable read'");
  eq(schedule(e2, UNREP)[3], [[['100']]], 'MVCC REPEATABLE READ: the snapshot holds');
}
for (const p of ['2pl', 'strict2pl', 'rigorous2pl', 'mv2pl']) {
  const e = setup(ACCT, p);
  const r = schedule(e, UNREP);
  eq([r[1], r[3], r[2]], [[[['100']]], [[['100']]], ['UPDATE 1']], p + ': the writer waits for A\'s S lock; A reads the same value twice');
  eq(q(e, 'select bal from acct where id = 1'), [['50']], p + ': the update happens after A');
}
{
  const e = setup(ACCT, 'to');
  const r = schedule(e, UNREP);
  eq(r[2], ['UPDATE 1'], 'TO: the younger writer goes ahead');
  eq(r[3].error, '40001', 'TO: A\'s second read comes too late (TS(A) < W-timestamp)');
  ok(/W-timestamp/.test(r[3].detail), 'TO: the reason names the W-timestamp');
}
{
  const e = setup(ACCT, 'occ');
  const r = schedule(e, UNREP);
  eq(r[3], [[['50']]], 'validation: the read phase sees the newest committed value');
  eq(r[4].error, '40001', 'validation: A fails, B wrote what A read after A started');
}
{
  const e = setup(ACCT, 'mvto');
  const r = schedule(e, UNREP);
  eq([r[3], r[4]], [[[['100']]], ['COMMIT']], 'MVTO: A keeps reading the version for its timestamp');
  eq(q(e, 'select bal from acct where id = 1'), [['50']], 'MVTO: B\'s version is the newest');
}
{
  const e = setup(ACCT, 'mv2pl');
  const r = schedule(e, [['A', 'begin read only'], ['A', 'select sum(bal) from acct'], ['B', 'update acct set bal = bal + 1 where id = 1'], ['A', 'select sum(bal) from acct'], ['A', 'commit']]);
  eq([r[1], r[2], r[3]], [[[['300']]], ['UPDATE 1'], [[['300']]]], 'MV2PL: a read-only transaction reads its snapshot and takes no locks');
  ok(e.events.some((x) => x.type === 'cc.ts'), 'MV2PL: the update transaction got a commit timestamp');
}

// ---- phantoms ----------------------------------------------------------------------------------------------------------------
const PHANTOM = [['A', 'begin'], ['A', 'select count(*) from acct where bal > 50'], ['B', 'insert into acct values (3, 300)'], ['A', 'select count(*) from acct where bal > 50'], ['A', 'commit']];
{
  const e = setup(ACCT);
  eq(schedule(e, PHANTOM)[3], [[['3']]], 'MVCC READ COMMITTED: the phantom appears');
  const e2 = setup(ACCT, null, "set default_transaction_isolation = 'repeatable read'");
  eq(schedule(e2, PHANTOM)[3], [[['2']]], 'MVCC REPEATABLE READ: no phantom');
}
{
  const e = setup(ACCT, 'strict2pl');
  const r = schedule(e, PHANTOM);
  eq([r[2], r[3]], [['INSERT 0 1'], [[['3']]]], '2PL on rows: the insert takes no lock A holds, and the phantom appears');
}
for (const extra of ['set phantom_protection = on', "set lock_granularity = 'table'"]) {
  const e = setup(ACCT, 'strict2pl', extra);
  const r = schedule(e, PHANTOM);
  eq([r[1], r[3], r[2]], [[[['2']]], [[['2']]], ['INSERT 0 1']], '2PL with ' + extra + ': the scan locks the table S, the insert (IX) waits');
  ok(e.events.some((x) => x.type === 'cc.wait' && x.mode === 'IX'), '2PL with ' + extra + ': the wait is for IX on the table');
}
{ // index-range (next-key) locking
  const ix = 'set enable_seqscan = off; set enable_bitmapscan = off';
  const setupSql = 'create table acct (id int primary key, bal int); insert into acct values (1, 100), (2, 200), (10, 1000)';
  const e = setup(setupSql, 'strict2pl', ix + '; set phantom_protection = on');
  const r = schedule(e, [['A', 'begin'], ['A', 'select count(*) from acct where id between 1 and 5'], ['B', 'insert into acct values (3, 300)'], ['C', 'insert into acct values (20, 2000)'], ['A', 'select count(*) from acct where id between 1 and 5'], ['A', 'commit']]);
  eq([r[1], r[4]], [[[['2']]], [[['2']]]], 'next-key locking: no phantom in the range');
  eq([r[2], r[3]], [['INSERT 0 1'], ['INSERT 0 1']], 'next-key locking: both inserts finish');
  const waits = e.events.filter((x) => x.type === 'cc.wait');
  eq(waits.map((x) => x.item), ['acct_pkey[10]'], 'next-key locking: only the insert of 3 waits, for the next key 10');
  const e2 = setup(setupSql, 'strict2pl', ix);
  const r2 = schedule(e2, [['A', 'begin'], ['A', 'select count(*) from acct where id between 1 and 5'], ['B', 'insert into acct values (3, 300)'], ['A', 'select count(*) from acct where id between 1 and 5'], ['A', 'commit']]);
  eq([r2[2], r2[3]], [['INSERT 0 1'], [[['3']]]], 'without phantom protection the index scan locks only the rows it found');
}
{
  const e = setup(ACCT, 'to', 'set phantom_protection = on');
  const r = schedule(e, PHANTOM);
  eq([r[2], r[3].error], [['INSERT 0 1'], '40001'], 'TO with the relation as a data item: the younger insert wins, A\'s rescan is rolled back');
  const e2 = setup(ACCT, 'occ', 'set phantom_protection = on');
  const r2 = schedule(e2, PHANTOM);
  eq([r2[3], r2[4].error], [[[['3']]], '40001'], 'validation with the relation as a data item: the phantom is caught at validation');
}

// ---- write skew -------------------------------------------------------------------------------------------------------------
const SKEW = (iso) => [['A', 'begin isolation level ' + iso], ['B', 'begin isolation level ' + iso], ['A', 'select count(*) from standby where ready and night = 1'], ['B', 'select count(*) from standby where ready and night = 1'], ['A', "update standby set ready = false where name = 'mara'"], ['B', "update standby set ready = false where name = 'tomas'"], ['A', 'commit'], ['B', 'commit']];
const SSI_ERR = { error: '40001', msg: 'could not serialize access due to read/write dependencies among transactions', detail: 'Reason code: Canceled on identification as a pivot, during commit attempt.', hint: 'The transaction might succeed if retried.' };
{
  const e = setup(STANDBY);
  const r = schedule(e, SKEW('repeatable read'));
  eq([r[6], r[7]], [['COMMIT'], ['COMMIT']], 'REPEATABLE READ: write skew, both commit (as in PostgreSQL)');
  eq(q(e, 'select ready from standby order by name'), [['f'], ['f']], 'REPEATABLE READ: nobody is on standby');
  const e2 = setup(STANDBY);
  const r2 = schedule(e2, SKEW('serializable'));
  eq(r2[6], ['COMMIT'], 'SERIALIZABLE: the first to commit succeeds');
  eq(r2[7], SSI_ERR, 'SERIALIZABLE: the second fails at commit, with PostgreSQL\'s message, detail and hint');
  eq(q(e2, 'select ready from standby order by name'), [['f'], ['t']], 'SERIALIZABLE: tomas is still on standby');
  ok(e2.events.some((x) => x.type === 'ssi.rw') && e2.events.some((x) => x.type === 'ssi.doom'), 'SERIALIZABLE: rw-conflicts flagged, the pivot doomed');
  const e3 = setup(STANDBY);
  const r3 = schedule(e3, SKEW('serializable').slice(0, 6).concat([['B', 'commit'], ['A', 'commit']]));
  eq([r3[6], r3[7]], [['COMMIT'], SSI_ERR], 'SERIALIZABLE: whichever commits first wins');
  eq(K.SSI.describe(e3.db).transactions, [], 'SSI: nothing is kept once no transaction overlaps');
}
{ // two accounts whose sum must stay positive
  const S2 = (iso) => [['A', 'begin isolation level ' + iso], ['B', 'begin isolation level ' + iso], ['A', 'select sum(bal) from acct'], ['B', 'select sum(bal) from acct'], ['A', 'update acct set bal = bal - 250 where id = 1'], ['B', 'update acct set bal = bal - 250 where id = 2'], ['B', 'commit'], ['A', 'commit']];
  const e = setup(ACCT);
  const r = schedule(e, S2('repeatable read'));
  eq([r[6], r[7], q(e, 'select sum(bal) from acct')], [['COMMIT'], ['COMMIT'], [['-200']]], 'REPEATABLE READ: both withdrawals commit, the sum goes negative');
  const e2 = setup(ACCT);
  const r2 = schedule(e2, S2('serializable'));
  eq([r2[6], r2[7]], [['COMMIT'], SSI_ERR], 'SERIALIZABLE: the second withdrawal fails');
  eq(q(e2, 'select sum(bal) from acct'), [['50']], 'SERIALIZABLE: the constraint holds');
}
{ // the lock, timestamp and validation protocols on write skew
  const run = (p) => { const e = setup(STANDBY, p); return { e, r: schedule(e, SKEW('read committed')), on: q(e, 'select ready from standby order by name') }; };
  for (const p of ['2pl', 'strict2pl', 'rigorous2pl']) { const { e, r, on } = run(p); eq([r[5].error, on], ['40P01', [['f'], ['t']]], p + ': write skew becomes a deadlock'); ok(cs(e), p + ': serializable history'); }
  { const { e, r, on } = run('to'); eq([r[4].error, r[7], on], ['40001', ['COMMIT'], [['t'], ['f']]], 'TO: the older A is rolled back'); ok(cs(e), 'TO: serializable history'); }
  { const { e, r, on } = run('occ'); eq([r[6], r[7].error, on], [['COMMIT'], '40001', [['f'], ['t']]], 'validation: B fails validation'); ok(cs(e), 'validation: serializable history'); }
  { const { r, on } = run('mvto'); eq([r[4].error, on], ['40001', [['t'], ['f']]], 'MVTO: A replaces a version B read'); }
}
{ // inserts: each transaction sums one class and inserts into the other (PostgreSQL's documentation example)
  const MYTAB = 'create table mytab (class int, value int); insert into mytab values (1, 10), (1, 20), (2, 100), (2, 200)';
  const steps = (iso) => [['A', 'begin isolation level ' + iso], ['B', 'begin isolation level ' + iso], ['A', 'select sum(value) from mytab where class = 1'], ['A', 'insert into mytab values (2, 30)'], ['B', 'select sum(value) from mytab where class = 2'], ['B', 'insert into mytab values (1, 300)'], ['A', 'commit'], ['B', 'commit']];
  const e = setup(MYTAB);
  const r = schedule(e, steps('serializable'));
  eq([r[2], r[4], r[6], r[7]], [[[['30']]], [[['300']]], ['COMMIT'], SSI_ERR], 'SERIALIZABLE: insert-based write skew fails at the second commit');
  const e2 = setup(MYTAB);
  const r2 = schedule(e2, steps('repeatable read'));
  eq([r2[6], r2[7]], [['COMMIT'], ['COMMIT']], 'REPEATABLE READ: both commit');
}
{ // the read-only anomaly (Fekete, O'Neil and O'Neil): the read-only transaction makes the cycle; the pivot fails
  const sql = 'create table control (deposit_no int not null); insert into control values (1); create table receipt (receipt_no serial primary key, deposit_no int not null, amount numeric(13,2)); insert into receipt (deposit_no, amount) values ((select deposit_no from control), 1.00), ((select deposit_no from control), 2.00)';
  const e = setup(sql);
  const r = schedule(e, [['A', 'begin isolation level serializable'], ['A', 'insert into receipt (deposit_no, amount) values ((select deposit_no from control), 4.00)'], ['B', 'begin isolation level serializable'], ['B', 'select deposit_no from control'], ['B', 'update control set deposit_no = 2'], ['B', 'commit'], ['C', 'begin isolation level serializable read only'], ['C', 'select deposit_no from control'], ['C', 'select receipt_no, amount from receipt where deposit_no = 1'], ['C', 'commit'], ['A', 'commit']]);
  eq([r[7], r[8], r[9]], [[[['2']]], [[['1', '1.00'], ['2', '2.00']]], ['COMMIT']], 'read-only anomaly: the report sees batch 2 closed without receipt 3');
  eq(r[10], SSI_ERR, 'read-only anomaly: the receipt transaction (the pivot) fails at commit, as in PostgreSQL');
}
{ // PostgreSQL's other reason codes, each checked against PostgreSQL 17
  const sql = 'create table tx (id int primary key, v int); create table ty (id int primary key, v int); create table tz (id int); insert into tx values (1, 1); insert into ty values (1, 1); insert into tz values (1)';
  const env = () => { const e = setup(sql); e.s.T = e.db.session({ name: 'T2' }); return e; };
  const e = env();
  const r = schedule(e, [['A', 'begin isolation level serializable'], ['B', 'begin isolation level serializable'], ['T', 'begin isolation level serializable'], ['A', 'select * from tz'], ['B', 'select * from tx'], ['T', 'update tx set v = 2'], ['T', 'commit'], ['A', 'select * from ty'], ['B', 'update ty set v = 2'], ['B', 'rollback'], ['A', 'commit']]);
  eq([r[8].error, r[8].detail], ['40001', 'Reason code: Canceled on identification as a pivot, during write.'], 'SSI: the writer is the pivot');
  const e2 = env();
  const r2 = schedule(e2, [['A', 'begin isolation level serializable'], ['A', 'select * from tz'], ['B', 'begin isolation level serializable'], ['T', 'begin isolation level serializable'], ['B', 'select * from tx'], ['T', 'update tx set v = 2'], ['T', 'commit'], ['B', 'update ty set v = 2'], ['B', 'commit'], ['A', 'select * from ty'], ['A', 'rollback']]);
  ok(r2[9].error === '40001' && /^Reason code: Canceled on conflict out to pivot \d+, during read\.$/.test(r2[9].detail), 'SSI: a read of a committed pivot\'s write');
  const e3 = setup(STANDBY);
  const r3 = schedule(e3, SKEW('serializable').slice(0, 7).concat([['B', 'select count(*) from standby'], ['B', 'rollback']]));
  eq(r3[7].detail, 'Reason code: Canceled on identification as a pivot, during conflict out checking.', 'SSI: a doomed transaction fails at its next read');
  const e4 = setup(STANDBY);
  const r4 = schedule(e4, SKEW('serializable').slice(0, 7).concat([['B', "insert into standby values ('ines', true, 1)"], ['B', 'rollback']]));
  eq(r4[7].detail, 'Reason code: Canceled on identification as a pivot, during conflict in checking.', 'SSI: a doomed transaction fails at its next write');
}
{ // index scans lock pages and tuples, not the relation: updates of different rows do not conflict
  const e = setup(ACCT, null, 'set enable_seqscan = off; set enable_bitmapscan = off');
  const r = schedule(e, [['A', 'begin isolation level serializable'], ['B', 'begin isolation level serializable'], ['A', 'update acct set bal = bal - 150 where id = 1'], ['B', 'update acct set bal = bal - 150 where id = 2'], ['A', 'select bal from acct where id = 1'], ['B', 'select bal from acct where id = 2'], ['B', 'commit'], ['A', 'commit']]);
  eq([r[6], r[7]], [['COMMIT'], ['COMMIT']], 'SSI with index scans: disjoint updates both commit (as in PostgreSQL)');
  ok(e.events.some((x) => x.type === 'ssi.lock' && x.kind === 'page' && /acct_pkey/.test(x.target)), 'SSI: an index scan locks B+ tree leaf pages');
  ok(e.events.some((x) => x.type === 'ssi.lock' && x.kind === 'tuple'), 'SSI: and heap tuples');
}
{ // promotion: tuple locks become a page lock, then a relation lock
  const e = setup('create table big (id int primary key, v text); insert into big select g, repeat(\'x\', 500) from generate_series(1, 400) g', null, 'set enable_seqscan = off; set enable_bitmapscan = off');
  schedule(e, [['A', 'begin isolation level serializable'], ['A', 'select count(*) from big where id between 1 and 3']]);
  ok(e.events.some((x) => x.type === 'ssi.promote' && x.to === 'page'), 'SSI: two tuple locks on one page become a page lock');
  schedule(e, [['A', 'select count(*) from big where id between 4 and 400']]);
  ok(e.events.some((x) => x.type === 'ssi.promote' && x.to === 'relation'), 'SSI: past 31 page locks, a relation lock');
  const t = K.SSI.describe(e.db).transactions.find((x) => x.tx === e.s.A.tx.id);
  ok(t.locks.some((l) => l.kind === 'relation' && l.target === 'big') && !t.locks.some((l) => l.target.startsWith('big ')), 'SSI: the relation lock replaces the finer locks on big');
}
{ // a READ ONLY transaction with no concurrent read-write one opts out (safe snapshot)
  const e = setup(ACCT);
  const r = schedule(e, [['A', 'begin isolation level serializable read only'], ['A', 'select sum(bal) from acct'], ['A', 'commit']]);
  eq(r[1], [[['300']]], 'safe snapshot: reads as usual');
  ok(e.events.some((x) => x.type === 'ssi.safe') && !e.events.some((x) => x.type === 'ssi.lock'), 'safe snapshot: no SIREAD locks');
}

// ---- deadlock handling with row locks only (index scans) -----------------------------------------------------------------------
const CROSS = [['A', 'begin'], ['B', 'begin'], ['A', 'update acct set bal = 1 where id = 1'], ['B', 'update acct set bal = 2 where id = 2'], ['A', 'update acct set bal = 1 where id = 2'], ['B', 'update acct set bal = 2 where id = 1'], ['A', 'commit'], ['B', 'commit']];
{
  const ix = 'set enable_seqscan = off; set enable_bitmapscan = off';
  const e = setup(ACCT, 'strict2pl', ix);
  const r = schedule(e, CROSS);
  eq([r[2], r[3], r[4], r[5].error], [['UPDATE 1'], ['UPDATE 1'], ['UPDATE 1'], '40P01'], 'detect: the cycle is found when B closes it');
  const e2 = setup(ACCT, 'strict2pl', ix + "; set deadlock_handling = 'wait-die'");
  const r2 = schedule(e2, CROSS);
  eq([r2[4], r2[5].error], [['UPDATE 1'], '40P01'], 'wait-die: A (older) waits for B; B (younger) asks for A\'s row and dies');
  const e3 = setup(ACCT, 'strict2pl', ix + "; set deadlock_handling = 'wound-wait'");
  const r3 = schedule(e3, CROSS);
  eq([r3[4], r3[5].error], [['UPDATE 1'], '40P01'], 'wound-wait: A (older) wounds B at once');
  eq(q(e3, 'select bal from acct order by id'), [['1'], ['1']], 'wound-wait: A\'s updates stand, B\'s are gone');
  // the tab's next transaction after a wait-die rollback has a timestamp of its own
  const e4 = setup(ACCT, 'strict2pl', ix + "; set deadlock_handling = 'wait-die'");
  schedule(e4, CROSS.slice(0, 6).concat([['B', 'rollback'], ['B', 'begin'], ['B', 'select bal from acct where id = 2']]));
  const die = e4.events.find((x) => x.type === 'cc.die');
  eq([e4.s.B.tx.lockTs, e4.s.B.tx.id > die.ts], [undefined, true], 'wait-die: the next transaction gets a new timestamp');
}
{ // multiple granularity: a seq-scan update holds SIX on the table, an index reader (IS) goes on, an inserter (IX) waits
  const e = setup(ACCT, 'strict2pl', "set lock_granularity = 'table'");
  e.s.B.exec('set enable_seqscan = off; set enable_bitmapscan = off');
  const r = schedule(e, [['A', 'begin'], ['A', 'update acct set bal = 0 where id = 1'], ['B', 'select bal from acct where id = 2'], ['C', 'insert into acct values (3, 3)'], ['A', 'commit']]);
  const table = (env) => env.db.protocol.describe().locks.find((l) => l.what === 'table acct');
  eq(r[2], [[['200']]], 'MGL: IS is compatible with SIX');
  eq(r[3], ['INSERT 0 1'], 'MGL: the insert finishes after the commit');
  const e2 = setup(ACCT, 'strict2pl', "set lock_granularity = 'table'");
  schedule(e2, [['A', 'begin'], ['A', 'update acct set bal = 0 where id = 1']]);
  eq(table(e2).granted.map((g) => g.mode), ['SIX'], 'MGL: S then IX on the table is SIX');
  eq(e2.db.protocol.describe().locks.find((l) => l.what === 'database').granted.map((g) => g.mode), ['IX'], 'MGL: IX on the database');
  ok(e.events.some((x) => x.type === 'cc.wait' && x.mode === 'IX'), 'MGL: the inserter waited for IX');
}
{ // Thomas' write rule
  const steps = [['A', 'begin'], ['A', 'select bal from acct where id = 1'], ['B', 'begin'], ['B', 'update acct set bal = 2 where id = 1'], ['B', 'commit'], ['A', 'update acct set bal = 1 where id = 1'], ['A', 'commit']];
  const e = setup(ACCT, 'to');
  const r = schedule(e, steps);
  eq(r[5].error, '40001', 'TO: an obsolete write rolls the transaction back');
  const e2 = setup(ACCT, 'to', 'set thomas_write_rule = on');
  const r2 = schedule(e2, steps);
  eq([r2[5], r2[6]], [['UPDATE 0'], ['COMMIT']], "Thomas' write rule: the obsolete write is ignored");
  eq(q(e2, 'select bal from acct where id = 1'), [['2']], "Thomas' write rule: B's value stays");
  ok(e2.events.some((x) => x.type === 'cc.ignore'), "Thomas' write rule: an ignore event");
}
{ // the per-transaction history the transactions view draws
  const e = setup(ACCT, 'strict2pl');
  schedule(e, [['A', 'begin'], ['A', 'select bal from acct where id = 1'], ['A', 'update acct set bal = 1 where id = 1'], ['A', 'commit']]);
  const d = e.db.protocol.describe();
  const t = d.transactions.find((x) => x.status === 'committed' && x.writes.length);
  ok(t.events.some((x) => x.kind === 'grant' && x.mode === 'S') && t.events.some((x) => x.kind === 'grant' && x.mode === 'X'), 'history: S then X granted');
  eq(t.events[t.events.length - 1].kind, 'commit', 'history: ends with the commit');
  ok(/^r\d+\(acct\.1\)/.test(d.schedule), 'history: a schedule the workbench can read');
  eq(K.Schedule.parse(d.schedule).ops.length > 0, true, 'history: parses');
  eq(q(e, 'select cc_schedule() is not null'), [['t']], 'cc_schedule() returns the history');
}
{ // lock_timeout applies to PostgreSQL's own row locks too
  const e = setup(ACCT, null, 'set lock_timeout = 100');
  const r = schedule(e, [['A', 'begin'], ['A', 'update acct set bal = 1 where id = 1'], ['B', 'update acct set bal = 2 where id = 1'], later(50), ['C', 'select 1'], later(60), ['A', 'commit']]);
  eq([r[2].error, r[2].msg], ['55P03', 'canceling statement due to lock timeout'], 'MVCC: a row-lock wait past lock_timeout is cancelled');
  eq(q(e, 'select bal from acct where id = 1'), [['1']], 'MVCC: the waiting update did not happen');
}
{ // switching back to MVCC
  const e = setup(ACCT, '2pl');
  e.s.A.exec("set concurrency_control = 'mvcc'");
  eq(e.db.protocol, null, 'mvcc clears the protocol');
  let err = null;
  try { e.s.A.exec("set concurrency_control = 'nosuch'"); } catch (x) { err = x.code; }
  eq(err, '22023', 'an unknown protocol is an invalid parameter value');
}
K.Clock.frozen = null;
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
