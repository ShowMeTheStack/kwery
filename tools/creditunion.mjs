// Writes src/data/creditunion.sql: a credit union. Members own share accounts (savings, never below zero) and loan
// accounts (what they owe, never above zero); share accounts carry debit cards, cards pay merchants, and money moves
// between accounts by transfers (a payment into a loan account is a repayment). Half a year of activity is replayed
// in time order, so every balance is exactly what the opening amount, the transfers and the settled card payments
// leave: a transfer redone in a transaction lesson starts from consistent data. Everything is invented.
import { rng, insert, write, FIRST, LAST, day, stamp } from './sample-lib.mjs';
const { int, pick, chance, sample, rnd } = rng(20251111);
const cents = (v) => Math.round(v * 100) / 100;
const money = (v) => ({ sql: v.toFixed(2) });

const cities = ['Brightwater', 'Saltreach', 'Quillmere', 'Lindenford', 'Vantmoor', 'Fennick'];
const member = [];
const names = new Set();
while (member.length < 150) {
  const n = pick(FIRST) + ' ' + pick(LAST);
  if (names.has(n)) continue;
  names.add(n);
  member.push([member.length + 1, n, chance(0.08) ? null : pick(cities), day('2009-01-01', int(0, 365 * 15 + 300)), chance(0.05) ? null : day('1945-01-01', int(0, 365 * 60))]);
}

// accounts: everyone but a few newcomers has a share account, some a second one, some a loan
const account = [], open = new Map();
const add = (m, kind, amount) => {
  const no = (kind === 'share' ? 'S' : 'L') + '-' + String(10001 + account.length);
  const rate = kind === 'share' ? pick([0.5, 0.75, 1.25, 2.0]) : pick([4.9, 5.5, 6.25, 7.9, 9.5]);
  account.push([no, m[0], kind, 0, day(m[3], int(0, 30)), rate]);
  open.set(no, amount);
  return no;
};
const noAccount = new Set(sample(member, 4).map((m) => m[0]));
for (const m of member) {
  if (noAccount.has(m[0])) continue;
  add(m, 'share', cents(Math.round(Math.pow(rnd(), 2.5) * 30000 / 5) * 5 + 50));
  if (chance(0.35)) add(m, 'share', cents(int(0, 80) * 50));
  if (chance(0.3)) add(m, 'loan', -int(10, 250) * 100);
}
const shares = account.filter((a) => a[2] === 'share');
const loans = account.filter((a) => a[2] === 'loan');

// cards on share accounts; some frozen, some expired
const card = [];
for (const a of shares) {
  if (chance(0.25)) continue;
  card.push([card.length + 1, a[0], String(int(1000, 9999)), day('2025-03-31', int(-60, 1200)), pick(['active', 'active', 'active', 'active', 'active', 'frozen'])]);
  if (chance(0.08)) card.push([card.length + 1, a[0], String(int(1000, 9999)), day('2024-06-30', int(0, 150)), 'expired']);
}
const MERCH = {
  grocery: ['Greengage Grocers', 'Barley & Bell Market', 'Corner Pantry', 'Harvest Lane Foods'], fuel: ['Kestrel Fuel', 'Roadstone Garage', 'Pumpkin Hill Fuels'],
  dining: ['The Salted Oar', 'Noodle Lantern', 'Mabel\'s Kitchen', 'Copper Pot Cafe', 'Little Fig Bakery'], travel: ['Tern Rail', 'Skylark Coaches', 'Harbourside Inn'],
  online: ['Parcelbox', 'Pagewise Books', 'Loomstitch', 'Gadgetry 100%'], pharmacy: ['Willow Chemist', 'Mortar & Pestle'], utilities: ['Brightwater Water Co.', 'Quill Power', 'Fennick Broadband'],
  entertainment: ['Riverlight Playhouse', 'Starling Cinema', 'Ninepins Bowling'],
};
const merchant = [];
for (const [cat, list] of Object.entries(MERCH)) for (const n of list) merchant.push([merchant.length + 1, n, cat, chance(0.15) ? null : pick(cities)]);
const AMOUNT = { grocery: [8, 140], fuel: [25, 90], dining: [9, 85], travel: [12, 420], online: [5, 260], pharmacy: [4, 60], utilities: [30, 160], entertainment: [10, 70] };

