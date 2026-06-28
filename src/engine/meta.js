// psql's backslash commands (\d, \dt, \di, \dv, \ds, \df, \dn, \du, \dT, \l, \?), answered from the catalog
// in the shape psql prints them, so a script written for psql runs here too.
(function (root) {
  'use strict';
  const K = root.K;
  const T = () => K.T;
  const B = () => K.T.BASE;

  const res = (title, cols, rows) => { const r = new K.Result('\\' + title, cols.map((c) => ({ name: c, type: B().text })), rows); r.meta = title; return r; };
  const like = (pat) => (pat ? new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$') : null);
  const kindName = { table: 'table', view: 'view', matview: 'materialized view', index: 'index', sequence: 'sequence' };

  function list(s, kinds, pat) {
    const cat = s.catalog, re = like(pat);
    const rows = cat.tables(kinds).filter((r) => !cat.schema(r.schema).system && (!re || re.test(r.name))).sort((a, b) => (a.schema + a.name < b.schema + b.name ? -1 : 1));
    return res('d', ['Schema', 'Name', 'Type', 'Owner'].concat(kinds.includes('index') ? ['Table'] : []), rows.map((r) => [r.schema, r.name, kindName[r.kind], r.owner].concat(kinds.includes('index') ? [r.table !== undefined && cat.rel(r.table) ? cat.rel(r.table).name : ''] : [])));
  }
  /** \d name: the columns, then indexes, constraints and references, as psql's footer lines */
  function describe(s, name) {
    const cat = s.catalog;
    const parts = name.replace(/"/g, '').split('.');
    const r = cat.lookup(parts.length > 1 ? { schema: parts[0], name: parts[1] } : { name: parts[0] }, s.searchPath());
    if (!r) throw K.err(K.STATE.undefinedTable, 'Did not find any relation named "' + name + '".');
    if (r.kind === 'index') {
      const t = cat.rel(r.table);
      const out = res('d', ['Column', 'Type', 'Key?', 'Definition'], r.keys.map((k, i) => [k.attnum !== undefined ? t.cols[k.attnum].name : k.name, T().sqlName(r.keyTypes[i]), 'yes', k.attnum !== undefined ? t.cols[k.attnum].name : k.name]));
      out.footer = [(r.primary ? 'primary key, ' : r.unique ? 'unique, ' : '') + r.method + ', for table "' + t.schema + '.' + t.name + '"'];
      out.title = 'Index "' + r.schema + '.' + r.name + '"';
      return out;
    }
    if (r.kind === 'sequence') {
      const q = r.seq;
      const out = res('d', ['Type', 'Start', 'Minimum', 'Maximum', 'Increment', 'Cycles?'], [[T().sqlName(q.as), String(q.start), String(q.min), String(q.max), String(q.inc), q.cycle ? 'yes' : 'no']]);
      out.title = 'Sequence "' + r.schema + '.' + r.name + '"';
      return out;
    }
    const rows = r.cols.filter((c) => !c.dropped).map((c) => [c.name, T().sqlName(c.type), c.collate || '', c.notNull ? 'not null' : '', c.identity ? 'generated ' + c.identity + ' as identity' : c.generatedText ? 'generated always as (' + c.generatedText + ') stored' : c.defaultText || '']);
    const out = res('d', ['Column', 'Type', 'Collation', 'Nullable', 'Default'], rows);
    out.title = (r.kind === 'view' ? 'View' : r.kind === 'matview' ? 'Materialized view' : 'Table') + ' "' + r.schema + '.' + r.name + '"';
    const foot = [];
    const idx = cat.indexesOf(r);
    if (idx.length) { foot.push('Indexes:'); for (const ix of idx) foot.push('    "' + ix.name + '"' + (ix.primary ? ' PRIMARY KEY,' : ix.unique ? ' UNIQUE CONSTRAINT,' : '') + ' ' + ix.method + ' (' + ix.keys.map((k) => (k.attnum !== undefined ? r.cols[k.attnum].name : k.name) + (k.dir === 'desc' ? ' DESC' : '')).join(', ') + ')' + (ix.whereText ? ' WHERE ' + ix.whereText : '')); }
    const checks = (r.constraints || []).filter((c) => c.kind === 'check');
    if (checks.length) { foot.push('Check constraints:'); for (const c of checks) foot.push('    "' + c.name + '" CHECK (' + c.text + ')'); }
    const fks = (r.constraints || []).filter((c) => c.kind === 'foreign');
    if (fks.length) { foot.push('Foreign-key constraints:'); for (const c of fks) { const ref = cat.rel(c.refRel); foot.push('    "' + c.name + '" FOREIGN KEY (' + c.cols.map((a) => r.cols[a].name).join(', ') + ') REFERENCES ' + (ref ? ref.name + '(' + c.refCols.map((a) => ref.cols[a].name).join(', ') + ')' : '?') + (c.onUpdate !== 'no action' ? ' ON UPDATE ' + c.onUpdate.toUpperCase() : '') + (c.onDelete !== 'no action' ? ' ON DELETE ' + c.onDelete.toUpperCase() : '')); } }
    const refs = (r.referencedBy || []).map((x) => ({ t: cat.rel(x.rel), name: x.name })).filter((x) => x.t);
    if (refs.length) { foot.push('Referenced by:'); for (const x of refs) { const c = x.t.constraints.find((y) => y.name === x.name); foot.push('    TABLE "' + x.t.name + '" CONSTRAINT "' + x.name + '" FOREIGN KEY (' + (c ? c.cols.map((a) => x.t.cols[a].name).join(', ') : '') + ') REFERENCES ' + r.name + '(' + (c ? c.refCols.map((a) => r.cols[a].name).join(', ') : '') + ')'); } }
    if (r.triggers && r.triggers.length) { foot.push('Triggers:'); for (const t of r.triggers) foot.push('    ' + t.name + ' ' + t.timing.toUpperCase() + ' ' + t.events.map((e) => e.event.toUpperCase()).join(' OR ') + ' ON ' + r.name + ' FOR EACH ' + t.forEach.toUpperCase() + ' EXECUTE FUNCTION ' + t.func + '()'); }
    if (r.kind === 'view' || r.kind === 'matview') { foot.push('View definition:'); foot.push(' ' + r.queryText.trim().replace(/;?$/, ';')); }
    out.footer = foot;
    return out;
  }
  const HELP = [
    ['\\d [NAME]', 'list tables, views and sequences, or describe a table, view, sequence or index'],
    ['\\dt [PATTERN]', 'list tables'], ['\\di [PATTERN]', 'list indexes'], ['\\dv [PATTERN]', 'list views'], ['\\dm [PATTERN]', 'list materialized views'],
    ['\\ds [PATTERN]', 'list sequences'], ['\\df [PATTERN]', 'list functions and procedures'], ['\\dn', 'list schemas'], ['\\du', 'list roles'],
    ['\\dT [PATTERN]', 'list user-defined types and domains'], ['\\l', 'list databases'], ['\\conninfo', 'the session you are connected as'], ['\\?', 'this help'],
  ];

  /** run one backslash command line */
  function run(s, line) {
    const m = /^\\(\S+)\s*(.*)$/.exec(line.trim());
    if (!m) throw K.err(K.STATE.syntax, 'invalid command \\');
    const cmd = m[1].replace(/\+$/, ''), arg = m[2].trim().replace(/;$/, '') || null;
    const cat = s.catalog;
    switch (cmd) {
      case 'd': return arg ? describe(s, arg) : list(s, ['table', 'view', 'matview', 'sequence']);
      case 'dt': return list(s, ['table'], arg);
      case 'di': return list(s, ['index'], arg);
      case 'dv': return list(s, ['view'], arg);
      case 'dm': return list(s, ['matview'], arg);
      case 'ds': return list(s, ['sequence'], arg);
      case 'df': { const re = like(arg); return res('df', ['Schema', 'Name', 'Result data type', 'Argument data types', 'Type'], [...cat.funcs.values()].flat().filter((f) => !re || re.test(f.name)).map((f) => [f.schema, f.name, f.kind === 'procedure' ? '' : (f.setof ? 'SETOF ' : '') + (f.retType ? T().sqlName(f.retType) : 'void'), f.params.map((p) => (p.mode !== 'in' ? p.mode.toUpperCase() + ' ' : '') + (p.name ? p.name + ' ' : '') + T().sqlName(p.type)).join(', '), f.kind === 'procedure' ? 'proc' : 'func'])); }
      case 'dn': return res('dn', ['Name', 'Owner'], [...cat.schemas.values()].filter((x) => !x.system).map((x) => [x.name, x.owner]));
      case 'du': case 'dg': return res('du', ['Role name', 'Attributes', 'Member of'], [...cat.roles.values()].filter((r) => r.name !== 'public').map((r) => [r.name, [r.superuser ? 'Superuser' : '', r.login ? '' : 'Cannot login'].filter(Boolean).join(', '), '{' + [...cat.roles.values()].filter((g) => g.member.has(r.name)).map((g) => g.name).join(',') + '}']));
      case 'dT': { const re = like(arg); return res('dT', ['Schema', 'Name', 'Description'], [...cat.types.values()].filter((t) => !re || re.test(t.name)).map((t) => [t.schema, t.name, t.domain ? 'domain over ' + T().sqlName(t.base) : t.cat === 'E' ? 'enum (' + t.labels.join(', ') + ')' : 'composite (' + t.fields.map((f) => f.name + ' ' + T().sqlName(f.type)).join(', ') + ')'])); }
      case 'l': return res('l', ['Name', 'Owner', 'Encoding'], [['kwery', 'kwery', 'UTF8']]);
      case 'conninfo': { const r = res('conninfo', ['Info'], [['You are connected to database "kwery" as user "' + s.user + '" in session ' + s.id + ' (' + s.name + ').']]); return r; }
      case '?': case 'h': case 'help': return res('?', ['Command', 'What it does'], HELP);
    }
    throw K.err(K.STATE.syntax, 'invalid command \\' + cmd, { hint: 'Try \\? for help.' });
  }
  /** split a script into SQL pieces and backslash lines, in order */
  function split(src) {
    const out = [];
    let buf = '';
    for (const line of src.split('\n')) {
      if (/^\s*\\/.test(line) && !/\$\w*\$/.test(buf)) { if (buf.trim()) out.push({ sql: buf }); buf = ''; out.push({ meta: line.trim() }); }
      else buf += line + '\n';
    }
    if (buf.trim()) out.push({ sql: buf });
    return out;
  }

  K.Meta = { run, split, describe, HELP };
})(typeof window !== 'undefined' ? window : globalThis);
