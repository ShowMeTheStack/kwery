// Consensus on the simulated network: Raft (leader election, log replication, a replicated key-value store) and,
// for comparison, single-decree Paxos and a short multi-Paxos model. Nodes keep their state as plain data, split
// as the papers split it: Raft's currentTerm, votedFor and log (and a Paxos acceptor's promise and accepted
// proposal) survive a crash; everything else is rebuilt after a restart. A checker watches every run for the
// safety properties of the Raft paper (figure 3) and for Paxos's "at most one value is chosen".
(function (root) {
  'use strict';
  const K = root.K;
  const C = K.Cluster = K.Cluster || {};
  const clone = (v) => C.clone(v);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  /** the replicated state machine: a key-value map that also remembers each client's answered requests */
  function applyCmd(kv, e) {
    const cmd = e.cmd || {};
    if (e.client && e.req && kv.done[e.client + '/' + e.req]) return { result: kv.done[e.client + '/' + e.req].result, duplicate: true };
    let result;
    switch (cmd.op) {
      case 'set': kv.data[cmd.key] = cmd.value; result = { ok: true }; break;
      case 'del': result = { ok: cmd.key in kv.data }; delete kv.data[cmd.key]; break;
      case 'get': result = { ok: true, value: cmd.key in kv.data ? kv.data[cmd.key] : null }; break;
      case 'cas': { const cur = cmd.key in kv.data ? kv.data[cmd.key] : null; result = { ok: same(cur, cmd.expect), value: cur }; if (result.ok) kv.data[cmd.key] = cmd.value; break; }
      case 'incr': kv.data[cmd.key] = (Number(kv.data[cmd.key]) || 0) + (cmd.by === undefined ? 1 : cmd.by); result = { ok: true, value: kv.data[cmd.key] }; break;
      default: result = { ok: true };
    }
    if (e.client && e.req) kv.done[e.client + '/' + e.req] = { result };
    return { result };
  }
  const freshKv = () => ({ data: {}, done: {} });

  // ---- Raft ------------------------------------------------------------------------------------------------------
  class RaftNode extends C.Actor {
    constructor(id, peers, cfg) {
      super(id);
      this.peers = peers;
      this.cfg = cfg;
      this.state = { term: 0, votedFor: null, log: [] };
      this.volatile();
    }
    get role() { return this.state.role; }
    volatile() {
      Object.assign(this.state, { role: 'follower', leader: null, commit: 0, applied: 0, kv: freshKv(), votes: [], next: {}, match: {} });
    }
    get majority() { return Math.floor(this.peers.length / 2) + 1; }
    lastIndex() { return this.state.log.length; }
    lastTerm() { const l = this.state.log; return l.length ? l[l.length - 1].term : 0; }
    termAt(i) { return i <= 0 ? 0 : this.state.log[i - 1] ? this.state.log[i - 1].term : -1; }
    others() { return this.peers.filter((p) => p !== this.id); }
    resetElection() { this.cancelTimers('election'); this.setTimer('election', this.cfg.electionMin + this.rng.next() * (this.cfg.electionMax - this.cfg.electionMin)); }
    start() { this.resetElection(); }
    onCrash() { /* term, votedFor and log are on stable storage; the rest is lost */ }
    onRestart() { this.volatile(); this.note('recover', { term: this.state.term, log: this.state.log.length }); this.resetElection(); }
    /** a higher term seen anywhere turns any node into a follower of that term */
    adopt(term) {
      if (term <= this.state.term) return false;
      const was = this.state.role;
      this.state.term = term; this.state.votedFor = null;
      if (was !== 'follower') { this.state.role = 'follower'; this.cancelTimers('heartbeat'); this.note('stepdown', { term }); this.resetElection(); }
      return true;
    }
    onTimer(name) {
      if (name === 'election' && this.state.role !== 'leader') this.campaign();
      else if (name === 'heartbeat' && this.state.role === 'leader') { this.replicate(); this.setTimer('heartbeat', this.cfg.heartbeat); }
    }
    campaign() {
      const s = this.state;
      s.term++; s.role = 'candidate'; s.votedFor = this.id; s.votes = [this.id]; s.leader = null;
      this.note('candidate', { term: s.term });
      this.resetElection();
      this.broadcast(this.peers, 'RequestVote', { term: s.term, cand: this.id, lastIndex: this.lastIndex(), lastTerm: this.lastTerm() });
      if (s.votes.length >= this.majority) this.lead();
    }
    lead() {
      const s = this.state;
      s.role = 'leader'; s.leader = this.id;
      for (const p of this.others()) { s.next[p] = this.lastIndex() + 1; s.match[p] = 0; }
      this.cancelTimers('election');
      this.note('leader', { term: s.term });
      // an entry of its own term lets the leader commit what earlier leaders left uncommitted
      if (this.cfg.noop) this.append({ term: s.term, cmd: { op: 'noop' } });
      this.replicate();
      this.setTimer('heartbeat', this.cfg.heartbeat);
    }
    append(e) { this.state.log.push(e); this.note('append', { index: this.lastIndex(), term: e.term, cmd: e.cmd }); }
    replicate(only) {
      for (const p of only ? [only] : this.others()) {
        const s = this.state, next = s.next[p], prev = next - 1;
        this.send(p, 'AppendEntries', { term: s.term, leader: this.id, prevIndex: prev, prevTerm: this.termAt(prev), entries: s.log.slice(prev, prev + this.cfg.maxBatch), commit: s.commit });
      }
    }
    onMessage(m) {
      const s = this.state, b = m.body;
      if (m.type === 'request') return this.request(m);
      if (b.term !== undefined) this.adopt(b.term);
      switch (m.type) {
        case 'RequestVote': {
          const upToDate = b.lastTerm > this.lastTerm() || (b.lastTerm === this.lastTerm() && b.lastIndex >= this.lastIndex());
          const granted = b.term === s.term && (s.votedFor === null || s.votedFor === b.cand) && upToDate;
          if (granted) { s.votedFor = b.cand; this.note('vote', { term: s.term, for: b.cand }); this.resetElection(); }
          this.send(m.from, 'VoteReply', { term: s.term, granted, why: granted ? null : b.term < s.term ? 'stale term' : !upToDate ? 'log not up to date' : 'already voted for ' + s.votedFor });
          break;
        }
        case 'VoteReply':
          if (s.role === 'candidate' && b.term === s.term && b.granted && !s.votes.includes(m.from)) { s.votes.push(m.from); if (s.votes.length >= this.majority) this.lead(); }
          break;
        case 'AppendEntries': return this.appendEntries(m);
        case 'AppendReply': {
          if (s.role !== 'leader' || b.term !== s.term) break;
          if (b.ok) {
            if (b.match > s.match[m.from]) s.match[m.from] = b.match;
            s.next[m.from] = Math.max(s.next[m.from], b.match + 1);
            this.advance();
            if (s.next[m.from] <= this.lastIndex()) this.replicate(m.from);
          } else {
            s.next[m.from] = Math.max(1, this.cfg.fastBackup ? Math.min(b.hint, s.next[m.from] - 1) : s.next[m.from] - 1);
            this.note('backup', { peer: m.from, next: s.next[m.from] });
            this.replicate(m.from);
          }
          break;
        }
      }
    }
    appendEntries(m) {
      const s = this.state, b = m.body;
      if (b.term < s.term) return this.send(m.from, 'AppendReply', { term: s.term, ok: false, hint: this.lastIndex() + 1, why: 'stale term' });
      if (s.role !== 'follower') { s.role = 'follower'; this.cancelTimers('heartbeat'); this.note('stepdown', { term: s.term }); }
      s.leader = b.leader;
      this.resetElection();
      // the consistency check: the entry before the new ones must match the leader's
      if (b.prevIndex > this.lastIndex() || this.termAt(b.prevIndex) !== b.prevTerm) {
        let hint = this.lastIndex() + 1;
        if (b.prevIndex <= this.lastIndex()) { const t = this.termAt(b.prevIndex); hint = b.prevIndex; while (hint > 1 && this.termAt(hint - 1) === t) hint--; }
        return this.send(m.from, 'AppendReply', { term: s.term, ok: false, hint, why: b.prevIndex > this.lastIndex() ? 'missing entry ' + b.prevIndex : 'term mismatch at ' + b.prevIndex });
      }
      b.entries.forEach((e, k) => {
        const i = b.prevIndex + 1 + k;
        if (this.termAt(i) !== e.term) {
          if (i <= this.lastIndex()) { this.note('truncate', { from: i, dropped: s.log.slice(i - 1).map((x) => ({ term: x.term, cmd: x.cmd })) }); s.log.length = i - 1; }
          this.append(clone(e));
        }
      });
      const match = b.prevIndex + b.entries.length;
      if (b.commit > s.commit) this.commitTo(Math.min(b.commit, match));
      this.send(m.from, 'AppendReply', { term: s.term, ok: true, match });
    }
    /** the leader commits the highest index stored on a majority, if that entry is from its own term */
    advance() {
      const s = this.state;
      for (let n = this.lastIndex(); n > s.commit; n--) {
        if (this.termAt(n) !== s.term) break;
        const count = 1 + this.others().filter((p) => s.match[p] >= n).length;
        if (count >= this.majority) { this.commitTo(n); break; }
      }
    }
    commitTo(n) {
      const s = this.state;
      if (n <= s.commit) return;
      s.commit = n;
      this.note('commit', { index: n, term: s.term });
      while (s.applied < s.commit) {
        s.applied++;
        const e = s.log[s.applied - 1];
        const r = applyCmd(s.kv, e);
        this.note('apply', { index: s.applied, term: e.term, cmd: e.cmd, result: r.result, duplicate: !!r.duplicate });
        if (s.role === 'leader' && e.client) this.send(e.client, 'response', { req: e.req, ok: true, index: s.applied, result: r.result, leader: this.id });
      }
    }
    /** a client request: only the leader takes it; the others say who they think leads */
    request(m) {
      const s = this.state, b = m.body;
      if (s.role !== 'leader') return this.send(m.from, 'redirect', { req: b.req, leader: s.leader });
      const key = m.from + '/' + b.req;
      if (s.kv.done[key]) return this.send(m.from, 'response', { req: b.req, ok: true, result: s.kv.done[key].result, leader: this.id, duplicate: true });
      if (s.log.some((e) => e.client === m.from && e.req === b.req)) return;
      this.append({ term: s.term, cmd: clone(b.cmd), client: m.from, req: b.req });
      this.replicate();
    }
  }

  class RaftClient extends C.Actor {
    constructor(id, cfg) { super(id); this.cfg = cfg; this.state = { reqs: {}, order: [], n: 0, hint: null }; }
    submit(cmd, to) {
      const s = this.state, id = 'r' + (++s.n);
      s.reqs[id] = { id, cmd: clone(cmd), status: 'pending', tries: 0, to: to || null, sent: this.now, done: null, result: null, index: null, leader: null };
      s.order.push(id);
      this.issue(id);
      return id;
    }
    issue(id) {
      const s = this.state, r = s.reqs[id];
      const up = this.cfg.ids.filter((x) => this.net.isUp(x));
      const to = r.to || s.hint || this.rng.pick(up.length ? up : this.cfg.ids);
      r.tries++; r.to = null;
      this.send(to, 'request', { req: id, cmd: r.cmd });
      this.setTimer('retry', this.cfg.clientTimeout, { req: id, tries: r.tries });
    }
    /** stop retrying a request (its fate is then whatever the log says) */
    abandon(id) { const r = this.state.reqs[id]; if (r && r.status === 'pending') r.status = 'abandoned'; }
    onMessage(m) {
      const s = this.state, r = s.reqs[m.body.req];
      if (!r || r.status !== 'pending') return;
      if (m.type === 'redirect') {
        s.hint = m.body.leader && m.body.leader !== m.from ? m.body.leader : null;
        // with a hint go there at once; without one, wait for the retry timer (an election may be running)
        if (s.hint && r.tries < this.cfg.maxTries) { r.to = s.hint; this.issue(r.id); }
      } else if (m.type === 'response') {
        Object.assign(r, { status: 'done', done: this.now, result: m.body.result, index: m.body.index, leader: m.body.leader });
        s.hint = m.body.leader;
        this.note('done', { req: r.id, index: r.index, result: r.result });
      }
    }
    onTimer(name, d) {
      const r = this.state.reqs[d.req];
      if (!r || r.status !== 'pending' || r.tries !== d.tries) return;
      if (r.tries >= this.cfg.maxTries) { r.status = 'failed'; this.note('failed', { req: r.id }); return; }
      this.state.hint = null;
      this.issue(r.id);
    }
  }

  const RAFT = { n: 5, latency: 10, jitter: 5, electionMin: 150, electionMax: 300, heartbeat: 50, maxBatch: 20, noop: true, fastBackup: true, clientTimeout: 400, maxTries: 30 };

  class RaftCluster {
    constructor(opts) {
      opts = Object.assign({}, RAFT, opts || {});
      this.cfg = opts;
      this.net = opts.net || new C.Net({ seed: opts.seed === undefined ? 1 : opts.seed, latency: opts.latency, jitter: opts.jitter, loss: opts.loss || 0, dup: opts.dup || 0, undo: opts.undo || 0 });
      this.ids = opts.ids || K.range(opts.n).map((i) => 's' + (i + 1));
      for (const id of this.ids) this.net.add(id, new RaftNode(id, this.ids, opts));
      this.client = this.net.add('client', new RaftClient('client', Object.assign({ ids: this.ids }, opts)));
      this.chk = { leaders: {}, committed: {}, applied: {}, violations: [] };
      this.net.on((e) => this.watch(e));
      for (const id of this.ids) this.net.node(id).start();
    }
    node(id) { return this.net.node(id); }
    nodes() { return this.ids.map((id) => this.net.node(id)); }
    // ---- driving -------------------------------------------------------------------------------------------------
    submit(cmd, opts) { return this.client.submit(cmd, opts && opts.to); }
    result(req) { return clone(this.client.state.reqs[req]); }
    results() { return this.client.state.order.map((r) => clone(this.client.state.reqs[r])); }
    step() { return this.net.step(); }
    run(until) { return this.net.run(until); }
    runFor(dt) { return this.net.runFor(dt); }
    crash(id) { this.net.crash(id); return this; }
    restart(id) { this.net.restart(id); return this; }
    /** the client joins the largest group unless a group names it */
    partition(groups) {
      groups = groups.map((g) => g.slice());
      if (!groups.some((g) => g.includes('client'))) groups.reduce((a, g) => (g.length > a.length ? g : a), groups[0]).push('client');
      this.net.partition(groups); return this;
    }
    heal() { this.net.heal(); return this; }
    /** run until some up node is leader (or the time limit passes); returns its id */
    elect(limit) { const end = this.net.clock + (limit || 3000); this.net.run((n) => n.clock > end || !!this.leader()); return this.leader(); }
    /** run until the request is answered */
    await(req, limit) { const end = this.net.clock + (limit || 5000); this.net.run((n) => n.clock > end || this.client.state.reqs[req].status !== 'pending'); return this.result(req); }
    /** the leader with the highest term among the nodes that are up */
    leader() {
      let best = null;
      for (const n of this.nodes()) if (this.net.isUp(n.id) && n.state.role === 'leader' && (!best || n.state.term > best.state.term)) best = n;
      return best ? best.id : null;
    }
    leaders() { return this.nodes().filter((n) => this.net.isUp(n.id) && n.state.role === 'leader').map((n) => n.id); }
    // ---- safety ----------------------------------------------------------------------------------------------------
    violate(prop, detail) { this.chk.violations.push({ prop, t: this.net.clock, detail }); }
    watch(e) {
      if (e.kind !== 'note' || !this.ids.includes(e.node)) return;
      const n = this.node(e.node), c = this.chk;
      if (e.what === 'leader') {
        const t = e.data.term;
        if (c.leaders[t] && c.leaders[t] !== e.node) this.violate('election safety', 'two leaders in term ' + t + ': ' + c.leaders[t] + ' and ' + e.node);
        c.leaders[t] = e.node;
        for (const [i, x] of Object.entries(c.committed)) if (x.at < t && n.termAt(+i) !== x.term) this.violate('leader completeness', 'leader ' + e.node + ' of term ' + t + ' lacks committed entry ' + i);
      } else if (e.what === 'commit') {
        for (let i = 1; i <= e.data.index; i++) {
          const x = c.committed[i], term = n.termAt(i);
          if (!x) c.committed[i] = { term, at: n.state.term, cmd: n.state.log[i - 1].cmd };
          else if (x.term !== term) this.violate('commit safety', 'index ' + i + ' committed with terms ' + x.term + ' and ' + term);
        }
      } else if (e.what === 'apply') {
        const x = c.applied[e.data.index], v = { term: e.data.term, cmd: e.data.cmd };
        if (!x) c.applied[e.data.index] = v;
        else if (!same(x, v)) this.violate('state machine safety', e.node + ' applied a different entry at ' + e.data.index);
      } else if (e.what === 'append' || e.what === 'truncate') this.checkLogs(e.node);
    }
    /** log matching: two logs with an entry of the same index and term are identical up to there */
    checkLogs(only) {
      const ns = this.nodes();
      for (const a of ns) for (const b of ns) {
        if (a.id >= b.id || (only && a.id !== only && b.id !== only)) continue;
        const la = a.state.log, lb = b.state.log;
        let i = Math.min(la.length, lb.length);
        while (i > 0 && la[i - 1].term !== lb[i - 1].term) i--;
        for (let j = 0; j < i; j++) if (la[j].term !== lb[j].term || !same(la[j].cmd, lb[j].cmd)) { this.violate('log matching', a.id + ' and ' + b.id + ' agree at ' + i + ' but differ at ' + (j + 1)); return; }
      }
    }
    /** every property checked now; violations seen during the run are kept */
    check() {
      this.checkLogs();
      const v = this.chk.violations;
      const has = (p) => !v.some((x) => x.prop === p);
      return { ok: !v.length, violations: clone(v), electionSafety: has('election safety'), logMatching: has('log matching'), leaderCompleteness: has('leader completeness'), stateMachineSafety: has('state machine safety') && has('commit safety') };
    }
    // ---- drawing -----------------------------------------------------------------------------------------------------
    view() {
      return {
        clock: this.net.clock,
        nodes: this.nodes().map((n) => {
          const s = n.state;
          return { id: n.id, up: this.net.isUp(n.id), role: s.role, term: s.term, votedFor: s.votedFor, leader: s.leader, commit: s.commit, applied: s.applied,
            log: s.log.map((e, i) => ({ index: i + 1, term: e.term, cmd: e.cmd, committed: i < s.commit })), kv: clone(s.kv.data), next: clone(s.next), match: clone(s.match) };
        }),
        leader: this.leader(), terms: clone(this.chk.leaders), inFlight: this.net.inFlight(), groups: clone(this.net.groups),
      };
    }
    snapshot() { return { net: this.net.snapshot(), chk: clone(this.chk) }; }
    restore(s) { this.net.restore(s.net); this.chk = clone(s.chk); }
    describe() {
      return {
        name: 'Raft',
        text: 'Raft keeps a replicated log. A follower that hears nothing for a randomized election timeout becomes a candidate, '
          + 'increments its term and asks for votes; a node votes once per term, and only for a candidate whose log is at least as '
          + 'up to date as its own. The leader appends client commands to its log and sends AppendEntries; a follower accepts them '
          + 'only if its entry at prevIndex has prevTerm (the consistency check), deleting any conflicting suffix. An entry is '
          + 'committed once the leader has it stored on a majority and it is from the leader\'s current term; committed entries '
          + 'are applied in order to the key-value state machine. A leader cut off in a minority keeps its term but can commit '
          + 'nothing; after the partition heals it sees a higher term, steps down, and its uncommitted entries are overwritten.',
        cfg: { n: this.ids.length, electionTimeout: [this.cfg.electionMin, this.cfg.electionMax], heartbeat: this.cfg.heartbeat, noop: this.cfg.noop },
        messages: ['RequestVote', 'VoteReply', 'AppendEntries', 'AppendReply', 'request', 'redirect', 'response'],
        notes: ['candidate', 'vote', 'leader', 'stepdown', 'append', 'truncate', 'backup', 'commit', 'apply', 'recover', 'done', 'failed'],
        properties: ['election safety', 'leader append-only', 'log matching', 'leader completeness', 'state machine safety'],
        persistent: ['term', 'votedFor', 'log'], volatile: ['role', 'leader', 'commit', 'applied', 'kv', 'next', 'match'],
      };
    }
  }

  /** the demonstrations; each returns the cluster (for drawing), the steps taken and what came out */
  const scenarios = {
    election(opts) {
      const c = new RaftCluster(Object.assign({ n: 5 }, opts));
      const leader = c.elect();
      return { cluster: c, steps: [{ t: c.net.clock, what: 'leader elected', leader, term: c.node(leader).state.term }], trace: c.net.trace };
    },
    leaderCrash(opts) {
      const c = new RaftCluster(Object.assign({ n: 5 }, opts));
      const steps = [];
      const l1 = c.elect(); steps.push({ t: c.net.clock, what: 'leader elected', leader: l1, term: c.node(l1).state.term });
      const r1 = c.await(c.submit({ op: 'set', key: 'x', value: 1 })); steps.push({ t: c.net.clock, what: 'x = 1 committed', index: r1.index });
      c.crash(l1); steps.push({ t: c.net.clock, what: 'leader crashes', node: l1 });
      const l2 = c.elect(); steps.push({ t: c.net.clock, what: 'new leader', leader: l2, term: c.node(l2).state.term });
      const r2 = c.await(c.submit({ op: 'set', key: 'y', value: 2 })); steps.push({ t: c.net.clock, what: 'y = 2 committed', index: r2.index });
      c.restart(l1); c.runFor(600); steps.push({ t: c.net.clock, what: 'old leader back as follower', role: c.node(l1).state.role, kv: clone(c.node(l1).state.kv.data) });
      return { cluster: c, steps, trace: c.net.trace, check: c.check() };
    },
    /** a leader in a minority partition takes a write it cannot commit; the majority elects another and goes on */
    minorityPartition(opts) {
      const c = new RaftCluster(Object.assign({ n: 5 }, opts));
      const steps = [];
      const l1 = c.elect();
      c.await(c.submit({ op: 'set', key: 'x', value: 1 }));
      const minority = [l1, c.ids.find((i) => i !== l1)], majority = c.ids.filter((i) => !minority.includes(i));
      c.partition([minority.concat(['client']), majority]); steps.push({ t: c.net.clock, what: 'partition', minority, majority });
      const before = c.node(l1).state.commit;
      const lost = c.client.submit({ op: 'set', key: 'x', value: 'minority' }, l1);
      c.runFor(800);
      steps.push({ t: c.net.clock, what: 'minority leader cannot commit', leader: l1, logLength: c.node(l1).state.log.length, commit: c.node(l1).state.commit, committedBefore: before, request: c.result(lost).status });
      const l2 = c.leaders().find((i) => majority.includes(i));
      steps.push({ t: c.net.clock, what: 'majority elected its own leader', leader: l2, term: l2 ? c.node(l2).state.term : null, oldTerm: c.node(l1).state.term });
      return { cluster: c, steps, trace: c.net.trace, minority, majority, oldLeader: l1, newLeader: l2, lostReq: lost };
    },
    /** after the partition heals the old leader steps down and its uncommitted suffix is replaced */
    logRepair(opts) {
      const r = scenarios.minorityPartition(opts);
      const c = r.cluster;
      c.client.abandon(r.lostReq);
      c.net.partition([r.majority.concat(['client']), r.minority]);
      const w = c.await(c.client.submit({ op: 'set', key: 'x', value: 'majority' }, r.newLeader));
      r.steps.push({ t: c.net.clock, what: 'majority commits', index: w.index });
      c.heal(); c.runFor(800);
      const old = c.node(r.oldLeader);
      r.steps.push({ t: c.net.clock, what: 'healed: old leader repaired', role: old.state.role, term: old.state.term, x: old.state.kv.data.x, truncated: c.net.trace.filter((e) => e.kind === 'note' && e.what === 'truncate' && r.minority.includes(e.node)).map((e) => ({ node: e.node, from: e.data.from })) });
      return Object.assign(r, { check: c.check() });
    },
  };

  C.Raft = { create: (opts) => new RaftCluster(opts), Cluster: RaftCluster, Node: RaftNode, Client: RaftClient, applyCmd, scenarios, defaults: RAFT, describe: () => RaftCluster.prototype.describe.call({ ids: K.range(RAFT.n), cfg: RAFT }) };

  // ---- single-decree Paxos -------------------------------------------------------------------------------------------
  // Ballot numbers are round * 16 + proposer index, so two proposers never use the same one.
  const ballot = (round, idx) => round * 16 + idx;
  const roundOf = (n) => Math.floor(n / 16);

  class Acceptor extends C.Actor {
    constructor(id, cfg) { super(id); this.cfg = cfg; this.state = { promised: -1, accepted: null }; }
    get role() { return 'acceptor'; }
    onMessage(m) {
      const s = this.state, b = m.body;
      if (m.type === 'prepare') {
        if (b.n > s.promised) { s.promised = b.n; this.note('promise', { n: b.n, accepted: clone(s.accepted) }); this.send(m.from, 'promise', { n: b.n, accepted: clone(s.accepted) }); }
        else this.send(m.from, 'nack', { n: b.n, promised: s.promised });
      } else if (m.type === 'accept') {
        if (b.n >= s.promised) {
          s.promised = b.n; s.accepted = { n: b.n, v: b.v };
          this.note('accepted', { n: b.n, v: b.v });
          for (const l of this.cfg.learners.includes(m.from) ? this.cfg.learners : this.cfg.learners.concat([m.from])) this.send(l, 'accepted', { n: b.n, v: b.v });
        } else this.send(m.from, 'nack', { n: b.n, promised: s.promised });
      }
    }
  }
  /** counts accepted messages per ballot; a majority for one ballot means its value is chosen */
  function learn(s, m, majority) {
    const k = String(m.body.n);
    s.votes[k] = s.votes[k] || {};
    s.votes[k][m.from] = m.body.v;
    if (s.chosen === null && Object.keys(s.votes[k]).length >= majority) { s.chosen = m.body.v; return true; }
    return false;
  }
  class Learner extends C.Actor {
    constructor(id, cfg) { super(id); this.cfg = cfg; this.state = { votes: {}, chosen: null }; }
    get role() { return 'learner'; }
    onMessage(m) { if (m.type === 'accepted' && learn(this.state, m, this.cfg.majority)) this.note('chosen', { v: this.state.chosen, n: m.body.n }); }
  }
  class Proposer extends C.Actor {
    constructor(id, idx, cfg) { super(id); this.cfg = cfg; this.state = { idx, value: null, round: 0, n: -1, phase: 'idle', promises: {}, acks: {}, highest: -1, votes: {}, chosen: null, attempts: 0 }; }
    get role() { return 'proposer'; }
    propose(v) { this.state.value = v; this.prepare(); }
    prepare() {
      const s = this.state;
      if (s.chosen !== null) return;
      s.round = Math.max(s.round, roundOf(s.highest)) + 1;
      s.n = ballot(s.round, s.idx); s.phase = 'prepare'; s.promises = {}; s.acks = {}; s.attempts++;
      this.note('prepare', { n: s.n });
      this.broadcast(this.cfg.acceptors, 'prepare', { n: s.n });
      this.cancelTimers('retry');
      this.setTimer('retry', this.cfg.timeout, { n: s.n });
    }
    backoff() { this.cancelTimers('retry'); this.state.phase = 'backoff'; this.setTimer('retry', this.cfg.backoff * (0.5 + this.rng.next()), { n: this.state.n }); }
    onMessage(m) {
      const s = this.state, b = m.body;
      if (m.type === 'accepted') {
        if (learn(s, m, this.cfg.majority)) { s.phase = 'done'; this.cancelTimers('retry'); this.note('chosen', { v: s.chosen, n: b.n, mine: b.n === s.n }); }
        return;
      }
      if (b.n !== s.n || s.phase === 'done') { if (m.type === 'nack') s.highest = Math.max(s.highest, b.promised); return; }
      if (m.type === 'nack') { s.highest = Math.max(s.highest, b.promised); this.note('rejected', { n: s.n, promised: b.promised }); this.backoff(); }
      else if (m.type === 'promise' && s.phase === 'prepare') {
        s.promises[m.from] = b.accepted;
        if (Object.keys(s.promises).length >= this.cfg.majority) {
          // the value of the highest-numbered proposal any promiser accepted, or our own if none did
          const prior = Object.values(s.promises).filter(Boolean).sort((x, y) => y.n - x.n)[0];
          s.phase = 'accept';
          s.proposed = prior ? prior.v : s.value;
          this.note('propose', { n: s.n, v: s.proposed, adopted: !!prior });
          this.broadcast(this.cfg.acceptors, 'accept', { n: s.n, v: s.proposed });
        }
      }
    }
    onTimer(name, d) { if (name === 'retry' && this.state.phase !== 'done' && d.n === this.state.n) this.prepare(); }
    onCrash() { }
    onRestart() { const s = this.state; if (s.phase !== 'done' && s.value !== null) { s.phase = 'idle'; this.setTimer('retry', this.cfg.backoff, { n: s.n }); } }
  }

  class PaxosSingle {
    /**
     * opts: acceptors (3), proposers (2), values, start (times each proposer begins), seed, latency, jitter, loss, dup,
     * proposersLearn (false: a proposer hears only about its own ballots)
     */
    constructor(opts) {
      opts = Object.assign({ acceptors: 3, proposers: 2, latency: 10, jitter: 8, timeout: 120, backoff: 60, seed: 1 }, opts || {});
      this.cfg = opts;
      this.net = new C.Net({ seed: opts.seed, latency: opts.latency, jitter: opts.jitter, loss: opts.loss || 0, dup: opts.dup || 0 });
      this.acceptors = K.range(opts.acceptors).map((i) => 'a' + (i + 1));
      this.proposers = K.range(opts.proposers).map((i) => 'p' + (i + 1));
      const cfg = { acceptors: this.acceptors, majority: Math.floor(opts.acceptors / 2) + 1, learners: (opts.proposersLearn === false ? [] : this.proposers).concat(['learner']), timeout: opts.timeout, backoff: opts.backoff };
      this.majority = cfg.majority;
      for (const a of this.acceptors) this.net.add(a, new Acceptor(a, cfg));
      this.proposers.forEach((p, i) => this.net.add(p, new Proposer(p, i + 1, cfg)));
      this.learner = this.net.add('learner', new Learner('learner', cfg));
      this.chk = { acc: {}, chosen: [], violations: [] };
      this.net.on((e) => this.watch(e));
      const values = opts.values || this.proposers.map((p, i) => String.fromCharCode(65 + i));
      const start = opts.start || this.proposers.map(() => 0);
      this.proposers.forEach((p, i) => { if (values[i] !== undefined && values[i] !== null) this.net.at(start[i] || 0, 'call', (net) => net.node(p).propose(values[i])); });
    }
    propose(p, v) { this.net.node(p).propose(v); return this; }
    run(until) { return this.net.run(until); }
    /** a value is chosen once a majority of acceptors accepted the same ballot; the checker records each one */
    watch(e) {
      if (e.kind !== 'note') return;
      if (e.what === 'accepted') {
        const k = String(e.data.n), a = this.chk.acc[k] = this.chk.acc[k] || { v: e.data.v, by: {} };
        a.by[e.node] = 1;
        if (Object.keys(a.by).length === this.majority) {
          this.chk.chosen.push({ n: e.data.n, v: a.v, t: e.t });
          if (this.chk.chosen.some((x) => !same(x.v, a.v))) this.chk.violations.push({ prop: 'at most one value chosen', t: e.t, detail: clone(this.chk.chosen) });
        }
      }
      if (e.what === 'chosen' && this.chk.chosen.length && !same(this.chk.chosen[0].v, e.data.v)) this.chk.violations.push({ prop: 'learners learn the chosen value', t: e.t, node: e.node });
    }
    chosen() { return this.chk.chosen.length ? this.chk.chosen[0].v : null; }
    check() { return { ok: !this.chk.violations.length, violations: clone(this.chk.violations), chosen: this.chosen(), ballots: this.chk.chosen.map((x) => x.n) }; }
    view() {
      return {
        clock: this.net.clock,
        acceptors: this.acceptors.map((a) => Object.assign({ id: a, up: this.net.isUp(a) }, clone(this.net.node(a).state))),
        proposers: this.proposers.map((p) => { const s = this.net.node(p).state; return { id: p, up: this.net.isUp(p), phase: s.phase, n: s.n, value: s.value, proposed: s.proposed, chosen: s.chosen, attempts: s.attempts }; }),
        learner: clone(this.learner.state.chosen), inFlight: this.net.inFlight(),
      };
    }
    snapshot() { return { net: this.net.snapshot(), chk: clone(this.chk) }; }
    restore(s) { this.net.restore(s.net); this.chk = clone(s.chk); }
    describe() {
      return {
        name: 'Paxos (single decree)',
        text: 'A proposer picks a ballot number n and sends prepare(n). An acceptor promises to ignore ballots below n and reports the '
          + 'proposal it has accepted, if any. With promises from a majority the proposer sends accept(n, v), where v is the value of '
          + 'the highest-numbered proposal reported, or its own value if none was. An acceptor accepts unless it has promised a higher '
          + 'ballot. A value is chosen when a majority accepts the same ballot; any later ballot finds it in some promise and proposes '
          + 'it again, so at most one value is ever chosen. Two proposers can keep pre-empting each other (duelling); randomized '
          + 'back-off breaks the tie, and multi-Paxos avoids it with a stable leader.',
        messages: ['prepare', 'promise', 'nack', 'accept', 'accepted'], notes: ['prepare', 'promise', 'propose', 'accepted', 'rejected', 'chosen'],
        persistent: ['promised', 'accepted'],
      };
    }
  }

  // ---- multi-Paxos ------------------------------------------------------------------------------------------------------
  // Every node is an acceptor; one is the leader. A leader runs phase 1 once for all slots, adopting values its
  // promisers report and filling gaps with no-ops; after that each command needs phase 2 only.
  class MPNode extends C.Actor {
    constructor(id, idx, cfg) {
      super(id); this.cfg = cfg;
      this.state = { idx, promised: -1, slots: {}, chosen: {}, leader: false, n: -1, round: 0, promises: {}, props: {}, nextSlot: 1, queue: [] };
    }
    get role() { return this.state.leader ? 'leader' : 'acceptor'; }
    lead() {
      const s = this.state;
      s.round = Math.max(s.round, roundOf(s.promised)) + 1;
      s.n = ballot(s.round, s.idx); s.leader = false; s.promises = {};
      this.note('prepare', { n: s.n });
      this.broadcast(this.cfg.ids, 'prepare', { n: s.n });
      this.onMessage({ type: 'prepare', from: this.id, body: { n: s.n } });
    }
    submit(cmd) { const s = this.state; if (!s.leader) { s.queue.push(cmd); return null; } return this.propose(s.nextSlot++, cmd); }
    propose(slot, v) {
      const s = this.state;
      s.props[slot] = { v, acks: {} };
      this.note('accept', { n: s.n, slot, v });
      this.broadcast(this.cfg.ids, 'accept', { n: s.n, slot, v });
      this.onMessage({ type: 'accept', from: this.id, body: { n: s.n, slot, v } });
      return slot;
    }
    onMessage(m) {
      const s = this.state, b = m.body, reply = (type, body) => (m.from === this.id ? this.onMessage({ type, from: this.id, body }) : this.send(m.from, type, body));
      switch (m.type) {
        case 'prepare':
          if (b.n > s.promised) { s.promised = b.n; if (m.from !== this.id) s.leader = false; reply('promise', { n: b.n, slots: clone(s.slots) }); }
          else reply('nack', { n: b.n, promised: s.promised });
          break;
        case 'accept':
          if (b.n >= s.promised) { s.promised = b.n; s.slots[b.slot] = { n: b.n, v: b.v }; reply('accepted', { n: b.n, slot: b.slot }); }
          else reply('nack', { n: b.n, promised: s.promised });
          break;
        case 'promise': {
          if (b.n !== s.n || s.leader) break;
          s.promises[m.from] = b.slots;
          if (Object.keys(s.promises).length < this.cfg.majority) break;
          s.leader = true;
          const best = {};
          for (const sl of Object.values(s.promises)) for (const [k, x] of Object.entries(sl)) if (!best[k] || x.n > best[k].n) best[k] = x;
          const top = Math.max(0, ...Object.keys(best).map(Number), ...Object.keys(s.chosen).map(Number));
          this.note('leader', { n: s.n, adopted: Object.keys(best).length, top });
          s.nextSlot = top + 1;
          for (let k = 1; k <= top; k++) if (!(k in s.chosen)) this.propose(k, best[k] ? best[k].v : { op: 'noop' });
          for (const cmd of s.queue.splice(0)) this.propose(s.nextSlot++, cmd);
          break;
        }
        case 'accepted': {
          const p = s.props[b.slot];
          if (!s.leader || b.n !== s.n || !p || p.done) break;
          p.acks[m.from] = 1;
          if (Object.keys(p.acks).length >= this.cfg.majority) { p.done = true; this.broadcast(this.cfg.ids, 'chosen', { slot: b.slot, v: p.v }); this.onMessage({ type: 'chosen', from: this.id, body: { slot: b.slot, v: p.v } }); }
          break;
        }
        case 'chosen':
          if (!(b.slot in s.chosen)) { s.chosen[b.slot] = b.v; this.note('chosen', { slot: b.slot, v: b.v }); }
          break;
        case 'nack':
          if (b.n === s.n && b.promised > s.n) { if (s.leader) this.note('deposed', { n: s.n, promised: b.promised }); s.leader = false; s.round = Math.max(s.round, roundOf(b.promised)); }
          break;
      }
    }
    onRestart() { Object.assign(this.state, { leader: false, promises: {}, props: {}, queue: [] }); }
  }

  class MultiPaxos {
    constructor(opts) {
      opts = Object.assign({ n: 3, latency: 10, jitter: 5, seed: 1 }, opts || {});
      this.net = new C.Net({ seed: opts.seed, latency: opts.latency, jitter: opts.jitter, loss: opts.loss || 0 });
      this.ids = K.range(opts.n).map((i) => 'm' + (i + 1));
      const cfg = { ids: this.ids, majority: Math.floor(opts.n / 2) + 1 };
      this.ids.forEach((id, i) => this.net.add(id, new MPNode(id, i + 1, cfg)));
      this.chk = { acc: {}, chosen: {}, violations: [] };
      this.majority = cfg.majority;
      this.net.on((e) => this.watch(e));
    }
    node(id) { return this.net.node(id); }
    lead(id) { this.node(id).lead(); this.net.settle(); return this.leader(); }
    leader() { const l = this.ids.filter((i) => this.net.isUp(i) && this.node(i).state.leader); return l.length ? l[l.length - 1] : null; }
    submit(cmd, at) { const l = at || this.leader(); if (!l) throw new Error('no leader'); const slot = this.node(l).submit(cmd); return slot; }
    run(until) { return this.net.run(until); }
    settle() { return this.net.settle(); }
    watch(e) {
      if (e.kind !== 'note' || e.what !== 'chosen') return;
      const c = this.chk.chosen, k = e.data.slot;
      if (!(k in c)) c[k] = e.data.v;
      else if (!same(c[k], e.data.v)) this.chk.violations.push({ prop: 'one value per slot', slot: k, t: e.t });
    }
    /** the chosen log as each node knows it */
    logs() { const out = {}; for (const id of this.ids) out[id] = clone(this.node(id).state.chosen); return out; }
    messages() { const out = {}; for (const e of this.net.trace) if (e.kind === 'send') out[e.type] = (out[e.type] || 0) + 1; return out; }
    check() {
      const v = clone(this.chk.violations);
      for (const id of this.ids) for (const [k, x] of Object.entries(this.node(id).state.chosen)) if (!same(this.chk.chosen[k], x)) v.push({ prop: 'one value per slot', slot: k, node: id });
      return { ok: !v.length, violations: v, log: clone(this.chk.chosen) };
    }
    view() { return { clock: this.net.clock, nodes: this.ids.map((id) => Object.assign({ id, up: this.net.isUp(id) }, clone(this.node(id).state))), inFlight: this.net.inFlight() }; }
    describe() {
      return {
        name: 'Multi-Paxos',
        text: 'Running single-decree Paxos for every log slot would cost two round trips per command. In multi-Paxos a leader runs phase 1 '
          + 'once, for all slots at once; its promisers report what they accepted in any slot, the leader re-proposes those values and '
          + 'fills gaps with no-ops, and from then on each command needs only accept/accepted (phase 2). A node that starts a higher '
          + 'ballot deposes the leader. Raft is close to this design with the leader election and log repair spelled out.',
        messages: ['prepare', 'promise', 'nack', 'accept', 'accepted', 'chosen'],
      };
    }
  }

  C.Paxos = { single: (opts) => new PaxosSingle(opts), multi: (opts) => new MultiPaxos(opts), Single: PaxosSingle, Multi: MultiPaxos, Acceptor, Proposer, Learner, ballot,
    describe: () => PaxosSingle.prototype.describe.call(null) };
})(typeof window !== 'undefined' ? window : globalThis);
