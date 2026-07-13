-- MERGE: matched and not matched clauses with conditions, NOT MATCHED BY SOURCE, DO NOTHING, defaults,
-- RETURNING with merge_action(), the cardinality error, triggers, and errors.
create table stock (item text primary key, qty int not null check (qty >= 0), updated int default 0);
insert into stock values ('apple', 10, 0), ('pear', 5, 0), ('plum', 0, 0), ('fig', 3, 0);
create table delivery (item text, qty int);
insert into delivery values ('apple', 5), ('kiwi', 7), ('plum', 2), ('fig', -3);
merge into stock s using delivery d on s.item = d.item
when matched and s.qty + d.qty = 0 then delete
when matched then update set qty = s.qty + d.qty, updated = s.updated + 1
when not matched then insert (item, qty) values (d.item, d.qty);
select * from stock order by item;
merge into stock s using delivery d on s.item = d.item
when not matched by source then update set updated = -1
when matched then do nothing;
select * from stock order by item;
merge into stock s using delivery d on s.item = d.item
when not matched by source and s.updated = -1 then delete;
select item from stock order by item;
merge into stock as s using (values ('apple', 100), ('mango', 1)) as v(item, qty) on s.item = v.item
when matched then update set qty = v.qty
when not matched by target then insert values (v.item, v.qty, 9)
returning merge_action(), s.item, s.qty, s.updated, v.qty as source_qty;
merge into stock s using (select 'apple' as item) src on s.item = src.item
when matched then delete
returning merge_action() as action, s.*;
select * from stock order by item;
merge into stock s using delivery d on s.item = d.item
when not matched then insert default values;
merge into stock s using (values ('grape', 4)) v(item, qty) on s.item = v.item
when not matched then insert (qty, item) values (v.qty, v.item);
select * from stock where item = 'grape';
merge into stock s using (values ('grape', 1), ('grape', 2)) v(item, qty) on s.item = v.item
when matched then update set qty = s.qty + v.qty;
select qty from stock where item = 'grape';
merge into stock s using (values ('grape', 1), ('grape', 2)) v(item, qty) on s.item = v.item
when matched and v.qty = 1 then update set qty = s.qty + v.qty
when matched then do nothing;
select qty from stock where item = 'grape';
merge into stock s using (values ('grape', 1), ('grape', 2)) v(item, qty) on s.item = v.item
when matched then delete;
merge into stock s using (values ('kiwi', -100)) v(item, qty) on s.item = v.item
when matched then update set qty = s.qty + v.qty;
merge into stock s using (values ('new1', null::int)) v(item, qty) on s.item = v.item
when not matched then insert values (v.item, v.qty);
merge into stock s using (values ('kiwi', 1), ('kiwi', 2)) v(item, qty) on s.item = v.item
when not matched then insert values (v.item, v.qty);
merge into stock s using (values ('dup1', 1), ('dup1', 2)) v(item, qty) on s.item = v.item
when not matched then insert values (v.item, v.qty);
select count(*) from stock where item = 'dup1';
merge into stock s using (values ('x', 1)) v(item, qty) on s.item = v.item
when not matched then insert values (s.item, v.qty);
merge into stock s using (values ('x', 1)) v(item, qty) on s.item = v.item
when not matched by source then update set qty = v.qty;
merge into stock s using (values ('x', 1)) v(item, qty) on s.item = v.item
when matched then update set nosuch = 1;
merge into nosuch s using (values ('x', 1)) v(item, qty) on s.item = v.item when matched then delete;
merge into stock s using nosuch v on s.item = v.item when matched then delete;
create view stock_view as select * from stock;
merge into stock_view s using delivery d on s.item = d.item when matched then delete;
merge into stock s using (values ('fig', 1)) v(item, qty) on s.item = v.item
when matched then update set qty = default;
select merge_action();
create table budget_changes (company_id varchar(5), delta numeric);
insert into budget_changes values ('C01', 1000), ('C02', -500), ('C90', 25000);
merge into company c using budget_changes b on c.company_id = b.company_id
when matched then update set budget = c.budget + b.delta
when not matched then insert values (b.company_id, 'New Company ' || b.company_id, 'Lakeside', 2025, b.delta);
select company_id, name, city from company where company_id in ('C01', 'C02', 'C90') order by 1;
select delta = (select budget from company where company_id = 'C90') from budget_changes where company_id = 'C90';
merge into artist a using (select person_id, company_id from artist where company_id = 'C03') b on a.person_id = b.person_id
when matched then update set fee = a.fee * 1.05;
select count(*) from artist where company_id = 'C03';
merge into production p using (values ('ZZ100', 'C99')) v(prod_id, comp) on p.prod_id = v.prod_id
when not matched then insert values (v.prod_id, 'Ghost show', v.comp, 'drama', null, 60, null);
merge into booking b using patron p on b.patron_id = p.patron_id and p.city = (select min(city) from patron)
when matched and b.rating is null then update set rating = 3;
select count(*) from booking where rating is null and patron_id in (select patron_id from patron where city = (select min(city) from patron));
create table merge_log (n serial primary key, what text);
create function merge_tg() returns trigger language plpgsql as $$
begin
  insert into merge_log (what) values (tg_when || ' ' || tg_op || ' ' || tg_level || coalesce(' ' || new.item, '') || coalesce(' ' || old.item, ''));
  if tg_level = 'ROW' and tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger m_bs before insert or update or delete on stock for each statement execute function merge_tg();
