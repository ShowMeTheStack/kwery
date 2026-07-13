-- PL/pgSQL: declarations, control flow, queries inside functions, errors and exception blocks, cursors,
-- set-returning functions, procedures and transaction control.
create function add1(x int) returns int language plpgsql as $$ begin return x + 1; end $$;
select add1(41), add1(null);
create function fact(n int) returns numeric language plpgsql as $$
declare
  r numeric := 1;
begin
  for i in 1..n loop
    r := r * i;
  end loop;
  return r;
end $$;
select fact(0), fact(5), fact(20);
create function fib(n int) returns bigint language plpgsql immutable as $$
declare a bigint := 0; b bigint := 1; t bigint;
begin
  if n < 0 then raise exception 'negative argument %', n using errcode = 'invalid_parameter_value'; end if;
  while n > 0 loop
    t := a + b; a := b; b := t; n := n - 1;
  end loop;
  return a;
end $$;
select fib(1), fib(10), fib(50);
select fib(-1);
create function roster_size(cid varchar) returns int language plpgsql as $$
declare n_artists integer;
begin
  select count(*) into n_artists from artist where artist.company_id = cid;
  return n_artists;
end $$;
select company_id, roster_size(company_id) from company order by company_id;
select company_id from company where roster_size(company_id) > 3 order by 1;
create function ambiguous(company_id varchar) returns int language plpgsql as $$
declare n int;
begin
  select count(*) into n from artist where artist.company_id = company_id;
  return n;
end $$;
select ambiguous('C01');
create function qualified(company_id varchar) returns int language plpgsql as $$
declare n int;
begin
  select count(*) into n from artist a where a.company_id = qualified.company_id;
  return n;
end $$;
select qualified('C01');
create function seat_band(code varchar) returns text language plpgsql as $$
begin
  if code is null then return 'none';
  elsif code like 'A%' then return 'stalls';
  elsif code like 'B%' then return 'circle';
  elseif code like 'C%' then return 'gallery';
  else return 'standing';
  end if;
end $$;
select seat_band('A12'), seat_band('B4'), seat_band('C7'), seat_band('F1'), seat_band(null);
create function season(m int) returns text language plpgsql as $$
begin
  case m
    when 12, 1, 2 then return 'winter';
    when 3, 4, 5 then return 'spring';
    when 6, 7, 8 then return 'summer';
    else return 'autumn';
  end case;
end $$;
select season(1), season(4), season(7), season(10);
create function sign_word(x numeric) returns text language plpgsql as $$
declare w text;
begin
  case
    when x < 0 then w := 'negative';
    when x = 0 then w := 'zero';
    when x > 0 then w := 'positive';
  end case;
  return w;
end $$;
select sign_word(-3), sign_word(0), sign_word(2.5);
select sign_word(null);
create function evens(n int) returns text language plpgsql as $$
declare s text := '';
begin
  for i in 1..n loop
    continue when i % 2 = 1;
    s := s || i || ' ';
  end loop;
  return trim(s);
end $$;
select evens(10);
create function countdown(n int) returns text language plpgsql as $$
declare s text := '';
begin
  for i in reverse n..1 by 2 loop
    s := s || i || ',';
  end loop;
  return s;
end $$;
select countdown(9), countdown(0);
create function first_square_over(lim int) returns int language plpgsql as $$
declare i int := 0;
begin
  loop
    i := i + 1;
    exit when i * i > lim;
  end loop;
  return i;
end $$;
select first_square_over(50), first_square_over(0);
create function nested_exit() returns text language plpgsql as $$
declare s text := '';
begin
  <<outer>>
  for i in 1..3 loop
    for j in 1..3 loop
      if j = 2 then continue outer; end if;
      if i = 3 then exit outer; end if;
      s := s || i || j || ' ';
    end loop;
  end loop;
  return s;
end $$;
select nested_exit();
create function block_exit() returns int language plpgsql as $$
declare x int := 1;
begin
  <<blk>>
  begin
    x := 2;
    exit blk;
    x := 3;
  end;
  return x;
