// The disk view (chapter 12): the simulated disk under the database. For a magnetic disk, the platter with a
// track per file and the arm moving to each block the recorded run reads or writes, with every access timed as
// seek + rotational latency + transfer. For an SSD, uniform reads and a flash translation layer that writes out
// of place, collects garbage and counts write amplification. And RAID 0, 1, 5 and 6 as a model of its own:
// stripes, parity, a failed disk and its rebuild.
(function (root) {
  'use strict';
  const K = root.K;
  const UI = K.UI;
  const { h, s } = UI;

  const fmt = (n) => Number(n).toLocaleString('en-US');
  const safe = (f, d) => { try { return f(); } catch (e) { return d; } };
  const ms3 = (x) => (x < 0.01 ? x.toFixed(4) : x < 1 ? x.toFixed(3) : x.toFixed(2));
  const models = () => K.DISK_MODELS || {};

  /** one access timed the way the disk model times it, from a head position: a seek unless it continues where the head is */
  function timeAccess(m, pageSize, head, file, block) {
    const xfer = (pageSize / (m.mbps * 1e6)) * 1000;
    if (m.kind === 'ssd') return { kind: 'uniform', seek: 0, rot: 0, lat: m.latencyMs || 0, xfer, total: (m.latencyMs || 0) + xfer };
    const seq = head.file === file && block === head.block + 1;
    const sameTrack = head.file === file && Math.floor(block / m.trackBlocks) === Math.floor(head.block / m.trackBlocks);
    if (seq) return { kind: 'sequential', seek: 0, rot: 0, lat: 0, xfer, total: xfer };
    const seek = sameTrack ? 0 : m.seekMs;
    return { kind: sameTrack ? 'same track' : 'random', seek, rot: m.rotMs, lat: 0, xfer, total: seek + m.rotMs + xfer };
  }
  /** the disk accesses of a run, each with its time split into parts (from the event when the model is the database's own) */
  function accesses(events, upto, db, m) {
    const own = m === db.disk.model || (m && db.disk.model && m.kind === db.disk.model.kind);
    const out = [];
    let head = { file: -1, block: -2 };
    events.forEach((e, k) => {
      if (e.type !== 'disk.read' && e.type !== 'disk.write') return;
      const d = e.data;
      let t = timeAccess(m, db.disk.pageSize, head, d.file, d.block);
      if (own && d.ms !== undefined) {
        // the engine's own figure; split it the same way (its head position is known only to the engine)
        if (m.kind === 'ssd') t = Object.assign(t, { total: d.ms });
        else if (!d.seek) t = { kind: 'sequential', seek: 0, rot: 0, lat: 0, xfer: d.ms, total: d.ms };
        else { const xfer = (db.disk.pageSize / (m.mbps * 1e6)) * 1000; const sameTrack = Math.abs(d.ms - m.rotMs - xfer) < 1e-6; t = { kind: sameTrack ? 'same track' : 'random', seek: sameTrack ? 0 : d.ms - m.rotMs - xfer, rot: m.rotMs, lat: 0, xfer, total: d.ms }; }
      }
      head = { file: d.file, block: d.block };
      out.push({ k, step: k + 1, op: e.type === 'disk.read' ? 'read' : 'write', file: d.file, block: d.block, name: d.name, t, past: k < upto });
    });
    return out;
  }

  // ---- GF(2^8) for RAID 6's second parity (the polynomial 0x11d, generator 2, as Linux md uses) -------------------
  const GEXP = new Uint8Array(512), GLOG = new Uint8Array(256);
  (() => { let x = 1; for (let i = 0; i < 255; i++) { GEXP[i] = x; GLOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i++) GEXP[i] = GEXP[i - 255]; })();
  const gmul = (a, b) => (a && b ? GEXP[GLOG[a] + GLOG[b]] : 0);
  const gdiv = (a, b) => (a ? GEXP[(GLOG[a] + 255 - GLOG[b]) % 255] : 0);
  const gpow = (i) => GEXP[i % 255];
  const hx = (v) => (v === null || v === undefined ? '??' : v.toString(16).padStart(2, '0').toUpperCase());

  /** where everything is in a RAID array: per stripe, the data blocks, P and Q by disk */
  function raidLayout(level, n, stripes) {
    const rows = [];
    let next = 0;
    for (let st = 0; st < stripes; st++) {
      const cells = new Array(n).fill(null);
      if (level === 0) for (let d = 0; d < n; d++) cells[d] = { kind: 'D', b: next++, j: d };
      else if (level === 1) { const b = next++; for (let d = 0; d < n; d++) cells[d] = { kind: 'D', b, j: 0, mirror: d > 0 }; }
      else {
        const p = n - 1 - (st % n);
        cells[p] = { kind: 'P' };
        let d = (p + 1) % n;
        if (level === 6) { cells[d] = { kind: 'Q' }; d = (d + 1) % n; }
        for (let j = 0; j < n - (level === 6 ? 2 : 1); j++) { cells[d] = { kind: 'D', b: next++, j }; d = (d + 1) % n; }
      }
      rows.push(cells);
    }
    return { rows, blocks: next };
  }
  const RAID = {
    0: { name: 'RAID 0', what: 'Block striping, no redundancy: consecutive blocks go to consecutive disks, so n disks read and write n blocks at once. One failed disk loses the array.', min: 2, usable: (n) => n, tol: () => 0, small: 'write 1 block: 1 write' },
    1: { name: 'RAID 1', what: 'Mirroring: every block is written to every disk. Reads can go to any copy; the array survives as long as one disk is left. It costs n times the space.', min: 2, usable: () => 1, tol: (n) => n - 1, small: 'write 1 block: ' + 'a write on every disk' },
    5: { name: 'RAID 5', what: 'Block-interleaved distributed parity: each stripe has n − 1 data blocks and their parity P = D₀ ⊕ D₁ ⊕ …, and the parity moves from disk to disk so no one disk does every parity write. Any one disk may fail.', min: 3, usable: (n) => n - 1, tol: () => 1, small: 'write 1 block: read old data and old P, write new data and new P (2 reads + 2 writes)' },
    6: { name: 'RAID 6', what: 'P + Q redundancy: a second check block Q = Σ gⁱ·Dᵢ (Reed–Solomon over GF(2⁸)) besides P, so any two disks may fail. Small writes cost one more read and one more write than RAID 5.', min: 4, usable: (n) => n - 2, tol: () => 2, small: 'write 1 block: 3 reads + 3 writes' },
  };

  function create(app, el) {
    const db = () => app.db;
    let tab = UI.store.get('disk.tab', null);
    // the SSD's flash translation layer: a model fed by the database's writes and by the buttons
    let ftl = null;
    const raid = { level: 5, n: 4, stripes: 6, data: [], failed: new Set(), sel: null, written: null, rebuilding: null, timer: null };
    const intro = h('div.kv-intro', h('b', 'Physical storage. '), 'The database reads and writes whole blocks. On a magnetic disk an access costs a seek (moving the arm to the track), rotational latency (waiting for the sector to come round) and the transfer, so reading blocks in order is far cheaper than jumping about. An SSD has no moving parts: every read costs the same, but a page cannot be rewritten in place.');
    const head = h('div.view-head.dk-head');
    const body = h('div.view-body.dk-body');
    el.appendChild(intro); el.appendChild(head); el.appendChild(body);

    const view = {
      onRun(run) { if (ftl) for (const e of (run && run.events) || []) if (e.type === 'disk.write') ftlWrite(ftl, e.data.file + ':' + e.data.block); },
      onDb() { ftl = null; },
      render() { draw(); },
      destroy() { if (raid.timer) clearInterval(raid.timer); },
    };

    function draw() {
      const own = db().disk.model.kind;
      const t = tab || own;
      head.innerHTML = '';
      head.appendChild(h('div.seg', [['hdd', 'Magnetic disk'], ['ssd', 'SSD'], ['raid', 'RAID']].map(([k, l]) => h('button' + (t === k ? '.on' : ''), { type: 'button', onclick: () => { tab = k; UI.store.set('disk.tab', k); draw(); } }, l + (k === own ? ' ●' : '')))));
      head.appendChild(h('span.kv-small.muted', 'This database: ' + db().disk.model.name + ', ' + fmt(db().disk.pageSize) + '-byte blocks'));
      body.innerHTML = '';
      if (t !== 'raid') body.appendChild(summary());
      if (t === 'hdd') hddTab(t !== own);
      else if (t === 'ssd') ssdTab(t !== own);
      else raidTab();
    }

    function summary() {
      const st = db().disk.stats;
      const run = app.tab && app.tab.run;
      const io = run && run.io;
      const stat = (l, v, cls, title) => h('div.kv-stat' + (cls ? '.' + cls : ''), { title: title || '' }, h('div.kv-sv', v), h('div.kv-sl', l));
      return h('section.kv-card', h('h3', 'I/O since the database started'),
        h('div.kv-stats', stat('reads', fmt(st.reads)), stat('writes', fmt(st.writes), 'warn'), stat('seeks', fmt(st.seeks), '', 'accesses that did not continue where the head was'), stat('disk time', UI.ms(st.ms), 'acc', 'simulated time the disk spent'), stat('read', fmtBytes(st.bytesRead || 0)), stat('written', fmtBytes(st.bytesWritten || 0))),
        io ? h('p.kv-small', h('b', 'The last statement: '), UI.plural(io.reads, 'block read') + ', ' + UI.plural(io.writes, 'block write') + ', ' + UI.plural(io.seeks, 'seek') + ', ' + UI.ms(io.ms) + ' of disk time' + (io.reads + io.writes ? ' (' + ms3(io.ms / (io.reads + io.writes)) + ' ms an access on average).' : '. Everything it needed was already in the buffer pool.')) : h('p.kv-small.muted', 'Run a statement to see what it cost.'));
    }
    const fmtBytes = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : b >= 1024 ? Math.round(b / 1024) + ' KB' : b + ' B');

    /** the tracks of the platter: one band of tracks per file, in file order */
    function trackMap(m) {
      const files = [...db().disk.files.values()].sort((a, b) => a.id - b.id);
      const map = new Map();
      let t = 0;
      for (const f of files) { const n = Math.max(1, Math.ceil(f.blocks.length / m.trackBlocks)); map.set(f.id, { first: t, n, name: f.name, blocks: f.blocks.length }); t += n; }
      return { map, tracks: t, files };
    }

    function hddTab(whatIf) {
      const m = models().hdd;
      if (!m) { body.appendChild(h('p.muted', 'No magnetic disk model.')); return; }
      const tl = app.timeline;
      const acc = accesses(tl.events, tl.pos, db(), m);
      const cur = [...acc].reverse().find((a) => a.past) || null;
      const xfer = (db().disk.pageSize / (m.mbps * 1e6)) * 1000;
      if (whatIf) body.appendChild(h('div.kv-banner', h('span', 'This database runs on an SSD. Below: the same accesses timed as the magnetic disk model would take them.')));
      // the platter, with the arm at the current access
      const TM = trackMap(m);
      const card = h('section.kv-card.dk-hdd');
      card.appendChild(h('h3', 'The platter', h('span.muted', ' · ' + m.name + ', ' + UI.plural(TM.tracks, 'track') + ' in use')));
      const svg = s('svg', { class: 'dk-platter', viewBox: '0 0 340 300', role: 'img', 'aria-label': 'A disk platter with its tracks and the arm' });
      const cx = 150, cy = 150, R0 = 34, R1 = 136;
      svg.appendChild(s('circle', { cx, cy, r: R1 + 6, class: 'dk-disc' }));
      const rw = Math.max(1.5, Math.min(10, (R1 - R0) / Math.max(1, TM.tracks)));
      const radius = (track) => R0 + (track + 0.5) * rw;
      for (const [id, f] of TM.map) for (let k = 0; k < f.n; k++) svg.appendChild(s('circle', { cx, cy, r: radius(f.first + k), class: 'dk-track' + (cur && cur.file === id ? ' cur' : ''), 'data-audit': 'group', 'stroke-width': Math.max(1, rw - 1) }, s('title', { text: 'track ' + (f.first + k) + ': ' + f.name + (f.n > 1 ? ' (part ' + (k + 1) + ')' : '') })));
      const pos = (file, block) => { const f = TM.map.get(file); if (!f) return null; const tr = f.first + Math.floor(block / m.trackBlocks); const a = -Math.PI / 2 + ((block % m.trackBlocks) / m.trackBlocks) * Math.PI * 2; const r = radius(tr); return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), a, r, tr }; };
      const arcLen = Math.max((Math.PI * 2) / m.trackBlocks, 0.045);
      for (const a of acc) {
        const p = pos(a.file, a.block);
        if (!p) continue;
        const a0 = p.a, a1 = p.a + arcLen;
        svg.appendChild(s('path', { d: 'M' + (cx + p.r * Math.cos(a0)) + ' ' + (cy + p.r * Math.sin(a0)) + ' A' + p.r + ' ' + p.r + ' 0 0 1 ' + (cx + p.r * Math.cos(a1)) + ' ' + (cy + p.r * Math.sin(a1)), class: 'dk-blk ' + a.op + (a.past ? ' past' : '') + (cur === a ? ' now' : ''), 'stroke-width': Math.max(2, rw) }));
      }
      svg.appendChild(s('circle', { cx, cy, r: R0 - 8, class: 'dk-spindle' }));
      // the arm pivots outside the platter; its head sits over the current block
      const piv = { x: 318, y: 278 };
      const tip = cur ? pos(cur.file, cur.block) : { x: cx + R1 * 0.75, y: cy + R1 * 0.55 };
      if (tip) {
        svg.appendChild(s('line', { x1: piv.x, y1: piv.y, x2: tip.x, y2: tip.y, class: 'dk-arm' }));
        svg.appendChild(s('circle', { cx: piv.x, cy: piv.y, r: 9, class: 'dk-pivot' }));
        svg.appendChild(s('circle', { cx: tip.x, cy: tip.y, r: 4.5, class: 'dk-headpt' + (cur ? ' ' + cur.op : '') }));
      }
      svg.appendChild(s('text', { x: cx, y: cy + 3, class: 'dk-lbl', text: 'spindle' }));
      card.appendChild(h('div.dk-platbox', svg, h('div.dk-side',
        cur ? h('div.dk-cur', h('div', h('span.kv-badge.' + (cur.op === 'read' ? 'acc' : 'warn'), cur.op), ' ', h('b', cur.name), ' block ' + cur.block), h('div.kv-small.muted', 'track ' + (pos(cur.file, cur.block) || {}).tr + ', sector ' + (cur.block % m.trackBlocks) + ' of ' + m.trackBlocks), formulaBox(cur.t, m, xfer)) : h('p.kv-small.muted', acc.length ? 'Step through the run to move the arm to each access.' : 'The last run did not touch the disk: every page it needed was in the buffer pool. Try a scan of a large table with a small pool, or a write and a CHECKPOINT.'),
        h('div.dk-tracks.kv-small', [...TM.map.values()].filter((f) => acc.some((a) => db().disk.files.get(a.file) && db().disk.files.get(a.file).name === f.name) || TM.files.length <= 12).slice(0, 14).map((f) => h('div', h('span.dk-tn', f.n > 1 ? f.first + '–' + (f.first + f.n - 1) : String(f.first)), f.name, h('span.muted', ' · ' + UI.plural(f.blocks, 'block'))))))));
      card.appendChild(h('p.kv-small.muted', 'Each file is laid out on its own track here (' + m.trackBlocks + ' blocks a track), so moving to another file means a seek. Blue marks: blocks read in this run; amber: written. The arm points at the access of the current step.'));
      body.appendChild(card);
      body.appendChild(accessCard(acc, cur, m, xfer));
      body.appendChild(hddModelCard(m, xfer));
    }

    function formulaBox(t, m, xfer) {
      if (m.kind === 'ssd') return h('div.kv-formula', 't = latency + transfer = ' + ms3(t.lat) + ' + ' + ms3(t.xfer) + ' = ' + ms3(t.total) + ' ms');
      if (t.kind === 'sequential') return h('div.kv-formula', 'sequential: the head is already there\nt = t_transfer = ' + ms3(t.xfer) + ' ms');
      if (t.kind === 'same track') return h('div.kv-formula', 'same track: no arm movement\nt = t_rotation + t_transfer\n  = ' + ms3(t.rot) + ' + ' + ms3(t.xfer) + '\n  = ' + ms3(t.total) + ' ms');
      return h('div.kv-formula', 'random: the arm moves\nt = t_seek + t_rotation + t_transfer\n  = ' + ms3(t.seek) + ' + ' + ms3(t.rot) + ' + ' + ms3(t.xfer) + '\n  = ' + ms3(t.total) + ' ms');
    }

    function accessCard(acc, cur, m, xfer) {
      const card = h('section.kv-card');
      const total = acc.reduce((a, x) => a + x.t.total, 0);
      const upto = acc.filter((a) => a.past);
      const sum = upto.reduce((a, x) => a + x.t.total, 0);
      const byKind = acc.reduce((a, x) => { a[x.t.kind] = (a[x.t.kind] || 0) + 1; return a; }, {});
      card.appendChild(h('h3', 'Accesses in this run', h('span.muted', ' · ' + UI.plural(acc.length, 'block') + ', ' + ms3(total) + ' ms' + (acc.length ? ' · ' + Object.entries(byKind).map(([k, v]) => v + ' ' + k).join(', ') : ''))));
      if (!acc.length) { card.appendChild(h('p.kv-small.muted', 'No disk reads or writes were recorded. The run is recorded while a view is open; the buffer pool absorbs most reads once pages are cached.')); return card; }
      // a bar per access, its height the time it took
      const W = 520, H = 80, n = Math.min(acc.length, 400), bw = W / n;
      const max = Math.max(...acc.slice(0, n).map((a) => a.t.total));
      const svg = s('svg', { class: 'dk-bars', viewBox: '0 0 ' + W + ' ' + (H + 2), preserveAspectRatio: 'none', role: 'img', 'aria-label': 'Time of each access' });
      acc.slice(0, n).forEach((a, i) => { const bh = Math.max(1.5, (a.t.total / max) * H); svg.appendChild(s('rect', { x: i * bw, y: H - bh + 1, width: Math.max(0.6, bw - (bw > 3 ? 1 : 0)), height: bh, class: 'dk-bar ' + a.op + (a.past ? ' past' : '') + (a === cur ? ' now' : ''), onclick: () => app.timeline.go(a.step) }, s('title', { text: '#' + (i + 1) + ' ' + a.op + ' ' + a.name + ' block ' + a.block + ': ' + a.t.kind + ', ' + ms3(a.t.total) + ' ms' }))); });
      card.appendChild(svg);
      card.appendChild(h('p.kv-small.muted', 'One bar per access in order (click one to step there). ' + (m.kind === 'ssd' ? 'They are all the same height: an SSD has no arm to move.' : 'The tall bars are seeks; a run of short bars is a sequential read.') + (acc.length > n ? ' The first ' + n + ' are shown.' : '')));
      card.appendChild(h('div.kv-formula', 'up to this step: ' + upto.length + ' of ' + acc.length + ' accesses, Σ t = ' + ms3(sum) + ' ms'));
      const curIdx = cur ? acc.indexOf(cur) : 0;
      const from = Math.max(0, Math.min(acc.length - 60, curIdx - 30));
      const rows = acc.slice(from, from + 60).map((a) => h('tr' + (a === cur ? '.dk-now' : a.past ? '' : '.dk-future'), { onclick: () => app.timeline.go(a.step) },
        h('td.num', String(a.step)), h('td', a.op), h('td', a.name), h('td.num', String(a.block)), h('td', h('span.kv-badge.' + (a.t.kind === 'random' ? 'no' : a.t.kind === 'sequential' ? 'ok' : a.t.kind === 'uniform' ? 'acc' : 'warn'), a.t.kind)),
        m.kind === 'ssd' ? h('td.num', ms3(a.t.lat)) : h('td.num', ms3(a.t.seek)), m.kind === 'ssd' ? null : h('td.num', ms3(a.t.rot)), h('td.num', ms3(a.t.xfer)), h('td.num', h('b', ms3(a.t.total)))));
      card.appendChild(h('div.grid-wrap.dk-tbl', h('table.grid.small', h('thead', h('tr', h('th.num', 'Step'), h('th', 'Op'), h('th', 'File'), h('th.num', 'Block'), h('th', 'Access'), m.kind === 'ssd' ? h('th.num', 'Latency') : h('th.num', 'Seek'), m.kind === 'ssd' ? null : h('th.num', 'Rotation'), h('th.num', 'Transfer'), h('th.num', 'ms'))), h('tbody', rows))));
      if (acc.length > 60) card.appendChild(h('p.kv-small.muted', 'Accesses ' + (from + 1) + '–' + Math.min(acc.length, from + 60) + ' of ' + acc.length + ', around the current step.'));
      return card;
    }

    function hddModelCard(m, xfer) {
      const big = [...db().disk.files.values()].reduce((a, f) => (f.blocks.length > a.blocks.length ? f : a), { blocks: [], name: '' });
      const b = Math.max(1, big.blocks.length);
      const tS = m.seekMs + m.rotMs;
      const rnd = b * (tS + xfer), seq = tS + b * xfer;
      return h('section.kv-card', h('h3', 'The magnetic disk model', h('span.muted', ' · ' + m.name)),
        h('div.kv-stats', statSm('avg seek', m.seekMs + ' ms'), statSm('rot. latency', m.rotMs + ' ms', 'on average half a rotation at ' + (m.rpm || Math.round(60000 / (2 * m.rotMs))) + ' rpm'), statSm('t_S', tS + ' ms', 'seek plus rotational latency: the cost of one random access'), statSm('transfer', (Math.round(m.mbps * 10) / 10) + ' MB/s'), statSm('t_T, a block', ms3(xfer) + ' ms', fmt(db().disk.pageSize) + ' bytes at ' + m.mbps + ' MB/s')),
        h('p.kv-small', 'Reading the ' + b + ' blocks of ' + (big.name || 'the largest file') + ':'),
        h('div.kv-formula', 'random:     b · (t_S + t_T) = ' + b + ' · (' + tS + ' + ' + ms3(xfer) + ') = ' + ms3(rnd) + ' ms\nsequential: t_S + b · t_T   = ' + tS + ' + ' + b + ' · ' + ms3(xfer) + ' = ' + ms3(seq) + ' ms'),
        h('p.kv-small.muted', 'Sequential access is ' + Math.round(rnd / seq) + ' times faster here. That is why a sequential scan can beat an index when many rows match, why the log is written sequentially, and why the cost formulas count seeks (t_S) and block transfers (t_T) separately.'));
    }
    const statSm = (l, v, title) => h('div.kv-stat', { title: title || '' }, h('div.kv-sv', v), h('div.kv-sl', l));

    // ---- the SSD ------------------------------------------------------------------------------------------------
    function newFtl() {
      const m = models().ssd || { eraseBlocks: 64 };
      const P = m.eraseBlocks || 64;
      const logical = [];
      for (const f of [...db().disk.files.values()].sort((a, b) => a.id - b.id)) for (let b = 0; b < f.blocks.length; b++) logical.push(f.id + ':' + b);
      const E = Math.max(4, Math.ceil(logical.length / (P * 0.7)) + 1);
      const F = { P, E, phys: new Array(P * E).fill(null), valid: new Uint8Array(P * E), erases: new Uint32Array(E), lmap: new Map(), active: 0, next: 0, host: 0, flash: 0, gc: 0, lastGc: null, recent: [] };
      for (const l of logical) ftlWrite(F, l, true);
      F.host = 0; F.flash = 0; F.recent = [];
      return F;
    }
    const erasedBlocks = (F) => { const out = []; for (let e = 0; e < F.E; e++) if (e !== F.active && freeIn(F, e) === F.P) out.push(e); return out; };
    const freeIn = (F, e) => { let n = 0; for (let k = 0; k < F.P; k++) if (F.phys[e * F.P + k] === null) n++; return n; };
    /** a write goes to the next free page; the old copy only becomes invalid. When erased blocks run short, collect garbage */
    function ftlWrite(F, l, quiet) {
      if (F.next >= F.P) {
        if (!quiet && erasedBlocks(F).length <= 1) gc(F);
        if (F.next >= F.P) { const e = erasedBlocks(F)[0]; if (e === undefined) return; F.active = e; F.next = 0; }
      }
      const old = F.lmap.get(l);
      if (old !== undefined) F.valid[old] = 0;
      const at = F.active * F.P + F.next++;
      F.phys[at] = l; F.valid[at] = 1;
      F.lmap.set(l, at);
      F.flash++;
      if (!quiet) { F.host++; F.recent.push(at); if (F.recent.length > 64) F.recent.shift(); }
    }
    /** greedy garbage collection: the block with the fewest valid pages; copy them out, erase it */
    function gc(F) {
      let best = -1, bestValid = Infinity;
      for (let e = 0; e < F.E; e++) {
        if (e === F.active) continue;
        let used = 0, valid = 0;
        for (let k = 0; k < F.P; k++) { const i = e * F.P + k; if (F.phys[i] !== null) { used++; if (F.valid[i]) valid++; } }
        if (used === F.P && valid < bestValid) { best = e; bestValid = valid; }
      }
      if (best < 0 || bestValid === F.P) return;
      const moving = [];
      for (let k = 0; k < F.P; k++) { const i = best * F.P + k; if (F.phys[i] !== null && F.valid[i]) moving.push(F.phys[i]); F.phys[i] = null; F.valid[i] = 0; }
      F.erases[best]++;
      F.gc++;
      // the copies go into the erased block itself, after the erase, ahead of new writes
      F.active = best; F.next = 0;
      for (const l of moving) { const at = best * F.P + F.next++; F.phys[at] = l; F.valid[at] = 1; F.lmap.set(l, at); F.flash++; }
      F.lastGc = { block: best, moved: moving.length };
    }

    function ssdTab(whatIf) {
      const m = models().ssd;
      if (!m) { body.appendChild(h('p.muted', 'No SSD model.')); return; }
      if (!ftl) ftl = newFtl();
      const tl = app.timeline;
      const acc = accesses(tl.events, tl.pos, db(), m);
      const cur = [...acc].reverse().find((a) => a.past) || null;
      const xfer = (db().disk.pageSize / (m.mbps * 1e6)) * 1000;
      if (whatIf) body.appendChild(h('div.kv-banner', h('span', 'This database runs on a magnetic disk. Below: the same accesses timed as an SSD would take them.')));
      body.appendChild(h('section.kv-card', h('h3', 'Why SSD reads cost the same everywhere'),
        h('div.kv-stats', statSm('latency', m.latencyMs + ' ms'), statSm('transfer', (m.mbps >= 1000 ? m.mbps / 1000 + ' GB/s' : m.mbps + ' MB/s')), statSm('one block', ms3(m.latencyMs + xfer) + ' ms'), statSm('erase block', (m.eraseBlocks || 64) + ' pages')),
        h('p.kv-small', 'Flash memory is read electrically: there is no arm to move and no platter to wait for, so block 1000 costs what block 1 costs, in any order. Random reads are cheap: t_S is close to zero (here ' + m.latencyMs + ' ms, against ' + (models().hdd ? models().hdd.seekMs + models().hdd.rotMs : 4) + ' ms on the magnetic disk).'),
        cur ? formulaBox(cur.t, m, xfer) : null));
      body.appendChild(accessCard(acc, cur, m, xfer));
      body.appendChild(ftlCard());
    }
    function ftlCard() {
      const F = ftl;
      const card = h('section.kv-card.dk-ftl');
      const wa = F.host ? F.flash / F.host : 1;
      card.appendChild(h('h3', 'Flash translation layer', h('span.muted', ' · ' + F.E + ' erase blocks of ' + F.P + ' pages')));
      card.appendChild(h('p.kv-small', 'A flash page cannot be overwritten: it must be erased first, and erasing works on a whole erase block. So the FTL writes every update to a fresh page and remaps the logical block to it; the old page becomes invalid. When free blocks run short, garbage collection copies the valid pages out of a block and erases it. Those extra copies are write amplification.'));
      const stat = (l, v, cls) => h('div.kv-stat' + (cls ? '.' + cls : ''), h('div.kv-sv', v), h('div.kv-sl', l));
      let valid = 0, invalid = 0;
      for (let i = 0; i < F.phys.length; i++) if (F.phys[i] !== null) { if (F.valid[i]) valid++; else invalid++; }
      card.appendChild(h('div.kv-stats', stat('host writes', fmt(F.host)), stat('flash writes', fmt(F.flash)), stat('write ampl.', wa.toFixed(2) + '×', wa > 1.05 ? 'warn' : 'ok'), stat('erases', fmt(F.gc)), stat('valid', fmt(valid), 'ok'), stat('invalid', fmt(invalid), 'bad')));
      card.appendChild(h('div.kv-row',
        UI.btn('bolt', 'Write 50 random blocks', 'Rewrite 50 blocks of the database chosen at random', () => { const ls = [...F.lmap.keys()]; for (let k = 0; k < 50; k++) ftlWrite(F, ls[Math.floor(Math.random() * ls.length)]); draw(); }),
        UI.btn('runAll', 'Write 50 in order', 'Rewrite 50 consecutive blocks', () => { const ls = [...F.lmap.keys()]; const at = Math.floor(Math.random() * Math.max(1, ls.length - 50)); for (let k = 0; k < 50 && at + k < ls.length; k++) ftlWrite(F, ls[at + k]); draw(); }),
        UI.btn('refresh', 'Start again', 'A freshly written device', () => { ftl = newFtl(); draw(); }, 'ghost')));
      const recent = new Set(F.recent);
      const fileIds = [...new Set([...F.lmap.keys()].map((l) => +l.split(':')[0]))];
      const grid = h('div.dk-flash');
      for (let e = 0; e < F.E; e++) {
        const cells = [];
        for (let k = 0; k < F.P; k++) {
          const i = e * F.P + k, l = F.phys[i];
          const f = l === null ? -1 : +l.split(':')[0];
          cells.push(h('i' + (l === null ? '.free' : F.valid[i] ? '.valid.c' + (fileIds.indexOf(f) % 6) : '.invalid') + (recent.has(i) && F.valid[i] ? '.recent' : ''), { title: l === null ? 'free (erased)' : (F.valid[i] ? 'valid: ' : 'invalid, old copy of ') + safe(() => db().disk.file(f).name, 'file ' + f) + ' block ' + l.split(':')[1] }));
        }
        grid.appendChild(h('div.dk-eb' + (e === F.active ? '.active' : '') + (F.lastGc && F.lastGc.block === e ? '.gced' : ''), h('span.dk-ebl', 'EB ' + e, h('span.muted', ' · ' + F.erases[e] + '×')), h('span.dk-pages', cells)));
      }
      card.appendChild(grid);
      card.appendChild(h('div.st-legend.kv-small', h('span', h('i.dk-sw.valid'), 'valid page (colour: file)'), h('span', h('i.dk-sw.invalid'), 'invalid (stale copy)'), h('span', h('i.dk-sw.free'), 'erased, free'), h('span', h('i.dk-sw.recent'), 'just written'), h('span', 'EB n · k×: erase block and how often it was erased')));
      if (F.lastGc) card.appendChild(h('p.kv-small', 'Last garbage collection: erase block ' + F.lastGc.block + ', ' + UI.plural(F.lastGc.moved, 'valid page') + ' copied out before the erase.'));
      const sample = [...F.lmap.entries()].slice(0, 12);
      card.appendChild(h('h4', 'Mapping (first entries)'));
      card.appendChild(h('div.dk-map', sample.map(([l, p]) => { const [f, b] = l.split(':'); return h('span.bp-entry', safe(() => db().disk.file(+f).name, f) + ' ' + b + ' → EB ' + Math.floor(p / F.P) + '.' + (p % F.P)); })));
      card.appendChild(h('p.kv-small.muted', 'The model starts with every block of the database written once, and then takes each block the database writes (dirty pages leaving the buffer pool) as a host write.'));
      return card;
    }

    // ---- RAID -----------------------------------------------------------------------------------------------------
    function raidData(need) {
      let x = 0x2545f491;
      while (raid.data.length < need) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; raid.data.push(x & 0xff); }
    }
    /** the bytes a stripe holds, with P and Q computed from its data */
    function stripeOf(L, row) {
      const cells = L.rows[row];
      const data = cells.map((c) => (c && c.kind === 'D' ? raid.data[c.b] : null));
      let P = 0, Q = 0;
      cells.forEach((c) => { if (c && c.kind === 'D' && !c.mirror) { P ^= raid.data[c.b]; Q ^= gmul(gpow(c.j), raid.data[c.b]); } });
      return cells.map((c, d) => (!c ? null : c.kind === 'P' ? P : c.kind === 'Q' ? Q : data[d]));
    }
    /** the value of the block on a failed disk, worked out from the survivors, with how */
    function recover(L, row, disk) {
      const cells = L.rows[row];
      const vals = stripeOf(L, row);
      const alive = (d) => !raid.failed.has(d);
      const c = cells[disk];
      if (raid.level === 0) return null;
      if (raid.level === 1) { const d = cells.findIndex((x, k) => alive(k)); return d < 0 ? null : { v: vals[d], how: 'copy from disk ' + d }; }
      const dIdx = cells.map((x, k) => (x && x.kind === 'D' ? k : -1)).filter((k) => k >= 0);
      const pd = cells.findIndex((x) => x && x.kind === 'P'), qd = cells.findIndex((x) => x && x.kind === 'Q');
      const lostData = dIdx.filter((k) => !alive(k));
      const pOk = alive(pd), qOk = qd >= 0 && alive(qd);
      if (c.kind === 'P' || c.kind === 'Q') {
        if (lostData.length) { if (c.kind === 'P' && qOk && lostData.length === 1) return { v: vals[disk], how: 'recompute the lost data from Q, then P = ⊕ of the data' }; if (c.kind === 'Q' && pOk && lostData.length === 1) return { v: vals[disk], how: 'recover the lost data from P, then recompute Q' }; return null; }
        return { v: vals[disk], how: c.kind === 'P' ? 'P = ' + dIdx.map((k) => 'D' + cells[k].b).join(' ⊕ ') : 'Q = Σ gʲ·Dⱼ over the stripe' };
      }
      const others = dIdx.filter((k) => k !== disk && alive(k));
      if (lostData.length === 1 && pOk) {
        const v = others.reduce((a, k) => a ^ vals[k], vals[pd]);
        return { v, how: 'D' + c.b + ' = P ⊕ ' + others.map((k) => 'D' + cells[k].b).join(' ⊕ ') + ' = ' + hx(vals[pd]) + ' ⊕ ' + others.map((k) => hx(vals[k])).join(' ⊕ ') + ' = ' + hx(v) };
      }
      if (lostData.length === 1 && qOk) {
        const qq = others.reduce((a, k) => a ^ gmul(gpow(cells[k].j), vals[k]), vals[qd]);
        return { v: gdiv(qq, gpow(c.j)), how: 'P is lost too: D' + c.b + ' = (Q ⊕ Σ gʲ·Dⱼ of the others) / g^' + c.j + ' in GF(2⁸)' };
      }
      if (lostData.length === 2 && pOk && qOk) {
        const [x, y] = lostData;
        const P2 = others.reduce((a, k) => a ^ vals[k], vals[pd]);
        const Q2 = others.reduce((a, k) => a ^ gmul(gpow(cells[k].j), vals[k]), vals[qd]);
        const gx = gpow(cells[x].j), gy = gpow(cells[y].j);
        const Dx = gdiv(Q2 ^ gmul(gy, P2), gx ^ gy);
        const v = disk === x ? Dx : P2 ^ Dx;
        return { v, how: 'two data blocks lost: solve P\' = Dx ⊕ Dy and Q\' = gˣ·Dx ⊕ gʸ·Dy for both (GF(2⁸) arithmetic)' };
      }
      return null;
    }

    function raidTab() {
      const R = RAID[raid.level];
      if (raid.n < R.min) raid.n = R.min;
      const L = raidLayout(raid.level, raid.n, raid.stripes);
      raidData(L.blocks + 8);
      const lostCount = raid.failed.size;
      const lost = lostCount > R.tol(raid.n);
      const card = h('section.kv-card.dk-raid');
      card.appendChild(h('h3', 'RAID: redundant arrays of independent disks', h('span.muted', ' · a model of its own, not the database\'s disk')));
      card.appendChild(h('div.kv-row',
        h('div.seg', [0, 1, 5, 6].map((lv) => h('button' + (raid.level === lv ? '.on' : ''), { type: 'button', onclick: () => { stopRebuild(); raid.level = lv; raid.failed.clear(); raid.sel = null; raid.written = null; draw(); } }, 'RAID ' + lv))),
        h('label.kv-check', 'Disks', h('select.inp', { 'aria-label': 'Number of disks', onchange: (e) => { stopRebuild(); raid.n = +e.target.value; raid.failed.clear(); raid.sel = null; raid.written = null; draw(); } }, [2, 3, 4, 5, 6].filter((n) => n >= R.min).map((n) => h('option', { value: String(n), selected: n === raid.n }, String(n)))))));
      card.appendChild(h('p.kv-small', R.what));
      card.appendChild(h('div.kv-stats', statSm('disks usable', R.usable(raid.n) + ' of ' + raid.n), statSm('survives', UI.plural(R.tol(raid.n), 'failure')), statSm('failed now', String(lostCount))));
      // the array: a column per disk, a row per stripe
      const grid = h('div.dk-array', { style: { gridTemplateColumns: '64px repeat(' + raid.n + ', minmax(0, 1fr))' } });
      grid.appendChild(h('div.dk-ah'));
      for (let d = 0; d < raid.n; d++) grid.appendChild(h('button.dk-disk' + (raid.failed.has(d) ? '.failed' : ''), { type: 'button', title: raid.failed.has(d) ? 'Disk ' + d + ' has failed' : 'Fail disk ' + d, onclick: () => { if (raid.rebuilding) return; if (raid.failed.has(d)) raid.failed.delete(d); else raid.failed.add(d); raid.sel = null; draw(); } }, h('span', 'Disk ' + d), h('span.kv-small', raid.failed.has(d) ? 'failed' : 'fail it')));
      for (let row = 0; row < L.rows.length; row++) {
        grid.appendChild(h('div.dk-sl', 'stripe ' + row));
        const vals = stripeOf(L, row);
        L.rows[row].forEach((c, d) => {
          const failed = raid.failed.has(d);
          const rebuilt = raid.rebuilding && raid.rebuilding.done > row && raid.rebuilding.disks.includes(d);
          const rec = failed && !rebuilt ? recover(L, row, d) : null;
          const label = c.kind === 'D' ? 'D' + c.b + (c.mirror ? '′' : '') : c.kind;
          const show = failed && !rebuilt ? (rec ? hx(rec.v) : '??') : hx(vals[d]);
          const isSel = raid.sel && raid.sel.row === row && raid.sel.disk === d;
          const wr = raid.written && raid.written.row === row && raid.written.disks.includes(d);
          grid.appendChild(h('button.dk-cell.k' + c.kind + (failed && !rebuilt ? (rec ? '.rec' : '.lost') : '') + (rebuilt ? '.rebuilt' : '') + (isSel ? '.sel' : '') + (wr ? '.wr' : ''), { type: 'button', onclick: () => { raid.sel = isSel ? null : { row, disk: d }; draw(); }, title: label + ' = ' + show },
            h('b', label), h('span', show)));
        });
      }
      card.appendChild(grid);
      card.appendChild(h('div.st-legend.kv-small', h('span', h('i.dk-sw.kD'), 'data'), raid.level >= 5 ? h('span', h('i.dk-sw.kP'), 'parity P') : null, raid.level === 6 ? h('span', h('i.dk-sw.kQ'), 'Q') : null, h('span', h('i.dk-sw.rec'), 'computed from the other disks'), h('span', h('i.dk-sw.lost'), 'lost'), h('span', 'values are one byte, in hex')));
      // what the selected block shows, a write, and the rebuild
      const info = h('div.dk-raidinfo');
      if (lost) info.appendChild(h('div.kv-banner.bad', h('b', 'Data lost. '), R.name + ' with ' + raid.n + ' disks survives ' + UI.plural(R.tol(raid.n), 'failure') + '; ' + lostCount + ' disks have failed, so some blocks can no longer be computed.'));
      else if (lostCount) info.appendChild(h('div.kv-banner', h('b', 'Degraded mode. '), 'Reads of blocks on the failed disk' + (lostCount > 1 ? 's' : '') + ' are answered by computing them from the surviving disks; replace the disk and rebuild before another one fails.'));
      if (raid.sel) {
        const { row, disk } = raid.sel;
        const c = L.rows[row][disk];
        const label = c.kind === 'D' ? 'D' + c.b : c.kind;
        const failed = raid.failed.has(disk);
        if (!failed) info.appendChild(h('p.kv-small', label + ' on disk ' + disk + ' = ' + hx(stripeOf(L, row)[disk]) + (c.kind === 'P' ? ': the XOR of the stripe\'s data blocks, ' + L.rows[row].filter((x) => x.kind === 'D').map((x) => 'D' + x.b + ' (' + hx(raid.data[x.b]) + ')').join(' ⊕ ') : c.kind === 'Q' ? ': Σ gʲ·Dⱼ over GF(2⁸), a second, independent check' : ': read straight from the disk.')));
        else { const rec = recover(L, row, disk); info.appendChild(h('p.kv-small', rec ? label + ' is on a failed disk; it is computed: ' + rec.how + '.' : label + ' is lost: too few disks survive to compute it.')); }
        if (c.kind === 'D' && !lost) info.appendChild(UI.btn('bolt', 'Write a new value to ' + label, 'A small write: update this block and its parity', () => { const old = raid.data[c.b]; raid.data[c.b] = (old + 37 + Math.floor(Math.random() * 180)) & 0xff; const touched = L.rows[row].map((x, k) => (raid.level === 1 || x === c || x.kind === 'P' || x.kind === 'Q' ? k : -1)).filter((k) => k >= 0 && !raid.failed.has(k)); raid.written = { row, disks: touched, old, nu: raid.data[c.b], b: c.b }; draw(); }));
      }
      if (raid.written) info.appendChild(h('p.kv-small', 'Wrote D' + raid.written.b + ': ' + hx(raid.written.old) + ' → ' + hx(raid.written.nu) + ' on ' + UI.plural(raid.written.disks.length, 'disk') + ' (outlined). ' + (raid.level === 5 ? 'New P = old P ⊕ old D ⊕ new D: read the old data and old parity, then write both: 4 accesses for one block.' : raid.level === 6 ? 'P and Q both change: 3 reads and 3 writes for one block.' : raid.level === 1 ? 'Every mirror gets the write.' : 'One disk, one write: no redundancy to keep up.')));
      if (lostCount && !lost && !raid.rebuilding) info.appendChild(UI.btn('refresh', 'Replace and rebuild', 'Put in a new disk and recompute its blocks stripe by stripe', () => startRebuild(L), 'primary'));
      if (raid.rebuilding) info.appendChild(h('p.kv-small', 'Rebuilding: stripe ' + Math.min(raid.rebuilding.done, L.rows.length) + ' of ' + L.rows.length + ' written to the new disk' + (raid.rebuilding.disks.length > 1 ? 's' : '') + '.'));
      if (!raid.sel && !lostCount) info.appendChild(h('p.kv-small.muted', 'Click a block to see where its value comes from, click a disk to fail it.'));
      card.appendChild(info);
      body.appendChild(card);
      body.appendChild(h('section.kv-card', h('h3', 'Choosing a level'), h('div.grid-wrap', h('table.grid.small.dk-levels', h('thead', h('tr', h('th', 'Level'), h('th', 'Usable'), h('th', 'Failures survived'), h('th', 'Small write'))), h('tbody', [0, 1, 5, 6].map((lv) => { const r = RAID[lv]; const n = Math.max(r.min, raid.n); return h('tr' + (lv === raid.level ? '.best' : ''), h('td', r.name), h('td', r.usable(n) + '/' + n), h('td', String(r.tol(n))), h('td.st-wrap', r.small)); })))),
        h('p.kv-small.muted', 'RAID 1 suits data that is written often, such as the log; RAID 5 stores the most for a given number of disks but pays for each small write; RAID 6 is used when a second failure during a long rebuild is a real risk.')));
    }
    function startRebuild(L) {
      raid.rebuilding = { done: 0, disks: [...raid.failed] };
      raid.sel = null;
      raid.timer = setInterval(() => {
        raid.rebuilding.done++;
        if (raid.rebuilding.done > L.rows.length) { stopRebuild(); raid.failed.clear(); UI.toast('Rebuilt: the array is whole again', 'ok'); }
        if (el.isConnected && !el.hidden) draw();
      }, 350);
    }
    function stopRebuild() { if (raid.timer) clearInterval(raid.timer); raid.timer = null; raid.rebuilding = null; }

    return view;
  }

  UI.registerView({ id: 'disk', title: 'Disk', icon: 'disk', group: 'Storage', order: 12, events: true, create });
  UI.DiskView = { timeAccess, raidLayout, gmul, gdiv };
})(typeof window !== 'undefined' ? window : globalThis);
