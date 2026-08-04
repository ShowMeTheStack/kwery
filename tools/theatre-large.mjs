// Writes src/data/theatre-large.sql: the Theatre schema at a size where indexes, join algorithms and the planner's
// estimates make a visible difference (6000 patrons, 2400 performances, 45000 bookings). Same seeded generator and
// the same kinds of edge cases as the main sample, in proportion.
import { write } from './sample-lib.mjs';
import { SCHEMA, CHAINS, generate, inserts, counts } from './theatre-gen.mjs';

const t = generate(20261031, {
  venues: 30, stages: 75, companies: 60, noArtistCos: 4, persons: 900, artists: 450, freelance: 50, productions: 400, unperformed: 30, titled: CHAINS,
  chains: [4, 3, 3, 3, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], perfs: 2400, castMean: 4, trailing: true,
  patrons: 6000, bookings: 45000, bookingSql: true, mentorDepth: [4, 12, 30, 45, 25], crossings: 20,
});
write('theatre-large.sql', [
  '-- The Theatre database, Kwery\'s own sample, at scale: the schema of the main Theatre sample with 60 companies,\n' +
  '-- 400 productions, 2400 performances, 6000 patrons and 45000 bookings. All names, titles, venues and cities are\n' +
  '-- invented; the rows come from a seeded generator.',
  SCHEMA, ...inserts(t)], Object.assign(counts(t), { booking: '45000 (computed)' }));