end $$;
select block_exit();
create function bad_exit() returns int language plpgsql as $$ begin exit; return 1; end $$;
create function bad_continue() returns int language plpgsql as $$ begin <<b>> begin continue b; end; return 1; end $$;
create function bad_label() returns int language plpgsql as $$ begin loop exit nowhere; end loop; return 1; end $$;
create function no_return(x int) returns int language plpgsql as $$ begin if x > 0 then return x; end if; end $$;
select no_return(1);
select no_return(-1);
create function arr_sum(a int[]) returns int language plpgsql as $$
declare s int := 0; x int;
begin
  foreach x in array a loop
    s := s + x;
  end loop;
  return s;
end $$;
select arr_sum(array[1,2,3,4]), arr_sum(array[[1,2],[3,4]]), arr_sum('{}');
select arr_sum(null);
create function row_sums(a int[]) returns text language plpgsql as $$
declare r int[]; s text := '';
begin
  foreach r slice 1 in array a loop
    s := s || array_to_string(r, '+') || ';';
  end loop;
  return s;
end $$;
select row_sums(array[[1,2],[3,4],[5,6]]);
create function arr_build(n int) returns int[] language plpgsql as $$
declare a int[] := '{}';
begin
  for i in 1..n loop a[i] := i * i; end loop;
  a[n + 2] := 0;
  return a;
end $$;
select arr_build(4);
create function consts() returns text language plpgsql as $$
declare
  pi constant numeric := 3.14159;
  n int not null := 7;
  t text default 'hi';
  d date := date '2024-02-28' + 1;
  v varchar(5) := 'abc';
begin
  return pi || ' ' || n || ' ' || t || ' ' || d || ' ' || v;
end $$;
select consts();
create function const_assign() returns int language plpgsql as $$ declare c constant int := 1; begin c := 2; return c; end $$;
create function notnull_nodef() returns int language plpgsql as $$ declare c int not null; begin return 1; end $$;
create function notnull_assign() returns int language plpgsql as $$ declare c int not null := 1; begin c := null; return c; end $$;
select notnull_assign();
create function too_long() returns text language plpgsql as $$ declare v varchar(3); begin v := 'abcdef'; return v; end $$;
select too_long();
create function conversions() returns text language plpgsql as $$
declare i int; n numeric(5,2); b boolean; t text;
begin
  i := '42';
  n := 3.14159;
  b := 'yes';
  t := 12.5;
  i := 7.5;
  return i || ' ' || n || ' ' || b::int || ' ' || t;
end $$;
select conversions();
create function bad_conv() returns int language plpgsql as $$ declare i int; begin i := 'abc'; return i; end $$;
select bad_conv();
create function family_of(p_id varchar) returns varchar language plpgsql as $$
declare n person.family_name%type;
begin
  select family_name into strict n from person where person_id = p_id;
  return n;
end $$;
select family_of((select min(person_id) from person)) = (select family_name from person order by person_id limit 1);
select family_of('none');
create function any_member(d varchar, lo numeric default 0) returns varchar language plpgsql as $$
declare n varchar;
begin
  select p.family_name into strict n from artist a join person p using (person_id) where a.company_id = d and a.fee >= lo;
  return n;
end $$;
select any_member((select company_id from artist group by company_id order by count(*) desc, company_id limit 1));
select any_member('C01', (select max(fee) from artist where company_id = 'C01')) = (select p.family_name from artist a join person p using (person_id) where a.company_id = 'C01' order by a.fee desc limit 1);
select any_member('C99');
create function nonstrict(d varchar) returns text language plpgsql as $$
declare n varchar; f boolean;
begin
  select p.family_name into n from artist a join person p using (person_id) where a.company_id = d order by p.family_name, p.person_id;
  f := found;
  return coalesce(n, '-') || ' ' || f::int;
end $$;
select nonstrict('C01') like '% 1', nonstrict('Nowhere');
create function rowtype_demo(p_id varchar) returns text language plpgsql as $$
declare r artist%rowtype;
begin
  select * into r from artist where person_id = p_id;
  if not found then return 'missing'; end if;
  return coalesce(r.billed_as, '?') || ' of ' || coalesce(r.company_id, 'freelance');
