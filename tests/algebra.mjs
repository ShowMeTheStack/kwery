// Relational algebra and calculus (K.Algebra): the parser in both notations, small examples with known answers,
// NULL and bag semantics, the Theatre database against SQL on Kwery, translations both ways checked by running
// them, equivalence rules checked by evaluating before and after, TRC and DRC, and the algebra exercises.
// A sample of the translations is also run on PostgreSQL 17 through its Unix socket when the server is up
// (pass --no-pg to skip it).
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { load } from './load.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const K = load();
const A = K.Algebra, C = A.Calculus, E = K.Exercises;
let pass = 0, fail = 0;
const T0 = Date.now();
const lap = (what) => { if (process.env.TIMING) console.log('  [' + what + '] ' + (Date.now() - T0) + ' ms'); };
const eq = (a, b, what) => { if (JSON.stringify(a) === JSON.stringify(b)) pass++; else { fail++; console.log('FAIL ' + what + '\n  expected ' + JSON.stringify(b) + '\n  got      ' + JSON.stringify(a)); } };
const ok = (c, what, extra) => { if (c) pass++; else { fail++; console.log('FAIL ' + what + (extra ? '\n  ' + extra : '')); } };
const throws = (f, re, what, pos) => {
  try { f(); fail++; console.log('FAIL ' + what + ': no error'); } catch (e) {
    if (re.test(e.message) && (pos === undefined || e.pos === pos)) pass++;
    else { fail++; console.log('FAIL ' + what + ': ' + e.message + ' (pos ' + e.pos + ')'); }
  }
};
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const sortRows = (rows) => rows.map((r) => JSON.stringify(r)).sort();
const ev = (x, src, o) => A.evaluate(x, src, o);
const rowsOf = (x, src, o) => sortRows(ev(x, src, o).rows);

// a small database with NULLs, for exact answers
const small = {
  r: { cols: ['a', 'b'], rows: [[1, 'x'], [2, 'y'], [3, null], [null, 'z']] },
  s: { cols: ['b', 'c'], rows: [['x', 10], ['y', 20], [null, 30], ['w', 40]] },
  t: { cols: ['n'], rows: [[1], [1], [2]] },
  u: { cols: ['n'], rows: [[1], [3]] },
  // a division with a known answer: r ÷ s
  rd: { cols: ['a', 'b'], rows: [['a1', 'b1'], ['a1', 'b2'], ['a2', 'b1'], ['a3', 'b2'], ['a3', 'b1'], ['a4', 'b3']] },
  sd: { cols: ['b'], rows: [['b1'], ['b2']] },
  empty: { cols: ['b'], rows: [] },
};

