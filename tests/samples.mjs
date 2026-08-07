// Loads each sample database into Kwery and into a local PostgreSQL (through its Unix socket only), runs a dozen
// queries on both and compares the results row by row (sorted, unless the query orders them). Without a server it says so and stops.
//   node tests/samples.mjs [sample-id ...] [--verbose]
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { load } from './load.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const K = load();
const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const only = args.filter((a) => !a.startsWith('--'));
const PG = '/opt/homebrew/opt/postgresql@17/bin';
const env = Object.assign({}, process.env, { PGHOST: path.join(process.env.HOME, '.kwery-pg/sock'), PGPORT: '5544' });
const SEP = '\x1f';

const theatre = [
  'select count(*), sum(seats), sum(paid) from booking',
  'select count(*), count(rating), count(distinct patron_id) from booking',
  'select genre, count(*), min(runtime_min), max(runtime_min) from production group by genre',
  'select p.genre, count(b.rating), avg(b.rating)::numeric(4,2) from booking b join performance f using (perf_id) join production p using (prod_id) group by p.genre',
  'select s.kind, count(*), min(f.price), max(f.price), avg(f.price)::numeric(8,2) from performance f join stage s using (venue_code, stage_no) group by s.kind',
  'select c.name, count(a.person_id), sum(a.fee) from company c left join artist a using (company_id) group by c.company_id, c.name',
  'select count(*) from artist where company_id is null',
  'select count(*) from production p where not exists (select 1 from performance f where f.prod_id = p.prod_id)',
  'with recursive chain(prod_id, depth) as (select prod_id, 0 from production where based_on is null union all select p.prod_id, c.depth + 1 from production p join chain c on p.based_on = c.prod_id) select depth, count(*) from chain group by depth order by depth',
  'with recursive tree(person_id, depth) as (select distinct mentor_id, 0 from mentor where mentor_id not in (select mentee_id from mentor) union all select m.mentee_id, t.depth + 1 from mentor m join tree t on m.mentor_id = t.person_id) select depth, count(*) from tree group by depth order by depth',
  'select coalesce(city, \'(none)\'), count(*) from patron group by city',
  'select prod_id, count(*), rank() over (order by count(*) desc) from casting group by prod_id order by 3, prod_id limit 8',
  'select title from production where title like \'%\'\'%\' or title like \'%\\%%\' escape \'\\\' order by title',
  'select count(*) from artist where billed_as <> trim(billed_as)',
  'select v.city, extract(year from f.perf_date) as y, count(*), sum(f.price) from performance f join venue v using (venue_code) group by v.city, y',
];
const QUERIES = {
  theatre,
  'theatre-small': theatre,
  'theatre-large': theatre.concat([
    'select f.prod_id, count(*) from booking b join performance f using (perf_id) where f.perf_date >= date \'2026-01-01\' group by f.prod_id order by count(*) desc, f.prod_id limit 5',
    'select seats, count(*), sum(paid) from booking group by seats',
  ]),
  creditunion: [
    'select kind, count(*), sum(balance), min(balance), max(balance) from account group by kind',
    'select status, count(*), sum(amount) from card_payment group by status',
    'select count(*), sum(amount), min(made_at), max(made_at) from transfer',
    'select m.category, count(*), sum(p.amount) from card_payment p join merchant m using (merchant_id) where p.status = \'settled\' group by m.category',
    'select count(*) from account a where a.balance - coalesce((select sum(amount) from transfer where to_account = a.account_no), 0) + coalesce((select sum(amount) from transfer where from_account = a.account_no), 0) + coalesce((select sum(p.amount) from card_payment p join card c using (card_id) where c.account_no = a.account_no and p.status <> \'declined\'), 0) < 0 and a.kind = \'share\'',
    'select count(*) from member m where not exists (select 1 from account a where a.member_id = m.member_id)',
    'select a.member_id, sum(a.balance) from account a group by a.member_id having count(*) > 2 order by a.member_id',
    'select date_trunc(\'month\', made_at) as m, count(*), sum(amount) from transfer group by m order by m',
    'select memo, count(*) from transfer group by memo',
    'select from_account, sum(amount) over (partition by from_account order by made_at, transfer_id) from transfer order by transfer_id limit 20',
    'select c.status, count(distinct c.card_id), count(p.payment_id) from card c left join card_payment p using (card_id) group by c.status',
    'select count(*) from card_payment where amount < 0',
  ],
  studio: [
    'select count(*), sum(salary), avg(salary)::numeric(10,2) from engineer',
    'select t.name, count(e.eng_id), max(e.salary) from team t left join engineer e using (team_id) group by t.name',
    'with recursive chain(eng_id, depth) as (select eng_id, 0 from engineer where manager_id is null union all select e.eng_id, c.depth + 1 from engineer e join chain c on e.manager_id = c.eng_id) select depth, count(*) from chain group by depth order by depth',
    'select p.name, count(a.eng_id), sum(a.hours) from product p left join assignment a using (product_id) group by p.name',
    'select role, count(*), sum(hours) from assignment group by role',
    'select count(*) from engineer e where not exists (select 1 from assignment a where a.eng_id = e.eng_id)',
    'select e.eng_id from engineer e join engineer m on m.eng_id = e.manager_id where e.salary > m.salary order by e.eng_id',
    'select eng_id, count(*) from on_call group by eng_id order by count(*) desc, eng_id limit 5',
    'select count(*), count(backup_id) from on_call',
    'select product_id, kind, count(*) from release group by rollup (product_id, kind) having product_id < 4 or product_id is null',
    'select team_id, eng_id, rank() over (partition by team_id order by salary desc), dense_rank() over (partition by team_id order by salary desc) from engineer order by team_id, eng_id',
    'select product_id, version, released_at - lag(released_at) over (partition by product_id order by released_at) from release order by product_id, released_at limit 15',
  ],
  library: [
    'select count(*), count(distinct isbn) from book',
    'select genre, count(*), avg(pages)::numeric(8,1) from book group by genre',
    'select a.name, count(*) from author a join book_author ba using (author_id) group by a.author_id, a.name order by count(*) desc, a.author_id limit 5',
    'select count(*) from loan where returned_on is null',
    'select count(*) from loan where returned_on > due_on or (returned_on is null and due_on < date \'2024-12-31\')',
    'select m.kind, count(*) from loan l join member m using (member_id) group by m.kind',
    'select b.title, count(*) from loan l join copy c using (copy_id) join book b using (book_id) group by b.book_id, b.title order by count(*) desc, b.book_id limit 5',
    'select count(*) from loan a join loan b on a.copy_id = b.copy_id and a.loan_id < b.loan_id and b.loaned_on < coalesce(a.returned_on, date \'9999-12-31\') and a.loaned_on < coalesce(b.returned_on, date \'9999-12-31\')',
    'select status, count(*) from reservation group by status',
    'select avg(returned_on - loaned_on)::numeric(6,2) from loan where returned_on is not null',
    'select date_trunc(\'month\', loaned_on)::date as m, count(*) from loan group by m order by m',
    'select condition, count(*) from copy group by condition',
  ],
  airline: [
    'select count(*), sum(distance_km) from flight',
    'select origin, count(*) from flight group by origin',
    'select a.country, count(*) from flight f join airport a on a.code = f.origin group by a.country',
    'select flight_date, count(*), sum(fare) from booking group by flight_date order by flight_date',
    'select s.cabin, count(*), avg(b.fare)::numeric(8,2) from booking b join flight f using (flight_no) join seat s on s.tail_no = f.tail_no and s.seat_no = b.seat_no group by s.cabin',
    'select count(*) from booking b join flight f using (flight_no) where not exists (select 1 from seat s where s.tail_no = f.tail_no and s.seat_no = b.seat_no)',
    'with recursive trip(stop, hops, path) as (select \'PIK\'::char(3), 0, \'PIK\'::text union all select f.destination, t.hops + 1, t.path || \'-\' || f.destination from trip t join flight f on f.origin = t.stop where t.hops < 3 and position(f.destination in t.path) = 0) select min(hops), count(*) from trip where stop = \'RVS\'',
    'with recursive reach(code) as (select \'ALD\'::char(3) union select f.destination from reach r join flight f on f.origin = r.code) select count(*) from reach',
    'select f.flight_no, count(b.booking_id), a.seats from flight f join aircraft a using (tail_no) left join booking b on b.flight_no = f.flight_no and b.flight_date = date \'2024-06-05\' group by f.flight_no, a.seats order by f.flight_no limit 10',
    'select model, count(*) from aircraft a join flight f using (tail_no) group by model',
    'select count(*) from passenger where frequent_flyer is not null',
    'select passenger_id, count(*) from booking group by passenger_id order by count(*) desc, passenger_id limit 5',
    'select flight_no, departs, departs + make_interval(mins => duration_min) from flight order by flight_no limit 8',
  ],
  shop: [
    'select count(*), sum(price) from product',
    'with recursive tree(category_id, top) as (select category_id, name from category where parent_id is null union all select c.category_id, t.top from category c join tree t on c.parent_id = t.category_id) select t.top, count(p.product_id) from tree t left join product p using (category_id) group by t.top',
    'select o.status, count(*) from orders o group by o.status',
    'select sum(quantity * unit_price) from order_item',
    'select count(*) from orders o join payment p using (order_id) where p.amount <> (select sum(quantity * unit_price) from order_item i where i.order_id = o.order_id)',
    'select date_trunc(\'month\', o.ordered_at) as m, sum(i.quantity * i.unit_price) from orders o join order_item i using (order_id) group by m order by m',
    'select attrs->>\'color\' as color, count(*) from product where attrs ? \'color\' group by color',
    'select count(*) from product where tags @> array[\'sale\']',
    'select count(*), avg((attrs->>\'weight_g\')::int)::numeric(8,1) from product where attrs @> \'{"wireless": true}\'',
    'select tag, count(*) from product, unnest(tags) as tag group by tag',
    'select rating, count(*), sum((details->>\'helpful\')::int) from review group by rating order by rating',
    'select c.name as cat, p.name, sum(i.quantity) from product p join category c using (category_id) join order_item i using (product_id) group by rollup (c.name, p.name) having c.name = \'Tents\' or c.name is null',
    'select method, count(*), sum(amount) from payment group by method',
  ],
  sensors: [
    'select count(*), min(read_at), max(read_at) from reading',
    'select s.kind, count(*), min(r.value), max(r.value), avg(r.value)::numeric(8,2) from reading r join sensor s using (sensor_id) group by s.kind',
    'select sensor_id, count(*) from reading group by sensor_id',
    'select count(*) from sensor s where not exists (select 1 from reading r where r.sensor_id = s.sensor_id)',
    'select sensor_id, read_at, value, avg(value) over (partition by sensor_id order by read_at rows between 3 preceding and current row)::numeric(8,2) from reading where sensor_id = 1 order by read_at limit 12',
    'select sensor_id, read_at, value - lag(value) over (partition by sensor_id order by read_at) from reading where sensor_id = 6 order by read_at limit 12',
    'select sensor_id, count(*) from (select sensor_id, read_at - lag(read_at) over (partition by sensor_id order by read_at) as gap from reading) g where gap > interval \'15 minutes\' group by sensor_id',
    'select date_trunc(\'hour\', read_at) as h, avg(value)::numeric(8,2) from reading where sensor_id = 2 group by h order by h limit 10',
    'select st.name, count(*) from reading r join sensor s using (sensor_id) join site st using (site_id) group by st.name',
    'select sensor_id, max(value) - min(value) from reading group by sensor_id',
    'select * from (select sensor_id, read_at, value, rank() over (partition by sensor_id order by value desc, read_at) as r from reading) x where r = 1 order by sensor_id',
    'select extract(hour from read_at) as hr, avg(value)::numeric(8,2) from reading r join sensor s using (sensor_id) where s.kind = \'co2\' group by hr order by hr',
  ],
};

