// Chapter 2 relational algebra exercises over the Theatre database, answered in the algebra workbench. The check
// evaluates the student's expression next to the reference on a fresh copy of the Theatre data and on randomized
// variants of it, so any correct expression passes and one that only fits the sample data is caught with a
// counterexample. Each exercise lists plausible wrong answers (`wrongs`) that the check must turn down.
(function (root) {
  'use strict';
  const K = root.K;
  const C = K.Content;
  const X = K.Exercises;
  if (!C || !X || !K.Algebra) return;

  // { id, title, level, prompt, solution, wrongs, hints }; the last hint is the worked answer
  const LIST = [
    { id: 'ra-operas', title: 'Selection and projection', level: 1, prompt: 'Find the titles of all the operas.', solution: 'π[title](σ[genre = "opera"](production))',
      wrongs: ['σ[genre = "opera"](production)', 'π[title](production)', 'π[title](σ[genre = "Opera"](production))'],
      hints: ['Two operators: one chooses tuples, the other chooses attributes.', 'σ[genre = "opera"](production) keeps the operas.', 'π[title](σ[genre = "opera"](production))'] },
    { id: 'ra-big-stages', title: 'Selection on a number', level: 1, prompt: 'Find the venue code and stage number of every stage with more than 1000 seats.', solution: 'π[venue_code, stage_no](σ[seats > 1000](stage))',
      wrongs: ['π[venue_code](σ[seats > 1000](stage))', 'π[venue_code, stage_no](σ[seats < 1000](stage))', 'π[venue_code, stage_no](stage)'],
      hints: ['The condition compares a number: no quotes around 1000.', 'σ[seats > 1000](stage) keeps the right tuples.', 'π[venue_code, stage_no](σ[seats > 1000](stage))'] },
    { id: 'ra-rich-companies', title: 'Conjunctive selection', level: 1, prompt: 'Find the names of the companies based in Brightwater whose budget is at least 400000.', solution: 'π[name](σ[city = "Brightwater" ∧ budget >= 400000](company))',
      wrongs: ['π[name](σ[city = "Brightwater" ∨ budget >= 400000](company))', 'π[name](σ[city = "Brightwater"](company))', 'π[name](σ[budget >= 400000](company))'],
      hints: ['Both conditions are on company.', 'Combine them in one selection with ∧, or nest two selections.', 'π[name](σ[city = "Brightwater" ∧ budget >= 400000](company))'] },
    { id: 'ra-theatre-cities', title: 'Union', level: 1, prompt: 'Find every city that is home to a company, has a venue, or both.', solution: 'π[city](company) ∪ π[city](venue)',
      wrongs: ['π[city](company)', 'π[city](company) ∩ π[city](venue)', 'π[city](company ⋈ venue)'],
      hints: ['Both company and venue have a city attribute.', 'Union needs compatible operands: project both on city first.', 'π[city](company) ∪ π[city](venue)'] },
    { id: 'ra-never-performed', title: 'Difference', level: 1, prompt: 'Find the IDs of the productions that have never been performed.', solution: 'π[prod_id](production) − π[prod_id](performance)',
      wrongs: ['π[prod_id](performance) − π[prod_id](production)', 'π[prod_id](σ[premiere = null](production))', 'π[prod_id](production)'],
      hints: ['Which productions have been performed? They appear in performance.', 'All production IDs minus those in performance.', 'π[prod_id](production) − π[prod_id](performance)'] },
    { id: 'ra-dancers', title: 'Join', level: 2, prompt: 'Find the given and family names of the people cast in a dance production.', solution: 'π[given_name, family_name](person ⋈ casting ⋈ σ[genre = "dance"](production))',
      wrongs: ['π[given_name, family_name](person ⋈ artist ⋈ casting ⋈ σ[genre = "dance"](production))', 'π[given_name, family_name](person ⋈ casting)', 'π[given_name, family_name](person × σ[genre = "dance"](production))'],
      hints: ['person and casting share person_id; casting and production share prod_id.', 'Leave artist out: it shares company_id with production, and a natural join would match on it too.', 'π[given_name, family_name](person ⋈ casting ⋈ σ[genre = "dance"](production))'] },
    { id: 'ra-shared-cities', title: 'Intersection', level: 2, prompt: 'Find the cities that are home to a company and also have a venue.', solution: 'π[city](company) ∩ π[city](venue)',
      wrongs: ['π[city](company) ∪ π[city](venue)', 'π[city](venue)', 'π[city](venue) − π[city](company)'],
      hints: ['A city in both sets.', 'Intersection ∩ of the two projections.', 'π[city](company) ∩ π[city](venue)'] },
    { id: 'ra-venue-only-cities', title: 'Difference of projections', level: 2, prompt: 'Find the cities that have a venue but are home to no company.', solution: 'π[city](venue) − π[city](company)',
      wrongs: ['π[city](company) − π[city](venue)', 'π[city](venue)', 'π[city](venue) ∩ π[city](company)'],
      hints: ['"But not" is a set difference.', 'Both operands must have the same attributes: city alone.', 'π[city](venue) − π[city](company)'] },
    { id: 'ra-never-cast', title: 'Difference or antijoin', level: 2, prompt: 'Find the person ID and billing name of each artist who has never been cast.', solution: 'π[person_id, billed_as](artist) − π[person_id, billed_as](artist ⋈ casting)',
      wrongs: ['π[person_id, billed_as](artist)', 'π[person_id, billed_as](artist ⋈ casting)', 'π[person_id, billed_as](σ[company_id = null](artist))'],
      hints: ['Start from all artists and remove the ones who were cast.', 'The ones who were cast are those that join with casting.', 'π[person_id, billed_as](artist) − π[person_id, billed_as](artist ⋈ casting), or with the antijoin: π[person_id, billed_as](artist ▷ casting).'] },
    { id: 'ra-company-productions', title: 'Left outer join', level: 2, prompt: 'List every company name with the ID of each of its productions; a company without productions must appear too, with a null ID.', solution: 'π[name, prod_id](company ⟕ production)',
      wrongs: ['π[name, prod_id](company ⋈ production)', 'π[name, prod_id](company ⟖ production)', 'π[name](company)'],
      hints: ['company and production share company_id.', 'An ordinary join drops the companies that match nothing: which outer join keeps the left side?', 'π[name, prod_id](company ⟕ production)'] },
    { id: 'ra-genre-count', title: 'Counting per group', level: 2, prompt: 'For each genre, find the number of productions; name the attributes genre and n.', solution: 'genre γ count(prod_id) → n (production)',
      wrongs: ['γ[count(prod_id) → n](production)', 'genre γ count(based_on) → n (production)', 'company_id γ count(prod_id) → n (production)'],
      hints: ['This needs the aggregation operator γ.', 'Group by genre and count the productions.', 'genre γ count(prod_id) → n (production), or γ[genre, count(prod_id) → n](production).'] },
    { id: 'ra-avg-fee', title: 'Selecting on an aggregate', level: 2, prompt: 'Find the company IDs whose artists earn an average fee above 1500. (Freelance artists, whose company_id is null, form a group of their own.)', solution: 'π[company_id](σ[avg_fee > 1500](company_id γ avg(fee) → avg_fee (artist)))',
      wrongs: ['π[company_id](σ[fee > 1500](artist))', 'π[company_id](σ[avg_fee > 1500](company_id γ max(fee) → avg_fee (artist)))', 'π[company_id](σ[avg_fee >= 1500](company_id γ avg(fee) → avg_fee (artist)))'],
      hints: ['First compute each company\'s average, then compare it.', 'The average is an attribute of the result of γ, so a selection can test it.', 'π[company_id](σ[avg_fee > 1500](company_id γ avg(fee) → avg_fee (artist)))'] },
    { id: 'ra-pricey-patrons', title: 'Semijoin', level: 2, prompt: 'Find the ID and name of each patron who booked at least one performance priced at 55 or more.', solution: 'π[patron_id, name](patron ⋉ (booking ⋈ σ[price >= 55](performance)))',
      wrongs: ['π[patron_id, name](patron)', 'π[patron_id, name](patron ⋉ booking)', 'π[patron_id, name](patron ⋉ (booking ⋈ σ[price > 55](performance)))'],
      hints: ['booking records which patron saw which performance; the price is on performance.', 'A semijoin r ⋉ s keeps the tuples of r that have a match in s, without the attributes of s.', 'π[patron_id, name](patron ⋉ (booking ⋈ σ[price >= 55](performance)))'] },
    { id: 'ra-venue-capacity', title: 'Two aggregates', level: 2, prompt: 'For each venue code, find the number of stages and their total number of seats; name the attributes venue_code, stages and capacity.', solution: 'venue_code γ count(stage_no) → stages, sum(seats) → capacity (stage)',
      wrongs: ['venue_code γ count(stage_no) → stages, max(seats) → capacity (stage)', 'venue_code γ sum(stage_no) → stages, sum(seats) → capacity (stage)', 'kind γ count(stage_no) → stages, sum(seats) → capacity (stage)'],
      hints: ['Group the stages by venue.', 'One γ can compute several aggregates, separated by commas.', 'venue_code γ count(stage_no) → stages, sum(seats) → capacity (stage)'] },
    { id: 'ra-price-rise', title: 'Generalized projection', level: 2, prompt: 'Give the ID and the price after a 10% rise, as new_price, of each performance currently priced above 50.', solution: 'π[perf_id, price * 1.1 → new_price](σ[price > 50](performance))',
      wrongs: ['π[perf_id, price → new_price](σ[price > 50](performance))', 'π[perf_id, price * 0.1 → new_price](σ[price > 50](performance))', 'π[perf_id, price * 1.1 → new_price](performance)'],
      hints: ['A projection may compute expressions, not only keep attributes.', 'Name a computed attribute with → (or "as" in ASCII).', 'π[perf_id, price * 1.1 → new_price](σ[price > 50](performance))'] },
    { id: 'ra-top-fee', title: 'The largest, without max', level: 3, prompt: 'Find the highest artist fee using only selection, projection, product, rename and difference.', solution: 'π[fee](artist) − π[a.fee](σ[a.fee < b.fee](ρ[a](artist) × ρ[b](artist)))',
      wrongs: ['π[a.fee](σ[a.fee < b.fee](ρ[a](artist) × ρ[b](artist)))', 'π[fee](artist) − π[a.fee](σ[a.fee <= b.fee](ρ[a](artist) × ρ[b](artist)))', 'π[fee](artist)'],
      hints: ['A fee is the largest when no fee is larger.', 'Compare artist with a renamed copy of itself: ρ[a](artist) × ρ[b](artist).', 'The fees smaller than some other fee are π[a.fee](σ[a.fee < b.fee](...)); subtract them from all fees: π[fee](artist) − π[a.fee](σ[a.fee < b.fee](ρ[a](artist) × ρ[b](artist))).'] },
    { id: 'ra-loyal-c04', title: 'Division', level: 3, prompt: 'Find the IDs of the patrons who have booked a performance of every production of company C04.', solution: 'π[patron_id, prod_id](booking ⋈ performance) ÷ π[prod_id](σ[company_id = "C04"](production))',
      wrongs: ['π[patron_id](booking ⋈ performance ⋈ σ[company_id = "C04"](production))', 'π[patron_id, prod_id](booking ⋈ performance) ÷ π[prod_id](production)', 'π[patron_id](booking)'],
      hints: ['"Every production of a company" calls for division.', 'r ÷ s gives the tuples t such that t paired with every tuple of s is in r.', 'π[patron_id, prod_id](booking ⋈ performance) ÷ π[prod_id](σ[company_id = "C04"](production))'] },
    { id: 'ra-own-company', title: 'Natural join on two attributes', level: 3, prompt: 'Find the given and family names of the artists who have been cast in a production of their own company.', solution: 'π[given_name, family_name](person ⋈ artist ⋈ casting ⋈ production)',
      wrongs: ['π[given_name, family_name](person ⋈ casting ⋈ production)', 'π[given_name, family_name](person ⋈ artist)', 'π[given_name, family_name](person ⋈ artist ⋈ casting)'],
      hints: ['artist ⋈ casting gives the productions each artist was cast in; production says which company staged it.', 'A natural join with production matches on every attribute the two sides share: prod_id and company_id.', 'Matching company_id too is exactly "their own company": π[given_name, family_name](person ⋈ artist ⋈ casting ⋈ production).'] },
    { id: 'ra-mentor-names', title: 'Theta joins with rename', level: 3, prompt: 'For every mentoring pair, find the family name of the mentor and of the mentee, as mentor and mentee.', solution: 'π[m.family_name → mentor, e.family_name → mentee](ρ[m](person) ⋈[m.person_id = r.mentor_id] ρ[r](mentor) ⋈[e.person_id = r.mentee_id] ρ[e](person))',
      wrongs: ['π[m.family_name → mentor, e.family_name → mentee](ρ[m](person) ⋈[m.person_id = r.mentee_id] ρ[r](mentor) ⋈[e.person_id = r.mentor_id] ρ[e](person))', 'π[family_name](person ⋈[person_id = mentor_id] mentor)'],
      hints: ['mentor links mentor_id and mentee_id, both persons.', 'person is needed twice: rename the copies, ρ[m](person) and ρ[e](person).', 'π[m.family_name → mentor, e.family_name → mentee](ρ[m](person) ⋈[m.person_id = r.mentor_id] ρ[r](mentor) ⋈[e.person_id = r.mentee_id] ρ[e](person))'] },
    { id: 'ra-company-pairs', title: 'Pairs from a self-join', level: 3, prompt: 'Find every pair of artists of the same company, as id1 and id2 with id1 < id2 (so each pair appears once).', solution: 'π[a.person_id → id1, b.person_id → id2](σ[a.company_id = b.company_id ∧ a.person_id < b.person_id](ρ[a](artist) × ρ[b](artist)))',
      wrongs: ['π[a.person_id → id1, b.person_id → id2](σ[a.company_id = b.company_id ∧ a.person_id <> b.person_id](ρ[a](artist) × ρ[b](artist)))', 'π[a.person_id → id1, b.person_id → id2](σ[a.company_id = b.company_id](ρ[a](artist) × ρ[b](artist)))'],
      hints: ['Two tuples of the same relation: rename two copies of artist.', 'σ over ρ[a](artist) × ρ[b](artist) compares a.company_id with b.company_id.', 'a.person_id < b.person_id keeps each pair once and drops an artist paired with itself.'] },
    { id: 'ra-adaptations', title: 'A relation that refers to itself', level: 3, prompt: 'For every production based on another, find its title and the title of the production it is based on, as adaptation and original.', solution: 'π[p.title → adaptation, o.title → original](ρ[p](production) ⋈[p.based_on = o.prod_id] ρ[o](production))',
      wrongs: ['π[p.title → adaptation, o.title → original](ρ[p](production) ⋈[o.based_on = p.prod_id] ρ[o](production))', 'π[title](σ[based_on ≠ null](production))'],
      hints: ['based_on holds the prod_id of another production.', 'Join two renamed copies of production on p.based_on = o.prod_id.', 'π[p.title → adaptation, o.title → original](ρ[p](production) ⋈[p.based_on = o.prod_id] ρ[o](production))'] },
    { id: 'ra-home-venues', title: 'A natural join on a shared name', level: 3, prompt: 'Pair each company with each venue in the company\'s home city: find the company name and the venue name.', solution: 'π[name, venue_name](company ⋈ venue)',
      wrongs: ['π[name, venue_name](company × venue)', 'π[name, venue_name](company ⋈ production ⋈ performance ⋈ venue)'],
      hints: ['company and venue both have an attribute called city, and nothing else in common.', 'A natural join matches on exactly that.', 'π[name, venue_name](company ⋈ venue)'] },
  ];

  // a fresh Theatre database for checking, so changes made in the editor do not change the answer
  let fresh = null;
  function source(app) {
    if (!fresh && K.SAMPLES && K.SAMPLES.theatre && K.Snapshot) {
      try { const snap = K.SAMPLES.theatre.snapshot; fresh = K.Snapshot.load(snap, { pageSize: snap.pageSize }).session({ name: 'algebra check' }); } catch (e) { fresh = null; }
    }
    return fresh || app.session;
  }

  LIST.forEach((x, i) => {
    const ex = { kind: 'algebra', template: null, seed: i + 1, title: x.title, prompt: x.prompt, solution: x.solution };
    const id = x.id;
    C.exercise({
      id, chapter: 2, kind: 'algebra', db: 'theatre', level: x.level,
      title: ex.title, prompt: ex.prompt, algebra: ex,
      text: [
        ex.prompt,
        'Write a relational algebra expression for it over the Theatre database. The symbols are on the palette; the ASCII spellings (select, project, join, minus ...) work as well.',
        { view: 'algebra', label: 'Write it in the algebra workbench', sel: { exercise: id } },
        { tip: 'The check evaluates your expression and a reference answer on a fresh copy of the Theatre data and on several altered copies of it, under set semantics; attribute names must match where the question names them.' },
      ],
      hints: x.hints,
      ref: ex.solution,
      wrongs: x.wrongs,
      check(app) {
        const W = K.UI && K.UI.AlgebraWorkbench;
        const answer = W ? W.answer(id) : null;
        if (!answer || !answer.trim()) return { ok: false, message: 'There is no expression for this exercise yet. Open the algebra workbench (the button above), write your expression, and check again.' };
        let r;
        try { r = X.checkAlgebra(ex, answer, source(app)); } catch (e) { return { ok: false, message: 'The check could not run: ' + e.message }; }
        const fb = r.feedback.slice();
        const message = r.ok ? (fb.shift() || '').replace(/^Correct:\s*/, '').replace(/^./, (c) => c.toUpperCase()) : fb.shift();
        return { ok: r.ok, message, details: fb };
      },
    });
  });
})(typeof window !== 'undefined' ? window : globalThis);
