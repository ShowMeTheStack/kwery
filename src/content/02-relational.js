// Chapter 2: the relational model. Relations and their schemas, keys, schema diagrams and the relational algebra.
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
  const ra = (expr, label) => ({ view: 'algebra', sel: { expr }, label: label || 'Try it in the algebra workbench' });

  lesson({
    id: 'rel-relations', chapter: 2, title: 'Relations, tuples and domains', minutes: 10,
    summary: 'A table is a relation, a row is a tuple, a column is an attribute. The schema stays put while the instance changes.',
    body: [
      'The relational model rests on a handful of ideas, and one table shows them all. Look at the theatre companies:',
      { sql: 'select * from company;' },
      { def: 'Relation.', text: 'A table. Mathematically it is a set of tuples, and the name comes from there: each tuple relates a few values to one another.' },
      { def: 'Tuple.', text: 'A row. In `company`, a tuple such as (C01, Brightwater Stage Society, Brightwater, 1954, 154500.00) says that company C01 has that name, is based in Brightwater, was founded in 1954 and has that budget.' },
      { def: 'Attribute.', text: 'A named column: `company_id`, `name`, `city`, `founded`, `budget`.' },
      { def: 'Domain.', text: 'The set of values an attribute may take. The domain of `budget` is the positive numbers with at most twelve digits, two of them after the decimal point.' },
      'The model asks that every domain be **atomic**: a value is not made of parts the database knows about. A city stored as one string is atomic; a column holding a list of the cities a company tours to is not.',
      { h: 'Order does not matter' },
      'A relation is a set, so its tuples come in no particular order. These two queries return the same relation, shown in two different orders:',
      { sql: 'select * from company order by budget;\nselect * from company order by city, name;' },
      { h: 'Schema and instance' },
      'The **relation schema** names the attributes and their domains. Written compactly, with the primary key first:',
      { p: '`company (company_id, name, city, founded, budget)`' },
      'The **relation instance** is the set of tuples it holds at one moment. The schema seldom changes; the instance changes whenever a company is founded, a patron books or a price goes up. The schema is kept in the data dictionary:',
      { sql: "select column_name, data_type, is_nullable\nfrom information_schema.columns\nwhere table_name = 'company';" },
      'Change the instance inside a transaction, so that you can undo it:',
      { sql: "begin;\ninsert into company values ('C99', 'Wrenfield Players', 'Wrenfield', 2024, 80000);\nselect count(*) from company;" },
      { predict: { q: 'The insert added a tuple. What changed?', options: ['The instance only', 'The schema only', 'Both the schema and the instance'], answer: 0, explain: 'The five attributes are still the same five; only the set of tuples grew. Adding or dropping a column would change the schema.' }, sql: 'rollback;\nselect count(*) from company;' },
      { h: 'Values outside the domain' },
      'The database refuses a value that lies outside an attribute\'s domain. A stage must be one of five kinds, and a cellar is not one of them:',
      { sql: "insert into stage values ('RIV', 9, 40, 'cellar');", fails: '23514', note: 'This fails on purpose: read the error message.' },
      { h: 'The null value' },
      'One special value belongs to every domain: **null**, meaning that the value is unknown or does not apply. Freelance artists belong to no company, so their `company_id` is null:',
      { sql: 'select * from artist where company_id is null;' },
      'Nulls make queries subtle, and chapter 3 gives them a lesson of their own. Where a design can avoid them, it usually should.',
    ],
  });

  lesson({
    id: 'rel-keys', chapter: 2, title: 'Keys', minutes: 12,
    summary: 'Superkeys, candidate keys and primary keys say which attributes identify a tuple; foreign keys say which values must exist elsewhere.',
    body: [
      'We need a way to say that two tuples of a relation may never agree on certain attributes. Keys say exactly that.',
      { def: 'Superkey.', text: 'A set of attributes whose values pick out a single tuple: no two tuples of any legal instance agree on all of them.' },
      'In `artist`, the attribute `person_id` is a superkey. A query can confirm that the current instance obeys it: group by `person_id` and look for a group with more than one tuple.',
      { sql: 'select person_id, count(*)\nfrom artist\ngroup by person_id\nhaving count(*) > 1;', note: 'No rows: no two artists share a person_id.' },
      'Compare `company_id`, which is not a superkey of `artist`: a company has several artists.',
      { sql: 'select company_id, count(*)\nfrom artist\ngroup by company_id\nhaving count(*) > 1;' },
      'Any set that contains a superkey is a superkey too: {person_id, fee} also identifies an artist. It just says more than it needs to.',
      { def: 'Candidate key.', text: 'A minimal superkey: take away any attribute and it is no longer a superkey. {person_id} is a candidate key of `artist`; {person_id, fee} is not.' },
      { def: 'Primary key.', text: 'The candidate key the designer picks as the usual way of identifying tuples. A schema underlines it, or lists it first.' },
      'A relation can have several candidate keys. `company` is identified by `company_id`, but its `name` is declared unique as well, so {name} is a second candidate key. The designer chose the short code as the primary key.',
      { h: 'A key is a promise about every instance' },
      'No two venues have the same name at the moment:',
      { sql: 'select venue_name, count(*)\nfrom venue\ngroup by venue_name\nhaving count(*) > 1;' },
      { predict: { q: 'No two venues share a name in this instance. Does that make {venue_name} a candidate key of `venue`?', options: ['No: nothing stops a second venue with the same name from opening', 'Yes: the query proves it', 'Yes, until a new venue opens'], answer: 0, explain: 'A key is a rule about every legal instance, decided by what the data means, not by the rows that happen to be there. One instance can show that something is *not* a key (several patrons share a name, for instance), but never that it is.' }, sql: 'select name, count(*)\nfrom patron\ngroup by name\nhaving count(*) > 1\norder by name;' },
      'A key can have several attributes. A stage is identified by its venue and its number together: many venues have a stage 2.',
      { sql: 'select * from stage where stage_no = 2;' },
      'The database enforces a primary key and refuses a second tuple with the same key:',
      { sql: "insert into company values ('C01', 'Second Society', 'Wrenfield', 2020, 50000);", fails: '23505' },
      { h: 'Foreign keys' },
      'Every production belongs to a company that exists. This is a **foreign-key constraint**: `production.company_id` references `company`. `production` is the *referencing* relation and `company` the *referenced* one.',
      'A query that looks for productions of a missing company finds none:',
      { sql: 'select p.prod_id, p.company_id\nfrom production p\nwhere not exists (select * from company c where c.company_id = p.company_id);' },
      'And the database refuses to create one:',
      { sql: "insert into production values ('PR999', 'Nobody\'\'s Play', 'C99', 'drama', null, 90, null);", fails: '23503' },
      'A foreign key can span several attributes. A performance names a venue and a stage number, and the pair (venue_code, stage_no) must be a stage that exists. Neither half alone would be enough: venue RIV exists, and so does some stage 3, but that does not mean RIV has a stage 3.',
      { sql: "select f.perf_id, f.venue_code, f.stage_no, s.seats\nfrom performance f join stage s on s.venue_code = f.venue_code and s.stage_no = f.stage_no\nwhere f.perf_id <= 5;" },
      'A foreign key may also point back into its own relation. `production.based_on` names another production that this one adapts or continues, and `mentor` pairs two artists. Chapter 5 follows such chains as far as they go.',
      { h: 'Schema diagrams' },
      'A **schema diagram** draws each relation as a box listing its attributes, with the primary key marked and an arrow for each foreign key, from the referencing attributes to the referenced relation.',
      { view: 'erd', label: 'Open the schema diagram of the Theatre database' },
    ],
  });

  lesson({
    id: 'rel-algebra-basic', chapter: 2, title: 'Relational algebra: select, project and set operations', minutes: 14,
    summary: 'The algebra builds new relations from old ones. Selection picks tuples, projection picks attributes, and union, difference and intersection combine relations.',
    body: [
      'The **relational algebra** is a small set of operations. Each one takes one or two relations and returns a relation, so the result of one can feed the next. SQL rests on the same ideas, and seeing them bare makes SQL easier to read.',
      { h: 'Selection: σ' },
      'Selection keeps the tuples that satisfy a predicate, written as a subscript (here in brackets). The operas are',
      { p: "`σ[genre = 'opera'](production)`" },
      ra("σ[genre = 'opera'](production)"),
      'The predicate compares attributes with constants or with each other, using =, ≠, <, ≤, >, ≥, and joins comparisons with ∧ (and), ∨ (or) and ¬ (not). In SQL, selection is the `where` clause:',
      { sql: "select * from production\nwhere genre = 'opera' and runtime_min > 150;" },
      { h: 'Projection: π' },
      'Projection keeps only some attributes. The algebra works with sets, so tuples that become equal are merged into one.',
      { p: '`π[city](company)`' },
      ra('π[city](company)'),
      { predict: { q: 'There are 12 companies. How many rows does `select city from company` return?', options: ['12, one per company', 'One per distinct city', 'One per venue'], answer: 0, explain: 'SQL keeps duplicates unless told otherwise, so each company contributes a row, even when several share a city. The algebra\'s π returns each city once. `select distinct` gives the set.' }, sql: 'select city from company;\nselect distinct city from company;' },
      { h: 'Composition' },
      'Every result is a relation, so operations nest. The titles and running times of the operas longer than 150 minutes:',
      { p: "`π[title, runtime_min](σ[genre = 'opera' ∧ runtime_min > 150](production))`" },
      ra("π[title, runtime_min](σ[genre = 'opera' ∧ runtime_min > 150](production))"),
      { sql: "select title, runtime_min\nfrom production\nwhere genre = 'opera' and runtime_min > 150;" },
      { h: 'Union, difference and intersection' },
      'The set operations combine two relations that are **compatible**: the same number of attributes, with matching domains. Both `company` and `venue` have a `city`. The cities that have a company, a venue, or both:',
      { p: '`π[city](company) ∪ π[city](venue)`' },
      ra('π[city](company) ∪ π[city](venue)'),
      { sql: 'select city from company\nunion\nselect city from venue;' },
      'The **set difference** r − s keeps the tuples of r that are not in s: the cities that have a venue but no company of their own.',
      ra('π[city](venue) − π[city](company)'),
      { sql: 'select city from venue\nexcept\nselect city from company;' },
      'The **intersection** r ∩ s keeps the tuples in both. It adds no new power: r ∩ s is the same as r − (r − s).',
      { sql: 'select city from venue\nintersect\nselect city from company;' },
      { predict: { q: 'Is `π[name](company) ∪ π[venue_name](venue)` a legal expression?', options: ['Yes: both sides have one string attribute, though the result answers no sensible question', 'No: the attribute names differ', 'Only after renaming one side'], answer: 0, explain: 'Compatibility asks only for the same number of attributes with compatible domains. Company names and venue names are both strings, so the union is legal; a set mixing the two just means nothing. Compatibility checks types, not meaning.' }, sql: 'select name from company\nunion\nselect venue_name from venue;' },
    ],
  });

  lesson({
    id: 'rel-algebra-join', chapter: 2, title: 'Relational algebra: products, rename and joins', minutes: 14,
    summary: 'The Cartesian product pairs every tuple with every other; selection over a product gives a join; rename lets a relation meet itself.',
    body: [
      { h: 'Cartesian product: ×' },
      'The product r × s pairs every tuple of r with every tuple of s. Its attributes are those of both, written `r.a` and `s.a` where a name occurs in both.',
      { predict: { q: 'There are 45 artists and 12 companies. How many tuples are in `artist × company`?', options: ['540', '57', '45'], answer: 0, explain: 'Each of the 45 artist tuples is paired with each of the 12 company tuples: 45 × 12 = 540. Most pairs mean nothing: an artist next to a company they have never worked for.' }, sql: 'select count(*) from artist, company;' },
      'On its own the product is rarely what you want. Select from it the pairs that belong together:',
      { p: '`σ[artist.company_id = company.company_id](artist × company)`' },
      ra('σ[artist.company_id = company.company_id](artist × company)'),
      { sql: 'select *\nfrom artist, company\nwhere artist.company_id = company.company_id;' },
      'Some artists are missing from the result. Which ones, and why? (Think about the freelancers.)',
      { h: 'Join: ⋈' },
      'A selection over a product is common enough to have its own symbol. The **theta join** r ⋈θ s means σθ(r × s). The **natural join** r ⋈ s pairs the tuples that agree on every attribute the two relations share, and keeps one copy of each shared attribute.',
      'Productions and their performances share only `prod_id`:',
      { p: '`π[title, venue_code](production ⋈ performance)`' },
      ra('π[title, venue_code](production ⋈ performance)'),
      { sql: 'select title, venue_code\nfrom production natural join performance;', note: 'SQL returns one row per performance; the workbench returns each (title, venue) pair once, because a run of performances at the same venue gives the same pair again and again.' },
      { warn: 'A natural join matches on *every* shared name. `production ⋈ performance` matches on `prod_id`, which is what you want. But `artist ⋈ production` matches on `company_id`: it pairs each artist with every production of their company, cast in it or not, which is not what "artist in a production" means. Casting is recorded in `casting`. Chapter 4 shows safer ways to write joins.' },
      { h: 'Rename: ρ' },
      'To compare tuples of a relation with other tuples of the *same* relation, you need two copies with different names. ρx(E) gives the result of E the name x. The productions that run longer than PR101:',
      { p: "`π[a.title](σ[a.runtime_min > b.runtime_min ∧ b.prod_id = 'PR101'](ρ[a](production) × ρ[b](production)))`" },
      ra("π[a.title](σ[a.runtime_min > b.runtime_min ∧ b.prod_id = 'PR101'](ρ[a](production) × ρ[b](production)))"),
      'In SQL, the names written after the tables in `from` do the renaming:',
      { sql: "select a.title\nfrom production a, production b\nwhere a.runtime_min > b.runtime_min and b.prod_id = 'PR101';" },
      { predict: { q: 'Is PR101 itself in the result?', options: ['No: no production runs longer than itself', 'Yes, once for each b', 'Only if two productions have its running time'], answer: 0, explain: 'The pair (PR101, PR101) has a.runtime_min = b.runtime_min, so `a.runtime_min > b.runtime_min` is false for it. Only strictly longer productions qualify.' } },
      { h: 'Assignment: ←' },
      'A long expression reads better in pieces. The assignment `temp ← E` names a result for later use, like a variable:',
      { p: "`operas ← σ[genre = 'opera'](production); π[title, perf_date](operas ⋈ performance)`" },
      ra("operas ← σ[genre = 'opera'](production); π[title, perf_date](operas ⋈ performance)"),
      'In SQL the same thing is a `with` clause:',
      { sql: "with operas as (\n  select * from production where genre = 'opera'\n)\nselect distinct title, perf_date\nfrom operas natural join performance;" },
      { h: 'Equivalent expressions' },
      'Many expressions give the same result. `σ[genre = \'opera\'](production ⋈ performance)` and `σ[genre = \'opera\'](production) ⋈ performance` are equal, but the second does less work: it joins only the operas. The optimizer of chapter 16 makes exactly this kind of choice, and the plan view shows it.',
      { view: 'plan', label: 'Open the plan view' },
    ],
  });

  // ---- exercises ----------------------------------------------------------------------------------------------------------
  const ex = (x) => C.exercise(Object.assign({ chapter: 2 }, x));

  ex({ id: 'rel-x-tragedies', level: 1, title: 'A selection in SQL',
    text: ["Write `σ[genre = 'tragedy'](production)` in SQL.", '**Answer with** all seven attributes of production, one row per tragedy, in any order.'],
    ref: "select * from production where genre = 'tragedy'",
    wrongs: ["select title from production where genre = 'tragedy'", "select * from production where genre = 'Tragedy'", "select * from production where genre <> 'tragedy'"],
    hints: ['σ keeps whole tuples, so every attribute stays.', 'The predicate becomes the where clause; genre values are lower case.', "select * from production where genre = 'tragedy'"] });

  ex({ id: 'rel-x-company-cities', level: 1, title: 'A projection is a set',
    text: ['Write `π[city](company)` in SQL. The algebra returns a set.', '**Answer with** one column, city, each city once, in any order.'],
    ref: 'select distinct city from company',
    wrongs: ['select city from company', 'select distinct city from venue'],
    hints: ['Projection keeps only the listed attribute.', 'Several companies share a city. Should that city appear twice?', 'select distinct city from company'] });

  ex({ id: 'rel-x-well-paid', level: 1, title: 'Selection, then projection',
    text: ['Write `π[person_id, billed_as](σ[fee > 2000](artist))` in SQL.', '**Answer with** person_id and billed_as, one row per artist whose fee is above 2000, in any order.'],
    ref: 'select person_id, billed_as from artist where fee > 2000',
    wrongs: ['select person_id, billed_as from artist where fee >= 2000', 'select person_id, billed_as from artist where fee > 2000 or fee is null', 'select person_id, fee from artist where fee > 2000'],
    hints: ['The inner σ becomes the where clause.', 'The outer π becomes the select list. person_id is a key, so no duplicates can arise.', 'select person_id, billed_as from artist where fee > 2000'] });

  ex({ id: 'rel-x-big-arenas', level: 1, title: 'A conjunction',
    text: ["Find the large arena stages: `π[venue_code, stage_no](σ[kind = 'arena' ∧ seats ≥ 600](stage))`.", '**Answer with** venue_code and stage_no, one row per stage, in any order.'],
    ref: "select venue_code, stage_no from stage where kind = 'arena' and seats >= 600",
    wrongs: ["select venue_code, stage_no from stage where kind = 'arena' or seats >= 600", "select venue_code, stage_no from stage where kind <> 'arena' and seats >= 600", "select venue_code, stage_no from stage where seats >= 600"],
    hints: ['∧ is and.', '≥ is >=, and both conditions go in the where clause.', "select venue_code, stage_no from stage where kind = 'arena' and seats >= 600"] });

  ex({ id: 'rel-x-two-cities', level: 1, title: 'A disjunction',
    text: ["List the patrons from Brightwater or Vantmoor: `π[patron_id, name](σ[city = 'Brightwater' ∨ city = 'Vantmoor'](patron))`.", '**Answer with** patron_id and name, one row per patron, in any order.'],
    ref: "select patron_id, name from patron where city = 'Brightwater' or city = 'Vantmoor'",
    alts: ["select patron_id, name from patron where city in ('Brightwater', 'Vantmoor')"],
    wrongs: ["select patron_id, name from patron where city = 'Brightwater' and city = 'Vantmoor'", "select patron_id, name from patron where city = 'Brightwater'", "select distinct name from patron where city in ('Brightwater', 'Vantmoor')"],
    hints: ['∨ is or.', 'in (...) says the same thing more briefly.', "select patron_id, name from patron where city in ('Brightwater', 'Vantmoor')"] });

  ex({ id: 'rel-x-city-union', level: 2, title: 'Union',
    text: ['Find every city that has a company or a venue: `π[city](company) ∪ π[city](venue)`.', '**Answer with** one column, city, each city once, in any order.'],
    ref: 'select city from company\nunion\nselect city from venue',
    wrongs: ['select city from company union all select city from venue', 'select city from company intersect select city from venue', 'select city from venue'],
    hints: ['Write each side as its own select.', 'Combine them with union.', 'select city from company union select city from venue'] });

  ex({ id: 'rel-x-never-cast', level: 2, title: 'Set difference',
    text: ['Find the artists who have never been cast in anything: `π[person_id](artist) − π[person_id](casting)`.', '**Answer with** one column, person_id, in any order.'],
    ref: 'select person_id from artist\nexcept\nselect person_id from casting',
    alts: ['select person_id from artist a where not exists (select * from casting c where c.person_id = a.person_id)'],
    wrongs: ['select person_id from casting except select person_id from artist', 'select person_id from artist where company_id is null', 'select person_id from artist except select person_id from casting where lead'],
    hints: ['− is except in SQL.', 'The left side lists every artist; the right side, everyone who appears in casting.', 'select person_id from artist except select person_id from casting'] });

  ex({ id: 'rel-x-city-intersect', level: 2, title: 'Intersection',
    text: ['Find the cities with a stage of at least 1000 seats that are also home to a company: `π[city](venue ⋈ σ[seats ≥ 1000](stage)) ∩ π[city](company)`.', '**Answer with** one column, city, in any order.'],
    ref: 'select v.city from venue v, stage s where v.venue_code = s.venue_code and s.seats >= 1000\nintersect\nselect city from company',
    wrongs: ['select city from company', 'select city from venue intersect select city from company', 'select v.city from venue v, stage s where v.venue_code = s.venue_code and s.seats >= 1000 union select city from company'],
    hints: ['venue and stage share venue_code; the city is in venue.', 'Each side of ∩ is a set of cities.', 'select v.city from venue v, stage s where v.venue_code = s.venue_code and s.seats >= 1000 intersect select city from company'] });

  ex({ id: 'rel-x-company-fees', level: 2, title: 'Selection over a product',
    text: ['Write in SQL: `π[name, fee](σ[artist.company_id = company.company_id](artist × company))`, the fees paid by each company. Keep the algebra\'s set semantics.', '**Answer with** company name and fee, each pair once, in any order.'],
    ref: 'select distinct name, fee\nfrom artist, company\nwhere artist.company_id = company.company_id',
    wrongs: ['select name, fee from artist, company where artist.company_id = company.company_id', 'select distinct name, fee from artist, company', 'select distinct company_id, fee from artist'],
    hints: ['× is a comma between the tables in from.', 'The σ predicate compares the two company_id attributes, qualified by table.', 'Two artists of one company may earn the same fee, so add distinct.'] });

  ex({ id: 'rel-x-opera-nights', level: 2, title: 'A natural join',
    text: ["List the opera performances: `π[title, perf_date, price](σ[genre = 'opera'](production) ⋈ performance)`.", '**Answer with** title, perf_date and price, each triple once, in any order.'],
    ref: "select distinct title, perf_date, price\nfrom production natural join performance\nwhere genre = 'opera'",
    alts: ["select distinct p.title, f.perf_date, f.price from production p join performance f on f.prod_id = p.prod_id where p.genre = 'opera'"],
    wrongs: ["select distinct title, perf_date, price from production, performance where genre = 'opera'", 'select distinct title, perf_date, price from production natural join performance', "select distinct title, premiere, price from production natural join performance where genre = 'opera'"],
    hints: ['production and performance share exactly one attribute name.', 'natural join matches on prod_id.', "select distinct title, perf_date, price from production natural join performance where genre = 'opera'"] });

  ex({ id: 'rel-x-opera-casts', level: 2, title: 'Three relations, carefully',
    text: ["Find the names of the people cast in an opera, with the title: `π[given_name, family_name, title](person ⋈ casting ⋈ σ[genre = 'opera'](production))`. Take care: if you bring `artist` into a natural join with `production`, the two share `company_id` and guests from other companies vanish.", '**Answer with** given_name, family_name and title, each triple once, in any order.'],
    ref: "select distinct p.given_name, p.family_name, r.title\nfrom person p, casting c, production r\nwhere p.person_id = c.person_id and c.prod_id = r.prod_id and r.genre = 'opera'",
    alts: ["select distinct given_name, family_name, title from person natural join casting natural join production where genre = 'opera'"],
    wrongs: ["select distinct given_name, family_name, title from person natural join artist natural join casting natural join production where genre = 'opera'", "select p.given_name, p.family_name, r.title from person p, casting c, production r where p.person_id = c.person_id and r.genre = 'opera'"],
    hints: ['person joins casting on person_id; casting joins production on prod_id.', 'artist is not needed: casting already holds the person_id.', "select distinct p.given_name, p.family_name, r.title from person p, casting c, production r where p.person_id = c.person_id and c.prod_id = r.prod_id and r.genre = 'opera'"] });

  ex({ id: 'rel-x-longer-than-some', level: 3, title: 'Rename to compare a relation with itself',
    text: ["Find the titles of the productions that run longer than at least one production of company C04: `π[a.title](σ[a.runtime_min > b.runtime_min ∧ b.company_id = 'C04'](ρ[a](production) × ρ[b](production)))`.", '**Answer with** one column, title, each title once, in any order.'],
    ref: "select distinct a.title\nfrom production a, production b\nwhere a.runtime_min > b.runtime_min and b.company_id = 'C04'",
    wrongs: ["select a.title from production a, production b where a.runtime_min > b.runtime_min and b.company_id = 'C04'", "select distinct a.title from production a where a.runtime_min > (select max(runtime_min) from production where company_id = 'C04')", "select distinct a.title from production a, production b where a.runtime_min > b.runtime_min and a.company_id = 'C04'"],
    hints: ['Name the two copies a and b in the from clause.', 'One condition puts b in C04; the other compares the running times.', 'A production longer than several C04 productions would appear several times: use distinct.'] });

  ex({ id: 'rel-x-most-seats', level: 3, title: 'The largest, with only the basic operators',
    text: ['Find the largest number of seats on any stage without using `max`: take all seat counts and remove each one that is smaller than some other. In the algebra: `π[seats](stage) − π[s.seats](σ[s.seats < t.seats](ρ[s](stage) × ρ[t](stage)))`.', '**Answer with** one column, seats, holding the largest value once.'],
    ref: 'select seats from stage\nexcept\nselect s.seats\nfrom stage s, stage t\nwhere s.seats < t.seats',
    wrongs: ['select seats from stage except select s.seats from stage s, stage t where s.seats <= t.seats', 'select s.seats from stage s, stage t where s.seats > t.seats', 'select seats from stage except select s.seats from stage s, stage t where s.seats > t.seats'],
    hints: ['The right side of the difference is every seat count that is not the largest.', 'Build it from two renamed copies of stage, with a strict <.', 'select seats from stage except select s.seats from stage s, stage t where s.seats < t.seats'] });

  ex({ id: 'rel-x-never-booked', level: 3, title: 'Patrons who never booked',
    text: ['Find the patrons who have never made a booking. In the algebra: `π[patron_id, name](patron) − π[patron_id, name](patron ⋈ booking)`.', '**Answer with** patron_id and name, one row per patron, in any order.'],
    ref: 'select patron_id, name from patron\nexcept\nselect p.patron_id, p.name from patron p, booking b where p.patron_id = b.patron_id',
    alts: ['select patron_id, name from patron p where not exists (select * from booking b where b.patron_id = p.patron_id)'],
    wrongs: ['select name from patron except select p.name from patron p, booking b where p.patron_id = b.patron_id', 'select patron_id, name from patron except select p.patron_id, p.name from patron p, booking b where p.patron_id = b.patron_id and b.rating is not null', 'select distinct p.patron_id, p.name from patron p, booking b where p.patron_id <> b.patron_id'],
    hints: ['Both sides of the difference need the same two attributes.', 'The right side is the patrons who appear in booking.', 'select patron_id, name from patron except select p.patron_id, p.name from patron p, booking b where p.patron_id = b.patron_id'] });

  ex({ id: 'rel-x-musical-goers', level: 3, title: 'Assignment as WITH',
    text: ["The algebra program `musicals ← σ[genre = 'musical'](production); π[patron_id](booking ⋈ performance ⋈ musicals)` finds the patrons who booked a musical. Write it in SQL with a `with` clause named `musicals`.", '**Answer with** one column, patron_id, each patron once, in any order.'],
    ref: "with musicals as (select * from production where genre = 'musical')\nselect distinct b.patron_id\nfrom booking b, performance f, musicals m\nwhere b.perf_id = f.perf_id and f.prod_id = m.prod_id",
    wrongs: ["with musicals as (select * from production where genre = 'musical') select b.patron_id from booking b, performance f, musicals m where b.perf_id = f.perf_id and f.prod_id = m.prod_id", "with musicals as (select * from production where genre = 'musical') select distinct b.patron_id from booking b, musicals m where b.perf_id = m.prod_id::int", "select distinct patron_id from booking"],
    hints: ['with musicals as (select ...) defines the temporary relation.', 'booking has no prod_id: go through performance.', "with musicals as (select * from production where genre = 'musical') select distinct b.patron_id from booking b, performance f, musicals m where b.perf_id = f.perf_id and f.prod_id = m.prod_id"] });
})(typeof window !== 'undefined' ? window : globalThis);
