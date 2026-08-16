// Design theory (K.Normal): worked examples with known answers, randomized cross-checks against brute force,
// exercises and their checker, FD discovery on the Theatre database, and anomaly scripts run on Kwery.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { load } from './load.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inManifest = JSON.parse(fs.readFileSync(path.join(root, 'src/manifest.json'), 'utf8')).engine.includes('theory/normal.js');
const K = inManifest ? load() : load(['theory/normal.js']);
const N = K.Normal;
let pass = 0, fail = 0;
const eq = (a, b, what) => { if (JSON.stringify(a) === JSON.stringify(b)) pass++; else { fail++; console.log('FAIL ' + what + '\n  expected ' + JSON.stringify(b) + '\n  got      ' + JSON.stringify(a)); } };
const ok = (c, what) => eq(!!c, true, what);
const sortSets = (ss) => ss.map((s) => s.slice().sort().join(',')).sort();
const throws = (f, re, what) => { try { f(); fail++; console.log('FAIL ' + what + ': no error'); } catch (e) { if (re.test(e.message)) pass++; else { fail++; console.log('FAIL ' + what + ': ' + e.message); } } };

// ---- brute force over plain sets ----------------------------------------------------------------------------------
const S = (x) => new Set(x);
const subset = (a, b) => [...a].every((x) => b.has(x));
function bclo(F, X) { const c = new Set(X); let ch = true; while (ch) { ch = false; for (const f of F) if (f.lhs.every((a) => c.has(a)) && f.rhs.some((a) => !c.has(a))) { f.rhs.forEach((a) => c.add(a)); ch = true; } } return c; }
function powerset(A) { const out = []; for (let m = 0; m < 1 << A.length; m++) out.push(A.filter((a, i) => m & (1 << i))); return out; }
function bkeys(A, F, R) { R = R || A; const sup = powerset(R).filter((x) => subset(S(R), bclo(F, x))); return sup.filter((x) => !sup.some((y) => y.length < x.length && y.every((a) => x.includes(a)))); }
function bBCNF(A, F, R) { for (const x of powerset(R)) { const c = [...bclo(F, x)].filter((a) => R.includes(a)); if (c.some((a) => !x.includes(a)) && c.length !== R.length) return false; } return true; }
function b3NF(A, F, R) { const prime = S(bkeys(A, F, R).flat()); for (const x of powerset(R)) { const c = [...bclo(F, x)].filter((a) => R.includes(a)); if (c.length === R.length) continue; if (c.some((a) => !x.includes(a) && !prime.has(a))) return false; } return true; }
function bChase(A, F, D) {
  const rows = D.map((s, i) => A.map((a, j) => (s.includes(a) ? 'a' + j : 'b' + i + '_' + j)));
  let ch = true;
  while (ch) {
    ch = false;
    for (const f of F) for (let i = 0; i < rows.length; i++) for (let k = 0; k < rows.length; k++) {
      if (i === k || !f.lhs.every((a) => rows[i][A.indexOf(a)] === rows[k][A.indexOf(a)])) continue;
      for (const a of f.rhs) {
        const j = A.indexOf(a), u = rows[i][j], v = rows[k][j];
        if (u === v) continue;
        const keep = u[0] === 'a' ? u : v[0] === 'a' ? v : u < v ? u : v, drop = keep === u ? v : u;
        for (const r of rows) if (r[j] === drop) r[j] = keep;
        ch = true;
      }
    }
  }
  return rows.some((r) => r.every((v) => v[0] === 'a'));
}
function bPreserve(A, F, D) {
  const G = [];
  for (const R of D) for (const x of powerset(R)) G.push({ lhs: x, rhs: [...bclo(F, x)].filter((a) => R.includes(a)) });
  return F.every((f) => subset(S(f.rhs), bclo(G, f.lhs)));
}
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function randomF(r, n) {
  const A = 'ABCDEFGH'.slice(0, n).split('');
  const F = [];
  const m = 1 + Math.floor(r() * (n + 1));
  for (let i = 0; i < m; i++) {
    const lhs = A.filter(() => r() < 0.3); if (!lhs.length) lhs.push(A[Math.floor(r() * n)]);
    const rhs = A.filter((a) => !lhs.includes(a) && r() < 0.3); if (!rhs.length) continue;
    F.push({ lhs, rhs });
  }
  return { A, F };
}