const ordered = (sql) => /\border\s+by\b[^()]*$/i.test(sql.replace(/\([^()]*\)/g, '()').replace(/\([^()]*\)/g, '()').replace(/\([^()]*\)/g, '()'));
const samples = JSON.parse(fs.readFileSync(path.join(root, 'src/data/samples.json'), 'utf8')).filter((s) => !only.length || only.includes(s.id));
try { execFileSync(PG + '/psql', ['-X', '-q', '-d', 'postgres', '-c', 'select 1'], { env, stdio: 'ignore' }); }
catch (e) { console.log('PostgreSQL is not reachable through ' + env.PGHOST + ': nothing to compare'); process.exit(0); }

function pgRun(id, sql, queries) {
  const db = 'kwery_samples_' + id.replace(/-/g, '_') + '_' + process.pid;
  execFileSync(PG + '/dropdb', ['--if-exists', db], { env, stdio: 'ignore' });
  execFileSync(PG + '/createdb', ['-T', 'template0', '-E', 'UTF8', '--locale=C', db], { env });
  try {
    execFileSync(PG + '/psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', db], { env, input: 'set client_min_messages = warning;\n' + sql, stdio: ['pipe', 'ignore', 'pipe'] });
    const script = queries.map((q, i) => '\\echo @@@' + i + '\n' + q + ';').join('\n');
    let text;
    try { text = execFileSync('/bin/sh', ['-c', '"$0" -X -q -A -t -F "$1" -P null=NULL -v VERBOSITY=sqlstate -d "$2" 2>&1', PG + '/psql', SEP, db], { env, input: script, encoding: 'utf8', maxBuffer: 1 << 26 }); }
    catch (e) { text = (e.stdout || '') + (e.stderr || ''); }
    const res = [];
    const parts = text.split(/^@@@(\d+)\n?/m);
    for (let i = 1; i < parts.length; i += 2) {
      const body = parts[i + 1] || '';
      const err = body.match(/ERROR:\s+([0-9A-Z]{5})/);
      res[+parts[i]] = err ? { error: err[1] } : { rows: body.split('\n').filter((l, k, a) => !(l === '' && k === a.length - 1)) };
    }
    return res;
  } finally { execFileSync(PG + '/dropdb', ['--if-exists', db], { env, stdio: 'ignore' }); }
}
function kwRun(sql, queries) {
  const t0 = Date.now();
  const db = new K.Database({ pageSize: 4096 });
  const s = db.session();
  s.exec(sql);
  s.exec('analyze');
  const ms = Date.now() - t0;
  const res = queries.map((q) => {
    try {
      const rs = s.exec(q);
      const r = rs[rs.length - 1];
      return { rows: (r.rows || []).map((row) => row.map((v, i) => (v === null || v === undefined ? 'NULL' : K.T.output(v, r.cols[i].type, { zone: 'UTC' }))).join(SEP)).flatMap((l) => l.split('\n')) };
    } catch (e) { return { error: e.code || 'JSERR', message: e.message }; }
  });
  return { ms, res };
}

