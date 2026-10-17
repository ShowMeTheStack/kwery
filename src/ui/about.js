// About Kwery and about the author.
(function (root) {
  'use strict';
  const K = root.K;
  const UI = K.UI;
  const { h } = UI;
  const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener' }, text);

  const AUTHOR = {
    name: 'Jyotiprakash Mishra',
    roles: [
      'Assistant Professor of Computer Science, KIIT',
      'Co-founder and CEO, ENineHQ Technologies',
      'PhD candidate (thesis submitted), BITS Pilani',
    ],
    profile: 'Computer scientist, teacher and engineer: sixteen years across enterprise software, healthcare technology, '
      + 'university teaching and hardware-security research on RISC-V. Doctoral research at BITS Pilani on the security of the '
      + 'hardware-software interface (microarchitectural side channels, memory encryption and hardware-assisted malware '
      + 'detection), with the degree expected in December 2026. Formerly a Team Lead at Epic in the USA and a Senior Member of '
      + 'Technical Staff at Oracle.',
    education: [
      ['PhD in Computer Science', 'BITS Pilani', '2021 to 2026 (expected)'],
      ['MS in Computer Science', 'University of Wisconsin-Madison', '2014 to 2016, GPA 3.9/4.0, with distinction'],
      ['BE (Hons.) in Computer Science', 'BITS Pilani', '2006 to 2010, CGPA 9.53/10, with distinction'],
    ],
    work: [
      ['Co-founder and CEO', 'ENineHQ Technologies', '2022 to now'],
      ['Assistant Professor', 'KIIT, Bhubaneswar', '2020 to now'],
      ['Team Lead, earlier Software Developer', 'Epic Systems, Madison, USA', '2015 to 2020'],
      ['Teaching Assistant, Introduction to Operating Systems', 'University of Wisconsin-Madison', '2014 to 2016'],
      ['Senior Member of Technical Staff', 'Oracle, Bangalore', '2010 to 2014'],
    ],
    books: [
      'RISC-V Architecture and XV6: Instruction Set Architecture, Systems Programming, and Kernel Development (De Gruyter Brill, 2026)',
      'Cryptographic Foundations: Symmetric and Public-Key Cryptography, Hashes, Digital Signatures, and Protocols (De Gruyter Brill, 2026)',
    ],
    numbers: [['16', 'years of experience'], ['2', 'books'], ['6', 'published patents'], ['16', 'research publications'], ['78', 'free lectures on YouTube']],
    made: [
      ['xv6, line by line', 'https://xv6.jyotiprakash.org', 'every line of a teaching operating system explained'],
      ['µSystem 8086', 'https://8086.jyotiprakash.org', 'a PC/XT you wire chip by chip, which boots FreeDOS'],
      ['See', 'https://see.jyotiprakash.org', 'C89 step by step, down to the byte'],
      ['Strux', 'https://strux.jyotiprakash.org', 'data structures and algorithms in C89, animated from real running code'],
      ['Compy', 'https://compy.jyotiprakash.org', 'a C compiler you can see through, phase by phase'],
      ['Baysik', 'https://baysik.jyotiprakash.org', 'GW-BASIC and QBasic, with a debugger'],
      ['Lohgo', 'https://lohgo.jyotiprakash.org', 'Logo with turtle graphics and a debugger'],
      ['Tooring', 'https://tooring.jyotiprakash.org', 'theory of computation you can play with, from automata to NP-completeness'],
      ['NetSim', 'https://netsim.jyotiprakash.org', 'a network simulator you can watch packet by packet'],
    ],
    links: [
      ['mail@jyotiprakash.org', 'mailto:mail@jyotiprakash.org'],
      ['jyotiprakash.org', 'https://jyotiprakash.org'],
      ['blog.jyotiprakash.org', 'https://blog.jyotiprakash.org'],
      ['eninehq.com', 'https://eninehq.com'],
      ['LinkedIn', 'https://www.linkedin.com/in/mishrajp88/'],
      ['GitHub', 'https://github.com/ShowMeTheStack'],
    ],
  };

  function authorBody() {
    const A = AUTHOR;
    const photo = h('div.author-photo', h('img', { src: 'data:image/png;base64,@@AUTHOR_PNG@@', alt: 'Photo of ' + A.name, width: '128', height: '160' }));
    const head = h('div.author-head', photo,
      h('div', h('div.author-name', A.name), ...A.roles.map((r) => h('div.author-role', r)),
        h('div.author-nums', ...A.numbers.map(([n, l]) => h('div', h('b', n), ' ' + l))),
        h('div.author-links', ...A.links.map(([t, u], i) => [i ? ' · ' : '', link(u, t)]))));
    const section = (title, rows) => h('div.author-sec', h('div.author-sec-t', title), ...rows);
    return h('div.author',
      head,
      h('p', A.profile),
      section('Education', A.education.map(([d, s, y]) => h('div.author-row', h('b', d), ', ' + s + ' (' + y + ')'))),
      section('Work', A.work.map(([r, o, y]) => h('div.author-row', h('b', r), ', ' + o + ' (' + y + ')'))),
      section('Books', A.books.map((b) => h('div.author-row', b))),
      section('Other things I made', A.made.map(([n, u, d]) => h('div.author-row', link(u, n), ': ' + d))),
      h('p.muted', { style: { marginTop: '10px' } }, 'Students learn SQL quickly and then hit a wall: the database is a black box that sometimes gets slow, sometimes waits, sometimes loses a race. Kwery opens the box. If watching a page split or a deadlock makes something click for you, I would love to hear about it.'));
  }

  function aboutBody() {
    return h('div.about',
      h('div.about-head', h('span.mark.big', { 'aria-hidden': 'true' }), h('div', h('div.about-name', 'Kwery'), h('div.muted', 'A relational database you can see into · version ' + (K.VERSION || 'dev')))),
      h('p', 'Kwery is a complete relational database that runs in your browser, built to be watched. It parses, plans and executes SQL over real slotted pages on a simulated disk, through a buffer pool, B+ trees and hash indexes, with locks, multiversion concurrency control, a write-ahead log and crash recovery. Every view draws the engine\'s own state as it works, and every run can be stepped forwards and backwards.'),
      h('p', 'The SQL is the ISO standard as PostgreSQL implements it; where the standard leaves a choice, Kwery does what PostgreSQL does, and its answers are checked against PostgreSQL by a conformance suite.'),
      h('p', 'The lessons follow the chapters of ', h('i', 'Database System Concepts'), ' by Abraham Silberschatz, Henry F. Korth and S. Sudarshan (7th edition, McGraw-Hill), the companion text, and use its terms. The sample databases, their data, the examples, figures and exercises are Kwery\'s own; none is taken from the book or from any other textbook.'),
      h('div.about-sec', h('b', 'Licence. '), 'Kwery is free software under the GNU General Public License, version 3 or later, with an attribution term: every copy and derived work must keep the notice "Based on Kwery by Jyotiprakash Mishra (https://kwery.jyotiprakash.org)". See the NOTICE file in the source.'),
      h('div.about-sec', h('b', 'Trademarks. '), 'PostgreSQL, Oracle, MySQL, SQL Server and SQLite are trademarks of their owners; McGraw-Hill and Database System Concepts belong to their publisher and authors. They are named only to describe compatibility and the companion text; Kwery is not affiliated with or endorsed by any of them.'),
      h('div.about-sec', h('b', 'Source. '), link('https://github.com/ShowMeTheStack/kwery', 'github.com/ShowMeTheStack/kwery')));
  }

  function show(app) {
    let tab = 'about';
    const body = h('div');
    const seg = h('div.seg', { style: { marginBottom: '12px' } });
    const draw = () => {
      seg.innerHTML = '';
      for (const [k, l] of [['about', 'About Kwery'], ['author', 'About the author']]) seg.appendChild(h('button' + (tab === k ? '.on' : ''), { type: 'button', onclick: () => { tab = k; draw(); } }, l));
      body.innerHTML = '';
      body.appendChild(seg);
      body.appendChild(tab === 'about' ? aboutBody() : authorBody());
    };
    draw();
    void app;
    UI.dialog('About', body, { wide: true, buttons: [{ label: 'OK', primary: true }] });
  }

  UI.About = { show, authorBody, AUTHOR };
})(typeof window !== 'undefined' ? window : globalThis);