end $$;
select rowtype_demo((select min(person_id) from artist)) = (select coalesce(billed_as, '?') || ' of ' || coalesce(company_id, 'freelance') from artist order by person_id limit 1), rowtype_demo('x');
create function record_demo() returns text language plpgsql as $$
declare r record; s text := '';
begin
  for r in select company_id, count(*) as n from artist where company_id is not null group by company_id order by n desc, company_id limit 3 loop
    s := s || r.company_id || '=' || r.n || ' ';
  end loop;
  return s;
end $$;
select record_demo();
create function record_unassigned() returns text language plpgsql as $$ declare r record; begin return r.x; end $$;
select record_unassigned();
create function record_nofield() returns text language plpgsql as $$ declare r record; begin select 1 as a into r; return r.b; end $$;
select record_nofield();
create function multi_into() returns text language plpgsql as $$
declare a int; b text; c numeric;
begin
  select 1, 'two', 3.5 into a, b, c;
  return a || b || c;
end $$;
select multi_into();
create function into_later() returns boolean language plpgsql as $$
declare mx numeric;
begin
  select max(fee) from artist into mx;
  return mx = (select max(fee) from artist);
end $$;
select into_later();
create function no_dest() returns int language plpgsql as $$ begin select 1; return 1; end $$;
select no_dest();
create function perform_found() returns text language plpgsql as $$
declare a boolean; b boolean;
begin
  perform 1 from artist where fee > 1000000;
  a := found;
  perform * from artist;
  b := found;
  return a::int || ' ' || b::int;
end $$;
select perform_found();
create table log (id serial primary key, msg text, at_count int);
create function raise_fees(d varchar, pct numeric) returns int language plpgsql as $$
declare n int;
begin
  update artist set fee = fee * (1 + pct / 100) where company_id = d;
  get diagnostics n = row_count;
  insert into log (msg, at_count) values ('raised ' || d, n);
  return n;
end $$;
select raise_fees('C01', 10);
select msg, at_count from log order by id;
select count(*), sum(fee) from artist where company_id = 'C01';
create function returning_into() returns text language plpgsql as $$
declare new_id int; m text;
begin
  insert into log (msg) values ('hello') returning id, msg into new_id, m;
  return m || ' ' || (new_id > 0)::int;
end $$;
select returning_into();
create function returning_many() returns int language plpgsql as $$
declare x int;
begin
  update log set at_count = 0 returning id into x;
  return x;
end $$;
select returning_many();
create function del_count() returns text language plpgsql as $$
declare n int; f1 boolean; f2 boolean;
begin
  delete from log where msg = 'nothing';
  f1 := found;
  delete from log where msg = 'hello';
  get diagnostics n = row_count;
  f2 := found;
  return f1::int || ' ' || f2::int || ' ' || n;
end $$;
select del_count();
create function safe_div(a numeric, b numeric) returns numeric language plpgsql as $$
begin
  return a / b;
exception
  when division_by_zero then return null;
end $$;
select safe_div(10, 4), safe_div(1, 0);
create function catch_state() returns text language plpgsql as $$
declare x int;
begin
  x := 1 / 0;
  return 'no';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
select catch_state();
create function catch_unique() returns text language plpgsql as $$
begin
  insert into company values ('C01', 'Second Act Players', 'Northbay', 1990, 70000);
  return 'inserted';
exception
  when unique_violation or foreign_key_violation then return 'dup ' || sqlstate;
end $$;
select catch_unique();
create function catch_class() returns text language plpgsql as $$
begin
  insert into person values ('P9999', null, 'Nobody', null, null);
  return 'ok';
exception when integrity_constraint_violation then return 'integrity ' || sqlstate;
end $$;
select catch_class();
create function catch_sqlstate() returns text language plpgsql as $$
begin
  perform 'x'::int;
  return 'ok';
exception when sqlstate '22P02' then return 'bad text';
end $$;
select catch_sqlstate();
create function uncaught() returns text language plpgsql as $$
begin
  perform 1 / 0;
  return 'ok';
