// The schema diagram: the tables of the current database as boxes with their columns, PK and FK marks, and a line
// from each foreign key to the table it references, drawn with crow's-foot ends. It is read from the catalog
// and redrawn when the schema changes; tables can be dragged, and a table opens its description or its pages.
(function (root) {
  'use strict';
  const K = root.K;
  const UI = K.UI;
  const ER = K.ER;
  const { h } = UI;
  const lc = (x) => String(x).toLowerCase();

  /** the tables of a schema as a model the E-R layout can draw: a table is an entity set, a foreign key a line */
  function schemaModel(cat, schema) {
    const rels = cat.tables(['table']).filter((r) => r.schema === schema && !r.temp).sort((a, b) => (a.name < b.name ? -1 : 1));
    const byOid = new Map(rels.map((r) => [r.oid, r]));
    const m = { entities: [], relationships: [], specializations: [], aggregations: [] };
    const info = new Map();
    let n = 0;
    for (const r of rels) {
      const pkc = (r.constraints.find((k) => k.kind === 'primary') || {}).cols || r.pk || [];
      const fkc = new Set();
      for (const k of r.constraints) if (k.kind === 'foreign') for (const a of k.cols) fkc.add(a);
      const cols = r.cols.map((c, i) => ({ c, i })).filter((x) => !x.c.dropped);
      m.entities.push({ name: r.name, attributes: cols.map(({ c, i }) => ({ name: c.name, type: ER.typeText(c.type), key: pkc.includes(i) })) });
      info.set(lc(r.name), { rel: r, tags: cols.map(({ i }) => [pkc.includes(i) ? 'PK' : '', fkc.has(i) ? 'FK' : ''].filter(Boolean).join(' ')), nn: cols.map(({ c }) => !!c.notNull) });
      for (const k of r.constraints) {
        if (k.kind !== 'foreign' || !byOid.has(k.refRel)) continue;
        const ref = byOid.get(k.refRel);
        const names = k.cols.map((a) => r.cols[a].name);
        const notNull = k.cols.every((a) => r.cols[a].notNull);
        const unique = (pkc.length === k.cols.length && k.cols.every((a) => pkc.includes(a))) || r.constraints.some((u) => u.kind === 'unique' && u.cols.length === k.cols.length && k.cols.every((a) => u.cols.includes(a)));
        // the line's end at the referenced table says how many it matches for one row (one, or at most one); the end
        // at the referencing table how many rows may refer to one referenced row
        m.relationships.push({ name: '#fk' + n++, identifying: k.cols.every((a) => pkc.includes(a)), participants: [{ entity: r.name, min: notNull ? 1 : 0, max: 1, total: notNull }, { entity: ref.name, min: 0, max: unique ? 1 : '*' }], attributes: [], fk: { name: k.name, from: r.name, cols: names, to: ref.name, refCols: k.refCols.map((a) => ref.cols[a].name), onDelete: k.onDelete } });
      }
    }
    return { model: m, info, fks: m.relationships.map((x) => x.fk) };
  }

  function create(app, el) {
    let schema = 'public', L = null, sel = null, showTypes = UI.store.get('erd.types', true), fitted = false, built = null;
    const posAll = UI.store.get('erd.pos', {});
    const headEl = h('div.view-head.erd-head');
    const intro = h('p.er-intro', h('span.er-intro-short', 'About the schema diagram ›'), h('span.er-intro-full', 'A ', h('b', 'schema diagram'), ' draws the tables of the database: each box is a relation schema with its columns, ', h('b', 'PK'), ' marking the primary key and ', h('b', 'FK'), ' the foreign keys. Each line joins a foreign key to the table it references, the crow\'s foot on the referencing side (dashed when the foreign key is not part of the primary key); it is read from the catalog, so it follows CREATE, ALTER and DROP.'));
    intro.addEventListener('click', () => intro.classList.toggle('open'));
    const host = h('div.er-canvas', { tabindex: '0', 'aria-label': 'Schema diagram' });
    const zoom = h('div.er-zoom',
      UI.btn('zoomOut', null, 'Zoom out', () => canvas.zoomBy(1 / 1.2), 'icon'),
      h('button.er-pct', { type: 'button', title: 'Actual size', onclick: () => canvas.actual() }, '100%'),
      UI.btn('zoomIn', null, 'Zoom in', () => canvas.zoomBy(1.2), 'icon'),
      UI.btn('fit', null, 'Fit the diagram in the view', () => canvas.fit(), 'icon'));
    const empty = h('div.empty.erd-empty', { hidden: true });
    const stage = h('div.er-stage', host, zoom, empty);
    const infoEl = h('div.erd-info');
    el.appendChild(h('div.er-view', intro, headEl, h('div.er-main', stage), infoEl));
    const canvas = new UI.ER.Canvas(host, { label: 'Schema diagram', onDown, onBackground: () => { sel = null; overlay(); info(); }, onDbl, onView: () => { zoom.querySelector('.er-pct').textContent = Math.round(canvas.z * 100) + '%'; } });
    const relayout = UI.raf(() => draw());

    function head() {
      headEl.innerHTML = '';
      const cat = app.session.catalog;
      const schemas = [...cat.schemas.values()].filter((x) => !x.system).map((x) => x.name);
      if (!schemas.includes(schema)) schema = schemas.includes('public') ? 'public' : schemas[0] || 'public';
      headEl.appendChild(h('label.er-check', 'Schema ', h('select.inp', { 'aria-label': 'Schema', onchange: (e) => { schema = e.target.value; fitted = false; build(); } }, schemas.map((x) => h('option', { value: x, selected: x === schema }, x)))));
      headEl.appendChild(h('label.er-check', h('input', { type: 'checkbox', checked: showTypes, onchange: (e) => { showTypes = e.target.checked; UI.store.set('erd.types', showTypes); draw(); } }), ' Types'));
      headEl.appendChild(h('div.grow'));
      headEl.appendChild(UI.btn('layout', null, 'Lay the diagram out again', () => { delete posAll[schema]; UI.store.set('erd.pos', posAll); draw(); canvas.fit(); }, 'icon'));
      headEl.appendChild(UI.btn('download', null, 'Download as SVG', () => { if (L) UI.download('schema-' + schema + '.svg', svgText(null), 'image/svg+xml'); }, 'icon'));
      if (UI.views.get('er')) headEl.appendChild(UI.btn('er', 'Read as E-R', 'Read an E-R design back from these tables, in the E-R editor', () => app.openView('er', { fromDb: schema })));
    }
    function build() {
      built = schemaModel(app.session.catalog, schema);
      if (sel && !built.info.has(lc(sel))) sel = null;
      draw();
      if (!fitted || !canvas.touched) fitted = canvas.fit(1);
      info();
    }
    function svgText(t) {
      return ER.svg(built.model, L, 'crowsfoot', { theme: t || undefined, background: !t });
    }
    function draw() {
      const m = built.model;
      empty.hidden = !!m.entities.length;
      if (!m.entities.length) { empty.textContent = 'Schema ' + schema + ' has no tables. Create one (or reduce an E-R design with To SQL in the E-R editor) and it appears here.'; }
      L = ER.layout(m, 'crowsfoot', { showTypes, positions: posAll[schema], gap: 48, lineNames: false, aspect: 1.5 });
      for (const n of L.nodes) {
        const x = built.info.get(lc(n.name));
        if (x && n.lines) n.lines.forEach((l, i) => { l.tag = x.tags[i] || ''; l.key = false; });
        // the key is marked PK, so the underline is not repeated; foreign key lines carry no name
      }
      for (const e of L.edges) if (e.name) e.name = null;
      // positions are kept only once the user has moved a table: until then the layout follows the schema
      if (posAll[schema]) posAll[schema] = placed();
      canvas.set(L, svgText(UI.ER.theme(el)));
      overlay();
    }
    function overlay() {
      const over = canvas.over;
      over.innerHTML = '';
      if (!L) return;
      for (const n of L.nodes) {
        over.appendChild(UI.s('rect', { x: n.x, y: n.y, width: n.w, height: n.h, rx: 6, class: 'er-hit er-hit-node', 'data-node': n.id }));
        if (sel && lc(sel) === lc(n.name)) over.appendChild(UI.s('rect', { x: n.x - 4, y: n.y - 4, width: n.w + 8, height: n.h + 8, rx: 9, class: 'er-sel' }));
      }
      if (sel) for (const e of L.edges) {
        const r = built.model.relationships.find((x) => x.name === e.relationship);
        if (r && r.fk && (lc(r.fk.from) === lc(sel) || lc(r.fk.to) === lc(sel))) over.insertBefore(UI.s('polyline', { points: e.points.map((q) => q.x + ',' + q.y).join(' '), class: 'er-sel-edge soft' }), over.firstChild);
      }
    }
    const placed = () => { const p = {}; for (const n of L.nodes) p[n.id] = { x: +(n.x + n.w / 2 + L.origin.x).toFixed(1), y: +(n.y + n.h / 2 + L.origin.y).toFixed(1) }; return p; };
    const nodeAt = (e) => { const t = e.target.closest && e.target.closest('[data-node]'); return t && L ? L.nodes.find((n) => n.id === t.dataset.node) : null; };
    function onDown(e) {
      const n = nodeAt(e);
      if (!n) return null;
      const start = Object.assign({}, placed()[n.id]);
      return {
        move(dx, dy) { canvas.touched = true; if (!posAll[schema]) posAll[schema] = placed(); posAll[schema][n.id] = { x: start.x + dx, y: start.y + dy }; relayout(); },
        up(moved) { if (moved) UI.store.set('erd.pos', posAll); else { sel = n.name; overlay(); info(); } },
      };
    }
    function onDbl(e) { const n = nodeAt(e); if (n) { const x = built.info.get(lc(n.name)); if (x) UI.Schema.describe(app, x.rel); } }
    function info() {
      infoEl.innerHTML = '';
      const x = sel && built && built.info.get(lc(sel));
      if (!x) {
        const n = built ? built.model.entities.length : 0;
        infoEl.appendChild(h('span.muted', n ? UI.plural(n, 'table') + ', ' + UI.plural(built.fks.length, 'foreign key') + ' in schema ' + schema + '. Click a table for its details, drag to move it, double-click to describe it.' : ''));
        return;
      }
      const r = x.rel;
      const out = built.fks.filter((f) => lc(f.from) === lc(r.name)), inn = built.fks.filter((f) => lc(f.to) === lc(r.name) && lc(f.from) !== lc(r.name));
      const live = app.db.liveOf ? app.db.liveOf(r) : null;
      infoEl.appendChild(h('div.grow', h('b', r.name), h('span.muted', ' · ' + UI.plural(r.cols.filter((c) => !c.dropped).length, 'column') + (live !== null ? ' · ' + UI.plural(live, 'row') : '')),
        out.length ? h('div.muted', out.map((f) => '(' + f.cols.join(', ') + ') → ' + f.to + (f.onDelete && f.onDelete !== 'no action' ? ' on delete ' + f.onDelete : '')).join('; ')) : null,
        inn.length ? h('div.muted', 'referenced by ' + inn.map((f) => f.from + ' (' + f.cols.join(', ') + ')').join(', ')) : null));
      infoEl.appendChild(h('div.er-group',
        UI.btn('info', 'Describe', 'Columns, keys and constraints (\\d)', () => UI.Schema.describe(app, r)),
        UI.views.get('storage') ? UI.btn('page', 'Pages', 'Show how the table is stored', () => app.openView('storage', { rel: r.oid })) : null,
        UI.btn('run', 'Rows', 'SELECT * FROM ' + r.name, () => app.runText('select * from ' + UI.Schema.quoteRel(r) + ' limit 100;'))));
    }
    const offs = [app.on('schema', () => { head(); build(); }), app.on('theme', () => { if (built) draw(); }), app.on('session', () => { head(); build(); })];
    head(); build();
    return {
      render() { fitted = fitted ? canvas.refit() : canvas.fit(1); },
      onDb() { fitted = false; head(); build(); },
      onSelect(x) { if (x && x.schema) { schema = x.schema; fitted = false; head(); build(); } if (x && x.table) { sel = x.table; overlay(); info(); } },
      destroy() { for (const f of offs) f(); UI.store.set('erd.pos', posAll); },
      layout: () => L, model: () => built && built.model,
    };
  }

  UI.registerView({ id: 'erd', title: 'Schema diagram', icon: 'table', group: 'Design', order: 31, create });
  UI.ERD = { schemaModel };
})(typeof window !== 'undefined' ? window : globalThis);
