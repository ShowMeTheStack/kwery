// Row stores and column stores (Ch. 13): the same table laid out row by row (as Kwery stores it) and column by
// column, with the pages a scan of some of its columns must read from each, worked out from the table's own data.
(function (root) {
  'use strict';
  const K = root.K;
  const UI = K.UI;
  const { h } = UI;

  function create(app, el) {
    let relName = UI.store.get('columns.rel', 'booking');
    let picked = new Set(UI.store.get('columns.cols', ['rating']));
    let rle = UI.store.get('columns.rle', true);
    el.appendChild(h('div.view-intro', h('b', 'Row stores and column stores. '), 'A row store keeps each row\'s values together on a page, so reading one column still reads every page of the table. A column store keeps each column in its own file, so a query reads only the columns it uses, and a column of repeated values compresses well. Analytical queries that touch a few columns of many rows gain the most.'));
    const body = h('div.view-body.cols');
    el.appendChild(body);
    const view = {
      onDb() { view.render(); },
      render() {
        body.innerHTML = '';
        const s = app.session, cat = s.catalog, db = app.db;
        const rels = cat.tables(['table']).filter((r) => !cat.schema(r.schema).system);
        const rel = rels.find((r) => r.name === relName) || rels[0];
        if (!rel) { body.appendChild(h('div.empty', 'There are no tables.')); return; }
        const cols = rel.cols.map((c, i) => [c, i]).filter(([c]) => !c.dropped);
        body.appendChild(h('div.qpl-row', h('select.inp', { 'aria-label': 'Table', onchange: (e) => { relName = e.target.value; UI.store.set('columns.rel', relName); picked = new Set(); view.render(); } }, rels.map((r) => h('option', { value: r.name, selected: r === rel }, r.name))),
          h('label.chk', h('input', { type: 'checkbox', checked: rle, onchange: (e) => { rle = e.target.checked; UI.store.set('columns.rle', rle); view.render(); } }), ' compress runs of equal values (in key order)')));
        body.appendChild(h('div.cols-pick', h('span.muted', 'The query reads: '), cols.map(([c]) => h('label.chk', h('input', { type: 'checkbox', checked: picked.has(c.name), onchange: (e) => { if (e.target.checked) picked.add(c.name); else picked.delete(c.name); UI.store.set('columns.cols', [...picked]); view.render(); } }), ' ' + c.name))));
        // the data: every live row's values, and each value's stored size
        const rows = [...db.liveRows(rel, { tx: { xids: new Set(), cid: 0 }, snap: db.xact.snapshot(null), session: s })].map((r) => r.vals);
        const usable = db.disk.pageSize - K.PAGE_HDR;
        const rowPages = Math.max(1, db.disk.blocks(rel.file));
        const colInfo = cols.map(([c, i]) => {
          const vals = rows.map((r) => r[i]);
          let bytes = 0;
          for (const v of vals) bytes += v === null ? 1 : K.T.encode(v, c.type).length + 1;
          // run-length encoding: in the column's sorted order, a run of equal values is stored once with its count
          let runs = 0, rleBytes = 0;
          if (rle) { const sorted = vals.slice().sort((a, b) => (a === null ? 1 : b === null ? -1 : K.T.compare(a, b, c.type))); for (let k = 0; k < sorted.length; k++) { if (k === 0 || K.keyOf(sorted[k]) !== K.keyOf(sorted[k - 1])) { runs++; rleBytes += (sorted[k] === null ? 1 : K.T.encode(sorted[k], c.type).length) + 4; } } }
          const stored = rle ? Math.min(bytes, rleBytes) : bytes;
          return { c, bytes, runs, stored, pages: Math.max(1, Math.ceil(stored / usable)) };
        });
        const need = colInfo.filter((x) => picked.has(x.c.name));
        const colPages = need.reduce((a, x) => a + x.pages, 0);
        const max = Math.max(rowPages, colPages, 1);
        const bar = (label, n, cls, note) => h('div.cols-bar', h('div.cb-l', label), h('div.cb-t', h('i.' + cls, { style: { width: Math.max(1.5, (n / max) * 100) + '%' } })), h('div.cb-n', UI.plural(n, 'page')), note ? h('div.cb-x', note) : null);
        body.appendChild(h('section.cols-res',
          bar('Row store (as stored)', rowPages, 'row', 'every page of ' + rel.name + ', whatever columns are used'),
          bar('Column store', need.length ? colPages : 0, 'col', need.length ? need.map((x) => x.c.name + ': ' + x.pages).join(', ') : 'choose the columns the query reads'),
          need.length ? h('p.cols-sum', 'A scan reading ' + need.map((x) => x.c.name).join(', ') + ' reads ' + (colPages < rowPages ? (rowPages / colPages).toFixed(1) + ' times fewer pages from the column store.' : colPages === rowPages ? 'as many pages either way.' : 'more pages from the column store: it has to read and stitch together several files.')) : null));
        body.appendChild(h('table.grid.small', h('thead', h('tr', ['Column', 'Type', 'Bytes', rle ? 'Runs' : null, rle ? 'Compressed' : null, 'Pages'].filter(Boolean).map((x) => h('th', x)))),
          h('tbody', colInfo.map((x) => h('tr' + (picked.has(x.c.name) ? '.best' : ''), h('td', x.c.name), h('td', K.T.sqlName(x.c.type)), h('td.num', x.bytes.toLocaleString('en-US')), rle ? h('td.num', String(x.runs)) : null, rle ? h('td.num', x.stored.toLocaleString('en-US')) : null, h('td.num', String(x.pages)))))));
        body.appendChild(h('p.muted', 'Sizes are the stored value sizes Kwery uses on its pages plus one byte per value for the null mask; page counts assume ' + db.disk.pageSize + '-byte pages. Kwery itself is a row store: the column store is worked out from the same data to compare.'));
      },
    };
    return view;
  }

  UI.registerView({ id: 'columns', title: 'Row vs column', icon: 'grid', group: 'Storage', order: 13, create });
})(typeof window !== 'undefined' ? window : globalThis);