exception when unique_violation then return 'dup';
end $$;
select uncaught();
create function undo_block() returns text language plpgsql as $$
begin
  insert into log (msg) values ('kept');
  begin
    insert into log (msg) values ('undone');
    perform 1 / 0;
  exception when division_by_zero then
    insert into log (msg) values ('handler');
  end;
  return (select string_agg(msg, ',' order by id) from log where msg in ('kept', 'undone', 'handler'));
end $$;
select undo_block();
select msg from log where msg in ('kept', 'undone', 'handler') order by id;
create function nested_handlers() returns text language plpgsql as $$
declare s text := '';
begin
  begin
    begin
      raise exception 'inner' using errcode = '22012';
    exception when unique_violation then s := s || 'wrong';
    end;
  exception when division_by_zero then s := s || 'outer caught ' || sqlerrm;
  end;
  return s;
end $$;
select nested_handlers();
create function reraise() returns text language plpgsql as $$
begin
  begin
    perform 1 / 0;
  exception when others then
    raise;
  end;
  return 'no';
exception when division_by_zero then return 'reraised ' || sqlstate;
end $$;
select reraise();
create function raise_custom(code text) returns text language plpgsql as $$
begin
  raise exception 'custom % and %', code, 42 using errcode = code, detail = 'some detail', hint = 'a hint';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
select raise_custom('P0001'), raise_custom('22023'), raise_custom('XY123');
create function raise_cond() returns text language plpgsql as $$
begin
  raise unique_violation;
exception when unique_violation then return sqlerrm;
end $$;
select raise_cond();
create function raise_state() returns text language plpgsql as $$
begin
  raise sqlstate '23503' using message = 'no such parent';
exception when foreign_key_violation then return sqlerrm;
end $$;
select raise_state();
create function raise_plain() returns int language plpgsql as $$ begin raise exception 'plain failure'; end $$;
select raise_plain();
create function raise_bad_args() returns int language plpgsql as $$ begin raise notice 'a % b %', 1; return 1; end $$;
create function raise_null_fmt() returns text language plpgsql as $$
begin
  raise exception 'value is %, %%', null;
exception when others then return sqlerrm;
end $$;
select raise_null_fmt();
create function stacked() returns text language plpgsql as $$
declare st text; msg text; det text; hnt text; tbl text; con text;
begin
  insert into company values ('C99', 'Twice Told', 'Northbay', 2001, 1000);
  insert into company values ('C99', 'Twice Again', 'Northbay', 2001, 1000);
  return 'no';
exception when unique_violation then
  get stacked diagnostics st = returned_sqlstate, msg = message_text, det = pg_exception_detail, con = constraint_name, tbl = table_name;
  return st || '|' || msg || '|' || det || '|' || con || '|' || tbl;
end $$;
select stacked();
create function stacked_outside() returns text language plpgsql as $$ declare s text; begin get stacked diagnostics s = message_text; return s; end $$;
select stacked_outside();
create function assert_pos(x int) returns int language plpgsql as $$ begin assert x > 0, 'x must be positive'; return x; end $$;
select assert_pos(3);
select assert_pos(-3);
create function assert_catch() returns text language plpgsql as $$
begin
  assert 1 = 2;
  return 'no';
exception when assert_failure then return 'caught ' || sqlerrm;
end $$;
select assert_catch();
create function assert_others() returns text language plpgsql as $$
begin
  assert false;
  return 'no';
exception when others then return 'others';
end $$;
select assert_others();
create function top_paid(n int) returns setof artist language plpgsql as $$
declare r artist%rowtype;
begin
  for r in select * from artist order by fee desc, person_id limit n loop
    return next r;
  end loop;
  return;
end $$;
select count(*) from top_paid(3);
select person_id from top_paid(2) order by person_id;
create function roster(d varchar) returns table (aname varchar, afee numeric) language plpgsql as $$
begin
  return query select billed_as, fee from artist where company_id = d;
end $$;
select * from roster('C02') order by aname, afee;
select count(*), sum(afee) = (select sum(fee) from artist where company_id = 'C03') from roster('C03');
create function squares(n int) returns setof int language plpgsql as $$
begin
  for i in 1..n loop return next i * i; end loop;
