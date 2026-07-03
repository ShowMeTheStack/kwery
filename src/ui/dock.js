// Views: the panes that draw the engine's internals (plans, pages, the buffer pool, indexes, locks, the log,
// the cluster ...). Each registers itself here; the dock shows the open ones as tabs and keeps them in step with
// the recorded run, so every view can be stepped forwards and backwards through what the last statement did.
(function (root) {
  'use strict';
  const K = root.K;
  const UI = K.UI;
  const { h } = UI;

  const registry = new Map();
  /**
   * register a view: { id, title, icon, group, order, events (true if it draws from recorded events),
   *   create(app, el) -> { render(), destroy?(), onSelect?(sel), onRun?(run) } }
   */
  UI.registerView = (def) => { registry.set(def.id, Object.assign({ group: 'More', order: 50 }, def)); };
  UI.views = registry;

  /** the recorded events of a run, with a position that the step controls move */
  class Timeline {
    constructor() { this.events = []; this.pos = 0; this.listeners = new Set(); this.kinds = 'all'; }
    reset(events) { this.events = events || []; this.pos = this.events.length; this.emit(); }
    get length() { return this.events.length; }
    /** events of a kind: operator calls, tuples, page I/O, log records */
    matches(e) {
      const k = this.kinds;
      if (k === 'all') return true;
      if (k === 'operator') return e.type === 'exec.open' || e.type === 'exec.close';
      if (k === 'tuple') return e.type === 'exec.row';
      if (k === 'page') return /^(buf|disk|heap\.page|btree\.visit)/.test(e.type);
      if (k === 'log') return /^wal\./.test(e.type);
      if (k === 'lock') return /^(lock|cc|xact)\./.test(e.type);
      return true;
    }
    step(d) {
      let p = this.pos;
      if (d > 0) { do p++; while (p < this.events.length && !this.matches(this.events[p - 1])); }
      else { do p--; while (p > 0 && !this.matches(this.events[p - 1])); }
      this.go(p);
    }
    go(p) { this.pos = Math.max(0, Math.min(this.events.length, p)); this.emit(); }
    upTo() { return this.events.slice(0, this.pos); }
    current() { return this.pos > 0 ? this.events[this.pos - 1] : null; }
    on(f) { this.listeners.add(f); return () => this.listeners.delete(f); }
    emit() { for (const f of this.listeners) f(this); }
  }
  UI.Timeline = Timeline;

  /** the dock: tabs of open views, with the step controls on top */
  class Dock {
    constructor(app, el) {
      this.app = app;
      this.el = el;
      this.open = [];          // [{ id, view, pane }]
      this.active = null;
      this.tabs = h('div.dock-tabs', { role: 'tablist' });
      this.addBtn = UI.btn('plus', null, 'Open a view', (e) => this.addMenu(e.currentTarget), 'icon');
      this.maxBtn = UI.btn('max', null, 'Give the views the whole width (again to give the editor its place back)', () => this.toggleMax(), 'icon');
      this.hideBtn = UI.btn('chevDown', null, 'Hide the views (they stay open)', () => this.hideSheet(), 'icon sheet-hide');
      this.stepBar = this.makeStepBar();
      this.panes = h('div.dock-panes');
      el.appendChild(h('div.dock-head', this.tabs, this.addBtn, this.maxBtn, this.hideBtn));
      el.appendChild(this.stepBar);
      el.appendChild(this.panes);
      app.timeline.on(() => { this.updateStepBar(); this.renderActive(); });
    }
    makeStepBar() {
      const tl = this.app.timeline;
      this.slider = h('input.tl-range', { type: 'range', min: '0', max: '0', value: '0', 'aria-label': 'Position in the recorded run', oninput: (e) => tl.go(+e.target.value) });
      this.posLabel = h('span.tl-pos', '');
      this.kindSel = h('select.tl-kind', { 'aria-label': 'Step by', onchange: (e) => { tl.kinds = e.target.value; } },
        [['all', 'Step: every event'], ['operator', 'Step: operator calls'], ['tuple', 'Step: tuples'], ['page', 'Step: page I/O'], ['log', 'Step: log records'], ['lock', 'Step: locks and transactions']].map(([v, l]) => h('option', { value: v }, l)));
      this.curLabel = h('div.tl-cur', '');
      return h('div.stepbar',
        h('div.tl-row', UI.btn('first', null, 'Back to the start of the run', () => tl.go(0), 'icon'), UI.btn('stepBack', null, 'Step back', () => tl.step(-1), 'icon'), UI.btn('step', null, 'Step forward', () => tl.step(1), 'icon'), UI.btn('last', null, 'To the end of the run', () => tl.go(tl.length), 'icon'), this.slider, this.posLabel, this.kindSel),
        this.curLabel);
    }
    updateStepBar() {
      const tl = this.app.timeline;
      this.slider.max = String(tl.length);
      this.slider.value = String(tl.pos);
      this.posLabel.textContent = tl.length ? tl.pos + ' / ' + tl.length : 'nothing recorded';
      const e = tl.current();
      this.curLabel.textContent = e ? describeEvent(e) : tl.length ? 'Before the first event' : 'Run a statement while a view is open to record what it does.';
      this.stepBar.classList.toggle('empty', !tl.length);
    }
    toggleMax(on) {
      const v = on === undefined ? !this.app.el.classList.contains('dock-max') : on;
      this.app.el.classList.toggle('dock-max', v);
      this.maxBtn.classList.toggle('on', v);
      this.renderActive();
    }
    addMenu(anchor) {
      const groups = new Map();
      for (const v of [...registry.values()].sort((a, b) => a.order - b.order)) { if (!groups.has(v.group)) groups.set(v.group, []); groups.get(v.group).push(v); }
      const items = [];
      for (const [g, list] of groups) { items.push({ head: g }); for (const v of list) items.push({ label: v.title, icon: v.icon, checked: this.open.some((o) => o.id === v.id), onclick: () => this.show(v.id) }); }
      UI.menu(anchor, items, { right: true });
    }
    /** open a view (or bring it forward) */
    show(id, sel) {
      let o = this.open.find((x) => x.id === id);
      if (!o) {
        const def = registry.get(id);
        if (!def) return null;
        const pane = h('div.dock-pane', { role: 'tabpanel' });
        this.panes.appendChild(pane);
        let view;
        try { view = def.create(this.app, pane) || {}; } catch (e) { pane.appendChild(h('div.res-err', 'This view failed to start: ' + e.message)); view = {}; console.error(e); }
        o = { id, def, view, pane };
        this.open.push(o);
        this.save();
      }
      // the selection reaches the view before it is drawn
      if (sel && o.view.onSelect) o.view.onSelect(sel);
      this.activate(id);
      this.app.layout();
      return o.view;
    }
    close(id) {
      const i = this.open.findIndex((x) => x.id === id);
      if (i < 0) return;
      const o = this.open[i];
      if (o.view.onHide) { try { o.view.onHide(); } catch (e) { console.error(e); } }
      if (o.view.destroy) o.view.destroy();
      o.pane.remove();
      this.open.splice(i, 1);
      if (this.active === id) this.active = this.open.length ? this.open[Math.min(i, this.open.length - 1)].id : null;
      this.save();
      this.drawTabs();
      this.renderActive();
      this.app.layout();
    }
    activate(id) {
      const prev = this.open.find((x) => x.id === this.active);
      if (prev && prev.id !== id && prev.view.onHide) { try { prev.view.onHide(); } catch (e) { console.error(e); } }
      this.active = id; this.drawTabs(); for (const o of this.open) o.pane.hidden = o.id !== id;
      const o = this.open.find((x) => x.id === id);
      this.stepBar.hidden = !(o && o.def.events);
      this.el.classList.remove('closed');
      if (o && o.view.onShow) { try { o.view.onShow(); } catch (e) { console.error(e); } }
      this.renderActive(); UI.store.set('dock.active', id);
    }
    /** on a phone the dock is a sheet over the editor: hide it without closing its views */
    hideSheet() { const o = this.open.find((x) => x.id === this.active); if (o && o.view.onHide) o.view.onHide(); this.el.classList.add('closed'); }
    drawTabs() {
      this.tabs.innerHTML = '';
      for (const o of this.open) {
        const t = h('div.dock-tab' + (o.id === this.active ? '.on' : ''), { role: 'tab', 'aria-selected': String(o.id === this.active), tabindex: '0', onclick: () => this.activate(o.id), ondblclick: () => this.toggleMax(), onkeydown: (e) => { if (e.key === 'Enter') this.activate(o.id); } },
          UI.icon(o.def.icon || 'grid'), h('span', o.def.title), h('button.tab-x', { type: 'button', 'aria-label': 'Close ' + o.def.title, onclick: (e) => { e.stopPropagation(); this.close(o.id); } }, UI.icon('x')));
        this.tabs.appendChild(t);
      }
      this.el.classList.toggle('none', !this.open.length);
    }
    renderActive() { const o = this.open.find((x) => x.id === this.active); if (o && o.view.render) { try { o.view.render(); } catch (e) { console.error(e); } } }
    /** after a run, every open view hears about it */
    onRun(run) { for (const o of this.open) if (o.view.onRun) { try { o.view.onRun(run); } catch (e) { console.error(e); } } this.renderActive(); }
    onDb() { for (const o of this.open) if (o.view.onDb) { try { o.view.onDb(); } catch (e) { console.error(e); } } this.renderActive(); }
    onSelect(sel) { for (const o of this.open) if (o.view.onSelect) o.view.onSelect(sel); }
    wantsEvents() { return this.open.some((o) => o.def.events); }
    save() { UI.store.set('dock.open', this.open.map((o) => o.id)); }
    restore() { const ids = UI.store.get('dock.open', ['plan']); for (const id of ids) if (registry.has(id)) this.show(id); const a = UI.store.get('dock.active'); if (a && this.open.some((o) => o.id === a)) this.activate(a); }
  }
  UI.Dock = Dock;

  /** a one-line description of a recorded event, for the step bar */
  function describeEvent(e) {
    const d = e.data || {};
    switch (e.type) {
      case 'exec.open': return 'Start ' + (d.op || 'operator');
      case 'exec.row': return (d.op || 'Operator') + ' produced a row' + (d.text ? ': ' + d.text : '');
      case 'exec.close': return (d.op || 'Operator') + ' finished (' + UI.plural(d.rows || 0, 'row') + ')';
      case 'buf.hit': return 'Buffer hit: block ' + d.block + ' of file ' + d.file + ' is in frame ' + d.frame;
      case 'buf.miss': return 'Buffer miss: block ' + d.block + ' of file ' + d.file + ' read into frame ' + d.frame;
      case 'buf.evict': return 'Evicted block ' + d.block + ' of file ' + d.file + ' from frame ' + d.frame;
      case 'buf.flush': return 'Wrote dirty frame ' + d.frame + ' (block ' + d.block + ') to disk';
      case 'buf.dirty': return 'Frame ' + d.frame + ' is now dirty';
      case 'buf.unpin': return 'Unpinned frame ' + d.frame + ' (' + d.pins + ' pins left)';
      case 'disk.read': return 'Disk read: ' + d.name + ' block ' + d.block + (d.seek ? ' (seek)' : '') + ', ' + UI.ms(d.ms);
      case 'disk.write': return 'Disk write: ' + d.name + ' block ' + d.block + ', ' + UI.ms(d.ms);
      case 'heap.insert': return 'Inserted a tuple into ' + d.rel + ' at (' + d.tid.b + ',' + d.tid.o + ')';
      case 'heap.update': return 'Replaced the version at (' + d.tid.b + ',' + d.tid.o + ') of ' + d.rel + ' by one at (' + d.newTid.b + ',' + d.newTid.o + ')';
      case 'heap.delete': return 'Marked (' + d.tid.b + ',' + d.tid.o + ') of ' + d.rel + ' deleted by transaction ' + d.xid;
      case 'heap.page': return 'Scan reads page ' + d.block + ' of ' + d.rel;
      case 'btree.visit': return 'B+ tree ' + d.index + ': visit ' + (d.leaf ? 'leaf' : 'internal node') + ' block ' + d.block;
      case 'btree.split': return 'B+ tree ' + d.index + ': split block ' + d.block + ' into ' + d.block + ' and ' + d.right;
      case 'btree.bulkload': return 'B+ tree ' + d.index + ': built bottom-up from ' + d.entries + ' sorted entries, ' + d.levels + (d.levels === 1 ? ' level' : ' levels') + ', leaves ' + Math.round(d.fillfactor) + '% full';
      case 'btree.newroot': return 'B+ tree ' + d.index + ': a new root, the tree is now ' + (d.levels + 1) + ' levels';
      case 'wal.append': return 'Log record ' + d.lsn + ': ' + d.type + (d.xid ? ' by transaction ' + d.xid : '');
      case 'wal.flush': return 'Log flushed to ' + d.lsn + ' (' + d.why + ')';
      case 'xact.assign': return 'Transaction id ' + d.xid + ' assigned';
      case 'xact.status': return 'Transaction ' + d.xid + ' ' + d.status;
      case 'xact.snapshot': return 'Snapshot taken: xmin ' + d.xmin + ', xmax ' + d.xmax + (d.xip.length ? ', running ' + d.xip.join(', ') : '');
      case 'lock.wait': return 'Transaction waits: ' + (d.what || d.tag || '');
      case 'lock.grant': return 'Lock granted: ' + d.mode + ' on ' + d.what;
      case 'lock.release': return 'Lock released: ' + d.tag;
      case 'runner.done': return 'The statement finished' + (d.error ? ' with an error: ' + d.error : '');
      case 'session.result': return 'Result: ' + d.tag;
      case 'exec.hashbuilt': return 'Hash join: built the hash table (' + d.rows + ' rows in ' + d.buckets + ' buckets)';
      case 'exec.mergesorted': return 'Merge join: both inputs sorted (' + d.left + ' and ' + d.right + ' rows)';
      case 'exec.block': return 'Block nested loop: outer block ' + d.block + ' (' + d.rows + ' rows) against the whole inner input';
      case 'exec.recursion': return 'Recursive query ' + d.cte + ': iteration ' + d.iteration + ' starts with ' + d.rows + ' new rows';
      case 'exec.bitmap': return 'Bitmap of ' + d.tids + ' TIDs on ' + d.blocks + ' blocks of ' + d.rel;
      case 'seq.next': return 'Sequence ' + d.seq + ' gave ' + d.value;
    }
    return e.type.replace(/\./g, ' ');
  }
  UI.describeEvent = describeEvent;
})(typeof window !== 'undefined' ? window : globalThis);
