// Chapter 3: introduction to SQL. Data definition, basic queries, set operations, nulls, aggregates, nested
// subqueries and modification of the database.
(function (root) {
  'use strict';
  const C = root.K.Content;
  // the right answer of each prediction is listed first in the source; rotate the options by a hash of the
  // question so that it lands in a different place from one question to the next
  const mix = (l) => {
    for (const b of l.body || []) {
      if (!b || !b.predict) continue;
      const p = b.predict, n = p.options.length;
      let k = 0;
      for (const ch of p.q) k = (k * 31 + ch.charCodeAt(0)) >>> 0;
      k %= n;
      const right = p.options[p.answer];
      p.options = p.options.slice(k).concat(p.options.slice(0, k));
      p.answer = p.options.indexOf(right);
    }
    return l;
  };
  const lesson = (l) => C.lesson(mix(l));

  lesson({
    id: 'sql-ddl', chapter: 3, title: 'Defining tables', minutes: 12,
    summary: 'CREATE TABLE names a relation, gives each attribute a type, and states the constraints every instance must satisfy.',
    body: [
      'SQL has two halves. The **data-definition language** (DDL) describes relations: their attributes, types, keys and constraints. The **data-manipulation language** (DML) queries and changes the tuples. This lesson is about the first half.',
      { h: 'Basic types' },
      { table: [['Type', 'Holds'], ['`char(n)`', 'a string of exactly n characters, padded with spaces'], ['`varchar(n)`', 'a string of at most n characters'], ['`int`, `smallint`', 'whole numbers (the range depends on the type)'], ['`numeric(p, d)`', 'exact decimals: p digits in all, d of them after the point. `numeric(3,1)` holds 12.5 but not 125.5'], ['`real`, `double precision`', 'floating-point numbers, approximate'], ['`float(n)`', 'a floating-point number with at least n binary digits of precision']] },
      { h: 'A table of your own' },
      'Companies rehearse before a production opens, and some venues have rooms set aside for it. Here is a small schema for those rooms and the rehearsals booked in them. Run it; it creates two empty relations.',
      { sql: "drop table if exists rehearsal;\ndrop table if exists rehearsal_room;\n\ncreate table rehearsal_room (\n  room_code  char(4),\n  venue_code varchar(6) not null,\n  capacity   smallint,\n  primary key (room_code),\n  foreign key (venue_code) references venue (venue_code)\n);\n\ncreate table rehearsal (\n  room_code char(4),\n  prod_id   varchar(6),\n  day       date,\n  hours     numeric(3,1),\n  primary key (room_code, day),\n  foreign key (room_code) references rehearsal_room (room_code),\n  foreign key (prod_id) references production (prod_id)\n);" },
      'Each line in the parentheses either declares an attribute with its type, or states a constraint:',
      { list: ['`primary key (...)` says the listed attributes form the primary key. They must be unique and may not be null. A room can host one rehearsal a day, so (room_code, day) identifies a rehearsal.', '`foreign key (...) references r` says the values must appear as the primary key of some tuple in r: a rehearsal room must belong to a venue that exists.', '`not null` says the attribute may not be null.'] },
      'Insert some tuples. The values are listed in the order the attributes were declared:',
      { sql: "insert into rehearsal_room values ('RV01', 'RIV', 30);\ninsert into rehearsal_room values ('RV02', 'RIV', 12);\ninsert into rehearsal_room values ('G7', 'GLA', 40);\nselect * from rehearsal_room;" },
      { predict: { q: "`room_code` is `char(4)`, and 'G7' has only two characters. What does `select * from rehearsal_room where room_code = 'G7'` return?", options: ['The Glasshouse room: trailing spaces are ignored when char values are compared', 'Nothing: the stored value is "G7" followed by two spaces', 'An error, because the value is too short'], answer: 0, explain: 'A `char(4)` value is padded with spaces to four characters, but comparisons between `char` values ignore trailing spaces, so the match succeeds. The padding shows up in other places (lengths, concatenation), which is why most schemas use `varchar`.' }, sql: "select * from rehearsal_room where room_code = 'G7';" },
      'The constraints are checked on every insert. Each of these fails, for a different reason:',
      { sql: "insert into rehearsal_room values ('RV01', 'LAN', 20);", fails: '23505', note: 'The primary key RV01 is taken.' },
      { sql: "insert into rehearsal_room values ('RV03', null, 20);", fails: '23502', note: 'venue_code is declared not null.' },
      { sql: "insert into rehearsal values ('ZZ99', null, date '2025-08-14', 3);", fails: '23503', note: 'There is no rehearsal room ZZ99.' },
      { h: 'Changing and removing tables' },
      '`alter table` changes a schema. A new attribute starts out null in every existing tuple:',
      { sql: 'alter table rehearsal_room add column has_piano boolean;\nselect * from rehearsal_room;' },
      'And `alter table ... drop column` removes one again. Two statements remove data and are easy to confuse:',
      { list: ['`delete from r` removes all tuples of r but keeps the relation: you can insert into it again.', '`drop table r` removes the relation itself, schema and all.'] },
      { sql: 'alter table rehearsal_room drop column has_piano;\ndelete from rehearsal;\ndrop table rehearsal;\ndrop table rehearsal_room;' },
      { tip: 'A table that another table refers to with a foreign key cannot be dropped while the referring table exists. That is why `rehearsal` was dropped first.' },
    ],
  });

  lesson({
    id: 'sql-select', chapter: 3, title: 'The basic query: select, from, where', minutes: 10,
    summary: 'A query lists the attributes it wants, the relations to take them from, and a predicate the tuples must satisfy.',
    body: [
      'Every basic SQL query has the same three clauses:',
      { list: ['`select` lists the attributes (or expressions) wanted in the result', '`from` lists the relations to read', '`where` gives a predicate on the tuples of those relations'] },
      'Read them in the order `from`, `where`, `select`: take the relations, keep the tuples that satisfy the predicate, then output the attributes asked for. The operas, and how long each one runs:',
      { sql: "select title, runtime_min\nfrom production\nwhere genre = 'opera';" },
      { h: 'Duplicates' },
      'Unlike the relational algebra, SQL keeps duplicates in a result unless told otherwise. Several companies are based in the same town, so the list of their cities repeats itself. `distinct` removes the repeats; `all`, the default, keeps them.',
      { sql: 'select all city from company;\nselect distinct city from company;' },
      { h: 'Expressions' },
      'The `select` clause can compute values with +, −, * and /. The length of each dance production in hours:',
      { sql: "select title, runtime_min / 60.0\nfrom production\nwhere genre = 'dance';" },
      { predict: { q: 'Why `60.0` and not `60`? What is `select 125 / 60`?', options: ['2: dividing one integer by another drops the fraction', '2.08, rounded to two places', 'An error: the result is not a whole number'], answer: 0, explain: 'Both operands are integers, so `/` is integer division and the result is truncated to 2. With `60.0` one operand is a decimal number and the division keeps the fraction.' }, sql: 'select 125 / 60 as whole, 125 / 60.0 as exact;' },
      'The result has a column with no proper name. The next lesson shows how to give it one.',
      { h: 'Predicates' },
      'The `where` clause combines comparisons with `and`, `or` and `not`. `between` is a shorthand for two comparisons, both inclusive. The performances with a ticket price from 40 to 45:',
      { sql: 'select perf_id, perf_date, price\nfrom performance\nwhere price between 40 and 45;' },
      { predict: { q: 'Is a performance whose ticket costs exactly 45.00 included by `price between 40 and 45`?', options: ['Yes: between includes both ends', 'No: between excludes the upper end', 'Only if the price is stored as an integer'], answer: 0, explain: '`x between a and b` means `x >= a and x <= b`. Both ends belong to the range.' } },
      'Comparisons work on strings too, using alphabetical order, and SQL tells upper from lower case in string values. The genres are stored in lower case:',
      { sql: "select title from production where title < 'C' order by title;\nselect count(*) from production where genre = 'Opera';" },
      { predict: { q: "What does `select title from production where genre = 'opera' and runtime_min > 300` return?", options: ['An empty result, with the column `title`', 'An error, because no production matches', 'One row containing null'], answer: 0, explain: 'No opera here runs for five hours. A query whose predicate is false for every tuple returns an empty relation. That is a normal answer, not an error.' }, sql: "select title from production\nwhere genre = 'opera' and runtime_min > 300;" },
      { tip: '`select *` means every attribute of every relation in the from clause. It is handy for looking around, but name the attributes in queries you keep.' },
    ],
  });

  lesson({
    id: 'sql-multi', chapter: 3, title: 'Several relations, and renaming', minutes: 12,
    summary: 'A from clause with several relations forms their Cartesian product; the where clause keeps the combinations that belong together. AS names results and tuple variables.',
    body: [
      'Most questions need data from more than one relation. In which town is the company behind each comedy based? The title and genre are in `production`, the town in `company`:',
      { sql: "select title, production.company_id, city\nfrom production, company\nwhere production.company_id = company.company_id\n  and genre = 'comedy';" },
      'Where an attribute name occurs in both relations, prefix it with the relation name, as in `production.company_id`. Names that occur only once, like `title` or `city`, need no prefix.',
      { h: 'What the from clause means' },
      'A from clause with several relations means their **Cartesian product**: every combination of one tuple from each. The where clause then filters the combinations. A database does not literally build the product (the plan view shows what it does instead), but the result is defined as if it did.',
      { predict: { q: 'There are 60 productions and 12 companies. What happens if you forget the join condition, as in `select title, city from production, company`?', options: ['You get 60 × 12 = 720 rows, pairing every production with every company\'s town', 'You get an error: the relations are not connected', 'You get 60 rows, one per production'], answer: 0, explain: 'Without a condition, every combination survives. The result is large and mostly wrong: a production is paired with the towns of companies that have nothing to do with it.' }, sql: 'select count(*)\nfrom production, company;' },
      'A query over three relations: where the operas have been performed, each pair once.',
      { sql: "select distinct title, venue_name\nfrom production, performance, venue\nwhere production.prod_id = performance.prod_id\n  and performance.venue_code = venue.venue_code\n  and genre = 'opera';" },
      { h: 'Renaming with as' },
      '`as` gives a name to an attribute of the result:',
      { sql: "select title as show, round(runtime_min / 60.0, 1) as hours\nfrom production\nwhere genre = 'tragedy';" },
      'It also names a relation in the from clause. Such a name is called a **correlation name** or **tuple variable**: it stands for one tuple at a time. Short names make long queries easier to read. Everything on in December 2025:',
      { sql: "select p.title, v.venue_name, f.perf_date, f.start_time\nfrom production as p, performance as f, venue as v\nwhere p.prod_id = f.prod_id and f.venue_code = v.venue_code\n  and f.perf_date between date '2025-12-01' and date '2025-12-31'\norder by f.perf_date, f.start_time;" },
      'Tuple variables are essential when a relation meets itself. Some productions are adaptations or sequels of earlier ones, recorded in `based_on`. To show both titles, use `production` twice, under two names:',
      { sql: 'select a.title as adaptation, s.title as source\nfrom production a, production s\nwhere a.based_on = s.prod_id;' },
      'Another use: the pairs of stages that share a venue.',
      { sql: 'select s1.venue_code, s1.stage_no, s2.stage_no as other_stage\nfrom stage s1, stage s2\nwhere s1.venue_code = s2.venue_code\n  and s1.stage_no < s2.stage_no;' },
      { predict: { q: 'Why `s1.stage_no < s2.stage_no` and not `<>`?', options: ['With <> each pair would appear twice, once in each order', 'Because <> is not allowed between numbers', 'It makes no difference'], answer: 0, explain: 'With `<>`, both (stage 1, stage 2) and (stage 2, stage 1) satisfy the condition. Requiring the first number to be smaller keeps exactly one of each pair, and also leaves out pairing a stage with itself.' } },
      { tip: 'In SQL, `as` is optional before a tuple variable: `from stage s1` means the same as `from stage as s1`.' },
    ],
  });

  lesson({
    id: 'sql-strings-order', chapter: 3, title: 'Strings, patterns and ordering', minutes: 10,
    summary: 'String values, matching patterns with LIKE, and sorting results with ORDER BY.',
    body: [
      'A string value is written in single quotes. A quote inside the string is written twice: `\'Ferryman\'\'s\'` is the string Ferryman\'s. Comparisons are case sensitive, so `\'Opera\' = \'opera\'` is false.',
      'SQL has many string functions. A few of them, on the people who live in Vantmoor:',
      { sql: "select given_name, family_name,\n       upper(family_name) as shouted,\n       length(given_name) as letters,\n       substring(family_name from 1 for 3) as start,\n       given_name || ' ' || family_name as full_name\nfrom person\nwhere home_city = 'Vantmoor';" },
      { h: 'Patterns: like' },
      '`like` matches a string against a pattern, in which two characters are special:',
      { list: ['`%` matches any substring, including the empty one', '`_` matches exactly one character'] },
      { sql: "select title from production where title like '%Salt%';\nselect name from patron where name like '_a%';" },
      { predict: { q: "Does `'The Lighthouse Keeper''s Daughter' like '%lighthouse%'` match?", options: ['No: like is case sensitive, and the L is upper case', 'Yes: like ignores case', 'Yes, because % matches the L'], answer: 0, explain: 'Patterns are case sensitive like every string comparison. `%` matches any characters, but the letters `lighthouse` must appear with that exact case. PostgreSQL also has `ilike`, which ignores case.' }, sql: "select title from production where title like '%lighthouse%';\nselect title from production where title ilike '%lighthouse%';" },
      'One title has a percent sign in it. To match a literal `%` or `_`, put an **escape character** in front of it and declare it with `escape`:',
      { sql: "select title from production where title like '%!%%' escape '!';" },
      'Without the escape, `\'%%%\'` would be three wildcards in a row and match every title. `not like` finds the strings that do not match.',
      { h: 'Ordering the result' },
      'The tuples of a relation have no order, but a result can be sorted for display. `order by` sorts ascending by default; `desc` sorts descending. With several keys, the second breaks ties in the first:',
      { sql: 'select genre, title, runtime_min\nfrom production\norder by genre, runtime_min desc;' },
      { predict: { q: 'A few productions have no premiere date yet. Where do they appear when sorting by `premiere` ascending?', options: ['Last', 'First', 'They are left out'], answer: 0, explain: 'PostgreSQL treats null as larger than every value when sorting, so nulls come last in ascending order and first in descending order, as this query shows. You can choose with `nulls first` or `nulls last`.' }, sql: 'select title, premiere\nfrom production\norder by premiere desc\nlimit 5;' },
      { warn: 'Without `order by`, the order of rows in a result is whatever the plan happens to produce. Never rely on it.' },
    ],
  });

  lesson({
    id: 'sql-setops', chapter: 3, title: 'Set operations', minutes: 10,
    summary: 'UNION, INTERSECT and EXCEPT combine the results of two queries. With ALL they keep duplicates, and count them in a precise way.',
    body: [
      'Two queries to start with: the towns that have a venue, and the towns where a company is based.',
      { sql: 'select city from venue order by city;\nselect city from company order by city;' },
      'Several companies can share a town, so the second list repeats some towns. Keep that in mind.',
      { sql: 'select city from venue\nunion\nselect city from company;' },
      '`union`, `intersect` and `except` work like ∪, ∩ and − in the algebra. Like the algebra, they remove duplicates from their result: that is every town with a venue or a company, each once.',
      { sql: 'select city from venue\nintersect\nselect city from company;\n\nselect city from venue\nexcept\nselect city from company;' },
      'The first is the towns with both; the second the towns with a venue but no company of their own: touring companies come to them.',
      { h: 'Keeping duplicates' },
      'With `all`, the duplicates stay, and the count of each tuple in the result follows simple rules. If a tuple occurs m times in the first input and n times in the second, it occurs:',
      { table: [['Operation', 'Times in the result'], ['`union all`', 'm + n'], ['`intersect all`', 'the smaller of m and n'], ['`except all`', 'm − n, or zero if that is negative']] },
      { predict: { q: 'There are 8 venues and 12 companies. How many rows does `select city from venue union all select city from company` return?', options: ['20', 'One per distinct town', '12'], answer: 0, explain: 'union all simply puts the two results together: 8 + 12 = 20 rows, duplicates and all.' }, sql: 'select city from venue\nunion all\nselect city from company;' },
      'Take a town that is home to three companies and one venue. In `company` it occurs three times, in `venue` once. So `intersect all` keeps it once, and `except all` keeps it twice (3 − 1):',
      { sql: 'select city from company\nintersect all\nselect city from venue;' },
      { sql: 'select city from company\nexcept all\nselect city from venue;' },
      { predict: { q: 'And with plain `except` (no all), is that town in the result?', options: ['No: it is in the venue result, so it is removed entirely', 'Yes, once', 'Yes, twice'], answer: 0, explain: 'Without all, both inputs are treated as sets: the town is in the second set, so it is not in the difference, however often it occurs in the first.' }, sql: 'select city from company\nexcept\nselect city from venue;' },
      { tip: 'The two queries must be compatible: the same number of columns, with compatible types. The column names of the result come from the first query.' },
    ],
  });

  lesson({
    id: 'sql-nulls', chapter: 3, title: 'Null values and three-valued logic', minutes: 14,
    summary: 'A comparison with null is neither true nor false but unknown. Learn the truth tables, and the places where unknown quietly changes an answer.',
    body: [
      'Null means "no value". In the Theatre data it has several meanings: a freelance artist has no company, a patron may not have told us their town, and a booking that was never rated has no rating. Arithmetic with a null gives null: `5 + null` is null. A comparison with a null gives a third truth value, **unknown**: is 5 < null? Nobody can say.',
      { sql: 'select 5 + null as sum, 5 < null as less, null = null as same;', note: 'All three show as NULL. SQL represents unknown as a null of type boolean.' },
      { predict: { q: 'What is `null = null`?', options: ['unknown', 'true', 'false'], answer: 0, explain: 'Two missing values might be equal or might not. So the comparison is unknown, not true. To test for null, use `is null`.' } },
      { h: 'The truth tables' },
      '`and`, `or` and `not` extend to unknown in the only consistent way: read unknown as "true or false, we do not know which", and ask whether the answer depends on which.',
      { table: [['a', 'b', 'a and b', 'a or b'], ['true', 'unknown', 'unknown', 'true'], ['false', 'unknown', 'false', 'unknown'], ['unknown', 'unknown', 'unknown', 'unknown']] },
      'And `not unknown` is unknown.',
      { predict: { q: 'What is `false and unknown`?', options: ['false', 'unknown', 'true'], answer: 0, explain: 'Whatever the unknown value is, and-ing it with false gives false. The answer does not depend on it, so it is known.' }, sql: 'select false and null as f_and_u, true and null as t_and_u;' },
      { predict: { q: 'What is `true or unknown`?', options: ['true', 'unknown', 'false'], answer: 0, explain: 'true or anything is true.' }, sql: 'select true or null as t_or_u, false or null as f_or_u;' },
      { h: 'Where unknown goes' },
      'A where clause keeps a tuple only if its predicate is **true**. Unknown is treated like false. So a predicate on a null attribute quietly drops the tuple. Count the artists, then those with company C05, then those with any other company:',
      { sql: "select count(*) from artist;\nselect count(*) from artist where company_id = 'C05';\nselect count(*) from artist where company_id <> 'C05';" },
      { predict: { q: 'Why don\'t the last two counts add up to the first?', options: ['The freelance artists have a null company, so both tests are unknown for them', 'Some artists belong to two companies', 'count skips the first row'], answer: 0, explain: '`null = \'C05\'` and `null <> \'C05\'` are both unknown, so neither query keeps a freelance artist. A tuple can fall between a predicate and its negation.' } },
      'Test for null with `is null` and `is not null`, and for unknown with `is unknown`:',
      { sql: "select person_id, fee from artist where company_id is null;\nselect person_id from artist where (company_id = 'C05') is unknown;" },
      '`coalesce` replaces a null with a value of your choice:',
      { sql: "select person_id, coalesce(billed_as, '(not billed)') as billing\nfrom artist\nwhere company_id = 'C08';" },
      { h: 'Where nulls count as equal' },
      'There is one exception. When SQL removes duplicates (`distinct`, `union`, `intersect`, `except`) or forms groups, two nulls are treated as the same value. Everyone whose home town is unknown shows up as a single null:',
      { sql: 'select distinct home_city from person order by home_city;' },
      { h: 'The not in trap' },
      'Two companies have no artists on their books. A natural way to ask for them:',
      { predict: { q: 'What does `select name from company where company_id not in (select company_id from artist)` return?', options: ['No rows at all', 'The two companies without artists', 'An error'], answer: 0, explain: 'The subquery returns the company of every artist, and for a freelance artist that is null. So `x not in (...)` includes the test `x <> null`, which is unknown, and the whole `not in` is never true: at best unknown. One null among the values makes `not in` useless.' }, sql: 'select name from company\nwhere company_id not in (select company_id from artist);' },
      'Leave the nulls out of the subquery, and the answer appears:',
      { sql: 'select name from company\nwhere company_id not in (select company_id from artist where company_id is not null);' },
    ],
  });

  lesson({
    id: 'sql-aggregates', chapter: 3, title: 'Aggregates and grouping', minutes: 14,
    summary: 'Aggregate functions turn a set of values into one. GROUP BY forms groups first; HAVING filters the groups.',
    body: [
      'SQL has five standard aggregate functions: `avg`, `min`, `max`, `sum` and `count`. Each takes a collection of values and returns one value. The weekly fees of the artists of company C06:',
      { sql: "select avg(fee) as average, min(fee) as lowest, max(fee) as highest, count(*) as artists\nfrom artist\nwhere company_id = 'C06';" },
      '`count(*)` counts tuples. `count(x)` counts the non-null values of x, and `count(distinct x)` the distinct non-null values:',
      { sql: 'select count(*) as artists, count(company_id) as in_a_company, count(distinct company_id) as companies\nfrom artist;' },
      { h: 'Groups' },
      '`group by` splits the tuples into groups that agree on the listed attributes, and the aggregates are computed once per group. The average fee in each company:',
      { sql: 'select company_id, round(avg(fee), 2) as avg_fee, count(*) as n\nfrom artist\ngroup by company_id\norder by company_id;' },
      'Only some attributes make sense in the select clause of a grouped query. Run this and read the error:',
      { sql: 'select company_id, billed_as, avg(fee)\nfrom artist\ngroup by company_id;', fails: '42803' },
      { predict: { q: 'Why is `billed_as` not allowed?', options: ['Each group has several artists, and the query does not say whose billing to show', 'Because billed_as may be null', 'Because billed_as is not part of a key'], answer: 0, explain: 'A grouped query returns one tuple per group. `company_id` has one value per group, and so does `avg(fee)`, but a company of five artists has five billings. Every attribute in select must be in the group by or inside an aggregate.' } },
      { h: 'having' },
      'A `where` predicate applies to tuples, before grouping. A `having` predicate applies to groups, after. The companies whose artists average more than 2000 a week:',
      { sql: 'select company_id, round(avg(fee), 2) as avg_fee\nfrom artist\ngroup by company_id\nhaving avg(fee) > 2000;' },
      'The full order of evaluation: from, then where, then group by, then having, then select, then order by. Here every clause plays its part: the productions that sold at least 40 seats in 2026.',
      { sql: "select f.prod_id, sum(b.seats) as seats_sold\nfrom booking b, performance f\nwhere b.perf_id = f.perf_id and f.perf_date >= date '2026-01-01'\ngroup by f.prod_id\nhaving sum(b.seats) >= 40\norder by seats_sold desc, f.prod_id;" },
      { h: 'Aggregates and nulls' },
      'Every aggregate except `count(*)` ignores nulls. About a quarter of the bookings were never rated:',
      { sql: 'select count(*) as bookings, count(rating) as rated, round(avg(rating), 2) as avg_rating,\n       round(avg(coalesce(rating, 0)), 2) as unrated_as_zero\nfrom booking;' },
      'The average is taken over the rated bookings only. Counting an unrated booking as 0 stars, as the last column does, answers a different (and unfair) question.',
      'Over an empty collection, `count` returns 0 and the others return null:',
      { predict: { q: 'No company has the ID C99. What does `select sum(fee), count(*) from artist where company_id = \'C99\'` return?', options: ['One row: null and 0', 'No rows', 'One row: 0 and 0'], answer: 0, explain: 'An aggregate query without group by always returns one row. The sum of no values is null, by definition; the count of no tuples is 0.' }, sql: "select sum(fee), count(*)\nfrom artist\nwhere company_id = 'C99';" },
      { tip: 'With group by, an empty input gives no groups and so no rows at all. Try the same query with `group by company_id` added.' },
    ],
  });

  lesson({
    id: 'sql-subq-membership', chapter: 3, title: 'Nested subqueries: membership, comparison, emptiness', minutes: 14,
    summary: 'A subquery inside a where clause can be tested for membership (IN), compared with (SOME, ALL), or tested for emptiness (EXISTS).',
    body: [
      'A **subquery** is a select-from-where expression nested inside another query. The most common place for one is the where clause.',
      { h: 'Set membership: in' },
      'The patrons who have booked anything at the Ferry Shed (venue FER). The subquery finds their IDs; the outer query lists the patrons whose ID is among them:',
      { sql: "select patron_id, name\nfrom patron\nwhere patron_id in (select b.patron_id\n                    from booking b, performance f\n                    where b.perf_id = f.perf_id and f.venue_code = 'FER');" },
      'A join would find the same people, but a patron with five bookings there would appear five times. With `in`, each patron is listed once, because each appears once in `patron`. `not in` gives the complement, and `in` also takes a list of constants: `genre in (\'opera\', \'musical\')`.',
      { h: 'Set comparison: some and all' },
      '`> some (subquery)` is true if the value is greater than at least one value of the subquery; `> all (subquery)` if it is greater than every one. The performances dearer than at least one at the Glasshouse (GLA), then those dearer than all of them:',
      { sql: "select perf_id, venue_code, price from performance\nwhere price > some (select price from performance where venue_code = 'GLA');" },
      { sql: "select perf_id, venue_code, price from performance\nwhere price > all (select price from performance where venue_code = 'GLA');" },
      '`= some` is the same as `in`. But `<> some` is not `not in`: it is true for almost any value. `<> all` is the same as `not in`.',
      { predict: { q: 'No venue has the code XYZ. For how many performances is `price > all (select price from performance where venue_code = \'XYZ\')` true?', options: ['For all of them', 'For none', 'An error: the subquery is empty'], answer: 0, explain: 'A statement about all members of an empty set is true: there is no member it fails for. So every performance passes. `> some` of an empty set is false for everyone.' }, sql: "select count(*) as passing, (select count(*) from performance) as performances\nfrom performance\nwhere price > all (select price from performance where venue_code = 'XYZ');" },
      '`all` also finds the largest group without `max`: the genre or genres with the most productions are those whose count is at least every genre\'s count.',
      { sql: 'select genre, count(*) as productions\nfrom production\ngroup by genre\nhaving count(*) >= all (select count(*) from production group by genre);' },
      { h: 'Emptiness: exists' },
      '`exists (subquery)` is true if the subquery returns at least one row. Here the subquery uses `p`, a tuple variable of the outer query. Such a subquery is **correlated**: conceptually it runs once for each outer tuple. The productions with at least one Sunday performance (`extract(dow ...)` is 0 on a Sunday):',
      { sql: 'select p.prod_id, p.title\nfrom production p\nwhere exists (select * from performance f\n              where f.prod_id = p.prod_id\n                and extract(dow from f.perf_date) = 0);' },
      '`not exists` finds the outer tuples for which there is no match: the productions that have never been performed at all.',
      { sql: 'select p.prod_id, p.title, p.premiere\nfrom production p\nwhere not exists (select * from performance f where f.prod_id = p.prod_id);' },
      { warn: 'Prefer `not exists` to `not in` when the subquery could return nulls. `x not in (subquery)` is never true if the subquery contains a null; `not exists` does not have this problem.' },
    ],
  });

  lesson({
    id: 'sql-subq-more', chapter: 3, title: 'Nested subqueries: for all, scalar subqueries, FROM and WITH', minutes: 14,
    summary: 'Expressing "for all" with NOT EXISTS and EXCEPT, subqueries that return one value, subqueries in the from clause, and the with clause.',
    body: [
      { h: '"For all" with not exists' },
      'Which artists have been cast in every production of their own company? SQL has no "for all", so turn the question around: an artist qualifies if no production of their company is missing from their castings. That is, the company\'s productions minus the artist\'s productions is empty.',
      { sql: 'select a.person_id, a.company_id\nfrom artist a\nwhere a.company_id is not null\n  and not exists (\n    (select p.prod_id from production p where p.company_id = a.company_id)\n    except\n    (select c.prod_id from casting c where c.person_id = a.person_id)\n  );' },
      { predict: { q: 'One company has artists but has not staged a single production yet. Are its artists in the result?', options: ['Yes, every one of them', 'No, none of them', 'Only those cast in some other company\'s production'], answer: 0, explain: 'For them the first set is empty, so the difference is empty and `not exists` is true. "Cast in every production of a company that has none" is true of anybody. Look for that company in the result: whenever a "for all" question can range over an empty set, decide whether that is the answer you want.' }, sql: 'select a.person_id, a.company_id,\n       (select count(*) from production p where p.company_id = a.company_id) as company_productions\nfrom artist a\nwhere a.company_id is not null\n  and not exists (\n    (select p.prod_id from production p where p.company_id = a.company_id)\n    except\n    (select c.prod_id from casting c where c.person_id = a.person_id)\n  )\norder by company_productions, a.person_id;' },
      'The standard also has a `unique` test for subqueries without duplicates. PostgreSQL does not support it; `count(*)` in a subquery does the same job.',
      { h: 'Scalar subqueries' },
      'A subquery that returns one row with one column can be used wherever a value is expected. The number of productions of each company, including companies with none:',
      { sql: 'select c.name,\n       (select count(*) from production p where p.company_id = c.company_id) as productions\nfrom company c\norder by c.name;' },
      'If such a subquery returns more than one row, the query fails when it runs:',
      { sql: "select (select title from production where genre = 'opera') as which;", fails: '21000' },
      { h: 'Subqueries in from' },
      'A query returns a relation, so it can stand in the from clause. The average fee in each company, then only the companies above 2000, without having:',
      { sql: 'select company_id, avg_fee\nfrom (select company_id, round(avg(fee), 2) as avg_fee\n      from artist\n      where company_id is not null\n      group by company_id) as company_fees\nwhere avg_fee > 2000;' },
      'The derived relation needs a name (`company_fees`), and its expressions need column names (`avg_fee`).',
      { h: 'The with clause' },
      '`with` defines a temporary relation for one query. It reads top to bottom, and a later definition can use an earlier one. What each company has taken at the box office, and its share of all the takings:',
      { sql: 'with takings (company_id, total) as (\n  select p.company_id, sum(b.paid)\n  from booking b, performance f, production p\n  where b.perf_id = f.perf_id and f.prod_id = p.prod_id\n  group by p.company_id\n),\ngrand (total) as (\n  select sum(total) from takings\n)\nselect t.company_id, t.total, round(100 * t.total / g.total, 1) as percent\nfrom takings t, grand g\norder by t.total desc;' },
      { predict: { q: 'Grouping artists by company: do the freelance artists (null company) form a group of their own?', options: ['Yes: group by puts all the nulls into one group', 'No: tuples with a null group-by attribute are dropped', 'Only if there is more than one of them'], answer: 0, explain: 'Grouping treats nulls as equal, so the freelance artists form one group, shown with a null company. In an average over the groups it would count like a company. Whether that is what you want depends on the question.' }, sql: 'select company_id, count(*), sum(fee)\nfrom artist\ngroup by company_id\norder by company_id nulls first;' },
    ],
  });

  lesson({
    id: 'sql-modify', chapter: 3, title: 'Modifying the database', minutes: 14,
    summary: 'INSERT adds tuples, DELETE removes them and UPDATE changes them; each can use a query to decide what to do.',
    body: [
      'This lesson changes the Theatre data. Each part that changes a Theatre table runs inside a transaction and ends with `rollback`, which undoes everything, so the data stays as it was. Run the blocks in order.',
      { h: 'Delete' },
      '`delete from r where P` removes the tuples of r that satisfy P. It removes whole tuples; it cannot remove only some attributes. Forget every one-star booking:',
      { sql: 'begin;\ndelete from booking where rating = 1;\nselect count(*) from booking;' },
      { sql: 'rollback;' },
      'The predicate can use a subquery. Remove the bookings for every performance at the Copperleaf Amphitheatre (venue COP):',
      { sql: "begin;\ndelete from booking\nwhere perf_id in (select perf_id from performance where venue_code = 'COP');\nselect count(*) from booking;" },
      { predict: { q: 'Still in the same transaction, what does `delete from patron where patron_id = 1` do? Patron 1 has bookings at other venues.', options: ['It fails: bookings still refer to patron 1, and the foreign key does not cascade', 'It deletes the patron and their bookings', 'It deletes the patron and leaves the bookings pointing nowhere'], answer: 0, explain: '`booking.patron_id` references `patron` with no `on delete` action, so a patron who is still referred to cannot be deleted. The error also aborts the transaction; end it with rollback.' }, sql: 'delete from patron where patron_id = 1;', fails: '23503' },
      { sql: 'rollback;' },
      { h: 'Insert' },
      'An insert gives the values in attribute order, or names the attributes it fills. Attributes left out get their default, or null:',
      { sql: "begin;\ninsert into company values ('C20', 'Night Ferry Theatre', 'Saltreach', 2026, 80000);\ninsert into company (company_id, city, name)\n  values ('C21', 'Easterholm', 'The Small Hours');\nselect * from company where company_id >= 'C20';" },
      { sql: 'rollback;' },
      'An insert can also take its tuples from a query. Copy the bookings of the first season (up to the end of June 2025) into an archive table:',
      { sql: "drop table if exists booking_archive;\ncreate table booking_archive (\n  booking_id integer primary key,\n  patron_id  integer,\n  perf_id    integer,\n  seats      smallint,\n  paid       numeric(8,2),\n  rating     smallint\n);\ninsert into booking_archive\n  select b.*\n  from booking b, performance f\n  where b.perf_id = f.perf_id and f.perf_date < date '2025-07-01';\nselect count(*) from booking_archive;" },
      { h: 'Update' },
      '`update` changes attribute values in the tuples that satisfy a predicate. Ten percent more for every ticket at Lantern Yard (LAN):',
      { sql: "begin;\nupdate performance set price = price * 1.10 where venue_code = 'LAN';\nselect perf_id, perf_date, price from performance where venue_code = 'LAN' order by perf_id limit 5;" },
      { sql: 'rollback;' },
      'Suppose the box office runs a points scheme: a patron with 1000 points or more redeems 1000 of them, and everyone else gets 50 bonus points. Two updates in a row would be wrong: a patron with 1020 points would redeem down to 20, and then, being under 1000, get the bonus as well. A `case` expression does it in one pass, deciding for every tuple from the values it had before the statement:',
      { sql: 'begin;\nupdate patron\nset points = case\n               when points >= 1000 then points - 1000\n               else points + 50\n             end;\nselect patron_id, name, points from patron order by patron_id limit 5;' },
      { sql: 'rollback;' },
      'An update can compute each new value with a scalar subquery. Recompute every patron\'s points as 10 per seat they have ever booked:',
      { sql: 'begin;\nupdate patron p\nset points = (\n  select coalesce(sum(b.seats), 0) * 10\n  from booking b\n  where b.patron_id = p.patron_id\n);\nselect patron_id, name, points from patron order by points desc, patron_id limit 5;' },
      { predict: { q: 'Why the `coalesce(..., 0)`?', options: ['A patron who never booked would get a sum of null, and points may not be null', 'To round the sum', 'Because sum fails on an empty set'], answer: 0, explain: 'The sum over no tuples is null, and `points` is declared not null, so the update would fail for the first patron with no bookings. coalesce turns that null into 0.' }, sql: 'rollback;' },
      'Finally, remove the archive table:',
      { sql: 'drop table booking_archive;' },
    ],
  });

  // ---- exercises ----------------------------------------------------------------------------------------------------------
  const ex = (x) => C.exercise(Object.assign({ chapter: 3 }, x));
  const fix = (wrong, why) => ['A classmate wrote this query' + (why ? ' ' + why : '') + ':', { sql: wrong, run: false }, 'It does not do what was asked. Write a query that does.'];

  // basic queries
  ex({ id: 'sql-x-operas', level: 1, title: 'The operas',
    text: ['List the title of every production whose genre is opera.', '**Answer with** one column, the title; one row per opera production, in any order.'],
    ref: "select title from production where genre = 'opera'",
    wrongs: ["select title from production where genre = 'Opera'", "select title, genre from production where genre = 'opera'"],
    hints: ['One relation is enough: production.', 'The genres are stored in lower case, and string comparison is case sensitive.', "select title from production where genre = 'opera'"] });

  ex({ id: 'sql-x-long-shows', level: 1, title: 'Long evenings',
    text: ['Which productions run for more than two and a half hours? Give the production ID, the title and the running time in minutes.', '**Answer with** prod_id, title, runtime_min; one row per production longer than 150 minutes, in any order.'],
    ref: 'select prod_id, title, runtime_min from production where runtime_min > 150',
    wrongs: ['select prod_id, title, runtime_min from production where runtime_min >= 150', 'select prod_id, title, runtime_min from production where runtime_min > 2.5'],
    hints: ['The running time is stored in minutes, in production.runtime_min.', 'Two and a half hours is 150 minutes, and "more than" leaves 150 itself out.', 'select prod_id, title, runtime_min from production where runtime_min > 150'] });

  ex({ id: 'sql-x-company-towns', level: 1, title: 'Where the companies are',
    text: ['In which towns is at least one company based? List each town once.', '**Answer with** one column, the town; each town once, in any order.'],
    ref: 'select distinct city from company',
    wrongs: ['select city from company', 'select distinct city from venue'],
    hints: ['company.city is the town a company is based in.', 'Several companies can share a town. Should it appear twice?', 'select distinct city from company'] });

  ex({ id: 'sql-x-dance-hours', level: 1, title: 'Minutes into hours',
    text: ['For each dance production, give the title and its running time in hours, rounded to two decimal places with `round(x, 2)`.', '**Answer with** title, hours; one row per dance production, in any order.'],
    ref: "select title, round(runtime_min / 60.0, 2) from production where genre = 'dance'",
    alts: ["select title, round(runtime_min::numeric / 60, 2) from production where genre = 'dance'"],
    wrongs: ["select title, round(runtime_min / 60, 2) from production where genre = 'dance'", "select title, runtime_min / 60.0 from production where genre = 'dance'"],
    hints: ['Arithmetic is allowed in the select clause.', 'runtime_min / 60 divides two integers and drops the fraction; divide by 60.0 instead.', "select title, round(runtime_min / 60.0, 2) from production where genre = 'dance'"] });

  ex({ id: 'sql-x-mid-price', level: 1, title: 'Tickets from 30 to 40',
    text: ['List the performances whose ticket price is from 30 to 40, both included.', '**Answer with** perf_id, perf_date, price; one row per such performance, in any order.'],
    ref: 'select perf_id, perf_date, price from performance where price between 30 and 40',
    wrongs: ['select perf_id, perf_date, price from performance where price > 30 and price < 40', 'select perf_id, perf_date, price from performance where price >= 30 and price < 40'],
    hints: ['The price is an attribute of performance.', 'between includes both ends.', 'select perf_id, perf_date, price from performance where price between 30 and 40'] });

  ex({ id: 'sql-x-not-c05', level: 2, title: 'With some other company',
    text: ['List the artists who belong to a company other than C05. Freelance artists belong to no company at all, so leave them out.', '**Answer with** person_id, fee; one row per such artist, in any order.'],
    ref: "select person_id, fee from artist where company_id <> 'C05'",
    wrongs: ["select person_id, fee from artist where company_id is distinct from 'C05'", "select person_id, fee from artist where company_id <> 'C05' or company_id is null"],
    hints: ['<> means not equal.', "What does company_id <> 'C05' give for a freelance artist, whose company_id is null?", "It is unknown, so the where clause already leaves them out: select person_id, fee from artist where company_id <> 'C05'"] });

  // several relations and renaming
  ex({ id: 'sql-x-prod-company', level: 1, title: 'Who stages what',
    text: ['For every production, give its title and the name of the company that stages it.', '**Answer with** title, name; one row per production, in any order.'],
    ref: 'select p.title, c.name from production p, company c where p.company_id = c.company_id',
    alts: ['select title, name from production natural join company'],
    wrongs: ['select p.title, c.name from production p, company c', 'select title, company_id from production'],
    hints: ['You need production and company.', 'Join them on company_id.', 'select p.title, c.name from production p, company c where p.company_id = c.company_id'] });

  ex({ id: 'sql-x-company-artists', level: 1, title: 'The artists of one company',
    text: ['List the given name, family name and weekly fee of every artist of company C07. The names are kept in person.', '**Answer with** given_name, family_name, fee; one row per artist of C07, in any order.'],
    ref: "select p.given_name, p.family_name, a.fee from person p, artist a where p.person_id = a.person_id and a.company_id = 'C07'",
    alts: ["select given_name, family_name, fee from person natural join artist where company_id = 'C07'"],
    wrongs: ["select p.given_name, p.family_name, a.fee from person p, artist a where a.company_id = 'C07'", "select p.given_name, p.family_name, a.fee from person p, artist a where p.person_id = a.person_id and a.company_id <> 'C07'"],
    hints: ['artist has the company and the fee; person has the names.', 'Both have person_id: join on it.', "select p.given_name, p.family_name, a.fee from person p, artist a where p.person_id = a.person_id and a.company_id = 'C07'"] });

  ex({ id: 'sql-x-arena-stages', level: 1, title: 'Theatre in the round',
    text: ['List every arena stage, with the name of its venue, its stage number and its number of seats.', '**Answer with** venue_name, stage_no, seats; one row per arena stage, in any order.'],
    ref: "select v.venue_name, s.stage_no, s.seats from venue v, stage s where v.venue_code = s.venue_code and s.kind = 'arena'",
    wrongs: ["select v.venue_name, s.stage_no, s.seats from venue v, stage s where s.kind = 'arena'", "select v.venue_name, s.stage_no, s.seats from venue v, stage s where v.venue_code = s.venue_code and s.kind = 'Arena'"],
    hints: ['stage has the kind and the seats; venue has the name.', 'Join them on venue_code.', "select v.venue_name, s.stage_no, s.seats from venue v, stage s where v.venue_code = s.venue_code and s.kind = 'arena'"] });

  ex({ id: 'sql-x-based-on', level: 2, title: 'Adaptations and their sources',
    text: ['For every production that is based on another one, give its title and the title of the production it is based on.', '**Answer with** the adaptation\'s title, then the source\'s title; one row per adaptation, in any order.'],
    ref: 'select a.title, s.title from production a, production s where a.based_on = s.prod_id',
    wrongs: ['select a.title, s.title from production a, production s where a.prod_id = s.based_on', 'select title, based_on from production where based_on is not null'],
    hints: ['You need production twice: once for the adaptation, once for its source.', 'Give the two copies different names, such as a and s. The adaptation\'s based_on is the source\'s prod_id.', 'select a.title, s.title from production a, production s where a.based_on = s.prod_id'] });

  ex({ id: 'sql-x-comedy-leads', level: 2, title: 'Leading roles in comedies',
    text: ['For every lead role in a comedy, give the production title, the role name and the family name of the artist who plays it.', '**Answer with** title, role_name, family_name; one row per lead casting, in any order.'],
    ref: "select p.title, c.role_name, pe.family_name\nfrom production p, casting c, person pe\nwhere p.prod_id = c.prod_id and c.person_id = pe.person_id\n  and c.lead and p.genre = 'comedy'",
    wrongs: ["select p.title, c.role_name, pe.family_name from production p, casting c, person pe where p.prod_id = c.prod_id and c.person_id = pe.person_id and p.genre = 'comedy'", "select p.title, c.role_name, pe.family_name from production p, casting c, person pe where p.prod_id = c.prod_id and c.lead and p.genre = 'comedy'"],
    hints: ['Three relations: production (title, genre), casting (role, lead) and person (name).', 'casting.lead is a boolean: c.lead on its own is a condition.', "select p.title, c.role_name, pe.family_name from production p, casting c, person pe where p.prod_id = c.prod_id and c.person_id = pe.person_id and c.lead and p.genre = 'comedy'"] });

  ex({ id: 'sql-x-patron-venues', level: 1, title: 'Where one patron goes',
    text: ['List the names of the venues where patron 1 has booked a performance, each venue once.', '**Answer with** one column, venue_name; each venue once, in any order.'],
    ref: 'select distinct v.venue_name\nfrom booking b, performance f, venue v\nwhere b.perf_id = f.perf_id and f.venue_code = v.venue_code and b.patron_id = 1',
    wrongs: ['select v.venue_name from booking b, performance f, venue v where b.perf_id = f.perf_id and f.venue_code = v.venue_code and b.patron_id = 1', 'select distinct f.venue_code from booking b, performance f where b.perf_id = f.perf_id and b.patron_id = 1'],
    hints: ['booking leads to performance, performance to venue.', 'A patron who books the same venue twice should still see it once.', 'select distinct v.venue_name from booking b, performance f, venue v where b.perf_id = f.perf_id and f.venue_code = v.venue_code and b.patron_id = 1'] });

  ex({ id: 'sql-x-local-artists', level: 2, title: 'Working close to home',
    text: ['Find the artists whose home town is the town where their company is based.', '**Answer with** person_id, family_name; one row per such artist, in any order.'],
    ref: 'select a.person_id, p.family_name\nfrom artist a, person p, company c\nwhere a.person_id = p.person_id and a.company_id = c.company_id and p.home_city = c.city',
    wrongs: ['select a.person_id, p.family_name from artist a, person p, company c where a.person_id = p.person_id and a.company_id = c.company_id and p.home_city <> c.city', 'select a.person_id, p.family_name from artist a, person p, venue c where a.person_id = p.person_id and p.home_city = c.city'],
    hints: ['Three relations: artist, person (home_city) and company (city).', 'Two join conditions, and a third condition comparing the two towns.', 'select a.person_id, p.family_name from artist a, person p, company c where a.person_id = p.person_id and a.company_id = c.company_id and p.home_city = c.city'] });

  ex({ id: 'sql-x-stage-pairs', level: 2, title: 'Bigger and smaller stages',
    text: ['For every venue, list the pairs of its stages in which the first stage has more seats than the second.', '**Answer with** venue_code, the larger stage\'s stage_no, the smaller stage\'s stage_no; one row per pair, in any order.'],
    ref: 'select s1.venue_code, s1.stage_no, s2.stage_no from stage s1, stage s2 where s1.venue_code = s2.venue_code and s1.seats > s2.seats',
    wrongs: ['select s1.venue_code, s1.stage_no, s2.stage_no from stage s1, stage s2 where s1.venue_code = s2.venue_code and s1.stage_no <> s2.stage_no', 'select s1.venue_code, s1.stage_no, s2.stage_no from stage s1, stage s2 where s1.venue_code = s2.venue_code and s1.seats >= s2.seats'],
    hints: ['Use two copies of stage, s1 and s2.', 'They must be at the same venue, and s1 must be the bigger one.', 'select s1.venue_code, s1.stage_no, s2.stage_no from stage s1, stage s2 where s1.venue_code = s2.venue_code and s1.seats > s2.seats'] });

  ex({ id: 'sql-x-mentor-names', level: 2, title: 'Mentors by name',
    text: ['For every row of mentor, give the family name of the mentor and the family name of the mentee.', '**Answer with** the mentor\'s family_name, then the mentee\'s family_name; one row per mentor row, in any order.'],
    ref: 'select m.family_name, e.family_name from mentor r, person m, person e where r.mentor_id = m.person_id and r.mentee_id = e.person_id',
    wrongs: ['select m.family_name, e.family_name from mentor r, person m, person e where r.mentee_id = m.person_id and r.mentor_id = e.person_id', 'select p.family_name, p.family_name from mentor r, person p where r.mentor_id = p.person_id'],
    hints: ['The names are in person, and you need two different people per row.', 'Use person twice, as m for the mentor and e for the mentee.', 'select m.family_name, e.family_name from mentor r, person m, person e where r.mentor_id = m.person_id and r.mentee_id = e.person_id'] });

  // strings and ordering
  ex({ id: 'sql-x-salt', level: 1, title: 'A word in the title',
    text: ['List the productions whose title contains the word `Salt` (with a capital S), wherever it appears.', '**Answer with** prod_id, title; one row per such production, in any order.'],
    ref: "select prod_id, title from production where title like '%Salt%'",
    wrongs: ["select prod_id, title from production where title like 'Salt%'", "select prod_id, title from production where title like '%salt%'"],
    hints: ['like with % matches any substring.', 'The word may be at the start, in the middle or at the end.', "select prod_id, title from production where title like '%Salt%'"] });

  ex({ id: 'sql-x-the-titles', level: 1, title: 'Titles that start with The',
    text: ['List the titles that begin with the word `The` followed by a space.', '**Answer with** one column, title; in any order.'],
    ref: "select title from production where title like 'The %'",
    wrongs: ["select title from production where title like '%The %'", "select title from production where title like 'the %'"],
    hints: ['The pattern starts at the first character unless it begins with %.', 'After "The " anything may follow.', "select title from production where title like 'The %'"] });

  ex({ id: 'sql-x-second-letter', level: 1, title: 'A pattern on names',
    text: ['List the patrons whose name has `a` as its second letter.', '**Answer with** patron_id, name; in any order.'],
    ref: "select patron_id, name from patron where name like '_a%'",
    wrongs: ["select patron_id, name from patron where name like '%a%'", "select patron_id, name from patron where name like 'a%'"],
    hints: ['_ matches exactly one character.', 'After the a, anything may follow.', "select patron_id, name from patron where name like '_a%'"] });

  ex({ id: 'sql-x-percent', level: 2, title: 'A percent sign in a title',
    text: ['List the titles that contain a percent sign (the character %).', '**Answer with** one column, title; in any order.'],
    ref: "select title from production where title like '%!%%' escape '!'",
    alts: ["select title from production where position('%' in title) > 0"],
    wrongs: ["select title from production where title like '%%%'", "select title from production where title like '%_%'"],
    hints: ['In a pattern, % is a wildcard, so it cannot stand for itself without help.', "Choose an escape character: like '...' escape '!'. Then !% means a literal percent sign.", "select title from production where title like '%!%%' escape '!'"] });

  ex({ id: 'sql-x-order-fee', level: 1, title: 'Sorted by fee',
    text: ['List the artists of company C06, highest fee first. Break ties by person ID, ascending.', '**Answer with** person_id, fee; ordered by fee descending, then person_id.'],
    ref: "select person_id, fee from artist where company_id = 'C06' order by fee desc, person_id",
    wrongs: ["select person_id, fee from artist where company_id = 'C06' order by fee, person_id", "select person_id, fee from artist where company_id = 'C06' order by person_id"],
    hints: ['order by fee desc sorts from high to low.', 'A second sort key breaks ties.', "select person_id, fee from artist where company_id = 'C06' order by fee desc, person_id"] });

  ex({ id: 'sql-x-order-premiere', level: 2, title: 'Not yet scheduled first',
    text: ['List every production\'s title and premiere date: first the productions with no premiere date yet, then the rest from the earliest premiere to the latest. Break ties by title.', '**Answer with** title, premiere; ordered by premiere with nulls first, then title.'],
    ref: 'select title, premiere from production order by premiere nulls first, title',
    wrongs: ['select title, premiere from production order by premiere, title', 'select title, premiere from production order by premiere desc, title'],
    hints: ['In ascending order, nulls sort last by default.', 'nulls first changes that, without changing the direction.', 'select title, premiere from production order by premiere nulls first, title'] });

  ex({ id: 'sql-x-billing', level: 2, title: 'The name on the poster',
    text: ['Produce one column for every artist: the name they are billed as, or, for an artist with no billing name, their given name and family name separated by a space.', '**Answer with** one column; one row per artist, in any order.'],
    ref: "select coalesce(a.billed_as, p.given_name || ' ' || p.family_name) from artist a, person p where a.person_id = p.person_id",
    alts: ["select case when a.billed_as is null then p.given_name || ' ' || p.family_name else a.billed_as end from artist a join person p on p.person_id = a.person_id"],
    wrongs: ['select a.billed_as from artist a', "select p.given_name || ' ' || p.family_name from artist a, person p where a.person_id = p.person_id"],
    hints: ['|| joins strings; the names are in person.', 'billed_as is null for many artists.', "coalesce(a.billed_as, p.given_name || ' ' || p.family_name), over artist joined with person."] });

  ex({ id: 'sql-x-initials', level: 2, title: 'Initial and family name',
    text: ['For each person born before 1960, give a label made of the first letter of the given name, a full stop, a space and the family name (like `T. Nakamura`), and the birth date.', '**Answer with** label, birth_date; one row per such person, in any order.'],
    ref: "select substring(given_name from 1 for 1) || '. ' || family_name, birth_date from person where birth_date < date '1960-01-01'",
    alts: ["select left(given_name, 1) || '. ' || family_name, birth_date from person where birth_date < date '1960-01-01'"],
    wrongs: ["select substring(given_name from 1 for 1) || '.' || family_name, birth_date from person where birth_date < date '1960-01-01'", "select given_name || '. ' || family_name, birth_date from person where birth_date < date '1960-01-01'"],
    hints: ['substring(s from 1 for 1) is the first character of s.', "Join the parts with ||: the initial, '. ', the family name.", "select substring(given_name from 1 for 1) || '. ' || family_name, birth_date from person where birth_date < date '1960-01-01'"] });

  // set operations
  ex({ id: 'sql-x-town-union', level: 1, title: 'Towns with something on',
    text: ['List every town that has a venue or is home to a company (or both), each once.', '**Answer with** one column, the town; each once, in any order.'],
    ref: 'select city from venue\nunion\nselect city from company',
    wrongs: ['select city from venue union all select city from company', 'select city from venue intersect select city from company'],
    hints: ['Two queries, one on venue and one on company.', 'union combines them and removes duplicates.', 'select city from venue union select city from company'] });

  ex({ id: 'sql-x-town-both', level: 1, title: 'Towns with both',
    text: ['List the towns that have a venue and are also home to at least one company.', '**Answer with** one column, the town; each once, in any order.'],
    ref: 'select city from venue\nintersect\nselect city from company',
    wrongs: ['select city from venue union select city from company', 'select city from venue except select city from company'],
    hints: ['Two queries, one per relation.', 'Keep only what is in both.', 'select city from venue intersect select city from company'] });

  ex({ id: 'sql-x-town-visited', level: 2, title: 'Visited but no company of its own',
    text: ['List the towns that have a venue but are not home to any company.', '**Answer with** one column, the town; each once, in any order.'],
    ref: 'select city from venue\nexcept\nselect city from company',
    wrongs: ['select city from company except select city from venue', 'select distinct city from venue'],
    hints: ['A difference: venue towns minus company towns.', 'The order of the two queries matters for except.', 'select city from venue except select city from company'] });

  ex({ id: 'sql-x-mentor-mentee', level: 2, title: 'Both sides of mentoring',
    text: ['List the IDs of the artists who mentor someone and are also mentored by someone.', '**Answer with** one column, the person ID; each once, in any order.'],
    ref: 'select mentor_id from mentor\nintersect\nselect mentee_id from mentor',
    wrongs: ['select mentor_id from mentor union select mentee_id from mentor', 'select distinct mentor_id from mentor'],
    hints: ['One query lists the mentors, the other the mentees.', 'An artist on both lists is in their intersection.', 'select mentor_id from mentor intersect select mentee_id from mentor'] });

  ex({ id: 'sql-x-town-every-row', level: 2, title: 'One row per venue and per company',
    text: ['List the town of every venue and of every company in one column, with one row per venue and one per company: a town with two companies and a venue appears three times. Use a set operation.', '**Answer with** one column, the town; one row per venue or company, in any order.'],
    ref: 'select city from venue\nunion all\nselect city from company',
    wrongs: ['select city from venue union select city from company', 'select city from company'],
    hints: ['union removes duplicates, which is not wanted here.', 'union all keeps them.', 'select city from venue union all select city from company'] });

  ex({ id: 'sql-x-never-performed', level: 2, title: 'Never on stage',
    text: ['List the productions that have never had a performance.', '**Answer with** prod_id, title; in any order.'],
    ref: 'select prod_id, title from production\nwhere prod_id not in (select prod_id from performance)',
    alts: ['select p.prod_id, p.title from production p where not exists (select * from performance f where f.prod_id = p.prod_id)', 'select prod_id, title from production except select p.prod_id, p.title from production p, performance f where p.prod_id = f.prod_id'],
    wrongs: ['select prod_id, title from production where prod_id in (select prod_id from performance)', 'select prod_id, title from production where premiere is null'],
    hints: ['Compare the productions with the prod_ids that appear in performance.', 'except, not in or not exists all work here: performance.prod_id is never null.', 'select prod_id, title from production where prod_id not in (select prod_id from performance)'] });

  ex({ id: 'sql-x-both-seasons', level: 2, title: 'Busy in both seasons',
    text: ['A season runs from September to June. List the venues that had a performance in the 2024–25 season (before 1 July 2025) and also in the 2025–26 season (from 1 July 2025 on).', '**Answer with** one column, venue_code; each once, in any order.'],
    ref: "select venue_code from performance where perf_date < date '2025-07-01'\nintersect\nselect venue_code from performance where perf_date >= date '2025-07-01'",
    wrongs: ["select venue_code from performance where perf_date < date '2025-07-01' union select venue_code from performance where perf_date >= date '2025-07-01'", "select venue_code from performance where perf_date < date '2025-07-01' except select venue_code from performance where perf_date >= date '2025-07-01'"],
    hints: ['One query per season, both projecting venue_code.', 'A venue busy in both is in both results.', "select venue_code from performance where perf_date < date '2025-07-01' intersect select venue_code from performance where perf_date >= date '2025-07-01'"] });

  // nulls
  ex({ id: 'sql-x-freelance', level: 1, title: 'Freelance artists',
    text: ['List the artists who belong to no company.', '**Answer with** person_id, fee; in any order.'],
    ref: 'select person_id, fee from artist where company_id is null',
    wrongs: ['select person_id, fee from artist where company_id = null', "select person_id, fee from artist where company_id = ''"],
    hints: ['A freelance artist has a null company_id.', '= null is never true. Use is null.', 'select person_id, fee from artist where company_id is null'] });

  ex({ id: 'sql-x-unrated-count', level: 1, title: 'Bookings without a rating',
    text: ['For each patron with at least one unrated booking, give the patron ID and the number of their unrated bookings.', '**Answer with** patron_id, count; one row per such patron, in any order.'],
    ref: 'select patron_id, count(*) from booking where rating is null group by patron_id',
    wrongs: ['select patron_id, count(rating) from booking where rating is null group by patron_id', 'select patron_id, count(*) from booking group by patron_id'],
    hints: ['An unrated booking has a null rating.', 'Keep the unrated bookings, then group them by patron.', 'count(rating) would count none of them: use count(*). select patron_id, count(*) from booking where rating is null group by patron_id'] });

  ex({ id: 'sql-x-fix-not-c03', level: 2, title: 'Fix: everyone not with C03',
    text: fix("select person_id, fee from artist where company_id <> 'C03';", 'to list every artist who is not with company C03, the freelance artists included'),
    wrong: "select person_id, fee from artist where company_id <> 'C03'",
    ref: "select person_id, fee from artist where company_id <> 'C03' or company_id is null",
    alts: ["select person_id, fee from artist where company_id is distinct from 'C03'"],
    wrongs: ["select person_id, fee from artist where company_id is null"],
    hints: ["What is null <> 'C03'?", 'It is unknown, so the freelance artists are dropped.', "Add or company_id is null: select person_id, fee from artist where company_id <> 'C03' or company_id is null"] });

  ex({ id: 'sql-x-fix-eq-null', level: 1, title: 'Fix: comparing with null',
    text: fix('select booking_id, patron_id, perf_id from booking where rating = null;', 'to find the bookings that were never rated'),
    wrong: 'select booking_id, patron_id, perf_id from booking where rating = null',
    ref: 'select booking_id, patron_id, perf_id from booking where rating is null',
    wrongs: ['select booking_id, patron_id, perf_id from booking where rating = 0'],
    hints: ['Run it: how many rows does it give?', '= null is unknown for every row.', 'Use is null: select booking_id, patron_id, perf_id from booking where rating is null'] });

  ex({ id: 'sql-x-fix-not-in', level: 3, title: 'Fix: a not in that finds nothing',
    text: fix('select company_id, name from company\nwhere company_id not in (select company_id from artist);', 'to list the companies that have no artists'),
    wrong: 'select company_id, name from company where company_id not in (select company_id from artist)',
    ref: 'select c.company_id, c.name from company c\nwhere not exists (select * from artist a where a.company_id = c.company_id)',
    alts: ['select company_id, name from company where company_id not in (select company_id from artist where company_id is not null)'],
    wrongs: ['select c.company_id, c.name from company c where exists (select * from artist a where a.company_id = c.company_id)'],
    hints: ['Run the subquery on its own. What does it return for a freelance artist?', 'It returns a null, and x not in (..., null) is never true.', 'Rewrite with not exists: select c.company_id, c.name from company c where not exists (select * from artist a where a.company_id = c.company_id)'] });

  ex({ id: 'sql-x-patron-towns', level: 2, title: 'Patrons per town',
    text: ['Count the patrons per town. Patrons whose town is unknown should be counted under the name `unknown`.', '**Answer with** the town (or `unknown`), the count; one row per town, in any order.'],
    ref: "select coalesce(city, 'unknown'), count(*) from patron group by coalesce(city, 'unknown')",
    wrongs: ['select city, count(*) from patron group by city', 'select city, count(*) from patron where city is not null group by city'],
    hints: ['You can group by an expression.', "coalesce(city, 'unknown') gives the name to show.", "select coalesce(city, 'unknown'), count(*) from patron group by coalesce(city, 'unknown')"] });

  // aggregates
  ex({ id: 'sql-x-avg-fee', level: 1, title: 'An average fee',
    text: ['What is the average weekly fee of the artists of company C05? Round it to two decimal places.', '**Answer with** one column and one row: the rounded average.'],
    ref: "select round(avg(fee), 2) from artist where company_id = 'C05'",
    wrongs: ['select round(avg(fee), 2) from artist', "select round(avg(fee)) from artist where company_id = 'C05'"],
    hints: ['avg computes the mean.', 'round(x, 2) rounds.', "select round(avg(fee), 2) from artist where company_id = 'C05'"] });

  ex({ id: 'sql-x-artists-per-company', level: 1, title: 'Artists per company',
    text: ['For each company that has at least one artist, give the company ID and the number of its artists. Leave the freelance artists out.', '**Answer with** company_id, count; one row per company with artists, in any order.'],
    ref: 'select company_id, count(*) from artist where company_id is not null group by company_id',
    wrongs: ['select company_id, count(*) from artist group by company_id', 'select company_id, count(company_id) from artist group by company_id'],
    hints: ['group by company_id forms one group per company.', 'Without a filter, the freelance artists form a group of their own, with a null company.', 'select company_id, count(*) from artist where company_id is not null group by company_id'] });

  ex({ id: 'sql-x-artists-per-company0', level: 2, title: 'Including companies with nobody',
    text: ['For every company in the company table, give its ID and the number of its artists. A company with no artists shows 0.', '**Answer with** company_id, count; one row per company, in any order.'],
    ref: 'select c.company_id, (select count(*) from artist a where a.company_id = c.company_id)\nfrom company c',
    alts: ['select c.company_id, count(a.person_id) from company c left join artist a on a.company_id = c.company_id group by c.company_id'],
    wrongs: ['select company_id, count(*) from artist where company_id is not null group by company_id', 'select c.company_id, count(*) from company c left join artist a on a.company_id = c.company_id group by c.company_id'],
    hints: ['Grouping artist cannot produce a company that has no artists.', 'Start from company, and count with a scalar subquery.', 'count(*) of an empty set is 0: select c.company_id, (select count(*) from artist a where a.company_id = c.company_id) from company c'] });

  ex({ id: 'sql-x-stage-range', level: 1, title: 'Largest and smallest stage',
    text: ['For each venue, give the venue code, the number of seats of its smallest stage and of its largest.', '**Answer with** venue_code, the smallest seats, the largest seats; one row per venue with stages, in any order.'],
    ref: 'select venue_code, min(seats), max(seats) from stage group by venue_code',
    wrongs: ['select venue_code, min(seats), max(seats) from stage group by venue_code, kind', 'select venue_code, min(stage_no), max(stage_no) from stage group by venue_code'],
    hints: ['One group per venue.', 'min and max work on numbers.', 'select venue_code, min(seats), max(seats) from stage group by venue_code'] });

  ex({ id: 'sql-x-busy-companies', level: 2, title: 'Companies with five or more',
    text: ['List the companies that have staged at least five productions, with the number of productions.', '**Answer with** company_id, count; one row per such company, in any order.'],
    ref: 'select company_id, count(*) from production group by company_id having count(*) >= 5',
    wrongs: ['select company_id, count(*) from production group by company_id having count(*) > 5', 'select company_id, count(*) from production group by company_id'],
    hints: ['Group the productions by company.', 'A condition on a group goes in having.', 'select company_id, count(*) from production group by company_id having count(*) >= 5'] });

  ex({ id: 'sql-x-patrons-per-year', level: 2, title: 'Audience per year',
    text: ['For each calendar year, how many different patrons booked a performance taking place that year?', '**Answer with** year, number of patrons; one row per year, in any order.'],
    ref: 'select extract(year from f.perf_date), count(distinct b.patron_id)\nfrom booking b, performance f\nwhere b.perf_id = f.perf_id\ngroup by extract(year from f.perf_date)',
    wrongs: ['select extract(year from f.perf_date), count(*) from booking b, performance f where b.perf_id = f.perf_id group by extract(year from f.perf_date)', 'select extract(year from f.perf_date), count(distinct b.perf_id) from booking b, performance f where b.perf_id = f.perf_id group by extract(year from f.perf_date)'],
    hints: ['The year is in performance.perf_date: extract(year from ...).', 'A patron with several bookings in a year counts once.', 'count(distinct b.patron_id), grouped by extract(year from f.perf_date).'] });

  ex({ id: 'sql-x-low-ratings', level: 2, title: 'Poor reviews',
    text: ['For each production that received at least one rating of 1 or 2 stars, give the production ID and the number of such ratings.', '**Answer with** prod_id, count; one row per such production, in any order.'],
    ref: 'select f.prod_id, count(*)\nfrom booking b, performance f\nwhere b.perf_id = f.perf_id and b.rating <= 2\ngroup by f.prod_id',
    wrongs: ['select f.prod_id, count(*) from booking b, performance f where b.perf_id = f.perf_id and b.rating < 2 group by f.prod_id', 'select f.prod_id, count(b.rating) from booking b, performance f where b.perf_id = f.perf_id group by f.prod_id'],
    hints: ['booking has the rating; performance tells which production it was for.', 'Filter the ratings in where, then group by production.', 'select f.prod_id, count(*) from booking b, performance f where b.perf_id = f.perf_id and b.rating <= 2 group by f.prod_id'] });

  ex({ id: 'sql-x-fix-groupby', level: 2, title: 'Fix: a column not in GROUP BY',
    text: fix('select company_id, billed_as, max(fee)\nfrom artist\ngroup by company_id;', 'to find the highest fee in each company (freelance artists counting as one group)'),
    wrong: 'select company_id, billed_as, max(fee) from artist group by company_id',
    ref: 'select company_id, max(fee) from artist group by company_id',
    wrongs: ['select company_id, max(fee) from artist where company_id is not null group by company_id'],
    hints: ['Run it and read the error.', 'Each group has many billing names: which one should be shown?', 'The task asks only for the company and the highest fee: select company_id, max(fee) from artist group by company_id'] });

  ex({ id: 'sql-x-fix-where-agg', level: 2, title: 'Fix: an aggregate in WHERE',
    text: fix('select company_id, count(*)\nfrom production\nwhere count(*) > 3\ngroup by company_id;', 'to list the companies with more than three productions, and how many each has'),
    wrong: 'select company_id, count(*) from production where count(*) > 3 group by company_id',
    ref: 'select company_id, count(*) from production group by company_id having count(*) > 3',
    wrongs: ['select company_id, count(*) from production group by company_id having count(*) >= 3'],
    hints: ['where is evaluated before the groups exist.', 'A condition on a group belongs in having.', 'select company_id, count(*) from production group by company_id having count(*) > 3'] });

  ex({ id: 'sql-x-venue-takings', level: 2, title: 'Takings per venue',
    text: ['For each venue, give the total amount patrons paid for bookings of performances held there in 2025.', '**Answer with** venue_code, total paid; one row per venue with 2025 bookings, in any order.'],
    ref: "select f.venue_code, sum(b.paid)\nfrom booking b, performance f\nwhere b.perf_id = f.perf_id and f.perf_date between date '2025-01-01' and date '2025-12-31'\ngroup by f.venue_code",
    wrongs: ["select f.venue_code, sum(f.price) from booking b, performance f where b.perf_id = f.perf_id and f.perf_date between date '2025-01-01' and date '2025-12-31' group by f.venue_code", "select f.venue_code, sum(b.paid) from booking b, performance f where b.perf_id = f.perf_id group by f.venue_code"],
    hints: ['booking.paid is what each booking cost; performance has the venue and the date.', 'Filter the year in where, then group by venue.', "select f.venue_code, sum(b.paid) from booking b, performance f where b.perf_id = f.perf_id and f.perf_date between date '2025-01-01' and date '2025-12-31' group by f.venue_code"] });

  ex({ id: 'sql-x-well-rated', level: 3, title: 'Average rating, fairly',
    text: ['For each production with at least 10 ratings, give the production ID and the average rating, rounded to two decimals. Unrated bookings count neither towards the average nor towards the 10.', '**Answer with** prod_id, average; one row per such production, in any order.'],
    ref: 'select f.prod_id, round(avg(b.rating), 2)\nfrom booking b, performance f\nwhere b.perf_id = f.perf_id\ngroup by f.prod_id\nhaving count(b.rating) >= 10',
    wrongs: ['select f.prod_id, round(avg(b.rating), 2) from booking b, performance f where b.perf_id = f.perf_id group by f.prod_id having count(*) >= 10', 'select f.prod_id, round(avg(coalesce(b.rating, 0)), 2) from booking b, performance f where b.perf_id = f.perf_id group by f.prod_id having count(b.rating) >= 10'],
    hints: ['avg already ignores nulls.', 'count(*) counts the unrated bookings too; count(b.rating) does not.', 'select f.prod_id, round(avg(b.rating), 2) from booking b, performance f where b.perf_id = f.perf_id group by f.prod_id having count(b.rating) >= 10'] });

  ex({ id: 'sql-x-prods-per-venue', level: 1, title: 'How many different productions',
    text: ['For each venue that has hosted a performance, give the venue code and the number of different productions performed there (a production with many performances counts once).', '**Answer with** venue_code, count; one row per venue, in any order.'],
    ref: 'select venue_code, count(distinct prod_id) from performance group by venue_code',
    wrongs: ['select venue_code, count(*) from performance group by venue_code', 'select venue_code, count(distinct stage_no) from performance group by venue_code'],
    hints: ['performance alone is enough.', 'Group by venue_code.', 'select venue_code, count(distinct prod_id) from performance group by venue_code'] });

  // nested subqueries
  ex({ id: 'sql-x-in-ferry', level: 1, title: 'Patrons of one venue',
    text: ['Using `in` and a subquery, list the patrons who have booked a performance at venue FER.', '**Answer with** patron_id, name; each patron once, in any order.'],
    ref: "select patron_id, name from patron\nwhere patron_id in (select b.patron_id from booking b, performance f where b.perf_id = f.perf_id and f.venue_code = 'FER')",
    alts: ["select distinct p.patron_id, p.name from patron p, booking b, performance f where p.patron_id = b.patron_id and b.perf_id = f.perf_id and f.venue_code = 'FER'"],
    wrongs: ["select p.patron_id, p.name from patron p, booking b, performance f where p.patron_id = b.patron_id and b.perf_id = f.perf_id and f.venue_code = 'FER'", "select patron_id, name from patron where patron_id in (select perf_id from performance where venue_code = 'FER')"],
    hints: ['The subquery finds the patron IDs, joining booking and performance.', 'The outer query lists the patrons whose ID is in that set.', "select patron_id, name from patron where patron_id in (select b.patron_id from booking b, performance f where b.perf_id = f.perf_id and f.venue_code = 'FER')"] });

  ex({ id: 'sql-x-2025-not-2026', level: 2, title: 'Not brought back',
    text: ['Using a subquery, list the productions performed in 2025 that have no performance in 2026.', '**Answer with** one column, prod_id; each once, in any order.'],
    ref: "select distinct prod_id from performance\nwhere extract(year from perf_date) = 2025\n  and prod_id not in (select prod_id from performance where extract(year from perf_date) = 2026)",
    wrongs: ["select prod_id from performance where extract(year from perf_date) = 2025 and prod_id not in (select prod_id from performance where extract(year from perf_date) = 2026)", "select distinct prod_id from performance where extract(year from perf_date) = 2025 and prod_id in (select prod_id from performance where extract(year from perf_date) = 2026)"],
    hints: ['The subquery lists the productions performed in 2026.', 'not in keeps the 2025 ones that are not in it.', 'Add distinct: a production has several performances.'] });

  ex({ id: 'sql-x-gt-all-glass', level: 2, title: 'Dearer than all of them',
    text: ['List the performances whose ticket costs more than every performance at venue GLA.', '**Answer with** perf_id, price; in any order.'],
    ref: "select perf_id, price from performance\nwhere price > all (select price from performance where venue_code = 'GLA')",
    alts: ["select perf_id, price from performance where price > (select max(price) from performance where venue_code = 'GLA')"],
    wrongs: ["select perf_id, price from performance where price > some (select price from performance where venue_code = 'GLA')", "select perf_id, price from performance where price > (select avg(price) from performance where venue_code = 'GLA')"],
    hints: ['> all compares with every value of the subquery.', 'The subquery gives the GLA prices.', "select perf_id, price from performance where price > all (select price from performance where venue_code = 'GLA')"] });

  ex({ id: 'sql-x-gt-some-riv', level: 2, title: 'Bigger than some',
    text: ['List the stages that have more seats than at least one stage of venue RIV.', '**Answer with** venue_code, stage_no, seats; in any order.'],
    ref: "select venue_code, stage_no, seats from stage\nwhere seats > some (select seats from stage where venue_code = 'RIV')",
    alts: ["select venue_code, stage_no, seats from stage where seats > (select min(seats) from stage where venue_code = 'RIV')"],
    wrongs: ["select venue_code, stage_no, seats from stage where seats > all (select seats from stage where venue_code = 'RIV')", "select venue_code, stage_no, seats from stage where seats >= some (select seats from stage where venue_code = 'RIV')"],
    hints: ['> some is true if there is at least one smaller value.', 'The subquery gives the seats of the RIV stages.', "select venue_code, stage_no, seats from stage where seats > some (select seats from stage where venue_code = 'RIV')"] });

  ex({ id: 'sql-x-top-fee', level: 2, title: 'The highest fee',
    text: ['List the artist or artists with the highest fee. If several share it, list them all. Some artists may have no fee recorded.', '**Answer with** person_id, fee; in any order.'],
    ref: 'select person_id, fee from artist where fee = (select max(fee) from artist)',
    wrongs: ['select person_id, fee from artist order by fee desc nulls last limit 1', 'select person_id, fee from artist where fee >= all (select fee from artist)'],
    hints: ['First find the highest fee; max ignores nulls.', 'A scalar subquery can do that.', 'select person_id, fee from artist where fee = (select max(fee) from artist)'] });

  ex({ id: 'sql-x-top-genre', level: 2, title: 'The most common genre',
    text: ['Which genre or genres have the most productions? Give each with its number of productions; if genres tie for first place, list them all.', '**Answer with** genre, count; in any order.'],
    ref: 'select genre, count(*) from production group by genre\nhaving count(*) >= all (select count(*) from production group by genre)',
    alts: ['select genre, count(*) from production group by genre having count(*) = (select max(n) from (select count(*) as n from production group by genre) t)'],
    wrongs: ['select genre, count(*) from production group by genre having count(*) > all (select count(*) from production group by genre)', 'select genre, count(*) from production group by genre'],
    hints: ['Group by genre and count.', 'Keep the groups whose count is at least every group\'s count.', 'having count(*) >= all (select count(*) from production group by genre)'] });

  ex({ id: 'sql-x-mentor-outside', level: 3, title: 'Mentoring across companies',
    text: ['Using `exists`, list the artists who mentor at least one artist who is not in the same company as they are. Freelance counts as a company of its own here: a freelance mentor of a freelance mentee is in the same "company", a freelance mentor of a company artist is not.', '**Answer with** one column, person_id; each once, in any order.'],
    ref: 'select a.person_id from artist a\nwhere exists (select * from mentor m, artist b\n              where m.mentor_id = a.person_id and m.mentee_id = b.person_id\n                and b.company_id is distinct from a.company_id)',
    wrongs: ['select a.person_id from artist a where exists (select * from mentor m, artist b where m.mentor_id = a.person_id and m.mentee_id = b.person_id and b.company_id <> a.company_id)', 'select a.person_id from artist a where exists (select * from mentor m where m.mentor_id = a.person_id)'],
    hints: ['The subquery joins mentor with the mentee\'s artist row, and refers to the outer artist a.', 'b.company_id <> a.company_id is unknown when either is null, so freelance pairs would be lost.', 'is distinct from treats two nulls as equal and a null and a value as different: ... and b.company_id is distinct from a.company_id'] });

  ex({ id: 'sql-x-quiet-2026', level: 2, title: 'Not seen in 2026',
    text: ['List the patrons who have no booking for any performance in 2026 (including those who never booked at all).', '**Answer with** patron_id, name; in any order.'],
    ref: "select p.patron_id, p.name from patron p\nwhere not exists (select * from booking b, performance f\n                  where b.perf_id = f.perf_id and b.patron_id = p.patron_id\n                    and f.perf_date >= date '2026-01-01')",
    wrongs: ['select p.patron_id, p.name from patron p where not exists (select * from booking b where b.patron_id = p.patron_id)', "select distinct p.patron_id, p.name from patron p, booking b, performance f where b.perf_id = f.perf_id and b.patron_id = p.patron_id and f.perf_date < date '2026-01-01'"],
    hints: ['not exists tests that no row matches.', 'The subquery looks for a 2026 booking of this patron.', "select p.patron_id, p.name from patron p where not exists (select * from booking b, performance f where b.perf_id = f.perf_id and b.patron_id = p.patron_id and f.perf_date >= date '2026-01-01')"] });

  ex({ id: 'sql-x-all-own-productions', level: 3, title: 'In every production at home',
    text: ['List the artists who have been cast in every production of their own company. An artist whose company has staged nothing yet qualifies: there is no production they missed. Leave out freelance artists.', '**Answer with** person_id, company_id; in any order.'],
    ref: 'select a.person_id, a.company_id from artist a\nwhere a.company_id is not null\n  and not exists (\n    select p.prod_id from production p where p.company_id = a.company_id\n    except\n    select c.prod_id from casting c where c.person_id = a.person_id)',
    wrongs: ['select a.person_id, a.company_id from artist a, casting c, production p where c.person_id = a.person_id and c.prod_id = p.prod_id and p.company_id = a.company_id group by a.person_id, a.company_id having count(distinct p.prod_id) = (select count(*) from production q where q.company_id = a.company_id)', 'select distinct a.person_id, a.company_id from artist a, casting c, production p where c.person_id = a.person_id and c.prod_id = p.prod_id and p.company_id = a.company_id'],
    hints: ['"Every" becomes: no production of the company is missing from the artist\'s castings.', 'The company\'s productions, minus the artist\'s productions, must be empty.', 'select a.person_id, a.company_id from artist a where a.company_id is not null and not exists (select p.prod_id from production p where p.company_id = a.company_id except select c.prod_id from casting c where c.person_id = a.person_id)'] });

  ex({ id: 'sql-x-every-stage', level: 3, title: 'Every stage of one venue',
    text: ['Find the patrons who have booked a performance on every stage of venue RIV that has hosted at least one performance.', '**Answer with** patron_id, name; in any order.'],
    ref: "select p.patron_id, p.name from patron p\nwhere not exists (\n  select f.stage_no from performance f where f.venue_code = 'RIV'\n  except\n  select f.stage_no from booking b, performance f\n  where b.perf_id = f.perf_id and b.patron_id = p.patron_id and f.venue_code = 'RIV')",
    wrongs: ["select p.patron_id, p.name from patron p where exists (select * from booking b, performance f where b.perf_id = f.perf_id and b.patron_id = p.patron_id and f.venue_code = 'RIV')", "select p.patron_id, p.name from patron p where exists (select * from booking b, performance f where b.perf_id = f.perf_id and b.patron_id = p.patron_id and f.venue_code = 'RIV' and f.stage_no = 1)"],
    hints: ['The stages that count are those that appear in performance for RIV.', 'Subtract the RIV stages this patron has booked; nothing may be left.', "select p.patron_id, p.name from patron p where not exists (select f.stage_no from performance f where f.venue_code = 'RIV' except select f.stage_no from booking b, performance f where b.perf_id = f.perf_id and b.patron_id = p.patron_id and f.venue_code = 'RIV')"] });

  ex({ id: 'sql-x-prods-per-company', level: 2, title: 'Productions per company',
    text: ['For every company, give its name, its budget and the number of productions it has staged (0 if none), using a scalar subquery.', '**Answer with** name, budget, count; one row per company, in any order.'],
    ref: 'select c.name, c.budget, (select count(*) from production p where p.company_id = c.company_id)\nfrom company c',
    alts: ['select c.name, c.budget, count(p.prod_id) from company c left join production p on p.company_id = c.company_id group by c.company_id, c.name, c.budget'],
    wrongs: ['select c.name, c.budget, count(*) from company c, production p where p.company_id = c.company_id group by c.name, c.budget', 'select c.name, c.budget, count(*) from company c left join production p on p.company_id = c.company_id group by c.name, c.budget'],
    hints: ['Start from company.', 'The count goes in a subquery in the select clause.', 'select c.name, c.budget, (select count(*) from production p where p.company_id = c.company_id) from company c'] });

  ex({ id: 'sql-x-above-avg-fee', level: 2, title: 'Better-paid companies',
    text: ['Using a subquery in the from clause, list the companies whose average artist fee is above the average fee of all artists, with that company average rounded to two decimals. Freelance artists count in the overall average but are not a company.', '**Answer with** company_id, average fee; in any order.'],
    ref: 'select company_id, round(avg_fee, 2)\nfrom (select company_id, avg(fee) as avg_fee from artist where company_id is not null group by company_id) as c\nwhere avg_fee > (select avg(fee) from artist)',
    wrongs: ['select company_id, round(avg_fee, 2) from (select company_id, avg(fee) as avg_fee from artist group by company_id) as c where avg_fee > (select avg(fee) from artist)', 'select company_id, round(avg_fee, 2) from (select company_id, avg(fee) as avg_fee from artist where company_id is not null group by company_id) as c where avg_fee < (select avg(fee) from artist)'],
    hints: ['The derived table computes one average per company.', 'Compare it with a scalar subquery for the overall average.', 'select company_id, round(avg_fee, 2) from (select company_id, avg(fee) as avg_fee from artist where company_id is not null group by company_id) as c where avg_fee > (select avg(fee) from artist)'] });

  ex({ id: 'sql-x-fullest-performance', level: 3, title: 'The fullest house',
    text: ['Using `with`, find the performance or performances with the most seats booked. Give the performance ID and the number of seats booked; list every performance that ties for the top.', '**Answer with** perf_id, seats; in any order.'],
    ref: 'with sold as (\n  select perf_id, sum(seats) as n from booking group by perf_id\n)\nselect perf_id, n from sold where n = (select max(n) from sold)',
    wrongs: ['with sold as (select perf_id, count(*) as n from booking group by perf_id) select perf_id, n from sold where n = (select max(n) from sold)', 'select perf_id, sum(seats) from booking group by perf_id order by sum(seats) desc limit 1'],
    hints: ['First add up the seats per performance: a booking can be for up to 8 seats.', 'Then keep the performances whose total is the largest.', 'with sold as (select perf_id, sum(seats) as n from booking group by perf_id) select perf_id, n from sold where n = (select max(n) from sold)'] });

  ex({ id: 'sql-x-above-own-production', level: 2, title: 'Pricier than usual',
    text: ['List the performances whose ticket price is above the average price of the performances of the same production.', '**Answer with** perf_id, prod_id, price; in any order.'],
    ref: 'select f.perf_id, f.prod_id, f.price from performance f\nwhere f.price > (select avg(g.price) from performance g where g.prod_id = f.prod_id)',
    wrongs: ['select f.perf_id, f.prod_id, f.price from performance f where f.price > (select avg(g.price) from performance g)', 'select f.perf_id, f.prod_id, f.price from performance f where f.price >= (select avg(g.price) from performance g where g.prod_id = f.prod_id)'],
    hints: ['A correlated scalar subquery computes the average for the performance\'s own production.', 'Use g for the production\'s performances and f for the outer one.', 'select f.perf_id, f.prod_id, f.price from performance f where f.price > (select avg(g.price) from performance g where g.prod_id = f.prod_id)'] });

  // modification
  ex({ id: 'sql-x-dml-one-star', kind: 'dml', level: 1, title: 'Forget the one-star reviews',
    text: ['Delete every booking rated 1.', '**Answer with** one delete statement. It is checked by counting the bookings per rating afterwards.'],
    ref: 'delete from booking where rating = 1',
    after: 'select rating, count(*) from booking group by rating',
    wrongs: ['delete from booking where rating <= 1 or rating is null', 'delete from booking where rating < 1'],
    hints: ['delete from booking where ...', 'Only the bookings rated exactly 1; unrated bookings stay.', 'delete from booking where rating = 1'] });

  ex({ id: 'sql-x-dml-new-company', kind: 'dml', level: 1, title: 'A new company',
    text: ['Add a company with ID C20, named Night Ferry Theatre, based in Saltreach, founded in 2026, with a budget of 75000.', '**Answer with** one insert statement. It is checked by listing the companies afterwards.'],
    ref: "insert into company values ('C20', 'Night Ferry Theatre', 'Saltreach', 2026, 75000)",
    alts: ["insert into company (company_id, name, city, founded, budget) values ('C20', 'Night Ferry Theatre', 'Saltreach', 2026, 75000)"],
    after: 'select * from company',
    wrongs: ["insert into company (company_id, name, city, budget) values ('C20', 'Night Ferry Theatre', 'Saltreach', 75000)", "insert into company values ('C20', 'Night Ferry Theatre', 'Saltreach', 75000, 2026)"],
    hints: ['insert into company values (...)', 'The attributes are company_id, name, city, founded, budget, in that order.', "insert into company values ('C20', 'Night Ferry Theatre', 'Saltreach', 2026, 75000)"] });

  ex({ id: 'sql-x-dml-ensemble', kind: 'dml', level: 2, title: 'Cast a whole company',
    text: ['Cast every artist of company C05 in production PR153, in the role `Ensemble`, not as a lead. Some of them may already be cast as Ensemble in it; do not cast them twice.', '**Answer with** one insert ... select statement. It is checked by listing who is cast in PR153 afterwards.'],
    ref: "insert into casting\nselect a.person_id, 'PR153', 'Ensemble', false\nfrom artist a\nwhere a.company_id = 'C05'\n  and not exists (select * from casting c where c.person_id = a.person_id and c.prod_id = 'PR153' and c.role_name = 'Ensemble')",
    after: "select person_id, role_name, lead from casting where prod_id = 'PR153'",
    wrongs: ["insert into casting select a.person_id, 'PR153', 'Ensemble', true from artist a where a.company_id = 'C05' and not exists (select * from casting c where c.person_id = a.person_id and c.prod_id = 'PR153' and c.role_name = 'Ensemble')", "insert into casting select a.person_id, 'PR153', 'ensemble', false from artist a where a.company_id = 'C05'"],
    hints: ['insert into casting select ... from artist', 'The constants PR153, Ensemble and false can be columns of the select.', 'A not exists condition skips artists already cast in that role (the primary key would reject them).'] });

  ex({ id: 'sql-x-dml-lan-prices', kind: 'dml', level: 1, title: 'Dearer tickets at one venue',
    text: ['Raise by 10 percent the ticket price of every performance at venue LAN.', '**Answer with** one update statement. It is checked by listing the prices afterwards.'],
    ref: "update performance set price = price * 1.10 where venue_code = 'LAN'",
    after: 'select perf_id, price from performance',
    wrongs: ["update performance set price = price * 0.10 where venue_code = 'LAN'", "update performance set price = price + 10 where venue_code = 'LAN'"],
    hints: ['update performance set price = ...', 'Ten percent more is a factor of 1.10.', "update performance set price = price * 1.10 where venue_code = 'LAN'"] });

  ex({ id: 'sql-x-dml-points', kind: 'dml', level: 2, title: 'Redeem or earn',
    text: ['In one statement: every patron with at least 1000 points redeems 1000 of them, and every other patron earns 25 points.', '**Answer with** one update statement. It is checked by listing the points afterwards.'],
    ref: 'update patron set points = case when points >= 1000 then points - 1000 else points + 25 end',
    after: 'select patron_id, points from patron',
    wrongs: ['update patron set points = points - 1000 where points >= 1000; update patron set points = points + 25 where points < 1000', 'update patron set points = case when points >= 1000 then 0 else points + 25 end'],
    hints: ['Two updates in a row would give the bonus to some who just redeemed.', 'A case expression picks the change for each tuple.', 'update patron set points = case when points >= 1000 then points - 1000 else points + 25 end'] });

  ex({ id: 'sql-x-dml-no-bookings', kind: 'dml', level: 2, title: 'Patrons who never came',
    text: ['Delete the patrons who have never made a booking.', '**Answer with** one delete statement. It is checked by listing the remaining patrons afterwards.'],
    ref: 'delete from patron p where not exists (select * from booking b where b.patron_id = p.patron_id)',
    alts: ['delete from patron where patron_id not in (select patron_id from booking)'],
    after: 'select patron_id from patron',
    wrongs: ['delete from patron where points = 0', 'delete from patron p where not exists (select * from booking b where b.patron_id = p.patron_id and b.rating is not null)'],
    hints: ['A subquery decides which tuples go.', 'not exists finds the patrons without bookings.', 'delete from patron p where not exists (select * from booking b where b.patron_id = p.patron_id)'] });

  ex({ id: 'sql-x-dml-rating-points', kind: 'dml', level: 3, title: 'Points for reviews',
    text: ['Set each patron\'s points to 5 for every booking of theirs that has a rating. A patron who has rated nothing keeps their points.', '**Answer with** one update statement. It is checked by listing the points afterwards.'],
    ref: 'update patron p\nset points = 5 * (select count(b.rating) from booking b where b.patron_id = p.patron_id)\nwhere exists (select * from booking b where b.patron_id = p.patron_id and b.rating is not null)',
    after: 'select patron_id, points from patron',
    wrongs: ['update patron p set points = 5 * (select count(b.rating) from booking b where b.patron_id = p.patron_id)', 'update patron p set points = 5 * (select count(*) from booking b where b.patron_id = p.patron_id) where exists (select * from booking b where b.patron_id = p.patron_id and b.rating is not null)'],
    hints: ['A scalar subquery counts the rated bookings: count(b.rating) skips the nulls.', 'Without a where clause, patrons who rated nothing would get 0.', 'Restrict the update with where exists (select * from booking b where b.patron_id = p.patron_id and b.rating is not null).'] });

  ex({ id: 'sql-x-ddl-tour', kind: 'dml', level: 2, title: 'Create a table',
    text: ['Create a table `tour_date` with these attributes: `tour_id`, an integer, the primary key; `prod_id`, up to 6 characters, referring to a production; `venue_code`, up to 6 characters; `stage_no`, a smallint; and `day`, a date that may not be null. The pair (venue_code, stage_no) must refer to a stage.', '**Answer with** one create table statement. It is checked by reading the columns and constraints from the catalog.'],
    ref: 'create table tour_date (\n  tour_id integer primary key,\n  prod_id varchar(6) references production,\n  venue_code varchar(6),\n  stage_no smallint,\n  day date not null,\n  foreign key (venue_code, stage_no) references stage\n)',
    after: "select c.column_name, c.data_type, c.is_nullable,\n  (select string_agg(t.constraint_type, ', ' order by t.constraint_type) from information_schema.table_constraints t where t.table_name = 'tour_date') as constraints\nfrom information_schema.columns c\nwhere c.table_name = 'tour_date'\norder by c.ordinal_position",
    wrongs: ['create table tour_date (tour_id integer primary key, prod_id varchar(6) references production, venue_code varchar(6), stage_no smallint, day date, foreign key (venue_code, stage_no) references stage)', 'create table tour_date (tour_id integer primary key, prod_id varchar(6) references production, venue_code varchar(6), stage_no smallint, day date not null)'],
    hints: ['varchar(n) holds up to n characters; not null follows the type.', 'A reference can follow the attribute: prod_id varchar(6) references production.', 'A reference to a two-attribute key is a separate line: foreign key (venue_code, stage_no) references stage'] });
})(typeof window !== 'undefined' ? window : globalThis);