end $$;
select * from squares(5);
select sum(s) from squares(10) s;
select squares(3);
create function pairs(n int) returns table (a int, b int) language plpgsql as $$
begin
  for i in 1..n loop
    a := i; b := i * 10;
    return next;
  end loop;
end $$;
select * from pairs(3);
create function query_twice() returns setof text language plpgsql as $$
begin
  return query select 'x'::text;
  return query select billed_as::text from artist where company_id = 'C02' order by billed_as;
  return next 'end';
end $$;
select * from query_twice();
create function return_value_setof() returns setof int language plpgsql as $$ begin return 1; end $$;
create function next_non_setof() returns int language plpgsql as $$ begin return next 1; end $$;
create function wrong_query_shape() returns setof int language plpgsql as $$ begin return query select 1, 2; end $$;
select * from wrong_query_shape();
create function out_params(x int, out doubled int, out squared int) language plpgsql as $$
begin
  doubled := x * 2;
  squared := x * x;
end $$;
select * from out_params(7);
select (out_params(3)).squared;
create function one_out(x int, out y int) language plpgsql as $$ begin y := x + 100; end $$;
select one_out(1);
create function inout_param(inout v int) language plpgsql as $$ begin v := v * 3; end $$;
select inout_param(5);
create function return_with_out(out y int) language plpgsql as $$ begin y := 1; return 5; end $$;
create function void_fn() returns void language plpgsql as $$ begin insert into log (msg) values ('void'); end $$;
select void_fn();
select count(*) from log where msg = 'void';
create function void_return_value() returns void language plpgsql as $$ begin return 1; end $$;
create function composite_ret(p_id varchar) returns artist language plpgsql as $$
declare r artist;
begin
  select * into r from artist where person_id = p_id;
  return r;
end $$;
select (composite_ret((select min(person_id) from artist))).fee = (select fee from artist order by person_id limit 1);
create type pair as (x int, y text);
create function make_pair(a int) returns pair language plpgsql as $$
declare p pair;
begin
  p.x := a;
  p.y := 'n' || a;
  return p;
end $$;
select make_pair(4), (make_pair(5)).y;
select * from make_pair(6);
create function dyn_count(tbl text) returns bigint language plpgsql as $$
declare n bigint;
begin
  execute 'select count(*) from ' || quote_ident(tbl) into n;
  return n;
end $$;
select dyn_count('company') = (select count(*) from company), dyn_count('production') = (select count(*) from production);
select dyn_count('nosuch');
create function dyn_using(d text, lo numeric) returns bigint language plpgsql as $$
declare n bigint;
begin
  execute format('select count(*) from %I where company_id = $1 and fee > $2', 'artist') into n using d, lo;
  return n;
end $$;
select dyn_using('C01', 0) = roster_size('C01');
create function dyn_ddl() returns int language plpgsql as $$
declare n int;
begin
  execute 'create table dyn_t (a int)';
  execute 'insert into dyn_t select generate_series(1, 5)';
  get diagnostics n = row_count;
  return n;
end $$;
select dyn_ddl();
select count(*) from dyn_t;
create function dyn_loop() returns text language plpgsql as $$
declare r record; s text := '';
begin
  for r in execute 'select a from dyn_t where a > $1 order by a' using 2 loop
    s := s || r.a;
  end loop;
  return s;
end $$;
select dyn_loop();
create function dyn_strict() returns int language plpgsql as $$ declare x int; begin execute 'select a from dyn_t' into strict x; return x; end $$;
select dyn_strict();
create function dyn_null() returns int language plpgsql as $$ begin execute null; return 1; end $$;
select dyn_null();
create function cursor_sum() returns numeric language plpgsql as $$
declare
  c cursor for select fee from artist order by person_id;
  s numeric := 0;
  v numeric;
begin
  open c;
  loop
    fetch c into v;
    exit when not found;
    s := s + v;
  end loop;
  close c;
  return s = (select sum(fee) from artist);