// six months of events in time order: card payments (some declined, some pending, a few refunds) and transfers
const balance = new Map(open);
const payment = [], transfer = [];
const live = card.filter((c) => c[4] !== 'expired');
const quiet = new Set(sample(live, 6).map((c) => c[0]));       // cards never used
const usable = live.filter((c) => !quiet.has(c[0]));
const idleMerchant = merchant[merchant.length - 1][0];
let t = 0;
const end = 181 * 24 * 60;
while (t < end) {
  t += int(20, 150);
  const when = stamp('2025-01-01 07:00:00', t);
  if (chance(0.72)) {
    const c = pick(usable);
    const m = pick(merchant.filter((x) => x[0] !== idleMerchant));
    const [lo, hi] = AMOUNT[m[2]];
    let amt = cents(lo + Math.pow(rnd(), 2) * (hi - lo));
    if (chance(0.03)) amt = -amt;                               // a refund
    const have = balance.get(c[1]);
    if ((amt > have || c[4] === 'frozen') && chance(0.85)) continue;   // a card known to be empty or frozen is seldom tried
    let status = c[4] === 'frozen' || amt > have ? 'declined' : t > end - 3 * 24 * 60 && chance(0.5) ? 'pending' : 'settled';
    if (status !== 'declined') balance.set(c[1], cents(have - amt));
    payment.push([payment.length + 1, c[0], m[0], money(amt), when, status]);
  } else {
    const from = pick(shares);
    const have = balance.get(from[0]);
    if (have < 40) continue;
    let to, amt;
    if (chance(0.35) && loans.length) {                         // a loan repayment, never more than is owed
      to = pick(loans);
      amt = Math.min(-balance.get(to[0]), cents(Math.round(have * (0.05 + rnd() * 0.25))));
      if (amt <= 0) continue;
    } else {
      to = pick(shares.filter((a) => a[0] !== from[0]));
      amt = Math.max(5, Math.round(have * (0.03 + rnd() * 0.35) / 5) * 5);
      if (amt > have) continue;
    }
    balance.set(from[0], cents(have - amt));
    balance.set(to[0], cents(balance.get(to[0]) + amt));
    transfer.push([transfer.length + 1, from[0], to[0], money(amt), when, to[2] === 'loan' ? 'repayment' : pick(['rent', 'savings', 'gift', 'invoice', 'groceries', 'school trip', 'Dinner at Mabel\'s', null])]);
  }
}
for (const a of account) a[3] = money(balance.get(a[0]));

write('creditunion.sql', [
  '-- A credit union, Kwery\'s own sample: members, their share and loan accounts, debit cards, merchants, card\n' +
  '-- payments and transfers between accounts. A balance is the opening amount plus the transfers in, minus the transfers\n' +
  '-- out and the settled card payments; loan balances are negative (what the member owes). Everything is invented.',
  `create table member (
  member_id integer primary key,
  name varchar(40) not null,
  city varchar(20),
  joined date not null,
  birth_date date
);
create table account (
  account_no varchar(8) primary key,
  member_id integer not null references member (member_id),
  kind varchar(5) not null check (kind in ('share', 'loan')),
  balance numeric(12,2) not null,
  opened date not null,
  rate numeric(5,2) not null check (rate >= 0),
  check (kind = 'loan' or balance >= 0),
  check (kind = 'share' or balance <= 0)
);
create table card (
  card_id integer primary key,
  account_no varchar(8) not null references account (account_no),
  last4 char(4) not null,
  expires date not null,
  status varchar(7) not null check (status in ('active', 'frozen', 'expired'))
);
create table merchant (
  merchant_id integer primary key,
  name varchar(40) not null unique,
  category varchar(13) not null,
  city varchar(20)
);
create table card_payment (
  payment_id integer primary key,
  card_id integer not null references card (card_id),
  merchant_id integer not null references merchant (merchant_id),
  amount numeric(10,2) not null check (amount <> 0),
  paid_at timestamp not null,
  status varchar(8) not null check (status in ('settled', 'pending', 'declined'))
);
create table transfer (
  transfer_id integer primary key,
  from_account varchar(8) not null references account (account_no),
  to_account varchar(8) not null references account (account_no),
  amount numeric(12,2) not null check (amount > 0),
  made_at timestamp not null,
  memo varchar(30),
  check (from_account <> to_account)
);`,
  insert('member', null, member), insert('account', null, account), insert('card', null, card), insert('merchant', null, merchant),
  insert('card_payment', null, payment), insert('transfer', null, transfer),
  'create index account_member on account (member_id);\ncreate index payment_card on card_payment (card_id, paid_at);\ncreate index transfer_from on transfer (from_account, made_at);\ncreate index transfer_to on transfer (to_account, made_at);',
], { member: member.length, account: account.length, card: card.length, merchant: merchant.length, card_payment: payment.length, transfer: transfer.length });
