// Writes src/data/theatre.sql: the Theatre database, Kwery's own main sample and the default. Twelve companies stage
// sixty productions at eight venues over two seasons; artists are cast in them, patrons book and rate performances,
// and artists mentor one another. The rows are seeded, so they never change, and they keep the cases lessons need:
// companies with no artists or no productions, freelance artists, productions never performed, chains of
// adaptations, patrons with no city, unrated bookings, and a mentoring tree.
import { write } from './sample-lib.mjs';
import { SCHEMA, CHAINS, generate, inserts, counts } from './theatre-gen.mjs';

const t = generate(20260917, {
  venues: 8, stages: 20, companies: 12, noArtistCos: 2, persons: 90, artists: 45, freelance: 5, productions: 60, unperformed: 6, titled: CHAINS,
  perfs: 180, castMean: 3.4, trailing: true, patrons: 200, bookings: 1100, mentorDepth: [3, 7, 10, 6], crossings: 4,
});
write('theatre.sql', [
  '-- The Theatre database, Kwery\'s own sample: theatre companies stage productions at venues with one or more stages;\n' +
  '-- artists (some freelance) are cast in productions, patrons book performances and may rate them, and artists mentor\n' +
  '-- one another. All names, titles, venues and cities are invented; the rows come from a seeded generator.',
  SCHEMA, ...inserts(t)], counts(t));
