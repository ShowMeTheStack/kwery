// The Theatre sample shared by tools/theatre.mjs, tools/theatre-small.mjs and tools/theatre-large.mjs: its CREATE
// TABLE statements and a seeded generator that scales. Companies stage productions at venues, artists are cast in
// productions, patrons book performances and may rate them, and artists mentor one another.
import { insert, FIRST, LAST, day, pad } from './sample-lib.mjs';

// a seeded generator with the same helpers as sample-lib's rng, but whose successive draws are independent enough to
// pick pairs (patron, performance) from large tables without repeating a small set of them
function rng(seed) {
  let s = seed >>> 0;
  const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const chance = (p) => rnd() < p;
  const shuffle = (a) => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
  const sample = (a, n) => shuffle(a).slice(0, n);
  return { rnd, int, pick, chance, shuffle, sample };
}

export const SCHEMA = `create table venue (
  venue_code  varchar(6) primary key,
  venue_name  varchar(40) not null,
  city        varchar(20) not null,
  opened      integer check (opened > 1800)
);
create table stage (                            -- weak entity: identified by its venue
  venue_code  varchar(6) references venue on delete cascade,
  stage_no    smallint check (stage_no > 0),
  seats       integer not null check (seats > 0),
  kind        varchar(12) not null check (kind in ('proscenium', 'thrust', 'arena', 'studio', 'open air')),
  primary key (venue_code, stage_no)
);
create table company (
  company_id  varchar(5) primary key,
  name        varchar(40) not null unique,
  city        varchar(20) not null,
  founded     integer,
  budget      numeric(12,2) check (budget > 0)
);
create table person (
  person_id   varchar(6) primary key,
  given_name  varchar(20) not null,
  family_name varchar(20) not null,
  birth_date  date,
  home_city   varchar(20)                       -- may be null
);
create table artist (                           -- a person who performs; fee is per production week
  person_id   varchar(6) primary key references person on delete cascade,
  company_id  varchar(5) references company on delete set null,   -- null: freelance
  billed_as   varchar(40),
  fee         numeric(8,2) check (fee > 0)
);
create table production (
  prod_id     varchar(6) primary key,
  title       varchar(60) not null,
  company_id  varchar(5) not null references company,
  genre       varchar(12) not null check (genre in ('drama', 'comedy', 'musical', 'opera', 'dance', 'tragedy', 'revue')),
  premiere    date,
  runtime_min integer check (runtime_min > 0),
  based_on    varchar(6) references production  -- an adaptation or sequel of another production
);
create table performance (
  perf_id     integer primary key,
  prod_id     varchar(6) not null references production,
  venue_code  varchar(6) not null,
  stage_no    smallint not null,
  perf_date   date not null,
  start_time  time not null,
  price       numeric(6,2) not null check (price >= 0),
  foreign key (venue_code, stage_no) references stage
);
create table casting (                          -- many-to-many artist x production, with the role
  person_id   varchar(6) references artist,
  prod_id     varchar(6) references production,
  role_name   varchar(40),
  lead        boolean not null default false,
  primary key (person_id, prod_id, role_name)
);
create table patron (
  patron_id   integer primary key,
  name        varchar(40) not null,
  city        varchar(20),
  joined      date not null,
  points      integer not null default 0 check (points >= 0)
);
create table booking (                          -- many-to-many patron x performance; rating null = not rated
  booking_id  integer primary key,
  patron_id   integer not null references patron,
  perf_id     integer not null references performance,
  seats       smallint not null check (seats between 1 and 8),
  paid        numeric(8,2) not null,
  rating      smallint check (rating between 1 and 5),
  unique (patron_id, perf_id)
);
create table mentor (                           -- recursive: an artist mentors another
  mentor_id   varchar(6) references artist (person_id),
  mentee_id   varchar(6) references artist (person_id),
  since       date,
  primary key (mentor_id, mentee_id),
  check (mentor_id <> mentee_id)
);`;

export const GENRES = ['drama', 'comedy', 'musical', 'opera', 'dance', 'tragedy', 'revue'];
export const CITIES = ['Brightwater', 'Saltreach', 'Quillmere', 'Lindenford', 'Vantmoor', 'Calder Falls', 'Easterholm', 'Marrowgate',
  'Fennick', 'Oxlow', 'Port Amberly', 'Hollin Vale', 'Tessaby', 'Wrenfield', 'Dunmarrow', 'Kestrel Point'];