// ---- the parser: both notations give the same tree ------------------------------------------------------------------
{
  const same = [
    ['σ[a > 1](r)', 'select[a > 1](r)', 'σ_{a > 1}(r)', 'σ a > 1 (r)', 'sigma[a>1](r)', '\\sigma_{a > 1}(r)', 'select_{a > 1}(r)', 'σ_[a > 1](r)', 'σ{a > 1}(r)'],
    ['π[a](r)', 'project[a](r)', 'π a (r)', 'pi_{a}(r)', 'Π[a](r)'],
    ['r ⋈ s', 'r njoin s', 'r join s', 'r \\bowtie s', 'r ⨝ s', 'r natjoin s'],
    ['r ⋈[r.b = s.b] s', 'r join[r.b = s.b] s', 'r ⋈_{r.b = s.b} s', 'r ⋈ r.b = s.b s', 'r \\bowtie_{r.b = s.b} s'],
    ['r ⟕ s', 'r ljoin s', 'r leftjoin s'], ['r ⟖ s', 'r rjoin s'], ['r ⟗ s', 'r fjoin s', 'r fulljoin s'],
    ['r ⋉ s', 'r semijoin s', 's ⋊ r'], ['r ▷ s', 'r antijoin s', 'r |> s'], ['rd ÷ sd', 'rd divide sd', 'rd / sd'],
    ['π[b](r) ∪ π[b](s)', 'project[b](r) union project[b](s)'], ['π[b](r) − π[b](s)', 'π[b](r) - π[b](s)', 'project[b](r) minus project[b](s)', 'π[b](r) except π[b](s)', 'π[b](r) \\setminus π[b](s)'],
    ['π[b](r) ∩ π[b](s)', 'project[b](r) intersect project[b](s)', 'π[b](r) \\cap π[b](s)'], ['r × s', 'r cross s', 'r times s', 'r \\times s'],
    ['ρ[x(c, d)](r)', 'rename[x(c, d)](r)', 'rho_{x(c, d)}(r)', 'ρ x(c, d) (r)'],
    ['ρ[a → z](r)', 'rename[a -> z](r)', 'ρ[z ← a](r)', 'rename[z <- a](r)'],
    ['γ[b, count(*) → n](r)', 'b γ count(*) → n (r)', 'γ[b; count(*) as n](r)', 'group[b, count(*) -> n](r)', 'gamma_{b; count(*) as n}(r)'],
    ['γ[count(distinct a) → k](r)', 'γ[count-distinct(a) → k](r)', 'γ[count_distinct(a) as k](r)'],
    ['τ[a desc, b](r)', 'sort[a desc, b asc](r)', 'tau_{a desc, b}(r)'], ['δ(r)', 'distinct(r)', 'delta(r)'],
    ['σ[a ≥ 1 ∧ b ≠ "x" ∨ ¬(a ≤ 2)](r)', 'select[a >= 1 and b <> \'x\' or not (a <= 2)](r)', 'σ[a >= 1 && b != "x" or !(a <= 2)](r)'],
    ['t1 ← σ[a > 1](r)\nπ[b](t1)', 't1 <- select[a > 1](r); project[b](t1)', 't1 := σ[a > 1](r); π[b](t1)'],
  ];
  for (const group of same) {
    const want = A.programText(A.parse(group[0]));
    for (const g of group.slice(1)) eq(A.programText(A.parse(g)), want, 'same tree: ' + g);
  }
  // printing in either style parses back to the same text
  const exprs = ['π[billed_as, fee * 1.1 → raise](σ[company_id = "C01" ∧ fee > 2000](artist))', 'company_id γ avg(fee) → a, count(*) → n (artist ⋈ company)',
    'ρ[a](artist) ⋈[a.person_id = c.person_id] ρ[c](casting)', 'π[patron_id](patron) − π[patron_id](booking) ∪ π[person_id](artist) ∩ π[person_id](casting)', '(r ⋈ s) ⟕ s', 'r × (s × r)', 'π[prod_id, based_on](production) ÷ π[based_on](σ[based_on = "PR101"](production))',
    'σ[name like "Z%" ∧ city is not null](patron)', 'σ[upper(name) = "ILYA FERREIRA" ∨ length(name) < 4](patron)', '{(1, "a"), (2, null)} ∪ π[a, b](r)', 'r1 ← r\nr2(x, y) ← s\nr1 ▷[r1.a = r2.y] r2'];
  for (const x of exprs) {
    const u = A.programText(A.parse(x)), a = A.programText(A.parse(x), 'ascii');
    eq(A.programText(A.parse(u)), u, 'unicode round trip: ' + x);
    eq(A.programText(A.parse(a)), u, 'ascii round trip: ' + x);
    ok(/^[\x20-\x7e\n]*$/.test(a), 'ascii text is ASCII: ' + a);
  }
  // precedence: × and ⋈ before ∩ before ∪ and −, all left-associative
  eq(A.toText(A.parseExpr('a ∪ b ∩ c')), 'a ∪ b ∩ c', 'precedence print');
  eq(A.parseExpr('a ∪ b ∩ c').op, 'union', '∩ binds tighter than ∪');
  eq(A.parseExpr('a − b − c').left.op, 'minus', '− is left-associative');
  eq(A.parseExpr('a ∪ b × c').right.op, 'product', '× binds tighter than ∪');
  eq(A.toText(A.parseExpr('a − (b − c)')), 'a − (b − c)', 'parentheses kept where needed');
  eq(A.toTree(A.parseExpr('π[a](σ[a > 1](r) ⋈ s)')).children[0].children.map((c) => c.symbol), ['σ', 's'], 'tree');
  eq(A.parseExpr('σ[a > 1](r)').cond.k, 'cmp', 'condition tree');
}
lap('precise errors');
// ---- precise errors with positions --------------------------------------------------------------------------------------
{
  throws(() => A.parse('σ[a > ](r)'), /expected a value or an attribute but found "\]"/, 'missing operand', 6);
  throws(() => A.parse('π[a](r'), /expected "\)" to close the operand of π but found the end of the input/, 'unclosed operand', 6);
  throws(() => A.parse('σ[a = "x](r)'), /unterminated string literal/, 'unterminated string', 6);
  throws(() => A.parse('r ∪'), /the expression ends where a relation is expected/, 'dangling ∪', 3);
  throws(() => A.parse('σ[sum(a) > 1](r)'), /aggregate sum\(\) is only allowed in γ/, 'aggregate in σ', 2);
  throws(() => A.parse('r s'), /two expressions without an assignment/, 'two expressions', 2);
  throws(() => A.parse('r )'), /unexpected "\)" after the end of an expression/, 'stray parenthesis', 2);
  throws(() => A.parse('σ[a > 1](r) # s'), /unexpected character "#"/, 'bad character', 12);
  throws(() => A.parse('π[a ← b](r)'), /write the new name after the expression/, 'wrong arrow in π', 4);
  throws(() => A.parse('γ[b → x](r)'), /only aggregates can be named in γ/, 'renaming a group attribute in γ');
  throws(() => A.parse('γ[sum(*) → x](r)'), /only count\(\*\) counts rows/, 'sum(*)');
  throws(() => A.parse('σ[a > 1 (r)'), /expected "\]" to close the subscript opened at 1/, 'unclosed subscript', 8);
  throws(() => A.parse('σ[a > 1]'), /needs an operand/, 'no operand', 8);
  throws(() => A.parse('{(1, 2), (3)}'), /same number of values/, 'ragged constant relation');
  throws(() => A.parse(''), /empty/, 'empty input');
  throws(() => ev('σ[x > 1](r)', small), /attribute "x" does not exist/, 'unknown attribute', 2);
  throws(() => ev('q', small), /relation "q" does not exist/, 'unknown relation', 0);
  throws(() => ev('π[a](r × r)', small), /attribute reference "a" is ambiguous/, 'ambiguous after ×', 2);
  try { ev('π[a](r × r)', small); } catch (e) { ok(/rename one of them/.test(e.hint), 'hint: rename for a self-product'); }
  try { ev('π[b](r × s)', small); } catch (e) { eq(e.hint, 'Qualify it: r.b or s.b', 'hint: qualify'); }
  throws(() => ev('π[q.a](r)', small), /no relation named "q" provides "a"/, 'wrong qualifier', 2);
  throws(() => ev('r ∪ t', small), /not union-compatible: the left has 2 attributes \(a, b\), the right 1 \(n\)/, 'union compatibility', 2);
  throws(() => ev('r ÷ s', small), /every attribute of s must be an attribute of r; "c" is not/, 'division schema', 2);
  throws(() => ev('r ÷ r', small), /proper subset/, 'division by itself');
  throws(() => ev('ρ[x(c)](r)', small), /names 1 attributes but its operand has 2/, 'rename arity');
  throws(() => ev('(r × r) ⋈ s', small), /natural join is ambiguous: attribute "b" occurs 2 times in the left operand/, 'natural join ambiguity');
  throws(() => ev('σ[b > 1](r)', small), /cannot compare string "x" with number 1/, 'type mismatch');
  throws(() => ev('π[a / 0 → z](r)', small), /division by zero/, 'division by zero');
  throws(() => ev('patron × booking × booking', K.Algebra.source({ patron: { cols: ['x'], rows: K.range(300).map((i) => [i]) }, booking: { cols: ['y'], rows: K.range(300).map((i) => [i]) } }), { maxRows: 1e5 }), /would have 27000000 tuples/, 'product size guard');
}
lap('semantics');
// ---- semantics on the small database -------------------------------------------------------------------------------
{
  const S = (x) => rowsOf(x, small);
  eq(S('r ⋈ s'), sortRows([['x', 1, 10], ['y', 2, 20]]), 'natural join: NULL matches nothing');
  eq(ev('r ⋈ s', small).cols, ['b', 'a', 'c'], 'natural join schema: common attributes first');
  eq(S('r ⟕ s'), sortRows([['x', 1, 10], ['y', 2, 20], [null, 3, null], ['z', null, null]]), 'left outer join');
  eq(S('r ⟖ s'), sortRows([['x', 1, 10], ['y', 2, 20], [null, null, 30], ['w', null, 40]]), 'right outer join');
  eq(S('r ⟗ s').length, 6, 'full outer join');
  eq(S('r ⟕[r.a * 10 = s.c] s'), sortRows([[1, 'x', 'x', 10], [2, 'y', 'y', 20], [3, null, null, 30], [null, 'z', null, null]]), 'theta outer join');
  eq(S('π[b](r) ∪ π[b](s)'), sortRows([['x'], ['y'], [null], ['z'], ['w']]), 'union: NULLs are duplicates of each other');
  eq(S('π[b](r) − π[b](s)'), sortRows([['z']]), 'difference treats NULL as a value');
  eq(S('π[b](r) ∩ π[b](s)'), sortRows([['x'], ['y'], [null]]), 'intersection treats NULL as a value');
  eq(S('σ[a > 1](r)'), sortRows([[2, 'y'], [3, null]]), 'σ: unknown is false');
  eq(S('σ[¬(a > 1)](r)'), sortRows([[1, 'x']]), 'σ: ¬unknown is unknown');
  eq(S('σ[a > 1 ∨ b = "z"](r)'), sortRows([[2, 'y'], [3, null], [null, 'z']]), 'σ: true ∨ unknown');
  eq(S('σ[b is null](r)'), sortRows([[3, null]]), 'is null');
  eq(S('σ[b is not null ∧ b like "_"](r)').length, 3, 'like');
  eq(S('γ[count(a) → n, count(*) → m, sum(a) → s, avg(a) → v, min(b) → lo, max(b) → hi](r)'), sortRows([[3, 4, 6, 2, 'x', 'z']]), 'aggregates skip NULLs');
  eq(S('γ[count(*) → n, sum(a) → s](σ[a > 100](r))'), sortRows([[0, null]]), 'aggregates of an empty relation');
  eq(S('b γ count(*) → n (σ[a > 100](r))'), [], 'grouping an empty relation');
  eq(S('b γ count(a) → n (r)'), sortRows([['x', 1], ['y', 1], [null, 1], ['z', 0]]), 'a NULL group');
  eq(S('γ[count(distinct n) → k, sum(distinct n) → s](t)'), sortRows([[2, 3]]), 'distinct aggregates');
  eq(S('γ[count(*) → k](t)'), sortRows([[2]]), 'set semantics: t has 2 tuples');
  eq(rowsOf('γ[count(*) → k](t)', small, { bag: true }), sortRows([[3]]), 'bag semantics: t has 3 tuples');
  eq(rowsOf('t ∩ u', small, { bag: true }), sortRows([[1]]), 'bag intersection: the smaller multiplicity');
  eq(rowsOf('t − u', small, { bag: true }), sortRows([[1], [2]]), 'bag difference: multiplicities subtract');
  eq(rowsOf('t ∪ u', small, { bag: true }).length, 5, 'bag union adds multiplicities');
  eq(rowsOf('δ(t ∪ u)', small, { bag: true }), sortRows([[1], [2], [3]]), 'δ removes duplicates in a bag');
  eq(S('t − u'), sortRows([[2]]), 'set difference');
  eq(rowsOf('π[b](r ∪ r)', small, { bag: true }).length, 8, 'bag projection keeps duplicates');
  eq(S('r ⋉ s'), sortRows([[1, 'x'], [2, 'y']]), 'semijoin');
  eq(S('r ▷ s'), sortRows([[3, null], [null, 'z']]), 'antijoin');
  eq(S('r ⋉[r.a * 10 = s.c] s'), sortRows([[1, 'x'], [2, 'y'], [3, null]]), 'theta semijoin');
  eq(S('ρ[r1](r) ⋈[r1.a < r2.a] ρ[r2](r)').length, 3, 'self join with renames');
  eq(S('rd ÷ sd'), sortRows([['a1'], ['a3']]), 'division');
  eq(S('rd ÷ empty'), sortRows([['a1'], ['a2'], ['a3'], ['a4']]), 'division by an empty relation');
  // division by its definition: r ÷ s = π(R−S)(r) − π(R−S)((π(R−S)(r) × s) − r)
  eq(S('π[a](rd) − π[a]((π[a](rd) × sd) − rd)'), S('rd ÷ sd'), 'division equals its definition');
  eq(S('{(1, "x"), (5, "q")} − r'), sortRows([[5, 'q']]), 'constant relation');
  eq(ev('{(1, "x")} ∪ r', small).cols, ['column1', 'column2'], 'constant relation names');
  eq(ev('τ[a desc](r)', small).rows.map((x) => x[0]), [null, 3, 2, 1], 'τ: NULLs first when descending');
  eq(ev('τ[a](r)', small).rows.map((x) => x[0]), [1, 2, 3, null], 'τ: NULLs last when ascending');
  eq(S('π[a + 1 → a1, b || "!" → e](σ[a = 1](r))'), sortRows([[2, 'x!']]), 'generalized projection');
  eq(ev('ρ[x(p, q)](r)', small).cols, ['p', 'q'], 'rename attributes');
  eq(S('π[x.p](ρ[x(p, q)](r))').length, 4, 'qualified by the new name');
  eq(S('t1 ← σ[a > 1](r)\nt2 ← t1 ⋈ s\nπ[c](t2)'), sortRows([[20]]), 'assignments');
  eq(S('res(k, v) ← r\nσ[k = 1](res)'), sortRows([[1, 'x']]), 'assignment with attribute names');
  eq(S('t1 ← r; t1 ← σ[a = 1](t1); t1'), sortRows([[1, 'x']]), 'reassignment');
  // steps: one per operator node, children before parents, each with its rows
  const res = ev('π[a](σ[a > 1](r) ⋈ s)', small);
  eq(res.steps.map((st) => st.symbol), ['r', 'σ', 's', '⋈', 'π'], 'steps in evaluation order');
  eq(res.steps.map((st) => st.count), [4, 2, 4, 1, 1], 'step sizes');
  eq(res.steps[3].children, [res.steps[1].id, res.steps[2].id], 'step children');
  eq(res.steps[1].text, 'σ[a > 1](r)', 'step text');
  const prog = ev('t1 ← σ[a > 1](r); π[b](t1)', small);
  ok(prog.steps.some((st) => st.op === 'assign' && st.assign === 't1' && st.count === 2), 'assignment step');
  // schemas
  eq(A.schemaOf(A.parseExpr('r × s'), small).map(A.qualName), ['r.a', 'r.b', 's.b', 's.c'], 'schema of ×');
  eq(A.displayNames(A.schemaOf(A.parseExpr('r × s'), small)), ['a', 'r.b', 's.b', 'c'], 'display names after ×');
  eq(A.schemaOf(A.parseExpr('r ⋈ s'), small)[0].quals, ['r', 's'], 'a common attribute is reachable as r.b and s.b');
  eq(rowsOf('π[s.b](r ⋈ s)', small), rowsOf('π[r.b](r ⋈ s)', small), 'r.b and s.b name the same attribute after ⋈');
}

