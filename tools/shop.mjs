// Writes src/data/shop.sql: an online shop. Categories form a tree (each has a parent), products carry their
// attributes as jsonb and their tags as a text array, customers place orders of several items, orders are paid
// (not the pending or cancelled ones), and customers review products they bought (with jsonb details). Two years
// of orders, for analytics: ROLLUP and CUBE by category and month, running totals, top products per category.
// Products and people are invented; no brand names.
import { rng, insert, write, FIRST, LAST, day, stamp } from './sample-lib.mjs';
const { int, pick, chance, sample, rnd } = rng(20250707);

// the category tree: [id, name, parent]
const tree = {
  Home: { Kitchen: ['Cookware', 'Tableware', 'Coffee and Tea'], Furniture: ['Chairs', 'Desks'], Garden: [] },
  Outdoors: { Camping: ['Tents', 'Backpacks'], Cycling: [] },
  Electronics: { Audio: ['Headphones', 'Speakers'], Computing: ['Keyboards', 'Monitors'] },
  Books: { Fiction: [], Nonfiction: [] },
};
const category = [];
const leaves = [];
for (const [top, subs] of Object.entries(tree)) {
  const t = category.length + 1; category.push([t, top, null]);
  for (const [sub, kids] of Object.entries(subs)) {
    const s = category.length + 1; category.push([s, sub, t]);
    if (!kids.length) leaves.push([s, sub, top]);
    for (const k of kids) { const id = category.length + 1; category.push([id, k, s]); leaves.push([id, k, top]); }
  }
}
const things = {
  Cookware: ['Cast Iron Skillet', 'Saucepan', 'Stock Pot', 'Wok', 'Dutch Oven'], Tableware: ['Dinner Plate', 'Bowl Set', 'Glass Tumbler', 'Serving Platter'], 'Coffee and Tea': ['Pour-over Kettle', 'Tea Infuser', 'Ceramic Mug', 'Coffee Grinder'],
  Chairs: ['Oak Chair', 'Folding Chair', 'Office Chair'], Desks: ['Standing Desk', 'Writing Desk'], Garden: ['Watering Can', 'Pruning Shears', 'Planter Box', 'Garden Hose'],
  Tents: ['Two-person Tent', 'Family Tent', 'Ultralight Tarp'], Backpacks: ['Daypack 20L', 'Trail Pack 35L', 'Expedition Pack 60L'], Cycling: ['Bike Light', 'Helmet', 'Bike Lock', 'Saddle Bag'],
  Headphones: ['Over-ear Headphones', 'Earbuds', 'Studio Headphones'], Speakers: ['Bookshelf Speaker', 'Portable Speaker'], Keyboards: ['Mechanical Keyboard', 'Compact Keyboard'], Monitors: ['24-inch Monitor', '27-inch Monitor'],
  Fiction: ['Novel', 'Short Stories', 'Poetry Collection'], Nonfiction: ['Cookbook', 'Field Guide', 'Biography', 'Atlas'],
};
const colors = ['black', 'white', 'red', 'blue', 'green', 'grey', 'yellow'];
const product = [];
const used = new Set();
while (product.length < 200) {
  const [cid, cname, top] = pick(leaves);
  const variant = pick(['Classic', 'Pro', 'Mini', 'Plus', 'Lite', 'Max', 'Studio', 'Field', 'Urban', 'Nova']);
  const name = variant + ' ' + pick(things[cname]);
  if (used.has(name)) continue;
  used.add(name);
  const a = {};
  if (top === 'Books') { a.pages = int(90, 700); a.format = pick(['hardcover', 'paperback']); a.language = pick(['en', 'en', 'en', 'fr', 'de', 'es']); }
  else { a.color = pick(colors); a.weight_g = int(5, 400) * 10; if (top === 'Electronics') { a.wireless = chance(0.5); a.warranty_months = pick([12, 24, 36]); } if (cname === 'Tents' || cname === 'Backpacks') a.capacity_l = int(15, 90); if (chance(0.2)) a.sizes = sample(['S', 'M', 'L', 'XL'], int(2, 4)); }
  const tags = sample(['new', 'sale', 'eco', 'bestseller', 'gift', 'limited', 'handmade', 'refurbished'], int(0, 3));
  const price = top === 'Electronics' ? int(15, 400) : top === 'Books' ? int(8, 45) : top === 'Outdoors' ? int(10, 350) : int(6, 300);
  product.push([product.length + 1, name, cid, (price - 0.01).toFixed(2), JSON.stringify(a), '{' + tags.join(',') + '}']);
}
const cities = ['Alderton', 'Brookhaven', 'Cedar Falls', 'Dunmore', 'Eastwick', 'Fairport', 'Glenrock', 'Harlow'];
const customer = [];
const cn = new Set();
while (customer.length < 300) { const f = pick(FIRST), l = pick(LAST); if (cn.has(f + l)) continue; cn.add(f + l); customer.push([customer.length + 1, f + ' ' + l, (f + '.' + l).toLowerCase() + '@example.com', pick(cities), day('2022-01-01', int(0, 700))]); }
// orders over 2023 and 2024, more of them towards the end of each year
const orders = [], order_item = [], payment = [];
for (let k = 0; k < 1500; k++) {
  const c = pick(customer);
  let at;
  do { const d = int(0, 730); at = stamp('2023-01-01 00:00:00', d * 1440 + int(7 * 60, 23 * 60)); } while (at.slice(0, 10) < c[4] || (chance(0.3) && !/-(1[012])-/.test(at)));
  orders.push([0, c[0], at, null]);
}
orders.sort((a, b) => (a[2] < b[2] ? -1 : 1));
orders.forEach((o, i) => {
  o[0] = i + 1;
  const recent = o[2] >= '2024-12-20';
  o[3] = recent ? pick(['pending', 'paid', 'shipped']) : pick(['delivered', 'delivered', 'delivered', 'delivered', 'delivered', 'delivered', 'cancelled', 'returned']);
  let total = 0;
  for (const [n, p] of sample(product, int(1, 5)).entries()) { const qn = chance(0.8) ? 1 : int(2, 4); const price = (+p[3] * (p[5].includes('sale') ? 0.8 : 1)).toFixed(2); order_item.push([o[0], n + 1, p[0], qn, price]); total += qn * Math.round(+price * 100); }
  if (o[3] !== 'pending' && o[3] !== 'cancelled') payment.push([payment.length + 1, o[0], stamp(o[2], int(1, 90)), (total / 100).toFixed(2), pick(['card', 'card', 'card', 'transfer', 'wallet'])]);
});
// reviews by customers of products they received
const review = [];
const seen = new Set();
for (const it of order_item) {
  const o = orders[it[0] - 1];
  if (o[3] !== 'delivered' || !chance(0.15) || seen.has(o[1] + ':' + it[2])) continue;
  seen.add(o[1] + ':' + it[2]);
  const rating = pick([5, 5, 5, 4, 4, 4, 3, 2, 1]);
  const d = { verified: true, helpful: int(0, 40) };
  if (chance(0.4)) d.pros = sample(['sturdy', 'light', 'good value', 'looks great', 'easy to use', 'quiet', 'fast delivery'], int(1, 2));
  if (rating <= 2) d.cons = sample(['broke quickly', 'too heavy', 'not as pictured', 'late delivery', 'noisy'], 1);
  review.push([review.length + 1, it[2], o[1], rating, pick({ 5: ['Excellent', 'Love it', 'Just right'], 4: ['Very good', 'Solid choice'], 3: ['It is fine', 'Average'], 2: ['Disappointing'], 1: ['Would not buy again'] }[rating]), stamp(o[2], int(3, 40) * 1440 + int(0, 600)), JSON.stringify(d)]);
}
void rnd;