end $$;
select cursor_sum();
create function cursor_args(d varchar) returns text language plpgsql as $$
declare
  c cursor (dn varchar) for select p.family_name from artist a join person p using (person_id) where a.company_id = dn order by p.family_name, p.person_id;
  n varchar;
  s text := '';
begin
  open c(d);
  fetch c into n; s := s || n;
  fetch last from c into n; s := s || '..' || n;
  close c;
  return s;
end $$;
select cursor_args('C02');
create function cursor_for() returns int language plpgsql as $$
declare
  c cursor for select * from company;
  k int := 0;
begin
  for r in c loop k := k + 1; end loop;
  return k;
end $$;
select cursor_for() = (select count(*) from company);
create function refcur() returns refcursor language plpgsql as $$
declare c refcursor := 'mycur';
begin
  open c for select company_id from company order by company_id;
  return c;
end $$;
begin;
select refcur();
fetch 2 from mycur;
close mycur;
commit;
create function cursor_move() returns text language plpgsql as $$
declare c refcursor; v text;
begin
  open c scroll for select x::text from generate_series(1, 10) x;
  move forward 3 from c;
  fetch c into v;
  fetch prior from c into v;
  fetch absolute 8 from c into v;
  close c;
  return v;
end $$;
select cursor_move();
create function closed_cursor() returns int language plpgsql as $$ declare c refcursor; v int; begin fetch c into v; return v; end $$;
select closed_cursor();
create function alias_demo(int, int) returns int language plpgsql as $$
declare a alias for $1; b alias for $2;
begin
  return a * 10 + $2;
end $$;
select alias_demo(4, 2);
create function label_vars() returns text language plpgsql as $$
<<outer>>
declare x int := 1;
begin
  declare x int := 2;
  begin
    return outer.x || ',' || x;
  end;
end $$;
select label_vars();
create function shadow() returns int language plpgsql as $$
declare i int := 100;
begin
  for i in 1..3 loop null; end loop;
  return i;
end $$;
select shadow();
create function recurse(n int) returns int language plpgsql as $$ begin if n = 0 then return 0; end if; return n + recurse(n - 1); end $$;
select recurse(50);
create function forever(n int) returns int language plpgsql as $$ begin return forever(n + 1); end $$;
select forever(1);
create function call_count() returns int language plpgsql as $$
declare n int := 0;
begin
  for i in 1..3 loop
    insert into log (msg) values ('loop ' || i);
    n := n + (select count(*) from log where msg like 'loop %');
  end loop;
  return n;
end $$;
select call_count();
create function sees_outer() returns bigint language plpgsql as $$ begin return (select count(*) from log where msg = 'row'); end $$;
insert into log (msg, at_count) select 'row', sees_outer() from generate_series(1, 3);
select at_count from log where msg = 'row' order by id;
create function strict_fn(x int) returns int language plpgsql strict as $$ begin return 1; end $$;
select strict_fn(null), strict_fn(5);
create function default_arg(a int, b int default 10) returns int language plpgsql as $$ begin return a + b; end $$;
select default_arg(1), default_arg(1, 2);
create function syntax_err() returns int language plpgsql as $$ begin retrun 1; end $$;
create function missing_end_if(x int) returns int language plpgsql as $$ begin if x > 0 then return 1; end; $$;
create function bad_type() returns int language plpgsql as $$ declare x nosuchtype; begin return 1; end $$;
create function unknown_var() returns int language plpgsql as $$ begin select 1 into nosuchvar; return 1; end $$;
create function bad_cond() returns int language plpgsql as $$ begin return 1; exception when no_such_condition then return 2; end $$;
create function unknown_col() returns int language plpgsql as $$ begin return nosuchcol; end $$;
select unknown_col();
create function multi_row_expr() returns int language plpgsql as $$ declare x int; begin x := (select id::int from dyn_t); return x; end $$;
create function multi_row_assign() returns int language plpgsql as $$ declare x int; begin x := a from dyn_t; return x; end $$;
select multi_row_assign();
create function assign_query() returns int language plpgsql as $$ declare x int; begin x := max(a) from dyn_t; return x; end $$;
select assign_query();
do $$
declare n int;
begin
  insert into log (msg) values ('from do');
  select count(*) into n from log where msg = 'from do';
  if n <> 1 then raise exception 'expected one row'; end if;
