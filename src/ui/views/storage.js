// The storage inspector (chapter 13): a relation's file as its pages, one page drawn to scale as a slotted page,
// and one tuple taken apart: header fields, null bitmap, alignment padding and decoded values. Pages are read
// from the disk image and from the buffer frame directly (never pinned), so looking is not I/O and does not
// change what the replacement policy sees.
(function (root) {
  'use strict';
  const K = root.K;
  const UI = K.UI;
  const { h, s } = UI;

  const LPF = ['unused', 'normal', 'redirect', 'dead'];
  const HDR = [
    ['pd_lsn', 0, 8, 'log position (LSN) of the last change: the page may be written only once the log is flushed past it'],
    ['pd_checksum', 8, 2, 'checksum over the page, set when it is written to disk'],
    ['pd_flags', 10, 2, 'page flags'],
    ['pd_lower', 12, 2, 'end of the line pointer array: free space starts here'],
    ['pd_upper', 14, 2, 'start of the tuple data: free space ends here'],
    ['pd_special', 16, 2, 'start of the special area (index pages keep their links there)'],
    ['pd_pagesize_version', 18, 2, 'page size and layout version'],
    ['pd_prune_xid', 20, 4, 'oldest deleting transaction on the page: a hint for pruning'],
  ];
  const IMW = [
    [0x0001, 'HASNULL', 'some column is null: a null bitmap follows the header'],
    [0x0002, 'HASVARWIDTH', 'has variable-length columns'],
    [0x0004, 'HASEXTERNAL', 'has values stored out of line'],
    [0x0010, 'XMAX_KEYSHR_LOCK', 'xmax holds a key-share row lock'],
    [0x0040, 'XMAX_EXCL_LOCK', 'xmax holds an exclusive row lock'],
    [0x0080, 'XMAX_LOCK_ONLY', 'xmax only locked the row; it did not delete it'],
    [0x0100, 'XMIN_COMMITTED', 'hint bit: the inserting transaction is known to have committed'],
    [0x0200, 'XMIN_INVALID', 'the inserting transaction aborted, or its insert was undone'],
    [0x0400, 'XMAX_COMMITTED', 'hint bit: the deleting transaction is known to have committed'],
    [0x0800, 'XMAX_INVALID', 'no valid xmax: nobody has deleted or locked this version'],
    [0x1000, 'XMAX_IS_MULTI', 'xmax is a group of lockers'],
    [0x2000, 'UPDATED', 'this version was replaced by an UPDATE: t_ctid points to the newer one'],
  ];
  const BT = { LEAF: 1, ROOT: 2, META: 4 };
  const NONE = 0xffffffff;
  const alignUp = (n, a) => (n + a - 1) & ~(a - 1);
  const safe = (f, d) => { try { return f(); } catch (e) { return d; } };
  const hx = (x, n) => x.toString(16).padStart(n || 2, '0');
  const fmt = (n) => Number(n).toLocaleString('en-US');
  const tyName = (t) => K.T.sqlName(t).replace('character varying', 'varchar').replace('timestamp with time zone', 'timestamptz').replace('timestamp without time zone', 'timestamp');
  const tidText = (t) => '(' + t.b + ',' + t.o + ')';
  const u16 = (b, o) => b[o] | (b[o + 1] << 8);
  const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

  /** the page as it is on disk, and as it is in a buffer frame if it is cached */
  function images(db, file, b) {
    const f = db.disk.files.get(file);
    const disk = f && f.blocks ? f.blocks[b] || null : null;
    const frame = safe(() => db.buffers.frameOf(file, b), null);
    return { disk, mem: frame ? frame.buf : null, frame };
  }
  const isZero = (b) => { for (let i = 0; i < b.length; i++) if (b[i]) return false; return true; };
  function diffRanges(a, b) {
    const out = [];
    if (!a || !b) return out;
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i]) continue;
      const last = out[out.length - 1];
      if (last && i - last[1] <= 4) last[1] = i + 1; else out.push([i, i + 1]);
    }
    return out;
  }

  /** what the active session sees, and what a new transaction would see */
  function visCtx(app) {
    const db = app.db;
    db.bus.muted++;
    try {
      const sess = app.session, tx = sess && sess.tx;
      const fresh = db.xact.snapshot(null);
      const snap = tx ? (tx.snapshot && tx.isolation !== 'read committed' ? tx.snapshot : db.xact.snapshot(tx.xid || null)) : fresh;
      return { db, fresh, snap, tx: tx ? Object.assign({}, tx, { cid: Infinity }) : null, horizon: safe(() => db.xact.horizon(), 0), sess };
    } finally { db.bus.muted--; }
  }
  function fate(hd, c) {
    const x = c.db.xact;
    const me = safe(() => x.satisfies(hd, c.tx, c.snap), { visible: false, why: 'unknown' });
    const all = c.tx ? safe(() => x.satisfies(hd, null, c.fresh), me) : me;
    const dead = safe(() => x.deadToAll(hd, c.horizon), false);
    return { me, all, kind: dead ? 'dead' : all.visible ? 'live' : 'pending' };
  }

  /** the line pointers of a page, with each heap tuple's header and fate */
  function scanPage(bytes, heap, c) {
    const p = new K.Page(bytes);
    const out = { size: p.size, isNew: p.isNew(), ok: true, slots: [], n: 0, live: 0, dead: 0, pending: 0, lpDead: 0, tupleBytes: 0, free: 0 };
    if (out.isNew) { out.free = p.size - K.PAGE_HDR; return out; }
    if (p.lower < K.PAGE_HDR || p.lower > p.upper || p.upper > p.special || p.special > p.size) { out.ok = false; return out; }
    Object.assign(out, { lower: p.lower, upper: p.upper, special: p.special, free: p.free(), lsn: p.lsn });
    for (let i = 1; i <= p.nslots; i++) {
      const lp = p.lp(i);
      const sl = { i, off: lp.off, flags: lp.flags, len: lp.len };
      if (lp.flags === K.LP.NORMAL && lp.len && lp.off + lp.len <= p.size) {
        out.n++; out.tupleBytes += lp.len;
        if (heap && lp.len >= K.Tuple.HEADER) { sl.h = K.Tuple.header(bytes.subarray(lp.off, lp.off + lp.len)); sl.f = fate(sl.h, c); out[sl.f.kind]++; }
      } else if (lp.flags === K.LP.DEAD) out.lpDead++;
      out.slots.push(sl);
    }
    return out;
  }

  /** a heap tuple, region by region: the header fields, bitmap, padding and every column */
  function heapLayout(bytes, cols, ctx) {
    const hd = K.Tuple.header(bytes);
    const im2 = u16(bytes, 18);
    const hasNull = !!(hd.infomask & K.Tuple.IM.HASNULL);
    const regs = [['t_xmin', 0, 4, 'x-xmin'], ['t_xmax', 4, 8, 'x-xmax'], ['t_cid', 8, 12, 'x-cid'], ['t_ctid', 12, 18, 'x-ctid'], ['t_infomask2', 18, 20, 'x-im2'], ['t_infomask', 20, 22, 'x-im'], ['t_hoff', 22, 23, 'x-hoff']];
    const bm = hasNull ? Math.ceil(hd.natts / 8) : 0;
    if (bm) regs.push(['null bitmap', 23, 23 + bm, 'x-bm']);
    if (hd.hoff > 23 + bm) regs.push(['padding to t_hoff', 23 + bm, hd.hoff, 'x-pad']);
    const colsOut = [];
    let off = hd.hoff;
    cols.forEach((c, i) => {
      const present = !(hasNull && !(bytes[23 + (i >> 3)] & (1 << (i & 7))));
      const r = { c, i, present, missing: i >= hd.natts };
      if (r.missing || !present) { colsOut.push(r); return; }
      const a = K.T.align(c.type);
      const at = alignUp(off, a);
      r.align = a; r.pad = at - off; r.off = at;
      const d = safe(() => K.T.decode(bytes, at, c.type, ctx), null);
      if (!d) { r.err = true; colsOut.push(r); return; }
      r.v = d[0]; r.len = d[1];
      if (r.pad) regs.push(['padding before ' + c.name, off, at, 'x-pad']);
      regs.push([c.name, at, at + r.len, 'x-c' + (colsOut.filter((x) => x.len).length % 2)]);
      off = at + r.len;
      colsOut.push(r);
    });
    return { hd, im2, hasNull, bm, regs, cols: colsOut };
  }
  /** an index entry: the TID (or child block), the info word, then the key columns aligned as in a tuple */
  function indexLayout(bytes, types, ctx) {
    const info = u16(bytes, 6);
    const hasNull = !!(info & 0x8000);
    const regs = [['TID block / child', 0, 4, 'x-ctid'], ['TID item', 4, 6, 'x-cid'], ['info (size, nulls)', 6, 8, 'x-im']];
    const bm = hasNull ? Math.ceil(types.length / 8) : 0;
    if (bm) regs.push(['null bitmap', 8, 8 + bm, 'x-bm']);
    const cols = [];
    let off = 8 + bm;
    if ((info & 0x1fff) > 8 || hasNull) types.forEach((t, i) => {
      const present = !(hasNull && !(bytes[8 + (i >> 3)] & (1 << (i & 7))));
      const r = { c: { name: 'key ' + (i + 1), type: t }, i, present };
      if (!present || off >= bytes.length) { cols.push(r); return; }
      const at = alignUp(off, K.T.align(t));
      const d = safe(() => K.T.decode(bytes, at, t, ctx), null);
      r.pad = at - off; r.off = at;
      if (d) { r.v = d[0]; r.len = d[1]; if (r.pad) regs.push(['padding', off, at, 'x-pad']); regs.push([r.c.name, at, at + r.len, 'x-c' + (i % 2)]); off = at + r.len; } else r.err = true;
      cols.push(r);
    });
    return { b: u32(bytes, 0), o: u16(bytes, 4), size: info & 0x1fff, hasNull, regs, cols };
  }
  /** the special area of a B+ tree page: its level and links, or the meta page's root */
  function btSpecial(bytes, special) {
    if (special + 10 > bytes.length) return null;
    const flags = u16(bytes, special + 2);
    if (u16(bytes, special + 8) & BT.META) return { meta: true, root: u32(bytes, special), levels: u32(bytes, special + 4) };
    return { level: u16(bytes, special), flags, leaf: !!(flags & BT.LEAF), root: !!(flags & BT.ROOT), left: u32(bytes, special + 4), right: u32(bytes, special + 8) };
  }

  /** which block of this relation a recorded event is about (-1: none) */
  function blocksOf(e, rel) {
    const d = e.data || {};
    if (/^(buf|disk)\./.test(e.type) || e.type === 'wal.append') return d.file === rel.file && d.block !== undefined ? [d.block] : [];
    if (/^heap\./.test(e.type)) return d.rel !== rel.name ? [] : [d.tid ? d.tid.b : d.block, d.newTid ? d.newTid.b : undefined].filter((x) => x !== undefined);
    if (/^btree\./.test(e.type)) return d.index === rel.name ? [d.block, d.right].filter((x) => x !== undefined) : [];
    return [];
  }
  const changeTid = (e) => (e.type === 'heap.update' ? e.data.newTid : e.data.tid);
  const isChange = (e) => e && (e.type === 'heap.insert' || e.type === 'heap.update' || e.type === 'heap.delete') && e.data && e.data.tid;

  function create(app, el) {
    const st = { oid: null, block: null, item: null, image: null, follow: UI.store.get('storage.follow', true), pos: -1, hover: null, scroll: null };
    const intro = h('div.kv-intro', h('b', 'Data storage structures. '), 'A table lives in a heap file: a sequence of fixed-size blocks (pages) on disk, read and written through the buffer pool. Every page is a slotted page: a header, an array of line pointers that grows down from it, and tuples that grow up from the end, so a tuple is found by its TID (block, item) even when it moves within its page.');
    const head = h('div.view-head.st-head');
    const body = h('div.view-body.st-body');
    el.appendChild(intro); el.appendChild(head); el.appendChild(body);
    body.addEventListener('mouseover', (e) => {
      const t = e.target.closest && e.target.closest('[data-i]');
      const i = t ? t.getAttribute('data-i') : null;
      if (i === st.hover) return;
      st.hover = i;
      body.querySelectorAll('.hl').forEach((x) => x.classList.remove('hl'));
      if (i !== null) body.querySelectorAll('[data-i="' + i + '"]').forEach((x) => x.classList.add('hl'));
    });

    const cat = () => app.session.catalog;
    const rels = () => cat().tables(['table', 'matview', 'index']).filter((r) => r.file && app.db.disk.files.has(r.file) && !safe(() => cat().schema(r.schema).system, false)).sort((a, b) => (a.name < b.name ? -1 : 1));
    const rel = () => (st.oid !== null ? cat().rel(st.oid) : null);
    const relByName = (n) => rels().find((r) => r.name === n && r.kind !== 'index') || null;
    const relByFile = (f) => rels().find((r) => r.file === f) || null;
    const pick = (r, block, item) => { st.oid = r ? r.oid : null; st.block = block === undefined ? null : block; st.item = item === undefined ? null : item; st.image = null; if (r) UI.store.set('storage.rel', r.name); };
    const visible = () => !el.hidden && el.isConnected;

    const view = {
      onSelect(sel) {
        if (!sel) return;
        const oid = sel.rel !== undefined ? sel.rel : sel.index !== undefined ? sel.index : undefined;
        if (oid === undefined) return;
        const r = cat().rel(typeof oid === 'object' ? oid.oid : oid);
        if (!r) return;
        if (sel.tid) pick(r, sel.tid.b, sel.tid.o); else pick(r, sel.block);
        st.scroll = sel.tid ? 'tuple' : sel.block !== undefined ? 'page' : null;
        if (visible()) view.render();
      },
      onRun(run) {
        const evs = (run && run.events) || [];
        st.pos = -1;
        if (!st.follow) return;
        const last = [...evs].reverse().find(isChange);
        if (last) { const r = relByName(last.data.rel); if (r) { const t = changeTid(last); pick(r, t.b, t.o); } }
      },
      onDb() { st.oid = null; st.block = null; st.item = null; },
      render() { draw(); },
    };

    function followTimeline() {
      const tl = app.timeline;
      if (!st.follow || tl.pos === st.pos) return;
      st.pos = tl.pos;
      const cur = tl.current();
      if (!cur) return;
      if (isChange(cur)) { const r = relByName(cur.data.rel); if (r) { const t = changeTid(cur); pick(r, t.b, t.o); } return; }
      const r = rel();
      if (!r) return;
      const bs = blocksOf(cur, r);
      if (bs.length && bs[0] !== st.block) { st.block = bs[0]; st.item = null; st.image = null; }
    }

    function draw() {
      followTimeline();
      const all = rels();
      if (st.oid === null || !rel()) {
        const saved = UI.store.get('storage.rel', null);
        const r = all.find((x) => x.name === saved) || all.find((x) => x.kind === 'table') || null;
        pick(r);
      }
      const r = rel();
      head.innerHTML = '';
      const sel = h('select.inp.st-rel', { 'aria-label': 'Table or index', onchange: (e) => { pick(cat().rel(+e.target.value)); draw(); } },
        h('optgroup', { label: 'Tables' }, all.filter((x) => x.kind !== 'index').map((x) => h('option', { value: String(x.oid), selected: r && x.oid === r.oid }, x.name + ' (' + UI.plural(app.db.disk.blocks(x.file), 'page') + ')'))),
        h('optgroup', { label: 'Indexes' }, all.filter((x) => x.kind === 'index').map((x) => h('option', { value: String(x.oid), selected: r && x.oid === r.oid }, x.name + ' (' + UI.plural(app.db.disk.blocks(x.file), 'page') + ')'))));
      head.appendChild(sel);
      head.appendChild(h('label.kv-check', { title: 'When you step through a run, open the page (and tuple) each step touches' }, h('input', { type: 'checkbox', checked: st.follow, onchange: (e) => { st.follow = e.target.checked; UI.store.set('storage.follow', st.follow); } }), 'Follow the run'));
      head.appendChild(UI.btn('refresh', null, 'Read the pages again', () => draw(), 'icon'));
      body.innerHTML = '';
      if (!r) { body.appendChild(h('div.empty', h('p', 'No tables yet.'), h('p.muted', 'Create a table and insert some rows, or load a sample database.'))); return; }
      const c = visCtx(app);
      const heap = r.kind !== 'index';
      const nb = app.db.disk.blocks(r.file);
      const cap = Math.min(nb, 2000);
      const pages = [];
      for (let b = 0; b < cap; b++) {
        const im = images(app.db, r.file, b);
        const bytes = im.mem || im.disk;
        const info = bytes ? scanPage(bytes, heap, c) : { isNew: true, slots: [], n: 0, live: 0, dead: 0, pending: 0, lpDead: 0, tupleBytes: 0, free: 0, size: app.db.disk.pageSize };
        info.cached = !!im.frame; info.dirty = !!(im.frame && im.frame.dirty); info.frame = im.frame ? im.frame.i : null;
        pages.push(info);
      }
      if (st.block !== null && st.block >= nb) { st.block = null; st.item = null; }
      const marks = runMarks(r);
      if (marks) body.appendChild(stepBanner(marks, r));
      body.appendChild(summary(r, pages, nb, heap));
      body.appendChild(strip(r, pages, nb, marks));
      if (st.block !== null) body.appendChild(pageCard(r, st.block, heap, c, marks));
      else body.appendChild(h('p.muted.st-hint', 'Select a page to see it drawn byte by byte.'));
      if (st.scroll) { const t = body.querySelector(st.scroll === 'tuple' ? '.st-tuple' : '.st-page'); if (t && t.scrollIntoView) t.scrollIntoView({ block: 'nearest' }); st.scroll = null; }
    }

    /** the pages this run touched, the one the current step touches, and the last tuple changed so far */
    function runMarks(r) {
      const tl = app.timeline;
      if (!tl.length) return null;
      const touched = new Set();
      let last = null, lastAt = 0;
      const upto = tl.upTo();
      upto.forEach((e, k) => { for (const b of blocksOf(e, r)) touched.add(b); if (isChange(e) && e.data.rel === r.name) { last = e; lastAt = k + 1; } });
      const cur = tl.current();
      return { touched, now: new Set(cur ? blocksOf(cur, r) : []), cur, last, lastAt, pos: tl.pos, len: tl.length };
    }
    function stepBanner(m, r) {
      const kids = [h('span.kv-step', m.pos ? 'Step ' + m.pos + ' of ' + m.len : 'Before the first step')];
      if (m.cur) kids.push(h('span', UI.describeEvent(m.cur) + (m.now.size ? '' : ' (not in ' + r.name + ')')));
      const box = h('div.kv-banner', kids);
      if (m.last) {
        const t = changeTid(m.last);
        const verb = m.last.type === 'heap.insert' ? 'inserted' : m.last.type === 'heap.update' ? 'written by an update' : 'deleted';
        box.appendChild(h('div.st-last', 'Last tuple ' + verb + ' so far (step ' + m.lastAt + '): ', h('button.kv-link', { type: 'button', onclick: () => { st.block = t.b; st.item = t.o; st.scroll = 'tuple'; draw(); } }, tidText(t))));
      }
      box.appendChild(h('div.muted.kv-small', 'The pages show their current bytes; stepping marks where each step happened (' + UI.plural(m.touched.size, 'page') + ' of ' + r.name + ' touched up to here).'));
      return box;
    }

    function summary(r, pages, nb, heap) {
      const tot = pages.reduce((a, p) => { a.n += p.n; a.live += p.live; a.dead += p.dead; a.pending += p.pending; a.lpDead += p.lpDead; a.bytes += p.tupleBytes; a.free += p.free; a.cached += p.cached ? 1 : 0; a.dirty += p.dirty ? 1 : 0; return a; }, { n: 0, live: 0, dead: 0, pending: 0, lpDead: 0, bytes: 0, free: 0, cached: 0, dirty: 0 });
      const size = app.db.disk.pageSize;
      const used = nb ? 1 - tot.free / (pages.length * size) : 0;
      const fsm = app.db.fsms.get(r.file) || r.fsm || [];
      const tracked = fsm.filter((x) => x !== undefined && x !== null).length;
      const stat = (label, value, title, cls) => h('div.kv-stat' + (cls ? '.' + cls : ''), { title: title || '' }, h('div.kv-sv', value), h('div.kv-sl', label));
      const stats = h('div.kv-stats',
        stat('pages', fmt(nb), 'blocks in the file, ' + fmt(size) + ' bytes each'),
        stat(heap ? 'tuples' : 'entries', fmt(tot.n), 'items with a normal line pointer'),
        heap ? stat('live', fmt(tot.live), 'visible to a new transaction', 'ok') : null,
        heap ? stat('dead', fmt(tot.dead + tot.lpDead), 'versions no transaction can see any more (VACUUM reclaims them), and dead line pointers', 'bad') : null,
        heap && tot.pending ? stat('in flux', fmt(tot.pending), 'versions some transaction may still see, or inserts not yet committed', 'warn') : null,
        stat('avg size', tot.n ? Math.round(tot.bytes / tot.n) + ' B' : '–', 'average item length, header included'),
        stat('fill', Math.round(used * 100) + '%', 'bytes in use (headers, line pointers, items) over the size of all pages'),
        stat('in memory', fmt(tot.cached), 'pages of this file now in buffer frames', 'acc'),
        tot.dirty ? stat('dirty', fmt(tot.dirty), 'cached pages changed since they were read: newer in memory than on disk', 'warn') : null);
      const txt = heap
        ? [h('p', 'Heap file organisation: a tuple goes wherever there is room. An insert asks the free-space map for a page with enough space (the last page first), and extends the file by a block when none has. The map here records the free bytes of ' + UI.plural(tracked, 'page') + '; it is a hint, refreshed whenever a page is visited.'),
          h('p', 'An UPDATE does not overwrite: it writes a new version and sets the old one\'s xmax and ctid, so the old one becomes dead once no snapshot needs it, and VACUUM reclaims the space.')]
        : [h('p', 'An index file is made of pages too: block 0 is the meta page that says where the root is, and every other page is one node of the ' + (r.method || 'B+ tree') + ' with its entries in key order and its sibling links in the special area at the end of the page.')];
      return h('section.kv-card.st-sum', h('h3', (heap ? 'Table ' : 'Index ') + r.name, h('span.muted', ' · file ' + r.file + ' · ' + UI.plural(nb, 'block'))), stats, h('div.st-org', txt));
    }

    function strip(r, pages, nb, marks) {
      const size = app.db.disk.pageSize;
      const fsm = app.db.fsms.get(r.file) || [];
      const box = h('div.st-strip', { role: 'list' });
      pages.forEach((p, b) => {
        const usedFrac = p.isNew ? 0 : 1 - p.free / size;
        const deadFrac = p.n ? ((p.dead + p.lpDead) / Math.max(1, p.n + p.lpDead)) * usedFrac : 0;
        const cls = (st.block === b ? '.sel' : '') + (marks && marks.now.has(b) ? '.now' : marks && marks.touched.has(b) ? '.run' : '');
        const title = 'Block ' + b + ': ' + (p.isNew ? 'empty' : UI.plural(p.n, r.kind === 'index' ? 'entry' : 'tuple', r.kind === 'index' ? 'entries' : 'tuples') + (p.dead ? ', ' + p.dead + ' dead' : '') + ', ' + fmt(p.free) + ' bytes free') + (fsm[b] !== undefined ? ' (free-space map: ' + fmt(fsm[b]) + ')' : '') + (p.cached ? ' · in frame ' + p.frame + (p.dirty ? ', dirty' : '') : ' · on disk only');
        box.appendChild(h('button.st-pg' + cls, { type: 'button', role: 'listitem', title, 'aria-label': title, onclick: () => { st.block = st.block === b ? null : b; st.item = null; st.image = null; st.scroll = 'page'; draw(); } },
          h('span.st-fill', h('span.st-used', { style: { height: Math.round(usedFrac * 100) + '%' } }), deadFrac ? h('span.st-deadfill', { style: { height: Math.round(deadFrac * 100) + '%' } }) : null),
          h('span.st-pgn', String(b)), h('span.st-pgt', p.isNew ? '–' : String(p.n)),
          h('span.st-dots', p.cached ? h('i.st-dot.mem', { title: 'in the buffer pool' }) : null, p.dirty ? h('i.st-dot.dirty', { title: 'dirty' }) : null)));
      });
      const legend = h('div.st-legend.kv-small', h('span', h('i.st-sw.used'), 'used'), h('span', h('i.st-sw.deadsw'), 'dead'), h('span', h('i.st-dot.mem'), 'in memory'), h('span', h('i.st-dot.dirty'), 'dirty'), marks ? h('span', h('i.st-sw.nowsw'), 'this step') : null, marks ? h('span', h('i.st-sw.runsw'), 'touched in the run') : null);
      return h('section.kv-card', h('h3', 'The file, block by block', nb > pages.length ? h('span.muted', ' (first ' + pages.length + ' of ' + nb + ')') : null), box, legend);
    }

    function pageCard(r, b, heap, c, marks) {
      const im = images(app.db, r.file, b);
      const both = im.mem && im.disk;
      const differs = both ? diffRanges(im.disk, im.mem) : [];
      let which = st.image || (im.mem ? 'mem' : 'disk');
      if (which === 'mem' && !im.mem) which = 'disk';
      if (which === 'disk' && !im.disk) which = 'mem';
      const bytes = which === 'mem' ? im.mem : im.disk;
      const card = h('section.kv-card.st-page');
      card.appendChild(h('h3', 'Block ' + b + ' of ' + r.name, h('span.muted', ' · ' + fmt(app.db.disk.pageSize) + ' bytes')));
      // where the page is: on disk, in a frame, and whether the two copies differ
      const where = h('div.st-where');
      if (im.mem) {
        where.appendChild(h('div.seg', h('button' + (which === 'mem' ? '.on' : ''), { type: 'button', onclick: () => { st.image = 'mem'; draw(); } }, 'In memory' + (im.frame.dirty ? ' (dirty)' : '')), h('button' + (which === 'disk' ? '.on' : ''), { type: 'button', onclick: () => { st.image = 'disk'; draw(); } }, 'On disk')));
        where.appendChild(h('p.kv-small', im.frame.dirty
          ? (differs.length ? 'Frame ' + im.frame.i + ' holds a newer version of this page than the disk: ' + UI.plural(differs.reduce((a, d) => a + d[1] - d[0], 0), 'byte') + ' differ (outlined). The change is in memory and in the log; the page goes back to disk when it is evicted, or at a checkpoint.' + (isZero(im.disk) ? ' On disk the block is still all zeros: it was added to the file but never written.' : '') : 'Frame ' + im.frame.i + ' is marked dirty; its bytes match the disk copy.')
          : 'Cached in frame ' + im.frame.i + ' (' + UI.plural(im.frame.pins, 'pin') + '), clean: the same bytes as on disk.'));
      } else where.appendChild(h('p.kv-small', 'Only on disk: this page is not in the buffer pool now. A query that needs it will read it into a frame (a miss).'));
      card.appendChild(where);
      if (!bytes) { card.appendChild(h('p.muted', 'No bytes for this block.')); return card; }
      const info = scanPage(bytes, heap, c);
      if (info.isNew) { card.appendChild(h('p.muted', 'This copy of the page is all zeros: a new, empty block.')); return card; }
      if (!info.ok) { card.appendChild(h('p.muted', 'This page does not have a slotted-page header (pd_lower ' + u16(bytes, 12) + ', pd_upper ' + u16(bytes, 14) + ').')); card.appendChild(hexDump(bytes, [], 0, 256)); return card; }
      const sp = !heap ? btSpecial(bytes, info.special) : null;
      card.appendChild(pageMap(bytes, info, which === 'mem' ? differs : [], marks && marks.last && marks.last.data.rel === r.name && changeTid(marks.last).b === b ? changeTid(marks.last).o : null));
      card.appendChild(headerTable(bytes, info));
      if (info.special < info.size) card.appendChild(specialBox(info, sp));
      card.appendChild(slotTable(r, b, bytes, info, heap, sp, marks));
      card.appendChild(h('details.st-hexall', { ontoggle: (e) => { const d = e.currentTarget; if (d.open && !d.querySelector('.hex')) d.appendChild(hexDump(bytes, pageRegions(info), 0, bytes.length)); } }, h('summary', 'All ' + fmt(bytes.length) + ' bytes in hex')));
      if (st.item !== null) card.appendChild(tupleCard(r, b, st.item, bytes, heap, c, sp));
      return card;
    }

    /** the regions of a page, for colouring its hex dump */
    function pageRegions(info) {
      const regs = [['page header', 0, 24, 'x-xmin'], ['line pointers', 24, info.lower, 'x-im'], ['free space', info.lower, info.upper, 'x-free']];
      for (const sl of info.slots) if (sl.flags === K.LP.NORMAL && sl.len) regs.push(['item ' + sl.i, sl.off, sl.off + sl.len, 'x-c' + (sl.i % 2)]);
      if (info.special < info.size) regs.push(['special', info.special, info.size, 'x-ctid']);
      return regs;
    }

    /** the page to scale: one row of the drawing per size/32 bytes, every region a rectangle */
    function pageMap(bytes, info, diffs, justItem) {
      const size = bytes.length;
      // on a phone, half as many bytes a row in a drawing as wide as the screen, so its labels keep their size
      const phone = app.el.classList.contains('phone');
      const VW = phone ? 320 : 512;
      const W = phone ? Math.max(16, Math.min(64, size / 64)) : Math.max(16, Math.min(256, size / 32)), U = VW / W, RH = 12, rows = Math.ceil(size / W);
      const svg = s('svg', { class: 'st-map', viewBox: '0 0 ' + VW + ' ' + (rows * RH), role: 'img', 'aria-label': 'Slotted page, ' + size + ' bytes' });
      const seg = (a, z, cls, extra, label) => {
        const g = s('g', Object.assign({ class: cls }, extra || {}));
        if (label) g.appendChild(s('title', { text: label }));
        for (let r = Math.floor(a / W); r <= Math.floor((z - 1) / W) && z > a; r++) {
          const x0 = Math.max(a, r * W) - r * W, x1 = Math.min(z, (r + 1) * W) - r * W;
          g.appendChild(s('rect', { x: x0 * U, y: r * RH, width: (x1 - x0) * U, height: RH }));
        }
        svg.appendChild(g);
        return g;
      };
      const text = (at, str, cls, maxW) => {
        const r = Math.floor(at / W), x = (at - r * W) * U;
        if (maxW !== undefined && str.length * 5.4 > maxW) return;
        svg.appendChild(s('text', { x: x + 2, y: r * RH + RH - 3, class: 'st-lbl' + (cls ? ' ' + cls : ''), text: str }));
      };
      seg(0, size, 'r-bg');
      // the header is one region under its label; its fields are hover targets on top of it
      seg(0, 24, 'r-hdr r-hdr0', null, 'page header, 24 bytes: ' + HDR.map(([n]) => n).join(', '));
      HDR.forEach(([n, o, l]) => seg(o, o + l, 'r-hdrf', null, n + ' (bytes ' + o + '–' + (o + l - 1) + ')'));
      for (const sl of info.slots) seg(24 + (sl.i - 1) * 4, 24 + sl.i * 4, 'r-lp f-' + LPF[sl.flags] + (sl.i === justItem ? ' just' : ''), { 'data-i': sl.i, onclick: () => { st.item = sl.i; st.scroll = 'tuple'; draw(); } }, 'line pointer ' + sl.i + ': lp_off ' + sl.off + ', lp_len ' + sl.len + ', ' + LPF[sl.flags]);
      seg(info.lower, info.upper, 'r-free', null, 'free space: ' + (info.upper - info.lower) + ' bytes (pd_lower ' + info.lower + ' to pd_upper ' + info.upper + ')');
      for (const sl of info.slots) {
        if (sl.flags !== K.LP.NORMAL || !sl.len) continue;
        const kind = sl.f ? sl.f.kind : 'live';
        seg(sl.off, sl.off + sl.len, 'r-tup r-tup' + (sl.i % 2) + ' k-' + kind + (sl.i === justItem ? ' just' : ''), { 'data-i': sl.i, onclick: () => { st.item = sl.i; st.scroll = 'tuple'; draw(); } }, 'item ' + sl.i + ': bytes ' + sl.off + '–' + (sl.off + sl.len - 1) + (sl.f ? ', ' + (kind === 'dead' ? 'dead' : kind === 'pending' ? 'not visible to a new transaction' : 'live') : ''));
        if (sl.h) seg(sl.off, sl.off + Math.min(sl.len, sl.h.hoff), 'r-thdr', { 'data-i': sl.i });
      }
      if (info.special < size) seg(info.special, size, 'r-spc', null, 'special area: ' + (size - info.special) + ' bytes');
      for (const [a, z] of diffs) seg(a, z, 'r-diff', { 'data-audit': 'overlap-ok' }, 'bytes ' + a + '–' + (z - 1) + ' differ from the disk copy');
      // labels on the regions wide enough to hold them
      text(0, 'header', 'on-dark', 24 * U);
      const lpEnd = info.lower;
      if (info.slots.length) for (const sl of info.slots) text(24 + (sl.i - 1) * 4, String(sl.i), 'on-dark', 4 * U);
      const freeLen = info.upper - info.lower;
      if (freeLen > W) { const mid = info.lower + Math.floor(freeLen / 2 / W) * W; const r0 = Math.floor(mid / W) * W; text(Math.max(info.lower, r0) + Math.max(0, Math.floor(W / 2) - 18), 'free space · ' + fmt(freeLen) + ' bytes', 'muted'); }
      for (const sl of info.slots) if (sl.flags === K.LP.NORMAL && sl.len) { const room = Math.min(sl.len, W - (sl.off % W)) * U; text(sl.off, '#' + sl.i, 'on-dark', room); }
      // pd_lower and pd_upper as ticks
      for (const [at, n] of [[lpEnd, 'pd_lower'], [info.upper, 'pd_upper']]) {
        const r = Math.floor(at / W), x = (at - r * W) * U;
        svg.appendChild(s('line', { x1: x, x2: x, y1: r * RH - 1, y2: r * RH + RH + 1, class: 'st-tick' }, s('title', { text: n + ' = ' + at })));
      }
      const legend = h('div.st-legend.kv-small', h('span', h('i.st-sw.hdrsw'), 'page header (24 B)'), h('span', h('i.st-sw.lpsw'), 'line pointers ↓'), h('span', h('i.st-sw.freesw'), 'free space'), h('span', h('i.st-sw.tupsw'), 'tuples ↑ (darker: tuple header)'), info.special < size ? h('span', h('i.st-sw.spcsw'), 'special area') : null, diffs.length ? h('span', h('i.st-sw.diffsw'), 'differs from disk') : null, h('span', h('i.st-sw.deadsw'), 'dead'));
      return h('div.st-mapbox', h('div.kv-small.muted', 'Drawn to scale, ' + W + ' bytes a row, offset 0 at the top left. Hover a line pointer to see its tuple.'), svg, legend);
    }

    function headerTable(bytes, info) {
      const val = (n, o, l) => {
        if (n === 'pd_lsn') return String(new K.Page(bytes).lsn);
        if (n === 'pd_pagesize_version') { const v = u16(bytes, o); return (v & 0xff00) + ' | v' + (v & 0xff); }
        if (n === 'pd_checksum') { const v = u16(bytes, o); return v ? '0x' + hx(v, 4) : '0 (not written yet)'; }
        return l === 4 ? String(u32(bytes, o)) : String(u16(bytes, o));
      };
      return h('div.st-hdr', h('h4', 'Page header'), h('table.grid.small', h('thead', h('tr', h('th', 'Field'), h('th.num', 'Bytes'), h('th.num', 'Value'), h('th', 'Meaning'))),
        h('tbody', HDR.map(([n, o, l, m]) => h('tr', h('td', h('code', n)), h('td.num', o + '–' + (o + l - 1)), h('td.num', val(n, o, l)), h('td.st-wrap', m))))),
        h('p.kv-small', UI.plural(info.slots.length, 'line pointer') + ' of 4 bytes (' + (info.lower - 24) + ' bytes), ' + fmt(info.upper - info.lower) + ' bytes free, ' + fmt(info.special - info.upper) + ' bytes of items' + (info.special < info.size ? ', ' + (info.size - info.special) + ' bytes of special area' : '') + '.'));
    }
    function specialBox(info, sp) {
      let txt = (info.size - info.special) + ' bytes at the end of the page that the access method owns.';
      if (sp && sp.meta) txt = 'Meta page: the root is block ' + sp.root + ', the tree has ' + UI.plural(sp.levels + 1, 'level') + '.';
      else if (sp) txt = (sp.leaf ? 'Leaf' : 'Internal node') + (sp.root ? ' (the root)' : '') + ' at level ' + sp.level + '; left sibling ' + (sp.left === NONE ? 'none' : 'block ' + sp.left) + ', right sibling ' + (sp.right === NONE ? 'none' : 'block ' + sp.right) + '.';
      return h('div.st-special.kv-small', h('b', 'Special area: '), txt);
    }

    function slotTable(r, b, bytes, info, heap, sp, marks) {
      const cols = heap ? r.cols : null;
      const just = marks && marks.last && marks.last.data.rel === r.name && changeTid(marks.last).b === b ? changeTid(marks.last).o : null;
      const ctx = { session: app.session, db: app.db, zone: app.session.settings.timezone };
      const preview = (sl) => {
        if (sl.flags !== K.LP.NORMAL || !sl.len) return '';
        const item = bytes.subarray(sl.off, sl.off + sl.len);
        if (heap) { const vals = safe(() => K.Tuple.deform(item, cols, ctx), null); if (!vals) return '?'; return cols.map((c, i) => (c.dropped ? null : vals[i] === null ? 'NULL' : UI.valueText(vals[i], c.type))).filter((x) => x !== null).slice(0, 4).join(', '); }
        const e = indexLayout(item, r.keyTypes || [], ctx);
        return (sp && !sp.leaf ? '→ block ' + e.b : tidText(e)) + (e.cols.length ? ' ' + e.cols.map((x) => (x.v === undefined ? 'NULL' : UI.valueText(x.v, x.c.type))).join(', ') : '');
      };
      const rows = info.slots.slice(0, 500).map((sl) => {
        const kind = sl.f ? sl.f.kind : '';
        return h('tr.st-slot' + (st.item === sl.i ? '.sel' : '') + (sl.i === just ? '.just' : '') + (kind ? '.k-' + kind : ''), { dataset: { i: String(sl.i) }, onclick: () => { st.item = st.item === sl.i ? null : sl.i; st.scroll = 'tuple'; draw(); } },
          h('td.num', String(sl.i)), h('td.num', String(sl.off)), h('td', LPF[sl.flags]), h('td.num', String(sl.len)),
          heap ? h('td.num', sl.h ? String(sl.h.xmin) : '') : null, heap ? h('td.num', sl.h ? String(sl.h.xmax || '') : '') : null,
          heap ? h('td', sl.h ? tidText(sl.h.ctid) : '') : null,
          heap ? h('td', { title: sl.f ? sl.f.me.why : '' }, sl.f ? h('span.kv-badge.' + (sl.f.me.visible ? 'ok' : 'no'), sl.f.me.visible ? 'yes' : 'no') : '') : null,
          ((p) => h('td.st-prev', { title: p.length > 30 ? p.slice(0, 600) : null }, p.slice(0, 80)))(preview(sl)));
      });
      const th = ['Item', 'lp_off', 'lp_flags', 'lp_len'].concat(heap ? ['xmin', 'xmax', 'ctid', 'You see it'] : []).concat([heap ? 'Values' : 'Entry']);
      return h('div.st-slots', h('h4', 'Line pointers and items'), h('div.grid-wrap', h('table.grid.small', h('thead', h('tr', th.map((t, k) => h('th' + (k < 4 && k !== 2 ? '.num' : ''), t)))), h('tbody', rows))),
        info.slots.length > 500 ? h('p.kv-small', 'First 500 of ' + info.slots.length + ' line pointers.') : null,
        heap ? h('p.kv-small.muted', '"You see it" is the visibility of each version to ' + (app.session.tx ? 'the transaction open in ' + app.session.name : 'a statement run now in ' + app.session.name) + '; hover it for the reason.') : null);
    }

    /** read one tuple, following a redirect line pointer; from memory if the page is cached */
    function readTuple(r, tid) {
      if (tid.b >= app.db.disk.blocks(r.file)) return null;
      const im = images(app.db, r.file, tid.b);
      const bytes = im.mem || im.disk;
      if (!bytes) return null;
      const p = new K.Page(bytes);
      if (p.isNew() || tid.o < 1 || tid.o > p.nslots) return null;
      const lp = p.lp(tid.o);
      if (lp.flags === K.LP.REDIRECT) return readTuple(r, { b: tid.b, o: lp.off });
      if (lp.flags !== K.LP.NORMAL || !lp.len) return null;
      const item = bytes.subarray(lp.off, lp.off + lp.len);
      return { tid, item, h: K.Tuple.header(item) };
    }
    /** the update chain through this version: older ones (found by their ctid) and newer ones (by following ctid) */
    function chain(r, tid) {
      const out = [];
      const seen = new Set();
      const key = (t) => t.b + ',' + t.o;
      // older versions: a scan for tuples whose ctid points here (only for files small enough to look through)
      const nb = app.db.disk.blocks(r.file);
      let target = tid;
      const older = [];
      if (nb <= 400) {
        const pointing = new Map();
        for (let b = 0; b < nb; b++) {
          const im = images(app.db, r.file, b);
          const bytes = im.mem || im.disk;
          if (!bytes) continue;
          const p = new K.Page(bytes);
          if (p.isNew()) continue;
          for (let o = 1; o <= p.nslots; o++) {
            const lp = p.lp(o);
            if (lp.flags !== K.LP.NORMAL || lp.len < K.Tuple.HEADER) continue;
            const hd = K.Tuple.header(bytes.subarray(lp.off, lp.off + lp.len));
            if (hd.ctid.b !== b || hd.ctid.o !== o) pointing.set(key(hd.ctid), { b, o });
          }
        }
        for (let k = 0; k < 50; k++) { const prev = pointing.get(key(target)); if (!prev || seen.has(key(prev))) break; seen.add(key(prev)); older.unshift(prev); target = prev; }
      }
      for (const t of older) out.push(t);
      out.push(tid);
      seen.add(key(tid));
      let cur = readTuple(r, tid);
      for (let k = 0; cur && k < 50; k++) {
        const n = cur.h.ctid;
        if ((n.b === cur.tid.b && n.o === cur.tid.o) || seen.has(key(n)) || n.b === NONE) break;
        seen.add(key(n));
        out.push(n);
        cur = readTuple(r, n);
      }
      return out;
    }

    function tupleCard(r, b, i, bytes, heap, c, sp) {
      const p = new K.Page(bytes);
      const card = h('section.st-tuple');
      if (i < 1 || i > p.nslots) { st.item = null; return card; }
      const lp = p.lp(i);
      card.appendChild(h('h3', (heap ? 'Tuple ' : 'Index entry ') + tidText({ b, o: i }), h('span.muted', ' · line pointer ' + LPF[lp.flags] + ', ' + lp.len + ' bytes at offset ' + lp.off), h('button.btn.icon.st-close', { type: 'button', 'aria-label': 'Close the tuple', title: 'Close', onclick: () => { st.item = null; draw(); } }, UI.icon('x'))));
      if (lp.flags === K.LP.REDIRECT) { card.appendChild(h('p', 'A redirect line pointer: it forwards to item ', h('button.kv-link', { type: 'button', onclick: () => { st.item = lp.off; draw(); } }, String(lp.off)), ' on this page (the head of a heap-only update chain).')); return card; }
      if (lp.flags !== K.LP.NORMAL || !lp.len) { card.appendChild(h('p.muted', lp.flags === K.LP.DEAD ? 'A dead line pointer: pruning removed the tuple and kept the slot, because an index may still point at this TID. VACUUM sets it free after cleaning the indexes.' : 'An unused line pointer: free for the next insert on this page.')); return card; }
      const item = bytes.subarray(lp.off, lp.off + lp.len);
      const ctx = { session: app.session, db: app.db, zone: app.session.settings.timezone };
      if (!heap) return indexTuple(card, r, item, sp, ctx);
      const L = heapLayout(item, r.cols, ctx);
      const hd = L.hd;
      const xs = (x) => (x ? safe(() => c.db.xact.status(x), '?') : '');
      const f = fate(hd, c);
      card.appendChild(h('div.st-vis',
        h('div', h('span.kv-badge.' + (f.me.visible ? 'ok' : 'no'), f.me.visible ? 'visible' : 'not visible'), ' to ', h('b', app.session.tx ? 'the open transaction in ' + app.session.name : 'a new statement in ' + app.session.name), ': ', f.me.why + '.'),
        c.tx ? h('div', h('span.kv-badge.' + (f.all.visible ? 'ok' : 'no'), f.all.visible ? 'visible' : 'not visible'), ' to a new transaction: ', f.all.why + '.') : null,
        f.kind === 'dead' ? h('div.kv-small', 'Dead to every transaction: VACUUM can reclaim it.') : null));
      const im = L.im2;
      const flags = IMW.filter(([m]) => hd.infomask & m);
      const ctid = hd.ctid;
      const self = ctid.b === b && ctid.o === i;
      const rows = [
        ['t_xmin', '0–3', String(hd.xmin), 'inserted by transaction ' + hd.xmin + ' (' + xs(hd.xmin) + ')'],
        ['t_xmax', '4–7', String(hd.xmax), hd.xmax ? (hd.infomask & K.Tuple.IM.XMAX_LOCK_ONLY ? 'locked by transaction ' : 'deleted or replaced by transaction ') + hd.xmax + ' (' + xs(hd.xmax) + ')' : 'not deleted'],
        ['t_cid', '8–11', String(hd.cid), 'command number within ' + (hd.xmax && xs(hd.xmax) === K.XSTATUS.INPROGRESS ? 'the deleting' : 'the inserting') + ' transaction'],
        ['t_ctid', '12–17', tidText(ctid), self ? 'points to itself: the newest version' : h('span', 'points to the newer version ', h('button.kv-link', { type: 'button', title: 'Follow the ctid', onclick: () => followCtid(r, ctid) }, 'follow to ' + tidText(ctid)))],
        ['t_infomask2', '18–19', '0x' + hx(im, 4), hd.natts + ' attributes' + (im & K.Tuple.IM2.HOT_UPDATED ? '; HOT updated: the new version is on this page, with no new index entry' : '') + (im & K.Tuple.IM2.ONLY_TUPLE ? '; heap-only tuple: no index entry points at it' : '')],
        ['t_infomask', '20–21', '0x' + hx(hd.infomask, 4), flags.length ? h('ul.st-flags', flags.map(([, n, w]) => h('li', h('code', n), ' ', w))) : 'no flags'],
        ['t_hoff', '22', String(hd.hoff), 'the column data starts at byte ' + hd.hoff + ' (the header rounded up to 8 bytes)'],
        ['null bitmap', L.bm ? '23–' + (22 + L.bm) : '–', L.bm ? [...item.subarray(23, 23 + L.bm)].map((x) => x.toString(2).padStart(8, '0').split('').reverse().join('')).join(' ') : 'none', L.bm ? 'one bit per column, 1 = a value is stored, 0 = null' : 'no column is null, so there is no bitmap'],
      ];
      card.appendChild(h('h4', 'Tuple header'));
      card.appendChild(h('div.grid-wrap', h('table.grid.small.st-thdr', h('thead', h('tr', h('th', 'Field'), h('th.num', 'Bytes'), h('th.num', 'Value'), h('th', 'Meaning'))), h('tbody', rows.map(([n, at, v, m]) => h('tr', h('td', h('code', n)), h('td.num', at), h('td.num', v), h('td.st-wrap', m)))))));
      card.appendChild(h('h4', 'Columns'));
      const crow = (x) => {
        if (x.c.dropped && !x.len) return null;
        const nm = x.c.dropped ? '(dropped)' : x.c.name;
        if (x.missing) return h('tr', h('td', nm), h('td', tyName(x.c.type)), h('td.num', '–'), h('td.num', ''), h('td.num', ''), h('td', ''), h('td.null', 'not stored (added after this tuple was written)'));
        if (!x.present) return h('tr', h('td', nm), h('td', tyName(x.c.type)), h('td.num', '–'), h('td.num', ''), h('td.num', '0'), h('td', ''), h('td.null', 'NULL (bit ' + x.i + ' is 0)'));
        if (x.err) return h('tr', h('td', nm), h('td', tyName(x.c.type)), h('td.num', String(x.off)), h('td.num', ''), h('td.num', ''), h('td', ''), h('td.null', 'could not decode'));
        const raw = [...item.subarray(x.off, x.off + x.len)].map((v) => hx(v)).join(' ');
        return h('tr', h('td', nm), h('td', tyName(x.c.type)), h('td.num', String(x.off)), h('td.num', { title: 'aligned to ' + x.align + ' bytes' }, x.pad ? '+' + x.pad : '0'), h('td.num', String(x.len)), h('td.st-raw', { title: raw }, raw.length > 24 ? raw.slice(0, 23) + '…' : raw), h('td', UI.valueText(x.v, x.c.type)));
      };
      card.appendChild(h('div.grid-wrap', h('table.grid.small', h('thead', h('tr', h('th', 'Column'), h('th', 'Type'), h('th.num', 'Offset'), h('th.num', 'Padding'), h('th.num', 'Length'), h('th', 'Bytes'), h('th', 'Value'))), h('tbody', L.cols.map(crow)))));
      card.appendChild(h('p.kv-small.muted', 'Each value starts at a multiple of its type\'s alignment (int2: 2, int4 and variable-length values: 4, int8, float8 and timestamps: 8), so padding bytes may sit between columns. Variable-length values carry a 4-byte length first.'));
      card.appendChild(h('h4', 'Bytes'));
      card.appendChild(hexDump(item, L.regs, lp.off, item.length, true));
      // the update chain
      const ch = chain(r, { b, o: i });
      if (ch.length > 1) {
        card.appendChild(h('h4', 'Update chain'));
        card.appendChild(h('div.st-chain', ch.map((t, k) => {
          const tu = readTuple(r, t);
          const fv = tu ? fate(tu.h, c) : null;
          const here = t.b === b && t.o === i;
          return [k ? h('span.st-arrow', '→') : null, h('button.st-ver' + (here ? '.sel' : '') + (fv ? (fv.me.visible ? '.ok' : '.no') : ''), { type: 'button', title: fv ? fv.me.why : 'not found', onclick: () => { st.block = t.b; st.item = t.o; st.image = null; st.scroll = 'tuple'; draw(); } },
            h('b', tidText(t)), h('span', tu ? 'xmin ' + tu.h.xmin + (tu.h.xmax ? ' · xmax ' + tu.h.xmax : '') : 'gone'), h('span.kv-small', fv ? (fv.me.visible ? 'you see this one' : fv.kind === 'dead' ? 'dead' : 'hidden') : ''))];
        })));
        card.appendChild(h('p.kv-small.muted', 'Each UPDATE leaves the old version in place with its xmax set and its ctid pointing at the new one. Exactly one version in a chain is visible to any one snapshot.'));
      }
      return card;
    }
    function followCtid(r, t) {
      const tu = readTuple(r, t);
      if (!tu) { UI.toast('No tuple at ' + tidText(t) + ': it was removed by VACUUM', 'warn'); return; }
      st.block = t.b; st.item = t.o; st.image = null; st.scroll = 'tuple';
      draw();
    }
    function indexTuple(card, r, item, sp, ctx) {
      const L = indexLayout(item, r.keyTypes || [], ctx);
      const leaf = !sp || sp.leaf;
      const table = cat().rel(r.table);
      const rows = [
        [leaf ? 'heap TID' : 'child pointer', '0–5', leaf ? tidText(L) : 'block ' + L.b, leaf ? h('span', 'the row in ' + (table ? table.name : 'the table') + ' ', table ? h('button.kv-link', { type: 'button', onclick: () => { pick(table, L.b, L.o); st.scroll = 'tuple'; draw(); } }, 'open ' + tidText(L)) : null) : 'the subtree with keys from this separator up to the next'],
        ['info', '6–7', '0x' + hx(u16(item, 6), 4), 'entry size ' + L.size + ' bytes' + (L.hasNull ? ', has nulls' : '')],
      ];
      card.appendChild(h('div.grid-wrap', h('table.grid.small', h('thead', h('tr', h('th', 'Field'), h('th.num', 'Bytes'), h('th.num', 'Value'), h('th', 'Meaning'))), h('tbody', rows.map(([n, at, v, m]) => h('tr', h('td', n), h('td.num', at), h('td.num', v), h('td.st-wrap', m)))))));
      if (L.cols.length) card.appendChild(h('div.grid-wrap', h('table.grid.small', h('thead', h('tr', h('th', 'Key'), h('th', 'Type'), h('th.num', 'Offset'), h('th.num', 'Padding'), h('th.num', 'Length'), h('th', 'Value'))), h('tbody', L.cols.map((x) => h('tr', h('td', x.c.name), h('td', tyName(x.c.type)), h('td.num', x.off !== undefined ? String(x.off) : '–'), h('td.num', x.pad ? '+' + x.pad : '0'), h('td.num', x.len !== undefined ? String(x.len) : '0'), x.present ? h('td', x.v !== undefined ? UI.valueText(x.v, x.c.type) : '?') : h('td.null', 'NULL')))))));
      else if (!leaf) card.appendChild(h('p.kv-small.muted', 'The first pointer of an internal node has no key: it leads to everything below the first separator.'));
      card.appendChild(h('h4', 'Bytes'));
      card.appendChild(hexDump(item, L.regs, 0, item.length, true));
      return card;
    }

    return view;
  }

  /** a hex dump, 16 bytes a row, each byte coloured by the region it belongs to */
  function hexDump(bytes, regs, base, n, legend) {
    const cls = new Array(Math.min(n, bytes.length)).fill('');
    const name = new Array(cls.length).fill('');
    for (const [nm, a, z, c] of regs) for (let k = a; k < z && k < cls.length; k++) { cls[k] = c; name[k] = nm; }
    const rows = [];
    for (let r = 0; r < cls.length; r += 16) {
      const hexs = [], asc = [];
      for (let k = r; k < r + 16 && k < cls.length; k++) {
        const v = bytes[k];
        hexs.push(h('span.hb' + (cls[k] ? '.' + cls[k] : ''), { title: name[k] ? name[k] + ' · byte ' + k : 'byte ' + k }, hx(v)));
        asc.push(v >= 32 && v < 127 ? String.fromCharCode(v) : '·');
      }
      rows.push(h('div.hr', h('span.ho', hx(base + r, 4)), h('span.hh', hexs), h('span.ha', asc.join(''))));
    }
    const box = h('div.hex', rows);
    if (!legend) return box;
    const seen = new Map();
    for (const [nm, , , c] of regs) if (!seen.has(nm)) seen.set(nm, [nm, c]);
    return h('div', box, h('div.st-legend.kv-small', [...seen.values()].slice(0, 24).map(([nm, c]) => h('span', h('i.st-sw.' + c), nm))));
  }

  UI.registerView({ id: 'storage', title: 'Storage', icon: 'page', group: 'Storage', order: 10, events: true, create });
  UI.StorageView = { images, scanPage, heapLayout, hexDump };
})(typeof window !== 'undefined' ? window : globalThis);
