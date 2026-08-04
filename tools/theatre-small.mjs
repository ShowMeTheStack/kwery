// Writes src/data/theatre-small.sql: the Theatre schema with a handful of rows per table, small enough to trace a
// query by hand and to show on a slide. The rows are chosen so the usual lessons have something to show: a company
// with no artists and one with no productions, a freelance artist, a production never performed, an adaptation of
// an adaptation, a patron with no city, an unrated booking, a tie on price, and a mentoring chain.
import { insert, write } from './sample-lib.mjs';
import { SCHEMA } from './theatre-gen.mjs';

const venue = [['RVL', 'Riverlight Playhouse', 'Brightwater', 1911], ['HBR', 'Harbour Rooms', 'Saltreach', 1987], ['LNT', 'Lantern Yard', 'Brightwater', null]];
const stage = [['RVL', 1, 420, 'proscenium'], ['RVL', 2, 60, 'studio'], ['HBR', 1, 250, 'thrust'], ['LNT', 1, 300, 'open air'], ['LNT', 2, 80, 'studio']];
const company = [
  ['C01', 'Brightwater Players', 'Brightwater', 1982, { sql: '850000.00' }], ['C02', 'Tin Whistle Comedy Co.', 'Saltreach', 2004, { sql: '120000.00' }],
  ['C03', 'Quillmere Opera Guild', 'Quillmere', 1961, { sql: '1400000.00' }], ['C04', 'Paper Moon Revue', 'Brightwater', null, { sql: '45000.00' }],
];
const person = [
  ['P1001', 'Hana', 'Okafor', '1961-04-12', 'Brightwater'], ['P1002', 'Tomas', 'Lindqvist', '1979-11-03', 'Saltreach'], ['P1003', 'Priya', 'Moreau', '1988-02-29', null],
  ['P1004', 'Kofi', 'Valdez', '1995-07-18', 'Brightwater'], ['P1005', 'Zara', 'Iyer', '2001-09-30', 'Quillmere'], ['P1006', 'Ilya', 'Castellano', null, 'Saltreach'],
];
// P1006 is a person who is not an artist; C03 has no artists; P1005 is freelance
const artist = [
  ['P1001', 'C01', 'Dame Hana Okafor', { sql: '4200.00' }], ['P1002', 'C02', null, { sql: '900.00' }], ['P1003', 'C01', 'Priya Moreau', { sql: '1500.00' }],
  ['P1004', 'C02', null, { sql: '900.00' }], ['P1005', null, 'Zara ', { sql: '650.00' }],
];
// C04 has no productions; PR105 is never performed; PR103 is based on PR102, which is based on PR101
const production = [
  ['PR101', 'Dinner at the Ferryman\'s', 'C01', 'drama', '2023-10-06', 120, null], ['PR102', 'The Ferryman Returns', 'C01', 'drama', '2024-10-04', 115, 'PR101'],
  ['PR103', 'Ferryman: The Revue', 'C02', 'comedy', '2025-03-14', 90, 'PR102'], ['PR104', 'The Copper Crown', 'C03', 'opera', '2024-11-22', 185, null],
  ['PR105', '100% Tuesday', 'C02', 'comedy', null, null, null],
];
const performance = [
  [1, 'PR101', 'RVL', 1, '2024-09-20', '19:30', { sql: '32.00' }], [2, 'PR102', 'RVL', 1, '2024-10-04', '19:30', { sql: '45.00' }],
  [3, 'PR102', 'RVL', 1, '2024-10-05', '14:30', { sql: '35.00' }], [4, 'PR104', 'HBR', 1, '2024-11-22', '19:00', { sql: '68.50' }],
  [5, 'PR103', 'LNT', 1, '2025-03-14', '20:00', { sql: '0.00' }], [6, 'PR103', 'RVL', 2, '2025-03-15', '20:00', { sql: '45.00' }],
];
const casting = [
  ['P1001', 'PR101', 'The Widow', true], ['P1003', 'PR101', 'The Daughter', false], ['P1001', 'PR102', 'The Widow', true], ['P1005', 'PR102', 'The Stranger', false],
  ['P1002', 'PR103', 'Compere', true], ['P1004', 'PR103', 'Turn', false], ['P1004', 'PR103', 'Pianist', false], ['P1005', 'PR104', 'The Oracle', true],
];
const patron = [
  [1, 'Amara Novak', 'Brightwater', '2019-03-02', 120], [2, 'Felix O\'Hara', 'Saltreach', '2022-08-15', 40], [3, 'Lucia Park', null, '2024-01-09', 0],
  [4, 'Jonas Weber', 'Quillmere', '2024-09-01', 60], [5, 'Rosa Achebe', 'Brightwater', '2025-02-20', 0],
];
// patron 5 has booked nothing; booking 3 and 7 are unrated
const booking = [
  [1, 1, 1, 2, { sql: '64.00' }, 4], [2, 1, 2, 2, { sql: '90.00' }, 5], [3, 2, 3, 1, { sql: '35.00' }, null], [4, 4, 4, 3, { sql: '205.50' }, 3],
  [5, 1, 4, 2, { sql: '109.60' }, 2], [6, 3, 5, 4, { sql: '0.00' }, 5], [7, 4, 6, 1, { sql: '45.00' }, null], [8, 2, 6, 2, { sql: '90.00' }, 4],
];
const mentor = [['P1001', 'P1003', '2010-05-01'], ['P1003', 'P1005', '2021-09-01'], ['P1002', 'P1004', '2018-01-15'], ['P1001', 'P1004', null]];

const t = { venue, stage, company, person, artist, production, performance, casting, patron, booking, mentor };
write('theatre-small.sql', [
  '-- The Theatre database, Kwery\'s own sample, in miniature: the schema of the main Theatre sample with a handful of\n' +
  '-- rows per table, small enough to trace a query by hand. All names, titles, venues and cities are invented.',
  SCHEMA, ...Object.entries(t).map(([k, rows]) => insert(k, null, rows))], Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.length])));