lap('the Theatre database');
// ---- the Theatre database: algebra against SQL on Kwery ---------------------------------------------------------------
const db = new K.Database();
const s = db.session();
const theatreSql = fs.readFileSync(path.join(root, 'src/data/theatre.sql'), 'utf8');
s.exec(theatreSql);
const sqlRes = (sql) => { const r = s.query(sql); return { cols: r.cols.map((c) => c.name), rows: r.rows.map((row) => row.map((v, i) => A.plain(v, r.cols[i].type))) }; };
const same = (a, b, opts) => A.sameResult(a, b, opts).equal;
// the two seasons of performances
const S1 = 'perf_date < "2025-07-01"', S2 = 'perf_date ≥ "2025-07-01"';
{
  const cases = [
    ['π[title](σ[genre = "opera"](production))', 'select distinct title from production where genre = \'opera\''],
    ['π[person_id, fee](σ[fee > 3000](artist))', 'select distinct person_id, fee from artist where fee > 3000'],
    ['π[person_id, title](casting ⋈ production)', 'select distinct person_id, title from casting natural join production'],
    ['π[prod_id](σ[' + S1 + ' ∧ venue_code = "RIV"](performance)) ∪ π[prod_id](σ[' + S2 + ' ∧ venue_code = "FER"](performance))', 'select prod_id from performance where perf_date < \'2025-07-01\' and venue_code = \'RIV\' union select prod_id from performance where perf_date >= \'2025-07-01\' and venue_code = \'FER\''],
    ['π[prod_id](σ[perf_date < "2025-01-01"](performance)) ∩ π[prod_id](σ[perf_date ≥ "2025-01-01"](performance))', 'select prod_id from performance where perf_date < \'2025-01-01\' intersect select prod_id from performance where perf_date >= \'2025-01-01\''],
    ['π[prod_id](production) − π[prod_id](performance)', 'select prod_id from production except select prod_id from performance'],
    ['π[fee](artist) − π[a.fee](σ[a.fee < b.fee](ρ[a](artist) × ρ[b](artist)))', 'select max(fee) from artist'],
    ['company_id γ avg(fee) → avg_fee (artist)', 'select company_id, avg(fee) from artist group by company_id'],
    ['γ[count(distinct patron_id) → n](σ[seats > 4](booking))', 'select count(distinct patron_id) from booking where seats > 4'],
    ['π[venue_code](venue) ∩ (π[venue_code, genre](performance ⋈ production) ÷ π[genre](σ[genre = "opera" ∨ genre = "dance"](production)))', 'select v.venue_code from venue v where not exists (select genre from production where genre in (\'opera\', \'dance\') except select p.genre from performance f join production p on p.prod_id = f.prod_id where f.venue_code = v.venue_code)'],
    ['artist ▷ casting', 'select * from artist a where not exists (select 1 from casting c where c.person_id = a.person_id)'],
    ['π[person_id, billed_as](artist ⋉ casting)', 'select person_id, billed_as from artist where person_id in (select person_id from casting)'],
    ['π[person_id, prod_id](artist ⟕ casting)', 'select distinct a.person_id, prod_id from artist a left join casting c on a.person_id = c.person_id'],
    ['π[p.prod_id, b.title → source](ρ[p](production) ⟕[p.based_on = b.prod_id] ρ[b](production))', 'select distinct p.prod_id, b.title from production p left join production b on p.based_on = b.prod_id'],
    ['π[e.family_name → mentee, m.family_name → mentor](ρ[e](person) ⋈[e.person_id = t.mentee_id] ρ[t](mentor) ⋈[t.mentor_id = m.person_id] ρ[m](person))', 'select e.family_name, m.family_name from person e join mentor t on e.person_id = t.mentee_id join person m on t.mentor_id = m.person_id'],
    ['π[city](venue) ∪ π[city](company)', 'select city from venue union select city from company'],
    ['σ[n > 4](company_id γ count(*) → n (artist))', 'select company_id, count(*) from artist group by company_id having count(*) > 4'],
    ['π[patron_id](σ[points < 100](patron)) − π[patron_id](booking)', 'select patron_id from patron where points < 100 except select patron_id from booking'],
    ['π[title](production ⋈ π[prod_id](σ[venue_code = "LAN"](performance)))', 'select distinct title from production where prod_id in (select prod_id from performance where venue_code = \'LAN\')'],
    ['π[p.title, b.title → source](ρ[p](production) ⋈[p.based_on = b.prod_id] ρ[b](production))', 'select p.title, b.title from production p join production b on p.based_on = b.prod_id'],
  ];
  for (const [alg, sql] of cases) {
    let a;
    try { a = ev(alg, s); } catch (e) { fail++; console.log('FAIL evaluating ' + alg + ': ' + e.message); continue; }
    ok(same(a, sqlRes(sql), { positional: true }), 'Theatre: ' + alg, JSON.stringify(A.sameResult(a, sqlRes(sql), { positional: true })).slice(0, 300));
  }
  // the source can also be a plain map of relations
  const art = sqlRes('select * from artist');
  eq(rowsOf('σ[fee > 3000](artist)', { artist: art }), rowsOf('σ[fee > 3000](artist)', s), 'map source equals session source');
  eq(rowsOf('σ[fee > 3000](artist)', { artist: { cols: art.cols, rows: art.rows.map((r) => Object.fromEntries(art.cols.map((c, i) => [c, r[i]]))) } }), rowsOf('σ[fee > 3000](artist)', s), 'rows as objects');
}

