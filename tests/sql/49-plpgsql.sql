-- PL/pgSQL edge cases: DO blocks, errors and exception handlers, OUT parameters, set-returning functions, loops,
-- FOUND and ROW_COUNT, dynamic SQL, STRICT, recursion, defaults and named notation, procedures
create table acct (id int primary key, bal numeric(10,2) not null check (bal >= 0));
insert into acct values (1, 71), (2, 50), (3, 0), (4, 10), (6, 30), (8, 1), (41, 5), (42, 7), (43, 9);
create table tx_tab (x int);
insert into tx_tab values (2);
do $$ begin insert into tx_tab values (100); end $$;
select * from tx_tab order by x;
do $$ declare n int; begin select count(*) into n from acct; insert into tx_tab values (n); end $$;
select max(x) from tx_tab;
do $$ begin raise exception 'boom' using errcode = '22012'; end $$;
do $$ begin raise exception using errcode = 'unique_violation'; end $$;
do $$ begin raise sqlstate 'P1234'; end $$;
do $$ begin perform 1 / 0; exception when division_by_zero then insert into tx_tab values (-1); end $$;
select count(*) from tx_tab where x = -1;
create function safe_div(a int, b int) returns text language plpgsql as $$
begin
  return (a / b)::text;
exception
  when division_by_zero then return 'div0:' || sqlstate;
  when others then return 'other:' || sqlstate;
end $$;
select safe_div(7, 2), safe_div(1, 0), safe_div(2147483647, -1)::text;
select safe_div(-2147483647 - 1, -1);
create function errinfo(q text) returns text language plpgsql as $$
declare st text; msg text;
begin
  execute q;
  return 'ok';
exception when others then
  get stacked diagnostics st = returned_sqlstate, msg = message_text;
  return st || ': ' || msg;
end $$;
select errinfo('select 1/0');
select errinfo('select ''abc''::int');
select errinfo('insert into acct values (1, 1)');
select errinfo('insert into acct values (99, -5)');
select errinfo('select 1');
create function rethrow() returns int language plpgsql as $$
begin
  begin
    raise exception 'inner' using errcode = 'P0042';
  exception when sqlstate 'P0042' then
    raise;
  end;
  return 1;
end $$;
select rethrow();
create function catch_custom() returns text language plpgsql as $$
begin
  raise exception 'custom %', 7 using errcode = 'P0042', detail = 'd';
exception when sqlstate 'P0042' then return sqlerrm;
end $$;
select catch_custom();
create function effects_undone() returns int language plpgsql as $$
begin
  begin
    insert into tx_tab values (555);
    perform 1 / 0;
  exception when others then null;
  end;
  return (select count(*) from tx_tab where x = 555);
end $$;
select effects_undone();
create function minmax(a int[], out lo int, out hi int) language plpgsql as $$
begin
  select min(v), max(v) into lo, hi from unnest(a) v;
end $$;
select * from minmax(array[3, 9, 1]);
select (minmax(array[5])).hi, (minmax('{}')).lo;
create function evens(n int) returns setof int language plpgsql as $$
begin
  for i in reverse n..1 by 2 loop
    if i % 2 = 0 then return next i; end if;
  end loop;
  return;
end $$;
select * from evens(10);
select * from evens(0);
create function steps() returns setof int language plpgsql as $$
begin
  for i in 1..20 by 3 loop return next i; end loop;
  for i in reverse 3..1 loop return next -i; end loop;
end $$;
select array_agg(s) from steps() s;
create function richest(d text) returns table (name text, fee numeric) language plpgsql as $$
begin
  return query select a.person_id::text, a.fee from artist a where a.company_id = d order by a.fee desc nulls last, a.person_id limit 2;
  return query select 'total'::text, sum(a.fee) from artist a where a.company_id = d;
end $$;
select * from richest((select min(company_id) from artist));
select * from richest('Nowhere');
create function labels() returns text language plpgsql as $$
declare out text := '';
begin
  <<outer>>
  for i in 1..4 loop
    for j in 1..4 loop
      continue outer when j > i;
      exit outer when i = 4;
      out := out || i || j || ' ';
    end loop;
  end loop;
  return out;
end $$;
select labels();
create function arr_sum(a int[]) returns int language plpgsql as $$
declare s int := 0; v int;
begin
  foreach v in array a loop s := s + coalesce(v, 100); end loop;
  return s;
end $$;
select arr_sum(array[1, 2, 3]), arr_sum(array[[1, 2], [3, null]]), arr_sum('{}');
create function slices(a int[]) returns setof text language plpgsql as $$
declare r int[];
begin
  foreach r slice 1 in array a loop return next r::text; end loop;
end $$;
select * from slices(array[[1, 2], [3, 4], [5, 6]]);
create function found_test() returns text language plpgsql as $$
declare r record; n int; out text := '';
begin
  select * into r from acct where id = -1;
  out := out || found::text;
  select * into r from acct where id = 1;
  out := out || ',' || found::text;
  update acct set bal = bal where id > 0;
  get diagnostics n = row_count;
  out := out || ',' || n;
  delete from acct where id = -5;
  out := out || ',' || found::text;
  for r in select * from acct where id < 3 order by id loop n := r.id; end loop;
  out := out || ',' || found::text || n;
  return out;
