// The E-R editor (chapter 6): an entity-relationship diagram drawn and edited on a canvas, in the boxed-attribute
// notation with min..max, Chen's or crow's foot, and kept in step with its text form both ways. The design is
// validated and checked as it changes, can be reduced to tables rule by rule and run in a schema of its own,
// and can be read back from the tables of the database.
(function (root) {
  'use strict';
  const K = root.K;
  const UI = K.UI;
  const ER = K.ER;
  const { h, s } = UI;
  const lc = (x) => String(x == null ? '' : x).toLowerCase();
  const same = (a, b) => lc(a) === lc(b);
  const NOTATIONS = [['textbook', 'Boxed attributes'], ['chen', 'Chen'], ['crowsfoot', 'Crow\'s foot']];
  const LINE = 18;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  // the shape automatic layouts aim for (fixed, so a layout comes out the same each time)
  // (the canvas is wider than tall on a phone too: the side panel goes under it)
  const ER_ASPECT = () => 1.5;

  const ICONS = {
    undo: '<path d="M7.5 4.5L3.5 8.5l4 4"/><path d="M3.5 8.5h8.5a4.5 4.5 0 0 1 0 9H8.5"/>',
    redo: '<path d="M12.5 4.5l4 4-4 4"/><path d="M16.5 8.5H8a4.5 4.5 0 0 0 0 9h3.5"/>',
    zoomIn: '<circle cx="8.5" cy="8.5" r="5.5"/><path d="M12.5 12.5l5 5M6 8.5h5M8.5 6v5"/>',
    zoomOut: '<circle cx="8.5" cy="8.5" r="5.5"/><path d="M12.5 12.5l5 5M6 8.5h5"/>',
    fit: '<path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4"/><rect x="7" y="7" width="6" height="6" rx="1"/>',
    erEntity: '<rect x="2.5" y="5" width="15" height="10" rx="1.5"/>',
    erWeak: '<rect x="1.5" y="4" width="17" height="12" rx="1.5"/><rect x="4" y="6.5" width="12" height="7" rx="1"/>',
    erRel: '<path d="M10 3.5l7.5 6.5-7.5 6.5L2.5 10z"/>',
    erAttr: '<ellipse cx="10" cy="10" rx="7.5" ry="4.5"/>',
    erIsa: '<path d="M10 3.5l7.5 12.5h-15z"/>',
    erAgg: '<rect x="1.5" y="3" width="17" height="14" rx="2" stroke-dasharray="3 2"/><path d="M10 6.5l3.5 3.5-3.5 3.5-3.5-3.5z"/>',
    erLink: '<circle cx="4.5" cy="15.5" r="2"/><circle cx="15.5" cy="4.5" r="2"/><path d="M6 14l8-8"/>',
    layout: '<rect x="2.5" y="2.5" width="6" height="5" rx="1"/><rect x="11.5" y="12.5" width="6" height="5" rx="1"/><rect x="11.5" y="2.5" width="6" height="5" rx="1"/><path d="M8.5 5h3M14.5 7.5v5"/>',
  };
  for (const k in ICONS) if (!UI.ICONS[k]) UI.ICONS[k] = ICONS[k];

  // ---- the diagram's colours come from CSS variables (see er.css), so both themes are drawn properly
  const TV = { background: 'canvas', text: 'text', line: 'line', muted: 'muted', entity: 'entity', entityStroke: 'entity-stroke', header: 'header', rel: 'rel', relStroke: 'rel-stroke', attr: 'attr', attrStroke: 'attr-stroke', assoc: 'assoc', assocStroke: 'assoc-stroke', assocHeader: 'assoc-header', group: 'group', isa: 'isa' };
  function theme(el) {
    const cs = getComputedStyle(el || document.documentElement);
    const t = {};
    for (const k in TV) { const v = cs.getPropertyValue('--er-' + TV[k]).trim(); if (v) t[k] = v; }
    return t;
  }

  // ---- a pannable, zoomable SVG host for a laid-out diagram, shared with the schema diagram ----------------------
  // World coordinates are the layout's coordinates plus its origin, so nodes keep their place when the bounding box
  // of the diagram changes. opts: onDown(e) -> { move(dx, dy, e), up(moved, e) } | null (null pans the view),
  // onBackground(e) for a click on empty space, onDbl(e), onView() after a pan or zoom.
  class Canvas {
    constructor(host, opts) {
      this.opts = opts || {};
      this.host = host;
      this.svg = s('svg', { class: 'er-svg', role: 'img', 'aria-label': opts.label || 'diagram' });
      this.world = s('g');
      this.content = s('g');
      this.diagram = s('g', { class: 'er-diagram' });
      this.over = s('g', { class: 'er-over' });
      this.content.appendChild(this.diagram); this.content.appendChild(this.over);
      this.world.appendChild(this.content); this.svg.appendChild(this.world);
      host.appendChild(this.svg);
      this.tx = 16; this.ty = 16; this.z = 1;
      this.L = null;
      // until the user pans or zooms, the view follows the size of its pane and keeps the diagram fitted
      this.touched = false; this.fitSize = null;
      this.pointers = new Map();
      this.bind();
    }
    set(L, svgText) {
      this.L = L;
      this.content.setAttribute('transform', 'translate(' + L.origin.x + ',' + L.origin.y + ')');
      this.diagram.innerHTML = svgText;
      const inner = this.diagram.firstElementChild;
      if (inner) { inner.setAttribute('overflow', 'visible'); inner.removeAttribute('role'); }
    }
    apply() { this.world.setAttribute('transform', 'translate(' + this.tx.toFixed(1) + ',' + this.ty.toFixed(1) + ') scale(' + this.z.toFixed(4) + ')'); if (this.opts.onView) this.opts.onView(); }
    size() { const r = this.host.getBoundingClientRect(); return { w: r.width, h: r.height }; }
    bounds() { const L = this.L; return L ? { x: L.origin.x, y: L.origin.y, w: L.width, h: L.height } : { x: 0, y: 0, w: 100, h: 100 }; }
    fit(max) {
      const { w, h: hh } = this.size();
      if (!w || !hh) return false;
      const b = this.bounds();
      // room at the bottom for the zoom buttons and the status that float over the canvas
      const pb = hh > 140 ? 46 : 8;
      this.z = clamp(Math.min((w - 20) / b.w, (hh - 14 - pb) / b.h), 0.02, max || 1.2);
      this.touched = false; this.fitSize = w + 'x' + hh; this.fitMax = max;
      this.tx = (w - b.w * this.z) / 2 - b.x * this.z;
      this.ty = (hh - pb - b.h * this.z) / 2 - b.y * this.z;
      this.apply();
      return true;
    }
    zoomAt(f, px, py) {
      const nz = clamp(this.z * f, Math.min(0.1, this.z), 4), k = nz / this.z;
      this.tx = px - (px - this.tx) * k; this.ty = py - (py - this.ty) * k; this.z = nz;
      this.apply();
    }
    zoomBy(f) { const { w, h: hh } = this.size(); this.touched = true; this.zoomAt(f, w / 2, hh / 2); }
    actual() { const { w, h: hh } = this.size(); this.touched = true; this.zoomAt(1 / this.z, w / 2, hh / 2); }
    /** fit again when the pane changed size and the user has not moved the view; true when the view is fitted */
    refit() { const { w, h: hh } = this.size(); if (!w || !hh) return false; if (!this.touched && this.fitSize !== w + 'x' + hh) return this.fit(this.fitMax); return true; }
    toWorld(cx, cy) { const r = this.svg.getBoundingClientRect(); return { x: (cx - r.left - this.tx) / this.z, y: (cy - r.top - this.ty) / this.z }; }
    toHost(x, y) { return { x: x * this.z + this.tx, y: y * this.z + this.ty }; }
    centre() { const { w, h: hh } = this.size(); return { x: (w / 2 - this.tx) / this.z, y: (hh / 2 - this.ty) / this.z }; }
    /** pan so that a world box is in view */
    reveal(b) {
      const { w, h: hh } = this.size();
      const a = this.toHost(b.x, b.y), c = this.toHost(b.x + b.w, b.y + b.h);
      if (a.x >= 8 && a.y >= 8 && c.x <= w - 8 && c.y <= hh - 8) return;
      this.tx += w / 2 - (a.x + c.x) / 2; this.ty += hh / 2 - (a.y + c.y) / 2;
      this.apply();
    }
    bind() {
      const svg = this.svg;
      svg.addEventListener('wheel', (e) => {
        e.preventDefault();
        this.touched = true;
        const r = svg.getBoundingClientRect();
        // a pinch on a trackpad arrives as a wheel event with ctrlKey
        if (e.ctrlKey || e.metaKey) this.zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
        else { this.tx -= e.deltaX; this.ty -= e.deltaY; this.apply(); }
      }, { passive: false });
      svg.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 && e.pointerType === 'mouse') return;
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        try { svg.setPointerCapture(e.pointerId); } catch (err) { /* already gone */ }
        if (this.pointers.size === 2) {
          // two fingers: pinch to zoom, and forget whatever the first finger started
          if (this.drag && this.drag.cancel) this.drag.cancel();
          const [p, q] = [...this.pointers.values()];
          this.touched = true;
          this.pinch = { d: Math.hypot(p.x - q.x, p.y - q.y) || 1, z: this.z, tx: this.tx, ty: this.ty, mx: (p.x + q.x) / 2, my: (p.y + q.y) / 2 };
          this.drag = null;
          return;
        }
        if (this.pointers.size > 2) return;
        const handler = this.opts.onDown ? this.opts.onDown(e) : null;
        const tx = this.tx, ty = this.ty;
        this.drag = handler || { move: (dx, dy) => { this.touched = true; this.tx = tx + dx * this.z; this.ty = ty + dy * this.z; this.apply(); }, up: (moved) => { if (!moved && this.opts.onBackground) this.opts.onBackground(e); }, pan: true };
        this.drag.x0 = e.clientX; this.drag.y0 = e.clientY; this.drag.moved = false;
        if (this.drag.pan) svg.classList.add('panning');
      });
      svg.addEventListener('pointermove', (e) => {
        if (!this.pointers.has(e.pointerId)) return;
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this.pinch && this.pointers.size === 2) {
          const [p, q] = [...this.pointers.values()], P = this.pinch;
          const r = svg.getBoundingClientRect();
          const nz = clamp(P.z * (Math.hypot(p.x - q.x, p.y - q.y) / P.d), Math.min(0.1, P.z), 4);
          const mx = (p.x + q.x) / 2 - r.left, my = (p.y + q.y) / 2 - r.top, k = nz / P.z;
          this.z = nz; this.tx = mx - (P.mx - r.left - P.tx) * k; this.ty = my - (P.my - r.top - P.ty) * k;
          this.apply();
          return;
        }
        const d = this.drag;
        if (!d) return;
        const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
        if (!d.moved && Math.hypot(dx, dy) < 4) return;
        d.moved = true;
        d.move(dx / this.z, dy / this.z, e);
      });
      const end = (e) => {
        if (!this.pointers.has(e.pointerId)) return;
        this.pointers.delete(e.pointerId);
        if (this.pinch) { if (this.pointers.size < 2) this.pinch = null; return; }
        const d = this.drag;
        this.drag = null;
        svg.classList.remove('panning');
        if (d && e.type === 'pointerup') d.up(d.moved, e);
        else if (d && d.cancel) d.cancel();
      };
      svg.addEventListener('pointerup', end);
      svg.addEventListener('pointercancel', end);
      svg.addEventListener('dblclick', (e) => { if (this.opts.onDbl) this.opts.onDbl(e); });
    }
  }

  // ---- samples ------------------------------------------------------------------------------------------------
  const SAMPLES = {
    theatre: { title: 'Theatre network (a full design)', name: 'Theatre network', text: `-- venues and their stages, productions staged by companies, and the people who make and watch them
entity venue (venue_code varchar(6) key, venue_name varchar(40), address (street varchar(40), city varchar(30), postcode varchar(10)), {phone varchar(20)})
weak entity stage (stage_no integer partial, seats integer, stage_kind varchar(12))
identifying relationship has_stage (stage [1..1] total, venue [0..*])
entity company (company_id integer key, company_name varchar(40), founded integer)
entity production (prod_id integer key, title varchar(60), opening date, weeks_open() derived from opening)
entity season (season_year integer key, theme varchar(40))
entity person (person_id integer key, full_name (given varchar(30), family varchar(30)), birth_date date, age() derived from birth_date)
entity artist (billed_as varchar(40), {skill varchar(20)})
entity crew (trade varchar(20), day_rate numeric(7,2))
isa person (artist, crew) overlapping partial
entity patron (patron_id integer key, name varchar(40), {email varchar(60)})
relationship staged_by (production [1..1] total, company [0..*])
relationship scheduled (production [0..*], stage [0..*], season [0..*]) with (nights integer)
relationship belongs_to (artist [0..*], company [0..*]) with (since date)
relationship coaches (artist as coach [0..*], artist as trainee [0..1])
relationship attends (patron [0..*], production [0..*]) with (rating integer)
relationship runs (crew [0..1], stage [0..*])
` },
    small: { title: 'A small example', name: 'Parks', text: `entity park (park_code varchar(4) key, park_name varchar(30), area_km2 numeric(8,1))
entity ranger (ranger_id varchar(5) key, name varchar(30), hired date)
entity trail (trail_no varchar(6) key, trail_name varchar(30), length_km numeric(5,1))
relationship maintains (trail [0..1], ranger [0..*])
relationship works_in (ranger [1..1] total, park [0..*])
` },
  };

  // ---- the working models, kept in the browser --------------------------------------------------------------------
  const KEY = (ex) => (ex ? 'er.ex.' + ex : 'er.work');
  function loadWork(ex) {
    const w = UI.store.get(KEY(ex));
    if (w && w.model) { try { return { model: ER.fromJSON(w.model), pos: w.pos || {}, notation: ER.notation(w.notation), name: w.name || '' }; } catch (e) { /* unreadable: start again */ } }
    return null;
  }
  let live = null; // the open editor, if any

  /** the attribute paths of a list in the order the boxes list them (a composite, then its components) */
  const attrPaths = (attrs, path) => { const out = []; for (const a of attrs || []) { const p = (path || []).concat(a.name); out.push(p); if (a.components) out.push(...attrPaths(a.components, p)); } return out; };
  const pathEq = (a, b) => a && b && a.length === b.length && a.every((x, i) => same(x, b[i]));
  function findAttr(list, path) {
    let cur = list, a = null, parent = null;
    for (const n of path) { parent = cur; a = (cur || []).find((x) => same(x.name, n)); if (!a) return null; cur = a.components; }
    return { attr: a, list: parent, index: parent.indexOf(a) };
  }
  const ownerOf = (m, o) => (o.kind === 'entity' ? ER.entity(m, o.name) : ER.relationship(m, o.name));
  const takenName = (m, n) => !!(ER.entity(m, n) || ER.relationship(m, n) || ER.aggregation(m, n));
  const uniq = (m, base) => { let n = base, k = 2; while (takenName(m, n)) n = base + '_' + k++; return n; };

  function create(app, el) {
    let model = null, pos = {}, nt = 'textbook', docName = '', exercise = null;
    let L = null, sel = null, multi = [], mode = null, tab = UI.store.get('er.tab', 'props');
    let undo = [], redo = [], textSource = false, lastTextPush = 0, fitted = false;
    const view = {};

    // ---- the page
    // on a phone the introduction folds to one line of its own (er.css), and opens with a tap
    const intro = h('p.er-intro', h('span.er-intro-short', 'About the E-R diagram ›'), h('span.er-intro-full', 'An E-R diagram describes a design as ', h('b', 'entity sets'), ' (rectangles), the ', h('b', 'relationship sets'), ' among them (diamonds) and their ', h('b', 'attributes'), '. Draw it here or type it in the Text tab; the two stay in step, and the checker explains what the chapter would criticize. ', h('b', 'To SQL'), ' reduces the design to tables one rule at a time.'));
    intro.title = 'Click to read it all';
    intro.addEventListener('click', () => intro.classList.toggle('open'));
    const banner = h('div.er-banner', { hidden: true });
    const tools = h('div.er-tools');
    const host = h('div.er-canvas', { tabindex: '0', 'aria-label': 'E-R diagram canvas' });
    const hint = h('div.er-hint', { hidden: true });
    const statusEl = h('button.er-status', { type: 'button', onclick: () => showTab('checks') });
    const zoom = h('div.er-zoom',
      UI.btn('zoomOut', null, 'Zoom out', () => canvas.zoomBy(1 / 1.2), 'icon'),
      h('button.er-pct', { type: 'button', title: 'Actual size', onclick: () => canvas.actual() }, '100%'),
      UI.btn('zoomIn', null, 'Zoom in', () => canvas.zoomBy(1.2), 'icon'),
      UI.btn('fit', null, 'Fit the diagram in the view', () => canvas.fit(), 'icon'));
    const stage = h('div.er-stage', host, hint, zoom, statusEl);
    const tabsEl = h('div.seg.er-tabs');
    const propsEl = h('div.er-pane.er-props');
    const textBox = h('div.er-text-box');
    const perr = h('div.er-perr', { hidden: true });
    const textEl = h('div.er-pane.er-textpane', h('div.er-text-head', h('span.muted', 'The design as text. Edit it and the diagram follows.'), h('button.btn.small.ghost', { type: 'button', onclick: () => grammar.hidden = !grammar.hidden }, UI.icon('help'), 'Syntax')), textBox, perr);
    const grammar = h('pre.er-grammar', { hidden: true }, ER.GRAMMAR);
    textEl.insertBefore(grammar, textBox);
    const checksEl = h('div.er-pane.er-checks');
    const side = h('div.er-side', tabsEl, propsEl, textEl, checksEl);
    const main = h('div.er-main', stage, UI.splitter('h', side, { key: 'er.side', min: 140, max: 900, after: true }), side);
    const wrap = h('div.er-view', intro, banner, tools, main);
    el.appendChild(wrap);
    if (UI.store.get('er.noside', false)) wrap.classList.add('noside');

    const editor = new UI.Editor(textBox, { label: 'E-R design as text' });
    editor.on('change', () => { textSource = true; onText(); });
    const onText = UI.debounce(() => applyText(), 350);

    const canvas = new Canvas(host, { label: 'E-R diagram', onDown, onBackground, onDbl, onView: () => { zoom.querySelector('.er-pct').textContent = Math.round(canvas.z * 100) + '%'; } });
    const relayout = UI.raf(() => draw(true));

    // ---- state: load, save, undo ----------------------------------------------------------------------------------
    function snapshot() { return JSON.stringify({ m: ER.toJSON(model), pos, name: docName }); }
    function restore(snap) { const o = JSON.parse(snap); model = ER.fromJSON(o.m); pos = o.pos || {}; docName = o.name || docName; }
    function pushUndo() { undo.push(snapshot()); if (undo.length > 150) undo.shift(); redo = []; }
    function save() { UI.store.set(KEY(exercise), { model: ER.toJSON(model), pos, notation: nt, name: docName }); }
    function load(work) {
      model = work.model; pos = work.pos || {}; nt = work.notation || nt; docName = work.name || '';
      sel = null; multi = []; mode = null; fitted = false;
      setText();
      after({ text: false, fit: true });
    }
    function startModel(text, name) { return { model: ER.parse(text), pos: {}, notation: nt, name }; }
    function replaceModel(m, name, keepPos) {
      pushUndo();
      model = ER.normalize(m); if (!keepPos) pos = {}; if (name !== undefined) docName = name;
      sel = null; multi = [];
      after({ fit: true });
    }
    /** change the model through a function on a copy of it; one undo step */
    function commit(fn, opts) {
      opts = opts || {};
      if (!opts.noUndo) pushUndo();
      const m = ER.clone(model);
      const r = fn(m);
      if (r === false) { undo.pop(); return; }
      model = ER.normalize(m);
      after(opts);
    }
    function after(opts) {
      opts = opts || {};
      save();
      if (opts.text !== false) setText();
      draw(true);
      if (opts.fit) { fitted = canvas.fit(); }
      renderTools(); renderTabs(); renderProps(); renderChecks();
    }
    function doUndo() { if (!undo.length) return; redo.push(snapshot()); restore(undo.pop()); afterHistory(); }
    function doRedo() { if (!redo.length) return; undo.push(snapshot()); restore(redo.pop()); afterHistory(); }
    function afterHistory() { if (sel && !exists(sel)) sel = null; multi = multi.filter(exists); save(); setText(); draw(true); renderTools(); renderTabs(); renderProps(); renderChecks(); }
    function exists(x) {
      if (!x) return false;
      if (x.kind === 'entity') return !!ER.entity(model, x.name);
      if (x.kind === 'relationship') return !!ER.relationship(model, x.name);
      if (x.kind === 'aggregation') return !!ER.aggregation(model, x.name);
      if (x.kind === 'isa') return model.specializations.some((y) => same(y.name, x.name));
      if (x.kind === 'participant') { const r = ER.relationship(model, x.rel); return !!(r && r.participants[x.index]); }
      if (x.kind === 'attribute') { const o = ownerOf(model, x.owner); return !!(o && findAttr(o.attributes, x.path)); }
      return false;
    }

    // ---- the text pane ----------------------------------------------------------------------------------------------
    function setText() {
      if (textSource) return;
      const t = ER.toText(model);
      if (editor.getValue() !== t) editor.setValue(t);
      perr.hidden = true;
    }
    function applyText() {
      const src = editor.getValue();
      const p = ER.tryParse(src);
      editor.clearMarks('err');
      if (p.error) {
        const e = p.error;
        editor.mark(e.pos, e.pos + Math.max(1, e.length), 'err', e.message);
        perr.hidden = false;
        perr.textContent = '';
        perr.appendChild(h('button.er-perr-b', { type: 'button', title: 'Show the place in the text', onclick: () => { editor.focus(); editor.ta.setSelectionRange(e.pos, e.pos + Math.max(1, e.length)); editor.scrollToPos(e.pos); } }, UI.icon('warn'), h('span', 'Line ' + e.line + ', column ' + e.col + ': ' + e.reason)));
        textSource = false;
        return;
      }
      perr.hidden = true;
      if (JSON.stringify(ER.toJSON(p.model)) === JSON.stringify(ER.toJSON(model))) { textSource = false; return; }
      // typing makes one undo step per pause of a couple of seconds, not one per key
      const now = Date.now();
      if (now - lastTextPush > 2000) pushUndo();
      lastTextPush = now;
      carryPositions(model, p.model);
      model = p.model;
      if (sel && !exists(sel)) sel = null;
      multi = multi.filter(exists);
      after({ text: false });
      textSource = false;
    }
    // a name changed in the text: the renamed node keeps its place
    function carryPositions(a, b) {
      for (const [kind, pre] of [['entities', 'e:'], ['relationships', 'r:']]) {
        const gone = a[kind].filter((x) => !b[kind].some((y) => same(x.name, y.name)));
        const added = b[kind].filter((y) => !a[kind].some((x) => same(x.name, y.name)));
        if (gone.length === 1 && added.length === 1) for (const k in pos) { const p = pos[k] && pos[k][pre + gone[0].name]; if (p) pos[k][pre + added[0].name] = p; }
      }
    }

    // ---- drawing ------------------------------------------------------------------------------------------------------
    function draw(full) {
      if (full || !L) {
        L = ER.layout(model, nt, { positions: pos[nt], aspect: ER_ASPECT() });
        const p = {};
        for (const n of L.nodes) if (!n.owner) p[n.id] = { x: +(n.x + n.w / 2 + L.origin.x).toFixed(1), y: +(n.y + n.h / 2 + L.origin.y).toFixed(1) };
        pos[nt] = p;
        canvas.set(L, ER.svg(model, L, nt, { theme: theme(wrap), background: false }));
        // a view the user has not panned or zoomed keeps the whole diagram in sight
        if (!canvas.touched && !host.classList.contains('dragging')) canvas.fit();
      }
      drawOverlay();
      renderStatus();
    }
    const byId = () => new Map(L.nodes.map((n) => [n.id, n]));
    /** what a node of the layout stands for in the model */
    function nodeElement(n, line, ids) {
      ids = ids || byId();
      if (n.kind === 'entity') {
        if (line !== undefined) { const e = ER.entity(model, n.name); const p = e && attrPaths(e.attributes)[line]; if (p) return { kind: 'attribute', owner: { kind: 'entity', name: e.name }, path: p }; }
        return { kind: 'entity', name: n.name };
      }
      if (n.kind === 'relationship' || n.kind === 'associative' || n.kind === 'relattrs') {
        if (line !== undefined) { const r = ER.relationship(model, n.name); const p = r && attrPaths(r.attributes)[line]; if (p) return { kind: 'attribute', owner: { kind: 'relationship', name: r.name }, path: p }; }
        return { kind: 'relationship', name: n.name };
      }
      if (n.kind === 'isa') return { kind: 'isa', name: n.name };
      if (n.kind === 'attribute') {
        let cur = n; const path = [cur.name];
        while (cur.parentAttr && ids.get(cur.parentAttr)) { cur = ids.get(cur.parentAttr); path.unshift(cur.name); }
        const o = ids.get(cur.owner);
        if (!o) return null;
        return { kind: 'attribute', owner: { kind: o.kind === 'entity' ? 'entity' : 'relationship', name: o.name }, path };
      }
      return null;
    }
    function edgeElement(e, ids) {
      if (e.kind === 'participation') return { kind: 'participant', rel: e.relationship, index: e.participant };
      if (e.kind === 'relationship-line') return { kind: 'relationship', name: e.relationship };
      if (e.specialization) return { kind: 'isa', name: e.specialization };
      if (e.kind === 'relattrs') { const n = (ids || byId()).get(e.to); return n ? { kind: 'relationship', name: n.name } : null; }
      return null;
    }
    /** the node a drag on this node moves: the entity of an attribute oval, the diamond of a box of attributes */
    function mainOf(n, ids) { let cur = n; while (cur && cur.owner) cur = ids.get(cur.owner); return cur; }
    const isSel = (x) => !!x && [sel].concat(multi).some((y) => y && sameEl(x, y));
    function sameEl(a, b) {
      if (!a || !b || a.kind !== b.kind) return false;
      if (a.kind === 'participant') return same(a.rel, b.rel) && a.index === b.index;
      if (a.kind === 'attribute') return a.owner.kind === b.owner.kind && same(a.owner.name, b.owner.name) && pathEq(a.path, b.path);
      return same(a.name, b.name);
    }
    function drawOverlay() {
      const over = canvas.over;
      over.innerHTML = '';
      const ids = byId();
      const hl = [];
      const relSel = sel && (sel.kind === 'relationship' || sel.kind === 'participant') ? (sel.rel || sel.name) : null;
      for (const e of L.edges) {
        const x = edgeElement(e, ids);
        if (!x) continue;
        const pts = e.points.map((p) => p.x + ',' + p.y).join(' ');
        over.appendChild(s('polyline', { points: pts, class: 'er-hit er-hit-edge', 'data-edge': e.id }));
        if (isSel(x) || (relSel && x.kind === 'participant' && same(x.rel, relSel) && sel.kind === 'relationship')) hl.push(s('polyline', { points: pts, class: 'er-sel-edge' + (isSel(x) ? '' : ' soft') }));
      }
      for (const g of L.groups) {
        over.appendChild(s('rect', { x: g.x, y: g.y, width: g.w, height: g.h, rx: 8, class: 'er-hit er-hit-group', 'data-group': g.id }));
        over.appendChild(s('rect', { x: g.x + 4, y: g.y + 2, width: Math.max(60, g.label.length * 7 + 16), height: 20, class: 'er-hit', 'data-group': g.id }));
        if (isSel({ kind: 'aggregation', name: g.name })) hl.push(s('rect', { x: g.x - 3, y: g.y - 3, width: g.w + 6, height: g.h + 6, rx: 10, class: 'er-sel' }));
      }
      for (const n of L.nodes) {
        const x = nodeElement(n, undefined, ids);
        let shape;
        if (n.shape === 'diamond') shape = s('polygon', { points: [[n.x + n.w / 2, n.y], [n.x + n.w, n.y + n.h / 2], [n.x + n.w / 2, n.y + n.h], [n.x, n.y + n.h / 2]].map((p) => p.join(',')).join(' ') });
        else if (n.shape === 'ellipse') shape = s('ellipse', { cx: n.x + n.w / 2, cy: n.y + n.h / 2, rx: n.w / 2, ry: n.h / 2 });
        else if (n.shape === 'point') shape = s('circle', { cx: n.x + n.w / 2, cy: n.y + n.h / 2, r: 9 });
        else if (n.shape === 'triangle') shape = s('circle', { cx: n.x + n.w / 2, cy: n.y + n.h / 2, r: Math.min(n.w, n.h) / 2 + 4 });
        else shape = s('rect', { x: n.x, y: n.y, width: n.w, height: n.h, rx: 6 });
        shape.setAttribute('class', 'er-hit er-hit-node' + (mode && x && x.kind === 'entity' ? ' pick' : ''));
        shape.setAttribute('data-node', n.id);
        over.appendChild(shape);
        if (isSel(x) || (multi.length && x && multi.some((y) => sameEl(x, y)))) hl.push(s('rect', { x: n.x - 4, y: n.y - 4, width: n.w + 8, height: n.h + 8, rx: n.shape === 'rect' ? 9 : n.h / 2, class: 'er-sel' }));
        // the attribute lines inside a box can be picked one by one
        if (n.lines && (n.kind === 'entity' || n.kind === 'associative' || n.kind === 'relattrs')) {
          const top = n.kind === 'relattrs' ? n.y + 4 : n.y + n.header + (n.weak ? 2 : 0) + 3;
          n.lines.forEach((l, i) => {
            over.appendChild(s('rect', { x: n.x + 3, y: top + i * LINE, width: n.w - 6, height: LINE, class: 'er-hit er-hit-row', 'data-node': n.id, 'data-line': i }));
            if (isSel(nodeElement(n, i, ids))) hl.push(s('rect', { x: n.x + 3, y: top + i * LINE, width: n.w - 6, height: LINE, rx: 4, class: 'er-sel-row' }));
          });
        }
      }
      for (const x of hl) over.appendChild(x);
    }
    function renderStatus() {
      const v = ER.validate(model), c = ER.check(model);
      const err = v.filter((x) => x.severity === 'error').length, warn = v.length - err;
      statusEl.textContent = '';
      statusEl.appendChild(h('span', UI.plural(model.entities.length, 'entity set') + ' · ' + UI.plural(model.relationships.length, 'relationship set')));
      if (err) statusEl.appendChild(h('span.er-b.bad', UI.plural(err, 'error')));
      if (warn) statusEl.appendChild(h('span.er-b.warn', UI.plural(warn, 'warning')));
      if (c.length) statusEl.appendChild(h('span.er-b.acc', UI.plural(c.length, 'suggestion')));
      if (!err && !warn && !c.length && model.entities.length) statusEl.appendChild(h('span.er-b.ok', 'no problems'));
    }

    // ---- pointer interaction ------------------------------------------------------------------------------------------
    function hitOf(e) {
      const t = e.target.closest && e.target.closest('[data-node],[data-edge],[data-group]');
      if (!t || !L) return null;
      const ids = byId();
      if (t.dataset.node) { const n = ids.get(t.dataset.node); if (!n) return null; const line = t.dataset.line !== undefined ? +t.dataset.line : undefined; return { node: n, el: nodeElement(n, line, ids), main: mainOf(n, ids), line }; }
      if (t.dataset.edge) { const ed = L.edges.find((x) => x.id === t.dataset.edge); return ed ? { edge: ed, el: edgeElement(ed, ids) } : null; }
      const g = L.groups.find((x) => x.id === t.dataset.group);
      return g ? { group: g, el: { kind: 'aggregation', name: g.name } } : null;
    }
    function onDown(e) {
      host.focus({ preventScroll: true });
      const hit = hitOf(e);
      if (!hit || !hit.el) return null;
      if (!hit.node || !hit.main) return { move: panner(), up: (moved) => { if (!moved) clickEl(hit, e); } };
      const id = hit.main.id;
      const start = pos[nt] && pos[nt][id] ? Object.assign({}, pos[nt][id]) : null;
      let pushed = false;
      return {
        move(dx, dy) {
          if (!start) return;
          if (!pushed) { pushUndo(); pushed = true; host.classList.add('dragging'); canvas.touched = true; }
          pos[nt][id] = { x: start.x + dx, y: start.y + dy };
          relayout();
        },
        up(moved) { host.classList.remove('dragging'); if (!moved) clickEl(hit, e); else { save(); draw(true); } },
        cancel() { host.classList.remove('dragging'); if (pushed) { restore(undo.pop()); draw(true); } },
      };
    }
    function panner() { const tx = canvas.tx, ty = canvas.ty; return (dx, dy) => { canvas.touched = true; canvas.tx = tx + dx * canvas.z; canvas.ty = ty + dy * canvas.z; canvas.apply(); }; }
    function onBackground() {
      if (mode) { setMode(null); return; }
      if (sel || multi.length) { sel = null; multi = []; drawOverlay(); renderProps(); }
    }
    function onDbl(e) {
      const hit = hitOf(e);
      if (!hit) { if (!mode) addEntity(false, canvas.toWorld(e.clientX, e.clientY)); return; }
      if (hit.el) rename(hit.el);
    }
    function clickEl(hit, e) {
      const x = hit.el;
      if (mode) { pickInMode(x); return; }
      if (e.shiftKey && x.kind === 'entity') {
        const all = [sel].concat(multi).filter((y) => y && y.kind === 'entity');
        const i = all.findIndex((y) => sameEl(y, x));
        if (i >= 0) all.splice(i, 1); else all.push(x);
        sel = all[0] || null; multi = all.slice(1);
      } else { sel = x; multi = []; }
      drawOverlay(); renderProps();
    }
    function select(x, reveal) {
      sel = x; multi = [];
      drawOverlay(); renderProps();
      if (reveal && x) { const b = boxOf(x); if (b) canvas.reveal(b); flash(x); }
    }
    /** the world box of an element, for revealing and for the rename field */
    function boxOf(x) {
      if (!L) return null;
      const ids = byId(), o = L.origin;
      const wb = (n) => ({ x: n.x + o.x, y: n.y + o.y, w: n.w, h: n.h });
      for (const n of L.nodes) {
        const y = nodeElement(n, undefined, ids);
        if (y && sameEl(x, y)) return wb(n);
        if (x.kind === 'attribute' && n.lines) {
          const i = n.lines.findIndex((l, k) => sameEl(x, nodeElement(n, k, ids)));
          if (i >= 0) { const top = n.kind === 'relattrs' ? n.y + 4 : n.y + n.header + (n.weak ? 2 : 0) + 3; return { x: n.x + o.x, y: top + i * LINE + o.y, w: n.w, h: LINE, row: true }; }
        }
      }
      for (const g of L.groups) if (x.kind === 'aggregation' && same(g.name, x.name)) return { x: g.x + o.x, y: g.y + o.y, w: Math.max(80, g.label.length * 8 + 16), h: 22, row: true };
      for (const e of L.edges) {
        const y = edgeElement(e, ids);
        if (y && sameEl(x, y)) { const xs = e.points.map((p) => p.x), ys = e.points.map((p) => p.y); return { x: Math.min(...xs) + o.x, y: Math.min(...ys) + o.y, w: Math.max(...xs) - Math.min(...xs) + 1, h: Math.max(...ys) - Math.min(...ys) + 1 }; }
      }
      if (x.kind === 'participant') return boxOf({ kind: 'relationship', name: x.rel });
      return null;
    }
    function flash(x) {
      const b = boxOf(x);
      if (!b) return;
      const r = s('rect', { x: b.x - L.origin.x - 8, y: b.y - L.origin.y - 8, width: b.w + 16, height: b.h + 16, rx: 12, class: 'er-flash' });
      canvas.over.appendChild(r);
      setTimeout(() => r.remove(), 1300);
    }

    // ---- inline rename --------------------------------------------------------------------------------------------------
    function rename(x) {
      if (x.kind === 'participant') { select({ kind: 'relationship', name: x.rel }); return rename({ kind: 'relationship', name: x.rel }); }
      const b = boxOf(x);
      if (!b) return;
      const old = x.kind === 'attribute' ? x.path[x.path.length - 1] : x.name;
      const p = canvas.toHost(b.x, b.y);
      const w = Math.max(130, b.row ? b.w * canvas.z : Math.min(b.w * canvas.z, 260));
      const top = b.row ? p.y : p.y + Math.min(b.h * canvas.z, 40) / 2 - 15;
      const inp = h('input.er-rename', { value: old, 'aria-label': 'New name', spellcheck: 'false', style: { left: Math.max(4, p.x + (b.row ? 0 : (b.w * canvas.z - w) / 2)) + 'px', top: Math.max(4, top) + 'px', width: w + 'px' } });
      stage.appendChild(inp);
      inp.focus(); inp.select();
      let done = false;
      const end = (ok) => {
        if (done) return; done = true;
        const v = inp.value.trim();
        inp.remove();
        host.focus({ preventScroll: true });
        if (ok && v && v !== old) renameTo(x, v);
      };
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); end(true); } else if (e.key === 'Escape') { e.preventDefault(); end(false); } e.stopPropagation(); });
      inp.addEventListener('blur', () => end(true));
    }
    function renameTo(x, v) {
      if (x.kind === 'attribute') {
        commit((m) => {
          const o = ownerOf(m, x.owner); const f = o && findAttr(o.attributes, x.path);
          if (!f) return false;
          if (f.list.some((a) => a !== f.attr && same(a.name, v))) { UI.toast(o.name + ' already has an attribute named ' + v, 'err'); return false; }
          f.attr.name = v;
        });
        sel = Object.assign({}, x, { path: x.path.slice(0, -1).concat(v) });
        drawOverlay(); renderProps();
        return;
      }
      if (x.kind === 'isa') { commit((m) => { const y = m.specializations.find((z) => same(z.name, x.name)); if (!y) return false; if (m.specializations.some((z) => z !== y && same(z.name, v))) { UI.toast('Another specialization is named ' + v, 'err'); return false; } y.name = v; movePos('s:', x.name, v); }); sel = { kind: 'isa', name: v }; renderProps(); drawOverlay(); return; }
      if (!same(x.name, v) && takenName(model, v)) { UI.toast('The name ' + v + ' is already used: entity sets, relationship sets and aggregations share one name space.', 'err', 4000); return; }
      commit((m) => renameIn(m, x.kind, x.name, v));
      if (sel && sameEl(sel, x)) sel = { kind: x.kind, name: v };
      drawOverlay(); renderProps();
    }
    function movePos(pre, a, b) { for (const k in pos) if (pos[k] && pos[k][pre + a]) { pos[k][pre + b] = pos[k][pre + a]; delete pos[k][pre + a]; } }
    function renameIn(m, kind, a, b) {
      if (kind === 'entity') {
        const e = ER.entity(m, a); if (!e) return false;
        e.name = b;
        // the identifier made up for a new entity set follows its name
        const id = e.attributes.find((x) => x.key && same(x.name, a + '_id'));
        if (id && !e.attributes.some((x) => same(x.name, b + '_id'))) id.name = b + '_id';
        for (const r of m.relationships) for (const p of r.participants) if (same(p.entity, a)) p.entity = b;
        for (const sp of m.specializations) { if (same(sp.parent, a)) sp.parent = b; sp.children = sp.children.map((c) => (same(c, a) ? b : c)); }
        movePos('e:', a, b);
      } else if (kind === 'relationship') {
        const r = ER.relationship(m, a); if (!r) return false;
        r.name = b;
        for (const g of m.aggregations) if (same(g.relationship, a)) g.relationship = b;
        for (const e of m.entities) if (same(e.identifiedBy, a)) e.identifiedBy = b;
        movePos('r:', a, b);
      } else if (kind === 'aggregation') {
        const g = ER.aggregation(m, a); if (!g) return false;
        g.name = b;
        for (const r of m.relationships) for (const p of r.participants) if (same(p.entity, a)) p.entity = b;
      }
    }

    // ---- editing actions --------------------------------------------------------------------------------------------------
    /** a place near p (world coordinates) that no node covers */
    function freeSpot(p, w, hh) {
      const o = L ? L.origin : { x: 0, y: 0 };
      const boxes = L ? L.nodes.concat(L.groups).map((n) => ({ x: n.x + o.x, y: n.y + o.y, w: n.w, h: n.h })) : [];
      const ov = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      for (let r = 0; r < 3000; r += 24) {
        const steps = r ? Math.max(8, Math.round((2 * Math.PI * r) / 40)) : 1;
        for (let k = 0; k < steps; k++) {
          const a = (2 * Math.PI * k) / steps;
          const q = { x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r * 0.75 };
          const b = { x: q.x - w / 2 - 18, y: q.y - hh / 2 - 18, w: w + 36, h: hh + 36 };
          if (!boxes.some((x) => ov(x, b))) return q;
        }
      }
      return p;
    }
    const entSize = () => (nt === 'chen' ? [230, 170] : [150, 80]);
    const centreOf = (id) => (pos[nt] && pos[nt][id]) || null;
    function place(id, p, w, hh) { pos[nt] = pos[nt] || {}; pos[nt][id] = freeSpot(p, w, hh); }
    function addEntity(weak, at) {
      const owner = weak && sel && sel.kind === 'entity' && ER.entity(model, sel.name) ? sel.name : null;
      let name;
      commit((m) => {
        name = uniq(m, weak ? 'weak_entity' : 'entity');
        m.entities.push({ name, weak, attributes: [weak ? { name: 'number', partial: true } : { name: name + '_id', key: true }] });
        const [w, hh] = entSize();
        let p = at || canvas.centre();
        if (owner) {
          const r = uniq(m, name + '_' + owner);
          m.relationships.push({ name: r, identifying: true, participants: [{ entity: name, min: 1, max: 1, total: true }, { entity: owner, min: 0, max: '*' }], attributes: [] });
          m.entities[m.entities.length - 1].identifiedBy = r;
          const oc = centreOf('e:' + owner);
          if (oc) { p = { x: oc.x, y: oc.y + (nt === 'chen' ? 330 : 230) }; place('r:' + r, { x: oc.x, y: oc.y + (nt === 'chen' ? 165 : 115) }, 110, 56); }
        }
        place('e:' + name, p, w, hh);
      });
      select({ kind: 'entity', name });
      setTimeout(() => rename({ kind: 'entity', name }), 30);
      if (weak && !owner) UI.toast('A weak entity set needs an owner: connect it to one with an identifying relationship (or select the owner first next time).', null, 5000);
    }
    function addRelationship(a, b) {
      let name;
      commit((m) => {
        name = uniq(m, same(a, b) ? a + '_' + a : a + '_' + b);
        const ps = [{ entity: a, min: 0, max: '*' }, { entity: b, min: 0, max: '*' }];
        if (same(a, b)) { ps[0].role = 'first'; ps[1].role = 'second'; }
        m.relationships.push({ name, identifying: false, participants: ps, attributes: [] });
        const pa = centreOf('e:' + ER.entity(m, a).name), pb = centreOf('e:' + ER.entity(m, b).name);
        if (pa && pb) place('r:' + name, same(a, b) ? { x: pa.x + 200, y: pa.y } : { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 }, 110, 56);
      });
      setMode(null);
      select({ kind: 'relationship', name });
      setTimeout(() => rename({ kind: 'relationship', name }), 30);
    }
    function startRelationship() {
      const ents = [sel].concat(multi).filter((x) => x && x.kind === 'entity');
      if (ents.length >= 2) {
        if (ents.length > 2) { naryRelationship(ents.map((x) => x.name)); return; }
        addRelationship(ents[0].name, ents[1].name); return;
      }
      setMode({ kind: 'rel', picks: [] });
    }
    function naryRelationship(names) {
      let name;
      commit((m) => {
        name = uniq(m, 'relationship');
        m.relationships.push({ name, identifying: false, participants: names.map((n) => ({ entity: n, min: 0, max: '*' })), attributes: [] });
        const cs = names.map((n) => centreOf('e:' + n)).filter(Boolean);
        if (cs.length) place('r:' + name, { x: cs.reduce((t, c) => t + c.x, 0) / cs.length, y: cs.reduce((t, c) => t + c.y, 0) / cs.length }, 110, 56);
      });
      select({ kind: 'relationship', name });
    }
    function startConnect() {
      const first = sel && (sel.kind === 'relationship' || sel.kind === 'participant') ? { kind: 'relationship', name: sel.rel || sel.name } : sel && (sel.kind === 'entity' || sel.kind === 'aggregation') ? sel : null;
      setMode({ kind: 'connect', first });
    }
    function setMode(m) {
      mode = m;
      hint.hidden = !m;
      hint.textContent = '';
      if (m) {
        const txt = m.kind === 'rel' ? (m.picks.length ? 'Now click the second entity set (the same one again for a recursive relationship).' : 'Click the two entity sets to relate. Shift-click three or more, then press Relationship, for a non-binary one.')
          : m.first ? (m.first.kind === 'relationship' ? 'Click the entity set (or aggregation) that takes part in ' + m.first.name + '.' : 'Click the relationship set that ' + m.first.name + ' takes part in.')
            : 'Click a relationship set and an entity set to add the entity set as a participant.';
        hint.appendChild(h('span', txt));
        hint.appendChild(h('button.btn.small.ghost', { type: 'button', onclick: () => setMode(null) }, 'Cancel'));
      }
      host.classList.toggle('picking', !!m);
      renderTools();
      if (L) drawOverlay();
    }
    function pickInMode(x) {
      if (x.kind === 'attribute') x = { kind: x.owner.kind, name: x.owner.name };
      if (mode.kind === 'rel') {
        if (x.kind !== 'entity') { UI.toast('Pick an entity set.'); return; }
        mode.picks.push(x.name);
        if (mode.picks.length === 2) { addRelationship(mode.picks[0], mode.picks[1]); return; }
        sel = x; drawOverlay(); setMode(mode);
        return;
      }
      if (mode.kind === 'connect') {
        const asRel = x.kind === 'relationship' || x.kind === 'participant' ? { kind: 'relationship', name: x.rel || x.name } : null;
        const asEnt = x.kind === 'entity' || x.kind === 'aggregation' ? x : null;
        if (!mode.first) { mode.first = asRel || asEnt; if (!mode.first) return; sel = mode.first; drawOverlay(); setMode(mode); return; }
        const rel = mode.first.kind === 'relationship' ? mode.first.name : asRel && asRel.name;
        const ent = mode.first.kind === 'relationship' ? asEnt : mode.first;
        if (!rel || !ent) { UI.toast(mode.first.kind === 'relationship' ? 'Pick an entity set or an aggregation.' : 'Pick a relationship set.'); return; }
        const ag = ER.aggregation(model, ent.name);
        if (ag && same(ag.relationship, rel)) { UI.toast('A relationship set cannot take part in its own aggregation.', 'err'); return; }
        commit((m) => {
          const r = ER.relationship(m, rel);
          const p = { entity: ent.name, min: 0, max: '*' };
          if (r.participants.some((q) => same(q.entity, ent.name))) { p.role = 'role_' + (r.participants.length + 1); r.participants.forEach((q, i) => { if (same(q.entity, ent.name) && !q.role) q.role = 'role_' + (i + 1); }); }
          r.participants.push(p);
        });
        setMode(null);
        select({ kind: 'participant', rel, index: ER.relationship(model, rel).participants.length - 1 });
      }
    }
    function addAttribute(kind) {
      let owner = null, parentPath = null;
      if (sel && (sel.kind === 'entity' || sel.kind === 'relationship')) owner = { kind: sel.kind, name: sel.name };
      else if (sel && sel.kind === 'participant') owner = { kind: 'relationship', name: sel.rel };
      else if (sel && sel.kind === 'attribute') {
        owner = sel.owner;
        const o = ownerOf(model, owner), f = o && findAttr(o.attributes, sel.path);
        if (f && f.attr.components) parentPath = sel.path;
        else if (sel.path.length > 1) parentPath = sel.path.slice(0, -1);
      }
      if (!owner) { UI.toast('Select an entity set or a relationship set first, then add the attribute.'); return; }
      const isRel = owner.kind === 'relationship';
      if (isRel && (kind === 'key' || kind === 'partial')) { UI.toast('A relationship set is identified by its participants: its attributes cannot be keys.', 'err', 4000); return; }
      let path;
      commit((m) => {
        const o = ownerOf(m, owner);
        if (!o) return false;
        const list = parentPath ? findAttr(o.attributes, parentPath).attr.components : o.attributes;
        const base = { simple: 'attribute', key: 'id', partial: 'number', multivalued: 'values', derived: 'computed', composite: 'composite' }[kind] || 'attribute';
        let n = base, k = 2;
        while (list.some((a) => same(a.name, n))) n = base + '_' + k++;
        const a = { name: n };
        if (kind === 'key') { if (o.weak) a.partial = true; else a.key = true; }
        if (kind === 'partial') a.partial = true;
        if (kind === 'multivalued') a.multivalued = true;
        if (kind === 'derived') a.derived = true;
        if (kind === 'composite') a.components = [{ name: 'part_1' }, { name: 'part_2' }];
        list.push(a);
        path = (parentPath || []).concat(n);
      });
      if (path) { const x = { kind: 'attribute', owner, path }; select(x); setTimeout(() => rename(x), 30); }
    }
    function addIsa() {
      const ents = [sel].concat(multi).filter((x) => x && x.kind === 'entity');
      if (!ents.length) { UI.toast('Select the higher-level entity set first (shift-click lower-level ones to use existing entity sets).'); return; }
      const parent = ents[0].name, kids = ents.slice(1).map((x) => x.name);
      let isaName;
      commit((m) => {
        if (!kids.length) {
          const c = uniq(m, 'subtype');
          m.entities.push({ name: c, weak: false, attributes: [{ name: 'detail' }] });
          kids.push(c);
          const pc = centreOf('e:' + ER.entity(m, parent).name);
          const n = m.specializations.filter((x) => same(x.parent, parent)).reduce((t, x) => t + x.children.length, 0);
          if (pc) place('e:' + c, { x: pc.x + (n % 2 ? 1 : -1) * Math.ceil(n / 2) * 200, y: pc.y + (nt === 'chen' ? 300 : 210) }, ...entSize());
        }
        const ex = ents.length === 1 && m.specializations.find((x) => same(x.parent, parent));
        if (ex) { ex.children.push(...kids); isaName = ex.name; return; }
        let n = 'isa_' + parent, k = 2;
        while (m.specializations.some((x) => same(x.name, n))) n = 'isa_' + parent + '_' + k++;
        m.specializations.push({ name: n, parent, children: kids, disjoint: true, total: false });
        isaName = n;
      });
      select({ kind: 'isa', name: isaName });
    }
    function addAggregation() {
      const rel = sel && (sel.kind === 'relationship' || sel.kind === 'participant') ? sel.rel || sel.name : null;
      if (!rel) { UI.toast('Select the relationship set to aggregate first.'); return; }
      if (model.aggregations.some((a) => same(a.relationship, rel))) { UI.toast(rel + ' is already aggregated.'); return; }
      let name;
      commit((m) => { name = uniq(m, rel + '_agg'); m.aggregations.push({ name, relationship: ER.relationship(m, rel).name }); });
      select({ kind: 'aggregation', name });
      UI.toast('Now connect a relationship set to ' + name + ' to relate it as a whole.', null, 4000);
    }
    function removeSel() {
      const x = sel;
      if (!x) return;
      const xs = [x].concat(multi);
      commit((m) => { for (const y of xs) removeIn(m, y); });
      sel = null; multi = [];
      drawOverlay(); renderProps();
    }
    function removeIn(m, x) {
      if (x.kind === 'entity') {
        m.entities = m.entities.filter((e) => !same(e.name, x.name));
        for (const r of m.relationships) r.participants = r.participants.filter((p) => !same(p.entity, x.name));
        m.specializations = m.specializations.filter((sp) => !same(sp.parent, x.name));
        for (const sp of m.specializations) sp.children = sp.children.filter((c) => !same(c, x.name));
        m.specializations = m.specializations.filter((sp) => sp.children.length);
      } else if (x.kind === 'relationship') {
        const ags = m.aggregations.filter((a) => same(a.relationship, x.name));
        m.relationships = m.relationships.filter((r) => !same(r.name, x.name));
        for (const a of ags) removeIn(m, { kind: 'aggregation', name: a.name });
        for (const e of m.entities) if (same(e.identifiedBy, x.name)) delete e.identifiedBy;
      } else if (x.kind === 'aggregation') {
        m.aggregations = m.aggregations.filter((a) => !same(a.name, x.name));
        for (const r of m.relationships) r.participants = r.participants.filter((p) => !same(p.entity, x.name));
      } else if (x.kind === 'isa') m.specializations = m.specializations.filter((sp) => !same(sp.name, x.name));
      else if (x.kind === 'participant') { const r = ER.relationship(m, x.rel); if (r) r.participants.splice(x.index, 1); }
      else if (x.kind === 'attribute') { const o = ownerOf(m, x.owner); const f = o && findAttr(o.attributes, x.path); if (f) f.list.splice(f.index, 1); }
    }
    function autoLayout() { pushUndo(); delete pos[nt]; draw(true); fitted = canvas.fit(); save(); renderTools(); }
    function setNotation(n) { if (n === nt) return; nt = n; save(); draw(true); fitted = canvas.fit(); renderTools(); renderProps(); }

    // ---- toolbar ------------------------------------------------------------------------------------------------------------
    function renderTools() {
      tools.innerHTML = '';
      const attrMenu = (e) => UI.menu(e.currentTarget, [
        { head: 'Add to the selected entity or relationship set' },
        { label: 'Simple attribute', onclick: () => addAttribute('simple') },
        { label: 'Key attribute (underlined)', onclick: () => addAttribute('key') },
        { label: 'Discriminator (partial key of a weak entity set)', onclick: () => addAttribute('partial') },
        { label: 'Composite attribute', onclick: () => addAttribute('composite') },
        { label: 'Multivalued attribute { }', onclick: () => addAttribute('multivalued') },
        { label: 'Derived attribute ( )', onclick: () => addAttribute('derived') },
      ]);
      const on = (k) => (mode && mode.kind === k ? '.on' : '');
      tools.appendChild(h('div.er-group',
        UI.btn('erEntity', 'Entity', 'Add an entity set (or double-click the empty canvas)', () => addEntity(false)),
        UI.btn('erWeak', null, 'Add a weak entity set (owned by the selected entity set)', () => addEntity(true), 'icon'),
        h('button.btn' + on('rel'), { type: 'button', title: 'Add a relationship set: click two entity sets', onclick: () => (mode && mode.kind === 'rel' ? setMode(null) : startRelationship()) }, UI.icon('erRel'), h('span.bl', 'Relationship')),
        h('button.btn.icon', { type: 'button', title: 'Add an attribute', 'aria-label': 'Add an attribute', onclick: attrMenu }, UI.icon('erAttr')),
        UI.btn('erIsa', null, 'Specialize the selected entity set (ISA)', addIsa, 'icon'),
        UI.btn('erAgg', null, 'Aggregate the selected relationship set', addAggregation, 'icon'),
        h('button.btn.icon' + on('connect'), { type: 'button', title: 'Connect a participant to a relationship set', 'aria-label': 'Connect', onclick: () => (mode && mode.kind === 'connect' ? setMode(null) : startConnect()) }, UI.icon('erLink'))));
      const ub = UI.btn('undo', null, 'Undo (Ctrl+Z)', doUndo, 'icon'); ub.disabled = !undo.length;
      const rb = UI.btn('redo', null, 'Redo (Ctrl+Shift+Z)', doRedo, 'icon'); rb.disabled = !redo.length;
      const db = UI.btn('trash', null, 'Delete the selection (Delete)', removeSel, 'icon'); db.disabled = !sel;
      const sb = UI.btn('split', null, 'Show or hide the side panel', () => { const off = !wrap.classList.contains('noside'); wrap.classList.toggle('noside', off); UI.store.set('er.noside', off); renderTools(); }, 'icon');
      if (!wrap.classList.contains('noside')) sb.classList.add('on');
      tools.appendChild(h('div.er-group', ub, rb, db, UI.btn('layout', null, 'Lay the diagram out again', autoLayout, 'icon'), sb));
      tools.appendChild(h('div.seg.er-nt', { role: 'group', 'aria-label': 'Notation' }, NOTATIONS.map(([k, l]) => h('button' + (nt === k ? '.on' : ''), { type: 'button', 'aria-pressed': String(nt === k), onclick: () => setNotation(k) }, l))));
      tools.appendChild(h('div.grow'));
      tools.appendChild(h('div.er-group',
        UI.btn('table', 'To SQL', 'Reduce the design to tables, rule by rule', toSql),
        UI.btn('db', 'From the database', 'Read a design back from the tables of the database', fromDb),
        h('button.btn.icon', { type: 'button', title: 'New, open, save, export', 'aria-label': 'File', onclick: fileMenu }, UI.icon('more'))));
    }
    function fileMenu(e) {
      UI.menu(e.currentTarget, [
        { head: 'Start' },
        { label: 'New empty diagram', icon: 'plus', onclick: () => replaceModel({ entities: [] }, '') },
        ...Object.entries(SAMPLES).map(([k, v]) => ({ label: v.title, icon: 'er', onclick: () => replaceModel(ER.parse(v.text), v.name) })),
        { sep: true },
        { label: 'Save in this browser…', icon: 'download', onclick: saveAs },
        { label: 'Open a saved diagram…', icon: 'upload', onclick: openSaved },
        { sep: true },
        { label: 'Download as SVG', icon: 'download', onclick: () => UI.download(fileBase() + '.svg', exportSvg(), 'image/svg+xml') },
        { label: 'Download as PNG', icon: 'download', onclick: exportPng },
        { label: 'Download the text (.er)', icon: 'download', onclick: () => UI.download(fileBase() + '.er', ER.toText(model), 'text/plain') },
        { label: 'Open a text file…', icon: 'upload', onclick: importText },
        { label: 'Copy the text', icon: 'copy', onclick: () => UI.copy(ER.toText(model)) },
      ], { right: true });
    }
    const fileBase = () => (docName || 'er-diagram').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'er-diagram';
    function exportSvg() { return ER.svg(model, L, nt, { title: docName || undefined }); }
    function exportPng() {
      const svgText = exportSvg();
      const m = /width="(\d+)" height="(\d+)"/.exec(svgText);
      const img = new Image();
      img.onload = () => {
        const sc = 2, c = document.createElement('canvas');
        c.width = (+m[1]) * sc; c.height = (+m[2]) * sc;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
        ctx.scale(sc, sc); ctx.drawImage(img, 0, 0);
        c.toBlob((b) => { const a = h('a', { href: URL.createObjectURL(b), download: fileBase() + '.png' }); document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); }, 'image/png');
      };
      img.onerror = () => UI.toast('The PNG could not be made in this browser; download the SVG instead.', 'err');
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
    }
    function importText() {
      const inp = h('input', { type: 'file', accept: '.er,.txt,text/plain', style: { display: 'none' } });
      inp.addEventListener('change', () => {
        const f = inp.files[0];
        if (!f) return;
        f.text().then((t) => { const p = ER.tryParse(t); if (p.error) { UI.toast('That file does not read as an E-R design: ' + p.error.message, 'err', 6000); return; } replaceModel(p.model, f.name.replace(/\.[^.]*$/, '')); });
        inp.remove();
      });
      document.body.appendChild(inp);
      inp.click();
    }
    function saveAs() {
      UI.prompt('Save the diagram', 'Name', docName || 'My design', (v) => {
        v = v.trim(); if (!v) return;
        const list = UI.store.get('er.saved', []).filter((x) => x.name !== v);
        list.unshift({ name: v, at: Date.now(), model: ER.toJSON(model), pos, notation: nt });
        UI.store.set('er.saved', list.slice(0, 50));
        docName = v; save();
        UI.toast('Saved as ' + v);
      });
    }
    function openSaved() {
      const body = h('div.er-saved');
      const d = UI.dialog('Open a saved diagram', body, { buttons: [{ label: 'Close' }] });
      const fill = () => {
        body.innerHTML = '';
        const cur = UI.store.get('er.saved', []);
        if (!cur.length) { body.appendChild(h('p.muted', 'Nothing saved yet. Use Save in this browser in the menu.')); return; }
        for (const x of cur) {
          let n = 0; try { n = ER.fromJSON(x.model).entities.length; } catch (e) { /* skip */ }
          body.appendChild(h('div.er-saved-row',
            h('button.er-saved-open', { type: 'button', onclick: () => { try { pushUndo(); load({ model: ER.fromJSON(x.model), pos: x.pos || {}, notation: x.notation, name: x.name }); d.close(); } catch (e) { UI.toast('That diagram cannot be read: ' + e.message, 'err'); } } }, h('b', x.name), h('span.muted', UI.plural(n, 'entity set') + ' · ' + new Date(x.at).toLocaleString())),
            UI.btn('trash', null, 'Delete ' + x.name, () => { UI.store.set('er.saved', UI.store.get('er.saved', []).filter((y) => y.name !== x.name)); fill(); }, 'icon')));
        }
      };
      fill();
    }

    // ---- the side tabs --------------------------------------------------------------------------------------------------------
    function showTab(t) { tab = t; UI.store.set('er.tab', t); renderTabs(); if (t === 'text') setTimeout(() => editor.render(), 0); }
    function renderTabs() {
      const v = ER.validate(model);
      const n = v.length + ER.check(model).length, bad = v.some((x) => x.severity === 'error');
      tabsEl.innerHTML = '';
      for (const [k, l] of [['props', 'Properties'], ['text', 'Text'], ['checks', 'Checks']]) {
        tabsEl.appendChild(h('button' + (tab === k ? '.on' : ''), { type: 'button', onclick: () => showTab(k) }, l, k === 'checks' && n ? h('span.er-count' + (bad ? '.bad' : ''), String(n)) : null));
      }
      propsEl.hidden = tab !== 'props'; textEl.hidden = tab !== 'text'; checksEl.hidden = tab !== 'checks';
    }

    // ---- properties of the selection -------------------------------------------------------------------------------------------
    const field = (label, ctl, cls) => h('label.er-f' + (cls ? '.' + cls : ''), h('span', label), ctl);
    function inputFor(key, value, onchange, opts) {
      opts = opts || {};
      return h('input.inp' + (opts.cls ? '.' + opts.cls : ''), { type: opts.type || 'text', value: value == null ? '' : String(value), placeholder: opts.placeholder || '', 'aria-label': opts.label || key, 'data-f': key, spellcheck: 'false', min: opts.min,
        onchange: (e) => onchange(e.target.value), onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); } });
    }
    const seg = (items, cur, f) => h('div.seg.er-seg', items.map(([k, l, t]) => h('button' + (cur === k ? '.on' : ''), { type: 'button', title: t || '', onclick: () => f(k) }, l)));
    function renderProps() {
      const focus = document.activeElement && propsEl.contains(document.activeElement) ? document.activeElement.dataset.f : null;
      propsEl.innerHTML = '';
      const x = sel && exists(sel) ? sel : null;
      if (!x) propsEl.appendChild(nothingSelected());
      else if (x.kind === 'entity') propsEl.appendChild(entityProps(ER.entity(model, x.name)));
      else if (x.kind === 'relationship' || x.kind === 'participant') propsEl.appendChild(relProps(ER.relationship(model, x.rel || x.name), x.kind === 'participant' ? x.index : -1));
      else if (x.kind === 'attribute') {
        const o = ownerOf(model, x.owner);
        propsEl.appendChild(x.owner.kind === 'entity' ? entityProps(o) : relProps(o, -1));
      } else if (x.kind === 'isa') propsEl.appendChild(isaProps(model.specializations.find((y) => same(y.name, x.name))));
      else if (x.kind === 'aggregation') propsEl.appendChild(aggProps(ER.aggregation(model, x.name)));
      if (focus) { const f = propsEl.querySelector('[data-f="' + CSS.escape(focus) + '"]'); if (f) f.focus(); }
      const on = propsEl.querySelector('.er-arow.on input');
      if (on && !focus) on.scrollIntoView({ block: 'nearest' });
    }
    function nothingSelected() {
      const box = h('div.er-none');
      box.appendChild(h('div.er-ph', (docName ? docName + ': ' : '') + UI.plural(model.entities.length, 'entity set') + ', ' + UI.plural(model.relationships.length, 'relationship set') + (model.specializations.length ? ', ' + UI.plural(model.specializations.length, 'specialization') : '') + (model.aggregations.length ? ', ' + UI.plural(model.aggregations.length, 'aggregation') : '')));
      box.appendChild(h('ul.er-help',
        h('li', h('b', 'Click'), ' an element to see and change its properties; ', h('b', 'drag'), ' to move it; ', h('b', 'double-click'), ' to rename it, or the empty canvas to add an entity set.'),
        h('li', h('b', 'Relationship'), ': click two entity sets. ', h('b', 'Shift-click'), ' selects several entity sets (for a non-binary relationship, or the lower-level sets of a specialization).'),
        h('li', 'Drag the empty canvas to pan; ', h('kbd', 'Ctrl'), ' + wheel or a pinch zooms. ', h('kbd', 'Delete'), ' removes, ', h('kbd', 'Ctrl'), '+', h('kbd', 'Z'), ' undoes, ', h('kbd', 'F2'), ' renames.')));
      // one row per symbol, the caption beside it wrapping to the width of the panel
      const leg = h('div.er-legend', ER.legendRows(nt, { theme: theme(wrap) }).map((r) => { const sym = h('span.er-leg-sym'); sym.innerHTML = r.svg; return h('div.er-leg-row', sym, h('span.er-leg-cap', r.caption)); }));
      box.appendChild(h('details.er-legend-box', { open: UI.store.get('er.legend', true) ? true : null, ontoggle: (e) => UI.store.set('er.legend', e.target.open) }, h('summary', 'Symbols of this notation'), leg));
      return box;
    }
    function head(kind, name, icon) {
      return h('div.er-ph', UI.icon(icon), h('span.er-pk', kind), h('b', name), h('div.grow'), UI.btn('trash', null, 'Delete', removeSel, 'icon'));
    }
    function nameField(kind, name) {
      return field('Name', inputFor('name', name, (v) => { v = v.trim(); if (v && v !== name) renameTo({ kind, name }, v); }));
    }
    function entityProps(e) {
      const box = h('div');
      box.appendChild(head(e.weak ? 'Weak entity set' : 'Entity set', e.name, e.weak ? 'erWeak' : 'erEntity'));
      box.appendChild(nameField('entity', e.name));
      const isChild = ER.parents(model, e.name).length > 0;
      box.appendChild(field('Kind', seg([['strong', 'Strong', 'Identified by its own key'], ['weak', 'Weak', 'Identified through an owner and a discriminator']], e.weak ? 'weak' : 'strong', (k) => commit((m) => {
        const x = ER.entity(m, e.name);
        x.weak = k === 'weak';
        // the key becomes the discriminator and back
        const flip = (list) => { for (const a of list) { if (x.weak && a.key) { delete a.key; a.partial = true; } else if (!x.weak && a.partial) { delete a.partial; a.key = true; } if (a.components) flip(a.components); } };
        flip(x.attributes);
      }))));
      if (e.weak) {
        const owner = ER.owner(model, e);
        const strong = model.entities.filter((y) => !same(y.name, e.name));
        box.appendChild(field('Owner', h('select.inp', { 'aria-label': 'Owner', onchange: (ev) => setOwner(e.name, ev.target.value) }, h('option', { value: '' }, '(none yet)'), strong.map((y) => h('option', { value: y.name, selected: owner && same(owner, y.name) }, y.name)))));
        if (e.identifiedBy) box.appendChild(h('div.er-note', 'Identified through ', relLink(e.identifiedBy), ': its key is the key of ', h('b', owner || '?'), ' plus its discriminator.'));
      }
      if (isChild) box.appendChild(h('div.er-note', 'A lower-level entity set of ', ER.parents(model, e.name).map((p, i) => [i ? ', ' : '', link('entity', p)]), ': it inherits the key and attributes (', ER.inherited(model, e.name).map((i) => i.attr.name).join(', ') || 'none', ').'));
      box.appendChild(attrsEditor({ kind: 'entity', name: e.name }, e.attributes, e.weak));
      const rels = model.relationships.filter((r) => r.participants.some((p) => same(p.entity, e.name)));
      if (rels.length) box.appendChild(h('div.er-sub', h('div.er-st', 'Takes part in'), h('div.er-links', rels.map((r) => relLink(r.name)))));
      const isas = model.specializations.filter((sp) => same(sp.parent, e.name));
      box.appendChild(h('div.er-sub', h('div.er-st', 'Specialization'), isas.length ? h('div.er-links', isas.map((sp) => h('button.er-link', { type: 'button', onclick: () => select({ kind: 'isa', name: sp.name }, true) }, sp.name + ': ' + sp.children.join(', ')))) : null, h('button.btn.small', { type: 'button', onclick: addIsa, title: 'Add a lower-level entity set below this one' }, UI.icon('erIsa'), 'Add a lower-level entity set')));
      return box;
    }
    function setOwner(weak, owner) {
      commit((m) => {
        const e = ER.entity(m, weak);
        const old = e.identifiedBy && ER.relationship(m, e.identifiedBy);
        if (!owner) { if (old) old.identifying = false; delete e.identifiedBy; return; }
        if (old && old.participants.length === 2) { const o = old.participants.find((p) => !same(p.entity, weak)); if (o) o.entity = owner; return; }
        const r = uniq(m, weak + '_' + owner);
        m.relationships.push({ name: r, identifying: true, participants: [{ entity: weak, min: 1, max: 1, total: true }, { entity: owner, min: 0, max: '*' }], attributes: [] });
        e.identifiedBy = r;
      });
    }
    const link = (kind, name) => h('button.er-link', { type: 'button', onclick: () => select({ kind, name }, true) }, name);
    const relLink = (name) => link('relationship', name);
    function attrsEditor(owner, attrs, weak) {
      const isRel = owner.kind === 'relationship';
      const box = h('div.er-sub');
      const add = h('button.btn.small', { type: 'button', onclick: (e) => UI.menu(e.currentTarget, [
        { label: 'Simple', onclick: () => { select({ kind: owner.kind, name: owner.name }); addAttribute('simple'); } },
        !isRel ? { label: weak ? 'Discriminator' : 'Key', onclick: () => { select({ kind: owner.kind, name: owner.name }); addAttribute('key'); } } : null,
        { label: 'Composite', onclick: () => { select({ kind: owner.kind, name: owner.name }); addAttribute('composite'); } },
        { label: 'Multivalued', onclick: () => { select({ kind: owner.kind, name: owner.name }); addAttribute('multivalued'); } },
        { label: 'Derived', onclick: () => { select({ kind: owner.kind, name: owner.name }); addAttribute('derived'); } },
      ].filter(Boolean)) }, UI.icon('plus'), 'Add');
      box.appendChild(h('div.er-st', isRel ? 'Descriptive attributes' : 'Attributes', h('div.grow'), add));
      const rows = h('div.er-attrs');
      const walk = (list, path, depth) => list.forEach((a) => {
        const p = path.concat(a.name);
        const me = { kind: 'attribute', owner, path: p };
        const k = p.join('.');
        const upd = (fn) => commit((m) => { const o = ownerOf(m, owner); const f = o && findAttr(o.attributes, p); if (!f) return false; return fn(f.attr, f); });
        const tg = (flag, label, title, ok) => (ok ? h('button.er-tg' + (a[flag] ? '.on' : ''), { type: 'button', title, 'aria-pressed': String(!!a[flag]), onclick: () => { sel = me; upd((x) => { if (x[flag]) delete x[flag]; else { x[flag] = true; if (flag === 'key') delete x.partial; if (flag === 'partial') delete x.key; } }); } }, label) : null);
        rows.appendChild(h('div.er-arow' + (isSel(me) ? '.on' : ''), { style: { paddingLeft: 4 + depth * 16 + 'px' }, onclick: (e) => { if (e.target.tagName === 'DIV') { sel = me; drawOverlay(); renderProps(); } } },
          inputFor('a:' + k, a.name, (v) => { v = v.trim(); if (v && v !== a.name) renameTo(me, v); }, { cls: 'er-an', label: 'Attribute name' }),
          a.components ? h('span.er-comp', 'composite') : inputFor('t:' + k, a.type || '', (v) => upd((x) => { v = v.trim(); if (v) x.type = v; else delete x.type; }), { cls: 'er-at', placeholder: 'type', label: 'Type of ' + a.name }),
          tg('key', 'key', 'Key: the attribute identifies an entity (underlined)', !isRel && !weak && depth === 0),
          tg('partial', 'disc', 'Discriminator: identifies an entity within its owner (dashed underline)', !isRel && weak && depth === 0),
          tg('multivalued', '{ }', 'Multivalued: an entity can have several values', true),
          tg('derived', '( )', 'Derived: computed from other attributes, not stored', true),
          h('button.er-tg', { type: 'button', title: 'Add a component (makes it composite)', onclick: () => upd((x) => { x.components = x.components || []; let n = 'part_1', i = 2; while (x.components.some((c) => same(c.name, n))) n = 'part_' + i++; x.components.push({ name: n }); delete x.type; }) }, '+'),
          h('button.er-tg.x', { type: 'button', title: 'Remove ' + a.name, onclick: () => { commit((m) => removeIn(m, me)); if (sel && sameEl(sel, me)) sel = { kind: owner.kind, name: owner.name }; renderProps(); drawOverlay(); } }, '×')));
        if (a.components) walk(a.components, p, depth + 1);
      });
      walk(attrs, [], 0);
      if (!attrs.length) rows.appendChild(h('div.er-note', isRel ? 'None. A relationship set can have descriptive attributes, such as the role of an artist in casting.' : 'No attributes yet.'));
      box.appendChild(rows);
      return box;
    }
    function relProps(r, focusIdx) {
      const box = h('div');
      box.appendChild(head(r.identifying ? 'Identifying relationship set' : 'Relationship set', r.name, 'erRel'));
      box.appendChild(nameField('relationship', r.name));
      const ck = h('input', { type: 'checkbox', checked: r.identifying, onchange: (e) => commit((m) => { ER.relationship(m, r.name).identifying = e.target.checked; }) });
      box.appendChild(h('label.er-check', ck, ' Identifying (it identifies a weak entity set)'));
      const mp = ER.mapping(r);
      if (mp) {
        const [a, b] = r.participants;
        const an = a.role || a.entity, bn = b.role || b.entity;
        const many = (p) => (p.max === 1 ? 'at most one' : p.max === '*' ? 'any number of' : 'up to ' + p.max);
        box.appendChild(field('Mapping', seg([['1:1', '1 : 1'], ['1:N', '1 : N'], ['N:1', 'N : 1'], ['M:N', 'M : N']], mp, (k) => commit((m) => {
          const ps = ER.relationship(m, r.name).participants;
          ps[1].max = k[0] === '1' ? 1 : '*'; ps[0].max = k[2] === '1' ? 1 : '*';
          for (const p of ps) if (p.max !== '*' && p.min > p.max) p.min = p.max;
        }))));
        box.appendChild(h('div.er-note', 'Read ' + an + ' : ' + bn + '. Each ' + an + ' goes with ' + many(a) + ' ' + bn + (a.max === 1 ? '' : ' entities') + ', each ' + bn + ' with ' + many(b) + ' ' + an + (b.max === 1 ? '' : ' entities') + '.'));
      }
      const parts = h('div.er-sub', h('div.er-st', 'Participants', h('div.grow'), h('span.muted.er-small', 'min..max: how many ' + r.name + ' relationships each entity takes part in')));
      const opts = model.entities.map((e) => e.name).concat(model.aggregations.filter((a) => !same(a.relationship, r.name)).map((a) => a.name));
      r.participants.forEach((p, i) => {
        const upd = (fn) => commit((m) => fn(ER.relationship(m, r.name).participants[i]));
        const me = { kind: 'participant', rel: r.name, index: i };
        parts.appendChild(h('div.er-prow' + (i === focusIdx ? '.on' : ''), { onclick: (e) => { if (e.target === e.currentTarget) { sel = me; drawOverlay(); renderProps(); } } },
          h('select.inp.er-pe', { 'aria-label': 'Entity set', 'data-f': 'pe' + i, onchange: (e) => upd((x) => { x.entity = e.target.value; }) }, opts.concat(opts.some((o) => same(o, p.entity)) ? [] : [p.entity]).map((o) => h('option', { value: o, selected: same(o, p.entity) }, o))),
          inputFor('pr' + i, p.role || '', (v) => upd((x) => { v = v.trim(); if (v) x.role = v; else delete x.role; }), { cls: 'er-pr', placeholder: 'role', label: 'Role' }),
          h('span.er-card', inputFor('pmin' + i, ER.isTotal(p) ? Math.max(1, p.min) : p.min, (v) => upd((x) => { const n = Math.max(0, parseInt(v, 10) || 0); x.min = n; x.total = n >= 1; }), { cls: 'er-num', type: 'number', min: '0', label: 'Minimum' }), '..',
            inputFor('pmax' + i, p.max, (v) => upd((x) => { v = v.trim(); x.max = /^[*nm]$/i.test(v) || !v ? '*' : Math.max(1, parseInt(v, 10) || 1); }), { cls: 'er-num', label: 'Maximum (a number or *)' })),
          h('label.er-check.small', { title: 'Total participation: every entity takes part (a double line)' }, h('input', { type: 'checkbox', checked: ER.isTotal(p), 'data-f': 'pt' + i, onchange: (e) => upd((x) => { x.total = e.target.checked; x.min = e.target.checked ? Math.max(1, x.min) : 0; }) }), 'total'),
          r.participants.length > 2 ? h('label.er-check.small', { title: 'An arrow: each combination of the others goes with at most one of this entity set' }, h('input', { type: 'checkbox', checked: !!p.arrow, onchange: (e) => upd((x) => { if (e.target.checked) x.arrow = true; else delete x.arrow; }) }), 'arrow') : null,
          h('button.er-tg.x', { type: 'button', title: 'Remove this participant', onclick: () => { commit((m) => removeIn(m, me)); sel = { kind: 'relationship', name: r.name }; renderProps(); drawOverlay(); } }, '×')));
      });
      parts.appendChild(h('select.inp.er-add', { 'aria-label': 'Add a participant', onchange: (e) => { const v = e.target.value; if (v) commit((m) => { const x = ER.relationship(m, r.name); const p = { entity: v, min: 0, max: '*' }; if (x.participants.some((q) => same(q.entity, v))) p.role = 'role_' + (x.participants.length + 1); x.participants.push(p); }); } }, h('option', { value: '' }, 'Add a participant…'), opts.map((o) => h('option', { value: o }, o))));
      box.appendChild(parts);
      box.appendChild(attrsEditor({ kind: 'relationship', name: r.name }, r.attributes, false));
      const ag = model.aggregations.find((a) => same(a.relationship, r.name));
      box.appendChild(h('div.er-sub', h('div.er-st', 'Aggregation'), ag ? h('div.er-note', 'Aggregated as ', link('aggregation', ag.name), ': other relationship sets can relate to it as a whole.') : h('button.btn.small', { type: 'button', onclick: addAggregation }, UI.icon('erAgg'), 'Aggregate it (treat it as an entity set)')));
      return box;
    }
    function isaProps(sp) {
      const box = h('div');
      box.appendChild(head(sp.kind === 'generalization' ? 'Generalization' : 'Specialization', sp.name, 'erIsa'));
      const upd = (fn) => commit((m) => fn(m.specializations.find((y) => same(y.name, sp.name)), m));
      box.appendChild(field('Higher-level', h('select.inp', { 'aria-label': 'Higher-level entity set', onchange: (e) => upd((x) => { x.parent = e.target.value; }) }, model.entities.map((e) => h('option', { value: e.name, selected: same(e.name, sp.parent) }, e.name)))));
      box.appendChild(field('Lower-level', h('div.er-chips', sp.children.map((c) => h('span.er-chip', link('entity', c), h('button.er-tg.x', { type: 'button', title: 'Remove ' + c + ' from the specialization', onclick: () => upd((x) => { x.children = x.children.filter((y) => !same(y, c)); if (!x.children.length) return false; }) }, '×'))),
        h('select.inp.er-add', { 'aria-label': 'Add a lower-level entity set', onchange: (e) => { const v = e.target.value; if (v) upd((x) => { x.children.push(v); }); } }, h('option', { value: '' }, 'Add…'), model.entities.filter((e) => !same(e.name, sp.parent) && !sp.children.some((c) => same(c, e.name))).map((e) => h('option', { value: e.name }, e.name))))));
      box.appendChild(field('Membership', seg([['disjoint', 'Disjoint', 'An entity belongs to at most one lower-level entity set'], ['overlapping', 'Overlapping', 'An entity may belong to several']], sp.disjoint ? 'disjoint' : 'overlapping', (k) => upd((x) => { x.disjoint = k === 'disjoint'; }))));
      box.appendChild(field('Completeness', seg([['total', 'Total', 'Every higher-level entity belongs to a lower-level entity set'], ['partial', 'Partial', 'Some belong to none']], sp.total ? 'total' : 'partial', (k) => upd((x) => { x.total = k === 'total'; }))));
      const p = ER.entity(model, sp.parent);
      box.appendChild(field('Defined by', h('select.inp', { 'aria-label': 'Defining attribute', onchange: (e) => upd((x) => { if (e.target.value) x.by = e.target.value; else delete x.by; }) }, h('option', { value: '' }, '(user-defined)'), (p ? ER.leaves(p.attributes) : []).map((l) => h('option', { value: l.name, selected: same(l.name, sp.by || '') }, l.name)))));
      box.appendChild(field('Seen as', seg([['specialization', 'Specialization', 'Designed top-down: subgroups of an entity set'], ['generalization', 'Generalization', 'Designed bottom-up: common features pulled up']], sp.kind, (k) => upd((x) => { x.kind = k; }))));
      box.appendChild(h('div.er-note', nt === 'textbook' ? 'This notation draws a hollow arrow from each lower-level entity set to the higher-level one: separate arrows for an overlapping specialization, one joined arrow for a disjoint one.' : nt === 'chen' ? 'Chen\'s notation uses an ISA triangle, labelled disjoint or overlapping; a double line means total.' : 'Crow\'s foot diagrams draw the specialization as a hollow arrow to the higher-level entity set.'));
      return box;
    }
    function aggProps(a) {
      const box = h('div');
      box.appendChild(head('Aggregation', a.name, 'erAgg'));
      box.appendChild(nameField('aggregation', a.name));
      box.appendChild(field('Of', h('select.inp', { 'aria-label': 'Relationship set', onchange: (e) => commit((m) => { ER.aggregation(m, a.name).relationship = e.target.value; }) }, model.relationships.map((r) => h('option', { value: r.name, selected: same(r.name, a.relationship) }, r.name)))));
      const users = model.relationships.filter((r) => r.participants.some((p) => same(p.entity, a.name)));
      box.appendChild(h('div.er-note', 'An aggregation treats relationship set ', relLink(a.relationship), ' with its participants as one higher-level entity set. ', users.length ? ['It takes part in ', users.map((r, i) => [i ? ', ' : '', relLink(r.name)]), '.'] : 'Use Connect to make it a participant of another relationship set.'));
      return box;
    }

    // ---- checks --------------------------------------------------------------------------------------------------------------
    function atToSel(at) {
      if (!at) return null;
      if (at.attribute && (at.entity || at.relationship)) {
        const owner = at.entity ? { kind: 'entity', name: at.entity } : { kind: 'relationship', name: at.relationship };
        const o = ownerOf(model, owner);
        const p = o && attrPaths(o.attributes).find((x) => same(x[x.length - 1], at.attribute));
        if (p) return { kind: 'attribute', owner, path: p };
      }
      if (at.participant && at.relationship) { const r = ER.relationship(model, at.relationship); const i = r ? r.participants.findIndex((p) => same(p.entity, at.participant)) : -1; if (i >= 0) return { kind: 'participant', rel: r.name, index: i }; }
      if (at.entity && ER.entity(model, at.entity)) return { kind: 'entity', name: ER.entity(model, at.entity).name };
      if (at.relationship && ER.relationship(model, at.relationship)) return { kind: 'relationship', name: ER.relationship(model, at.relationship).name };
      if (at.specialization) return { kind: 'isa', name: at.specialization };
      if (at.aggregation && ER.aggregation(model, at.aggregation)) return { kind: 'aggregation', name: at.aggregation };
      return null;
    }
    function renderChecks() {
      checksEl.innerHTML = '';
      const v = ER.validate(model), c = ER.check(model);
      if (!model.entities.length) { checksEl.appendChild(h('div.er-note', 'Add an entity set to begin. Errors in the design, and the checker\'s advice, show here.')); return; }
      if (!v.length && !c.length) { checksEl.appendChild(h('div.er-ok', UI.icon('check'), h('div', h('b', 'No problems found. '), 'The design is valid, and the checker has no advice on it.'))); }
      const item = (sev, msg, explanation, at, loc) => {
        const x = atToSel(at);
        const body = h('div.er-ci-b', h('div', msg), explanation ? h('div.er-ci-x', explanation) : null);
        return h('button.er-ci.' + sev, { type: 'button', title: x ? 'Show it in the diagram' : '', onclick: (e) => { e.currentTarget.classList.toggle('open'); if (x) select(x, true); if (loc && tab === 'text') { editor.ta.setSelectionRange(loc.pos, loc.pos); editor.scrollToPos(loc.pos); } } },
          UI.icon(sev === 'error' ? 'x' : sev === 'warning' ? 'warn' : sev === 'advice' ? 'help' : 'info'), body);
      };
      const groups = [['error', 'Errors', v.filter((x) => x.severity === 'error')], ['warning', 'Warnings', v.filter((x) => x.severity === 'warning')], ['advice', 'Design advice', c.filter((x) => x.severity === 'advice')], ['info', 'Worth a thought', c.filter((x) => x.severity !== 'advice')]];
      for (const [sev, title, list] of groups) {
        if (!list.length) continue;
        checksEl.appendChild(h('div.er-st', title + ' (' + list.length + ')'));
        for (const x of list) checksEl.appendChild(item(sev, x.message.replace(/^./, (ch) => ch.toUpperCase()), x.explanation, x.at, x.loc));
      }
      if (c.length) checksEl.appendChild(h('div.er-note', 'Click an item to see it in the diagram and read why it matters.'));
    }

    // ---- To SQL ---------------------------------------------------------------------------------------------------------------
    function toSql() {
      const o = UI.store.get('er.sqlopts', { specialization: 'per-entity', mergeManyToOne: true, oneToOne: 'merge', avoidNulls: false });
      let step = 0, all = false;
      const body = h('div.er-sql');
      const d = UI.dialog('From the E-R design to tables', body, { wide: true });
      const draw2 = () => {
        body.innerHTML = '';
        let res;
        try { res = ER.toRelational(model, o); } catch (e) {
          body.appendChild(h('p', 'The design has errors, and the reduction needs a valid design. Fix these first:'));
          body.appendChild(h('ul.er-list', (e.problems || [{ message: e.message }]).map((x) => h('li', x.message))));
          body.appendChild(h('button.btn', { type: 'button', onclick: () => { d.close(); showTab('checks'); } }, 'Show the checks'));
          return;
        }
        const optRow = h('div.er-sqlopts',
          field('Specialization', h('select.inp', { onchange: (e) => { o.specialization = e.target.value; again(); } }, [['per-entity', 'A table per entity set (first method)'], ['lower-only', 'Lower-level tables only (second method)'], ['single-table', 'One table with a type column']].map(([k, l]) => h('option', { value: k, selected: o.specialization === k }, l)))),
          h('label.er-check', h('input', { type: 'checkbox', checked: o.mergeManyToOne !== false, onchange: (e) => { o.mergeManyToOne = e.target.checked; again(); } }), ' Combine many-to-one relationships with the many side'),
          h('label.er-check', h('input', { type: 'checkbox', checked: o.oneToOne === 'separate', onchange: (e) => { o.oneToOne = e.target.checked ? 'separate' : 'merge'; again(); } }), ' One-to-one relationships as tables of their own'),
          h('label.er-check', h('input', { type: 'checkbox', checked: !!o.avoidNulls, onchange: (e) => { o.avoidNulls = e.target.checked; again(); } }), ' Avoid nulls (keep partial many-to-one relationships separate)'));
        body.appendChild(optRow);
        const n = res.steps.length;
        step = Math.min(step, n - 1);
        const cur = res.steps[step];
        const seen = new Set(res.steps.slice(0, all ? n : step + 1).map((x) => x.target).filter(Boolean).map(lc));
        const stepCard = (x, i) => h('div.er-step' + (!all || i === step ? '.on' : ''),
          h('div.er-step-h', h('span.er-step-n', String(i + 1)), h('span.er-rule', x.title.split(':')[0]), x.target ? h('span.er-step-t', x.source + ' → ' + x.target) : h('span.er-step-t', x.source)),
          h('div.er-step-r', x.title.split(':').slice(1).join(':').trim()),
          h('div.er-step-why', x.reason));
        body.appendChild(h('div.er-sql-sec', h('h3', 'The reduction, one rule at a time'),
          h('div.er-stepper', UI.btn('stepBack', null, 'Previous rule', () => { all = false; step = Math.max(0, step - 1); draw2(); }, 'icon'), h('span.er-step-pos', all ? 'All ' + n + ' steps' : 'Step ' + (step + 1) + ' of ' + n), UI.btn('step', null, 'Next rule', () => { all = false; step = Math.min(n - 1, step + 1); draw2(); }, 'icon'), h('input.tl-range', { type: 'range', min: '0', max: String(n - 1), value: String(step), 'aria-label': 'Step', oninput: (e) => { all = false; step = +e.target.value; draw2(); } }), h('button.btn.small' + (all ? '.primary' : ''), { type: 'button', onclick: () => { all = !all; draw2(); } }, all ? 'One at a time' : 'Show all')),
          all ? h('div.er-steps', res.steps.map(stepCard)) : stepCard(cur, step)));
        const tables = h('div.er-tables');
        for (const t of res.tables) {
          const fkCols = new Map(); for (const fk of t.foreignKeys) for (const c of fk.columns) fkCols.set(c, fk);
          tables.appendChild(h('div.er-tbl' + (cur && same(cur.target || '', t.name) && !all ? '.cur' : '') + (seen.has(lc(t.name)) ? '' : '.later'),
            h('div.er-tbl-h', h('b', t.name), h('span.muted', t.source.kind + ' ' + t.source.name)),
            h('div.er-tbl-c', t.columns.map((c) => h('div.er-col', h('span' + (t.primaryKey.includes(c.name) ? '.pk' : ''), c.name), h('span.er-ct', c.type), fkCols.has(c.name) ? h('span.er-fk', { title: fkCols.get(c.name).reason }, '→ ' + fkCols.get(c.name).references) : null, c.notNull && !t.primaryKey.includes(c.name) ? h('span.er-nn', 'not null') : null))),
            t.uniques.length ? h('div.er-tbl-x', 'unique (' + t.uniques.map((u) => u.join(', ')).join('), (') + ')') : null,
            t.checks.length ? h('div.er-tbl-x', t.checks.map((c) => 'check (' + c.expr + ')').join('; ')) : null));
        }
        body.appendChild(h('div.er-sql-sec', h('h3', 'The relation schemas', h('span.muted.er-small', ' primary keys underlined; tables not yet reached by the steps are dimmed')), tables));
        const cat = app.session.catalog;
        let k = 1; while (cat.schemas.has('er_' + k)) k++;
        const schema = 'er_' + k;
        body.appendChild(h('div.er-sql-sec', h('h3', 'The DDL'), h('pre.ls-sql.er-ddl', UI.highlightSql ? UI.highlightSql(res.ddl) : res.ddl),
          h('div.er-row', h('button.btn.primary', { type: 'button', onclick: () => runIn(schema, res, d) }, UI.icon('run'), 'Run in a new schema (' + schema + ')'), UI.btn('copy', 'Copy', 'Copy the DDL', () => UI.copy(res.ddl)), UI.btn('download', 'Download', 'Download the DDL', () => UI.download(fileBase() + '.sql', res.ddl, 'application/sql'))),
          h('p.muted.er-small', 'Running it creates schema ', h('code', schema), ' and sets the search path of the active tab to it, so the tables can be queried by name; ', h('code', 'set search_path to public'), ' goes back.')));
      };
      const again = () => { UI.store.set('er.sqlopts', o); draw2(); };
      draw2();
    }
    function runIn(schema, res, d) {
      const sql = '-- ' + (docName || 'the E-R design') + ', reduced to tables\ncreate schema ' + schema + ';\nset search_path to ' + schema + ', public;\n\n' + res.ddl;
      app.runText(sql, { insert: true });
      const run = app.tab && app.tab.run;
      const err = run && run.results.find((r) => r.error);
      if (err) { UI.toast('The DDL failed: ' + err.error.message, 'err', 6000); return; }
      d.close();
      UI.toast('Created ' + UI.plural(res.tables.length, 'table') + ' in schema ' + schema, 'ok', 4000);
      if (UI.views.get('erd')) app.openView('erd', { schema });
    }

    // ---- From the database ---------------------------------------------------------------------------------------------------
    function fromDb(preset) {
      const cat = app.session.catalog;
      const schemas = [...cat.schemas.values()].filter((x) => !x.system).map((x) => x.name);
      const o = { schema: preset && schemas.includes(preset) ? preset : schemas.includes('public') ? 'public' : schemas[0], weak: 'auto' };
      const body = h('div.er-fromdb');
      let res = null;
      UI.dialog('An E-R design read from the database', body, { wide: true, buttons: [{ label: 'Close' }, { label: 'Open it in the editor', primary: true, onclick: () => { if (!res || !res.model.entities.length) return false; replaceModel(res.model, 'Read from ' + o.schema); return true; } }] });
      const draw2 = () => {
        body.innerHTML = '';
        body.appendChild(h('p.er-small', 'Reverse engineering reads the tables, primary keys and foreign keys and asks what E-R design would reduce to them. The reduction loses information, so parts of the answer are guesses (marked), and some things cannot come back at all.'));
        body.appendChild(h('div.er-row', field('Schema', h('select.inp', { onchange: (e) => { o.schema = e.target.value; draw2(); } }, schemas.map((x) => h('option', { value: x, selected: x === o.schema }, x)))),
          h('label.er-check', h('input', { type: 'checkbox', checked: o.weak === 'strong', onchange: (e) => { o.weak = e.target.checked ? 'strong' : 'auto'; draw2(); } }), ' Read every table as a strong entity set')));
        try { res = ER.fromCatalog(app.session, o); } catch (e) { body.appendChild(h('p.er-bad', 'It could not be read: ' + e.message)); res = null; return; }
        if (!res.model.entities.length) { body.appendChild(h('p.muted', 'Schema ' + o.schema + ' has no tables.')); return; }
        const fig = h('div.er-fig');
        fig.innerHTML = ER.svg(res.model, null, nt, { theme: theme(wrap) });
        body.appendChild(fig);
        body.appendChild(h('h3', 'What each table became'));
        body.appendChild(h('table.grid.small', h('tbody', Object.entries(res.tables).map(([t, w]) => h('tr', h('td', t), h('td', w))))));
        body.appendChild(h('h3', 'How it was read'));
        body.appendChild(h('ul.er-list', res.notes.map((n) => h('li', h('code', n.table), ' ', n.message, n.guess ? h('span.er-b.warn', 'guess') : null))));
        body.appendChild(h('h3', 'What the tables cannot tell'));
        body.appendChild(h('ul.er-list', res.lost.map((x) => h('li', x))));
      };
      draw2();
    }

    // ---- exercises --------------------------------------------------------------------------------------------------------------
    function enterExercise(id) {
      const x = ER.exercise(id);
      if (!x) return;
      if (exercise === id) return;
      save();
      exercise = id;
      undo = []; redo = [];
      load(loadWork(id) || { model: ER.normalize({ entities: [] }), pos: {}, notation: nt, name: x.title });
      renderBanner();
    }
    function leaveExercise() {
      save();
      exercise = null;
      undo = []; redo = [];
      load(loadWork(null) || startModel(SAMPLES.theatre.text, SAMPLES.theatre.name));
      renderBanner();
    }
    function renderBanner() {
      banner.innerHTML = '';
      banner.hidden = !exercise;
      if (!exercise) return;
      const x = ER.exercise(exercise);
      banner.appendChild(h('div.er-ban-t', UI.icon('tasks'), h('span', h('b', 'Exercise: ' + x.title), h('span.muted', ' · this diagram is your answer'))));
      banner.appendChild(h('div.er-row',
        h('button.btn.small.primary', { type: 'button', onclick: checkHere }, UI.icon('check'), 'Check my design'),
        K.Content && K.Content.exercises.has('er-' + exercise) ? h('button.btn.small', { type: 'button', onclick: () => app.openView('exercise', { exercise: 'er-' + exercise }) }, 'The problem') : null,
        h('button.btn.small.ghost', { type: 'button', onclick: leaveExercise }, 'Back to my diagram')));
    }
    function checkHere() {
      const r = ER.checkExercise(exercise, model);
      const errs = r.problems.filter((x) => x.severity === 'error');
      const ok = r.correct && !errs.length;
      const body = h('div', h('div.ex-res' + (ok ? '.ok' : '.bad'), h('div.ex-v', UI.icon(ok ? 'check' : 'x'), h('b', ok ? 'Correct.' : 'Not yet.'), ' Score ' + r.score + ' of 100.')),
        errs.length ? h('div.er-st', 'The design is not valid yet') : null, h('ul.er-list', errs.map((x) => h('li', x.message))),
        h('ul.er-list', r.feedback.map((f) => h('li.er-fb.' + f.level, h('span.er-b.' + ({ ok: 'ok', error: 'bad', warning: 'warn', info: 'acc' }[f.level] || 'acc'), { ok: 'fine', error: 'error', warning: 'warning', info: 'note' }[f.level] || f.level), ' ', f.message))));
      if (ok && K.Content && K.Content.exercises.has('er-' + exercise)) { const p = UI.store.get('progress', { done: {}, solved: {} }); p.solved['er-' + exercise] = Date.now(); UI.store.set('progress', p); if (app.panel === 'tasks') app.renderPanel(); }
      UI.dialog('Your design for ' + ER.exercise(exercise).title, body, { wide: true, buttons: [{ label: 'Close', primary: true }] });
    }

    // ---- keys -------------------------------------------------------------------------------------------------------------------
    host.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); return; }
      if (mod && e.key === 'y') { e.preventDefault(); doRedo(); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') { if (sel) { e.preventDefault(); removeSel(); } return; }
      if (e.key === 'Escape') { if (mode) setMode(null); else if (sel) { sel = null; multi = []; drawOverlay(); renderProps(); } return; }
      if (e.key === 'F2' && sel) { e.preventDefault(); rename(sel); return; }
      if (e.key === '+' || e.key === '=') canvas.zoomBy(1.2);
      if (e.key === '-') canvas.zoomBy(1 / 1.2);
    });
    const offTheme = app.on('theme', () => { if (model) { draw(true); renderProps(); } });

    // ---- start -------------------------------------------------------------------------------------------------------------------
    {
      const w = loadWork(null);
      if (w) load(w); else load(startModel(SAMPLES.theatre.text, SAMPLES.theatre.name));
      renderBanner();
    }
    const api = {
      model: () => model,
      exercise: () => exercise,
      notation: () => nt,
      layout: () => L,
      canvas,
      /** where a node of the layout is on the screen (client coordinates) */
      screenOf(id) { const n = L && L.nodes.find((x) => x.id === id); if (!n) return null; const r = canvas.svg.getBoundingClientRect(), p = canvas.toHost(n.x + n.w / 2 + L.origin.x, n.y + n.h / 2 + L.origin.y); return { x: r.left + p.x, y: r.top + p.y }; },
      // for tests and lessons: the same actions the toolbar and the canvas use
      act: { addEntity, addRelationship, addAttribute, addIsa, addAggregation, startConnect, pickInMode, select, remove: removeSel, undo: doUndo, redo: doRedo, setNotation, autoLayout, renameTo, toSql, fromDb, setText: (t) => { editor.setValue(t); textSource = true; applyText(); }, showTab, check: checkHere, enterExercise, leaveExercise, replaceModel, commit },
    };
    live = api;
    Object.assign(view, {
      render() {
        fitted = fitted ? canvas.refit() : canvas.fit();
        if (tab === 'text') editor.render();
      },
      onSelect(x) {
        if (!x) return;
        if (x.exercise) enterExercise(x.exercise);
        if (x.text) { const p = ER.tryParse(x.text); if (!p.error) replaceModel(p.model, x.name || ''); }
        if (x.notation) setNotation(ER.notation(x.notation));
        if (x.fromDb) fromDb(x.fromDb === true ? null : x.fromDb);
      },
      destroy() { offTheme(); save(); if (live === api) live = null; },
      api,
    });
    return view;
  }

  UI.registerView({ id: 'er', title: 'E-R diagram', icon: 'er', group: 'Design', order: 30, create });
  UI.ER = {
    Canvas, theme, SAMPLES,
    /** the model in the open editor, or the one saved in the browser */
    current() { if (live) return live.model(); const w = loadWork(null); return w ? w.model : null; },
    /** the student's answer to an exercise: the editor's model when it is on that exercise, else the one saved for it */
    answer(id) {
      if (live && live.exercise() === id) return live.model();
      const w = loadWork(id);
      if (w && w.model.entities.length) return w.model;
      return live && !live.exercise() ? live.model() : null;
    },
    editor: () => live,
  };
})(typeof window !== 'undefined' ? window : globalThis);
