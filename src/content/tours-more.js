// More guided tours: a query from SQL down to pages, a B+ tree page split, a deadlock, a crash and ARIES restart,
// a shard rebalance and a Raft election. Each step's before() puts the workbench in the state the step talks about,
// and does it again safely when the student goes back a step.
(function (root) {
  'use strict';
  const C = root.K.Content;

  // ---- small helpers ----------------------------------------------------------------------------------------------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  /** the button inside `within` whose text is `text` (or matches it) */
  const button = (within, text) => $$(within + ' button').find((b) => (text instanceof RegExp ? text.test(b.textContent) : b.textContent.trim() === text));
  const click = (within, text) => { const b = button(within, text); if (b && !b.disabled) b.click(); return b; };
  /** bring an element in a scrolling view into sight, so the callout can sit next to it */
  const show = (sel) => { const e = $(sel); if (e) e.scrollIntoView({ block: 'center', inline: 'nearest' }); };
  /** a view that redraws on the next animation frame replaces the highlighted element: mark the new one too */
  const rehighlight = (sel) => requestAnimationFrame(() => requestAnimationFrame(() => { const e = $(sel); if (e && document.querySelector('.tour')) e.classList.add('tour-hi'); }));
  const viewOf = (app, id) => { const o = app.dock.open.find((x) => x.id === id); return o ? o.view : null; };

  // ---- 1. a query from SQL to pages -------------------------------------------------------------------------------
  const Q1 = "select booking_id, perf_id, seats\nfrom booking\nwhere paid > 150;\n";
  const typeQ1 = (app) => { if (app.editor.getValue() !== Q1) { app.editor.setValue(Q1); app.tab.text = Q1; app.saveTabs(); } };
  const ranQ1 = (app) => { typeQ1(app); if (!app.tab.run) app.run('all'); };
  const bookingOid = (app) => { const r = app.session.catalog.tables().find((x) => x.name === 'booking'); return r ? r.oid : undefined; };
  C.tour({
    id: 'tour-sql-pages', title: 'A query, from SQL down to the pages',
    steps: [
      { target: '.ed-box', before: typeQ1, text: 'We follow one query all the way down. It asks for the bookings that paid more than 150. SQL says *what* rows to return, never *how* to find them.' },
      { target: '.results', before: (app) => { typeQ1(app); app.run('all'); }, text: 'Here is the answer. Behind it, the query processor parsed the statement, chose a plan, and the storage manager fetched pages of the table. The line above the rows counts the pages read from disk and written.' },
      { target: '.pl-node.op-SeqScan', before: (app) => { ranQ1(app); app.openView('plan'); }, text: 'The **plan**: a sequential scan of `booking` that tests every row against `paid > 150`. There is no index on paid, so the only way is to read the whole heap file, page by page. Click a node to see its estimates beside what really happened.' },
      { target: '.stepbar', before: (app) => { ranQ1(app); app.openView('plan'); }, text: 'Every run is recorded. Step through it to watch the scan ask the buffer manager for one page after another, and the rows flow up the plan.' },
      { target: '.st-strip', before: (app) => { ranQ1(app); app.openView('storage', { rel: bookingOid(app), block: 0 }); show('.st-strip'); }, text: 'The **storage** view shows the heap file of `booking`: a sequence of fixed-size blocks. The scan read each of them. More rows means more pages, and pages are what a query really costs.' },
      { target: '.st-map', before: (app) => { ranQ1(app); app.openView('storage', { rel: bookingOid(app), block: 0 }); show('.st-map'); }, text: 'One block, drawn to scale. It is a **slotted page**: a header, an array of line pointers growing down, and the tuples growing up from the end. A row is found by its TID (block, slot), which is what `ctid` shows in SQL.' },
      { target: '.bp-frames', before: (app) => { ranQ1(app); app.openView('buffer'); }, text: 'The **buffer pool**. Every page the scan read was copied from disk into one of these frames. The page table remembers which page is in which frame, so the next request for it needs no disk read.' },
      { target: '.bp-body .kv-stats', before: (app) => { typeQ1(app); app.run('all'); app.openView('buffer'); }, text: 'The query has just run a second time. Its pages were still in memory, so the hits went up and the misses did not: the same plan, far fewer disk reads. Try the LRU, Clock and MRU policies above with a smaller pool.' },
    ],
  });

  // ---- 2. a page split in a B+ tree -------------------------------------------------------------------------------
  /** the index playground on a B+ tree of fan-out 4 in step mode, with these keys inserted, at the step matching `at` */
  function lab(app, keys, at) {
    app.openView('indexlab');
    const mode = button('.ix-head .seg', 'Step through');
    if (mode && !mode.classList.contains('on')) mode.click();
    const kind = $('.ix-sel');
    if (kind && kind.value !== 'bplus') { kind.value = 'bplus'; kind.dispatchEvent(new Event('change')); }
    const fan = $$('.lab-param').find((l) => /Fan-out/.test(l.textContent));
    const fs = fan && fan.querySelector('select');
    if (fs && fs.value !== '4') { fs.value = '4'; fs.dispatchEvent(new Event('change')); }
    click('.lab-quick', 'Start over');
    if (keys) {
      const input = $('.lab-in');
      input.value = keys;
      click('.lab-ops', 'Insert');
      const steps = $$('.lab-li');
      const pick = at ? steps.filter((b) => at.test(b.textContent)).pop() : steps[steps.length - 1];
      if (pick) pick.click();
    }
  }
  C.tour({
    id: 'tour-page-split', title: 'A B+ tree page splits',
    steps: [
      { target: '.ix-head', before: (app) => lab(app, null), text: 'The index playground holds one index structure on its own. Here it is a **B+ tree of fan-out 4**: a node has at most 4 child pointers, so a leaf holds at most 3 keys.' },
      { target: '.lab-ctl', before: (app) => lab(app, null), text: 'Type keys and press Insert, or pick a sequence under it. Each operation is recorded as a series of steps, one per change to the structure.' },
      { target: '.ix-canvas', before: (app) => lab(app, '10 20 30'), text: 'After 10, 20 and 30 the tree is a single leaf, and it is the root. It is full: three keys is all a leaf of this tree can hold.' },
      { target: '.lab-say', before: (app) => lab(app, '10 20 30 40', /split/), text: 'Now 40 arrives. The leaf has no room, so it **splits**: the first half of the keys stays, the rest move to a new leaf, and the leaves stay linked left to right for range scans.' },
      { target: '.ix-canvas', before: (app) => lab(app, '10 20 30 40', /newroot/), text: 'The new leaf\'s first key, 30, is **copied up** into the parent. There was no parent, so a new root is made. This is the only way a B+ tree grows taller, which keeps every leaf at the same depth.' },
      { target: '.lab-stepbar', before: (app) => lab(app, '10 20 30 40'), text: 'Step backwards and forwards through what happened, or play it. Each step names the pages it read and wrote: a split writes the old leaf, the new leaf and the parent.' },
      { target: '.lab-quick', before: (app) => lab(app, null), text: 'Try the chip **Ten keys: 8 14 21 26 33 38 44 50 57 63** and watch a split propagate up to an internal node. Then delete keys and see leaves borrow from a sibling (redistribution) or merge with it (coalescing).' },
    ],
  });

  // ---- 3. a deadlock ----------------------------------------------------------------------------------------------
  /** the deadlock scenario of the transactions view, run up to `n` steps, showing a sub-tab */
  function deadlockAt(app, n, sub) {
    let v = viewOf(app, 'txn');
    if (!v || !v.state) v = app.openView('txn');
    else app.openView('txn');
    const st = v.state;
    if (!st.sc || st.sc.id !== 'deadlock' || st.step > n) v.start('deadlock');
    while (v.state.step < n && v.state.sc) v.next();
    const tab = $('.tx-tabs button[data-tab="' + (sub || 'timeline') + '"]');
    if (tab && !tab.classList.contains('on')) tab.click();
  }
  C.tour({
    id: 'tour-deadlock', title: 'Two transactions deadlock',
    steps: [
      { target: '.tx-sels', before: (app) => { deadlockAt(app, 0); rehighlight('.tx-sels'); }, text: 'The transactions view. The menus say how concurrency is controlled: the protocol, the isolation level of new transactions, and what to do about deadlocks. Here: MVCC as in PostgreSQL, with **deadlock detection**.' },
      { target: '.tx-next', before: (app) => { deadlockAt(app, 0); rehighlight('.tx-next'); }, text: 'The deadlock scenario opened two tabs, T1 and T2, each a session with its own transaction. This bar runs the next statement in its tab, one step at a time, in the order the schedule gives.' },
      { target: '.tx-grid', before: (app) => { deadlockAt(app, 4); rehighlight('.tx-grid'); }, text: 'Four steps in. Both began, T1 updated row 1 and T2 updated row 2. An update locks its row until the transaction ends, so T1 now holds row 1 and T2 holds row 2.' },
      { target: '.dg-box', before: (app) => { deadlockAt(app, 5, 'locks'); show('.dg-box'); rehighlight('.dg-box'); }, text: 'Step 5: T1 asks for row 2, which T2 holds, so T1 **waits**. The wait-for graph has an edge T1 → T2. A wait is fine as long as the other transaction can finish.' },
      { target: '.tx-pred', before: (app) => { deadlockAt(app, 5); rehighlight('.tx-pred'); }, text: 'Before the next step, predict: T2 now asks for row 1, which T1 holds. Pick an answer, then go on.' },
      { target: '.tx-span.deadlock', before: (app) => { deadlockAt(app, 6); show('.tx-span.deadlock'); rehighlight('.tx-span.deadlock'); }, text: 'T2\'s request would close the cycle T1 → T2 → T1: neither could ever go on. The detector finds the cycle and rolls back the transaction whose wait closed it, T2, with "deadlock detected". T1\'s update then goes ahead.' },
      { target: '.dg-box', before: (app) => { deadlockAt(app, 6, 'locks'); show('.dg-box'); rehighlight('.dg-box'); }, text: 'The Locks tab keeps the last deadlock found: the cycle in the wait-for graph. T2 lost its locks with its rollback, so T1 holds both rows.' },
      { target: '.tx-sels .tx-sel:last-child', before: (app) => { deadlockAt(app, 6); rehighlight('.tx-sels .tx-sel:last-child'); }, text: 'Now prevent the cycle instead of detecting it. Choose **wait-die** or **wound-wait** here and restart the scenario: the older transaction\'s timestamp decides who waits and who is rolled back, before any cycle can form.' },
    ],
  });

  // ---- 4. a crash and ARIES -----------------------------------------------------------------------------------------
  const RC = 'A checkpoint between';
  function recovery(app) {
    app.openView('recovery');
    const tab = button('.rc-tabs', 'Crash and restart');
    if (tab && !tab.classList.contains('on')) tab.click();
    const chip = button('.rc-chips', RC);
    if (chip && !chip.classList.contains('on')) chip.click();
  }
  /** end what other tabs left running (a waiting statement, an open transaction): the crash would take it anyway */
  function endOthers(app) {
    if (app.db.down) return;
    for (const t of app.tabs) {
      if (t.runner && !t.runner.done) { try { t.runner.cancel(); } catch (e) { /* gone */ } }
      if (t.session && t.session.tx) { try { t.session.exec('rollback'); } catch (e) { /* gone */ } }
    }
    try { app.db.step(); } catch (e) { /* nothing runs */ }
    app.drawTabs(); app.updateStatus();
  }
  const setUp = (app, active) => { endOthers(app); click('.rc-scen', active ? 'Set up again' : 'Set up'); };
  /** the scenario set up; with crash, crashed; with restart, restarted by ARIES (and on a pass) */
  function recoveryAt(app, stage, pass) {
    recovery(app);
    const db = app.db;
    const active = !!$('.rc-preds');
    const restarted = !!$('.rc-passes');
    if (stage === 'setup') { if (!active || db.down || restarted) setUp(app, active); show('.rc-preds'); return; }
    if (!active || (restarted && stage !== 'restart')) setUp(app, active);
    if (!app.db.down && !$('.rc-passes')) click('.rc-scen', 'Crash as described');
    if (stage === 'crash') { show('.rc-crash'); return; }
    const aries = button('.rc-restart .seg', 'ARIES');
    if (aries && !aries.classList.contains('on')) aries.click();
    if (stage === 'aries') { show('.rc-restart'); return; }
    if (app.db.down) click('.rc-restart', 'Restart');
    if (pass) { const p = $$('.rc-pass').find((b) => b.textContent.startsWith(pass)); if (p) p.click(); }
    show(pass ? '.rc-step' : '.rc-passes');
  }
  C.tour({
    id: 'tour-aries', title: 'A crash, and restart with ARIES',
    steps: [
      { target: '.rc-chips', before: (app) => { recovery(app); show('.rc-chips'); }, text: 'The crash and recovery view. Each scenario runs a few statements in two tabs, Session A and Session B, on a small table `account`. This one: T1 moves 300 from A to B and commits; T2 sets C to 500, a checkpoint is taken while it runs, then T2 sets A to 3500.' },
      { target: '.rc-preds', before: (app) => recoveryAt(app, 'setup'), text: 'The statements have run, and T2 is still open. Before the crash, predict for each update whether it survives the restart. Only committed work should survive: that is **atomicity** and **durability** together.' },
      { target: '.rc-crash', before: (app) => recoveryAt(app, 'crash'), text: 'The system has crashed. Main memory is gone: the buffer pool, the log buffer, the running transaction T2. The disk and the stable log survive. The checkpoint wrote every dirty page, T2\'s uncommitted C = 500 included (a **steal** policy).' },
      { target: '.rc-restart', before: (app) => recoveryAt(app, 'aries'), text: 'Choose how to restart. **ARIES** works in three passes: analysis, redo and undo. The other choice, **Redo then undo (basic)**, is the simpler two-pass algorithm; try it afterwards and compare.' },
      { target: '.rc-passes', before: (app) => recoveryAt(app, 'restart', 'Analysis'), text: '**Analysis** starts at the last checkpoint and reads the log forward. It rebuilds the transaction table and the dirty page table, so it knows which transactions were running at the crash: the **losers**: here only T2, the transaction of Session B (the view names it by its transaction id).' },
      { target: '.rc-step', before: (app) => recoveryAt(app, 'restart', 'Redo'), text: '**Redo** repeats history from RedoLSN, losers\' changes included, and skips a change the page already has (its PageLSN is not older than the record). Here there is nothing to redo: the checkpoint wrote every dirty page, and the one later change, A = 3500, never reached the stable log.' },
      { target: '.rc-step', before: (app) => recoveryAt(app, 'restart', 'Undo'), text: '**Undo** rolls the losers back, newest change first. Each undone change is logged as a **compensation log record** (CLR), so a crash during recovery never undoes the same change twice.' },
      { target: '.rc-preds', before: (app) => { recoveryAt(app, 'restart'); show('.rc-preds'); }, text: 'Now check your predictions. T1\'s transfer survived; T2\'s C = 500 was undone though it was on disk, and its A = 3500 never reached stable storage at all.' },
    ],
  });

  // ---- 5. a shard rebalance ---------------------------------------------------------------------------------------
  const PART = { table: 'booking', key: 'patron_id', scheme: 'consistent', n: 3, vnodes: 8 };
  function cluster(app) { return app.openView('cluster'); }
  /** the partitioning scenario, restarted only when asked to (it loads the data after a moment) */
  function partition(app, restart) {
    const v = cluster(app);
    const on = root.K.UI.store.get('ck.scenario') === 'partition' && $('.ck-about');
    if (restart || !on) v.scenario('partition', PART);
    return v;
  }
  const nodes = () => $$('.ck-node').filter((n) => !n.classList.contains('k-client')).length;
  C.tour({
    id: 'tour-rebalance', title: 'A node joins: rebalancing shards',
    steps: [
      { target: '.ck-pickf', before: (app) => partition(app, true), text: 'The cluster view simulates several database nodes. This scenario partitions the `booking` relation of the Theatre database across three nodes; each node is a real database holding its share of the rows.' },
      { target: '.ck-about', before: (app) => partition(app), text: 'Partitioning spreads the rows of a relation over the nodes. **Round-robin** deals rows out in turn, **hash partitioning** sends a row to h(key) mod n, and **range partitioning** gives each node a range of keys.' },
      { target: '.ck-controls', before: (app) => { partition(app); show('.ck-controls'); }, text: 'Here the key is the `patron_id` and the scheme is **consistent hashing**: keys and nodes are hashed onto the same ring, and a key belongs to the next node point clockwise. Each node has 8 points on the ring (virtual nodes).' },
      { target: '.ck-panel .ck-bars', before: (app) => { partition(app); show('.ck-panel .ck-bars'); }, text: 'Rows per node. They are not equal: the node with the most rows decides how long a parallel scan takes. The ratio of the largest share to the mean measures this **skew**.' },
      { target: '.ck-what', before: (app) => { partition(app); if (nodes() < 4) click('.ck-actions', 'Add a node'); }, text: 'A fourth node, n4, has joined. On the ring it takes over a few arcs from its neighbours, so only the rows on those arcs move, and all of them move to n4. Play the timeline to watch the rows travel as messages.' },
      { target: '.ck-panel', before: (app) => { partition(app); if (nodes() < 4) click('.ck-actions', 'Add a node'); show('.ck-panel'); }, text: 'The panel compares: with h(key) mod n, going from 3 to 4 nodes would have moved most of the rows, because changing n changes almost every row\'s home. Consistent hashing moves about a quarter, the share the new node should own.' },
      { target: '.ck-controls', before: (app) => { partition(app); show('.ck-controls'); }, text: 'Try it yourself: choose hash or range partitioning, or fewer points per node, then add or remove a node and compare how many rows move and how even the shares are.' },
    ],
  });

  // ---- 6. a Raft election -----------------------------------------------------------------------------------------
  /** a fresh run of the Raft scenario (five servers), the leader crashed if asked, at the frame `pick` chooses */
  function raft(app, crash, pick) {
    const v = cluster(app);
    const stage = v.scenario('raft', { n: 5, seed: 1 });
    const fr = () => stage.src.rec.frames;
    if (crash) {
      const lead = fr().findIndex((f) => f.s.nodes.some((n) => n.role === 'leader'));
      stage.player.go(lead);
      click('.ck-actions', 'Crash the leader');
    }
    const from = stage.player.i;
    const i = fr().findIndex((f, k) => k >= from && pick(f));
    stage.player.go(i < 0 ? from : i);
    return stage;
  }
  const role = (r, term) => (f) => f.s.nodes.some((n) => n.role === r && (!term || n.term >= term));
  C.tour({
    id: 'tour-raft', title: 'Raft elects a leader',
    steps: [
      { target: '.ck-canvas', before: (app) => raft(app, false, () => true), text: '**Raft** keeps the same log on five servers. At the start every server is a **follower** in term 0. The ring around each one is its election timer, set to a random length.' },
      { target: '.ck-node.cand', before: (app) => raft(app, false, role('candidate')), text: 'One server\'s timer ran out first, so it heard from no leader. It becomes a **candidate**: it starts term 1, votes for itself and asks the others for their votes. A server votes for at most one candidate in a term.' },
      { target: '.ck-node.lead', before: (app) => raft(app, false, role('leader')), text: 'With votes from a majority, 3 of 5, the candidate is **leader** of term 1. It sends AppendEntries messages at once and then regularly as heartbeats, which reset the followers\' timers, so no one else stands.' },
      { target: '.ck-actions', before: (app) => raft(app, false, role('leader')), text: 'These buttons change the run from the current moment: send a client write, crash the leader, or cut it off from the others. Click any server to crash or isolate that one.' },
      { target: '.ck-node.cand', before: (app) => raft(app, true, role('candidate')), text: 'The leader has crashed. The heartbeats stop, so the followers\' timers run out, and the first to run out stands in **term 2**. A majority of the five is still up, so an election can still succeed.' },
      { target: '.ck-node.lead:not(.down)', before: (app) => raft(app, true, role('leader', 2)), text: 'A new leader of term 2. Only a server whose log is at least as up to date as a majority\'s can win, so no committed entry is ever lost in the change of leader.' },
      { target: '.ck-player', before: (app) => raft(app, true, role('leader', 2)), text: 'Play the rest, or step back and forth. Restart the crashed server: it sees the higher term, becomes a follower, and the new leader brings its log up to date. Compare a blockchain\'s consensus in chapter 26.' },
    ],
  });
})(typeof window !== 'undefined' ? window : globalThis);