let pass = 0, fail = 0;
for (const smp of samples) {
  const sql = fs.readFileSync(path.join(root, 'src/data', smp.file), 'utf8');
  const queries = QUERIES[smp.id] || [];
  const exp = pgRun(smp.id, sql, queries);
  const { ms, res: got } = kwRun(sql, queries);
  let fp = 0, ff = 0;
  queries.forEach((q, i) => {
    const e = exp[i] || { rows: [] }, g = got[i];
    let ok;
    if (e.error || g.error) ok = e.error === g.error;
    else {
      const a = ordered(q) ? e.rows : e.rows.slice().sort(), b = ordered(q) ? g.rows : g.rows.slice().sort();
      ok = a.length === b.length && a.every((x, k) => x === b[k]);
    }
    if (verbose || !ok) console.log((ok ? '  ok   ' : '  FAIL ') + smp.id + ' #' + (i + 1) + ': ' + q.replace(/\s+/g, ' ').slice(0, 110));
    if (ok) { fp++; return; }
    ff++;
    if (e.error || g.error) { console.log('    expected ' + (e.error ? 'error ' + e.error : e.rows.length + ' rows') + ', got ' + (g.error ? 'error ' + g.error + ': ' + g.message : g.rows.length + ' rows')); return; }
    const a = ordered(q) ? e.rows : e.rows.slice().sort(), b = ordered(q) ? g.rows : g.rows.slice().sort();
    const show = (r) => (r === undefined ? '-' : r.split(SEP).join(' | '));
    for (let k = 0, n = 0; k < Math.max(a.length, b.length) && n < 5; k++) if (a[k] !== b[k]) { console.log('    row ' + (k + 1) + ': pg ' + show(a[k]) + '\n           kw ' + show(b[k])); n++; }
  });
  pass += fp; fail += ff;
  console.log(smp.id + ': ' + fp + ' passed' + (ff ? ', ' + ff + ' FAILED' : '') + ' (Kwery load ' + ms + ' ms)');
}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
