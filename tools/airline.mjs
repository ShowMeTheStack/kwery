// Writes src/data/airline.sql: an airline of invented airports. Flights are daily routes with departure times and
// durations (three hubs, with spokes and a few direct routes, so "how do I get from X to Y with at most two
// changes" is a recursive query), aircraft with their seat maps, passengers, and a week of bookings with seats.
// The places, aircraft models and people are all invented.
import { rng, insert, write, FIRST, LAST, day, pad } from './sample-lib.mjs';
const { int, pick, chance, sample, rnd } = rng(20250606);

const airport = [
  ['ALD', 'Alderton International', 'Alderton', 'Norland', 51.2, -1.4], ['BRK', 'Brookhaven Field', 'Brookhaven', 'Norland', 53.4, -2.2], ['CDF', 'Cedar Falls Regional', 'Cedar Falls', 'Norland', 52.1, 0.9],
  ['DNM', 'Dunmore Airport', 'Dunmore', 'Norland', 55.9, -3.1], ['EST', 'Estmark Central', 'Estmark', 'Estmark', 50.1, 8.6], ['FRP', 'Fairport', 'Fairport', 'Estmark', 53.6, 10.0],
  ['GLN', 'Glenrock', 'Glenrock', 'Estmark', 48.4, 11.8], ['HRL', 'Harlow Airport', 'Harlow', 'Estmark', 52.4, 13.5], ['IVA', 'Ivanport', 'Ivanport', 'Sudria', 41.3, 2.1],
  ['JUN', 'Juniper Coast', 'Juniper', 'Sudria', 38.8, -0.3], ['KAL', 'Kalvara', 'Kalvara', 'Sudria', 40.5, -3.6], ['LMR', 'Lomira', 'Lomira', 'Sudria', 37.4, -5.9],
  ['MRV', 'Marrow Valley', 'Marrow', 'Westvale', 45.7, -73.7], ['NTH', 'Northam', 'Northam', 'Westvale', 43.7, -79.6], ['ORL', 'Orlen Bay', 'Orlen', 'Westvale', 44.9, -63.5],
  ['PIK', 'Pike Hill', 'Pike', 'Westvale', 49.2, -123.2], ['QRY', 'Quarry Point', 'Quarry', 'Estmark', 47.5, 19.3], ['RVS', 'Rivers End', 'Rivers End', 'Sudria', 36.7, -4.5],
];
const hubs = ['ALD', 'EST', 'NTH'];
const pos = new Map(airport.map((a) => [a[0], [a[4], a[5]]]));
const dist = (a, b) => { const [la1, lo1] = pos.get(a).map((x) => (x * Math.PI) / 180), [la2, lo2] = pos.get(b).map((x) => (x * Math.PI) / 180); const h = Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2; return Math.round(2 * 6371 * Math.asin(Math.sqrt(h))); };
const aircraft = [
  ['KW-101', 'Swift 140', 64, 3000], ['KW-102', 'Swift 140', 64, 3000], ['KW-103', 'Swift 140', 64, 3000], ['KW-104', 'Swift 140', 64, 3000],
  ['KW-201', 'Heron 220', 96, 6000], ['KW-202', 'Heron 220', 96, 6000], ['KW-203', 'Heron 220', 96, 6000], ['KW-204', 'Heron 220', 96, 6000],
  ['KW-301', 'Condor 300', 120, 12000], ['KW-302', 'Condor 300', 120, 12000], ['KW-303', 'Condor 300', 120, 12000], ['KW-304', 'Condor 300', 120, 12000],
];
// seat maps: four seats a row, the first rows business
const seat = [];
for (const a of aircraft) { const rows = a[2] / 4; for (let r = 1; r <= rows; r++) for (const l of 'ABCD') seat.push([a[0], r + l, r <= (a[2] === 64 ? 2 : 4) ? 'business' : 'economy']); }
// routes: spokes to their nearest hub (and some to a second), hubs to each other, a few direct routes
const pairs = new Set();
const route = (a, b) => { if (a !== b) { pairs.add(a + b); pairs.add(b + a); } };
for (let i = 0; i < hubs.length; i++) for (let j = i + 1; j < hubs.length; j++) route(hubs[i], hubs[j]);
for (const [c] of airport) {
  if (hubs.includes(c)) continue;
  const near = hubs.slice().sort((x, y) => dist(c, x) - dist(c, y));
  route(c, near[0]);
  if (chance(0.35)) route(c, near[1]);
}
for (const [x, y] of [['IVA', 'JUN'], ['KAL', 'LMR'], ['GLN', 'QRY'], ['BRK', 'DNM'], ['MRV', 'ORL'], ['LMR', 'RVS']]) route(x, y);
const flight = [];
let n = 100;
for (const p of [...pairs].sort()) {
  const [o, d] = [p.slice(0, 3), p.slice(3)];
  const km = dist(o, d);
  const dur = Math.round((km / 780) * 60 / 5) * 5 + 35;
  const plane = pick(aircraft.filter((a) => a[3] >= km));
  // one or two departures a day
  for (let k = 0; k < (hubs.includes(o) && hubs.includes(d) ? 2 : 1); k++) {
    const dep = int(6 * 12, 21 * 12) * 5;
    flight.push(['KW' + n++, o, d, pad(Math.floor(dep / 60), 2) + ':' + pad(dep % 60, 2), dur, km, plane[0]]);
  }
}
const passenger = [];
const pn = new Set();
while (passenger.length < 400) {
  const f = pick(FIRST), l = pick(LAST);
  if (pn.has(f + l)) continue;
  pn.add(f + l);
  passenger.push([passenger.length + 1, f + ' ' + l, day('1950-01-01', int(0, 20000)), chance(0.3) ? 'FF' + pad(int(10000, 99999), 5) : null]);
}
// a week of bookings
const booking = [];
for (let d = 0; d < 7; d++) {
  const date = day('2024-06-03', d);
  for (const f of flight) {
    const plane = aircraft.find((a) => a[0] === f[6]);
    const seats = seat.filter((s) => s[0] === plane[0]);
    const taken = sample(seats, Math.floor(seats.length * (0.03 + rnd() * 0.09)));
    const who = sample(passenger, taken.length);
    taken.forEach((s, i) => booking.push([0, who[i][0], f[0], date, s[1], ((s[2] === 'business' ? 2.8 : 1) * (40 + f[5] * 0.11) * (0.8 + rnd() * 0.6)).toFixed(2)]));
  }
}
booking.forEach((b, i) => { b[0] = i + 1; });

