-- The Theatre database, Kwery's own sample, in miniature: the schema of the main Theatre sample with a handful of
-- rows per table, small enough to trace a query by hand. All names, titles, venues and cities are invented.

create table venue (
  venue_code  varchar(6) primary key,
  venue_name  varchar(40) not null,
  city        varchar(20) not null,
  opened      integer check (opened > 1800)
);
create table stage (                            -- weak entity: identified by its venue
  venue_code  varchar(6) references venue on delete cascade,
  stage_no    smallint check (stage_no > 0),
  seats       integer not null check (seats > 0),
  kind        varchar(12) not null check (kind in ('proscenium', 'thrust', 'arena', 'studio', 'open air')),
  primary key (venue_code, stage_no)
);
create table company (
  company_id  varchar(5) primary key,
  name        varchar(40) not null unique,
  city        varchar(20) not null,
  founded     integer,
  budget      numeric(12,2) check (budget > 0)
);
create table person (
  person_id   varchar(6) primary key,
  given_name  varchar(20) not null,
  family_name varchar(20) not null,
  birth_date  date,
  home_city   varchar(20)                       -- may be null
);
create table artist (                           -- a person who performs; fee is per production week
  person_id   varchar(6) primary key references person on delete cascade,
  company_id  varchar(5) references company on delete set null,   -- null: freelance
  billed_as   varchar(40),
  fee         numeric(8,2) check (fee > 0)
);
create table production (
  prod_id     varchar(6) primary key,
  title       varchar(60) not null,
  company_id  varchar(5) not null references company,
  genre       varchar(12) not null check (genre in ('drama', 'comedy', 'musical', 'opera', 'dance', 'tragedy', 'revue')),
  premiere    date,
  runtime_min integer check (runtime_min > 0),
  based_on    varchar(6) references production  -- an adaptation or sequel of another production
);
create table performance (
  perf_id     integer primary key,
  prod_id     varchar(6) not null references production,
  venue_code  varchar(6) not null,
  stage_no    smallint not null,
  perf_date   date not null,
  start_time  time not null,
  price       numeric(6,2) not null check (price >= 0),
  foreign key (venue_code, stage_no) references stage
);
create table casting (                          -- many-to-many artist x production, with the role
  person_id   varchar(6) references artist,
  prod_id     varchar(6) references production,
  role_name   varchar(40),
  lead        boolean not null default false,
  primary key (person_id, prod_id, role_name)
);
create table patron (
  patron_id   integer primary key,
  name        varchar(40) not null,
  city        varchar(20),
  joined      date not null,
  points      integer not null default 0 check (points >= 0)
);
create table booking (                          -- many-to-many patron x performance; rating null = not rated
  booking_id  integer primary key,
  patron_id   integer not null references patron,
  perf_id     integer not null references performance,
  seats       smallint not null check (seats between 1 and 8),
  paid        numeric(8,2) not null,
  rating      smallint check (rating between 1 and 5),
  unique (patron_id, perf_id)
);
create table mentor (                           -- recursive: an artist mentors another
  mentor_id   varchar(6) references artist (person_id),
  mentee_id   varchar(6) references artist (person_id),
  since       date,
  primary key (mentor_id, mentee_id),
  check (mentor_id <> mentee_id)
);

insert into venue values
  ('RVL', 'Riverlight Playhouse', 'Brightwater', 1911),
  ('HBR', 'Harbour Rooms', 'Saltreach', 1987),
  ('LNT', 'Lantern Yard', 'Brightwater', null);

insert into stage values
  ('RVL', 1, 420, 'proscenium'),
  ('RVL', 2, 60, 'studio'),
  ('HBR', 1, 250, 'thrust'),
  ('LNT', 1, 300, 'open air'),
  ('LNT', 2, 80, 'studio');

