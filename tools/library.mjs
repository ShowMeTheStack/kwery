// Writes src/data/library.sql: a lending library. Books have one or more authors (many to many), each book has
// copies on the shelves, members borrow copies (a loan has a due date, and a return date once it is back) and
// reserve books that are out. Loans of one copy never overlap; some are late, some are still out. Titles, authors,
// publishers and members are invented.
import { rng, insert, write, FIRST, LAST, day, stamp, pad } from './sample-lib.mjs';
const { int, pick, chance, sample } = rng(20250505);

const author = [];
const an = new Set();
while (author.length < 60) { const n = pick(FIRST) + ' ' + pick(LAST); if (an.has(n)) continue; an.add(n); author.push([author.length + 1, n, int(1920, 1995)]); }
const adj = ['Silent', 'Hidden', 'Last', 'Broken', 'Golden', 'Distant', 'Winter', 'Crimson', 'Quiet', 'Restless', 'Forgotten', 'Northern', 'Paper', 'Glass', 'Iron', 'Hollow'];
const noun = ['Harbor', 'Garden', 'River', 'Orchard', 'Lighthouse', 'Archive', 'Valley', 'Bridge', 'Island', 'Station', 'Library', 'Mountain', 'Kingdom', 'Map', 'Clock', 'Forest'];
const topics = ['Databases', 'Algorithms', 'Bread', 'Birds', 'Stars', 'Rivers', 'Cities', 'Gardens', 'Numbers', 'Weather', 'Ships', 'Music'];
const genres = ['fiction', 'mystery', 'science', 'history', 'poetry', 'children', 'cooking', 'travel'];
const publishers = ['Larkspur Books', 'Tidewater House', 'Copper Kettle Press', 'Blue Heron Editions', 'Millstone Publishing', 'Quillfeather'];
const isbn = (n) => { const d = ('978099' + pad(n, 6)).split('').map(Number); const s = d.reduce((a, x, i) => a + x * (i % 2 ? 3 : 1), 0); return d.join('') + ((10 - (s % 10)) % 10); };
const book = [], titles = new Set();
while (book.length < 150) {
  const g = pick(genres);
  const t = ['science', 'history', 'cooking', 'travel'].includes(g) ? pick(['A Short History of ', 'The Book of ', 'Understanding ', 'A Field Guide to ', 'Everyday ']) + pick(topics) : pick(['The ', 'The ', 'A ', '']) + pick(adj) + ' ' + pick(noun);
  if (titles.has(t)) continue;
  titles.add(t);
  const id = book.length + 1;
  book.push([id, isbn(id * 37), t, pick(publishers), int(1950, 2024), g, int(9, 70) * 10]);
}
const book_author = [];
for (const b of book) { const n = chance(0.8) ? 1 : chance(0.7) ? 2 : 3; sample(author, n).forEach((a, i) => book_author.push([b[0], a[0], i + 1])); }
const member = [];
const mn = new Set();
while (member.length < 200) {
  const f = pick(FIRST), l = pick(LAST);
  if (mn.has(f + l)) continue;
  mn.add(f + l);
  member.push([member.length + 1, f + ' ' + l, (f + '.' + l).toLowerCase() + '@example.org', pick(['student', 'student', 'staff', 'public', 'public']), day('2019-01-01', int(0, 1800))]);
}
const copy = [];
for (const b of book) { const n = int(1, 4); for (let k = 0; k < n; k++) copy.push([copy.length + 1, b[0], pick(['A', 'B', 'C', 'D']) + '-' + int(1, 40), day(Math.max(b[4], 2005) + '-01-01', int(0, 364)), pick(['new', 'good', 'good', 'good', 'worn', 'damaged'])]); }
// loans: each copy is lent out from its acquisition date, one loan after another, until the end of 2024
const loan = [];
const today = Date.parse('2024-12-31T00:00:00Z');
const toDays = (d) => Math.round((Date.parse(d + 'T00:00:00Z') - Date.parse('2019-01-01T00:00:00Z')) / 86400000);
for (const c of copy) {
  let t = Math.max(toDays(c[3]), toDays('2023-07-01')) + int(0, 90);
  while (true) {
    const out = day('2019-01-01', t);
    if (Date.parse(out + 'T00:00:00Z') > today) break;
    const m = pick(member.filter((x) => toDays(x[4]) <= t));
    if (!m) { t += 30; continue; }
    const kept = chance(0.15) ? int(22, 60) : int(3, 21);
    const back = t + kept;
    const returned = Date.parse(day('2019-01-01', back) + 'T00:00:00Z') > today ? null : day('2019-01-01', back);
    loan.push([loan.length + 1, c[0], m[0], out, day('2019-01-01', t + 21), returned]);
    if (!returned) break;
    t = back + int(5, 120);
  }
}
loan.sort((a, b) => (a[3] < b[3] ? -1 : a[3] > b[3] ? 1 : a[0] - b[0]));
loan.forEach((l, i) => { l[0] = i + 1; });
// reservations: members wait for books whose copies are all out at the end of 2024, and some older ones
const reservation = [];
const outNow = new Set(loan.filter((l) => !l[5]).map((l) => l[1]));
for (const b of book) {
  const copies = copy.filter((c) => c[1] === b[0]);
  const allOut = copies.every((c) => outNow.has(c[0]));
  const n = allOut ? int(1, 3) : chance(0.3) ? 1 : 0;
  for (const m of sample(member, n)) reservation.push([reservation.length + 1, b[0], m[0], stamp('2024-01-05 09:00:00', int(0, 520000)), allOut ? pick(['waiting', 'waiting', 'ready']) : pick(['fulfilled', 'fulfilled', 'cancelled'])]);
}

