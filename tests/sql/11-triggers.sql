-- Triggers: BEFORE and AFTER, row and statement level, NEW and OLD, WHEN, UPDATE OF, ordering by name, TG_*
-- variables, transition tables, INSTEAD OF triggers on views, errors raised by triggers.
create table audit (n serial primary key, op text, who text, old_fee numeric, new_fee numeric, tg text);
create function audit_fee() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    insert into audit (op, who, old_fee, tg) values (tg_op, old.billed_as, old.fee, tg_name || ' ' || tg_when || ' ' || tg_level || ' ' || tg_table_name);
    return old;
  elsif tg_op = 'UPDATE' then
    insert into audit (op, who, old_fee, new_fee, tg) values (tg_op, new.billed_as, old.fee, new.fee, tg_name);
  else
    insert into audit (op, who, new_fee, tg) values (tg_op, new.billed_as, new.fee, tg_name);
  end if;
  return new;
end $$;
insert into person values ('P7001', 'Ada', 'Quill', '1990-04-02', 'Northbay'), ('P7002', 'Ben', 'Marsh', null, null), ('P7003', 'Cy', 'Lark', null, null), ('P7004', 'Dee', 'Fox', null, null), ('P7005', 'Eli', 'Rook', null, 'Westmoor');
create trigger artist_audit after insert or update or delete on artist for each row execute function audit_fee();
insert into artist values ('P7001', 'C01', 'Ada Quill', 900), ('P7002', 'C01', 'Ben Marsh', 950);
update artist set fee = fee + 10 where person_id in ('P7001', 'P7002');
delete from artist where person_id = 'P7001';
select op, who, old_fee, new_fee, tg from audit order by n;
update artist set fee = fee where person_id = 'nobody';
select count(*) from audit;
create function cap_fee() returns trigger language plpgsql as $$
begin
  if new.fee > 1500 then new.fee := 1500; end if;
  new.billed_as := initcap(new.billed_as);
  return new;
end $$;
create trigger artist_cap before insert or update on artist for each row execute function cap_fee();
insert into artist values ('P7003', 'C01', 'cy lark', 999999) returning billed_as, fee;
select billed_as, fee from artist where person_id = 'P7003';
select who, new_fee from audit where who = 'Cy Lark';
update artist set fee = 2000 where person_id = 'P7002' returning fee;
create function no_freelance() returns trigger language plpgsql as $$
begin
  if new.company_id is null then return null; end if;
  return new;
end $$;
create trigger artist_no_freelance before insert on artist for each row execute function no_freelance();
insert into artist values ('P7004', null, 'Dee Fox', 500), ('P7005', 'C02', 'Eli Rook', 800);
select person_id, billed_as from artist where person_id in ('P7004', 'P7005') order by person_id;
create function keep_rows() returns trigger language plpgsql as $$ begin if old.company_id = 'C01' and old.person_id like 'P7%' then return null; end if; return old; end $$;
create trigger artist_keep before delete on artist for each row execute function keep_rows();
delete from artist where person_id in ('P7002', 'P7005');
select person_id from artist where person_id like 'P700%' order by person_id;
drop trigger artist_keep on artist;
drop trigger artist_no_freelance on artist;
drop trigger artist_cap on artist;
create table stmt_log (n serial primary key, what text);
create function log_stmt() returns trigger language plpgsql as $$
begin
  insert into stmt_log (what) values (tg_when || ' ' || tg_op || ' ' || tg_level || ' ' || coalesce(new::text, 'no new'));
  return null;
end $$;
create trigger company_stmt_before before update on company for each statement execute function log_stmt();
create trigger company_stmt_after after update on company for each statement execute function log_stmt();
update company set budget = budget * 1.1 where city = (select city from company order by company_id limit 1);
update company set budget = budget where company_id = 'None';
select what from stmt_log order by n;
create table ordered (id int primary key, trail text default '');
create function append_name() returns trigger language plpgsql as $$
begin
  new.trail := new.trail || tg_name || ';';
  return new;
end $$;
create trigger b_second before insert on ordered for each row execute function append_name();
create trigger a_first before insert on ordered for each row execute function append_name();
create trigger "C_upper" before insert on ordered for each row execute function append_name();
insert into ordered (id) values (1);
select trail from ordered;
create function argv_demo() returns trigger language plpgsql as $$
begin
  new.trail := tg_nargs || ':' || coalesce(tg_argv[0], '-') || ',' || coalesce(tg_argv[1], '-') || ',' || coalesce(tg_argv[2], '-');
  return new;