end $$;
select count(*) from log where msg = 'from do';
do $$ begin raise exception 'do failed: %', 'yes'; end $$;
do $$ begin perform 1; end $$;
create procedure add_log(m text) language plpgsql as $$ begin insert into log (msg) values (m); end $$;
call add_log('via call');
select count(*) from log where msg = 'via call';
create procedure inout_proc(inout a int, inout b int) language plpgsql as $$ begin a := a + b; b := a * 2; end $$;
call inout_proc(1, 2);
create procedure tx_proc() language plpgsql as $$
begin
  insert into log (msg) values ('committed');
  commit;
  insert into log (msg) values ('rolled back');
  rollback;
  insert into log (msg) values ('last');
end $$;
call tx_proc();
select msg from log where msg in ('committed', 'rolled back', 'last') order by id;
begin;
call tx_proc();
rollback;
create procedure call_inner() language plpgsql as $$
declare x int := 1; y int := 5;
begin
  call inout_proc(x, y);
  insert into log (msg) values ('inner ' || x || ' ' || y);
end $$;
call call_inner();
select msg from log where msg like 'inner%';
create procedure proc_return_value() language plpgsql as $$ begin return 1; end $$;
create function fn_commit() returns int language plpgsql as $$ begin commit; return 1; end $$;
select fn_commit();
create function txn_in_handler() returns text language plpgsql as $$
begin
  insert into log (msg) values ('a');
  perform 1 / 0;
  return 'x';
exception when others then
  return (select count(*) from log where msg = 'a')::text;
end $$;
select txn_in_handler();
select count(*) from log where msg = 'a';
begin;
select safe_div(1, 0);
insert into log (msg) values ('in tx');
select catch_unique();
commit;
select count(*) from log where msg = 'in tx';
create function looper() returns int language plpgsql as $$
declare i int := 0; total int := 0;
begin
  while true loop
    i := i + 1;
    if i > 1000 then exit; end if;
    total := total + i;
  end loop;
  return total;
end $$;
select looper();
create function if_null_cond() returns text language plpgsql as $$ begin if null then return 'yes'; else return 'no'; end if; end $$;
select if_null_cond();
create function for_null() returns int language plpgsql as $$ begin for i in 1..null loop end loop; return 1; end $$;
select for_null();
create function for_bad_by() returns int language plpgsql as $$ begin for i in 1..3 by 0 loop end loop; return 1; end $$;
select for_bad_by();
create function found_for() returns text language plpgsql as $$
declare a boolean; b boolean;
begin
  for i in 1..0 loop end loop;
  a := found;
  for i in 1..2 loop end loop;
  b := found;
  return a::int || ' ' || b::int;
end $$;
select found_for();
create function quote_demo(t text) returns text language plpgsql as $$
begin
  return format('%s|%I|%L', t, t, t);
end $$;
select quote_demo('O''Neil'), quote_demo('plain');
create function case_expr(x int) returns text language plpgsql as $$
declare r text;
begin
  r := case when x > 0 then 'pos' when x < 0 then 'neg' else 'zero' end;
  if case when x = 0 then true else false end then r := r || '!'; end if;
  return r;
end $$;
select case_expr(1), case_expr(0), case_expr(-1);
create function update_where_var(p_id varchar, p_amount numeric) returns numeric language plpgsql as $$
declare v numeric;
begin
  update artist set fee = fee + p_amount where person_id = p_id returning fee into v;
  return v;
end $$;
select update_where_var((select min(person_id) from artist), 1000) = (select fee from artist order by person_id limit 1);
create function tg_outside() returns trigger language plpgsql as $$ begin return new; end $$;
select tg_outside();
drop function add1(int);
select add1(1);
create or replace function season(m int) returns text language plpgsql as $$ begin return 'replaced'; end $$;
select season(1);
create function dyn_query(n int) returns setof int language plpgsql as $$ begin return query execute 'select g from generate_series(1, $1) g' using n; end $$;
select * from dyn_query(4);
create function get_ctx() returns boolean language plpgsql as $$ declare c text; begin get diagnostics c = pg_context; return c like '%get_ctx%'; end $$;
select get_ctx();
create function with_query() returns bigint language plpgsql as $$
declare n bigint;
begin
  with d as (select company_id from company where budget > 50000) select count(*) into n from d;
  return n = (select count(*) from company where budget > 50000);
