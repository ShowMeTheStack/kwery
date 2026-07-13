// The SQL/PSM forms of the standard (the standard's own syntax, which PostgreSQL does not accept, so they are checked
// here rather than in the conformance files), and procedural behaviour the conformance harness cannot see:
// notices, the trigger timeline events, error context, subtransactions in the commit log.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { load } from './load.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const K = load();
const theatre = fs.readFileSync(path.join(root, 'src/data/theatre.sql'), 'utf8');
let pass = 0, fail = 0;
const eq = (a, b, what) => { if (JSON.stringify(a) === JSON.stringify(b)) pass++; else { fail++; console.log('FAIL ' + what + '\n  expected ' + JSON.stringify(b) + '\n  got      ' + JSON.stringify(a)); } };
function fresh() { const db = new K.Database(); const s = db.session(); s.exec(theatre); return { db, s }; }
const rows = (s, sql) => { let r; try { r = s.query(sql); } catch (e) { return 'error ' + e.code + ': ' + e.message; } return r.rows.map((row) => row.map((v, i) => (v === null ? null : K.T.output(v, r.cols[i].type)))); };
const one = (s, sql) => { const r = rows(s, sql); return typeof r === 'string' ? r : r[0][0]; };
const err = (s, sql) => { try { s.exec(sql); return null; } catch (e) { return e.code; } };

