// The schema browser: schemas, tables with their columns, keys, constraints and indexes, views, sequences,
// types and functions, read from the active session's catalog. A table's menu runs a query on it or opens
// its pages, its indexes or its diagram in a view.
(function (root) {
  'use strict';
  const K = root.K;
  const UI = K.UI;
  const { h } = UI;

  const open = new Set(UI.store.get('schema.open', ['s:public', 's:public:Tables']));
  const toggle = (k, app) => { if (open.has(k)) open.delete(k); else open.add(k); UI.store.set('schema.open', [...open]); app.renderPanel(); };

  function render(app, el) {
    const cat = app.session.catalog;
    const filter = h('input.inp.filter', { type: 'search', placeholder: 'Filter', 'aria-label': 'Filter the schema', value: render.filter || '', oninput: UI.debounce((e) => { render.filter = e.target.value; app.renderPanel(); const f = app.side.querySelector('.filter'); if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); } }, 200) });
    el.appendChild(h('div.side-tools', filter, UI.btn('refresh', null, 'Refresh', () => app.renderPanel(), 'icon'), UI.btn('er', null, 'Schema diagram', () => app.openView('erd'), 'icon')));
    const f = (render.filter || '').toLowerCase();
    const tree = h('div.tree', { role: 'tree' });
    for (const sc of cat.schemas.values()) {
      if (sc.system) continue;
      const objs = [...sc.objects.values()].filter((o) => o.oid !== undefined && o.kind !== 'index' && (!f || o.name.toLowerCase().includes(f) || (o.cols || []).some((c) => c.name.toLowerCase().includes(f))));
      const types = [...cat.types.values()].filter((t) => t.schema === sc.name);
      const funcs = [...cat.funcs.values()].flat().filter((x) => x.schema === sc.name);
      const sk = 's:' + sc.name;
      tree.appendChild(node(app, sk, 'schema', sc.name, objs.length + ' objects', 0));
      if (!open.has(sk) && !f) continue;
      const group = (title, icon, list, fn) => { if (!list.length) return; const gk = sk + ':' + title; tree.appendChild(node(app, gk, icon, title, String(list.length), 1, null, true)); if (open.has(gk) || f) for (const x of list) fn(x); };
      group('Tables', 'table', objs.filter((o) => o.kind === 'table').sort(byName), (r) => tableNode(app, tree, r, cat, f));
      group('Views', 'view', objs.filter((o) => o.kind === 'view' || o.kind === 'matview').sort(byName), (r) => tableNode(app, tree, r, cat, f));
      group('Sequences', 'seq', objs.filter((o) => o.kind === 'sequence').sort(byName), (r) => tree.appendChild(leaf(app, 'seq', r.name, String(r.seq.inc > 0n ? 'from ' + r.seq.start : 'down from ' + r.seq.start), 2, () => app.runText('select * from ' + r.name + ';'))));
      group('Types', 'type', types, (t) => tree.appendChild(leaf(app, 'type', t.name, t.domain ? 'domain over ' + K.T.sqlName(t.base) : t.cat === 'E' ? 'enum: ' + t.labels.join(', ') : 'composite', 2)));
      group('Functions', 'fn', funcs, (x) => tree.appendChild(leaf(app, 'fn', x.name + '(' + x.params.filter((p) => p.mode !== 'out').map((p) => K.T.sqlName(p.type)).join(', ') + ')', x.kind === 'procedure' ? 'procedure' : (x.setof ? 'setof ' : '') + (x.retType ? K.T.sqlName(x.retType) : ''), 2)));
    }
    el.appendChild(tree);
    if (!tree.querySelector('.tn')) el.appendChild(h('div.empty', 'No tables yet. Try CREATE TABLE, or load a sample database from the database menu.'));
  }
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  function node(app, key, icon, label, meta, depth, menu, group) {
    const isOpen = open.has(key);
    return h('div.tn' + (group ? '.grp' : ''), { role: 'treeitem', 'aria-expanded': String(isOpen), tabindex: '0', style: { paddingLeft: 6 + depth * 14 + 'px' }, onclick: () => toggle(key, app), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(key, app); } }, oncontextmenu: menu ? (e) => { e.preventDefault(); menu(e); } : null },
      h('span.tw', isOpen ? UI.icon('chevDown') : UI.icon('chev')), UI.icon(icon), h('span.tl', label), meta ? h('span.tm', { title: meta }, meta) : null, menu ? h('button.tn-more', { type: 'button', 'aria-label': 'Actions for ' + label, onclick: (e) => { e.stopPropagation(); menu(e); } }, UI.icon('more')) : null);
  }
  function leaf(app, icon, label, meta, depth, onclick, title) {
    return h('div.tn.leaf', { role: 'treeitem', tabindex: '0', title: title || null, style: { paddingLeft: 6 + depth * 14 + 18 + 'px' }, onclick, ondblclick: () => app.editor.insert(label.split('(')[0]) }, UI.icon(icon), h('span.tl', label), meta ? h('span.tm', meta) : null);
  }
  function tableNode(app, tree, r, cat, f) {
    const key = 't:' + r.oid;
    const live = app.db.liveOf(r);
    const pages = r.file && app.db.disk.files.has(r.file) ? app.db.disk.blocks(r.file) : 0;
    const menu = (e) => UI.menu(e.currentTarget || e.target, [
      { label: 'SELECT * FROM ' + r.name, icon: 'run', onclick: () => app.runText('select * from ' + qi(r) + ' limit 100;') },
      { label: 'Describe (columns, keys, indexes)', icon: 'info', onclick: () => describe(app, r) },
      r.kind === 'table' ? { label: 'Show its pages', icon: 'page', onclick: () => app.openView('storage', { rel: r.oid }) } : null,
      r.kind === 'table' && r.indexes.length ? { label: 'Show its indexes', icon: 'index', onclick: () => app.openView('index', { index: r.indexes[0] }) } : null,
      { label: 'Copy the CREATE statement', icon: 'copy', onclick: () => UI.copy(K.Dump ? K.Dump.create(r, cat) : r.name) },
      { sep: true },
      { label: 'Insert the name', icon: 'plus', onclick: () => app.editor.insert(r.name) },
    ].filter(Boolean));
    tree.appendChild(node(app, key, r.kind === 'table' ? 'table' : 'view', r.name, r.kind === 'table' ? live.toLocaleString('en-US') + ' rows · ' + pages + ' pg' : r.kind === 'matview' ? 'materialized' : 'view', 2, menu));
    if (!open.has(key)) return;
    const pk = new Set(r.pk || []);
    const fk = new Map();
    for (const c of r.constraints || []) if (c.kind === 'foreign') for (const a of c.cols) fk.set(a, cat.rel(c.refRel));
    r.cols.forEach((c, a) => {
      if (c.dropped) return;
      const marks = (pk.has(a) ? 'PK ' : '') + (fk.has(a) ? 'FK→' + (fk.get(a) ? fk.get(a).name : '?') + ' ' : '') + (c.notNull && !pk.has(a) ? 'not null' : '');
      tree.appendChild(leaf(app, pk.has(a) ? 'key' : 'col', c.name, K.T.sqlName(c.type) + (marks ? ' · ' + marks.trim() : ''), 3, null, (c.defaultText ? 'default ' + c.defaultText : '') || null));
    });
    for (const o of r.indexes || []) { const ix = cat.rel(o); if (ix) tree.appendChild(leaf(app, 'index', ix.name, ix.method + (ix.unique ? ', unique' : ''), 3, () => app.openView('index', { index: ix.oid }))); }
    for (const c of r.constraints || []) if (c.kind === 'check') tree.appendChild(leaf(app, 'check', c.name, 'check (' + (c.text || '') + ')', 3));
    for (const t of r.triggers || []) tree.appendChild(leaf(app, 'bolt', t.name, t.timing + ' ' + t.events.map((e) => e.event).join(' or ') + ' for each ' + t.forEach, 3));
    void f;
  }
  const qi = (r) => (r.schema !== 'public' ? r.schema + '.' : '') + (/^[a-z_][a-z0-9_]*$/.test(r.name) ? r.name : '"' + r.name.replace(/"/g, '""') + '"');
  /** psql's \d, as a dialog */
  function describe(app, r) {
    const cat = app.session.catalog;
    const rows = r.cols.filter((c) => !c.dropped).map((c) => h('tr', h('td', c.name), h('td', K.T.sqlName(c.type)), h('td', c.notNull ? 'not null' : ''), h('td', c.identity ? 'generated ' + c.identity + ' as identity' : c.generatedText ? 'generated always as (' + c.generatedText + ') stored' : c.defaultText || '')));
    const body = h('div', h('table.grid.small', h('thead', h('tr', h('th', 'Column'), h('th', 'Type'), h('th', 'Nullable'), h('th', 'Default'))), h('tbody', rows)));
    const idx = cat.indexesOf(r);
    if (idx.length) body.appendChild(h('div.desc', h('b', 'Indexes:'), h('ul', idx.map((ix) => h('li', '"' + ix.name + '"' + (ix.primary ? ' PRIMARY KEY,' : ix.unique ? ' UNIQUE,' : '') + ' ' + ix.method + ' (' + ix.keys.map((k) => (k.attnum !== undefined ? r.cols[k.attnum].name : k.name) + (k.dir === 'desc' ? ' DESC' : '')).join(', ') + ')' + (ix.whereText ? ' WHERE ' + ix.whereText : ''))))));
    const checks = (r.constraints || []).filter((c) => c.kind === 'check');
    if (checks.length) body.appendChild(h('div.desc', h('b', 'Check constraints:'), h('ul', checks.map((c) => h('li', '"' + c.name + '" CHECK (' + c.text + ')')))));
    const fks = (r.constraints || []).filter((c) => c.kind === 'foreign');
    if (fks.length) body.appendChild(h('div.desc', h('b', 'Foreign-key constraints:'), h('ul', fks.map((c) => { const ref = cat.rel(c.refRel); return h('li', '"' + c.name + '" FOREIGN KEY (' + c.cols.map((a) => r.cols[a].name).join(', ') + ') REFERENCES ' + (ref ? ref.name : '?') + '(' + c.refCols.map((a) => ref.cols[a].name).join(', ') + ')' + (c.onDelete !== 'no action' ? ' ON DELETE ' + c.onDelete.toUpperCase() : '') + (c.onUpdate !== 'no action' ? ' ON UPDATE ' + c.onUpdate.toUpperCase() : '')); }))));
    const refs = (r.referencedBy || []).map((x) => ({ t: cat.rel(x.rel), name: x.name })).filter((x) => x.t);
    if (refs.length) body.appendChild(h('div.desc', h('b', 'Referenced by:'), h('ul', refs.map((x) => h('li', 'TABLE "' + x.t.name + '" CONSTRAINT "' + x.name + '"')))));
    if (r.kind !== 'table') body.appendChild(h('div.desc', h('b', 'View definition:'), h('pre', r.queryText)));
    UI.dialog((r.kind === 'table' ? 'Table' : 'View') + ' "' + r.schema + '.' + r.name + '"', body, { wide: true });
  }

  UI.Schema = { render, describe, quoteRel: qi };
})(typeof window !== 'undefined' ? window : globalThis);
