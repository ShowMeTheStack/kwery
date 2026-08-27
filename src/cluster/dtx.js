// Distributed transactions (chapter 23): two-phase commit over real engines, three-phase commit as a model, and
// distributed deadlock detection with a global wait-for graph built from the engines' own lock tables.
//
// 2PC: the coordinator first ships each participant its part of the transaction; a participant runs it inside an
// open transaction (BEGIN, its statements), so its row locks are real. On PREPARE it forces <ready T> with its
// writes to its log and votes yes, or votes no if a statement failed. On the decision it runs COMMIT or ROLLBACK.
// A participant that crashes after <ready T> loses the open transaction with the engine, so on restart it runs the
// logged writes again and holds them, locks and all, until it learns the outcome: the redo-and-relock a real
// participant does from its log. Logs are durable; everything else on a node is lost in a crash.
(function (root) {
  'use strict';
  const K = root.K;
  const C = K.Cluster = K.Cluster || {};
  const recText = (r) => '<' + r.type + ' ' + r.T + (r.type === 'ready' && r.writes ? ' ' + r.writes.length + ' writes' : '') + '>';

  const FAILURES2 = {
    none: 'no failure',
    'vote-no': 'the target participant\'s statement violates a check constraint, so it votes no',
    'participant-before-vote': 'the target participant crashes on PREPARE, before logging <ready T>',
    'participant-after-vote': 'the target participant crashes right after sending its yes vote',
    'coordinator-before-prepare': 'the coordinator crashes after the work is done, before sending PREPARE',
    'coordinator-before-decision': 'the coordinator crashes with every yes vote in hand, before logging a decision',
    'coordinator-after-decision': 'the coordinator logs <commit T> and crashes before sending it',
    'coordinator-partial-decision': 'the coordinator sends COMMIT to the first participant only, then crashes',
    'lost-prepare': 'the PREPARE to the target participant is lost',
    'lost-vote': 'the target participant\'s vote is lost',
    'lost-decision': 'the decision to the target participant is lost',
    'partition-during-vote': 'the target participant is cut off from everyone while votes are collected',
    random: 'random crashes of any node at random times, with restarts, and 5% message loss',
  };

  // ---- two-phase commit -------------------------------------------------------------------------------------------
  class Coordinator2 extends C.Actor {
    constructor(id, sim) { super(id); this.sim = sim; this.role = 'coordinator'; this.state = { log: [], v: this.fresh() }; }
    fresh() { return { phase: 'idle', done: {}, votes: {}, acks: {}, decision: null }; }
    get v() { return this.state.v; }
    get parts() { return this.sim.parts; }
    logRec(type, extra) { const r = Object.assign({ lsn: this.state.log.length + 1, t: this.now, type, T: this.sim.T }, extra); this.state.log.push(r); this.note('log', recText(r)); return r; }
    begin() {
      this.v.phase = 'work';
      for (const p of this.parts) this.sim.send(this, p, 'work', { T: this.sim.T, sql: this.sim.writes[p] });
      this.setTimer('work-timeout', this.sim.to.work);
    }
    onMessage(m) {
      const v = this.v, f = this.sim.failure;
      switch (m.type) {
        case 'done':
          if (v.phase !== 'work') return;
          v.done[m.from] = m.body.ok;
          if (Object.keys(v.done).length < this.parts.length) return;
          if (f === 'coordinator-before-prepare') return this.sim.crash(this.id);
          this.cancelTimers('work-timeout');
          this.logRec('prepare');
          v.phase = 'voting';
          for (const p of this.parts) this.sim.send(this, p, 'prepare', { T: this.sim.T });
          this.setTimer('vote-timeout', this.sim.to.vote);
          return;
        case 'vote':
          if (v.phase !== 'voting') return;
          v.votes[m.from] = m.body.yes;
          if (!m.body.yes) return this.decide('abort', m.from + ' voted no');
          if (this.parts.every((p) => v.votes[p])) {
            if (f === 'coordinator-before-decision') return this.sim.crash(this.id);
            this.decide('commit', 'all voted yes');
          }
          return;
        case 'ack':
          if (v.phase !== 'decided') return;
          v.acks[m.from] = true;
          if (this.parts.every((p) => v.acks[p])) { this.cancelTimers('ack-timeout'); this.logRec('end'); v.phase = 'done'; }
          return;
        case 'status': {
          const d = this.decisionInLog();
          this.sim.send(this, m.from, 'status-reply', { T: this.sim.T, state: d === 'commit' ? 'committed' : d === 'abort' ? 'aborted' : 'unknown', by: 'coordinator' });
          return;
        }
      }
    }
    decisionInLog() { const r = this.state.log.find((x) => x.type === 'commit' || x.type === 'abort'); return r ? r.type : null; }
    decide(d, why) {
      const v = this.v;
      this.cancelTimers('vote-timeout'); this.cancelTimers('work-timeout');
      this.logRec(d, { why });
      v.phase = 'decided'; v.decision = d;
      const f = this.sim.failure;
      if (d === 'commit' && f === 'coordinator-after-decision') return this.sim.crash(this.id);
      if (d === 'commit' && f === 'coordinator-partial-decision') { this.sim.send(this, this.parts[0], d, { T: this.sim.T }); return this.sim.crash(this.id); }
      this.sendDecision();
    }
    sendDecision() {
      for (const p of this.parts) if (!this.v.acks[p]) this.sim.send(this, p, this.v.decision, { T: this.sim.T });
      this.setTimer('ack-timeout', this.sim.to.ack);
    }
    onTimer(name) {
      const v = this.v;
      if (name === 'work-timeout' && v.phase === 'work') this.decide('abort', 'participants did not finish their work in time');
      else if (name === 'vote-timeout' && v.phase === 'voting') this.decide('abort', 'votes missing: ' + this.parts.filter((p) => !(p in v.votes)).join(', '));
      else if (name === 'ack-timeout' && v.phase === 'decided') { this.note('resend', v.decision); this.sendDecision(); }
    }
    onCrash() { this.state.v = this.fresh(); }
    onRestart() {
      // recovery from the log: a decision is sent again; <prepare T> without one, or nothing at all, means abort
      const log = this.state.log, has = (t) => log.some((r) => r.type === t);
      const d = this.decisionInLog();
      if (has('end')) { this.v.phase = 'done'; this.note('recover', 'transaction already ended'); return; }
      if (d) { this.v.phase = 'decided'; this.v.decision = d; this.note('recover', 'decision ' + d + ' in the log: send it again'); this.sendDecision(); return; }
      this.note('recover', has('prepare') ? '<prepare T> but no decision: abort' : 'no log record: abort');
      this.decide('abort', 'coordinator recovery');
    }
  }

  class Participant2 extends C.Node {
    constructor(id, sim) { super(id); this.sim = sim; this.role = 'participant'; this.tx = null; this.state = { log: [], v: this.fresh(), blocked: [] }; }
    fresh() { return { phase: 'idle', failed: null, writes: null }; }
    get v() { return this.state.v; }
    logRec(type, extra) { const r = Object.assign({ lsn: this.state.log.length + 1, t: this.now, type, T: this.sim.T }, extra); this.state.log.push(r); this.note('log', recText(r)); return r; }
    lastRec() { for (let i = this.state.log.length - 1; i >= 0; i--) if (this.state.log[i].type !== 'no') return this.state.log[i]; return null; }
    others() { return this.sim.parts.filter((p) => p !== this.id); }
    runWrites(sqls) {
      this.tx = this.tx || this.session(this.sim.T);
      this.tx.exec('begin');
      for (const q of sqls) { if (this.logSql) this.sqlLog.push({ t: this.now, sql: q }); this.tx.exec(q); }
    }
    abortLocal(why) {
      if (this.tx && this.tx.tx) this.tx.exec('rollback');
      if (!this.lastRec() || this.lastRec().type === 'ready') this.logRec('abort', { why });
      this.v.phase = 'aborted';
      this.cancelTimers('prepare-timeout'); this.cancelTimers('decision-timeout');
      this.unblock();
    }
    commitLocal() {
      if (this.v.phase === 'aborted') { this.note('violation', 'commit after abort'); this.sim.violations.push(this.id + ': commit after abort'); return; }
      if (this.tx && this.tx.tx) this.tx.exec('commit');
      this.logRec('commit');
      this.v.phase = 'committed';
      this.cancelTimers('decision-timeout');
      this.unblock();
    }
    unblock() { const b = this.state.blocked[this.state.blocked.length - 1]; if (b && b.to === null) { b.to = this.now; this.note('unblocked', { after: +(this.now - b.from).toFixed(3) }); } }
    onMessage(m) {
      const v = this.v, f = this.sim.failure, target = this.id === this.sim.target;
      switch (m.type) {
        case 'work':
          if (v.phase !== 'idle') return this.sim.send(this, m.from, 'done', { T: m.body.T, ok: v.phase === 'working' && !v.failed });
          if (this.lastRec()) return this.sim.send(this, m.from, 'done', { T: m.body.T, ok: false });
          v.phase = 'working'; v.writes = m.body.sql;
          try { this.runWrites(m.body.sql); } catch (e) { v.failed = e.code + ' ' + e.message; this.note('statement failed', v.failed); if (this.tx.tx) this.tx.exec('rollback'); }
          this.sim.send(this, m.from, 'done', { T: m.body.T, ok: !v.failed });
          this.setTimer('prepare-timeout', this.sim.to.prepare);
          return;
        case 'prepare':
          if (v.phase === 'ready') return this.sim.send(this, m.from, 'vote', { T: m.body.T, yes: true });
          if (v.phase === 'working' && !v.failed) {
            if (target && f === 'participant-before-vote') return this.sim.crash(this.id);
            this.cancelTimers('prepare-timeout');
            this.logRec('ready', { writes: v.writes });
            v.phase = 'ready';
            this.sim.send(this, m.from, 'vote', { T: m.body.T, yes: true });
            this.setTimer('decision-timeout', this.sim.to.decision);
            if (target && f === 'participant-after-vote') this.sim.crash(this.id);
            return;
          }
          if (v.phase !== 'committed') this.abortLocal(v.failed ? 'statement failed' : 'not prepared');
          this.logRec('no');
          this.sim.send(this, m.from, 'vote', { T: m.body.T, yes: false });
          return;
        case 'commit': if (v.phase !== 'committed') this.commitLocal(); return this.sim.send(this, m.from, 'ack', { T: m.body.T });
        case 'abort': if (v.phase !== 'aborted') this.abortLocal('coordinator decided abort'); return this.sim.send(this, m.from, 'ack', { T: m.body.T });
        case 'status': {
          // asked by a peer: a participant that has not voted can still abort on its own, and must, to answer
          if (v.phase === 'idle' || v.phase === 'working') this.abortLocal('a peer asked and this site had not voted');
          const st = v.phase === 'committed' ? 'committed' : v.phase === 'aborted' ? 'aborted' : 'ready';
          return this.sim.send(this, m.from, 'status-reply', { T: m.body.T, state: st, by: this.id });
        }
        case 'status-reply':
          if (v.phase !== 'ready') return;
          if (m.body.state === 'committed') { this.note('learned', 'commit from ' + m.body.by); this.commitLocal(); }
          else if (m.body.state === 'aborted') { this.note('learned', 'abort from ' + m.body.by); this.abortLocal('learned abort from ' + m.body.by); }
          return;
      }
    }
    onTimer(name) {
      const v = this.v;
      if (name === 'prepare-timeout' && v.phase === 'working') { this.note('timeout', 'no PREPARE: abort on its own'); this.abortLocal('no PREPARE in time'); }
      if (name === 'decision-timeout' && v.phase === 'ready') {
        const b = this.state.blocked[this.state.blocked.length - 1];
        if (!b || b.to !== null) { this.state.blocked.push({ from: this.now, to: null }); this.note('blocked', 'ready, no decision: ask the coordinator and the other participants'); }
        this.sim.send(this, this.sim.coord, 'status', { T: this.sim.T });
        for (const p of this.others()) this.sim.send(this, p, 'status', { T: this.sim.T });
        this.setTimer('decision-timeout', this.sim.to.decision);
      }
    }
    onCrash() { super.onCrash(); this.tx = null; this.state.v = this.fresh(); const b = this.state.blocked[this.state.blocked.length - 1]; if (b && b.to === null) b.to = this.now; }
    onRestart() {
      const r = this.lastRec();
      if (!r) { this.note('recover', 'no log record: abort'); this.logRec('abort', { why: 'recovery' }); this.v.phase = 'aborted'; return; }
      if (r.type === 'commit' || r.type === 'abort') { this.v.phase = r.type === 'commit' ? 'committed' : 'aborted'; this.note('recover', r.type + ' in the log'); return; }
      // in doubt: redo the writes, keep the transaction open, and find out what was decided
      this.note('recover', '<ready T> in the log: redo the writes and wait for the decision');
      this.v.phase = 'ready'; this.v.writes = r.writes;
      this.runWrites(r.writes);
      this.sim.send(this, this.sim.coord, 'status', { T: this.sim.T });
      for (const p of this.others()) this.sim.send(this, p, 'status', { T: this.sim.T });
      this.setTimer('decision-timeout', this.sim.to.decision);
    }
  }

  class TwoPC {
    /**
     * opts: seed, n (participants, 3), latency, jitter, loss, failure (a key of TwoPC.failures), target ('P2'),
     * restart (true: crashed nodes come back), restartAfter (150), timeouts { work, vote, prepare, decision, ack },
     * writes { P1: [sql], ... } to replace the default transfer
     */
    constructor(opts) {
      opts = Object.assign({ seed: 1, n: 3, latency: 10, jitter: 4, loss: 0, failure: 'none', target: 'P2', restart: true, restartAfter: 150 }, opts || {});
      if (!(opts.failure in FAILURES2)) throw new Error('unknown failure ' + opts.failure);
      this.opts = opts;
      this.failure = opts.failure;
      this.T = 'T1';
      this.to = Object.assign({ work: 60, vote: 60, prepare: 90, decision: 50, ack: 50 }, opts.timeouts || {});
      this.net = new C.Net({ seed: opts.seed, latency: opts.latency, jitter: opts.jitter, loss: opts.failure === 'random' ? Math.max(opts.loss, 0.05) : opts.loss });
      this.coord = 'C';
      this.parts = K.range(opts.n).map((i) => 'P' + (i + 1));
      this.target = opts.target;
      this.violations = [];
      this.lossUsed = false;
      this.net.add(this.coord, new Coordinator2(this.coord, this));
      this.init = {};
      this.after = {};
      this.writes = {};
      this.parts.forEach((p, i) => {
        const node = this.net.add(p, new Participant2(p, this));
        node.logSql = false;
        node.exec('create table account (id int primary key, balance int check (balance >= 0)); insert into account values (' + (i + 1) + ', 100)');
        node.logSql = true;
        this.init[p] = 100;
        const delta = i === 0 ? -10 * (opts.n - 1) : 10;
        const bad = opts.failure === 'vote-no' && p === this.target;
        this.writes[p] = opts.writes ? opts.writes[p] || [] : ['update account set balance = balance ' + (bad ? '- 1000' : (delta < 0 ? '- ' + -delta : '+ ' + delta)) + ' where id = ' + (i + 1)];
        this.after[p] = 100 + delta;
      });
      if (opts.failure === 'partition-during-vote') this.net.at(opts.latency * 1.5, 'partition', [[this.target]]).at(opts.latency * 1.5 + 200, 'heal');
      if (opts.failure === 'random') {
        const rng = this.net.rng.fork(), all = [this.coord].concat(this.parts);
        for (let k = rng.int(1, 2); k > 0; k--) { const who = rng.pick(all), at = rng.int(1, 120); this.net.at(at, 'crash', who).at(at + rng.int(20, 200), 'restart', who); }
      }
      this.net.at(0, 'call', () => this.net.node(this.coord).begin());
    }
    /** a message, with the scripted message loss applied */
    send(from, to, type, body) {
      const f = this.failure, tg = this.target;
      const lose = !this.lossUsed && ((f === 'lost-prepare' && type === 'prepare' && to === tg) || (f === 'lost-vote' && type === 'vote' && from.id === tg) || (f === 'lost-decision' && (type === 'commit' || type === 'abort') && to === tg));
      if (!lose) return from.send(to, type, body);
      this.lossUsed = true;
      this.net.link(from.id, to, { loss: 1 }, true);
      const id = from.send(to, type, body);
      this.net.link(from.id, to, { loss: this.net.cfg.loss }, true);
      return id;
    }
    crash(id) { this.net.crash(id); if (this.opts.restart) this.net.after(this.opts.restartAfter, 'restart', id); }
    run(until) { this.net.run(until === undefined ? 5000 : until, { maxSteps: 20000 }); return this.result(); }
    step() { return this.net.step(); }
    /** try to lock a participant's rows from another session: a blocked participant still holds them */
    probe(p) {
      const s = this.net.node(p).session('probe');
      try { const r = s.query('select id, balance from account for update nowait'); return { blocked: false, rows: C.textResult(r).rows }; } catch (e) { return { blocked: e.code === '55P03', code: e.code, message: e.message }; }
    }
    outcomeOf(p) {
      const n = this.net.node(p), r = n.lastRec();
      if (!this.net.isUp(p)) return r && (r.type === 'commit' || r.type === 'abort') ? (r.type === 'commit' ? 'committed' : 'aborted') : 'down';
      return n.v.phase === 'committed' ? 'committed' : n.v.phase === 'aborted' ? 'aborted' : n.v.phase === 'ready' ? 'blocked' : n.v.phase === 'idle' ? (r && r.type === 'abort' ? 'aborted' : 'idle') : n.v.phase;
    }
    result() {
      const parts = {}, balances = {}, logs = { [this.coord]: this.net.node(this.coord).state.log.map(recText) };
      for (const p of this.parts) {
        parts[p] = this.outcomeOf(p);
        const n = this.net.node(p);
        logs[p] = n.state.log.map(recText);
        n.logSql = false;
        balances[p] = Number(n.query('select balance from account').rows[0][0]);
        n.logSql = true;
      }
      const vals = Object.values(parts);
      const committed = vals.filter((x) => x === 'committed').length, aborted = vals.filter((x) => x === 'aborted').length;
      const coordDecision = this.net.node(this.coord).decisionInLog();
      const dataOk = this.parts.every((p) => balances[p] === (parts[p] === 'committed' ? this.after[p] : this.init[p]));
      const blocked = this.parts.flatMap((p) => this.net.node(p).state.blocked.map((b) => ({ node: p, from: b.from, to: b.to })));
      return {
        failure: this.failure, describe: FAILURES2[this.failure], decision: coordDecision, participants: parts, balances,
        total: Object.values(balances).reduce((a, b) => a + b, 0),
        atomic: !(committed && aborted) && !this.violations.length && (!coordDecision || vals.every((x) => x !== (coordDecision === 'commit' ? 'aborted' : 'committed'))),
        complete: committed === this.parts.length || aborted === this.parts.length,
        outcome: committed === this.parts.length ? 'committed' : aborted === this.parts.length ? 'aborted' : 'incomplete',
        dataOk, blocked, violations: this.violations.slice(), logs, clock: this.net.clock, stats: C.clone(this.net.stats), trace: this.net.trace,
      };
    }
    static run(opts, until) { return new TwoPC(opts).run(until); }
    describe() { return TwoPC.describe(); }
    static describe() {
      return {
        name: 'Two-phase commit',
        text: 'Phase 1: the coordinator logs <prepare T> and sends PREPARE; each participant forces <ready T> and votes yes, or '
          + '<no T> and votes no. Phase 2: with every vote yes the coordinator logs <commit T>, otherwise <abort T>, and sends the decision; '
          + 'participants log it, commit or roll back, and acknowledge; the coordinator then logs <end T>. A participant that has '
          + 'voted yes may not decide alone: if the coordinator fails it is blocked, holding its locks, until the coordinator '
          + 'recovers or another participant knows the outcome (or had not voted, and so aborts).',
        failures: Object.assign({}, FAILURES2),
        messages: ['work', 'done', 'prepare', 'vote', 'commit', 'abort', 'ack', 'status', 'status-reply'],
        logRecords: ['<prepare T>', '<ready T>', '<no T>', '<commit T>', '<abort T>', '<end T>'],
      };
    }
  }
  TwoPC.failures = FAILURES2;
  C.TwoPC = TwoPC;

  // ---- three-phase commit (a model: participants hold no data) ---------------------------------------------------
  const FAILURES3 = {
    none: 'no failure',
    'vote-no': 'the target participant votes no',
    'coordinator-before-precommit': 'the coordinator crashes with every yes vote, before any PRECOMMIT: the participants abort',
    'coordinator-partial-precommit': 'the coordinator sends PRECOMMIT to the first participant only and crashes: the participants commit',
    'coordinator-after-precommit': 'the coordinator crashes after PRECOMMIT reached everyone: the participants commit',
    partition: 'PRECOMMIT reaches the first participant only, the coordinator crashes and a partition splits that participant off: '
      + 'each side terminates on its own and they disagree. 3PC is safe under crashes, not under partitions',
  };
  class Coordinator3 extends C.Actor {
    constructor(id, sim) { super(id); this.sim = sim; this.role = 'coordinator'; this.state = { phase: 'idle', votes: {}, acks: {}, log: [] }; }
    begin() { this.state.phase = 'voting'; for (const p of this.sim.parts) this.send(p, 'canCommit', {}); this.setTimer('timeout', this.sim.to.vote); }
    onMessage(m) {
      const s = this.state, f = this.sim.failure, parts = this.sim.parts;
      if (m.type === 'vote' && s.phase === 'voting') {
        s.votes[m.from] = m.body.yes;
        if (!m.body.yes) { s.phase = 'aborted'; s.log.push('abort'); this.cancelTimers('timeout'); this.broadcast(parts, 'abort', {}); return; }
        if (!parts.every((p) => s.votes[p])) return;
        this.cancelTimers('timeout');
        if (f === 'coordinator-before-precommit') return this.net.crash(this.id);
        s.phase = 'precommit'; s.log.push('precommit');
        if (f === 'coordinator-partial-precommit' || f === 'partition') {
          this.send(parts[0], 'preCommit', {});
          if (f === 'partition') this.net.after(this.sim.opts.latency + this.sim.opts.jitter + 1, 'partition', [[parts[0]], parts.slice(1).concat([this.id])]);
          return this.net.crash(this.id);
        }
        this.broadcast(parts, 'preCommit', {});
        if (f === 'coordinator-after-precommit') return this.net.crash(this.id);
        this.setTimer('timeout', this.sim.to.vote);
      } else if (m.type === 'ack' && s.phase === 'precommit') {
        s.acks[m.from] = true;
        if (parts.every((p) => s.acks[p])) { s.phase = 'committed'; s.log.push('commit'); this.cancelTimers('timeout'); this.broadcast(parts, 'doCommit', {}); }
      }
    }
    onTimer() {
      const s = this.state;
      if (s.phase === 'voting') { s.phase = 'aborted'; s.log.push('abort'); this.broadcast(this.sim.parts, 'abort', {}); }
      // a missing PRECOMMIT ack: the participants that did ack will terminate to commit anyway
      else if (s.phase === 'precommit') { s.phase = 'committed'; s.log.push('commit'); this.broadcast(this.sim.parts, 'doCommit', {}); }
    }
  }
  class Participant3 extends C.Actor {
    constructor(id, sim) { super(id); this.sim = sim; this.role = 'participant'; this.state = { phase: 'init', round: 0, replies: {}, decidedBy: null }; }
    finish(phase, by) { if (this.state.phase === 'committed' || this.state.phase === 'aborted') return; this.state.phase = phase; this.state.decidedBy = by; this.cancelTimers(); this.note(phase, { by }); }
    onMessage(m) {
      const s = this.state;
      switch (m.type) {
        case 'canCommit': {
          if (s.phase !== 'init') return;
          const yes = !(this.sim.failure === 'vote-no' && this.id === this.sim.target);
          if (!yes) { this.send(m.from, 'vote', { yes }); return this.finish('aborted', 'own no vote'); }
          s.phase = 'waiting'; this.send(m.from, 'vote', { yes }); this.setTimer('timeout', this.sim.to.wait);
          return;
        }
        case 'preCommit': if (s.phase === 'waiting') { s.phase = 'precommitted'; this.send(m.from, 'ack', {}); this.cancelTimers(); this.setTimer('timeout', this.sim.to.wait); } return;
        case 'doCommit': return this.finish('committed', m.from);
        case 'abort': return this.finish('aborted', m.from);
        case 'state?':
          if (s.phase === 'init') this.finish('aborted', 'had not voted');
          return this.send(m.from, 'state', { round: m.body.round, phase: s.phase });
        case 'state':
          if (m.body.round === s.round) s.replies[m.from] = m.body.phase;
          return;
        case 'decision':
          if (m.body.d === 'precommit') { if (s.phase === 'waiting') s.phase = 'precommitted'; return; }
          return this.finish(m.body.d === 'commit' ? 'committed' : 'aborted', m.from + ' (termination)');
      }
    }
    onTimer(name) {
      const s = this.state;
      if (s.phase === 'committed' || s.phase === 'aborted') return;
      if (name === 'timeout') {
        if (s.phase === 'init') return this.finish('aborted', 'no canCommit');
        // termination protocol: ask everyone's state; the lowest-numbered site that answers takes over
        s.round++; s.replies = { [this.id]: s.phase };
        this.broadcast(this.sim.parts, 'state?', { round: s.round });
        this.note('termination', { round: s.round });
        this.setTimer('collect', this.sim.to.collect);
      } else if (name === 'collect') {
        const ids = Object.keys(s.replies).sort();
        if (ids[0] === this.id) {
          const ph = Object.values(s.replies);
          const d = ph.includes('aborted') ? 'abort' : ph.includes('committed') || ph.includes('precommitted') ? 'commit' : 'abort';
          this.note('new coordinator', { states: C.clone(s.replies), decision: d });
          if (d === 'commit') this.broadcast(ids, 'decision', { d: 'precommit' });
          this.broadcast(ids, 'decision', { d });
          this.finish(d === 'commit' ? 'committed' : 'aborted', 'self (termination)');
        } else this.setTimer('timeout', this.sim.to.wait);
      }
    }
  }
  class ThreePC {
    constructor(opts) {
      opts = Object.assign({ seed: 1, n: 3, latency: 10, jitter: 4, failure: 'none', target: 'P2' }, opts || {});
      if (!(opts.failure in FAILURES3)) throw new Error('unknown failure ' + opts.failure);
      this.opts = opts; this.failure = opts.failure; this.target = opts.target;
      this.to = { vote: 60, wait: 60, collect: opts.latency * 2 + opts.jitter * 2 + 5 };
      this.net = new C.Net({ seed: opts.seed, latency: opts.latency, jitter: opts.jitter });
      this.parts = K.range(opts.n).map((i) => 'P' + (i + 1));
      this.net.add('C', new Coordinator3('C', this));
      for (const p of this.parts) this.net.add(p, new Participant3(p, this));
      this.net.at(0, 'call', () => this.net.node('C').begin());
    }
    run(until) {
      this.net.run(until === undefined ? 3000 : until, { maxSteps: 20000 });
      const participants = {};
      for (const p of this.parts) participants[p] = this.net.node(p).state.phase;
      const v = Object.values(participants);
      return {
        failure: this.failure, describe: FAILURES3[this.failure], participants,
        atomic: !(v.includes('committed') && v.includes('aborted')),
        blocked: v.some((x) => x === 'waiting' || x === 'precommitted'),
        outcome: v.every((x) => x === 'committed') ? 'committed' : v.every((x) => x === 'aborted') ? 'aborted' : 'mixed',
        coordinator: C.clone(this.net.node('C').state.log), trace: this.net.trace, clock: this.net.clock,
      };
    }
    static run(opts, until) { return new ThreePC(opts).run(until); }
    describe() { return ThreePC.describe(); }
    static describe() {
      return {
        name: 'Three-phase commit',
        text: 'Between voting and committing, 3PC adds a PRECOMMIT phase: no site commits until every site knows that all voted yes. '
          + 'If the coordinator fails, the remaining sites elect a new one (here the lowest-numbered site that answers), which '
          + 'commits if any site is precommitted or committed and aborts otherwise; no site is left waiting. That holds only if '
          + 'failures are crashes and the network does not partition: two sides of a partition can each terminate, differently.',
        failures: Object.assign({}, FAILURES3), messages: ['canCommit', 'vote', 'preCommit', 'ack', 'doCommit', 'abort', 'state?', 'state', 'decision'],
      };
    }
  }
  ThreePC.failures = FAILURES3;
  C.ThreePC = ThreePC;

  // ---- distributed deadlock detection -------------------------------------------------------------------------------
  /** the cycle through the graph's edges [{ from, to }], or null */
  function findCycle(edges) {
    const adj = {};
    for (const e of edges) (adj[e.from] = adj[e.from] || []).push(e.to);
    const color = {}, stack = [];
    let found = null;
    const dfs = (u) => {
      color[u] = 1; stack.push(u);
      for (const w of adj[u] || []) {
        if (found) return;
        if (color[w] === 1) { found = stack.slice(stack.indexOf(w)); return; }
        if (!color[w]) dfs(w);
      }
      stack.pop(); color[u] = 2;
    };
    for (const u of Object.keys(adj).sort()) { if (!color[u]) dfs(u); if (found) break; }
    return found;
  }
  C.findCycle = findCycle;

  class Site extends C.Node {
    constructor(id, sim) { super(id); this.sim = sim; this.role = 'site'; this.sess = {}; this.runners = {}; this.state = { done: {} }; }
    sessionOf(T) { return this.sess[T] || (this.sess[T] = this.session(T)); }
    /** run a statement of global transaction T here; it may wait for a lock */
    submit(T, sql) {
      if (this.logSql) this.sqlLog.push({ t: this.now, sql: T + ': ' + sql });
      // every statement of a global transaction at this site runs inside one local transaction
      const sess = this.sessionOf(T);
      const r = sess.start(sess.tx ? sql : 'begin; ' + sql);
      this.runners[T] = r;
      this.db.step();
      this.note('statement', { T, sql, state: r.done ? (r.error ? 'error ' + r.error.code : 'done') : 'waiting' });
      this.sim.after(this.id);
      return r;
    }
    /** the local wait-for graph, in global transaction names */
    localEdges() {
      const out = [];
      for (const [tx, w] of this.db.locks.waiting) for (const h of w.holders) if (tx.session && h.session) out.push({ from: tx.session.name.split(':')[1], to: h.session.name.split(':')[1], site: this.id });
      return out;
    }
    abortTx(T, why) {
      const r = this.runners[T];
      if (r && !r.done) {
        r.waitingOn = null; r.session.waiting = null;
        try { r.gen.throw(K.err(K.STATE.deadlock, why)); } catch (e) { r.finish(null, e); }
      }
      const s = this.sessionOf(T);
      if (s.tx) s.exec('rollback');
      this.state.done[T] = 'aborted';
      this.db.step();
      this.note('aborted', { T, why });
      this.sim.after(this.id);
    }
    onMessage(m) {
      if (m.type === 'wfg?') this.send(m.from, 'wfg', { round: m.body.round, edges: this.localEdges() });
      else if (m.type === 'abort-tx') { this.abortTx(m.body.T, 'chosen as deadlock victim by the global detector'); this.send(m.from, 'aborted', { T: m.body.T }); }
    }
  }
  class Detector extends C.Actor {
    constructor(id, sim) { super(id); this.sim = sim; this.role = 'detector'; this.state = { round: 0, got: {}, rounds: [] }; }
    onTimer(name) {
      if (name !== 'collect') return;
      const s = this.state;
      s.round++; s.got = {};
      this.broadcast(this.sim.sites, 'wfg?', { round: s.round });
      if (!this.sim.finished()) this.setTimer('collect', this.sim.period);
    }
    onMessage(m) {
      const s = this.state;
      if (m.type !== 'wfg' || m.body.round !== s.round) return;
      s.got[m.from] = m.body.edges;
      if (Object.keys(s.got).length < this.sim.sites.length) return;
      const edges = Object.values(s.got).flat();
      const local = this.sim.sites.map((x) => ({ site: x, edges: s.got[x], cycle: findCycle(s.got[x]) }));
      const cycle = findCycle(edges);
      const round = { round: s.round, t: this.now, local, edges, cycle };
      s.rounds.push(round);
      this.note('global wait-for graph', { edges: edges.map((e) => e.from + '->' + e.to + '@' + e.site), cycle });
      if (cycle) {
        // victim: the youngest transaction in the cycle (the highest number)
        const victim = cycle.slice().sort((a, b) => Number(b.replace(/\D/g, '')) - Number(a.replace(/\D/g, '')))[0];
        round.victim = victim;
        this.note('victim', victim);
        this.broadcast(this.sim.sites, 'abort-tx', { T: victim });
      }
    }
  }
  class DistDeadlock {
    /**
     * the classic two-site deadlock: T1 and T2 each lock an item at one site and then want the other's item at the
     * other site. Each engine sees one waiting edge and no cycle; the detector, collecting the local graphs every
     * period, sees T1 -> T2 -> T1 and aborts the youngest. opts: seed, latency, period, script ([at, site, T, sql])
     */
    constructor(opts) {
      opts = Object.assign({ seed: 1, latency: 5, jitter: 2, period: 40 }, opts || {});
      this.opts = opts; this.period = opts.period;
      this.net = new C.Net({ seed: opts.seed, latency: opts.latency, jitter: opts.jitter });
      this.sites = ['S1', 'S2'];
      this.net.add('D', new Detector('D', this));
      this.sites.forEach((s, i) => { const n = this.net.add(s, new Site(s, this)); n.logSql = false; n.exec('create table item (id int primary key, v int); insert into item values (' + (i + 1) + ', 0)'); n.logSql = true; });
      this.script = opts.script || [
        [1, 'S1', 'T1', 'update item set v = v + 1 where id = 1'],
        [2, 'S2', 'T2', 'update item set v = v + 10 where id = 2'],
        [3, 'S2', 'T1', 'update item set v = v + 1 where id = 2'],
        [4, 'S1', 'T2', 'update item set v = v + 10 where id = 1'],
      ];
      this.txs = [...new Set(this.script.map((x) => x[2]))];
      for (const [at, site, T, sql] of this.script) this.net.at(at, 'call', () => this.net.node(site).submit(T, sql));
      this.net.setTimer('D', 'collect', opts.period);
    }
    /** when every statement of a surviving transaction has run, it commits at every site (one-phase, for brevity) */
    after() {
      for (const T of this.txs) {
        if (this.sites.some((x) => this.net.node(x).state.done[T])) continue;
        const last = this.script.filter((x) => x[2] === T);
        const allRan = last.every(([at]) => at <= this.net.clock);
        const ready = this.sites.every((x) => { const r = this.net.node(x).runners[T]; return !r || (r.done && !r.error); });
        if (allRan && ready && this.sites.some((x) => this.net.node(x).runners[T])) {
          for (const x of this.sites) { const n = this.net.node(x); const s = n.sessionOf(T); if (s.tx) s.exec('commit'); n.state.done[T] = 'committed'; n.db.step(); }
          this.net.note('D', 'committed', T);
          this.after();
          return;
        }
      }
    }
    finished() { return this.txs.every((T) => this.sites.every((x) => this.net.node(x).state.done[T])); }
    run(until) {
      this.net.run(until === undefined ? 1000 : until, { maxSteps: 20000 });
      const det = this.net.node('D').state;
      const found = det.rounds.find((r) => r.cycle);
      const outcome = {};
      for (const T of this.txs) outcome[T] = this.net.node('S1').state.done[T] || this.net.node('S2').state.done[T] || 'running';
      const items = {};
      for (const x of this.sites) { const n = this.net.node(x); n.logSql = false; for (const r of n.query('select id, v from item').rows) items[x + ':' + r[0]] = Number(r[1]); n.logSql = true; }
      return { rounds: C.clone(det.rounds), cycle: found ? found.cycle : null, victim: found ? found.victim : null, localCycles: found ? found.local.map((l) => l.cycle) : [], outcome, items, trace: this.net.trace, clock: this.net.clock };
    }
    static run(opts, until) { return new DistDeadlock(opts).run(until); }
    /**
     * a false cycle: S1 reports edges to the detector over a slow link. T1 waits for T2 at S1;
     * T2 then releases its item at S1 and asks for an item T1 holds at S2. The removal of T1 -> T2 is still in flight
     * when the insertion of T2 -> T1 arrives, so the detector's graph has a cycle that never existed.
     */
    static falseCycle(opts) {
      opts = Object.assign({ seed: 1, slow: 60, fast: 5 }, opts || {});
      const net = new C.Net({ seed: opts.seed, latency: opts.fast });
      net.link('S1', 'D', { latency: opts.slow }, true);
      const truth = new Map(), view = new Map();
      const out = { reports: [], detections: [] };
      const det = net.add('D', new C.Actor('D'));
      det.onMessage = (m) => {
        const k = m.body.from + '->' + m.body.to;
        if (m.body.op === 'insert') view.set(k, m.body); else view.delete(k);
        const cycle = findCycle([...view.values()]);
        if (cycle) {
          const real = findCycle([...truth.values()]);
          out.detections.push({ t: net.clock, cycle, edges: [...view.keys()], trueEdges: [...truth.keys()], real: !!real });
          det.note(real ? 'deadlock' : 'false cycle', { cycle, trueEdges: [...truth.keys()] });
        }
      };
      for (const s of ['S1', 'S2']) net.add(s, new C.Actor(s));
      const change = (site, op, from, to) => {
        const k = from + '->' + to;
        if (op === 'insert') truth.set(k, { from, to }); else truth.delete(k);
        out.reports.push({ t: net.clock, site, op, edge: k });
        net.node(site).note(op, k);
        net.send(site, 'D', 'wfg-' + op, { op, from, to });
      };
      net.at(1, 'call', () => change('S1', 'insert', 'T1', 'T2'));
      net.at(20, 'call', () => change('S1', 'remove', 'T1', 'T2'));
      net.at(25, 'call', () => change('S2', 'insert', 'T2', 'T1'));
      net.run();
      return Object.assign(out, { falseCycle: out.detections.some((d) => !d.real), trace: net.trace, log: net.log() });
    }
    describe() { return DistDeadlock.describe(); }
    static describe() {
      return {
        name: 'Distributed deadlock detection',
        text: 'Each site\'s lock manager knows only its local wait-for graph, and each local graph can be acyclic while their union has a cycle. '
          + 'A central detector collects the local graphs, builds the global wait-for graph, and on a cycle aborts a victim at every site. '
          + 'Reports travel with delay, so the detector\'s graph can contain a cycle that never existed at any instant (a false cycle); '
          + 'the cost is an unnecessary abort, never a missed deadlock.',
      };
    }
  }
  C.DistDeadlock = DistDeadlock;
  C.Dtx = { TwoPC, ThreePC, DistDeadlock, findCycle };
})(typeof window !== 'undefined' ? window : globalThis);