{ // a function counting a company's artists and its procedure form, with BEGIN ATOMIC and with BEGIN ... END
  const { s } = fresh();
  s.exec(`create function troupe_size(company_id varchar(5)) returns integer
    begin atomic
      declare n integer;
      select count(*) into n from artist where artist.company_id = troupe_size.company_id;
      return n;
    end`);
  eq(one(s, "select troupe_size('C07')"), one(s, "select count(*) from artist where company_id = 'C07'"), 'BEGIN ATOMIC function with DECLARE and SELECT INTO');
  eq(rows(s, "select company_id from company where troupe_size(company_id) > 4 order by 1"), rows(s, "select company_id from artist where company_id is not null group by company_id having count(*) > 4 order by 1"), 'PSM function in WHERE');
  s.exec(`create procedure troupe_size_proc(in company_id varchar(5), out n integer)
    begin
      select count(*) into n from artist where artist.company_id = troupe_size_proc.company_id;
    end`);
  eq(rows(s, "call troupe_size_proc('C04', null)"), rows(s, "select count(*)::int from artist where company_id = 'C04'"), 'procedure with an OUT parameter, BEGIN ... END body');
}
{ // WHILE ... DO, REPEAT ... UNTIL, IF ... ELSEIF, SET, LOOP with LEAVE and ITERATE
  const { s } = fresh();
  s.exec(`create function sum_even(n int) returns int language sql
    begin atomic
      declare i int default 0;
      declare total int default 0;
      while i < n do
        set i = i + 1;
        if i % 2 = 0 then set total = total + i;
        elseif i = 5 then set total = total + 100;
        end if;
      end while;
      return total;
    end`);
  eq(one(s, 'select sum_even(10)'), '130', 'WHILE ... DO ... END WHILE with IF ... ELSEIF');
  s.exec(`create function rep(n int) returns int
    begin atomic
      declare k int default 0;
      repeat set k = k + 1; until k >= n end repeat;
      return k;
    end`);
  eq(rows(s, 'select rep(5), rep(0)'), [['5', '1']], 'REPEAT ... UNTIL runs its body at least once');
  s.exec(`create function first_multiple(m int) returns int
    begin atomic
      declare i int default 0;
      scan: loop
        set i = i + 1;
        if i % m <> 0 then iterate scan; end if;
        if i > 10 then leave scan; end if;
      end loop scan;
      return i;
    end`);
  eq(one(s, 'select first_multiple(7)'), '14', 'labelled LOOP with ITERATE and LEAVE');
  s.exec(`create function nested(n int) returns int
    begin atomic
      declare a int default 0;
      outer_loop: while a < n do
        set a = a + 1;
        begin
          declare b int default 10;
          set a = a + b - 10;
        end;
      end while outer_loop;
      return a;
    end`);
  eq(one(s, 'select nested(3)'), '3', 'nested compound statement with its own DECLARE');
}
{ // FOR ... AS ... DO over a query
  const { s } = fresh();
  s.exec(`create function quillmere_budget() returns numeric
    begin atomic
      declare n numeric default 0;
      for r as select budget from company where city = 'Quillmere' do
        set n = n - r.budget;
      end for;
      return n;
    end`);
  eq(one(s, 'select quillmere_budget()'), one(s, "select -sum(budget) from company where city = 'Quillmere'"), 'FOR r AS query DO ... END FOR');
  s.exec(`create function total_runtime() returns numeric
    begin atomic
      declare t numeric default 0;
      for c as cur cursor for select runtime_min from production do
        set t = t + c.runtime_min;
      end for;
      return t;
    end`);
  eq(one(s, 'select total_runtime()'), one(s, 'select sum(runtime_min) from production'), 'FOR v AS c CURSOR FOR query');
}
{ // handlers: CONTINUE HANDLER FOR NOT FOUND with a cursor, EXIT HANDLER FOR SQLEXCEPTION, SIGNAL
  const { s } = fresh();
  s.exec(`create function count_by_cursor() returns int
    begin atomic
      declare done int default 0;
      declare n int default 0;
      declare x varchar(20);
      declare c cursor for select given_name from person;
      declare continue handler for not found set done = 1;
      open c;
      fetch_loop: loop
        fetch c into x;
        if done = 1 then leave fetch_loop; end if;
        set n = n + 1;
      end loop;
      close c;
      return n;
    end`);
  eq(one(s, 'select count_by_cursor()'), one(s, 'select count(*) from person'), 'cursor loop ended by a CONTINUE HANDLER FOR NOT FOUND');
  s.exec(`create function guarded(a int, b int) returns int
    begin atomic
      declare r int default -1;
      begin
        declare exit handler for sqlexception set r = -99;
        set r = a / b;
        set r = r + 1;
      end;
      return r;
    end`);
  eq(rows(s, 'select guarded(10, 2), guarded(1, 0)'), [['6', '-99']], 'EXIT HANDLER leaves the compound statement');
  s.exec(`create function checked(x int) returns int
    begin atomic
      if x < 0 then signal sqlstate '22003' set message_text = 'negative input'; end if;
      return x;
    end`);
  eq(err(s, 'select checked(-1)'), '22003', 'SIGNAL SQLSTATE raises the condition');
  eq(one(s, 'select checked(4)'), '4', 'SIGNAL only when reached');
  s.exec(`create function no_rows() returns text
    begin atomic
      declare n varchar(20) default 'none';
      select given_name into n from person where person_id = 'nope';
      return n;
    end`);
  eq(one(s, 'select no_rows()'), null, 'SELECT INTO without a row and without a handler sets the target to null');
  s.exec(`create function no_rows_handled() returns text
    begin atomic
      declare n varchar(20) default 'none';
      declare continue handler for not found set n = 'not found';
      select given_name into n from person where person_id = 'nope';
      return n;
    end`);
  eq(one(s, 'select no_rows_handled()'), 'not found', 'NOT FOUND handler runs for SELECT INTO without a row');
}
{ // a plain BEGIN ATOMIC body of SQL statements still runs as SQL
  const { s } = fresh();
  s.exec('create function plain(x int) returns int language sql begin atomic select x + 1; end');
  eq(one(s, 'select plain(1)'), '2', 'BEGIN ATOMIC with only SQL statements');
}
{ // RAISE notices reach the session, with their level; format placeholders and NULL
  const { s } = fresh();
  const r = s.exec("do $$ begin raise notice 'a % b %', 1, null; raise warning 'w %%'; raise info 'i'; end $$")[0];
  eq(r.notices.map((n) => n.level + ':' + n.message), ['NOTICE:a 1 b <NULL>', 'WARNING:w %', 'INFO:i'], 'RAISE NOTICE / WARNING / INFO');
  try { s.exec("do $$ begin raise exception 'bad %', 7 using detail = 'more', hint = 'try'; end $$"); } catch (e) { eq([e.code, e.message, e.detail, e.hint], ['P0001', 'bad 7', 'more', 'try'], 'RAISE EXCEPTION with USING options'); }
  try { s.exec("create function f1() returns int language plpgsql as $$ begin\n  return 1 / 0;\nend $$; select f1()"); } catch (e) { eq([e.code, /line 2 at RETURN/.test(e.context || '')], ['22012', true], 'error context names the function and line'); }
}
{ // the trigger timeline: one event per firing
  const { db, s } = fresh();
  const seen = [];
  db.bus.on('trigger.fire', (e) => seen.push(e.trigger + ' ' + e.timing + ' ' + e.level + ' ' + e.event));
  s.exec(`create function noop() returns trigger language plpgsql as $$ begin return new; end $$;
    create trigger b_row before update on company for each row execute function noop();
    create trigger a_stmt after update on company for each statement execute function noop();
    update company set budget = budget where company_id in ('C04', 'C11')`);
  eq(seen, ['b_row before row update', 'b_row before row update', 'a_stmt after statement update'], 'trigger.fire events');
}
{ // an EXCEPTION block is a subtransaction: its xid aborts when the handler runs, the rest commits
  const { db, s } = fresh();
  s.exec('create table t (x int)');
  s.exec(`do $$ begin insert into t values (1); begin insert into t values (2); perform 1 / 0; exception when others then null; end; insert into t values (3); end $$`);
  eq(rows(s, 'select x from t order by x'), [['1'], ['3']], 'the failed block is undone');
  const statuses = new Set(db.xact.describe().clog.map((c) => c.status));
  eq(statuses.has('aborted') && statuses.has('committed'), true, 'the subtransaction aborted, the transaction committed');
}
{ // a procedure that commits in a loop: each COMMIT ends a transaction and the work stays even if a later one fails
  const { s } = fresh();
  s.exec(`create table batch (n int);
    create procedure fill() language plpgsql as $$
    begin
      for i in 1..3 loop insert into batch values (i); commit; end loop;
      insert into batch values (99);
      raise exception 'stop';
    end $$`);
  eq(err(s, 'call fill()'), 'P0001', 'the last part fails');
  eq(rows(s, 'select n from batch order by n'), [['1'], ['2'], ['3']], 'committed batches stay');
  eq(err(s, 'begin; call fill(); '), '2D000', 'COMMIT inside a transaction block is not allowed');
  s.exec('rollback');
}
{ // a loop that would never end is stopped, so the page does not freeze
  const { s } = fresh();
  s.exec('create function spin() returns int language plpgsql as $$ begin loop end loop; end $$');
  eq(err(s, 'select spin()'), '57014', 'endless loop is cancelled');
}
{ // concurrency: a function called by a statement that waits keeps its frame; a trigger sees its own statement's rows
  const { s } = fresh();
  s.exec(`create table seen (n bigint);
    create function count_venues() returns trigger language plpgsql as $$ begin insert into seen select count(*) from venue; return new; end $$;
    create trigger cd after insert on venue for each row execute function count_venues()`);
  const before = +one(s, 'select count(*) from venue');
  s.exec("insert into venue values ('V1', 'Test Hall', 'Nowhere', 1990), ('V2', 'Test Barn', 'Nowhere', 1991)");
  eq(rows(s, 'select n from seen order by n'), [[String(before + 2)], [String(before + 2)]], 'AFTER ROW triggers fire at statement end and see all rows');
}
{ // procedures and triggers wait for row locks like any statement: run side by side, a CALL blocks, then a deadlock
  const db = new K.Database();
  const a = db.session({ name: 'A' }), b = db.session({ name: 'B' });
  a.exec(`create table acct (id int primary key, bal int);
    insert into acct values (1, 100), (2, 100);
    create procedure transfer(src int, dst int, amt int) language plpgsql as $$
    begin
      update acct set bal = bal - amt where id = src;
      update acct set bal = bal + amt where id = dst;
    end $$`);
  const ra = a.start('begin; update acct set bal = bal where id = 1');
  db.step();
  const rb = b.start('call transfer(1, 2, 10)');
  db.step();
  eq([ra.done, rb.done], [true, false], 'CALL waits for the row lock another transaction holds');
  const rc = a.start('commit');
  db.step();
  eq([rc.done, rb.done, rb.error], [true, true, null], 'the waiting CALL finishes once the lock is released');
  eq(rows(a, 'select bal from acct order by id'), [['90'], ['110']], 'the transfer happened');
  // a deadlock between two procedures: one of them fails with 40P01, and its handler may catch it
  a.exec(`create procedure slow_transfer(src int, dst int) language plpgsql as $$
    begin
      update acct set bal = bal - 1 where id = src;
      perform pg_sleep(0);
      update acct set bal = bal + 1 where id = dst;
    end $$`);
  a.start('begin; update acct set bal = bal where id = 1');
  b.start('begin; update acct set bal = bal where id = 2');
  db.step();
  const x2 = a.start('call slow_transfer(2, 1)');
  const y2 = b.start('call slow_transfer(1, 2)');
  db.step();
  const codes = [x2, y2].map((r) => (r.done && r.error ? r.error.code : null)).filter(Boolean);
  eq(codes, ['40P01'], 'deadlock between two CALLs is detected, one of them fails');
  a.exec('rollback'); b.exec('rollback');
}
{ // a trigger that has to wait passes the wait up too
  const db = new K.Database();
  const a = db.session({ name: 'A' }), b = db.session({ name: 'B' });
  a.exec(`create table item (id int primary key, n int); create table total (id int primary key, n int);
    insert into total values (1, 0);
    create function bump() returns trigger language plpgsql as $$ begin update total set n = n + new.n where id = 1; return new; end $$;
    create trigger bump after insert on item for each row execute function bump()`);
  const r1 = a.start('begin; insert into item values (1, 5)');
  db.step();
  const r2 = b.start('insert into item values (2, 7)');
  db.step();
  eq([r1.done, r2.done], [true, false], 'the second trigger waits for the first transaction');
  a.start('commit');
  db.step();
  eq([r2.done, r2.error], [true, null], 'and continues after it commits');
  eq(rows(a, 'select n from total'), [['12']], 'both increments applied');
}
{ // features Kwery does not model are refused, not ignored (PostgreSQL accepts them, so they cannot be conformance tests)
  const { s } = fresh();
  s.exec('create table par (a int)');
  eq(err(s, 'create table chi (b int) inherits (par)'), '0A000', 'INHERITS is refused');
  eq(err(s, 'create table pt (a int) partition by range (a)'), '0A000', 'PARTITION BY is refused');
  eq(err(s, 'create temp table oc (a int) on commit drop'), '0A000', 'ON COMMIT DROP is refused');
  eq(err(s, 'create temp table oc (a int) on commit preserve rows'), null, 'ON COMMIT PRESERVE ROWS is the default');
}
{ // a sequential scan returns rows in physical (ctid) order, also after updates, deletes, VACUUM and CLUSTER
  const { s } = fresh();
  const inOrder = () => { const r = rows(s, 'select ctid from phys').map((x) => x[0].slice(1, -1).split(',').map(Number)); return r.every((t, i) => !i || r[i - 1][0] < t[0] || (r[i - 1][0] === t[0] && r[i - 1][1] < t[1])); };
  s.exec("create table phys (id int primary key, pad text); insert into phys select g, repeat('x', 300) from generate_series(1, 60) g");
  s.exec('update phys set id = id + 100 where id % 3 = 0; delete from phys where id % 5 = 0');
  eq(inOrder(), true, 'ctid order after updates and deletes');
  s.exec("vacuum phys; insert into phys select g, 'y' from generate_series(1000, 1010) g");
  eq(inOrder(), true, 'ctid order after VACUUM and inserts into freed space');
  s.exec('cluster phys using phys_pkey');
  eq(inOrder(), true, 'ctid order after CLUSTER');
  eq(rows(s, 'select id from phys limit 3'), [['1'], ['2'], ['4']], 'CLUSTER put the rows in key order');
}
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
