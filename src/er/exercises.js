// Design exercises: a problem statement and a reference design in the text format. A student's model is checked
// against the reference with ER.compare; the reference can also be reduced to tables and drawn.
(function (root) {
  'use strict';
  const K = root.K;
  const ER = K.ER;
  const X = [
    {
      id: 'ensembles', title: 'Community ensembles', domain: 'community',
      text: 'A town arts centre keeps track of the amateur ensembles that rehearse there: choirs, bands and string groups. Each ensemble has a unique name, the year it was formed and the rehearsal room it uses. Residents (identified by their library card number, with a name and a phone number) may join any number of ensembles; for each membership the centre records the date the resident joined and the part they sing or play, if any. Every ensemble has exactly one conductor, a professional musician identified by a registration number, with a name and a session fee; a musician may conduct several ensembles or none.',
      reference: `
entity resident (card_no varchar(10) key, name varchar(40), phone varchar(20))
entity ensemble (ens_name varchar(40) key, formed integer, room varchar(10))
entity musician (reg_no varchar(8) key, name varchar(40), fee numeric(7,2))
relationship member_of (resident [0..*], ensemble [0..*]) with (joined date, part varchar(20))
relationship conducts (ensemble [1..1] total, musician [0..*])`,
      hints: ['The date a resident joined depends on both the resident and the ensemble.', 'The conductor is a relationship between ensemble and musician, not an attribute of ensemble.'],
    },
    {
      id: 'kennel', title: 'Boarding kennels', domain: 'pets',
      text: 'A boarding kennel is divided into blocks, each with a block code, a name and a heating type. Pens are numbered within their block (pen 1, pen 2, ... in every block) and each has a size class such as small or large. A dog (identified by its microchip number, with a name and a date of birth; its age is computed from the date of birth) stays in at most one pen at a time, and a pen holds at most one dog. Groomers, with a staff id, a name and a speciality, look after dogs; each arrangement between a groomer and a dog is recorded with the date it began.',
      reference: `
entity block (block_code varchar(6) key, name varchar(30), heating varchar(20))
weak entity pen (pen_no integer partial, size_class varchar(10))
identifying relationship block_pen (pen [1..1] total, block [0..*])
entity dog (chip_no varchar(15) key, name varchar(30), birth_date date, age() derived from birth_date)
entity groomer (staff_id varchar(8) key, name varchar(40), speciality varchar(30))
relationship stays_in (dog [0..1], pen [0..1])
relationship grooms (groomer [0..*], dog [0..*]) with (began date)`,
      hints: ['Pen numbers repeat in every block: pen is a weak entity set.', 'stays_in is one-to-one.'],
    },
    {
      id: 'library', title: 'Lending library', domain: 'library',
      text: 'A library holds books, each identified by ISBN, with a title and a publication year, written by one or more authors (author id, name). A book can have several subject keywords. The library owns several physical copies of a book, numbered 1, 2, 3 ... for each book, with a shelf location. Members (card number, name, and an address made of street, city and postcode) borrow copies; a loan records the date out and the due date, and a copy is on loan to at most one member at a time.',
      reference: `
entity book (isbn varchar(13) key, title varchar(80), pub_year integer, {keyword varchar(30)})
entity author (author_id integer key, name varchar(40))
weak entity copy (copy_no integer partial, shelf varchar(10))
identifying relationship book_copy (copy [1..1] total, book [0..*])
entity member (card_no varchar(10) key, name varchar(40), address (street varchar(40), city varchar(30), postcode varchar(10)))
relationship wrote (author [0..*], book [1..*] total)
relationship borrows (copy [0..1], member [0..*]) with (date_out date, due_date date)`,
      hints: ['Keywords are multivalued.', 'A loan connects one copy to one member: many-to-one from copy to member.'],
    },
    {
      id: 'ferry', title: 'Ferry sailings', domain: 'travel',
      text: 'A ferry operator runs routes between ports (a four-letter port code, the town). A route has a route number, a port it leaves from and a port it arrives at, and is sailed on many dates; each dated sailing has its own berth and status. Travellers (account number, name) book places on dated sailings: a booking records the deck and the cabin class. Every dated sailing is made by one vessel (an IMO number, the vessel name and the number of passengers it may carry).',
      reference: `
entity port (port_code char(4) key, town varchar(40))
entity route (route_no varchar(8) key)
relationship leaves_from (route [1..1] total, port as origin [0..*])
relationship arrives_at (route [1..1] total, port as destination [0..*])
weak entity sailing (sail_date date partial, berth varchar(5), status varchar(12))
identifying relationship route_sailing (sailing [1..1] total, route [0..*])
entity traveller (account_no varchar(12) key, name varchar(40))
entity vessel (imo_no varchar(10) key, vessel_name varchar(30), capacity integer)
relationship booked_on (traveller [0..*], sailing [0..*]) with (deck varchar(4), cabin_class char(1))
relationship made_by (sailing [1..1] total, vessel [0..*])`,
      hints: ['A dated sailing is identified by its route and its date.', 'The two ports of a route are two relationships, or one relationship with roles.'],
    },
    {
      id: 'shop', title: 'Online shop', domain: 'shop',
      text: 'An online shop has customers (customer id, name, e-mail, and one or more delivery addresses). Customers place orders; an order has an order number and a date, belongs to exactly one customer, and contains one or more products with the quantity ordered and the unit price at the time of ordering. Products have a code, a name and a current price, and belong to one category (category name, description). The total of an order is computed from its lines.',
      reference: `
entity customer (customer_id integer key, name varchar(40), email varchar(60), {address varchar(100)})
entity orders (order_no integer key, order_date date, total() derived)
entity product (code varchar(12) key, name varchar(60), price numeric(8,2))
entity category (cat_name varchar(30) key, description varchar(200))
relationship places (orders [1..1] total, customer [0..*])
relationship contains (orders [1..*] total, product [0..*]) with (quantity integer, unit_price numeric(8,2))
relationship in_category (product [1..1] total, category [0..*])`,
      hints: ['The price paid is a property of the order line, not of the product.', 'The order total is derived.'],
    },
    {
      id: 'chess', title: 'Chess league', domain: 'sports',
      text: 'A regional chess league has clubs (club name, town, meeting venue). Players have a rating number, a name and a date of birth, and are registered with one club at a time; for the current registration we record the board the player usually takes for that club. Games have a game id and a date, are played between one player with the white pieces and one with the black pieces, and the result is recorded. Each game is supervised by one arbiter (arbiter number, name).',
      reference: `
entity club (club_name varchar(30) key, town varchar(30), venue varchar(40))
entity player (rating_no varchar(10) key, name varchar(40), birth_date date)
relationship registered (player [0..1], club [0..*]) with (board_no integer)
entity game (game_id integer key, played date, result varchar(7))
relationship white (game [1..1] total, player as white_player [0..*])
relationship black (game [1..1] total, player as black_player [0..*])
entity arbiter (arbiter_no varchar(10) key, name varchar(40))
relationship supervises (game [1..1] total, arbiter [0..*])`,
      hints: ['The board number can be on registered or on player, since registered is many-to-one.'],
    },
    {
      id: 'festival', title: 'Short film festival', domain: 'film',
      text: 'A short film festival receives entries (entry id, title, running time), each made by one or more filmmakers; for each filmmaker of an entry the festival records the credit they take on it, such as director or editor. Filmmakers have an e-mail address (unique) and a name. Each entry is scored by several jurors (juror id, name, profession); a score gives a number of points and a comment. Selected entries are shown in exactly one screening (screening code, cinema, start time); a screening shows several entries.',
      reference: `
entity entry (entry_id integer key, title varchar(120), running_time integer)
entity filmmaker (email varchar(60) key, name varchar(40))
entity juror (juror_id integer key, name varchar(40), profession varchar(60))
entity screening (screening_code varchar(8) key, cinema varchar(30), start_time timestamp)
relationship made (filmmaker [1..*] total, entry [1..*] total) with (credit varchar(20))
relationship scores (juror [0..*], entry [0..*]) with (points integer, comment text)
relationship shown_in (entry [0..1], screening [1..*] total)`,
      hints: ['The credit of a filmmaker depends on the entry too.', 'An entry that is not selected is in no screening: partial participation.'],
    },
    {
      id: 'bikes', title: 'Bike sharing', domain: 'transport',
      text: 'A city bike-sharing scheme has docking stations (station id, street, number of docks). Every bike (bike number, date bought) is either an electric bike, with a battery capacity in watt-hours, or a pedal bike, with a number of gears; no bike is both and none is neither. Each bike is registered to one home station. Riders (rider id, name, e-mail) take trips: a trip has a trip id unique in the scheme, a start time and an end time, and is made by one rider on one bike, starting at one station. Bikes are serviced from time to time; the services of a bike are numbered 1, 2, 3 ... for that bike, each with a date and a description of the work done.',
      reference: `
entity station (station_id integer key, street varchar(40), docks integer)
entity bike (bike_no integer key, bought date)
entity ebike (battery_wh integer)
entity pedal_bike (gears integer)
isa bike (ebike, pedal_bike) disjoint total
relationship home_station (bike [1..1] total, station [0..*])
entity rider (rider_id integer key, name varchar(40), email varchar(60))
entity trip (trip_id integer key, started timestamp, ended timestamp)
relationship ridden_by (trip [1..1] total, rider [0..*])
relationship trip_bike (trip [1..1] total, bike [0..*])
relationship starts_at (trip [1..1] total, station [0..*])
weak entity service (service_no integer partial, service_date date, work text)
identifying relationship bike_service (service [1..1] total, bike [0..*])`,
      hints: ['Electric and pedal bikes are a disjoint, total specialization of bike.', 'Services are numbered within a bike: a weak entity set.'],
    },
    {
      id: 'tools', title: 'Tool library', domain: 'lending',
      text: 'A neighbourhood tool library has lending points (point id, address). Each tool has an asset tag, a brand and a purchase price, and is kept at one lending point. Some tools are power tools (wattage), some are ladders (height in metres); a tool can be neither (a rake, say) but not both. Borrowers (member number, name, phone numbers) borrow tools; a loan records the collection date and the return date, and the same borrower may borrow the same tool many times, so each loan also gets a loan number that is unique across the library.',
      reference: `
entity lending_point (point_id integer key, address varchar(100))
entity tool (asset_tag varchar(10) key, brand varchar(20), price numeric(8,2))
entity power_tool (watts integer)
entity ladder (height numeric(4,1))
isa tool (power_tool, ladder) disjoint partial
relationship kept_at (tool [1..1] total, lending_point [0..*])
entity borrower (member_no varchar(16) key, name varchar(40), {phone varchar(20)})
entity loan (loan_no integer key, collected date, returned date)
relationship borrowed_by (loan [1..1] total, borrower [0..*])
relationship loaned_tool (loan [1..1] total, tool [0..*])`,
      hints: ['Because the same pair can meet many times, a loan is an entity set of its own.'],
    },
    {
      id: 'garden', title: 'Botanic garden displays', domain: 'garden',
      text: 'A botanic garden catalogues its specimens (accession number, species name, year acquired), each given by one donor (donor id, name, town); for some specimens the donor is not known. Displays have a code, a theme, an opening date and a closing date. A specimen can appear in many displays and a display shows many specimens; for each specimen in a display the garden records the glasshouse it is shown in. Glasshouses are identified by a house code and have a floor area.',
      reference: `
entity specimen (accession_no varchar(10) key, species varchar(60), acquired integer)
entity donor (donor_id integer key, name varchar(40), town varchar(30))
entity display (code varchar(8) key, theme varchar(60), opens date, closes date)
entity glasshouse (house_code varchar(6) key, area numeric(7,1))
relationship given_by (specimen [0..1], donor [0..*])
relationship shown (specimen [0..*], display [1..*] total, glasshouse [0..*] one)`,
      hints: ['The glasshouse depends on the specimen and the display together: a ternary relationship with an arrow to glasshouse.'],
    },
    {
      id: 'recipes', title: 'Recipe website', domain: 'food',
      text: 'A recipe website stores recipes (recipe id, title, servings). A recipe uses ingredients (ingredient name, unit such as grams); for each ingredient of a recipe the amount is given. A recipe is a sequence of steps numbered 1, 2, 3 within the recipe, each with an instruction text. Registered users (user name, join date) post recipes (each recipe is posted by one user) and rate any recipe with a number of stars.',
      reference: `
entity recipe (recipe_id integer key, title varchar(80), servings integer)
entity ingredient (ing_name varchar(40) key, unit varchar(10))
weak entity step (step_no integer partial, instruction text)
identifying relationship recipe_step (step [1..1] total, recipe [0..*])
entity site_user (user_name varchar(20) key, joined date)
relationship uses (recipe [1..*] total, ingredient [0..*]) with (amount numeric(8,2))
relationship posted_by (recipe [1..1] total, site_user [0..*])
relationship rates (site_user [0..*], recipe [0..*]) with (stars integer)`,
      hints: ['Steps are weak: step 1 exists in every recipe.'],
    },
    {
      id: 'music', title: 'Music streaming', domain: 'music',
      text: 'A streaming service stores artists (artist id, name), albums (album id, title, release year) released by one artist, and tracks. Tracks are numbered within their album and have a title and a duration. Listeners (account id, name, country) create playlists; a playlist has a playlist id and a name and belongs to one listener. A playlist contains tracks in an order: for every track in a playlist we keep its position.',
      reference: `
entity artist (artist_id integer key, name varchar(60))
entity album (album_id integer key, title varchar(80), release_year integer)
relationship released (album [1..1] total, artist [0..*])
weak entity track (track_no integer partial, title varchar(80), duration integer)
identifying relationship album_track (track [1..1] total, album [1..*] total)
entity listener (account_id integer key, name varchar(40), country varchar(30))
entity playlist (playlist_id integer key, name varchar(40))
relationship owns (playlist [1..1] total, listener [0..*])
relationship in_playlist (playlist [0..*], track [0..*]) with (position integer)`,
      hints: ['A track is identified by its album and its number on the album.'],
    },
    {
      id: 'timetable', title: 'School timetable', domain: 'school',
      text: 'A school assigns teachers (teacher code, name) to teach subjects (subject code, title) to class groups (group name such as 9B, size). The same teacher may teach several subjects to the same group, and the same subject to several groups; a subject in a group may be shared between teachers. For each assignment the number of weekly hours is recorded. Each class group has one form tutor, who is a teacher.',
      reference: `
entity teacher (teacher_code varchar(6) key, name varchar(40))
entity subject (subject_code varchar(6) key, title varchar(40))
entity class_group (group_name varchar(6) key, size integer)
relationship assignment (teacher [0..*], subject [0..*], class_group [0..*]) with (hours integer)
relationship tutor (class_group [1..1] total, teacher [0..1])`,
      hints: ['Teacher, subject and group are related together: three binary relationships would lose which teacher teaches which subject to which group.'],
    },
    {
      id: 'hotel', title: 'Hotel chain', domain: 'hotel',
      text: 'A hotel chain has hotels (hotel id, name, city, star rating) and each hotel has rooms numbered within the hotel (room 101 can exist in every hotel), with a type and a nightly rate. Each hotel lists its amenities (pool, gym, ...). Guests (guest id, name, phone) make reservations: a reservation has a reservation number, an arrival date and a number of nights, is made by one guest and is for one or more rooms.',
      reference: `
entity hotel (hotel_id integer key, name varchar(40), city varchar(30), stars integer, {amenity varchar(30)})
weak entity room (room_no varchar(6) partial, room_type varchar(20), rate numeric(8,2))
identifying relationship hotel_room (room [1..1] total, hotel [1..*] total)
entity guest (guest_id integer key, name varchar(40), phone varchar(20))
entity reservation (res_no integer key, arrival date, nights integer)
relationship made_by (reservation [1..1] total, guest [0..*])
relationship for_room (reservation [1..*] total, room [0..*])`,
      hints: ['Amenities are multivalued.', 'Rooms are numbered within the hotel.'],
    },
    {
      id: 'property', title: 'Estate agency', domain: 'real estate',
      text: 'An estate agency lists properties (property id, address, asking price). A property is a house (number of floors, garden size) or an apartment (floor, whether there is a lift); every property is exactly one of these. Each property has one or more owners (owner id, name, phone) and is handled by one agent (agent id, name). An agent handles many properties. Viewings are recorded: a client (client id, name) views a property with an agent on a date.',
      reference: `
entity property (property_id integer key, address varchar(100), asking_price numeric(12,2))
entity house (floors integer, garden numeric(8,1))
entity apartment (floor integer, lift boolean)
isa property (house, apartment) disjoint total
entity owner (owner_id integer key, name varchar(40), phone varchar(20))
entity agent (agent_id integer key, name varchar(40))
entity client (client_id integer key, name varchar(40))
relationship owned_by (property [1..*] total, owner [1..*] total)
relationship handled_by (property [1..1] total, agent [0..*])
relationship viewing (client [0..*], property [0..*], agent [0..*]) with (view_date date)`,
      hints: ['A viewing involves client, property and agent at once.'],
    },
    {
      id: 'podcasts', title: 'Podcast network', domain: 'media',
      text: 'A podcast network records its shows (show id, title, year launched), each published by one label (label name, country) and presented by one or more hosts. Guests appear on shows to talk about topics; a guest may cover several topics on the same show, and each topic is recorded. Hosts and guests are both people (person id, name, birth date); a person can be both a host and a guest.',
      reference: `
entity show (show_id integer key, title varchar(80), launched integer)
entity label (label_name varchar(40) key, country varchar(30))
entity person (person_id integer key, name varchar(40), birth_date date)
entity host ()
entity guest ()
isa person (host, guest) overlapping partial
relationship published_by (show [1..1] total, label [0..*])
relationship presents (host [1..*] total, show [1..*] total)
relationship appears_on (guest [1..*] total, show [0..*]) with ({topic varchar(40)})`,
      hints: ['A person can be both: an overlapping specialization.', 'Several topics per guest and show: a multivalued descriptive attribute.'],
    },
    {
      id: 'vet', title: 'Veterinary clinic', domain: 'clinic',
      text: 'A veterinary clinic registers owners (owner id, name, phone) and their pets. A pet is known by its name, which is unique only among the pets of the same owner, and has a species and a date of birth. The clinic records the vaccinations each pet has had (vaccine names). Vets (vet id, name) see pets in visits; each visit has a visit number unique in the clinic, a date and a diagnosis, involves one pet and one vet.',
      reference: `
entity owner (owner_id integer key, name varchar(40), phone varchar(20))
weak entity pet (pet_name varchar(20) partial, species varchar(20), birth_date date, {vaccine varchar(30)})
identifying relationship owns (pet [1..1] total, owner [1..*] total)
entity vet (vet_id integer key, name varchar(40))
entity visit (visit_no integer key, visit_date date, diagnosis text)
relationship of_pet (visit [1..1] total, pet [0..*])
relationship seen_by (visit [1..1] total, vet [0..*])`,
      hints: ['The pet name only identifies a pet within its owner.'],
    },
    {
      id: 'transit', title: 'Bus network', domain: 'transport',
      text: 'A city bus network has lines (line number, colour) and stops (stop id, name, location). A line serves many stops in order and a stop is served by many lines; for each stop on a line its sequence number is recorded. Buses (fleet number, capacity) are driven by drivers (employee number, name) in shifts: a shift has a shift id, a date, a start time, and involves one driver, one bus and one line.',
      reference: `
entity line (line_no varchar(4) key, colour varchar(10))
entity stop (stop_id integer key, name varchar(40), location varchar(60))
relationship serves (line [1..*] total, stop [1..*] total) with (seq integer)
entity bus (fleet_no integer key, capacity integer)
entity driver (emp_no integer key, name varchar(40))
entity shift (shift_id integer key, shift_date date, start_time time)
relationship shift_driver (shift [1..1] total, driver [0..*])
relationship shift_bus (shift [1..1] total, bus [0..*])
relationship shift_line (shift [1..1] total, line [0..*])`,
      hints: ['The sequence number depends on both the line and the stop.'],
    },
    {
      id: 'tracker', title: 'Issue tracker', domain: 'software',
      text: 'A software company tracks projects (project key such as KW, name). Issues are numbered within their project (KW-1, KW-2, ...) and have a title, a status and labels (several per issue). Users (login, name, e-mail) report issues (each issue has one reporter) and can be assigned to issues (several users per issue, several issues per user). Users write comments on issues; a comment has a comment id unique in the system, a text and a time.',
      reference: `
entity project (project_key varchar(6) key, name varchar(40))
weak entity issue (issue_no integer partial, title varchar(120), status varchar(12), {label varchar(20)})
identifying relationship project_issue (issue [1..1] total, project [0..*])
entity app_user (login varchar(20) key, name varchar(40), email varchar(60))
relationship reported_by (issue [1..1] total, app_user [0..*])
relationship assigned (app_user [0..*], issue [0..*])
entity comment (comment_id integer key, body text, posted timestamp)
relationship on_issue (comment [1..1] total, issue [0..*])
relationship written_by (comment [1..1] total, app_user [0..*])`,
      hints: ['Issue numbers start again in every project.'],
    },
    {
      id: 'gym', title: 'Fitness centre', domain: 'gym',
      text: 'A fitness centre has members (member id, name, birth date) who each hold one membership plan (plan code, monthly fee). Employees (employee id, name, hire date) are either trainers (certification level) or receptionists (desk number), or neither; no one is both. Trainers lead classes (class id, title, weekday, time), each class led by one trainer; members enrol in classes and the enrolment date is kept.',
      reference: `
entity member (member_id integer key, name varchar(40), birth_date date)
entity plan (plan_code varchar(6) key, monthly_fee numeric(6,2))
relationship holds_plan (member [1..1] total, plan [0..*])
entity employee (employee_id integer key, name varchar(40), hire_date date)
entity trainer (cert_level integer)
entity receptionist (desk_no integer)
isa employee (trainer, receptionist) disjoint partial
entity gym_class (class_id integer key, title varchar(40), weekday varchar(10), start_time time)
relationship leads (gym_class [1..1] total, trainer [0..*])
relationship enrols (member [0..*], gym_class [0..*]) with (enrolled date)`,
      hints: ['Classes are led by trainers, not by employees in general.'],
    },
    {
      id: 'farm', title: 'Farming cooperative', domain: 'agriculture',
      text: 'A farming cooperative has farmers (farmer id, name). Each farmer owns fields, numbered within the farm, with an area. Crops (crop name, family) are planted in fields in seasons (season code such as 2026S); the planting of a crop in a field in a season records the expected yield. Inspectors (inspector id, name) inspect plantings: an inspection of a particular planting by an inspector records the date and a grade.',
      reference: `
entity farmer (farmer_id integer key, name varchar(40))
weak entity field (field_no integer partial, area numeric(8,2))
identifying relationship farmer_field (field [1..1] total, farmer [0..*])
entity crop (crop_name varchar(30) key, family varchar(30))
entity season (season_code varchar(6) key)
relationship planting (field [0..*], crop [0..*], season [0..*]) with (expected_yield numeric(8,1))
aggregation planted of planting
entity inspector (inspector_id integer key, name varchar(40))
relationship inspects (inspector [0..*], planted [0..*]) with (insp_date date, grade char(1))`,
      hints: ['An inspection is about a planting as a whole: aggregate the planting relationship.'],
    },
    {
      id: 'translation', title: 'Translation agency', domain: 'languages',
      text: 'A translation agency records translators (translator id, name, grade) and commissions (commission code, title, word count). Translators work on commissions, and each assignment records the language pair, such as de-en. Some assignments are checked by a senior translator: a check concerns one assignment as a whole (a particular translator on a particular commission), and each assignment has at most one checker. Clients (client name, country) order commissions and pay a fee; a commission may be ordered jointly by several clients.',
      reference: `
entity translator (translator_id integer key, name varchar(40), grade varchar(20))
entity commission (code varchar(8) key, title varchar(80), word_count integer)
relationship works_on (translator [0..*], commission [1..*] total) with (language_pair varchar(10))
aggregation assignment of works_on
relationship checks (assignment [0..1], translator as checker [0..*])
entity client (client_name varchar(40) key, country varchar(30))
relationship orders (client [0..*], commission [0..*]) with (fee numeric(10,2))`,
      hints: ['A check is a relationship between a checker and a works_on relationship: aggregation.'],
    },
    {
      id: 'theatre', title: 'Theatre tickets', domain: 'theatre',
      text: 'A theatre stages shows (show id, title, director). Each show has performances, identified by the show and the date and time of the performance. The hall has seats identified by row letter and seat number, with a price band. Customers (customer id, name, e-mail) buy tickets: a ticket is for one seat at one performance, bought by one customer, with the price paid; a seat can be sold only once for a performance.',
      reference: `
entity show (show_id integer key, title varchar(80), director varchar(40))
weak entity performance (starts timestamp partial)
identifying relationship show_performance (performance [1..1] total, show [1..*] total)
entity seat (seat_row char(1) key, seat_no integer key, band char(1))
entity customer (customer_id integer key, name varchar(40), email varchar(60))
relationship ticket (performance [0..*], seat [0..*], customer [0..*] one) with (price numeric(7,2))`,
      hints: ['A performance plus a seat determines at most one customer: an arrow to customer in the ternary relationship.'],
    },
    {
      id: 'restaurants', title: 'Restaurant chain', domain: 'restaurant',
      text: 'A restaurant chain has restaurants (restaurant id, address, seats). Employees (employee id, name, salary) work at one restaurant; chefs have a speciality and waiters a section; an employee may be neither but not both. Each restaurant is managed by one employee, and an employee manages at most one restaurant. Menu items (item code, name, description) are served at restaurants, each restaurant setting its own price for an item.',
      reference: `
entity restaurant (restaurant_id integer key, address varchar(100), seats integer)
entity employee (employee_id integer key, name varchar(40), salary numeric(9,2))
entity chef (speciality varchar(30))
entity waiter (section varchar(10))
isa employee (chef, waiter) disjoint partial
relationship works_at (employee [1..1] total, restaurant [0..*])
relationship manages (restaurant [1..1] total, employee [0..1])
entity menu_item (item_code varchar(8) key, name varchar(40), description text)
relationship serves (restaurant [0..*], menu_item [0..*]) with (price numeric(7,2))`,
      hints: ['manages is one-to-one.', 'The price depends on the restaurant and the item.'],
    },
    {
      id: 'election', title: 'General election', domain: 'politics',
      text: 'An election commission records constituencies (constituency code, name, number of registered voters) and parties (party name, leader). Candidates are people (person id, name, address); in this election a candidate stands in exactly one constituency, either for one party or as an independent, and the number of votes received is recorded. A party fields at most one candidate per constituency. Each constituency has one returning officer (officer id, name), who serves only that constituency.',
      reference: `
entity constituency (code varchar(6) key, name varchar(40), voters integer)
entity party (party_name varchar(40) key, leader varchar(40))
entity candidate (person_id integer key, name varchar(40), address varchar(100))
relationship stands_in (candidate [1..1] total, constituency [1..*] total) with (votes integer)
relationship stands_for (candidate [0..1], party [0..*])
entity officer (officer_id integer key, name varchar(40))
relationship returning_officer (constituency [1..1] total, officer [1..1] total)`,
      hints: ['stands_in is many-to-one, so votes may also be an attribute of candidate.', 'At most one candidate per party and constituency cannot be expressed by cardinalities alone.'],
    },
  ];
  const cache = new Map();
  /** the exercises: [{ id, title, domain, text, reference (text format), hints, model() }] */
  ER.exercises = X.map((x) => Object.assign({}, x, { reference: x.reference.trim() + '\n', model() { if (!cache.has(x.id)) cache.set(x.id, ER.parse(x.reference)); return ER.clone(cache.get(x.id)); } }));
  ER.exercise = (id) => ER.exercises.find((x) => x.id === id) || null;
  /** check a student's answer (a model or text) against an exercise: the result of ER.compare plus validation */
  ER.checkExercise = (id, answer) => {
    const ex = ER.exercise(id);
    if (!ex) throw new Error('no exercise ' + id);
    let model = answer;
    if (typeof answer === 'string') { const p = ER.tryParse(answer); if (p.error) return { parseError: p.error, score: 0, correct: false, feedback: [{ level: 'error', code: 'parse', message: p.error.message, at: {} }] }; model = p.model; }
    const problems = ER.validate(model);
    const res = ER.compare(model, ex.model());
    res.problems = problems;
    return res;
  };
})(typeof window !== 'undefined' ? window : globalThis);
