// The workbench: the database and its sessions, editor tabs (each tab is its own session, so two tabs can run
// conflicting transactions), the results, the schema browser, the dock of views, settings and the status bar.
(function (root) {
  'use strict';
  const K = root.K;
  const UI = K.UI;
  const { h } = UI;

  const SETTINGS = [
    { key: 'pageSize', label: 'Page size', group: 'Storage (applies to a new database)', options: [512, 1024, 2048, 4096, 8192], fmt: (v) => v + ' bytes', db: true },
    { key: 'frames', label: 'Buffer pool frames', group: 'Storage (applies to a new database)', options: [4, 8, 16, 32, 64, 128, 256], db: true },
    { key: 'disk', label: 'Disk model', group: 'Storage (applies to a new database)', options: ['hdd', 'ssd'], fmt: (v) => (v === 'hdd' ? 'Magnetic disk' : 'SSD'), db: true },
    { key: 'policy', label: 'Replacement policy', group: 'Buffer manager', options: ['lru', 'mru', 'clock', 'fifo', 'lru2'], fmt: (v) => v.toUpperCase().replace('LRU2', 'LRU-2'), live: (app, v) => app.db.buffers.setPolicy(v) },
    { key: 'sample', label: 'Sample database', group: 'Data', options: () => Object.keys(K.SAMPLES || {}).concat(['empty']), fmt: (v) => (K.SAMPLES && K.SAMPLES[v] ? K.SAMPLES[v].title : 'Empty database'), db: true },
    { key: 'theme', label: 'Theme', group: 'Look', options: ['auto', 'light', 'dark'], fmt: (v) => v[0].toUpperCase() + v.slice(1), live: (app) => app.applyTheme() },
    { key: 'font', label: 'Editor font size', group: 'Look', options: [12, 13, 14, 15, 16, 18, 20], fmt: (v) => v + ' px', live: (app) => app.applyTheme() },
  ];
  const DEFAULTS = { pageSize: 4096, frames: 64, disk: 'hdd', policy: 'lru', sample: 'theatre', theme: 'auto', font: 14 };

  class App {
    constructor(el) {
      this.el = el;
      this.settings = Object.assign({}, DEFAULTS, UI.store.get('settings', {}));
      // a stored sample that no longer exists (an older version's) falls back to the default
      if (this.settings.sample !== 'empty' && K.SAMPLES && !K.SAMPLES[this.settings.sample]) this.settings.sample = DEFAULTS.sample;
      this.timeline = new UI.Timeline();
      this.handlers = {};
      this.tabs = [];
      this.tabSeq = 1;
      this.selection = null;
      this.build();
      this.applyTheme();
      this.newDatabase(true);
      this.restoreTabs();
      this.showPanel(UI.store.get('panel', 'schema'));
      this.dock.restore();
      // on a phone or a narrow tablet, panels and views are sheets over the editor: none is open when the page starts
      if (innerWidth < 900) { this.showPanel(null); this.dock.el.classList.add('closed'); }
      this.layout();
      addEventListener('resize', UI.debounce(() => this.layout(), 100));
    }
    on(ev, f) { (this.handlers[ev] = this.handlers[ev] || []).push(f); return () => { this.handlers[ev] = this.handlers[ev].filter((g) => g !== f); }; }
    emit(ev, d) { for (const f of this.handlers[ev] || []) { try { f(d); } catch (e) { console.error(e); } } }
    get bus() { return this.db.bus; }
    get tab() { return this.tabs.find((t) => t.id === this.activeTab) || this.tabs[0]; }
    get session() { return this.tab.session; }

    // ---- layout -------------------------------------------------------------------------------------
    build() {
      const el = this.el;
      el.innerHTML = '';
      this.top = h('header.top');
      this.rail = h('nav.rail', { 'aria-label': 'Panels' });
      this.side = h('aside.side');
      this.center = h('main.center');
      this.dockEl = h('aside.dock');
      this.status = h('footer.status', { role: 'status' });
      const body = h('div.body', this.rail, this.side, UI.splitter('v', this.side, { key: 'w.side', min: 180, max: 520 }), this.center, UI.splitter('v', this.dockEl, { key: 'w.dock', min: 280, max: 1400, after: true, onresize: () => this.dock.renderActive() }), this.dockEl);
      el.appendChild(this.top); el.appendChild(body); el.appendChild(this.status);
      this.buildTop();
      this.buildRail();
      this.buildCenter();
      this.dock = new UI.Dock(this, this.dockEl);
      document.addEventListener('keydown', (e) => this.globalKey(e));
    }
    buildTop() {
      const t = this.top;
      t.appendChild(h('a.brand', { href: '#', title: 'Kwery', onclick: (e) => { e.preventDefault(); this.showAbout(); } }, h('span.mark', { 'aria-hidden': 'true' }), h('span', 'Kwery')));
      this.dbBtn = h('button.chip', { type: 'button', title: 'Database', onclick: (e) => this.dbMenu(e.currentTarget) }, UI.icon('db'), h('span.chip-l', ''), UI.icon('chevDown'));
      t.appendChild(this.dbBtn);
      t.appendChild(h('div.top-run', UI.btn('run', 'Run', 'Run the statement under the caret (Ctrl+Enter)', () => this.run('current'), 'primary'), UI.btn('runAll', 'Run all', 'Run the whole script (Ctrl+Shift+Enter)', () => this.run('all')), UI.btn('plan', 'Explain', 'Show the plan of the statement under the caret', () => this.explain(false)), UI.btn('bolt', 'Analyze', 'Run with EXPLAIN ANALYZE: estimated and actual rows', () => this.explain(true))));
      t.appendChild(h('div.grow'));
      t.appendChild(UI.btn('grid', 'Views', 'Open a view of the internals', (e) => this.dock.addMenu(e.currentTarget), 'ghost'));
      t.appendChild(UI.btn('share', null, 'Share this tab\'s script as a link', () => UI.Share.dialog(this), 'icon'));
      t.appendChild(UI.btn('cog', null, 'Settings', () => this.showSettings(), 'icon'));
      this.themeBtn = UI.btn(this.isDark() ? 'sun' : 'moon', null, 'Light or dark', () => { this.settings.theme = this.isDark() ? 'light' : 'dark'; this.saveSettings(); this.applyTheme(); }, 'icon');
      t.appendChild(this.themeBtn);
      t.appendChild(UI.btn('help', null, 'About Kwery', () => this.showAbout(), 'icon'));
    }
    buildRail() {
      this.panels = [
        { id: 'schema', icon: 'db', title: 'Schema', render: (el) => UI.Schema.render(this, el) },
        { id: 'learn', icon: 'learn', title: 'Lessons', render: (el) => (UI.Lessons ? UI.Lessons.render(this, el) : el.appendChild(h('div.empty', 'Lessons are coming.'))) },
        { id: 'tasks', icon: 'tasks', title: 'Exercises', render: (el) => (UI.Exercises ? UI.Exercises.render(this, el) : el.appendChild(h('div.empty', 'Exercises are coming.'))) },
        { id: 'ref', icon: 'book', title: 'Reference', render: (el) => (UI.Reference ? UI.Reference.render(this, el) : el.appendChild(h('div.empty', 'The reference is coming.'))) },
        { id: 'history', icon: 'history', title: 'History', render: (el) => this.renderHistory(el) },
      ];
      for (const p of this.panels) this.rail.appendChild(h('button.rail-btn', { type: 'button', title: p.title, 'aria-label': p.title, dataset: { id: p.id }, onclick: () => this.showPanel(this.panel === p.id && !this.side.hidden ? null : p.id) }, UI.icon(p.icon)));
    }
    showPanel(id) {
      this.panel = id;
      UI.store.set('panel', id);
      for (const b of this.rail.children) b.classList.toggle('on', b.dataset.id === id);
      this.side.hidden = !id;
      if (this.side.nextElementSibling) this.side.nextElementSibling.hidden = !id;
      if (id) this.renderPanel();
      this.layout();
    }
    renderPanel() {
      const p = this.panels.find((x) => x.id === this.panel);
      if (!p) return;
      this.side.innerHTML = '';
      this.side.appendChild(h('div.side-head', h('h2', p.title)));
      const body = h('div.side-body');
      this.side.appendChild(body);
      p.render(body);
    }
    buildCenter() {
      this.tabBar = h('div.tabs', { role: 'tablist' });
      this.edBox = h('div.ed-box');
      this.resEl = h('div.results');
      this.edWrap = h('div.ed-wrap', this.tabBar, this.edBox);
      this.center.appendChild(this.edWrap);
      this.center.appendChild(UI.splitter('h', this.edWrap, { key: 'h.editor', min: 120, max: 2000 }));
      this.center.appendChild(this.resEl);
      this.editor = new UI.Editor(this.edBox, { complete: (w, q, text, at) => this.complete(w, q, text, at) });
      this.editor.on('run', () => this.run('current'));
      this.editor.on('runAll', () => this.run('all'));
      this.editor.on('change', UI.debounce(() => { if (this.tab) { this.tab.text = this.editor.getValue(); this.saveTabs(); } }, 300));
    }
    layout() {
      const w = innerWidth;
      const phone = w < 600;
      this.el.classList.toggle('narrow', w < 900);
      this.el.classList.toggle('phone', phone);
      document.documentElement.style.setProperty('--top-h', (this.top ? this.top.offsetHeight : 52) + 'px');
    }
    isDark() { return this.settings.theme === 'dark' || (this.settings.theme === 'auto' && matchMedia && matchMedia('(prefers-color-scheme: dark)').matches); }
    applyTheme() {
      document.documentElement.dataset.theme = this.isDark() ? 'dark' : 'light';
      document.documentElement.style.setProperty('--ed-font', this.settings.font + 'px');
      if (this.themeBtn) { this.themeBtn.innerHTML = ''; this.themeBtn.appendChild(UI.icon(this.isDark() ? 'sun' : 'moon')); }
      this.emit('theme');
      if (this.dock) this.dock.renderActive();
    }
    globalKey(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); this.saveTabs(); UI.toast('Saved in this browser'); }
      if (e.key === 'F6' && this.timeline.length) { e.preventDefault(); this.timeline.step(e.shiftKey ? -1 : 1); }
    }

    // ---- the database ---------------------------------------------------------------------------------
    newDatabase(first, fresh) {
      const s = this.settings;
      this.db = null;
      for (const t of this.tabs) t.session = null;
      const sample = K.SAMPLES && K.SAMPLES[s.sample];
      const opts = { pageSize: s.pageSize, frames: s.frames, disk: s.disk, policy: s.policy };
      // a large sample is kept compressed: open an empty database now, and the sample when it has been unpacked
      if (sample && sample.file && !sample.snapshot && s.pageSize === 4096 && !(first && UI.Persist && UI.Persist.loaded)) {
        this.db = new K.Database(opts);
        this.db.app = this;
        const id = s.sample;
        UI.toast('Opening the ' + sample.title + ' database…', null, 4000);
        const done = () => { if (this.settings.sample === id) this.newDatabase(false); };
        fetchSnapshot(sample.file).then((snap) => { sample.snapshot = snap; done(); }).catch(() => {
          // no server (the page opened as a file): build it from its SQL instead, which takes longer
          UI.toast('Building the ' + sample.title + ' database from its SQL…', null, 6000);
          setTimeout(() => { sample.file = null; done(); }, 50);
        });
        if (!first) { for (const t of this.tabs) t.session = this.db.session({ name: t.name }); this.emit('db'); this.dock.onDb(); this.renderPanel(); this.drawTabs(); this.updateStatus(); }
        this.dbBtn.querySelector('.chip-l').textContent = sample.title;
        return;
      }
      const t0 = K.now();
      const saved = first && fresh !== true ? UI.Persist && UI.Persist.loaded : null;
      if (saved && saved.pageSize === s.pageSize) { try { this.db = K.Snapshot.load(saved, opts); this.restored = true; } catch (e) { console.error(e); this.db = null; } }
      if (!this.db || !first) {
        this.restored = false;
        if (sample && sample.snapshot && sample.snapshot.pageSize === s.pageSize) this.db = K.Snapshot.load(sample.snapshot, opts);
        else {
          this.db = new K.Database(opts);
          if (sample) {
            const loader = this.db.session({ name: 'loader' });
            try { loader.exec(sample.sql); loader.exec('analyze'); } catch (e) { UI.toast('The sample database did not load: ' + e.message, 'err', 8000); console.error(e); }
            this.db.closeSession(loader);
          }
        }
      }
      this.loadMs = K.now() - t0;
      this.db.app = this;
      this.db.disk.resetStats(); this.db.buffers.resetStats();
      for (const t of this.tabs) t.session = this.db.session({ name: t.name });
      this.dbBtn.querySelector('.chip-l').textContent = sample ? sample.title : 'Empty database';
      this.timeline.reset([]);
      if (!first) { this.emit('db'); this.dock.onDb(); this.renderPanel(); this.drawTabs(); this.updateStatus(); this.resEl.innerHTML = ''; UI.toast('A new database is ready'); }
    }
    /** make another database the workbench's (a backup taking over, a restored dump): sessions and views follow it */
    adoptDatabase(db) {
      this.db = db;
      db.app = this;
      for (const t of this.tabs) { t.session = db.session({ name: t.name }); t.runner = null; }
      this.timeline.reset([]);
      this.emit('db'); this.dock.onDb(); this.renderPanel(); this.drawTabs(); this.updateStatus();
    }
    dbMenu(anchor) {
      const items = [{ head: 'Sample databases' }];
      for (const [k, v] of Object.entries(K.SAMPLES || {})) items.push({ label: v.title, checked: this.settings.sample === k, onclick: () => { this.settings.sample = k; this.saveSettings(); if (UI.Persist) UI.Persist.clear(); this.newDatabase(); } });
      items.push({ label: 'Empty database', checked: this.settings.sample === 'empty', onclick: () => { this.settings.sample = 'empty'; this.saveSettings(); this.newDatabase(); } });
      items.push({ sep: true });
      items.push({ label: 'Start this database again', icon: 'refresh', onclick: () => UI.confirm('Start again?', 'Throw away the changes to this database and start again from the sample?', () => { if (UI.Persist) UI.Persist.clear(); this.newDatabase(); }, 'Start again') });
      items.push({ label: 'Download as SQL', icon: 'download', onclick: () => UI.download('kwery-dump.sql', K.Dump ? K.Dump.sql(this.db) : '', 'application/sql') });
      items.push({ label: 'Open a .sql script or a CSV file…', icon: 'upload', onclick: () => UI.Share.pick(this) });
      items.push({ label: 'Share this tab\'s script as a link…', icon: 'share', onclick: () => UI.Share.dialog(this) });
      items.push({ label: 'Storage and buffer settings…', icon: 'cog', onclick: () => this.showSettings() });
      UI.menu(anchor, items);
    }

    // ---- editor tabs: each one a session ----------------------------------------------------------------
    restoreTabs() {
      const saved = UI.store.get('tabs', null);
      const list = saved && saved.length ? saved : [{ name: 'Query 1', text: K.WELCOME_SQL || 'select title, genre, premiere\nfrom production\nwhere runtime_min > 150\norder by premiere;\n' }];
      for (const t of list) this.addTab(t.name, t.text, true);
      this.activeTab = this.tabs[Math.min(UI.store.get('tab', 0), this.tabs.length - 1)].id;
      this.tabSeq = Math.max(...this.tabs.map((t) => +(/\d+$/.exec(t.name) || [0])[0])) + 1;
      this.selectTab(this.activeTab);
    }
    addTab(name, text, quiet) {
      const t = { id: 't' + Math.random().toString(36).slice(2, 9), name: name || 'Query ' + this.tabSeq++, text: text || '', session: null, run: null };
      t.session = this.db.session({ name: t.name });
      this.tabs.push(t);
      if (!quiet) { this.selectTab(t.id); this.saveTabs(); }
      return t;
    }
    selectTab(id) {
      if (this.tab && this.tab.id !== id) this.tab.text = this.editor.getValue();
      this.activeTab = id;
      const t = this.tab;
      this.editor.setValue(t.text);
      UI.store.set('tab', this.tabs.indexOf(t));
      this.drawTabs();
      this.showRun(t.run);
      this.updateStatus();
      this.emit('session', t.session);
      this.dock.renderActive();
    }
    closeTab(id) {
      if (this.tabs.length === 1) { this.tabs[0].text = ''; this.editor.setValue(''); this.saveTabs(); return; }
      const i = this.tabs.findIndex((t) => t.id === id);
      const t = this.tabs[i];
      if (t.session && t.session.tx) { const tx = t.session.tx; t.session.abortTx(tx); this.db.step(); }
      this.db.closeSession(t.session);
      this.tabs.splice(i, 1);
      if (this.activeTab === id) this.activeTab = this.tabs[Math.min(i, this.tabs.length - 1)].id;
      this.selectTab(this.activeTab);
      this.saveTabs();
    }
    drawTabs() {
      const bar = this.tabBar;
      bar.innerHTML = '';
      for (const t of this.tabs) {
        const s = t.session;
        const state = s && s.waiting ? 'wait' : s && s.tx ? (s.tx.failed ? 'failed' : 'tx') : '';
        const tab = h('div.tab' + (t.id === this.activeTab ? '.on' : '') + (state ? '.' + state : ''), { role: 'tab', tabindex: '0', title: t.name + (state === 'tx' ? ': in a transaction' : state === 'wait' ? ': waiting for a lock' : state === 'failed' ? ': transaction failed, ROLLBACK to go on' : ''), onclick: () => this.selectTab(t.id), ondblclick: () => UI.prompt('Rename tab', 'Name', t.name, (v) => { if (v.trim()) { t.name = v.trim(); if (t.session) t.session.name = t.name; this.drawTabs(); this.saveTabs(); } }) },
          h('span.dot', { 'aria-hidden': 'true' }), h('span.tab-l', t.name), h('button.tab-x', { type: 'button', 'aria-label': 'Close ' + t.name, onclick: (e) => { e.stopPropagation(); this.closeTab(t.id); } }, UI.icon('x')));
        bar.appendChild(tab);
      }
      bar.appendChild(h('button.tab-add', { type: 'button', title: 'A new tab, with its own session (to run two transactions side by side)', 'aria-label': 'New tab', onclick: () => this.addTab() }, UI.icon('plus')));
    }
    saveTabs() { UI.store.set('tabs', this.tabs.map((t) => ({ name: t.name, text: t.id === this.activeTab ? this.editor.getValue() : t.text }))); }

    // ---- running SQL ----------------------------------------------------------------------------------------
    /** run the statement under the caret or the whole script in the active tab's session */
    run(what, textOverride) {
      const tab = this.tab;
      const text = this.editor.getValue();
      let sql, base = 0;
      if (textOverride) sql = textOverride;
      else if (what === 'all') sql = text;
      else { const cur = this.editor.current(); if (!cur) return; sql = cur.text; base = cur.a; }
      if (!sql.trim()) return;
      if (tab.runner && !tab.runner.done) { UI.toast(tab.name + ' is still waiting for a lock. Finish the other transaction first, or close the tab.', 'warn', 5000); return; }
      this.editor.clearMarks();
      this.runSql(tab, sql, base);
    }
    runSql(tab, sql, base) {
      if (this.db.down) { UI.toast('The database has crashed. Restart it in the Crash and recovery view first.', 'err', 5000); this.openView('recovery'); return; }
      const s = tab.session;
      this.emit('beforeRun', { tab, sql });
      const record = this.dock.wantsEvents();
      const events = [];
      let off = null;
      if (record) {
        let n = 0;
        off = this.db.bus.on('*', (data, type) => { if (n++ < 60000) events.push({ type, data: snap(data), session: K.currentSession ? K.currentSession.id : null }); });
      }
      const io0 = Object.assign({}, this.db.disk.stats);
      let stmts;
      // psql's backslash commands are handled by the session itself, between the statements
      const meta = K.Meta && /^\s*\\/m.test(sql);
      try { stmts = meta ? [] : K.parse(sql); } catch (e) { if (off) off(); this.finishRun(tab, { results: [{ tag: 'ERROR', error: e, text: sql, notices: [] }], base, sql }); return; }
      const trace = record ? traceHooks(events) : null;
      const runner = s.start(meta ? sql : stmts, { trace });
      tab.runner = runner;
      const t0 = K.now();
      this.db.step();
      if (off) off();
      // statements that ran report their results; a statement still waiting shows that it waits
      const results = (runner.done ? runner.results || (runner.error && runner.error.results) || [] : []).map((r, i) => Object.assign(r, { text: r.text || (stmts[i] && stmts[i].text) }));
      const run = { results, base, sql, ms: K.now() - t0, events, io: diffIo(this.db.disk.stats, io0) };
      if (runner.done && runner.error) {
        const done = results.length;
        run.results = results.concat([{ tag: 'ERROR', error: runner.error, text: stmts[done] ? stmts[done].text : sql, notices: s.notices, stmt: stmts[done] }]);
        run.stopped = done + 1 < stmts.length;
      }
      if (!runner.done) run.waiting = runner.waitingOn ? runner.waitingOn.why : 'waiting';
      this.finishRun(tab, run);
      // another tab may have been waiting for what this one just released
      this.resumeOthers(tab);
    }
    resumeOthers(except) {
      const waiting = this.tabs.filter((t) => t !== except && t.runner && !t.runner.done);
      if (!waiting.length) return;
      this.db.step();
      for (const t of waiting) if (t.runner.done) {
        const run = t.run || { results: [], sql: '', base: 0 };
        const res = t.runner.results || (t.runner.error && t.runner.error.results) || [];
        run.results = res;
        if (t.runner.error) run.results = res.concat([{ tag: 'ERROR', error: t.runner.error, text: '', notices: [] }]);
        run.waiting = null;
        t.run = run;
        UI.toast(t.name + ' went on: ' + (t.runner.error ? t.runner.error.message : 'its statement finished'), t.runner.error ? 'err' : 'ok', 4500);
        if (t === this.tab) this.showRun(run);
      }
      this.drawTabs();
      this.updateStatus();
    }
    finishRun(tab, run) {
      tab.run = run;
      if (run.results.length) { const last = run.results[run.results.length - 1]; if (last && !last.error) last.io = run.io; }
      // mark the error in the editor, at the token
      const err = run.results.find((r) => r.error);
      if (err && err.error.pos !== undefined && tab === this.tab) {
        const stmtStart = run.sql.indexOf((err.text || '').trim());
        const at = run.base + Math.max(0, stmtStart) + err.error.pos;
        const tokEnd = (() => { const v = this.editor.getValue(); const m = /^[\w$]+|^'[^']*'|^\S/.exec(v.slice(at)); return at + (m ? m[0].length : 1); })();
        this.editor.mark(at, tokEnd, 'err', err.error.message);
      }
      this.timeline.reset(run.events || []);
      if (tab === this.tab) this.showRun(run);
      this.drawTabs();
      this.updateStatus();
      if (run.results.some((r) => r.tag && /^(CREATE|ALTER|DROP|TRUNCATE|COMMIT|ROLLBACK|COMMENT|GRANT|REVOKE|SELECT \d+$)/.test(r.tag) && !/^SELECT/.test(r.tag))) { this.emit('schema'); if (this.panel === 'schema') this.renderPanel(); }
      this.addHistory(run);
      this.dock.onRun(run);
      this.emit('run', run);
    }
    showRun(run) {
      if (!run) { this.showWelcome(); return; }
      UI.Results.render(this.resEl, run, {
        zone: this.session ? this.session.settings.timezone : 'UTC',
        onShow: (r) => { const i = run.sql.indexOf((r.text || '').trim()); if (i >= 0) { this.editor.focus(); this.editor.ta.setSelectionRange(run.base + i, run.base + i + r.text.trim().length); this.editor.scrollToPos(run.base + i); } },
        onPos: (e, r) => { const i = run.sql.indexOf((r.text || '').trim()); const at = run.base + Math.max(0, i) + e.pos; this.editor.focus(); this.editor.ta.setSelectionRange(at, at + 1); this.editor.scrollToPos(at); },
        onPlan: (r) => { this.dock.show('plan', { plan: r.plan }); },
      });
      if (run && run.waiting) this.resEl.prepend(h('div.res-wait', UI.icon('clock'), h('div', h('b', 'Waiting. '), run.waiting.replace(/^waits/, 'This session waits') + '. Commit or roll back the other transaction (in its tab) and this one goes on by itself.')));
    }
    /** before anything has run: what Kwery is and where to start */
    showWelcome() {
      const el = this.resEl;
      el.innerHTML = '';
      const go = (label, icon, title, f, primary) => h('button.wel-card' + (primary ? '.primary' : ''), { type: 'button', onclick: f }, UI.icon(icon), h('div', h('b', label), h('span', title)));
      el.appendChild(h('div.welcome',
        h('div.wel-head', h('h2', 'A relational database you can see into'), h('p', 'Run SQL on Theatre, a sample database of theatre companies, productions, performances and bookings, then watch what the engine did: the plan, the pages it read, the buffer pool, the indexes, the locks and versions, the log. Every run can be stepped forwards and backwards.')),
        h('div.wel-grid',
          go('Run the query above', 'run', 'Ctrl + Enter runs the statement under the caret', () => this.run('current'), true),
          go('Take the tour', 'flag', 'Two minutes around the workbench', () => UI.Tour.start(this, 'tour-first')),
          go('Start the lessons', 'learn', 'Chapter by chapter, following Database System Concepts', () => { this.showPanel('learn'); const ch = K.Content && [...K.Content.chapters.values()].find((c) => c.lessons.length); if (ch) UI.Lessons.open(this, ch.lessons[0]); }),
          go('Open a view', 'grid', 'Pages, buffer pool, B+ trees, transactions, the log, a cluster', (e) => this.dock.addMenu(e.currentTarget))),
        h('p.wel-foot', 'Keyboard: ', h('kbd', 'Ctrl'), ' ', h('kbd', 'Enter'), ' run · ', h('kbd', 'Ctrl'), ' ', h('kbd', 'Shift'), ' ', h('kbd', 'Enter'), ' run all · ', h('kbd', 'Ctrl'), ' ', h('kbd', 'Space'), ' complete · ', h('kbd', 'Ctrl'), ' ', h('kbd', '/'), ' comment · ', h('kbd', 'F6'), ' step through the run')));
    }
    explain(analyze) {
      const cur = this.editor.current();
      if (!cur) return;
      const body = cur.text.trim().replace(/;\s*$/, '');
      if (/^explain\b/i.test(body)) { this.run('current'); return; }
      this.dock.show('plan');
      this.runSql(this.tab, 'explain ' + (analyze ? 'analyze ' : '') + body, cur.a);
    }

    // ---- completion ---------------------------------------------------------------------------------------
    complete(word, qual, text, at) {
      const cat = this.session.catalog;
      const lw = word.toLowerCase();
      const out = [];
      const add = (t, kind, detail, insert) => { if (t.toLowerCase().startsWith(lw) && !out.some((x) => x.text === t)) out.push({ text: t, kind, detail, insert }); };
      const rels = cat.tables(['table', 'view', 'matview']).filter((r) => !cat.schema(r.schema).system);
      if (qual !== null) {
        // after "x.": columns of the table (or the alias in this statement)
        const alias = new RegExp('\\b(?:from|join|update|into)\\s+("?[\\w.]+"?)\\s+(?:as\\s+)?' + qual + '\\b', 'i').exec(text);
        const name = alias ? alias[1].replace(/"/g, '').split('.').pop() : qual;
        const r = rels.find((x) => x.name === name);
        if (r) for (const c of r.cols) if (!c.dropped) add(c.name, 'column', K.T.sqlName(c.type));
        const sc = cat.schemas.get(qual);
        if (sc) for (const o of sc.objects.values()) if (o.name) add(o.name, o.kind === 'view' ? 'view' : 'table');
        return out;
      }
      const before = text.slice(0, at - word.length).toLowerCase();
      const afterFrom = /\b(from|join|update|into|table|truncate)\s+[\w,\s"]*$/.test(before.slice(-80)) && !/\b(where|on|set|select|values)\b[^;]*$/.test(before.slice(before.lastIndexOf(' from ') + 1));
      for (const r of rels) add(r.name, r.kind === 'table' ? 'table' : 'view', r.kind);
      if (!afterFrom) {
        const used = new Set((before.slice(before.lastIndexOf(';') + 1).match(/\b\w+\b/g) || []).concat((text.slice(at).split(';')[0].match(/\b\w+\b/g) || [])));
        for (const r of rels) if (used.has(r.name)) for (const c of r.cols) if (!c.dropped) add(c.name, 'column', r.name + '.' + c.name + ' ' + K.T.sqlName(c.type));
        for (const f of K.F.FUNCS.keys()) if (!f.startsWith('_') && f.length > 2) add(f, 'function', null, f + '(');
        for (const f of K.F.AGGS.keys()) add(f, 'function', 'aggregate', f + '(');
      }
      for (const k of K.SQL_KEYWORDS) if (k.length > 2) add(k, 'keyword');
      return out.sort((a, b) => (a.kind === b.kind ? 0 : ['column', 'table', 'view', 'function', 'keyword'].indexOf(a.kind) - ['column', 'table', 'view', 'function', 'keyword'].indexOf(b.kind)) || a.text.length - b.text.length);
    }

    // ---- selection shared between views ---------------------------------------------------------------------
    select(sel) { this.selection = sel; this.dock.onSelect(sel); this.emit('select', sel); }
    openView(id, sel) { return this.dock.show(id, sel); }
    /** run SQL from a view or a lesson, in the active tab, showing it in the results */
    runText(sql, opts) {
      opts = opts || {};
      if (opts.insert) { const v = this.editor.getValue(); this.editor.setValue((v.trim() ? v.replace(/\s*$/, '\n\n') : '') + sql); this.tab.text = this.editor.getValue(); this.saveTabs(); }
      this.runSql(this.tab, sql, opts.insert ? this.editor.getValue().length - sql.length : 0);
    }

    // ---- history ---------------------------------------------------------------------------------------------
    addHistory(run) {
      const list = UI.store.get('history', []);
      list.unshift({ sql: run.sql.trim().slice(0, 4000), at: Date.now(), ok: !run.results.some((r) => r.error), tag: (run.results[run.results.length - 1] || {}).tag });
      UI.store.set('history', list.slice(0, 200));
      if (this.panel === 'history') this.renderPanel();
    }
    renderHistory(el) {
      const list = UI.store.get('history', []);
      if (!list.length) { el.appendChild(h('div.empty', 'The statements you run show here.')); return; }
      el.appendChild(h('div.hist', list.map((x) => h('button.hist-item' + (x.ok ? '' : '.bad'), { type: 'button', title: 'Put this back in the editor', onclick: () => { this.editor.setValue(x.sql); this.tab.text = x.sql; this.saveTabs(); } }, h('code', x.sql.length > 160 ? x.sql.slice(0, 160) + '…' : x.sql), h('span.hist-meta', new Date(x.at).toLocaleTimeString() + (x.tag ? ' · ' + x.tag : ''))))));
      el.appendChild(UI.btn('trash', 'Clear the history', null, () => { UI.store.set('history', []); this.renderPanel(); }, 'ghost'));
    }

    // ---- status bar ------------------------------------------------------------------------------------------
    updateStatus() {
      const s = this.session, db = this.db;
      const tx = s && s.tx;
      const st = db.disk.stats, bs = db.buffers.stats;
      this.status.innerHTML = '';
      this.status.appendChild(h('span.st-item', { title: 'The active tab\'s session' }, UI.icon('users'), s ? s.name : ''));
      this.status.appendChild(h('span.st-item' + (tx ? '.on' : ''), { title: tx ? 'A transaction is open: COMMIT or ROLLBACK ends it' : 'No transaction is open: each statement commits by itself' }, UI.icon('lock'), tx ? (tx.failed ? 'Transaction failed (ROLLBACK)' : 'In transaction' + (tx.xid ? ' ' + tx.xid : '') + ' · ' + tx.isolation) : 'Autocommit'));
      if (s && s.waiting) this.status.appendChild(h('span.st-item.warn', UI.icon('clock'), 'Waiting for a lock'));
      if (db.down) this.status.appendChild(h('span.st-item.bad', UI.icon('crash'), 'The database is down: restart it'));
      this.status.appendChild(h('span.grow'));
      this.status.appendChild(h('span.st-item', { title: 'Simulated disk: block reads and writes since the database started' }, UI.icon('disk'), st.reads.toLocaleString('en-US') + ' reads · ' + st.writes.toLocaleString('en-US') + ' writes'));
      const hit = bs.hits + bs.misses ? Math.round((bs.hits / (bs.hits + bs.misses)) * 100) : 100;
      this.status.appendChild(h('span.st-item', { title: 'Buffer pool: ' + db.buffers.n + ' frames, ' + db.buffers.policy.toUpperCase() + ' replacement' }, UI.icon('frames'), db.buffers.n + ' frames · ' + hit + '% hits'));
      this.status.appendChild(h('span.st-item', { title: 'Page size' }, UI.icon('page'), db.disk.pageSize + ' B pages'));
    }

    // ---- settings and about -------------------------------------------------------------------------------------
    saveSettings() { UI.store.set('settings', this.settings); }
    showSettings() {
      const body = h('div.settings');
      const groups = new Map();
      for (const s of SETTINGS) { if (!groups.has(s.group)) groups.set(s.group, []); groups.get(s.group).push(s); }
      let needDb = false;
      for (const [g, list] of groups) {
        body.appendChild(h('h3', g));
        for (const s of list) {
          const opts = typeof s.options === 'function' ? s.options() : s.options;
          const sel = h('select.inp', { 'aria-label': s.label, onchange: (e) => { const v = typeof opts[0] === 'number' ? +e.target.value : e.target.value; this.settings[s.key] = v; this.saveSettings(); if (s.db) needDb = true; if (s.live) s.live(this, v); } }, opts.map((o) => h('option', { value: String(o), selected: String(o) === String(this.settings[s.key]) }, s.fmt ? s.fmt(o) : String(o))));
          body.appendChild(h('label.field', h('span', s.label), sel));
        }
      }
      body.appendChild(h('p.muted', 'Small pages (512 bytes) and a small buffer pool (4 or 8 frames) make the pictures of the course appear with a few rows of data. SET statements change the planner, isolation and other settings of one session: try SHOW ALL.'));
      UI.dialog('Settings', body, { buttons: [{ label: 'Close', onclick: () => { if (needDb) UI.confirm('Start a new database?', 'The storage settings apply to a new database. Start one now with these settings? (The scripts in your tabs stay.)', () => this.newDatabase(), 'Start a new database'); } }] });
    }
    showAbout() {
      if (UI.About) { UI.About.show(this); return; }
      UI.dialog('Kwery', h('div', h('p', 'Kwery is a relational database you can see into.'), h('p.muted', 'Version ' + (K.VERSION || 'dev'))));
    }
  }

  /** fetch and inflate a sample's snapshot file (deflate-raw JSON) */
  async function fetchSnapshot(file) {
    const r = await fetch(file);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const text = await new Response(r.body.pipeThrough(new DecompressionStream('deflate-raw'))).text();
    return JSON.parse(text);
  }
  /** copy what a bus event carries that later code might change (rows, TIDs), so stepping back shows the past */
  function snap(d) {
    if (!d || typeof d !== 'object') return d;
    const out = {};
    for (const k of Object.keys(d)) {
      const v = d[k];
      if (v instanceof Uint8Array) out[k] = v.length > 64 ? v : v.slice();
      else if (k === 'node') { out.node = v; out.op = v && v.op; }
      else if (Array.isArray(v)) out[k] = v.slice();
      else if (v && typeof v === 'object' && !(v instanceof Map) && Object.keys(v).length <= 6 && !v.op) out[k] = Object.assign({}, v);
      else out[k] = v;
    }
    return out;
  }
  /** the executor's trace hooks, recording operator calls and the rows each produces */
  function traceHooks(events) {
    return {
      open(n) { events.push({ type: 'exec.open', data: { node: n, op: n.op } }); },
      row(n, r) { if (events.length < 60000) events.push({ type: 'exec.row', data: { node: n, op: n.op, row: Array.from(r).slice(0, 16), text: rowText(r, n) } }); },
      close(n) { events.push({ type: 'exec.close', data: { node: n, op: n.op, rows: n.rt ? n.rt.rows : 0 } }); },
    };
  }
  const rowText = (r, n) => Array.from(r).map((v, i) => [v, n.cols && n.cols[i]]).filter(([, c]) => !c || !c.hidden).slice(0, 6).map(([v, c]) => (v === null || v === undefined ? 'NULL' : c ? UI.valueText(v, c.type) : String(v))).join(', ').slice(0, 120);
  const diffIo = (a, b) => ({ reads: a.reads - b.reads, writes: a.writes - b.writes, seeks: a.seeks - b.seeks, ms: a.ms - b.ms });

  UI.App = App;
  UI.SETTINGS = SETTINGS;
})(typeof window !== 'undefined' ? window : globalThis);