lap('algebra -> SQL');
// ---- algebra -> SQL, run on Kwery ------------------------------------------------------------------------------------
const pgSample = [];
const toSqlCheck = (alg, what, bag) => {
  let a, t, r;
  try { a = ev(alg, s, { bag }); } catch (e) { return null; }
  const t1 = Date.now();
  try { t = A.toSQL(alg, s, { bag }); r = sqlRes(t.sql); if (process.env.TIMING && Date.now() - t1 > 300) console.log('  slow SQL ' + (Date.now() - t1) + ' ms: ' + alg); } catch (e) { fail++; console.log('FAIL ' + what + ' (SQL fails: ' + e.message + ')\n  ' + alg + '\n' + (t ? t.sql : '')); return false; }
  const c = A.sameResult(a, r, { positional: true, bag });
  if (c.equal) pass++; else { fail++; console.log('FAIL ' + what + '\n  ' + alg + '\n' + t.sql + '\n  ' + JSON.stringify(c).slice(0, 300)); }
  if (!bag && pgSample.length < 60) pgSample.push({ alg, sql: t.sql, a });
  return c.equal;
};
{
  const list = ['σ[fee > 2000](artist)', 'π[billed_as, fee * 1.1 → raise](artist)', 'artist ⋈ casting', 'π[billed_as, prod_id](artist ⋈[artist.person_id = casting.person_id] casting)',
    'company_id γ count(*) → n, avg(fee) → a, min(billed_as) → lo (artist)', 'π[venue_code, genre](performance ⋈ production) ÷ π[genre](σ[genre = "opera" ∨ genre = "dance"](production))', 'artist ▷ casting', 'artist ⋉ casting',
    'π[a.fee](σ[a.fee < b.fee](ρ[a](artist) × ρ[b](artist)))', 't ← σ[company_id = "C01"](artist); result ← π[billed_as](t)', 'ρ[x(a, b, c, d)](artist)', 'π[company_id](artist) − π[company_id](company)',
    'γ[count(*) → n](π[company_id](artist))', 'π[prod_id](production) ⟗ π[prod_id, venue_code](performance)', 'π[patron_id](patron) ⟕ ρ[patron_id → patron_id](π[patron_id, perf_id](booking))', 'π[prod_id](production) ⟖ casting',
    'π[prod_id](σ[' + S1 + '](performance)) ∪ π[prod_id](σ[' + S2 + '](performance))', 'π[prod_id](σ[' + S1 + '](performance)) ∩ π[prod_id](σ[' + S2 + '](performance))',
    'τ[fee desc](π[billed_as, fee](artist))', 'σ[n > 4](company_id γ count(*) → n (artist))', 'π[company_id](σ[n > 4](company_id γ count(*) → n (artist)))', '{(1, "x"), (2, "y")}', 'π[column1](σ[column1 > 1]({(1, "x"), (2, "y")}))',
    'patron ⋉[patron.patron_id = booking.patron_id ∧ rating = 5] booking', 'π[family_name](person ▷[person.person_id = mentor.mentee_id] mentor)', 'π[upper(name) → u, length(name) → l](σ[name like "A%"](patron))', 'σ[company_id is null](artist)',
    'π[a.billed_as, b.billed_as](σ[a.company_id = b.company_id ∧ a.person_id < b.person_id](ρ[a](artist) × ρ[b](artist)))', 'π[person_id, prod_id](casting) ÷ π[prod_id](σ[prod_id = "PR101"](production))', 'q(x) ← π[company_id](company)\nq ⋈ ρ[q2(x)](π[company_id](artist))',
    'π[title](production ⋈ (π[prod_id](performance) − π[prod_id](casting)))', 'γ[sum(runtime_min) → r, count(distinct company_id) → d](production)',
    'γ[count(*) → n](π[company_id](artist) ⟕ company)', 'γ[count(*) → n](π[company_id](artist) × π[city](company))', 'city γ count(*) → n (π[person_id, city](artist ⋈ company))',
    'γ[count(*) → n](π[company_id](artist) ⋉ company)', 'γ[count(*) → n](σ[company_id > "C05"](π[company_id](artist)))', 'π[company_id, city](company) ⋈ π[company_id, person_id](σ[fee > 4000](artist))'];
  for (const x of list) toSqlCheck(x, 'toSQL: ' + x);
  // bag semantics
  for (const x of ['π[company_id](artist)', 'π[city](patron) ∪ π[city](company)', 'π[city](patron) − π[city](venue)', 'π[city](patron) ∩ π[city](company)', 'δ(π[company_id](artist))', 'γ[count(city) → n](π[city](patron))'])
    toSqlCheck(x, 'toSQL bag: ' + x, true);
  const t = A.toSQL('σ[fee > 2000](artist)', s);
  eq(t.sql, 'SELECT DISTINCT artist.person_id, artist.company_id, artist.billed_as, artist.fee\nFROM artist\nWHERE artist.fee > 2000', 'readable SQL for σ');
  ok(/^WITH t\(person_id, company_id, billed_as, fee\) AS/.test(A.toSQL('t ← σ[company_id = "C01"](artist); π[billed_as](t)', s).sql), 'assignments become WITH');
}
lap('random expressions');
// random expressions over the Theatre schema: evaluated directly and through the SQL translation
const RELS = ['venue', 'stage', 'company', 'person', 'artist', 'production', 'performance', 'casting', 'patron', 'booking', 'mentor'];
const ATTRS = (() => {
  const vals = new Map();
  for (const rel of RELS) {
    const r = A.source(s)(rel);
    r.attrs.forEach((a, i) => { if (!vals.has(a)) vals.set(a, new Set()); for (const row of r.rows) if (row[i] !== null) vals.get(a).add(row[i]); });
  }
  return new Map([...vals].map(([k, v]) => [k, [...v]]));
})();
function randomExpr(r, depth) {
  const pick = (a) => a[Math.floor(r() * a.length)];
  const rels = RELS;
  const schema = (e) => A.displayNames(A.schemaOf(A.parseExpr(e), s));
  const uniqueNames = (e) => { const a = A.schemaOf(A.parseExpr(e), s); return a.filter((x) => a.filter((y) => y.name === x.name).length === 1).map((x) => x.name); };
  const cond = (e) => {
    const names = uniqueNames(e).filter((n) => ATTRS.has(n));
    if (!names.length) return null;
    const a = pick(names), v = pick(ATTRS.get(a));
    const op = typeof v === 'number' ? pick(['>', '<', '=', '>=', '<>']) : pick(['=', '<>', '>']);
    const c = a + ' ' + op + ' ' + A.litText(v);
    return r() < 0.2 ? c + ' ∨ ' + a + ' is null' : r() < 0.2 ? '¬(' + c + ')' : c;
  };
  const gen = (d) => {
    if (d <= 0 || r() < 0.25) return pick(rels);
    const k = r();
    const sub = gen(d - 1);
    if (k < 0.2) { const c = cond(sub); return c ? 'σ[' + c + '](' + sub + ')' : sub; }
    if (k < 0.35) { const ns = uniqueNames(sub); if (!ns.length) return sub; const take = ns.filter(() => r() < 0.5); return 'π[' + (take.length ? take : [ns[0]]).join(', ') + '](' + sub + ')'; }
    if (k < 0.5) { const other = pick(rels); const shared = uniqueNames(sub).filter((n) => uniqueNames(other).includes(n)); if (!shared.length) return sub; return '(' + sub + ') ' + pick(['⋈', '⋈', '⟕', '⟖', '⟗', '⋉', '▷']) + ' ' + other; }
    if (k < 0.65) {
      const ns = uniqueNames(sub);
      const shared = ns.filter((n) => ['company_id', 'person_id', 'prod_id', 'venue_code', 'patron_id', 'city', 'genre'].includes(n));
      if (!shared.length) return sub;
      const a = pick(shared);
      const others = rels.filter((x) => uniqueNames(x).includes(a));
      return 'π[' + a + '](' + sub + ') ' + pick(['∪', '−', '∩']) + ' π[' + a + '](' + pick(others) + ')';
    }
    if (k < 0.8) {
      const ns = uniqueNames(sub);
      const nums = ns.filter((n) => ATTRS.has(n) && typeof ATTRS.get(n)[0] === 'number');
      const g = ns.filter((n) => !nums.includes(n));
      const agg = nums.length && r() < 0.8 ? pick(['sum', 'avg', 'min', 'max', 'count']) + '(' + pick(nums) + ') → v' : 'count(*) → v';
      return (g.length && r() < 0.7 ? pick(g) + ' ' : '') + 'γ ' + agg + ' (' + sub + ')';
    }
    if (k < 0.9) { const ns = uniqueNames(sub); if (!ns.includes('person_id')) return sub; return 'π[x.person_id](σ[x.person_id = y.person_id](ρ[x](' + sub + ') × ρ[y](π[person_id](' + pick(['casting', 'artist', 'person']) + '))))'; }
    void schema;
    return 'π[person_id, prod_id](' + sub + ' ⋈ casting) ÷ π[prod_id](σ[' + 'company_id = ' + A.litText(pick(ATTRS.get('company_id'))) + '](production))';
  };
  return gen(depth);
}
const randomExprs = [];
{
  const r = rng(20251017);
  let tried = 0;
  while (randomExprs.length < 100 && tried < 2000) {
    tried++;
    let x;
    try { x = randomExpr(r, 3); } catch (e) { continue; }
    // keep the intermediate results small, so that the SQL runs quickly too
    try { const res = ev(x, s, { maxRows: 2e5 }); if (res.steps.some((st) => st.count > 15000)) continue; } catch (e) { continue; }
    randomExprs.push(x);
  }
  ok(randomExprs.length >= 80, 'enough random expressions (' + randomExprs.length + ')');
  for (const x of randomExprs) toSqlCheck(x, 'toSQL random');
  for (const x of randomExprs.slice(0, 30)) if (!/÷|γ/.test(x)) toSqlCheck(x, 'toSQL random bag', true);
}

