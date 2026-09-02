// The cluster workbench. The shared kit lives here (UI.CK): a recording of a simulated run (frames, and the
// messages with the frames they were sent and delivered in), a live recorder that steps a K.Cluster simulation
// and replays it from the start when the user changes the past, a player with its own timeline, and a canvas
// that draws nodes, links, cuts and messages in flight. The Cluster view picks a scenario (UI.CK.scenarios,
// filled by cluster-scenarios.js) and plays it. The other distributed views use the same kit at run time, so
// the order the files load in does not matter.
(function (root) {
  'use strict';
  const K = root.K;
  const UI = K.UI;
  const { h, s } = UI;
  const CK = UI.CK = UI.CK || {};
  CK.scenarios = CK.scenarios || [];
  const C = () => K.Cluster;

  // ---- small helpers ------------------------------------------------------------------------------------------
  /** the id of the network hub a layout can put among its nodes ({ id: CK.HUB, kind: 'hub' }) */
  CK.HUB = 'network';
  /** a node's spoke to the hub, for a layout's links */
  CK.spokes = (ids) => ids.map((id) => [id, CK.HUB, 'spoke']);
  CK.theatre = function () {
    const c = C();
    if (!c.theatreSql && K.SAMPLES && K.SAMPLES.theatre) c.theatreSql = K.SAMPLES.theatre.sql;
    return c.theatre();
  };
  /** run slow work after the browser has painted a loading note */
  CK.later = (el, text, f) => {
    el.innerHTML = '';
    el.appendChild(h('div.ck-loading', h('span.ck-spin'), text));
    setTimeout(() => { try { f(); } catch (e) { console.error(e); el.innerHTML = ''; el.appendChild(h('div.res-err', e.message)); } }, 30);
  };
  CK.hue = (str) => { let x = 0; for (const ch of String(str)) x = (x * 31 + ch.charCodeAt(0)) >>> 0; return x % 8; };
  CK.bytes = (n) => (n < 1024 ? n.toLocaleString('en-US') + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB');
  CK.num = (n) => Number(n).toLocaleString('en-US');
  CK.fix = (x, d) => (Number.isInteger(x) ? String(x) : x.toFixed(d === undefined ? 2 : d));
  CK.select = (label, opts, value, onchange, title) => {
    const numeric = typeof opts[0][0] === 'number';
    return h('label.ck-field', { title: title || null }, label ? h('span', label) : null,
      h('select.inp.ck-sel', { 'aria-label': label || title, onchange: (e) => onchange(numeric ? Number(e.target.value) : e.target.value) },
        opts.map(([v, l]) => h('option', { value: String(v), selected: String(v) === String(value) }, l))));
  };
  CK.check = (label, value, onchange, title) => h('label.ck-check', { title: title || null }, h('input', { type: 'checkbox', checked: !!value, onchange: (e) => onchange(e.target.checked) }), h('span', label));
  CK.seg = (opts, value, onchange) => h('div.seg.ck-seg', opts.map(([v, l]) => h('button' + (v === value ? '.on' : ''), { type: 'button', 'aria-pressed': String(v === value), onclick: () => onchange(v) }, l)));
  CK.about = (text) => h('p.ck-about', text);
  CK.section = (title, ...kids) => h('section.ck-sec', title ? h('h3.ck-h', title) : null, ...kids);
  CK.badge = (text, cls) => h('span.ck-badge' + (cls ? '.' + cls : ''), text);
  CK.ok = (good, text) => h('div.ck-verdict' + (good ? '.good' : '.bad'), UI.icon(good ? 'check' : 'warn'), h('span', text));
  CK.pairs = (ids) => { const out = []; ids.forEach((a, i) => ids.slice(i + 1).forEach((b) => out.push([a, b]))); return out; };
  /**
   * points on an ellipse in the given (cyclic) order, starting at the top, in the 0..1 box. On a narrow canvas
   * (opts.narrow) the cards are wide for the space, so the ellipse stands up and the points go down its two sides in
   * turn, evenly spaced in height, the first at the top and (when the rest are odd in number) the middle one at the
   * bottom: still in convex position and in the same cyclic order, and no two cards at one height
   */
  CK.circle = (ids, opts) => {
    opts = Object.assign({ cx: 0.5, cy: 0.5, rx: 0.5, ry: 0.5, start: -Math.PI / 2 }, opts);
    if (opts.narrow && ids.length > 2) {
      const n = ids.length, m = n - 1, k = Math.floor(m / 2), L = 2 * k + (m % 2);
      const at = (id, level, side) => { const y = -1 + (2 * level) / L; return { id, x: 0.5 + side * 0.5 * Math.sqrt(Math.max(0, 1 - y * y)), y: (y + 1) / 2 }; };
      const out = [{ id: ids[0], x: 0.5, y: 0 }];
      for (let j = 1; j <= k; j++) out.push(at(ids[j], 2 * j - 1, 1));
      if (m % 2) out.push({ id: ids[k + 1], x: 0.5, y: 1 });
      for (let j = 1; j <= k; j++) out.push(at(ids[n - j], 2 * j, -1));
      return out;
    }
    return ids.map((id, i) => { const a = opts.start + (2 * Math.PI * i) / ids.length; return { id, x: opts.cx + opts.rx * Math.cos(a), y: opts.cy + opts.ry * Math.sin(a) }; });
  };
  CK.col = (ids, x, y0, y1) => ids.map((id, i) => ({ id, x, y: ids.length === 1 ? (y0 + y1) / 2 : y0 + ((y1 - y0) * i) / (ids.length - 1) }));
  CK.row = (ids, y, x0, x1) => ids.map((id, i) => ({ id, y, x: ids.length === 1 ? (x0 + x1) / 2 : x0 + ((x1 - x0) * i) / (ids.length - 1) }));
  const short = (v) => { let t; try { t = JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? String(x) : x)); } catch (e) { t = String(v); } return t && t.length > 80 ? t.slice(0, 77) + '…' : t; };
  CK.short = short;

  const REASON = { lost: 'lost on the link', partition: 'the network is partitioned', 'receiver down': 'the receiver is down', 'sender down': 'the sender is down', 'no such node': 'no such node' };
  /** a trace entry in words */
  CK.describe = function (e, note) {
    switch (e.kind) {
      case 'send': return e.from + ' → ' + e.to + ': ' + e.type;
      case 'dup': return 'the network duplicates ' + e.type + ' from ' + e.from + ' to ' + e.to;
      case 'deliver': return e.to + ' receives ' + e.type + ' from ' + e.from;
      case 'drop': return e.type + ' from ' + e.from + ' to ' + e.to + ' is dropped: ' + (REASON[e.reason] || e.reason);
      case 'timer': return e.node + ': ' + e.name + ' timer fires';
      case 'crash': return e.node + ' crashes';
      case 'restart': return e.node + ' restarts';
      case 'partition': return 'the network splits: ' + e.groups.map((g) => '{' + g.join(', ') + '}').join(' | ') + ' and the rest';
      case 'heal': return 'the network heals';
      case 'block': return 'the link ' + e.from + ' → ' + e.to + ' is cut';
      case 'unblock': return 'the link ' + e.from + ' → ' + e.to + ' works again';
      case 'note': { const t = note && note(e); return t === undefined ? e.node + ': ' + e.what + (e.data === undefined ? '' : ' ' + short(e.data)) : t; }
    }
    return e.kind;
  };
  /** one line for a frame: what happened, what it led to, and how many messages went out */
  CK.frameText = function (f, note) {
    if (!f) return '';
    if (f.user) return f.user;
    if (!f.ev.length) return f.i === 0 ? 'The start. Press play or step forward.' : '';
    const main = f.ev.find((e) => e.kind !== 'send' && e.kind !== 'note' && e.kind !== 'dup') || f.ev[0];
    if (main.kind === 'send' && f.ev.every((e) => e.kind === 'send')) {
      const pairs = [...new Set(f.ev.map((e) => e.from + ' → ' + e.to))], types = [...new Set(f.ev.map((e) => e.type))];
      if (f.ev.length > 1) return (pairs.length === 1 ? pairs[0] : pairs.length + ' links') + ': ' + f.ev.length + ' ' + types.join(', ') + ' messages sent';
    }
    const parts = [CK.describe(main, note)];
    for (const e of f.ev) if (e !== main && e.kind === 'note') { const t = CK.describe(e, note); if (t) parts.push(t); }
    const sends = f.ev.filter((e) => e.kind === 'send' && e !== main);
    if (sends.length === 1) parts.push('sends ' + sends[0].type + ' to ' + sends[0].to);
    else if (sends.length > 1) { const types = [...new Set(sends.map((e) => e.type))]; parts.push('sends ' + sends.length + ' messages (' + types.join(', ') + ')'); }
    return parts.filter(Boolean).join(' · ');
  };

  // ---- a recording ------------------------------------------------------------------------------------------------
  /**
   * frames: [{ i, t, ev (trace entries), s (the scenario's captured state), n (network: up, groups, blocked), user }].
   * msgs: every message with f0 (frame it was sent in) and f1 (frame it was delivered or dropped in).
   */
  class Rec {
    constructor() { this.frames = []; this.msgs = []; this.byId = new Map(); this.netState = { up: {}, groups: null, blocked: {} }; }
    get last() { return this.frames.length - 1; }
    add(t, ev, st, extra) {
      const i = this.frames.length;
      const f = Object.assign({ i, t, ev: (ev || []).slice(), s: st }, extra || {});
      this.frames.push(f);
      for (const e of f.ev) this.track(e, i);
      f.n = this.netState;
      return f;
    }
    /** add an entry to an existing frame (grouped recordings) */
    more(f, e) { f.ev.push(e); this.track(e, f.i); f.n = this.netState; }
    track(e, i) {
      const k = e.kind;
      if (k === 'send' || k === 'dup') {
        const src = k === 'dup' ? this.byId.get(e.copyOf) : null;
        const m = { id: e.msg, from: e.from, to: e.to, type: e.type, sent: e.t, at: e.at, f0: i, f1: Infinity, bytes: e.bytes || (src && src.bytes) || 0, body: e.body || (src && src.body), dup: k === 'dup' };
        this.msgs.push(m); this.byId.set(e.msg, m);
      } else if (k === 'deliver' || k === 'drop') {
        const m = this.byId.get(e.msg);
        if (m) { m.f1 = i; m.end = e.t; m.fate = k; m.reason = e.reason; }
      } else if (['crash', 'restart', 'partition', 'heal', 'block', 'unblock'].includes(k)) {
        const n = this.netState = { up: Object.assign({}, this.netState.up), groups: this.netState.groups, blocked: Object.assign({}, this.netState.blocked) };
        if (k === 'crash') n.up[e.node] = false;
        else if (k === 'restart') n.up[e.node] = true;
        else if (k === 'partition') n.groups = e.groups.map((g) => g.slice());
        else if (k === 'heal') { n.groups = null; n.blocked = {}; }
        else if (k === 'block') n.blocked[e.from + '>' + e.to] = true;
        else delete n.blocked[e.from + '>' + e.to];
      }
    }
    inFlight(i) { return this.msgs.filter((m) => m.f0 <= i && i < m.f1); }
    endedAt(i) { return this.msgs.filter((m) => m.f1 === i); }
  }
  CK.Rec = Rec;
  /** the network as a frame saw it */
  CK.up = (f, id) => !f || !f.n || f.n.up[id] !== false;
  CK.groupOf = (f, id) => { const g = f && f.n && f.n.groups; if (!g) return 0; const i = g.findIndex((x) => x.includes(id)); return i < 0 ? g.length : i; };
  CK.canTalk = (f, a, b) => !(f && f.n && (f.n.blocked[a + '>' + b] || f.n.blocked[b + '>' + a])) && CK.groupOf(f, a) === CK.groupOf(f, b);

  /**
   * a recording of a finished trace. opts: group(e) gives a key, and consecutive entries with the same key share a
   * frame; apply(e) updates the caller's running state and snap() copies it into the frame
   */
  CK.fromTrace = function (trace, opts) {
    opts = opts || {};
    const rec = opts.rec || new Rec();
    if (!rec.frames.length) rec.add(opts.t0 || 0, [], opts.snap ? opts.snap() : null, { user: opts.start || null });
    let cur = null, key = null;
    for (const e of trace) {
      if (opts.skip && opts.skip(e)) continue;
      const k = opts.group ? opts.group(e) : null;
      if (opts.apply) opts.apply(e);
      if (cur && k !== null && k === key) rec.more(cur, e);
      else { cur = rec.add(e.t, [e], null); key = k; }
      if (opts.snap) cur.s = opts.snap();
    }
    return rec;
  };

  // ---- a live simulation, stepped and recorded ------------------------------------------------------------------
  const GENERIC = {
    crash: (net, o) => { net.crash(o.id); return o.id + ' crashes (you clicked)'; },
    restart: (net, o) => { net.restart(o.id); return o.id + ' restarts'; },
    isolate: (net, o) => { net.partition([[o.id]]); return 'partition: ' + o.id + ' is cut off from everyone else'; },
    partition: (net, o) => { net.partition(o.groups); return 'partition: ' + o.groups.map((g) => '{' + g.join(', ') + '}').join(' | '); },
    heal: (net) => { net.heal(); return 'the network heals: every link works again'; },
    cut: (net, o) => { net.block(o.a, o.b); net.block(o.b, o.a); return 'the link ' + o.a + ' – ' + o.b + ' is cut'; },
    mend: (net, o) => { net.unblock(o.a, o.b); net.unblock(o.b, o.a); return 'the link ' + o.a + ' – ' + o.b + ' works again'; },
  };
  /**
   * def: make() -> a simulation with .net; capture(sim, memo, t) -> plain state for a frame; apply(sim, op) for the
   * scenario's own operations (returns a label); done(sim) when the run is over. User operations are kept with the
   * step count they happened after, so changing the past replays the run from the start, deterministically, and
   * applies them at the same points.
   */
  class Live {
    constructor(def) { this.def = def; this.ops = []; this.cap = def.maxFrames || 6000; this.reset(); }
    reset() {
      this.sim = this.def.make();
      this.net = this.sim.net;
      this.rec = new Rec();
      for (const id of this.net.ids()) this.rec.netState.up[id] = this.net.isUp(id);
      this.k = 0; this.oi = 0; this.memo = {}; this.finished = false;
      this.rec.add(this.net.clock, [], this.snap(), { k: 0 });
      this.applyOps();
    }
    snap() { return this.def.capture(this.sim, this.memo, this.net.clock); }
    applyOps() {
      while (this.oi < this.ops.length && this.ops[this.oi].k === this.k) {
        const op = this.ops[this.oi++];
        const n0 = this.net.trace.length;
        const g = GENERIC[op.kind];
        const label = g ? g(this.net, op, this.sim) : this.def.apply(this.sim, op);
        op.fi = this.rec.add(this.net.clock, this.net.trace.slice(n0), this.snap(), { k: this.k, user: label || op.label || op.kind }).i;
        this.finished = false;
      }
    }
    step() {
      if (this.finished) return false;
      if (this.def.done && this.def.done(this.sim)) { this.finished = true; return false; }
      const ev = this.net.step();
      if (!ev) { this.finished = true; return false; }
      this.k++;
      // steps the scenario finds uninteresting (heartbeats) join the previous frame instead of making one
      const lastF = this.rec.frames[this.rec.last];
      if (this.def.quiet && this.def.quiet(ev) && !lastF.user && this.rec.last > 0) { for (const e of ev) this.rec.more(lastF, e); lastF.k = this.k; lastF.s = this.snap(); }
      else this.rec.add(this.net.clock, ev, this.snap(), { k: this.k });
      this.applyOps();
      return true;
    }
    /** run on until the clock would pass t, the run ends, or the frames run out */
    extend(t) {
      const n0 = this.rec.frames.length;
      for (let n = 0; n < 30000 && this.rec.frames.length < this.cap; n++) {
        const q = this.net.queue;
        if (q.length && q[0].at > t && this.rec.frames.length > n0) break;
        if (!this.step()) break;
      }
      return this.rec.frames.length > n0;
    }
    get full() { return this.rec.frames.length >= this.cap; }
    /** apply op at frame i; returns the frame that shows it */
    intervene(i, op) {
      op = Object.assign({}, op, { k: this.rec.frames[i].k, fi: undefined });
      const keep = this.ops.filter((o) => o.fi !== undefined && o.fi <= i);
      if (i === this.rec.last && keep.length === this.ops.length && !this.full) { this.ops.push(op); this.applyOps(); }
      else {
        this.ops = keep.concat([op]);
        this.reset();
        while (op.fi === undefined && this.step());
        if (op.fi === undefined) { this.applyOpsLate(op); }
      }
      this.extend(this.rec.frames[op.fi].t + (this.def.ahead || 300));
      return op.fi;
    }
    // the replay ended before reaching the op's step (the run was over): apply it at the end
    applyOpsLate(op) { op.k = this.k; this.oi = this.ops.indexOf(op); this.finished = false; this.applyOps(); }
  }
  CK.Live = Live;
  /**
   * a playable source from a live simulation. def as for Live plus horizon (first run length), chunk (how much to
   * add when the player reaches the end), and the drawing hooks (layout, card, panel, menu, actions, note)
   */
  CK.liveSrc = function (def) {
    const live = new Live(def);
    live.extend(def.horizon || 600);
    // Object.assign would copy a getter's value once: rec and sim must follow the replays
    const src = Object.assign({}, def, {
      live,
      extend() { if (live.finished || live.full) return false; return live.extend(live.net.clock + (def.chunk || 400)); },
      intervene(i, op) { return live.intervene(i, op); },
      ended() { return live.finished; },
    });
    Object.defineProperty(src, 'rec', { get: () => live.rec });
    Object.defineProperty(src, 'sim', { get: () => live.sim });
    return src;
  };

  // ---- the player ----------------------------------------------------------------------------------------------------
  const SPEEDS = [0.25, 0.5, 1, 2, 4, 8, 16];
  class Player {
    /** opts: onFrame(i), onTick(t); base: time units per second at 1x */
    constructor(opts) {
      this.opts = opts; this.i = 0; this.t = 0; this.playing = false; this.src = null; this.raf = 0;
      this.mult = UI.store.get('ck.speed', 1);
      if (!SPEEDS.includes(this.mult)) this.mult = 1;
      this.el = this.build();
    }
    build() {
      this.playBtn = UI.btn('run', null, 'Play (space)', () => this.toggle(), 'icon ck-play');
      this.slider = h('input.tl-range.ck-range', { type: 'range', min: '0', max: '0', value: '0', 'aria-label': 'Position in the cluster run', oninput: (e) => { this.pause(); this.go(+e.target.value); } });
      this.clock = h('span.ck-clock', '');
      this.speed = h('select.tl-kind.ck-speed', { 'aria-label': 'Playback speed', title: 'Playback speed', onchange: (e) => { this.mult = +e.target.value; UI.store.set('ck.speed', this.mult); } }, SPEEDS.map((v) => h('option', { value: String(v), selected: v === this.mult }, v + '×')));
      return h('div.ck-player', { role: 'group', 'aria-label': 'Cluster timeline' },
        UI.btn('first', null, 'Back to the start', () => { this.pause(); this.go(0); }, 'icon'),
        UI.btn('stepBack', null, 'Step back (←)', () => this.step(-1), 'icon'),
        this.playBtn,
        UI.btn('step', null, 'Step forward (→)', () => this.step(1), 'icon'),
        UI.btn('last', null, 'To the latest event', () => { this.pause(); this.go(this.rec.last); }, 'icon'),
        this.slider, this.clock, this.speed);
    }
    get rec() { return this.src.rec; }
    load(src, i) { this.pause(); this.src = src; this.go(i || 0); }
    go(i, keepT) {
      const fr = this.rec.frames;
      this.i = Math.max(0, Math.min(fr.length - 1, i));
      if (!keepT) this.t = fr[this.i].t;
      this.sync();
      this.opts.onFrame(this.i);
      this.opts.onTick(this.t);
    }
    sync() {
      this.slider.max = String(this.rec.last);
      this.slider.value = String(this.i);
      this.clock.textContent = 't = ' + CK.fix(Math.round(this.t * 10) / 10, 1) + ' · ' + (this.i + 1) + '/' + this.rec.frames.length + (this.src.ended && !this.src.ended() ? '+' : '');
      this.playBtn.innerHTML = '';
      this.playBtn.appendChild(UI.icon(this.playing ? 'pause' : 'run'));
      this.playBtn.title = this.playing ? 'Pause (space)' : 'Play (space)';
    }
    step(d) {
      this.pause();
      if (d > 0 && this.i >= this.rec.last && this.src.extend) this.src.extend();
      this.go(this.i + d);
    }
    toggle() { if (this.playing) this.pause(); else this.play(); }
    play() {
      if (this.playing || !this.src) return;
      if (this.i >= this.rec.last && !(this.src.extend && this.src.extend())) this.go(0);
      this.playing = true; this.lastNow = performance.now();
      this.sync();
      const loop = (now) => { if (!this.playing) return; this.tick(now); if (this.playing) this.raf = requestAnimationFrame(loop); };
      this.raf = requestAnimationFrame(loop);
    }
    pause() { if (!this.playing) return; this.playing = false; cancelAnimationFrame(this.raf); if (this.src) this.sync(); }
    tick(now) {
      const dt = Math.min(0.1, (now - this.lastNow) / 1000);
      this.lastNow = now;
      this.t += dt * (this.src.base || 60) * this.mult;
      let fr = this.rec.frames, i = this.i;
      if (i + 1 >= fr.length && this.src.extend) { this.src.extend(); fr = this.rec.frames; }
      while (i + 1 < fr.length && fr[i + 1].t <= this.t) { i++; if (i + 1 >= fr.length && this.src.extend) { this.src.extend(); fr = this.rec.frames; } }
      if (i + 1 >= fr.length && this.t >= fr[i].t) { this.t = fr[i].t; this.playing = false; }
      if (i !== this.i) { this.i = i; this.opts.onFrame(i); }
      this.sync();
      this.opts.onTick(this.t);
    }
    destroy() { this.pause(); }
  }
  CK.Player = Player;

  // ---- the canvas -------------------------------------------------------------------------------------------------------
  /** rectangles and segments in the canvas's pixel space, for placing labels where nothing else is */
  const hit = (a, b, pad) => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
  const segHits = (p, q, r) => {
    // does the segment p-q pass through rectangle r? clip it to r (Liang-Barsky)
    let t0 = 0, t1 = 1;
    const dx = q[0] - p[0], dy = q[1] - p[1];
    for (const [pp, qq] of [[-dx, p[0] - r.x], [dx, r.x + r.w - p[0]], [-dy, p[1] - r.y], [dy, r.y + r.h - p[1]]]) {
      if (pp === 0) { if (qq < 0) return false; continue; }
      const t = qq / pp;
      if (pp < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
    }
    return t0 < t1;
  };
  /** the convex hull of points [[x, y]] */
  const hull = (pts) => {
    const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const x of p) { while (lo.length > 1 && cr(lo[lo.length - 2], lo[lo.length - 1], x) <= 0) lo.pop(); lo.push(x); }
    for (const x of p.reverse()) { while (up.length > 1 && cr(up[up.length - 2], up[up.length - 1], x) <= 0) up.pop(); up.push(x); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  };
  const inside = (pt, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
  /**
   * where a label of size w x h goes beside a point on a line running (dx, dy): just off the line on either side,
   * or a little along it, wherever it does not touch a card, a drawn link, another label or the canvas's edge.
   * Returns the label's box, or null if there is no room.
   */
  CK.placeLabel = function (px, py, dx, dy, w, h, avoid) {
    const len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
    let nx = -uy, ny = ux;
    if (ny > 0.0001 || (Math.abs(ny) <= 0.0001 && nx < 0)) { nx = -nx; ny = -ny; }
    const d = (w / 2) * Math.abs(nx) + (h / 2) * Math.abs(ny) + 5;
    const along = [0, 0.6, -0.6, 1.2, -1.2];
    for (const k of along) {
      for (const side of [1, -1]) {
        const cx = px + side * nx * d + ux * k * (w * Math.abs(ux) + h * Math.abs(uy) + 6), cy = py + side * ny * d + uy * k * (w * Math.abs(ux) + h * Math.abs(uy) + 6);
        const r = { x: cx - w / 2, y: cy - h / 2, w, h };
        if (avoid.bounds && (r.x < avoid.bounds.x || r.y < avoid.bounds.y || r.x + r.w > avoid.bounds.x + avoid.bounds.w || r.y + r.h > avoid.bounds.y + avoid.bounds.h)) continue;
        if (avoid.boxes.some((b) => hit(r, b, 3))) continue;
        if (avoid.labels.some((b) => hit(r, b, 2))) continue;
        const rr = { x: r.x - 2, y: r.y - 2, w: r.w + 4, h: r.h + 4 };
        if (avoid.segs.some(([p, q]) => segHits(p, q, rr))) continue;
        return r;
      }
    }
    return null;
  };

  /**
   * nodes as cards over an SVG layer of links, with message dots between them. Coordinates are 0..1 inside an inset
   * box, so the drawing fits any width; the canvas grows taller when cards would touch. A partition draws a dashed
   * zone around each side. Message and link labels sit beside their line, clear of cards, links and each other,
   * and are left out when there is no room (the dot's tooltip still says what it is). opts: onNode(id, el), onLink(a, b)
   */
  class Canvas {
    constructor(opts) {
      this.opts = opts || {};
      this.svg = s('svg', { class: 'ck-links', viewBox: '0 0 100 100', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
      this.cardsEl = h('div.ck-cards');
      this.dotsEl = h('div.ck-dots', { 'aria-hidden': 'true' });
      this.marksEl = h('div.ck-dots', { 'aria-hidden': 'true' });
      this.inner = h('div.ck-in', this.svg, this.marksEl, this.cardsEl, this.dotsEl);
      this.el = h('div.ck-canvas', this.inner);
      this.key = null; this.pos = new Map(); this.cards = new Map(); this.linkEls = []; this.flight = []; this.ended = []; this.pool = [];
    }
    get compact() { return this.el.clientWidth > 0 && this.el.clientWidth < 520; }
    layout(L) {
      const key = JSON.stringify([L.nodes.map((n) => [n.id, +n.x.toFixed(3), +n.y.toFixed(3), n.kind]), L.links, L.height]);
      this.el.classList.toggle('compact', this.compact);
      if (key === this.key) return;
      this.key = key; this.L = L; this.grow = 0;
      this.el.style.height = (L.height || 300) + 'px';
      this.pos = new Map(L.nodes.map((n) => [n.id, n]));
      this.svg.innerHTML = ''; this.marksEl.innerHTML = ''; this.cardsEl.innerHTML = ''; this.cards.clear(); this.linkEls = []; this.hubCount = null;
      this.zones = s('g', { class: 'ck-zones' });
      this.svg.appendChild(this.zones);
      for (const ln of L.links || []) {
        const [a, b, cls, label] = ln;
        const p = this.pos.get(a), q = this.pos.get(b);
        if (!p || !q) continue;
        const line = s('line', { x1: p.x * 100, y1: p.y * 100, x2: q.x * 100, y2: q.y * 100, class: 'ck-link' + (cls ? ' ' + cls : ''), 'vector-effect': 'non-scaling-stroke', 'data-audit': 'edge' });
        const hitEl = s('line', { x1: p.x * 100, y1: p.y * 100, x2: q.x * 100, y2: q.y * 100, class: 'ck-hit', 'vector-effect': 'non-scaling-stroke', 'data-audit': 'ignore' }, s('title', { text: !this.noLinks ? 'Click to cut or mend the link ' + a + ' – ' + b : a + ' – ' + b }));
        if (this.opts.onLink && !this.noLinks) hitEl.addEventListener('click', () => this.opts.onLink(a, b)); else hitEl.style.cursor = 'default';
        this.svg.appendChild(line); this.svg.appendChild(hitEl);
        // the cut mark is drawn on the link itself, like an arrowhead
        const mark = h('div.ck-cut', { style: { left: ((p.x + q.x) / 2) * 100 + '%', top: ((p.y + q.y) / 2) * 100 + '%' }, title: 'cut', 'data-audit': 'ignore' }, UI.icon('x'));
        const lab = label ? h('div.ck-linklab', { 'data-audit': 'label' }, label) : null;
        this.marksEl.appendChild(mark); if (lab) this.marksEl.appendChild(lab);
        this.linkEls.push({ a, b, line, hit: hitEl, mark, lab });
      }
      for (const n of L.nodes) {
        if (n.kind === 'hub') {
          // the network every node hangs on: messages travel sender → hub → receiver along the spokes
          this.hubCount = h('b.ck-hubn');
          const el = h('div.ck-hub', { 'data-audit': 'node', title: 'the network: every message passes through it', style: { left: n.x * 100 + '%', top: n.y * 100 + '%' } }, h('span', 'network'), this.hubCount);
          this.cardsEl.appendChild(el);
          this.cards.set(n.id, el);
          continue;
        }
        const el = h('button.ck-node' + (n.kind ? '.k-' + n.kind : ''), { type: 'button', 'data-audit': 'node', style: { left: n.x * 100 + '%', top: n.y * 100 + '%' }, onclick: (e) => { if (this.opts.onNode) this.opts.onNode(n.id, e.currentTarget); } });
        this.cardsEl.appendChild(el);
        this.cards.set(n.id, el);
      }
    }
    /** draw a frame: cards from cardOf(id) -> { title, badge, badgeCls, cls, lines, timer } */
    frame(f, rec, cardOf) {
      this.f = f;
      for (const [id, el] of this.cards) {
        if (id === CK.HUB) continue;
        const c = cardOf(id) || { title: id };
        const up = CK.up(f, id);
        el.className = 'ck-node' + (this.pos.get(id).kind ? ' k-' + this.pos.get(id).kind : '') + (c.cls ? ' ' + c.cls : '') + (up ? '' : ' down') + (f.n && f.n.groups ? ' grp g' + (CK.groupOf(f, id) % 4) : '');
        el.innerHTML = '';
        const head = h('div.ckn-h', h('span.ckn-t', c.title || id), !up ? CK.badge('down', 'bad') : c.badge ? CK.badge(c.badge, c.badgeCls) : null);
        el.appendChild(head);
        for (const l of c.lines || []) if (l !== '' && l !== null && l !== undefined) el.appendChild(h('div.ckn-l', l));
        el.timer = c.timer && up ? c.timer : null;
        if (el.timer) { const ring = s('svg', { class: 'ck-ring', viewBox: '0 0 20 20', 'data-audit': 'ignore' }, s('circle', { cx: 10, cy: 10, r: 8, class: 'r0' }), s('circle', { cx: 10, cy: 10, r: 8, class: 'r1', 'stroke-dasharray': '50.27', transform: 'rotate(-90 10 10)' }), s('title', { text: c.timer.label || 'timer' })); el.appendChild(ring); el.ring = ring.lastChild.previousSibling; }
        el.setAttribute('aria-label', [...el.children].map((x) => x.textContent).join('. '));
      }
      this.fit();
      // a cut link gets a mark; a partition shows as red links, a zone around each side and the sides' colours on the cards
      // a spoke is cut when its node is not on the side that keeps most of the cluster
      const groups = f.n && f.n.groups;
      let main = 0;
      if (groups) { const ids = [...this.cards.keys()].filter((x) => x !== CK.HUB && this.pos.get(x).kind !== 'client'), cnt = {}; for (const x of ids) { const g = CK.groupOf(f, x); cnt[g] = (cnt[g] || 0) + 1; } main = +Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a] || a - b)[0]; }
      for (const l of this.linkEls) { const ok = l.b === CK.HUB ? !groups || CK.groupOf(f, l.a) === main : CK.canTalk(f, l.a, l.b); l.line.classList.toggle('cut', !ok); l.mark.hidden = !l.clear || !(f.n && (f.n.blocked[l.a + '>' + l.b] || f.n.blocked[l.b + '>' + l.a])); }
      this.drawZones(f);
      this.placeLinkLabels();
      const shown = (m) => m.from !== m.to && this.pos.has(m.from) && this.pos.has(m.to) && !(this.hide && this.hide(m));
      this.flight = rec.inFlight(f.i).filter(shown);
      this.ended = rec.endedAt(f.i).filter(shown);
      for (const m of this.ended) if (m.fate === 'deliver') { const el = this.cards.get(m.to); if (el) el.classList.add('got'); }
    }
    /** card boxes in pixels; the canvas grows taller (never shorter, within one layout) until no two cards touch */
    fit() {
      const GAP = 12, M = 6;
      // the inset leaves room for the widest and tallest cards at the edges: a card at x keeps its whole box inside
      const sizes = [...this.cards].map(([id, el]) => [this.pos.get(id), el.offsetWidth, el.offsetHeight]);
      const pad = (sz, k, total) => Math.max(8, ...sz.map(([n, w, hh]) => { const v = k === 'x' ? n.x : n.y, half = (k === 'x' ? w : hh) / 2 + M; return v < 0.5 ? (half - v * total) / (1 - 2 * v) : v > 0.5 ? (half - (1 - v) * total) / (2 * v - 1) : 0; }));
      const setPads = () => {
        const cw = this.el.clientWidth, ch = this.el.clientHeight;
        const px = Math.ceil(pad(sizes, 'x', cw)), py = Math.ceil(pad(sizes, 'y', ch));
        Object.assign(this.inner.style, { left: px + 'px', right: px + 'px', top: py + 'px', bottom: py + 'px' });
      };
      const measure = () => {
        setPads();
        this.W = this.inner.clientWidth || 1; this.H = this.inner.clientHeight || 1;
        this.boxes = new Map([...this.cards].map(([id, el]) => { const n = this.pos.get(id), w = el.offsetWidth, hh = el.offsetHeight; return [id, { x: n.x * this.W - w / 2, y: n.y * this.H - hh / 2, w, h: hh }]; }));
      };
      measure();
      // the canvas grows taller (never shorter, within one layout) until no two cards touch
      for (let round = 0; round < 3; round++) {
        let need = 0;
        const ids = [...this.boxes.keys()];
        for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
          const a = this.boxes.get(ids[i]), b = this.boxes.get(ids[j]);
          if (!hit(a, b, GAP)) continue;
          const dy = Math.abs(this.pos.get(ids[i]).y - this.pos.get(ids[j]).y);
          if (dy > 0.02) need = Math.max(need, ((a.h + b.h) / 2 + GAP) / dy - this.H);
        }
        if (need < 0.5) break;
        this.grow += Math.ceil(need);
        this.el.style.height = ((this.L.height || 300) + this.grow) + 'px';
        measure();
      }
      this.half = new Map([...this.cards].map(([id, el]) => [id, [el.offsetWidth / 2 + 4, el.offsetHeight / 2 + 4]]));
      // where labels may go: inside the canvas, around the cards, beside the links that are drawn
      const ox = this.inner.offsetLeft, oy = this.inner.offsetTop;
      this.bounds = { x: -ox + 3, y: -oy + 3, w: this.el.clientWidth - 6, h: this.el.clientHeight - 6 };
      // a link that would pass over a third card (on a narrow canvas the cards crowd the lines) is not drawn: it would
      // look like it ends there. Its messages still fly
      this.segs = [];
      for (const l of this.linkEls) {
        const p = this.pos.get(l.a), q = this.pos.get(l.b), seg = [[p.x * this.W, p.y * this.H], [q.x * this.W, q.y * this.H]];
        l.clear = ![...this.boxes].some(([id, b]) => id !== l.a && id !== l.b && segHits(seg[0], seg[1], { x: b.x - 2, y: b.y - 2, w: b.w + 4, h: b.h + 4 }));
        l.line.style.display = l.hit.style.display = l.clear ? '' : 'none';
        l.seg = seg;
        if (l.clear) this.segs.push(seg);
      }
    }
    drawZones(f) {
      this.zones.innerHTML = '';
      const groups = f.n && f.n.groups;
      if (!groups) return;
      const ids = [...this.cards.keys()].filter((x) => x !== CK.HUB);
      // the listed sides, and the rest
      const sides = [];
      for (let g = 0; g <= groups.length; g++) sides.push(ids.filter((id) => CK.groupOf(f, id) === g));
      sides.forEach((mine, g) => {
        if (!mine.length || mine.length === ids.length) return;
        const pts = [];
        const R = 10, P = 9;
        for (const id of mine) {
          const b = this.boxes.get(id);
          const x0 = b.x - P, y0 = b.y - P, x1 = b.x + b.w + P, y1 = b.y + b.h + P;
          for (const [cx, cy, a0] of [[x1 - R, y1 - R, 0], [x0 + R, y1 - R, 90], [x0 + R, y0 + R, 180], [x1 - R, y0 + R, 270]]) for (let k = 0; k <= 3; k++) { const a = ((a0 + k * 30) * Math.PI) / 180; pts.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]); }
        }
        const bx = this.bounds;
        const poly = hull(pts).map(([x, y]) => [Math.max(bx.x, Math.min(bx.x + bx.w, x)), Math.max(bx.y, Math.min(bx.y + bx.h, y))]);
        // a zone that would take in a card from another side says nothing: the cards' colours still tell the sides apart
        const clash = [...this.cards.keys()].some((id) => {
          if (mine.includes(id)) return false;
          const b = this.boxes.get(id), c = [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h], [b.x + b.w / 2, b.y + b.h / 2]];
          return c.some((p) => inside(p, poly)) || poly.some((p, i) => segHits(p, poly[(i + 1) % poly.length], b));
        });
        if (clash) return;
        this.zones.appendChild(s('polygon', { points: poly.map(([x, y]) => ((x / this.W) * 100).toFixed(3) + ',' + ((y / this.H) * 100).toFixed(3)).join(' '), class: 'ck-zone z' + (g % 4), 'vector-effect': 'non-scaling-stroke', 'data-audit': 'group' }));
      });
    }
    placeLinkLabels() {
      this.fixed = [];
      for (let k = 0; k < this.linkEls.length; k++) {
        const l = this.linkEls[k];
        if (!l.lab) continue;
        if (!l.clear) { l.lab.hidden = true; continue; }
        const [p, q] = l.seg;
        l.lab.hidden = false;
        const w = l.lab.offsetWidth, hh = l.lab.offsetHeight;
        const avoid = { boxes: [...this.boxes.values()], labels: this.fixed, segs: this.segs.filter((x) => x !== l.seg), bounds: this.bounds };
        const r = CK.placeLabel((p[0] + q[0]) / 2, (p[1] + q[1]) / 2, q[0] - p[0], q[1] - p[1], w, hh, avoid);
        l.lab.hidden = !r;
        if (r) { l.lab.style.left = r.x + 'px'; l.lab.style.top = r.y + 'px'; this.fixed.push(r); }
      }
    }
    /** where a message at progress p sits: it leaves the sender's card edge and arrives at the receiver's */
    at(a, b, p) {
      const dx = (b.x - a.x) * this.W, dy = (b.y - a.y) * this.H, len = Math.hypot(dx, dy) || 1;
      const out = (id) => { const [hw, hh] = this.half.get(id) || [0, 0]; return Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity); };
      let s0 = out(a.id), s1 = 1 - out(b.id);
      if (!(s1 > s0)) { s0 = 0.5; s1 = 0.5; }
      const q = s0 + (s1 - s0) * (0.06 + 0.88 * p);
      return [(a.x + (b.x - a.x) * q) * 100, (a.y + (b.y - a.y) * q) * 100, len];
    }
    /**
     * where a message at progress p sits, in pixels, with the direction it travels and the stretch of line it is on.
     * With a hub it goes out along the sender's spoke and in along the receiver's, on its own side of each spoke (two
     * lanes, so messages passing each other never sit on one another); otherwise straight from card edge to card edge
     */
    route(m, p) {
      const W = this.W, H = this.H, a = this.pos.get(m.from), b = this.pos.get(m.to), hub = this.pos.get(CK.HUB);
      if (!hub || m.from === CK.HUB || m.to === CK.HUB) {
        const [x, y] = this.at(a, b, p);
        return { x: (x / 100) * W, y: (y / 100) * H, dx: (b.x - a.x) * W, dy: (b.y - a.y) * H, seg: m.from + '>' + m.to };
      }
      const P = (n) => [n.x * W, n.y * H], A = P(a), Hh = P(hub), Bb = P(b);
      const edge = (id, ux, uy) => { const [hw, hh] = this.half.get(id) || [0, 0]; return Math.min(ux ? hw / Math.abs(ux) : Infinity, uy ? hh / Math.abs(uy) : Infinity); };
      const la = Math.hypot(Hh[0] - A[0], Hh[1] - A[1]) || 1, lb = Math.hypot(Bb[0] - Hh[0], Bb[1] - Hh[1]) || 1;
      const ua = [(Hh[0] - A[0]) / la, (Hh[1] - A[1]) / la], ub = [(Bb[0] - Hh[0]) / lb, (Bb[1] - Hh[1]) / lb];
      const r = (this.half.get(CK.HUB) || [30])[0], oa = edge(m.from, ua[0], ua[1]), ob = edge(m.to, ub[0], ub[1]);
      const s1 = Math.max(1, la - oa - r), s2 = Math.max(1, lb - ob - r), d = (0.04 + 0.92 * p) * (s1 + s2), LANE = 7;
      // near: how far the message is from the hub's rim
      if (d <= s1) return { x: A[0] + ua[0] * (oa + d) - ua[1] * LANE, y: A[1] + ua[1] * (oa + d) + ua[0] * LANE, dx: ua[0], dy: ua[1], seg: m.from + '>hub', near: s1 - d };
      return { x: Hh[0] + ub[0] * (r + d - s1) - ub[1] * LANE, y: Hh[1] + ub[1] * (r + d - s1) + ub[0] * LANE, dx: ub[0], dy: ub[1], seg: 'hub>' + m.to, near: d - s1 };
    }
    tick(t) {
      const W = this.W, H = this.H;
      // messages of one type on one stretch of line close together are one dot with a count: near the hub, where the
      // spokes converge, that keeps the dots apart
      // where the spokes converge the messages passing through the network are counted on the hub instead
      const marks = [], inHub = [];
      for (const m of this.flight) {
        const p = Math.max(0, Math.min(1, m.at > m.sent ? (t - m.sent) / (m.at - m.sent) : 1));
        const at = this.route(m, p);
        if (at.near !== undefined && at.near < 18) { inHub.push(m); continue; }
        const g = marks.find((x) => x.at.seg === at.seg && Math.hypot(x.at.x - at.x, x.at.y - at.y) < 18 && (x.m.type === m.type || Math.hypot(x.at.x - at.x, x.at.y - at.y) < 13));
        if (g) { g.n++; if (g.m.type !== m.type) g.mixed = true; } else marks.push({ m, n: 1, p, kind: 'msg', at });
      }
      if (this.hubCount) {
        this.hubCount.textContent = inHub.length ? String(inHub.length) : '';
        this.hubCount.parentNode.title = inHub.length ? inHub.length + ' message' + (inHub.length > 1 ? 's' : '') + ' passing through the network: ' + [...new Set(inHub.map((m) => m.type))].join(', ') : 'the network: every message passes through it';
      }
      for (const m of this.ended) if (m.fate === 'drop') { const p = m.reason === 'receiver down' ? 1 : 0.6; marks.push({ m, n: 1, p, kind: 'drop', at: this.route(m, p) }); }
      // the dots first, then their labels where there is room, the dropped ones first
      for (const mk of marks) { mk.xy = [(mk.at.x / W) * 100, (mk.at.y / H) * 100]; mk.dx = mk.at.dx; mk.dy = mk.at.dy; }
      const dots = marks.map((mk) => ({ x: (mk.xy[0] / 100) * W - 7, y: (mk.xy[1] / 100) * H - 7, w: 14, h: 14 }));
      const avoid = { boxes: [...this.boxes.values()].concat(dots), labels: (this.fixed || []).slice(), segs: this.segs, bounds: this.bounds };
      // drops and counts first, then the messages furthest out on their links; a type is named on two dots at most,
      // the colour tells the rest
      const order = marks.map((mk, i) => i).sort((i, j) => (marks[j].kind === 'drop') - (marks[i].kind === 'drop') || marks[j].n - marks[i].n || Math.abs(marks[i].p - 0.5) - Math.abs(marks[j].p - 0.5));
      const named = new Map();
      let j = 0;
      for (const mk of marks) {
        let el = this.pool[j];
        if (!el) { el = h('div.ck-msg', h('i'), h('span', { 'data-audit': 'label' })); this.pool.push(el); this.dotsEl.appendChild(el); }
        el.hidden = false;
        el.className = 'ck-msg c' + CK.hue(mk.m.type) + (mk.kind === 'drop' ? ' drop' : '') + (mk.m.dup ? ' dup' : '');
        el.style.left = mk.xy[0] + '%';
        el.style.top = mk.xy[1] + '%';
        el.title = (mk.n > 1 ? mk.n + ' × ' : '') + (mk.kind === 'drop' ? mk.m.type + ' dropped: ' + (REASON[mk.m.reason] || mk.m.reason) : mk.m.type + ' ' + mk.m.from + ' → ' + mk.m.to + (mk.m.body !== undefined ? ' ' + short(mk.m.body) : ''));
        mk.el = el;
        j++;
      }
      for (let k = j; k < this.pool.length; k++) this.pool[k].hidden = true;
      for (const i of order) {
        const mk = marks[i], lab = mk.el.lastChild;
        // a label near either end would crowd a card: name messages while they are out on the link
        const mid = mk.p > 0.1 && mk.p < 0.9;
        const again = mk.kind !== 'drop' && (named.get(mk.m.type) || 0) >= (mk.n > 1 ? 4 : 2);
        const text = again ? '' : mk.kind === 'drop' ? mk.m.type + ' ✕' : mk.mixed ? mk.n + ' messages' : mid || mk.n > 1 ? mk.m.type + (mk.n > 1 ? ' ×' + mk.n : '') : '';
        lab.textContent = text;
        if (!text) continue;
        const px = (mk.xy[0] / 100) * W, py = (mk.xy[1] / 100) * H;
        const own = dots[i];
        avoid.boxes = avoid.boxes.filter((b) => b !== own);
        const r = CK.placeLabel(px, py, mk.dx, mk.dy, lab.offsetWidth, lab.offsetHeight, avoid);
        avoid.boxes.push(own);
        if (!r) { lab.textContent = ''; continue; }
        avoid.labels.push(r);
        named.set(mk.m.type, (named.get(mk.m.type) || 0) + 1);
        // the label is placed relative to the dot's box, an 11px square centred on the point
        lab.style.left = (r.x - px + 5.5) + 'px';
        lab.style.top = (r.y - py + 5.5) + 'px';
      }
      for (const el of this.cards.values()) {
        if (!el.timer || !el.ring) continue;
        const { start, end } = el.timer;
        const left = end > start ? Math.max(0, Math.min(1, (end - t) / (end - start))) : 0;
        el.ring.setAttribute('stroke-dashoffset', String(50.27 * (1 - left)));
      }
    }
  }
  CK.Canvas = Canvas;

  /**
   * a stage that plays one source: a canvas, the player, the line saying what the current frame did, and a panel.
   * host: { el (where to draw), onIntervene? } ; returns { load(src, i), redraw(), destroy() }
   */
  CK.stage = function (host) {
    let src = null, panelTimer = 0;
    const canvas = new Canvas({
      onNode: (id, el) => nodeMenu(id, el),
      onLink: (a, b) => { if (!src || !src.intervene || src.noLinks) return; const f = cur(); intervene(CK.canTalk(f, a, b) ? { kind: 'cut', a, b } : { kind: 'mend', a, b }); },
    });
    const what = h('div.ck-what', { role: 'status', 'aria-live': 'polite' });
    const actions = h('div.ck-actions');
    const panel = h('div.ck-panel');
    const player = new Player({
      onFrame: () => { drawFrame(); },
      onTick: (t) => { canvas.tick(t); if (src && src.onTick) src.onTick(t, cur()); },
    });
    const box = h('div.ck-stage', actions, canvas.el, player.el, what, panel);
    host.el.appendChild(box);
    const cur = () => src && src.rec.frames[player.i];
    function drawFrame(force) {
      if (!src) return;
      const f = cur();
      canvas.hide = src.hideMsg || null;
      canvas.layout(src.layout(f, canvas.el.clientWidth || host.el.clientWidth || 800));
      canvas.frame(f, src.rec, (id) => src.card(id, f));
      what.textContent = CK.frameText(f, src.note);
      drawActions(f);
      // the panel can be heavy: during play it is redrawn a few times a second
      if (force || !player.playing) { clearTimeout(panelTimer); panelTimer = 0; drawPanel(); }
      else if (!panelTimer) panelTimer = setTimeout(() => { panelTimer = 0; drawPanel(); }, 120);
    }
    function drawPanel() {
      if (!src) return;
      const f = cur();
      const keep = panel.scrollTop;
      panel.innerHTML = '';
      if (src.panel) src.panel(panel, f, src.rec, player.i);
      panel.scrollTop = keep;
    }
    function drawActions(f) {
      actions.innerHTML = '';
      const list = src.actions ? src.actions(f) : [];
      for (const a of list) actions.appendChild(UI.btn(a.icon || null, a.label, a.title || a.label, () => { if (a.op) intervene(typeof a.op === 'function' ? a.op(f) : a.op); else if (a.run) a.run(f, player.i); }, 'small' + (a.primary ? ' primary' : '')));
      if (src.intervene && f.n && (f.n.groups || Object.keys(f.n.blocked).length)) actions.appendChild(UI.btn('refresh', 'Heal the network', 'Mend every cut link and end the partition', () => intervene({ kind: 'heal' }), 'small'));
      actions.hidden = !actions.children.length;
    }
    function intervene(op) {
      if (!src || !src.intervene) return;
      const fi = src.intervene(player.i, op);
      player.load(src, fi);
      if (host.onIntervene) host.onIntervene(op);
    }
    function nodeMenu(id, el) {
      if (!src || !src.intervene) { if (src && src.onNode) src.onNode(id, cur()); return; }
      const f = cur();
      const node = canvas.pos.get(id) || {};
      const items = [{ head: id }];
      if (src.menu) for (const it of src.menu(id, f)) items.push(Object.assign({}, it, { onclick: () => (it.op ? intervene(it.op) : it.run && it.run()) }));
      if (node.kind !== 'client' && !src.noCrash) {
        if (CK.up(f, id)) items.push({ label: 'Crash ' + id, icon: 'crash', onclick: () => intervene({ kind: 'crash', id }) });
        else items.push({ label: 'Restart ' + id, icon: 'refresh', onclick: () => intervene({ kind: 'restart', id }) });
      }
      if (!src.noLinks) items.push({ label: 'Cut ' + id + ' off from the others', icon: 'split', onclick: () => intervene({ kind: 'isolate', id }) });
      if (f.n && (f.n.groups || Object.keys(f.n.blocked).length)) items.push({ label: 'Heal the network', icon: 'refresh', onclick: () => intervene({ kind: 'heal' }) });
      if (items.length > 1) UI.menu(el, items);
    }
    box.addEventListener('keydown', (e) => {
      if (e.target.closest('input, select, textarea')) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); player.step(1); } else if (e.key === 'ArrowLeft') { e.preventDefault(); player.step(-1); } else if (e.key === ' ' && !e.target.closest('button')) { e.preventDefault(); player.toggle(); }
    });
    return {
      el: box, player, canvas, panel,
      load(s2, i) { src = s2; canvas.noLinks = !!s2.noLinks || !s2.intervene; canvas.key = null; player.load(s2, i || 0); drawFrame(true); },
      redraw() { if (src) { canvas.key = null; drawFrame(true); canvas.tick(player.t); } },
      intervene,
      get src() { return src; },
      destroy() { player.destroy(); clearTimeout(panelTimer); },
    };
  };

  // ---- small drawings shared by the views ---------------------------------------------------------------------------
  /** horizontal bars: rows [{ label, value, note, cls }] scaled to max */
  CK.bars = function (rows, opts) {
    opts = opts || {};
    const max = opts.max || Math.max(1, ...rows.map((r) => r.value));
    return h('div.ck-bars' + (opts.cls ? '.' + opts.cls : ''), rows.map((r) => h('div.ck-bar' + (r.cls ? '.' + r.cls.trim().split(/\s+/).join('.') : ''), { title: r.title || null },
      h('span.ck-bl', r.label), h('span.ck-bt', h('i', { style: { width: Math.max(r.value ? 1.5 : 0, (100 * r.value) / max) + '%' } })), h('span.ck-bv', r.note !== undefined ? r.note : CK.num(r.value)))));
  };
  /** a small directed graph of named vertices on a circle; edges [{ from, to, cls }] */
  let graphs = 0;
  CK.graph = function (verts, edges, opts) {
    opts = opts || {};
    const W = opts.w || 180, H = opts.h || 120, r = 15;
    const pts = CK.circle(verts, { rx: 0.32, ry: 0.3, start: Math.PI }).map((p) => ({ id: p.id, x: p.x * W, y: p.y * H }));
    const at = new Map(pts.map((p) => [p.id, p]));
    const id = 'cka' + (++graphs);
    const marker = (k, cls) => s('marker', { id: id + k, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, s('path', { d: 'M0 0L10 5L0 10z', class: 'ck-ah' + cls }));
    const svg = s('svg', { class: 'ck-graph', viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, role: 'img', 'aria-label': opts.label || 'graph' }, s('defs', {}, marker('n', ''), marker('c', ' cyc')));
    for (const e of edges) {
      const a = at.get(e.from), b = at.get(e.to);
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1, nx = -dy / d, ny = dx / d, bend = 10;
      const x1 = a.x + (dx / d) * r, y1 = a.y + (dy / d) * r, x2 = b.x - (dx / d) * (r + 2), y2 = b.y - (dy / d) * (r + 2);
      svg.appendChild(s('path', { d: 'M' + x1 + ' ' + y1 + ' Q ' + ((a.x + b.x) / 2 + nx * bend) + ' ' + ((a.y + b.y) / 2 + ny * bend) + ' ' + x2 + ' ' + y2, class: 'ck-edge' + (e.cls ? ' ' + e.cls : ''), 'marker-end': 'url(#' + id + (/cyc/.test(e.cls || '') ? 'c' : 'n') + ')' }, e.title ? s('title', { text: e.title }) : null));
    }
    for (const p of pts) svg.appendChild(s('g', { class: 'ck-v' + (opts.cls && opts.cls[p.id] ? ' ' + opts.cls[p.id] : '') }, s('circle', { cx: p.x, cy: p.y, r }), s('text', { x: p.x, y: p.y + 4, 'text-anchor': 'middle', text: p.id })));
    return svg;
  };

  // ---- the Cluster view ----------------------------------------------------------------------------------------------------
  function create(app, el) {
    const list = () => CK.scenarios;
    let id = UI.store.get('ck.scenario', 'raft');
    if (!list().some((x) => x.id === id)) id = list()[0] && list()[0].id;
    const allOpts = UI.store.get('ck.opts', {});
    const head = h('div.view-head.ck-head');
    const body = h('div.view-body.ck-body', { tabindex: '-1' });
    el.appendChild(head); el.appendChild(body);
    let stage = null, sc = null, opts = null, token = 0;

    function start() {
      sc = list().find((x) => x.id === id) || list()[0];
      if (!sc) { body.appendChild(h('div.empty', 'No cluster scenarios are loaded.')); return; }
      opts = Object.assign({}, sc.defaults || {}, allOpts[sc.id] || {});
      drawHead();
      if (stage) stage.destroy();
      stage = null;
      body.innerHTML = '';
      const about = CK.about(sc.about);
      const ctl = h('div.ck-controls');
      const host = h('div.ck-host');
      body.appendChild(about); body.appendChild(ctl); body.appendChild(host);
      const my = ++token;
      // controls come after the data: some list the columns of the loaded tables
      const go = () => {
        if (my !== token) return;
        if (sc.controls) for (const c of sc.controls(opts, set)) if (c) ctl.appendChild(c);
        const src = sc.start(opts, { app });
        host.innerHTML = '';
        stage = CK.stage({ el: host });
        stage.load(src, 0);
      };
      if (sc.slow) CK.later(host, sc.slow, go); else go();
    }
    function set(k, v) { opts[k] = v; allOpts[sc.id] = opts; UI.store.set('ck.opts', allOpts); start(); }
    function drawHead() {
      head.innerHTML = '';
      const groups = new Map();
      for (const x of list()) { const g = x.group || 'Scenarios'; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(x); }
      const sel = h('select.inp.ck-pick', { 'aria-label': 'Scenario', onchange: (e) => { id = e.target.value; UI.store.set('ck.scenario', id); start(); } },
        [...groups].map(([g, xs]) => h('optgroup', { label: g }, xs.map((x) => h('option', { value: x.id, selected: x.id === id }, x.title)))));
      head.appendChild(h('label.ck-field.ck-pickf', h('span', 'Scenario'), sel));
      head.appendChild(h('span.grow'));
      head.appendChild(UI.btn('refresh', 'Start again', 'Start this scenario again from the beginning', () => start(), 'small ghost'));
    }
    start();
    return {
      render() { if (stage) stage.redraw(); },
      destroy() { token++; if (stage) stage.destroy(); },
      /** for tests and lessons: open a scenario by id with options */
      scenario(x, o) { id = x; if (o) { allOpts[x] = Object.assign({}, allOpts[x] || {}, o); } UI.store.set('ck.scenario', id); start(); return stage; },
      get stage() { return stage; },
    };
  }
  UI.registerView({ id: 'cluster', title: 'Cluster', icon: 'nodes', group: 'Distributed', order: 60, create });
})(typeof window !== 'undefined' ? window : globalThis);