end $$;
select with_query();
create function setop_into() returns int language plpgsql as $$
declare n int;
begin
  select count(*) into n from (select person_id from person union select person_id from artist) u;
  return n = (select count(*) from (select person_id from person union select person_id from artist) x);
end $$;
select setop_into();
create function sum_fees() returns numeric language plpgsql as $$
declare total numeric := 0; r record;
begin
  for r in select * from artist loop
    total := total + r.fee;
  end loop;
  return total = (select sum(fee) from artist);
end $$;
select sum_fees();
create function exc_vars() returns text language plpgsql as $$
declare x int;
begin
  x := 10;
  begin
    x := 20;
    perform 1 / 0;
  exception when others then
    return 'x=' || x;
  end;
end $$;
select exc_vars();
create function exc_in_loop() returns int language plpgsql as $$
declare ok int := 0;
begin
  for i in -2..2 loop
    begin
      perform 10 / i;
      ok := ok + 1;
    exception when division_by_zero then null;
    end;
  end loop;
  return ok;
end $$;
select exc_in_loop();
create function while_select() returns int language plpgsql as $$
declare k int := 0;
begin
  while (select count(*) from log where msg = 'w') < 3 loop
    insert into log (msg) values ('w');
    k := k + 1;
  end loop;
  return k;
end $$;
select while_select(), while_select();
create function rec_assign() returns text language plpgsql as $$
declare r record; s artist%rowtype;
begin
  r := row(1, 'a');
  select * into s from artist order by person_id limit 1;
  s.fee := 1;
  return r::text || ' ' || s.fee;
end $$;
select rec_assign();
create function nested_fn_calls(n int) returns int language plpgsql as $$ begin return add_two(n) * 2; end $$;
create function add_two(n int) returns int language sql as 'select n + 2';
select nested_fn_calls(3);
create function exception_found() returns boolean language plpgsql as $$
begin
  perform 1;
  begin
    perform 1 / 0;
  exception when others then
    return found;
  end;
end $$;
select exception_found();
create function rq1() returns setof bigint language plpgsql as $$ begin return query select 1; end $$;
select * from rq1();
create function rq2() returns table (a varchar) language plpgsql as $$ begin return query select 'x'::text; end $$;
select * from rq2();
create function rq3() returns setof numeric language plpgsql as $$ begin return query select 1.5::float8; end $$;
select * from rq3();
create function into_few() returns text language plpgsql as $$ declare a int; b int; begin select 1 into a, b; return a || '/' || coalesce(b::text, 'null'); end $$;
select into_few();
create function into_many() returns text language plpgsql as $$ declare a int; begin select 1, 2 into a; return a; end $$;
select into_many();
create function rowvar_few() returns text language plpgsql as $$ declare r artist; begin select 'x', 'y' into r; return r::text; end $$;
select rowvar_few();
create function ret_rec() returns record language plpgsql as $$ begin return row(1, 'a'); end $$;
select ret_rec();
create function ret_int_from_text() returns int language plpgsql as $$ begin return '12'; end $$;
select ret_int_from_text();
create function ret_bool_int() returns int language plpgsql as $$ begin return true; end $$;
select ret_bool_int();
create function txt_to_date() returns date language plpgsql as $$ declare d date; begin d := '2024-01-05'; return d + 1; end $$;
select txt_to_date();
create function num_to_int() returns int language plpgsql as $$ declare i int; begin i := 2.5; return i; end $$;
select num_to_int();
create function int_overflow() returns int language plpgsql as $$ declare i int; begin i := 3000000000; return i; end $$;
select int_overflow();
create function ts_to_date() returns date language plpgsql as $$ declare d date; begin d := timestamp '2024-01-05 10:00'; return d; end $$;
select ts_to_date();