const KINDS = ['proscenium', 'thrust', 'arena', 'studio', 'open air'];
const KIND_PRICE = { proscenium: 38, thrust: 32, arena: 28, studio: 18, 'open air': 14 };
const GENRE_PRICE = { opera: 26, musical: 16, dance: 8, revue: 4, drama: 0, comedy: 0, tragedy: 2 };
const GENRE_RATING = { comedy: 4.1, musical: 4.0, revue: 3.8, dance: 3.7, drama: 3.6, opera: 3.5, tragedy: 3.3 };
const RUNTIME = { drama: [95, 150], comedy: [80, 120], musical: [130, 170], opera: [150, 210], dance: [60, 110], tragedy: [120, 180], revue: [70, 100] };
const ROLES = {
  drama: ['The Keeper', 'The Daughter', 'The Lodger', 'The Magistrate', 'The Widow', 'The Stranger', 'The Clerk'],
  comedy: ['The Landlady', 'The Nephew', 'The Inspector', 'The Cook', 'The Suitor', 'The Butler', 'The Twin'],
  musical: ['The Captain', 'The Singer', 'The Newsboy', 'The Mayor', 'Chorus', 'Ensemble'],
  opera: ['The Countess', 'The Ferryman', 'The Prince', 'The Oracle', 'Chorus'],
  dance: ['Principal', 'Soloist', 'Corps', 'Ensemble'],
  tragedy: ['The Queen', 'The Heir', 'The Exile', 'The Ghost', 'The General', 'The Fool'],
  revue: ['Compere', 'Ensemble', 'Turn', 'Pianist'],
};
const VENUE_A = ['Riverlight', 'Harbour', 'Glasshouse', 'Old Oak', 'Lantern', 'Meridian', 'Ferry', 'Copperleaf', 'Kingfisher', 'Saltbox', 'Lamplight', 'Ropewalk',
  'Thistle', 'Granary', 'Bellfounders', 'Weaver\'s', 'Tidemark', 'Quarry', 'Orchard', 'Cinder', 'Moorland', 'Larkhill', 'Foundry', 'Mill Race', 'Clocktower',
  'Ironbridge', 'Starling', 'Wharfside', 'Brambles', 'Coldharbour'];
const VENUE_B = ['Playhouse', 'Rooms', 'Theatre', 'Hall', 'Yard', 'Arts Centre', 'Shed', 'Amphitheatre', 'Stage', 'Assembly Rooms', 'Exchange', 'Institute'];
const CO_A = ['Brightwater', 'Saltreach', 'Lantern', 'Quillmere', 'Northlight', 'Tin Whistle', 'Vantmoor', 'Copperleaf', 'Ashfall', 'Paper Moon', 'Lindenford',
  'Grey Heron', 'Blue Lobster', 'Tallow', 'Merrow', 'Fiddlehead', 'Long Shadow', 'Night Kite', 'Magpie', 'Second Wind', 'Hollowtree', 'Quarter Moon', 'Red Thread',
  'Little Wolf', 'Stormglass', 'Juniper', 'Wildwood', 'Half Light', 'Saffron', 'Ninepins'];
const CO_B = { drama: ['Players', 'Repertory', 'Stage Society', 'Ensemble'], comedy: ['Comedy Co.', 'Players', 'Farceurs'], musical: ['Musical Theatre', 'Song & Stage'],
  opera: ['Opera Guild', 'Opera Company'], dance: ['Dance Collective', 'Dance Theatre'], tragedy: ['Tragedians', 'Ensemble'], revue: ['Revue', 'Cabaret'] };
