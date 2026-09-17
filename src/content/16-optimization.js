// Chapter 16: query optimization. Equivalence rules, pushing selections and projections down, statistics and
// estimates, join ordering by dynamic programming, decorrelating nested subqueries, and materialized views.
(function (root) {
  'use strict';
  const K = root.K;
  const C = K.Content;
  const P = () => C.phys;
  const num = (truth, opts) => (app, a) => P().number(truth, opts)(app, a);
  const FOUR = "select pa.name, pf.perf_date\nfrom patron pa\n  join booking b on pa.patron_id = b.patron_id\n  join performance pf on b.perf_id = pf.perf_id\n  join venue v on pf.venue_code = v.venue_code\nwhere v.city = 'Vantmoor';";

  C.lesson({
    id: 'opt-equivalence', chapter: 16, title: 'Equivalence rules', minutes: 12,
    summary: 'Two expressions are equivalent if they give the same result on every database. A handful of rules generate the equivalent forms an optimizer chooses among.',
    body: [
      'A query can be written as many relational-algebra expressions that always give the same answer. The optimizer generates such alternatives with **equivalence rules**, estimates the cost of evaluating each, and keeps the cheapest. The main rules:',
      { table: [['Rule', 'In words'],
        ['σθ1∧θ2(E) = σθ1(σθ2(E))', 'a conjunctive selection is a cascade of selections'],
        ['σθ1(σθ2(E)) = σθ2(σθ1(E))', 'selections commute'],
        ['σθ(E1 × E2) = E1 ⋈θ E2', 'a selection over a product is a theta join'],
        ['E1 ⋈ E2 = E2 ⋈ E1', 'joins commute'],
        ['(E1 ⋈ E2) ⋈ E3 = E1 ⋈ (E2 ⋈ E3)', 'natural joins associate'],
        ['σθ0(E1 ⋈ E2) = σθ0(E1) ⋈ E2', 'a selection on the attributes of E1 alone moves below the join'],
        ['πL(E1 ⋈θ E2) = πL(πL1(E1) ⋈θ πL2(E2))', 'a projection moves below a join, keeping the join attributes'],
        ['σP(E1 ∪ E2) = σP(E1) ∪ σP(E2)', 'a selection distributes over union (and over ∩ and −)']] },
      'Commutativity and associativity of joins alone generate a great many join orders (lesson 4 counts them). Pushing selections and projections down makes intermediate results smaller.',
      { view: 'algebra', sel: { expr: 'π[title, name](σ[runtime_min > 150 ∧ budget > 1000000](production ⋈ company))', mode: 'rules' }, label: 'Open this expression in the algebra workbench, rules mode' },
      { steps: ['The workbench shows the expression as a tree. In **Equivalence rules** mode, nodes where some rule applies carry a number.', 'Select the selection node: the rules listed include splitting the conjunction and pushing each part to the side of the join it belongs to.', 'Apply them one at a time. After each rewrite the workbench evaluates the new expression and confirms the result is unchanged.'] },
      { predict: { q: '`runtime_min > 150` refers only to `production`, and `budget > 1000000` only to `company`. Where do the two selections end up after pushing them as far down as the rules allow?', options: ['Each directly on its own relation, below the join', 'Both stay above the join, since they were written there', 'Both on `production`'], answer: 0, explain: 'Split σ[a ∧ b] into σ[a](σ[b](...)), then push each through the join to the side whose attributes it uses. The join then combines only the long productions with only the companies with budgets over a million.' } },
      'The SQL optimizer does the same thing. Ask for the plan of the equivalent query and look at where each condition is applied:',
      { sql: 'explain\nselect p.title, c.name\nfrom production p join company c on p.company_id = c.company_id\nwhere p.runtime_min > 150 and c.budget > 1000000;', note: 'Each **Filter** sits on its own scan, below the join.' },
      'An equivalence rule must hold for every database, not just this one. Some tempting rewrites are wrong. A selection on the nullable side of an outer join cannot simply be pushed below it, because the outer join creates the null rows the selection would then never see:',
      { sql: "explain\nselect c.name, p.title\nfrom company c left join production p on c.company_id = p.company_id\nwhere p.genre = 'opera';", note: 'Kwery keeps the condition above the outer join, which is always safe. Since `p.genre = \'opera\'` is false for the null rows the left join adds (a company with no productions), rule 16 would allow turning the left join into an inner join and pushing the condition down; with `p.genre is null` neither rewrite would be allowed. Kwery\'s planner does not apply rule 16.' },
      { tip: 'The workbench lists rules 14 to 16 for outer joins: which rewrites are safe, and when an outer join becomes an inner join.' },
    ],
  });

  C.lesson({
    id: 'opt-pushdown', chapter: 16, title: 'Pushing selections and projections down', minutes: 10,
    summary: 'Do selections as early as possible, and drop unneeded attributes as early as possible: the two heuristics behind nearly every good plan, visible in Kwery\'s plans.',
    body: [
      'Two heuristics come straight from the equivalence rules:',
      { list: ['**Perform selections early.** A selection reduces the size of everything above it, and a selection on a base relation may use an index.', '**Perform projections early.** Attributes nobody above needs make every tuple wider, and wider tuples mean more blocks.'] },
      'Write a query with the selection where SQL puts it, after all the joins:',
      { sql: "explain\nselect pa.name, b.perf_id\nfrom patron pa, booking b, performance pf\nwhere pa.patron_id = b.patron_id and b.perf_id = pf.perf_id\n  and pf.venue_code = 'RIV' and b.rating = 5;" },
      { predict: { q: 'Where does the plan apply `pf.venue_code = \'RIV\'`?', options: ['As a filter on the scan of performance, at the bottom of the plan', 'On the result of the three-way join, at the top', 'On the join of booking and performance'], answer: 0, explain: 'The planner splits the WHERE clause into conjuncts and gives each to the lowest place that has all its attributes: one-relation conditions go to the scans, two-relation conditions become join conditions. The written FROM list with commas is a Cartesian product; the equalities turn it into joins.' } },
      { view: 'plan', label: 'Open the plan view' },
      { steps: ['Run the query with the plan view open and choose the **Algebra** tab: the plan written as one expression, with σ on each relation and the joins above.', 'Back in **Physical plan**, click a scan and look at **Columns out**: each scan passes up only the columns used above it, which is projection pushed down.'] },
      'Pushdown also works through a subquery in FROM, when the subquery allows it:',
      { sql: "explain\nselect *\nfrom (select patron_id, name, city, points from patron where points > 300) keen\nwhere city = 'Vantmoor';", note: 'The outer condition joins the inner one on the scan of `patron`; the Subquery Scan above it only passes the rows on.' },
      'It cannot pass through an aggregation on attributes that are aggregated: a condition on `count(*)` must wait for the count. (A condition on a grouping attribute could go below the grouping, rule 13 in the workbench; Kwery\'s planner leaves such conditions above the aggregation too.)',
      { sql: "explain\nselect city, n\nfrom (select city, count(*) as n from patron group by city) per_city\nwhere n > 20;" },
      { tip: 'These are heuristics, not laws: a selection that is expensive to evaluate (a call to a slow function, say) might better be applied after a join has removed most rows. Cost-based optimizers weigh that.' },
    ],
  });

  C.lesson({
    id: 'opt-statistics', chapter: 16, title: 'Statistics and estimates', minutes: 14,
    summary: 'The optimizer chooses by estimated cost, and estimates come from statistics: numbers of tuples, distinct values, the most common values and histograms. ANALYZE gathers them; EXPLAIN ANALYZE shows how good the guesses were.',
    body: [
      'For each relation r the catalog keeps n_r (tuples), b_r (blocks) and, for each attribute A, V(A, r): the number of distinct values. With only these, the classic estimates are:',
      { list: ['σA=v(r): n_r / V(A, r) tuples, assuming values are equally common', 'σA≤v(r): n_r · (v − min(A, r)) / (max(A, r) − min(A, r)), assuming values are spread evenly', 'a conjunction: n_r times the product of the selectivities, assuming the conditions are independent', 'a disjunction: n_r · (1 − (1 − s1/n_r) · (1 − s2/n_r) · ...)', 'a join on A: n_r · n_s / max(V(A, r), V(A, s)); a join on a key of s: at most n_r'] },
      'Uniformity is often false. Real systems therefore keep, per attribute, the **most common values** with their frequencies, and an **equi-depth histogram** of the rest: bucket boundaries chosen so that each bucket holds the same number of tuples.',
      'Make a relation with a skewed column: 88% of orders are done, 10% open, 2% lost.',
      { sql: "drop table if exists orders;\ncreate table orders as\n  select i as id,\n    case when i % 10 = 0 then 'open' when i % 50 = 1 then 'lost' else 'done' end as status,\n    (i * 37) % 1000 as amount\n  from generate_series(1, 5000) i;\nexplain analyze select * from orders where status = 'open';", note: 'Without statistics the planner guesses a fixed 0.5% for an equality: 25 rows estimated, 500 actual.' },
      { sql: "analyze orders;\nselect attname, n_distinct, most_common_vals, most_common_freqs\nfrom pg_stats where tablename = 'orders';" },
      { predict: { q: '`done` is in the most-common-values list with frequency 0.88; `open` is not. What will the planner estimate for `status = \'open\'` now?', options: ['300: the remaining 12% shared evenly by the two other values', '500, exactly right', '4,400'], answer: 0, explain: 'Values outside the MCV list share what the list leaves over, evenly: (1 − 0.88) / 2 = 0.06 of 5,000 = 300. Better than 25, but the uniformity assumption is still there, one level down.' }, sql: "explain analyze select * from orders where status = 'open';" },
      'For ranges, the histogram:',
      { sql: "select histogram_bounds from pg_stats where tablename = 'orders' and attname = 'amount';\nexplain analyze select * from orders where amount < 100;", note: 'Each bucket of the histogram holds about 1% of the rows; `amount < 100` covers about ten buckets, so 500 estimated, 500 actual.' },
      'Now two conditions at once:',
      { sql: "explain analyze select * from orders where status = 'open' and amount < 100;", note: 'The estimate multiplies 0.06 by 0.1, assuming the conditions are independent: 30 estimated, 50 actual. When columns are correlated, estimates of conjunctions are the weakest point of the model.' },
      'The Theatre data has skew of its own: a few venues stage most of the performances. Compare the estimate with the truth for one of the busy venues, then for a quiet one:',
      { sql: "analyze performance;\nselect most_common_vals, most_common_freqs from pg_stats\nwhere tablename = 'performance' and attname = 'venue_code';\nexplain analyze select * from performance where venue_code = 'RIV';\nexplain analyze select * from performance where venue_code = 'GLA';", note: 'A venue in the most-common list is estimated from its own frequency, so the estimate is exact here (ANALYZE read every row of this small table). A venue outside it gets an even share of what the list leaves over.' },
      { tip: 'ANALYZE in Kwery keeps up to 100 most common values and 100 histogram buckets per column, as PostgreSQL does by default, and also the correlation between a column\'s order and the physical row order, which the planner uses to cost index scans (the clustering effect of chapter 14). `pg_stats` shows the null fraction, distinct count, MCVs and histogram.' },
      { sql: 'drop table orders;' },
    ],
  });

  C.lesson({
    id: 'opt-join-order', chapter: 16, title: 'Choosing a join order by dynamic programming', minutes: 14,
    summary: 'n relations can be joined in a huge number of orders. Dynamic programming finds the cheapest by building the best plan for every subset from the best plans of its parts.',
    body: [
      'Joins commute and associate, so r1 ⋈ r2 ⋈ ... ⋈ rn can be computed in (2(n − 1))! / (n − 1)! orders: 12 for three relations, 120 for four, 30,240 for six. Trying each separately is out of the question for large n.',
      'But the best way to join a set S of relations does not depend on what is done with the result afterwards (apart from its sort order). So:',
      { steps: ['For each single relation, find its best access path.', 'For each set of 2 relations, the best plan is the cheapest join of its two members.', 'For each set S of k relations, try every way of splitting S into two non-empty parts S1 and S2, take the best plans already found for S1 and S2, and keep the cheapest join of the two.', 'The best plan for the set of all n relations is the answer.'] },
      'This is the **dynamic programming** algorithm, first used in IBM\'s System R. It considers O(3^n) splits instead of n! orders. Restricting it to **left-deep** trees (the right input of every join is a single relation, which suits pipelining and indexed nested loops) cuts that to O(n · 2^n).',
      { sql: 'analyze;\nexplain\n' + FOUR },
      { view: 'plan', label: 'Open the plan view' },
      { steps: ['Run the query above with the plan view open and choose **What the optimizer tried**.', 'Under **join order (dynamic programming over 4 relations)** each row of the lattice is one subset size: 2 relations, 3 relations, 4. Each cell is a subset with the cost and size of its best plan.', 'The access-path tables above it show the best way to read each relation, which the lattice starts from.'] },
      { predict: { q: 'Some pairs, such as {patron, performance}, have no join condition between them. Will the lattice contain them?', options: ['No: the planner skips subsets it could only form by a Cartesian product, when a connected alternative exists', 'Yes: every subset is tried', 'Only if they are small'], answer: 0, explain: 'A Cartesian product is almost never part of a good plan, so the planner considers a split only if a join condition connects the two parts (unless no other way is left). That prunes the lattice a great deal.' } },
      'By default Kwery searches left-deep plans only. **Bushy** plans, with joins on both sides of a join, can be better when two separate small joins can be combined at the end:',
      { sql: 'set bushy = on;\nexplain\n' + FOUR + '\nreset bushy;', note: 'Here the best plan is the same: turning bushy plans on only widens the search, and the optimizer keeps whichever is cheapest.' },
      'With many relations even dynamic programming is too slow. `join_collapse_limit` (8 by default) caps the number of relations searched exhaustively; above it Kwery joins in the written order, greedily choosing an algorithm for each step:',
      { sql: 'set join_collapse_limit = 2;\nexplain\n' + FOUR + '\nreset join_collapse_limit;', note: 'Now the joins follow the FROM clause: patron with booking, then performance, then venue.' },
      { tip: 'Fuller optimizers also track **interesting sort orders**: a plan for a subset that is not the cheapest may still be worth keeping if its result is sorted in a way a later merge join or ORDER BY can use. Kwery keeps only the cheapest plan per subset.' },
    ],
  });

  C.lesson({
    id: 'opt-subqueries', chapter: 16, title: 'Nested subqueries and decorrelation', minutes: 12,
    summary: 'A correlated subquery, run once per outer tuple, is slow. Rewritten as a semijoin or antijoin, it becomes one join, evaluated with the usual algorithms.',
    body: [
      'A subquery that refers to the outer query is **correlated**. Taken literally, it is evaluated again for each tuple of the outer query, like a nested loop that cannot use any of the better join algorithms: **correlated evaluation**.',
      'The optimizer can often do better by **decorrelation**: rewriting the query as a join. EXISTS becomes a **semijoin** (⋉: each outer tuple at most once, if it has a match), NOT EXISTS an **antijoin** (▷: the outer tuples with no match), and IN a semijoin on the tested attribute.',
      { sql: 'explain\nselect name from patron p\nwhere exists (select 1 from booking b where b.patron_id = p.patron_id);' },
      { predict: { q: 'What will the plan for the NOT EXISTS version look like?', options: ['An anti join of patron and booking', 'A scan of patron with a subplan run for every patron', 'A join followed by a filter on NULLs'], answer: 0, explain: 'The subquery\'s condition `b.patron_id = p.patron_id` becomes the join condition and NOT EXISTS the anti join, evaluated with one pass over booking rather than one per patron. The optimizer\'s trace says so: "subquery rewritten as an antijoin".' }, sql: 'explain\nselect name from patron p\nwhere not exists (select 1 from booking b where b.patron_id = p.patron_id);' },
      'Not every subquery can be rewritten this way. A correlated scalar subquery, which computes a value for each outer tuple, stays a subplan here:',
      { sql: 'explain\nselect title, runtime_min from production p\nwhere runtime_min > (select avg(runtime_min) from production q where q.genre = p.genre);', note: 'SubPlan 1 runs once per production. By hand you could decorrelate it: compute the average per genre once, with GROUP BY, and join.' },
      'NOT IN looks like NOT EXISTS but is not equivalent when NULLs are about: if the subquery returns a NULL, `x not in (...)` is never true. So the optimizer must not turn it into an antijoin unless it knows there are no NULLs, and Kwery leaves it as a subplan:',
      { sql: 'explain\nselect title from production\nwhere prod_id not in (select prod_id from performance);' },
      { view: 'plan', label: 'Open the plan view' },
      { steps: ['Run the NOT EXISTS query with the plan view open and choose **What the optimizer tried**: the first entry records the rewrite into an antijoin.', 'In the **Physical plan** the join is drawn with ▷ (anti) or ⋉ (semi).'] },
      { tip: 'Decorrelation is one of the rewrites that matter most in practice: a query that runs a subquery for each of a million rows can become a single hash join.' },
    ],
  });

  C.lesson({
    id: 'opt-matviews', chapter: 16, title: 'Materialized views and their maintenance', minutes: 10,
    summary: 'A materialized view stores its result. Queries read it cheaply, but every change to the base relations makes it stale until it is recomputed, or, better, updated by just the difference.',
    body: [
      'A view is normally a stored query, expanded into every query that uses it. A **materialized view** stores the result as well, so that reading it costs a scan of a small relation instead of the whole computation. Summaries over large relations are the classic use.',
      { sql: 'drop materialized view if exists genre_time;\ncreate materialized view genre_time as\n  select genre, count(*) as n, sum(runtime_min) as total\n  from production group by genre;\nexplain select * from genre_time where n > 7;', note: 'The plan reads `genre_time` like a table: the grouping is not redone.' },
      'The cost is keeping it correct. Add a production inside a transaction (rolled back at the end, so the Theatre data stays as it was):',
      { predict: { q: 'After the insert, what does `genre_time` say for opera?', options: ['The old numbers: the view is not updated until it is refreshed', 'The new numbers: every change is applied at once', 'Nothing: the view is emptied'], answer: 0, explain: 'In Kwery, as in PostgreSQL, a materialized view is recomputed only by REFRESH MATERIALIZED VIEW. Until then queries see the old result.' }, sql: "begin;\ninsert into production values ('PR999', 'The Glass Orchard', 'C04', 'opera', date '2026-05-01', 140, null);\nselect * from genre_time where genre = 'opera';" },
      { sql: "refresh materialized view genre_time;\nselect * from genre_time where genre = 'opera';\nrollback;", note: 'REFRESH recomputed the whole view to change one row of it.' },
      { h: 'Incremental view maintenance' },
      'Recomputing everything is wasteful. **Incremental maintenance** computes the change to the view from the change to the base relations, the **differential**:',
      { list: ['For a join v = r ⋈ s, inserting the set i_r into r inserts i_r ⋈ s into v; deleting d_r deletes d_r ⋈ s.', 'For a selection or a projection, apply the selection or projection to the inserted or deleted tuples. A projection that removes duplicates must count how many times each tuple was derived, so that a deletion removes it only when the count reaches zero.', 'For count and sum grouped by G, an inserted tuple adds 1 and its value to its group (creating the group if needed); a deleted one subtracts them (removing the group at count 0). avg is kept as sum and count.', 'min and max are easy on insertion, but deleting the current minimum requires looking at the other tuples of the group again.'] },
      'Systems maintain views **immediately**, as part of the transaction that changes the base relations, or **deferred**, periodically or when the view is read.',
      { h: 'Using materialized views when optimizing' },
      'A query that matches a materialized view can be rewritten to use it, and conversely a query on a view may be cheaper evaluated from the base relations if a selection can be pushed into them. Choosing which views to materialize, given a workload, is **materialized view selection**, a tuning problem much like choosing indexes. Kwery does not rewrite queries to use materialized views automatically: you name the view in the query.',
      { sql: "select matviewname, ispopulated from pg_matviews;\ndrop materialized view genre_time;" },
    ],
  });

  // ---- exercises -----------------------------------------------------------------------------------------------------------
  // Estimates on the Theatre (large) sample: booking has 45,000 tuples over 2,400 performances and 6,000 patrons.
  C.exercise({
    id: 'ex16-eq', chapter: 16, level: 1, kind: 'number', title: 'Estimating an equality',
    text: ['In Theatre (large), `booking` has 45,000 tuples and V(perf_id, booking) = 2,400 distinct performances. Assuming every performance is booked equally often, how many tuples does the optimizer estimate for σperf_id = v(booking)? Give two decimal places.'],
    hints: ['Each value is assumed to appear equally often, so each gets the same share of the tuples.', 'n_r / V(A, r).', 'Worked answer: 45000 / 2400 = **18.75** tuples.'],
    check: num(18.75, { tol: 0.006 }), solution: 18.75,
    wrongs: ['2400', '45000', '19'],
  });
  C.exercise({
    id: 'ex16-range', chapter: 16, level: 1, kind: 'number', title: 'Estimating a range',
    text: ['For the same 45,000 bookings, suppose ANALYZE found min(paid) = 0 and max(paid) = 680, and nothing more is known, so the amounts are taken to be spread evenly. How many tuples does σpaid ≤ 170(booking) have, by that estimate?'],
    hints: ['The fraction of the range covered is (170 − min) / (max − min).', '170 / 680 = 0.25.', 'Worked answer: 45000 · 0.25 = **11,250** tuples.'],
    check: num(11250), solution: 11250, solutionText: '11,250',
    wrongs: ['42500', '0.25', '11000'],
  });
  C.exercise({
    id: 'ex16-and', chapter: 16, level: 1, kind: 'number', title: 'A conjunction',
    text: ['Of the 45,000 bookings, `rating = 5` holds for 10% and `seats = 2` for 40%. Assuming the two are independent, how many bookings does the optimizer expect to satisfy both?'],
    hints: ['Independent conditions: multiply the fractions.', '0.1 · 0.4 = 0.04.', 'Worked answer: 45000 · 0.04 = **1,800** tuples.'],
    check: num(1800), solution: 1800, solutionText: '1,800',
    wrongs: ['22500', '0.04', '4500'],
  });
  C.exercise({
    id: 'ex16-or', chapter: 16, level: 2, kind: 'number', title: 'A disjunction',
    text: ['Same bookings and conditions (`rating = 5` for 10%, `seats = 2` for 40%, independently). How many satisfy `rating = 5 or seats = 2`?'],
    hints: ['A booking fails the disjunction only if it fails both conditions.', 'The fraction failing both is 0.9 · 0.6 = 0.54.', 'Worked answer: 45000 · (1 − 0.54) = **20,700** tuples.'],
    check: num(20700, { why: (v) => (v === 22500 ? 'Adding the two counts counts the bookings satisfying both twice.' : null) }), solution: 20700, solutionText: '20,700',
    wrongs: ['22500', '1800', '24300'],
  });
  C.exercise({
    id: 'ex16-join-size', chapter: 16, level: 2, kind: 'number', title: 'The size of a join',
    text: ['In Theatre (large), `patron` has 6,000 tuples and `venue` has 30. A query pairs each patron with the venues in their home town: `patron ⋈ venue` on `city`, a key of neither. Take V(city, patron) = 16 and V(city, venue) = 20. What is the standard estimate of the size of the join?'],
    hints: ['Two estimates: n_r · n_s / V(A, s) and n_r · n_s / V(A, r). Take the smaller.', '180,000 / 16 = 11,250 and 180,000 / 20 = 9,000.', 'Worked answer: **9,000** tuples, that is n_r · n_s / max(V(A, r), V(A, s)).'],
    check: num(9000, { why: (v) => (v === 11250 ? 'That is the larger of the two estimates; take the smaller.' : null) }), solution: 9000, solutionText: '9,000',
    wrongs: ['11250', '180000', '6000'],
  });
  C.exercise({
    id: 'ex16-join-key', chapter: 16, level: 2, kind: 'number', title: 'A join on a key',
    text: ['In the Theatre database, `booking.patron_id` is a foreign key (not null) referencing `patron.patron_id`, the key of `patron`. Without running the join, how many tuples does `booking ⋈ patron` (on patron_id) have? You may count the tuples of one relation.'],
    hints: ['Each booking matches exactly one patron, because patron_id is the key of patron and the foreign key guarantees the patron exists.', 'So the join has as many tuples as one of the two relations. Which?', 'Worked answer: as many as `booking`: `select count(*) from booking` gives **1100**.'],
    check: num((app) => Number(P().theatre(app).exec('select count(*) from booking')[0].rows[0][0]), { why: (v) => (v === 200 ? 'That is the number of patrons; a patron can have many bookings.' : null) }), solution: 1100,
    wrongs: ['200', '220000', '1300'],
  });
  C.exercise({
    id: 'ex16-planner-estimate', chapter: 16, level: 2, kind: 'number', title: 'What does the planner expect?',
    text: ['After `analyze performance`, how many rows does the planner estimate for `select * from performance where venue_code = \'FER\'`? Work it out from `pg_stats` (the most common values and their frequencies, and the number of performances), then confirm with `explain`.'],
    hints: ["`select most_common_vals, most_common_freqs from pg_stats where tablename = 'performance' and attname = 'venue_code'`.", 'FER is in the list; multiply its frequency by the number of performances, 180.', 'Worked answer: 0.25 · 180 = **45** rows.'],
    check: num((app) => { const s = P().theatre(app, 'analyze performance'); const line = s.exec("explain select * from performance where venue_code = 'FER'")[0].rows[0][0]; return Number(/rows=(\d+)/.exec(line)[1]); }), solution: 45,
    wrongs: ['64', '0.25', '22'],
  });
  C.exercise({
    id: 'ex16-mcv', chapter: 16, level: 1, kind: 'number', title: 'Read a statistic',
    text: ['Run `analyze performance` and query `pg_stats`. What frequency does ANALYZE record for the venue `LAN` among the most common values of `venue_code`? Give four decimal places.'],
    hints: ['The columns `most_common_vals` and `most_common_freqs` are lists in the same order.', "`select most_common_vals, most_common_freqs from pg_stats where tablename = 'performance' and attname = 'venue_code';`", 'Worked answer: **0.2167** (39 of the 180 performances).'],
    check: num((app) => { const s = P().theatre(app, 'analyze performance'); const r = s.exec("select most_common_vals, most_common_freqs from pg_stats where tablename = 'performance' and attname = 'venue_code'")[0].rows[0]; const vals = String(r[0]).replace(/[{}]/g, '').split(','); const fr = String(r[1]).replace(/[{}]/g, '').split(',').map(Number); return fr[vals.indexOf('LAN')]; }, { tol: 0.0006 }), solution: 0.2167,
    wrongs: ['0.3556', '0.25', '39'],
  });
  C.exercise({
    id: 'ex16-orders', chapter: 16, level: 2, kind: 'number', title: 'How many join orders?',
    text: ['How many different join orders (join trees, counting both inputs of each join as ordered) are there for joining 5 relations? Use (2(n − 1))! / (n − 1)!.'],
    hints: ['n = 5: (2 · 4)! / 4!.', '8! = 40,320 and 4! = 24.', 'Worked answer: 40320 / 24 = **1,680**.'],
    check: num(1680), solution: 1680, solutionText: '1,680',
    wrongs: ['120', '40320', '1024'],
  });
  C.exercise({
    id: 'ex16-left-deep', chapter: 16, level: 1, kind: 'number', title: 'Left-deep orders',
    text: ['How many left-deep join orders are there for 5 relations (each join\'s right input a single base relation)?'],
    hints: ['A left-deep tree is fixed by the order in which the relations join in.', 'That is a permutation of the 5 relations.', 'Worked answer: 5! = **120**.'],
    check: num(120), solution: 120,
    wrongs: ['1680', '25', '60'],
  });
  C.exercise({
    id: 'ex16-dp-sets', chapter: 16, level: 2, kind: 'number', title: 'The dynamic-programming table',
    text: ['The dynamic-programming join-order algorithm keeps a best plan for every subset of the relations with at least two members. For 5 relations, how many such subsets are there (ignoring the pruning of unconnected subsets)?'],
    hints: ['There are 2^5 subsets in all, the empty one included.', 'Leave out the empty set and the 5 single relations.', 'Worked answer: 32 − 1 − 5 = **26** subsets.'],
    check: num(26), solution: 26,
    wrongs: ['32', '31', '27'],
  });
  C.exercise({
    id: 'ex16-antijoin', chapter: 16, level: 2, title: 'Productions never staged, as an antijoin',
    text: ['List the `prod_id` and `title` of every production that has no performance at all, with a query the optimizer evaluates as an anti join (the plan must show `Anti Join`).'],
    hints: ['A production qualifies if no performance has its prod_id.', 'NOT IN is not turned into an antijoin, because of what NULLs do to it. Which form is?', "Use `where not exists (select 1 from performance pf where pf.prod_id = pr.prod_id)`."],
    ref: 'select pr.prod_id, pr.title\nfrom production pr\nwhere not exists (select 1 from performance pf where pf.prod_id = pr.prod_id);',
    check: (app, a) => P().sqlPlan({ theatre: true, ref: 'select pr.prod_id, pr.title from production pr where not exists (select 1 from performance pf where pf.prod_id = pr.prod_id)', plan: /Anti Join/, planMessage: 'The rows are right, but the plan has no anti join. Which way of writing "has no performance" does the optimizer decorrelate?' })(app, a),
    wrongs: ['select pr.prod_id, pr.title from production pr where prod_id not in (select prod_id from performance);', 'select prod_id, title from production;'],
  });
})(typeof window !== 'undefined' ? window : globalThis);
