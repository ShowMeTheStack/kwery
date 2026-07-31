// The crash and recovery view: crash the database (between two actions, or in the middle of a page write so the
// page is torn), restart it with the basic redo-then-undo algorithm or with ARIES, and step through the passes: analysis
// rebuilding the transaction table and the dirty page table, redo comparing each record's LSN with the PageLSN,
// undo following UndoNextLSN and writing compensation records. The rows touched before the crash are shown as the
// transactions saw them and as restart left them. Scenarios set up the classic situations in two tabs and ask for
// a prediction first. Smaller panels: an archival dump with log replay after the disk is lost, a remote backup fed
// by the log with a lag and a takeover, and shadow paging.
(function (root) {
  'use strict';
  const K = root.K;
  const UI = K.UI;
  const { h, s } = UI;

  const safe = (f, d) => { try { return f(); } catch (e) { return d; } };
  const PASS = { check: 'Page check', analysis: 'Analysis', redo: 'Redo', undo: 'Undo', finish: 'Finish' };
  const BADGE = { redo: 'acc', undo: 'no', skip: 'mute', follow: 'warn', end: 'ok', abort: 'no', list: 'acc', update: 'acc', start: 'warn', torn: 'no', reset: 'warn', clog: 'acc', checkpoint: 'ok', none: 'mute', memtable: 'mute', 'wal-violation': 'no', ok: 'ok' };
  const ALG = {
    textbook: { name: 'Redo then undo (basic)', long: 'the basic redo-then-undo algorithm', about: 'Redo phase: scan forward from the last checkpoint, repeat every logged change and keep an undo-list (the checkpoint\'s list L, plus each <Ti start>, minus each <Ti commit> or <Ti abort>). Undo phase: scan backward, undo the records of the transactions on the undo-list (writing redo-only records), and write <Ti abort> on reaching <Ti start>.' },
    aries: { name: 'ARIES', long: 'ARIES', about: 'Analysis: from the checkpoint, rebuild the transaction table and the dirty page table, and find RedoLSN (the smallest recLSN). Redo: repeat history from RedoLSN, skipping a record when its page is not dirty, its LSN is below the page\'s recLSN, or the PageLSN shows the change is there. Undo: roll back the losers newest first, writing a CLR for each undone change and following UndoNextLSN.' },
  };
  const BASE = "drop table if exists account;\ncreate table account (name text primary key, balance int);\ninsert into account values ('A', 4200), ('B', 3100), ('C', 860);\ncheckpoint;";
  const upd = (who, v) => "update account set balance = " + v + " where name = '" + who + "';";
  const SCENARIOS = [
    { id: 'ck', title: 'A checkpoint between', about: 'T1 moves 300 from A to B and commits. T2 sets C to 500, and a checkpoint is taken while T2 runs: a sharp checkpoint writes every dirty page, T2\'s uncommitted change included (steal). T2 then sets A to 3500, and the system crashes.',
      steps: [[0, 'begin;\n' + upd('A', 'balance - 300') + '\n' + upd('B', 'balance + 300') + '\ncommit;'], [1, 'begin;\n' + upd('C', 500)], [0, 'checkpoint;'], [1, upd('A', 3500)]],
      predict: [['A', '3900', 'T1 (Session A): A = 3900, committed before the checkpoint'], ['B', '3400', 'T1 (Session A): B = 3400'], ['C', '500', 'T2 (Session B): C = 500, on disk since the checkpoint'], ['A', '3500', 'T2 (Session B): A = 3500, after the checkpoint']] },
    { id: 'group', title: 'Another commit flushes the log', about: 'T1 sets A to 3900 and keeps running. T2 sets C to 500 and commits: its commit flushes the whole log buffer, T1\'s record with it. The system crashes. T1\'s change is in the stable log, but T1 never committed.',
      steps: [[0, 'begin;\n' + upd('A', 3900)], [1, upd('C', 500)]],
      predict: [['A', '3900', 'T1 (Session A): A = 3900, its record on stable storage'], ['C', '500', 'T2 (Session B): C = 500, committed']] },
    { id: 'async', title: 'Commit without waiting for the log', about: 'Session A turns synchronous_commit off and sets A to 3900. COMMIT returns before the commit record is flushed, and the system crashes before anything else flushes the log.',
      steps: [[0, 'set synchronous_commit = off;\n' + upd('A', 3900)]],
      predict: [['A', '3900', 'Session A: A = 3900, reported as committed']] },
    { id: 'torn', title: 'Torn page', about: 'T1 sets A to 3900 and commits: its log records are flushed, the page is changed only in memory. The system crashes while the buffer manager is writing that page, so the disk copy is half new and half old. Restart finds the checksum wrong.',
      steps: [[0, upd('A', 3900)]], crash: 'during-write',
      predict: [['A', '3900', 'T1: A = 3900, committed'], ['B', '3100', 'B = 3100, on the same page, untouched since the checkpoint']] },
    { id: 'tornfpw', title: 'Torn page, no full-page writes', about: 'As before, but Session A turns full_page_writes off first, so the change is logged without an image of the whole page. The crash tears the page during its write.',
      steps: [[0, 'set full_page_writes = off;\n' + upd('A', 3900)]], crash: 'during-write',
      predict: [['A', '3900', 'T1: A = 3900, committed'], ['B', '3100', 'B = 3100, on the same page, untouched since the checkpoint']] },
  ];

  // ---- reading the tables --------------------------------------------------------------------------------------------
  const qname = (rel) => '"' + rel.schema + '"."' + rel.name + '"';
  /** run a query in a throw-away session (so no tab's transaction is disturbed) */
  function scratch(db, f) {
    const x = db.session({ name: 'recovery view' });
    try { return f(x); } finally { db.closeSession(x); }
  }
  const asRows = (r) => (r && r.rows ? r.rows.map((row) => row.map((v, i) => (v === null || v === undefined ? 'NULL' : UI.valueText(v, r.cols[i].type)))) : null);
  const keyed = (rows) => { const m = new Map(); if (rows) for (const r of rows) { let k = r[0], n = 1; while (m.has(k)) k = r[0] + ' #' + ++n; m.set(k, r); } return m; };
  /** the tables the log has changed lately (since the last checkpoint, or the last 200 records) */
  function touched(db) {
    const recs = db.wal.records, ck = db.wal.lastCheckpoint();
    const from = ck ? recs.indexOf(ck) : 0;
    const start = from > 0 && recs.length - from > 3 ? from : Math.max(0, recs.length - 200);
    const oids = [];
    for (let i = recs.length - 1; i >= start; i--) { const r = recs[i]; if (/^heap\./.test(r.type) && r.rel && !oids.includes(r.rel)) oids.push(r.rel); }
    return oids.map((o) => db.catalog.rel(o)).filter((r) => r && r.kind === 'table' && !safe(() => db.catalog.schema(r.schema).system, false)).slice(0, 3);
  }
  /** each table as committed, and as each tab's open transaction sees it */
  function capture(app, rels) {
    const db = app.db, out = [];
    for (const rel of rels) {
      const sql = 'select * from ' + qname(rel) + ' limit 500';
      const res = scratch(db, (x) => safe(() => x.query(sql), null));
      if (!res) continue;
      const t = { oid: rel.oid, name: rel.name, sql, cols: res.cols.map((c) => c.name), committed: keyed(asRows(res)), seen: new Map() };
      for (const tab of app.tabs) {
        const ss = tab.session;
        if (!ss || !ss.tx || ss.tx.failed || ss.waiting || !ss.tx.xid || (tab.runner && !tab.runner.done)) continue;
        const mine = keyed(asRows(safe(() => ss.query(sql), null)));
        for (const [k, row] of mine) { const c = t.committed.get(k); if (!c || c.join('\u0001') !== row.join('\u0001')) t.seen.set(k, { row, by: tab.name, xid: ss.tx.xid }); }
        for (const k of t.committed.keys()) if (!mine.has(k) && mine.size) t.seen.set(k, { row: null, by: tab.name, xid: ss.tx.xid });
      }
      out.push(t);
    }
    return out;
  }
  function captureAfter(db, before) {
    const m = new Map();
    for (const t of before || []) m.set(t.oid, scratch(db, (x) => { const r = safe(() => x.query(t.sql), null); return r ? keyed(asRows(r)) : null; }));
    return m;
  }
  function counts(db) {
    const rels = db.catalog.tables(['table']).filter((r) => !safe(() => db.catalog.schema(r.schema).system, false)).slice(0, 10);
    return scratch(db, (x) => rels.map((r) => ({ name: r.name, n: safe(() => Number(x.query('select count(*) from ' + qname(r)).rows[0][0]), null) })));
  }

  /**
   * Restart rebuilds the commit log from the stable log, plus the fates kept for records truncated away
   * (wal.archived). A database loaded from a snapshot (the sample databases) has a commit log but no log records
   * for the transactions that loaded it, so restart would take them all for aborted and hide every sample row. Until
   * Snapshot.load records those fates itself, they are put in wal.archived here from the commit log; transactions
   * the log does mention are left to the log.
   */
  function keepHistory(db) {
    if (db.wal.archived || !db.xact.clog.size) return;
    const ST = K.XSTATUS, inLog = new Set();
    for (const r of db.wal.records) if (r.xid) { inLog.add(r.xid); if (r.top) inLog.add(r.top); }
    const topOf = (x) => { let y = x, n = 0; while (db.xact.parent.has(y) && n++ < 1000) y = db.xact.parent.get(y); return y; };
    const a = { tops: new Map(), subs: new Map(), subAborted: new Set(), parent: new Map(), commits: [], maxXid: 0 };
    for (const [x, st] of db.xact.clog) {
      const top = topOf(x);
      if (inLog.has(x) || inLog.has(top)) continue;
      a.maxXid = Math.max(a.maxXid, x);
      if (top !== x) { a.subs.set(x, top); a.parent.set(x, db.xact.parent.get(x)); if (st === ST.ABORTED) a.subAborted.add(x); continue; }
      a.tops.set(x, st === ST.COMMITTED ? 'commit' : 'abort');
    }
    a.commits = [...a.tops].filter(([, f]) => f === 'commit').map(([x]) => x).sort((p, q) => (db.xact.commitOrder.get(p) || 0) - (db.xact.commitOrder.get(q) || 0));
    if (a.tops.size || a.subs.size) db.wal.archived = a;
  }

  function create(app, el) {
    let tab = UI.store.get('recovery.tab', 'crash');
    let alg = UI.store.get('recovery.alg', 'aries');
    let dbRef = app.db, crashInfo = null, before = null, after = null, res = null, step = 0, src = null;
    let scen = null, scId = UI.store.get('recovery.scenario', 'ck');
    let dump = null, rb = null, rbOff = null, rbLag = 1, rbOut = null;
    let sp = null, spPos = null;
    const intro = h('div.kv-intro', h('b', 'Crash and recovery. '), 'A crash loses main memory: the buffer pool, the log buffer and the running transactions; the disk and the stable log survive. Restart must redo the changes of committed transactions that never reached the disk and undo the changes of the others that did, so the database again holds exactly the committed work (atomicity and durability).');
    const head = h('div.view-head.rc-head');
    const body = h('div.view-body.rc-body');
    el.appendChild(intro); el.appendChild(head); el.appendChild(body);
    const redraw = UI.raf(() => { if (!el.hidden && el.isConnected && app.dock.active === 'recovery') draw(); });

    function reset() { crashInfo = null; before = null; after = null; res = null; step = 0; src = null; scen = null; dump = null; stopBackup(); rbOut = null; }
    const view = {
      onDb() { if (app.db !== dbRef) { dbRef = app.db; reset(); } },
      render() { draw(); },
      destroy() { stopBackup(); },
    };
    /** the sessions lost their transactions: tell the rest of the workbench */
    function notify() { app.drawTabs(); app.updateStatus(); if (app.renderPanel) app.renderPanel(); app.dock.onDb(); }

    // ---- actions -------------------------------------------------------------------------------------------------
    function crash(at, page) {
      const db = app.db;
      if (db.down) return;
      before = capture(app, touched(db));
      const running = app.tabs.filter((t) => t.session && t.session.tx && t.session.tx.xid).map((t) => t.name + ' (T' + t.session.tx.xid + ')');
      crashInfo = Object.assign(K.Recovery.crash(db, { at, page }), { tabs: running });
      after = null; res = null; step = 0;
      notify();
      if (running.length) UI.toast('The database crashed: the open transactions in ' + running.join(', ') + ' are gone', 'err', 4000);
    }
    function restart(how) {
      const db = app.db;
      keepHistory(db);
      try {
        res = how ? how() : K.Recovery.restart(db, { algorithm: alg });
      } catch (e) { UI.toast('Restart failed: ' + e.message, 'err', 6000); console.error(e); return; }
      src = how ? 'dump' : 'crash';
      step = 0;
      after = db.down ? null : captureAfter(db, before);
      if (scen && !db.down) scen.after = scratch(db, (x) => keyed(asRows(safe(() => x.query('select name, balance from account'), null))));
      notify();
      if (res.crashed) UI.toast('The system crashed again during recovery', 'err');
    }
    function setupScenario(sc) {
      let db = app.db;
      if (db.down) { keepHistory(db); K.Recovery.restart(db, { algorithm: 'aries' }); }
      reset();
      const dflt = Object.assign({}, K.RECOVERY_DEFAULTS || {}, { synchronous_commit: true });
      for (const k of ['buffer_steal', 'buffer_force', 'wal_rule', 'full_page_writes', 'page_checksums', 'synchronous_commit']) UI.LogView.setSetting(app, k, dflt[k]);
      const tabs = ['Session A', 'Session B'].map((n) => app.tabs.find((t) => t.name === n) || app.addTab(n, '', true));
      for (const t of tabs) {
        if (t.runner && !t.runner.done) { UI.toast(t.name + ' is waiting for a lock: finish it first', 'warn'); return; }
        if (t.session.tx) app.runSql(t, 'rollback;', 0);
      }
      app.selectTab(tabs[0].id);
      const texts = ['-- ' + sc.title + ': Session A\n' + BASE + '\n', '-- ' + sc.title + ': Session B\n'];
      const runs = [[0, BASE]].concat(sc.steps);
      for (const [i, sql] of runs) {
        if (sql !== BASE) texts[i] += '\n' + sql + '\n';
        app.runSql(tabs[i], sql, 0);
        const err = tabs[i].run && tabs[i].run.results.find((r) => r.error);
        if (err) { UI.toast('The scenario stopped: ' + err.error.message, 'err', 6000); break; }
        if (tabs[i].runner && !tabs[i].runner.done) { UI.toast('The scenario stopped: ' + tabs[i].name + ' waits for a lock another tab holds. Commit or roll back the other tabs first.', 'err', 7000); break; }
      }
      tabs.forEach((t, i) => { t.text = texts[i]; });
      app.editor.setValue(tabs[0].text);
      app.saveTabs();
      app.drawTabs();
      scen = { def: sc, preds: new Map(), after: null };
      notify();
    }
    const rel = (name) => safe(() => app.session.catalog.tables().find((r) => r.name === name), null);
    function scenarioCrash() {
      const sc = scen.def;
      if (sc.crash === 'during-write') { const r = rel('account'); crash('during-write', r ? { file: r.file, block: 0 } : null); }
      else crash('now');
    }
    function stopBackup() { if (rbOff) rbOff(); rbOff = null; if (rb && rb.off) safe(() => rb.off()); rb = null; }

    // ---- drawing -------------------------------------------------------------------------------------------------
    function draw() {
      head.innerHTML = '';
      const tabs = [['crash', 'Crash and restart'], ['dump', 'Disk loss'], ['backup', 'Remote backup'], ['shadow', 'Shadow paging']];
      head.appendChild(h('div.seg.rc-tabs', { role: 'tablist' }, tabs.map(([k, l]) => h('button' + (tab === k ? '.on' : ''), { type: 'button', role: 'tab', 'aria-selected': String(tab === k), onclick: () => { tab = k; UI.store.set('recovery.tab', k); draw(); } }, l))));
      body.innerHTML = '';
      if (tab === 'crash') { body.appendChild(scenarioCard()); body.appendChild(crashCard()); if (res && src === 'crash') { body.appendChild(traceCard()); } if (before && before.length) body.appendChild(rowsCard()); }
      else if (tab === 'dump') { body.appendChild(dumpCard()); if (res && src === 'dump') body.appendChild(traceCard()); }
      else if (tab === 'backup') { body.appendChild(backupCard()); if (rbOut) body.appendChild(traceCard(rbOut.result, 'Takeover at the backup')); }
      else body.appendChild(shadowCard());
    }

    function scenarioCard() {
      const card = h('section.kv-card.rc-scen');
      card.appendChild(h('h3', 'Scenarios ', h('span.muted', 'classic situations, set up in two tabs (Session A and Session B) on a table account')));
      card.appendChild(h('div.rc-chips', SCENARIOS.map((sc) => h('button.rc-chip' + (scId === sc.id ? '.on' : ''), { type: 'button', onclick: () => { scId = sc.id; UI.store.set('recovery.scenario', sc.id); draw(); } }, sc.title))));
      const sc = SCENARIOS.find((x) => x.id === scId) || SCENARIOS[0];
      card.appendChild(h('p.kv-small', sc.about));
      const steps = h('ol.rc-steps');
      steps.appendChild(h('li', h('span.rc-who', 'Session A'), h('code', 'account: A = 4200, B = 3100, C = 860; checkpoint')));
      for (const [i, sql] of sc.steps) steps.appendChild(h('li', h('span.rc-who', i ? 'Session B' : 'Session A'), h('code', sql.replace(/\n/g, ' '))));
      steps.appendChild(h('li', h('span.rc-who.bad', 'Crash'), h('span', sc.crash === 'during-write' ? 'during the write of the page holding A (torn page)' : 'now, between two actions')));
      card.appendChild(steps);
      const active = scen && scen.def.id === sc.id;
      card.appendChild(h('div.kv-row', UI.btn('run', active ? 'Set up again' : 'Set up', 'Run the statements above in two tabs, up to just before the crash', () => setupScenario(sc), active ? '' : 'primary'), active && !app.db.down ? UI.btn('crash', 'Crash as described', null, scenarioCrash, 'danger') : null));
      if (active) {
        const done = scen.after && res;
        card.appendChild(h('h4', done ? 'Your predictions' : 'Predict: which updates survive the restart?'));
        const list = h('div.rc-preds');
        for (const [i, [key, val, text]] of sc.predict.entries()) {
          const p = scen.preds.get(i);
          const actual = done ? (scen.after.get(key) || [])[1] === val : null;
          const row = h('div.rc-pred' + (done && p !== undefined ? (p === actual ? '.right' : '.wrong') : ''), h('span.rc-pt', text),
            h('div.seg', [[true, 'Survives'], [false, 'Lost']].map(([v, l]) => h('button' + (p === v ? '.on' : ''), { type: 'button', disabled: !!done, onclick: () => { scen.preds.set(i, v); draw(); } }, l))),
            done ? h('span.kv-badge.' + (actual ? 'ok' : 'no'), actual ? 'survived' : 'lost: ' + key + ' = ' + ((scen.after.get(key) || [])[1] || 'gone')) : null);
          list.appendChild(row);
        }
        card.appendChild(list);
        if (done) {
          const right = [...scen.preds.entries()].filter(([i, v]) => v === ((scen.after.get(sc.predict[i][0]) || [])[1] === sc.predict[i][1])).length;
          card.appendChild(h('p.kv-small', h('b', right + ' of ' + sc.predict.length + ' right. '), explain(sc.id)));
        } else card.appendChild(h('p.kv-small.muted', app.db.down ? 'The system has crashed. Choose an algorithm below and restart.' : 'Look at the Log view first if you like: which records reached stable storage? Then crash.'));
      }
      return card;
    }
    function explain(id) {
      return {
        ck: 'T1 committed: redo puts back any of its changes that were not on disk. T2 never committed: undo removes C = 500 from the page the checkpoint wrote, and A = 3500 never reached stable storage at all (its records were still in the log buffer).',
        group: 'Redo repeats history, T1\'s update included, and undo then rolls it back: having a record on stable storage does not make a transaction committed, only its commit record does.',
        async: 'The commit record was still in the log buffer when the system crashed, so to restart T1 never committed. synchronous_commit off trades the durability of the last transactions for faster commits.',
        torn: 'The torn page fails its checksum. Its first change since the last write was logged with a full-page image, so redo starts the page from that image and replays the later records: every row comes back.',
        tornfpw: 'With no full-page image there is nothing to start the torn page from: redo can only replay the records since the checkpoint on an empty page. A survives (its record carries the whole new tuple); B and C, written before the checkpoint, are lost.',
      }[id];
    }

    function crashCard() {
      const db = app.db;
      const card = h('section.kv-card.rc-crash' + (db.down ? '.down' : ''));
      if (!db.down) {
        const running = app.tabs.filter((t) => t.session && t.session.tx && t.session.tx.xid);
        const buffered = db.wal.pending();
        card.appendChild(h('h3', h('span.rc-dot.up'), 'The database is running'));
        card.appendChild(h('p.kv-small', 'A crash now would lose ' + UI.plural(buffered.length, 'log record') + ' in the log buffer, ' + UI.plural(db.buffers.dirtyPages().length, 'dirty page') + ' in the buffer pool, and ' + (running.length ? 'the open transactions of ' + running.map((t) => t.name + ' (T' + t.session.tx.xid + ')').join(', ') : 'no open transaction') + '.'));
        card.appendChild(h('div.rc-crashbtns',
          h('button.rc-big', { type: 'button', onclick: () => crash('now') }, UI.icon('crash'), h('span', h('b', 'Crash now'), h('small', 'power fails between two actions'))),
          h('button.rc-big.alt', { type: 'button', onclick: () => crash('during-write'), title: db.buffers.dirtyPages().length ? '' : 'No page is dirty: there is nothing being written' }, UI.icon('bolt'), h('span', h('b', 'Crash during a page write'), h('small', 'a dirty page is half written: a torn page')))));
        if (res && src === 'crash') card.appendChild(h('p.kv-small.muted', 'Restarted by ' + ALG[res.algorithm].long + '. The passes are below.'));
        return card;
      }
      const d = db.down || {};
      const ci = crashInfo || d;
      card.appendChild(h('h3', h('span.rc-dot.down'), 'The database is down ', h('span.muted', ci.at === 'during-write' ? 'crashed during a page write' : ci.at === 'disk' ? 'the disk failed' : 'crashed')));
      const facts = h('ul.rc-facts');
      if (ci.lostRecords !== undefined) facts.appendChild(h('li', UI.plural(ci.lostRecords, 'log record') + ' (' + (ci.lostBytes || 0).toLocaleString('en-US') + ' bytes) in the log buffer were lost; the stable log ends at LSN ' + ci.flushedLsn + '.'));
      if (ci.dirtyPages !== undefined) facts.appendChild(h('li', UI.plural(ci.dirtyPages, 'dirty page') + ' in the buffer pool never reached the disk.'));
      if (ci.running && ci.running.length) facts.appendChild(h('li', 'Running at the crash: ' + ci.running.map((x) => 'T' + x).join(', ') + (ci.tabs && ci.tabs.length ? ' (' + ci.tabs.join(', ') + ')' : '') + '. Their sessions are now outside any transaction.'));
      if (ci.torn) facts.appendChild(h('li.bad', 'The page ' + ci.torn.name.replace(/^public\./, '') + '[' + ci.torn.block + '] was being written: it is torn, half new and half old.'));
      else if (ci.at === 'during-write') facts.appendChild(h('li', 'No page was dirty, so no write was under way: an ordinary crash.'));
      card.appendChild(facts);
      card.appendChild(h('div.rc-restart',
        h('div.seg', { role: 'group', 'aria-label': 'Recovery algorithm' }, Object.entries(ALG).map(([k, a]) => h('button' + (alg === k ? '.on' : ''), { type: 'button', onclick: () => { alg = k; UI.store.set('recovery.alg', k); draw(); } }, a.name))),
        UI.btn('refresh', 'Restart', 'Run recovery and bring the database up', () => restart(), 'primary')));
      card.appendChild(h('p.kv-small.muted', ALG[alg].about));
      card.appendChild(h('p.kv-small.rc-warn', 'Restart before running statements in the tabs: until then the database is down.'));
      return card;
    }

    // ---- the passes, step by step ----------------------------------------------------------------------------------
    function traceCard(r, label) {
      r = r || res;
      const steps = r.steps;
      step = Math.max(0, Math.min(step, steps.length - 1));
      const o = steps[step] || {};
      const card = h('section.kv-card.rc-trace');
      const clrs = (r.written || []).filter((w) => /CLR|redo-only/.test(w.text)).length;
      card.appendChild(h('h3', (label || 'Restart') + ' by ' + ALG[r.algorithm].long + ' ', h('span.muted', UI.plural(steps.length, 'step'))));
      const chips = h('div.rc-facts2');
      const chip = (l, v, c) => h('span.rc-fact', h('span.muted', l), h('b' + (c ? '.' + c : ''), v));
      chips.appendChild(chip('Checkpoint', r.checkpoint ? String(r.checkpoint) : 'none'));
      if (r.redoLsn !== undefined) chips.appendChild(chip(r.algorithm === 'aries' ? 'RedoLSN' : 'Redo from', String(r.redoLsn || 'none')));
      chips.appendChild(chip(r.algorithm === 'aries' ? 'Losers' : 'Undo-list', r.losers.length ? r.losers.map((x) => 'T' + x).join(', ') : 'none', r.losers.length ? 'bad' : ''));
      chips.appendChild(chip('Written', UI.plural(clrs, r.algorithm === 'aries' ? 'CLR' : 'redo-only record')));
      if (r.torn && r.torn.length) chips.appendChild(chip('Torn', r.torn.map((t) => t.name.replace(/^public\./, '') + '[' + t.block + ']').join(', '), 'bad'));
      card.appendChild(chips);
      if (r.problems.length) card.appendChild(h('div.kv-banner.bad', r.problems.map((p) => h('div', p))));
      if (r.crashed) card.appendChild(h('div.kv-banner.bad', 'The system crashed again during recovery. Restart once more: the compensation records already written are redone, never undone twice.'));
      // the passes, each a button to its first step
      const passes = Object.keys(r.passes);
      card.appendChild(h('div.rc-passes', passes.map((p) => {
        const ps = r.passes[p].steps, first = steps.indexOf(ps[0]);
        const cur = o.pass === p, done = first >= 0 && first < step && !cur;
        return h('button.rc-pass' + (cur ? '.on' : done ? '.done' : ''), { type: 'button', disabled: first < 0, onclick: () => { step = first; draw(); } }, h('b', PASS[p] || p), h('span', UI.plural(ps.length, 'step')));
      })));
      // the stepper
      const go = (n) => { step = Math.max(0, Math.min(steps.length - 1, n)); draw(); };
      card.appendChild(h('div.rc-stepper',
        UI.btn('first', null, 'First step', () => go(0), 'icon'), UI.btn('stepBack', null, 'Previous step', () => go(step - 1), 'icon'), UI.btn('step', null, 'Next step', () => go(step + 1), 'icon'), UI.btn('last', null, 'Last step', () => go(steps.length - 1), 'icon'),
        h('input.tl-range', { type: 'range', min: '0', max: String(steps.length - 1), value: String(step), 'aria-label': 'Recovery step', oninput: (e) => go(+e.target.value) }),
        h('span.tl-pos', (step + 1) + ' / ' + steps.length)));
      card.appendChild(stepBox(r, o));
      card.appendChild(context(r, o));
      card.appendChild(stepList(r, o));
      return card;
    }
    function stepBox(r, o) {
      const box = h('div.rc-step');
      box.appendChild(h('div.rc-sh', h('span.rc-pn', PASS[o.pass] || o.pass), h('span.kv-badge.' + (BADGE[o.action] || 'mute'), o.action || ''), o.lsn ? h('span.rc-lsn', 'LSN ' + o.lsn) : null, o.xid ? h('span.rc-lsn', 'T' + o.xid) : null));
      if (o.record) box.appendChild(h('code.rc-rec', o.record));
      if (o.cmp) {
        const m = /PageLSN (\d+) (<|≥) LSN (\d+)/.exec(o.cmp);
        if (m) box.appendChild(h('div.rc-cmp', h('span.rc-cv', h('small', 'PageLSN'), h('b', m[1])), h('span.rc-op', m[2]), h('span.rc-cv', h('small', 'record LSN'), h('b', m[3])), h('span.rc-arrow', '→'), h('span.kv-badge.' + (o.action === 'redo' ? 'acc' : 'mute'), o.action === 'redo' ? (m[2] === '<' ? 'not on the page: redo' : 'redo anyway') : 'already there: skip'), /regardless/.test(o.cmp) ? h('span.kv-small.muted', 'the basic algorithm redoes every record; redo is idempotent') : null));
        else box.appendChild(h('div.rc-cmpt', o.cmp));
      }
      if (o.why) box.appendChild(h('div.rc-why', o.why));
      if (o.what && o.what !== o.why) box.appendChild(h('div.rc-what', 'On the page: ' + o.what + (o.pageLsnAfter ? '; PageLSN is now ' + o.pageLsnAfter : '')));
      if (o.clr) box.appendChild(h('div.rc-what', (r.algorithm === 'aries' ? 'CLR' : 'Redo-only record') + ' written at LSN ' + o.clr + (o.lsn ? ', compensating ' + o.lsn : '')));
      if (o.lsn2) box.appendChild(h('div.rc-what', '<T' + o.xid + ' abort> written at LSN ' + o.lsn2));
      return box;
    }
    /** the newest value of a field at or before step i of the same pass */
    function lastWith(r, i, field) { for (let k = i; k >= 0; k--) { const x = r.steps[k]; if (x[field] !== undefined) return x[field]; if (x.pass !== r.steps[i].pass) break; } return undefined; }
    const ttTable = (tt, hl) => h('table.grid.small', h('thead', h('tr', h('th', 'Transaction'), h('th', 'Status'), h('th.num', 'LastLSN'), h('th.num', 'UndoNext'))), h('tbody', tt.length ? tt.map((e) => h('tr' + (hl === e.xid ? '.hl' : ''), h('td', 'T' + e.xid), h('td', h('span.kv-badge.' + (e.status === 'C' ? 'ok' : e.status === 'A' ? 'no' : 'acc'), { title: e.status === 'C' ? 'committed' : e.status === 'A' ? 'was rolling back' : 'undo candidate: no commit record yet' }, e.status || 'U')), h('td.num', String(e.lastLsn || '–')), h('td.num', String(e.undoNext || '–')))) : h('tr', h('td.muted', { colspan: '4' }, 'empty'))));
    const dptTable = (dpt, hl) => h('table.grid.small', h('thead', h('tr', h('th', 'Page'), h('th.num', 'recLSN'))), h('tbody', dpt.length ? dpt.map((d) => h('tr' + (hl && hl.file === d.file && hl.block === d.block ? '.hl' : ''), h('td', d.name.replace(/^public\./, '') + '[' + d.block + ']'), h('td.num', String(d.recLsn)))) : h('tr', h('td.muted', { colspan: '2' }, 'empty'))));
    const xlist = (l) => (l && l.length ? l.map((x) => 'T' + x).join(', ') : 'empty');
    function context(r, o) {
      const box = h('div.rc-ctx');
      const i = step;
      const pane = (title, ...kids) => h('div.rc-pane', h('h4', title), ...kids);
      if (o.pass === 'analysis') {
        const tt = lastWith(r, i, 'tt') || r.passes.analysis.before.tt, dpt = lastWith(r, i, 'dpt') || r.passes.analysis.before.dpt;
        box.appendChild(pane('Transaction table', ttTable(tt, null)));
        box.appendChild(pane('Dirty page table', dptTable(dpt, o.file !== undefined ? o : null)));
        if (o.action === 'clog') box.appendChild(pane('Commit log rebuilt', h('p.kv-small', 'Committed: ' + xlist(o.committed)), h('p.kv-small', 'Aborted (losers and earlier aborts): ' + xlist(o.aborted))));
        else if (r.passes.analysis.redoLsn !== undefined) box.appendChild(pane('At the end of analysis', h('p.kv-small', 'RedoLSN = smallest recLSN = ' + (r.passes.analysis.redoLsn || 'none (no dirty page)')), h('p.kv-small', 'Winners: ' + xlist(r.passes.analysis.winners) + ' · losers: ' + xlist(r.passes.analysis.losers))));
      } else if (o.pass === 'redo' && r.algorithm === 'aries') {
        box.appendChild(pane('Dirty page table after analysis', dptTable(r.passes.analysis.after.dpt, o.file !== undefined ? o : null), h('p.kv-small.muted', 'Redo starts at RedoLSN ' + (r.redoLsn || 'none') + ' and repeats history: the losers\' changes are redone too, then undone.')));
      } else if (r.algorithm === 'textbook' && (o.pass === 'redo' || o.pass === 'undo')) {
        const ul = lastWith(r, i, 'undoList') || (o.pass === 'undo' ? r.passes.undo.undoList : []);
        box.appendChild(pane('Undo-list', h('div.rc-ul', ul && ul.length ? ul.map((x) => h('span.rc-tx' + (o.xid === x ? '.on' : ''), 'T' + x)) : h('span.muted.kv-small', 'empty')), h('p.kv-small.muted', o.pass === 'redo' ? 'Redo phase: <Ti start> adds Ti, <Ti commit> and <Ti abort> remove it.' : 'Undo phase: scanning backward, each record of a transaction on the list is undone; <Ti start> ends Ti\'s undo.')));
      } else if (o.pass === 'undo') {
        const tu = o.toUndo || (r.passes.undo.losers || []);
        box.appendChild(pane('ToUndo', h('div.rc-ul', tu.length ? tu.map((e) => h('span.rc-tx' + (o.xid === e.xid ? '.on' : ''), 'T' + e.xid + ' → ' + (e.undoNext || 'done'))) : h('span.muted.kv-small', 'empty')), h('p.kv-small.muted', 'Each step undoes the largest UndoNextLSN among the losers; a CLR sends undo to its UndoNextLSN, skipping what was already undone.')));
      } else if (o.pass === 'check') {
        box.appendChild(pane('Before anything else', h('p.kv-small', 'Every page on disk is checked: a checksum that does not match marks a torn page; a PageLSN past the end of the stable log marks a page written ahead of its log records.')));
      } else return h('div');
      return box;
    }
    function stepList(r, o) {
      const ps = r.passes[o.pass] ? r.passes[o.pass].steps : [];
      const box = h('div.rc-list');
      for (const x of ps) {
        const k = r.steps.indexOf(x);
        box.appendChild(h('button.rc-li' + (k === step ? '.on' : k < step ? '.past' : ''), { type: 'button', onclick: () => { step = k; draw(); } }, h('span.rc-n', String(x.n)), h('span.kv-badge.' + (BADGE[x.action] || 'mute'), x.action), h('span.rc-lt', { title: [x.record, x.why].filter(Boolean).join('\n') }, x.record || x.why)));
      }
      requestAnimationFrame(() => { const on = box.querySelector('.on'); if (on) box.scrollTop = Math.max(0, on.offsetTop - box.clientHeight / 2); });
      return h('div', h('h4.rc-h4', 'The steps of ' + (PASS[o.pass] || o.pass).toLowerCase()), box);
    }

    // ---- rows before and after -------------------------------------------------------------------------------------
    function rowsCard() {
      const card = h('section.kv-card');
      card.appendChild(h('h3', 'The rows ', h('span.muted', after ? 'before the crash, as the transactions saw them, and after restart' : 'before the crash; restart to compare')));
      for (const t of before) {
        const aft = after ? after.get(t.oid) : null;
        const keys = [...new Set([...t.committed.keys(), ...t.seen.keys(), ...(aft ? aft.keys() : [])])];
        const show = keys.length <= 14 ? keys : keys.filter((k) => t.seen.has(k) || !aft || (t.committed.get(k) || []).join() !== (aft.get(k) || []).join());
        const tb = h('tbody');
        const txt = (row) => (row ? row.slice(1).join(', ') : '—');
        for (const k of show.slice(0, 40)) {
          const c = t.committed.get(k), u = t.seen.get(k), a = aft ? aft.get(k) : undefined;
          let verdict = null;
          if (after) {
            const same = (x, y) => (x || []).join('\u0001') === (y || []).join('\u0001');
            if (!aft) verdict = h('span.kv-badge.no', { title: 'The table is gone after restart: it was created by a transaction that did not commit' }, 'gone');
            else if (u && same(a, c)) verdict = h('span.kv-badge.ok', { title: 'The uncommitted change was undone: the committed value is back' }, 'undone');
            else if (!same(a, c)) verdict = h('span.kv-badge.no', { title: c ? 'A committed value did not survive the restart' : 'A row nobody had committed is there after restart' }, c ? 'lost' : 'appeared');
            else verdict = h('span.kv-badge.mute', { title: 'The committed value survived' }, 'kept');
          }
          tb.appendChild(h('tr', h('td', k), h('td', txt(c)), h('td' + (u ? '.rc-unc' : ''), u ? h('span', txt(u.row), h('small', ' ' + u.by + ', T' + u.xid + ', not committed')) : h('span.muted', 'same')), after ? h('td', aft ? txt(a) : '') : null, after ? h('td', verdict) : null));
        }
        card.appendChild(h('h4', t.name + (show.length < keys.length ? ' (' + show.length + ' of ' + keys.length + ' rows: the ones that changed)' : '')));
        card.appendChild(h('div.grid-wrap', h('table.grid.small.rc-rows', h('thead', h('tr', h('th', t.cols[0]), h('th', 'Committed'), h('th', 'Seen inside a transaction'), after ? h('th', 'After restart') : null, after ? h('th', '') : null)), tb)));
      }
      return card;
    }

    // ---- archival dump, disk loss and log replay -----------------------------------------------------------------------
    function dumpCard() {
      const db = app.db;
      const card = h('section.kv-card');
      card.appendChild(h('h3', 'Loss of non-volatile storage ', h('span.muted', 'an archival dump, then the log replayed over it')));
      card.appendChild(h('p.kv-small', 'A crash loses memory; a disk failure loses the database itself. An archival dump copies the whole database to other stable storage (after a checkpoint, with a <dump> record in the log). When the disk fails, the most recent dump is restored and the log since it is replayed: redo of every logged change, then undo of the transactions that did not commit.'));
      const steps = h('ol.rc-steps');
      steps.appendChild(h('li', h('span.rc-who.num', '1'), h('span', dump ? 'Dump taken at checkpoint LSN ' + dump.d.lsn + ': ' + dump.counts.map((c) => c.name + ' ' + c.n).join(', ') : 'No dump yet.'), UI.btn('download', 'Take a dump', null, () => { try { dump = { d: K.Recovery.dump(db), counts: counts(db), lost: null }; res = null; } catch (e) { UI.toast(e.message, 'err'); } draw(); }, 'small')));
      const since = dump ? db.wal.records.filter((r) => r.lsn > dump.d.dumpLsn) : [];
      steps.appendChild(h('li', h('span.rc-who.num', '2'), h('span', dump ? 'Since the dump the log has ' + UI.plural(since.length, 'record') + ' (' + UI.plural(since.filter((r) => r.type === 'commit').length, 'commit') + '). Change some rows in a tab, commit some and leave one transaction open.' : 'Then change some rows.')));
      steps.appendChild(h('li', h('span.rc-who.num', '3'), h('span', dump && dump.lost ? 'The disk failed: every block is gone. The log, on its own device, survived.' : 'The disk fails.'), UI.btn('crash', 'Disk failure', null, () => {
        if (!dump) { UI.toast('Take a dump first: without one the data cannot be rebuilt', 'warn'); return; }
        before = db.down ? before : capture(app, touched(db));
        dump.lost = counts(db);
        K.Recovery.loseDisk(db);
        crashInfo = { at: 'disk', running: [] };
        res = null; notify();
      }, 'small danger')));
      steps.appendChild(h('li', h('span.rc-who.num', '4'), h('span', 'Restore the dump and replay the log with'), h('div.seg', Object.entries(ALG).map(([k, a]) => h('button' + (alg === k ? '.on' : ''), { type: 'button', onclick: () => { alg = k; UI.store.set('recovery.alg', k); draw(); } }, a.name))), UI.btn('refresh', 'Restore', null, () => {
        if (!dump || !dump.lost) { UI.toast('The disk has not failed', 'warn'); return; }
        restart(() => K.Recovery.restoreFromDump(app.db, dump.d, { algorithm: alg }));
        dump.after = app.db.down ? null : counts(app.db);
        draw();
      }, 'small primary')));
      card.appendChild(steps);
      if (dump && dump.lost && dump.after) {
        const m = new Map(dump.after.map((c) => [c.name, c.n]));
        card.appendChild(h('div.grid-wrap', h('table.grid.small', h('thead', h('tr', h('th', 'Table'), h('th.num', 'Rows at the dump'), h('th.num', 'Before the failure'), h('th.num', 'After restore and replay'))), h('tbody', dump.lost.map((c) => { const d0 = dump.counts.find((x) => x.name === c.name); return h('tr', h('td', c.name), h('td.num', d0 ? String(d0.n) : '–'), h('td.num', String(c.n)), h('td.num', String(m.has(c.name) ? m.get(c.name) : '–'))); })))));
        card.appendChild(h('p.kv-small.muted', 'The counts before the failure include changes of transactions that were still open; replay keeps only the committed ones.'));
      }
      return card;
    }

    // ---- remote backup -------------------------------------------------------------------------------------------------
    function backupCard() {
      const db = app.db;
      const card = h('section.kv-card');
      card.appendChild(h('h3', 'Remote backup ', h('span.muted', 'log shipping to a second site')));
      card.appendChild(h('p.kv-small', 'The backup site starts from a copy of the database and receives the log as the primary flushes it, redoing it on its own pages. If the primary fails, the backup takes over: it runs recovery and becomes the primary. A one-safe backup confirms a commit as soon as the primary has logged it, so the last commits may not have reached the backup yet: here the lag holds back that many flushes.'));
      if (!rb && !rbOut) {
        card.appendChild(h('div.kv-row', h('span.kv-small', 'Lag'), h('div.seg', [0, 1, 2].map((n) => h('button' + (rbLag === n ? '.on' : ''), { type: 'button', onclick: () => { rbLag = n; draw(); } }, n ? n + ' flush' + (n > 1 ? 'es' : '') : 'none (two-safe)'))),
          UI.btn('run', 'Start the backup', null, () => { if (db.down) { UI.toast('Restart the database first', 'warn'); return; } rb = new K.RemoteBackup(db, { lag: rbLag }); rb.firstXid = db.xact.next; rbOff = db.bus.on('wal.flush', redraw); draw(); }, 'small primary')));
        return card;
      }
      if (rb) {
        const w = db.wal;
        const inFlight = rb.queue.reduce((n, q) => n + q.recs.length, 0);
        const stat = (v, l, c) => h('div.kv-stat' + (c ? '.' + c : ''), h('div.kv-sv', String(v)), h('div.kv-sl', l));
        card.appendChild(h('div.rc-sites',
          h('div.rc-site', h('h4', 'Primary'), h('div.kv-stats', stat(w.flushedLsn, 'Flushed LSN', 'ok'), stat(w.records.filter((r) => r.type === 'commit' && r.lsn > rb.received && r.lsn <= w.flushedLsn).length, 'Commits not at the backup', 'warn'))),
          h('div.rc-wire', h('span', inFlight ? UI.plural(inFlight, 'record') + ' in flight' : 'in step'), h('span.rc-wa', '⟶')),
          h('div.rc-site', h('h4', 'Backup'), h('div.kv-stats', stat(rb.received, 'Received LSN', 'acc'), stat(rb.applied, 'Applied LSN')))));
        card.appendChild(h('p.kv-small.muted', 'Run statements in a tab: every commit flushes the log and ships it' + (rb.lag ? ', arriving ' + rb.lag + ' flush' + (rb.lag > 1 ? 'es' : '') + ' later' : '') + '.'));
        card.appendChild(h('div.rc-hist', rb.history.slice(-6).reverse().map((x) => h('div', h('span.kv-badge.' + (x.action === 'apply' ? 'ok' : x.action === 'receive' ? 'acc' : 'mute'), x.action), ' ', x.action === 'receive' ? UI.plural(x.records, 'record') + ' up to LSN ' + x.lsn : x.action === 'apply' ? UI.plural(x.redone, 'change') + ' redone, up to LSN ' + x.lsn : 'copy of the database at LSN ' + x.lsn))));
        card.appendChild(h('div.kv-row', UI.btn('refresh', 'Apply the received log', null, () => { rb.apply(); draw(); }, 'small'),
          UI.btn('crash', 'Primary fails: take over', null, () => {
            const lost = db.wal.records.filter((r) => r.type === 'commit' && r.lsn > rb.received && r.lsn <= db.wal.flushedLsn).map((r) => r.xid);
            keepHistory(db);
            const first = rb.firstXid;
            try { const out = rb.takeover(); inherit(db, out.db, first); rbOut = Object.assign(out, { lost, counts: counts(out.db), primary: counts(db) }); } catch (e) { UI.toast(e.message, 'err'); console.error(e); }
            if (rbOff) rbOff(); rbOff = null; rb = null; step = 0; draw();
          }, 'small danger')));
        return card;
      }
      const m = new Map(rbOut.primary.map((c) => [c.name, c.n]));
      card.appendChild(h('div.kv-banner' + (rbOut.lost.length ? '.bad' : ''), rbOut.lost.length ? 'The backup took over without the commits of ' + rbOut.lost.map((x) => 'T' + x).join(', ') + ': the primary had confirmed them, but their log records had not arrived. That is the risk of a one-safe backup.' : 'The backup took over with every committed transaction: nothing confirmed was lost.'));
      card.appendChild(h('div.grid-wrap', h('table.grid.small', h('thead', h('tr', h('th', 'Table'), h('th.num', 'Rows at the primary'), h('th.num', 'Rows at the new primary'))), h('tbody', rbOut.counts.map((c) => h('tr' + (m.get(c.name) !== c.n ? '.hl' : ''), h('td', c.name), h('td.num', String(m.has(c.name) ? m.get(c.name) : '–')), h('td.num', String(c.n))))))));
      card.appendChild(h('div.kv-row', UI.btn('db', 'Work on the new primary', 'Replace the workbench\'s database by the backup that took over', () => adopt(rbOut.db), 'small primary'), UI.btn('x', 'Discard', null, () => { rbOut = null; draw(); }, 'small')));
      return card;
    }
    /** the transactions that finished before the backup was copied are not in its log: their fates come from the primary */
    function inherit(p, nd, first) {
      for (const [x, st] of p.xact.clog) if (x < first && !nd.xact.clog.has(x)) nd.xact.clog.set(x, st);
      for (const [x, y] of p.xact.parent) if (!nd.xact.parent.has(x)) nd.xact.parent.set(x, y);
      if (!nd.wal.archived && p.wal.archived) nd.wal.archived = p.wal.archived;
    }
    /** the backup is the database now: the tabs get sessions on it */
    function adopt(nd) {
      nd.app = app;
      app.db = nd;
      for (const t of app.tabs) t.session = nd.session({ name: t.name });
      app.timeline.reset([]);
      dbRef = nd; reset();
      app.emit('db');
      notify();
      UI.toast('The workbench now runs on the former backup site');
    }

    // ---- shadow paging ---------------------------------------------------------------------------------------------------
    function shadowCard() {
      if (!sp) { sp = new K.ShadowPaging({ values: ['A', 'B', 'C', 'D'], spare: 4 }); spPos = null; }
      const card = h('section.kv-card.rc-shadow');
      card.appendChild(h('h3', 'Shadow paging ', h('span.muted', 'recovery without a log')));
      card.appendChild(h('p.kv-small', 'A transaction never overwrites a page: it copies the page to a free block and changes its current page table, kept in memory. The shadow page table on disk still points to the old blocks. Commit writes the current table to disk and then switches the database pointer to it in one atomic write. A crash before the switch leaves the shadow table in force: nothing to undo, nothing to redo.'));
      const act = (f) => { try { f(); spPos = null; } catch (e) { UI.toast(e.message, 'warn'); } draw(); };
      const pageSel = h('select.inp', { 'aria-label': 'Page' }, [0, 1, 2, 3].map((i) => h('option', { value: String(i) }, 'page ' + i)));
      const valIn = h('input.inp.rc-val', { type: 'text', value: String.fromCharCode(97 + (sp.history.length % 26)), 'aria-label': 'New value', maxlength: '6' });
      const running = !!sp.current;
      card.appendChild(h('div.kv-row.rc-sptools',
        UI.btn('run', 'Begin', null, () => act(() => sp.begin()), 'small' + (running ? '' : ' primary')),
        h('span.rc-write', pageSel, h('span', ':='), valIn, UI.btn('format', 'Write', null, () => act(() => sp.write(+pageSel.value, valIn.value || '?')), 'small')),
        UI.btn('check', 'Commit', null, () => act(() => sp.commit()), 'small'), UI.btn('x', 'Abort', null, () => act(() => sp.abort()), 'small'), UI.btn('crash', 'Crash', null, () => act(() => sp.crash()), 'small danger'),
        UI.btn('refresh', null, 'Start over', () => { sp = null; draw(); }, 'icon')));
      const hist = sp.history;
      const at = spPos === null ? hist.length - 1 : spPos;
      const e = hist[at];
      card.appendChild(h('div.rc-stepper', UI.btn('stepBack', null, 'Previous', () => { spPos = Math.max(0, at - 1); draw(); }, 'icon'), UI.btn('step', null, 'Next', () => { spPos = at + 1 >= hist.length ? null : at + 1; draw(); }, 'icon'), h('span.kv-badge.' + (e.action === 'crash' ? 'no' : e.action === 'commit' ? 'ok' : 'acc'), e.action), h('span.kv-small', e.note), h('span.tl-pos', (at + 1) + ' / ' + hist.length)));
      card.appendChild(shadowSvg(e));
      return card;
    }
    function shadowSvg(e) {
      const R = 26, top = 56, n = e.shadow.length, nb = e.blocks.length;
      const H = top + Math.max(n, nb) * R + 8;
      const X = { st: 6, b: 196, ct: 356 }, W = 120;
      const svg = s('svg', { class: 'rc-sp', viewBox: '0 0 488 ' + H, role: 'img', 'aria-label': 'Shadow and current page tables pointing to disk blocks' });
      const t = (x, y, txt, cls) => s('text', { x, y, class: cls || 'rc-spt', text: txt });
      svg.appendChild(s('rect', { x: X.st, y: 4, width: 172, height: 22, rx: 6, class: 'rc-spptr' }));
      svg.appendChild(t(X.st + 86, 19, 'database pointer → table ' + e.pointer, 'rc-spt mid b'));
      svg.appendChild(s('path', { d: 'M' + (X.st + W / 2) + ' 26V' + (top - 18), class: 'rc-spl' }));
      svg.appendChild(t(X.st + W / 2, top - 6, 'shadow (on disk)', 'rc-spt mid h'));
      svg.appendChild(t(X.b + W / 2, top - 6, 'disk blocks', 'rc-spt mid h'));
      svg.appendChild(t(X.ct + W / 2, top - 6, 'current (in memory)', 'rc-spt mid h'));
      const by = (i) => top + i * R + R / 2;
      const changed = new Set(e.current ? e.current.map((b, i) => (b !== e.shadow[i] ? b : null)).filter((x) => x !== null) : []);
      // the blocks in page order, each page's copy right under its shadow block, the free ones last: then
      // neither table's arrows cross
      const order = [];
      e.shadow.forEach((b, i) => { if (!order.includes(b)) order.push(b); if (e.current && e.current[i] !== b && !order.includes(e.current[i])) order.push(e.current[i]); });
      e.blocks.forEach((v, j) => { if (!order.includes(j)) order.push(j); });
      const row = (j) => order.indexOf(j);
      order.forEach((j, k) => {
        const v = e.blocks[j];
        svg.appendChild(s('rect', { x: X.b, y: top + k * R + 3, width: W, height: R - 6, rx: 5, class: 'rc-spb' + (v === null ? ' free' : '') + (changed.has(j) ? ' new' : '') }));
        svg.appendChild(t(X.b + 8, by(k) + 4, String(j), 'rc-spt dim'));
        svg.appendChild(t(X.b + W / 2 + 6, by(k) + 4, v === null ? 'free' : v, 'rc-spt mid' + (v === null ? ' dim' : ' b')));
      });
      e.shadow.forEach((b, i) => {
        svg.appendChild(s('rect', { x: X.st, y: top + i * R + 3, width: W, height: R - 6, rx: 5, class: 'rc-spe' }));
        svg.appendChild(t(X.st + 10, by(i) + 4, 'page ' + i + ' → ' + b));
        svg.appendChild(s('path', { d: 'M' + (X.st + W) + ' ' + by(i) + 'C' + (X.st + W + 30) + ' ' + by(i) + ',' + (X.b - 30) + ' ' + by(row(b)) + ',' + X.b + ' ' + by(row(b)), class: 'rc-spl' }));
      });
      if (e.current) e.current.forEach((b, i) => {
        const ch = b !== e.shadow[i];
        svg.appendChild(s('rect', { x: X.ct, y: top + i * R + 3, width: W, height: R - 6, rx: 5, class: 'rc-spe' + (ch ? ' new' : '') }));
        svg.appendChild(t(X.ct + 10, by(i) + 4, 'page ' + i + ' → ' + b));
        svg.appendChild(s('path', { d: 'M' + X.ct + ' ' + by(i) + 'C' + (X.ct - 30) + ' ' + by(i) + ',' + (X.b + W + 30) + ' ' + by(row(b)) + ',' + (X.b + W) + ' ' + by(row(b)), class: 'rc-spl' + (ch ? ' new' : '') }));
      });
      else svg.appendChild(t(X.ct + W / 2, top + 18, 'no transaction', 'rc-spt mid dim'));
      return h('div.rc-spwrap', svg);
    }
    return view;
  }

  UI.registerView({ id: 'recovery', title: 'Crash and recovery', icon: 'crash', group: 'Transactions', order: 46, create });
})(typeof window !== 'undefined' ? window : globalThis);
