// Writes src/data/studio.sql: a software studio. Engineers belong to teams and report to a manager (one chain of
// command five levels deep under the head of engineering, for recursive queries); teams own products, engineers are
// assigned to products for some hours a week (many to many, across teams), take turns on call for a product each
// week with a backup, and products ship releases. A team with no engineers, a product nobody works on, contractors
// with no team, and engineers on no product are there on purpose. Everything is invented.
import { rng, insert, write, FIRST, LAST, day, stamp } from './sample-lib.mjs';
const { int, pick, chance, sample, rnd, shuffle } = rng(20251212);

const team = [
  [1, 'Platform', 'infrastructure', '2015-03-02'], [2, 'Payments', 'backend', '2016-07-11'], [3, 'Mobile', 'apps', '2017-01-09'], [4, 'Web', 'frontend', '2016-02-15'],
  [5, 'Data', 'analytics', '2018-09-03'], [6, 'Security', 'infrastructure', '2019-05-20'], [7, 'Growth', 'frontend', '2021-04-12'], [8, 'Research', null, '2025-01-06'],
];
// Research (8) has no engineers yet
const staffed = [1, 2, 3, 4, 5, 6, 7];
const engineer = [];
const names = new Set();
const person = () => { let n; do n = pick(FIRST) + ' ' + pick(LAST); while (names.has(n)); names.add(n); return n; };
const email = (n) => n.toLowerCase().replace(/[^a-z ]/g, '').replace(' ', '.') + '@studio.example';
const salary = (level) => ({ sql: (Math.round((52000 + level * 17000 + Math.pow(rnd(), 2) * 25000) / 500) * 500).toFixed(2) });
const add = (team_id, manager, level, hired) => { const id = 101 + engineer.length; const n = person(); engineer.push([id, n, email(n), team_id, manager, level, hired, salary(level)]); return id; };
// the head of engineering, a director per two or three teams, a lead per team, then engineers under the leads
const head = add(null, null, 7, '2015-01-05');
const directors = [add(1, head, 6, '2015-06-01'), add(2, head, 6, '2016-08-22'), add(4, head, 6, '2017-03-13')];
const dirOf = { 1: 0, 6: 0, 5: 0, 2: 1, 3: 1, 4: 2, 7: 2 };
const leads = {};
for (const t of staffed) leads[t] = add(t, directors[dirOf[t]], 5, day(team[t - 1][3], int(0, 300)));
for (let k = 0; k < 52; k++) {
  const t = staffed[k % staffed.length];
  const level = pick([1, 2, 2, 3, 3, 3, 4, 4]);
  const seniors = engineer.filter((e) => e[3] === t && e[5] === 4 && e[0] !== leads[t]);
  const mgr = level <= 2 && seniors.length && chance(0.6) ? pick(seniors)[0] : leads[t];
  const hired = day(team[t - 1][3], int(30, 3500));
  add(t, mgr, level, hired > '2025-09-30' ? day('2025-09-30', -int(0, 200)) : hired);
}
// contractors: no team, report to a director
for (let k = 0; k < 4; k++) add(null, pick(directors), 2, day('2024-01-01', int(0, 600)));
// the same salary twice in one team, for rank() and dense_rank()
engineer[20][7] = engineer[27][7];