// hand-made titles, in the order the main sample uses them; two of them hide awkward characters on purpose
export const TITLES = ['The Lighthouse Keeper\'s Daughter', 'Salt and Ashes', 'A Clock with No Hands', 'Dinner at the Ferryman\'s', 'Wolves in the Orchard',
  '100% Tuesday', 'The Glass Harbour', 'Seven Doors to Vantmoor', 'Lantern Songs', 'The Copper Crown', 'Nobody Leaves Before Midnight', 'The Ninth Bell',
  'Rain on the Ropewalk', 'Paper Boats', 'The Mapmaker\'s Wager', 'Heron Dances', 'All the Quiet Kings', 'Tuesday Never Ends', 'The Widow of Easterholm',
  'Fog Over Marrowgate', 'The Last Tram', 'Moth and Candle', 'A Feast of Small Lies', 'Brass Hearts', 'The Undertow', 'Winter Clockwork', 'Three Sisters of Salt',
  'The Forgotten Overture', 'Stormglass', 'A Ladder to the Moon', 'The Borrowed Coat', 'Kingfisher Blue', 'Halfway House', 'The Burning Library',
  'Gulls at Dawn', 'The Tin Admiral', 'Lucky Number Nine', 'The Cartographer', 'Velvet and Iron', 'Shadows on the Quay', 'The Ferryman Returns',
  'The Ferryman: Last Crossing', 'The Ferryman\'s Ghost', 'Rain on the Ropewalk II', 'Rain on the Ropewalk III', 'Ropewalk Forever',
  'The Lighthouse Keeper\'s Son', 'The Lighthouse Keeper\'s Grandson', 'Salt and Embers', 'Salt and Stars', 'Brass Hearts Encore', 'Kites Over Fennick',
  'Midnight at the Exchange', 'The Sparrow Waltz',
  // never performed: announced for next season, or shelved
  'Ferryman: The Revue', 'The Quiet Mirror', 'Letters to Oxlow', 'A Wedding in Wrenfield', 'The Admiral\'s Funeral', 'Half Past Never'];
export const CHAINS = [
  ['Dinner at the Ferryman\'s', 'The Ferryman Returns', 'The Ferryman: Last Crossing', 'The Ferryman\'s Ghost', 'Ferryman: The Revue'],
  ['Rain on the Ropewalk', 'Rain on the Ropewalk II', 'Rain on the Ropewalk III', 'Ropewalk Forever'],
  ['The Lighthouse Keeper\'s Daughter', 'The Lighthouse Keeper\'s Son', 'The Lighthouse Keeper\'s Grandson'],
  ['Salt and Ashes', 'Salt and Embers', 'Salt and Stars'],
  ['Brass Hearts', 'Brass Hearts Encore'],
];
const T_A = ['The', 'A', 'Seven', 'Nine', 'Two', 'The Last', 'The First', 'Our', 'No', 'The Quiet', 'The Silver', 'The Crooked', 'Midnight', 'Winter', 'Summer'];
const T_B = ['Lanterns', 'Ferries', 'Orchards', 'Clocks', 'Gulls', 'Harbours', 'Crowns', 'Ladders', 'Kingdoms', 'Bells', 'Keys', 'Mirrors', 'Maps', 'Gardens', 'Kites',
  'Tides', 'Letters', 'Lighthouses', 'Moths', 'Admirals', 'Bridges', 'Wolves', 'Sparrows', 'Weddings', 'Funerals', 'Promises'];
const T_C = ['of Saltreach', 'at Dawn', 'in the Fog', 'for Sale', 'on Fire', 'of Glass', 'Under Ice', 'by Candlelight', 'and Ashes', 'of the North', 'Remembered',
  'in Brass', 'at Sea', 'of Vantmoor', 'Unbound', 'in Velvet', 'After Dark', 'of Copper', 'in Spring', 'Adrift'];

const money = (v) => ({ sql: v.toFixed(2) });

/**
 * Generates the Theatre rows. n: { venues, companies, noArtistCos, noProdCos, persons, artists, freelance, productions,
 * titled (chains of titles, base first), chains (lengths in links of further random chains), unperformed, perfs, patrons, bookings, mentorDepth }.
 */
