// Chapter 6: database design with the E-R model. The design process, entity sets and attributes, relationship
// sets, mapping cardinalities and participation, keys, weak entity sets, the reduction to relational schemas,
// specialization, generalization and aggregation, and the design choices the chapter discusses. Most lessons
// open the E-R editor with a small model of their own; the SQL blocks build the tables such a model becomes.
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
  /** a button that opens the E-R editor on a model typed in its text format */
  const er = (name, text, label, more) => ({ view: 'er', sel: Object.assign({ text, name }, more || {}), label });
  const REPLACES = 'The button replaces the diagram in the editor with this one. Your own diagram is not lost: Undo in the editor brings it back.';

  // ---- 6.1 the design process ------------------------------------------------------------------------------------------
  lesson({
    id: 'erm-process', chapter: 6, title: 'The design process and the E-R model', minutes: 9,
    summary: 'A database is designed in phases, from what its users need to how it is stored. The E-R model is the language of the middle phase.',
    body: [
      'Before anyone writes `create table`, someone has to decide what the database should hold. For a small database that can happen in one person\'s head. For a real one it is a process with several phases, each producing something the next one uses.',
      { steps: [
        '**Requirements.** Talk to the people who will use the data and write down what they need: the things they keep track of, the questions they ask, the rules they follow.',
        '**Conceptual design.** Describe that world precisely, without yet thinking about tables: the kinds of things there are, their properties, and how they are connected. This is where the E-R model is used.',
        '**Functional requirements.** List the operations the users will perform (book seats for a performance, find the productions a company has staged) and check that the conceptual design supports each one.',
        '**Logical design.** Turn the conceptual design into relation schemas. For an E-R design there are rules that do this almost mechanically; a later lesson in this chapter follows them.',
        '**Physical design.** Decide how the relations are stored: indexes, file organization, partitioning. This can change later without touching the logical design.',
      ] },
      'Two dangers run through every phase. **Redundancy** stores the same fact in more than one place, and the copies can come to disagree. **Incompleteness** makes some fact impossible to record: a design that writes a theatre company\'s name only on the productions it stages cannot describe a company that has just been founded and has staged nothing yet.',
      { h: 'The E-R model in one paragraph' },
      'The **entity-relationship model** describes a world as **entities** (distinguishable things: a venue, a production), grouped into **entity sets**, and **relationships** among entities, grouped into **relationship sets**. Both can have **attributes**. A diagram draws entity sets as rectangles and relationship sets as diamonds. That is almost all of it; the rest of the chapter adds precision.',
      'The Theatre database you have been querying was designed this way. Its tables still show the design: each foreign key is a connection the E-R diagram drew as a line. The catalog lists them:',
      { sql: "select conrelid::regclass as from_table,\n       confrelid::regclass as to_table,\n       conname\nfrom pg_constraint\nwhere contype = 'f'\norder by 1, 2;", note: 'Thirteen connections among eleven tables.' },
      'The E-R editor can read these tables back into a diagram. It has to guess in places, because the tables lose some of what the diagram said. Open it and choose **From the database**:',
      { view: 'er', sel: { fromDb: true }, label: 'Read the Theatre tables into an E-R diagram' },
      { predict: { q: 'A designer decides that the `patron` table should have a B+ tree index on `name`. Which phase is that decision part of?', options: ['Physical design', 'Conceptual design', 'Logical design', 'Requirements'], answer: 0, explain: 'An index changes how data is stored and found, not what the data means. It belongs to physical design, and adding or dropping it never changes the answer to a query.' } },
      'Here is a much smaller design to start with: theatre companies stage productions, each production staged by exactly one company, and a production can play at any number of venues.',
      er('Productions', 'entity company (company_id integer key, company_name varchar(40), founded integer)\nentity production (prod_id integer key, title varchar(60), opening date)\nentity venue (venue_code varchar(6) key, venue_name varchar(40), city varchar(30))\nrelationship staged_by (production [1..1] total, company [0..*])\nrelationship plays_at (production [0..*], venue [0..*])\n', 'Open a small design in the E-R editor'),
      { tip: REPLACES + ' The **Text** tab shows the same design as text; edit either and the other follows.' },
      'The Theatre tables avoid that kind of incompleteness: a company is a row of its own in `company`, so it can be recorded before it stages anything. Had company names been kept only in the production rows, a company with no productions could not be stored at all. This query looks for such companies:',
      { sql: 'select c.company_id, c.name, c.founded\nfrom company c\nwhere not exists (select 1 from production p where p.company_id = c.company_id);', note: 'A company that has staged nothing yet. The design that wrote company names only on productions could not hold this row.' },
    ],
  });

  // ---- 6.2 entity sets and attributes -----------------------------------------------------------------------------------
  const VOLUNTEER = 'entity volunteer (vol_id varchar(6) key,\n  name (given_name varchar(20), family_name varchar(30)),\n  home (line1 varchar(40), town varchar(30), postcode varchar(10)),\n  {email varchar(60)},\n  joined date,\n  years_active() derived from joined)\n';
  lesson({
    id: 'erm-entities', chapter: 6, title: 'Entity sets and attributes', minutes: 11,
    summary: 'Entities are described by attributes. An attribute can be simple or composite, single-valued or multivalued, stored or derived.',
    body: [
      'An **entity** is a thing that can be told apart from all other things: one particular volunteer at a food bank, say. An **entity set** is a collection of entities of the same kind, described by the same **attributes**. Each attribute has a **domain**, the set of values it may take.',
      'Attributes come in a few kinds. A food bank keeps this about each volunteer:',
      { table: [['Attribute', 'Kind', 'Why'],
        ['vol_id', 'simple, single-valued', 'one indivisible value per volunteer; it is also the key'],
        ['name', 'composite', 'made of given_name and family_name, which can be used apart or together'],
        ['home', 'composite', 'line1, town and postcode; a query can ask about the town alone'],
        ['email', 'multivalued', 'a volunteer can have none, one or several addresses'],
        ['joined', 'simple', 'the date they started'],
        ['years_active', 'derived', 'computed from joined and today\'s date, so it is never stored']] },
      'In the diagram, components of a composite attribute are indented under it, a multivalued attribute is written in braces, and a derived one ends in parentheses.',
      er('Volunteers', VOLUNTEER, 'Open the volunteer entity set'),
      { tip: REPLACES },
      'Tables have only simple, single-valued columns, so the attributes are reshaped when the design becomes tables. The composites are flattened into their components; the multivalued attribute gets a table of its own.',
      { sql: "drop table if exists volunteer_email, volunteer;\ncreate table volunteer (\n  vol_id      varchar(6) primary key,\n  given_name  varchar(20),\n  family_name varchar(30),\n  line1       varchar(40),\n  town        varchar(30),\n  postcode    varchar(10),\n  joined      date\n);\ncreate table volunteer_email (\n  vol_id varchar(6) references volunteer on delete cascade,\n  email  varchar(60),\n  primary key (vol_id, email)\n);\ninsert into volunteer values\n  ('V01', 'Noor', 'Haddad', '4 Mill Lane', 'Easton', 'E4 2AB', date '2019-03-15'),\n  ('V02', 'Tomas', 'Berg', '18 Quay Road', 'Weston', 'W1 7QR', date '2023-10-01'),\n  ('V03', 'Ines', 'Okafor', null, 'Easton', null, date '2025-06-20');\ninsert into volunteer_email values\n  ('V01', 'noor@example.org'), ('V01', 'n.haddad@example.net'), ('V02', 'tomas@example.org');" },
      { predict: { q: 'Noor gets a third email address. How does the database record it?', options: ['One more row in volunteer_email', 'A new column email3 in volunteer', 'Her volunteer row is copied with the new address'], answer: 0, explain: 'Each value of a multivalued attribute is a row of its own. Adding a value never changes the schema, and nothing else about Noor is repeated.' }, sql: "insert into volunteer_email values ('V01', 'noor.h@example.com');\nselect vol_id, count(*) as addresses\nfrom volunteer_email\ngroup by vol_id\norder by vol_id;" },
      'A derived attribute is computed in the query that needs it. Here `years_active` is worked out from `joined`, as of a fixed date so that the answer does not change from day to day:',
      { sql: "select v.given_name || ' ' || v.family_name as name,\n       v.town,\n       extract(year from age(date '2026-09-01', v.joined)) as years_active,\n       string_agg(e.email, ', ' order by e.email) as emails\nfrom volunteer v left join volunteer_email e using (vol_id)\ngroup by v.vol_id, v.given_name, v.family_name, v.town, v.joined\norder by v.vol_id;", note: 'Ines has no email: the left join keeps her, with a null list.' },
      { h: 'Null values' },
      'An attribute can be **null** when a value does not apply or is not known. Ines\'s street address is null because she has not given it yet. In the design, a null is a statement about one entity, not about the attribute: most volunteers do have an address.',
      { def: 'Choosing the kind.', text: 'Whether an attribute is composite or simple depends on how it is used. If nobody ever asks for a postcode on its own, `home` could be one simple text attribute. Design for the questions people will ask.' },
      'Tidy up:',
      { sql: 'drop table volunteer_email, volunteer;' },
    ],
  });

  // ---- 6.2 relationship sets ----------------------------------------------------------------------------------------------
  lesson({
    id: 'erm-relationships', chapter: 6, title: 'Relationship sets, roles and degree', minutes: 11,
    summary: 'A relationship set connects entity sets. Roles name the part each entity plays, descriptive attributes describe the connection itself, and the degree counts the entity sets involved.',
    body: [
      'A **relationship** is an association among entities: the artist Mira Sol belongs to the company Lantern Players. A **relationship set** is a set of relationships of the same kind. Mathematically it is a subset of the cartesian product of the entity sets it connects: each relationship is one tuple (an artist, a company).',
      'The Theatre data you have been querying stores its relationships the same way. Which artist is cast in which production is kept in the table `casting`, one row per relationship (with the role as a descriptive attribute):',
      { sql: "select p.given_name || ' ' || p.family_name as artist, pr.title as production, c.role_name\nfrom casting c\n  join person p on p.person_id = c.person_id\n  join production pr on pr.prod_id = c.prod_id\norder by pr.title, artist\nlimit 8;" },
      { h: 'Roles' },
      'The entity sets of a relationship set need not be different. In a theatre company an experienced artist coaches a newer one: both ends of the relationship are artists. Each end then needs a **role** name to say which artist plays which part, here coach and trainee. Such a relationship set is called **recursive**. The Theatre data has one: the table `mentor` pairs an artist with an artist they mentor, and its two columns, `mentor_id` and `mentee_id`, do the work of the roles.',
      { sql: "select m.given_name || ' ' || m.family_name as mentor,\n       e.given_name || ' ' || e.family_name as mentee,\n       r.since\nfrom mentor r\n  join person m on m.person_id = r.mentor_id\n  join person e on e.person_id = r.mentee_id\norder by r.since, mentor\nlimit 8;" },
      { predict: { q: 'What would go wrong if `mentor` had two columns both simply called `artist`?', options: ['Nothing would say who mentors whom: the roles are what give the pair its direction', 'Nothing: a pair of artists is a pair of artists', 'The table could not have a primary key'], answer: 0, explain: 'The pair (A, B) and the pair (B, A) mean opposite things: A teaching B, or B teaching A. The role names are the only thing that distinguishes them, in the diagram and in the table.' } },
      { h: 'Descriptive attributes' },
      'A relationship can have attributes of its own, describing the connection rather than either entity. The rating a theatregoer gives a production is not a property of the theatregoer (who rates many productions) or of the production (rated by many people). It belongs to the pair. The Theatre data has the same shape: the rating in `booking` belongs to a patron and a performance together. Here are the bookings of one patron, with the rating given to each performance (null where none was given):',
      { sql: "select b.perf_id, pr.title, pf.perf_date, b.seats, b.rating\nfrom booking b\n  join performance pf on pf.perf_id = b.perf_id\n  join production pr on pr.prod_id = pf.prod_id\nwhere b.patron_id = (select min(patron_id) from booking)\norder by pf.perf_date\nlimit 8;" },
      'Here is a small design with both ideas, drawn the way a designer might have sketched the Theatre data: artists coach other artists (a recursive relationship with the roles coach and trainee) and the coaching has a start date; patrons attend productions and give each one a rating.',
      er('Coaching', 'entity artist (artist_id integer key, billed_as varchar(40))\nentity patron (patron_id integer key, name varchar(40))\nentity production (prod_id integer key, title varchar(60))\nrelationship attends (patron [0..*], production [0..*]) with (rating integer)\nrelationship coaches (artist as coach [0..*], artist as trainee [0..1]) with (since date)\n', 'Open the design with roles'),
      { tip: REPLACES + ' Open the **Checks** tab: the checker notes that `since` could also be an attribute of the trainee, since each artist has at most one coach. Both choices are correct.' },
      { h: 'Degree' },
      'The number of entity sets in a relationship set is its **degree**. Most are **binary** (degree 2). Some facts need three: a musician performs a piece at a concert. Recording the three together says exactly which piece was played at which concert by whom, which two binary relationships could not say. A later lesson looks at that choice closely.',
      er('Concerts', 'entity musician (m_id varchar(5) key, name varchar(30))\nentity piece (p_id varchar(5) key, title varchar(50), composer varchar(30))\nentity concert (c_id varchar(5) key, held_on date, venue varchar(30))\nrelationship performs (musician [0..*], piece [0..*], concert [1..*] total)\n', 'Open a ternary relationship set'),
    ],
  });

  // ---- 6.3 mapping cardinalities and participation -------------------------------------------------------------------
  const CARD = 'entity person (person_id integer key, name varchar(40))\nentity stage (stage_id integer key, seats integer)\nentity company (company_id integer key, company_name varchar(40))\nentity production (prod_id integer key, title varchar(60))\nrelationship runs (person [0..1], stage [0..*])\nrelationship staged_by (production [1..1] total, company [0..*])\nrelationship directs (person [0..1], company [1..1] total)\n';
  lesson({
    id: 'erm-cardinality', chapter: 6, title: 'Mapping cardinalities and participation', minutes: 12,
    summary: 'How many entities an entity can be related to: one-to-one, one-to-many, many-to-one or many-to-many. Participation says whether every entity must take part. min..max says both at once.',
    body: [
      'For a binary relationship set between A and B, the **mapping cardinality** says how many B entities one A entity can be related to, and the other way round.',
      { table: [['Cardinality', 'Meaning', 'Example'],
        ['one-to-one', 'an A with at most one B, a B with at most one A', 'a person directs at most one theatre company; a company has one artistic director'],
        ['one-to-many', 'an A with any number of B, a B with at most one A', 'a company stages many productions; a production is staged by one company'],
        ['many-to-one', 'the same, seen from the other side', 'productions to the company that stages them'],
        ['many-to-many', 'no limit either way', 'theatregoers and the productions they see']] },
      'These are statements about the world being modelled, not about today\'s data. Still, the data must obey them. In the Theatre data, an artist belongs to at most one company: the relationship is many-to-one from artists to companies. Is there an artist with two companies?',
      { sql: 'select person_id, count(company_id) as companies\nfrom artist\ngroup by person_id\nhaving count(company_id) > 1;', note: 'No rows. The company is a single column of the artist\'s row, and person_id is the key, so a second company cannot even be written down.' },
      'The other side is many: how many artists do the biggest companies have?',
      { sql: 'select c.name, count(*) as artists\nfrom artist a join company c on c.company_id = a.company_id\ngroup by c.company_id, c.name\norder by artists desc, c.name\nlimit 3;' },
      { h: 'Participation' },
      'Participation of an entity set is **total** if every entity in it takes part in at least one relationship of the set, and **partial** otherwise. Not every artist belongs to a company (some work freelance), so artists take part partially:',
      { sql: 'select count(*) as freelance_artists\nfrom artist\nwhere company_id is null;' },
      'Every production, on the other hand, is staged by a company: total participation. The schema enforces it with `not null` on `production.company_id`. Now suppose a designer also declared that every company has at least one artist. Nothing in the tables enforces that. Is it kept anyway?',
      { sql: 'select c.company_id, c.name\nfrom company c\nwhere not exists (select 1 from artist a where a.company_id = c.company_id);', note: 'Some companies have no artists. A rule of the design that the schema does not enforce is a rule the data can break.' },
      { h: 'min..max' },
      'One notation says both things at once. A line from an entity set to a relationship set is labelled **min..max**: each entity takes part in at least min and at most max relationships of the set (`*` means no limit). min = 1 is total participation; max = 1 is the "one" side of a cardinality.',
      { predict: { q: 'In the design below, the person line of runs is labelled 0..1. What does it say?', options: ['A person runs at most one stage, and may run none', 'A stage is run by at most one person', 'Every person runs exactly one stage', 'A person runs at least one stage'], answer: 0, explain: 'The label is on the person\'s line, so it counts relationships per person: from 0 (partial participation) to 1 (at most one stage). It says nothing directly about how many people run a stage; that is the 0..* on the other line.' } },
      er('Cardinalities', CARD, 'Open the design in the boxed-attribute notation'),
      { tip: REPLACES + ' Select a line in the diagram to change its min and max in the Properties tab, and watch the arrow or the double line change.' },
      'The same design looks different in other notations. Chen\'s notation writes 1 and N on the lines; crow\'s foot notation, common in industry, draws a fork on the many side and a bar or circle for one and zero:',
      er('Cardinalities', CARD, 'The same design in crow\'s foot notation', { notation: 'crowsfoot' }),
      er('Cardinalities', CARD, 'The same design in Chen\'s notation', { notation: 'chen' }),
      { warn: 'Read the labels carefully when you switch notations. In min..max the label sits next to the entity it counts for; in crow\'s foot notation the symbol sits at the far end, next to the entity being counted. Both are common, and mixing them up reverses the meaning.' },
      'Finally, partial participation you can see in the data: productions that have never been performed, perhaps still in rehearsal. Productions take part in performances partially, which allows it.',
      { sql: 'select p.prod_id, p.title, p.genre\nfrom production p\nwhere not exists (select 1 from performance f where f.prod_id = p.prod_id)\norder by p.prod_id;' },
    ],
  });

  // ---- 6.4 keys -----------------------------------------------------------------------------------------------------------------
  lesson({
    id: 'erm-keys', chapter: 6, title: 'Keys of entity sets and relationship sets', minutes: 9,
    summary: 'A key tells entities apart. A relationship set is identified by the keys of the entities it connects, and its mapping cardinality decides which of them form its primary key.',
    body: [
      'Keys work for entity sets as they do for relations. A **superkey** is a set of attributes whose values differ for any two entities; a **candidate key** is a minimal superkey; the **primary key** is the candidate key the designer picks. The values of the key are what other parts of the design use to point at an entity.',
      'A relationship is identified by the entities it relates. So the union of the primary keys of the participating entity sets is always a superkey of a relationship set. Whether a smaller set is enough depends on the mapping cardinality:',
      { table: [['Mapping cardinality of R between A and B', 'Primary key of R'],
        ['many-to-many', 'the primary keys of A and B together'],
        ['many-to-one, from A to B', 'the primary key of A alone: each A appears in at most one relationship'],
        ['one-to-one', 'either primary key; both are candidate keys'],
        ['n-ary, no arrows', 'the primary keys of all the participants']] },
      'The Theatre tables follow these rules. `mentor` is many-to-many between artists, so its key has both artists. `booking` is many-to-many between patrons and performances, so (patron_id, perf_id) identifies a booking; it is declared unique, and the designers added a booking number as the primary key:',
      { sql: "select k.table_name, t.constraint_type, k.column_name\nfrom information_schema.key_column_usage k\n  join information_schema.table_constraints t using (constraint_name, table_name)\nwhere t.constraint_type in ('PRIMARY KEY', 'UNIQUE')\n  and k.table_name in ('mentor', 'booking')\norder by k.table_name, t.constraint_type, k.ordinal_position;" },
      { predict: { q: 'Take a patron who already has a booking for some performance. What happens when you insert a second booking for the same patron and performance?', options: ['The insert fails: (patron_id, perf_id) is declared unique', 'The patron now has two bookings for that performance', 'The old booking is replaced'], answer: 0, explain: 'A booking is one relationship between a patron and a performance, and a relationship set holds each pair at most once. The unique constraint on (patron_id, perf_id) enforces exactly that; more seats go into the seats attribute of the one booking.' }, sql: 'insert into booking (booking_id, patron_id, perf_id, seats, paid)\nselect (select max(booking_id) + 1 from booking), patron_id, perf_id, 1, 0\nfrom booking\norder by booking_id\nlimit 1;', fails: '23505' },
      'Had the designers declared only booking_id, the same insert would succeed, and "a patron books a performance once" would be lost. Choosing the keys of a relationship set is choosing what it means.',
      'A performance refers to the stage it is played on with two columns, venue_code and stage_no, because the key of stage has two parts: a stage is identified through its venue. The next lesson is about that.',
      { sql: 'select count(*) as stages,\n       count(distinct (venue_code, stage_no)) as distinct_keys,\n       count(distinct stage_no) as distinct_stage_numbers\nfrom stage;', note: 'The first two counts agree, as they must for a key. Stage numbers on their own repeat.' },
    ],
  });

  // ---- 6.5 weak entity sets ----------------------------------------------------------------------------------------------
  const PLAYLIST = 'entity playlist (pl_id int key, title varchar(40), owner varchar(30))\nweak entity slot (position int partial, song varchar(60), added date)\nidentifying relationship holds (slot [1..1] total, playlist [0..*])\n';
  lesson({
    id: 'erm-weak', chapter: 6, title: 'Weak entity sets', minutes: 10,
    summary: 'Some entities can only be told apart within another entity. A weak entity set has a discriminator instead of a key and depends on an identifying entity set.',
    body: [
      'Think of a music playlist. Its songs sit in numbered slots: slot 1, slot 2, slot 3. Slot 3 of one playlist has nothing to do with slot 3 of another. A slot number on its own identifies nothing; a slot number *within a playlist* does.',
      { def: 'Weak entity set.', text: 'An entity set whose entities are identified by an **identifying** (or owner) entity set together with a **discriminator**: the attributes that tell apart the weak entities belonging to one owner. Here the owner is playlist and the discriminator is position.' },
      'The connection to the owner is the **identifying relationship**. It is many-to-one from the weak entity set to its owner, and the weak entity set takes part in it totally: a slot cannot exist without its playlist. The primary key of a weak entity set is the owner\'s primary key plus the discriminator.',
      er('Playlists', PLAYLIST, 'Open the playlist design'),
      { tip: REPLACES + ' The diagram draws the weak entity set and its identifying relationship with double lines, and underlines the discriminator with a dashed line.' },
      'The Theatre database shows the same pattern. Stages are numbered within their venue (stage 1, stage 2, ...), and the key of `stage` includes `venue_code`, just as a weak entity set\'s key includes its owner\'s. Its foreign key to venue also cascades deletions:',
      { sql: 'select stage_no, count(*) as venues_with_this_stage_number\nfrom stage\ngroup by stage_no\norder by stage_no;' },
      'As tables, the weak entity set\'s key includes the owner\'s key, and the foreign key to the owner usually cascades deletions, because a slot means nothing once its playlist is gone:',
      { sql: "drop table if exists slot, playlist;\ncreate table playlist (\n  pl_id int primary key,\n  title varchar(40),\n  owner varchar(30)\n);\ncreate table slot (\n  pl_id    int references playlist on delete cascade,\n  position int,\n  song     varchar(60),\n  added    date,\n  primary key (pl_id, position)\n);\ninsert into playlist values (1, 'Morning', 'Ravi'), (2, 'Running', 'Ravi');\ninsert into slot values\n  (1, 1, 'Clair de lune', date '2026-01-04'), (1, 2, 'Gymnopedie No. 1', date '2026-01-04'),\n  (2, 1, 'Born to Run', date '2026-02-11'), (2, 2, 'Run Boy Run', date '2026-02-11'), (2, 3, 'Go', date '2026-03-01');\nselect p.title, s.position, s.song\nfrom playlist p join slot s using (pl_id)\norder by p.pl_id, s.position;" },
      { predict: { q: 'Delete the playlist Running. How many rows are left in slot?', options: ['2', '5', '0', 'The delete fails, because slots refer to the playlist'], answer: 0, explain: 'The three slots of playlist 2 are removed with it (on delete cascade). The two slots of Morning stay. This is the existence dependence of a weak entity set made concrete.' }, sql: "delete from playlist where pl_id = 2;\nselect count(*) from slot;" },
      { h: 'Weak or strong?' },
      'A weak entity set can always be turned into a strong one by giving it an identifier of its own (a slot_id that is unique everywhere). That costs an extra attribute and loses the fact that slots belong to playlists in the key. A weak entity set is the natural choice when the owner really does give the entities their identity, and when not much else refers to them.',
      'Tidy up:',
      { sql: 'drop table slot, playlist;' },
    ],
  });

  // ---- 6.7 reduction to relational schemas ---------------------------------------------------------------------------
  const WARDROBE = 'entity designer (designer_id varchar(6) key, name (given varchar(20), family varchar(30)))\nentity costume (costume_code varchar(8) key, title varchar(60), {fabric varchar(20)}, made date, age_years() derived from made)\nweak entity garment (garment_no int partial, rack varchar(10))\nentity troupe (troupe_id varchar(6) key, name varchar(40))\nidentifying relationship garment_of (garment [1..1] total, costume [0..*])\nrelationship designed (designer [0..*], costume [1..*] total)\nrelationship lent_to (garment [0..1], troupe [0..*]) with (due date)\n';
  const WARDROBE_DDL = [
    'drop table if exists costume_fabric, garment, troupe, designed, costume, designer cascade;',
    'create table designer (\n  designer_id varchar(6) primary key,\n  given       varchar(20),\n  family      varchar(30)\n);',
    'create table costume (\n  costume_code varchar(8) primary key,\n  title        varchar(60),\n  made         date\n);',
    'create table designed (\n  designer_id  varchar(6) references designer on delete cascade,\n  costume_code varchar(8) references costume on delete cascade,\n  primary key (designer_id, costume_code)\n);',
    'create table troupe (\n  troupe_id varchar(6) primary key,\n  name      varchar(40)\n);',
    'create table garment (\n  costume_code varchar(8) references costume on delete cascade,\n  garment_no   int,\n  rack         varchar(10),\n  troupe_id    varchar(6) references troupe on delete set null,\n  due          date,\n  primary key (costume_code, garment_no)\n);',
    'create table costume_fabric (\n  costume_code varchar(8) references costume on delete cascade,\n  fabric       varchar(20),\n  primary key (costume_code, fabric)\n);',
  ].join('\n');
  lesson({
    id: 'erm-reduce', chapter: 6, title: 'Reducing an E-R design to relational schemas', minutes: 15,
    summary: 'A handful of rules turn an E-R design into tables: one for each strong and weak entity set, one for each many-to-many relationship set, a foreign key for each many-to-one, and a table for each multivalued attribute.',
    body: [
      'Once a design is right, turning it into tables is close to mechanical. These are the rules, in the order the E-R editor applies them:',
      { table: [['Construct', 'Becomes'],
        ['strong entity set', 'a table with its simple attributes; its key is the primary key'],
        ['composite attribute', 'one column per component; no column for the composite itself'],
        ['multivalued attribute M of E', 'a table (key of E, M), with a foreign key to E'],
        ['derived attribute', 'nothing stored; compute it in a view or query'],
        ['weak entity set', 'a table with its attributes plus the owner\'s primary key; primary key = owner\'s key + discriminator'],
        ['identifying relationship', 'nothing: the weak entity\'s table already holds it'],
        ['many-to-many relationship set', 'a table of the participants\' primary keys and its descriptive attributes'],
        ['many-to-one relationship set', 'usually no table: the many side gets the one side\'s key as a foreign key, plus the descriptive attributes'],
        ['one-to-one relationship set', 'like many-to-one, on either side, with a UNIQUE foreign key'],
        ['n-ary relationship set', 'a table of all the participants\' primary keys']] },
      'Here is a small costume store of the kind a theatre keeps: designers design costumes, a costume is made of several fabrics and exists as numbered garments (a weak entity set: garment 2 of one costume has nothing to do with garment 2 of another), and a garment can be lent to a touring troupe until a due date.',
      er('Costume store', WARDROBE, 'Open the costume store design'),
      { steps: [
        'Open the design with the button above.',
        'Press **To SQL** in the editor\'s toolbar. A dialog shows the reduction one rule at a time.',
        'Step through with the arrows. Each step names the rule, the construct it was applied to and the table it changed; tables the steps have not reached yet are dimmed.',
        'Look at step **relationship-many-to-one** for lent_to: no table appears, but garment gains two columns.',
        'Untick **Combine many-to-one relationships with the many side** and see lent_to become a table of its own, keyed by the garment.',
      ] },
      { predict: { q: 'With the default rules, where do the columns of the lent_to relationship set end up?', options: ['In garment: troupe_id as a foreign key, and due', 'In a table lent_to (costume_code, garment_no, troupe_id, due)', 'In troupe', 'Nowhere: relationship sets do not become columns'], answer: 0, explain: 'lent_to is many-to-one from garment to troupe: a garment is lent to at most one troupe at a time. A many-to-one relationship set is folded into the many side, so garment gets the troupe\'s key and the descriptive attribute due. A garment that is not lent out has nulls there.' } },
      'This is the DDL the reduction produces, tidied a little. Run it to create the tables:',
      { sql: WARDROBE_DDL, note: 'The order matters: a table can only refer to tables that already exist.' },
      'Now some data, and a query that walks across the whole design: which troupe has which garment, and who designed the costume?',
      { sql: "insert into designer values ('D1', 'Wren', 'Atkins'), ('D2', 'Tomasz', 'Ilic'), ('D3', 'Amara', 'Osei');\ninsert into costume values ('QUEEN-1', 'Winter queen gown', date '2016-02-01'),\n                           ('FOX-2', 'Fox with tail', date '2022-09-15');\ninsert into designed values ('D1', 'QUEEN-1'), ('D2', 'FOX-2'), ('D3', 'FOX-2');\ninsert into costume_fabric values ('QUEEN-1', 'velvet'), ('QUEEN-1', 'lace'), ('FOX-2', 'faux fur');\ninsert into troupe values ('T1', 'Northgate Touring'), ('T2', 'Little Lamp Players');\ninsert into garment values ('QUEEN-1', 1, 'R-12', 'T2', date '2026-11-01'),\n                           ('QUEEN-1', 2, 'R-12', null, null),\n                           ('FOX-2', 1, 'R-03', 'T1', date '2026-10-28');\nselect t.name as troupe, c.title, g.garment_no, g.due,\n       string_agg(d.given || ' ' || d.family, ' and ' order by d.family) as designers\nfrom garment g\n  join troupe t using (troupe_id)\n  join costume c using (costume_code)\n  join designed x using (costume_code)\n  join designer d using (designer_id)\ngroup by t.name, c.title, g.garment_no, g.due\norder by t.name;" },
      'The derived attribute age_years has no column. A view can supply it:',
      { sql: "create or replace view costume_age as\n  select costume_code, title, extract(year from age(date '2026-09-01', made)) as age_years\n  from costume;\nselect * from costume_age order by age_years desc;" },
      { h: 'What the tables cannot say' },
      'Some constraints of the diagram do not survive. The design says every costume has at least one designer (total participation of costume in designed), but nothing in these tables stops a costume with no row in designed. The To SQL dialog lists such losses under **unenforced**; a trigger or an assertion would be needed to keep them.',
      { sql: "insert into costume values ('CLOAK-9', 'Plain grey cloak', date '2026-01-01');\nselect c.title\nfrom costume c\nwhere not exists (select 1 from designed x where x.costume_code = c.costume_code);", note: 'The insert succeeds, and the costume has no designer.' },
      'Tidy up:',
      { sql: 'drop view costume_age;\ndrop table costume_fabric, garment, troupe, designed, costume, designer;' },
    ],
  });

  // ---- 6.8 extended features ---------------------------------------------------------------------------------------------
  const CLUB = 'entity club_member (member_id varchar(6) key, name varchar(40), born date)\nentity player (position varchar(12))\nentity coach (licence_level int)\nisa club_member (player, coach) overlapping partial\nentity team (team_id varchar(4) key, age_group varchar(10))\nrelationship trains (coach [0..*], team [1..*] total)\n';
  const CONCERT_AGG = 'entity musician (m_id varchar(5) key, name varchar(30))\nentity piece (p_id varchar(5) key, title varchar(50))\nentity concert (c_id varchar(5) key, held_on date)\nentity critic (cr_id varchar(5) key, name varchar(30), outlet varchar(30))\nrelationship performs (musician [0..*], piece [0..*], concert [1..*] total)\naggregation performance of performs\nrelationship reviews (critic [0..*], performance [0..*]) with (stars int)\n';
  lesson({
    id: 'erm-extended', chapter: 6, title: 'Specialization, generalization and aggregation', minutes: 14,
    summary: 'Specialization splits an entity set into subgroups with their own attributes; generalization merges similar entity sets into one. Aggregation lets a relationship take part in another relationship.',
    body: [
      'A sports club has members. Some members play, some coach, some do both, and some only pay their fees. Players have a position; coaches have a licence level and train teams. Every member has a name and a date of birth.',
      { def: 'Specialization.', text: 'Splitting an entity set into lower-level entity sets whose entities have something extra: attributes or relationships the others lack. Player and coach are specializations of club_member, drawn with an ISA link (a player *is a* club member).' },
      { def: 'Generalization.', text: 'The same structure reached from the other direction: noticing that player and coach share attributes and building a higher-level entity set for what they share. The result is the same diagram; only the order of discovery differs.' },
      'The lower-level entity sets **inherit** every attribute and relationship of the higher-level one. A coach has a name, though the name is written only on club_member.',
      { h: 'Constraints on a specialization' },
      { list: ['**Disjoint** or **overlapping**: may an entity belong to more than one lower-level set? A member can both play and coach, so this one is overlapping.', '**Total** or **partial**: must every higher-level entity belong to some lower-level set? Members who neither play nor coach exist, so this one is partial.'] },
      er('Sports club', CLUB, 'Open the sports club design'),
      { tip: REPLACES + ' Select the ISA triangle to switch between disjoint and overlapping, total and partial.' },
      { h: 'Specialization as tables' },
      'There are three ways to reduce a specialization. The first, and the editor\'s default, makes one table for the higher-level entity set and one per lower-level set holding the inherited key and its own attributes:',
      { sql: "drop table if exists coach, player, club_member;\ncreate table club_member (member_id varchar(6) primary key, name varchar(40), born date);\ncreate table player (member_id varchar(6) primary key references club_member on delete cascade, position varchar(12));\ncreate table coach  (member_id varchar(6) primary key references club_member on delete cascade, licence_level int);\ninsert into club_member values ('C1', 'Ama Mensah', date '1990-04-02'), ('C2', 'Leo Rossi', date '2008-09-17'),\n                               ('C3', 'Sara Lind', date '1975-12-30'), ('C4', 'Omar Aziz', date '1962-07-08');\ninsert into player values ('C1', 'keeper'), ('C2', 'striker');\ninsert into coach  values ('C1', 2), ('C3', 3);" },
      { predict: { q: 'With these tables, how do you list every coach with their name?', options: ['Join coach with club_member on member_id', 'Select name from coach', 'Union coach and club_member'], answer: 0, explain: 'The name is stored once, in club_member. A coach\'s row holds only what is special to coaches, so getting the inherited attributes takes a join.' }, sql: 'select m.name, c.licence_level\nfrom coach c join club_member m using (member_id)\norder by m.name;' },
      'Membership in several lower-level sets is no trouble for this method. Ama is in both:',
      { sql: "select m.name,\n       p.member_id is not null as plays,\n       c.member_id is not null as coaches\nfrom club_member m\n  left join player p using (member_id)\n  left join coach c using (member_id)\norder by m.member_id;" },
      'The second method has no higher-level table: each lower-level table repeats all the inherited attributes. It works only for a total, disjoint specialization (otherwise Omar, who is neither, has nowhere to go, and Ama would be stored twice). The third puts everything in one table with a column saying which lower-level sets each entity belongs to, and nulls in the columns that do not apply. In the **To SQL** dialog, the Specialization menu switches among the three.',
      { h: 'Aggregation' },
      'Back to the musicians: a musician performs a piece at a concert. Now critics review performances, and a review is about one particular performance, the combination of all three. A relationship set cannot connect to another relationship set directly. **Aggregation** treats the relationship set performs, with its participants, as if it were an entity set, here called performance, which can then take part in reviews.',
      er('Reviews', CONCERT_AGG, 'Open the design with an aggregation'),
      'In tables, the aggregation is represented by the primary key of performs, so reviews holds the critic\'s key, the keys of the musician, the piece and the concert, and the stars. Step through To SQL to see the aggregation rule at work.',
      'Tidy up:',
      { sql: 'drop table coach, player, club_member;' },
    ],
  });

  // ---- 6.9 design issues -----------------------------------------------------------------------------------------------------
  lesson({
    id: 'erm-issues', chapter: 6, title: 'Design choices: entity, attribute or relationship', minutes: 13,
    summary: 'The same facts can be modelled in several ways. The chapter\'s rules of thumb, with the E-R editor\'s design checker pointing out where a design could be better.',
    body: [
      'Several E-R designs can describe the same world, and none is the one right answer. But some choices cause trouble later. The E-R editor\'s **Checks** tab has a design checker that flags the common ones and explains each. Here are the main questions.',
      { h: 'Attribute or entity set?' },
      'A production plays at a venue. Is venue an attribute of production, or an entity set related to production? If venues have properties of their own (a city, a number of seats) or take part in other relationships, they are an entity set. Making it an attribute as well stores the connection in a way the design cannot check.',
      'The same goes for a patron\'s emergency contacts, each with a name and a phone number. Contacts may be shared by members of one family and may be asked about on their own: a multivalued composite attribute with several parts is often an entity set in disguise.',
      er('Attribute or entity', 'entity production (prod_id integer key, title varchar(60), venue varchar(40))\nentity venue (venue_name varchar(40) key, city varchar(30))\nentity patron (patron_id integer key, name varchar(40), {contact (contact_name varchar(40), phone varchar(20))})\n', 'Open a design with both problems', { expect: ['attribute-is-entity', 'attribute-could-be-entity'] }),
      { tip: REPLACES + ' Then open the **Checks** tab and click each piece of advice to read why.' },
      { h: 'Entity set or relationship set?' },
      'A review could be an entity set with an id and a rating, linked to a patron and to a production. Or it could be a relationship set between patrons and productions with rating as its attribute. When the thing has little of its own and exists only to connect exactly one of each of two other things, a relationship set says that more directly.',
      er('Reviews', 'entity patron (patron_id integer key, name varchar(40))\nentity production (prod_id integer key, title varchar(60))\nentity review (review_id integer key, rating integer)\nrelationship review_patron (review [1..1] total, patron [0..*])\nrelationship review_prod (review [1..1] total, production [0..*])\n', 'Open the review-as-entity design', { expect: ['entity-could-be-relationship'] }),
      'The theatre design that the E-R editor starts with takes the second option: `attends` is a relationship set between patron and production with the attribute rating.',
      { h: 'Binary or n-ary?' },
      'A musician plays pieces, and a musician plays in venues. Two binary relationship sets, plays_piece and plays_at, seem to cover it. But they lose something. Make a ternary table of gigs and take its two binary projections:',
      { sql: "drop table if exists gig;\ncreate table gig (musician text, piece text, venue text);\ninsert into gig values\n  ('Ana', 'Bolero', 'Oslo'),\n  ('Ana', 'Clair de lune', 'Rome'),\n  ('Ben', 'Bolero', 'Rome');\nselect distinct musician, piece from gig order by 1, 2;\nselect distinct musician, venue from gig order by 1, 2;" },
      { predict: { q: 'Join the two projections on musician. How many (musician, piece, venue) rows come back?', options: ['5', '3', '4', '6'], answer: 0, explain: 'Ana has two pieces and two venues, so the join pairs each of her pieces with each of her venues: four rows, two of which never happened (Bolero in Rome, Clair de lune in Oslo). Ben adds one. The binary relationships cannot say which piece was played where.' }, sql: "select p.musician, p.piece, v.venue\nfrom (select distinct musician, piece from gig) p\n  join (select distinct musician, venue from gig) v using (musician)\norder by 1, 2, 3;" },
      'So when a fact really involves three things at once, keep it ternary. The checker notices the opposite pattern too: two binary relationship sets through one entity set that both record the same descriptive attribute, which often means they were one event all along.',
      er('Binary or ternary', 'entity musician (m_id varchar(5) key, name varchar(30))\nentity piece (p_id varchar(5) key, title varchar(50))\nentity venue (v_id varchar(5) key, city varchar(30))\nrelationship plays_piece (musician [0..*], piece [0..*]) with (on_date date)\nrelationship plays_at (musician [0..*], venue [0..*]) with (on_date date)\n', 'Open the two binary relationships', { expect: ['binaries-could-be-ternary'] }),
      'A ternary relationship set can always be replaced by an entity set with an identifier of its own (performance_id) and three many-to-one binary relationships. That works, but it needs an artificial key and extra constraints to say that each combination appears once.',
      { h: 'Where does a relationship attribute go?' },
      'For a one-to-many or many-to-one relationship set, a descriptive attribute can be moved to the entity set on the many side: since each of those entities is in at most one relationship, the attribute is still single-valued there. For a many-to-many relationship set it cannot move: a rating belongs to a patron and a production together.',
      'Tidy up:',
      { sql: 'drop table gig;' },
    ],
  });
})(typeof window !== 'undefined' ? window : globalThis);