end $$;
select found_test();
create function strict_get(k int) returns numeric language plpgsql as $$
declare b numeric;
begin
  select bal into strict b from acct where id >= k;
  return b;
end $$;
select strict_get(41);
select strict_get(1000);
select strict_get(1);
create function strict_catch(k int) returns text language plpgsql as $$
declare b numeric;
begin
  select bal into strict b from acct where id >= k;
  return b::text;
exception
  when no_data_found then return 'none';
  when too_many_rows then return 'many';
end $$;
select strict_catch(1000), strict_catch(1), strict_catch(41);
create function dyn(tbl text, k int) returns bigint language plpgsql as $$
declare n bigint;
begin
  execute format('select count(*) from %I where id > $1', tbl) into n using k;
  return n;
end $$;
create view artist_ids as select person_id as id from artist;
select dyn('acct', 0), dyn('artist_ids', 0) > 0;
select dyn('nosuch', 0);
create function dyn_rows(lim int) returns setof text language plpgsql as $$
begin
  return query execute 'select title::text from production order by title, prod_id limit $1' using lim;
end $$;
select * from dyn_rows(3);
create function rfact(n int) returns numeric language plpgsql as $$
begin
  if n <= 1 then return 1; end if;
  return n * rfact(n - 1);
end $$;
select rfact(1), rfact(25);
create function greet(who text, greeting text default 'Hello', punct text default '!') returns text language sql as $$ select greeting || ', ' || who || punct $$;
select greet('Ann'), greet('Bob', 'Hi'), greet('Cy', punct => '?'), greet(greeting => 'Yo', who => 'Di');
select greet();
select greet(who => 'x', who => 'y');
select greet(punct => '.', 'Ed');
create function addm(a int, b int default 10) returns int language plpgsql as $$ begin return a + b; end $$;
select addm(1), addm(1, 2), addm(b => 5, a => 1);
create function cnt_case(x int) returns text language plpgsql as $$
begin
  case
    when x < 0 then return 'neg';
    when x = 0 then return 'zero';
  end case;
  return 'pos-unreached';
end $$;
select cnt_case(-3), cnt_case(0);
select cnt_case(5);
create function simple_case(x int) returns text language plpgsql as $$
begin
  case x when 1, 2 then return 'small'; when 3 then return 'three'; else return 'big'; end case;
end $$;
select simple_case(1), simple_case(3), simple_case(9), simple_case(null);
create function noreturn(x int) returns int language plpgsql as $$ begin if x > 0 then return x; end if; end $$;
select noreturn(1);
select noreturn(-1);
create function while_test(n int) returns int language plpgsql as $$
declare i int := 0; s int := 0;
begin
  while i < n loop
    i := i + 1;
    continue when i % 3 = 0;
    s := s + i;
  end loop;
  loop
    exit when s < 100;
    s := s - 100;
  end loop;
  return s;
end $$;
select while_test(10), while_test(30), while_test(0);
create function assign_err() returns int language plpgsql as $$ declare x smallint; begin x := 40000; return x; end $$;
select assign_err();
create function not_null_var() returns int language plpgsql as $$ declare x int not null := 1; begin x := null; return x; end $$;
select not_null_var();
create function const_var() returns int language plpgsql as $$ declare x constant int := 5; begin return x * 2; end $$;
select const_var();
create function rec_fields() returns text language plpgsql as $$
declare r acct%rowtype; b acct.bal%type;
begin
  select * into r from acct where id = 2;
  b := r.bal * 2;
  return r.id || ':' || b;
end $$;
select rec_fields();
create procedure bump(k int, by_amt numeric) language plpgsql as $$ begin update acct set bal = bal + by_amt where id = k; end $$;
call bump(2, 5);
select bal from acct where id = 2;
call bump(2);
create procedure tx_proc() language plpgsql as $$
begin
  insert into tx_tab values (700);
  commit;
  insert into tx_tab values (701);
  rollback;
end $$;
call tx_proc();
select x from tx_tab where x >= 700 order by x;
begin;
call tx_proc();
rollback;
select x from tx_tab where x >= 700 order by x;
create function shadow() returns text language plpgsql as $$
declare x int := 1; out text := '';
begin
  out := out || x;
  declare x int := 2;
  begin
    out := out || x;
    <<inner>> declare x int := 3; begin out := out || x || inner.x; end;
  end;
  out := out || x;
  return out;
end $$;
select shadow();
create function arr_assign() returns int[] language plpgsql as $$
declare a int[] := '{}';
begin
  a[3] := 30;
  a[1] := 10;
  a := a || 40;
  return a;