lap('SQL -> algebra');
// ---- SQL -> algebra -------------------------------------------------------------------------------------------------------------------
{
  const cases = [
    ['select billed_as from artist where fee > 3000', 'π[billed_as](σ[fee > 3000](artist))'],
    ['select distinct company_id from artist', 'π[company_id](artist)'],
    ['select billed_as, prod_id from artist natural join casting', 'π[billed_as, prod_id](artist ⋈ casting)'],
    ['select a.billed_as from artist a, casting c where a.person_id = c.person_id and c.role_name = \'Ensemble\'', 'π[billed_as](σ[a.person_id = c.person_id ∧ role_name = "Ensemble"](ρ[a](artist) × ρ[c](casting)))'],
    ['select company_id, avg(fee) as avg_fee from artist group by company_id having avg(fee) > 2000', 'σ[avg_fee > 2000](γ[company_id, avg(fee) → avg_fee](artist))'],
    ['select billed_as from artist where person_id in (select person_id from casting)', 'π[billed_as](artist ⋉[artist.person_id = casting.person_id] casting)'],
    ['select billed_as from artist a where not exists (select * from casting c where c.person_id = a.person_id)', 'π[billed_as](ρ[a](artist) ▷[c.person_id = a.person_id] ρ[c](casting))'],
    ['select billed_as from artist where fee > (select avg(fee) from artist)', null],
    ['select prod_id from performance where venue_code = \'RIV\' union select prod_id from performance where venue_code = \'FER\'', 'π[prod_id](σ[venue_code = "RIV"](performance)) ∪ π[prod_id](σ[venue_code = "FER"](performance))'],
    ['select * from person left join mentor on person.person_id = mentor.mentee_id', 'person ⟕[person_id = mentee_id] mentor'],
    ['with t as (select company_id, count(*) as n from artist group by company_id) select * from t where n > 2', 't ← γ[company_id, count(*) → n](artist)\nσ[n > 2](t)'],
    ['select billed_as from artist where fee > all (select fee from artist where company_id = \'C07\')', null],
    ['select p.name from patron p where p.patron_id not in (select patron_id from booking)', null],
    ['select count(*) from artist', 'γ[count(*) → count](artist)'],
    ['select billed_as from (select * from artist where company_id = \'C01\') as p', 'π[billed_as](ρ[p](σ[company_id = "C01"](artist)))'],
    ['select * from booking natural full join patron', 'booking ⟗ patron'],
    ['select prod_id from production except select prod_id from performance', 'π[prod_id](production) − π[prod_id](performance)'],
    ['select company_id from company intersect select company_id from artist', 'π[company_id](company) ∩ π[company_id](artist)'],
    ['select * from artist cross join company', 'artist × company'],
    ['select name from patron where city in (\'Vantmoor\', \'Marrowgate\')', 'π[name](σ[city = "Vantmoor" ∨ city = "Marrowgate"](patron))'],
    ['select billed_as from artist where fee between 2000 and 3000', 'π[billed_as](σ[fee ≥ 2000 ∧ fee ≤ 3000](artist))'],
    ['select b.booking_id from booking b where exists (select 1 from performance f where f.perf_id = b.perf_id and f.venue_code = \'RIV\')', null],
    ['select company_id, count(distinct prod_id) from casting natural join artist group by company_id', null],
    ['select upper(name) as n from patron where points > 2000', 'π[upper(name) → n](σ[points > 2000](patron))'],
    ['select a.billed_as, c.city from artist a join company c using (company_id)', null],
    ['select a.billed_as, b.billed_as from artist a, artist b where a.fee > b.fee and b.person_id = \'P1004\'', null],
    ['select x.person_id from (select person_id from casting union select mentor_id from mentor) x', null],
    ['select company_id, sum(budget) from company group by company_id order by 2 desc', null],
    ['select prod_id, title from production where prod_id not in (select prod_id from performance)', null],
  ];
  for (const [sql, want] of cases) {
    const t = A.fromSQL(sql, s);
    if (t.error) { fail++; console.log('FAIL fromSQL ' + sql + ': ' + t.error); continue; }
    if (want) eq(t.text, want, 'fromSQL text: ' + sql);
    const a = ev(t.program, s);
    const c = A.sameResult(a, sqlRes(sql), {});
    ok(c.equal, 'fromSQL result: ' + sql, t.text + '\n  ' + JSON.stringify(c).slice(0, 300));
    // and back: the algebra's own SQL gives the same set
    const back = A.toSQL(t.program, s);
    ok(A.sameResult(sqlRes(back.sql), a, { positional: true }).equal, 'fromSQL then toSQL: ' + sql);
  }
  const n1 = A.fromSQL('select p.name from patron p where p.patron_id not in (select patron_id from booking)', s);
  ok(n1.notes.some((x) => /NOT IN/.test(x)), 'NOT IN is explained');
  const n2 = A.fromSQL('select company_id from artist', s);
  ok(n2.notes.some((x) => /duplicate/.test(x)), 'duplicates are explained');
  ok(!A.fromSQL('select distinct company_id from artist', s).notes.length, 'no note for DISTINCT');
  const n3 = A.fromSQL('select billed_as from artist order by fee limit 2', s);
  eq(n3.exact, false, 'LIMIT is not exact');
  ok(n3.notes.some((x) => /LIMIT/.test(x)), 'LIMIT is explained');
  const u1 = A.fromSQL('select billed_as, (select count(*) from casting c where c.person_id = a.person_id) from artist a', s);
  ok(u1.error && /subquery in the select list/.test(u1.error), 'scalar subquery in the select list is explained');
  const u2 = A.fromSQL('select billed_as from artist a where fee > (select avg(fee) from artist b where b.company_id = a.company_id)', s);
  ok(u2.error && /correlated scalar subquery/.test(u2.error), 'correlated scalar subquery is explained');
  const u3 = A.fromSQL('select billed_as, rank() over (order by fee) from artist', s);
  ok(u3.error && /window/.test(u3.error), 'window functions are explained');
  const u4 = A.fromSQL('with recursive r(n) as (select 1 union select n + 1 from r where n < 3) select * from r', s);
  ok(u4.error && /recursive/.test(u4.error), 'recursion is explained');
  const u5 = A.fromSQL('select billed_as from artist where fee > 5000 or person_id in (select person_id from casting)', s);
  ok(u5.error && /OR/.test(u5.error), 'a subquery under OR is explained');
  eq(A.fromSQL('select billed_as from artist where fee > 1', s, { bag: true }).text, 'π[billed_as](σ[fee > 1](artist))', 'bag translation');
  eq(A.fromSQL('select distinct billed_as from artist', s, { bag: true }).text, 'δ(π[billed_as](artist))', 'bag translation keeps δ');
  // a tree for the view
  eq(A.fromSQL('select billed_as from artist where fee > 3000', s).tree.symbol, 'π', 'fromSQL tree');
}