// ---- parsing ----------------------------------------------------------------------------------------------------
eq(N.parseFDs('A B -> C, C -> D').map((d) => [d.lhs, d.rhs]), [[['A', 'B'], ['C']], [['C'], ['D']]], 'parse: comma between FDs');
eq(N.parseFDs('AB->C; CD -> E').map((d) => [d.lhs, d.rhs]), [[['A', 'B'], ['C']], [['C', 'D'], ['E']]], 'parse: single letters');
eq(N.parseFDs('A -> B, C, D -> E').map((d) => [d.lhs, d.rhs]), [[['A'], ['B', 'C']], [['D'], ['E']]], 'parse: last comma splits');
eq(N.parseFDs('company_id -> city, budget\nperson_id -> fee', 'r(person_id, fee, company_id, city, budget)').map((d) => [d.lhs, d.rhs]), [[['company_id'], ['city', 'budget']], [['person_id'], ['fee']]], 'parse: names and new lines');
eq(N.parseFDs('{A, B} → {C}').map((d) => [d.lhs, d.rhs]), [[['A', 'B'], ['C']]], 'parse: unicode arrow and braces');
eq(N.parseMVDs('A ->> B; C -> D', 'R(A,B,C,D)').mvds.map((m) => m.text), ['A ↠ B'], 'parse: MVD');
eq(N.parseSchema('show(prod_id, title)'), { name: 'show', attrs: ['prod_id', 'title'] }, 'parse: schema');
eq(N.parseSchema('R(ABCD)').attrs, ['A', 'B', 'C', 'D'], 'parse: letter schema');
throws(() => N.parseFDs('A -> ', 'R(A,B)'), /right side .* position 3 is empty/, 'parse: empty right side');
throws(() => N.parseFDs('A B -> C D -> E'), /missing separator/, 'parse: missing separator');
throws(() => N.parseFDs('A -> X', 'R(A,B)'), /unknown attribute "X" at position 6/, 'parse: unknown attribute');
throws(() => N.parseFDs('id -> Name', 'r(id, name)'), /did you mean "name"/, 'parse: suggestion');
throws(() => N.parseFDs('A -> B; C', 'R(A,B,C)'), /expected "->"/, 'parse: missing arrow');
throws(() => N.parseFDs('A % B'), /unexpected character "%" at position 3/, 'parse: bad character');
throws(() => N.parseSchema('R(A, B, A)'), /appears twice/, 'parse: duplicate attribute');
{ let pos; try { N.parseFDs('A -> Q', 'R(A,B)'); } catch (e) { pos = e.pos; } eq(pos, 5, 'parse: error position'); }

