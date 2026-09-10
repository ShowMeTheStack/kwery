// Exercises with checkers. Design-theory kinds (closure, keys, cover, normalForm, bcnf, 3nf, lossless,
// preservation) come from K.Normal; this file adds relational algebra exercises over the Theatre schema.
// An algebra answer is checked by evaluating it next to a reference solution on the visible database and on
// randomized variants of it (rows dropped, values reshuffled within their columns), so any correct expression
// is accepted and a wrong one is usually caught with a concrete counterexample.
(function (root) {
  'use strict';
  const K = root.K;
  const A = K.Algebra;

  function rng(seed) {
    let a = (seed >>> 0) || 1;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const pick = (r, a) => a[Math.floor(r() * a.length)];
  const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';

  // ---- algebra templates over the Theatre schema ---------------------------------------------------------------
  // each: { id, title, params(r, data) -> params, prompt(p), solution(p), hint }
  const TEMPLATES = [
    { id: 'genre-titles', title: 'Selection and projection', topic: 'σ π',
      params: (r, d) => ({ genre: pick(r, d.genres) }),
      prompt: (p) => 'Find the titles of all productions of the ' + p.genre + ' genre.',
      solution: (p) => 'π[title](σ[genre = ' + q(p.genre) + '](production))',
      hint: 'Select the productions of the genre, then project their titles.' },
    { id: 'fee-above', title: 'Selection on a number', topic: 'σ π',
      params: (r, d) => ({ x: pick(r, d.fees) }),
      prompt: (p) => 'Find the person ID and company ID of each artist whose fee is greater than ' + p.x + '.',
      solution: (p) => 'π[person_id, company_id](σ[fee > ' + p.x + '](artist))',
      hint: 'σ with fee > …, then π[person_id, company_id].' },
    { id: 'stage-kind', title: 'Conjunctive selection', topic: 'σ π',
      params: (r, d) => ({ kind: pick(r, d.kinds), x: pick(r, d.seats) }),
      prompt: (p) => 'Find the venue code and stage number of the ' + p.kind + ' stages with at least ' + p.x + ' seats.',
      solution: (p) => 'π[venue_code, stage_no](σ[kind = ' + q(p.kind) + ' ∧ seats >= ' + p.x + '](stage))',
      hint: 'Both conditions go into one selection, joined by ∧.' },
    { id: 'played-at', title: 'Join', topic: '⋈',
      params: (r, d) => ({ v: pick(r, d.venues) }),
      prompt: (p) => 'Find the titles of the productions performed at the venue ' + p.v + '.',
      solution: (p) => 'π[title](production ⋈ σ[venue_code = ' + q(p.v) + '](performance))',
      hint: 'production and performance share the attribute prod_id.' },
    { id: 'both-venues', title: 'Intersection', topic: '∩',
      params: (r, d) => { const a = pick(r, d.venues); let b = pick(r, d.venues); if (b === a) b = d.venues[(d.venues.indexOf(a) + 1) % d.venues.length]; return { v1: a, v2: b }; },
      prompt: (p) => 'Find the IDs of the productions performed both at ' + p.v1 + ' and at ' + p.v2 + '.',
      solution: (p) => 'π[prod_id](σ[venue_code = ' + q(p.v1) + '](performance)) ∩ π[prod_id](σ[venue_code = ' + q(p.v2) + '](performance))',
      hint: 'Project prod_id for each venue before intersecting.' },
    { id: 'either-venue', title: 'Union', topic: '∪',
      params: (r, d) => { const a = pick(r, d.venues); let b = pick(r, d.venues); if (b === a) b = d.venues[(d.venues.indexOf(a) + 1) % d.venues.length]; return { v1: a, v2: b }; },
      prompt: (p) => 'Find the IDs of the productions performed at ' + p.v1 + ', at ' + p.v2 + ', or at both.',
      solution: (p) => 'π[prod_id](σ[venue_code = ' + q(p.v1) + '](performance)) ∪ π[prod_id](σ[venue_code = ' + q(p.v2) + '](performance))',
      hint: 'A union of two projections.' },
    { id: 'venue-not-venue', title: 'Difference', topic: '−',
      params: (r, d) => { const a = pick(r, d.venues); let b = pick(r, d.venues); if (b === a) b = d.venues[(d.venues.indexOf(a) + 1) % d.venues.length]; return { v1: a, v2: b }; },
      prompt: (p) => 'Find the IDs of the productions performed at ' + p.v1 + ' but never at ' + p.v2 + '.',
      solution: (p) => 'π[prod_id](σ[venue_code = ' + q(p.v1) + '](performance)) − π[prod_id](σ[venue_code = ' + q(p.v2) + '](performance))',
      hint: 'Set difference of two projections on prod_id.' },
    { id: 'never-performed', title: 'Difference or antijoin', topic: '− ▷',
      params: () => ({}),
      prompt: () => 'Find the ID and title of each production that has never been performed.',
      solution: () => 'π[prod_id, title](production) − π[prod_id, title](production ⋈ performance)',
      hint: 'Every production minus those that appear in performance; an antijoin ▷ says the same.' },
    { id: 'patrons-in-city', title: 'Joins with a projection to avoid a trap', topic: '⋈ π',
      params: (r, d) => ({ city: pick(r, d.venueCities) }),
      prompt: (p) => 'Find the names of the patrons who booked a performance at a venue in ' + p.city + ' (wherever the patron lives).',
      solution: (p) => 'π[name](patron ⋈ π[patron_id](π[patron_id, perf_id](booking) ⋈ π[perf_id](performance ⋈ π[venue_code](σ[city = ' + q(p.city) + '](venue)))))',
      hint: 'patron and venue both have city: a natural join of them all would also require the patron to live there.' },
    { id: 'max-seats', title: 'The largest value without aggregation', topic: 'ρ × −',
      params: () => ({}),
      prompt: () => 'Find the largest number of seats of any stage without using aggregate functions.',
      solution: () => 'π[seats](stage) − π[i.seats](σ[i.seats < j.seats](ρ[i](stage) × ρ[j](stage)))',
      hint: 'A number is the largest when no other is greater: compare stage with a renamed copy of itself.' },
    { id: 'count-per-company', title: 'Aggregation', topic: 'γ',
      params: () => ({}),
      prompt: () => 'For each company that has staged productions, find the number of its productions; name the attributes company_id and n.',
      solution: () => 'company_id γ count(prod_id) → n (production)',
      hint: 'G γ count(A) → n (E).' },
    { id: 'avg-runtime-above', title: 'Aggregation then selection', topic: 'γ σ',
      params: (r, d) => ({ x: pick(r, d.runtimes) }),
      prompt: (p) => 'Find the genres whose average running time is greater than ' + p.x + ' minutes; give genre and the average as avg_runtime.',
      solution: (p) => 'σ[avg_runtime > ' + p.x + '](genre γ avg(runtime_min) → avg_runtime (production))',
      hint: 'Compute the averages with γ, then select.' },
    { id: 'cast-in-all', title: 'Division', topic: '÷',
      params: (r, d) => ({ c: pick(r, d.smallCompanies) }),
      prompt: (p) => 'Find the IDs of the artists who are cast in every production of the company ' + p.c + '.',
      solution: (p) => 'π[person_id, prod_id](casting) ÷ π[prod_id](σ[company_id = ' + q(p.c) + '](production))',
      hint: 'Divide the (artist, production) pairs by the set of the company\'s productions.' },
    { id: 'mentor-names', title: 'Renaming for a three-way join', topic: 'ρ ⋈θ',
      params: () => ({}),
      prompt: () => 'List the family names of every mentor and mentee pair, as mentor_name and mentee_name.',
      solution: () => 'π[m.family_name → mentor_name, e.family_name → mentee_name](ρ[m](person) ⋈[m.person_id = r.mentor_id] ρ[r](mentor) ⋈[r.mentee_id = e.person_id] ρ[e](person))',
      hint: 'Both people come from person: rename two copies so the conditions can tell them apart.' },
    { id: 'no-artists', title: 'Difference on keys', topic: '−',
      params: () => ({}),
      prompt: () => 'Find the IDs of the companies that have no artists.',
      solution: () => 'π[company_id](company) − π[company_id](artist)',
      hint: 'artist lists the company of each artist (or null for a freelancer).' },
    { id: 'cast-list', title: 'Left outer join', topic: '⟕',
      params: (r, d) => ({ c: pick(r, d.artistCompanies) }),
      prompt: (p) => 'For each artist of the company ' + p.c + ', list the person ID together with the prod_id of every production the artist is cast in; keep artists cast in nothing (with a null prod_id).',
      solution: (p) => 'π[person_id, prod_id](σ[company_id = ' + q(p.c) + '](artist) ⟕ casting)',
      hint: 'An outer join keeps the artists without a match.' },
  ];

  /** the values the templates draw their parameters from */
  function theatreData(get) {
    const col = (rel, c) => { const r = get(rel); if (!r) throw K.err('42P01', 'the exercises need the Theatre relation ' + rel); const i = r.attrs.indexOf(c); return r.rows.map((x) => x[i]); };
    const uniq = (a) => [...new Set(a.filter((x) => x !== null))].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    const num = (a) => uniq(a.map(Number)).sort((x, y) => x - y);
    const quant = (a, ps) => uniq(ps.map((p) => a[Math.floor(p * (a.length - 1))]));
    const prodCompany = col('production', 'company_id');
    const counts = new Map();
    for (const c of prodCompany) if (c !== null) counts.set(c, (counts.get(c) || 0) + 1);
    const small = [...counts].filter(([, n]) => n <= 3).map(([c]) => c).sort();
    return {
      genres: uniq(col('production', 'genre')), kinds: uniq(col('stage', 'kind')), venues: uniq(col('performance', 'venue_code')),
      venueCities: uniq(col('venue', 'city')), artistCompanies: uniq(col('artist', 'company_id')),
      fees: quant(num(col('artist', 'fee')), [0.3, 0.5, 0.7, 0.85]).map((x) => Math.round(x / 50) * 50),
      seats: quant(num(col('stage', 'seats')), [0, 0.25, 0.5]).map((x) => Math.floor(x / 10) * 10),
      runtimes: quant(num(col('production', 'runtime_min')), [0.3, 0.5, 0.7]).map((x) => Math.round(x / 5) * 5),
      smallCompanies: small.length ? small : uniq(prodCompany),
    };
  }

  /** an algebra exercise: { kind: 'algebra', template, seed, title, prompt, params, solution, hint } (plain JSON) */
  function algebraExercise(seed, src, opts) {
    opts = opts || {};
    const get = A.source(src);
    const r = rng((seed === undefined ? 1 : seed) * 104729 + 17);
    const t = opts.template ? TEMPLATES.find((x) => x.id === opts.template) : TEMPLATES[Math.floor(r() * TEMPLATES.length)];
    if (!t) throw K.err('22023', 'unknown algebra exercise template ' + opts.template);
    const data = theatreData(get);
    // parameters whose answer is empty make a poor exercise: try a few
    let params = t.params(r, data);
    for (let i = 0; i < 12; i++) {
      let n = 1;
      try { n = A.evaluate(t.solution(params), get, { steps: false }).rows.length; } catch (e) { n = 1; }
      if (n > 0) break;
      params = t.params(r, data);
    }
    return { kind: 'algebra', template: t.id, seed, title: t.title, topic: t.topic, prompt: t.prompt(params), params, solution: t.solution(params), hint: t.hint };
  }

  /** a variant of the relations: some tuples dropped, some values replaced by others of the same column */
  function variant(rels, seed) {
    const r = rng(seed * 7 + 3);
    const out = {};
    for (const [name, rel] of Object.entries(rels)) {
      const domains = rel.attrs.map((_, i) => rel.rows.map((x) => x[i]));
      // columns whose values are all different stay as they are (they are keys, and answers may rely on that);
      // NULLs only go where the database already has some
      const keyLike = domains.map((d) => new Set(d.map((v) => A.keyOf(v))).size === d.length);
      const nullable = domains.map((d) => d.some((v) => v === null));
      let rows = rel.rows.filter(() => r() < 0.7);
      if (!rows.length && rel.rows.length) rows = [rel.rows[0]];
      rows = rows.map((x) => x.map((v, i) => (!keyLike[i] && r() < 0.12 ? domains[i][Math.floor(r() * domains[i].length)] : v)));
      if (seed % 3 === 2) rows = rows.map((x) => x.map((v, i) => (nullable[i] && r() < 0.05 ? null : v)));
      out[name] = { cols: rel.attrs, rows };
    }
    return out;
  }
  const relNames = (prog) => {
    const out = new Set(), vars = new Set(prog.stmts.map((s) => s.name));
    const add = (e) => A.walk(e, (n) => { if (n.op === 'rel' && !vars.has(n.name)) out.add(n.name); });
    prog.stmts.forEach((s) => add(s.expr));
    if (prog.result) add(prog.result);
    return out;
  };
  const plural = (n) => n + (n === 1 ? ' tuple' : ' tuples');
  const showRow = (r) => '(' + r.map((v) => A.litText(v)).join(', ') + ')';

  /**
   * Check an algebra answer (text). opts: { variants: 6, bag: false }. src: the visible database (session or map).
   * Returns { ok, feedback: [lines], details: { visible: { expected, got, missing, extra }, variants: [...] } }.
   */
  function checkAlgebra(ex, answer, src, opts) {
    opts = opts || {};
    const get = A.source(src);
    const feedback = [];
    let prog;
    try { prog = typeof answer === 'string' ? A.parse(answer) : answer; } catch (e) {
      return { ok: false, feedback: ['Syntax error at position ' + e.pos + ': ' + e.message + (e.hint ? ' (' + e.hint + ')' : '')], error: { message: e.message, pos: e.pos } };
    }
    const ref = A.parse(ex.solution);
    const names = new Set([...relNames(prog), ...relNames(ref)]);
    const base = {};
    for (const n of names) { const r = get(n); if (r) base[n] = { attrs: r.attrs, rows: r.rows }; }
    const run = (p, s) => A.evaluate(p, s, { steps: false, bag: !!opts.bag, maxRows: 5e5 });
    let mine, want;
    try { mine = run(prog, get); } catch (e) { return { ok: false, feedback: ['Your expression fails: ' + e.message + (e.pos !== undefined ? ' (at position ' + e.pos + ')' : '') + (e.hint ? '. ' + e.hint : '')], error: { message: e.message, pos: e.pos } }; }
    want = run(ref, get);
    const compare = (a, b) => {
      const byName = A.sameResult(a, b, { bag: !!opts.bag });
      return byName.byName ? byName : Object.assign(byName, { positional: true });
    };
    const strip = (c) => String(c).split('.').pop();
    const vis = compare(mine, want);
    const details = { visible: { expected: want.rows.length, got: mine.rows.length, missing: vis.missing.slice(0, 5), extra: vis.extra.slice(0, 5) }, variants: [] };
    if (mine.cols.length !== want.cols.length) {
      feedback.push('Your result has ' + mine.cols.length + ' attribute' + (mine.cols.length === 1 ? '' : 's') + ' (' + mine.cols.join(', ') + '); the answer has ' + want.cols.length + ' (' + want.cols.join(', ') + ').');
      return { ok: false, feedback, details };
    }
    if (vis.positional && mine.cols.map(strip).join() !== want.cols.map(strip).join()) feedback.push('Your attributes are named ' + mine.cols.join(', ') + ' but the question asks for ' + want.cols.join(', ') + '; they are compared by position.');
    if (!vis.equal) {
      feedback.push('On the database shown, your result has ' + plural(mine.rows.length) + ' and the answer ' + want.rows.length + '.');
      if (vis.missing.length) feedback.push('Missing, for example: ' + vis.missing.slice(0, 3).map(showRow).join(', '));
      if (vis.extra.length) feedback.push('Not in the answer, for example: ' + vis.extra.slice(0, 3).map(showRow).join(', '));
      return { ok: false, feedback, details };
    }
    // the same on randomized variants: an expression that only happens to match this instance is caught here
    const n = opts.variants === undefined ? 6 : opts.variants;
    for (let i = 1; i <= n; i++) {
      const rels = variant(base, (ex.seed || 0) * 31 + i);
      const s = A.source(rels);
      let a, b;
      try { b = run(ref, s); } catch (e) { continue; }
      try { a = run(prog, s); } catch (e) { feedback.push('On a modified database your expression fails: ' + e.message); details.variants.push({ i, error: e.message }); return { ok: false, feedback, details }; }
      const c = compare(a, b);
      details.variants.push({ i, equal: c.equal, expected: b.rows.length, got: a.rows.length });
      if (!c.equal) {
        feedback.push('Your expression matches on the database shown but not on a modified one (some tuples removed or changed): ' + (a.rows.length === b.rows.length ? 'there it gives different tuples.' : 'there it gives ' + plural(a.rows.length) + ' instead of ' + b.rows.length + '.'));
        if (c.missing.length) feedback.push('Missing there: ' + c.missing.slice(0, 3).map(showRow).join(', '));
        if (c.extra.length) feedback.push('Wrongly there: ' + c.extra.slice(0, 3).map(showRow).join(', '));
        details.counterexample = rels;
        return { ok: false, feedback, details };
      }
    }
    feedback.unshift('Correct: your expression gives the right result on the database shown and on ' + n + ' modified versions of it.');
    return { ok: true, feedback, details };
  }

  const KINDS = ['algebra'].concat(K.Normal ? K.Normal.KINDS : []);
  /** generate(kind, seed, opts): opts.source (session or relations) is needed for 'algebra' */
  function generate(kind, seed, opts) {
    opts = opts || {};
    if (kind === 'algebra') return algebraExercise(seed, opts.source, opts);
    if (!K.Normal) throw K.err('22023', 'design theory exercises need theory/normal.js');
    return K.Normal.exercise(kind, seed, opts);
  }
  /** check(ex, answer, opts): opts.source for algebra exercises */
  function check(ex, answer, opts) {
    opts = opts || {};
    if (ex.kind === 'algebra') return checkAlgebra(ex, answer, opts.source, opts);
    return K.Normal.check(ex, answer);
  }

  K.Exercises = { KINDS, TEMPLATES, generate, check, algebraExercise, checkAlgebra, variant, theatreData };
})(typeof window !== 'undefined' ? window : globalThis);