lap('equivalence rules');
// ---- equivalence rules ----------------------------------------------------------------------------------------------------------------
{
  const rules = [
    // σ pushed through the join to the relation that has its attributes
    ['π[billed_as, title](σ[company_id = "C07" ∧ role_name = "Ensemble"](artist ⋈ (casting ⋈ π[prod_id, title](production))))', 'select-push', 'π[billed_as, title](σ[role_name = "Ensemble"](σ[company_id = "C07"](artist) ⋈ (casting ⋈ π[prod_id, title](production))))'],
    ['σ[fee > 2000](σ[company_id = "C01"](artist))', 'select-merge', 'σ[fee > 2000 ∧ company_id = "C01"](artist)'],
    ['σ[fee > 2000 ∧ company_id = "C01"](artist)', 'select-split', 'σ[fee > 2000](σ[company_id = "C01"](artist))'],
    ['σ[fee > 2000](σ[company_id = "C01"](artist))', 'select-commute', 'σ[company_id = "C01"](σ[fee > 2000](artist))'],
    ['π[billed_as](π[billed_as, fee](artist))', 'project-cascade', 'π[billed_as](artist)'],
    ['σ[artist.person_id = casting.person_id](artist × casting)', 'select-product', 'artist ⋈[artist.person_id = casting.person_id] casting'],
    ['artist ⋈[artist.person_id = casting.person_id] casting', 'join-to-select', 'σ[artist.person_id = casting.person_id](artist × casting)'],
    ['σ[fee > 1](artist ⋈[artist.person_id = casting.person_id] casting)', 'select-join', 'artist ⋈[fee > 1 ∧ artist.person_id = casting.person_id] casting'],
    ['(artist ⋈ casting) ⋈ performance', 'join-assoc', 'artist ⋈ (casting ⋈ performance)'],
    ['artist ⋈ (casting ⋈ performance)', 'join-assoc-rev', 'artist ⋈ casting ⋈ performance'],
    ['σ[city = "Quillmere" ∧ fee > 2000](artist ⋈ company)', 'select-push-both', 'σ[fee > 2000](artist) ⋈ σ[city = "Quillmere"](company)'],
    ['π[billed_as, city](artist ⋈ company)', 'project-push', 'π[billed_as, city](π[company_id, billed_as](artist) ⋈ π[company_id, city](company))'],
    ['σ[company_id = "C03"](π[company_id](artist) ∪ π[company_id](company))', 'select-setop', 'σ[company_id = "C03"](π[company_id](artist)) ∪ σ[company_id = "C03"](π[company_id](company))'],
    ['σ[company_id = "C03"](π[company_id](artist) − π[company_id](production))', 'select-setop-left', 'σ[company_id = "C03"](π[company_id](artist)) − π[company_id](production)'],
    ['π[company_id](π[company_id, city](company) ∪ π[company_id, city](company))', 'project-union', 'π[company_id](π[company_id, city](company)) ∪ π[company_id](π[company_id, city](company))'],
    ['σ[company_id = "C01"](company_id γ count(*) → n (artist))', 'select-group', 'γ[company_id, count(*) → n](σ[company_id = "C01"](artist))'],
    ['artist ⟕ casting', 'outer-commute', 'casting ⟖ artist'],
    ['σ[fee > 3000](artist ⟕ casting)', 'select-outer', 'σ[fee > 3000](artist) ⟕ casting'],
    ['σ[role_name = "Ensemble"](artist ⟕ casting)', 'outer-to-inner', 'σ[role_name = "Ensemble"](artist ⋈ casting)'],
    ['(π[person_id](artist) ∪ π[person_id](person)) ∪ π[person_id](casting)', 'setop-assoc', 'π[person_id](artist) ∪ (π[person_id](person) ∪ π[person_id](casting))'],
    ['(artist ⋈[artist.person_id = casting.person_id] casting) ⋈[casting.prod_id = production.prod_id ∧ artist.company_id = production.company_id] production', 'theta-assoc', 'artist ⋈[artist.person_id = casting.person_id ∧ artist.company_id = production.company_id] (casting ⋈[casting.prod_id = production.prod_id] production)'],
  ];
  for (const [x, id, want] of rules) {
    const rs = A.applicable(x, s).flatMap((node) => node.rules).filter((r) => r.id === id);
    if (!rs.length) { fail++; console.log('FAIL rule ' + id + ' does not apply to ' + x + '; applies: ' + A.applicable(x, s).flatMap((node) => node.rules).map((r) => r.id).join(', ')); continue; }
    ok(rs.some((r) => r.exprText === want), 'rule ' + id + ': ' + x, rs.map((r) => r.exprText).join('\n  '));
    for (const r of rs) ok(same(ev(r.expr, s), ev(x, s)), 'rule ' + id + ' keeps the result: ' + r.exprText);
  }
  // rules are offered only where valid
  ok(!A.rulesAt('σ[fee > 1 ∨ city = "x"](artist ⋈ company)', [], s).some((r) => r.id === 'select-push'), 'a disjunction over both sides is not pushed');
  ok(!A.rulesAt('σ[prod_id is null](artist ⟕ casting)', [], s).some((r) => r.id === 'outer-to-inner'), 'IS NULL does not reject nulls');
  ok(!A.rulesAt('π[company_id](artist ∩ artist)', [], s).some((r) => r.id === 'project-union'), 'π does not distribute over ∩');
  ok(!A.rulesAt('σ[n > 2](company_id γ count(*) → n (artist))', [], s).some((r) => r.id === 'select-group'), 'σ on an aggregate stays above γ');
  // commuting under a union keeps the attribute order
  const u = A.rulesAt('π[person_id, billed_as](artist ⋈ casting) ∪ π[person_id, billed_as](artist)', ['left', 'child'], s).find((r) => r.id === 'join-commute');
  ok(u && same(ev(u.expr, s), ev('π[person_id, billed_as](artist ⋈ casting) ∪ π[person_id, billed_as](artist)', s)), 'commuting below π');
  const v = A.rulesAt('(artist ▷ casting) ∪ (artist ⋉ casting)', ['left'], s);
  void v;
  const wx = 'π[person_id, billed_as](artist) ⋈ π[person_id, home_city](person) ∪ π[person_id, given_name, home_city](person)';
  const w = A.rulesAt(wx, ['left'], s).find((r) => r.id === 'join-commute');
  ok(w && w.result.op === 'project' && same(ev(w.expr, s), ev(wx, s), { positional: true }), 'reordering below ∪ restores the attribute order', w && w.exprText);
  const w2 = A.rulesAt('π[billed_as](π[person_id, billed_as](artist) ⋈ π[person_id, home_city](person))', ['child'], s).find((r) => r.id === 'join-commute');
  ok(w2 && w2.result.op === 'join', 'no projection added where the order does not matter');
  const all = A.applicable('π[billed_as](σ[city = "Quillmere" ∧ fee > 1](artist ⋈ company))', s);
  ok(all.length >= 2 && all.some((x) => x.path.join('.') === 'child' && x.rules.some((r) => r.id === 'select-push')), 'applicable lists nodes with their rules');
  eq(A.toText(A.applyRule('σ[a > 1 ∧ b = "x"](r)', [], 'select-split', small)), 'σ[a > 1](σ[b = "x"](r))', 'applyRule');
  throws(() => A.applyRule('r', [], 'select-split', small), /does not apply/, 'applyRule where it does not apply');
  // every rule anywhere in random expressions keeps the result
  let checked = 0;
  for (const x of randomExprs.slice(0, 60)) {
    const base = ev(x, s, { steps: false });
    for (const node of A.applicable(x, s)) for (const r of node.rules) {
      let after;
      try { after = ev(r.expr, s, { steps: false, maxRows: 5e5 }); } catch (e) { if (/would have/.test(e.message)) continue; fail++; console.log('FAIL rule ' + r.id + ' breaks ' + x + ': ' + e.message); continue; }
      checked++;
      ok(same(after, base), 'rule ' + r.id + ' at ' + node.path.join('.') + ' keeps ' + x, r.exprText);
    }
  }
  ok(checked > 40, 'rules checked on random expressions (' + checked + ')');
  // simplify keeps results
  for (const x of randomExprs.slice(0, 40)) ok(same(ev(A.simplify(A.parseExpr(x), s), s), ev(x, s)), 'simplify keeps ' + x);
}