// ---- worked examples ---------------------------------------------------------------------------------------------
// R1: A and B are on no right side, so every key holds both; B -> D is a partial dependency on the key AB
const R1 = 'R(A, B, C, D, E, F)', F1 = 'B -> D; A B -> C; C -> E; D -> F';
{
  const c = N.closure(R1, F1, 'AB');
  eq(c.attrs, ['A', 'B', 'C', 'D', 'E', 'F'], '(AB)+');
  eq(c.steps.map((s) => s.fd.text), ['B → D', 'AB → C', 'C → E', 'D → F'], '(AB)+ steps name the FDs');
  ok(c.superkey, 'AB superkey');
  eq(N.keys(R1, F1).keys, [['A', 'B']], 'keys of R1');
  eq(N.keys(R1, F1).mustHave, ['A', 'B'], 'AB on no right side');
  ok(!N.isSuperkey(R1, F1, 'A').ok, 'A not a superkey');
  eq(N.closure(R1, F1, 'D').attrs, ['D', 'F'], 'D+');
  ok(!N.derive(R1, F1, 'D', 'C').follows, 'D -> C does not follow');
  eq(N.derive(R1, F1, 'D', 'C').missing, ['C'], 'D -> C missing C');
  eq(N.normalForm(R1, F1).nf, '1NF', 'R1 only 1NF (B -> D partial)');
  eq(N.fplus('R(A,B,C)', 'A -> B; B -> C', { mode: 'closures' }).fds.find((f) => f.lhs.join('') === 'A').rhs, ['A', 'B', 'C'], 'F+ closures');
  eq(N.fplus('R(A,B)', 'A -> B').count, 2, 'F+ nontrivial of A -> B: A -> B, A -> AB');
  eq(N.fplus('R(A,B)', 'A -> B', { mode: 'all' }).count, 7, 'F+ all (A: 3, B: 1, AB: 3)');
}
// Armstrong derivations: every line checked mechanically
function validProof(schema, F, X, Y, opts) {
  const P = N.problem(schema, F);
  const d = N.derive(P, undefined, X, Y, opts);
  if (!d.follows) return false;
  const m = (a) => N.mask(P, a);
  const L = d.steps.map((s) => ({ l: m(s.lhs), r: m(s.rhs), rule: s.rule, from: s.from.map((n) => d.steps[n - 1]).map((t) => ({ l: m(t.lhs), r: m(t.rhs) })) }));
  const sb = (a, b) => (a & b) === a;
  for (const s of L) {
    let good;
    switch (s.rule) {
      case 'given': good = P.fds.some((f) => f.l === s.l && f.r === s.r); break;
      case 'reflexivity': good = sb(s.r, s.l); break;
      case 'augmentation': { const t = s.from[0]; good = sb(t.l, s.l) && sb(t.r, s.r) && sb(s.l & ~t.l, s.r) && sb(s.r & ~t.r, s.l); break; }
      case 'transitivity': good = s.from[0].l === s.l && s.from[0].r === s.from[1].l && s.from[1].r === s.r; break;
      case 'union': good = s.from[0].l === s.l && s.from[1].l === s.l && (s.from[0].r | s.from[1].r) === s.r; break;
      case 'decomposition': good = s.from[0].l === s.l && sb(s.r, s.from[0].r); break;
      default: good = false;
    }
    if (!good) return false;
    if (opts && opts.basic && !['given', 'reflexivity', 'augmentation', 'transitivity'].includes(s.rule)) return false;
  }
  const last = L[L.length - 1];
  return last.l === m(X) && last.r === m(Y);
}
ok(validProof(R1, F1, 'AB', 'F'), 'proof AB -> F');
ok(validProof(R1, F1, 'B', 'F'), 'proof B -> F');
ok(validProof(R1, F1, 'AB', 'CE'), 'proof AB -> CE');
ok(validProof(R1, F1, 'AB', 'ABCDEF', { basic: true }), 'proof AB -> R with the three axioms only');
ok(validProof(R1, F1, 'AB', 'B'), 'proof by reflexivity');
// canonical cover: B is extraneous on the left of AB -> CD (A alone gives C, then D), and D on the right of A -> CD
{
  const c = N.canonicalCover('R(A,B,C,D)', 'A -> C; A B -> C D; C -> D');
  eq(c.fds.map((f) => f.text), ['A → C', 'C → D'], 'canonical cover');
  ok(c.steps.some((s) => s.action === 'lhs' && s.attr === 'B') && c.steps.some((s) => s.action === 'rhs' && s.attr === 'D'), 'cover steps justified');
  eq(N.canonicalCover('R(A,B,C,D)', 'A -> B; B -> C; A -> C; AB -> D').fds.map((f) => f.text), ['A → BD', 'B → C'], 'cover: transitive and extraneous LHS');
}
// artist_co: a transitive dependency through company_id; coaching: 3NF but not BCNF
const ID = 'artist_co(person_id, billed_as, fee, company_id, city, budget)', IDF = 'person_id -> billed_as, fee, company_id; company_id -> city, budget';
{
  const nf = N.normalForm(ID, IDF);
  eq(nf.nf, '2NF', 'artist_co 2NF');
  eq(nf.tests.BCNF.violations.map((v) => v.text), ['company_id → city, budget'], 'artist_co BCNF violation');
  eq(N.bcnfDecompose(ID, IDF).schemas.map((s) => s.join(',')).sort(), ['person_id,billed_as,fee,company_id', 'company_id,city,budget'].sort(), 'artist_co BCNF decomposition');
  ok(N.losslessBinary(ID, IDF, 'person_id billed_as fee company_id', 'company_id city budget').lossless, 'artist_co split lossless (binary)');
  ok(!N.losslessBinary(ID, IDF, 'person_id billed_as fee city', 'company_id city budget').lossless, 'split on city lossy');
}
// each coach works on one production; an artist has one coach in each production
const DA = 'coaching(artist, production, coach)', DAF = 'coach -> production; artist, production -> coach';
{
  eq(sortSets(N.keys(DA, DAF).keys), sortSets([['artist', 'coach'], ['artist', 'production']]), 'coaching keys');
  eq(N.normalForm(DA, DAF).nf, '3NF', 'coaching 3NF');
  ok(N.is3NF(DA, DAF).ok && !N.isBCNF(DA, DAF).ok, 'coaching 3NF not BCNF');
  const d = N.bcnfDecompose(DA, DAF);
  eq(sortSets(d.schemas), sortSets([['artist', 'coach'], ['production', 'coach']]), 'coaching BCNF decomposition');
  ok(!d.preserved && d.lost[0].text === 'artist, production → coach', 'coaching BCNF loses artist production -> coach');
  ok(!N.preservesDependencies(DA, DAF, d.schemas).preserved, 'preservation test agrees');
  eq(N.primeAttrs(DA, DAF).nonprime, [], 'coaching all prime');
}
// show: productions, stages and performances in one relation, decomposed in two BCNF steps
{
  const cl = 'show(prod_id, title, company_id, genre, perf_id, venue_code, stage_no, seats, perf_date, price)';
  const F = 'prod_id -> title, company_id, genre; venue_code, stage_no -> seats; perf_id -> prod_id, venue_code, stage_no, perf_date, price';
  eq(N.keys(cl, F).keys, [['perf_id']], 'show key');
  const d = N.bcnfDecompose(cl, F);
  eq(sortSets(d.schemas), sortSets([['prod_id', 'title', 'company_id', 'genre'], ['venue_code', 'stage_no', 'seats'], ['prod_id', 'perf_id', 'venue_code', 'stage_no', 'perf_date', 'price']]), 'show BCNF decomposition');
  eq(d.steps.length, 2, 'show: two steps');
  ok(N.chase(cl, F, d.schemas).lossless, 'show decomposition lossless');
}
// 3NF synthesis: a stage manager works at one venue, so (venue, stage_manager) is inside (performer, venue, stage_manager)
{
  const desk = 'desk(performer, venue, stage_manager, agent)', F = 'performer venue -> stage_manager; stage_manager -> venue; performer -> agent';
  const d = N.synth3NF(desk, F);
  eq(sortSets(d.schemas), sortSets([['performer', 'venue', 'stage_manager'], ['performer', 'agent']]), 'desk 3NF');
  ok(d.steps.some((s) => s.action === 'remove' && s.schema.join(',') === 'venue,stage_manager'), 'redundant schema removed');
  const d2 = N.synth3NF('R(A,B,C,D)', 'A -> B; C -> D');
  ok(d2.steps.some((s) => s.action === 'key' && s.schema && s.schema.join('') === 'AC'), '3NF adds the key AC');
  eq(sortSets(d2.schemas), sortSets([['A', 'B'], ['C', 'D'], ['A', 'C']]), '3NF with key schema');
}
// lossless joins and the chase
{
  ok(N.chase('R(A,B,C)', 'A -> B', ['AB', 'AC']).lossless, 'chase AB, AC lossless');
  ok(!N.chase('R(A,B,C)', 'A -> B', ['AB', 'BC']).lossless, 'chase AB, BC lossy');
  const c = N.chase('R(A,B,C,D,E)', 'A -> C; B -> C; C -> D; DE -> C; CE -> A', ['AD', 'AB', 'BE', 'CDE', 'AE']);
  ok(c.lossless === bChase('ABCDE'.split(''), N.parseFDs('A -> C; B -> C; C -> D; DE -> C; CE -> A'), ['AD', 'AB', 'BE', 'CDE', 'AE'].map((s) => s.split(''))), 'five-way chase agrees with brute force');
  ok(c.tableaux.length > 1 && c.tableaux[0].fd === null, 'chase reports tableau states');
  const c2 = N.chase('R(A,B,C,D)', 'A -> B; B -> C; C -> D', ['AB', 'BC', 'CD']);
  ok(c2.lossless, 'chain decomposition lossless');
  eq(c2.tableaux[0].rows, [['a1', 'a2', 'b13', 'b14'], ['b21', 'a2', 'a3', 'b24'], ['b31', 'b32', 'a3', 'a4']], 'initial tableau');
}
// dependency preservation
{
  ok(N.preservesDependencies('R(A,B,C)', 'A -> B; B -> C', ['AB', 'BC']).preserved, 'AB, BC preserves');
  const p = N.preservesDependencies('R(A,B,C)', 'A -> B; B -> C', ['AB', 'AC']);
  ok(!p.preserved && p.lost.map((f) => f.text).join() === 'B → C', 'AB, AC loses B -> C');
  // A -> C over AB, BC is preserved through B though no schema holds both A and C
  const q = N.preservesDependencies('R(A,B,C)', 'A -> B; B -> C; A -> C', ['AB', 'BC']);
  ok(q.preserved && q.results[2].steps.some((s) => s.added.includes('C')), 'A -> C preserved through the closures');
}
// MVDs and 4NF
{
  // an artist's languages are independent of the artist's agent
  const r = 'artist_info(person_id, language, agent, agent_phone)', D = 'person_id ->> language';
  ok(!N.is4NF(r, D).ok, 'artist_info 4NF violation');
  eq(sortSets(N.fourNFDecompose(r, D).schemas), sortSets([['person_id', 'language'], ['person_id', 'agent', 'agent_phone']]), 'artist_info 4NF decomposition');
  // A ->> BC and C ->> D give A ->> D, which splits the second schema ADE
  const d = N.fourNFDecompose('R(A,B,C,D,E)', 'A ->> B C; C ->> D');
  eq(sortSets(d.schemas), sortSets([['A', 'B', 'C'], ['A', 'D'], ['A', 'E']]), '4NF decomposition');
  ok(d.steps.some((s) => s.dep === 'A ↠ D'), '4NF uses the derived A ->> D');
  ok(N.is4NF('R(A,B,C)', 'A ->> B; A -> C').ok === false, 'A ->> B with A not a key');
  ok(N.is4NF('R(A,B,C)', 'A -> B C').ok, 'key MVD fine');
  eq(N.normalForm('R(A,B,C)', 'A ->> B').nf, 'BCNF', 'BCNF but not 4NF');
}
// 2NF
{
  eq(N.is2NF('R(A,B,C,D)', 'AB -> C; B -> D').violations.map((v) => v.text), ['B → D'], '2NF partial dependency');
  ok(N.is2NF('R(A,B,C)', 'A -> B; B -> C').ok, 'single-attribute key is 2NF');
  ok(!N.normalForm('R(A,B)', '', { nonAtomic: ['B'] }).tests['1NF'].ok, '1NF with non-atomic domain');
  eq(N.normalForm('R(A,B)', '').nf, 'BCNF', 'no FDs: BCNF');
}

