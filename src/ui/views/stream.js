// Streaming data (Ch. 10): a seeded stream of sensor readings arrives over simulated processing time, out of
// order, some of it late. Windows (tumbling, hopping, session) are drawn on the event-time line with an aggregate
// per window that grows as events arrive; the watermark decides when a window's result is emitted, and an event
// that arrives after its window was emitted either updates the result (within the allowed lateness) or is dropped.
// The same windows are computed with SQL over a table holding the stream so far.
(function (root) {
  'use strict';
  const K = root.K;
  const UI = K.UI;
  const { h, s } = UI;

  const SENSORS = ['s1', 's2', 's3'];
  const BASE = '2026-03-02 09:00:00';
  const SPAN = 60;
  const mmss = (x) => { if (x < 0) return '−' + mmss(-x); const v = Math.round(x * 10) / 10; const m = Math.floor(v / 60), sec = v - m * 60; return String(m).padStart(2, '0') + ':' + (Number.isInteger(sec) ? String(sec).padStart(2, '0') : sec.toFixed(1).padStart(4, '0')); };
  const ts = (x) => { const d = new Date(Date.UTC(2026, 2, 2, 9, 0, 0) + Math.round(x * 1000)); const iso = d.toISOString(); return iso.slice(0, 10) + ' ' + iso.slice(11, 19) + (d.getUTCMilliseconds() ? '.' + String(d.getUTCMilliseconds()).padStart(3, '0').replace(/0+$/, '') : ''); };
  const r1 = (x) => Math.round(x * 10) / 10;

  /** the stream: per sensor, readings at irregular intervals with an occasional pause; most arrive within a second or so, some much later */
  function generate(seed) {
    const rnd = UI.ADV.rng(seed);
    const out = [];
    SENSORS.forEach((sn, k) => {
      let x = r1(rnd() * 2), v = 20 + k * 2.5 + rnd() * 2;
      while (x < SPAN) {
        v = Math.max(10, v + (rnd() - 0.5) * 1.6);
        const late = rnd() < 0.12;
        const delay = late ? 5 + rnd() * 9 : 0.2 + rnd() * 1.3;
        out.push({ sensor: sn, x, v: r1(v), p: r1(x + delay), late0: late });
        x = r1(x + (rnd() < 0.12 ? 5 + rnd() * 4 : 0.6 + rnd() * 2.4));
      }
    });
    out.sort((a, b) => a.p - b.p || a.x - b.x);
    out.forEach((e, i) => { e.id = i; });
    return out;
  }

  /** windows of a kind over event time; session windows come from the events themselves, per sensor */
  function windowsOf(cfg, accepted) {
    if (cfg.kind === 'tumbling') { const out = []; for (let a = 0; a < SPAN + cfg.size; a += cfg.size) out.push({ start: a, end: a + cfg.size }); return out; }
    if (cfg.kind === 'hopping') { const out = []; for (let a = -cfg.size + cfg.slide; a < SPAN + cfg.size; a += cfg.slide) if (a + cfg.size > 0) out.push({ start: a, end: a + cfg.size }); return out; }
    const out = [];
    for (const sn of SENSORS) {
      const xs = accepted.filter((e) => e.sensor === sn).map((e) => e.x).sort((a, b) => a - b);
      let cur = null;
      for (const x of xs) { if (cur && x < cur.last + cfg.gap) { cur.last = x; cur.end = x + cfg.gap; } else { cur = { key: sn, start: x, last: x, end: x + cfg.gap }; out.push(cur); } }
    }
    return out;
  }
  const inWin = (w, e) => e.x >= w.start && e.x < w.end && (!w.key || w.key === e.sensor);

  /**
   * replay the stream up to processing time t: the watermark after each arrival (the largest event time seen,
   * minus the allowed delay), whether each event was on time, late but accepted, or dropped, and each window's
   * state. At the end of the stream the source sends a final watermark that closes every window.
   */
  function replay(events, cfg, t) {
    const endT = events.length ? events[events.length - 1].p + 1 : 0;
    let maxX = -Infinity;
    const wmAfter = [];
    const status = [];
    for (const e of events) {
      if (e.p > t) break;
      const wmBefore = maxX - cfg.delay;
      // an event is late when the watermark has already passed the end of a window it belongs to (or, for sessions, the end its session would have)
      const ends = cfg.kind === 'session' ? [e.x + cfg.gap] : windowsOf(cfg, []).filter((w) => inWin(w, e)).map((w) => w.end);
      const closed = ends.filter((x) => x <= wmBefore);
      let st = 'ok';
      if (closed.length) st = ends.every((x) => wmBefore >= x + cfg.lateness) ? 'dropped' : 'late';
      status.push({ e, st, wm: wmBefore });
      maxX = Math.max(maxX, e.x);
      wmAfter.push({ p: e.p, wm: maxX - cfg.delay });
    }
    const final = t >= endT;
    const wm = final ? Infinity : maxX - cfg.delay;
    const accepted = status.filter((x) => x.st !== 'dropped').map((x) => x.e);
    const wins = windowsOf(cfg, accepted).map((w) => {
      const evs = status.filter((x) => x.st !== 'dropped' && inWin(w, x.e));
      const emitAt = (wmAfter.find((x) => x.wm >= w.end) || { p: final ? endT : null }).p;
      const emitted = wm >= w.end;
      const updates = emitted ? evs.filter((x) => x.e.p > emitAt).length : 0;
      const dropped = status.filter((x) => x.st === 'dropped' && inWin(w, x.e)).length;
      const vals = evs.map((x) => x.e.v);
      return Object.assign({}, w, { n: vals.length, avg: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null, max: vals.length ? Math.max(...vals) : null, emitted, emitAt, updates, dropped });
    }).filter((w) => w.n || w.dropped || (cfg.kind !== 'session' && w.start < Math.max(maxX, 0) + 0.001));
    return { status, wm, maxX, wins, final, endT };
  }

  function create(app, el) {
    const A = UI.ADV;
    const cfg = Object.assign({ seed: 7, kind: 'tumbling', size: 10, slide: 5, gap: 4, delay: 2, lateness: 5, per: false }, UI.store.get('stream.cfg', {}));
    let events = generate(cfg.seed);
    const endT = () => events[events.length - 1].p + 1;
    let t = Math.min(UI.store.get('stream.t', 24), endT());
    let timer = null;
    const save = () => { UI.store.set('stream.cfg', cfg); UI.store.set('stream.t', t); };

    el.appendChild(h('div.view-intro', h('b', 'A data stream never ends, so a query over it runs continuously and aggregates over windows. '), 'Each reading carries its event time, but readings arrive later and out of order. A window\'s result can only be emitted once the ', h('b', 'watermark'), ' (the system\'s estimate that no earlier event is still to come) has passed its end; an event that arrives after that is late, and either updates the result or is dropped.'));
    const head = h('div.view-head.adv-head');
    const body = h('div.view-body.adv-body.ds');
    el.appendChild(head); el.appendChild(body);

    const go = (x) => { t = Math.max(0, Math.min(endT(), r1(x))); save(); draw(); };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const play = () => { if (timer) { stop(); draw(); return; } if (t >= endT()) t = 0; timer = setInterval(() => { if (t >= endT()) { stop(); draw(); return; } go(t + 0.5); }, 140); draw(); };
    /** the next or previous moment something arrives */
    const nextArrival = (d) => { const ps = [...new Set(events.map((e) => e.p))].concat([endT()]).sort((a, b) => a - b); if (d > 0) { const n = ps.find((p) => p > t + 1e-9); go(n === undefined ? endT() : n); } else { const n = ps.filter((p) => p < t - 1e-9).pop(); go(n === undefined ? 0 : n); } };

    function drawHead(R) {
      head.innerHTML = '';
      const slider = h('input.adv-hr.ds-range', { type: 'range', min: '0', max: String(endT()), step: '0.1', value: String(t), 'aria-label': 'Processing time', oninput: (e) => { stop(); go(+e.target.value); } });
      head.appendChild(h('div.adv-hist',
        UI.btn('first', null, 'Back to the start', () => { stop(); go(0); }, 'icon'),
        UI.btn('stepBack', null, 'Back to the previous arrival', () => { stop(); nextArrival(-1); }, 'icon'),
        UI.btn(timer ? 'pause' : 'run', null, timer ? 'Pause' : 'Play the stream', play, 'icon' + (timer ? ' on' : '')),
        UI.btn('step', null, 'Forward to the next arrival', () => { stop(); nextArrival(1); }, 'icon'),
        UI.btn('last', null, 'To the end of the stream', () => { stop(); go(endT()); }, 'icon'),
        slider,
        h('span.adv-hl', h('b', 'processing time ' + mmss(t)), ' · ' + UI.plural(R.status.length, 'event') + ' arrived · watermark ' + (R.wm === Infinity ? 'end of stream' : R.wm < 0 ? '–' : mmss(R.wm)))));
    }

    function timeline(R) {
      const W = 920, left = 24, right = 16, xs = (W - left - right) / (SPAN + 5);
      const X = (x) => left + Math.max(-1, x) * xs;
      const bandRows = cfg.kind === 'tumbling' ? 1 : cfg.kind === 'hopping' ? Math.ceil(cfg.size / cfg.slide) : 0;
      const bh = 30, lane = cfg.kind === 'session' ? 56 : 34, top = 22;
      // a strip between the windows and the lanes holds the watermark's name
      const lanesTop = top + bandRows * (bh + 6) + 16;
      const H = lanesTop + SENSORS.length * lane + 30;
      const g = [], labels = [];
      // processing has reached up to the watermark: the region to its right may still receive events
      const wmX = R.wm === Infinity ? X(SPAN + 5) : R.wm < 0 ? X(0) : X(R.wm);
      const wmLine = R.wm !== Infinity && R.wm >= 0;
      g.push(s('rect', { class: 'ds-open', 'data-audit': 'ignore', x: wmX, y: top - 4, width: Math.max(0, X(SPAN + 5) - wmX), height: H - top - 22 }));
      for (let x = 0; x <= SPAN + 5; x += 5) { g.push(s('line', { class: 'ds-grid', 'data-audit': 'ignore', x1: X(x), x2: X(x), y1: top - 4, y2: H - 26 })); g.push(s('text', { x: X(x), y: H - 10, 'text-anchor': 'middle' }, mmss(x))); }
      g.push(s('text', { x: left, y: 12, class: 'ds-axl' }, 'event time →'));
      const winRect = (w, y, hgt, prevEnd) => {
        const x1 = X(Math.max(w.start, -1)), x2 = X(w.end);
        const cls = 'ds-win' + (w.emitted ? ' done' : ' open') + (w.updates ? ' upd' : '');
        // a session window starts at its first event: give that dot room inside it, short of the window before
        const pad = cfg.kind === 'session' ? Math.max(0, Math.min(7, prevEnd === undefined ? 7 : x1 - X(prevEnd) - 2)) : 0;
        const long = w.n ? 'n=' + w.n + ' · avg ' + w.avg.toFixed(1) : '';
        // the label in the widest stretch of the window that the watermark does not cut through (it runs down the
        // lanes, where session windows are)
        let a0 = x1 - pad + 5, a1 = x2 - 5;
        if (cfg.kind === 'session' && wmLine && wmX > a0 && wmX < a1) { if (wmX - a0 >= a1 - wmX) a1 = wmX - 5; else a0 = wmX + 5; }
        const fits = (t) => t.length * 6.4 <= a1 - a0;
        const label = !w.n ? '' : fits(long) ? long : fits(String(w.n)) ? String(w.n) : '';
        const ty = cfg.kind === 'session' ? y + 13 : y + hgt / 2 + 4;
        return s('g', { class: cls }, s('rect', { x: x1 + 1 - pad, y, width: Math.max(2, x2 - x1 - 2 + pad), height: hgt, rx: 6 }), label ? s('text', { x: (a0 + a1) / 2, y: ty, 'text-anchor': 'middle' }, label) : null,
          s('title', {}, '[' + mmss(w.start) + ', ' + mmss(w.end) + ')' + (w.key ? ' ' + w.key : '') + ': ' + w.n + ' events' + (w.emitted ? ', emitted' : ', open') + (w.updates ? ', updated ' + w.updates + '×' : '')));
      };
      if (cfg.kind !== 'session') R.wins.forEach((w, i) => { const row = cfg.kind === 'tumbling' ? 0 : Math.round((w.start + cfg.size) / cfg.slide) % bandRows; g.push(winRect(w, top + row * (bh + 6), bh)); });
      SENSORS.forEach((sn, k) => {
        const y = lanesTop + k * lane;
        g.push(s('line', { class: 'ds-lane', 'data-audit': 'ignore', x1: left, x2: W - right, y1: y + lane / 2, y2: y + lane / 2 }));
        labels.push(s('text', { x: 4, y: y + lane / 2 + 4, class: 'ds-sn' }, sn));
        if (cfg.kind === 'session') R.wins.filter((w) => w.key === sn).sort((a, b) => a.start - b.start).forEach((w, i, ws) => g.push(winRect(w, y + 3, lane - 6, i ? ws[i - 1].end : undefined)));
      });
      for (const x of R.status) {
        const e = x.e, y = lanesTop + SENSORS.indexOf(e.sensor) * lane + lane / 2 + (cfg.kind === 'session' ? 14 : 0);
        const fresh = e.p > t - 0.75;
        const title = s('title', {}, e.sensor + ' ' + e.v + ' at ' + mmss(e.x) + ', arrived ' + mmss(e.p) + (x.st === 'late' ? ': late, updates its window' : x.st === 'dropped' ? ': late, dropped' : ''));
        if (x.st === 'dropped') g.push(s('g', { class: 'ds-ev drop', transform: 'translate(' + X(e.x) + ',' + y + ')' }, s('path', { d: 'M-4 -4 L4 4 M4 -4 L-4 4' }), title));
        else g.push(s('circle', { class: 'ds-ev s' + (SENSORS.indexOf(e.sensor) + 1) + (x.st === 'late' ? ' late' : '') + (fresh ? ' fresh' : ''), cx: X(e.x), cy: y, r: fresh ? 5.5 : 4 }, title));
        if (x.st !== 'ok' && fresh) {
          // beside the watermark line rather than across it
          const word = x.st === 'late' ? 'late' : 'dropped', half = word.length * 3.2 + 3, ex = X(e.x);
          const near = wmLine && Math.abs(ex - wmX) < half;
          g.push(s('text', { x: near ? (ex < wmX ? wmX - 3 : wmX + 3) : ex, y: y - 9, 'text-anchor': near ? (ex < wmX ? 'end' : 'start') : 'middle', class: 'ds-latel' }, word));
        }
      }
      // the watermark runs down the lanes; its name sits in the strip above them, on whichever side has room
      // (session windows live in the lanes, and an open one straddles the watermark: there the shading of the open
      // region marks it, and the line stops above the lanes)
      if (wmLine) g.push(s('g', { class: 'ds-wm' }, s('line', { x1: wmX, x2: wmX, y1: lanesTop - 16, y2: cfg.kind === 'session' ? lanesTop - 1 : H - 26 }), s('text', { x: wmX + (wmX > W - 90 ? -4 : 4), y: lanesTop - 5, 'text-anchor': wmX > W - 90 ? 'end' : 'start' }, 'watermark')));
      const box = h('div.adv-scroll.ds-sc', s('svg', { class: 'adv-svg ds-svg', width: W, height: H, viewBox: '0 0 ' + W + ' ' + H }, g));
      // on a narrow screen keep the watermark, where things happen, in view
      requestAnimationFrame(() => { if (box.clientWidth && box.clientWidth < W) box.scrollLeft = Math.max(0, Math.min(W - box.clientWidth, wmX - box.clientWidth * 0.6)); });
      // the sensor names stay put while the time line scrolls
      return h('div.ds-tl', s('svg', { class: 'adv-svg ds-lab', width: 26, height: H, viewBox: '0 0 26 ' + H }, labels), box);
    }

    function resultsTable(R) {
      const rows = R.wins.slice().sort((a, b) => a.start - b.start || String(a.key).localeCompare(String(b.key)));
      const stat = (w) => (w.emitted ? (w.updates ? A.badge('updated ' + w.updates + '×', 'warn') : A.badge('emitted', 'ok')) : A.badge('open', 'acc'));
      return h('div.adv-tbl.ds-res', h('table.grid', h('thead', h('tr', cfg.kind === 'session' ? h('th', 'Sensor') : null, h('th', 'Window'), h('th.num', 'Events'), h('th.num', 'Average'), h('th.num', 'Max'), h('th', 'Result'), h('th.num', 'Dropped'))),
        h('tbody', rows.map((w) => h('tr' + (w.emitted ? '' : '.on'), cfg.kind === 'session' ? h('td', w.key) : null, h('td', '[' + mmss(w.start) + ', ' + mmss(w.end) + ')'), h('td.num', String(w.n)), h('td.num', w.avg === null ? '–' : w.avg.toFixed(1)), h('td.num', w.max === null ? '–' : w.max.toFixed(1)), h('td.txt', stat(w)), h('td.num', w.dropped ? String(w.dropped) : ''))))));
    }

    function sqlText(R) {
      const arrived = R.status.map((x) => x.e).slice().sort((a, b) => a.x - b.x || a.sensor.localeCompare(b.sensor));
      const vals = arrived.map((e) => "  ('" + e.sensor + "', " + e.v.toFixed(1) + ", '" + ts(e.x) + "', '" + ts(e.p) + "')").join(',\n');
      const make = '-- the stream so far, as a table\ndrop table if exists stream_events;\ncreate temp table stream_events (sensor text, reading numeric(5,1), event_time timestamp, arrival_time timestamp);\n' + (arrived.length ? 'insert into stream_events values\n' + vals + ';\n' : '');
      const sz = cfg.size + ' seconds';
      if (cfg.kind === 'tumbling') return make + '\n-- tumbling windows of ' + sz + ': date_bin puts each event in the bin its event time falls in\nselect date_bin(\'' + sz + '\', event_time, timestamp \'' + BASE + '\') as window_start,\n       count(*) as events, round(avg(reading), 1) as average, max(reading) as max\nfrom stream_events\ngroup by 1\norder by 1;';
      if (cfg.kind === 'hopping') return make + '\n-- hopping windows of ' + sz + ' every ' + cfg.slide + ' seconds: an event belongs to every window that covers it\nselect w.window_start, count(*) as events, round(avg(e.reading), 1) as average, max(e.reading) as max\nfrom generate_series(timestamp \'' + BASE + '\' - interval \'' + (cfg.size - cfg.slide) + ' seconds\', timestamp \'' + ts(SPAN + cfg.size) + '\', interval \'' + cfg.slide + ' seconds\') as w(window_start)\n  join stream_events e on e.event_time >= w.window_start and e.event_time < w.window_start + interval \'' + sz + '\'\ngroup by w.window_start\norder by 1;';
      return make + '\n-- session windows: a new session starts when a sensor has been quiet for ' + cfg.gap + ' seconds\nwith marked as (\n  select *, case when event_time - lag(event_time) over (partition by sensor order by event_time) < interval \'' + cfg.gap + ' seconds\' then 0 else 1 end as starts\n  from stream_events\n), numbered as (\n  select *, sum(starts) over (partition by sensor order by event_time) as session\n  from marked\n)\nselect sensor, session, min(event_time) as session_start, max(event_time) + interval \'' + cfg.gap + ' seconds\' as session_end,\n       count(*) as events, round(avg(reading), 1) as average, max(reading) as max\nfrom numbered\ngroup by sensor, session\norder by sensor, session;';
    }

    function draw() {
      const R = replay(events, cfg, t);
      drawHead(R);
      body.innerHTML = '';
      const set = (k, v) => { cfg[k] = v; save(); draw(); };
      const params = [A.seg([['tumbling', 'Tumbling'], ['hopping', 'Hopping'], ['session', 'Session']], cfg.kind, (v) => set('kind', v), 'Window')];
      if (cfg.kind !== 'session') params.push(A.select('Size', [5, 10, 15, 20].map((x) => [x, x + ' s']), cfg.size, (v) => { cfg.slide = Math.min(cfg.slide, v); set('size', v); }));
      if (cfg.kind === 'hopping') params.push(A.select('Slide', [2, 5, 10].filter((x) => x < cfg.size).map((x) => [x, 'every ' + x + ' s']), Math.min(cfg.slide, cfg.size), (v) => set('slide', v)));
      if (cfg.kind === 'session') params.push(A.select('Gap', [2, 3, 4, 6].map((x) => [x, x + ' s']), cfg.gap, (v) => set('gap', v)));
      const about = { tumbling: 'Tumbling windows cut event time into fixed, non-overlapping intervals: each event is in exactly one.', hopping: 'Hopping (sliding) windows have a fixed size but start every slide; they overlap, so an event counts in ' + Math.ceil(cfg.size / cfg.slide) + ' windows.', session: 'Session windows are per key: a session lasts while events keep coming, and ends after a gap with none. Their bounds depend on the data.' }[cfg.kind];
      const counts = { ok: 0, late: 0, dropped: 0 };
      R.status.forEach((x) => counts[x.st]++);
      body.appendChild(A.sec('Windows on the event-time line', params,
        A.note(about),
        timeline(R),
        h('div.adv-legend', h('span', h('i.ds-k1'), 'reading (by sensor)'), h('span', h('i.ds-kl'), 'late, updates its window'), h('span', h('i.ds-kd'), 'late, dropped'), h('span', h('i.ds-kw'), 'window emitted'), h('span', h('i.ds-ko'), 'window open'), h('span', h('i.ds-kwm'), 'watermark')),
        h('div.adv-kpis', kpi('Arrived', R.status.length + ' / ' + events.length), kpi('On time', counts.ok), kpi('Late, accepted', counts.late), kpi('Dropped', counts.dropped), kpi('Windows emitted', R.wins.filter((w) => w.emitted).length + ' / ' + R.wins.length))));
      body.appendChild(A.sec('Watermarks and late events', [A.select('Watermark delay', [0, 1, 2, 4, 6].map((x) => [x, x + ' s']), cfg.delay, (v) => set('delay', v), 'The watermark trails the largest event time seen by this much'),
        A.select('Allowed lateness', [0, 5, 10, 20].map((x) => [x, x ? x + ' s' : 'none']), cfg.lateness, (v) => set('lateness', v), 'How long after a window is emitted a late event may still update it')],
        A.note('The watermark here is the largest event time seen so far minus ', h('b', cfg.delay + ' s'), ': the system bets that nothing older is still on its way. A longer delay waits longer before emitting (higher latency) but sees fewer late events; a shorter one answers sooner and is wrong more often. An event arriving after its window was emitted updates the result if it is at most ', h('b', cfg.lateness ? cfg.lateness + ' s' : '0 s'), ' behind the watermark (allowed lateness), and is dropped otherwise. When the stream ends, a final watermark closes every window.'),
        resultsTable(R)));
      body.appendChild(A.sec('The same windows in SQL', [A.select('Stream', [[7, 'seed 7'], [11, 'seed 11'], [42, 'seed 42']], cfg.seed, (v) => { cfg.seed = v; events = generate(v); t = Math.min(t, endT()); save(); draw(); })],
        A.note('Over a table holding the stream so far, a window is just a GROUP BY: on the bin (date_bin) for tumbling windows, on a series of overlapping start times for hopping windows, and on a running count of gaps (window functions) for session windows. A table query sees every row, late ones included, so its answer is the one the stream reaches after the final watermark (with nothing dropped); a stream system has to emit its answers before it knows it has seen everything.'),
        A.sqlBox(app, sqlText(R), { note: UI.plural(R.status.length, 'event') + ' so far' })));
    }
    const kpi = (k, v) => h('div.adv-kpi', h('div.k', k), h('div.v', String(v)));
    return { render() { draw(); }, onHide() { stop(); }, destroy() { stop(); } };
  }

  UI.registerView({ id: 'stream', title: 'Streams', icon: 'clock', group: 'Big data', order: 75, create });
})(typeof window !== 'undefined' ? window : globalThis);