export function generate(seed, n) {
  const { rnd, int, pick, chance, shuffle, sample } = rng(seed);
  const skew = (p) => Math.pow(rnd(), p);
  const cities = CITIES.slice(0, Math.max(8, Math.min(CITIES.length, n.venues)));

  // venues and their stages
  const venue = [], stage = [];
  const codes = new Set();
  for (let i = 0; i < n.venues; i++) {
    const a = VENUE_A[i % VENUE_A.length], b = VENUE_B[i < 8 ? [0, 1, 2, 3, 4, 5, 6, 7][i] : int(0, VENUE_B.length - 1)];
    let code = (a.replace(/[^A-Za-z]/g, '').slice(0, 3)).toUpperCase();
    for (let k = 2; codes.has(code); k++) code = code.slice(0, 3) + k;
    codes.add(code);
    venue.push([code, (i >= VENUE_A.length ? 'New ' : '') + a + ' ' + b, i < cities.length ? cities[i] : pick(cities), i === 5 ? null : int(1868, 2019)]);
  }
  for (const v of venue) {
    const ns = v[3] === null ? 4 : stage.length < 2 ? 3 : int(1, 4);
    for (let s = 1; s <= ns; s++) {
      const kind = s === 1 ? pick(['proscenium', 'proscenium', 'thrust', 'arena']) : pick(KINDS);
      const seats = kind === 'studio' ? int(6, 16) * 5 : kind === 'open air' ? int(30, 90) * 10 : int(25, 120) * 10;
      stage.push([v[0], s, seats, kind]);
    }
  }
  // trim or pad to the target stage count
  while (n.stages && stage.length > n.stages) { const i = stage.findLastIndex((s, k) => s[1] > 1 && (k + 1 >= stage.length || stage[k + 1][0] !== s[0])); stage.splice(i, 1); }
  while (n.stages && stage.length < n.stages) { const v = venue[int(0, venue.length - 1)][0]; const last = stage.filter((s) => s[0] === v).length; const i = stage.findLastIndex((s) => s[0] === v); stage.splice(i + 1, 0, [v, last + 1, int(6, 16) * 5, 'studio']); }

  // companies, each with a home genre
  const company = [], home = {};
  const names = new Set();
  for (let i = 0; i < n.companies; i++) {
    const g = GENRES[i % GENRES.length];
    let name = CO_A[i % CO_A.length] + ' ' + pick(CO_B[g]);
    if (i >= CO_A.length) name = 'New ' + name;
    while (names.has(name)) name += ' II';
    names.add(name);
    const id = 'C' + pad(i + 1, n.companies > 99 ? 3 : 2);
    const budget = Math.round((60000 + skew(3) * 4000000) / 500) * 500;
    company.push([id, name, pick(cities), chance(0.1) ? null : int(1952, 2021), money(budget)]);
    home[id] = g;
  }
  const noArtist = company.slice(-n.noArtistCos).map((c) => c[0]);
  const noProd = company[company.length - n.noArtistCos - 1][0];

  // people; the artists are scattered among them
  const person = [], used = new Set();
  for (let i = 0; i < n.persons; i++) {
    let g, f;
    do { g = pick(FIRST); f = pick(LAST); } while (used.has(g + ' ' + f) && used.size < FIRST.length * LAST.length);
    used.add(g + ' ' + f);
    person.push(['P' + (1001 + i), g, f, chance(0.06) ? null : day('1948-01-01', int(0, 365 * 57)), chance(0.12) ? null : pick(cities)]);
  }
  const artistIdx = sample(person.map((p, i) => i), n.artists).sort((a, b) => a - b);
  const artistCos = company.filter((c) => !noArtist.includes(c[0])).map((c) => c[0]);
  const freeIdx = new Set(sample(artistIdx, n.freelance));
  const artist = artistIdx.map((i, k) => {
    const p = person[i];
    const co = freeIdx.has(i) ? null : k < artistCos.length ? artistCos[k] : pick(artistCos);
    const star = chance(0.06);
    const fee = star ? int(90, 130) * 100 : Math.round((450 + skew(3) * 5200) / 50) * 50;
    const billed = chance(0.55) ? null : chance(0.5) ? p[1] + ' ' + p[2] : pick(['', 'Little ', 'Madame ', 'Sir ', 'The Great ']) + p[2];
    return [p[0], co, billed, money(fee)];
  });
  if (n.trailing) { const a = artist.find((x) => x[2] && !x[2].includes(' ')); if (a) a[2] += ' '; }   // a trailing space, for trim() and comparisons
  const artistIds = artist.map((a) => a[0]);
  const birth = Object.fromEntries(person.map((p) => [p[0], p[3]]));

  // productions: titles, genres leaning on the company's home genre, premieres in date order
  const prodCos = company.filter((c) => c[0] !== noProd).map((c) => c[0]);
  const production = [];
  const titleSet = new Set();
  const titleAt = (i) => {
    if (i < TITLES.length) return TITLES[i];
    let t;
    do { t = pick(T_A) + ' ' + pick(T_B) + (chance(0.6) ? ' ' + pick(T_C) : ''); } while (titleSet.has(t));
    return t;
  };
  const seasonDays = (s) => [day('2024-09-01', 0), day('2025-09-01', 0)][s];
  for (let i = 0; i < n.productions; i++) {
    const co = i < prodCos.length ? prodCos[i] : pick(prodCos);
    const g = chance(0.7) ? home[co] : pick(GENRES);
    const title = titleAt(i);
    titleSet.add(title);
    const rt = RUNTIME[g];
    production.push({ id: 'PR' + (101 + i), title, co, genre: g, premiere: null, runtime: chance(0.05) ? null : Math.round(int(rt[0], rt[1]) / 5) * 5, based: null });
  }
  // who never plays: the last few, with a future or unknown premiere
  const unperformed = new Set(production.slice(-n.unperformed).map((p) => p.id));
  const performed = production.filter((p) => !unperformed.has(p.id));
  // runs: each performed production gets a first night in one of two seasons (some are revivals of older shows)
  const runs = {};
  const ordered = shuffle(performed);
  ordered.forEach((p, k) => {
    const season = k < ordered.length / 2 ? 0 : 1;
    const first = day(seasonDays(season), int(0, 270));
    runs[p.id] = first;
    p.premiere = chance(0.15) ? day('2012-03-01', int(0, 365 * 12)) : first;
  });
  production.filter((p) => unperformed.has(p.id)).forEach((p, k) => { p.premiere = k % 2 ? null : day('2026-09-10', int(0, 200)); });
  // based_on chains: either named in n.titled (lists of titles, base first) or random chains of n.chains links
  const chains = (n.titled || []).map((ts) => ts.map((t) => production.find((p) => p.title === t)));
  chains.forEach((ch) => ch.forEach((p) => { p.chained = true; }));
  chains.push(...(n.chains || []).map((len) => { const pool = shuffle(production.filter((p) => !p.chained && !unperformed.has(p.id))).slice(0, len + 1); pool.forEach((p) => { p.chained = true; }); return pool; }));
  for (const ch of chains) {
    // first nights in chain order, so an adaptation always opens after what it is based on
    const dates = ch.filter((p) => runs[p.id]).map((p) => runs[p.id]).sort();
    let k = 0;
    for (const p of ch) if (runs[p.id]) { runs[p.id] = dates[k++]; p.premiere = runs[p.id]; }
    for (let i = 1; i < ch.length; i++) ch[i].based = ch[i - 1];
  }
  // number the productions in order of premiere (unknown premieres last), so based_on always points backwards
  production.sort((a, b) => (a.premiere === b.premiere ? a.title < b.title ? -1 : 1 : a.premiere === null ? 1 : b.premiere === null ? -1 : a.premiere < b.premiere ? -1 : 1));
  const oldRuns = runs;
  const newRuns = {};
  production.forEach((p, i) => { const id = 'PR' + (101 + i); if (oldRuns[p.id]) newRuns[id] = oldRuns[p.id]; if (unperformed.has(p.id)) { unperformed.delete(p.id); p.unperf = true; } p.id = id; });
  for (const p of production) if (p.unperf) unperformed.add(p.id);
  for (const p of production) if (p.based) p.based = p.based.id;
  Object.keys(runs).forEach((k) => delete runs[k]);
  Object.assign(runs, newRuns);
  performed.sort((a, b) => (a.id < b.id ? -1 : 1));

  // performances
  const performance = [];
  const slot = new Set();
  const stagesIn = (city) => stage.filter((s) => venue.find((v) => v[0] === s[0])[2] === city);
  const coCity = Object.fromEntries(company.map((c) => [c[0], c[2]]));
  const counts = performed.map(() => 1);
  for (let extra = n.perfs - performed.length; extra > 0; extra--) counts[Math.floor(skew(1.6) * performed.length)]++;
  performed.forEach((p, k) => {
    const local = stagesIn(coCity[p.co]);
    let st = local.length && chance(0.75) ? pick(local) : pick(stage);
    let d = runs[p.id];
    for (let j = 0; j < counts[k]; j++) {
      if (j && chance(0.08)) st = pick(stage);                  // on tour
      const wd = new Date(d + 'T00:00:00Z').getUTCDay();
      const matinee = (wd === 0 || wd === 6) && chance(0.4);
      const time = matinee ? '14:30' : pick(['19:30', '19:30', '19:30', '20:00', '19:00']);
      const key = st[0] + st[1] + d + time;
      if (slot.has(key)) { d = day(d, 1); j--; continue; }
      slot.add(key);
      let price = KIND_PRICE[st[3]] + GENRE_PRICE[p.genre] + (wd === 5 || wd === 6 ? 6 : 0) - (matinee ? 8 : 0) + Math.min(10, Math.floor(st[2] / 150));
      price = Math.round(price * (0.9 + rnd() * 0.25) * 2) / 2;
      if (j === 0 && chance(0.06)) price = 0;                     // a free preview
      performance.push([0, p.id, st[0], st[1], d, time, price]);
      d = day(d, chance(0.7) ? 1 : int(2, 9));
    }
  });
  performance.sort((a, b) => (a[4] < b[4] ? -1 : a[4] > b[4] ? 1 : a[5] < b[5] ? -1 : a[5] > b[5] ? 1 : a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : a[3] - b[3]));
  performance.forEach((r, i) => { r[0] = i + 1; });

  // casting: mostly the company's own artists, with guests and freelancers; a few artists never cast
  const casting = [];
  const byCo = {};
  for (const a of artist) (byCo[a[1]] = byCo[a[1]] || []).push(a[0]);
  const idle = new Set(sample(artistIds, Math.max(1, Math.round(n.artists * 0.07))));
  const castable = artistIds.filter((a) => !idle.has(a));
  const freelancers = artist.filter((a) => a[1] === null).map((a) => a[0]).filter((a) => !idle.has(a));
  const castKey = new Set();
  for (const p of production) {
    const own = (byCo[p.co] || []).filter((a) => !idle.has(a));
    const size = Math.max(1, Math.round(n.castMean - 1.5 + rnd() * 3));
    const roles = shuffle(ROLES[p.genre]);
    const people = [];
    for (let k = 0; k < size; k++) {
      const from = own.length && chance(0.7) ? own : freelancers.length && chance(0.4) ? freelancers : castable;
      const a = pick(from);
      if (!people.includes(a)) people.push(a);
    }
    people.forEach((a, k) => {
      const role = roles[k % roles.length];
      if (castKey.has(a + p.id + role)) return;
      castKey.add(a + p.id + role);
      casting.push([a, p.id, role, k === 0]);
    });
    if (chance(0.12) && people.length && roles.length > people.length) casting.push([people[0], p.id, roles[people.length], false]);  // doubling a part
  }

  // patrons and their bookings; some patrons book a lot, some never
  const patron = [];
  for (let i = 0; i < n.patrons; i++) {
    patron.push([i + 1, pick(FIRST) + ' ' + pick(LAST), chance(0.1) ? null : pick(cities), n.bookingSql ? day('2012-01-01', int(0, 365 * 12 + 200)) : day('2016-01-01', int(0, 365 * 10 + 120)), 0]);
  }
  const prodOf = Object.fromEntries(production.map((p) => [p.id, p]));
  const booking = [];
  const pairs = new Set();
  const seatsUsed = {};
  let guard = 0;
  while (!n.bookingSql && booking.length < n.bookings && guard++ < n.bookings * 50) {
    const pa = patron[Math.floor(skew(n.patronSkew || 2.2) * patron.length)];
    const pf = performance[Math.floor(skew(0.8) * performance.length)];
    if (pf[4] < pa[3] || pairs.has(pa[0] + ':' + pf[0])) continue;
    pairs.add(pa[0] + ':' + pf[0]);
    const seats = pick([1, 2, 2, 2, 2, 2, 3, 4, 4, 1, 6, 8]);
    const g = prodOf[pf[1]].genre;
    let paid = pf[6] * seats;
    if (chance(0.15)) paid = Math.round(paid * 0.8 * 100) / 100;     // concession
    const rating = chance(0.25) ? null : Math.max(1, Math.min(5, Math.round(GENRE_RATING[g] + (rnd() + rnd() + rnd() - 1.5) * 1.8)));
    booking.push([0, pa[0], pf[0], seats, money(paid), rating]);
    seatsUsed[pa[0]] = (seatsUsed[pa[0]] || 0) + seats;
  }
  booking.sort((a, b) => a[2] - b[2] || a[1] - b[1]);
  booking.forEach((r, i) => { r[0] = i + 1; });
  for (const p of patron) p[4] = n.bookingSql ? int(0, 80) * 10 : seatsUsed[p[0]] ? seatsUsed[p[0]] * 10 + (chance(0.3) ? 50 : 0) : 0;

  // a mentoring tree (oldest artists at the top) plus a few crossings from a higher level
  const byAge = artistIds.filter((a) => birth[a]).sort((a, b) => (birth[a] < birth[b] ? -1 : 1));
  const levels = [[byAge[0]]];
  const pool = byAge.slice(1);
  const mentor = [];
  const take = () => pool.splice(Math.floor(rnd() * Math.min(pool.length, 6)), 1)[0];
  const since = (m, e) => day(birth[e] > '2000-01-01' ? '2022-01-01' : '2004-01-01', int(0, 365 * 4));
  for (let lv = 1; lv <= n.mentorDepth.length; lv++) {
    levels[lv] = [];
    const want = n.mentorDepth[lv - 1];
    for (let k = 0; k < want && pool.length; k++) {
      const m = levels[lv - 1][k % levels[lv - 1].length];
      const e = take();
      levels[lv].push(e);
      mentor.push([m, e, since(m, e)]);
    }
  }
  for (let k = 0; k < n.crossings; k++) {
    const lv = int(2, levels.length - 1);
    const e = pick(levels[lv]), m = pick(levels[int(0, lv - 2)]);
    if (!mentor.some((x) => x[0] === m && x[1] === e)) mentor.push([m, e, chance(0.2) ? null : since(m, e)]);
    else k--;
  }

  return { venue, stage, company, person, artist, production: production.map((p) => [p.id, p.title, p.co, p.genre, p.premiere, p.runtime, p.based]),
    performance: performance.map((r) => [r[0], r[1], r[2], r[3], r[4], r[5], money(r[6])]), casting, patron, booking, mentor,
    bookingSql: n.bookingSql ? bookingSql(patron.length, performance.length, n.bookings) : null };
}