write('airline.sql', [
  '-- An airline: airports, aircraft and their seats, daily flights, passengers and a week of bookings, made up for\n-- Kwery. The airports and their countries are invented.',
  `create table airport (
  code char(3) primary key,
  name varchar(40) not null,
  city varchar(30) not null,
  country varchar(20) not null,
  latitude numeric(7,4) check (latitude between -90 and 90),
  longitude numeric(7,4) check (longitude between -180 and 180)
);
create table aircraft (
  tail_no varchar(8) primary key,
  model varchar(20) not null,
  seats smallint not null check (seats > 0),
  range_km integer not null check (range_km > 0)
);
create table seat (
  tail_no varchar(8) references aircraft (tail_no) on delete cascade,
  seat_no varchar(4),
  cabin varchar(8) not null check (cabin in ('business', 'economy')),
  primary key (tail_no, seat_no)
);
create table flight (
  flight_no varchar(6) primary key,
  origin char(3) not null references airport (code),
  destination char(3) not null references airport (code),
  departs time not null,
  duration_min integer not null check (duration_min > 0),
  distance_km integer not null check (distance_km > 0),
  tail_no varchar(8) not null references aircraft (tail_no),
  check (origin <> destination)
);
create table passenger (
  passenger_id integer primary key,
  name varchar(40) not null,
  birth_date date,
  frequent_flyer varchar(8) unique
);
create table booking (
  booking_id integer primary key,
  passenger_id integer not null references passenger (passenger_id),
  flight_no varchar(6) not null references flight (flight_no),
  flight_date date not null,
  seat_no varchar(4) not null,
  fare numeric(8,2) not null check (fare > 0),
  unique (flight_no, flight_date, seat_no)
);`,
  insert('airport', null, airport), insert('aircraft', null, aircraft), insert('seat', null, seat), insert('flight', null, flight),
  insert('passenger', null, passenger), insert('booking', null, booking),
  'create index flight_origin on flight (origin);\ncreate index flight_destination on flight (destination);\ncreate index booking_passenger on booking (passenger_id);',
], { airport: airport.length, aircraft: aircraft.length, seat: seat.length, flight: flight.length, passenger: passenger.length, booking: booking.length });