end $$;
select arr_assign(), array_length(arr_assign(), 1);
create function null_bound(n int) returns int language plpgsql as $$ declare s int := 0; begin for i in 1..n loop s := s + i; end loop; return s; end $$;
select null_bound(4);
select null_bound(null);
create function zero_step() returns int language plpgsql as $$ declare s int := 0; begin for i in 1..5 by 0 loop s := s + 1; end loop; return s; end $$;
select zero_step();
create function assert_pos(x int) returns int language plpgsql as $$ begin assert x > 0, 'x must be positive'; return x; end $$;
select assert_pos(3);
select assert_pos(-3);
create function raise_fmt() returns text language plpgsql as $$
begin
  raise exception 'value % and %% literal and %', 1, 'two';
exception when others then return sqlerrm;
end $$;
select raise_fmt();
create function raise_too_few() returns text language plpgsql as $$ begin raise exception 'a % b %', 1; end $$;
select raise_too_few();
create function check_msg() returns text language plpgsql as $$
begin
  insert into acct values (500, -1);
  return 'no';
exception when check_violation then return sqlstate || ' ' || sqlerrm;
end $$;
select check_msg();
create function nested_handlers() returns text language plpgsql as $$
declare out text := '';
begin
  begin
    begin
      perform 1 / 0;
    exception when unique_violation then out := out || 'wrong';
    end;
  exception when division_by_zero then out := out || 'outer-caught';
  end;
  begin
    raise exception 'x' using errcode = '22003';
  exception when numeric_value_out_of_range or division_by_zero then out := out || ',both';
  end;
  return out;
end $$;
select nested_handlers();
create function handler_error() returns int language plpgsql as $$
begin
  perform 1 / 0;
  return 1;
exception when division_by_zero then
  return 1 / 0;
end $$;
select handler_error();
create function cursor_sum() returns numeric language plpgsql as $$
declare c cursor for select bal from acct order by id; v numeric; s numeric := 0;
begin
  open c;
  loop
    fetch c into v;
    exit when not found;
    s := s + v;
  end loop;
  close c;
  return s;
end $$;
select cursor_sum(), (select sum(bal) from acct);
create function cursor_args(lo int) returns text language plpgsql as $$
declare c cursor (k int) for select id from acct where id > k order by id; r record; out text := '';
begin
  for r in c(lo) loop out := out || r.id || ' '; end loop;
  return out;
end $$;
select cursor_args(5), cursor_args(100);
create function ret_comp() returns acct language plpgsql as $$ declare r acct; begin select * into r from acct where id = 2; r.bal := r.bal + 1; return r; end $$;
select ret_comp(), (ret_comp()).bal;
select * from ret_comp();
create function ret_void() returns void language plpgsql as $$ begin update acct set bal = bal where false; end $$;
select ret_void();
select ret_void() is null;
create function bad_field() returns int language plpgsql as $$ declare r record; begin select 1 as a into r; return r.b; end $$;
select bad_field();
create function unassigned_rec() returns int language plpgsql as $$ declare r record; begin return r.a; end $$;
select unassigned_rec();
create function into_more() returns text language plpgsql as $$ declare a int; b int; begin select 1, 2, 3 into a, b; return a || ',' || b; end $$;
select into_more();
create function into_fewer() returns text language plpgsql as $$ declare a int; b int; begin select 7 into a, b; return a || ',' || coalesce(b::text, 'null'); end $$;
select into_fewer();
create function concat_loop(n int) returns text language plpgsql as $$
declare s text := '';
begin
  for i in 1..n loop s := s || chr(64 + i); end loop;
  return s;
end $$;
select concat_loop(5), length(concat_loop(26));
create function exec_into_strict() returns int language plpgsql as $$ declare v int; begin execute 'select 1 where false' into strict v; return v; end $$;
select exec_into_strict();
create function dyn_ddl() returns bigint language plpgsql as $$
begin
  execute 'create table dyn_t (a int)';
  execute 'insert into dyn_t select g from generate_series(1, $1) g' using 5;
  return (select sum(a) from dyn_t);
end $$;
select dyn_ddl();
select count(*) from dyn_t;
create function getdiag() returns text language plpgsql as $$
declare n bigint; m bigint;
begin
  insert into tx_tab select g from generate_series(1, 4) g;
  get diagnostics n = row_count;
  delete from tx_tab where x <= 2;
  get diagnostics m = row_count;
  return n || '/' || m;
end $$;
select getdiag();
create function sqlstate_outside() returns text language plpgsql as $$ begin return sqlstate; end $$;
select sqlstate_outside();
create function over_load(x int) returns text language sql as $$ select 'int' $$;
create function over_load(x text) returns text language sql as $$ select 'text' $$;
select over_load(1), over_load('a'), over_load(1.5::int), over_load('1'::text);
select over_load(1.5);
create function inout_f(inout a int, inout b int) language plpgsql as $$ begin a := a + b; b := a * 2; end $$;
select * from inout_f(1, 2);
create function set_of_rec() returns setof acct language sql as $$ select * from acct where id < 4 order by id $$;
select * from set_of_rec();
select id from set_of_rec() where bal > 0;
select (set_of_rec()).id;
