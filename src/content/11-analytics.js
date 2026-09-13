// Chapter 11: data analytics. A data warehouse with a star schema built from the Theatre bookings, the
// OLAP operations (slice, dice, roll-up, drill-down, pivot), cross-tabs and the data cube with GROUPING SETS,
// CUBE and GROUPING(), and data mining in small runnable pieces: association rules, a decision rule and
// k-means clustering. Exercises on OLAP queries and association rules, checked on the Theatre database.
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

  // the star schema of the bookings, built from the Theatre tables (each OLAP lesson starts by running it)
  const STAR = [
    'drop table if exists booking_fact, dim_month, dim_production, dim_venue;',
    "create table dim_month as\n  select row_number() over (order by m) :: int as month_id,\n         m as month_start,\n         extract(month from m) :: int as month_no,\n         case when extract(month from m) >= 9 then extract(year from m) :: int else extract(year from m) :: int - 1 end as season_start,\n         case when extract(month from m) >= 9 then extract(year from m) :: int else extract(year from m) :: int - 1 end || '-' ||\n           right((case when extract(month from m) >= 9 then extract(year from m) :: int + 1 else extract(year from m) :: int end) :: text, 2) as season\n  from (select distinct date_trunc('month', perf_date) :: date as m from performance) as t;",
    'alter table dim_month add primary key (month_id);',
    'create table dim_production as\n  select p.prod_id, p.title, p.genre, c.name as company, c.city as company_city\n  from production p join company c on c.company_id = p.company_id;',
    'alter table dim_production add primary key (prod_id);',
    'create table dim_venue as\n  select venue_code, venue_name, city from venue;',
    'alter table dim_venue add primary key (venue_code);',
    "create table booking_fact as\n  select b.booking_id, b.patron_id, f.prod_id, f.venue_code, dm.month_id, b.seats, b.paid, b.rating\n  from booking b\n    join performance f on f.perf_id = b.perf_id\n    join dim_month dm on dm.month_start = date_trunc('month', f.perf_date) :: date;",
    'alter table booking_fact add foreign key (month_id) references dim_month;\nalter table booking_fact add foreign key (prod_id) references dim_production;\nalter table booking_fact add foreign key (venue_code) references dim_venue;',
  ].join('\n');
  const STAR_NOTE = 'This builds the star schema of the first lesson of this chapter from the Theatre tables. It drops and rebuilds the tables, so it is safe to run again.';
  const DROP_STAR = 'drop table booking_fact, dim_month, dim_production, dim_venue;';
  const JOIN = 'from booking_fact f\n  join dim_production p using (prod_id)\n  join dim_venue v using (venue_code)\n  join dim_month m using (month_id)';

  // ---- 11.2 data warehousing ----------------------------------------------------------------------------------------------
  lesson({
    id: 'ana-warehouse', chapter: 11, title: 'Data warehouses and the star schema', minutes: 14,
    summary: 'Analysis runs on a separate copy of the data, reshaped for questions rather than updates: a fact table of events surrounded by dimension tables that describe them.',
    body: [
      'The Theatre database is built for **transaction processing**: many small reads and updates (book two seats, record a rating), each touching a few rows. **Data analysis** asks different questions: how have bookings for each genre changed from one season to the next, city by city? Such a query reads a large part of the data and changes none of it. Running it on the transaction system slows everyone down, and the data it needs is often spread over several systems.',
      'So organizations keep a **data warehouse**: a separate database that collects data from the operational systems, cleans and integrates it, keeps its history, and is organized for analysis. Data is brought in by **ETL**: **extract** from the sources, **transform** (clean, convert codes, look up keys, aggregate), **load** into the warehouse, typically every night. When the warehouse stores the raw data and transforms it afterwards, inside the warehouse, the order is ELT.',
      { h: 'Facts and dimensions' },
      'A warehouse schema is built around **facts**: the events being analysed, here bookings. A fact has **measures**, numbers to add up or average (seats, the amount paid, the rating), and **dimension** attributes, which say what, where and when. Each dimension has a table of its own describing its values. With the fact table in the middle and the dimension tables around it, the diagram looks like a star, so this is a **star schema**:',
      { table: [['Table', 'Kind', 'Holds'], ['booking_fact', 'fact table', 'one row per booking: production, venue, month, patron, and the seats, the amount paid and the rating as measures'], ['dim_production', 'dimension', 'each production: title, genre and company (production within genre)'], ['dim_venue', 'dimension', 'each venue: its name and city (venue within city)'], ['dim_month', 'dimension', 'each month with performances: its number and its season, September to June (month within season)']] },
      'Build it from the Theatre tables. This is a small ETL job: the transform step gives every month a key, places each month in its season, and copies the company\'s name onto each production:',
      { sql: STAR + "\nselect (select count(*) from booking_fact) as facts,\n       (select count(*) from dim_month) as months,\n       (select count(*) from dim_production) as productions,\n       (select count(*) from dim_venue) as venues;" },
      'Questions are joins of the fact table with the dimensions they need, grouped by dimension attributes. Bookings, seats and the average rating per genre in the 2024-25 season:',
      { sql: "select p.genre,\n       count(*) as bookings,\n       sum(f.seats) as seats,\n       round(avg(f.rating), 2) as avg_rating\n" + JOIN + "\nwhere m.season = '2024-25'\ngroup by p.genre\norder by seats desc;", note: 'avg ignores the nulls of unrated bookings, so they do not drag the averages down.' },
      { predict: { q: 'A company changes its name. In the star schema, what has to change?', options: ['One column in the dim_production rows of that company', 'Every fact row of that company\'s productions', 'Nothing: the warehouse never changes'], answer: 0, explain: 'Dimension attributes live in the dimension table, not in the facts. Whether the old name should be kept for old facts is a design question of its own: a **slowly changing dimension** keeps a new dimension row per version, with dates, much like the temporal tables of chapter 7.' } },
      { h: 'Variations and storage' },
      { list: ['A **snowflake schema** normalizes the dimensions further: company as a table of its own referenced by dim_production. It saves space and costs joins.', 'Several fact tables can share dimensions: a fact table of casting fees would use the same dim_production.', 'Warehouses usually store tables **column by column**: a query that reads three columns of a wide fact table reads only those, and a column of similar values compresses very well.', 'A **data lake** keeps raw data in files, in whatever format it came, and structures it only when it is read. It is cheaper to load and harder to query.'] },
      { sql: DROP_STAR },
    ],
  });

  // ---- 11.3 OLAP operations -------------------------------------------------------------------------------------------------
  lesson({
    id: 'ana-olap', chapter: 11, title: 'OLAP: slice, dice, roll up, drill down, pivot', minutes: 14,
    summary: 'Online analytical processing treats the facts as a cube with one axis per dimension. A handful of operations move around it: fix a value, restrict ranges, aggregate up a hierarchy or go back down, and turn rows into columns.',
    body: [
      'Picture the bookings as a **data cube**: one axis for genres, one for cities, one for seasons, and in each cell the number of bookings with those three values. **OLAP** (online analytical processing) tools let an analyst move around this cube interactively, each move a query. First, build the star schema:',
      { sql: STAR, note: STAR_NOTE },
      { h: 'Slice and dice' },
      'A **slice** fixes one dimension to a single value, leaving a cube with one dimension fewer. The 2025-26 slice, by genre and city:',
      { sql: "select p.genre, v.city, count(*) as bookings\n" + JOIN + "\nwhere m.season = '2025-26'\ngroup by p.genre, v.city\norder by p.genre, v.city;" },
      'A **dice** restricts several dimensions to ranges or sets of values. Two genres, two cities, and only bookings rated 4 or 5:',
      { sql: "select p.genre, v.city, count(*) as well_rated\n" + JOIN + "\nwhere p.genre in ('opera', 'tragedy')\n  and v.city in ('Brightwater', 'Easterholm')\n  and f.rating >= 4\ngroup by p.genre, v.city\norder by p.genre, v.city;" },
      { h: 'Roll up and drill down' },
      'Dimensions often have **hierarchies**: month within season, venue within city, production within genre. **Rolling up** moves to a coarser level and aggregates; **drilling down** moves to a finer level. Seats booked for musicals per season, then drilled down to months:',
      { sql: "select m.season, sum(f.seats) as seats\n" + JOIN + "\nwhere p.genre = 'musical'\ngroup by m.season\norder by m.season;" },
      { predict: { q: 'Drill down from season to month for musicals. How do the monthly figures of 2024-25 relate to the 2024-25 row above?', options: ['They add up to it exactly', 'They are each about a tenth of it, but need not add up', 'They are larger, because each month is counted separately'], answer: 0, explain: 'Every booking belongs to exactly one month of one season, so the finer groups partition the coarser one. count and sum roll up exactly; an average does not (the average of averages is not the overall average), which is why tools keep sums and counts and divide at the end.' }, sql: "select m.month_start, sum(f.seats) as seats\n" + JOIN + "\nwhere p.genre = 'musical' and m.season = '2024-25'\ngroup by m.month_start\norder by m.month_start;" },
      'Rolling up the venue dimension to cities works the same way, through the city attribute of dim_venue:',
      { sql: 'select v.city, count(*) as bookings, sum(f.paid) as takings\nfrom booking_fact f join dim_venue v using (venue_code)\ngroup by v.city\norder by takings desc;' },
      { h: 'Pivot' },
      'A **pivot** turns the values of one dimension into columns. Each column is an aggregate restricted with `filter`; `case` inside the aggregate does the same in systems without filter:',
      { sql: "select p.genre,\n       count(*) filter (where m.season = '2024-25') as season_2024_25,\n       count(*) filter (where m.season = '2025-26') as season_2025_26,\n       sum(case when v.city = 'Brightwater' then 1 else 0 end) as in_brightwater\n" + JOIN + "\ngroup by p.genre\norder by p.genre;", note: 'The columns have to be written out: SQL needs to know a query\'s columns before it runs. OLAP tools generate this query from the values they find.' },
      { tip: 'OLAP systems that store the cube in special multidimensional arrays are called MOLAP; those that run SQL on a star schema, as here, are ROLAP; hybrids precompute some aggregates and query the rest. Most warehouses today are ROLAP on column stores.' },
      { sql: DROP_STAR },
    ],
  });

  // ---- 11.3 cross-tabs and the cube ----------------------------------------------------------------------------------------
  lesson({
    id: 'ana-cube', chapter: 11, title: 'Cross-tabs and the data cube in SQL', minutes: 13,
    summary: 'A cross-tab shows one dimension down the side, another across the top, and totals in the margins. GROUPING SETS, ROLLUP and CUBE compute all the groupings at once, and GROUPING() tells a total from a null.',
    body: [
      'A **cross-tabulation** (cross-tab, or pivot table) has the values of one dimension as rows, another as columns, aggregates in the cells, and totals along the edges. The margins are themselves aggregates at a coarser level: a row total ignores the column dimension. Build the star, then a cross-tab of well rated, poorly rated and unrated bookings for three genres:',
      { sql: STAR, note: STAR_NOTE },
      { sql: "select coalesce(p.genre, 'Total') as genre,\n       count(*) filter (where f.rating >= 4) as liked,\n       count(*) filter (where f.rating <= 3) as not_liked,\n       count(*) filter (where f.rating is null) as unrated,\n       count(*) as total\nfrom booking_fact f join dim_production p using (prod_id)\nwhere p.genre in ('comedy', 'opera', 'revue')\ngroup by rollup (p.genre)\norder by grouping(p.genre), p.genre;" },
      { h: 'The cube' },
      'With n dimensions there are 2ⁿ groupings, one for each subset of the dimensions: the detail, every partial total, and the grand total. The **data cube** is all of them together. `group by cube (a, b)` computes the groupings (a, b), (a), (b) and ():',
      { predict: { q: 'Group the bookings for drama and musicals in both seasons by cube (genre, season). How many rows come back?', options: ['9: 4 cells, 2 genre totals, 2 season totals and the grand total', '4', '7', '8'], answer: 0, explain: 'Two genres times two seasons gives four cells. cube adds the total of each genre over the seasons (2), of each season over the genres (2), and one grand total: 4 + 2 + 2 + 1 = 9.' }, sql: "select p.genre, m.season, count(*) as bookings\n" + JOIN + "\nwhere p.genre in ('drama', 'musical')\ngroup by cube (p.genre, m.season)\norder by p.genre, m.season;" },
      'In the total rows, the attributes that were aggregated away are shown as null. SQL calls that the value **all**. But a dimension can contain real nulls, and then a null in the result is ambiguous. `grouping(a)` is 1 when a was aggregated away in that row and 0 when it is a real value; with several arguments it returns a bit pattern. Some patrons have given no city:',
      { sql: "select case grouping(city) when 1 then 'all cities' else coalesce(city, '(no city)') end as city,\n       count(*) as patrons,\n       grouping(city) as is_total\nfrom patron\ngroup by rollup (city)\norder by is_total, city nulls last;", note: 'Without grouping() the row of patrons with no city and the grand total would both show a null city.' },
      { h: 'Choosing the groupings' },
      '`rollup (a, b, c)` follows a hierarchy: (a, b, c), (a, b), (a) and (). `grouping sets` lists exactly the groupings wanted. Totals per city and per season, and nothing else, in one pass:',
      { sql: "select v.city, m.season, count(*) as bookings,\n       grouping(v.city, m.season) as level\n" + JOIN + "\ngroup by grouping sets ((v.city), (m.season))\norder by level, v.city, m.season;", note: 'level is 1 for the per-city rows (season aggregated away) and 2 for the per-season rows.' },
      'A warehouse that answers the same cube queries all day can store some of the groupings as **materialized views** and answer coarser ones from them: totals per genre can be computed from stored totals per genre and season without touching the facts.',
      { sql: DROP_STAR },
    ],
  });

  // ---- 11.4 data mining ---------------------------------------------------------------------------------------------------------
  lesson({
    id: 'ana-mining', chapter: 11, title: 'Data mining: rules, classifiers and clusters', minutes: 15,
    summary: 'Data mining looks for patterns nobody asked about. Three small examples in SQL: association rules with support and confidence, a classification rule and its accuracy, and k-means clustering step by step.',
    body: [
      'OLAP answers questions an analyst thinks of. **Data mining** searches the data for patterns worth knowing: which items are bought together, which applicants are likely to repay a loan, which customers resemble each other. The methods come from statistics and machine learning; here are three of the simplest, small enough to run in SQL.',
      { h: 'Association rules' },
      'The theatre café records which items each interval order contained. An **association rule** A ⇒ B says that orders containing A tend to contain B. Two numbers measure it: **support**, the fraction of all orders containing both A and B, and **confidence**, the fraction of orders containing A that also contain B.',
      { sql: "drop table if exists basket;\ncreate table basket (order_no int, item text, primary key (order_no, item));\ninsert into basket values\n  (1, 'coffee'), (1, 'croissant'), (2, 'coffee'), (2, 'muffin'), (3, 'tea'), (3, 'croissant'),\n  (4, 'coffee'), (4, 'croissant'), (4, 'juice'), (5, 'coffee'), (6, 'tea'), (6, 'muffin'),\n  (7, 'coffee'), (7, 'croissant'), (8, 'juice'), (8, 'croissant');\nselect item, count(*) as orders from basket group by item order by orders desc, item;" },
      'Every rule between two items, with its support and confidence. A self-join pairs the items of each order:',
      { sql: "with n as (select count(distinct order_no)::numeric as n from basket),\n     item_count as (select item, count(*) as k from basket group by item)\nselect a.item as if_bought, b.item as then_bought,\n       round(count(*) / (select n from n), 2) as support,\n       round(count(*)::numeric / ic.k, 2) as confidence\nfrom basket a join basket b on a.order_no = b.order_no and a.item <> b.item\n  join item_count ic on ic.item = a.item\ngroup by a.item, b.item, ic.k\nhaving count(*) >= 2\norder by confidence desc, support desc, if_bought;" },
      { predict: { q: 'coffee ⇒ croissant and croissant ⇒ coffee have the same support. Do they have the same confidence?', options: ['Not necessarily: confidence divides by the orders with the left-hand item, and the two items can appear in different numbers of orders', 'Yes, always', 'Only if both items are equally expensive'], answer: 0, explain: 'Support counts orders with both, so it is symmetric. Confidence of A ⇒ B is support(A and B) / support(A). Coffee is in 5 orders and croissant in 5 too here, so the confidences happen to be equal; change one order and they differ.' } },
      'Real data has millions of orders and thousands of items, so mining algorithms such as **Apriori** first find the itemsets with enough support (an itemset can only be frequent if all its subsets are) and only build rules from those.',
      { h: 'Classification' },
      'A **classifier** predicts a class (pass or fail, approve or decline) from attributes, having learned from examples whose class is known. A **decision tree** asks one question per node: is attendance above 70%? Then, did the student submit the coursework? Each leaf names a class. The simplest tree is a single rule, and its quality is its **accuracy** on data it was not built from:',
      { sql: "drop table if exists outcome;\ncreate table outcome (student text, attendance int, submitted boolean, passed boolean);\ninsert into outcome values\n  ('s1', 92, true, true), ('s2', 85, true, true), ('s3', 40, false, false), ('s4', 75, false, true),\n  ('s5', 60, true, true), ('s6', 30, true, false), ('s7', 88, false, false), ('s8', 55, false, false),\n  ('s9', 97, true, true), ('s10', 65, false, false);\nselect count(*) filter (where (attendance >= 70) = passed) as right_by_attendance,\n       count(*) filter (where (attendance >= 50 and submitted) = passed) as right_by_tree,\n       count(*) as students\nfrom outcome;", note: 'The two-question rule (attended at least half and submitted) classifies more of these students correctly than attendance alone.' },
      'Other classifiers include **Bayesian** classifiers (which estimate how likely each class is given the attributes), **support vector machines**, and **neural networks**. **Regression** predicts a number instead of a class.',
      { h: 'Clustering' },
      '**Clustering** groups items so that items in a group are close to each other and far from other groups, without any classes given. **k-means** picks k centres, assigns each item to the nearest centre, moves each centre to the mean of its items, and repeats. Two clusters of patrons by loyalty points, starting from centres at 100 and 600:',
      { sql: "with c0(cluster, centre) as (values (1, 100.0), (2, 600.0)),\n     a1 as (select p.patron_id, p.points,\n                   (select c.cluster from c0 c order by abs(p.points - c.centre), c.cluster limit 1) as cluster\n            from patron p),\n     c1 as (select cluster, avg(points) as centre from a1 group by cluster),\n     a2 as (select p.patron_id, p.points,\n                   (select c.cluster from c1 c order by abs(p.points - c.centre), c.cluster limit 1) as cluster\n            from patron p)\nselect a2.cluster, count(*) as patrons, min(a2.points) as low, max(a2.points) as high,\n       round(avg(a2.points), 1) as new_centre\nfrom a2\ngroup by a2.cluster\norder by a2.cluster;", note: 'Two rounds. Another round would barely move the centres: the algorithm has nearly converged.' },
      { tip: 'Results of mining must be checked against data that was not used to find them, or a pattern may simply be noise in the sample. With enough attributes, something always looks significant.' },
      { sql: 'drop table basket, outcome;' },
    ],
  });

  // ---- exercises -------------------------------------------------------------------------------------------------------------
  const ex = (x) => C.exercise(Object.assign({ chapter: 11, db: 'theatre' }, x));
  const BOOKED = 'from booking b\n  join performance f on f.perf_id = b.perf_id\n  join production p on p.prod_id = f.prod_id\n  join venue v on v.venue_code = f.venue_code';

  ex({ id: 'ana-x-rollup', level: 2, title: 'Bookings with subtotals',
    text: ['Count bookings by the genre of the production and the city of the venue, with a subtotal for each genre and a grand total, using `rollup`. Return genre, city and the count; leave the rolled-up columns null.'],
    ref: 'select p.genre, v.city, count(*) as bookings\n' + BOOKED + '\ngroup by rollup (p.genre, v.city)',
    wrongs: ['select p.genre, v.city, count(*) as bookings\n' + BOOKED + '\ngroup by rollup (v.city, p.genre)', 'select p.genre, v.city, count(*) as bookings\n' + BOOKED + '\ngroup by p.genre, v.city'],
    hints: ['A booking reaches its genre through performance and production, and its city through performance and venue.', 'group by rollup (a, b) gives (a, b), (a) and ().', 'The order of the columns in rollup decides the hierarchy: genre first, then city.'] });

  ex({ id: 'ana-x-cube', level: 2, title: 'A small cube',
    text: ['For performances in 2025, count the performances by venue and by kind of stage, together with the totals per venue, per kind and overall, using `cube`. Return venue_code, kind and the count.'],
    ref: "select f.venue_code, s.kind, count(*) as performances\nfrom performance f join stage s on s.venue_code = f.venue_code and s.stage_no = f.stage_no\nwhere f.perf_date between date '2025-01-01' and date '2025-12-31'\ngroup by cube (f.venue_code, s.kind)",
    wrongs: ["select f.venue_code, s.kind, count(*) as performances from performance f join stage s on s.venue_code = f.venue_code and s.stage_no = f.stage_no where f.perf_date between date '2025-01-01' and date '2025-12-31' group by rollup (f.venue_code, s.kind)"],
    hints: ['The kind of a stage is in stage: join on both venue_code and stage_no.', 'Filter the year first, in where.', 'group by cube (venue_code, kind) computes all four groupings; do not coalesce the nulls of the totals.'] });

  ex({ id: 'ana-x-sets', level: 2, title: 'Exactly the totals you want',
    text: ['In one query, give the number of bookings per genre (with city null) and per venue city (with genre null), and nothing else: no detail rows and no grand total. Return genre, city and the count.'],
    ref: 'select p.genre, v.city, count(*) as bookings\n' + BOOKED + '\ngroup by grouping sets ((p.genre), (v.city))',
    wrongs: ['select p.genre, v.city, count(*) as bookings\n' + BOOKED + '\ngroup by cube (p.genre, v.city)'],
    hints: ['grouping sets lists the groupings explicitly.', 'Each grouping is a parenthesized list of columns.', 'group by grouping sets ((p.genre), (v.city))'] });

  ex({ id: 'ana-x-pivot', level: 2, title: 'A pivot with filter',
    text: ['For each genre, return the genre and three columns: the number of bookings for performances in 2024, in 2025 and in 2026. Genres nobody booked need not appear.'],
    ref: "select p.genre,\n       count(*) filter (where extract(year from f.perf_date) = 2024) as y2024,\n       count(*) filter (where extract(year from f.perf_date) = 2025) as y2025,\n       count(*) filter (where extract(year from f.perf_date) = 2026) as y2026\nfrom booking b\n  join performance f on f.perf_id = b.perf_id\n  join production p on p.prod_id = f.prod_id\ngroup by p.genre",
    wrongs: ["select p.genre, count(*) filter (where extract(year from f.perf_date) = 2024) as y2024, count(*) filter (where extract(year from f.perf_date) = 2025) as y2025, count(*) as y2026 from booking b join performance f on f.perf_id = b.perf_id join production p on p.prod_id = f.prod_id group by p.genre"],
    hints: ['Group by genre; each column is an aggregate over the group.', 'count(*) filter (where ...) counts only the rows that satisfy a condition.', 'Or sum(case when extract(year from f.perf_date) = 2024 then 1 else 0 end).'] });

  ex({ id: 'ana-x-dice', level: 1, title: 'A dice of the bookings',
    text: ['Dice the bookings: only productions of the drama or tragedy genres, only venues in Brightwater or Vantmoor, and only rated bookings (rating not null). Return genre, city and the number of bookings for each combination.'],
    ref: "select p.genre, v.city, count(*) as bookings\n" + BOOKED + "\nwhere p.genre in ('drama', 'tragedy')\n  and v.city in ('Brightwater', 'Vantmoor')\n  and b.rating is not null\ngroup by p.genre, v.city",
    wrongs: ["select p.genre, v.city, count(*) as bookings\n" + BOOKED + "\nwhere p.genre in ('drama', 'tragedy') and v.city in ('Brightwater', 'Vantmoor')\ngroup by p.genre, v.city"],
    hints: ['A dice is a where clause restricting several dimensions.', 'in (...) lists the allowed values.', 'Then group by the two remaining dimensions.'] });

  ex({ id: 'ana-x-grouping', level: 3, title: 'Telling totals from nulls',
    text: ['Sum the patrons\' loyalty points by city with a grand total, using `rollup`. Return a label and the sum. The label is the city; for patrons with no city it is null; for the grand total row it is the text `all cities`. (Use grouping(), since a city can really be null.)'],
    ref: "select case when grouping(city) = 1 then 'all cities' else city end as label,\n       sum(points) as total\nfrom patron\ngroup by rollup (city)",
    wrong: "select coalesce(city, 'all cities') as label, sum(points) as total\nfrom patron\ngroup by rollup (city)",
    hints: ['grouping(city) is 1 in the row where city was rolled up.', 'coalesce cannot tell the grand total from a real null city.', "case when grouping(city) = 1 then 'all cities' else city end"] });

  ex({ id: 'ana-x-pairs', level: 2, title: 'Frequent pairs of productions',
    text: ['Treat each patron as a basket and the productions they booked (any performance of them) as its items. Return every pair of productions (first prod_id alphabetically before the second) booked by at least 14 of the same patrons, with the number of such patrons.'],
    ref: 'with item as (\n  select distinct b.patron_id, f.prod_id\n  from booking b join performance f on f.perf_id = b.perf_id\n)\nselect a.prod_id as first, c.prod_id as second, count(*) as patrons\nfrom item a join item c on a.patron_id = c.patron_id and a.prod_id < c.prod_id\ngroup by a.prod_id, c.prod_id\nhaving count(*) >= 14',
    wrongs: ['select f1.prod_id as first, f2.prod_id as second, count(*) as patrons from booking b1 join performance f1 on f1.perf_id = b1.perf_id join booking b2 on b2.patron_id = b1.patron_id join performance f2 on f2.perf_id = b2.perf_id and f1.prod_id < f2.prod_id group by f1.prod_id, f2.prod_id having count(*) >= 14'],
    hints: ['First reduce the bookings to (patron, production) pairs, each once: a patron may book several performances of one production.', 'Self-join those pairs on the patron; a.prod_id < c.prod_id keeps each pair once and drops a production paired with itself.', 'Count per pair and keep the groups with at least 14 patrons.'] });

  ex({ id: 'ana-x-confidence', level: 3, title: 'Confidence of a rule',
    text: ['For the rule "booked PR101 ⇒ booked PR106" (patrons as baskets, any performance of a production counts), return one row: the number of patrons who booked PR101, the number who booked both, and the confidence (both divided by PR101 bookers) as a numeric rounded to 2 places.'],
    ref: "with a as (select distinct b.patron_id from booking b join performance f on f.perf_id = b.perf_id where f.prod_id = 'PR101'),\n     c as (select distinct b.patron_id from booking b join performance f on f.perf_id = b.perf_id where f.prod_id = 'PR106')\nselect (select count(*) from a) as booked_a,\n       (select count(*) from a join c using (patron_id)) as booked_both,\n       round((select count(*) from a join c using (patron_id))::numeric / (select count(*) from a), 2) as confidence",
    wrongs: ["with a as (select distinct b.patron_id from booking b join performance f on f.perf_id = b.perf_id where f.prod_id = 'PR101'),\n     c as (select distinct b.patron_id from booking b join performance f on f.perf_id = b.perf_id where f.prod_id = 'PR106')\nselect (select count(*) from a) as booked_a,\n       (select count(*) from a join c using (patron_id)) as booked_both,\n       round((select count(*) from a join c using (patron_id))::numeric / (select count(*) from c), 2) as confidence"],
    hints: ['Find the set of patrons who booked each production, each patron once.', 'The patrons who booked both are the intersection (or a join on patron_id).', 'Divide by the number who booked PR101, the left-hand side of the rule, and cast to numeric first.'] });

  ex({ id: 'ana-x-top-genre', level: 3, title: 'The most booked genre each year',
    text: ['For each year, return the year, the genre with the most bookings for performances in that year, and that number. If two genres tie, return both.'],
    ref: 'select year, genre, bookings\nfrom (select extract(year from f.perf_date)::int as year, p.genre, count(*) as bookings,\n             rank() over (partition by extract(year from f.perf_date)::int order by count(*) desc) as r\n      from booking b\n        join performance f on f.perf_id = b.perf_id\n        join production p on p.prod_id = f.prod_id\n      group by extract(year from f.perf_date)::int, p.genre) as ranked\nwhere r = 1',
    ordered: false,
    hints: ['First count bookings per year and genre.', 'rank() over (partition by year order by the count desc) numbers the genres within each year; ties share a rank.', 'Keep the rows with rank 1, in an outer query.'] });
})(typeof window !== 'undefined' ? window : globalThis);