// ---- randomized cross-checks against brute force -------------------------------------------------------------------
{
  const r = mulberry(42);
  let bad = 0, n0 = 0;
  for (let t = 0; t < 300; t++) {
    const n = 3 + Math.floor(r() * 4);
    const { A, F } = randomF(r, n);
    const P = N.problem(A, F);
    const X = A.filter(() => r() < 0.4);
    const c = N.closure(P, undefined, X).attrs;
    if (c.join() !== A.filter((a) => bclo(F, X).has(a)).join()) bad++;
    if (JSON.stringify(sortSets(N.keys(P).keys)) !== JSON.stringify(sortSets(bkeys(A, F)))) bad++;
    // canonical cover equivalent to F
    const G = N.canonicalCover(P).fds;
    if (!F.every((f) => subset(S(f.rhs), bclo(G, f.lhs))) || !G.every((g) => subset(S(g.rhs), bclo(F, g.lhs)))) bad++;
    if (new Set(G.map((g) => g.lhs.join())).size !== G.length) bad++;
    // normal form tests: direct on F against brute force
    if (N.isBCNF(P).ok !== bBCNF(A, F, A) || N.isBCNF(P, undefined, null, { exhaustive: true }).ok !== bBCNF(A, F, A)) bad++;
    if (N.is3NF(P).ok !== b3NF(A, F, A) || N.is3NF(P, undefined, null, { exhaustive: true }).ok !== b3NF(A, F, A)) bad++;
    // BCNF decomposition: lossless and every schema in BCNF
    const bd = N.bcnfDecompose(P).schemas;
    if (!bChase(A, F, bd) || !bd.every((s) => bBCNF(A, F, s)) || new Set(bd.flat()).size !== A.length) bad++;
    if (bd.some((s) => bd.some((t2) => t2 !== s && s.every((a) => t2.includes(a))))) bad++;
    if (N.bcnfDecompose(P).preserved !== bPreserve(A, F, bd)) bad++;
    // 3NF synthesis: lossless, preserving, every schema in 3NF
    const td = N.synth3NF(P).schemas;
    if (!bChase(A, F, td) || !bPreserve(A, F, td) || !td.every((s) => b3NF(A, F, s)) || new Set(td.flat()).size !== A.length) bad++;
    // the chase against brute force on random decompositions, the binary test against the chase
    const D = [A.filter(() => r() < 0.6), A.filter(() => r() < 0.6), A.filter(() => r() < 0.5)].filter((s) => s.length);
    for (const a of A) if (!D.some((s) => s.includes(a))) D[0].push(a);
    D.forEach((s) => s.sort((x, y) => A.indexOf(x) - A.indexOf(y)));
    if (N.chase(P, undefined, D).lossless !== bChase(A, F, D)) bad++;
    if (D.length === 2 && N.losslessBinary(P, undefined, D[0], D[1]).lossless !== bChase(A, F, D)) bad++;
    if (N.preservesDependencies(P, undefined, D).preserved !== bPreserve(A, F, D)) bad++;
    // derivations
    const Y = A.filter(() => r() < 0.4);
    if (Y.length) { const follows = subset(S(Y), bclo(F, X)); if (follows !== N.derive(P, undefined, X, Y).follows || (follows && !validProof(A, F, X, Y))) bad++; }
    n0++;
  }
  eq(bad, 0, 'randomized cross-checks (' + n0 + ' schemas)');
}

