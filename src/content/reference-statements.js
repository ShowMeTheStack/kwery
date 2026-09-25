// The SQL statements of the Reference pane: syntax, what each does, a runnable example on the Theatre database.
// An example that changes data or the schema undoes itself (BEGIN ... ROLLBACK, or it drops what it made), so it
// can be run any number of times.
(function (root) {
  'use strict';
  const K = root.K;
  const C = K.Content = K.Content || {};
  const R = C.reference = C.reference || { statements: [], types: [], glossary: [], settings: [], functions: {}, functionGroups: {}, operators: {}, operatorList: [], functionExamples: {} };

  R.statements.push(
    // ---- queries ---------------------------------------------------------------------------------------------------
    {
      id: 'select', name: 'SELECT', group: 'Queries',
      syntax: `SELECT [ ALL | DISTINCT [ ON ( expr, ... ) ] ]
  { * | table.* | expr [ [ AS ] alias ] }, ...
  [ FROM from_item, ... ]
  [ WHERE condition ]
  [ GROUP BY [ ALL | DISTINCT ] grouping_element, ... ]
  [ HAVING condition ]
  [ WINDOW name AS ( window_spec ), ... ]
  [ { UNION | INTERSECT | EXCEPT } [ ALL | DISTINCT ] select ]
  [ ORDER BY expr [ ASC | DESC ] [ NULLS { FIRST | LAST } ], ... ]
  [ LIMIT { count | ALL } ] [ OFFSET start [ ROW | ROWS ] ]
  [ FETCH { FIRST | NEXT } [ count ] { ROW | ROWS } { ONLY | WITH TIES } ]
  [ FOR { UPDATE | NO KEY UPDATE | SHARE | KEY SHARE } [ OF table, ... ] [ NOWAIT | SKIP LOCKED ] ]`,
      about: 'Reads rows. The clauses run in a fixed logical order: `FROM` builds the input (a product of its items and joins), `WHERE` keeps the rows whose condition is true, `GROUP BY` forms groups, `HAVING` keeps groups, the select list computes the output columns, `DISTINCT` removes duplicates, then `ORDER BY` sorts and `LIMIT`/`OFFSET` cut the result. A column alias of the select list can be used in `ORDER BY` but not in `WHERE`, because `WHERE` runs first. Without `ORDER BY` the order of the rows is not defined.',
      example: `select genre, count(*) as productions, avg(runtime_min)::numeric(6,1) as avg_runtime
from production
where runtime_min > 60
group by genre
having count(*) >= 2
order by avg_runtime desc;`,
      pg: 'Follows PostgreSQL: `DISTINCT ON`, `FETCH ... WITH TIES`, `GROUP BY DISTINCT`, output-column names and positions in `ORDER BY` and `GROUP BY`, and a `SELECT` without `FROM` all work as in PostgreSQL 17.',
      see: [{ lesson: 'sql-select' }, { lesson: 'sql-aggregates' }, { view: 'plan', label: 'See the plan' }, { ref: 'statement:joins' }],
      keywords: 'query where distinct projection selection',
    },
    {
      id: 'joins', name: 'FROM and JOIN', group: 'Queries',
      syntax: `from_item:
  table [ * ] [ [ AS ] alias [ ( column, ... ) ] ]
      [ TABLESAMPLE { BERNOULLI | SYSTEM } ( percent ) [ REPEATABLE ( seed ) ] ]
  [ LATERAL ] ( select ) [ AS ] alias [ ( column, ... ) ]
  [ LATERAL ] function ( args ) [ WITH ORDINALITY ] [ [ AS ] alias [ ( column [ type ], ... ) ] ]
  [ LATERAL ] ROWS FROM ( function ( args ), ... ) [ WITH ORDINALITY ] [ alias ]
  from_item [ NATURAL ] { [ INNER ] | LEFT [ OUTER ] | RIGHT [ OUTER ] | FULL [ OUTER ] } JOIN from_item
      [ ON condition | USING ( column, ... ) [ AS alias ] ]
  from_item CROSS JOIN from_item
  ( from_item ) [ AS alias ]`,
      about: 'The `FROM` clause names the inputs of a query. A comma between items is a Cartesian product, usually narrowed by `WHERE`. An inner join keeps the pairs of rows that satisfy `ON`; `USING` and `NATURAL` join on equal column names and show each such column once. Outer joins also keep the rows that found no partner, padded with nulls: `LEFT` keeps the left side, `RIGHT` the right side, `FULL` both. `LATERAL` lets a subquery or function refer to columns of the items before it.',
      example: `select p.given_name || ' ' || p.family_name as artist, c.name as company, a.fee
from artist a
  join person p on p.person_id = a.person_id
  left join company c on c.company_id = a.company_id
order by c.name nulls first, artist
limit 8;`,
      pg: 'As in PostgreSQL, including `JOIN ... USING (...) AS alias`, `LATERAL`, `ROWS FROM` and `WITH ORDINALITY`. The planner chooses among nested loop, block nested loop, indexed nested loop, hash and merge joins; `SET force_join` can pin one for a lesson.',
      see: [{ lesson: 'int-joins' }, { lesson: 'int-outer' }, { lesson: 'sql-multi' }, { view: 'plan', label: 'Watch the join run' }],
      keywords: 'inner outer left right full natural cross lateral tablesample product',
    },
    {
      id: 'with', name: 'WITH (common table expressions)', group: 'Queries',
      syntax: `WITH [ RECURSIVE ] name [ ( column, ... ) ] AS [ [ NOT ] MATERIALIZED ]
    ( select | insert ... RETURNING | update ... RETURNING | delete ... RETURNING )
    [ SEARCH { DEPTH | BREADTH } FIRST BY column, ... SET column ]
    [ CYCLE column, ... SET column [ TO value DEFAULT value ] USING column ], ...
  statement`,
      about: 'Names a query so the main statement can use it like a table. A plain `WITH` query is a convenience for writing a big query in steps. `WITH RECURSIVE` lets a query refer to itself: the part before `UNION` is the starting set, the part after it is run again and again on the rows found by the previous round until a round adds nothing. That computes transitive closures, such as every earlier production a production is adapted from, however far back. `SEARCH` adds an ordering column (depth-first or breadth-first) and `CYCLE` marks and stops cycles.',
      example: `with recursive lineage(prod_id, source_id, depth) as (
  select prod_id, based_on, 1 from production where based_on is not null
  union
  select l.prod_id, p.based_on, l.depth + 1
  from lineage l join production p on p.prod_id = l.source_id
  where p.based_on is not null
)
select l.prod_id, s.title as source, l.depth
from lineage l join production s on s.prod_id = l.source_id
order by l.depth desc, l.prod_id
limit 10;`,
      pg: 'As in PostgreSQL 17, with `SEARCH`, `CYCLE`, `MATERIALIZED` hints and data-changing statements inside `WITH`. A recursive query stops with an error after `max_recursion` rounds (10000 by default); PostgreSQL has no such limit.',
      see: [{ lesson: 'sql-subq-more' }, { view: 'plan', label: 'Step through the recursion' }],
      keywords: 'cte recursive transitive closure hierarchy',
    },
    {
      id: 'setops', name: 'UNION, INTERSECT, EXCEPT', group: 'Queries',
      syntax: `select { UNION | INTERSECT | EXCEPT } [ ALL | DISTINCT ] select
  [ ORDER BY ... ] [ LIMIT ... ]`,
      about: 'Combines the results of two queries with the same number of columns and compatible types. `UNION` gives the rows of either, `INTERSECT` the rows of both, `EXCEPT` the rows of the first that are not in the second. Without `ALL` duplicates are removed; with `ALL` the counts are kept as in bag algebra (`INTERSECT ALL` keeps the smaller count, `EXCEPT ALL` subtracts). `INTERSECT` binds tighter than `UNION` and `EXCEPT`; a trailing `ORDER BY` or `LIMIT` applies to the whole result.',
      example: `select patron_id from booking
except
select patron_id from booking where rating is not null
order by patron_id;`,
      pg: 'As in PostgreSQL. The column names come from the first query.',
      see: [{ lesson: 'sql-setops' }, { lesson: 'rel-algebra-basic' }],
      keywords: 'union intersect except minus difference bag',
    },
    {
      id: 'values', name: 'VALUES', group: 'Queries',
      syntax: `VALUES ( expr, ... ), ...
  [ ORDER BY ... ] [ LIMIT ... ]`,
      about: 'A constant table written inline. Each parenthesised list is one row; all rows need the same number of columns. The columns are named `column1`, `column2` and so on, and can be renamed with an alias when `VALUES` is used in `FROM`.',
      example: `select v.stars, v.label
from (values (5, 'superb'), (3, 'fair'), (1, 'poor')) as v(stars, label)
order by v.stars desc;`,
      pg: 'As in PostgreSQL.',
      see: [{ ref: 'statement:insert' }],
      keywords: 'constant table literal rows',
    },
    {
      id: 'table', name: 'TABLE', group: 'Queries',
      syntax: 'TABLE name',
      about: 'Short for `SELECT * FROM name`. It can stand wherever a query can, for example in a set operation.',
      example: 'table venue;',
      pg: 'As in PostgreSQL.',
      see: [{ ref: 'statement:select' }],
    },
    {
      id: 'group-by', name: 'GROUP BY, ROLLUP, CUBE, GROUPING SETS', group: 'Queries',
      syntax: `GROUP BY [ ALL | DISTINCT ] grouping_element, ...
grouping_element:
  expr
  ( )
  ROLLUP ( expr, ... )
  CUBE ( expr, ... )
  GROUPING SETS ( grouping_element, ... )`,
      about: 'Groups the rows that agree on the grouping expressions; aggregates in the select list and `HAVING` then compute one value per group. `GROUPING SETS` runs several groupings in one query and stacks the results, with nulls in the columns a grouping leaves out. `ROLLUP (a, b)` is the sets (a, b), (a) and (); `CUBE (a, b)` is every subset. `GROUPING(col)` returns 1 in the rows where `col` was rolled up, which tells such a null apart from a real one.',
      example: `select v.city, s.kind, count(*) as stages, sum(s.seats) as seats
from stage s join venue v using (venue_code)
group by rollup (v.city, s.kind)
order by v.city nulls last, s.kind nulls last
limit 10;`,
      pg: 'As in PostgreSQL 17, including `GROUP BY DISTINCT` and the `GROUPING` function.',
      see: [{ lesson: 'sql-aggregates' }],
      keywords: 'aggregate olap rollup cube grouping sets having',
    },
    {
      id: 'window', name: 'Window functions and WINDOW', group: 'Queries',
      syntax: `function ( args ) OVER { name | ( window_spec ) }
window_spec:
  [ existing_name ] [ PARTITION BY expr, ... ] [ ORDER BY expr [ ASC | DESC ], ... ]
  [ { ROWS | RANGE | GROUPS } { start | BETWEEN start AND end }
    [ EXCLUDE { CURRENT ROW | GROUP | TIES | NO OTHERS } ] ]
start, end:
  UNBOUNDED PRECEDING | n PRECEDING | CURRENT ROW | n FOLLOWING | UNBOUNDED FOLLOWING
SELECT ... WINDOW name AS ( window_spec ), ...`,
      about: 'A window function computes a value for each row from a set of related rows, its *window*, without collapsing them as `GROUP BY` does. `PARTITION BY` splits the rows into independent parts, `ORDER BY` orders each part, and the frame clause picks which rows around the current one count. Ranking functions (`row_number`, `rank`, `dense_rank`, `ntile`), offsets (`lag`, `lead`, `first_value`) and any aggregate can be used this way. The `WINDOW` clause names a window once for several functions.',
      example: `select title, genre, runtime_min,
  rank() over w as rank_in_genre,
  round(runtime_min - avg(runtime_min) over (partition by genre), 1) as above_avg
from production
where genre in ('drama', 'comedy') and runtime_min is not null
window w as (partition by genre order by runtime_min desc)
order by genre, rank_in_genre;`,
      pg: 'As in PostgreSQL 17, with `ROWS`, `RANGE` and `GROUPS` frames, `EXCLUDE` and `FILTER (WHERE ...)` on aggregates.',
      see: [{ ref: 'statement:select' }],
      keywords: 'over partition rank row_number lag lead frame analytic',
    },
    {
      id: 'order-limit', name: 'ORDER BY, LIMIT, OFFSET, FETCH', group: 'Queries',
      syntax: `ORDER BY expr [ ASC | DESC | USING { < | > } ] [ NULLS { FIRST | LAST } ], ...
LIMIT { count | ALL }
OFFSET start [ ROW | ROWS ]
FETCH { FIRST | NEXT } [ count ] { ROW | ROWS } { ONLY | WITH TIES }`,
      about: 'Sorts the result and keeps a slice of it. Nulls sort as larger than every value: last when ascending, first when descending, unless `NULLS FIRST` or `NULLS LAST` says otherwise. `OFFSET` skips rows, `LIMIT` or `FETCH FIRST` keeps at most a count of them. `WITH TIES` also keeps the rows that tie with the last one kept. Without `ORDER BY`, which rows a `LIMIT` keeps is not defined.',
      example: `select title, runtime_min
from production
order by runtime_min desc nulls last
fetch first 3 rows with ties;`,
      pg: 'As in PostgreSQL. A sort that does not fit in `work_mem_pages` pages becomes an external merge sort, which the plan view can show pass by pass.',
      see: [{ lesson: 'sql-strings-order' }, { view: 'plan', label: 'See the sort in the plan' }],
      keywords: 'sort top-n paging nulls first last',
    },
    {
      id: 'select-for-update', name: 'SELECT ... FOR UPDATE', group: 'Queries',
      syntax: `select ... FOR { UPDATE | NO KEY UPDATE | SHARE | KEY SHARE }
  [ OF table, ... ] [ NOWAIT | SKIP LOCKED ] [ ... ]`,
      about: 'Locks the rows a query returns, so that other transactions cannot change them (or, with `FOR UPDATE`, lock them too) until this transaction ends. It is how a transaction reads a row it means to change without letting another transaction change it in between. `NOWAIT` fails at once instead of waiting; `SKIP LOCKED` leaves out rows another transaction holds.',
      example: `begin;
select person_id, billed_as, fee from artist where company_id = 'C01' for update;
update artist set fee = fee * 1.02 where company_id = 'C01';
rollback;`,
      pg: 'The four row-lock strengths, `OF`, `NOWAIT` and `SKIP LOCKED` behave as in PostgreSQL. Open a second tab to see the other session wait.',
      see: [{ lesson: 'int-transactions' }, { view: 'txn', label: 'Open the transactions view' }],
      keywords: 'row lock pessimistic share nowait skip locked',
    },
    {
      id: 'select-into', name: 'SELECT INTO', group: 'Queries',
      syntax: `SELECT targets INTO [ TEMPORARY | TEMP ] [ UNLOGGED ] [ TABLE ] new_table
  [ FROM ... ] [ WHERE ... ] ...`,
      about: 'Makes a new table from the result of a query. It does the same as `CREATE TABLE ... AS`, which is the clearer form. Inside a PL/pgSQL function `SELECT ... INTO` means something else: it stores a row in variables.',
      example: `select patron_id, name, points into temp loyal from patron where points >= 100;
select count(*) from loyal;
drop table loyal;`,
      pg: 'As in PostgreSQL.',
      see: [{ ref: 'statement:create-table-as' }],
    },

    // ---- changing data -----------------------------------------------------------------------------------------------
    {
      id: 'insert', name: 'INSERT', group: 'Changing data',
      syntax: `INSERT INTO table [ AS alias ] [ ( column, ... ) ]
  [ OVERRIDING { SYSTEM | USER } VALUE ]
  { DEFAULT VALUES | VALUES ( { expr | DEFAULT }, ... ), ... | query }
  [ ON CONFLICT [ ( column | ( expr ), ... ) [ WHERE condition ] | ON CONSTRAINT name ]
    DO { NOTHING | UPDATE SET column = expr, ... [ WHERE condition ] } ]
  [ RETURNING { * | expr [ [ AS ] alias ] }, ... ]`,
      about: 'Adds rows to a table, from a list of values or from a query. Columns left out get their default (or null). Every constraint is checked: a duplicate key, a null in a `NOT NULL` column, a failed `CHECK` or a missing referenced row stops the statement and none of its rows stay. `ON CONFLICT` turns a duplicate key into a choice: skip the row, or update the existing one, where `excluded` names the row that was proposed. `RETURNING` hands back the rows as stored, with defaults filled in.',
      example: `begin;
insert into venue values ('KWY', 'Kwery Playhouse', 'Lakeport', 1998)
returning *;
insert into venue values ('KWY', 'Kwery Playhouse', 'Lakeport', 2001)
on conflict (venue_code) do update set opened = excluded.opened
returning venue_code, venue_name, opened;
rollback;`,
      pg: 'As in PostgreSQL, including `ON CONFLICT` with a conflict target, `ON CONSTRAINT`, `excluded`, and `OVERRIDING` for identity columns.',
      see: [{ lesson: 'sql-modify' }, { view: 'storage', label: 'See the tuple land on a page' }, { ref: 'statement:merge' }],
      keywords: 'add row upsert on conflict returning',
    },
    {
      id: 'update', name: 'UPDATE', group: 'Changing data',
      syntax: `UPDATE [ ONLY ] table [ [ AS ] alias ]
  SET { column = { expr | DEFAULT }
      | column.field = expr | column[ i ] = expr
      | ( column, ... ) = [ ROW ] ( expr, ... )
      | ( column, ... ) = ( select ) }, ...
  [ FROM from_item, ... ]
  [ WHERE condition | WHERE CURRENT OF cursor ]
  [ RETURNING { * | expr [ [ AS ] alias ] }, ... ]`,
      about: 'Changes columns of the rows that satisfy `WHERE`; without `WHERE` it changes every row. The right-hand sides see the old row, so `SET a = b, b = a` swaps two columns. `FROM` joins other tables in, so the new values and the condition can use them. Kwery, like PostgreSQL, stores an update as a new version of the row and marks the old one as replaced; the old version stays until vacuum removes it.',
      example: `begin;
update production
set runtime_min = runtime_min + 10
where genre = 'opera'
returning prod_id, title, runtime_min;
rollback;`,
      pg: 'As in PostgreSQL, including `UPDATE ... FROM` and multi-column assignment from a subquery.',
      see: [{ lesson: 'sql-modify' }, { view: 'storage', label: 'See the old and new versions' }],
      keywords: 'modify change set',
    },
    {
      id: 'delete', name: 'DELETE', group: 'Changing data',
      syntax: `DELETE FROM [ ONLY ] table [ [ AS ] alias ]
  [ USING from_item, ... ]
  [ WHERE condition | WHERE CURRENT OF cursor ]
  [ RETURNING { * | expr [ [ AS ] alias ] }, ... ]`,
      about: 'Removes the rows that satisfy `WHERE`; without `WHERE` it removes every row. `USING` joins other tables in for the condition. Foreign keys that point at a deleted row act as declared: the delete fails (`NO ACTION`, `RESTRICT`), the referencing rows go too (`CASCADE`), or their columns become null or the default.',
      example: `begin;
delete from booking
where rating = 1
returning booking_id, patron_id, perf_id;
rollback;`,
      pg: 'As in PostgreSQL. A deleted row stays on its page, marked by the deleting transaction, until vacuum reclaims it.',
      see: [{ lesson: 'sql-modify' }, { lesson: 'int-fk' }, { ref: 'statement:truncate' }],
      keywords: 'remove rows cascade',
    },
    {
      id: 'merge', name: 'MERGE', group: 'Changing data',
      syntax: `MERGE INTO table [ [ AS ] alias ]
  USING source [ [ AS ] alias ] ON condition
  WHEN MATCHED [ AND condition ] THEN { UPDATE SET column = expr, ... | DELETE | DO NOTHING }
  WHEN NOT MATCHED [ BY TARGET ] [ AND condition ] THEN
    { INSERT [ ( column, ... ) ] { VALUES ( expr, ... ) | DEFAULT VALUES } | DO NOTHING }
  WHEN NOT MATCHED BY SOURCE [ AND condition ] THEN { UPDATE SET ... | DELETE | DO NOTHING }
  ...
  [ RETURNING { * | expr [ [ AS ] alias ] }, ... ]`,
      about: 'Applies a set of changes from a source to a target table in one statement. Each source row is joined to the target with `ON`; the first `WHEN` clause whose case and condition fit decides what happens: update or delete the matched target row, or insert a new one when nothing matched. `NOT MATCHED BY SOURCE` acts on target rows no source row matched. A target row matched by two source rows is an error.',
      example: `begin;
merge into venue v
using (values ('KWY', 'Kwery Playhouse', 'Lakeport', 1998), ('RIV', 'Riverlight Playhouse', 'Brightwater', 1975))
  as n(venue_code, venue_name, city, opened)
on v.venue_code = n.venue_code
when matched then update set opened = n.opened
when not matched then insert values (n.venue_code, n.venue_name, n.city, n.opened)
returning merge_action(), v.*;
rollback;`,
      pg: 'Follows PostgreSQL 17, including `NOT MATCHED BY SOURCE`, `RETURNING` and `merge_action()`.',
      see: [{ ref: 'statement:insert' }, { ref: 'statement:update' }],
      keywords: 'upsert synchronize matched',
    },
    {
      id: 'truncate', name: 'TRUNCATE', group: 'Changing data',
      syntax: `TRUNCATE [ TABLE ] [ ONLY ] table, ...
  [ RESTART IDENTITY | CONTINUE IDENTITY ] [ CASCADE | RESTRICT ]`,
      about: 'Empties tables at once, by giving each a new empty file instead of deleting row by row. It takes an exclusive lock on the table. A table that other tables reference by foreign key can only be truncated together with them, or with `CASCADE`. `RESTART IDENTITY` resets the sequences of identity columns. Inside a transaction it can be rolled back.',
      example: `begin;
truncate booking;
select count(*) from booking;
rollback;`,
      pg: 'As in PostgreSQL.',
      see: [{ ref: 'statement:delete' }],
      keywords: 'empty table',
    },

    // ---- tables and constraints ------------------------------------------------------------------------------------------
    {
      id: 'create-table', name: 'CREATE TABLE', group: 'Tables and constraints',
      syntax: `CREATE [ TEMPORARY | TEMP ] [ UNLOGGED ] TABLE [ IF NOT EXISTS ] name (
    column type [ COLLATE c ] [ column_constraint ... ]
  | table_constraint
  | LIKE source [ { INCLUDING | EXCLUDING } what ... ], ...
)
  [ INHERITS ( parent, ... ) ]
  [ ON COMMIT { PRESERVE ROWS | DELETE ROWS | DROP } ]
column_constraint:
  [ CONSTRAINT name ] { NOT NULL | NULL | PRIMARY KEY | UNIQUE [ NULLS [ NOT ] DISTINCT ]
  | CHECK ( condition ) | DEFAULT expr
  | REFERENCES table [ ( column ) ] [ MATCH { FULL | SIMPLE } ]
      [ ON DELETE action ] [ ON UPDATE action ]
  | GENERATED ALWAYS AS ( expr ) STORED
  | GENERATED { ALWAYS | BY DEFAULT } AS IDENTITY [ ( sequence_options ) ] }
  [ [ NOT ] DEFERRABLE ] [ INITIALLY { DEFERRED | IMMEDIATE } ]
table_constraint:
  [ CONSTRAINT name ] { PRIMARY KEY ( column, ... ) | UNIQUE ( column, ... )
  | CHECK ( condition )
  | FOREIGN KEY ( column, ... ) REFERENCES table [ ( column, ... ) ] [ ... ]
  | EXCLUDE [ USING method ] ( expr WITH operator, ... ) [ WHERE ( condition ) ] }
action: NO ACTION | RESTRICT | CASCADE | SET NULL | SET DEFAULT`,
      about: 'Defines a new table: its columns with their types, defaults and constraints. A **primary key** is unique and not null and gets a B+ tree index. `UNIQUE` also builds an index. A **foreign key** makes every non-null value of its columns appear in the referenced key, and says what happens to the referencing rows when the referenced row is deleted or its key changes. `CHECK` rejects rows whose condition is false (a null result passes). Identity and generated columns fill themselves in.',
      example: `create table tour_plan (
  prod_id varchar(6) primary key references production on delete cascade,
  max_weeks int not null check (max_weeks > 0),
  cities int default 1,
  noted timestamp default now()
);
insert into tour_plan (prod_id, max_weeks) select min(prod_id), 6 from production;
select * from tour_plan;
drop table tour_plan;`,
      pg: 'Follows PostgreSQL 17 for the column and table constraints, `LIKE`, identity and stored generated columns, deferrable constraints and temporary tables. `MATCH PARTIAL` is accepted but behaves as `SIMPLE`; storage parameters in `WITH ( ... )` are ignored. `PARTITION BY` is accepted and ignored, and `PARTITION OF` is refused: partitioning is taught in the cluster view, across nodes.',
      see: [{ lesson: 'sql-ddl' }, { lesson: 'int-constraints' }, { lesson: 'int-fk' }, { view: 'erd', label: 'See the schema diagram' }],
      keywords: 'ddl define table column constraint primary foreign key check unique default identity generated',
    },
    {
      id: 'create-table-as', name: 'CREATE TABLE AS', group: 'Tables and constraints',
      syntax: `CREATE [ TEMPORARY | TEMP ] [ UNLOGGED ] TABLE [ IF NOT EXISTS ] name [ ( column, ... ) ]
  AS query [ WITH [ NO ] DATA ]`,
      about: 'Makes a new table with the columns and rows of a query. The new table copies only the column names and types: no constraints, defaults or indexes come along. `WITH NO DATA` makes the empty table only.',
      example: `create temp table genre_totals as
select genre, count(*) as n, sum(runtime_min) as minutes
from production group by genre;
select * from genre_totals order by minutes desc nulls last limit 5;
drop table genre_totals;`,
      pg: 'As in PostgreSQL.',
      see: [{ ref: 'statement:create-table' }, { ref: 'statement:select-into' }],
    },
    {
      id: 'alter-table', name: 'ALTER TABLE', group: 'Tables and constraints',
      syntax: `ALTER TABLE [ IF EXISTS ] [ ONLY ] name action, ...
ALTER TABLE name RENAME [ COLUMN ] column TO new_name
ALTER TABLE name RENAME CONSTRAINT c TO new_name
ALTER TABLE name RENAME TO new_name
ALTER TABLE name SET SCHEMA schema
action:
  ADD [ COLUMN ] [ IF NOT EXISTS ] column type [ column_constraint ... ]
  ADD table_constraint [ NOT VALID ]
  DROP [ COLUMN ] [ IF EXISTS ] column [ CASCADE | RESTRICT ]
  DROP CONSTRAINT [ IF EXISTS ] name [ CASCADE | RESTRICT ]
  ALTER [ COLUMN ] column [ SET DATA ] TYPE type [ USING expr ]
  ALTER [ COLUMN ] column { SET DEFAULT expr | DROP DEFAULT }
  ALTER [ COLUMN ] column { SET NOT NULL | DROP NOT NULL }
  ALTER [ COLUMN ] column ADD GENERATED { ALWAYS | BY DEFAULT } AS IDENTITY
  ALTER [ COLUMN ] column DROP IDENTITY [ IF EXISTS ]
  VALIDATE CONSTRAINT name
  { ENABLE | DISABLE } TRIGGER { name | ALL | USER }`,
      about: 'Changes the definition of a table. Adding a constraint checks the rows already there, unless `NOT VALID` defers that check to a later `VALIDATE CONSTRAINT`. Changing a column type rewrites every row through the cast or the `USING` expression. Dropping a column hides it; the space it took comes back as rows are rewritten.',
      example: `begin;
alter table patron add column email varchar(60);
update patron set email = lower(replace(name, ' ', '.')) || '@mail.example' where city is not null;
alter table patron add constraint email_has_at check (email like '%@%');
select patron_id, name, email from patron where email is not null limit 5;
rollback;`,
      pg: 'Follows PostgreSQL for the actions listed. `OWNER TO`, `SET STATISTICS`, `SET STORAGE`, `SET (options)` and `CLUSTER ON` are accepted and do nothing; `ATTACH PARTITION` and `DETACH PARTITION` are refused.',
      see: [{ lesson: 'sql-ddl' }, { lesson: 'int-constraints' }],
      keywords: 'add column drop column rename constraint change type',
    },
    {
      id: 'drop', name: 'DROP', group: 'Tables and constraints',
      syntax: `DROP { TABLE | VIEW | MATERIALIZED VIEW | INDEX | SEQUENCE | SCHEMA | TYPE | DOMAIN
     | FUNCTION | PROCEDURE | ROLE | USER | GROUP | EXTENSION | ASSERTION }
  [ CONCURRENTLY ] [ IF EXISTS ] name [ ( arg_type, ... ) ], ... [ CASCADE | RESTRICT ]
DROP TRIGGER [ IF EXISTS ] name ON table [ CASCADE | RESTRICT ]`,
      about: 'Removes objects from the catalog. An object that others depend on (a table under a view, a type used by a column, a key a foreign key references) cannot be dropped alone: `CASCADE` drops the dependent objects too, `RESTRICT` (the default) refuses. `IF EXISTS` turns a missing object into a notice instead of an error. Inside a transaction a drop can be rolled back.',
      example: `create view opera_titles as select title from production where genre = 'opera';
create table scratch (n int);
drop table scratch;
drop view if exists opera_titles, no_such_view;`,
      pg: 'As in PostgreSQL. `DROP OWNED BY` is accepted and does nothing; `DROP DATABASE` does not exist because Kwery has one database.',
      see: [{ ref: 'statement:create-table' }],
      keywords: 'remove delete object cascade restrict if exists',
    },
    {
      id: 'create-assertion', name: 'CREATE ASSERTION', group: 'Tables and constraints',
      syntax: 'CREATE ASSERTION name CHECK ( condition )',
      about: 'States a condition over the whole database that must always hold, such as a rule that spans several tables. Kwery checks it after every statement that touches a table the condition reads, and rejects a statement that makes it false. Assertions are part of the SQL standard but few systems have them, because checking them cheaply is hard; Kwery has them so the idea can be tried.',
      example: `begin;
create assertion budget_positive check (
  not exists (select * from company where budget <= 0)
);
update company set budget = budget - 1000 where company_id = 'C01';
select company_id, budget from company where company_id = 'C01';
rollback;`,
      pg: 'PostgreSQL 17 does not implement `CREATE ASSERTION` and reports it as not yet implemented. In PostgreSQL the same rule needs triggers.',
      see: [{ lesson: 'int-constraints' }, { ref: 'statement:create-trigger' }],
      keywords: 'integrity constraint database-wide',
    },
    {
      id: 'comment', name: 'COMMENT ON', group: 'Tables and constraints',
      syntax: `COMMENT ON { TABLE | COLUMN | VIEW | INDEX | SEQUENCE | SCHEMA | TYPE | FUNCTION | ... }
  name IS { 'text' | NULL }`,
      about: 'Stores a description with an object in the catalog. `\\d+` and the schema panel show it. `NULL` removes the comment.',
      example: `begin;
comment on table booking is 'One row per patron per performance booked, with a rating if one was given';
comment on column booking.rating is 'From 1 to 5 stars; null when the patron did not rate';
rollback;`,
      pg: 'As in PostgreSQL.',
    },

    // ---- indexes ---------------------------------------------------------------------------------------------------------
    {
      id: 'create-index', name: 'CREATE INDEX', group: 'Indexes',
      syntax: `CREATE [ UNIQUE ] INDEX [ CONCURRENTLY ] [ IF NOT EXISTS ] [ name ] ON [ ONLY ] table
  [ USING { btree | hash | bitmap | lsm | rtree | gist | gin | brin } ]
  ( { column | ( expr ) } [ COLLATE c ] [ opclass ] [ ASC | DESC ] [ NULLS { FIRST | LAST } ], ... )
  [ INCLUDE ( column, ... ) ]
  [ NULLS [ NOT ] DISTINCT ]
  [ WITH ( option = value, ... ) ]
  [ WHERE condition ]`,
      about: 'Builds an index: a second structure that finds rows by the values of some columns without reading the whole table. The default B+ tree keeps the keys sorted, so it serves equality, ranges and `ORDER BY`. A hash index serves equality only. `UNIQUE` also enforces that no two rows share a key. `INCLUDE` stores extra columns in the leaves so a query can be answered from the index alone; a `WHERE` clause makes a partial index over some rows only; an expression index indexes a computed value. The planner decides per query whether an index helps.',
      example: `create index booking_rating_idx on booking (rating) where rating is not null;
explain select booking_id, perf_id from booking where rating = 5;
drop index booking_rating_idx;`,
      pg: 'B+ tree and hash indexes behave as in PostgreSQL. `bitmap` (a bitmap index on a low-cardinality column), `lsm` (a log-structured merge tree) and `rtree` (a spatial R-tree) are Kwery\'s own teaching methods; `gist`, `gin` and `brin` are accepted names for the closest of them.',
      see: [{ lesson: 'int-indexes' }, { view: 'index', label: 'Draw the index' }, { view: 'indexlab', label: 'Try the index playground' }],
      keywords: 'b+ tree btree hash bitmap lsm rtree unique partial covering expression',
    },
    {
      id: 'alter-index', name: 'ALTER INDEX', group: 'Indexes',
      syntax: 'ALTER INDEX [ IF EXISTS ] name RENAME TO new_name',
      about: 'Renames an index. Indexes are otherwise changed by dropping and creating them again.',
      example: `create index perf_date_idx on performance (perf_date);
alter index perf_date_idx rename to performance_by_date_idx;
drop index performance_by_date_idx;`,
      pg: 'Kwery supports only `RENAME TO`; PostgreSQL also has `SET TABLESPACE`, `SET (options)` and `ATTACH PARTITION`.',
      see: [{ ref: 'statement:create-index' }],
    },

    // ---- views ---------------------------------------------------------------------------------------------------------------
    {
      id: 'create-view', name: 'CREATE VIEW', group: 'Views',
      syntax: `CREATE [ OR REPLACE ] [ TEMPORARY | TEMP ] [ RECURSIVE ] VIEW name [ ( column, ... ) ]
  AS query
  [ WITH [ CASCADED | LOCAL ] CHECK OPTION ]`,
      about: 'Names a query. A view stores no rows: each query that uses it runs the view\'s query in its place. A simple view over one table, without aggregates, `DISTINCT` or set operations, can be updated; the change goes to the base table. `WITH CHECK OPTION` rejects a change through the view that would produce a row the view does not show.',
      example: `create view billing as select person_id, billed_as, company_id from artist;
select * from billing where company_id is null;
drop view billing;`,
      pg: 'As in PostgreSQL, including automatically updatable views and `CHECK OPTION`.',
      see: [{ lesson: 'int-views' }, { ref: 'statement:create-materialized-view' }],
      keywords: 'virtual relation updatable view check option',
    },
    {
      id: 'create-materialized-view', name: 'CREATE MATERIALIZED VIEW', group: 'Views',
      syntax: `CREATE MATERIALIZED VIEW [ IF NOT EXISTS ] name [ ( column, ... ) ]
  AS query
  [ WITH [ NO ] DATA ]`,
      about: 'Runs a query and stores its result as a table. Reads are as fast as reading a table, but the stored rows go stale when the base tables change: `REFRESH MATERIALIZED VIEW` runs the query again. A materialized view can carry indexes.',
      example: `create materialized view company_reach as
select company_id, count(*) as productions from production group by company_id;
select * from company_reach order by productions desc, company_id limit 3;
drop materialized view company_reach;`,
      pg: 'As in PostgreSQL. The stored rows are not kept up to date by themselves, as there.',
      see: [{ lesson: 'int-views' }, { ref: 'statement:refresh' }],
      keywords: 'materialized precomputed cached view',
    },
    {
      id: 'refresh', name: 'REFRESH MATERIALIZED VIEW', group: 'Views',
      syntax: 'REFRESH MATERIALIZED VIEW [ CONCURRENTLY ] name [ WITH [ NO ] DATA ]',
      about: 'Replaces the stored rows of a materialized view with a fresh run of its query.',
      example: `create materialized view n_venues as select count(*) as n from venue;
begin;
insert into venue values ('KWY', 'Kwery Playhouse', 'Lakeport', 1998);
refresh materialized view n_venues;
select n from n_venues;
rollback;
drop materialized view n_venues;`,
      pg: 'As in PostgreSQL. `CONCURRENTLY` is accepted.',
      see: [{ ref: 'statement:create-materialized-view' }],
    },
    {
      id: 'alter-view', name: 'ALTER VIEW', group: 'Views',
      syntax: `ALTER [ MATERIALIZED ] VIEW [ IF EXISTS ] name RENAME TO new_name
ALTER [ MATERIALIZED ] VIEW [ IF EXISTS ] name RENAME COLUMN column TO new_name`,
      about: 'Renames a view or one of its columns. To change a view\'s query use `CREATE OR REPLACE VIEW`.',
      example: `create view v1 as select patron_id, name from patron;
alter view v1 rename column name to patron_name;
alter view v1 rename to patron_names;
select * from patron_names limit 3;
drop view patron_names;`,
      pg: 'Kwery supports the renames only.',
      see: [{ ref: 'statement:create-view' }],
    },

    // ---- schemas, types and sequences ---------------------------------------------------------------------------------------
    {
      id: 'create-schema', name: 'CREATE SCHEMA', group: 'Schemas, types and sequences',
      syntax: `CREATE SCHEMA [ IF NOT EXISTS ] name [ AUTHORIZATION role ]
ALTER SCHEMA name RENAME TO new_name`,
      about: 'Makes a namespace for tables, views, types and functions. A name is looked up in the schemas of `search_path` in order, so `public` objects need no prefix; any object can be named in full as `schema.name`.',
      example: `create schema archive;
create table archive.old_bookings as
  select b.* from booking b join performance p using (perf_id) where p.perf_date < date '2025-07-01';
select count(*) from archive.old_bookings;
drop schema archive cascade;`,
      pg: 'As in PostgreSQL. Kwery has one database, so a schema is the largest grouping.',
      see: [{ lesson: 'int-types' }, { ref: 'statement:set' }],
      keywords: 'namespace search_path',
    },
    {
      id: 'create-type', name: 'CREATE TYPE', group: 'Schemas, types and sequences',
      syntax: `CREATE TYPE name AS ENUM ( 'label', ... )
CREATE TYPE name AS ( field type, ... )
CREATE TYPE name AS RANGE ( SUBTYPE = type [ , ... ] )`,
      about: 'Defines a new data type. An **enum** is an ordered list of labels: values compare in the order they were declared. A **composite** type is a record of named fields, usable as a column type or a function result; a field is read with `(value).field`. A **range** type holds an interval of its subtype, with operators for containment and overlap.',
      example: `create type verdict as enum ('poor', 'fair', 'good', 'great', 'superb');
select v, v > 'good'::verdict as better_than_good
from unnest(array['superb', 'good', 'poor']::verdict[]) as v
order by v;
drop type verdict;`,
      pg: 'Enum, composite and range types follow PostgreSQL. Base types written in C cannot be defined.',
      see: [{ lesson: 'int-types' }, { ref: 'statement:alter-type' }],
      keywords: 'enum composite range user-defined type',
    },
    {
      id: 'alter-type', name: 'ALTER TYPE', group: 'Schemas, types and sequences',
      syntax: `ALTER TYPE name ADD VALUE [ IF NOT EXISTS ] 'label' [ { BEFORE | AFTER } 'existing' ]
ALTER TYPE name RENAME VALUE 'label' TO 'new_label'
ALTER TYPE name ADD ATTRIBUTE field type
ALTER TYPE name RENAME TO new_name`,
      about: 'Changes a user-defined type: adds or renames an enum label, adds a field to a composite type, or renames the type.',
      example: `create type showtime as enum ('matinee', 'evening');
alter type showtime add value 'late' after 'evening';
alter type showtime add value 'twilight' before 'evening';
select t from unnest(array['late', 'matinee', 'twilight', 'evening']::showtime[]) as t order by t;
drop type showtime;`,
      pg: 'As in PostgreSQL for these forms.',
      see: [{ ref: 'statement:create-type' }],
    },
    {
      id: 'create-domain', name: 'CREATE DOMAIN', group: 'Schemas, types and sequences',
      syntax: `CREATE DOMAIN name [ AS ] base_type
  [ DEFAULT expr ] [ [ NOT ] NULL ]
  [ [ CONSTRAINT c ] CHECK ( condition ) ] ...
ALTER DOMAIN name { SET DEFAULT expr | DROP DEFAULT | SET NOT NULL | DROP NOT NULL
  | ADD [ CONSTRAINT c ] CHECK ( condition ) | DROP CONSTRAINT c }`,
      about: 'Defines a type that is a base type plus rules: a default, `NOT NULL`, and checks that refer to the value as `VALUE`. Every column of the domain type obeys the rules, so a rule is written once instead of on each column.',
      example: `begin;
create domain star_rating as smallint
  check (value between 1 and 5);
select 4::star_rating as ok;
rollback;`,
      pg: 'As in PostgreSQL.',
      see: [{ lesson: 'int-types' }],
      keywords: 'domain constraint type check value',
    },
    {
      id: 'create-sequence', name: 'CREATE SEQUENCE', group: 'Schemas, types and sequences',
      syntax: `CREATE [ TEMPORARY | TEMP ] SEQUENCE [ IF NOT EXISTS ] name
  [ AS type ] [ INCREMENT [ BY ] n ]
  [ MINVALUE n | NO MINVALUE ] [ MAXVALUE n | NO MAXVALUE ]
  [ START [ WITH ] n ] [ CACHE n ] [ [ NO ] CYCLE ]
  [ OWNED BY { table.column | NONE } ]
ALTER SEQUENCE [ IF EXISTS ] name [ options ] [ RESTART [ [ WITH ] n ] ]
ALTER SEQUENCE name RENAME TO new_name`,
      about: 'Makes a counter that hands out numbers with `nextval`. A number once handed out is never given again, even if the transaction that took it rolls back, so sequences leave gaps; that is the price of never making two transactions wait for each other. Identity and `serial` columns use a sequence behind the scenes.',
      example: `create sequence ticket start 100 increment 10;
select nextval('ticket'), nextval('ticket'), currval('ticket');
alter sequence ticket restart with 1;
select nextval('ticket');
drop sequence ticket;`,
      pg: 'As in PostgreSQL, with `nextval`, `currval`, `setval` and `lastval`.',
      see: [{ lesson: 'int-types' }],
      keywords: 'serial identity counter nextval autoincrement',
    },

    // ---- functions, procedures and triggers ---------------------------------------------------------------------------------------
    {
      id: 'create-function', name: 'CREATE FUNCTION', group: 'Functions, procedures and triggers',
      syntax: `CREATE [ OR REPLACE ] FUNCTION name ( [ [ IN | OUT | INOUT | VARIADIC ] [ arg ] type
    [ DEFAULT expr ], ... ] )
  [ RETURNS type | RETURNS SETOF type | RETURNS TABLE ( column type, ... ) ]
  { LANGUAGE { sql | plpgsql }
  | IMMUTABLE | STABLE | VOLATILE
  | STRICT | CALLED ON NULL INPUT
  | SECURITY { INVOKER | DEFINER }
  | SET setting { TO | = } value
  | AS 'body'
  | RETURN expr
  | BEGIN ATOMIC statements END } ...`,
      about: 'Defines a function that queries can call. A `sql` function runs its statements and returns the result of the last one; a `plpgsql` function is a procedural block with variables, `IF`, loops, `RETURN` and exception handlers. `RETURNS SETOF` or `RETURNS TABLE` make a set-returning function that can be used in `FROM`. `IMMUTABLE`, `STABLE` and `VOLATILE` tell the planner how much it may assume about repeated calls. A body in the SQL/PSM style of the standard (`BEGIN ... END` with `DECLARE`, `SET` and `WHILE`) is also accepted.',
      example: `create function production_count(c varchar) returns bigint language sql stable as $$
  select count(*) from production where company_id = c
$$;
select name, production_count(company_id) from company order by 2 desc, 1 limit 4;
drop function production_count(varchar);`,
      pg: 'Follows PostgreSQL for `sql` and `plpgsql` functions, overloading by argument types, defaults and named arguments. Other languages (C, Python) are not available. SQL/PSM bodies, from the SQL standard, are a Kwery addition.',
      see: [{ ref: 'statement:create-procedure' }, { ref: 'statement:do' }, { ref: 'statement:create-trigger' }],
      keywords: 'function plpgsql psm stored routine returns table setof',
    },
    {
      id: 'create-procedure', name: 'CREATE PROCEDURE', group: 'Functions, procedures and triggers',
      syntax: `CREATE [ OR REPLACE ] PROCEDURE name ( [ [ IN | OUT | INOUT ] [ arg ] type [ DEFAULT expr ], ... ] )
  { LANGUAGE { sql | plpgsql } | SECURITY { INVOKER | DEFINER } | AS 'body' | BEGIN ATOMIC ... END } ...
ALTER { FUNCTION | PROCEDURE } name [ ( type, ... ) ] RENAME TO new_name`,
      about: 'Defines a procedure: a routine run with `CALL` rather than inside a query. It returns no value (only `INOUT` parameters). Unlike a function, a procedure called outside a transaction block may `COMMIT` or `ROLLBACK` in its body, ending one transaction and starting the next.',
      example: `create procedure raise_fees(c varchar, pct numeric) language plpgsql as $$
begin
  update artist set fee = fee * (1 + pct / 100) where company_id = c;
end $$;
begin;
call raise_fees('C01', 3);
select billed_as, fee from artist where company_id = 'C01';
rollback;
drop procedure raise_fees;`,
      pg: 'As in PostgreSQL.',
      see: [{ ref: 'statement:call' }, { ref: 'statement:create-function' }],
      keywords: 'procedure stored call',
    },
    {
      id: 'call', name: 'CALL', group: 'Functions, procedures and triggers',
      syntax: 'CALL name ( [ arg | name => arg, ... ] )',
      about: 'Runs a procedure. Arguments go by position or by name with `=>`. `INOUT` parameters come back as a result row.',
      example: `create procedure add_one(inout n int) language plpgsql as $$ begin n := n + 1; end $$;
call add_one(41);
drop procedure add_one;`,
      pg: 'As in PostgreSQL.',
      see: [{ ref: 'statement:create-procedure' }],
    },
    {
      id: 'do', name: 'DO', group: 'Functions, procedures and triggers',
      syntax: 'DO [ LANGUAGE plpgsql ] \'body\'',
      about: 'Runs an anonymous PL/pgSQL block once, without storing a function. Useful for a loop or a conditional in a script. `RAISE NOTICE` shows a message under the result.',
      example: `do $$
declare n int;
begin
  select count(*) into n from patron where points >= 100;
  raise notice '% patrons have at least 100 points', n;
end $$;`,
      pg: 'As in PostgreSQL for PL/pgSQL.',
      see: [{ ref: 'statement:create-function' }],
      keywords: 'anonymous block plpgsql raise notice',
    },
    {
      id: 'create-trigger', name: 'CREATE TRIGGER', group: 'Functions, procedures and triggers',
      syntax: `CREATE [ OR REPLACE ] [ CONSTRAINT ] TRIGGER name
  { BEFORE | AFTER | INSTEAD OF } { INSERT | UPDATE [ OF column, ... ] | DELETE | TRUNCATE } [ OR ... ]
  ON table
  [ [ NOT ] DEFERRABLE ] [ INITIALLY { DEFERRED | IMMEDIATE } ]
  [ REFERENCING { OLD | NEW } TABLE [ AS ] name ... ]
  [ FOR [ EACH ] { ROW | STATEMENT } ]
  [ WHEN ( condition ) ]
  EXECUTE { FUNCTION | PROCEDURE } function ( [ args ] )
ALTER TRIGGER name ON table RENAME TO new_name`,
      about: 'Runs a function automatically when rows of a table change. A row trigger runs once per row and sees the row as `OLD` and `NEW`; a `BEFORE` row trigger can change `NEW` or return null to skip the row. A statement trigger runs once per statement and can see all changed rows through transition tables. `INSTEAD OF` triggers make a view updatable. `WHEN` limits the trigger to rows that satisfy a condition.',
      example: `create function reward_rating() returns trigger language plpgsql as $$
begin
  if new.rating is not null and old.rating is null then
    update patron set points = points + 5 where patron_id = new.patron_id;
  end if;
  return new;
end $$;
create trigger rating_reward after update of rating on booking
  for each row execute function reward_rating();
begin;
update booking set rating = 4
where booking_id = (select min(booking_id) from booking where rating is null)
returning patron_id;
rollback;
drop trigger rating_reward on booking;
drop function reward_rating();`,
      pg: 'As in PostgreSQL 17, including transition tables, `WHEN`, constraint triggers and `INSTEAD OF` on views.',
      see: [{ ref: 'statement:create-function' }, { ref: 'statement:create-assertion' }],
      keywords: 'trigger event action before after instead of row statement',
    },

    // ---- transactions --------------------------------------------------------------------------------------------------------
    {
      id: 'begin', name: 'BEGIN / START TRANSACTION', group: 'Transactions',
      syntax: `BEGIN [ WORK | TRANSACTION ] [ mode, ... ]
START TRANSACTION [ mode, ... ]
mode:
  ISOLATION LEVEL { SERIALIZABLE | REPEATABLE READ | READ COMMITTED | READ UNCOMMITTED }
  READ WRITE | READ ONLY
  [ NOT ] DEFERRABLE`,
      about: 'Starts a transaction block: the statements up to `COMMIT` or `ROLLBACK` take effect together or not at all. Without `BEGIN` each statement is its own transaction (autocommit). The isolation level sets which anomalies other transactions can cause: under **read committed** each statement sees the data committed before it started; under **repeatable read** the whole transaction sees one snapshot; **serializable** also guarantees that the outcome equals some serial order, failing a transaction when it cannot.',
      example: `begin isolation level repeatable read;
select count(*) from booking;
select count(*) from booking where rating is null;
commit;`,
      pg: 'As in PostgreSQL: read uncommitted behaves as read committed, and serializable uses serializable snapshot isolation. With `SET concurrency_control` a classic protocol (two-phase locking, timestamp ordering, validation) can replace multiversion concurrency control.',
      see: [{ lesson: 'int-transactions' }, { view: 'txn', label: 'Open the transactions view' }, { ref: 'statement:commit' }],
      keywords: 'transaction atomic isolation level serializable snapshot',
    },
    {
      id: 'commit', name: 'COMMIT', group: 'Transactions',
      syntax: `COMMIT [ WORK | TRANSACTION ] [ AND [ NO ] CHAIN ]
END [ WORK | TRANSACTION ]`,
      about: 'Ends the transaction and makes its changes permanent and visible to others. The commit is durable once its log record reaches stable storage; the changed pages themselves may be written later, since recovery can redo them from the log. In a transaction that already failed, `COMMIT` rolls back. `AND CHAIN` starts a new transaction with the same modes at once.',
      example: `begin;
select sum(budget) from company;
commit;`,
      pg: 'As in PostgreSQL.',
      see: [{ lesson: 'int-transactions' }, { view: 'log', label: 'See the commit record in the log' }],
      keywords: 'durable end transaction',
    },
    {
      id: 'rollback', name: 'ROLLBACK', group: 'Transactions',
      syntax: `ROLLBACK [ WORK | TRANSACTION ] [ AND [ NO ] CHAIN ]
ABORT [ WORK | TRANSACTION ]`,
      about: 'Ends the transaction and undoes all its changes. Kwery, like PostgreSQL, marks the transaction aborted in the commit log, so its row versions become invisible at once; with `SET rollback_undo = on` it instead undoes each change on the pages and writes compensation log records, as log-based recovery in the style of ARIES does.',
      example: `begin;
delete from mentor;
select count(*) as left_inside from mentor;
rollback;
select count(*) as after_rollback from mentor;`,
      pg: 'As in PostgreSQL. `rollback_undo` is a Kwery setting for teaching recovery.',
      see: [{ lesson: 'int-transactions' }, { view: 'recovery', label: 'See undo during recovery' }],
      keywords: 'abort undo cancel',
    },
    {
      id: 'savepoint', name: 'SAVEPOINT, ROLLBACK TO, RELEASE', group: 'Transactions',
      syntax: `SAVEPOINT name
ROLLBACK [ WORK | TRANSACTION ] TO [ SAVEPOINT ] name
RELEASE [ SAVEPOINT ] name`,
      about: 'A savepoint marks a point inside a transaction. `ROLLBACK TO` undoes what happened after it and keeps the transaction going, also after an error. `RELEASE` forgets the savepoint and keeps its changes. Each savepoint is a subtransaction with its own transaction id once it writes.',
      example: `begin;
update company set budget = budget + 1000 where company_id = 'C01';
savepoint before_delete;
delete from mentor;
rollback to before_delete;
select count(*) as mentor_pairs from mentor;
select company_id, budget from company where company_id = 'C01';
rollback;`,
      pg: 'As in PostgreSQL.',
      see: [{ ref: 'statement:begin' }],
      keywords: 'subtransaction partial rollback nested',
    },
    {
      id: 'set-transaction', name: 'SET TRANSACTION', group: 'Transactions',
      syntax: `SET TRANSACTION mode, ...
SET SESSION CHARACTERISTICS AS TRANSACTION mode, ...
mode: ISOLATION LEVEL level | READ WRITE | READ ONLY | [ NOT ] DEFERRABLE`,
      about: 'Sets the isolation level or access mode of the current transaction, before its first query. The `SESSION CHARACTERISTICS` form sets the default for later transactions of the session. A read-only transaction may not change tables.',
      example: `begin;
set transaction isolation level serializable, read only;
show transaction_isolation;
commit;`,
      pg: 'As in PostgreSQL.',
      see: [{ ref: 'statement:begin' }],
    },
    {
      id: 'set-constraints', name: 'SET CONSTRAINTS', group: 'Transactions',
      syntax: 'SET CONSTRAINTS { ALL | name, ... } { DEFERRED | IMMEDIATE }',
      about: 'Chooses when deferrable constraints are checked in this transaction: after each statement (`IMMEDIATE`) or at commit (`DEFERRED`). Deferring lets a transaction pass through states that break a constraint, such as inserting two rows that reference each other, as long as all is well at the end.',
      example: `create table a (id int primary key, b_id int);
create table b (id int primary key, a_id int references a deferrable initially deferred);
alter table a add foreign key (b_id) references b deferrable initially deferred;
begin;
insert into a values (1, 1);
insert into b values (1, 1);
set constraints all immediate;
commit;
drop table b, a cascade;`,
      pg: 'As in PostgreSQL.',
      see: [{ lesson: 'int-fk' }],
      keywords: 'deferrable deferred immediate',
    },
    {
      id: 'lock', name: 'LOCK', group: 'Transactions',
      syntax: `LOCK [ TABLE ] [ ONLY ] name, ... [ IN mode MODE ] [ NOWAIT ]
mode: ACCESS SHARE | ROW SHARE | ROW EXCLUSIVE | SHARE UPDATE EXCLUSIVE | SHARE
    | SHARE ROW EXCLUSIVE | EXCLUSIVE | ACCESS EXCLUSIVE`,
      about: 'Takes a table lock explicitly, held until the transaction ends. The eight modes conflict as a table: for example `SHARE` lets others read but blocks writers, and `ACCESS EXCLUSIVE` (the default) blocks everything, even reads. It is only allowed inside a transaction block.',
      example: `begin;
lock table venue in share mode;
select count(*) from venue;
commit;`,
      pg: 'As in PostgreSQL. Under one of Kwery\'s locking protocols (`SET concurrency_control`), the lock manager also shows intention locks on the database and tables.',
      see: [{ view: 'txn', label: 'See the locks' }, { ref: 'statement:select-for-update' }],
      keywords: 'table lock mode exclusive share',
    },
    {
      id: 'prepare-transaction', name: 'PREPARE TRANSACTION', group: 'Transactions',
      syntax: `PREPARE TRANSACTION 'gid'
COMMIT PREPARED 'gid'
ROLLBACK PREPARED 'gid'`,
      about: 'The first phase of two-phase commit. `PREPARE TRANSACTION` writes everything the transaction needs to commit to the log and detaches it from the session: it can no longer fail on its own, and it keeps its locks. A coordinator later decides with `COMMIT PREPARED` or `ROLLBACK PREPARED`, from any session.',
      example: `begin;
update company set budget = budget + 1 where company_id = 'C01';
prepare transaction 'raise-c01';
rollback prepared 'raise-c01';`,
      pg: 'As in PostgreSQL, where it also needs `max_prepared_transactions` above zero.',
      see: [{ view: 'cluster', label: 'Two-phase commit across nodes' }],
      keywords: '2pc two-phase commit distributed coordinator',
    },

    // ---- settings and sessions --------------------------------------------------------------------------------------------
    {
      id: 'set', name: 'SET', group: 'Settings and sessions',
      syntax: `SET [ SESSION | LOCAL ] setting { TO | = } { value | 'value' | DEFAULT }
SET TIME ZONE { 'zone' | LOCAL | DEFAULT }`,
      about: 'Changes a setting for this session (one editor tab), or with `LOCAL` until the end of the current transaction. Settings switch planner methods on and off, choose the isolation level and concurrency control protocol, the buffer and log policies, the time zone and more; `SHOW ALL` lists them.',
      example: `set enable_hashjoin = off;
explain select * from patron join booking using (patron_id);
reset enable_hashjoin;`,
      pg: 'As in PostgreSQL. Kwery adds teaching settings such as `concurrency_control`, `buffer_steal`, `buffer_force`, `wal_rule` and `force_join`.',
      see: [{ ref: 'statement:show' }, { view: 'plan', label: 'Compare the plans' }],
      keywords: 'configuration parameter setting guc',
    },
    {
      id: 'show', name: 'SHOW', group: 'Settings and sessions',
      syntax: 'SHOW { setting | ALL }',
      about: 'Shows the current value of a setting, or of all settings with `ALL`.',
      example: 'show all;',
      pg: 'As in PostgreSQL; `current_setting(name)` gives the same value inside a query.',
      see: [{ ref: 'statement:set' }],
    },
    {
      id: 'reset', name: 'RESET', group: 'Settings and sessions',
      syntax: 'RESET { setting | ALL }',
      about: 'Puts a setting back to its default value for the session.',
      example: `set work_mem_pages = 4;
show work_mem_pages;
reset work_mem_pages;
show work_mem_pages;`,
      pg: 'As in PostgreSQL.',
      see: [{ ref: 'statement:set' }],
    },
    {
      id: 'set-role', name: 'SET ROLE', group: 'Settings and sessions',
      syntax: `SET ROLE { role | NONE }
SET SESSION AUTHORIZATION { role | DEFAULT }`,
      about: 'Acts as another role for the rest of the session, so privileges are checked as that role. `SET ROLE NONE` goes back to the session\'s own user.',
      example: `create role reader;
grant select on venue to reader;
set role reader;
select count(*) from venue;
set role none;
revoke select on venue from reader;
drop role reader;`,
      pg: 'Kwery lets any session switch to any role, which makes privilege lessons easy to try; PostgreSQL requires membership in the role.',
      see: [{ lesson: 'int-auth' }, { ref: 'statement:grant' }],
    },
    {
      id: 'discard', name: 'DISCARD', group: 'Settings and sessions',
      syntax: 'DISCARD { PLANS | TEMP | SEQUENCES }',
      about: 'Clears session state. `DISCARD ALL` resets the session: its settings, role, prepared statements, cursors and sequence state. `DISCARD SEQUENCES` forgets the values `currval` and `lastval` remember; `PLANS` and `TEMP` are accepted.',
      example: `prepare q as select 1;
discard all;
prepare q as select 2;
execute q;
deallocate q;`,
      pg: 'As in PostgreSQL, except that `DISCARD TEMP` keeps temporary tables and `DISCARD PLANS` has nothing to clear, since Kwery plans each statement afresh.',
    },
    {
      id: 'listen', name: 'LISTEN, NOTIFY, UNLISTEN', group: 'Settings and sessions',
      syntax: `LISTEN channel
NOTIFY channel
UNLISTEN { channel | * }`,
      about: 'Accepted so that scripts written for PostgreSQL run, but they do nothing: Kwery has no client connections to deliver notifications to.',
      example: 'listen bookings_changed;\nnotify bookings_changed;\nunlisten bookings_changed;',
      pg: 'In PostgreSQL these deliver asynchronous messages between sessions; in Kwery they are no-ops.',
    },
    {
      id: 'create-extension', name: 'CREATE EXTENSION', group: 'Settings and sessions',
      syntax: 'CREATE EXTENSION [ IF NOT EXISTS ] name',
      about: 'Accepted and ignored, so scripts that load an extension still run. What Kwery has is built in.',
      example: 'create extension if not exists pgcrypto;',
      pg: 'PostgreSQL loads the named extension; Kwery does nothing.',
    },

    // ---- access control --------------------------------------------------------------------------------------------------------
    {
      id: 'create-role', name: 'CREATE ROLE / USER', group: 'Access control',
      syntax: `CREATE { ROLE | USER | GROUP } [ IF NOT EXISTS ] name [ WITH ] [ option ... ]
option: LOGIN | NOLOGIN | SUPERUSER | NOSUPERUSER | CREATEDB | CREATEROLE | INHERIT
      | PASSWORD 'text' | IN ROLE role, ...
ALTER ROLE name [ WITH ] option ... | ALTER ROLE name RENAME TO new_name`,
      about: 'Makes a role: an identity that can own objects and hold privileges. A role with `LOGIN` is a user; a role without it is a group whose privileges pass to its members. `GRANT role TO user` makes a member.',
      example: `create role box_office;
create user usher in role box_office;
select rolname, rolcanlogin from pg_roles where rolname in ('box_office', 'usher');
drop role usher, box_office;`,
      pg: 'As in PostgreSQL for these options; passwords are accepted and not used.',
      see: [{ lesson: 'int-auth' }, { ref: 'statement:grant' }],
      keywords: 'user group role authorization',
    },
    {
      id: 'grant', name: 'GRANT', group: 'Access control',
      syntax: `GRANT { privilege [ ( column, ... ) ], ... | ALL [ PRIVILEGES ] }
  ON { [ TABLE ] name, ... | ALL TABLES IN SCHEMA schema | SEQUENCE name | SCHEMA name
     | FUNCTION name | TYPE name | DATABASE name }
  TO { role | PUBLIC }, ... [ WITH GRANT OPTION ]
GRANT role, ... TO role, ... [ WITH ADMIN OPTION ]
privilege: SELECT | INSERT | UPDATE | DELETE | TRUNCATE | REFERENCES | TRIGGER | USAGE | EXECUTE | CREATE`,
      about: 'Gives privileges on objects to roles. A privilege can name columns, so a role may read some columns of a table and not others. `WITH GRANT OPTION` lets the receiver pass the privilege on; the grants then form a graph from the owner, which `REVOKE ... CASCADE` follows. The second form makes roles members of another role.',
      example: `create role auditor;
grant select on patron to auditor;
set role auditor;
select current_user, name from patron limit 2;
set role none;
revoke all on patron from auditor;
drop role auditor;`,
      pg: 'As in PostgreSQL.',
      see: [{ lesson: 'int-auth' }, { ref: 'statement:revoke' }],
      keywords: 'privilege authorization permission grant option',
    },
    {
      id: 'revoke', name: 'REVOKE', group: 'Access control',
      syntax: `REVOKE [ GRANT OPTION FOR ] { privilege [ ( column, ... ) ], ... | ALL [ PRIVILEGES ] }
  ON object FROM { role | PUBLIC }, ... [ CASCADE | RESTRICT ]
REVOKE role, ... FROM role, ... [ CASCADE | RESTRICT ]`,
      about: 'Takes privileges back. If the role passed a privilege on with grant option, `RESTRICT` (the default) refuses and `CASCADE` revokes the grants that depended on it too. `GRANT OPTION FOR` removes only the right to pass the privilege on.',
      example: `create role helper;
grant select, update on venue to helper;
revoke update on venue from helper;
set role helper;
select count(*) from venue;
set role none;
revoke all on venue from helper;
drop role helper;`,
      pg: 'As in PostgreSQL.',
      see: [{ lesson: 'int-auth' }, { ref: 'statement:grant' }],
    },
    {
      id: 'alter-default-privileges', name: 'ALTER DEFAULT PRIVILEGES', group: 'Access control',
      syntax: 'ALTER DEFAULT PRIVILEGES ...',
      about: 'Accepted and ignored, so that dumps from PostgreSQL load.',
      example: 'alter default privileges grant select on tables to public;',
      pg: 'PostgreSQL sets the privileges future objects get; Kwery does nothing.',
    },

    // ---- maintenance and the plan ------------------------------------------------------------------------------------------------------
    {
      id: 'explain', name: 'EXPLAIN', group: 'Maintenance and the plan',
      syntax: `EXPLAIN [ ANALYZE ] [ VERBOSE ] statement
EXPLAIN ( option [ value ], ... ) statement
option: ANALYZE | VERBOSE | COSTS | BUFFERS | FORMAT { TEXT | JSON }`,
      about: 'Shows the plan the optimizer chose for a statement: a tree of operators (scans, joins, sorts, aggregates), each with its estimated rows and cost. `ANALYZE` also runs the statement and reports the actual rows, time and disk reads of each operator, so estimates and reality can be compared. Note that `EXPLAIN ANALYZE` of an `UPDATE` really changes the rows.',
      example: `explain analyze
select pr.title, count(*)
from booking b
  join performance f on f.perf_id = b.perf_id
  join production pr on pr.prod_id = f.prod_id
where f.perf_date >= date '2025-01-01'
group by pr.title;`,
      pg: 'The plan shapes and option names follow PostgreSQL; the cost model counts block transfers and seeks, so the numbers differ from PostgreSQL\'s.',
      see: [{ view: 'plan', label: 'Open the plan view' }, { ref: 'statement:analyze' }],
      keywords: 'plan optimizer cost query evaluation',
    },
    {
      id: 'analyze', name: 'ANALYZE', group: 'Maintenance and the plan',
      syntax: 'ANALYZE [ VERBOSE ] [ table ]',
      about: 'Collects statistics on the rows of a table, or of every table: the number of rows and pages, the number of distinct values per column, the most common values and a histogram. The optimizer uses them to estimate how many rows each step of a plan produces, which decides the join order and methods.',
      example: `analyze booking;
select attname, n_distinct, most_common_vals
from pg_stats where tablename = 'booking' and attname in ('rating', 'seats');`,
      pg: 'As in PostgreSQL, though Kwery reads every row rather than a sample.',
      see: [{ ref: 'statement:explain' }],
      keywords: 'statistics histogram selectivity estimate',
    },
    {
      id: 'vacuum', name: 'VACUUM', group: 'Maintenance and the plan',
      syntax: 'VACUUM [ FULL ] [ ANALYZE ] [ VERBOSE ] [ FREEZE ] [ table ]',
      about: 'Removes row versions that no transaction can see any more (left by updates and deletes) and their index entries, and records the freed space so new rows can reuse it. `FULL` rewrites the table compactly. `ANALYZE` also refreshes the statistics.',
      example: `update production set runtime_min = runtime_min where genre = 'opera';
vacuum verbose production;`,
      pg: 'As in PostgreSQL. Kwery has no autovacuum: dead versions stay until `VACUUM` runs, so they can be seen in the storage view.',
      see: [{ view: 'storage', label: 'See dead versions on the pages' }],
      keywords: 'garbage collect dead tuples mvcc cleanup',
    },
    {
      id: 'checkpoint', name: 'CHECKPOINT', group: 'Maintenance and the plan',
      syntax: 'CHECKPOINT',
      about: 'Writes every dirty page in the buffer pool to disk and logs a checkpoint record. After a crash, recovery starts its redo pass from the last checkpoint, so checkpoints bound how much log must be replayed.',
      example: `update company set budget = budget where company_id = 'C01';
checkpoint;`,
      pg: 'As in PostgreSQL.',
      see: [{ view: 'recovery', label: 'Crash and recover' }, { view: 'buffer', label: 'See the buffer pool' }, { view: 'log', label: 'See the log' }],
      keywords: 'recovery redo log flush dirty pages',
    },

    // ---- cursors and prepared statements ----------------------------------------------------------------------------------------------------
    {
      id: 'prepare', name: 'PREPARE, EXECUTE, DEALLOCATE', group: 'Cursors and prepared statements',
      syntax: `PREPARE name [ ( type, ... ) ] AS statement
EXECUTE name [ ( value, ... ) ]
DEALLOCATE [ PREPARE ] { name | ALL }`,
      about: 'Parses a statement with parameters `$1`, `$2` ... once and runs it many times with different values. A parameter is a value, never SQL text, so prepared statements cannot be broken by quotes in their input, which is the standard defence against SQL injection.',
      example: `prepare genre_titles(varchar) as
  select title, runtime_min from production where genre = $1 order by runtime_min desc nulls last;
execute genre_titles('drama');
deallocate genre_titles;`,
      pg: 'As in PostgreSQL.',
      keywords: 'parameter bind placeholder injection',
    },
    {
      id: 'declare', name: 'DECLARE, FETCH, MOVE, CLOSE', group: 'Cursors and prepared statements',
      syntax: `DECLARE name [ BINARY ] [ [ NO ] SCROLL ] CURSOR [ { WITH | WITHOUT } HOLD ] FOR query
FETCH [ direction ] [ FROM | IN ] name
MOVE [ direction ] [ FROM | IN ] name
CLOSE { name | ALL }
direction: NEXT | PRIOR | FIRST | LAST | ABSOLUTE n | RELATIVE n | n | ALL
         | FORWARD [ n | ALL ] | BACKWARD [ n | ALL ]`,
      about: 'A cursor runs a query and hands its rows out a few at a time. `FETCH` returns the next rows and moves on; `MOVE` moves without returning them. A `SCROLL` cursor can also go backwards. A cursor lives until its transaction ends, unless declared `WITH HOLD`. `UPDATE ... WHERE CURRENT OF` changes the row a cursor is on.',
      example: `begin;
declare c scroll cursor for select patron_id, name from patron order by patron_id;
fetch 3 from c;
fetch prior from c;
move last in c;
fetch backward 2 from c;
close c;
commit;`,
      pg: 'As in PostgreSQL.',
      keywords: 'cursor fetch scroll iterator',
    },

    // ---- import and export -------------------------------------------------------------------------------------------------------------
    {
      id: 'copy', name: 'COPY', group: 'Import and export',
      syntax: `COPY table [ ( column, ... ) ] FROM STDIN [ [ WITH ] options ]
COPY { table [ ( column, ... ) ] | ( query ) } TO STDOUT [ [ WITH ] options ]
options: ( FORMAT { text | csv }, HEADER [ bool ], DELIMITER 'c', NULL 'text' )
       | CSV | HEADER | DELIMITER [ AS ] 'c' | NULL [ AS ] 'text'`,
      about: 'Moves rows between a table and text in bulk. `TO STDOUT` writes a table or a query result as tab-separated or CSV text; `FROM STDIN` reads such text into a table, filling the columns it does not name with their defaults. It is much faster than one `INSERT` per row in a real system, because it skips parsing and planning per row.',
      example: `copy (select venue_code, venue_name, city from venue order by venue_code limit 4)
to stdout with (format csv, header);`,
      pg: 'The text and CSV formats follow PostgreSQL. There is no file system: `COPY` reads from and writes to the workbench only, never to a server file.',
      keywords: 'import export csv bulk load dump',
    },
  );
})(typeof window !== 'undefined' ? window : globalThis);