write('shop.sql', [
  '-- An online shop: a tree of categories, products with jsonb attributes and text[] tags, customers, orders and\n-- their items, payments, and reviews with jsonb details, made up for Kwery.',
  `create table category (
  category_id integer primary key,
  name varchar(30) not null unique,
  parent_id integer references category (category_id)
);
create table product (
  product_id integer primary key,
  name varchar(60) not null unique,
  category_id integer not null references category (category_id),
  price numeric(10,2) not null check (price > 0),
  attrs jsonb not null default '{}',
  tags text[] not null default '{}'
);
create table customer (
  customer_id integer primary key,
  name varchar(40) not null,
  email varchar(60) not null unique,
  city varchar(30),
  joined date not null
);
create table orders (
  order_id integer primary key,
  customer_id integer not null references customer (customer_id),
  ordered_at timestamp not null,
  status varchar(10) not null check (status in ('pending', 'paid', 'shipped', 'delivered', 'cancelled', 'returned'))
);
create table order_item (
  order_id integer references orders (order_id) on delete cascade,
  line_no smallint check (line_no > 0),
  product_id integer not null references product (product_id),
  quantity integer not null check (quantity > 0),
  unit_price numeric(10,2) not null check (unit_price >= 0),
  primary key (order_id, line_no)
);
create table payment (
  payment_id integer primary key,
  order_id integer not null references orders (order_id),
  paid_at timestamp not null,
  amount numeric(10,2) not null check (amount > 0),
  method varchar(8) not null check (method in ('card', 'transfer', 'wallet'))
);
create table review (
  review_id integer primary key,
  product_id integer not null references product (product_id),
  customer_id integer not null references customer (customer_id),
  rating smallint not null check (rating between 1 and 5),
  title varchar(40),
  created_at timestamp not null,
  details jsonb,
  unique (product_id, customer_id)
);`,
  insert('category', null, category), insert('product', null, product), insert('customer', null, customer), insert('orders', null, orders),
  insert('order_item', null, order_item), insert('payment', null, payment), insert('review', null, review),
  'create index product_category on product (category_id);\ncreate index orders_customer on orders (customer_id, ordered_at);\ncreate index order_item_product on order_item (product_id);\ncreate index product_tags on product using gin (tags);\ncreate index product_attrs on product using gin (attrs);',
], { category: category.length, product: product.length, customer: customer.length, orders: orders.length, order_item: order_item.length, payment: payment.length, review: review.length });