// ---- exercises and the checker ---------------------------------------------------------------------------------------
{
  let bad = 0;
  for (const kind of N.KINDS) for (let seed = 1; seed <= 25; seed++) {
    const ex = N.exercise(kind, seed);
    if (JSON.stringify(ex) !== JSON.stringify(N.exercise(kind, seed))) { bad++; console.log('not deterministic', kind, seed); }
    if (!N.check(ex, ex.answer).ok) { bad++; console.log('reference rejected', kind, seed, N.check(ex, ex.answer).feedback); }
    const P = N.problem(ex.schema, ex.fds);
    const wrong = (a, what) => { if (N.check(ex, a).ok) { bad++; console.log('wrong accepted', kind, seed, what, JSON.stringify(a)); } };
    const right = (a, what) => { const c = N.check(ex, a); if (!c.ok) { bad++; console.log('right rejected', kind, seed, what, JSON.stringify(a), c.feedback); } };
    switch (kind) {
      case 'closure': {
        right(ex.answer.closure.join(''), 'letters');
        right(ex.answer.closure.slice().reverse().join(', '), 'reversed');
        const extra = ex.schema.attrs.find((a) => !ex.answer.closure.includes(a));
        if (extra) wrong(ex.answer.closure.concat([extra]), 'extra');
        if (ex.answer.closure.length > ex.given.attrs.length) wrong(ex.given.attrs, 'only X');
        break;
      }
      case 'keys': {
        right(ex.answer.keys.slice().reverse().map((k) => k.join('')).join(', '), 'text');
        if (ex.answer.keys.length > 1) wrong(ex.answer.keys.slice(1), 'missing key');
        wrong(ex.answer.keys.concat([ex.schema.attrs]).filter((k, i, a) => a.findIndex((x) => x.join() === k.join()) === i), 'superkey added');
        break;
      }
      case 'cover': {
        right(N.canonicalCover(P.attrs, ex.fds.slice().reverse()).fds.map((f) => f.text).join('; '), 'cover from reversed F');
        const isCanon = N.check(ex, { fds: ex.fds.map((f) => f.text) }).ok;
        if (N.canonicalCover(P).steps.length && isCanon) { bad++; console.log('F itself accepted', seed); }
        if (ex.answer.fds.length > 1) wrong({ fds: ex.answer.fds.slice(1) }, 'dropped FD');
        break;
      }
      case 'normalForm': {
        right(ex.answer.nf.toLowerCase(), 'lower case');
        wrong(ex.answer.nf === 'BCNF' ? '3NF' : 'BCNF', 'other NF');
        break;
      }
      case 'bcnf': {
        right(N.bcnfDecompose(P, undefined, { expand: true }).schemas.map((s) => '(' + s.join(', ') + ')').join(', '), 'expanded BCNF');
        right(ex.answer.schemas.map((s) => s.join('')).join(', '), 'letters');
        wrong([ex.schema.attrs], 'R itself');
        wrong(ex.schema.attrs.map((a) => [a]), 'single attributes');
        break;
      }
      case '3nf': {
        right(N.synth3NF(P, undefined, { reverse: true }).schemas, 'synthesis from reversed F');
        const bd = N.bcnfDecompose(P);
        if (bd.preserved) right(bd.schemas, 'preserving BCNF decomposition'); else wrong(bd.schemas, 'non-preserving BCNF decomposition');
        wrong(ex.schema.attrs.map((a) => [a]), 'single attributes');
        break;
      }
      case 'lossless': right(ex.answer.lossless ? 'yes' : 'lossy', 'words'); wrong(!ex.answer.lossless, 'negated'); break;
      case 'preservation': right({ preserved: ex.answer.preserved, lost: ex.answer.lost }, 'with lost'); wrong(!ex.answer.preserved, 'negated'); break;
    }
  }
  eq(bad, 0, 'exercises: deterministic, reference and alternatives accepted, wrong answers rejected');
  const ex = N.exercise('keys', 3);
  ok(/candidate keys/.test(ex.prompt) && ex.schema.attrs.length >= 4 && ex.schema.attrs.length <= 7, 'exercise prompt and size');
  eq(N.exercise('closure', 5, { attrs: 6 }).schema.attrs.length, 6, 'exercise size option');
  const kx = N.exercise('bcnf', 2);
  ok(!N.check(kx, 'nonsense Z').ok && /could not read|unknown/.test(N.check(kx, 'nonsense Z').feedback.join()), 'checker reports unreadable answers');
  const c = N.check(N.exercise('normalForm', 9), 'BCNF');
  ok(c.ok || c.feedback.length > 0, 'checker gives feedback');
}