end $$;
drop trigger b_second on ordered;
drop trigger a_first on ordered;
drop trigger "C_upper" on ordered;
create trigger argv before insert on ordered for each row execute function argv_demo('x', 'y');
insert into ordered (id) values (2);
select trail from ordered where id = 2;
create table fee_changes (id varchar(6), old_fee numeric, new_fee numeric);
create function note_change() returns trigger language plpgsql as $$
begin
  insert into fee_changes values (new.person_id, old.fee, new.fee);
  return new;
end $$;
create trigger fee_changed after update on artist for each row when (old.fee is distinct from new.fee) execute function note_change();
update artist set fee = fee where company_id = 'C03';
update artist set fee = fee + 1 where company_id = 'C03';
select count(*) = (select count(*) from artist where company_id = 'C03'), count(*) > 0 from fee_changes;
create table name_changes (id varchar(6), old_name text, new_name text);
create function note_name() returns trigger language plpgsql as $$ begin insert into name_changes values (new.person_id, old.billed_as, new.billed_as); return new; end $$;
create trigger name_changed after update of billed_as on artist for each row execute function note_name();
update artist set fee = fee + 1 where company_id = 'C04';
select count(*) from name_changes;
update artist set billed_as = billed_as where company_id = 'C04';
select count(*) = (select count(*) from artist where company_id = 'C04') from name_changes;
create table budget_guard (company text, msg text);
create function guard_budget() returns trigger language plpgsql as $$
begin
  if new.budget < old.budget * 0.5 then
    raise exception 'budget of % cannot drop by half', new.name using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger budget_guard before update of budget on company for each row execute function guard_budget();
update company set budget = budget * 0.4 where company_id = 'C01';
update company set budget = budget * 0.9 where company_id = 'C01';
select count(*) from stmt_log where what like 'BEFORE UPDATE%';
create table counts (tbl text primary key, n int);
insert into counts values ('booking', (select count(*) from booking));
create function count_bookings() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then update counts set n = n + (select count(*) from new_rows) where tbl = 'booking';
  elsif tg_op = 'DELETE' then update counts set n = n - (select count(*) from old_rows) where tbl = 'booking';
  end if;
  return null;
end $$;
create trigger booking_ins after insert on booking referencing new table as new_rows for each statement execute function count_bookings();
create trigger booking_del after delete on booking referencing old table as old_rows for each statement execute function count_bookings();
insert into booking select (select max(booking_id) from booking) + row_number() over (order by p.patron_id), p.patron_id, f.perf_id, 1, f.price, null from patron p, (select perf_id, price from performance order by perf_id limit 1) f where p.city is null and not exists (select 1 from booking b where b.patron_id = p.patron_id and b.perf_id = f.perf_id);
select n = (select count(*) from booking) from counts;
delete from booking where rating is null;
select n = (select count(*) from booking) from counts;
create function show_transition() returns trigger language plpgsql as $$
declare s text;
begin
  select string_agg(o.name || '>' || n.name, ',' order by o.patron_id) into s from old_t o join new_t n on o.patron_id = n.patron_id;
  insert into stmt_log (what) values ('renamed ' || coalesce(s, 'none'));
  return null;
end $$;
create trigger patron_rename after update on patron referencing old table as old_t new table as new_t for each statement execute function show_transition();
update patron set name = upper(name) where city = (select min(city) from patron);
select what = 'renamed ' || (select string_agg(initcap(lower(name)) || '>' || name, ',' order by patron_id) from patron where city = (select min(city) from patron)) or what like 'renamed %' from stmt_log where what like 'renamed%';
create table tree (id int primary key, parent int, depth int);
create function tree_parent() returns trigger language plpgsql as $$
begin
  if new.parent is not null and not exists (select 1 from tree where id = new.parent) then
    insert into tree values (new.parent, case when new.parent > 1 then new.parent - 1 end, 0);
  end if;
  return new;
