// The buffer pool view: the frames, the page table, and the replacement policy's own state (the LRU order, the
// clock and its hand, the FIFO queue, the LRU-2 history). Stepping through a recorded run replays its buf.*
// events onto the pool as it was when the run began, so each step shows the hit, the miss, the victim and why
// the policy chose it, the write of a dirty page and the log flush that must come before it.
(function (root) {
  'use strict';
  const K = root.K;
  const UI = K.UI;
  const { h, s } = UI;

  const POLICIES = [['lru', 'LRU'], ['mru', 'MRU'], ['clock', 'Clock'], ['fifo', 'FIFO'], ['lru2', 'LRU-2']];
  const PNAME = Object.fromEntries(POLICIES);
  const ABOUT = {
    lru: 'Least recently used: the victim is the unpinned frame whose page was used longest ago. Good when recent use predicts the next use.',
    mru: 'Most recently used: the victim is the frame used last. Bad in general, but right for a scan repeated over a relation larger than the pool (the inner loop of a nested-loop join).',
    clock: 'Clock (second chance): the hand sweeps the frames; a frame whose reference bit is 1 gets the bit cleared and is passed over, the first with bit 0 is the victim. A cheap approximation of LRU.',
    fifo: 'First in, first out: the victim is the page that has been in the pool longest, however often it was used.',
    lru2: 'LRU-2: the victim is the frame whose second-to-last use is oldest (a page used only once counts as never used before), so a single scan cannot push out pages used again and again.',
  };
  const fmt = (n) => Number(n).toLocaleString('en-US');
  const safe = (f, d) => { try { return f(); } catch (e) { return d; } };
  const ratio = (st) => (st.hits + st.misses ? st.hits / (st.hits + st.misses) : 0);
  const pct = (x) => Math.round(x * 1000) / 10 + '%';
  const EXPERIMENT = [
    'set enable_hashjoin = off;',
    'set enable_mergejoin = off;',
    'set enable_indexscan = off;',
    'set enable_bitmapscan = off;',
    'set work_mem_pages = 3;',
    '-- block nested-loop join: booking (the inner relation) is scanned once per block of patron',
    'select count(*) from patron p join booking b on p.patron_id = b.patron_id;',
  ].join('\n');

  /** the pool's state, including what describe() leaves out (the FIFO queue, the LRU-2 history, load stamps) */
  function capture(bp) {
    const d = bp.describe();
    const raw = bp.frames || [];
    const frames = d.frames.map((f, k) => ({ i: f.i, file: f.file, block: f.block, pins: f.pins, dirty: f.dirty, used: f.used || 0, ref: !!f.ref, name: f.name, loaded: raw[k] && raw[k].loaded || 0, hist: raw[k] && Array.isArray(raw[k].hist) ? raw[k].hist.slice() : [] }));
    const tick = Math.max(bp.tick || 0, ...frames.map((f) => Math.max(f.used, f.loaded)));
    const fifo = Array.isArray(bp.fifo) ? bp.fifo.slice() : frames.filter((f) => f.block >= 0).sort((a, b) => a.loaded - b.loaded).map((f) => f.i);
    return { n: d.n, policy: d.policy, hand: d.hand || 0, tick, frames, fifo, stats: Object.assign({ hits: 0, misses: 0, evictions: 0, flushes: 0 }, d.stats) };
  }
  const clone = (st) => ({ n: st.n, policy: st.policy, hand: st.hand, tick: st.tick, fifo: st.fifo.slice(), stats: Object.assign({}, st.stats), frames: st.frames.map((f) => Object.assign({}, f, { hist: f.hist.slice() })) });
  const blank = (i) => ({ i, file: 0, block: -1, pins: 0, dirty: false, used: 0, ref: false, loaded: 0, hist: [], name: null });

  /** the policy's choice among the frames of st, as the buffer manager makes it; for Clock also the frames passed over */
  function chooseVictim(st, apply) {
    const cand = st.frames.filter((f) => f.block >= 0 && f.pins === 0);
    if (!cand.length) return null;
    switch (st.policy) {
      case 'mru': { const v = cand.reduce((a, b) => (b.used > a.used ? b : a)); return { v, why: 'it is the most recently used unpinned frame (last used at t = ' + v.used + ')' }; }
      case 'fifo': { const v = st.fifo.map((i) => st.frames[i]).find((f) => f && f.block >= 0 && f.pins === 0) || cand[0]; return { v, why: 'its page has been in the pool longest (loaded at t = ' + v.loaded + '): first in, first out' }; }
      case 'lru2': { const v = cand.reduce((a, b) => ((b.hist[1] || 0) < (a.hist[1] || 0) || ((b.hist[1] || 0) === (a.hist[1] || 0) && b.used < a.used) ? b : a)); return { v, why: v.hist[1] ? 'its second-to-last use (t = ' + v.hist[1] + ') is the oldest' : 'it was used only once since it was loaded, which counts as the oldest second-to-last use' + (cand.filter((f) => !f.hist[1]).length > 1 ? ' (of those, it was used longest ago, t = ' + v.used + ')' : '') }; }
      case 'clock': {
        const frames = apply ? st.frames : st.frames.map((f) => Object.assign({}, f));
        let hand = st.hand;
        const passed = [];
        for (let k = 0; k < st.n * 3; k++) {
          const f = frames[hand];
          hand = (hand + 1) % st.n;
          if (f.block < 0 || f.pins > 0) continue;
          if (f.ref) { f.ref = false; passed.push(f.i); continue; }
          if (apply) st.hand = hand;
          const v = st.frames[f.i];
          return { v, passed, why: (passed.length ? 'the hand passed frame' + (passed.length > 1 ? 's ' : ' ') + compact(passed) + ' (reference bit 1, cleared to 0: a second chance) and ' : 'the hand ') + 'stopped at frame ' + f.i + ', whose reference bit was 0' };
        }
        return { v: cand[0], why: 'every frame was pinned or referenced' };
      }
      default: { const v = cand.reduce((a, b) => (b.used < a.used ? b : a)); return { v, why: 'it is the least recently used unpinned frame (last used at t = ' + v.used + ', the oldest of ' + cand.length + ')' }; }
    }
  }
  const compact = (list) => (list.length > 6 ? list.slice(0, 5).join(', ') + ' … ' + list[list.length - 1] : list.join(', '));

  /** apply one recorded event to a replayed pool; returns a note about it (the victim's reason, for evictions) */
  function apply(st, e) {
    const d = e.data || {};
    const f = d.frame !== undefined ? st.frames[d.frame] : null;
    switch (e.type) {
      case 'buf.resize': st.n = d.frames; st.frames = []; for (let i = 0; i < st.n; i++) st.frames.push(blank(i)); st.fifo = []; st.hand = 0; return null;
      case 'buf.lost': st.frames = st.frames.map((x) => blank(x.i)); st.fifo = []; st.hand = 0; return null;
      case 'buf.policy': st.policy = d.policy; return null;
      case 'buf.hit': if (!f) return null; f.pins++; f.used = ++st.tick; f.ref = true; f.hist.unshift(st.tick); f.hist.length = Math.min(2, f.hist.length); st.stats.hits++; return null;
      case 'buf.evict': {
        if (!f) return null;
        const choice = chooseVictim(st, true);
        const note = { victim: f.i, wasDirty: f.dirty, file: f.file, block: f.block, why: choice && choice.v.i === f.i ? choice.why : 'chosen by the buffer manager' + (choice ? ' (the replay expected frame ' + choice.v.i + ')' : ''), passed: choice && choice.passed };
        if (st.policy === 'clock') st.hand = (f.i + 1) % st.n;
        Object.assign(f, blank(f.i));
        st.fifo = st.fifo.filter((i) => i !== f.i);
        st.stats.evictions++;
        return note;
      }
      case 'buf.miss': {
        if (!f) return null;
        f.file = d.file; f.block = d.block; f.dirty = false; f.hist = []; f.loaded = ++st.tick;
        st.fifo.push(f.i);
        f.pins++; f.used = ++st.tick; f.ref = true; f.hist.unshift(st.tick);
        st.stats.misses++;
        return null;
      }
      case 'buf.dirty': if (f) f.dirty = true; return null;
      case 'buf.flush': if (f) f.dirty = false; st.stats.flushes++; return null;
      case 'buf.unpin': if (f && d.pins !== undefined) f.pins = d.pins; return null;
    }
    return null;
  }
  function replay(base, events, upto) {
    const st = clone(base);
    const notes = new Map();
    for (let k = 0; k < upto; k++) { const n = apply(st, events[k]); if (n) notes.set(k, n); }
    return { st, notes };
  }
  const sameFrames = (a, b) => a.n === b.n && a.frames.every((f, i) => b.frames[i] && f.block === b.frames[i].block && (f.block < 0 || f.file === b.frames[i].file));

  function create(app, el) {
    const bp = () => app.db.buffers;
    let base = capture(bp());        // the pool as it was when the recorded run began
    let runEvents = null, replayOk = false, runBase = null;
    let shown = null;                // which policy's state is drawn (null: the pool's own)
    let exp = null;                  // the experiment's results
    let expFrames = UI.store.get('buffer.expFrames', 8);
    const intro = h('div.kv-intro', h('b', 'The buffer manager. '), 'Every page a query touches is read into one of a fixed number of frames in memory. The page table finds a cached page by (file, block); a miss reads the block from disk, and when no frame is free the replacement policy picks a victim among the unpinned frames, writing it first if it is dirty (after the log, by the write-ahead rule).');
    const head = h('div.view-head.bp-head');
    const body = h('div.view-body.bp-body');
    el.appendChild(intro); el.appendChild(head); el.appendChild(body);
    const recapture = () => { base = capture(bp()); runEvents = null; replayOk = false; };

    const view = {
      onRun(run) {
        const now = capture(bp());
        runEvents = (run && run.events) || [];
        const r = replay(base, runEvents, runEvents.length);
        replayOk = runEvents.length < 60000 && sameFrames(r.st, now);
        // the replay starts from the state before this run; the next run starts from now
        runBase = base;
        base = now;
      },
      onDb() { base = capture(bp()); runEvents = null; replayOk = false; exp = null; },
      render() { draw(); },
    };

    function stateNow() {
      const tl = app.timeline;
      if (runEvents && replayOk && tl.events === runEvents && runBase) {
        const r = replay(runBase, runEvents, tl.pos);
        return { st: r.st, notes: r.notes, replay: true, pos: tl.pos, cur: tl.current(), events: runEvents };
      }
      return { st: capture(bp()), notes: new Map(), replay: false, cur: null };
    }

    function draw() {
      const S = stateNow();
      const st = S.st;
      head.innerHTML = '';
      head.appendChild(h('div.seg', { role: 'group', 'aria-label': 'Replacement policy' }, POLICIES.map(([k, l]) => h('button' + (bp().policy === k ? '.on' : ''), { type: 'button', title: ABOUT[k], onclick: () => { bp().setPolicy(k); app.settings.policy = k; app.saveSettings(); shown = null; recapture(); app.updateStatus(); draw(); } }, l))));
      head.appendChild(h('label.kv-check', 'Frames', h('select.inp.bp-n', { 'aria-label': 'Number of frames', onchange: (e) => resize(+e.target.value, e.target) }, [4, 8, 16, 32, 64, 128, 256].concat(bp().n).filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b).map((n) => h('option', { value: String(n), selected: n === bp().n }, String(n))))));
      head.appendChild(UI.btn('download', 'Flush all', 'Write every dirty page to disk (the log first)', () => { const before = bp().stats.flushes; bp().flushAll(); const n = bp().stats.flushes - before; recapture(); app.updateStatus(); UI.toast(n ? 'Wrote ' + UI.plural(n, 'dirty page') + ' to disk' : 'No page was dirty'); draw(); }));
      body.innerHTML = '';
      if (S.replay && S.cur) body.appendChild(eventBox(S));
      else if (app.timeline.length && runEvents && !replayOk) body.appendChild(h('div.kv-banner', h('span', 'The pool changed in ways this run does not record (another tab, or a resize), so the frames below are the pool as it is now, not as it was at this step.')));
      body.appendChild(counters(S));
      body.appendChild(framesCard(S));
      body.appendChild(policyCard(S));
      body.appendChild(pageTable(st));
      body.appendChild(experimentCard());
    }

    function resize(n, sel) {
      if (n === bp().n) return;
      UI.confirm('Resize the buffer pool?', 'Resizing to ' + n + ' frames writes every dirty page to disk and empties the pool, so the next queries start with no page cached.', () => { bp().resize(n); recapture(); app.updateStatus(); draw(); }, 'Resize');
      sel.value = String(bp().n);
    }

    const nameOf = (file) => safe(() => app.db.disk.file(file).name, 'file ' + file);
    const pageName = (f) => (f.block < 0 ? 'free' : nameOf(f.file) + ' · ' + f.block);

    function eventBox(S) {
      const e = S.cur, d = e.data || {};
      const k = S.pos - 1;
      const box = h('div.kv-banner.bp-event');
      box.appendChild(h('div', h('span.kv-step', 'Step ' + S.pos + ' of ' + S.events.length), UI.describeEvent(e)));
      let txt = null;
      const f = d.frame !== undefined ? S.st.frames[d.frame] : null;
      switch (e.type) {
        case 'buf.hit': txt = 'A hit: ' + nameOf(d.file) + ' block ' + d.block + ' was found in the page table, in frame ' + d.frame + '. No disk access; the frame is pinned (' + (f ? f.pins : '?') + ' pins) and its last-used stamp and reference bit are updated.'; break;
        case 'buf.miss': {
          const ev = [...S.notes.entries()].reverse().find(([j]) => j < k && j >= k - 6);
          txt = 'A miss: ' + nameOf(d.file) + ' block ' + d.block + ' is not in the page table, so it is read from disk into frame ' + d.frame + (ev && ev[1].victim === d.frame ? ', the frame just freed.' : ', which was free.');
          break;
        }
        case 'buf.evict': { const n = S.notes.get(k); txt = 'No frame is free, so the ' + PNAME[S.st.policy] + ' policy picks a victim among the unpinned frames: frame ' + d.frame + ' (' + nameOf(d.file) + ' block ' + d.block + '), because ' + (n ? n.why : 'the policy chose it') + '.' + (n && n.wasDirty ? ' It was dirty, so its page was written back first.' : ' It was clean, so it is simply dropped: the disk copy is current.'); break; }
        case 'buf.flush': {
          const prev = S.events.slice(Math.max(0, k - 4), k).find((x) => x.type === 'wal.flush');
          txt = 'Frame ' + d.frame + ' was dirty: its page (' + nameOf(d.file) + ' block ' + d.block + ', page LSN ' + d.lsn + ') is written to disk.' + (prev ? ' Just before, the log was flushed to LSN ' + prev.data.lsn + ': the write-ahead rule, so the log records that describe the change reach stable storage before the page does.' : ' The log was already flushed past the page\'s LSN, so the write-ahead rule needed no log flush.');
          break;
        }
        case 'wal.flush': txt = 'The log is forced to stable storage up to LSN ' + d.lsn + ' (' + (d.why || 'flush') + ').' + (/about to be written/.test(d.why || '') ? ' A dirty page is about to be written, and its changes must be in the log on disk first.' : ''); break;
        case 'buf.dirty': txt = 'The page in frame ' + d.frame + ' was changed: its dirty bit is set. It is not written now; it goes to disk when it is evicted, flushed, or at a checkpoint.'; break;
        case 'buf.unpin': txt = 'Frame ' + d.frame + ' is unpinned; ' + (d.pins ? d.pins + ' pins remain, so it still cannot be replaced.' : 'with no pins left it may now be chosen as a victim.'); break;
        case 'disk.read': case 'disk.write': txt = 'The disk ' + (e.type === 'disk.read' ? 'reads' : 'writes') + ' ' + d.name + ' block ' + d.block + ' (' + UI.ms(d.ms || 0) + (d.seek ? ', with a seek' : ', sequential') + ').'; break;
      }
      if (txt) box.appendChild(h('div.bp-why', txt));
      return box;
    }

    function counters(S) {
      const st = S.st.stats;
      const live = bp().stats;
      const r = ratio(st);
      const stat = (l, v, cls, t) => h('div.kv-stat' + (cls ? '.' + cls : ''), { title: t || '' }, h('div.kv-sv', v), h('div.kv-sl', l));
      return h('section.kv-card', h('h3', S.replay ? 'Counters at this step' : 'Counters', h('span.muted', ' · ' + PNAME[S.st.policy] + ', ' + S.st.n + ' frames')),
        h('div.kv-stats', stat('hits', fmt(st.hits), 'ok'), stat('misses', fmt(st.misses), 'bad'), stat('evictions', fmt(st.evictions)), stat('writes', fmt(st.flushes), 'warn', 'dirty pages written back'), stat('hit ratio', pct(r), 'acc', 'hits / (hits + misses)')),
        h('div.bp-ratio', { title: 'hit ratio ' + pct(r) }, h('span', { style: { width: r * 100 + '%' } })),
        S.replay ? h('p.kv-small.muted', 'Since the database started, counting the run up to this step. At the end of the run: ' + fmt(live.hits) + ' hits, ' + fmt(live.misses) + ' misses.') : h('p.kv-small.muted', 'Since the database started (the sample data loads before the counters start).'));
    }

    function framesCard(S) {
      const st = S.st;
      const d = S.cur && S.cur.data;
      const curFrame = S.cur && /^buf\./.test(S.cur.type) && d.frame !== undefined ? d.frame : null;
      const kind = S.cur ? S.cur.type.split('.')[1] : '';
      const next = chooseVictim(st, false);
      const grid = h('div.bp-frames');
      for (const f of st.frames) {
        const empty = f.block < 0;
        const cls = (empty ? '.free' : '') + (f.dirty ? '.dirty' : '') + (f.pins ? '.pinned' : '') + (curFrame === f.i ? '.ev-' + kind : '') + (next && next.v.i === f.i && st.frames.every((x) => x.block >= 0) ? '.next' : '');
        grid.appendChild(h('div.bp-frame' + cls, { title: empty ? 'Frame ' + f.i + ': free' : 'Frame ' + f.i + ': ' + nameOf(f.file) + ' block ' + f.block + ', ' + UI.plural(f.pins, 'pin') + (f.dirty ? ', dirty' : ', clean') + ', reference bit ' + (f.ref ? 1 : 0) + ', last used t = ' + f.used },
          h('div.bp-fi', h('span', '#' + f.i), st.policy === 'clock' && st.hand === f.i ? h('span.bp-hand', { title: 'the clock hand' }, '◀ hand') : null),
          empty ? h('div.bp-fn.muted', 'free') : [h('div.bp-fn', nameOf(f.file)), h('div.bp-fb', 'block ' + f.block)],
          empty ? null : h('div.bp-bits', h('span.bp-bit' + (f.pins ? '.on' : ''), { title: 'pin count' }, 'pin ' + f.pins), h('span.bp-bit' + (f.dirty ? '.dirty' : ''), { title: 'dirty bit' }, f.dirty ? 'dirty' : 'clean'), h('span.bp-bit' + (f.ref ? '.on' : ''), { title: 'reference bit (Clock)' }, 'ref ' + (f.ref ? 1 : 0)), h('span.bp-t', { title: 'last-used stamp' }, 't ' + f.used))));
      }
      const used = st.frames.filter((f) => f.block >= 0).length;
      return h('section.kv-card', h('h3', 'Frames', h('span.muted', ' · ' + used + ' of ' + st.n + ' in use, ' + st.frames.filter((f) => f.dirty).length + ' dirty, ' + st.frames.filter((f) => f.pins).length + ' pinned')), grid,
        h('div.st-legend.kv-small', h('span', h('i.bp-sw.hit'), 'hit'), h('span', h('i.bp-sw.miss'), 'miss (read in)'), h('span', h('i.bp-sw.evict'), 'evicted'), h('span', h('i.bp-sw.flush'), 'written back'), h('span', h('i.bp-sw.next'), 'next victim')));
    }

    function policyCard(S) {
      const st = S.st;
      const p = shown || st.policy;
      const view2 = Object.assign(clone(st), { policy: p });
      const occupied = view2.frames.filter((f) => f.block >= 0);
      const next = chooseVictim(view2, false);
      const card = h('section.kv-card.bp-pol');
      card.appendChild(h('h3', 'Replacement policy state', h('span.muted', ' · ' + (p === st.policy ? 'the pool\'s policy' : 'what ' + PNAME[p] + ' would do with these frames'))));
      card.appendChild(h('div.seg.bp-polseg', POLICIES.map(([k, l]) => h('button' + (p === k ? '.on' : ''), { type: 'button', onclick: () => { shown = k === st.policy ? null : k; draw(); } }, l + (k === st.policy ? ' ●' : '')))));
      card.appendChild(h('p.kv-small', ABOUT[p]));
      if (!occupied.length) { card.appendChild(h('p.muted.kv-small', 'The pool is empty.')); return card; }
      const chip = (f, extra) => h('span.bp-chip' + (f.pins ? '.pinned' : '') + (next && next.v.i === f.i ? '.next' : ''), { title: 'Frame ' + f.i + ': ' + pageName(f) + (f.pins ? ' (pinned: not a candidate)' : '') }, h('b', '#' + f.i), h('span', pageName(f)), extra ? h('span.bp-cx', extra) : null);
      const list = (frames, label, extraFn, endLabel) => h('div.bp-order', h('span.bp-end', label), frames.map((f) => chip(f, extraFn(f))), h('span.bp-end', endLabel));
      if (p === 'lru') card.appendChild(list(occupied.slice().sort((a, b) => a.used - b.used), 'least recent', (f) => 't ' + f.used, 'most recent'));
      else if (p === 'mru') card.appendChild(list(occupied.slice().sort((a, b) => b.used - a.used), 'most recent', (f) => 't ' + f.used, 'least recent'));
      else if (p === 'fifo') card.appendChild(list(st.fifo.map((i) => st.frames[i]).filter((f) => f && f.block >= 0), 'oldest (out)', (f) => 'in at t ' + f.loaded, 'newest (in)'));
      else if (p === 'lru2') card.appendChild(list(occupied.slice().sort((a, b) => (a.hist[1] || 0) - (b.hist[1] || 0) || a.used - b.used), 'oldest 2nd-last use', (f) => (f.hist[1] ? 't₋₂ ' + f.hist[1] : 'used once') + ' · t ' + f.used, 'newest'));
      else card.appendChild(clockDrawing(view2, next));
      card.appendChild(h('p.kv-small.bp-nextv', next ? h('span', h('b', 'Next victim: frame ' + next.v.i), ' (' + pageName(next.v) + '), because ' + next.why + '.') : 'Every frame is pinned: no page can be replaced now.'));
      return card;
    }
    function clockDrawing(st, next) {
      const n = st.n, R = 110, cx = 150, cy = 140;
      const svg = s('svg', { class: 'bp-clock', viewBox: '0 0 300 280', role: 'img', 'aria-label': 'The clock: frames in a circle with their reference bits and the hand' });
      svg.appendChild(s('circle', { cx, cy, r: R, class: 'bp-rim' }));
      const ang = (i) => -Math.PI / 2 + (i / n) * Math.PI * 2;
      const show = n <= 64;
      for (let i = 0; i < n && show; i++) {
        const f = st.frames[i];
        const a = ang(i), x = cx + R * Math.cos(a), y = cy + R * Math.sin(a);
        const r = n > 32 ? 5 : n > 16 ? 8 : 12;
        svg.appendChild(s('circle', { cx: x, cy: y, r, class: 'bp-cf' + (f.block < 0 ? ' free' : f.ref ? ' ref' : '') + (f.pins ? ' pinned' : '') + (next && next.v.i === i ? ' next' : '') }, s('title', { text: 'Frame ' + i + ': ' + pageName(f) + ', reference bit ' + (f.ref ? 1 : 0) + (f.pins ? ', pinned' : '') })));
        if (n <= 32) svg.appendChild(s('text', { x, y: y + 3.5, class: 'bp-ct', text: n <= 16 ? (f.block < 0 ? '–' : String(f.ref ? 1 : 0)) : '' }));
        if (n <= 16) { const lx = cx + (R + 24) * Math.cos(a), ly = cy + (R + 24) * Math.sin(a); svg.appendChild(s('text', { x: lx, y: ly + 3, class: 'bp-cl', text: '#' + i })); }
      }
      const a = ang(st.hand);
      svg.appendChild(s('line', { x1: cx, y1: cy, x2: cx + (R - 18) * Math.cos(a), y2: cy + (R - 18) * Math.sin(a), class: 'bp-handl' }));
      svg.appendChild(s('circle', { cx, cy, r: 5, class: 'bp-hub' }));
      svg.appendChild(s('text', { x: cx, y: cy + 24, class: 'bp-cl', text: 'hand at #' + st.hand }));
      return h('div.bp-clockbox', svg, h('div.st-legend.kv-small', h('span', h('i.bp-sw.ref'), 'reference bit 1'), h('span', h('i.bp-sw.noref'), 'bit 0'), h('span', h('i.bp-sw.next'), 'next victim'), n <= 16 ? h('span', 'numbers: the reference bit') : null));
    }

    function pageTable(st) {
      const B = Math.max(4, Math.min(64, st.n));
      const buckets = Array.from({ length: B }, () => []);
      for (const f of st.frames) if (f.block >= 0) buckets[((f.file * 31 + f.block) >>> 0) % B].push(f);
      const rows = buckets.map((list, k) => h('div.bp-bucket' + (list.length ? '' : '.empty'), h('span.bp-bk', String(k)), list.length ? list.map((f) => h('span.bp-entry', { title: 'frame ' + f.i }, '(' + f.file + ', ' + f.block + ') → #' + f.i)) : h('span.muted', '·')));
      return h('section.kv-card', h('h3', 'Page table', h('span.muted', ' · a hash table from (file, block) to frame')), h('p.kv-small.muted', 'To find a page the buffer manager hashes its file and block number (here h = (31·file + block) mod ' + B + ') and looks along that bucket\'s chain. Found: a hit. Not found: a miss, and the page is read into a frame and added to the table.'), h('div.bp-buckets', rows),
        h('p.kv-small.muted', 'Files: ' + [...new Set(st.frames.filter((f) => f.block >= 0).map((f) => f.file))].sort((a, b) => a - b).map((f) => f + ' = ' + nameOf(f)).join(', ')));
    }

    function experimentCard() {
      const card = h('section.kv-card.bp-exp');
      card.appendChild(h('h3', 'Experiment: which policy suits a repeated scan?'));
      card.appendChild(h('p.kv-small', 'The same block nested-loop join runs under each policy with a small pool. The inner relation, booking (' + safe(() => UI.plural(app.db.disk.blocks(app.session.catalog.tables(['table']).find((r) => r.name === 'booking').file), 'page'), 'many pages') + '), is scanned once for every block of patron and is larger than the pool.'));
      card.appendChild(h('pre.kv-formula', EXPERIMENT));
      const has = ['booking', 'patron'].every((n) => app.session.catalog.tables(['table']).some((r) => r.name === n));
      const run = UI.btn('run', 'Run under every policy', 'Run the join under LRU, MRU, Clock, FIFO and LRU-2', () => experiment(run), 'primary');
      if (!has) run.disabled = true;
      card.appendChild(h('div.kv-row', h('label.kv-check', 'Pool of', h('select.inp', { 'aria-label': 'Frames for the experiment', onchange: (e) => { expFrames = +e.target.value; UI.store.set('buffer.expFrames', expFrames); } }, [4, 8, 16, 32].map((n) => h('option', { value: String(n), selected: n === expFrames }, String(n)))), 'frames'), run, !has ? h('span.kv-small.muted', 'Load the Theatre sample database to run it.') : null));
      if (exp) {
        const best = Math.max(...exp.rows.map((r) => ratio(r.stats)));
        card.appendChild(h('div.bp-exprows', exp.rows.map((r) => h('div.bp-exprow' + (ratio(r.stats) === best && best > 0 ? '.best' : ''),
          h('div.bp-expn', h('b', PNAME[r.policy]), h('span.kv-small.muted', fmt(r.stats.hits) + ' hits · ' + fmt(r.stats.misses) + ' misses · ' + fmt(r.reads) + ' reads · ' + UI.ms(r.ms))),
          h('div.bp-expbar', h('span', { style: { width: Math.max(0.5, ratio(r.stats) * 100) + '%' } }), h('em', pct(ratio(r.stats)))),
          h('div.bp-refs', { title: 'every page request in order: green a hit, red a miss' }, r.refs.slice(0, 400).map((x) => h('i' + (x ? '.h' : ''))))))));
        card.appendChild(h('p.kv-small', 'With ' + exp.frames + ' frames, LRU throws out each page of booking just before the next scan needs it again, so every request of the scan misses; Clock approximates LRU and does the same. MRU replaces the page it has just finished with and keeps the first pages of the scan, so each rescan finds those already in memory. So the best policy depends on the access pattern, which the query processor knows.'));
        card.appendChild(h('p.kv-small.muted', 'The run used its own session and the counters above leave it out; afterwards the pool went back to ' + exp.orig.n + ' frames and ' + PNAME[exp.orig.policy] + ', empty.'));
      }
      return card;
    }
    function experiment(btn) {
      const db = app.db, b = bp();
      const orig = { n: b.n, policy: b.policy, stats: Object.assign({}, b.stats), disk: Object.assign({}, db.disk.stats) };
      const sess = db.session({ name: 'buffer experiment' });
      const rows = [];
      btn.disabled = true;
      const order = ['lru', 'mru', 'clock', 'fifo', 'lru2'];
      const finish = () => {
        db.closeSession(sess);
        b.resize(orig.n); b.setPolicy(orig.policy);
        b.stats = Object.assign({}, orig.stats); db.disk.stats = Object.assign({}, orig.disk);
        exp = { rows, frames: expFrames, orig };
        recapture(); app.updateStatus(); draw();
      };
      const step = (k) => {
        if (k >= order.length) { finish(); return; }
        btn.querySelector('.bl').textContent = 'Running ' + PNAME[order[k]] + '…';
        setTimeout(() => {
          const p = order[k];
          const refs = [];
          const off1 = db.bus.on('buf.hit', () => { if (refs.length < 4000) refs.push(1); });
          const off2 = db.bus.on('buf.miss', () => { if (refs.length < 4000) refs.push(0); });
          try {
            b.resize(expFrames); b.setPolicy(p); b.resetStats();
            const d0 = Object.assign({}, db.disk.stats);
            const t0 = K.now();
            sess.exec(EXPERIMENT);
            rows.push({ policy: p, stats: Object.assign({}, b.stats), reads: db.disk.stats.reads - d0.reads, ms: db.disk.stats.ms - d0.ms, refs, wall: K.now() - t0 });
          } catch (e) { UI.toast('The experiment failed: ' + e.message, 'err', 6000); off1(); off2(); finish(); return; }
          off1(); off2();
          step(k + 1);
        }, 20);
      };
      step(0);
    }

    return view;
  }

  UI.registerView({ id: 'buffer', title: 'Buffer pool', icon: 'frames', group: 'Storage', order: 11, events: true, create });
  UI.BufferView = { capture, replay, chooseVictim };
})(typeof window !== 'undefined' ? window : globalThis);