// ---- FD discovery on Theatre data ----------------------------------------------------------------------------------
{
  const db = new K.Database(); const s = db.session();
  s.exec(fs.readFileSync(path.join(root, 'src/data/theatre.sql'), 'utf8'));
  const t0 = Date.now();
  const d = N.discover(s, 'artist');
  const has = (dd, l, r) => dd.holds.some((h) => h.lhs.join() === l && h.rhs.join() === r);
  ok(has(d, 'person_id', 'company_id') && has(d, 'person_id', 'billed_as') && has(d, 'person_id', 'fee'), 'artist: person_id -> company_id, billed_as, fee');
  ok(d.keys.some((k) => k.join() === 'person_id'), 'artist: person_id unique');
  ok(d.holds.every((h) => !h.lhs.includes('person_id') || h.lhs.length === 1), 'minimal left sides only');
  const c = N.discover(s, 'production');
  ok(has(c, 'prod_id', 'title'), 'production: prod_id -> title');
  ok(!has(c, 'genre', 'title') && c.fails.some((f) => f.lhs.join() === 'genre' && f.rhs.join() === 'title'), 'production: genre -> title fails');
  const f = c.fails.find((x) => x.lhs.join() === 'genre' && x.rhs.join() === 'title');
  ok(c.rows[f.violation[0]][3] === c.rows[f.violation[1]][3] && c.rows[f.violation[0]][1] !== c.rows[f.violation[1]][1], 'violating pair agrees on genre, differs on title');
  const co = N.discover(s, 'company');
  ok(has(co, 'company_id', 'city'), 'company: company_id -> city');
  const pf = N.discover(s, 'performance', { maxLhs: 2 });
  ok(pf.holds.every((h) => h.lhs.length <= 2), 'maxLhs respected');
  const bk = N.discover(s, 'booking');
  ok(Array.isArray(bk.holds) && bk.text.includes('NULL'), 'booking discovered');
  ok(Date.now() - t0 < 15000, 'discovery is quick');
  // a small instance with support and a NULL
  const small = N.discover({ cols: ['a', 'b', 'c'], rows: [[1, 'x', null], [1, 'x', null], [2, 'y', 5], [3, 'y', 6]] });
  const ab = small.holds.find((h) => h.lhs.join() === 'a' && h.rhs.join() === 'b');
  ok(ab && ab.support.length === 1 && !ab.vacuous, 'a -> b supported by rows 0, 1');
  ok(small.holds.some((h) => h.lhs.join() === 'a' && h.rhs.join() === 'c'), 'NULL equals NULL');
  ok(small.fails.some((f) => f.lhs.join() === 'b' && f.rhs.join() === 'c' && f.violation.join() === '2,3'), 'b -> c violated by rows 2, 3');
}