write('library.sql', [
  '-- A lending library: books and their authors, copies, members, loans with due dates, and reservations, made up\n-- for Kwery.',
  `create table author (
  author_id integer primary key,
  name varchar(40) not null,
  born smallint check (born > 1800)
);
create table book (
  book_id integer primary key,
  isbn char(13) not null unique,
  title varchar(80) not null,
  publisher varchar(30),
  pub_year smallint check (pub_year between 1450 and 2100),
  genre varchar(12) not null check (genre in ('fiction', 'mystery', 'science', 'history', 'poetry', 'children', 'cooking', 'travel')),
  pages integer check (pages > 0)
);
create table book_author (
  book_id integer references book (book_id) on delete cascade,
  author_id integer references author (author_id),
  author_order smallint not null default 1 check (author_order > 0),
  primary key (book_id, author_id)
);
create table member (
  member_id integer primary key,
  name varchar(40) not null,
  email varchar(60) not null unique,
  kind varchar(8) not null check (kind in ('student', 'staff', 'public')),
  joined date not null
);
create table copy (
  copy_id integer primary key,
  book_id integer not null references book (book_id),
  shelf varchar(6),
  acquired date not null,
  condition varchar(8) not null check (condition in ('new', 'good', 'worn', 'damaged'))
);
create table loan (
  loan_id integer primary key,
  copy_id integer not null references copy (copy_id),
  member_id integer not null references member (member_id),
  loaned_on date not null,
  due_on date not null,
  returned_on date,
  check (due_on > loaned_on),
  check (returned_on is null or returned_on >= loaned_on)
);
create table reservation (
  reservation_id integer primary key,
  book_id integer not null references book (book_id),
  member_id integer not null references member (member_id),
  reserved_at timestamp not null,
  status varchar(9) not null check (status in ('waiting', 'ready', 'fulfilled', 'cancelled'))
);`,
  insert('author', null, author), insert('book', null, book), insert('book_author', null, book_author), insert('member', null, member),
  insert('copy', null, copy), insert('loan', null, loan), insert('reservation', null, reservation),
  'create index book_author_author on book_author (author_id);\ncreate index copy_book on copy (book_id);\ncreate index loan_copy on loan (copy_id, loaned_on);\ncreate index loan_member on loan (member_id);\ncreate index loan_open on loan (due_on) where returned_on is null;',
], { author: author.length, book: book.length, book_author: book_author.length, member: member.length, copy: copy.length, loan: loan.length, reservation: reservation.length });
