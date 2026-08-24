// A cluster node: an actor on the simulated network that owns a real Kwery database. Rows move between nodes as
// text (the engine's output form) and go back in through ordinary SQL, so every fragment of distributed work is
// SQL that the node's engine runs. The engine has no recovery of its own here: a crash keeps committed data (as
// if the disk survived) and rolls back what was in progress, which is what a restarted database looks like.
(function (root) {
  'use strict';
  const K = root.K;
  const C = K.Cluster = K.Cluster || {};

  const lit = (v) => (v === null || v === undefined ? 'null' : "'" + String(v).replace(/'/g, "''") + "'");
  C.lit = lit;
  const ident = (s) => (/^[a-z_][a-z0-9_]*$/.test(s) ? s : '"' + String(s).replace(/"/g, '""') + '"');
  C.ident = ident;

  /** an engine result as text: { cols: [{ name, type }], rows: [[text|null]] } with type the SQL spelling */
  function textResult(r) {
    if (!r || !r.cols) return { cols: [], rows: [], tag: r ? r.tag : null };
    const cols = r.cols.map((c) => ({ name: c.name, type: K.T.sqlName(c.type) }));
    const rows = r.rows.map((row) => row.map((v, i) => (v === null || v === undefined ? null : K.T.output(v, r.cols[i].type))));
    return { cols, rows, tag: r.tag };
  }
  C.textResult = textResult;
  /** the bytes a row takes on the wire: its text values plus a length word each */
  C.rowBytes = (row) => row.reduce((n, v) => n + (v === null ? 1 : String(v).length + 4), 4);

  class Node extends C.Actor {
    constructor(id, opts) {
      super(id);
      opts = opts || {};
      this.db = new K.Database(opts.db || {});
      this.s = this.db.session({ name: String(id) });
      this.role = opts.role || null;
      this.sqlLog = [];
      this.logSql = opts.logSql !== false;
    }
    /** run SQL on this node's engine; returns the engine results */
    exec(sql) { if (this.logSql) this.sqlLog.push({ t: this.net ? this.net.clock : 0, sql }); return this.s.exec(sql); }
    /** one statement, as text rows */
    query(sql) { const r = this.exec(sql); return textResult(r[r.length - 1]); }
    session(name) { return this.db.session({ name: String(this.id) + (name ? ':' + name : '') }); }
    createTable(name, cols, opts) {
      opts = opts || {};
      const pk = opts.primaryKey && opts.primaryKey.length ? ', primary key (' + opts.primaryKey.map(ident).join(', ') + ')' : '';
      this.exec((opts.replace ? 'drop table if exists ' + ident(name) + '; ' : '') + 'create table ' + ident(name) + ' (' + cols.map((c) => ident(c.name) + ' ' + c.type).join(', ') + pk + ')');
    }
    dropTable(name) { this.exec('drop table if exists ' + ident(name)); }
    /** insert text rows, in batches of multi-row INSERTs */
    insert(name, rows, cols) {
      const target = ident(name) + (cols ? ' (' + cols.map((c) => ident(c.name || c)).join(', ') + ')' : '');
      const stmts = [];
      for (let i = 0; i < rows.length; i += 400) stmts.push('insert into ' + target + ' values ' + rows.slice(i, i + 400).map((r) => '(' + r.map(lit).join(', ') + ')').join(', '));
      if (stmts.length) this.exec(stmts.join('; '));
      return rows.length;
    }
    tables() { return this.query("select table_name from information_schema.tables where table_schema = 'public' order by 1").rows.map((r) => r[0]); }
    table(name) { return Object.assign({ name }, this.query('select * from ' + ident(name))); }
    count(name) { return Number(this.query('select count(*) from ' + ident(name)).rows[0][0]); }
    /** every table's schema and rows */
    dump() { const out = {}; for (const t of this.tables()) { const r = this.table(t); out[t] = { cols: r.cols, rows: r.rows }; } return out; }
    load(dump) { for (const [t, d] of Object.entries(dump)) { this.createTable(t, d.cols, { replace: true }); this.insert(t, d.rows); } }
    /** a snapshot carries the role state and the data: a restore rebuilds the engine from it */
    snapshot() { return { state: C.clone(this.state), role: this.role, data: this.dump() }; }
    restore(s) {
      this.state = C.clone(s.state); this.role = s.role;
      this.db = new K.Database(); this.s = this.db.session({ name: String(this.id) });
      const log = this.logSql; this.logSql = false; this.load(s.data); this.logSql = log;
    }
    /** a crash rolls back the open transactions; committed rows stay */
    onCrash() { for (const s of this.db.sessions) { if (s.tx) { try { s.exec('rollback'); } catch (e) { s.lost(); } } } this.db.runners = []; }
    describe() { return { id: this.id, role: this.role, up: this.net ? this.net.isUp(this.id) : true, tables: this.tables().map((t) => ({ name: t, rows: this.count(t) })) }; }
  }
  C.Node = Node;

  /** a table's schema and rows as text, from a session or database */
  C.tableData = function (src, name) {
    const s = src.exec ? src : src.session();
    const r = textResult(s.query('select * from ' + ident(name)));
    return { name, cols: r.cols, rows: r.rows };
  };

  // The Theatre sample database, loaded once into a reference engine. The SQL text comes from
  // src/data/theatre.sql: the page fetches it and the tests read it, and either sets C.theatreSql.
  let th = null;
  C.theatre = function (sql) {
    if (sql) C.theatreSql = sql;
    if (th && (!sql || th.sql === sql)) return th;
    if (!C.theatreSql) throw new Error('set K.Cluster.theatreSql to the text of src/data/theatre.sql first');
    const db = new K.Database();
    const s = db.session({ name: 'reference' });
    s.exec(C.theatreSql);
    const names = ['venue', 'stage', 'company', 'person', 'artist', 'production', 'performance', 'casting', 'patron', 'booking', 'mentor'];
    const tables = {};
    for (const n of names) tables[n] = C.tableData(s, n);
    th = { sql: C.theatreSql, db, s, tables, names };
    return th;
  };
})(typeof window !== 'undefined' ? window : globalThis);
