// SQL dumps: CREATE statements for catalog objects and a whole database as a script that rebuilds it
// (types, sequences, tables with their rows, constraints, indexes, views), in the order pg_dump uses.
(function (root) {
  'use strict';
  const K = root.K;
  const T = () => K.T;

  const qi = (n) => (/^[a-z_][a-z0-9_]*$/.test(n) && !K.RESERVED.has(n) ? n : '"' + String(n).replace(/"/g, '""') + '"');
  const qn = (r) => (r.schema && r.schema !== 'public' ? qi(r.schema) + '.' : '') + qi(r.name);
  const lit = (v, t) => {
    if (v === null || v === undefined) return 'NULL';
    const s = T().output(v, t);
    if (t.cat === 'N' && /^-?[0-9.e+]+$/i.test(s)) return s;
    if (t.cat === 'B') return v ? 'true' : 'false';
    return "'" + s.replace(/'/g, "''") + "'";
  };

  function colDef(c) {
    let s = qi(c.name) + ' ' + (c.serial ? (c.type.id === 'int8' ? 'bigserial' : c.type.id === 'int2' ? 'smallserial' : 'serial') : T().sqlName(c.type));
    if (c.identity) s += ' generated ' + c.identity + ' as identity';
    if (c.generatedText) s += ' generated always as (' + c.generatedText + ') stored';
    if (c.defaultText && !c.serial) s += ' default ' + c.defaultText;
    if (c.notNull && !c.serial && !c.identity) s += ' not null';
    return s;
  }
  function constraintDef(r, c, cat) {
    const cols = (list) => list.map((a) => qi(r.cols[a].name)).join(', ');
    switch (c.kind) {
      case 'primary': return 'constraint ' + qi(c.name) + ' primary key (' + cols(c.cols) + ')';
      case 'unique': return 'constraint ' + qi(c.name) + ' unique (' + cols(c.cols) + ')';
      case 'check': return 'constraint ' + qi(c.name) + ' check (' + c.text + ')';
      case 'foreign': {
        const ref = cat.rel(c.refRel);
        let s = 'constraint ' + qi(c.name) + ' foreign key (' + cols(c.cols) + ') references ' + (ref ? qn(ref) + ' (' + c.refCols.map((a) => qi(ref.cols[a].name)).join(', ') + ')' : '?');
        if (c.match === 'full') s += ' match full';
        if (c.onDelete && c.onDelete !== 'no action') s += ' on delete ' + c.onDelete;
        if (c.onUpdate && c.onUpdate !== 'no action') s += ' on update ' + c.onUpdate;
        if (c.deferrable) s += ' deferrable' + (c.deferred ? ' initially deferred' : '');
        return s;
      }
    }
    return '';
  }
  /** CREATE TABLE (or VIEW) for one relation, constraints inline */
  function create(r, cat, opts) {
    opts = opts || {};
    if (r.kind === 'view') return 'create view ' + qn(r) + (r.colNames ? ' (' + r.colNames.map(qi).join(', ') + ')' : '') + ' as\n' + r.queryText.trim().replace(/;$/, '') + (r.check ? '\nwith ' + r.check + ' check option' : '') + ';';
    if (r.kind === 'matview') return 'create materialized view ' + qn(r) + ' as\n' + r.queryText.trim().replace(/;$/, '') + ';';
    if (r.kind === 'sequence') { const q = r.seq; return 'create sequence ' + qn(r) + ' as ' + T().sqlName(q.as) + ' increment by ' + q.inc + ' minvalue ' + q.min + ' maxvalue ' + q.max + ' start with ' + q.start + (q.cycle ? ' cycle' : '') + ';'; }
    const lines = r.cols.filter((c) => !c.dropped).map((c) => '  ' + colDef(c));
    const cons = (r.constraints || []).filter((c) => !opts.noForeign || c.kind !== 'foreign');
    for (const c of cons) lines.push('  ' + constraintDef(r, c, cat));
    return 'create table ' + qn(r) + ' (\n' + lines.join(',\n') + '\n);';
  }
  function indexDef(ix, cat) {
    const t = cat.rel(ix.table);
    return 'create ' + (ix.unique ? 'unique ' : '') + 'index ' + qi(ix.name) + ' on ' + qn(t) + (ix.method !== 'btree' ? ' using ' + ix.method : '') + ' (' + ix.keys.map((k) => (k.attnum !== undefined ? qi(t.cols[k.attnum].name) : '(' + k.name + ')') + (k.dir === 'desc' ? ' desc' : '') + (k.nulls ? ' nulls ' + k.nulls : '')).join(', ') + ')' + (ix.include && ix.include.length ? ' include (' + ix.include.map((a) => qi(t.cols[a].name)).join(', ') + ')' : '') + (ix.whereText ? ' where ' + ix.whereText : '') + ';';
  }
  /** a script that rebuilds the database as the session sees it */
  function sql(db, session) {
    const s = session || db.session({ name: 'dump' });
    const cat = s.catalog;
    const out = ['-- Kwery database dump', ''];
    for (const sc of cat.schemas.values()) if (!sc.system && !sc.temp && sc.name !== 'public') out.push('create schema ' + qi(sc.name) + ';');
    for (const t of cat.types.values()) {
      if (t.cat === 'E' && !t.domain) out.push('create type ' + qi(t.name) + ' as enum (' + t.labels.map((l) => "'" + l.replace(/'/g, "''") + "'").join(', ') + ');');
      else if (t.domain) out.push('create domain ' + qi(t.name) + ' as ' + T().sqlName(t.base) + (t.notNull ? ' not null' : '') + (t.defaultText ? ' default ' + t.defaultText : '') + (t.checks || []).map((c) => ' constraint ' + qi(c.name) + ' check (' + (c.text || '') + ')').join('') + ';');
      else if (t.cat === 'C') out.push('create type ' + qi(t.name) + ' as (' + t.fields.map((f) => qi(f.name) + ' ' + T().sqlName(f.type)).join(', ') + ');');
    }
    const tables = cat.tables(['table']).filter((r) => !cat.schema(r.schema).system && !cat.schema(r.schema).temp);
    // tables in an order where referenced ones come first; foreign keys that would loop are added after the data
    const order = [];
    const seen = new Set();
    const visit = (r, stack) => { if (seen.has(r.oid)) return; if (stack.has(r.oid)) return; stack.add(r.oid); for (const c of r.constraints) if (c.kind === 'foreign' && c.refRel !== r.oid) { const ref = cat.rel(c.refRel); if (ref) visit(ref, stack); } seen.add(r.oid); order.push(r); };
    for (const r of tables) visit(r, new Set());
    for (const r of cat.tables(['sequence'])) if (!r.ownedBy && !cat.schema(r.schema).temp) out.push(create(r, cat));
    out.push('');
    for (const r of order) out.push(create(r, cat, { noForeign: true }), '');
    for (const r of order) {
      const rows = [...db.liveRows(r, s.tx ? s.ctx([], {}) : { tx: { xids: new Set(), cid: 0 }, snap: db.xact.snapshot(null) })];
      if (!rows.length) continue;
      const cols = r.cols.map((c, i) => [c, i]).filter(([c]) => !c.dropped && !c.generated);
      const chunk = 200;
      for (let i = 0; i < rows.length; i += chunk) out.push('insert into ' + qn(r) + ' (' + cols.map(([c]) => qi(c.name)).join(', ') + ')' + (cols.some(([c]) => c.identity === 'always') ? ' overriding system value' : '') + ' values\n' + rows.slice(i, i + chunk).map((row) => '  (' + cols.map(([c, k]) => lit(row.vals[k], c.type)).join(', ') + ')').join(',\n') + ';');
      out.push('');
    }
    for (const r of order) for (const c of r.constraints) if (c.kind === 'foreign') out.push('alter table ' + qn(r) + ' add ' + constraintDef(r, c, cat) + ';');
    for (const r of cat.tables(['sequence'])) { const st = db.seqs.get(r.oid); if (st && st.called) out.push("select setval('" + qn(r) + "', " + st.last + ');'); }
    for (const ix of cat.tables(['index'])) if (!ix.constraint) out.push(indexDef(ix, cat));
    for (const v of cat.tables(['view', 'matview'])) if (!cat.schema(v.schema).temp) out.push('', create(v, cat));
    for (const list of cat.funcs.values()) for (const f of list) out.push('', 'create ' + (f.kind === 'procedure' ? 'procedure ' : 'function ') + qi(f.name) + '(' + f.params.map((p) => (p.mode !== 'in' ? p.mode + ' ' : '') + (p.name ? qi(p.name) + ' ' : '') + T().sqlName(p.type)).join(', ') + ')' + (f.kind === 'procedure' ? '' : ' returns ' + (f.setof ? 'setof ' : '') + (f.retType ? T().sqlName(f.retType) : 'void')) + ' language ' + f.lang + ' as $kw$' + f.body + '$kw$;');
    return out.join('\n') + '\n';
  }

  K.Dump = { sql, create, indexDef, colDef, quoteIdent: qi };
})(typeof window !== 'undefined' ? window : globalThis);
