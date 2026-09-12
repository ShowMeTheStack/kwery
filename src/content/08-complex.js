// Chapter 8: complex data types. Semi-structured data and JSON in SQL, arrays and nested data, object-relational
// features (composite types, row values, domains, enums), textual data with an inverted index built by hand, and
// spatial data with an R-tree. Then exercises on JSON, arrays and words, checked on the Theatre database.
(function (root) {
  'use strict';
  const C = root.K.Content;
  // the right answer of each prediction is listed first in the source; rotate the options by a hash of the
  // question so that it lands in a different place from one question to the next
  const mix = (l) => {
    for (const b of l.body || []) {
      if (!b || !b.predict) continue;
      const p = b.predict, n = p.options.length;
      let k = 0;
      for (const ch of p.q) k = (k * 31 + ch.charCodeAt(0)) >>> 0;
      k %= n;
      const right = p.options[p.answer];
      p.options = p.options.slice(k).concat(p.options.slice(0, k));
      p.answer = p.options.indexOf(right);
    }
    return l;
  };
  const lesson = (l) => C.lesson(mix(l));

  // ---- 8.1 semi-structured data and JSON --------------------------------------------------------------------------------
  const ITEMS = "drop table if exists shop_item;\ncreate table shop_item (id int primary key, doc jsonb);\ninsert into shop_item values\n  (1, '{\"name\": \"Hoodie\", \"price\": 35.00, \"sizes\": [\"S\", \"M\", \"L\"], \"colour\": \"navy\"}'),\n  (2, '{\"name\": \"Notebook\", \"price\": 4.50, \"pages\": 120, \"ruled\": true}'),\n  (3, '{\"name\": \"USB stick\", \"price\": 9.99, \"specs\": {\"capacity_gb\": 64, \"usb\": \"3.2\"}}'),\n  (4, '{\"name\": \"Mug\", \"price\": 7.00, \"colour\": \"white\", \"sizes\": [\"M\"]}');";
  lesson({
    id: 'cx-json', chapter: 8, title: 'Semi-structured data and JSON', minutes: 15,
    summary: 'Not all data fits a fixed set of columns. JSON values store nested, varying structure inside a column, and SQL has operators to reach into them and functions to build them.',
    body: [
      'The relational model asks every row of a table to have the same attributes, each holding one atomic value. Some data does not fit that well. A theatre\'s foyer shop sells hoodies (with sizes and a colour), notebooks (with a page count) and USB sticks of cast recordings (with technical specs). A column for every attribute of every product would be mostly nulls, and a new kind of product would need a new column.',
      '**Semi-structured** data carries its structure with it: each value says what fields it has. The most common format today is **JSON**: objects in braces with named fields, arrays in brackets, and strings, numbers, booleans and null inside. SQL databases store it in a column of type `json` (the text as written) or `jsonb` (a parsed binary form that is faster to query, and the one to use).',
      { sql: ITEMS + "\nselect id, doc from shop_item order by id;" },
      { h: 'Reaching into a value' },
      { table: [['Operator', 'Gives', 'Example'], ['`->`', 'a field or array element, as jsonb', "`doc -> 'specs'`"], ['`->>`', 'the same, as text', "`doc ->> 'name'`"], ['`#>` and `#>>`', 'the value at a path, as jsonb or text', "`doc #>> '{specs,capacity_gb}'`"], ['`?`', 'whether a top-level key exists', "`doc ? 'sizes'`"], ['`@>`', 'whether the left value contains the right one', "`doc @> '{\"colour\": \"navy\"}'`"]] },
      { sql: "select doc ->> 'name' as name,\n       (doc ->> 'price')::numeric as price,\n       doc #>> '{specs,capacity_gb}' as capacity_gb,\n       doc -> 'sizes' as sizes\nfrom shop_item\norder by price desc;", note: 'A field that is missing gives null, not an error. `->>` gives text, so it is cast to numeric for sorting.' },
      { predict: { q: 'Which items does `where doc @> \'{"sizes": ["M"]}\'` return?', options: ['Hoodie and Mug: both have an array sizes containing "M"', 'Only Mug: its sizes are exactly ["M"]', 'All items: the others have no sizes, so nothing contradicts it'], answer: 0, explain: 'Containment compares structure: an object contains another if it has all of its fields with contained values, and an array contains another if it has all of its elements, in any order and among others. Items with no sizes field contain nothing about sizes.' }, sql: "select doc ->> 'name'\nfrom shop_item\nwhere doc @> '{\"sizes\": [\"M\"]}';" },
      'A JSON array can be unnested into rows, one per element, and then joined, filtered and grouped like any table:',
      { sql: "select doc ->> 'name' as item, size\nfrom shop_item, jsonb_array_elements_text(doc -> 'sizes') as size\norder by item, size;" },
      'Path queries use **jsonpath**, a small language for paths with filters. Which items have a capacity of at least 32 GB?',
      { sql: "select doc ->> 'name'\nfrom shop_item\nwhere jsonb_path_exists(doc, '$.specs ? (@.capacity_gb >= 32)');" },
      { h: 'Building JSON from relations' },
      'The other direction matters as much: a web page or a mobile app usually wants one nested document, not a set of flat rows. `jsonb_build_object` makes an object from name and value pairs, and `jsonb_agg` collects a group of values into an array. One document per company, with its artists nested inside:',
      { sql: "select jsonb_build_object(\n         'company', c.name,\n         'city', c.city,\n         'artists', (select jsonb_agg(jsonb_build_object('name', p.given_name || ' ' || p.family_name, 'fee', a.fee)\n                                      order by p.family_name, p.given_name)\n                     from artist a join person p on p.person_id = a.person_id\n                     where a.company_id = c.company_id)\n       ) as doc\nfrom company c\nwhere c.company_id in ('C02', 'C04');" },
      'Changing a document means building a new value: `jsonb_set` replaces the value at a path, and `||` merges objects.',
      { sql: "update shop_item\nset doc = jsonb_set(doc, '{price}', '29.00') || '{\"on_sale\": true}'\nwhere id = 1;\nselect doc from shop_item where id = 1;" },
      { h: 'When to use it' },
      'JSON columns suit data whose structure varies from row to row, data exchanged with other programs, and attributes that are rarely queried. They give up what the schema normally gives: types are not checked, a misspelt field name silently returns null, and constraints and foreign keys cannot reach inside. A field that every row has and queries filter on usually deserves a column of its own. For containment and key queries on a large table, a **GIN** index on the jsonb column (an inverted index over its keys and values) makes them fast.',
      { h: 'XML' },
      'Before JSON, the common semi-structured format was **XML**, in which data is nested in named tags: `<item><name>Mug</name><price>7.00</price></item>`. Elements can carry attributes, and a schema language can say which elements are allowed where. XML is queried with **XPath**, which selects nodes by path (`/item/price`), and **XQuery**, a full query language built on it. SQL has an `xml` type and functions to build and query XML; Kwery does not implement them, but the ideas are the ones you have just used with JSON: paths into a tree, containment, and building nested documents from rows.',
      { sql: 'drop table shop_item;' },
    ],
  });

  // ---- 8.1 arrays and nested data -------------------------------------------------------------------------------------------
  lesson({
    id: 'cx-arrays', chapter: 8, title: 'Arrays and nested relations', minutes: 12,
    summary: 'An array column holds a list of values in one attribute. unnest turns it into rows, array_agg turns rows into an array, and operators test membership and overlap.',
    body: [
      'First normal form asks for atomic values. Arrays deliberately break that: one attribute holds a list. They are handy for small lists that belong to the row and are mostly read together, such as the tags of a post or the keywords of a paper.',
      { sql: "drop table if exists paper;\ncreate table paper (\n  paper_id int primary key,\n  title    text,\n  authors  text[],\n  keywords text[]\n);\ninsert into paper values\n  (1, 'Cheaper joins on flash', ARRAY['Osei', 'Lund'], '{joins,flash,cost}'),\n  (2, 'Logging without locks', ARRAY['Lund'], '{recovery,logging}'),\n  (3, 'Skew in parallel joins', ARRAY['Varga', 'Osei', 'Kim'], '{joins,parallel,skew}');\nselect title, authors[1] as first_author, cardinality(authors) as n_authors\nfrom paper\norder by paper_id;", note: 'An array literal is either ARRAY[...] or a string in braces. Arrays are numbered from 1.' },
      { h: 'Membership and overlap' },
      { table: [['Expression', 'True when'], ["`'Osei' = any(authors)`", 'Osei is one of the elements'], ["`authors @> ARRAY['Osei', 'Kim']`", 'every element on the right is in the left array'], ["`keywords && ARRAY['flash', 'skew']`", 'the two arrays share an element'], ['`x > all(arr)`', 'x is greater than every element']] },
      { sql: "select title\nfrom paper\nwhere 'Osei' = any(authors)\n  and keywords && ARRAY['parallel', 'flash'];" },
      { h: 'From arrays to rows and back' },
      '`unnest` turns an array into a set of rows. With `with ordinality` it also numbers them, which keeps the author order:',
      { predict: { q: 'How many rows does `select p.title, a from paper p, unnest(p.authors) as a` return?', options: ['6, one per author of each paper', '3, one per paper', '9, every paper with every author'], answer: 0, explain: 'The lateral call to unnest runs once per paper and yields that paper\'s authors: 2 + 1 + 3 = 6 rows.' }, sql: 'select p.title, a.author, a.position\nfrom paper p, unnest(p.authors) with ordinality as a(author, position)\norder by p.paper_id, a.position;' },
      '`array_agg` goes the other way, collecting the values of a group into an array. Once unnested, an array can be grouped on, so "papers per author" is a short query:',
      { sql: 'select author, array_agg(title order by title) as papers\nfrom paper, unnest(authors) as author\ngroup by author\norder by author;' },
      'The same functions work on the Theatre tables. The productions each of a few patrons booked in 2025, as one array per patron:',
      { sql: "select b.patron_id, array_agg(distinct f.prod_id order by f.prod_id) as productions_2025\nfrom booking b join performance f on f.perf_id = b.perf_id\nwhere f.perf_date between date '2025-01-01' and date '2025-12-31'\ngroup by b.patron_id\norder by b.patron_id\nlimit 5;" },
      { h: 'Nested relations' },
      'Taken further, a table whose attributes can themselves be tables is a **nested relation**, and a schema in that style is in **non-first normal form**. Arrays and JSON columns are the practical form of it in SQL. Unnesting a nested relation gives an ordinary flat one, and grouping with `array_agg` nests it again, so both views of the data are always a query away. The flat form is better when the inner values are queried on their own or have attributes of their own: if authors had affiliations and email addresses, a separate table with a foreign key would be the better design.',
      { tip: '`ARRAY(subquery)` builds an array from the rows of a subquery: `select ARRAY(select name from company order by budget desc limit 3)`.' },
      { sql: 'drop table paper;' },
    ],
  });

  // ---- 8.2 object-relational features ---------------------------------------------------------------------------------------
  lesson({
    id: 'cx-objects', chapter: 8, title: 'Object-relational features: user-defined types', minutes: 12,
    summary: 'Composite types group attributes into one structured value; domains and enums give a name and a rule to a set of values. Row values compare several attributes at once.',
    body: [
      'Object-oriented programs describe data with classes: a Person has an Address, which has a street and a city. **Object-relational** databases bring some of that into SQL: user-defined structured types, values of those types inside columns, and functions on them.',
      { h: 'Composite types' },
      'A composite type is a named record type. Once defined it can be the type of a column:',
      { sql: "drop table if exists supplier;\ndrop type if exists postal_address;\ncreate type postal_address as (street text, city text, postcode text);\ncreate table supplier (\n  supplier_id int primary key,\n  name        text,\n  office      postal_address,\n  warehouse   postal_address\n);\ninsert into supplier values\n  (1, 'Paper & Co', row('12 Dock St', 'Leeds', 'LS1 4AA'), row('Unit 7, Ring Rd', 'Leeds', 'LS9 0PQ')),\n  (2, 'Inkwell', row('3 High St', 'York', 'YO1 8RS'), null);" },
      'A field of a composite value is reached with a dot. The parentheses around the column name are needed so that `office.city` is not read as table office, column city:',
      { sql: 'select name, (office).city as office_city, (warehouse).city as warehouse_city\nfrom supplier\norder by supplier_id;' },
      { predict: { q: 'Both addresses have the same three fields. What does the type buy you, compared with six text columns?', options: ['The structure is defined once and reused, and an address can be handled as one value (passed, compared, set to null)', 'Faster queries', 'Nothing at all'], answer: 0, explain: 'A type says once what an address is. Each column of that type then has the same fields, a whole address can be null at once (Inkwell has no warehouse), and functions can take an address as a parameter.' }, sql: 'select name, warehouse is null as no_warehouse, office\nfrom supplier\norder by supplier_id;' },
      { h: 'Row values' },
      'A **row value** is an anonymous composite: `(a, b, c)`. Row values compare field by field from the left, which makes some conditions much shorter. The performances that start after the evening show of 20 May 2026, by date and then by time:',
      { sql: "select perf_id, prod_id, perf_date, start_time\nfrom performance\nwhere (perf_date, start_time) > (date '2026-05-20', time '19:00')\norder by perf_date, start_time\nlimit 6;", note: 'A pair (d, t) is greater than (d0, t0) when d is later than d0, or the dates tie and t is later than t0: the first fields decide unless they are equal.' },
      { h: 'Domains and enumerations' },
      'A **domain** is a base type with a name and constraints. Every column declared with it gets the same rule, written once:',
      { sql: "drop table if exists rating;\ndrop domain if exists stars;\ncreate domain stars as int check (value between 1 and 5);\ncreate table rating (supplier_id int, score stars);\ninsert into rating values (1, 4), (2, 5);" },
      { sql: 'insert into rating values (1, 9);', fails: '23514', note: 'The domain\'s check rejects 9.' },
      'An **enumerated type** lists its values, and orders them in the order given, not alphabetically:',
      { sql: "drop table if exists delivery_status;\ndrop type if exists ship_stage;\ncreate type ship_stage as enum ('ordered', 'packed', 'shipped', 'delivered');\ncreate table delivery_status (order_no int, at ship_stage);\ninsert into delivery_status values (101, 'shipped'), (102, 'ordered'), (103, 'delivered'), (104, 'packed');\nselect order_no, at\nfrom delivery_status\nwhere at >= 'packed'\norder by at;" },
      { h: 'Inheritance and references' },
      'SQL also defines type inheritance (an artist type under a person type, inheriting its attributes), table inheritance (a table of artists whose rows also appear in the table of people), and reference types (a column that points to a row by an object identifier). Few systems implement all of these, and Kwery does not; the specialization lesson of chapter 6 shows how the same designs are built from plain tables with keys and joins.',
      { tip: 'Much object-relational work today happens outside the database, in **object-relational mapping** libraries that turn rows into program objects and back. They save code, and they can also hide how many queries a program sends; chapter 9 has the cautionary tale.' },
      { sql: 'drop table supplier, rating, delivery_status;\ndrop type postal_address;\ndrop domain stars;\ndrop type ship_stage;' },
    ],
  });

  // ---- 8.3 textual data ----------------------------------------------------------------------------------------------------------
  const DOCS = "drop table if exists programme_note;\ncreate table programme_note (doc_id int primary key, title text, body text);\ninsert into programme_note values\n  (1, 'The Keeper of Letters', 'A lighthouse keeper alone on a rock writes letters to the sea, and the sea writes back. A quiet drama about memory and letters.'),\n  (2, 'Salt and Silver', 'A comic opera about a fishing town, its silver band and a stolen trophy. Brass, songs and the smell of the sea.'),\n  (3, 'Paper Wings', 'Dance for young audiences: a flock of paper birds learns to fly. Movement, music and a great deal of paper.'),\n  (4, 'The Night Market', 'A musical set in a night market where every stall sells a memory. Songs, lanterns and a market that vanishes at dawn.'),\n  (5, 'Iron Bridge', 'A tragedy of two families divided by a river and joined, too late, by a bridge.'),\n  (6, 'Letters Home', 'Soldiers write letters home, and their families read them aloud. A drama of letters, waiting and songs from the front.');";
  const INDEX = "drop table if exists posting;\ncreate table posting as\n  select word, doc_id, count(*) as tf\n  from programme_note, regexp_split_to_table(lower(title || ' ' || body), '[^a-z]+') as word\n  where word <> ''\n  group by word, doc_id;\ncreate index posting_word on posting (word);";
  lesson({
    id: 'cx-text', chapter: 8, title: 'Textual data and information retrieval', minutes: 14,
    summary: 'Searching text is about relevance, not exact matches. Build an inverted index in SQL, answer keyword queries with it, and rank the results by TF-IDF.',
    body: [
      '**Information retrieval** is the study of finding documents that match a need expressed as a few **keywords**. Unlike a SQL query, a keyword query has no single right answer: some documents are more **relevant** than others, and the system has to rank them.',
      'Here is a tiny collection: the programme notes of six productions.',
      { sql: DOCS + '\nselect doc_id, title from programme_note order by doc_id;' },
      'Scanning every document for every query is too slow for large collections. Search engines build an **inverted index**: for each word, the list of documents containing it (its **postings**), here with the number of times the word appears in the document, its **term frequency** (tf).',
      { sql: INDEX + "\nselect word, doc_id, tf\nfrom posting\nwhere word in ('letters', 'sea', 'songs')\norder by word, doc_id;" },
      { predict: { q: 'A keyword query asks for documents with both "letters" and "songs". How do you answer it from the index?', options: ['Intersect the postings of the two words: documents that appear in both lists', 'Union the two postings lists', 'Scan the bodies of all documents'], answer: 0, explain: 'An AND query is an intersection of postings lists, an OR query a union. That is why the index stores, for each word, the documents containing it.' }, sql: "select doc_id from posting where word = 'letters'\nintersect\nselect doc_id from posting where word = 'songs';" },
      { h: 'Ranking by TF-IDF' },
      'A document that uses a query word often is likely to be about it: that is term frequency. But a word that appears in nearly every document (like "and") says little about any of them. **Inverse document frequency** measures how rare a word is: idf = log(N / df), where N is the number of documents and df the number containing the word. A document\'s score for a query is the sum, over the query words, of tf × idf (with tf usually damped by a logarithm).',
      { sql: "with n as (select count(*) as n from programme_note),\n     idf as (select word, ln((select n from n)::numeric / count(*)) as idf\n             from posting group by word),\n     q(word) as (values ('letters'), ('sea'))\nselect d.title,\n       round(sum((1 + ln(p.tf)) * i.idf)::numeric, 3) as score\nfrom q join posting p using (word)\n       join idf i using (word)\n       join programme_note d using (doc_id)\ngroup by d.title\norder by score desc, d.title;", note: 'The Keeper of Letters ranks first: it uses both words, each more than once.' },
      { h: 'Judging the results' },
      'Two measures say how good a retrieval system is on a query, given which documents really are relevant. **Precision** is the fraction of retrieved documents that are relevant; **recall** is the fraction of relevant documents that were retrieved. Returning everything gives perfect recall and poor precision; returning one sure hit gives the opposite. Ranking lets a user stop reading when precision drops.',
      'On the web, rank also uses the links between pages: **PageRank** gives a page a high score when pages with high scores link to it. Chapter 10 computes something similar with a recursive query over a graph.',
      { tip: 'Real search engines also remove **stop words** (and, of, the), reduce words to a **stem** (learning, learns, learn), and store word positions so that phrases can be matched. PostgreSQL bundles all of this as full-text search, with tsvector and tsquery types and a GIN index; Kwery does not have it built in, which is why you built the index yourself.' },
      { sql: 'drop table posting, programme_note;' },
    ],
  });

  // ---- 8.4 spatial data ----------------------------------------------------------------------------------------------------------
  lesson({
    id: 'cx-spatial', chapter: 8, title: 'Spatial data and R-trees', minutes: 13,
    summary: 'Points and rectangles stored as numeric columns, the queries spatial applications ask (window, nearest neighbour, spatial join), and an R-tree index that answers them without reading everything.',
    body: [
      '**Spatial data** describes where things are: points (a bus stop), lines (a road), polygons (a campus). Geographic systems store them in special types; the underlying ideas need nothing more than coordinates in numeric columns. Put the Theatre network\'s eight venues on a map of the region, in kilometres from its south-west corner:',
      { sql: "drop table if exists venue_site;\ncreate table venue_site (venue_code text primary key, x float8, y float8);\ninsert into venue_site values\n  ('RIV', 120, 340), ('HAR', 410, 380), ('GLA', 260, 150), ('OLD', 520, 90),\n  ('LAN', 80, 60), ('MER', 330, 520), ('FER', 600, 300), ('COP', 470, 240);\nselect s.venue_code, v.venue_name, s.x, s.y\nfrom venue_site s join venue v using (venue_code)\norder by s.venue_code;" },
      { h: 'Window queries' },
      'A **window query** (or range query) asks for the objects inside a rectangle. Which venues lie in the box from (100, 100) to (450, 400)?',
      { predict: { q: 'Which venues are in the window x between 100 and 450, y between 100 and 400?', options: ['RIV, HAR and GLA', 'RIV, HAR, GLA and COP', 'GLA only', 'RIV, HAR, GLA and MER'], answer: 0, explain: 'RIV (120, 340), HAR (410, 380) and GLA (260, 150) are inside. COP is just too far east (x = 470), MER too far north (y = 520), OLD and LAN too far south, FER too far east.' }, sql: 'select venue_code\nfrom venue_site\nwhere x between 100 and 450 and y between 100 and 400\norder by venue_code;' },
      { h: 'Nearest neighbours and spatial joins' },
      'A **nearest-neighbour** query asks for the objects closest to a point. The three venues nearest the railway junction at (300, 0):',
      { sql: 'select venue_code, round(sqrt((x - 300)^2 + (y - 0)^2)) as km\nfrom venue_site\norder by (x - 300)^2 + y^2\nlimit 3;' },
      'A **spatial join** pairs objects by their positions. Large stages (700 seats or more) within 250 km of the Glasshouse Theatre (GLA), with the stage table joined in:',
      { sql: "select st.venue_code, st.stage_no, st.seats,\n       round(sqrt((b.x - g.x)^2 + (b.y - g.y)^2)) as km_from_gla\nfrom stage st\n  join venue_site b using (venue_code)\n  cross join (select x, y from venue_site where venue_code = 'GLA') g\nwhere st.seats >= 700\n  and (b.x - g.x)^2 + (b.y - g.y)^2 <= 250^2\norder by km_from_gla, st.venue_code, st.stage_no;" },
      { h: 'An R-tree' },
      'A B+ tree orders values along one dimension, so it cannot answer "x in this range and y in that range" without reading everything in one of the ranges. An **R-tree** groups nearby objects into rectangles, and nearby rectangles into bigger rectangles, up to a root. A query descends only into rectangles that overlap its window. Make many points (say, the homes of a few thousand patrons) and index them:',
      { sql: "drop table if exists sensor_site;\ncreate table sensor_site (id int primary key, x float8, y float8);\ninsert into sensor_site\n  select g, (g * 37) % 700, (g * 61) % 599\n  from generate_series(1, 3000) as g;\ncreate index sensor_xy on sensor_site using rtree (x, y);\nanalyze sensor_site;\nset enable_seqscan = off;\nexplain analyze\nselect id from sensor_site\nwhere x between 200 and 260 and y between 100 and 140;", note: 'The plan shows an Index Scan using sensor_xy, with both ranges as its index condition.' },
      'An R-tree index can also hold rectangles: `using rtree (xmin, ymin, xmax, ymax)` indexes four columns as a box, and a query that asks which boxes contain a point, or overlap a window, uses it the same way.',
      { view: 'indexlab', label: 'Build an R-tree, a k-d tree and a quadtree point by point in the index playground' },
      { tip: 'In the index playground, choose **R-tree** under Spatial, insert the twelve preset points, and step through each split. Then drag a rectangle to run a window query and see which nodes it visits. The **k-d tree** and **quadtree** split space instead of grouping objects; compare how each divides the same points.' },
      { sql: 'reset enable_seqscan;\ndrop table sensor_site, venue_site;' },
    ],
  });

  // ---- exercises ---------------------------------------------------------------------------------------------------------------
  const ex = (x) => C.exercise(Object.assign({ chapter: 8, db: 'theatre' }, x));
  const ARTIST_DOC = "with roster as (\n  select jsonb_build_object(\n           'name', p.given_name || ' ' || p.family_name,\n           'company', a.company_id,\n           'fee', a.fee,\n           'cast_in', coalesce((select jsonb_agg(distinct c.prod_id) from casting c where c.person_id = a.person_id), '[]')\n         ) as doc\n  from artist a join person p on p.person_id = a.person_id\n)";
  const SHOW_DOC = { sql: ARTIST_DOC + '\nselect doc from roster;', run: false };
  const MAP = "with site(venue_code, x, y) as (\n  values ('RIV', 120, 340), ('HAR', 410, 380), ('GLA', 260, 150), ('OLD', 520, 90),\n         ('LAN', 80, 60), ('MER', 330, 520), ('FER', 600, 300), ('COP', 470, 240)\n)";

  ex({ id: 'cx-x-company-doc', level: 1, title: 'One JSON object per company',
    text: ['For each company, return its id and a jsonb object with the fields `city` and `budget`. Name the columns company_id and doc.'],
    ref: "select company_id, jsonb_build_object('city', city, 'budget', budget) as doc\nfrom company",
    wrongs: ["select company_id, jsonb_build_object('city', city) as doc from company", "select company_id, jsonb_build_object('city', name, 'budget', budget) as doc from company"],
    hints: ['jsonb_build_object takes name, value, name, value, ...', 'The field names are string literals: \'city\' and \'budget\'.', "select company_id, jsonb_build_object('city', city, 'budget', budget) as doc from company"] });

  ex({ id: 'cx-x-cast-array', level: 2, ordered: false, title: 'A company\'s artists as a JSON array',
    text: ['For each company that has at least one artist, return the company id and a JSON array of its artists\' family names in alphabetical order. Freelance artists (with no company) should not appear, and neither should companies without artists.'],
    ref: 'select a.company_id, jsonb_agg(p.family_name order by p.family_name) as names\nfrom artist a join person p on p.person_id = a.person_id\nwhere a.company_id is not null\ngroup by a.company_id',
    wrongs: ['select a.company_id, jsonb_agg(p.family_name order by p.family_name) as names from artist a join person p on p.person_id = a.person_id group by a.company_id', 'select a.company_id, jsonb_agg(p.family_name) as names from artist a join person p on p.person_id = a.person_id where a.company_id is not null group by a.company_id'],
    hints: ['The family names are in person; join it with artist on person_id.', 'jsonb_agg collects the values of a group into an array, and accepts an order by inside its parentheses.', 'Leave out the artists whose company_id is null, or they form a group of their own.'] });

  ex({ id: 'cx-x-doc-fields', level: 1, title: 'Reading fields of a document',
    text: ['Start your query with this `with` clause, which turns each artist into one jsonb document:', SHOW_DOC, 'Using only the `roster` documents and JSON operators, return the name (as text) and the fee (as numeric) of every artist whose fee is above 6000.'],
    ref: ARTIST_DOC + "\nselect doc ->> 'name' as name, (doc ->> 'fee')::numeric as fee\nfrom roster\nwhere (doc ->> 'fee')::numeric > 6000",
    wrongs: [ARTIST_DOC + "\nselect doc ->> 'name' as name, (doc ->> 'fee')::numeric as fee\nfrom roster\nwhere (doc ->> 'fee')::numeric >= 600"],
    hints: ['`->>` returns a field as text.', 'Cast the text to compare it as a number: `(doc ->> \'fee\')::numeric`.', "select doc ->> 'name', (doc ->> 'fee')::numeric from roster where (doc ->> 'fee')::numeric > 6000"] });

  ex({ id: 'cx-x-doc-contains', level: 2, title: 'Containment in a JSON array',
    text: ['With the same `roster` documents as the previous exercise, find the names of the artists whose `cast_in` array contains the production PR101. Use the containment operator `@>`.', SHOW_DOC],
    ref: ARTIST_DOC + "\nselect doc ->> 'name' as name\nfrom roster\nwhere doc -> 'cast_in' @> '[\"PR101\"]'",
    wrongs: [ARTIST_DOC + "\nselect doc ->> 'name' as name\nfrom roster\nwhere doc -> 'cast_in' @> '[\"PR102\"]'"],
    hints: ['`doc -> \'cast_in\'` is the array, as jsonb.', 'An array contains another array if it has all of its elements: `\'["PR101"]\'`.', 'Or test the whole document: doc @> \'{"cast_in": ["PR101"]}\'.'] });

  ex({ id: 'cx-x-unnest-json', level: 2, title: 'From a JSON array back to rows',
    text: ['With the `roster` documents, return one row for each (artist name, production id) pair in the `cast_in` arrays, as two text columns. An artist cast in nothing contributes no rows.', SHOW_DOC],
    ref: ARTIST_DOC + "\nselect doc ->> 'name' as name, c as prod_id\nfrom roster, jsonb_array_elements_text(doc -> 'cast_in') as c",
    hints: ['A set-returning function in the from clause runs once for each row before it.', 'jsonb_array_elements_text gives the elements of a jsonb array as text rows.', "from roster, jsonb_array_elements_text(doc -> 'cast_in') as c"] });

  ex({ id: 'cx-x-years-array', level: 1, ordered: false, title: 'Years as an array',
    text: ['For each patron who has booked at least one performance, return the patron id and an array of the distinct years (as integers) in which the performances they booked took place, in increasing order.'],
    ref: 'select b.patron_id, array_agg(distinct extract(year from f.perf_date)::int order by extract(year from f.perf_date)::int) as years\nfrom booking b join performance f on f.perf_id = b.perf_id\ngroup by b.patron_id',
    wrongs: ['select b.patron_id, array_agg(extract(year from f.perf_date)::int order by extract(year from f.perf_date)::int) as years from booking b join performance f on f.perf_id = b.perf_id group by b.patron_id'],
    hints: ['The date is in performance; join booking with it and group by patron.', 'array_agg collects values into an array, and accepts distinct and order by inside its parentheses (ordering by the same expression).', 'Without distinct, a year appears once for every booking in it.'] });

  ex({ id: 'cx-x-any', level: 1, title: 'Matching any element of an array',
    text: ['Return the ids and names of the patrons who booked a performance of at least one of the productions in the array `ARRAY[\'PR101\', \'PR104\', \'PR120\']`. Use `= any(...)`, and list each patron once.'],
    ref: "select distinct p.patron_id, p.name\nfrom patron p\n  join booking b on b.patron_id = p.patron_id\n  join performance f on f.perf_id = b.perf_id\nwhere f.prod_id = any(ARRAY['PR101', 'PR104', 'PR120'])",
    wrongs: ["select p.patron_id, p.name from patron p join booking b on b.patron_id = p.patron_id join performance f on f.perf_id = b.perf_id where f.prod_id = any(ARRAY['PR101', 'PR104', 'PR120'])"],
    hints: ['x = any(arr) is true when x equals some element of arr.', 'The production of a booking is found through its performance: patron, booking, performance.', 'A patron who booked two of them appears twice unless you use distinct.'] });

  ex({ id: 'cx-x-genre-array', level: 2, title: 'Venues whose genres include a set',
    text: ['Collect the genres of the productions performed at each venue into an array, and return the venue codes whose array contains both opera and dance. Use `@>`.'],
    ref: "select f.venue_code\nfrom performance f join production p on p.prod_id = f.prod_id\ngroup by f.venue_code\nhaving array_agg(p.genre) @> ARRAY['opera', 'dance']::varchar[]",
    wrongs: ["select f.venue_code from performance f join production p on p.prod_id = f.prod_id group by f.venue_code having array_agg(p.genre) && ARRAY['opera', 'dance']::varchar[]"],
    hints: ['Join performance with production and group by venue, building array_agg(genre).', 'A condition on an aggregate goes in having.', 'arr @> ARRAY[...] is true when arr has every element of the right-hand array; && would only need one.'] });

  ex({ id: 'cx-x-words', level: 2, title: 'Words in production titles',
    text: ['Split every production title into lowercase words (split on anything that is not a letter, and ignore empty strings). Return each word that appears in the titles of at least three different productions, with the number of such productions.'],
    ref: "select word, count(distinct prod_id) as productions\nfrom production, regexp_split_to_table(lower(title), '[^a-z]+') as word\nwhere word <> ''\ngroup by word\nhaving count(distinct prod_id) >= 3",
    wrongs: ["select word, count(distinct prod_id) as productions from production, regexp_split_to_table(title, '[^a-z]+') as word where word <> '' group by word having count(distinct prod_id) >= 3"],
    hints: ['regexp_split_to_table(text, pattern) returns one row per piece.', "lower(title) first, and the pattern '[^a-z]+' splits on runs of anything else.", 'Group by the word and keep groups with count(distinct prod_id) >= 3: a title can use a word twice.'] });

  ex({ id: 'cx-x-word-index', level: 3, title: 'A keyword query with an inverted index',
    text: ['Build an inverted index of production titles in a `with` clause: one row per (word, prod_id), words lowercased and split as in the previous exercise. Using only that index (and production, for the titles), return the titles of the productions whose title contains the word "salt" or the word "ropewalk", together with the number of the two words each contains, best first and then by title.'],
    ref: "with idx as (\n  select distinct word, prod_id\n  from production, regexp_split_to_table(lower(title), '[^a-z]+') as word\n  where word <> ''\n)\nselect p.title, count(*) as matched\nfrom idx join production p using (prod_id)\nwhere idx.word in ('salt', 'ropewalk')\ngroup by p.prod_id, p.title\norder by matched desc, p.title",
    hints: ['The index is select distinct word, prod_id from production, regexp_split_to_table(...).', 'An OR query is a union of postings: keep index rows whose word is one of the two.', 'Count the matching rows per production, and order by that count descending, then by title.'] });

  ex({ id: 'cx-x-window', level: 2, title: 'A window query on the regional map',
    text: ['The map of the spatial lesson is given as a `with` clause. Return the venue code, stage number and seats of every stage in a venue that lies inside the window 100 ≤ x ≤ 450, 100 ≤ y ≤ 400.', { sql: MAP + '\nselect * from site;', run: false }],
    ref: MAP + "\nselect st.venue_code, st.stage_no, st.seats\nfrom stage st join site s using (venue_code)\nwhere s.x between 100 and 450 and s.y between 100 and 400",
    wrongs: [MAP + "\nselect st.venue_code, st.stage_no, st.seats\nfrom stage st join site s using (venue_code)\nwhere s.x between 100 and 450 or s.y between 100 and 400"],
    hints: ['Join stage with the site rows on venue_code.', 'A window is two ranges, one on x and one on y, and both must hold.', 'where s.x between 100 and 450 and s.y between 100 and 400'] });
})(typeof window !== 'undefined' ? window : globalThis);
