// Chapter 7: relational database design. Redundancy and the anomalies it causes, functional dependencies and
// their closure, Armstrong's axioms and keys, the canonical cover, BCNF and lossless decomposition, 3NF and
// dependency preservation, multivalued dependencies and 4NF, and a short look at temporal data. The lessons
// make the theory happen on real rows and open the design workbench on the same schemas.
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
  /** a button that opens the design workbench on a schema and its dependencies, on one tab */
  const wb = (schema, deps, tab, label) => ({ view: 'design', sel: { schema, deps, tab }, label });

  // the running examples
  const PERF_STAGE = 'perf_stage(perf_id, prod_id, perf_date, venue_code, stage_no, seats)';
  const PERF_STAGE_FD = 'perf_id → prod_id, perf_date, venue_code, stage_no\nvenue_code, stage_no → seats';
  const MAKE_PERF_STAGE = "drop table if exists perf_stage;\ncreate table perf_stage as\n  select f.perf_id, f.prod_id, f.perf_date, f.venue_code, f.stage_no, s.seats\n  from performance f join stage s using (venue_code, stage_no);\nalter table perf_stage add primary key (perf_id);";
  // the stage with the most performances, and the one with the fewest (ties broken by the key)
  const BUSIEST = "(select venue_code, stage_no from perf_stage\n   group by venue_code, stage_no order by count(*) desc, venue_code, stage_no limit 1)";
  const QUIETEST = "(select venue_code, stage_no from perf_stage\n   group by venue_code, stage_no order by count(*), venue_code, stage_no limit 1)";
  const DELIVERY = 'delivery(order_id, customer, restaurant, courier, city, region, loyalty)';
  const DELIVERY_FD = 'order_id → customer, restaurant, courier\nrestaurant → city\ncity → region\ncustomer, restaurant → loyalty';
  // a table of dependencies, and attribute closure as a recursive query over it
  const MAKE_FD = "drop table if exists fd;\ncreate table fd (lhs text[], rhs text[]);\ninsert into fd values\n  ('{order_id}', '{customer,restaurant,courier}'),\n  ('{restaurant}', '{city}'),\n  ('{city}', '{region}'),\n  ('{customer,restaurant}', '{loyalty}');";
  const closureSql = (start, fdWhere) => "with recursive c(attrs) as (\n  select array[" + start.map((a) => "'" + a + "'").join(', ') + "]\n  union\n  select array(select distinct x from unnest(c.attrs || f.rhs) x order by x)\n  from c join fd f on f.lhs <@ c.attrs\n  where not f.rhs <@ c.attrs" + (fdWhere ? '\n    and ' + fdWhere : '') + "\n)\nselect attrs as closure\nfrom c\norder by cardinality(attrs) desc\nlimit 1;";

  // ---- 7.1 features of good design ---------------------------------------------------------------------------------------
  lesson({
    id: 'des-anomalies', chapter: 7, title: 'Good design, redundancy and anomalies', minutes: 12,
    summary: 'A schema that stores one fact in many rows invites trouble: updates that miss a copy, facts that cannot be inserted, facts lost by a deletion. Watch all three happen.',
    body: [
      'Suppose someone, to save a join, keeps each performance together with its stage and the stage\'s number of seats in one table. Build it from the Theatre data:',
      { sql: MAKE_PERF_STAGE + '\nselect * from perf_stage\norder by venue_code, stage_no, perf_date\nlimit 8;' },
      'It looks harmless. But the number of seats is a fact about the stage, and the table repeats it in every performance played there. The busiest stage has its seat count written down once per performance:',
      { sql: 'select venue_code, stage_no, seats, count(*) as rows\nfrom perf_stage\nwhere (venue_code, stage_no) = ' + BUSIEST + '\ngroup by venue_code, stage_no, seats;' },
      'That repetition is **redundancy**, and it causes three kinds of **anomalies**.',
      { h: 'The update anomaly' },
      'The busiest stage is refitted with 40 more seats. A program updates the row it happens to be looking at, the stage\'s first performance:',
      { sql: 'update perf_stage set seats = seats + 40\nwhere perf_id = (select min(perf_id) from perf_stage\n                 where (venue_code, stage_no) = ' + BUSIEST + ');' },
      { predict: { q: 'How many different seat counts does the table now give for that stage?', options: ['2', '1', 'As many as it has performances'], answer: 0, explain: 'One row has the new count and all the others still have the old one. The table now contradicts itself, and which answer a query gives depends on which row it happens to read.' }, sql: "select seats, count(*) as rows\nfrom perf_stage\nwhere (venue_code, stage_no) = (select venue_code, stage_no from perf_stage\n                                group by venue_code, stage_no\n                                having count(distinct seats) > 1)\ngroup by seats\norder by rows;" },
      { h: 'The insertion anomaly' },
      'A venue opens a new studio stage, number 9, with 60 seats. Nothing is scheduled on it yet, so there is no performance to attach it to, and the primary key cannot be left empty:',
      { sql: "insert into perf_stage (venue_code, stage_no, seats)\nvalues ((select min(venue_code) from perf_stage), 9, 60);", fails: '23502', note: 'It fails: there is no way to record the stage until something is played on it.' },
      { h: 'The deletion anomaly' },
      'The performances on the quietest stage are cancelled and deleted. With them goes the only record of how many seats that stage has:',
      { sql: "create temporary table gone as " + QUIETEST + ";\ndelete from perf_stage where (venue_code, stage_no) in (select venue_code, stage_no from gone);\nselect count(*) as rows_about_that_stage\nfrom perf_stage\nwhere (venue_code, stage_no) in (select venue_code, stage_no from gone);\ndrop table gone;" },
      'The Theatre schema does not have these problems, because seats lives in `stage`, once per stage. Splitting a table so that each fact is stored once is what this chapter is about. The rest of it makes "each fact once" precise with **functional dependencies**, and gives algorithms that find the right split.',
      'The design workbench can produce these scripts for any schema that has the problem. Open it on the same schema; the **Anomalies** tab has a Run button for each anomaly:',
      wb(PERF_STAGE, PERF_STAGE_FD, 'anom', 'Open the anomaly scripts in the design workbench'),
      { tip: 'Good design also means avoiding the opposite mistake: splitting a table so far that a fact is spread over pieces that cannot be put back together. The lesson on BCNF shows that kind of loss.' },
      'Tidy up:',
      { sql: 'drop table perf_stage;' },
    ],
  });

  // ---- 7.2 functional dependencies -----------------------------------------------------------------------------------------
  lesson({
    id: 'des-fds', chapter: 7, title: 'Functional dependencies and attribute closure', minutes: 13,
    summary: 'A functional dependency says that some attributes determine others. Testing one on data, and computing everything a set of attributes determines.',
    body: [
      { def: 'Functional dependency.', text: 'α → β holds on a relation schema r(R) if, in every legal instance of r, any two tuples that agree on the attributes α also agree on β. Read it as "α determines β".' },
      'A dependency is a rule about every legal instance, so data alone can only disprove one. To test α → β on an instance, look for an α value with more than one β value. Does a stage determine its number of seats?',
      { sql: 'select venue_code, stage_no\nfrom stage\ngroup by venue_code, stage_no\nhaving count(distinct seats) > 1;', note: 'No rows: the dependency holds here (and since venue_code and stage_no are the key of stage, it always will).' },
      'Do a patron and a production determine the rating? A patron who sees a production more than once may rate the performances differently:',
      { sql: 'select b.patron_id, f.prod_id, count(*) as times, count(distinct b.rating) as ratings\nfrom booking b join performance f on f.perf_id = b.perf_id\ngroup by b.patron_id, f.prod_id\nhaving count(distinct b.rating) > 1\norder by b.patron_id, f.prod_id\nlimit 5;', note: 'Some rows: patron_id, prod_id → rating does not hold. One counterexample is enough.' },
      { predict: { q: 'In this data every venue has a different name. Does venue_name → city hold on the venue schema?', options: ['No: two venues in different cities could have the same name. It only happens to hold in this instance', 'Yes: no instance can have two rows with the same name', 'Yes, because it holds in the data'], answer: 0, explain: 'A functional dependency is a statement about all legal instances, and it comes from the meaning of the data. Nothing about venues stops two towns from each having a Corn Exchange. Data can refute a dependency, never prove one.' }, sql: 'select count(*) as venues, count(distinct venue_name) as names\nfrom venue;' },
      'A dependency is **trivial** if β ⊆ α, like (venue_code, stage_no) → venue_code. Trivial dependencies hold in every relation.',
      { h: 'Closure of a set of attributes' },
      'Take a food delivery service with this schema and these dependencies, which come from how the business works:',
      { table: [['Dependency', 'Because'], ['order_id → customer, restaurant, courier', 'an order is placed by one customer at one restaurant and carried by one courier'], ['restaurant → city', 'each restaurant is in one city'], ['city → region', 'each city lies in one region'], ['customer, restaurant → loyalty', 'a customer has one loyalty level at each restaurant']] },
      'The **closure** α+ of a set of attributes α is every attribute that α determines, directly or through a chain. The algorithm is short: start with α, and as long as some dependency has its whole left side inside the result, add its right side.',
      'Dependencies are data too. Store them in a table, and the algorithm is a recursive query: each step adds the right side of every dependency whose left side is already contained (`<@`) in the set so far.',
      { sql: MAKE_FD + '\n' + closureSql(['restaurant']) },
      { predict: { q: 'What is the closure of {customer, restaurant}?', options: ['customer, restaurant, city, region, loyalty', 'customer, restaurant, loyalty', 'every attribute of delivery', 'customer, restaurant'], answer: 0, explain: 'restaurant brings city, city brings region, and the pair brings loyalty. Nothing brings order_id or courier, so {customer, restaurant} is not a superkey.' }, sql: closureSql(['customer', 'restaurant']) },
      'The workbench computes closures step by step and shows which dependency added each attribute. Try {order_id} there:',
      wb(DELIVERY, DELIVERY_FD, 'closure', 'Open the delivery schema in the design workbench'),
      { tip: 'Closure answers many questions at once. α is a superkey exactly when α+ is all of R; α → β follows from the dependencies exactly when β ⊆ α+. The next lessons use it for both.' },
      { sql: 'drop table fd;' },
    ],
  });

  // ---- 7.3 Armstrong's axioms and keys ---------------------------------------------------------------------------------------
  lesson({
    id: 'des-armstrong', chapter: 7, title: 'Armstrong\'s axioms and keys', minutes: 12,
    summary: 'Three rules derive every dependency that follows from a set F. Closure tests superkeys, and a candidate key is a superkey with nothing to spare.',
    body: [
      'Given a set F of dependencies, others follow from it. The set of all of them is the **closure of F**, written F+. Three rules, **Armstrong\'s axioms**, derive exactly F+: everything they derive holds (they are **sound**) and everything that holds can be derived (they are **complete**).',
      { table: [['Rule', 'If', 'then'], ['reflexivity', 'β ⊆ α', 'α → β'], ['augmentation', 'α → β', 'γα → γβ'], ['transitivity', 'α → β and β → γ', 'α → γ']] },
      'Three more rules follow from those and save steps:',
      { table: [['Rule', 'If', 'then'], ['union', 'α → β and α → γ', 'α → βγ'], ['decomposition', 'α → βγ', 'α → β and α → γ'], ['pseudotransitivity', 'α → β and γβ → δ', 'αγ → δ']] },
      'A proof in the delivery schema that an order determines its region:',
      { steps: ['order_id → customer, restaurant, courier (given)', 'order_id → restaurant (decomposition of 1)', 'restaurant → city (given)', 'order_id → city (transitivity of 2 and 3)', 'city → region (given)', 'order_id → region (transitivity of 4 and 5)'] },
      wb(DELIVERY, DELIVERY_FD, 'proof', 'Write proofs in the workbench (the Armstrong proof tab checks each line)'),
      { predict: { q: 'Which rule turns order_id → restaurant and customer, restaurant → loyalty into customer, order_id → loyalty?', options: ['pseudotransitivity', 'augmentation', 'union', 'reflexivity'], answer: 0, explain: 'With α = order_id, β = restaurant, γ = customer and δ = loyalty: α → β and γβ → δ give αγ → δ. You can also get it from augmentation (add customer to both sides of the first) and transitivity.' } },
      { h: 'Superkeys and candidate keys' },
      'α is a **superkey** of R when α+ = R. A **candidate key** is a superkey none of whose proper subsets is a superkey. Use the closure query on the delivery dependencies:',
      { sql: "drop table if exists fd;\ncreate table fd (lhs text[], rhs text[]);\ninsert into fd values\n  ('{order_id}', '{customer,restaurant,courier}'),\n  ('{restaurant}', '{city}'),\n  ('{city}', '{region}'),\n  ('{customer,restaurant}', '{loyalty}');\n" + closureSql(['order_id']), note: 'All seven attributes: order_id is a superkey, and with one attribute it cannot be anything but minimal.' },
      'Two observations narrow the search for keys. An attribute that is on no right side can never be added by a closure, so it must be in every key; order_id is such an attribute. An attribute that appears only on right sides is in no key. Here the only candidate key is {order_id}.',
      'The same tests work on real tables. A candidate key of the data has as many distinct values as there are rows:',
      { sql: 'select count(*) as bookings,\n       count(distinct (patron_id, perf_id)) as by_patron_and_performance,\n       count(distinct patron_id) as by_patron_alone\nfrom booking;', note: 'Leave out perf_id and bookings collide: patron_id alone is not a superkey, so (patron_id, perf_id) is minimal in this data.' },
      wb(DELIVERY, DELIVERY_FD, 'keys', 'See the key search in the workbench'),
      { sql: 'drop table fd;' },
    ],
  });

  // ---- 7.4 canonical cover -----------------------------------------------------------------------------------------------------
  const MESSY_FD = 'order_id → customer, restaurant, courier, city\nrestaurant → city\ncity → region\ncustomer, restaurant → loyalty\ncustomer, order_id → loyalty';
  lesson({
    id: 'des-cover', chapter: 7, title: 'The canonical cover', minutes: 11,
    summary: 'A set of dependencies often says some things twice. A canonical cover says the same with nothing extra: no extraneous attributes, and each left side once.',
    body: [
      'Every dependency is a rule the database should keep, and checking a rule costs work on every update. If a set says something twice, half of that work is wasted. A designer wrote down this set for the delivery schema:',
      { steps: MESSY_FD.split('\n') },
      'Two things in it are redundant. Order determines city through restaurant anyway, and customer with order determines loyalty through the other rules.',
      { def: 'Extraneous attribute.', text: 'An attribute of a dependency is extraneous if removing it does not change F+. On the right side of α → β, A is extraneous if α+ still contains A when computed under F with A removed from that dependency. On the left side, A is extraneous if (α − A)+ under F contains β.' },
      'Test the first claim with the closure query. Store the set with the first dependency already missing city, and see whether order_id still determines city:',
      { sql: "drop table if exists fd;\ncreate table fd (id int, lhs text[], rhs text[]);\ninsert into fd values\n  (1, '{order_id}', '{customer,restaurant,courier}'),\n  (2, '{restaurant}', '{city}'),\n  (3, '{city}', '{region}'),\n  (4, '{customer,restaurant}', '{loyalty}'),\n  (5, '{customer,order_id}', '{loyalty}');\n" + closureSql(['order_id']), note: 'city is there, through restaurant: it was extraneous on the right of the first dependency.' },
      { predict: { q: 'Leave dependency 5 out completely. Does {customer, order_id} still determine loyalty?', options: ['Yes: order_id brings customer and restaurant, and those bring loyalty', 'No: dependency 5 was the only way', 'Only if city is added'], answer: 0, explain: 'The closure of {customer, order_id} under the other four dependencies contains loyalty, so dependency 5 adds nothing to F+. Every attribute of its right side is extraneous, and it disappears from the cover.' }, sql: closureSql(['customer', 'order_id'], 'f.id <> 5') },
      'The **canonical cover** Fc is a set with the same closure as F in which no dependency has an extraneous attribute and no two dependencies have the same left side. The algorithm repeats until nothing changes:',
      { steps: ['combine dependencies with the same left side using the union rule', 'find a dependency with an extraneous attribute on either side', 'remove it, and start again'] },
      'For this set the result is the four dependencies of the previous lessons. A canonical cover need not be unique: when two attributes are each extraneous only while the other is present, the order of removal decides which one goes.',
      wb(DELIVERY, MESSY_FD, 'cover', 'Run the canonical cover algorithm in the workbench'),
      { tip: '3NF synthesis, two lessons on, starts from a canonical cover: each of its dependencies becomes one schema.' },
      { sql: 'drop table fd;' },
    ],
  });

  // ---- 7.5 BCNF and lossless decomposition -------------------------------------------------------------------------------
  lesson({
    id: 'des-bcnf', chapter: 7, title: 'BCNF and lossless decomposition', minutes: 14,
    summary: 'In Boyce-Codd normal form every nontrivial dependency has a superkey on its left. Decomposing on a violating dependency fixes it, and the decomposition loses nothing if the shared attributes are a key of one side.',
    body: [
      { def: 'Boyce-Codd normal form.', text: 'A schema R is in BCNF with respect to F if for every dependency α → β in F+ with α, β ⊆ R, either α → β is trivial or α is a superkey of R.' },
      'In the perf_stage table of the first lesson, venue_code, stage_no → seats holds, and venue_code with stage_no is not a superkey (many performances share a stage). That dependency is the cause of every anomaly you saw: its left side repeats, so its right side repeats with it.',
      { h: 'Decomposing' },
      'The BCNF decomposition algorithm takes a violating dependency α → β and replaces R by two schemas: (α ∪ β) and (R − (β − α)). Here that gives stage_part(venue_code, stage_no, seats) and perf_part(perf_id, prod_id, perf_date, venue_code, stage_no). Build both from the wide table:',
      { sql: MAKE_PERF_STAGE + "\ndrop table if exists stage_part, perf_part;\ncreate table stage_part as select distinct venue_code, stage_no, seats from perf_stage;\ncreate table perf_part as select perf_id, prod_id, perf_date, venue_code, stage_no from perf_stage;\nselect (select count(*) from stage_part) as stages, (select count(*) from perf_part) as performances;" },
      'Each seat count is now stored once per stage. Does a natural join give the original table back, no more and no less?',
      { sql: 'with joined as (\n  select perf_id, prod_id, perf_date, venue_code, stage_no, seats\n  from perf_part natural join stage_part\n), original as (\n  select perf_id, prod_id, perf_date, venue_code, stage_no, seats\n  from perf_stage\n)\n(select * from joined except select * from original)\nunion all\n(select * from original except select * from joined);', note: 'No rows either way: the join is exactly the original.' },
      { def: 'Lossless decomposition.', text: 'A decomposition of R into R1 and R2 is lossless if, for every legal instance r, joining the projections of r on R1 and R2 gives exactly r. It is guaranteed when R1 ∩ R2 → R1 or R1 ∩ R2 → R2 is in F+, that is, when the shared attributes are a superkey of one side. Here the shared attributes are venue_code and stage_no, the key of the stage part.' },
      { h: 'A lossy split' },
      'Split the same table the wrong way, sharing only seats: each performance with its seat count, and the stages with theirs.',
      { predict: { q: 'Join (perf_id, prod_id, perf_date, seats) with (venue_code, stage_no, seats) on seats. Compared with the original table, one row per performance, the join has', options: ['at least as many rows, and more as soon as two stages have the same number of seats', 'exactly one row per performance, always', 'fewer rows'], answer: 0, explain: 'seats is not a key of either side. A performance on a 300-seat stage joins with every 300-seat stage, producing performances on stages they were never played on. Getting more tuples means knowing less: the decomposition is **lossy**.' }, sql: 'select (select count(*) from perf_stage) as original_rows,\n       count(*) as joined_rows\nfrom (select perf_id, prod_id, perf_date, seats from perf_stage) a\n  join (select distinct venue_code, stage_no, seats from perf_stage) b using (seats);' },
      'The algorithm repeats on each piece until every piece is in BCNF, and each step is lossless by construction. The workbench plays it as a tree, and its **Lossless join** tab runs the test, including the chase for decompositions into more than two schemas:',
      wb(PERF_STAGE, PERF_STAGE_FD, 'decomp', 'Open the BCNF decomposition in the workbench'),
      wb(DELIVERY, DELIVERY_FD, 'decomp', 'Decompose the delivery schema, which takes several steps'),
      'Tidy up:',
      { sql: 'drop table perf_stage, stage_part, perf_part;' },
    ],
  });

  // ---- 7.6 3NF and dependency preservation ------------------------------------------------------------------------------
  lesson({
    id: 'des-3nf', chapter: 7, title: 'Third normal form and dependency preservation', minutes: 14,
    summary: 'A BCNF decomposition can make some dependency impossible to check without a join. Third normal form relaxes BCNF just enough to keep every dependency checkable, and synthesis builds such a design directly.',
    body: [
      'A theatre company books coaches for its artists. Each artist has one coach for each skill (voice, movement, stage combat), and each coach works on exactly one skill:',
      { steps: ['artist, skill → coach', 'coach → skill'] },
      'The candidate keys of coaching(artist, skill, coach) are {artist, skill} and {artist, coach}. The dependency coach → skill violates BCNF, since coach alone is not a superkey. Decomposing on it gives (coach, skill) and (artist, coach). Build that design:',
      { sql: "drop table if exists coach_skill, artist_coach;\ncreate table coach_skill (coach text primary key, skill text);\ncreate table artist_coach (artist text, coach text references coach_skill, primary key (artist, coach));\ninsert into coach_skill values ('Ruiz', 'voice'), ('Kaur', 'voice'), ('Bello', 'movement');\ninsert into artist_coach values ('Mira', 'Ruiz'), ('Mira', 'Bello'), ('Tobias', 'Kaur');" },
      'Now Mira books Kaur as well. Kaur coaches voice, and Mira already has a voice coach.',
      { predict: { q: 'Does the database reject `insert into artist_coach values (\'Mira\', \'Kaur\')`?', options: ['No: each table is fine on its own, and only a join shows that Mira now has two voice coaches', 'Yes: the primary key of artist_coach is violated', 'Yes: the foreign key is violated'], answer: 0, explain: 'The pair (Mira, Kaur) is new, and Kaur exists in coach_skill, so no constraint fails. The rule artist, skill → coach spans both tables, so no key or unique constraint on either table can express it. The decomposition is not **dependency preserving**.' }, sql: "insert into artist_coach values ('Mira', 'Kaur');\nselect ac.artist, cs.skill, count(*) as coaches\nfrom artist_coach ac join coach_skill cs using (coach)\ngroup by ac.artist, cs.skill\nhaving count(*) > 1;" },
      { def: 'Dependency preservation.', text: 'A decomposition preserves the dependencies if every dependency of F can be checked on the separate schemas alone; formally, the union of the dependencies that hold on each schema has the same closure as F.' },
      { h: 'Third normal form' },
      { def: '3NF.', text: 'R is in 3NF if for every α → β in F+, either it is trivial, or α is a superkey, or every attribute in β − α is contained in some candidate key (is **prime**).' },
      'The extra condition is exactly what lets coaching stay whole: in coach → skill, skill is part of the candidate key {artist, skill}. So coaching is in 3NF, and in one table the rule becomes an ordinary key:',
      { sql: "drop table if exists coaching;\ncreate table coaching (\n  artist text, skill text, coach text,\n  primary key (artist, skill)\n);\ninsert into coaching values ('Mira', 'voice', 'Ruiz'), ('Mira', 'movement', 'Bello'), ('Tobias', 'voice', 'Kaur');" },
      { sql: "insert into coaching values ('Mira', 'voice', 'Kaur');", fails: '23505', note: 'The second voice coach for Mira is refused by the primary key.' },
      'The price is some redundancy: coach → skill is not enforced by a key, and Ruiz\'s skill is repeated for each artist Ruiz coaches. 3NF accepts a little redundancy to keep every dependency checkable; BCNF removes it at the cost of a join to check some rules.',
      { h: '3NF synthesis' },
      'The 3NF algorithm builds a design from a canonical cover: one schema α ∪ β for each dependency α → β; if no schema contains a candidate key of R, add one that does; drop any schema contained in another. The result is in 3NF, lossless and dependency preserving.',
      wb('coaching(artist, skill, coach)', 'artist, skill → coach\ncoach → skill', 'pres', 'See the lost dependency in the workbench'),
      wb(DELIVERY, DELIVERY_FD, 'decomp', 'Compare BCNF decomposition and 3NF synthesis on the delivery schema'),
      'Tidy up:',
      { sql: 'drop table coaching, artist_coach, coach_skill;' },
    ],
  });

  // ---- 7.7 multivalued dependencies and 4NF ----------------------------------------------------------------------------------
  lesson({
    id: 'des-4nf', chapter: 7, title: 'Multivalued dependencies and fourth normal form', minutes: 12,
    summary: 'Two independent multivalued facts stored in one table force every combination to be stored. A multivalued dependency names the situation, and 4NF removes it.',
    body: [
      'For touring, a company records which instruments each artist can play on stage and which languages each can perform in. The two have nothing to do with each other. Store both in one table:',
      { sql: "drop table if exists artist_extra;\ncreate table artist_extra (artist text, instrument text, language text, primary key (artist, instrument, language));\ninsert into artist_extra values\n  ('Mira', 'violin', 'Spanish'), ('Mira', 'violin', 'English'),\n  ('Mira', 'accordion', 'Spanish'), ('Mira', 'accordion', 'English');\nselect * from artist_extra order by 1, 2, 3;" },
      'The only key is all three attributes, and there are no nontrivial functional dependencies, so the table is in BCNF. Yet it is clearly repetitive: each instrument is stored once per language.',
      { predict: { q: 'Mira can now also perform in French. How many rows must be inserted to keep the table consistent?', options: ['2, one for each instrument she plays', '1', '4'], answer: 0, explain: 'Since instruments and languages are independent, the table must hold every combination. With one row only, it would seem that Mira plays the violin in French but not the accordion, which means nothing. That is the anomaly a multivalued dependency causes.' }, sql: "insert into artist_extra values ('Mira', 'violin', 'French'), ('Mira', 'accordion', 'French');\nselect count(*) from artist_extra;" },
      { def: 'Multivalued dependency.', text: 'α ↠ β holds on R if, whenever two tuples agree on α, the tuples obtained by swapping their β values also appear. Equivalently, for each α value, the set of β values is independent of the values of the remaining attributes. Here artist ↠ instrument (and so artist ↠ language).' },
      'Every functional dependency is also a multivalued dependency, but not the other way round. Data can show that an MVD fails: look for an artist whose (instrument, language) pairs are not the full combination of their instruments and languages.',
      { sql: 'select artist,\n       count(*) as rows,\n       count(distinct instrument) * count(distinct language) as combinations\nfrom artist_extra\ngroup by artist;', note: 'Equal counts: every combination is there, as artist ↠ instrument requires.' },
      { def: '4NF.', text: 'R is in fourth normal form if for every nontrivial multivalued dependency α ↠ β in D+ (β not a subset of α, and α ∪ β not all of R), α is a superkey of R. 4NF implies BCNF.' },
      'The 4NF decomposition splits on the violating MVD into (α ∪ β) and (R − (β − α)): one table of instruments and one of languages. The join of the two gives back the original, so the split is lossless:',
      { sql: "drop table if exists artist_instrument, artist_language;\ncreate table artist_instrument as select distinct artist, instrument from artist_extra;\ncreate table artist_language as select distinct artist, language from artist_extra;\nselect (select count(*) from artist_instrument) as instrument_rows,\n       (select count(*) from artist_language) as language_rows,\n       (select count(*) from artist_instrument join artist_language using (artist)) as joined,\n       (select count(*) from artist_extra) as original;" },
      'Five rows replace six, and a new language is now one row however many instruments Mira plays. With more artists and more values the saving grows quickly.',
      wb('artist_extra(artist, instrument, language)', 'artist ↠ instrument', 'nf', 'See a schema in BCNF but not in 4NF in the workbench'),
      'Tidy up:',
      { sql: 'drop table artist_extra, artist_instrument, artist_language;' },
    ],
  });

  // ---- 7.10 temporal data -----------------------------------------------------------------------------------------------------
  lesson({
    id: 'des-temporal', chapter: 7, title: 'Modelling temporal data', minutes: 10,
    summary: 'Facts change over time. Giving each row a period of validity keeps the history, and asks for new kinds of queries and constraints.',
    body: [
      'A venue can be renamed, when a new sponsor arrives or after a refit. The Theatre table `venue` holds only the current name, so a programme reprinted today shows the new name for a performance given years ago. To keep the history, give each version of the fact a **valid time**: the period during which it was true in the real world.',
      { sql: "drop table if exists venue_name_history;\ncreate table venue_name_history (\n  venue_code varchar(6),\n  venue_name varchar(40),\n  valid_from date,\n  valid_to   date,          -- the first day it no longer holds; far in the future for the current name\n  primary key (venue_code, valid_from),\n  check (valid_from < valid_to)\n);\n-- the Ferry Shed (FER) took its name on 1 July 2025: before that it was the Old Net Loft\ninsert into venue_name_history\n  select venue_code, 'Old Net Loft', date '1990-01-01', date '2025-07-01' from venue where venue_code = 'FER';\ninsert into venue_name_history\n  select venue_code, venue_name, date '2025-07-01', date '9999-12-31' from venue where venue_code = 'FER';\nselect * from venue_name_history order by valid_from;" },
      'Each period is half open, `[valid_from, valid_to)`: it includes its first day and excludes its last. Consecutive versions then meet exactly, with no gap and no overlap.',
      { predict: { q: 'Which name did venue FER have on 1 July 2025?', options: ['Ferry Shed', 'Old Net Loft', 'Both', 'Neither'], answer: 0, explain: 'The old name is valid up to, but not including, 2025-07-01, and the new one from that day on. Half-open periods make every date belong to exactly one version.' }, sql: "select venue_name\nfrom venue_name_history\nwhere valid_from <= date '2025-07-01' and date '2025-07-01' < valid_to;" },
      'The interesting queries are **temporal joins**: join each performance with the venue name that was valid on the day it was given. Performances before the rename show the old name:',
      { sql: "select h.venue_name as name_then,\n       count(*) as performances,\n       min(f.perf_date) as first,\n       max(f.perf_date) as last\nfrom performance f\n  join venue_name_history h\n    on h.venue_code = f.venue_code\n   and h.valid_from <= f.perf_date and f.perf_date < h.valid_to\ngroup by h.venue_name, h.valid_from\norder by h.valid_from;" },
      { h: 'Temporal keys and dependencies' },
      'venue_code is no longer a key: it repeats once per version. What should hold is that **at any one time** a venue has one name. That is a **temporal functional dependency**: venue_code → venue_name holds in every snapshot of the table taken at a single instant. It fails exactly when two versions of one venue overlap:',
      { sql: "insert into venue_name_history\n  select venue_code, 'The Sponsor Hall', date '2026-01-01', date '9999-12-31' from venue where venue_code = 'FER';\nselect a.venue_code, a.venue_name, b.venue_name as overlapping_name\nfrom venue_name_history a join venue_name_history b\n  on a.venue_code = b.venue_code and a.valid_from < b.valid_from\n and (a.valid_from, a.valid_to) overlaps (b.valid_from, b.valid_to);", note: 'The new row overlaps the current one. The primary key did not catch it, because the start dates differ.' },
      'Systems that support temporal data directly can enforce this with a constraint over periods. Without that, a trigger or a check in the application has to run a query like the one above on every change.',
      { tip: 'Valid time is about the real world. **Transaction time** is about the database: when a row was stored and when it was replaced. A table that records both is called **bitemporal**.' },
      { sql: 'drop table venue_name_history;' },
    ],
  });
})(typeof window !== 'undefined' ? window : globalThis);