const product = [
  [1, 'Keystone', 1, '2016-05-01', 'active'], [2, 'Tollgate', 2, '2017-02-14', 'active'], [3, 'Pocketbook', 3, '2018-06-30', 'active'],
  [4, 'Lighthouse', 4, '2017-09-12', 'active'], [5, 'Riverbed', 5, '2019-03-04', 'active'], [6, 'Gatekeeper', 6, '2020-01-20', 'active'],
  [7, 'Sprout', 7, '2022-05-09', 'beta'], [8, 'Ledgerline', 2, '2021-11-01', 'active'], [9, 'Paper Trail', 5, '2014-10-01', 'sunset'],
  [10, 'Tidewatch', 1, '2023-08-15', 'active'], [11, 'Quickstep', 3, '2024-04-22', 'beta'], [12, 'Cartwheel', 4, '2019-07-01', 'active'],
  [13, 'Compass', 7, null, 'beta'], [14, 'Old Faithful', 1, '2013-03-01', 'sunset'],
];
// assignments: mostly to the team's own products, some across teams; Old Faithful (14) has nobody
const assignment = [];
const devs = engineer.filter((e) => e[5] <= 5);
const idle = new Set(sample(devs.filter((e) => e[5] <= 3), 3).map((e) => e[0]));
const ROLES = ['developer', 'developer', 'developer', 'reviewer', 'tech lead', 'tester', 'designer'];
for (const e of devs) {
  if (idle.has(e[0])) continue;
  const own = product.filter((p) => p[2] === e[3] && p[0] !== 14);
  const n = e[5] === 5 ? own.length : int(1, 3);
  const picks = new Set();
  for (let k = 0; k < n; k++) picks.add(own.length && chance(0.75) ? pick(own)[0] : int(1, 13));
  let left = 40;
  for (const p of picks) {
    const h = Math.min(left, pick([4, 8, 8, 10, 12, 16, 20, 20, 24, 32, 40]));
    if (h <= 0) break;
    left -= h;
    assignment.push([e[0], p, { sql: h.toFixed(1) }, e[5] === 5 ? 'tech lead' : pick(ROLES), day('2024-01-01', int(0, 600))]);
  }
}
// half-hours, for sums that are not whole
for (const a of sample(assignment, 6)) a[2] = { sql: (+a[2].sql - 0.5).toFixed(1) };
// on call: weekly, for the active products, from the engineers assigned to each (a backup when there are two)
const on_call = [];
for (const p of product.filter((x) => x[4] !== 'sunset' && x[3])) {
  const people = assignment.filter((a) => a[1] === p[0]).map((a) => a[0]);
  if (!people.length) continue;
  const rota = shuffle(people);
  for (let w = 0; w < 13; w++) {
    if (p[4] === 'beta' && w % 2) continue;
    const eng = rota[w % rota.length];
    const backup = rota.length > 1 && !chance(0.08) ? rota[(w + 1) % rota.length] : null;
    on_call.push([p[0], day('2025-06-30', w * 7), eng, backup]);
  }
}
// releases: majors, minors, patches and the odd hotfix, in version order
const release = [];
for (const p of product) {
  if (!p[3]) continue;
  let [maj, min, pat] = p[4] === 'beta' ? [0, 1, 0] : [1, 0, 0];
  let t = Date.parse(p[3] + 'T00:00:00Z') / 60000;
  const last = p[4] === 'sunset' ? Date.parse('2023-01-01T00:00:00Z') / 60000 : Date.parse('2025-09-30T00:00:00Z') / 60000;
  const count = p[4] === 'beta' ? int(2, 4) : int(5, 10);
  for (let k = 0; k < count && t < last; k++) {
    let kind;
    if (k === 0) kind = p[4] === 'beta' ? 'minor' : 'major';
    else { const r = rnd(); kind = r < 0.12 && p[4] !== 'beta' ? 'major' : r < 0.45 ? 'minor' : r < 0.9 ? 'patch' : 'hotfix'; }
    if (k) { if (kind === 'major') [maj, min, pat] = [maj + 1, 0, 0]; else if (kind === 'minor') [min, pat] = [min + 1, 0]; else pat++; }
    const version = maj + '.' + min + '.' + pat;
    release.push([p[0], version, stamp('1970-01-01 00:00:00', t + int(9, 17) * 60), kind, kind === 'hotfix' ? pick(['fix 100% CPU on start', 'roll back a bad migration', 'patch login loop']) : chance(0.3) ? null : pick(['faster search', 'new settings page', 'dark mode', 'export to CSV', 'fewer crashes', 'offline sync', 'it\'s quicker'])]);
    t += kind === 'hotfix' ? int(1, 3) * 1440 : int(20, 200) * 1440;
  }
}

write('studio.sql', [
  '-- A software studio, Kwery\'s own sample: teams, engineers who report to managers, products owned by teams,\n' +
  '-- assignments of engineers to products with hours a week, a weekly on-call rota with backups, and releases.\n' +
  '-- Everything is invented.',
  `create table team (
  team_id integer primary key,
  name varchar(20) not null unique,
  focus varchar(16),
  formed date not null
);
create table engineer (
  eng_id integer primary key,
  name varchar(40) not null,
  email varchar(60) not null unique,
  team_id integer references team (team_id) on delete set null,
  manager_id integer references engineer (eng_id),
  level smallint not null check (level between 1 and 7),
  hired date not null,
  salary numeric(10,2) not null check (salary > 0),
  check (manager_id <> eng_id)
);
create table product (
  product_id integer primary key,
  name varchar(30) not null unique,
  team_id integer not null references team (team_id),
  launched date,
  status varchar(6) not null check (status in ('beta', 'active', 'sunset'))
);
create table assignment (
  eng_id integer references engineer (eng_id) on delete cascade,
  product_id integer references product (product_id),
  hours numeric(3,1) not null check (hours > 0 and hours <= 40),
  role varchar(12) not null,
  since date not null,
  primary key (eng_id, product_id)
);
create table on_call (
  product_id integer references product (product_id),
  week_of date,
  eng_id integer not null references engineer (eng_id),
  backup_id integer references engineer (eng_id),
  primary key (product_id, week_of),
  check (backup_id <> eng_id)
);
create table release (
  product_id integer references product (product_id),
  version varchar(12),
  released_at timestamp not null,
  kind varchar(6) not null check (kind in ('major', 'minor', 'patch', 'hotfix')),
  notes varchar(40),
  primary key (product_id, version)
);`,
  insert('team', null, team), insert('engineer', null, engineer), insert('product', null, product), insert('assignment', null, assignment),
  insert('on_call', null, on_call), insert('release', null, release),
  'create index engineer_manager on engineer (manager_id);\ncreate index assignment_product on assignment (product_id);',
], { team: team.length, engineer: engineer.length, product: product.length, assignment: assignment.length, on_call: on_call.length, release: release.length });