end $$;
create trigger tree_fill before insert on tree for each row execute function tree_parent();
insert into tree values (10, 9, 0);
select count(*), min(id), max(id) from tree;
create table runaway (id int);
create function runaway_fn() returns trigger language plpgsql as $$ begin insert into runaway values (new.id + 1); return new; end $$;
create trigger runaway_t after insert on runaway for each row execute function runaway_fn();
insert into runaway values (1);
select count(*) from runaway;
create function bad_return() returns trigger language plpgsql as $$ begin return row(1, 2); end $$;
create table small (a int, b int, c int);
create trigger bad_return before insert on small for each row execute function bad_return();
insert into small values (1, 2, 3);
drop trigger bad_return on small;
create function no_return_tg() returns trigger language plpgsql as $$ begin null; end $$;
create trigger no_return before insert on small for each row execute function no_return_tg();
insert into small values (1, 2, 3);
drop trigger no_return on small;
create function after_fails() returns trigger language plpgsql as $$ begin raise exception 'after trigger rejects %', new.a; end $$;
create trigger after_fails after insert on small for each row execute function after_fails();
insert into small values (5, 6, 7);
select count(*) from small;
alter table small disable trigger after_fails;
insert into small values (5, 6, 7);
alter table small enable trigger after_fails;
insert into small values (8, 9, 10);
select a, b, c from small;
create view company_view as select company_id, city from company;
create table view_log (op text, company text, city text);
create function company_view_dml() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    insert into company values (new.company_id, 'Troupe ' || new.company_id, new.city, null, 1000);
    insert into view_log values (tg_op, new.company_id, new.city);
    return new;
  elsif tg_op = 'UPDATE' then
    update company set city = new.city where company_id = old.company_id;
    insert into view_log values (tg_op, old.company_id, new.city);
    return new;
  else
    delete from company where company_id = old.company_id;
    insert into view_log values (tg_op, old.company_id, old.city);
    return old;
  end if;
end $$;
create trigger company_view_ins instead of insert on company_view for each row execute function company_view_dml();
create trigger company_view_upd instead of update on company_view for each row execute function company_view_dml();
create trigger company_view_del instead of delete on company_view for each row execute function company_view_dml();
insert into company_view values ('C50', 'Eastport'), ('C51', 'Westmoor');
update company_view set city = 'Southfield' where company_id = 'C50' returning company_id, city;
delete from company_view where company_id = 'C51';
select * from view_log order by op, company;
select company_id, name, city, budget from company where company_id in ('C50', 'C51');
create view production_view as select prod_id, title from production;
create function skip_all() returns trigger language plpgsql as $$ begin return null; end $$;
create trigger production_view_skip instead of update on production_view for each row execute function skip_all();
update production_view set title = 'x';
select count(*) from production where title = 'x';
create trigger bad_instead instead of insert on company for each row execute function skip_all();
insert into production_view values ('XX-1', 'none');
create function rows_seen() returns trigger language plpgsql as $$
begin
  new.trail := (select count(*) from ordered)::text;
  return new;
end $$;
drop trigger argv on ordered;
create trigger rows_seen before insert on ordered for each row execute function rows_seen();
insert into ordered (id) values (3), (4), (5);
select id, trail from ordered where id >= 3 order by id;
create function chain_a() returns trigger language plpgsql as $$ begin insert into stmt_log (what) values ('chain ' || new.op); return new; end $$;
create trigger audit_chain after insert on audit for each row execute function chain_a();
update artist set fee = fee + 2 where person_id = 'P7002';
select what from stmt_log where what like 'chain%' order by n;
drop function audit_fee();
drop trigger audit_chain on audit;
drop trigger artist_audit on artist;
update artist set fee = fee + 3 where person_id = 'P7002';
select count(*) from audit where op = 'UPDATE' and who = 'Ben Marsh';
create trigger missing_fn after insert on small for each row execute function nope();
create trigger dup_name after insert on small for each row execute function skip_all();
create trigger dup_name after insert on small for each row execute function skip_all();
create trigger on_nothing after insert on nosuchtable for each row execute function skip_all();
select tgname from (select trigger_name as tgname from information_schema.triggers where event_object_table = 'small') x order by 1;
create function upd_key() returns trigger language plpgsql as $$ begin new.id := new.id * 100; return new; end $$;
create trigger upd_key before update on ordered for each row execute function upd_key();
update ordered set trail = 'k' where id = 1;
select id, trail from ordered order by id;
create table parent_t (id int primary key);
create table child_t (id int, pid int references parent_t);
create function make_parent() returns trigger language plpgsql as $$ begin insert into parent_t values (new.pid) on conflict do nothing; return new; end $$;
create trigger make_parent before insert on child_t for each row execute function make_parent();
insert into child_t values (1, 100), (2, 100), (3, 200);
select count(*) from parent_t;
create function exc_in_trigger() returns trigger language plpgsql as $$
begin
  begin
    new.c := new.a / new.b;
  exception when division_by_zero then
    new.c := -1;
  end;
  return new;