insert into company values
  ('C01', 'Brightwater Players', 'Brightwater', 1982, 850000.00),
  ('C02', 'Tin Whistle Comedy Co.', 'Saltreach', 2004, 120000.00),
  ('C03', 'Quillmere Opera Guild', 'Quillmere', 1961, 1400000.00),
  ('C04', 'Paper Moon Revue', 'Brightwater', null, 45000.00);

insert into person values
  ('P1001', 'Hana', 'Okafor', '1961-04-12', 'Brightwater'),
  ('P1002', 'Tomas', 'Lindqvist', '1979-11-03', 'Saltreach'),
  ('P1003', 'Priya', 'Moreau', '1988-02-29', null),
  ('P1004', 'Kofi', 'Valdez', '1995-07-18', 'Brightwater'),
  ('P1005', 'Zara', 'Iyer', '2001-09-30', 'Quillmere'),
  ('P1006', 'Ilya', 'Castellano', null, 'Saltreach');

insert into artist values
  ('P1001', 'C01', 'Dame Hana Okafor', 4200.00),
  ('P1002', 'C02', null, 900.00),
  ('P1003', 'C01', 'Priya Moreau', 1500.00),
  ('P1004', 'C02', null, 900.00),
  ('P1005', null, 'Zara ', 650.00);

insert into production values
  ('PR101', 'Dinner at the Ferryman''s', 'C01', 'drama', '2023-10-06', 120, null),
  ('PR102', 'The Ferryman Returns', 'C01', 'drama', '2024-10-04', 115, 'PR101'),
  ('PR103', 'Ferryman: The Revue', 'C02', 'comedy', '2025-03-14', 90, 'PR102'),
  ('PR104', 'The Copper Crown', 'C03', 'opera', '2024-11-22', 185, null),
  ('PR105', '100% Tuesday', 'C02', 'comedy', null, null, null);

insert into performance values
  (1, 'PR101', 'RVL', 1, '2024-09-20', '19:30', 32.00),
  (2, 'PR102', 'RVL', 1, '2024-10-04', '19:30', 45.00),
  (3, 'PR102', 'RVL', 1, '2024-10-05', '14:30', 35.00),
  (4, 'PR104', 'HBR', 1, '2024-11-22', '19:00', 68.50),
  (5, 'PR103', 'LNT', 1, '2025-03-14', '20:00', 0.00),
  (6, 'PR103', 'RVL', 2, '2025-03-15', '20:00', 45.00);

insert into casting values
  ('P1001', 'PR101', 'The Widow', true),
  ('P1003', 'PR101', 'The Daughter', false),
  ('P1001', 'PR102', 'The Widow', true),
  ('P1005', 'PR102', 'The Stranger', false),
  ('P1002', 'PR103', 'Compere', true),
  ('P1004', 'PR103', 'Turn', false),
  ('P1004', 'PR103', 'Pianist', false),
  ('P1005', 'PR104', 'The Oracle', true);

insert into patron values
  (1, 'Amara Novak', 'Brightwater', '2019-03-02', 120),
  (2, 'Felix O''Hara', 'Saltreach', '2022-08-15', 40),
  (3, 'Lucia Park', null, '2024-01-09', 0),
  (4, 'Jonas Weber', 'Quillmere', '2024-09-01', 60),
  (5, 'Rosa Achebe', 'Brightwater', '2025-02-20', 0);

insert into booking values
  (1, 1, 1, 2, 64.00, 4),
  (2, 1, 2, 2, 90.00, 5),
  (3, 2, 3, 1, 35.00, null),
  (4, 4, 4, 3, 205.50, 3),
  (5, 1, 4, 2, 109.60, 2),
  (6, 3, 5, 4, 0.00, 5),
  (7, 4, 6, 1, 45.00, null),
  (8, 2, 6, 2, 90.00, 4);

insert into mentor values
  ('P1001', 'P1003', '2010-05-01'),
  ('P1003', 'P1005', '2021-09-01'),
  ('P1002', 'P1004', '2018-01-15'),
  ('P1001', 'P1004', null);
