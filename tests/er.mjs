// Tests of the E-R modelling engine: the text format, validation and design checks, the reduction to tables (run
// on Kwery and on PostgreSQL 17), reverse engineering, layout, SVG, comparison and the exercises.
// Run: node tests/er.mjs
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { load } from './load.mjs';

const K = load();
const ER = K.ER;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0, skip = 0;
const ok = (c, what, extra) => { if (c) pass++; else { fail++; console.log('FAIL ' + what + (extra !== undefined ? '\n  ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : '')); } };
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), what, 'expected ' + JSON.stringify(b) + '\n  got      ' + JSON.stringify(a));
const throws = (f, re, what) => { try { f(); ok(false, what, 'did not throw'); } catch (e) { ok(re.test(e.message), what, e.message); } };
const codes = (list) => list.map((x) => x.code);
const has = (list, code, re, what) => { const x = list.find((y) => y.code === code); ok(!!x && (!re || re.test(x.message)), what || 'has ' + code, list.map((y) => y.code + ': ' + y.message).join('\n  ')); return x; };
const fresh = () => new K.Database().session();
const run = (ddl) => { const s = fresh(); s.exec(ddl); return s; };
const tableOf = (res, n) => res.tables.find((t) => t.name.toLowerCase() === n.toLowerCase());
const stepRules = (res) => res.steps.map((s) => s.rule);
const value = (s, sql) => { const r = [].concat(s.exec(sql)).pop(); return K.T.output(r.rows[0][0], r.cols[0].type); };

// the editor's default design (a theatre network), in the text format
const THEATRE = `
-- venues and their stages, productions staged by companies, and the people who make and watch them
entity venue (venue_code varchar(6) key, venue_name varchar(40), address (street varchar(40), city varchar(30), postcode varchar(10)), {phone varchar(20)})
weak entity stage (stage_no integer partial, seats integer, stage_kind varchar(12))
identifying relationship has_stage (stage [1..1] total, venue [0..*])
entity company (company_id integer key, company_name varchar(40), founded integer)
entity production (prod_id integer key, title varchar(60), opening date, weeks_open() derived from opening)
entity season (season_year integer key, theme varchar(40))
entity person (person_id integer key, full_name (given varchar(30), family varchar(30)), birth_date date, age() derived from birth_date)
entity artist (billed_as varchar(40), {skill varchar(20)})
entity crew (trade varchar(20), day_rate numeric(7,2))
isa person (artist, crew) overlapping partial
entity patron (patron_id integer key, name varchar(40), {email varchar(60)})
relationship staged_by (production [1..1] total, company [0..*])
relationship scheduled (production [0..*], stage [0..*], season [0..*]) with (nights integer)
relationship belongs_to (artist [0..*], company [0..*]) with (since date)
relationship coaches (artist as coach [0..*], artist as trainee [0..1])
relationship attends (patron [0..*], production [0..*]) with (rating integer)
relationship runs (crew [0..1], stage [0..*])
`;

// ---- the text format ------------------------------------------------------------------------------------------
{
  const m = ER.parse(THEATRE);
  eq(m.entities.map((e) => e.name), ['venue', 'stage', 'company', 'production', 'season', 'person', 'artist', 'crew', 'patron'], 'dsl: entity sets');
  const ven = ER.entity(m, 'venue');
  eq(ER.leaves(ven.attributes).map((l) => l.path.join('.')), ['venue_code', 'venue_name', 'address.street', 'address.city', 'address.postcode', 'phone'], 'dsl: composite attributes');
  eq(ER.leaves(ER.parse('entity a (k key, addr (street (number, name), city))').entities[0].attributes).map((l) => l.path.join('.')), ['k', 'addr.street.number', 'addr.street.name', 'addr.city'], 'dsl: nested composite attributes');
  const prod = ER.entity(m, 'production');
  eq([ven.attributes[3].multivalued, prod.attributes[3].derived, prod.attributes[3].from], [true, true, ['opening']], 'dsl: multivalued in braces, derived with () and from');
  eq(ven.attributes[0].type, 'varchar(6)', 'dsl: type with a parameter');
  eq(ER.entity(m, 'crew').attributes[1].type, 'numeric(7,2)', 'dsl: type with two parameters');
  const stg = ER.entity(m, 'stage');
  eq([stg.weak, stg.identifiedBy, ER.owner(m, stg), ER.keyOf(m, 'stage')], [true, 'has_stage', 'venue', ['venue_code', 'stage_no']], 'dsl: weak entity set, owner and key');
  const runs = ER.relationship(m, 'runs');
  eq([ER.mapping(runs), runs.participants[0].max, runs.participants[1].max], ['N:1', 1, '*'], 'dsl: [0..1] [0..*] is many-to-one');
  eq(ER.mapping(ER.relationship(m, 'attends')), 'M:N', 'dsl: attends is many-to-many');
  eq(ER.relationship(m, 'attends').attributes.map((a) => a.name), ['rating'], 'dsl: descriptive attribute');
  eq(ER.relationship(m, 'scheduled').participants.map((p) => p.entity), ['production', 'stage', 'season'], 'dsl: ternary relationship');
  eq(ER.relationship(m, 'coaches').participants.map((p) => p.role), ['coach', 'trainee'], 'dsl: roles');
  eq([m.specializations[0].parent, m.specializations[0].children, m.specializations[0].disjoint, m.specializations[0].total], ['person', ['artist', 'crew'], false, false], 'dsl: overlapping partial specialization');
  eq(ER.validate(m).filter((x) => x.severity === 'error'), [], 'dsl: the theatre design is valid');
  // the same model written back and read again
  eq(ER.toJSON(ER.parse(ER.toText(m))), ER.toJSON(m), 'dsl: toText round trip');
  eq(ER.toJSON(ER.fromJSON(JSON.stringify(ER.toJSON(m)))), ER.toJSON(m), 'json: round trip');
  eq(ER.toJSON(m).format, 'kwery-er', 'json: format tag');
  ok(!JSON.stringify(ER.toJSON(m)).includes('"loc"'), 'json: source positions are not saved');
  throws(() => ER.fromJSON('{"entities": 3}'), /not an E-R model/, 'json: bad shape');
  // mapping cardinality shorthand, one/many and the arrow of an n-ary relationship
  const c = ER.parse('entity a (x key)\nentity b (y key)\nentity c (z key)\nrelationship r 1:N (a, b total)\nrelationship s (a, b one)\nrelationship t (a, b, c one)\nrelationship u M:N (a, b)\nrelationship v 1:1 (a, b)');
  eq([ER.mapping(ER.relationship(c, 'r')), ER.isTotal(ER.relationship(c, 'r').participants[1])], ['1:N', true], 'dsl: 1:N header');
  eq(ER.mapping(ER.relationship(c, 's')), 'N:1', 'dsl: one on a binary participant');
  eq(ER.relationship(c, 't').participants.map((p) => !!p.arrow), [false, false, true], 'dsl: one on an n-ary participant is an arrow');
  eq([ER.mapping(ER.relationship(c, 'u')), ER.mapping(ER.relationship(c, 'v'))], ['M:N', '1:1'], 'dsl: M:N and 1:1 headers');
  const isa = ER.parse('entity member (id key, name)\nentity player (position)\nentity coach (licence)\nisa member (player, coach) overlapping total\ngeneralization member -> player disjoint\naggregation g of r\nentity "select" (k key)');
  eq([isa.specializations[0].disjoint, isa.specializations[0].total, isa.specializations[1].kind, isa.aggregations[0].relationship, isa.entities[3].name], [false, true, 'generalization', 'r', 'select'], 'dsl: isa, generalization, aggregation, quoted names');
  eq(ER.inherited(isa, 'player').map((x) => x.attr.name), ['id', 'name'], 'model: attribute inheritance');
  eq(ER.keyOf(isa, 'coach'), ['id'], 'model: a lower-level entity set has the key of its higher-level set');
  // owner shorthand builds the identifying relationship
  const o = ER.parse('entity building (bno key)\nweak entity room owner building (rno partial)');
  eq([o.relationships[0].name, o.relationships[0].identifying, ER.keyOf(o, 'room')], ['room_building', true, ['bno', 'rno']], 'dsl: weak entity with owner shorthand');
  // errors with positions
  const perr = (src) => ER.tryParse(src).error;
  let e = perr('entity a (x key,\n  , y)');
  eq([e.line, e.col, e.reason], [2, 3, "expected an attribute name, found ','"], 'parse error: position and reason');
  e = perr('entity a (x key');
  eq([e.line, e.col], [1, 16], 'parse error: unexpected end');
  ok(/expected ',' or '\)' after attribute 'x', found the end of the text/.test(e.message), 'parse error: message names the attribute', e.message);
  e = perr('entity a (x numeric(a))');
  eq([e.col, e.reason], [21, "expected a number in the type of 'x', found 'a'"], 'parse error: type parameter');
  e = perr('table a (x)');
  ok(e.line === 1 && e.col === 1 && /expected entity, weak entity, relationship/.test(e.reason), 'parse error: unknown statement', e.message);
  e = perr('entity a (x key)\nrelationship r 1:N (a, a as b, a as c)');
  eq([e.line, e.col], [2, 16], 'parse error: mapping cardinality on a ternary relationship points at the cardinality');
  e = perr('relationship r (a [0..x], b)');
  ok(e && e.col === 23 && /maximum cardinality/.test(e.reason), 'parse error: bad maximum', e && e.message);
  e = perr('entity a (key)');
  ok(e && /'key' is a keyword/.test(e.reason), 'parse error: key without a name', e && e.message);
  e = perr('entity a (x) $');
  ok(e && e.col === 14 && /unexpected character/.test(e.reason), 'parse error: bad character', e && e.message);
  e = perr('entity a (x key)\n\nentity b ({ y )');
  ok(e && e.line === 3 && /expected '\}' to close multivalued attribute 'y'/.test(e.reason), 'parse error: unclosed brace', e && e.message);
  e = perr('relationship r (a total partial, b)');
  ok(e && /both total and partial/.test(e.reason), 'parse error: total and partial', e && e.message);
  ok(perr('entity "a (x)') && /unterminated quoted name/.test(perr('entity "a (x)').reason), 'parse error: unterminated quote');
  ok(typeof ER.GRAMMAR === 'string' && ER.GRAMMAR.includes('relationship :='), 'grammar text');
}

// ---- validation -----------------------------------------------------------------------------------------------
{
  const v = (src) => ER.validate(ER.parse(src));
  let r = v('weak entity stage (stage_no partial)\nentity venue (venue_code key)');
  has(r, 'weak-no-identifying', /weak entity set 'stage' has no identifying relationship/, 'validate: weak entity set without identifying relationship');
  r = v('entity a (x key)\nrelationship r (a)');
  has(r, 'too-few-participants', /relationship set 'r' has only one participant \(a\)/, 'validate: one participant');
  r = v('entity a (x key)\nentity a (y key)\nrelationship a (a as p, a as q)');
  ok(r.filter((x) => x.code === 'duplicate-name').length === 2 && /duplicate name 'a'/.test(r[0].message), 'validate: duplicate names across entity and relationship sets', r);
  r = v('entity a (x key, y, Y)');
  has(r, 'duplicate-attribute', /entity set 'a' has two attributes named 'Y'/, 'validate: duplicate attributes (case-insensitive)');
  r = v('entity a ({x} key, y)');
  has(r, 'key-multivalued', /multivalued attribute 'x' of entity set 'a' cannot be a key/, 'validate: key on a multivalued attribute');
  r = v('entity a (x key, age() key)');
  has(r, 'key-derived', /derived attribute 'age'/, 'validate: key on a derived attribute');
  r = v('entity a (x, y)');
  has(r, 'missing-key', /entity set 'a' has no key/, 'validate: missing key');
  r = v('entity c (k key)\nweak entity w (d key)\nidentifying relationship cw (w, c)');
  has(r, 'weak-has-key', /weak entity set 'w' marks 'd' as a key/, 'validate: weak entity set with a key');
  has(r, 'weak-no-discriminator', null, 'validate: weak entity set without discriminator (warning)');
  r = v('entity a (x partial, y key)');
  has(r, 'partial-on-strong', /strong entity set 'a'/, 'validate: partial key on a strong entity set');
  r = v('entity c (k key)\nweak entity w (d partial)\nidentifying relationship cw (w [0..1], c)');
  has(r, 'identifying-partial', /must participate totally/, 'validate: partial participation in the identifying relationship');
  r = v('entity c (k key)\nweak entity w (d partial)\nidentifying relationship cw (w [1..*], c)');
  has(r, 'identifying-not-many-to-one', /many-to-one from 'w' to its owner/, 'validate: identifying relationship must be many-to-one');
  r = v('entity a (k key)\nentity b (j key)\nidentifying relationship ab (a, b)');
  has(r, 'identifying-not-weak', null, 'validate: identifying relationship without a weak entity set');
  r = v('entity e (k key)\nrelationship manages (e, e)');
  has(r, 'role-needed', /give each occurrence a distinct role/, 'validate: recursive relationship needs roles');
  r = v('entity a (k key)\nrelationship r (a, ghost)');
  has(r, 'unknown-entity', /refers to 'ghost'/, 'validate: unknown participant');
  r = v('entity a (k key)\nentity b (j key)\nrelationship r (a, b)\nrelationship s (a, r)');
  has(r, 'unknown-entity', /it is a relationship set: declare an aggregation/, 'validate: relationship as participant suggests aggregation');
  r = v('entity a (k key)\nentity b (j key)\nrelationship r (a [3..2], b)');
  has(r, 'cardinality-range', /minimum 3 above maximum 2/, 'validate: min above max');
  r = v('entity a (k key)\nentity b (j key)\nrelationship r (a [0..1] total, b)');
  has(r, 'total-min-zero', /marked total but its minimum is 0/, 'validate: total with minimum 0 (warning)');
  ok(r.every((x) => x.severity === 'warning'), 'validate: total with minimum 0 is only a warning');
  r = v('entity a (k key)\nentity b (j key)\nentity c (i key)\nrelationship r (a one, b one, c)');
  has(r, 'multiple-arrows', /at most one/, 'validate: more than one arrow out of a ternary relationship');
  r = v('entity a (k key)\nentity b ()\nentity c ()\nisa a (b)\nisa b (c)\nisa c (a)');
  has(r, 'isa-cycle', /cycle/, 'validate: specialization cycle');
  r = v('entity a (k key)\nisa a (ghost)');
  has(r, 'unknown-child', null, 'validate: unknown lower-level entity set');
  r = v('aggregation g of nothing');
  has(r, 'unknown-relationship', /aggregation 'g' refers to 'nothing'/, 'validate: aggregation of an unknown relationship');
  r = v('entity a (k key)\nentity b (x key, z)\nisa a (b)');
  has(r, 'subclass-has-key', /inherits the key of 'a'/, 'validate: lower-level entity set declaring a key');
  r = v('entity a (k key, n)\nentity b (n)\nisa a (b)');
  has(r, 'duplicate-attribute', /already inherits from 'a'/, 'validate: attribute that is also inherited');
  r = v('entity a (k key, b (c))');
  has(r, 'composite-single', null, 'validate: composite attribute with one component');
  r = v('entity a (k key)\nentity b (j key)\nrelationship r (a, b) with (w key)');
  has(r, 'key-on-relationship', null, 'validate: key on a relationship attribute');
  ok(r.find((x) => x.code === 'key-on-relationship').loc.line === 3, 'validate: messages carry the source line');
  r = v('entity a (k key, d derived from nothing)');
  has(r, 'derived-source', null, 'validate: derived from an unknown attribute');
}

// ---- design checker -------------------------------------------------------------------------------------------
{
  const ck = (src) => ER.check(ER.parse(src));
  let r = ck('entity company (company_name key, founded)\nentity production (prod_id key, title, company_name)');
  let x = has(r, 'fk-attribute', /'company_name' of 'production' looks like a foreign key to 'company'/, 'check: foreign key modelled as an attribute');
  ok(x && /relationship/.test(x.explanation), 'check: explanation given');
  r = ck('entity company (company_name key, founded)\nentity production (prod_id key, title, company_name)\nrelationship staged_by (production [1..1], company)');
  has(r, 'redundant-attribute', /repeats the key of 'company', which production is already related to/, 'check: redundant attribute');
  r = ck('entity venue (venue_code key)\nentity production (prod_id key, venue)');
  has(r, 'attribute-is-entity', /names entity set 'venue'/, 'check: attribute that should be a relationship');
  r = ck('entity a (x, y)\nentity b (k key)');
  has(r, 'missing-key', null, 'check: missing key');
  r = ck('entity venue (venue_code key)\nweak entity stage (stage_id partial)\nidentifying relationship vs (stage, venue)');
  x = has(r, 'weak-could-be-strong', /looks like an identifier/, 'check: weak entity that could be strong');
  ok(x && /strong entity set/.test(x.explanation), 'check: weak entity explanation');
  r = ck('entity person (pid key)\nweak entity passport (pno partial)\nidentifying relationship holder (passport, person [0..1])');
  has(r, 'weak-one-to-one', null, 'check: weak entity with a one-to-one identifying relationship');
  r = ck('entity editor (eid key)\nentity writer (wid key)\nentity magazine (mid key)\nrelationship commission (editor, writer, magazine)\nrelationship mentors (editor, writer)');
  has(r, 'ternary-overlaps-binary', /overlaps binary relationship mentors/, 'check: ternary relationship next to a binary one');
  r = ck('entity patron (pid key)\nentity production (prod_id key)\nentity stage (sid key)\nrelationship attended (patron, production) with (night)\nrelationship played_on (production, stage) with (night)');
  has(r, 'binaries-could-be-ternary', /both record night/, 'check: binary relationships that may be one ternary');
  r = ck('entity a (x key)\nentity b (y key)\nentity c (z key)\nrelationship r (a one, b one, c)');
  has(r, 'ternary-arrows', null, 'check: ternary relationship with two arrows');
  r = ck('entity person (pid key, {phone (number, kind)})');
  has(r, 'attribute-could-be-entity', null, 'check: multivalued composite attribute');
  r = ck('entity patron (pid key)\nentity performance (perf_id key)\nentity booking (booking_id key, seat)\nrelationship b1 (booking [1..1], patron)\nrelationship b2 (booking [1..1], performance)');
  has(r, 'entity-could-be-relationship', /only connects patron and performance/, 'check: entity set that is a relationship in disguise');
  r = ck('entity a (x key)\nentity b (y key)\nrelationship r (a [0..1], b) with (since)');
  has(r, 'attribute-on-many-side', null, 'check: attribute of a many-to-one relationship');
  eq(ER.check(ER.parse(THEATRE)).map((c) => c.code), [], 'check: the theatre design gets no advice');
}

// ---- reduction to relational schemas: one rule at a time --------------------------------------------------------
{
  const m = ER.parse(THEATRE);
  const res = ER.toRelational(m);
  const rules = stepRules(res);
  for (const r of ['strong-entity', 'composite-attribute', 'multivalued-attribute', 'derived-attribute', 'weak-entity', 'identifying-relationship', 'relationship-many-to-many', 'relationship-many-to-one', 'relationship-n-ary', 'specialization-per-entity'])
    ok(rules.includes(r), 'reduce: the theatre design uses rule ' + r);
  ok(res.steps.every((s) => s.title && s.reason), 'reduce: every step has a title and a reason');
  const t = (n) => tableOf(res, n);
  eq(res.tables.map((x) => x.name).sort(), ['artist', 'artist_skill', 'attends', 'belongs_to', 'company', 'crew', 'patron', 'patron_email', 'person', 'production', 'scheduled', 'season', 'stage', 'venue', 'venue_phone'], 'reduce: theatre tables');
  eq(t('venue').columns.map((c) => c.name), ['venue_code', 'venue_name', 'street', 'city', 'postcode'], 'reduce: composite flattened, multivalued left out');
  eq(t('person').columns.map((c) => c.name), ['person_id', 'given', 'family', 'birth_date'], 'reduce: derived attribute left out');
  eq(t('production').columns.map((c) => c.name), ['prod_id', 'title', 'opening', 'company_id'], 'reduce: derived left out, staged_by merged into production');
  eq(t('venue_phone').primaryKey, ['venue_code', 'phone'], 'reduce: multivalued attribute table key');
  eq(t('venue_phone').foreignKeys[0].onDelete, 'cascade', 'reduce: multivalued values cascade');
  eq(t('artist_skill').foreignKeys[0].references, 'artist', 'reduce: multivalued attribute of a lower-level entity set refers to its table');
  eq(t('stage').primaryKey, ['venue_code', 'stage_no'], 'reduce: weak entity key = owner key + discriminator');
  eq([t('stage').foreignKeys[0].references, t('stage').foreignKeys[0].onDelete], ['venue', 'cascade'], 'reduce: weak entity cascades from its owner');
  ok(!tableOf(res, 'has_stage'), 'reduce: no table for the identifying relationship');
  eq(t('attends').primaryKey, ['patron_id', 'prod_id'], 'reduce: M:N key = union of participant keys');
  eq(t('attends').columns.map((c) => c.name).slice(-1), ['rating'], 'reduce: descriptive attribute in the M:N table');
  eq(t('scheduled').primaryKey, ['prod_id', 'venue_code', 'stage_no', 'season_year'], 'reduce: ternary key = all participant keys, the weak one with its owner\'s');
  eq(t('scheduled').foreignKeys.map((f) => f.references), ['production', 'stage', 'season'], 'reduce: ternary refers to each participant');
  const co = t('artist').foreignKeys.find((f) => f.references === 'artist');
  eq([co.columns, co.onDelete], [['coach_person_id'], 'set null'], 'reduce: recursive many-to-one merged, its column named from the role');
  eq([t('artist').primaryKey, t('artist').foreignKeys.find((f) => f.references === 'person').onDelete], [['person_id'], 'cascade'], 'reduce: lower-level entity set keyed by the higher-level key');
  const ci = t('production').columns.find((c) => c.name === 'company_id');
  eq([ci.notNull, t('production').foreignKeys.find((f) => f.references === 'company').onDelete], [true, 'restrict'], 'reduce: total participation gives NOT NULL and on delete restrict');
  const rn = t('crew').foreignKeys.find((f) => f.references === 'stage');
  eq([rn.columns, rn.onDelete, t('crew').columns.find((c) => c.name === 'stage_no').notNull], [['venue_code', 'stage_no'], 'set null', false], 'reduce: partial many-to-one merged, nullable, on delete set null');
  ok(/create table production \(/.test(res.ddl) && /primary key \(prod_id\)/.test(res.ddl), 'reduce: DDL text');
  const s = run(res.ddl);
  eq(s.catalog.tables().length, res.tables.length, 'reduce: theatre DDL runs on Kwery');
  // the constraints work
  s.exec("insert into company values (1, 'Lantern Players', 1998)");
  throws(() => s.exec("insert into production (prod_id, title) values (10, 'Tidewater')"), /null value|not-null|violates/i, 'kwery: NOT NULL from total participation');
  s.exec("insert into production (prod_id, title, company_id) values (10, 'Tidewater', 1)");
  throws(() => s.exec('delete from company where company_id = 1'), /foreign key|violates|restrict/i, 'kwery: restrict on the one side of a total participation');
  s.exec("insert into venue values ('RVS', 'Riverside', '2 Quay Street', 'Easton', 'E1 4QS'); insert into stage values ('RVS', 1, 420, 'proscenium'), ('RVS', 2, 90, 'studio')");
  s.exec("insert into person values (7, 'Dara', 'Quinn', null); insert into crew values (7, 'lighting', 240.00, 'RVS', 2)");
  s.exec("delete from venue where venue_code = 'RVS'");
  eq(value(s, 'select count(*) from stage'), '0', 'kwery: weak entity rows cascade with their owner');
  eq(value(s, 'select count(*) from crew where venue_code is null and stage_no is null'), '1', 'kwery: set null keeps the crew member when the stage goes');
  // a schema text in the chapter's notation
  ok(/^stage \(_venue_code_, _stage_no_, seats, stage_kind\)$/m.test(ER.schemaText(res)), 'reduce: schema text');
  const withComments = ER.toRelational(m, { comments: true }).ddl;
  ok(/-- weak stage\n--   venue_code -> venue: a stage exists only with its venue/.test(withComments), 'reduce: DDL comments explain the foreign keys', withComments.slice(0, 400));
  run(withComments);
  // total participation on the many side of a many-to-many relationship cannot be a foreign key
  const cast = ER.toRelational(ER.parse('entity play (play_id integer key)\nentity actor (actor_id integer key)\nrelationship cast_in (play [1..*] total, actor [0..*])'));
  ok(cast.steps.some((s) => s.rule === 'unenforced' && /total participation of play in cast_in/.test(s.reason)), 'reduce: unenforceable total participation explained');
  throws(() => ER.toRelational(ER.parse('entity a (x)')), /the model has errors: entity set 'a' has no key/, 'reduce: refuses an invalid model');
}
{
  // many-to-one kept separate: when combining is turned off, when nulls are to be avoided, for a multivalued attribute
  const src = 'entity a (k integer key)\nentity b (j integer key)\nrelationship r (a [0..1], b) with (since date)';
  let res = ER.toRelational(ER.parse(src), { avoidNulls: true });
  ok(stepRules(res).includes('relationship-many-to-one-separate') && /participation of a is partial/.test(res.steps.find((s) => s.rule === 'relationship-many-to-one-separate').reason), 'reduce: avoidNulls keeps a partial many-to-one separate, with the reason');
  eq(tableOf(res, 'r').primaryKey, ['k'], 'reduce: separate many-to-one table keyed by the many side');
  res = ER.toRelational(ER.parse(src), { mergeManyToOne: false });
  ok(/option mergeManyToOne: false/.test(res.steps.find((s) => s.rule === 'relationship-many-to-one-separate').reason), 'reduce: mergeManyToOne false');
  res = ER.toRelational(ER.parse(src));
  eq(tableOf(res, 'a').columns.map((c) => c.name), ['k', 'j', 'since'], 'reduce: merged many-to-one takes its descriptive attributes along');
  res = ER.toRelational(ER.parse('entity a (k integer key)\nentity b (j integer key)\nrelationship r (a [0..1], b) with ({tag})'));
  ok(/multivalued attribute/.test(res.steps.find((s) => s.rule === 'relationship-many-to-one-separate').reason), 'reduce: many-to-one with a multivalued attribute stays separate');
  ok(tableOf(res, 'r_tag'), 'reduce: multivalued attribute of a relationship gets its own table');
  run(res.ddl);
}
{
  // one-to-one
  const src = 'entity company (company_id varchar(6) key)\nentity person (person_id varchar(5) key)\nrelationship directed_by (company [1..1] total, person [0..1])';
  let res = ER.toRelational(ER.parse(src));
  const d = tableOf(res, 'company');
  ok(stepRules(res).includes('relationship-one-to-one'), 'reduce: one-to-one rule');
  eq([d.columns.map((c) => c.name), d.uniques, d.columns[1].notNull], [['company_id', 'person_id'], [['person_id']], true], 'reduce: one-to-one merged into the total side, UNIQUE and NOT NULL');
  const s = run(res.ddl);
  s.exec("insert into person values ('1'); insert into company values ('LP', '1')");
  throws(() => s.exec("insert into company values ('NW', '1')"), /unique|duplicate/i, 'kwery: UNIQUE enforces one-to-one');
  res = ER.toRelational(ER.parse(src), { oneToOne: 'separate' });
  eq([tableOf(res, 'directed_by').primaryKey, tableOf(res, 'directed_by').uniques], [['company_id'], [['person_id']]], 'reduce: separate one-to-one table, other key UNIQUE');
  res = ER.toRelational(ER.parse('entity a (k key)\nentity b (j key)\nrelationship r (a [0..1], b [0..1])'));
  ok(/neither side is total/.test(res.steps.find((s) => s.rule === 'relationship-one-to-one').reason) && !tableOf(res, 'a').columns[1].notNull, 'reduce: one-to-one with no total side is nullable');
}
{
  // n-ary relationships with and without an arrow
  const src = 'entity editor (id key)\nentity writer (id key)\nentity magazine (mid key)\nrelationship commission (editor, writer, magazine)\nrelationship assigned (editor one, writer, magazine)';
  const res = ER.toRelational(ER.parse(src));
  eq(tableOf(res, 'commission').primaryKey, ['editor_id', 'writer_id', 'mid'], 'reduce: ternary key = all participant keys (clashing names prefixed)');
  eq(tableOf(res, 'assigned').primaryKey, ['writer_id', 'mid'], 'reduce: ternary with an arrow: key without the arrowed participant');
  ok(stepRules(res).filter((r) => r === 'relationship-n-ary').length === 2, 'reduce: n-ary rule');
  run(res.ddl);
}
{
  // specialization by the three methods
  const src = 'entity vehicle (plate varchar(8) key, make varchar(30))\nentity truck (payload numeric(8,2))\nentity coach (seats integer)\nisa vehicle (truck, coach) disjoint total';
  let res = ER.toRelational(ER.parse(src));
  eq(res.tables.map((t) => t.name), ['vehicle', 'truck', 'coach'], 'reduce: specialization, first method: a table per entity set');
  eq([tableOf(res, 'truck').columns.map((c) => c.name), tableOf(res, 'truck').primaryKey, tableOf(res, 'truck').foreignKeys[0].references, tableOf(res, 'truck').foreignKeys[0].onDelete], [['plate', 'payload'], ['plate'], 'vehicle', 'cascade'], 'reduce: lower-level table has the higher-level key as primary and foreign key');
  ok(res.steps.some((s) => s.rule === 'unenforced' && /disjointness/.test(s.reason)), 'reduce: first method explains what is not enforced');
  res = ER.toRelational(ER.parse(src), { specialization: 'lower-only' });
  eq(res.tables.map((t) => [t.name, t.columns.map((c) => c.name)]), [['truck', ['plate', 'make', 'payload']], ['coach', ['plate', 'make', 'seats']]], 'reduce: second method: lower-level tables only, with inherited attributes');
  res = ER.toRelational(ER.parse(src), { specialization: 'single-table' });
  const p = tableOf(res, 'vehicle');
  eq([res.tables.length, p.columns.map((c) => c.name), p.checks.map((c) => c.expr)], [1, ['plate', 'make', 'payload', 'seats', 'vehicle_type'], ["vehicle_type in ('truck', 'coach')"]], 'reduce: single table with a type column');
  ok(p.columns.find((c) => c.name === 'vehicle_type').notNull, 'reduce: the type is NOT NULL for a total specialization');
  run(res.ddl);
  // overlapping specialization in a single table: one flag per lower-level set
  res = ER.toRelational(ER.parse(src.replace('disjoint total', 'overlapping total')), { specialization: 'single-table' });
  eq(tableOf(res, 'vehicle').columns.slice(-2).map((c) => [c.name, c.type, c.default]), [['is_truck', 'boolean', 'false'], ['is_coach', 'boolean', 'false']], 'reduce: overlapping single table: boolean flags');
  eq(tableOf(res, 'vehicle').checks[0].expr, 'is_truck or is_coach', 'reduce: total overlapping single table: at least one flag');
  run(res.ddl);
  // the second method does not apply: falls back with a reason
  res = ER.toRelational(ER.parse(src.replace('disjoint total', 'overlapping partial')), { specialization: 'lower-only' });
  ok(/needs a total, disjoint specialization/.test(res.steps.find((s) => s.rule === 'specialization-fallback').reason), 'reduce: second method refused for an overlapping partial specialization');
  res = ER.toRelational(ER.parse(src + '\nentity depot (d key)\nrelationship kept_at (vehicle [0..1], depot)'), { specialization: { vehicle: 'lower-only' } });
  ok(/takes part in relationships/.test(res.steps.find((s) => s.rule === 'specialization-fallback').reason), 'reduce: second method refused when the higher-level set is referenced');
  // multiple inheritance
  res = ER.toRelational(ER.parse(src + '\nentity tour_coach (berths integer)\nisa truck (tour_coach)\nisa coach (tour_coach)'));
  eq(tableOf(res, 'tour_coach').foreignKeys.map((f) => f.references), ['truck', 'coach'], 'reduce: multiple inheritance refers to both parents');
  run(res.ddl);
}
{
  // aggregation
  const src = 'entity editor (eid varchar(5) key)\nentity writer (wid varchar(5) key)\nentity magazine (mid integer key)\nrelationship commission (editor, writer, magazine)\naggregation commissioned of commission\nentity invoice (inv_no integer key, amount integer)\nrelationship billed_for (invoice [1..1] total, commissioned [0..*])';
  const res = ER.toRelational(ER.parse(src));
  ok(stepRules(res).includes('aggregation'), 'reduce: aggregation rule');
  const iv = tableOf(res, 'invoice');
  eq([iv.foreignKeys[0].references, iv.foreignKeys[0].columns], ['commission', ['eid', 'wid', 'mid']], 'reduce: relationship with an aggregation refers to the aggregated relationship table');
  run(res.ddl);
  // aggregation on the many side of a many-to-one keeps its own table
  const res2 = ER.toRelational(ER.parse(src.replace('billed_for (invoice [1..1] total, commissioned [0..*])', 'billed_for (commissioned [0..1], invoice [0..*])')));
  ok(/many side is aggregation commissioned/.test(res2.steps.find((s) => s.rule === 'relationship-many-to-one-separate').reason), 'reduce: aggregation as the many side');
  run(res2.ddl);
}
{
  // a cycle of foreign keys becomes ALTER TABLE; reserved words are quoted
  const src = 'entity "user" (id integer key, "order" integer)\nentity "group" (gid integer key)\nrelationship r1 ("user" [0..1], "group")\nrelationship r2 ("group" [0..1], "user")';
  const res = ER.toRelational(ER.parse(src));
  ok(/alter table .* add foreign key/.test(res.ddl), 'reduce: cyclic foreign keys added with alter table', res.ddl);
  ok(/create table "user"/.test(res.ddl) && /"order" integer/.test(res.ddl), 'reduce: reserved words quoted');
  run(res.ddl);
}

// ---- generated DDL on every exercise runs on Kwery ---------------------------------------------------------------
const allDDL = [];
for (const ex of ER.exercises) for (const spec of ['per-entity', 'lower-only', 'single-table']) {
  let res;
  try { res = ER.toRelational(ex.model(), { specialization: spec }); } catch (e) { ok(false, 'reduce ' + ex.id + ' ' + spec, e.message); continue; }
  allDDL.push([ex.id + '/' + spec, res.ddl]);
  try { const s = run(res.ddl); ok(s.catalog.tables().length === res.tables.length, 'kwery: ' + ex.id + ' (' + spec + ')'); } catch (e) { ok(false, 'kwery: ' + ex.id + ' (' + spec + ')', e.message + '\n' + res.ddl); }
}
allDDL.push(['theatre', ER.toRelational(ER.parse(THEATRE)).ddl]);

// ---- and on PostgreSQL 17, through its Unix socket only ------------------------------------------------------------
{
  const PSQL = '/opt/homebrew/opt/postgresql@17/bin/psql';
  const args = ['-h', '/Users/jmishra/.kwery-pg/sock', '-p', '5544', '-X', '-q', '-v', 'ON_ERROR_STOP=1'];
  const dbn = 'kwery_er_test_' + process.pid;
  let up = false;
  try { execFileSync(PSQL, [...args, '-d', 'postgres', '-Atc', 'select 1'], { stdio: 'pipe' }); up = true; } catch (e) { /* not available */ }
  if (!up) { skip++; console.log('SKIP PostgreSQL 17 is not reachable on /Users/jmishra/.kwery-pg/sock'); }
  else {
    execFileSync(PSQL, [...args, '-d', 'postgres', '-c', 'create database ' + dbn], { stdio: 'pipe' });
    try {
      allDDL.forEach(([name, ddl], i) => {
        const script = 'create schema s' + i + '; set search_path = s' + i + ';\n' + ddl + '\nset search_path = public; drop schema s' + i + ' cascade;\n';
        try { execFileSync(PSQL, [...args, '-d', dbn], { input: script, stdio: ['pipe', 'pipe', 'pipe'] }); ok(true, 'pg: ' + name); }
        catch (e) { ok(false, 'pg: ' + name, String(e.stderr) + '\n' + ddl); }
      });
    } finally { execFileSync(PSQL, [...args, '-d', 'postgres', '-c', 'drop database if exists ' + dbn], { stdio: 'pipe' }); }
  }
}

// ---- reverse engineering of the Theatre schema ------------------------------------------------------------------
{
  const s = fresh();
  s.exec(fs.readFileSync(path.join(root, 'src/data/theatre.sql'), 'utf8'));
  // the sample declares every foreign key; a rehearsal timetable adds an undeclared reference to a table whose key is
  // longer than the referencing column (the shape a dropped multivalued attribute leaves behind)
  s.exec(`create table rehearsal_slot (slot_id varchar(4), day varchar(1), start_hr integer, start_min integer, end_hr integer, end_min integer, primary key (slot_id, day, start_hr, start_min));
    create table rehearsal (rehearsal_id integer primary key, prod_id varchar(6) not null references production, slot_id varchar(4));`);
  const r = ER.fromCatalog(s.catalog);
  const m = r.model;
  eq(m.entities.map((e) => e.name).sort(), ['artist', 'booking', 'casting', 'company', 'patron', 'performance', 'person', 'production', 'rehearsal', 'rehearsal_slot', 'stage', 'venue'], 'reverse: the entity sets of the Theatre database');
  const st = ER.entity(m, 'stage');
  eq([st.weak, ER.owner(m, st), ER.leaves(st.attributes).filter((l) => l.partial).map((l) => l.name)], [true, 'venue', ['stage_no']], 'reverse: stage is weak, owned by venue, discriminator stage_no');
  ok(r.notes.some((n) => n.kind === 'weak' && /stage/.test(n.message) && /discriminator/.test(n.message) && /option weak: strong/.test(n.message)), 'reverse: the weak entity choice is explained');
  ok(ER.relationship(m, 'stage_venue').identifying, 'reverse: identifying relationship rebuilt');
  // casting's key adds role_name to the two foreign keys, so it is an entity set of its own, weak on artist
  const ca = ER.entity(m, 'casting');
  eq([ca.weak, ER.owner(m, ca), ER.leaves(ca.attributes).filter((l) => l.partial).map((l) => l.name)], [true, 'artist', ['prod_id', 'role_name']], 'reverse: casting is weak, owned by artist');
  // mentor: a many-to-many relationship of artist with itself, roles from the column names, since descriptive
  const me = ER.relationship(m, 'mentor');
  eq([ER.mapping(me), me.participants.map((p) => p.entity + ' as ' + p.role), me.attributes.map((a) => a.name)], ['M:N', ['artist as mentor_id', 'artist as mentee_id'], ['since']], 'reverse: mentor recursive many-to-many with roles and descriptive attribute since');
  // based_on: a recursive many-to-one
  const bo = m.relationships.find((x) => x.participants.length === 2 && x.participants.every((p) => p.entity === 'production'));
  ok(bo && ER.mapping(bo) === 'N:1' && bo.participants.some((p) => p.role === 'based_on'), 'reverse: based_on recursive many-to-one with a role');
  // booking has its own key: an entity set joining patron and performance, many-to-one to each
  const rel = (a, b) => m.relationships.find((x) => x.participants.length === 2 && x.participants.map((p) => p.entity).sort().join() === [a, b].sort().join());
  for (const [a, b] of [['booking', 'patron'], ['booking', 'performance'], ['performance', 'production'], ['performance', 'stage'], ['production', 'company'], ['artist', 'company'], ['casting', 'production']]) {
    const x = rel(a, b);
    ok(x && ER.mapping(x) !== 'M:N' && x.participants.find((p) => p.entity === a).max === 1, 'reverse: ' + a + ' many-to-one ' + b);
  }
  eq(ER.keyOf(m, 'booking'), ['booking_id'], 'reverse: booking keeps its own key');
  ok(!ER.entity(m, 'production').attributes.some((a) => a.name === 'company_id'), 'reverse: the production-company foreign key is a relationship, not attribute company_id');
  ok(rel('performance', 'stage').participants.find((p) => p.entity === 'performance').total, 'reverse: a composite NOT NULL foreign key guesses total participation');
  eq(m.specializations.map((x) => [x.parent, x.children]), [['person', ['artist']]], 'reverse: artist is a specialization of person');
  ok(r.notes.some((n) => n.kind === 'implicit' && /slot_id/.test(n.message) && n.guess), 'reverse: undeclared reference to rehearsal_slot is a marked guess');
  const rs = ER.entity(m, 'rehearsal_slot');
  eq([ER.keyOf(m, 'rehearsal_slot'), rs.attributes[1].multivalued, rs.attributes[1].components.map((c) => c.name)], [['slot_id'], true, ['day', 'start_hr', 'start_min', 'end_hr', 'end_min']], 'reverse: rehearsal_slot with a multivalued composite attribute');
  ok(m.relationships.every((x) => x.participants.every((p) => p.guess || x.identifying && p.max === 1)), 'reverse: participation marked as a guess');
  ok(r.lost.length >= 6 && r.lost.some((l) => /derived attributes/.test(l)) && r.lost.some((l) => /participation/.test(l)), 'reverse: list of what cannot be recovered');
  ok(r.notes.some((n) => n.kind === 'check'), 'reverse: check constraints noted as outside the model');
  eq(ER.errors(m), [], 'reverse: the result is a valid model');
  eq(r.tables.mentor, 'relationship mentor (many-to-many)', 'reverse: table summary');
  // option: stage as a strong entity set
  const r2 = ER.fromCatalog(s.catalog, { weak: 'strong' });
  ok(!ER.entity(r2.model, 'stage').weak && ER.keyOf(r2.model, 'stage').length === 2, 'reverse: weak: strong option');
  const r3 = ER.fromCatalog(s, { inferImplicit: false });
  ok(!r3.model.relationships.some((x) => x.participants.some((p) => p.entity === 'rehearsal_slot')), 'reverse: inferImplicit false, and a session is accepted');
  // the Theatre model read back reduces to tables again
  run(ER.toRelational(m).ddl);
}
{
  // other shapes: one-to-one from UNIQUE, specialization, multivalued side table, aggregation, ternary with an arrow
  const s = run(`
    create table person (id integer primary key, name text);
    create table crew (id integer primary key references person (id) on delete cascade, wage numeric(8,2));
    create table badge (bno integer primary key, holder integer not null unique references person (id));
    create table person_phone (id integer references person (id) on delete cascade, phone varchar(20), primary key (id, phone));
    create table tour (pid integer primary key);
    create table touring (eid integer references crew (id), pid integer references tour (pid), primary key (eid, pid));
    create table review (rid integer primary key, eid integer not null, pid integer not null, foreign key (eid, pid) references touring (eid, pid));
    create table shift (eid integer references crew (id), pid integer references tour (pid), day date, room integer references badge (bno), primary key (eid, pid, day));
    create table slot (a integer references tour (pid), b integer references badge (bno), c integer not null references person (id), primary key (a, b));
  `);
  const r = ER.fromCatalog(s.catalog);
  const m = r.model;
  eq(m.specializations.map((x) => [x.parent, x.children]), [['person', ['crew']]], 'reverse: specialization from a primary key that is a foreign key');
  const b = m.relationships.find((x) => x.participants.some((p) => p.entity === 'badge') && x.participants.some((p) => p.entity === 'person') && x.participants.length === 2);
  eq([ER.mapping(b), b.participants[0].total], ['1:1', true], 'reverse: one-to-one from a UNIQUE foreign key, total guessed from NOT NULL');
  ok(ER.entity(m, 'person').attributes.some((a) => a.name === 'phone' && a.multivalued), 'reverse: multivalued attribute from a side table');
  eq(m.aggregations.map((a) => a.relationship), ['touring'], 'reverse: a referenced relationship table is an aggregation');
  ok(m.relationships.some((x) => x.participants.some((p) => p.entity === 'touring_agg')), 'reverse: the referencing table relates to the aggregation');
  ok(ER.entity(m, 'shift') && ER.entity(m, 'shift').weak, 'reverse: primary key with a foreign key and more columns is a weak entity set');
  const slot = ER.relationship(m, 'slot');
  eq(slot.participants.map((p) => p.entity + (p.arrow ? '>' : '')), ['tour', 'badge', 'person>'], 'reverse: ternary with the third foreign key outside the key is an arrow');
  eq(ER.errors(m), [], 'reverse: valid model');
}

// ---- round trips: model -> SQL -> Kwery -> catalog -> model, equal up to the documented losses -----------------------
{
  // what the tables cannot carry (see the lost list of fromCatalog)
  const LOSSES = new Set(['participation', 'disjointness', 'completeness', 'range']);
  for (const ex of ER.exercises) {
    const m = ex.model();
    const res = ER.toRelational(m);
    const s = run(res.ddl);
    const back = ER.fromCatalog(s.catalog).model;
    const c = ER.compare(back, m);
    const derived = new Set(ER.exercises.length && m.entities.flatMap((e) => ER.leaves(e.attributes).filter((l) => l.derived).map((l) => l.name)));
    const bad = c.feedback.filter((f) => (f.level === 'error' || f.level === 'warning') && !LOSSES.has(f.code) && !(f.code === 'missing-attribute' && derived.has(f.at.attribute)));
    ok(!bad.length, 'round trip: ' + ex.id, bad.map((f) => f.code + ': ' + f.message).join('\n  '));
  }
  // the theatre design, with composite attributes flattened and the derived ones gone
  const m = ER.parse(THEATRE);
  const back = ER.fromCatalog(run(ER.toRelational(m).ddl).catalog).model;
  const c = ER.compare(back, m);
  // the roles of the recursive coaches relationship do not survive (the column gives one of them, coach_person_id);
  // the comparison pairs the two artist participants by their cardinalities instead
  const rec = back.relationships.find((x) => x.participants.length === 2 && x.participants.every((p) => p.entity === 'artist'));
  eq(rec && rec.participants.map((p) => p.role + ' ' + p.min + '..' + p.max), ['artist 0..1', 'coach_person_id 0..*'], 'round trip: recursive many-to-one comes back with a role from its column');
  const errs = c.feedback.filter((f) => f.level === 'error');
  eq(errs.map((f) => f.code + ' ' + f.at.attribute).sort(), ['missing-attribute age', 'missing-attribute weeks_open'], 'round trip: theatre (only the derived attributes lost)');
  ok(c.feedback.filter((f) => f.code === 'flattened').length === 2, 'round trip: theatre composites come back flattened');
  eq(back.specializations.map((x) => [x.parent, x.children]), [['person', ['artist', 'crew']]], 'round trip: the specialization comes back');
  // reduction is stable: reducing the recovered model gives the same tables
  const t1 = ER.toRelational(ER.parse('entity a (k integer key, n text)\nentity b (j integer key)\nrelationship r (a, b) with (w integer)\nweak entity c (d integer partial, note text)\nidentifying relationship ca (c, a)'));
  const t2 = ER.toRelational(ER.fromCatalog(run(t1.ddl).catalog).model);
  eq(t2.tables.map((t) => [t.name, t.columns.map((x) => x.name), t.primaryKey]).sort(), t1.tables.map((t) => [t.name, t.columns.map((x) => x.name), t.primaryKey]).sort(), 'round trip: tables reproduced exactly');
}

// ---- layout ------------------------------------------------------------------------------------------------------
const notations = ['chen', 'textbook', 'crowsfoot'];
const theatreModel = ER.parse(THEATRE);
const aggModel = ER.parse('entity editor (eid key, name)\nentity writer (wid key, name)\nentity magazine (mid key, title)\nrelationship commission (editor, writer, magazine)\naggregation commissioned of commission\nentity invoice (inv_no key, amount)\nrelationship billed_for (invoice [1..1] total, commissioned)\nentity vehicle (plate key, make)\nentity truck (payload)\nentity camper (berths)\nisa vehicle (truck, camper) overlapping partial\nisa vehicle (hearse) disjoint total\nentity hearse (length)');
{
  const models = [['theatre', theatreModel], ['aggregation', aggModel]].concat(ER.exercises.map((x) => [x.id, x.model()]));
  for (const [name, m] of models) for (const n of notations) {
    const L = ER.layout(m, n);
    const o = ER.layoutOverlaps(L);
    ok(!o.length, 'layout: no overlaps, ' + name + ' (' + n + ')', o);
    ok(L.nodes.every((x) => [x.x, x.y, x.w, x.h].every(Number.isFinite) && x.x >= 0 && x.y >= 0 && x.x + x.w <= L.width && x.y + x.h <= L.height), 'layout: nodes inside the canvas, ' + name + ' (' + n + ')');
    ok(L.edges.every((e) => e.points.length >= 2 && e.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))), 'layout: routed edges, ' + name + ' (' + n + ')');
  }
  const ch = ER.layout(theatreModel, 'chen');
  ok(ch.nodes.filter((x) => x.kind === 'attribute').length === 35, 'layout chen: attribute ovals, components included', ch.nodes.filter((x) => x.kind === 'attribute').length);
  ok(ch.nodes.find((x) => x.id === 'e:stage').weak && ch.nodes.find((x) => x.id === 'r:has_stage').identifying, 'layout chen: weak entity and identifying relationship flagged');
  const e1 = ch.edges.find((e) => e.relationship === 'runs' && e.entity === 'stage');
  const e2 = ch.edges.find((e) => e.relationship === 'runs' && e.entity === 'crew');
  eq([e1.arrow, e1.card, e2.arrow, e2.card], [true, '1', false, 'M'], 'layout chen: arrow and 1/M labels for runs');
  ok(ch.edges.find((e) => e.relationship === 'has_stage' && e.entity === 'stage').double, 'layout: double line for total participation');
  ok(ch.nodes.find((x) => x.name === 'phone').multivalued && ch.nodes.find((x) => x.name === 'age').derived && ch.nodes.find((x) => x.name === 'stage_no').partial, 'layout chen: attribute kinds');
  { const [a, b] = ch.edges.filter((e) => e.relationship === 'coaches').map((e) => e.points); ok(a && b && JSON.stringify(a) !== JSON.stringify(b) && (a.length > 2 || b.length > 2) && !(a[0].x === b[0].x && a[0].y === b[0].y), 'layout: the two lines of a recursive relationship take separate paths'); }
  const tb = ER.layout(theatreModel, 'textbook');
  ok(!tb.nodes.some((x) => x.kind === 'attribute') && tb.nodes.find((x) => x.id === 'e:venue').lines.length === 7, 'layout boxed: attributes listed in the rectangle', tb.nodes.find((x) => x.id === 'e:venue').lines);
  eq(tb.edges.find((e) => e.relationship === 'staged_by' && e.entity === 'production').label.text, '1..1', 'layout boxed: min..max label');
  ok(tb.nodes.some((x) => x.kind === 'relattrs' && x.owner === 'r:attends'), 'layout boxed: descriptive attributes box');
  ok(tb.edges.some((e) => e.kind === 'relattrs' && e.dashed), 'layout boxed: dashed line to the descriptive attributes');
  const cf = ER.layout(theatreModel, 'crowsfoot');
  const rn = cf.edges.find((e) => e.relationship === 'runs');
  eq([rn.kind, rn.from, rn.markers], ['relationship-line', 'e:crew', { from: 'zero-or-many', to: 'zero-or-one' }], 'layout crowsfoot: runs as a line with ends');
  ok(cf.nodes.some((x) => x.kind === 'associative' && x.name === 'attends'), 'layout crowsfoot: relationship with attributes as an associative entity');
  const sb = cf.edges.find((e) => e.relationship === 'staged_by');
  eq(sb.markers, { from: 'zero-or-many', to: 'one-only' }, 'layout crowsfoot: total many-to-one ends');
  ok(cf.edges.find((e) => e.relationship === 'has_stage').dashed === false && sb.dashed === true, 'layout crowsfoot: identifying solid, others dashed');
  const ag = ER.layout(aggModel, 'textbook');
  eq(ag.groups.map((g) => g.name), ['commissioned'], 'layout: aggregation group');
  ok(ag.groups[0].members.includes('r:commission') && ag.groups[0].members.includes('e:magazine'), 'layout: aggregation contains its relationship and participants');
  ok(ag.edges.some((e) => e.to === 'a:commissioned'), 'layout: relationship with the aggregation attaches to the group');
  ok(ag.edges.some((e) => e.kind === 'isa' && e.arrowHead === 'hollow'), 'layout boxed: overlapping specialization as separate hollow arrows');
  ok(ag.edges.some((e) => e.kind === 'isa-parent' && e.arrowHead === 'hollow'), 'layout boxed: disjoint specialization joins into one arrow');
  ok(ER.layout(aggModel, 'chen').nodes.some((x) => x.kind === 'isa' && x.shape === 'triangle' && x.caption === 'overlapping'), 'layout chen: ISA triangle with caption');
  eq(ER.layout({ entities: [] }, 'chen').nodes, [], 'layout: empty model');
  eq(ER.notation('7e'), 'textbook', 'notation aliases');
}

// ---- SVG ---------------------------------------------------------------------------------------------------------
function wellFormed(xml) {
  // a small XML well-formedness check: tags nest, attributes are quoted and unique, entity references are known
  const stack = [];
  let i = 0, roots = 0;
  const ent = /&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/iy;
  const textOk = (s) => { for (let j = 0; j < s.length; j++) { if (s[j] === '<') return false; if (s[j] === '&') { ent.lastIndex = j; if (!ent.test(s)) return false; } } return true; };
  xml = xml.replace(/^<\?xml[^>]*\?>/, '');
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    const txt = lt < 0 ? xml.slice(i) : xml.slice(i, lt);
    if (!textOk(txt)) return 'bad text near ' + i;
    if (txt.trim() && !stack.length) return 'text outside the root';
    if (lt < 0) break;
    if (xml.startsWith('<!--', lt)) { const e = xml.indexOf('-->', lt); if (e < 0) return 'open comment'; i = e + 3; continue; }
    const gt = xml.indexOf('>', lt);
    if (gt < 0) return 'unclosed tag';
    const tag = xml.slice(lt + 1, gt);
    if (tag.startsWith('/')) { const n = tag.slice(1).trim(); if (stack.pop() !== n) return 'mismatched </' + n + '>'; i = gt + 1; continue; }
    const self = tag.endsWith('/');
    const m = /^([A-Za-z_][\w:.-]*)([\s\S]*?)\/?$/.exec(tag);
    if (!m) return 'bad tag ' + tag.slice(0, 20);
    const seen = new Set();
    const re = /\s+([A-Za-z_][\w:.-]*)\s*=\s*("[^"<]*"|'[^'<]*')/y;
    let rest = m[2], k = 0;
    while (k < rest.length) {
      if (/^\s*$/.test(rest.slice(k))) break;
      re.lastIndex = k;
      const a = re.exec(rest);
      if (!a) return 'bad attribute in <' + m[1] + '>: ' + rest.slice(k, k + 30);
      if (seen.has(a[1])) return 'duplicate attribute ' + a[1];
      seen.add(a[1]);
      if (!textOk(a[2].slice(1, -1))) return 'bad attribute value';
      k = re.lastIndex;
    }
    if (!stack.length) { roots++; if (roots > 1) return 'two roots'; }
    if (!self) stack.push(m[1]);
    i = gt + 1;
  }
  return stack.length ? 'unclosed <' + stack[stack.length - 1] + '>' : roots === 1 ? true : 'no root';
}
{
  ok(wellFormed('<a x="1"><b/>t&amp;</a>') === true && wellFormed('<a><b></a>') !== true && wellFormed('<a x="1" x="2"/>') !== true && wellFormed('<a>&nope;</a>') !== true, 'xml checker sanity');
  const models = [['theatre', theatreModel], ['aggregation', aggModel]].concat(ER.exercises.slice(0, 25).map((x) => [x.id, x.model()]));
  for (const [name, m] of models) for (const n of notations) {
    const svg = ER.svg(m, ER.layout(m, n), n, { title: name });
    const w = wellFormed(svg);
    ok(w === true, 'svg: well-formed, ' + name + ' (' + n + ')', w);
    ok(!/href|<style|@import|url\(/.test(svg), 'svg: self-contained, ' + name + ' (' + n + ')');
  }
  const s = ER.svg(theatreModel, null, 'chen');
  ok(s.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'), 'svg: root element');
  ok(/<ellipse[^>]*stroke-dasharray/.test(s), 'svg chen: dashed oval for a derived attribute');
  ok(/stroke-dasharray="4 3"/.test(s), 'svg: dashed underline for a partial key');
  ok((s.match(/<rect /g) || []).length >= 9, 'svg chen: rectangles, double for the weak entity');
  ok(/<polygon/.test(s), 'svg: diamonds and arrowheads');
  const t = ER.svg(theatreModel, null, 'textbook');
  ok(/\{ phone : varchar\(20\) \}|\{ phone \}/.test(t) && /age \( \)/.test(t), 'svg boxed: multivalued in braces, derived with ( )');
  ok(/rx="6"/.test(t), 'svg: rounded rectangles');
  const c = ER.svg(theatreModel, null, 'crowsfoot');
  ok(/<circle/.test(c) && />PK</.test(c), 'svg crowsfoot: optional circles and PK tags');
  const nasty = ER.svg(ER.parse('entity "a&b<c>" (k key, "x\'y" text)'), null, 'textbook');
  ok(wellFormed(nasty) === true && /a&amp;b&lt;c&gt;/.test(nasty), 'svg: names are escaped');
  for (const n of notations) { const l = ER.svgLegend(n); ok(wellFormed(l) === true, 'legend: well-formed (' + n + ')', wellFormed(l)); }
  ok(/crow's|Crow&#39;s/.test(ER.svgLegend('crowsfoot')) && /zero or more/.test(ER.svgLegend('crowsfoot')), 'legend: crow\'s foot captions');
  ok(/double line/.test(ER.svgLegend('chen')) && /dashed underline/.test(ER.svgLegend('chen')), 'legend: Chen captions');
}

// ---- comparison with a reference ------------------------------------------------------------------------------------
{
  const fbOf = (r, code) => r.feedback.filter((f) => f.code === code);
  let r = ER.checkExercise('ensembles', 'entity resident (card_no key, name, phone, joined)\nentity troupe (ens_name key, formed, room, reg_no)\nentity musician (reg_no key, name, fee)\nrelationship member_of (resident, troupe) with (part)');
  ok(!r.correct && r.score < 90, 'compare: wrong design is not correct', r.score);
  ok(fbOf(r, 'renamed-entity').length === 1 && /'troupe' is taken to be 'ensemble'/.test(fbOf(r, 'renamed-entity')[0].message), 'compare: renamed entity set matched by attributes');
  ok(fbOf(r, 'attribute-belongs-to-relationship').length === 1 && /'joined' should be on relationship 'member_of'/.test(fbOf(r, 'attribute-belongs-to-relationship')[0].message), 'compare: M:N attribute on an entity');
  ok(fbOf(r, 'foreign-key-attribute').length === 1 && fbOf(r, 'relationship-as-attribute').length === 1, 'compare: relationship modelled as a foreign key attribute');
  r = ER.checkExercise('chess', ER.exercise('chess').reference.replace('birth_date date)', 'birth_date date, board_no integer)').replace(' with (board_no integer)', ''));
  ok(r.correct && fbOf(r, 'attribute-on-many-side').length === 1 && fbOf(r, 'attribute-on-many-side')[0].level === 'ok', 'compare: attribute of a 1:N relationship on the many side is accepted', r.feedback);
  r = ER.checkExercise('chess', ER.exercise('chess').reference.replace('supervises (game [1..1] total, arbiter [0..*])', 'supervises (game, arbiter)'));
  ok(fbOf(r, 'cardinality').length === 1 && /each game should go with at most one arbiter, but yours allows many/.test(fbOf(r, 'cardinality')[0].message), 'compare: cardinality difference explained');
  ok(fbOf(r, 'participation').length === 1, 'compare: participation difference');
  r = ER.checkExercise('timetable', 'entity teacher (teacher_code key, name)\nentity subject (subject_code key, title)\nentity class_group (group_name key, size)\nrelationship teaches (teacher, subject)\nrelationship takes (subject, class_group) with (hours)\nrelationship tutor (class_group [1..1] total, teacher [0..1])');
  ok(fbOf(r, 'ternary-as-binaries').length === 1 && /cannot say which combinations belong together/.test(fbOf(r, 'ternary-as-binaries')[0].message), 'compare: ternary replaced by binaries');
  r = ER.checkExercise('library', 'entity book (isbn key, title, pub_year, keyword)\nentity author (author_id key, name)\nentity copy (copy_no key, shelf, isbn)\nentity member (card_no key, name, street, city, postcode)\nrelationship wrote (author, book total)\nrelationship borrows (copy [0..1], member) with (date_out, due_date)');
  ok(fbOf(r, 'should-be-weak').length === 1 && fbOf(r, 'multivalued').length === 1 && fbOf(r, 'flattened').length === 1, 'compare: weak entity, multivalued, composite flattened', r.feedback.map((f) => f.code));
  r = ER.checkExercise('bikes', ER.exercise('bikes').reference.replace('isa bike (ebike, pedal_bike) disjoint total', 'isa bike (ebike, pedal_bike) overlapping total'));
  ok(fbOf(r, 'disjointness').length === 1, 'compare: specialization disjointness');
  r = ER.checkExercise('farm', ER.exercise('farm').reference.replace('aggregation planted of planting\n', '').replace('planted [0..*]', 'crop [0..*]'));
  ok(fbOf(r, 'missing-aggregation').length === 1, 'compare: missing aggregation');
  r = ER.checkExercise('ensembles', 'entity resident (');
  ok(r.parseError && r.feedback[0].code === 'parse', 'compare: parse error in an answer');
  r = ER.compare(ER.parse('entity Residents (Card_No key, Name, Phone)\nentity ensemble (ens_name key, formed, room)\nentity musician (reg_no key, name, fee)\nrelationship membership (Residents [0..*], ensemble [0..*]) with (joined, part)\nrelationship conducts (ensemble [1..1] total, musician [0..*])'), ER.exercise('ensembles').model());
  ok(r.correct && r.score === 100, 'compare: plural and case differences in names are accepted', r.feedback);
  // a recursive relationship: participants are paired by what they say, whatever the roles are called
  const recRef = ER.parse('entity runner (runner_id key, name)\nrelationship paces (runner as pacer [0..*], runner as paced [0..1])');
  r = ER.compare(ER.parse('entity runner (runner_id key, name)\nrelationship paces (runner as follower [0..1], runner as leader [0..*])'), recRef);
  eq(r.feedback.filter((f) => f.level === 'error').map((f) => f.code), [], 'compare: recursive relationship with other role names, in the other order, is correct');
  r = ER.compare(ER.parse('entity runner (runner_id key, name)\nrelationship paces (runner as follower [0..1], runner as leader [0..1])'), recRef);
  eq(r.feedback.filter((f) => f.level === 'error').map((f) => f.code), ['cardinality'], 'compare: recursive relationship with a wrong cardinality gives one error');
  r = ER.compare(ER.parse('entity runner (runner_id key, name)\nrelationship paces (runner as pacer [0..1], runner as paced [0..*])'), recRef);
  eq(r.feedback.filter((f) => f.level === 'error').map((f) => f.code), ['cardinality', 'cardinality'], 'compare: recursive relationship with the same role names but swapped cardinalities is wrong for both roles');
}

// ---- exercises -------------------------------------------------------------------------------------------------------
{
  eq(ER.exercises.length, 25, 'exercises: 25 problems');
  eq(new Set(ER.exercises.map((x) => x.id)).size, 25, 'exercises: unique ids');
  const domains = new Set(ER.exercises.map((x) => x.domain));
  ok(['community', 'pets', 'library', 'travel', 'shop', 'sports'].every((d) => domains.has(d)), 'exercises: the domains asked for');
  for (const ex of ER.exercises) {
    const m = ex.model();
    eq(ER.errors(m), [], 'exercise ' + ex.id + ': reference is valid');
    ok(ex.text.length > 150 && ex.hints.length >= 1, 'exercise ' + ex.id + ': statement and hints');
    const self = ER.compare(m, ex.model());
    ok(self.correct && self.score === 100, 'exercise ' + ex.id + ': reference matches itself');
  }
  const kinds = (pred) => ER.exercises.filter((x) => pred(x.model())).length;
  ok(kinds((m) => m.entities.some((e) => e.weak)) >= 8, 'exercises: weak entity sets');
  ok(kinds((m) => m.specializations.length) >= 5, 'exercises: specializations');
  ok(kinds((m) => m.aggregations.length) >= 2, 'exercises: aggregations');
  ok(kinds((m) => m.relationships.some((r) => r.participants.length > 2)) >= 4, 'exercises: n-ary relationships');
}

console.log(pass + ' passed, ' + fail + ' failed' + (skip ? ', ' + skip + ' skipped' : ''));
process.exit(fail ? 1 : 0);
