// The cluster simulator's network: a discrete-event simulation of nodes exchanging messages. Time is a logical
// clock in abstract units; each message gets a delivery time from the link's latency and jitter, and may be lost,
// duplicated, cut off by a partition or arrive at a crashed node. Every random choice comes from one seeded
// generator, so a run is a function of its seed and its script. Everything that happens goes into the trace with
// an id, which is what a view draws; snapshot() and restore() take the whole simulation back to an earlier point.
(function (root) {
  'use strict';
  const K = root.K;
  const C = K.Cluster = K.Cluster || {};

  /** mulberry32: its whole state is one 32-bit number, so a snapshot can carry it */
  class Rng {
    constructor(seed) { this.s = (Number(seed) >>> 0) || 0x9e3779b9; }
    next() {
      let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    int(lo, hi) { return lo + Math.floor(this.next() * (hi - lo + 1)); }
    pick(a) { return a[Math.floor(this.next() * a.length)]; }
    chance(p) { return p > 0 && this.next() < p; }
    shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(this.next() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
    fork() { return new Rng(Math.floor(this.next() * 4294967296)); }
  }
  C.Rng = Rng;

  /** deep copy of plain data (arrays, plain objects, Maps, Sets); class instances such as Decimal are immutable and shared */
  function clone(v) {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(clone);
    if (v instanceof Map) return new Map([...v].map(([k, x]) => [k, clone(x)]));
    if (v instanceof Set) return new Set([...v].map(clone));
    const p = Object.getPrototypeOf(v);
    if (p !== Object.prototype && p !== null) return v;
    const o = {};
    for (const k of Object.keys(v)) o[k] = clone(v[k]);
    return o;
  }
  C.clone = clone;

  /** a rough wire size: the length of the JSON form, for counting bytes shipped */
  function sizeOf(v) {
    if (v === null || v === undefined) return 1;
    if (typeof v === 'string') return v.length + 2;
    if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') return String(v).length;
    if (Array.isArray(v)) return v.reduce((n, x) => n + sizeOf(x) + 1, 2);
    if (v instanceof Map) return [...v].reduce((n, [k, x]) => n + sizeOf(k) + sizeOf(x) + 2, 2);
    if (v instanceof Set) return [...v].reduce((n, x) => n + sizeOf(x) + 1, 2);
    if (typeof v.toString === 'function' && Object.getPrototypeOf(v) !== Object.prototype) return String(v).length;
    return Object.keys(v).reduce((n, k) => n + k.length + 3 + sizeOf(v[k]), 2);
  }
  C.sizeOf = sizeOf;

  /**
   * The base of everything that runs on the network. A subclass keeps its mutable state in this.state (plain data,
   * so the default snapshot is a deep copy) and implements any of onMessage(msg), onTimer(name, data),
   * onCrash() and onRestart().
   */
  class Actor {
    constructor(id) { this.id = id; this.net = null; this.state = {}; }
    get now() { return this.net.clock; }
    get rng() { return this.net.rng; }
    send(to, type, body, opts) { return this.net.send(this.id, to, type, body, opts); }
    broadcast(tos, type, body, opts) { return tos.filter((t) => t !== this.id).map((t) => this.net.send(this.id, t, type, body, opts)); }
    setTimer(name, delay, data) { return this.net.setTimer(this.id, name, delay, data); }
    cancelTimer(id) { this.net.cancelTimer(id); }
    cancelTimers(name) { this.net.cancelTimers(this.id, name); }
    note(kind, data) { return this.net.note(this.id, kind, data); }
    snapshot() { return clone(this.state); }
    restore(s) { this.state = clone(s); }
  }
  C.Actor = Actor;

  const DEFAULTS = { latency: 10, jitter: 0, loss: 0, dup: 0, bandwidth: 0, fifo: false };

  class Net {
    /**
     * opts: seed, latency (time units), jitter (extra 0..jitter added per message), loss and dup (probabilities),
     * bandwidth (bytes per time unit, 0 = unlimited), fifo (no overtaking on a link), undo (snapshots kept for stepBack)
     */
    constructor(opts) {
      opts = opts || {};
      this.seed = opts.seed === undefined ? 1 : opts.seed;
      this.rng = new Rng(this.seed);
      this.cfg = {};
      for (const k of Object.keys(DEFAULTS)) this.cfg[k] = opts[k] === undefined ? DEFAULTS[k] : opts[k];
      this.links = {};        // 'a>b' -> overrides of cfg for messages from a to b
      this.nodes = new Map(); // id -> { id, up, epoch, h }
      this.clock = 0;
      this.queue = [];        // events sorted by (at, seq)
      this.seq = 0;
      this.msgId = 0;
      this.timerId = 0;
      this.trace = [];
      this.traceId = 0;
      this.groups = null;     // id -> partition group number
      this.blocked = {};      // 'a>b' -> true: one-way cuts
      this.lastOnLink = {};   // 'a>b' -> latest delivery time, for fifo links
      this.stats = { sent: 0, delivered: 0, dropped: 0, duplicated: 0, bytes: 0, timers: 0 };
      this.listeners = [];
      this.undoDepth = opts.undo || 0;
      this.undo = [];
      this.maxSteps = opts.maxSteps || 1000000;
    }

    // ---- nodes ------------------------------------------------------------------------------------------------
    add(id, h) {
      if (this.nodes.has(id)) throw new Error('node ' + id + ' already exists');
      h = h || new Actor(id);
      h.id = id; h.net = this;
      this.nodes.set(id, { id, up: true, epoch: 0, h });
      return h;
    }
    node(id) { const n = this.nodes.get(id); return n ? n.h : null; }
    ids() { return [...this.nodes.keys()]; }
    isUp(id) { const n = this.nodes.get(id); return !!(n && n.up); }
    upIds() { return this.ids().filter((i) => this.isUp(i)); }
    crash(id) {
      const n = this.nodes.get(id);
      if (!n || !n.up) return;
      n.up = false; n.epoch++;
      this.queue = this.queue.filter((e) => !(e.kind === 'timer' && e.node === id));
      this.record({ kind: 'crash', node: id });
      if (n.h.onCrash) n.h.onCrash();
    }
    restart(id) {
      const n = this.nodes.get(id);
      if (!n || n.up) return;
      n.up = true;
      this.record({ kind: 'restart', node: id });
      if (n.h.onRestart) n.h.onRestart();
    }

    // ---- links and partitions ---------------------------------------------------------------------------------
    /** override latency/jitter/loss/dup/bandwidth for messages from a to b (and b to a unless oneWay) */
    link(a, b, cfg, oneWay) { this.links[a + '>' + b] = Object.assign({}, this.links[a + '>' + b], cfg); if (!oneWay) this.links[b + '>' + a] = Object.assign({}, this.links[b + '>' + a], cfg); }
    linkCfg(a, b) { const o = this.links[a + '>' + b]; return o ? Object.assign({}, this.cfg, o) : this.cfg; }
    /** split the nodes into groups that cannot talk to each other; nodes not named form one more group */
    partition(groups) {
      this.groups = {};
      groups.forEach((g, i) => g.forEach((id) => { this.groups[id] = i; }));
      for (const id of this.ids()) if (!(id in this.groups)) this.groups[id] = groups.length;
      this.record({ kind: 'partition', groups: groups.map((g) => g.slice()) });
    }
    heal() { this.groups = null; this.blocked = {}; this.record({ kind: 'heal' }); }
    /** cut the link a to b in one direction only */
    block(a, b) { this.blocked[a + '>' + b] = true; this.record({ kind: 'block', from: a, to: b }); }
    unblock(a, b) { delete this.blocked[a + '>' + b]; this.record({ kind: 'unblock', from: a, to: b }); }
    canTalk(a, b) {
      if (this.blocked[a + '>' + b]) return false;
      if (!this.groups) return true;
      const ga = this.groups[a], gb = this.groups[b];
      return ga === undefined || gb === undefined || ga === gb;
    }

    // ---- messages and timers ----------------------------------------------------------------------------------
    push(ev) {
      ev.seq = this.seq++;
      let lo = 0, hi = this.queue.length;
      while (lo < hi) { const m = (lo + hi) >> 1; const q = this.queue[m]; if (q.at < ev.at || (q.at === ev.at && q.seq < ev.seq)) lo = m + 1; else hi = m; }
      this.queue.splice(lo, 0, ev);
      return ev;
    }
    delay(from, to, bytes) {
      const c = this.linkCfg(from, to);
      let d = c.latency + (c.jitter ? this.rng.next() * c.jitter : 0) + (c.bandwidth ? bytes / c.bandwidth : 0);
      d = Math.max(1e-6, Math.round(d * 1000) / 1000);
      let at = this.clock + d;
      if (c.fifo) { const k = from + '>' + to; at = Math.max(at, this.lastOnLink[k] || 0); this.lastOnLink[k] = at; }
      return at;
    }
    /** send a message; returns its id. opts.bytes overrides the size estimate */
    send(from, to, type, body, opts) {
      opts = opts || {};
      const id = 'm' + (++this.msgId);
      body = clone(body);
      const bytes = opts.bytes !== undefined ? opts.bytes : sizeOf(body) + type.length + 8;
      const msg = { id, from, to, type, body, bytes, sent: this.clock };
      this.stats.sent++; this.stats.bytes += bytes;
      if (!this.isUp(from)) { this.stats.dropped++; this.record({ kind: 'drop', msg: id, from, to, type, reason: 'sender down' }); return id; }
      const c = this.linkCfg(from, to);
      const lost = this.rng.chance(c.loss);
      const at = this.delay(from, to, bytes);
      this.record({ kind: 'send', msg: id, from, to, type, body: clone(body), bytes, at, label: opts.label });
      this.push({ kind: 'deliver', at, msg, lost });
      if (this.rng.chance(c.dup)) {
        const copy = Object.assign({}, msg, { id: id + "'", body: clone(body), copyOf: id });
        this.stats.duplicated++;
        const at2 = this.delay(from, to, bytes);
        this.record({ kind: 'dup', msg: copy.id, copyOf: id, from, to, type, at: at2 });
        this.push({ kind: 'deliver', at: at2, msg: copy, lost: false });
      }
      return id;
    }
    setTimer(node, name, delay, data) {
      const n = this.nodes.get(node);
      const id = 't' + (++this.timerId);
      this.push({ kind: 'timer', at: this.clock + delay, node, name, data: clone(data), id, epoch: n ? n.epoch : 0 });
      return id;
    }
    cancelTimer(id) { this.queue = this.queue.filter((e) => e.id !== id); }
    cancelTimers(node, name) { this.queue = this.queue.filter((e) => !(e.kind === 'timer' && e.node === node && (name === undefined || e.name === name))); }
    hasTimer(node, name) { return this.queue.some((e) => e.kind === 'timer' && e.node === node && e.name === name); }
    /**
     * schedule an action at a time: 'crash' / 'restart' (node id), 'partition' (groups), 'heal', 'block' / 'unblock'
     * (a, b), or 'call' with a function run then (it gets the net)
     */
    at(time, op, ...args) { this.push({ kind: 'action', at: Math.max(time, this.clock), op, args }); return this; }
    after(dt, op, ...args) { return this.at(this.clock + dt, op, ...args); }
    note(node, kind, data) { return this.record({ kind: 'note', node, what: kind, data: clone(data) }); }
    record(e) {
      e.id = ++this.traceId;
      e.t = this.clock;
      this.trace.push(e);
      for (const f of this.listeners) f(e);
      return e;
    }
    on(f) { this.listeners.push(f); return () => { this.listeners = this.listeners.filter((g) => g !== f); }; }

    // ---- running ----------------------------------------------------------------------------------------------
    /** process the next event; returns the trace entries it produced, or null when nothing is left */
    step() {
      if (!this.queue.length) return null;
      if (this.undoDepth) { this.undo.push(this.snapshot()); if (this.undo.length > this.undoDepth) this.undo.shift(); }
      const from = this.trace.length;
      const ev = this.queue.shift();
      this.clock = Math.max(this.clock, ev.at);
      if (ev.kind === 'deliver') this.deliver(ev);
      else if (ev.kind === 'timer') {
        const n = this.nodes.get(ev.node);
        if (n && n.up && n.epoch === ev.epoch) {
          this.stats.timers++;
          this.record({ kind: 'timer', node: ev.node, name: ev.name, timer: ev.id, data: ev.data });
          if (n.h.onTimer) n.h.onTimer(ev.name, ev.data, ev);
        }
      } else if (ev.kind === 'action') {
        if (ev.op === 'call') ev.args[0](this);
        else this[ev.op](...ev.args);
      }
      return this.trace.slice(from);
    }
    deliver(ev) {
      const m = ev.msg;
      const n = this.nodes.get(m.to);
      const reason = !n ? 'no such node' : !n.up ? 'receiver down' : ev.lost ? 'lost' : !this.canTalk(m.from, m.to) ? 'partition' : null;
      if (reason) { this.stats.dropped++; this.record({ kind: 'drop', msg: m.id, from: m.from, to: m.to, type: m.type, reason }); return; }
      this.stats.delivered++;
      this.record({ kind: 'deliver', msg: m.id, from: m.from, to: m.to, type: m.type, sent: m.sent });
      if (n.h.onMessage) n.h.onMessage(m);
    }
    /** run until the clock passes a time (a number), a predicate on the net becomes true, or nothing is left */
    run(until, opts) {
      opts = opts || {};
      const max = opts.maxSteps || this.maxSteps;
      let steps = 0;
      const timed = typeof until === 'number';
      for (;;) {
        if (typeof until === 'function' && until(this)) break;
        if (!this.queue.length) break;
        if (timed && this.queue[0].at > until) break;
        this.step();
        if (++steps >= max) break;
      }
      if (timed && this.clock < until) this.clock = until;
      return steps;
    }
    runFor(dt, opts) { return this.run(this.clock + dt, opts); }
    /** run until no messages are in flight (timers may remain) */
    settle(opts) { return this.run((n) => !n.queue.some((e) => e.kind === 'deliver' || e.kind === 'action'), opts); }
    inFlight() { return this.queue.filter((e) => e.kind === 'deliver').map((e) => ({ id: e.msg.id, from: e.msg.from, to: e.msg.to, type: e.msg.type, sent: e.msg.sent, at: e.at, lost: e.lost })); }
    pending() { return this.queue.map((e) => ({ kind: e.kind, at: e.at, msg: e.msg ? e.msg.id : undefined, type: e.msg ? e.msg.type : undefined, node: e.node, name: e.name, op: e.op })); }

    // ---- snapshots ----------------------------------------------------------------------------------------------
    snapshot() {
      return {
        clock: this.clock, seq: this.seq, msgId: this.msgId, timerId: this.timerId, traceId: this.traceId, traceLen: this.trace.length,
        rng: this.rng.s, queue: clone(this.queue), groups: clone(this.groups), blocked: clone(this.blocked), lastOnLink: clone(this.lastOnLink),
        stats: clone(this.stats), cfg: clone(this.cfg), links: clone(this.links),
        nodes: [...this.nodes.values()].map((n) => ({ id: n.id, up: n.up, epoch: n.epoch, state: n.h.snapshot ? n.h.snapshot() : null })),
      };
    }
    restore(s) {
      Object.assign(this, { clock: s.clock, seq: s.seq, msgId: s.msgId, timerId: s.timerId, traceId: s.traceId });
      this.rng.s = s.rng;
      this.queue = clone(s.queue); this.groups = clone(s.groups); this.blocked = clone(s.blocked); this.lastOnLink = clone(s.lastOnLink);
      this.stats = clone(s.stats); this.cfg = clone(s.cfg); this.links = clone(s.links);
      this.trace.length = s.traceLen;
      for (const ns of s.nodes) { const n = this.nodes.get(ns.id); if (!n) continue; n.up = ns.up; n.epoch = ns.epoch; if (n.h.restore && ns.state !== null) n.h.restore(ns.state); }
    }
    /** undo the last step (needs opts.undo when the net was made) */
    stepBack() { const s = this.undo.pop(); if (!s) return false; this.restore(s); return true; }

    /** what a view needs to draw the cluster now */
    view() {
      return {
        clock: this.clock,
        nodes: [...this.nodes.values()].map((n) => ({ id: n.id, up: n.up, group: this.groups ? this.groups[n.id] : 0, role: n.h.role || (n.h.state && n.h.state.role) || null })),
        inFlight: this.inFlight(), groups: this.groups ? clone(this.groups) : null, stats: clone(this.stats),
      };
    }
    /** the trace filtered by kind, node or message type */
    events(f) {
      f = f || {};
      return this.trace.filter((e) => (!f.kind || [].concat(f.kind).includes(e.kind)) && (!f.node || e.node === f.node || e.from === f.node || e.to === f.node) && (!f.type || e.type === f.type));
    }
    /** a sequence diagram as text: one line per event */
    log(f) {
      return this.events(f).map((e) => {
        const t = String(+e.t.toFixed(3)).padStart(8);
        switch (e.kind) {
          case 'send': return t + '  ' + e.from + ' -> ' + e.to + '  ' + e.type + ' ' + JSON.stringify(e.body, (k, v) => (typeof v === 'bigint' ? String(v) : v));
          case 'deliver': return t + '  ' + e.to + ' <- ' + e.from + '  ' + e.type;
          case 'drop': return t + '  x ' + e.from + ' -> ' + e.to + '  ' + e.type + ' dropped (' + e.reason + ')';
          case 'timer': return t + '  ' + e.node + ' timer ' + e.name;
          case 'note': return t + '  ' + e.node + ' ' + e.what + (e.data === undefined ? '' : ' ' + JSON.stringify(e.data, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
          case 'partition': return t + '  partition ' + e.groups.map((g) => '{' + g.join(',') + '}').join(' | ');
          default: return t + '  ' + e.kind + (e.node !== undefined ? ' ' + e.node : '') + (e.from !== undefined ? ' ' + e.from + '>' + e.to : '');
        }
      }).join('\n');
    }
    describe() {
      return {
        name: 'Network',
        text: 'A discrete-event network. Each message is delivered after the link latency plus a random jitter; it can be lost, duplicated, '
          + 'dropped by a partition or arrive at a crashed node. Timers belong to a node and die with it. The clock is logical; '
          + 'the seed fixes every random choice, so the same seed and script give the same trace.',
        cfg: clone(this.cfg), nodes: this.ids(), clock: this.clock, stats: clone(this.stats),
        traceKinds: ['send', 'deliver', 'drop', 'dup', 'timer', 'crash', 'restart', 'partition', 'heal', 'block', 'unblock', 'note'],
      };
    }
  }
  C.Net = Net;
})(typeof window !== 'undefined' ? window : globalThis);
