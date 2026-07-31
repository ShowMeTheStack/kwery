// The log view: the write-ahead log as a list of records (LSN, transaction, page, the values before and after,
// prevLSN chains, compensation records), split at the flushed point into the stable part and the log buffer, with
// each page's PageLSN beside the records that touched it, the dirty page table and the transaction table, the
// write-ahead rule at work (every page write and the log flush it forced), and the buffer and logging policies.
// Stepping through a recorded run shows records being appended and flushed.
(function (root) {
  'use strict';
  const K = root.K;
  const UI = K.UI;
  const { h, s } = UI;

  const PAGE = (r) => r.file !== undefined && r.file !== null && r.block !== undefined;
  const safe = (f, d) => { try { return f(); } catch (e) { return d; } };
  const fmt = (n) => Number(n).toLocaleString('en-US');
  const tname = (r) => 'T' + (r.top || r.xid);
  const LANES = ['--accent', '--kw', '--ty', '--num', '--qid', '--ok'];

  // ---- the policies, with what each means for recovery -------------------------------------------------------------
  const POLICY = [
    { k: 'buffer_steal', label: 'Steal', on: 'Steal', off: 'No-steal',
      yes: 'A page holding uncommitted changes may be written to disk (evicted, or at a checkpoint), so recovery must be able to undo.',
      no: 'Pages with uncommitted changes stay in memory until commit: the disk never needs undo, but the pool must hold every running transaction\'s pages.' },
    { k: 'buffer_force', label: 'Force', on: 'Force', off: 'No-force',
      yes: 'Every page a transaction changed is written before its commit record: committed work never needs redo, at the price of random writes at each commit.',
      no: 'Commit writes only the log; the changed pages go to disk later, so recovery must redo committed changes from the log.' },
    { k: 'wal_rule', label: 'WAL rule', on: 'On', off: 'Off',
      yes: 'Before a dirty page is written the log is flushed up to its PageLSN: every change on disk has its log record on stable storage.',
      no: 'Pages may reach the disk ahead of their log records: after a crash those changes can be neither redone nor undone.' },
    { k: 'full_page_writes', label: 'Full-page writes', on: 'On', off: 'Off',
      yes: 'The first change to a page after it was read or written logs the whole page, so a page torn by a crash can be rebuilt from the log.',
      no: 'Only the change is logged: a page torn half-way through its write cannot be repaired.' },
    { k: 'page_checksums', label: 'Page checksums', on: 'On', off: 'Off',
      yes: 'Every page written carries a checksum (pd_checksum), so restart detects a torn page.',
      no: 'A torn page goes unnoticed: recovery would trust a page that is half old and half new.' },
    { k: 'synchronous_commit', label: 'Synchronous commit', on: 'On', off: 'Off',
      yes: 'COMMIT returns only once its commit record is flushed: a committed transaction survives any crash.',
      no: 'COMMIT returns before the log is flushed: a crash can lose the last committed transactions (the database stays consistent, they are just gone).' },
  ];
  const settingOf = (db, k) => { const v = K.settingOf ? K.settingOf(db, k) : db.settings[k]; return v !== false && v !== 'off'; };
  /** a recovery setting for the database and every session on it, so the tabs agree */
  function setSetting(app, k, v) {
    const db = app.db;
    db.settings[k] = v;
    for (const x of db.sessions) if (x.settings) x.settings[k] = v;
  }

  // ---- describing records ------------------------------------------------------------------------------------------
  const pageName = (db, file, block) => safe(() => db.disk.file(file).name.replace(/^public\./, ''), 'file ' + file) + '[' + block + ']';
  function rowVals(db, r, bytes) {
    const rel = r.rel && safe(() => db.catalog.rel(r.rel), null);
    if (!rel || !bytes) return null;
    return safe(() => { const v = K.Tuple.deform(bytes, rel.cols, {}); return rel.cols.map((c, i) => (c.dropped ? null : { name: c.name, text: v[i] === null || v[i] === undefined ? 'NULL' : UI.valueText(v[i], c.type) })).filter(Boolean); }, null);
  }
  const tup = (v) => '(' + v.map((x) => x.text).join(', ') + ')';
  /** link every update record to the insert of its new version (the insert comes first, with the TID the update names) */
  function versions(recs) {
    const last = new Map(), newOf = new Map(), isNew = new Set();
    for (const r of recs) {
      if (r.type === 'heap.insert') last.set(r.file + ':' + r.block + ':' + r.item, r);
      else if (r.type === 'heap.update' && r.newTid) { const n = last.get(r.file + ':' + r.newTid.b + ':' + r.newTid.o); if (n) { newOf.set(r.lsn, n); isNew.add(n.lsn); } }
    }
    return { newOf, isNew };
  }
  /** what a record says, in words, with the tuple values decoded where the catalog still knows the table */
  function detail(db, r, ver) {
    switch (r.type) {
      case 'begin': return 'start';
      case 'commit': return 'commit';
      case 'abort': return r.sub ? 'rollback to savepoint (subtransaction ' + r.xid + ')' : 'abort';
      case 'end': return 'end: the transaction is finished';
      case 'checkpoint': { const d = r.data || {}; return (d.endOfRecovery ? 'end-of-recovery ' : d.fuzzy ? 'fuzzy ' : '') + 'checkpoint · running {' + (d.active || []).map((x) => 'T' + x).join(', ') + '}' + (d.dpt ? ' · ' + UI.plural(d.dpt.length, 'dirty page') : ''); }
      case 'dump': return 'archival dump taken';
      case 'heap.insert': { const v = rowVals(db, r, r.bytes); return (ver && ver.isNew.has(r.lsn) ? 'new version ' : 'insert ') + (v ? tup(v) : '(' + r.bytes.length + ' bytes)'); }
      case 'heap.update': {
        const a = rowVals(db, r, r.before), n = ver && ver.newOf.get(r.lsn), b = n ? rowVals(db, n, n.bytes) : null;
        if (a && b) {
          const ch = a.map((x, i) => (b[i] && b[i].text !== x.text ? x.name + ' ' + x.text + ' → ' + b[i].text : null)).filter(Boolean);
          return a[0].name + ' = ' + a[0].text + ': ' + (ch.length ? ch.join(', ') : 'no column changed');
        }
        return 'update ' + (a ? tup(a) : '') + ' (xmax set)';
      }
      case 'heap.delete': { const v = rowVals(db, r, r.before); return 'delete ' + (v ? tup(v) : ''); }
      case 'heap.lock': { const v = rowVals(db, r, r.before); return 'row lock on ' + (v ? tup(v) : 'a tuple'); }
      case 'clr': return 'undoes LSN ' + r.undoes + ': ' + (r.action === 'invalidate' ? 'inserted tuple marked invalid' : 'before-image restored');
      case 'btree.page': return 'B+ tree page image';
      case 'index.page': return (r.method || 'index') + ' page image';
      case 'heap.prune': return 'pruned page image';
      case 'page.image': return 'page image';
      case 'lsm.put': return 'LSM memtable put';
    }
    return r.type;
  }
  const KIND = { begin: 'start', commit: 'commit', abort: 'abort', end: 'end', checkpoint: 'checkpoint', clr: 'CLR', dump: 'dump', 'heap.insert': 'insert', 'heap.update': 'update', 'heap.delete': 'delete', 'heap.lock': 'lock', 'btree.page': 'index', 'index.page': 'index', 'heap.prune': 'prune', 'page.image': 'image', 'lsm.put': 'lsm' };
  /** PageLSN of a page in the buffer pool and on disk */
  function pageLsns(db, file, block) {
    const f = db.down ? null : db.buffers.frameOf(file, block);
    const d = safe(() => db.disk.file(file).blocks[block], null);
    return { mem: f ? new K.Page(f.buf).lsn : null, disk: d ? new K.Page(d).lsn : null };
  }
  function pageChip(db, r) {
    const p = pageLsns(db, r.file, r.block);
    const name = pageName(db, r.file, r.block);
    let cls = 'mute', t;
    if (p.disk !== null && p.disk >= r.lsn) { cls = 'ok'; t = 'on disk'; }
    else if (p.mem !== null && p.mem >= r.lsn) { cls = 'warn'; t = 'in memory'; }
    else { cls = 'no'; t = db.down ? 'not on disk' : 'not on the page'; }
    const title = name + ': PageLSN ' + (p.mem !== null ? p.mem + ' in the buffer pool, ' : '') + (p.disk !== null ? p.disk + ' on disk' : 'no block on disk') + '. ' + (cls === 'ok' ? 'The disk copy already holds this change (PageLSN ≥ ' + r.lsn + ').' : cls === 'warn' ? 'Only the page in memory holds this change: a crash now leaves it for redo.' : 'Neither copy holds this change.');
    return h('span.lg-pg.' + cls, { title }, h('span.lg-pgn', name), h('span.lg-pgl', 'PageLSN ' + (p.mem !== null ? p.mem : p.disk !== null ? p.disk : '–')), h('span.kv-badge.' + cls, t));
  }

  function create(app, el) {
    let runEvents = null, shown = UI.store.get('log.shown', 60), xf = 'all', textbook = UI.store.get('log.textbook', false);
    let hist = [], offs = [], dbRef = null, listTop = null, runEnd = 0;
    const intro = h('div.kv-intro', h('b', 'The log. '), 'Every change is described by a log record before the changed page may reach the disk (the write-ahead rule). Records go to a log buffer in memory and are flushed to stable storage at commit, when the buffer fills, or before a page whose PageLSN is past the flushed point is written; a crash loses only the unflushed tail.');
    const head = h('div.view-head.lg-head');
    const body = h('div.view-body.lg-body');
    el.appendChild(intro); el.appendChild(head); el.appendChild(body);

    // page writes and the log flushes they forced, across runs, from the bus
    function listen() {
      for (const f of offs) f();
      offs = []; hist = []; dbRef = app.db;
      const bus = app.db.bus;
      let lastFlush = null;
      offs.push(bus.on('wal.flush', (d) => { lastFlush = Object.assign({ at: hist.length }, d); }));
      offs.push(bus.on('buf.flush', (d) => {
        const forced = lastFlush && /about to be written/.test(lastFlush.why) && lastFlush.why.indexOf('block ' + d.block) >= 0 ? lastFlush : null;
        hist.push({ kind: 'write', file: d.file, block: d.block, lsn: d.lsn, forced, name: pageName(app.db, d.file, d.block) });
        lastFlush = null;
        if (hist.length > 60) hist.shift();
      }));
      offs.push(bus.on('wal.violation', (d) => { hist.push({ kind: 'violation', name: pageName(app.db, d.file, d.block), lsn: d.pageLsn, flushed: d.flushedLsn }); }));
    }
    listen();

    const view = {
      onRun(run) { runEvents = (run && run.events) || null; runEnd = app.db.wal.nextLsn; },
      onDb() { if (app.db !== dbRef) { listen(); runEvents = null; xf = 'all'; } },
      render() { draw(); },
      destroy() { for (const f of offs) f(); offs = []; },
    };

    /** the log as of the current step of the recorded run, or null when showing the log as it is */
    function stepState() {
      const tl = app.timeline;
      if (app.db.down || !runEvents || tl.events !== runEvents || !tl.length || tl.pos >= tl.length) return null;
      const ev = tl.events, pos = tl.pos;
      // records appended after the run (a checkpoint, a restart) are in the future of every step too
      const future = new Set(app.db.wal.records.filter((r) => r.lsn >= runEnd).map((r) => r.lsn));
      for (let i = pos; i < ev.length; i++) if (ev[i].type === 'wal.append') future.add(ev[i].data.lsn);
      let flushed = null, first = null;
      for (let i = 0; i < ev.length; i++) if (ev[i].type === 'wal.flush') { if (first === null) first = ev[i].data.from; if (i < pos) flushed = ev[i].data.lsn; }
      if (flushed === null) flushed = first !== null ? first : app.db.wal.flushedLsn;
      return { pos, cur: tl.current(), future, flushed, events: ev };
    }

    function draw() {
      const db = app.db, wal = db.wal;
      const S = stepState();
      const flushed = S ? S.flushed : wal.flushedLsn;
      const all = S ? wal.records.filter((r) => !S.future.has(r.lsn)) : wal.records;
      const ver = versions(all);
      // the head: notation, transaction filter, actions
      head.innerHTML = '';
      head.appendChild(h('div.seg', { role: 'group', 'aria-label': 'Notation' }, [[false, 'Records'], [true, 'Angle-bracket notation']].map(([v, l]) => h('button' + (textbook === v ? '.on' : ''), { type: 'button', onclick: () => { textbook = v; UI.store.set('log.textbook', v); draw(); } }, l))));
      const xids = []; for (let i = all.length - 1; i >= 0; i--) { const x = all[i].top || all[i].xid; if (x && !xids.includes(x)) xids.push(x); }
      if (xf !== 'all' && !xids.includes(+xf)) xf = 'all';
      head.appendChild(h('select.inp.lg-xf', { 'aria-label': 'Show the records of', onchange: (e) => { xf = e.target.value; draw(); } }, h('option', { value: 'all' }, 'All transactions'), xids.slice(0, 80).map((x) => h('option', { value: String(x), selected: String(x) === xf }, 'T' + x + (db.xact.active && [...db.xact.active.values()].some((t) => t.xid === x) ? ' (running)' : '')))));
      head.appendChild(h('div.grow'));
      const act = (icon, label, title, f) => UI.btn(icon, label, title, () => { if (db.down) { UI.toast('The database is down: restart it in the Crash and recovery view first', 'warn'); return; } try { f(); } catch (e) { UI.toast(e.message, 'err'); } app.updateStatus(); draw(); }, 'small');
      head.appendChild(act('download', 'Flush log', 'Write the log buffer to stable storage', () => wal.flush(undefined, 'flushed by hand')));
      head.appendChild(act('flag', 'Checkpoint', 'Write every dirty page, then log a checkpoint record with the running transactions and the dirty page table', () => K.Recovery.checkpoint(db, {})));
      head.appendChild(act('flag', 'Fuzzy', 'A fuzzy checkpoint (ARIES): log the transaction table and the dirty page table without writing any page', () => K.Recovery.checkpoint(db, { fuzzy: true })));

      body.innerHTML = '';
      if (db.down) body.appendChild(h('div.kv-banner.bad', h('div', h('b', 'The database is down. '), 'Memory is gone: the buffer pool, the log buffer and the running transactions. The records below are what reached stable storage. '), h('div', h('button.kv-link', { type: 'button', onclick: () => app.openView('recovery') }, 'Restart it in the Crash and recovery view'))));
      if (S && S.cur) body.appendChild(stepBanner(db, S, ver));
      body.appendChild(summary(db, all, flushed));
      body.appendChild(list(db, all, flushed, ver, S));
      const two = h('div.lg-two', dirtyCard(db, flushed), txCard(db));
      body.appendChild(two);
      body.appendChild(walRuleCard(db, S));
      body.appendChild(policyCard(db));
    }

    function stepBanner(db, S, ver) {
      const e = S.cur, d = e.data || {};
      const box = h('div.kv-banner.lg-step');
      box.appendChild(h('div', h('span.kv-step', 'Step ' + S.pos + ' of ' + S.events.length), UI.describeEvent(e)));
      let t = null;
      if (e.type === 'wal.append') {
        const r = db.wal.byLsn(d.lsn);
        t = 'Record ' + d.lsn + (r ? ' ' + K.Recovery.text(db, r) : '') + ' is appended to the log buffer' + (r && r.prevLsn ? ', pointing back to its transaction\'s previous record ' + r.prevLsn + ' (prevLSN)' : '') + '. It is volatile until the log is flushed.';
      } else if (e.type === 'wal.flush') {
        t = 'The log buffer is written to stable storage up to LSN ' + d.lsn + ': ' + UI.plural(d.records || 0, 'record') + ', ' + fmt(d.bytes || 0) + ' bytes, because ' + d.why + '.' + (d.commits > 1 ? ' One write carries ' + d.commits + ' commit records: a group commit.' : '');
      } else if (e.type === 'buf.flush') {
        const k = S.pos - 1;
        const prev = S.events.slice(Math.max(0, k - 6), k).reverse().find((x) => x.type === 'wal.flush');
        t = 'The dirty page ' + pageName(db, d.file, d.block) + ' (PageLSN ' + d.lsn + ') is written to disk. ' + (prev && /about to be written/.test(prev.data.why) ? 'The write-ahead rule forced the log to LSN ' + prev.data.lsn + ' first, so every change on the page is described on stable storage before the page is.' : 'The log was already flushed past its PageLSN, so no log write was needed first.');
      } else if (e.type === 'wal.violation') t = 'The WAL rule is off: the page ' + d.name + ' reached the disk with PageLSN ' + d.pageLsn + ' while the log was flushed only to ' + d.flushedLsn + '.';
      else t = 'Choose "Step: log records" in the step bar to move from one log record to the next.';
      box.appendChild(h('div.lg-why', t));
      return box;
    }

    function summary(db, all, flushed) {
      const wal = db.wal;
      const end = all.length ? all[all.length - 1].lsn : flushed;
      const buffered = all.filter((r) => r.lsn > flushed);
      const bytes = buffered.reduce((n, r) => n + r.size, 0);
      const cap = K.settingOf ? K.settingOf(db, 'wal_buffers') : db.settings.wal_buffers;
      const ck = wal.lastCheckpoint();
      const st = (v, l, c, title) => h('div.kv-stat' + (c ? '.' + c : ''), { title }, h('div.kv-sv', v), h('div.kv-sl', l));
      const card = h('section.kv-card');
      card.appendChild(h('h3', 'Log tail ', h('span.muted', UI.plural(all.length, 'record') + ' in the log')));
      card.appendChild(h('div.kv-stats',
        st(String(end || 0), 'Last LSN', null, 'The LSN of the newest record'),
        st(String(flushed), 'Flushed LSN', 'ok', 'Records up to here are on stable storage and survive a crash'),
        st(String(buffered.length), 'In the buffer', buffered.length ? 'warn' : null, 'Records in the log buffer, lost if the system crashed now'),
        st(ck ? String(ck.lsn) : 'none', 'Checkpoint', 'acc', 'The last checkpoint record on stable storage: restart starts there'),
        st(String(wal.stats.flushes) + (wal.stats.groups ? ' · ' + wal.stats.groups : ''), wal.stats.groups ? 'Flushes · groups' : 'Log flushes', null, 'Log writes so far' + (wal.stats.groups ? ', and how many carried more than one commit record (group commits)' : ''))));
      const pct = cap ? Math.min(100, (bytes / cap) * 100) : 0;
      card.appendChild(h('div.lg-buf', h('div.lg-bufbar', { title: fmt(bytes) + ' of ' + fmt(cap) + ' bytes' }, h('span', { style: { width: pct + '%' } })), h('div.kv-small.muted', 'Log buffer: ' + UI.plural(buffered.length, 'record') + ', ' + fmt(bytes) + ' of ' + fmt(cap) + ' bytes (wal_buffers). It is flushed when it fills, at a synchronous commit, and before a page with a later PageLSN is written.')));
      return card;
    }

    function list(db, all, flushed, ver, S) {
      const card = h('section.kv-card.lg-card');
      let recs = xf === 'all' ? all : all.filter((r) => (r.top || r.xid) === +xf);
      const hidden = xf === 'all' ? Math.max(0, recs.length - shown) : 0;
      if (hidden) recs = recs.slice(hidden);
      card.appendChild(h('h3', textbook ? 'The log in angle-bracket notation ' : 'Log records ', h('span.muted', (xf === 'all' ? '' : 'T' + xf + ': ') + 'newest at the bottom; the lines on the left follow each transaction\'s prevLSN chain')));
      if (hidden) card.appendChild(h('div.lg-more', UI.btn(null, 'Show ' + Math.min(hidden, 200) + ' earlier records', null, () => { shown += 200; UI.store.set('log.shown', Math.min(shown, 600)); draw(); }, 'small'), h('span.muted.kv-small', fmt(hidden) + ' earlier records not shown')));
      if (!recs.length) { card.appendChild(h('div.empty', db.down ? 'Nothing reached stable storage since the last checkpoint.' : 'The log is empty. Run an INSERT, UPDATE or DELETE to see records appear.')); return card; }
      const cur = S && S.cur ? S.cur : null;
      const just = cur && cur.type === 'wal.append' ? cur.data.lsn : null;
      const flushFrom = cur && cur.type === 'wal.flush' ? cur.data.from : null, flushTo = cur && cur.type === 'wal.flush' ? cur.data.lsn : null;
      const box = h('div.lg-list');
      const rows = [];
      let divided = false;
      for (const r of recs) {
        if (!divided && r.lsn > flushed) {
          divided = true;
          const left = recs.filter((x) => x.lsn > flushed);
          box.appendChild(h('div.lg-div', h('span', '▲ stable storage, flushed to LSN ' + flushed), h('span', '▼ log buffer: ' + UI.plural(left.length, 'record') + ', lost if the system crashes now')));
        }
        const cls = (r.lsn > flushed ? '.vol' : '') + (r.lsn === just ? '.just' : '') + (flushTo !== null && r.lsn > flushFrom && r.lsn <= flushTo ? '.flushed' : '') + (r.type === 'clr' ? '.clr' : '') + (r.type === 'checkpoint' ? '.ck' : '');
        const kind = KIND[r.type] || r.type;
        const links = [
          r.prevLsn ? h('button.kv-link.lg-prev', { type: 'button', title: 'prevLSN: the previous record of ' + tname(r), onclick: () => jump(box, r.prevLsn) }, 'prev ' + r.prevLsn) : r.type === 'begin' ? h('span.lg-prev.muted', 'first of ' + tname(r)) : null,
          r.type === 'clr' ? h('button.kv-link.lg-prev', { type: 'button', title: 'UndoNextLSN: the next record of the transaction to undo', onclick: () => jump(box, r.undoNext) }, 'undo next ' + (r.undoNext || 'none')) : null,
        ];
        const l1 = textbook
          ? h('div.lg-l1', h('code.lg-tb', K.Recovery.text(db, r)), h('span.lg-links', links))
          : h('div.lg-l1', h('span.lg-k.k-' + kind, kind), r.xid ? h('span.lg-x', tname(r)) : null, h('span.lg-d', detail(db, r, ver)), h('span.lg-links', links));
        const l2 = textbook && /^heap\./.test(r.type) ? h('div.lg-l2', h('span.lg-d.muted', detail(db, r, ver)), pageChip(db, r)) : PAGE(r) ? h('div.lg-l2', pageChip(db, r)) : null;
        const row = h('div.lg-row' + cls, { dataset: { lsn: String(r.lsn) } }, h('span.lg-lsn', String(r.lsn)), h('div.lg-main', l1, l2));
        rows.push([r, row]);
        box.appendChild(row);
      }
      if (!divided) box.appendChild(h('div.lg-div.empty', h('span', '▲ all on stable storage (flushed to LSN ' + flushed + ')'), h('span', 'the log buffer is empty')));
      card.appendChild(box);
      // newest at the bottom: keep the list there unless the reader scrolled up
      box.addEventListener('scroll', () => { listTop = box.scrollTop + box.clientHeight >= box.scrollHeight - 8 ? null : box.scrollTop; });
      // the prevLSN chains, drawn once the rows have their places
      requestAnimationFrame(() => { chains(box, rows); box.scrollTop = listTop === null ? box.scrollHeight : listTop; });
      return card;
    }
    function jump(box, lsn) {
      const row = box.querySelector('.lg-row[data-lsn="' + lsn + '"]');
      if (!row) { UI.toast('Record ' + lsn + ' is not shown: show earlier records, or pick the transaction'); return; }
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      row.classList.remove('hl'); void row.offsetWidth; row.classList.add('hl');
    }
    /** one lane per transaction, reused once a transaction's records are over; a bracket from each record to its prevLSN */
    function chains(box, rows) {
      if (!box.isConnected) return;
      const old = box.querySelector('svg.lg-lanes'); if (old) old.remove();
      const by = new Map();
      rows.forEach(([r, el], i) => { if (!r.xid) return; const t = r.top || r.xid; if (!by.has(t)) by.set(t, { first: i, last: i, color: LANES[t % LANES.length] }); by.get(t).last = i; });
      const ends = [];
      for (const v of [...by.values()].sort((a, b) => a.first - b.first)) { let l = ends.findIndex((e) => e < v.first); if (l < 0) { l = ends.length; ends.push(0); } ends[l] = v.last; v.lane = Math.min(l, 5); }
      const W = 10 + 9 * Math.min(6, Math.max(1, ends.length));
      box.style.setProperty('--lanes', W + 'px');
      const H = box.scrollHeight;
      const svg = s('svg', { class: 'lg-lanes', width: W, height: H, 'aria-hidden': 'true' });
      const pos = new Map(rows.map(([r, el]) => [r.lsn, el.offsetTop + el.offsetHeight / 2]));
      for (const [r, el] of rows) {
        if (!r.xid) continue;
        const v = by.get(r.top || r.xid), x = 6 + v.lane * 9, y = pos.get(r.lsn);
        const col = 'var(' + v.color + ')';
        if (r.prevLsn) {
          const py = pos.get(r.prevLsn);
          if (py !== undefined) svg.appendChild(s('path', { d: 'M' + W + ' ' + y + 'H' + x + 'V' + py + 'H' + (W - 3), stroke: col, class: 'lg-chain' }));
          else svg.appendChild(s('path', { d: 'M' + W + ' ' + y + 'H' + x + 'V' + Math.max(0, y - 14), stroke: col, class: 'lg-chain dash' }));
        }
        svg.appendChild(s('circle', { cx: x, cy: y, r: 2.6, fill: col }));
      }
      box.prepend(svg);
    }

    function dirtyCard(db, flushed) {
      const card = h('section.kv-card');
      card.appendChild(h('h3', 'Dirty page table ', h('span.muted', 'pages changed in memory since they were read, with recLSN')));
      const pages = db.down ? [] : db.buffers.dirtyPages();
      if (!pages.length) { card.appendChild(h('p.muted.kv-small', db.down ? 'The buffer pool was lost in the crash.' : 'No page is dirty: the disk holds every change.')); return card; }
      const tb = h('tbody');
      for (const p of pages.sort((a, b) => (a.recLsn || 0) - (b.recLsn || 0))) {
        const d = pageLsns(db, p.file, p.block).disk;
        const need = p.lsn > db.wal.flushedLsn;
        tb.appendChild(h('tr', h('td', pageName(db, p.file, p.block)), h('td.num', p.recLsn === null ? '–' : String(p.recLsn)), h('td.num', String(p.lsn)), h('td.num', d === null ? '–' : String(d)), h('td', { title: need ? 'Writing this page now would first flush the log to ' + p.lsn : 'Its PageLSN is on stable storage: it can be written at once' }, h('span.kv-badge.' + (need ? 'warn' : 'ok'), need ? 'log flush first' : 'can be written'))));
      }
      card.appendChild(h('div.grid-wrap', h('table.grid.small', h('thead', h('tr', h('th', 'Page'), h('th.num', 'recLSN'), h('th.num', 'PageLSN'), h('th.num', 'On disk'), h('th', 'Write now'))), tb)));
      const redo = pages.reduce((m, p) => (p.recLsn !== null && p.recLsn < m ? p.recLsn : m), Infinity);
      if (redo !== Infinity) card.appendChild(h('p.kv-small.muted', 'The smallest recLSN, ' + redo + ', is where ARIES redo would start if the system crashed now (RedoLSN).'));
      return card;
    }
    function txCard(db) {
      const card = h('section.kv-card');
      card.appendChild(h('h3', 'Transaction table ', h('span.muted', 'running transactions and their last record')));
      const txs = db.down ? [] : [...db.xact.active.values()].filter((t) => t.xid);
      if (!txs.length) { card.appendChild(h('p.muted.kv-small', db.down ? 'The running transactions were lost in the crash; restart decides their fate from the log.' : 'No transaction has written anything yet. BEGIN and UPDATE in a tab to see one here.')); return card; }
      const tb = h('tbody');
      for (const t of txs) {
        const last = db.wal.lastByXid.get(t.xid) || 0, r = last ? db.wal.byLsn(last) : null;
        const tab = app.tabs.find((x) => x.session && x.session.tx === t);
        tb.appendChild(h('tr', h('td', 'T' + t.xid), h('td', tab ? tab.name : ''), h('td', h('span.kv-badge.acc', 'running')), h('td.num', last ? h('button.kv-link', { type: 'button', onclick: () => { xf = String(t.xid); draw(); } }, String(last)) : '–'), h('td.num', r && r.type === 'clr' ? String(r.undoNext) : last ? String(last) : '–'), h('td', last > db.wal.flushedLsn ? h('span.kv-badge.warn', 'in buffer') : last ? h('span.kv-badge.ok', 'stable') : '')));
      }
      card.appendChild(h('div.grid-wrap', h('table.grid.small', h('thead', h('tr', h('th', 'Transaction'), h('th', 'Tab'), h('th', 'Status'), h('th.num', 'LastLSN'), h('th.num', 'UndoNextLSN'), h('th', 'Last record'))), tb)));
      return card;
    }
    function walRuleCard(db, S) {
      const card = h('section.kv-card');
      card.appendChild(h('h3', 'The write-ahead rule ', h('span.muted', 'each page written, and the log flush that had to come first')));
      let items = hist.slice(-10).reverse();
      if (S) {
        // the page writes of the recorded run up to this step, with the flush just before each
        items = [];
        let lf = null;
        S.events.slice(0, S.pos).forEach((e) => {
          if (e.type === 'wal.flush') lf = e.data;
          else if (e.type === 'buf.flush') { items.push({ kind: 'write', name: pageName(db, e.data.file, e.data.block), lsn: e.data.lsn, forced: lf && /about to be written/.test(lf.why) ? lf : null }); lf = null; }
          else if (e.type === 'wal.violation') items.push({ kind: 'violation', name: e.data.name, lsn: e.data.pageLsn, flushed: e.data.flushedLsn });
        });
        items = items.slice(-10).reverse();
      }
      if (!items.length) { card.appendChild(h('p.muted.kv-small', 'No page has been written ' + (S ? 'in this run up to this step' : 'since this view opened') + '. A checkpoint, Flush all in the buffer pool view, or an eviction from a small pool writes dirty pages.')); return card; }
      const ul = h('div.lg-wal');
      for (const it of items) {
        if (it.kind === 'violation') { ul.appendChild(h('div.lg-wr.bad', h('span.kv-badge.no', 'violated'), h('span', it.name + ' written with PageLSN ' + it.lsn + ' while the log was flushed only to ' + it.flushed + ' (wal_rule off)'))); continue; }
        ul.appendChild(h('div.lg-wr', it.forced ? h('span.kv-badge.warn', 'flush first') : h('span.kv-badge.ok', 'no flush'), h('span', it.forced ? 'Log flushed to ' + it.forced.lsn + ', then ' + it.name + ' (PageLSN ' + it.lsn + ') written' : it.name + ' (PageLSN ' + it.lsn + ') written: the log was already flushed past it')));
      }
      card.appendChild(ul);
      return card;
    }
    function policyCard(db) {
      const card = h('section.kv-card');
      card.appendChild(h('h3', 'Buffer and logging policies ', h('span.muted', 'for every session on this database')));
      for (const p of POLICY) {
        const on = settingOf(db, p.k);
        card.appendChild(h('div.lg-pol',
          h('div.lg-pl', h('b', p.label)),
          h('div.seg', { role: 'group', 'aria-label': p.label }, [[true, p.on], [false, p.off]].map(([v, l]) => h('button' + (on === v ? '.on' : ''), { type: 'button', onclick: () => { setSetting(app, p.k, v); draw(); } }, l))),
          h('div.lg-pd.kv-small', on ? p.yes : p.no)));
      }
      const wb = K.settingOf ? K.settingOf(db, 'wal_buffers') : db.settings.wal_buffers;
      card.appendChild(h('div.lg-pol', h('div.lg-pl', h('b', 'Log buffer')), h('select.inp', { 'aria-label': 'Log buffer size', onchange: (e) => { setSetting(app, 'wal_buffers', +e.target.value); draw(); } }, [8192, 16384, 65536, 262144].concat(wb).filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b).map((v) => h('option', { value: String(v), selected: v === wb }, fmt(v / 1024) + ' KB'))), h('div.lg-pd.kv-small', 'wal_buffers: a full buffer is flushed even with no commit. A small one writes the log more often, carrying uncommitted records to stable storage.')));
      return card;
    }
    return view;
  }

  UI.registerView({ id: 'log', title: 'Log', icon: 'log', group: 'Transactions', order: 45, events: true, create });
  UI.LogView = { detail, versions, setSetting, pageName, rowVals, POLICY };
})(typeof window !== 'undefined' ? window : globalThis);
