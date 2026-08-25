// Replication on the simulated network (chapter 23.4 and the consistency discussion of 23.6): primary-copy with
// synchronous, semi-synchronous and asynchronous propagation; multi-master with conflict detection by version
// vectors, resolved by last-writer-wins or kept as siblings; quorum reads and writes (N, R, W) with read repair;
// session guarantees (read-your-writes, monotonic reads) and the CAP trade-off under a partition. Replicas are
// key-value stores whose whole state is plain data, so the network's snapshots cover them. Clients are actors too:
// each runs a script of operations and keeps a history that the checkers read.
(function (root) {
  'use strict';
  const K = root.K;
  const C = K.Cluster = K.Cluster || {};
  const clone = C.clone;

  // ---- version vectors ----------------------------------------------------------------------------------------
  const VV = {
    inc(vv, n) { const o = Object.assign({}, vv); o[n] = (o[n] || 0) + 1; return o; },
    merge(...vs) { const o = {}; for (const v of vs) for (const k of Object.keys(v || {})) o[k] = Math.max(o[k] || 0, v[k]); return o; },
    /** 'equal', 'before' (a happened before b), 'after' or 'concurrent' */
    compare(a, b) {
      let lt = false, gt = false;
      for (const k of new Set(Object.keys(a || {}).concat(Object.keys(b || {})))) { const x = (a && a[k]) || 0, y = (b && b[k]) || 0; if (x < y) lt = true; if (x > y) gt = true; }
      return lt && gt ? 'concurrent' : lt ? 'before' : gt ? 'after' : 'equal';
    },
    str(vv) { return '[' + Object.keys(vv || {}).sort().map((k) => k + ':' + vv[k]).join(',') + ']'; },
  };

  // ---- clients -------------------------------------------------------------------------------------------------
  /**
   * A client runs its script one operation at a time: { op: 'write' | 'read' | 'merge' | 'sleep', key, value, at, to, t }.
   * at starts the operation no earlier than that time, to names the node to use, sleep waits t. Each finished
   * operation goes into the history: { n, client, op, key, value, start, end, ok, err, ver, node, ... }.
   */
  class Client extends C.Actor {
    constructor(id, script, opts) {
      super(id);
      this.opts = opts || {};
      this.state = { script: clone(script || []), i: 0, hist: [], cur: null, opn: 0, token: 0, sticky: this.opts.sticky || null };
    }
    start() { this.next(); }
    next() {
      const s = this.state, op = s.script[s.i];
      if (!op) return;
      this.setTimer('next', op.at !== undefined ? Math.max(0, op.at - this.now) : s.i ? (this.opts.think === undefined ? 1 : this.opts.think) : 0);
    }
    onTimer(name, data) {
      const s = this.state;
      if (name === 'timeout') { if (s.cur && s.cur.n === data.n) this.finish({ ok: false, err: 'timeout' }); return; }
      if (name !== 'next' || s.cur) return;
      const op = s.script[s.i++];
      if (!op) return;
      if (op.op === 'sleep') { this.setTimer('next', op.t || 0); return; }
      s.cur = { n: ++s.opn, client: this.id, op: op.op, key: op.key, value: op.value, start: this.now };
      if (op.to) s.cur.to = op.to;
      this.setTimer('timeout', this.opts.timeout || 200, { n: s.cur.n });
      this.note('op', { n: s.cur.n, op: op.op, key: op.key, value: op.value });
      this.dispatch(s.cur);
    }
    finish(res) {
      const s = this.state;
      const c = Object.assign(s.cur, res, { end: this.now });
      s.hist.push(c);
      s.cur = null;
      this.cancelTimers('timeout');
      this.note(c.ok ? 'done' : 'failed', { n: c.n, op: c.op, key: c.key, value: c.value, ver: c.ver, err: c.err });
      this.next();
    }
    onMessage(m) {
      const s = this.state;
      if (m.type === 'error' && s.cur && m.body.n === s.cur.n) return this.finish({ ok: false, err: m.body.err, node: m.from });
      if (this.late) this.late(m);
      if (s.cur && m.body && m.body.n === s.cur.n) this.reply(m, s.cur);
    }
  }

  /** the system shared by the three designs: a net, the replicas, the clients, the lag samples */
  class System {
    constructor(opts) {
      this.opts = opts;
      this.net = new C.Net(Object.assign({ latency: 10, jitter: 4 }, opts.net || {}, { seed: opts.seed === undefined ? 1 : opts.seed }));
      this.nodes = opts.nodes || ['A', 'B', 'C'];
      this.clients = [];
    }
    client(id, script, opts) { const c = this.net.add(id, new this.ClientClass(id, script, Object.assign({}, this.opts.client, opts), this)); this.clients.push(id); c.sys = this; c.start(); return c; }
    run(until) { this.net.run(until); return this; }
    history() { return this.clients.flatMap((c) => this.net.node(c).state.hist).sort((a, b) => a.start - b.start || a.n - b.n); }
    replica(id) { return this.net.node(id).state; }
    result(extra) { return Object.assign({ trace: this.net.trace, history: this.history(), violations: this.violations ? this.violations() : [] }, extra || {}); }
  }

  /**
   * Session checks over the history. ver is the version a read returned or a write made; cmp orders versions.
   * ryw: a read older than the client's own earlier write; monotonic: a read older than one the client saw before;
   * stale: a read older than a write some client had completed before the read began.
   */
  function check(hist, cmp) {
    cmp = cmp || ((a, b) => a - b);
    const out = [];
    const byClient = {};
    for (const h of hist) (byClient[h.client] = byClient[h.client] || []).push(h);
    for (const hs of Object.values(byClient)) {
      const lastW = {}, maxR = {};
      for (const h of hs.slice().sort((a, b) => a.start - b.start)) {
        if (!h.ok) continue;
        if (h.op === 'write') { lastW[h.key] = h.ver; continue; }
        if (h.op !== 'read') continue;
        if (lastW[h.key] !== undefined && cmp(h.ver, lastW[h.key]) < 0) out.push({ kind: 'ryw', client: h.client, n: h.n, key: h.key, got: h.ver, wrote: lastW[h.key], node: h.node, t: h.start });
        if (maxR[h.key] !== undefined && cmp(h.ver, maxR[h.key]) < 0) out.push({ kind: 'monotonic', client: h.client, n: h.n, key: h.key, got: h.ver, saw: maxR[h.key], node: h.node, t: h.start });
        if (maxR[h.key] === undefined || cmp(h.ver, maxR[h.key]) > 0) maxR[h.key] = h.ver;
      }
    }
    for (const r of hist) {
      if (r.op !== 'read' || !r.ok) continue;
      let latest;
      for (const w of hist) if (w.op === 'write' && w.ok && w.key === r.key && w.end < r.start && (latest === undefined || cmp(w.ver, latest) > 0)) latest = w.ver;
      if (latest !== undefined && cmp(r.ver, latest) < 0) out.push({ kind: 'stale', client: r.client, n: r.n, key: r.key, got: r.ver, latest, node: r.node, t: r.start });
    }
    return out;
  }

  // ---- primary copy -----------------------------------------------------------------------------------------------
  class PCNode extends C.Actor {
    constructor(id, sys) { super(id); this.sys = sys; this.state = { store: {}, applied: 0, seq: 0, log: [], buf: {}, waits: [], acks: {}, pos: {}, retry: false }; }
    get role() { return this.id === this.sys.primary ? 'primary' : 'replica'; }
    onMessage(m) {
      const s = this.state, b = m.body, sys = this.sys, primary = this.id === sys.primary;
      if (m.type === 'write') {
        if (!primary) return this.send(m.from, 'error', { n: b.n, err: 'not the primary' });
        const seq = ++s.seq;
        s.store[b.key] = { value: b.value, ver: seq };
        s.applied = seq;
        s.log.push({ seq, key: b.key, value: b.value });
        this.note('commit', { seq, key: b.key, value: b.value });
        for (const r of sys.replicas) this.send(r, 'replicate', { seq, key: b.key, value: b.value });
        const need = sys.mode === 'sync' ? sys.replicas.length : sys.mode === 'semi' ? Math.min(1, sys.replicas.length) : 0;
        if (!need) this.send(m.from, 'writeOk', { n: b.n, ver: seq });
        else s.acks[seq] = { client: m.from, n: b.n, need, got: [] };
        if (sys.retry && !s.retry) { s.retry = true; this.setTimer('retry', sys.retry); }
      } else if (m.type === 'replicate') {
        if (b.seq > s.applied) s.buf[b.seq] = b;
        while (s.buf[s.applied + 1]) {
          const e = s.buf[s.applied + 1];
          delete s.buf[s.applied + 1];
          s.applied = e.seq;
          s.store[e.key] = { value: e.value, ver: e.seq };
          this.note('apply', { seq: e.seq, key: e.key, value: e.value });
        }
        this.send(m.from, 'ack', { seq: s.applied });
        this.serveWaits();
      } else if (m.type === 'ack') {
        s.pos[m.from] = Math.max(s.pos[m.from] || 0, b.seq);
        for (const seq of Object.keys(s.acks)) {
          const a = s.acks[seq];
          if (+seq <= s.pos[m.from] && !a.got.includes(m.from)) a.got.push(m.from);
          if (a.got.length >= a.need) { this.send(a.client, 'writeOk', { n: a.n, ver: +seq, replicas: a.got.slice() }); delete s.acks[seq]; }
        }
      } else if (m.type === 'read') {
        if (sys.tokens && b.token > s.applied) { s.waits.push({ from: m.from, n: b.n, key: b.key, token: b.token }); this.note('read waits', { token: b.token, applied: s.applied }); }
        else this.answer(m.from, b.n, b.key);
      }
    }
    answer(to, n, key) { const v = this.state.store[key]; this.send(to, 'readOk', { n, key, value: v ? v.value : null, ver: v ? v.ver : 0, applied: this.state.applied }); }
    serveWaits() { const s = this.state; const ready = s.waits.filter((w) => w.token <= s.applied); s.waits = s.waits.filter((w) => w.token > s.applied); for (const w of ready) this.answer(w.from, w.n, w.key); }
    onTimer(name) {
      if (name !== 'retry') return;
      const s = this.state;
      let behind = false;
      for (const r of this.sys.replicas) { const p = s.pos[r] || 0; if (p < s.seq) { behind = true; for (const e of s.log) if (e.seq > p) this.send(r, 'replicate', e); } }
      s.retry = behind;
      if (behind) this.setTimer('retry', this.sys.retry);
    }
  }
  class PCClient extends Client {
    dispatch(c) {
      const s = this.state, sys = this.sys;
      if (c.op === 'write') return this.send(sys.primary, 'write', { n: c.n, key: c.key, value: c.value });
      const route = this.opts.readFrom || sys.readFrom;
      let to = c.to;
      if (!to) {
        if (route === 'primary') to = sys.primary;
        else if (route === 'sticky') { if (!s.sticky) s.sticky = this.rng.pick(sys.replicas.length ? sys.replicas : sys.nodes); to = s.sticky; }
        else to = this.rng.pick(route === 'replicas' ? sys.replicas : sys.nodes);
      }
      this.send(to, 'read', { n: c.n, key: c.key, token: sys.tokens ? s.token : 0 });
    }
    reply(m) {
      const s = this.state, b = m.body;
      if (m.type === 'writeOk') { s.token = Math.max(s.token, b.ver); this.finish({ ok: true, ver: b.ver, node: m.from }); }
      else if (m.type === 'readOk') { s.token = Math.max(s.token, b.applied); this.finish({ ok: true, value: b.value, ver: b.ver, node: m.from, applied: b.applied }); }
    }
  }
  /**
   * opts: seed, nodes (the first is the primary), mode 'sync' | 'semi' | 'async', readFrom 'primary' | 'any' |
   * 'replicas' | 'sticky', tokens (session tokens: a replica holds a read until it has applied the client's token),
   * lag { node: extra latency from the primary }, retry (resend period for lost messages), net (Net options), client
   */
  class PrimaryCopy extends System {
    constructor(opts) {
      opts = opts || {};
      super(opts);
      this.ClientClass = PCClient;
      this.primary = this.nodes[0];
      this.replicas = this.nodes.slice(1);
      this.mode = opts.mode || 'async';
      this.readFrom = opts.readFrom || 'any';
      this.tokens = !!opts.tokens;
      this.retry = opts.retry === undefined ? (this.net.cfg.loss ? 100 : 0) : opts.retry;
      for (const n of this.nodes) this.net.add(n, new PCNode(n, this));
      for (const [r, d] of Object.entries(opts.lag || {})) this.net.link(this.primary, r, { latency: this.net.cfg.latency + d });
      this.lagSeries = [];
      this.net.on((e) => { if (e.kind === 'note' && (e.what === 'commit' || e.what === 'apply')) this.lagSeries.push({ t: e.t, lag: this.lag() }); });
    }
    /** how many writes each replica is behind the primary */
    lag() { const p = this.replica(this.primary).seq; const o = {}; for (const r of this.replicas) o[r] = p - this.replica(r).applied; return o; }
    violations() { return check(this.history()); }
    describe() {
      return {
        name: 'Primary-copy replication', mode: this.mode, primary: this.primary, replicas: this.replicas, readFrom: this.readFrom, tokens: this.tokens, lag: this.lag(),
        text: 'All writes go to the primary, which orders them by a sequence number and ships them to the replicas. Synchronous: the client '
          + 'hears back after every replica has applied the write, so any replica can serve reads. Semi-synchronous: after one replica. '
          + 'Asynchronous: at once; replicas lag, so a read from a replica can miss the client\'s own write (read-your-writes) or go back in '
          + 'time after a read from a fresher replica (monotonic reads). A session token (the highest position the client has written or '
          + 'seen) fixes both: a replica holds the read until it has applied that far. Sticky routing to one replica fixes monotonic reads only.',
      };
    }
  }

  // ---- multi-master ------------------------------------------------------------------------------------------------
  /** each version: { value, vv, ts, node }; a key holds one version, or several concurrent siblings */
  class MMNode extends C.Actor {
    constructor(id, sys) { super(id); this.sys = sys; this.state = { store: {}, clock: 0, conflicts: [] }; }
    write(key, value, ctx) {
      const s = this.state;
      const cur = s.store[key] || [];
      const v = { value, vv: VV.inc(ctx || VV.merge(...cur.map((c) => c.vv)), this.id), ts: ++s.clock, node: this.id };
      this.integrate(key, v);
      this.broadcast(this.sys.nodes, 'update', { key, v });
      return v;
    }
    integrate(key, v) {
      const s = this.state, cur = s.store[key] || [];
      s.clock = Math.max(s.clock, v.ts);
      if (cur.some((c) => { const r = VV.compare(c.vv, v.vv); return r === 'after' || r === 'equal'; })) return 'old';
      const keep = cur.filter((c) => VV.compare(c.vv, v.vv) === 'concurrent');
      if (!keep.length) { s.store[key] = [v]; return 'newer'; }
      const all = keep.concat([v]);
      const conflict = { key, t: this.now, versions: all.map((x) => ({ value: x.value, vv: x.vv, ts: x.ts, node: x.node })) };
      if (this.sys.resolve === 'lww') {
        const win = all.reduce((a, b) => (b.ts > a.ts || (b.ts === a.ts && b.node > a.node) ? b : a));
        s.store[key] = [Object.assign({}, win, { vv: VV.merge(...all.map((x) => x.vv)) })];
        conflict.winner = win.value; conflict.lost = all.filter((x) => x !== win).map((x) => x.value);
      } else s.store[key] = all;
      s.conflicts.push(conflict);
      this.note('conflict', conflict);
      return 'conflict';
    }
    onMessage(m) {
      const b = m.body, s = this.state;
      if (m.type === 'put') { const v = this.write(b.key, b.value, b.ctx); this.send(m.from, 'putOk', { n: b.n, vv: v.vv, ts: v.ts }); }
      else if (m.type === 'get') this.send(m.from, 'getOk', { n: b.n, key: b.key, versions: s.store[b.key] || [] });
      else if (m.type === 'update') this.integrate(b.key, b.v);
      else if (m.type === 'state') for (const [k, vs] of Object.entries(b.store)) for (const v of vs) this.integrate(k, v);
    }
    onTimer(name) { if (name === 'gossip') { this.gossip(); this.setTimer('gossip', this.sys.antiEntropy); } }
    gossip() { this.broadcast(this.sys.nodes, 'state', { store: this.state.store }); }
  }
  class MMClient extends Client {
    dispatch(c) {
      const to = c.to || this.opts.home || this.sys.nodes[0];
      c.node = to;
      if (c.op === 'write') this.send(to, 'put', { n: c.n, key: c.key, value: c.value, ctx: c.ctx || null });
      else this.send(to, 'get', { n: c.n, key: c.key });
    }
    reply(m, c) {
      const b = m.body;
      if (m.type === 'putOk') return this.finish({ ok: true, vv: b.vv, ver: b.ts });
      if (m.type !== 'getOk') return;
      const vals = b.versions.map((v) => v.value).sort();
      if (c.op === 'merge' && !c.merging) {
        // read the siblings, then write one value whose context covers them all
        c.merging = true; c.siblings = vals;
        const value = c.value !== undefined && c.value !== null ? c.value : vals.slice().sort().join('+');
        c.value = value;
        return this.send(c.node, 'put', { n: c.n, key: c.key, value, ctx: VV.merge(...b.versions.map((v) => v.vv)) });
      }
      this.finish({ ok: true, value: vals.length === 1 ? vals[0] : vals.length ? vals : null, siblings: vals.length, vv: VV.merge(...b.versions.map((v) => v.vv)), ver: b.versions.length ? Math.max(...b.versions.map((v) => v.ts)) : 0 });
    }
  }
  /**
   * opts: seed, nodes, resolve 'lww' | 'vv' (keep siblings), antiEntropy (gossip period, 0 = only when called), net, client.
   * Every node accepts writes and sends each update to the others; a full-state exchange (antiEntropy) catches up
   * whatever a partition or loss kept away.
   */
  class MultiMaster extends System {
    constructor(opts) {
      opts = opts || {};
      super(opts);
      this.ClientClass = MMClient;
      this.resolve = opts.resolve || 'vv';
      this.antiEntropy = opts.antiEntropy || 0;
      for (const n of this.nodes) { const h = this.net.add(n, new MMNode(n, this)); if (this.antiEntropy) h.setTimer('gossip', this.antiEntropy); }
    }
    /** every node sends its whole store to every other now */
    sync() { for (const n of this.nodes) if (this.net.isUp(n)) this.net.node(n).gossip(); return this; }
    values(key) { const o = {}; for (const n of this.nodes) o[n] = (this.replica(n).store[key] || []).map((v) => v.value).sort(); return o; }
    converged(keys) {
      keys = keys || [...new Set(this.nodes.flatMap((n) => Object.keys(this.replica(n).store)))];
      return keys.every((k) => new Set(this.nodes.map((n) => JSON.stringify((this.replica(n).store[k] || []).map((v) => [v.value, VV.str(v.vv)]).sort()))).size === 1);
    }
    conflicts() { return this.nodes.flatMap((n) => this.replica(n).conflicts.map((c) => Object.assign({ at: n }, c))); }
    describe() {
      return {
        name: 'Multi-master replication', resolve: this.resolve, nodes: this.nodes,
        text: 'Every replica accepts writes and propagates them. Each version carries a version vector (one counter per replica); two versions '
          + 'whose vectors are not ordered were written concurrently: a conflict. Last-writer-wins keeps the version with the larger Lamport '
          + 'timestamp (node id breaks ties) and silently loses the other; with version vectors the replica keeps both as siblings and the next '
          + 'client to read them writes a merged value whose context covers both.',
      };
    }
  }

  // ---- quorums ------------------------------------------------------------------------------------------------------
  const vcmp = (a, b) => { a = a || [-1, '']; b = b || [-1, '']; return a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0); };
  class QNode extends C.Actor {
    constructor(id, sys) { super(id); this.sys = sys; this.state = { store: {} }; }
    onMessage(m) {
      const b = m.body, s = this.state;
      if (m.type === 'put') {
        const cur = s.store[b.key];
        if (!cur || vcmp(b.ver, cur.ver) > 0) { s.store[b.key] = { value: b.value, ver: b.ver }; if (b.repair) this.note('repaired', { key: b.key, ver: b.ver }); }
        if (!b.repair) this.send(m.from, 'putAck', { n: b.n });
      } else if (m.type === 'get') { const v = s.store[b.key]; this.send(m.from, 'getR', { n: b.n, key: b.key, value: v ? v.value : null, ver: v ? v.ver : null }); }
    }
  }
  class QClient extends Client {
    targets(k) { const sys = this.sys; return sys.fanout === 'all' ? sys.nodes.slice() : this.rng.shuffle(sys.nodes.slice()).slice(0, k); }
    dispatch(c) {
      const sys = this.sys;
      if (c.op === 'write') { c.ver = [this.now, this.id]; c.acks = []; for (const t of this.targets(sys.W)) this.send(t, 'put', { n: c.n, key: c.key, value: c.value, ver: c.ver }); }
      else { c.replies = []; for (const t of this.targets(sys.R)) this.send(t, 'get', { n: c.n, key: c.key }); }
    }
    reply(m, c) {
      const sys = this.sys;
      if (m.type === 'putAck') { if (!c.acks.includes(m.from)) c.acks.push(m.from); if (c.acks.length >= sys.W) this.finish({ ok: true, replicas: c.acks.slice() }); return; }
      if (m.type !== 'getR') return;
      c.replies.push({ node: m.from, value: m.body.value, ver: m.body.ver });
      if (c.replies.length < sys.R) return;
      const best = c.replies.reduce((a, b) => (vcmp(b.ver, a.ver) > 0 ? b : a));
      this.state.last = { n: c.n, key: c.key, best: clone(best), seen: c.replies.map((r) => r.node) };
      if (sys.readRepair) this.repair(c.key, best, c.replies);
      this.finish({ ok: true, value: best.value, ver: best.ver, from: c.replies.map((r) => r.node), node: best.node });
    }
    repair(key, best, replies) { for (const r of replies) if (best.ver && vcmp(r.ver, best.ver) < 0) { this.note('read repair', { key, node: r.node }); this.send(r.node, 'put', { n: -1, key, value: best.value, ver: best.ver, repair: true }); } }
    // replies that arrive after the read has its R answers can still be repaired
    late(m) {
      const l = this.state.last;
      if (m.type !== 'getR' || !l || m.body.n !== l.n || (this.state.cur && this.state.cur.n === m.body.n)) return;
      if (this.sys.readRepair) this.repair(l.key, l.best, [{ node: m.from, ver: m.body.ver }]);
    }
  }
  /**
   * opts: seed, nodes (N of them), R, W, readRepair, fanout 'all' (ask every replica, wait for the first R or W) or
   * 'quorum' (ask exactly R or W, chosen at random), net, client. A version is [time, client id]; the coordinator
   * is the client itself.
   */
  class Quorum extends System {
    constructor(opts) {
      opts = opts || {};
      super(opts);
      this.ClientClass = QClient;
      this.N = this.nodes.length;
      this.R = opts.R || Math.floor(this.N / 2) + 1;
      this.W = opts.W || Math.floor(this.N / 2) + 1;
      this.readRepair = opts.readRepair !== false;
      this.fanout = opts.fanout || 'all';
      for (const n of this.nodes) this.net.add(n, new QNode(n, this));
    }
    strict() { return this.R + this.W > this.N; }
    violations() { return check(this.history(), vcmp).filter((v) => v.kind === 'stale'); }
    versions(key) { const o = {}; for (const n of this.nodes) { const v = this.replica(n).store[key]; o[n] = v ? v.ver : null; } return o; }
    describe() {
      return {
        name: 'Quorum replication', N: this.N, R: this.R, W: this.W, strict: this.strict(), readRepair: this.readRepair,
        text: 'A write goes to the replicas and succeeds once W have acknowledged; a read asks replicas and returns the newest version among R '
          + 'answers. With R + W > N every read quorum meets every write quorum, so a read that starts after a write completed sees it (or '
          + 'something newer). With R + W <= N it may not. Read repair sends the newest version back to replicas that answered with older ones.',
      };
    }
  }

  // ---- CAP -------------------------------------------------------------------------------------------------------------
  /**
   * Three replicas A, B, C; client c1 next to A and B, client c2 next to C. At t=50 the network splits {A, B, c1} |
   * {C, c2}; both clients write x during the split and read it back; at t=400 the split heals, then both read again.
   * CP: primary copy with the primary A on the majority side; a write needs a majority of copies (the primary and one
   * replica) and reads go to the primary, so the minority side's write and read fail: consistent, not available. AP:
   * every replica accepts writes (multi-master); the sides diverge, and after the heal anti-entropy reconciles them,
   * by last-writer-wins or by keeping both writes as siblings.
   */
  function cap(mode, opts) {
    opts = opts || {};
    const seed = opts.seed === undefined ? 1 : opts.seed;
    const net = Object.assign({ latency: 5, jitter: 2 }, opts.net);
    const cp = mode === 'CP';
    const sys = cp
      ? new PrimaryCopy({ seed, net, nodes: ['A', 'B', 'C'], mode: 'semi', readFrom: 'primary', retry: 50, client: { timeout: 100 } })
      : new MultiMaster({ seed, net, nodes: ['A', 'B', 'C'], resolve: opts.resolve || 'lww', client: { timeout: 100 } });
    const to = (n) => (cp ? {} : { to: n });
    sys.client('c1', [{ op: 'write', key: 'x', value: 'v0', at: 0 }, Object.assign({ op: 'write', key: 'x', value: 'left', at: 100 }, to('A')), Object.assign({ op: 'read', key: 'x', at: 250 }, to('B')), Object.assign({ op: 'read', key: 'x', at: 500 }, to('A'))], { home: 'A' });
    sys.client('c2', [Object.assign({ op: 'write', key: 'x', value: 'right', at: 110 }, to('C')), Object.assign({ op: 'read', key: 'x', at: 260 }, to('C')), Object.assign({ op: 'read', key: 'x', at: 510 }, to('C'))], { home: 'C' });
    sys.net.at(50, 'partition', [['A', 'B', 'c1'], ['C', 'c2']]);
    sys.net.at(400, 'heal');
    if (mode !== 'CP') sys.net.at(420, 'call', () => sys.sync());
    sys.run(800);
    const hist = sys.history();
    const during = hist.filter((h) => h.start >= 50 && h.start < 400);
    const after = hist.filter((h) => h.start >= 400 && h.op === 'read');
    const reads = (hs) => hs.filter((h) => h.op === 'read' && h.ok).map((h) => JSON.stringify(h.value));
    const outcome = {
      mode,
      accepted: during.filter((h) => h.op === 'write' && h.ok).map((h) => h.client + ' ' + h.value),
      refused: during.filter((h) => !h.ok).map((h) => h.client + ' ' + h.op + (h.value ? ' ' + h.value : '') + ': ' + h.err),
      diverged: new Set(reads(during)).size > 1,
      convergedAfter: after.length > 0 && after.every((h) => h.ok) && new Set(reads(after)).size === 1,
      finalValue: after.length && after[0].ok ? after[0].value : null,
      conflicts: sys.conflicts ? sys.conflicts() : [],
    };
    return sys.result({ outcome, system: sys, violations: cp ? sys.violations() : [] });
  }

  /**
   * The session-guarantee demonstration: asynchronous primary-copy, a lagging replica, a client that writes and
   * reads back, and runs with and without the fixes. Returns { plain, tokens, sticky } results with violations.
   */
  function sessions(opts) {
    opts = opts || {};
    const script = [];
    for (let i = 1; i <= (opts.rounds || 12); i++) script.push({ op: 'write', key: 'k', value: 'v' + i }, { op: 'read', key: 'k' }, { op: 'read', key: 'k' });
    const run = (o) => {
      const sys = new PrimaryCopy(Object.assign({ seed: opts.seed === undefined ? 1 : opts.seed, nodes: ['P', 'R1', 'R2'], mode: 'async', readFrom: 'any', lag: { R2: 60 } }, o));
      sys.client('c', script, { think: 2 });
      sys.run();
      return sys.result({ lagSeries: sys.lagSeries, system: sys });
    };
    return { plain: run({}), tokens: run({ tokens: true }), sticky: run({ readFrom: 'sticky' }) };
  }

  C.Replication = {
    VV, check, PrimaryCopy, MultiMaster, Quorum, cap, sessions,
    primaryCopy: (o) => new PrimaryCopy(o), multiMaster: (o) => new MultiMaster(o), quorum: (o) => new Quorum(o),
    describe() {
      return {
        name: 'Replication',
        designs: ['primary copy (sync, semi-sync, async)', 'multi-master (LWW, version vectors)', 'quorum (N, R, W) with read repair'],
        guarantees: ['read-your-writes', 'monotonic reads', 'no stale reads with R + W > N'],
        text: 'Replicas are key-value stores on the simulated network. Clients run scripts and keep histories; check() finds read-your-writes, '
          + 'monotonic-read and stale-read violations in them. cap(\'CP\') and cap(\'AP\') replay the same partition against a majority-quorum '
          + 'system and an always-writable one.',
      };
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