// ---- anomaly scripts on Kwery ---------------------------------------------------------------------------------------------
function runScenarios(a, what) {
  for (const sc of a.scenarios) {
    const db = new K.Database(); const s = db.session();
    const res = s.exec(sc.sql, { collectErrors: true });
    const last = res[res.length - 1];
    if (sc.expect.error) { ok(last.error && last.error.code === sc.expect.error, what + ' ' + sc.kind + ' fails with ' + sc.expect.error + (last.error ? ' (' + last.error.code + ' ' + last.error.message + ')' : '')); ok(res.slice(0, -1).every((r) => !r.error), what + ' ' + sc.kind + ' setup runs'); }
    else { ok(!res.some((r) => r.error), what + ' ' + sc.kind + ' runs' + (res.find((r) => r.error) ? ': ' + res.find((r) => r.error).error.message : '')); eq(last.rows && last.rows.length, sc.expect.rows, what + ' ' + sc.kind + ' shows the anomaly'); }
  }
}
{
  const a = N.anomalies(ID, IDF);
  eq(a.violation.text, 'company_id → city, budget', 'anomalies: violating FD');
  eq(a.scenarios.map((x) => x.kind), ['update', 'insert', 'delete'], 'three scenarios');
  runScenarios(a, 'artist_co');
  runScenarios(N.anomalies(DA, DAF, { table: 'coaching' }), 'coaching');
  runScenarios(N.anomalies('R(A,B,C,D)', 'AB -> C; B -> D'), 'R');
  runScenarios(N.anomalies(ID, IDF, { rows: [['P1', 'Ann', '100', 'C01', 'Brightwater', '9000'], ['P2', 'Bob', '200', 'C01', 'Brightwater', '9000'], ['P3', 'Cy', '300', 'C02', 'Saltreach', '800']] }), 'given rows');
  eq(N.anomalies('R(A,B)', 'A -> B').scenarios.length, 0, 'BCNF schema: no anomalies');
}

console.log(pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