lap('tuple and domain');
// ---- tuple and domain relational calculus ---------------------------------------------------------------------------------------------
{
  const cases = [
    ['{ t | t ∈ artist ∧ t[fee] > 3000 }', 'σ[fee > 3000](artist)'],
    ['{ t | ∃ s ∈ artist (t[person_id] = s[person_id] ∧ s[fee] > 3000) }', 'π[person_id](σ[fee > 3000](artist))'],
    ['{ t | exists s in artist (t.billed_as = s.billed_as and exists u in company (u.company_id = s.company_id and u.city = \'Quillmere\')) }', 'π[billed_as](artist ⋈ σ[city = "Quillmere"](company))'],
    ['{ t | ∃ s ∈ performance (t[prod_id] = s[prod_id] ∧ s[venue_code] = "RIV" ∧ s[perf_date] < "2025-07-01") ∨ ∃ u ∈ performance (t[prod_id] = u[prod_id] ∧ u[venue_code] = "FER" ∧ u[perf_date] ≥ "2025-07-01") }', 'π[prod_id](σ[venue_code = "RIV" ∧ ' + S1 + '](performance)) ∪ π[prod_id](σ[venue_code = "FER" ∧ ' + S2 + '](performance))'],
    ['{ t | ∃ s ∈ performance (t[prod_id] = s[prod_id] ∧ s[perf_date] < "2025-07-01" ∧ ¬∃ u ∈ performance (t[prod_id] = u[prod_id] ∧ u[perf_date] ≥ "2025-07-01")) }', 'π[prod_id](σ[' + S1 + '](performance)) − π[prod_id](σ[' + S2 + '](performance))'],
    ['{ t | ∃ p ∈ production (t[prod_id] = p[prod_id]) ∧ (∀ f ∈ performance (f[prod_id] = t[prod_id] ⇒ f[price] > 30)) }', 'π[prod_id](production) − π[prod_id](σ[price ≤ 30](performance))'],
    ['{ t | ∃ s ∈ artist (t[billed_as] = s[billed_as] ∧ ¬∃ u ∈ casting (u[person_id] = s[person_id])) }', 'π[billed_as](artist ▷ casting)'],
    ['{ t | ∃ s ∈ artist (t[billed_as] = s[billed_as] ∧ t[raise] = s[fee] * 1.1 ∧ s[company_id] = "C07") }', 'π[billed_as, fee * 1.1 → raise](σ[company_id = "C07"](artist))'],
    ['{ <p, c, b, f> | <p, c, b, f> ∈ artist ∧ f > 3000 }', 'σ[fee > 3000](artist)'],
    ['{ <b> | ∃ p, c, f (<p, c, b, f> ∈ artist ∧ c = "C07") }', 'π[billed_as](σ[company_id = "C07"](artist))'],
    ['{ <b> | ∃ p, f (<p, "C07", b, f> ∈ artist) }', 'π[billed_as](σ[company_id = "C07"](artist))'],
    ['{ <v> | ∃ n, c, o (<v, n, c, o> ∈ venue) ∧ ∀ pi, ti, ci, g, d, r, bo (<pi, ti, ci, g, d, r, bo> ∈ production ∧ g = "revue" ⇒ ∃ f, sn, pd, st, pr (<f, pi, v, sn, pd, st, pr> ∈ performance)) }', 'π[venue_code](venue) ∩ (π[venue_code, prod_id](performance) ÷ π[prod_id](σ[genre = "revue"](production)))'],
    ['{ <b, r> | ∃ p, c, f (<p, c, b, f> ∈ artist ∧ ∃ pr, l (<p, pr, r, l> ∈ casting)) }', 'π[billed_as, role_name](artist ⋈ casting)'],
    ['{ <p> | ∃ i, v, sn, d, st, pr (<i, p, v, sn, d, st, pr> ∈ performance ∧ v = "RIV") ∧ ¬∃ c, t, g, d2, r, b (<b, t, c, g, d2, r, p> ∈ production) }', 'π[prod_id](σ[venue_code = "RIV"](performance)) − π[based_on](production)'],
    ['{ <a, b> | ∃ x, y (<a, x, y, b> ∈ artist) ∧ b > 5000 ∨ ∃ x, y, z (<a, x, y, z> ∈ artist ∧ b = z ∧ x = "C02") }', 'π[person_id, fee](σ[fee > 5000 ∨ company_id = "C02"](artist))'],
  ];
  for (const [q, alg] of cases) {
    let r;
    try { r = C.evaluate(q, s); } catch (e) { fail++; console.log('FAIL calculus ' + q + ': ' + e.message + ' at ' + e.pos); continue; }
    ok(same(r, ev(alg, s), { positional: true }), 'calculus: ' + q);
    const t = C.toAlgebra(q, s);
    ok(same(ev(t.program, s), r, { positional: true }), 'calculus to algebra: ' + q, t.text);
    ok(C.safety(q, s).safe, 'safe: ' + q);
  }
  eq(C.evaluate('{ t | t ∈ artist ∧ t[fee] > 3000 }', s).cols, ['person_id', 'company_id', 'billed_as', 'fee'], 'TRC schema from the membership');
  eq(C.evaluate('{ t | ∃ s ∈ artist (t[who] = s[billed_as]) }', s).cols, ['who'], 'TRC schema from the attributes named');
  eq(C.evaluate('{ <b> | ∃ p, c, f (<p, c, b, f> ∈ artist) }', s).cols, ['b'], 'DRC schema');
  ok(/for each tuple of artist/.test(C.evaluate('{ t | t ∈ artist }', s).text), 'evaluation plan text');
  const unsafeCases = [
    ['{ t | ¬ (t ∈ artist) }', /t\.person_id, t\.company_id, t\.billed_as, t\.fee are not limited/],
    ['{ t | ∃ s ∈ artist (t[fee] > s[fee]) }', /t\.fee is not limited to values of a relation where the comparison t\.fee > s\.fee needs it/],
    ['{ <a, b> | ∃ p, c, n (<p, c, n, a> ∈ artist) }', /the result variable b is not limited/],
    ['{ <x> | ∃ y (y > 3 ∧ <x> ∈ based_on_only) }', null],
    ['{ <x> | ∀ p, c, b, f (<p, c, b, f> ∈ artist ⇒ x > f) }', /x is not limited/],
    ['{ t | ∃ s (t[person_id] = s[person_id]) }', /t\.person_id is not limited/],
    ['{ <x> | ∃ y (∃ z (<x, y, z> ∈ mentor) ∨ y = 1) }', /x is not limited|y is not limited/],
  ];
  for (const [q, re] of unsafeCases) {
    let r;
    try { r = C.safety(q, s); } catch (e) { r = { error: e.message }; }
    if (re) ok(r.safe === false && re.test(r.reason), 'unsafe: ' + q, JSON.stringify(r));
    else ok(r.safe === false || r.error, 'rejected: ' + q, JSON.stringify(r));
  }
  throws(() => C.evaluate('{ t | ¬ (t ∈ artist) }', s), /unsafe/, 'evaluate refuses an unsafe query');
  throws(() => C.parse('{ t | t ∈ }'), /expected a relation name/, 'TRC syntax error', 10);
  throws(() => C.parse('{ <x | x > 1 }'), /expected ">" to close the result tuple|expected "," /, 'DRC syntax error');
  throws(() => C.evaluate('{ t | t ∈ artist ∧ t[fe] = 1 }', s), /the tuple variable t has no attribute "fe"/, 'unknown attribute', 19);
  throws(() => C.evaluate('{ <x> | <x> ∈ artist }', s), /artist has 4 attributes/, 'arity', 8);
  throws(() => C.evaluate('{ t | t ∈ artst }', s), /relation "artst" does not exist/, 'unknown relation', 10);
  // the small database: calculus against algebra with NULLs
  eq(sortRows(C.evaluate('{ t | t ∈ r ∧ ¬ (t[a] > 1) }', small).rows), sortRows([[1, 'x'], [null, 'z']]), 'calculus: a comparison with NULL is false, its negation true');
  eq(sortRows(C.evaluate('{ <a, c> | ∃ b (<a, b> ∈ r ∧ <b, c> ∈ s) }', small).rows), rowsOf('π[a, c](r ⋈ s)', small), 'DRC join');
  eq(sortRows(C.evaluate('{ <x> | ∃ y (<x, y> ∈ rd) ∧ ∀ z (<z> ∈ sd ⇒ <x, z> ∈ rd) }', small).rows), rowsOf('rd ÷ sd', small), 'DRC division');
}