create trigger m_as after insert or update or delete on stock for each statement execute function merge_tg();
create trigger m_br before insert or update or delete on stock for each row execute function merge_tg();
create trigger m_ar after insert or update or delete on stock for each row execute function merge_tg();
merge into stock s using (values ('pear', 1), ('lime', 2), ('fig', 0)) v(item, qty) on s.item = v.item
when matched and v.qty = 0 then delete
when matched then update set qty = s.qty + v.qty
when not matched then insert values (v.item, v.qty);
select what from merge_log order by n;
delete from merge_log;
merge into stock s using (values ('nothing', 1)) v(item, qty) on s.item = v.item
when matched then update set qty = 1;
select what from merge_log order by n;
create function skip_lime() returns trigger language plpgsql as $$ begin if new.item = 'lime' then return null; end if; return new; end $$;
create trigger m_skip before update on stock for each row execute function skip_lime();
merge into stock s using (values ('lime', 50), ('pear', 50)) v(item, qty) on s.item = v.item
when matched then update set qty = v.qty
returning s.item, s.qty;
select item, qty from stock where item in ('lime', 'pear') order by item;
drop trigger m_bs on stock;
drop trigger m_as on stock;
drop trigger m_br on stock;
drop trigger m_ar on stock;
drop trigger m_skip on stock;
create table target_ids (id int primary key, val text);
insert into target_ids select g, 'v' || g from generate_series(1, 10) g;
merge into target_ids t using generate_series(5, 15) as g(id) on t.id = g.id
when matched and t.id % 2 = 0 then update set val = val || '!'
when matched then delete
when not matched then insert values (g.id, 'new')
when not matched by source and t.id < 3 then delete;
select * from target_ids order by id;
merge into target_ids t using (select 100 as id) s on false
when not matched then insert values (s.id, 'on false');
select val from target_ids where id = 100;
merge into target_ids t using (select 1 as id) s on true
when matched then update set val = 'all';
select count(*) from target_ids where val = 'all';
begin;
merge into target_ids t using (select 1 as x) s on true when matched then delete;
select count(*) from target_ids;
rollback;
select count(*) from target_ids;
create function merge_fn(p_id int, p_val text) returns text language plpgsql as $$
declare act text;
begin
  merge into target_ids t using (select p_id as id, p_val as val) s on t.id = s.id
  when matched then update set val = s.val
  when not matched then insert values (s.id, s.val)
  returning merge_action() into act;
  return act;
end $$;
select merge_fn(1000, 'a'), merge_fn(1000, 'b');
select val from target_ids where id = 1000;
create view cheap as select item, qty from stock where qty < 10;
merge into cheap c using (values ('grape', 2), ('pear', 1), ('zzz', 3)) v(item, qty) on c.item = v.item
when matched then update set qty = c.qty + v.qty
when not matched then insert values (v.item, v.qty);
select item, qty from stock where item in ('grape', 'pear', 'zzz') order by item;
merge into cheap c using (values ('grape')) v(item) on c.item = v.item when matched then delete;
select count(*) from stock where item = 'grape';
create view agg_view as select item, count(*) as n from stock group by item;
merge into agg_view a using (values ('x')) v(item) on a.item = v.item when matched then delete;
