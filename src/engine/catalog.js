// The catalog: every schema, table, column, constraint, index, view, sequence, type, function, trigger, role
// and privilege. DDL is transactional: a transaction that changes the catalog works on a copy, which becomes
// the catalog when it commits and is thrown away if it rolls back.
(function (root) {
  'use strict';
  const K = root.K;
  const S = K.STATE;

  class Catalog {
    constructor(db) {
      this.db = db;
      this.nextOid = 16384; // user objects start here, as in PostgreSQL
      this.schemas = new Map(); // name -> { name, owner, objects: Map(name -> rel/type/...) }
      this.rels = new Map();    // oid -> relation (table, view, matview, index, sequence, toast)
      this.types = new Map();   // "schema.name" -> user type
      this.funcs = new Map();   // name -> [routine overloads]
      this.roles = new Map();   // name -> role
      this.assertions = new Map();
      this.version = 0;
      this.addSchema('pg_catalog', 'kwery', true);
      this.addSchema('information_schema', 'kwery', true);
      this.addSchema('public', 'kwery');
      this.roles.set('kwery', { name: 'kwery', superuser: true, login: true, member: new Set() });
      this.roles.set('public', { name: 'public', superuser: false, login: false, member: new Set(), group: true });
    }
    oid() { return this.nextOid++; }
    addSchema(name, owner, system) {
      if (this.schemas.has(name)) throw K.err(S.duplicateObject, 'schema "' + name + '" already exists');
      this.schemas.set(name, { name, owner: owner || 'kwery', system: !!system, objects: new Map(), acl: [] });
      this.version++;
    }
    schema(name, missingOk) {
      const s = this.schemas.get(name);
      if (!s && !missingOk) throw K.err(S.undefinedObject, 'schema "' + name + '" does not exist');
      return s || null;
    }
    /** look up a relation by (schema, name), following the session's search_path when no schema is given */
    lookup(qn, path, kinds) {
      const want = (r) => !kinds || kinds.includes(r.kind);
      // pg_temp names the session's own temporary schema, the one on its search path
      if (qn.schema === 'pg_temp') qn = { schema: (path || []).find((x) => x.startsWith('pg_temp_')) || 'pg_temp', name: qn.name };
      if (qn.schema) {
        const s = this.schema(qn.schema, true);
        const r = s && s.objects.get(qn.name);
        return r && r.oid !== undefined && want(r) ? r : null;
      }
      for (const sn of path || ['public']) {
        const s = this.schemas.get(sn === '$user' ? 'kwery' : sn);
        const r = s && s.objects.get(qn.name);
        if (r && r.oid !== undefined && want(r)) return r;
      }
      return null;
    }
    rel(oid) { return this.rels.get(oid) || null; }
    /** add a relation to its schema */
    addRel(r) {
      const s = this.schema(r.schema);
      if (s.objects.has(r.name)) {
        const o = s.objects.get(r.name);
        throw K.err(S.duplicateTable, 'relation "' + r.name + '" already exists' + (o.kind !== r.kind ? ' (as ' + (o.kind === 'index' ? 'an index' : 'a ' + o.kind) + ')' : ''));
      }
      if (r.oid === undefined) r.oid = this.oid();
      s.objects.set(r.name, r);
      this.rels.set(r.oid, r);
      this.version++;
      return r;
    }
    removeRel(r) {
      const s = this.schema(r.schema, true);
      if (s && s.objects.get(r.name) === r) s.objects.delete(r.name);
      this.rels.delete(r.oid);
      this.version++;
    }
    renameRel(r, to) {
      const s = this.schema(r.schema);
      if (s.objects.has(to)) throw K.err(S.duplicateTable, 'relation "' + to + '" already exists');
      s.objects.delete(r.name); r.name = to; s.objects.set(to, r);
      this.version++;
    }
    tables(kinds) { return [...this.rels.values()].filter((r) => (kinds || ['table']).includes(r.kind)); }
    indexesOf(rel) { return (rel.indexes || []).map((o) => this.rels.get(o)).filter(Boolean); }

    // ---- user types --------------------------------------------------------------------------------------------
    userType(name, path) {
      const n = K.lower(name);
      if (n.includes('.')) return this.types.get(n) || null;
      for (const sn of path || this.db.searchPath || ['public']) { const t = this.types.get(sn + '.' + n); if (t) return t; }
      const t = this.types.get('public.' + n) || this.types.get('pg_catalog.' + n);
      if (t) return t;
      // a table's row type can be used as a type too
      const r = this.lookup({ name: n }, path || this.db.searchPath, ['table', 'view', 'matview']);
      if (r) return this.rowType(r);
      return null;
    }
    addType(schema, t) {
      const key = schema + '.' + t.name;
      // a table, view or sequence has a row type of its own name, so it takes that type name
      const o = this.schema(schema).objects.get(t.name);
      // a composite type is a relation too: it cannot share a name with an index either
      if (o && o.kind === 'index' && t.cat === 'C' && !t.domain) throw K.err(S.duplicateTable, 'relation "' + t.name + '" already exists');
      if (this.types.has(key) || (o && (o.oid === undefined || o.kind !== 'index'))) throw K.err(S.duplicateObject, 'type "' + t.name + '" already exists');
      t.schema = schema;
      t.oid = this.oid();
      this.types.set(key, t);
      this.version++;
      return t;
    }
    rowType(r) { return { id: r.schema + '.' + r.name, name: r.name, cat: 'C', len: -1, fields: r.cols.filter((c) => !c.dropped).map((c) => ({ name: c.name, type: c.type })), rel: r.oid }; }

    // ---- functions -----------------------------------------------------------------------------------------------
    addFunc(f) {
      const list = this.funcs.get(f.name) || [];
      const same = list.findIndex((g) => g.schema === f.schema && g.params.length === f.params.length && g.params.every((p, i) => K.T.sqlName(p.type) === K.T.sqlName(f.params[i].type)));
      if (same >= 0) {
        if (!f.orReplace) throw K.err(S.duplicateObject, 'function ' + f.name + '(' + f.params.map((p) => K.T.sqlName(p.type)).join(', ') + ') already exists with same argument types');
        f.oid = list[same].oid;
        list[same] = f;
      } else { f.oid = this.oid(); list.push(f); }
      this.funcs.set(f.name, list);
      this.version++;
      return f;
    }
    userFuncs(name) { return this.funcs.get(name) || []; }

    // ---- copies for transactional DDL ------------------------------------------------------------------------------
    /** a deep copy of the catalog (relations keep their files: only metadata is copied) */
    clone() {
      const c = Object.create(Catalog.prototype);
      c.db = this.db;
      c.nextOid = this.nextOid;
      c.version = this.version;
      const relCopy = new Map();
      const copyRel = (r) => { if (relCopy.has(r.oid)) return relCopy.get(r.oid); const x = cloneObj(r); relCopy.set(r.oid, x); return x; };
      c.rels = new Map([...this.rels].map(([o, r]) => [o, copyRel(r)]));
      c.schemas = new Map([...this.schemas].map(([n, s]) => [n, Object.assign({}, s, { acl: s.acl.slice(), objects: new Map([...s.objects].map(([k, o]) => [k, o.oid !== undefined && relCopy.has(o.oid) ? relCopy.get(o.oid) : cloneObj(o)])) })]));
      c.types = new Map([...this.types].map(([k, t]) => [k, cloneObj(t)]));
      c.funcs = new Map([...this.funcs].map(([k, l]) => [k, l.map((f) => Object.assign({}, f))]));
      c.roles = new Map([...this.roles].map(([k, r]) => [k, Object.assign({}, r, { member: new Set(r.member) })]));
      c.assertions = new Map(this.assertions);
      return c;
    }
  }
  /** copy plain catalog objects; parsed trees, types and compiled caches are shared (they are never mutated) */
  function cloneObj(o) {
    if (o === null || typeof o !== 'object') return o;
    if (Array.isArray(o)) return o.map(cloneObj);
    if (o instanceof Map) return new Map([...o].map(([k, v]) => [k, cloneObj(v)]));
    if (o instanceof Set) return new Set(o);
    const out = {};
    for (const k of Object.keys(o)) {
      const v = o[k];
      out[k] = k === 'ast' || k === 'type' || k === 'compiled' || k === 'plan' || k === 'query' || k === 'expr' || k === 'base' || k === 'elem' || k === 'parsed' || k === 'fsm' || k === 'stats' || k === 'missing' ? (k === 'fsm' ? (v || []).slice() : v) : cloneObj(v);
    }
    return out;
  }

  K.Catalog = Catalog;
  K.cloneObj = cloneObj;
})(typeof window !== 'undefined' ? window : globalThis);
