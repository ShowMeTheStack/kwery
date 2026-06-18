// Tests for the aggregates (aggs.js), the window executor (windows.js) and functions in FROM (srf.js).
// Hand-built plan nodes check the executor contracts; the SQL cases are parsed and bound by the engine's own
// parser and binder (with a stand-in session) and run through the executor. Their expected outputs were taken
// from PostgreSQL 17; run with --pg to compare against a live server instead (Unix socket only).
//   node tests/aggwin.mjs [--pg] [-v]
import { load } from './load.mjs';
import { execFileSync } from 'child_process';

const K = load();
const B = K.T.BASE;
const LIVE = process.argv.includes('--pg'), VERBOSE = process.argv.includes('-v');
let passed = 0, failed = 0;
function check(name, got, want) {
  if (got === want) { passed++; if (VERBOSE) console.log('ok   ' + name); return; }
  failed++;
  console.log('FAIL ' + name + '\n  got:  ' + String(got).replace(/\n/g, '\n        ') + '\n  want: ' + String(want).replace(/\n/g, '\n        '));
}
/** run a generator to the end, collecting what it yields */
function drive(gen) { const yielded = []; for (;;) { const r = gen.next(); if (r.done) return { value: r.value, yielded }; yielded.push(r.value); } }
const db = { srf: K.SRF, windows: K.Windows, settingsOf: () => ({}) };
const newCtx = () => ({ db, bus: new K.Bus(), outer: null, cteCache: new Map(), workTables: new Map() });
const session = { db, catalog: { userFuncs: () => [], userType: () => null }, searchPath: () => ['public'] };
const fmt = (rows, cols) => rows.map((r) => cols.map((c, i) => { const v = K.T.output(r[i], c.type, { zone: 'UTC' }); return v === null ? '' : v; }).join('|')).join('\n');

// ---- hand-built nodes ----------------------------------------------------------------------------------------
const c = (v, type) => ({ k: 'const', v, type });
const col = (id, type) => ({ k: 'col', id, type });
{
  // a Values child with (x int4, g text), and four window calls over it
  const data = [[3, 'a'], [1, 'b'], [2, 'a'], [5, 'b'], [4, 'a'], [null, 'a']];
  // the rows under both names: older executors read n.rows, newer ones n.tuples
  const tuples = data.map(([x, g]) => [c(x, B.int4), c(g, B.text)]);
  const child = { op: 'Values', rows: tuples, tuples, cols: [{ id: 1, name: 'x', type: B.int4 }, { id: 2, name: 'g', type: B.text }] };
  const x = col(1, B.int4), g = col(2, B.text);
  const w = (name, extra) => Object.assign({ k: 'wincall', name, def: K.F.WINS.get(name) || K.F.AGGS.get(name), isAgg: !K.F.WINS.get(name), args: [], star: false, distinct: false, filter: null, partition: [g], order: [{ e: x, dir: 'asc', nulls: 'last' }], frame: null, nulls: undefined }, extra);
  const wins = [
    w('row_number', { outId: 10, type: B.int8 }),
    w('sum', { outId: 11, type: B.int8, args: [x], frame: { unit: 'rows', start: { kind: 'offset', e: c(1n, B.int8), dir: 'preceding' }, end: { kind: 'current' } } }),
    w('lag', { outId: 12, type: B.int4, args: [x] }),
    w('count', { outId: 13, type: B.int8, star: true, partition: [], order: [] }),
  ];
  const node = { op: 'Window', children: [child], wins, cols: child.cols.concat(wins.map((v) => ({ id: v.outId, name: v.name, type: v.type }))) };
  const ctx = newCtx();
  let event = null;
  ctx.bus.on('exec.window', (e) => { event = e; });
  const rows = drive(K.Exec.all(node, ctx)).value;
  check('window node over Values', fmt(rows, node.cols), ['2|a|1|2||6', '3|a|2|5|2|6', '4|a|3|7|3|6', '|a|4|4|4|6', '1|b|1|1||6', '5|b|2|6|1|6'].join('\n'));
  check('window event', event && event.rows + '/' + event.partitions, '6/1');

  // signals from below pass through unchanged
  K.Exec.OPS.TestSignal = function* () { yield { signal: 'wait', id: 7 }; yield [2]; yield [1]; };
  const sig = { op: 'TestSignal', cols: [{ id: 1, name: 'x', type: B.int4 }] };
  const wn = { op: 'Window', children: [sig], wins: [w('rank', { outId: 20, type: B.int8, partition: [] })], cols: [] };
  const r = drive(K.Exec.run(wn, newCtx()));
  check('signals pass through', JSON.stringify(r.yielded, (k, v) => (typeof v === 'bigint' ? Number(v) : v)), '[{"signal":"wait","id":7},[1,1],[2,2]]');
}
{
  // an aggregate runner, as OPS.Aggregate uses it
  const lay = new Map([[1, 0]]);
  const call = { k: 'aggcall', name: 'avg', def: K.F.AGGS.get('avg'), args: [col(1, B.int4)], type: B.numeric, filter: null, order: null, within: null };
  const run = K.aggRunner(call, lay, newCtx());
  const st = run.init();
  for (const v of [1, 2, null, 2]) run.step(st, [v]);
  check('aggRunner avg', String(run.final(st)), '1.6666666666666667');
  const cnt = K.aggRunner({ name: 'count', def: K.F.AGGS.get('count'), args: [], star: true, type: B.int8 }, lay, newCtx());
  const s2 = cnt.init();
  for (const v of [1, null]) cnt.step(s2, [v]);
  check('aggRunner count(*)', String(cnt.final(s2)), '2');
}
{
  // a Func node: ROWS FROM (generate_series(1, 3), unnest(ARRAY['a', 'b'])) WITH ORDINALITY
  const binder = new K.Binder(session);
  const calls = [K.parseExpr('generate_series(1, 3)'), K.parseExpr("unnest(array['a', 'b'])")].map((a) => K.SRF.bind(binder, a, { items: [], parent: null }, null));
  const cols = calls.flatMap((x) => x.cols).concat([{ name: 'ordinality', type: B.int8 }]);
  const rows = drive(K.Exec.all({ op: 'Func', calls, ordinality: true, cols }, newCtx())).value;
  check('Func node', fmt(rows, cols), '1|a|1\n2|b|2\n3||3');
  check('Func column names', cols.map((x) => x.name).join(','), 'generate_series,unnest,ordinality');
}