end $$;
create trigger exc_tg before insert on small for each row execute function exc_in_trigger();
insert into small values (10, 0, null), (10, 5, null);
select a, b, c from small where a = 10 order by b;
-- INSERT ... ON CONFLICT and referential actions fire triggers too
create table kv (k int primary key, v text);
create table tlog (n serial, what text);
create function tl() returns trigger language plpgsql as $$ begin insert into tlog (what) values (tg_when || ' ' || tg_op || ' ' || tg_level || coalesce(' ' || new.k || '=' || new.v, '') || coalesce(' old ' || old.v, '')); if tg_level = 'ROW' and tg_when = 'BEFORE' and new.v = 'skip' then return null; end if; return new; end $$;
create trigger a1 before insert or update on kv for each row execute function tl();
create trigger a2 after insert or update on kv for each row execute function tl();
create trigger s1 before insert or update on kv for each statement execute function tl();
create trigger s2 after insert or update on kv for each statement execute function tl();
insert into kv values (1, 'a');
delete from tlog;
insert into kv values (1, 'b'), (2, 'c') on conflict (k) do update set v = excluded.v || '!';
select what from tlog order by n; -- ordered
delete from tlog;
insert into kv values (1, 'x') on conflict do nothing;
select what from tlog order by n; -- ordered
delete from tlog;
insert into kv values (5, 'skip'), (1, 'skip') on conflict (k) do update set v = 'never';
select what from tlog order by n; -- ordered
select * from kv order by k;
create table p_dept (name text primary key);
create table p_emp (id int primary key, dept text references p_dept on delete cascade on update cascade, boss text references p_dept on delete set null);
insert into p_dept values ('a'), ('b'), ('c');
insert into p_emp values (1, 'a', 'b'), (2, 'a', 'c'), (3, 'b', 'a'), (4, 'c', 'c');
create table elog (what text);
create function el() returns trigger language plpgsql as $$ begin insert into elog values (tg_when || ' ' || tg_op || ' ' || tg_level || coalesce(' ' || old.id, '') || coalesce(' -> ' || new.dept || '/' || coalesce(new.boss, 'null'), '')); if tg_op = 'DELETE' then return old; end if; return new; end $$;
create trigger e_row before update or delete on p_emp for each row execute function el();
create trigger e_row_after after update or delete on p_emp for each row execute function el();
delete from p_dept where name = 'a';
select what from elog order by what;
delete from elog;
update p_dept set name = 'bb' where name = 'b';
select what from elog order by what;
select * from p_emp order by id;
create table trunc_me (a int);
insert into trunc_me values (1), (2);
create table trunc_log (what text, n bigint);
create function on_truncate() returns trigger language plpgsql as $$ begin insert into trunc_log values (tg_when || ' ' || tg_op || ' ' || tg_level, (select count(*) from trunc_me)); return null; end $$;
create trigger trunc_b before truncate on trunc_me for each statement execute function on_truncate();
create trigger trunc_a after truncate on trunc_me for each statement execute function on_truncate();
truncate trunc_me;
select what, n from trunc_log order by what desc;
create trigger trunc_row before truncate on trunc_me for each row execute function on_truncate();
create table tt (a int, b int);
create view vv as select * from tt;
create function tf() returns trigger language plpgsql as $$ begin return new; end $$;
create function nf() returns int language sql as 'select 1';
create trigger x1 before truncate on tt for each row execute function tf();
create trigger x2 instead of insert on vv for each statement execute function tf();
create trigger x3 instead of insert on vv for each row when (new.a > 0) execute function tf();
create trigger x4 before insert on vv for each row execute function tf();
create trigger x5 after insert on tt for each statement when (new.a > 0) execute function tf();
create trigger x6 after insert on tt for each row when (old.a > 0) execute function tf();
create trigger x7 after delete on tt for each row when (new.a > 0) execute function tf();
create trigger x8 before insert on tt referencing new table as nt for each statement execute function tf();
create trigger x9 after insert on tt for each row execute function nf();
create trigger x10 after insert on tt referencing old table as ot for each statement execute function tf();
create trigger x11 after insert on vv for each statement execute function tf();
create trigger x12 before update of nosuch on tt for each row execute function tf();
create trigger x13 after insert or update on tt referencing new table as nt for each row execute function tf();
create trigger x14 after update of a on tt referencing new table as nt for each row execute function tf();
create trigger x15 before insert on tt for each row when (new.a > (select 1)) execute function tf();
