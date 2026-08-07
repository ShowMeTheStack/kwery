// Writes src/data/sensors.sql: sensors at a few sites and three days of their readings, one every 15 minutes
// (temperature follows the day, humidity moves against it, pressure drifts, CO2 rises in working hours), with a
// few readings missing and a few spikes, for window functions: moving averages, differences from the previous
// reading, gaps, per-hour buckets and ranking. The values are computed here and written as literals.
import { rng, insert, write, stamp } from './sample-lib.mjs';
const { int, chance, rnd } = rng(20250808);

const site = [[1, 'North Greenhouse', 'Alderton', 40], [2, 'Riverside Depot', 'Brookhaven', 12], [3, 'Hilltop Station', 'Glenrock', 820], [4, 'Harbor Office', 'Fairport', 5]];
const kinds = [['temperature', 'C'], ['humidity', '%'], ['pressure', 'hPa'], ['co2', 'ppm']];
const sensor = [];
for (const s of site) for (const [k, u] of kinds) sensor.push([sensor.length + 1, s[0], k, u, '2024-0' + int(1, 9) + '-' + String(int(10, 28)), !(s[0] === 2 && k === 'co2')]);
// the CO2 sensor at the depot was switched off: no readings
const reading = [];
const start = '2024-10-01 00:00:00';
const noise = () => (rnd() + rnd() + rnd() - 1.5);
for (const s of sensor) {
  if (!s[5]) continue;
  const st = site[s[1] - 1];
  let drift = 0;
  for (let i = 0; i < 3 * 96; i++) {
    const hour = (i / 4) % 24;
    const dayWave = Math.sin(((hour - 9) / 24) * 2 * Math.PI);
    if (chance(0.015)) continue;
    let v;
    if (s[2] === 'temperature') v = 14 - st[3] / 150 + 6 * dayWave + noise() * 0.6 + (st[0] === 1 ? 8 : 0);
    else if (s[2] === 'humidity') v = Math.min(100, Math.max(5, 65 - 18 * dayWave + noise() * 3 + (st[0] === 1 ? 15 : 0)));
    else if (s[2] === 'pressure') { drift += noise() * 0.15; v = 1013 - st[3] / 8.3 + drift + 3 * Math.sin(i / 60); }
    else v = 420 + (hour >= 8 && hour < 18 ? 350 * Math.sin(((hour - 8) / 10) * Math.PI) : 0) + noise() * 15;
    if (chance(0.004)) v = s[2] === 'pressure' ? v - 40 : v * 3;
    reading.push([s[0], stamp(start, i * 15), v.toFixed(2)]);
  }
}

write('sensors.sql', [
  '-- Sensors at four sites and three days of readings every 15 minutes, made up for Kwery.',
  `create table site (
  site_id integer primary key,
  name varchar(30) not null unique,
  city varchar(30) not null,
  elevation_m integer
);
create table sensor (
  sensor_id integer primary key,
  site_id integer not null references site (site_id),
  kind varchar(12) not null check (kind in ('temperature', 'humidity', 'pressure', 'co2')),
  unit varchar(4) not null,
  installed_on date not null,
  active boolean not null default true
);
create table reading (
  sensor_id integer references sensor (sensor_id) on delete cascade,
  read_at timestamp,
  value numeric(7,2) not null,
  primary key (sensor_id, read_at)
);`,
  insert('site', null, site), insert('sensor', null, sensor), insert('reading', null, reading),
  'create index reading_time on reading (read_at);',
], { site: site.length, sensor: sensor.length, reading: reading.length });