lap('exercises');
// ---- exercises ----------------------------------------------------------------------------------------------------------------------------
{
  // every template: deterministic, and its own solution is accepted on the Theatre database (a template over
  // relations the database does not have is reported and skipped)
  const missing = new Set();
  for (const t of E.TEMPLATES) for (const seed of [1, 2, 3]) {
    let ex;
    try { ex = E.generate('algebra', seed, { source: s, template: t.id }); } catch (e) { if (/does not exist|need the/.test(e.message)) { missing.add(t.id); continue; } throw e; }
    try { ev(ex.solution, s); } catch (e) { if (/does not exist/.test(e.message)) { missing.add(t.id); continue; } }
    eq(E.generate('algebra', seed, { source: s, template: t.id }), ex, 'deterministic: ' + t.id + ' ' + seed);
    ok(JSON.parse(JSON.stringify(ex)).solution === ex.solution, 'plain JSON: ' + t.id);
    const r = E.check(ex, ex.solution, { source: s, variants: 3 });
    ok(r.ok, 'reference accepted: ' + t.id + ' ' + seed, r.feedback.join(' / '));
  }
  if (missing.size) console.log('NOTE: ' + missing.size + ' algebra exercise templates use relations the Theatre database does not have (' + [...missing].join(', ') + '); skipped');
  if (missing.size < E.TEMPLATES.length) {
    const exs = new Set(K.range(30).map((i) => { try { return E.generate('algebra', i, { source: s }).template; } catch (e) { return null; } }).filter(Boolean));
    ok(exs.size >= Math.min(10, E.TEMPLATES.length - missing.size), 'seeds pick different templates (' + exs.size + ')');
  }
  // the checker, on exercises written here
  const mk = (solution, seed) => ({ kind: 'algebra', template: 'test', seed: seed || 1, solution });
  const accept = (e, ans, what) => { const r = E.check(e, ans, { source: s }); ok(r.ok, 'accepts ' + what, r.feedback.join(' / ')); };
  const reject = (e, ans, what, re) => { const r = E.check(e, ans, { source: s }); ok(!r.ok && (!re || re.test(r.feedback.join(' '))), 'rejects ' + what, r.feedback.join(' / ')); };
  // artists never cast
  const nc = mk('π[person_id, billed_as](artist) − π[person_id, billed_as](artist ⋈ casting)');
  accept(nc, 'π[person_id, billed_as](artist ▷ casting)', 'an antijoin for a difference');
  accept(nc, 'π[person_id, billed_as](artist) − π[artist.person_id, billed_as](artist ⋈[artist.person_id = casting.person_id] casting)', 'a theta join');
  accept(nc, 'select[true](project[person_id, billed_as](artist antijoin casting))', 'ASCII notation');
  reject(nc, 'π[person_id, billed_as](artist ⋉ casting)', 'the complement', /tuples/);
  reject(nc, 'π[person_id](artist ▷ casting)', 'a missing attribute', /attribute/);
  // the largest fee without aggregation
  const mf = mk('π[fee](artist) − π[a.fee](σ[a.fee < b.fee](ρ[a](artist) × ρ[b](artist)))');
  accept(mf, 'γ[max(fee) → fee](artist)', 'aggregation for the maximum');
  accept(mf, 'π[fee](artist) − π[a.fee](ρ[a](artist) ⋈[a.fee < b.fee] ρ[b](artist))', 'a theta join for the maximum');
  const v = ev(mf.solution, s).rows[0][0];
  reject(mf, '{(' + v + ')}', 'a constant that only fits the shown data', /modified/);
  reject(mf, 'π[fee](σ[fee = ' + v + '](artist))', 'a hard-coded value', /modified/);
  // patrons who booked a performance at a venue in one city: patron and venue both have city
  const pv = mk('π[name](patron ⋈ π[patron_id](π[patron_id, perf_id](booking) ⋈ π[perf_id](performance ⋈ π[venue_code](σ[city = "Quillmere"](venue)))))');
  reject(pv, 'π[name](patron ⋈ booking ⋈ performance ⋈ σ[city = "Quillmere"](venue))', 'the natural join trap');
  accept(pv, 'π[name](patron ⋈ π[patron_id](booking ⋈ π[perf_id](σ[city = "Quillmere"](venue) ⋈ performance)))', 'a different correct order');
  const cp = mk('company_id γ count(person_id) → n (artist)');
  accept(cp, 'company_id γ count(*) → n (artist)', 'count(*) for count(person_id)');
  const r1 = E.check(cp, 'company_id γ count(*) → k (artist)', { source: s });
  ok(r1.ok && r1.feedback.some((x) => /named/.test(x)), 'other attribute names are compared by position, with a remark', r1.feedback.join(' / '));
  const dv = mk('π[venue_code, genre](performance ⋈ production) ÷ π[genre](σ[genre = "opera" ∨ genre = "dance"](production))');
  accept(dv, 'π[venue_code](performance) − π[venue_code]((π[venue_code](performance) × π[genre](σ[genre = "opera" ∨ genre = "dance"](production))) − π[venue_code, genre](performance ⋈ production))', 'division by its definition');
  const syn = E.check(nc, 'π[person_id, billed_as](artist ▷ casting', { source: s });
  ok(!syn.ok && /Syntax error at position/.test(syn.feedback[0]) && syn.error.pos !== undefined, 'syntax errors are reported with the position');
  const bad = E.check(nc, 'π[person_id, bild_as](artist)', { source: s });
  ok(!bad.ok && /bild_as/.test(bad.feedback[0]), 'evaluation errors are reported');
  // the design-theory kinds go through K.Normal
  const fx = E.generate('keys', 5);
  ok(fx.kind === 'keys' && E.check(fx, fx.answer.keys).ok, 'design theory exercises through K.Exercises');
  ok(E.KINDS.includes('algebra') && E.KINDS.includes('bcnf'), 'all kinds listed');
}

lap('PostgreSQL');
// ---- PostgreSQL: a sample of the generated SQL, against the algebra's own result ------------------------------------------------
const PSQL = '/opt/homebrew/opt/postgresql@17/bin/psql';
const SOCK = path.join(process.env.HOME || '', '.kwery-pg/sock');
const pg = (args, input) => execFileSync(PSQL, ['-h', SOCK, '-p', '5544', '-X', '-q', '-v', 'ON_ERROR_STOP=1'].concat(args), { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 26 });
let pgRan = 0;
if (!process.argv.includes('--no-pg') && fs.existsSync(PSQL) && fs.existsSync(SOCK)) {
  let up = true;
  try { pg(['-d', 'postgres', '-c', 'select 1']); } catch (e) { up = false; console.log('PostgreSQL is not reachable; skipping the PostgreSQL checks'); }
  if (up) {
    // the database is loaded again when the sample's SQL has changed (its hash is kept as the database's comment)
    const hash = createHash('sha1').update(theatreSql).digest('hex').slice(0, 16);
    const have = pg(['-d', 'postgres', '-At', '-c', 'select shobj_description(oid, \'pg_database\') from pg_database where datname = \'kwery_theory_theatre\'']).trim();
    if (have !== hash) {
      if (have || pg(['-d', 'postgres', '-At', '-c', 'select 1 from pg_database where datname = \'kwery_theory_theatre\'']).trim()) pg(['-d', 'postgres', '-c', 'drop database kwery_theory_theatre']);
      pg(['-d', 'postgres', '-c', 'create database kwery_theory_theatre']); pg(['-d', 'kwery_theory_theatre'], theatreSql); pg(['-d', 'postgres', '-c', 'comment on database kwery_theory_theatre is \'' + hash + '\'']);
    }
    const SEP = '\u001f';
    const run = (sql) => pg(['-d', 'kwery_theory_theatre', '-A', '-t', '-F', SEP, '-P', 'null=\u0001NULL'], sql + ';\n').split('\n').filter((l) => l.length).map((l) => l.split(SEP).map((v) => (v === '\u0001NULL' ? null : v)));
    for (const { alg, sql, a } of pgSample) {
      let rows;
      try { rows = run(sql); } catch (e) { fail++; console.log('FAIL PostgreSQL rejects the SQL of ' + alg + ': ' + String(e.stderr).split('\n')[0] + '\n' + sql); continue; }
      const plainA = { cols: a.cols, rows: a.rows.map((r) => r.map((v) => (typeof v === 'boolean' ? (v ? 't' : 'f') : v))) };
      const c = A.sameResult({ cols: a.cols, rows }, plainA, { positional: true });
      if (c.equal) { pass++; pgRan++; } else { fail++; console.log('FAIL PostgreSQL result of ' + alg + '\n' + sql + '\n  ' + JSON.stringify(c).slice(0, 300)); }
    }
    // a few SQL queries on PostgreSQL against the algebra Kwery derives from them
    for (const sql of ['select billed_as from artist where person_id in (select person_id from casting)', 'select company_id, avg(fee) from artist group by company_id having avg(fee) > 2000', 'select * from booking natural full join patron', 'select a.billed_as from artist a where not exists (select * from casting c where c.person_id = a.person_id)']) {
      const t = A.fromSQL(sql, s);
      const a = ev(t.program, s);
      const c = A.sameResult({ cols: a.cols, rows: run(sql) }, a, { positional: true });
      if (c.equal) { pass++; pgRan++; } else { fail++; console.log('FAIL PostgreSQL vs fromSQL: ' + sql + '\n  ' + JSON.stringify(c).slice(0, 300)); }
    }
  }
}
console.log(pass + ' passed, ' + fail + ' failed' + (pgRan ? ' (' + pgRan + ' on PostgreSQL)' : ''));
process.exit(fail ? 1 : 0);