// Many bookings, computed from row numbers so the file stays small: patron p books 1 to 13 different performances
// (perf ids p*7919 + m*173 apart, so never the same one twice), a quarter of them unrated, ratings leaning on the genre.
function bookingSql(patrons, perfs, total) {
  const base = GENRES.map((g) => `when '${g}' then ${GENRE_RATING[g]}`).join(' ');
  return `insert into booking (booking_id, patron_id, perf_id, seats, paid, rating)
select row_number() over (order by b.n), b.p + 1, f.perf_id, b.seats,
       round(f.price * b.seats * case when b.n % 7 = 0 then 0.80 else 1 end, 2),
       case when (b.n * 7 + b.m) % 4 = 0 then null
            else greatest(1, least(5, round(case pr.genre ${base} end + ((b.n * 7919 + b.p * 104729) % 21 - 10) / 4.0))) end
from (select n, p, m, case when x < 2 then 1 when x < 7 then 2 when x < 8 then 3 when x < 10 then 4 when x < 11 then 6 else 8 end as seats
      from (select n, n % ${patrons} as p, n / ${patrons} as m, (n * 13 + n / ${patrons}) % 12 as x from generate_series(0, ${patrons * 13 - 1}) n) g
      where m < 1 + (p * 7) % 13 or (p % 9 = 0 and m < 13)
      order by n limit ${total}) b
join performance f on f.perf_id = 1 + (b.p * 7919 + b.m * 173) % ${perfs}
join production pr on pr.prod_id = f.prod_id;`;
}

export const TABLES = ['venue', 'stage', 'company', 'person', 'artist', 'production', 'performance', 'casting', 'patron', 'booking', 'mentor'];
/** the INSERT statements for every table, in dependency order */
export const inserts = (t) => TABLES.map((k) => (k === 'booking' && t.bookingSql ? t.bookingSql : insert(k, null, t[k])));
export const counts = (t) => Object.fromEntries(TABLES.map((k) => [k, t[k].length]));