// ---- SQL cases -------------------------------------------------------------------------------------------------
function kwery(sql) {
  try {
    const plan = new K.Binder(session).query(K.parse(sql)[0], null);
    const rows = drive(K.Exec.all(plan, newCtx())).value;
    return fmt(rows, plan.cols.filter((x) => !x.hidden));
  } catch (e) { return 'ERROR:  ' + e.message; }
}
function postgres(sql) {
  try {
    return execFileSync('/opt/homebrew/opt/postgresql@17/bin/psql', ['-h', '/Users/jmishra/.kwery-pg/sock', '-p', '5544', '-d', 'postgres', '-XAtq', '-F|', '-v', 'ON_ERROR_STOP=1', '-c', 'set timezone=UTC', '-c', sql], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\n$/, '');
  } catch (e) { return String(e.stderr).split('\n')[0].replace(/^psql:.*?ERROR/, 'ERROR'); }
}
const CASES = [
  ["select count(*), count(x), sum(x), avg(x), min(x), max(x) from (values (1),(2),(null),(4)) v(x)", "4|3|7|2.3333333333333333|1|4"],
  ["select count(*), sum(x), avg(x), min(x) from (values (1)) v(x) where x > 5", "0|||"],
  ["select sum(x::int8), avg(x::int8), sum(x::numeric), avg(x::numeric(10,2)), sum(x::float4), avg(x::float4), sum(x::float8) from (values (10000),(3),(1)) v(x)", "10004|3334.6666666666666667|10004|3334.6666666666666667|10004|3334.6666666666665|10004"],
  ["select avg(x), sum(x) from (values (1.25),(1.125)) v(x)", "1.18750000000000000000|2.375"],
  ["select avg(x), sum(x) from (values (0),(0)) v(x)", "0.00000000000000000000|0"],
  ["select avg(x) from (values (100000000),(2)) v(x)", "50000001.000000000000"],
  ["select avg(x) from (values (0.001),(0.0002)) v(x)", "0.00060000000000000000"],
  ["select avg(x), sum(x) from (values ('1 mon'::interval),('1 day 3 hours'), ('7 sec')) v(x)", "10 days 09:00:02.333333|1 mon 1 day 03:00:07"],
  ["select min(x), max(x) from (values ('b'),('a'),('c')) v(x)", "a|c"],
  ["select min(x), max(x) from (values ('2020-01-02'::date),('2019-05-01')) v(x)", "2019-05-01|2020-01-02"],
  ["select min(x), max(x) from (values (array[1,2]),(array[1,3]),(array[0,9])) v(x)", "{0,9}|{1,3}"],
  ["select bool_and(x), bool_or(x), every(x) from (values (true),(false),(null)) v(x)", "f|t|f"],
  ["select bit_and(x), bit_or(x), bit_xor(x) from (values (12),(10),(6)) v(x)", "0|14|0"],
  ["select bit_and(x::int8), bit_or(x::int2), bit_xor(x::int8) from (values (-12),(10),(6)) v(x)", "0|-2|-8"],
  ["select string_agg(x, y) from (values ('a',','),('b','-'),(null,'+'),('c',null)) v(x,y)", "a-bc"],
  ["select string_agg(x, ',' order by x desc) from (values ('a'),('c'),('b')) v(x)", "c,b,a"],
  ["select string_agg(distinct x, ',') from (values ('a'),('c'),('a')) v(x)", "a,c"],
  ["select array_agg(x) from (values (array[1,2]),(array[3,4])) v(x)", "{{1,2},{3,4}}"],
  ["select array_agg(x) from (values (array[1,2]),(array[3])) v(x)", "ERROR:  cannot accumulate arrays of different dimensionality"],
  ["select array_agg(x) from (values (array[1,2]),(null)) v(x)", "ERROR:  cannot accumulate null arrays"],
  ["select json_agg(x), jsonb_agg(x) from (values (1),(null),(3)) v(x)", "[1, null, 3]|[1, null, 3]"],
  ["select json_agg(array[x,x]) from (values (1),(null),(3)) v(x)", "[[1,1], \n [null,null], \n [3,3]]"],
  ["select json_object_agg('k'||coalesce(x,0), x), jsonb_object_agg('k'||coalesce(x,0), x) from (values (1),(null),(3)) v(x)", "{ \"k1\" : 1, \"k0\" : null, \"k3\" : 3 }|{\"k0\": null, \"k1\": 1, \"k3\": 3}"],
  ["select json_object_agg(x, y), jsonb_object_agg(x,y) from (values ('b',1),('a',2),('b',3)) v(x,y)", "{ \"b\" : 1, \"a\" : 2, \"b\" : 3 }|{\"a\": 2, \"b\": 3}"],
  ["select json_agg(x), jsonb_agg(x) from (values ('2020-01-01 10:00:00.5'::timestamp)) v(x)", "[\"2020-01-01T10:00:00.5\"]|[\"2020-01-01T10:00:00.5\"]"],
  ["select json_agg(x), jsonb_agg(x) from (values ('2020-01-01 10:00:00+02'::timestamptz)) v(x)", "[\"2020-01-01T08:00:00+00:00\"]|[\"2020-01-01T08:00:00+00:00\"]"],
  ["select json_agg(x) from (values (1.5::float8),('Infinity'), (1e20)) v(x)", "[1.5, \"Infinity\", 1e+20]"],
  ["select jsonb_agg(x) from (values (1.5::float8),('NaN'), (1e20)) v(x)", "[1.5, \"NaN\", 100000000000000000000]"],
  ["select json_agg(x) from (values ('a\"b'),('c\\d')) v(x)", "[\"a\\\"b\", \"c\\\\d\"]"],
  ["select json_agg(x), jsonb_agg(x) from (values ('{\"a\": 1,  \"b\":2}'::json), ('[1,2]')) v(x)", "[{\"a\": 1,  \"b\":2}, [1,2]]|[{\"a\": 1, \"b\": 2}, [1, 2]]"],
  ["select json_agg(x) from (values (true), (false)) v(x)", "[true, false]"],
  ["select json_agg(v) from (values (1,'a'),(2,'b')) v(x,y)", "[{\"x\":1,\"y\":\"a\"}, \n {\"x\":2,\"y\":\"b\"}]"],
  ["select jsonb_agg(v) from (values (1,'a'),(2,'b')) v(x,y)", "[{\"x\": 1, \"y\": \"a\"}, {\"x\": 2, \"y\": \"b\"}]"],
  ["select json_object_agg(x, y) from (values (null,1)) v(x,y)", "ERROR:  null value not allowed for object key"],
  ["select variance(x), stddev_pop(x), var_pop(x), stddev(x) from (values (1),(1)) v(x)", "0|0|0|0"],
  ["select variance(x), stddev(x), var_pop(x), stddev_pop(x), var_samp(x), stddev_samp(x) from (values (1.5),(2.25),(3)) v(x)", "0.56250000000000000000|0.75000000000000000000|0.37500000000000000000|0.61237243569579452455|0.56250000000000000000|0.75000000000000000000"],
  ["select variance(x), stddev(x) from (values (1),(2),(3),(4),(10)) v(x)", "12.5000000000000000|3.5355339059327376"],
  ["select variance(x), stddev(x), var_pop(x) from (values (1)) v(x)", "||0"],
  ["select variance(x), stddev(x), var_pop(x), stddev_pop(x) from (values (1e10::float8),(2.5),(3)) v(x)", "3.3333333315e+19|5773502690.308544|2.222222221e+19|4714045206.613955"],
  ["select variance(x::float4), stddev(x::float4) from (values (1.1),(2.2),(3.3)) v(x)", "1.2099999213218715|1.0999999642372138"],
  ["select variance(x), stddev(x) from (values (123456789012),(98765432109),(5)) v(x)", "4267642072720012610712|65327192445"],
  ["select variance(x), stddev(x) from (values (0.000001),(0.000003)) v(x)", "0.0000000000020000000000000000|0.0000014142135623730950488017"],
  ["select corr(y,x), covar_pop(y,x), covar_samp(y,x), regr_slope(y,x), regr_intercept(y,x), regr_r2(y,x), regr_count(y,x) from (values (1,2),(2,3.5),(3,7),(4,null)) v(x,y)", "0.9743547036924464|1.6666666666666667|2.5|2.5|-0.8333333333333334|0.949367088607595|3"],
  ["select corr(y,x), regr_r2(y,x), regr_slope(y,x) from (values (1,5),(2,5),(3,5)) v(x,y)", "|1|0"],
  ["select corr(y,x), covar_samp(y,x) from (values (1,5)) v(x,y)", "|"],
  ["select mode() within group (order by x), percentile_cont(0.3) within group (order by x), percentile_disc(0.3) within group (order by x) from (values (1),(2),(2),(5),(null)) v(x)", "2|1.9|2"],
  ["select percentile_cont(array[0, 0.25, null, 1]) within group (order by x), percentile_disc(array[0.5,1]) within group (order by x) from (values (1),(2),(2),(5),(null)) v(x)", "{1,1.75,NULL,5}|{2,5}"],
  ["select percentile_cont(0.3) within group (order by x) from (values ('1 day'::interval),('3 days 5 hours')) v(x)", "1 day 15:54:00"],
  ["select percentile_cont(0.5) within group (order by x desc) from (values (1),(2),(10)) v(x)", "2"],
  ["select percentile_disc(0.5) within group (order by x) from (values ('b'),('a'),('c'),('d')) v(x)", "b"],
  ["select percentile_cont(1.5) within group (order by x) from (values (1)) v(x)", "ERROR:  percentile value 1.5 is not between 0 and 1"],
  ["select mode() within group (order by x) from (values ('b'),('a'),('b'),('a')) v(x)", "a"],
  ["select percentile_cont(0.5) within group (order by x), mode() within group (order by x) from (values (1)) v(x) where false", "|"],
  ["select rank(3) within group (order by x), dense_rank(3) within group (order by x), percent_rank(3) within group (order by x), cume_dist(3) within group (order by x) from (values (1),(3),(3),(5)) v(x)", "2|2|0.25|0.8"],
  ["select rank(3) within group (order by x desc), dense_rank(1, 'b') within group (order by x, y) from (values (1, 'a'),(3, 'c'),(3,'a'),(5,'z'),(1,'c')) v(x, y)", "2|2"],
  ["select count(distinct x), sum(distinct x), avg(distinct x) from (values (1),(1),(2),(null)) v(x)", "2|3|1.5000000000000000"],
  ["select count(*) filter (where x > 1), sum(x) filter (where x < 3) from (values (1),(2),(3)) v(x)", "2|3"],
  ["select x % 2, count(*), sum(x), array_agg(x order by x) from (values (1),(2),(3),(4),(5)) v(x) group by x % 2 order by 1", "0|2|6|{2,4}\n1|3|9|{1,3,5}"],
  ["select any_value(x) from (values (null),(5),(6)) v(x)", "5"],
  ["select x, row_number() over (order by x), row_number() over (order by x desc), sum(x) over (partition by x%2) from (values (1),(2),(3),(4)) v(x)", "1|1|4|4\n2|2|3|6\n3|3|2|4\n4|4|1|6"],
  ["select x, sum(x) over (partition by x%2), row_number() over (order by x desc) from (values (1),(2),(3),(4)) v(x)", "4|6|1\n2|6|3\n3|4|2\n1|4|4"],
  ["select x, sum(x) over (partition by x%2 order by x), row_number() over (partition by x%2) from (values (1),(2),(3),(4)) v(x)", "2|2|1\n4|6|2\n1|1|1\n3|4|2"],
  ["select x, y, rank() over (partition by y order by x desc), sum(x) over (partition by y) from (values (1,'a'),(2,'a'),(2,'b'),(3,'a'),(null,'c'),(5,null),(6,null)) v(x,y)", "3|a|1|6\n2|a|2|6\n1|a|3|6\n2|b|1|2\n|c|1|\n6||1|11\n5||2|11"],
  ["select x, ntile(3) over (order by x), ntile(4) over (order by x), ntile(10) over (order by x) from (values (1),(2),(3),(4),(5),(6),(7)) v(x)", "1|1|1|1\n2|1|1|2\n3|1|2|3\n4|2|2|4\n5|2|3|5\n6|3|3|6\n7|3|4|7"],
  ["select x, lag(x) over (order by x), lead(x) over (order by x), lag(x, 2, -1) over (order by x), lead(x, 2, 0.5) over (order by x) from (values (1),(2),(3),(4)) v(x)", "1||2|-1|3\n2|1|3|-1|4\n3|2|4|1|0.5\n4|3||2|0.5"],
  ["select x, lag(x, -1) over (order by x), lead(x, 0) over (order by x) from (values (1),(2),(3)) v(x)", "1|2|1\n2|3|2\n3||3"],
  ["select x, first_value(x) over (order by x), last_value(x) over (order by x), nth_value(x, 2) over (order by x) from (values (1),(2),(2),(3)) v(x)", "1|1|1|\n2|1|2|2\n2|1|2|2\n3|1|3|2"],
  ["select x, sum(x) over (order by x rows between unbounded preceding and current row), sum(x) over (order by x), sum(x) over () from (values (1),(2),(2),(3)) v(x)", "1|1|1|8\n2|3|5|8\n2|5|5|8\n3|8|8|8"],
  ["select x, sum(x) over (order by x rows 2 preceding), count(*) over (order by x rows between current row and unbounded following) from (values (1),(2),(2),(3),(7)) v(x)", "1|1|5\n2|3|4\n2|5|3\n3|7|2\n7|12|1"],
  ["select x, sum(x) over (order by x range between 1 preceding and 1 following), count(*) over (order by x range between current row and 2 following) from (values (1),(2),(2),(3),(7),(8)) v(x)", "1|5|4\n2|8|3\n2|8|3\n3|7|1\n7|15|2\n8|15|1"],
  ["select x, sum(x) over (order by x desc range between 1 preceding and 1 following), array_agg(x) over (order by x desc range between 2 preceding and current row) from (values (1),(2),(2),(3),(7),(8)) v(x)", "8|15|{8}\n7|15|{8,7}\n3|7|{3}\n2|8|{3,2,2}\n2|8|{3,2,2}\n1|5|{3,2,2,1}"],
  ["select x, array_agg(x) over (order by x range between 1 preceding and 1 following) from (values (1),(2),(null),(3),(null)) v(x)", "1|{1,2}\n2|{1,2,3}\n3|{2,3}\n|{NULL,NULL}\n|{NULL,NULL}"],
  ["select x, array_agg(x) over (order by x nulls first range between 1 preceding and unbounded following) from (values (1),(2),(null),(3),(null)) v(x)", "|{NULL,NULL,1,2,3}\n|{NULL,NULL,1,2,3}\n1|{1,2,3}\n2|{1,2,3}\n3|{2,3}"],
  ["select x, array_agg(x) over (order by x groups between 1 preceding and 1 following), array_agg(x) over (order by x groups between current row and 1 following exclude current row) from (values (1),(2),(2),(3),(7)) v(x)", "1|{1,2,2}|{2,2}\n2|{1,2,2,3}|{2,3}\n2|{1,2,2,3}|{2,3}\n3|{2,2,3,7}|{7}\n7|{3,7}|"],
  ["select x, array_agg(x) over (order by x rows between unbounded preceding and unbounded following exclude group), array_agg(x) over (order by x rows between unbounded preceding and unbounded following exclude ties) from (values (1),(2),(2),(3)) v(x)", "1|{2,2,3}|{1,2,2,3}\n2|{1,3}|{1,2,3}\n2|{1,3}|{1,2,3}\n3|{1,2,2}|{1,2,2,3}"],
  ["select x, array_agg(x) over (order by x range between unbounded preceding and current row exclude current row), sum(x) over (order by x rows between 1 following and 3 following) from (values (1),(2),(2),(3)) v(x)", "1||7\n2|{1,2}|5\n2|{1,2}|3\n3|{1,2,2}|"],
  ["select x, sum(x) over (order by x range between 0.5 preceding and 1.5 following) from (values (1.0),(1.5),(2.0),(4.5)) v(x)", "1.0|4.5\n1.5|4.5\n2.0|3.5\n4.5|4.5"],
  ["select x, sum(x) over (order by x range between 1.5 preceding and current row) from (values (1.0::float8),(1.5),(2.0),(4.5)) v(x)", "1|1\n1.5|2.5\n2|4.5\n4.5|4.5"],
  ["select d, count(*) over (order by d range between interval '1 day' preceding and current row), count(*) over (order by d range between '1 mon' preceding and '1 day' following) from (values ('2020-01-01'::date),('2020-01-02'),('2020-01-05'),('2020-02-01'),('2020-02-02')) v(d)", "2020-01-01|1|2\n2020-01-02|2|2\n2020-01-05|1|3\n2020-02-01|1|5\n2020-02-02|2|4"],
  ["select t, count(*) over (order by t range between interval '1 hour' preceding and current row) from (values ('2020-01-01 10:00'::timestamp),('2020-01-01 10:30'),('2020-01-01 11:30'),('2020-01-01 11:31')) v(t)", "2020-01-01 10:00:00|1\n2020-01-01 10:30:00|2\n2020-01-01 11:30:00|2\n2020-01-01 11:31:00|2"],
  ["select x, sum(x) over (order by x rows between -1 preceding and current row) from (values (1)) v(x)", "ERROR:  frame starting offset must not be negative"],
  ["select x, sum(x) over (order by x range between -1 preceding and current row) from (values (1)) v(x)", "ERROR:  invalid preceding or following size in window function"],
  ["select x, sum(x) over (order by x, x range between 1 preceding and current row) from (values (1)) v(x)", "1|1"],
  ["select x, sum(x) over (order by x rows between current row and 1 preceding) from (values (1)) v(x)", "ERROR:  frame starting from current row cannot have preceding rows"],
  ["select x, ntile(0) over () from (values (1)) v(x)", "ERROR:  argument of ntile must be greater than zero"],
  ["select x, nth_value(x, 0) over () from (values (1)) v(x)", "ERROR:  argument of nth_value must be greater than zero"],
  ["select x, avg(x) over (order by x rows between 1 preceding and 1 following), stddev(x) over (order by x rows between 1 preceding and 1 following) from (values (1),(2),(4),(8)) v(x)", "1|1.5000000000000000|0.70710678118654752440\n2|2.3333333333333333|1.5275252316519467\n4|4.6666666666666667|3.0550504633038933\n8|6.0000000000000000|2.8284271247461901"],
  ["select x, count(*) filter (where x > 1) over (order by x), string_agg(x::text, ',') over (order by x desc) from (values (1),(2),(3)) v(x)", "1|0|3,2,1\n2|1|3,2\n3|2|3"],
  ["select x % 3 as g, sum(x), rank() over (order by sum(x) desc) from (values (1),(2),(3),(4),(5),(6)) v(x) group by x % 3", "0|9|1\n2|7|2\n1|5|3"],
  ["select x, row_number() over (), sum(x) over (order by x) from (values (3),(1),(2)) v(x)", "1|1|1\n2|2|3\n3|3|6"],
  ["select x, y, first_value(y) over (partition by x order by y desc), count(*) over (partition by x) from (values (1,'a'),(2,'b'),(1,'c'),(null,'d'),(2,null)) v(x,y)", "1|c|c|2\n1|a|c|2\n2|||2\n2|b||2\n|d|d|1"],
  ["select x, percent_rank() over (order by x), cume_dist() over (order by x desc) from (values (1)) v(x)", "1|0|1"],
  ["select x, sum(x) over (order by x groups between 1 preceding and current row exclude group) from (values (1),(1),(2),(3),(3)) v(x)", "1|\n1|\n2|2\n3|2\n3|2"],
  ["select x, last_value(x) over (order by x groups between current row and 1 following) from (values (1),(1),(2),(3),(3)) v(x)", "1|2\n1|2\n2|3\n3|3\n3|3"],
  ["select x, array_agg(x) over (order by x rows between 2 following and 4 following) from (values (1),(2),(3),(4),(5)) v(x)", "1|{3,4,5}\n2|{4,5}\n3|{5}\n4|\n5|"],
  ["select x, sum(x) over (order by x range between unbounded preceding and 2 preceding) from (values (1),(2),(3),(4),(5)) v(x)", "1|\n2|\n3|1\n4|3\n5|6"],
  ["select x, sum(x) over (order by x range between 1 following and unbounded following) from (values (1),(2),(3),(4),(5)) v(x)", "1|14\n2|12\n3|9\n4|5\n5|"],
  ["select * from generate_series(1,3)", "1\n2\n3"],
  ["select * from generate_series(1,10,3) as g", "1\n4\n7\n10"],
  ["select * from generate_series(5,1,-2) with ordinality", "5|1\n3|2\n1|3"],
  ["select * from generate_series(1, 3.5)", "1\n2\n3"],
  ["select * from generate_series(0.5, 2, 0.75)", "0.5\n1.25\n2.00"],
  ["select * from generate_series(1::int8, 3)", "1\n2\n3"],
  ["select * from generate_series(2147483646, 2147483647)", "2147483646\n2147483647"],
  ["select * from generate_series(1, 10, 0)", "ERROR:  step size cannot equal zero"],
  ["select * from generate_series('2020-01-01'::date, '2020-01-03'::date, '1 day')", "2020-01-01 00:00:00+00\n2020-01-02 00:00:00+00\n2020-01-03 00:00:00+00"],
  ["select * from generate_series('2020-03-01 00:00+00'::timestamptz, '2020-03-01 02:00+00', '45 min')", "2020-03-01 00:00:00+00\n2020-03-01 00:45:00+00\n2020-03-01 01:30:00+00"],
  ["select * from generate_series(3, 1)", ""],
  ["select * from unnest(array[1,2,3])", "1\n2\n3"],
  ["select * from unnest(array[[1,2],[3,4]]) as u", "1\n2\n3\n4"],
  ["select * from unnest(array[1,2], array['a','b','c']) with ordinality as u", "1|a|1\n2|b|2\n|c|3"],
  ["select * from unnest(null::int[])", ""],
  ["select * from unnest(array[1,2]) as u(v)", "1\n2"],
  ["select * from rows from (generate_series(1,2), unnest(array['a','b','c'])) as t", "1|a\n2|b\n|c"],
  ["select * from rows from (generate_series(1,2)) as t", "1\n2"],
  ["select * from rows from (generate_series(1,2), generate_series(5,7)) with ordinality as t(a, b, n)", "1|5|1\n2|6|2\n|7|3"],
  ["select * from generate_subscripts(array[3,4,5],1)", "1\n2\n3"],
  ["select * from generate_subscripts(array[3,4,5],1, true)", "3\n2\n1"],
  ["select * from generate_subscripts(array[[1,2,3],[4,5,6]], 2)", "1\n2\n3"],
  ["select * from generate_subscripts(array[3,4,5], 2)", ""],
  ["select * from json_each('{\"a\":[1,2],  \"b\":\"x\", \"a\":null}')", "a|[1,2]\nb|\"x\"\na|null"],
  ["select * from json_each_text('{\"a\":[1,2],  \"b\":\"x\", \"c\":null}')", "a|[1,2]\nb|x\nc|"],
  ["select * from jsonb_each('{\"b\":[1,2],  \"a\":\"x\", \"c\":null}')", "a|\"x\"\nb|[1, 2]\nc|null"],
  ["select * from jsonb_each_text('{\"b\":[1, 2],  \"a\":\"x\", \"c\":null}')", "a|x\nb|[1, 2]\nc|"],
  ["select * from json_array_elements('[1, \"a\", {\"b\" : 2}, null]')", "1\n\"a\"\n{\"b\" : 2}\nnull"],
  ["select * from json_array_elements_text('[1, \"a\", {\"b\" : 2}, null]')", "1\na\n{\"b\" : 2}\n"],
  ["select * from jsonb_array_elements('[1, \"a\", {\"b\" : 2}, null]')", "1\n\"a\"\n{\"b\": 2}\nnull"],
  ["select * from jsonb_array_elements_text('[1, \"a\", {\"b\" : 2}, null]')", "1\na\n{\"b\": 2}\n"],
  ["select * from json_object_keys('{\"b\":1, \"a\":2, \"b\":3}')", "b\na\nb"],
  ["select * from jsonb_object_keys('{\"b\":1, \"a\":2, \"b\":3}')", "a\nb"],
  ["select * from json_array_elements('{\"a\":1}')", "ERROR:  cannot call json_array_elements on a non-array"],
  ["select * from jsonb_array_elements('3')", "ERROR:  cannot extract elements from a scalar"],
  ["select * from json_each('[1]')", "ERROR:  cannot deconstruct an array as an object"],
  ["select * from jsonb_object_keys('[1]')", "ERROR:  cannot call jsonb_object_keys on an array"],
  ["select * from jsonb_to_record('{\"a\":\"5\",\"b\":[1,2],\"c\":{\"x\":1},\"d\":true,\"e\":1.5}') as x(a int, b int[], c jsonb, d text, e numeric, f text)", "5|{1,2}|{\"x\": 1}|true|1.5|"],
  ["select * from json_to_record('{\"a\":5,\"b\":\"2020-01-01\"}') as x(a int, b date)", "5|2020-01-01"],
  ["select * from jsonb_to_recordset('[{\"a\":1,\"b\":\"x\"},{\"a\":2}]') as x(a int, b text)", "1|x\n2|"],
  ["select * from jsonb_to_record('{\"a\":1}')", "ERROR:  a column definition list is required for functions returning \"record\""],
  ["select * from regexp_matches('abcabc','(b)(c)','g')", "{b,c}\n{b,c}"],
  ["select * from regexp_matches('abcabc','b(x)?c','g')", "{NULL}\n{NULL}"],
  ["select * from regexp_matches('abc', '')", "{\"\"}"],
  ["select * from regexp_matches('aXbX', 'x', 'gi')", "{X}\n{X}"],
  ["select * from regexp_matches('foo', 'z')", ""],
  ["select * from regexp_matches('foo bar baz', '\\w+', 'g') with ordinality", "{foo}|1\n{bar}|2\n{baz}|3"],
  ["select * from regexp_split_to_table('hello', '')", "h\ne\nl\nl\no"],
  ["select * from regexp_split_to_table('a1b22c', '\\d*')", "a\nb\nc"],
  ["select * from regexp_split_to_table('the quick  brown', '\\s+')", "the\nquick\nbrown"],
  ["select * from regexp_split_to_table('ab', 'x*')", "a\nb"],
  ["select * from regexp_split_to_table('a,b', ',', 'g')", "ERROR:  regexp_split_to_table() does not support the \"global\" option"],
  ["select * from string_to_table('a,b,,c', ',', '')", "a\nb\n\nc"],
  ["select * from string_to_table('abc', null)", "a\nb\nc"],
  ["select * from string_to_table('abc', '')", "abc"],
  ["select * from string_to_table('', ',')", ""],
  ["select * from generate_series(1,3) g where g > 1", "2\n3"],
  ["select g, sum(g) over (order by g) from generate_series(1,4) g", "1|1\n2|3\n3|6\n4|10"],
  ["select count(*), sum(g), avg(g) from generate_series(1,100) g", "100|5050|50.5000000000000000"],
  ["select * from json_array_elements('3')", "ERROR:  cannot call json_array_elements on a scalar"],
  ["select * from json_array_elements_text('{}')", "ERROR:  cannot call json_array_elements_text on a non-array"],
  ["select * from jsonb_array_elements('{}')", "ERROR:  cannot extract elements from an object"],
  ["select * from json_each('3')", "ERROR:  cannot deconstruct a scalar"],
  ["select * from json_each_text('[]')", "ERROR:  cannot deconstruct an array as an object"],
  ["select * from jsonb_each('[]')", "ERROR:  cannot call jsonb_each on a non-object"],
  ["select * from json_object_keys('3')", "ERROR:  cannot call json_object_keys on a scalar"],
  ["select * from jsonb_to_record('[]') as x(a int)", "ERROR:  cannot call populate_composite on an array"],
  ["select * from jsonb_to_recordset('{}') as x(a int)", "ERROR:  cannot call jsonb_to_recordset on a non-array"],
  ["select * from jsonb_to_recordset('[1]') as x(a int)", "ERROR:  argument of jsonb_to_recordset must be an array of objects"],
  ["select * from json_each(null)", ""],
  ["select * from generate_series('2020-01-31 00:00'::timestamp, '2020-05-01 00:00', '1 month')", "2020-01-31 00:00:00\n2020-02-29 00:00:00\n2020-03-29 00:00:00\n2020-04-29 00:00:00"],
  ["select * from generate_series('2020-01-31 00:00'::timestamp, '2020-01-01 00:00', '-1 week')", "2020-01-31 00:00:00\n2020-01-24 00:00:00\n2020-01-17 00:00:00\n2020-01-10 00:00:00\n2020-01-03 00:00:00"],
  ["select * from generate_series(1.5, 0, -0.5)", "1.5\n1.0\n0.5\n0.0"],
  ["select avg(x), variance(x), stddev(x) from (values (1.123456789),(2.987654321),(3.5),(100.25)) v(x)", "26.9652777775000000|2387.998637009199601179|48.867152945605492898"],
  ["select avg(x), variance(x), stddev(x), var_pop(x) from (values (12345678901234567890),(1),(2)) v(x)", "4115226300411522631|50805262510796122488289387723771782811|7127781036956461003|33870175007197414992192925149181188541"],
  ["select avg(x::int2), sum(x::int2), variance(x::int2) from (values (1),(2),(4)) v(x)", "2.3333333333333333|7|2.3333333333333333"],
  ["select avg(x) from (values (1),(2),(3)) v(x)", "2.0000000000000000"],
  ["select avg(x) from (values (-7),(2)) v(x)", "-2.5000000000000000"],
  ["select avg(x), sum(x) from (values (1.5::float4),(2.25),(1e-7)) v(x)", "1.2500000333333336|3.75"],
  ["select sum(x) from (values (9223372036854775807),(1)) v(x)", "9223372036854775808"],
  ["select sum(x::int8) from (values (2147483647),(2147483647)) v(x)", "4294967294"],
  ["select max(x), min(x) from (values (1.5),(1.50),(2)) v(x)", "2|1.50"],
  ["select x, sum(x) over (order by x), avg(x) over (order by x) from (values (1.5),(2.5),(2.5),(4)) v(x)", "1.5|1.5|1.50000000000000000000\n2.5|6.5|2.1666666666666667\n2.5|6.5|2.1666666666666667\n4|10.5|2.6250000000000000"],
  ["select x, count(x) over (order by x rows between 5 preceding and 4 preceding) from (values (1),(2),(3)) v(x)", "1|0\n2|0\n3|0"],
  ["select x, y, sum(x) over (partition by y order by x), row_number() over (order by y desc, x), lag(y) over (order by x) from (values (1,'a'),(2,'b'),(3,'a'),(4,'b'),(5,'a')) v(x,y)", "1|a|1|3|\n2|b|2|1|a\n3|a|4|4|b\n4|b|6|2|a\n5|a|9|5|b"],
  ["select x, y, dense_rank() over (order by y), rank() over (partition by y order by x), count(*) over (partition by y), max(x) over (order by y, x) from (values (1,'a'),(2,'b'),(3,'a'),(4,'b'),(5,'a')) v(x,y)", "1|a|1|1|3|1\n3|a|1|2|3|3\n5|a|1|3|3|5\n2|b|2|1|2|5\n4|b|2|2|2|5"],
  ["select x, json_agg(x) over (order by x), jsonb_agg(x) over (order by x rows between 1 preceding and current row) from (values (1),(2),(3)) v(x)", "1|[1]|[1]\n2|[1, 2]|[1, 2]\n3|[1, 2, 3]|[2, 3]"],
  ["select x, percent_rank() over (partition by x > 2 order by x), cume_dist() over (partition by x > 2 order by x) from (values (1),(2),(3),(4),(5)) v(x)", "1|0|0.5\n2|1|1\n3|0|0.3333333333333333\n4|0.5|0.6666666666666666\n5|1|1"],
  ["select x, lead(x, 1, x) over (order by x) from (values (1),(2),(3)) v(x)", "1|2\n2|3\n3|3"],
  ["select x, lag(x, null) over (order by x) from (values (1),(2),(3)) v(x)", "1|\n2|\n3|"],
  ["select x, nth_value(x, null) over (order by x) from (values (1),(2),(3)) v(x)", "1|\n2|\n3|"],
  ["select x, ntile(null) over (order by x) from (values (1),(2),(3)) v(x)", "1|\n2|\n3|"],
  ["select x, first_value(x) over (order by x desc nulls last), last_value(x) over (order by x desc nulls last range between current row and unbounded following) from (values (1),(null),(3)) v(x)", "3|3|\n1|3|\n|3|"],
  ["select x, sum(x) over (order by x rows between unbounded following and current row) from (values (1)) v(x)", "ERROR:  frame start cannot be UNBOUNDED FOLLOWING"],
  ["select x, sum(x) over (order by x rows between current row and unbounded preceding) from (values (1)) v(x)", "ERROR:  frame end cannot be UNBOUNDED PRECEDING"],
  ["select x, sum(x) over (order by x rows between 1 following and current row) from (values (1)) v(x)", "ERROR:  frame starting from following row cannot have preceding rows"],
  ["select x, sum(x) over (order by x rows between null preceding and current row) from (values (1)) v(x)", "ERROR:  frame starting offset must not be null"],
  ["select x, sum(x) over (order by x range between '1 day' preceding and current row) from (values (1)) v(x)", "ERROR:  invalid input syntax for type integer: \"1 day\""],
  ["select d, count(*) over (order by d range between '1 day' preceding and current row) from (values ('2020-01-01'::date),('2020-01-02')) v(d)", "2020-01-01|1\n2020-01-02|2"],
  ["select x, min(x) over (order by x range between 2 preceding and 2 preceding), max(x) over (order by x range between 2 following and 2 following) from (values (1),(2),(3),(4),(6)) v(x)", "1||3\n2||4\n3|1|\n4|2|6\n6|4|"],
  ["select x, count(*) over (order by x groups 1 preceding exclude ties) from (values (1),(1),(2),(3),(3)) v(x)", "1|1\n1|1\n2|3\n3|2\n3|2"],
  ["select x, array_agg(x) over (order by x rows between unbounded preceding and current row exclude current row) from (values (1),(2),(3)) v(x)", "1|\n2|{1}\n3|{1,2}"],
  ["select x, string_agg(y, ',') over (order by x range unbounded preceding exclude group) from (values (1,'a'),(1,'b'),(2,'c')) v(x,y)", "1|\n1|\n2|a,b"],
  ["select x, bool_and(x > 1) over (order by x), every(x < 3) over () from (values (1),(2),(3)) v(x)", "1|f|f\n2|f|f\n3|f|f"],
  ["select x, array_agg(x) over (partition by x is null order by x nulls first range between 1 preceding and 1 following) from (values (1),(2),(null),(4),(null)) v(x)", "1|{1,2}\n2|{1,2}\n4|{4}\n|{NULL,NULL}\n|{NULL,NULL}"],
];
for (const [sql, want] of CASES) check(sql, kwery(sql), LIVE ? postgres(sql) : want);

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
