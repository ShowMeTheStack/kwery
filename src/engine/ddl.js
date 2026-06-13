// Data definition: CREATE, ALTER and DROP for schemas, tables, constraints, indexes, views, materialized
// views, sequences, types, domains, functions and procedures, triggers, roles; TRUNCATE; privileges. Every
// change goes to the transaction's own copy of the catalog, so DDL commits and rolls back like any other change.
(function (root) {
  'use strict';
  const K = root.K;
  const S = K.STATE;
  const B = () => K.T.BASE;
  const T = () => K.T;

  const qn = (n) => (n.schema ? n.schema + '.' : '') + n.name;

  class DDL {
    constructor(db) { this.db = db; }

    /** run one DDL statement; a generator (it takes locks) that returns the command tag */
    *run(st, ctx) {
      const s = ctx.session;
      const cat = yield* s.catalogForWrite(ctx);
      const fn = this[st.type];
      if (!fn) throw K.err(S.featureNotSupported, st.type + ' is not supported');
      return yield* fn.call(this, st, ctx, cat, s);
    }
    schemaOf(n, s, cat, temp) {
      // temporary objects live in the session's own pg_temp_N schema, made when first needed
      if (temp || n.schema === 'pg_temp') {
        if (n.schema && n.schema !== 'pg_temp' && n.schema !== s.tempSchemaName()) throw K.err('42P16', 'cannot create temporary relation in non-temporary schema');
        const t = s.tempSchemaName();
        if (!cat.schemas.has(t)) { cat.addSchema(t, s.user); cat.schema(t).temp = true; }
        return t;
      }
      const name = n.schema || s.searchPath().find((x) => x !== 'pg_catalog' && x !== '$user' && !x.startsWith('pg_temp_') && cat.schemas.has(x)) || 'public';
      const sc = cat.schema(name, true);
      if (!sc) throw K.err(S.undefinedObject, 'schema "' + name + '" does not exist');
      if (sc.system && !s.superuser()) throw K.err(S.insufficientPrivilege, 'permission denied to create "' + name + '.' + n.name + '"', { detail: 'System catalog modifications are currently disallowed.' });
      return name;
    }
    rel(cat, s, n, kinds, missingOk) {
      const r = cat.lookup(n, s.searchPath(), kinds);
      if (!r && !missingOk) {
        const any = cat.lookup(n, s.searchPath());
        if (any) throw K.err(S.wrongObjectType || '42809', '"' + qn(n) + '" is not a ' + (kinds[0] === 'matview' ? 'materialized view' : kinds[0]));
        throw K.err(kinds[0] === 'table' || kinds[0] === 'view' || kinds[0] === 'matview' || kinds[0] === 'sequence' ? S.undefinedTable : S.undefinedObject, (kinds[0] === 'index' ? 'index' : kinds[0] === 'sequence' ? 'sequence' : kinds[0] === 'view' ? 'view' : 'relation') + ' "' + qn(n) + '" does not exist');
      }
      return r;
    }
    *lock(ctx, rel, mode) { yield* this.db.locks.acquire(ctx.tx, 'table:' + rel.oid, 'table', mode, { what: 'relation ' + rel.name }); }
    owner(s, rel) { if (!s.superuser() && rel.owner !== s.user) throw K.err(S.insufficientPrivilege, 'must be owner of ' + (rel.kind === 'index' ? 'index' : rel.kind === 'view' ? 'view' : rel.kind === 'sequence' ? 'sequence' : 'table') + ' ' + rel.name); }

    // ---- schemas ------------------------------------------------------------------------------------------------
    *createSchema(st, ctx, cat, s) {
      if (cat.schemas.has(st.name)) { if (st.ifNotExists) { s.notice('schema "' + st.name + '" already exists, skipping'); return 'CREATE SCHEMA'; } throw K.err(S.duplicateObject === '42710' ? '42P06' : S.duplicateObject, 'schema "' + st.name + '" already exists'); }
      cat.addSchema(st.name, s.user);
      return 'CREATE SCHEMA';
    }

    // ---- tables -------------------------------------------------------------------------------------------------
    *createTable(st, ctx, cat, s) {
      // table inheritance and declarative partitioning are not modelled: refuse them rather than ignore them
      if (st.inherits) throw K.err(S.featureNotSupported, 'INHERITS is not supported in Kwery');
      if (st.partitionBy) throw K.err(S.featureNotSupported, 'PARTITION BY is not supported in Kwery');
      if (st.onCommit && !st.temp) throw K.err('42P16', 'ON COMMIT can only be used on temporary tables');
      if (st.onCommit && st.onCommit !== 'preserve') throw K.err(S.featureNotSupported, 'ON COMMIT ' + (st.onCommit === 'drop' ? 'DROP' : 'DELETE ROWS') + ' is not supported in Kwery');
      const schema = this.schemaOf(st.name, s, cat, st.temp);
      const existing = cat.schema(schema).objects.get(st.name.name);
      if (existing) {
        if (st.ifNotExists) { s.notice('relation "' + st.name.name + '" already exists, skipping'); return st.as ? 'SELECT 0' : 'CREATE TABLE'; }
        throw K.err(S.duplicateTable, 'relation "' + st.name.name + '" already exists');
      }
      const ty = cat.types.get(schema + '.' + st.name.name);
      if (ty && !st.ifNotExists) throw ty.cat === 'C' && !ty.domain ? K.err(S.duplicateTable, 'relation "' + st.name.name + '" already exists') : K.err(S.duplicateObject, 'type "' + st.name.name + '" already exists');
      if (st.as) return yield* this.createTableAs(st, ctx, cat, s, schema);
      if (st.partitionOf) throw K.err(S.featureNotSupported, 'partitioned tables are shown in the sharding workbench; CREATE TABLE ... PARTITION OF is not supported here', { pos: st.pos });
      const rel = { kind: 'table', schema, name: st.name.name, owner: s.user, cols: [], constraints: [], indexes: [], pk: null, acl: [], triggers: [], temp: !!(st.temp || cat.schema(schema).temp), deps: new Set(), created: this.db.clock() };
      const cols = st.cols.slice();
      if (st.like) {
        const src = this.rel(cat, s, st.like.name, ['table', 'view', 'matview']);
        const inc = new Set(st.like.including.map(K.lower));
        for (const c of src.cols) if (!c.dropped) cols.push({ name: c.name, typeObj: c.type, notNullLike: c.notNull, defaultLike: inc.has('defaults') || inc.has('all') ? c : null, constraints: [] });
      }
      if (st.ofType) { const t = cat.userType(qn(st.ofType), s.searchPath()); if (!t || t.cat !== 'C') throw K.err(S.undefinedObject, 'type "' + qn(st.ofType) + '" does not exist'); for (const f of t.fields) cols.push({ name: f.name, typeObj: f.type, constraints: [] }); }
      if (!cols.length && !st.constraints.length && !st.ofType && !st.like) { /* a table with no columns is allowed */ }
      const seen = new Set();
      for (const c of cols) {
        if (seen.has(c.name)) throw K.err(S.duplicateColumn, 'column "' + c.name + '" specified more than once', { pos: c.pos });
        seen.add(c.name);
        rel.cols.push(this.columnOf(c, rel, cat, s));
      }
      rel.file = this.db.newFile(schema + '.' + rel.name, 'heap');
      cat.addRel(rel);
      for (const c of rel.cols) if (c.generated) this.checkGenerated(rel, c, s);
      // column constraints, then table constraints
      const pending = [];
      for (const c of cols) {
        const attnum = rel.cols.findIndex((x) => x.name === c.name);
        if (c.notNullLike) rel.cols[attnum].notNull = true;
        if (c.defaultLike) { rel.cols[attnum].default = c.defaultLike.default; rel.cols[attnum].defaultText = c.defaultLike.defaultText; }
        for (const k of c.constraints || []) {
          if (k.kind === 'notnull') { rel.cols[attnum].notNull = true; continue; }
          if (k.kind === 'null') continue;
          pending.push(Object.assign({}, k, { cols: k.kind === 'foreign' ? [c.name] : [c.name], text: k.text }));
        }
      }
      for (const k of st.constraints) pending.push(k);
      // the primary key first, so foreign keys to this same table can find it
      pending.sort((a, b) => (a.kind === 'primary' ? -1 : 0) - (b.kind === 'primary' ? -1 : 0));
      for (const k of pending) yield* this.addConstraint(rel, k, ctx, cat, s, true);
      for (const c of rel.cols) if (c.serial || c.identity) yield* this.ownSequence(rel, c, ctx, cat, s);
      this.db.bus.emit('ddl.create', { kind: 'table', name: rel.name, oid: rel.oid });
      return 'CREATE TABLE';
    }
    /** a column from its definition: the type, NOT NULL, DEFAULT, identity, generated */
    columnOf(c, rel, cat, s) {
      let type = c.typeObj || this.typeOf(c.type, cat, s, c.pos);
      const col = { name: c.name, type, notNull: false };
      if (type.serial) { col.type = Object.assign({}, type); delete col.type.serial; col.serial = true; col.notNull = true; }
      if (type.cat === 'P' && type.id !== 'unknown') throw K.err(S.datatypeMismatch, 'column "' + c.name + '" has pseudo-type ' + type.name);
      if (c.default) { col.default = c.default; col.defaultText = c.defaultText; }
      if (c.identity) {
        const where = ' for column "' + c.name + '" of table "' + rel.name + '"';
        if (c.multiIdentity) throw K.err(S.syntax, 'multiple identity specifications' + where);
        if (c.default || col.serial) throw K.err(S.syntax, 'both default and identity specified' + where);
        if (!['int2', 'int4', 'int8'].includes(type.domain ? type.base.id : type.id)) throw K.err(S.invalidParameter, 'identity column type must be smallint, integer, or bigint');
        col.identity = c.identity; col.notNull = true; col.seqOpts = c.seqOpts;
      }
      if (c.generated && (c.default || c.identity)) throw K.err(S.syntax, 'both ' + (c.default ? 'default' : 'identity') + ' and generation expression specified for column "' + c.name + '" of table "' + rel.name + '"');
      if (c.generated) { col.generated = c.generated; col.generatedText = c.generatedText; }
      if (c.collate) col.collate = c.collate;
      if (type.domain && type.notNull) col.domainNotNull = true;
      return col;
    }
    /** a generation expression may use only plain columns of its table and immutable functions */
    checkGenerated(rel, col, s) {
      for (const n of this.checkCols(rel, col.generated)) if (rel.cols.find((c) => c.name === n && !c.dropped).generated) throw K.err('42P17', 'cannot use generated column "' + n + '" in column generation expression', { detail: 'A generated column cannot reference another generated column.' });
      const f = this.db.tableExpr(s, rel, col.generated, 'generation expression', { type: col.type });
      let mutable = false;
      new K.Binder(s).walk(f.bound, (x) => { if ((x.k === 'call' && x.def.volatile) || x.k === 'udf') mutable = true; }, true);
      if (mutable) throw K.err('42P17', 'generation expression is not immutable');
    }
    typeOf(tn, cat, s, pos) {
      const t = T().byName(tn.name, tn.mods, cat);
      if (!t) throw K.err(S.undefinedObject, 'type "' + tn.name + '" does not exist', { pos: pos !== undefined ? pos : tn.pos });
      let out = tn.field && t.id === 'interval' ? Object.assign({}, t, { field: tn.field }) : t;
      for (let i = 0; i < (tn.dims || 0); i++) out = T().arrayOf(out);
      return out;
    }
    /** serial and identity columns get a sequence owned by the column */
    *ownSequence(rel, c, ctx, cat, s) {
      let name = rel.name + '_' + c.name + '_seq';
      for (let i = 1; cat.schema(rel.schema).objects.has(name); i++) name = rel.name + '_' + c.name + '_seq' + i;
      const max = c.type.id === 'int2' ? 32767n : c.type.id === 'int4' ? 2147483647n : 9223372036854775807n;
      const o = c.seqOpts || {};
      const seq = this.makeSequence(rel.schema, name, Object.assign({ as: null }, o), s, c.type, max);
      seq.ownedBy = { rel: rel.oid, col: c.name };
      cat.addRel(seq);
      c.seq = seq.oid;
      if (c.serial) { c.default = { k: 'fn', name: 'nextval', args: [{ k: 'lit', v: name, type: 'str' }] }; c.defaultText = "nextval('" + name + "'::regclass)"; }
      rel.deps.add(seq.oid);
    }
    *createTableAs(st, ctx, cat, s, schema) {
      const r = yield* s.runQueryForDDL(st.as, ctx);
      const rel = { kind: 'table', schema, name: st.name.name, owner: s.user, cols: [], constraints: [], indexes: [], pk: null, acl: [], triggers: [], temp: !!(st.temp || cat.schema(schema).temp), deps: new Set() };
      const names = st.name.cols || [];
      r.cols.forEach((c, i) => rel.cols.push({ name: names[i] || c.name, type: c.type.cat === 'P' ? B().text : c.type, notNull: false }));
      rel.file = this.db.newFile(schema + '.' + rel.name, 'heap');
      cat.addRel(rel);
      let n = 0;
      if (st.withData !== false) for (const row of r.rows) { yield* this.db.dml.insertRow(rel, row.slice(), ctx, { skipChecks: true }); n++; }
      return 'SELECT ' + n;
    }
    /** add a constraint (from CREATE TABLE or ALTER TABLE ADD); existing rows are checked */
    *addConstraint(rel, k, ctx, cat, s, creating) {
      const attnums = (k.cols || []).map((name) => {
        const i = rel.cols.findIndex((c) => c.name === name && !c.dropped);
        if (i < 0) throw K.err(S.undefinedColumn, 'column "' + name + '" named in key does not exist', { pos: k.pos });
        return i;
      });
      const names = new Set(rel.constraints.map((x) => x.name));
      const pick = (base) => { let n = base, i = 1; while (names.has(n) || cat.schema(rel.schema).objects.has(n)) n = base + (i++); return n; };
      const colPart = (k.cols || []).join('_');
      switch (k.kind) {
        case 'primary': case 'unique': {
          if (k.kind === 'primary' && rel.pk) throw K.err(S.invalidTableDefinition || '42P16', 'multiple primary keys for table "' + rel.name + '" are not allowed', { pos: k.pos });
          const name = k.name || pick(rel.name + (k.kind === 'primary' ? '_pkey' : '_' + colPart + '_key'));
          if (k.kind === 'primary') { for (const a of attnums) rel.cols[a].notNull = true; rel.pk = attnums; }
          const idx = yield* this.buildIndex(rel, { name, method: 'btree', cols: attnums.map((a) => ({ col: rel.cols[a].name })), unique: true, primary: k.kind === 'primary', constraint: name, include: k.include, nullsDistinct: k.nullsDistinct }, ctx, cat, s);
          rel.constraints.push({ name, kind: k.kind, cols: attnums, index: idx.oid, deferrable: !!k.deferrable, deferred: !!k.deferred });
          return;
        }
        case 'check': {
          const name = k.name || pick(rel.name + '_' + (colPart || (this.checkCols(rel, k.expr)[0] || '')) + '_check').replace(/__/, '_');
          const c = { name, kind: 'check', expr: k.expr, text: k.text, noInherit: k.noInherit };
          // bind it now, to report mistakes when the constraint is created
          this.db.tableExpr(s, rel, k.expr, 'check constraint', { bool: true });
          if (!creating && !k.notValid) yield* this.validateCheck(rel, c, ctx);
          rel.constraints.push(c);
          return;
        }
        case 'foreign': {
          const ref = this.rel(cat, s, k.refTable, ['table']);
          let refCols;
          if (k.refCols) refCols = k.refCols.map((n) => { const i = ref.cols.findIndex((c) => c.name === n && !c.dropped); if (i < 0) throw K.err(S.undefinedColumn, 'column "' + n + '" referenced in foreign key constraint does not exist'); return i; });
          else { if (!ref.pk) throw K.err(S.undefinedObject, 'there is no primary key for referenced table "' + ref.name + '"'); refCols = ref.pk.slice(); }
          if (refCols.length !== attnums.length) throw K.err(S.invalidForeignKey || '42830', 'number of referencing and referenced columns for foreign key disagree');
          // the referenced columns need a unique index
          const uidx = cat.indexesOf(ref).find((ix) => ix.unique && !ix.where && ix.keys.length === refCols.length && ix.keys.every((x) => refCols.includes(x.attnum)));
          if (!uidx) throw K.err('42830', 'there is no unique constraint matching given keys for referenced table "' + ref.name + '"');
          attnums.forEach((a, i) => { const lt = rel.cols[a].type, rt = ref.cols[refCols[i]].type; try { T().common([lt, rt], 'foreign key'); } catch (e) { throw K.err(S.datatypeMismatch, 'foreign key constraint "' + (k.name || '') + '" cannot be implemented', { detail: 'Key columns "' + rel.cols[a].name + '" and "' + ref.cols[refCols[i]].name + '" are of incompatible types: ' + T().sqlName(lt) + ' and ' + T().sqlName(rt) + '.' }); } });
          const name = k.name || pick(rel.name + '_' + colPart + '_fkey');
          const c = { name, kind: 'foreign', cols: attnums, refRel: ref.oid, refCols, refIndex: uidx.oid, onDelete: k.onDelete || 'no action', onUpdate: k.onUpdate || 'no action', match: k.match || 'simple', deferrable: !!k.deferrable, deferred: !!k.deferred };
          if (k.setCols) c.setCols = k.setCols.map((n) => { const i = rel.cols.findIndex((x) => x.name === n && !x.dropped); if (!attnums.includes(i)) throw K.err(S.invalidForeignKey || '42830', 'column "' + n + '" referenced in ON DELETE ' + k.onDelete.toUpperCase() + ' action must be part of foreign key'); return i; });
          if (ref !== rel) yield* this.lock(ctx, ref, 'share row exclusive');
          if (!creating && !k.notValid) yield* this.validateForeign(rel, c, ref, ctx);
          rel.constraints.push(c);
          if (!ref.referencedBy) ref.referencedBy = [];
          ref.referencedBy.push({ rel: rel.oid, name });
          return;
        }
        case 'exclude': throw K.err(S.featureNotSupported, 'EXCLUDE constraints are not supported', { pos: k.pos });
      }
      throw K.err(S.featureNotSupported, 'constraint type ' + k.kind + ' is not supported');
    }
    checkCols(rel, e) { const out = []; const walk = (x) => { if (!x || typeof x !== 'object') return; if (Array.isArray(x)) return x.forEach(walk); if (x.k === 'col' && x.parts.length === 1 && rel.cols.some((c) => c.name === x.parts[0])) out.push(x.parts[0]); for (const v of Object.values(x)) if (v && typeof v === 'object') walk(v); }; walk(e); return out; }
    *validateCheck(rel, c, ctx) {
      const f = this.db.tableExpr(ctx.session, rel, c.expr, 'check constraint', { bool: true });
      for (const row of this.db.liveRows(rel, ctx)) { if (f(row.vals, ctx) === false) throw K.err(S.checkViolation, 'check constraint "' + c.name + '" of relation "' + rel.name + '" is violated by some row'); }
    }
    *validateForeign(rel, c, ref, ctx) {
      // both tables are locked against writers: when the key types match, the referenced keys go in one hash set
      // instead of an index probe per row
      const types = c.refCols.map((a) => ref.cols[a].type);
      const keys = c.cols.every((a, i) => rel.cols[a].type.id === types[i].id) ? new Set() : null;
      if (keys) for (const row of this.db.visibleRows(ref, ctx)) { const k = c.refCols.map((a) => row.vals[a]); if (!k.some((v) => v === null)) keys.add(K.hashKey(k, types)); }
      for (const row of this.db.liveRows(rel, ctx)) {
        const key = c.cols.map((a) => row.vals[a]);
        if (key.some((v) => v === null)) continue;
        const found = keys ? keys.has(K.hashKey(key, types)) : yield* this.db.dml.findKey(ref, c.refIndex, c.refCols, key, ctx);
        if (!found) throw K.err(S.foreignKeyViolation, 'insert or update on table "' + rel.name + '" violates foreign key constraint "' + c.name + '"', { detail: 'Key (' + c.cols.map((a) => rel.cols[a].name).join(', ') + ')=(' + key.map((v, i) => T().output(v, rel.cols[c.cols[i]].type, ctx)).join(', ') + ') is not present in table "' + ref.name + '".' });
      }
    }

    // ---- indexes --------------------------------------------------------------------------------------------------
    *createIndex(st, ctx, cat, s) {
      const rel = this.rel(cat, s, st.table, ['table', 'matview']);
      this.owner(s, rel);
      yield* this.lock(ctx, rel, st.concurrently ? 'share update exclusive' : 'share');
      if (st.name && cat.schema(rel.schema).objects.has(st.name)) {
        if (st.ifNotExists) { s.notice('relation "' + st.name + '" already exists, skipping'); return 'CREATE INDEX'; }
        throw K.err(S.duplicateTable, 'relation "' + st.name + '" already exists');
      }
      const methods = ['btree', 'hash', 'bitmap', 'lsm', 'rtree', 'gist', 'gin', 'brin'];
      if (!methods.includes(st.method)) throw K.err(S.undefinedObject, 'access method "' + st.method + '" does not exist');
      yield* this.buildIndex(rel, { name: st.name, method: st.method, cols: st.cols, unique: st.unique, include: st.include, where: st.where, whereText: st.whereText, options: st.options, nullsDistinct: st.nullsDistinct }, ctx, cat, s);
      return 'CREATE INDEX';
    }
    /** make an index and fill it from the table's rows (checking uniqueness) */
    *buildIndex(rel, o, ctx, cat, s) {
      const keys = o.cols.map((c) => {
        if (c.col) {
          const a = rel.cols.findIndex((x) => x.name === c.col && !x.dropped);
          if (a < 0) throw K.err(S.undefinedColumn, 'column "' + c.col + '" does not exist');
          return { attnum: a, name: c.col, dir: c.dir || 'asc', nulls: c.nulls, type: rel.cols[a].type };
        }
        const f = this.db.tableExpr(s, rel, c.expr, 'index expression', {});
        return { expr: c.expr, name: this.exprName(c.expr), dir: c.dir || 'asc', nulls: c.nulls, type: f.type };
      });
      if (o.method === 'hash' && keys.length > 1) throw K.err(S.featureNotSupported, 'access method "hash" does not support multicolumn indexes');
      if (o.unique && o.method !== 'btree') throw K.err(S.featureNotSupported, 'access method "' + o.method + '" does not support unique indexes');
      let name = o.name;
      if (!name) { const base = rel.name + '_' + keys.map((k) => k.name).join('_') + (o.unique ? '_key' : '_idx'); name = base; for (let i = 1; cat.schema(rel.schema).objects.has(name); i++) name = base + i; }
      const include = (o.include || []).map((n) => { const a = rel.cols.findIndex((x) => x.name === n); if (a < 0) throw K.err(S.undefinedColumn, 'column "' + n + '" does not exist'); return a; });
      const opts = {};
      for (const [k, v] of Object.entries(o.options || {})) opts[k] = v && v.k === 'lit' ? v.v : v && v.k === 'col' ? v.parts[0] : v;
      const idx = { kind: 'index', schema: rel.schema, name, owner: rel.owner, table: rel.oid, method: o.method, keys: keys.map((k) => ({ attnum: k.attnum, expr: k.expr, name: k.name, dir: k.dir, nulls: k.nulls })), keyTypes: keys.map((k) => k.type), unique: !!o.unique, primary: !!o.primary, constraint: o.constraint || null, include, where: o.where || null, whereText: o.whereText, options: opts, nullsDistinct: o.nullsDistinct !== false };
      idx.file = this.db.newFile(rel.schema + '.' + name, 'index');
      cat.addRel(idx);
      rel.indexes.push(idx.oid);
      const am = this.db.indexAm(idx, cat);
      if (o.method === 'btree' && !opts.fanout && am.bulkLoad) {
        // a B+ tree is built bottom up from the sorted entries, as PostgreSQL builds one; only rows whose key
        // equals a neighbour's in that order can break uniqueness, and those are checked against the finished tree
        const entries = [];
        for (const row of this.db.liveRows(rel, ctx, true)) if (this.db.dml.indexWants(idx, row.vals, ctx, s)) entries.push({ key: am.keyOf(row.vals, ctx), tid: row.tid, vals: row.vals });
        entries.sort((a, b) => am.cmpEntry(a.key, a.tid, b.key, b.tid));
        am.bulkLoad(entries);
        if (idx.unique) {
          const dup = new Set();
          for (let i = 1; i < entries.length; i++) if (am.cmpKey(entries[i - 1].key, entries[i].key) === 0) { dup.add(entries[i - 1]); dup.add(entries[i]); }
          for (const e of entries.filter((x) => dup.has(x)).sort((a, b) => a.tid.b - b.tid.b || a.tid.o - b.tid.o)) yield* this.db.dml.checkUnique(rel, idx, e.vals, e.tid, ctx, true);
        }
      } else {
        // other methods (and B+ trees with a small fanout, for watching splits) take the rows one at a time
        for (const row of this.db.liveRows(rel, ctx, true)) {
          if (!this.db.dml.indexWants(idx, row.vals, ctx, s)) continue;
          if (idx.unique) yield* this.db.dml.checkUnique(rel, idx, row.vals, row.tid, ctx, true);
          am.insert(row.vals, row.tid, ctx);
        }
      }
      this.db.bus.emit('ddl.create', { kind: 'index', name, oid: idx.oid, table: rel.name });
      return idx;
    }
    exprName(e) { if (e.k === 'fn') return e.name; if (e.k === 'col') return e.parts[e.parts.length - 1]; return 'expr'; }

    // ---- views ------------------------------------------------------------------------------------------------------
    *createView(st, ctx, cat, s) {
      const schema = this.schemaOf(st.name, s, cat, st.temp);
      const sc = cat.schema(schema);
      const old = sc.objects.get(st.name.name);
      const plan = s.bindOnly(st.query, cat);
      const vis = plan.cols.filter((c) => !c.hidden);
      if (st.cols && st.cols.length > vis.length) throw K.err(S.syntax, 'CREATE VIEW specifies more column names than columns');
      const colNames = vis.map((c, i) => (st.cols && st.cols[i]) || c.name);
      const deps = this.depsOf(plan);
      if (old) {
        if (st.ifNotExists) { s.notice('relation "' + st.name.name + '" already exists, skipping'); return st.materialized ? 'SELECT 0' : 'CREATE VIEW'; }
        if (!st.orReplace || old.kind !== 'view') throw K.err(S.duplicateTable, 'relation "' + st.name.name + '" already exists');
        // CREATE OR REPLACE VIEW may only add columns at the end
        old.cols.forEach((c, i) => { if (colNames[i] !== c.name) throw K.err('42P16', 'cannot change name of view column "' + c.name + '" to "' + (colNames[i] || '') + '"'); });
        old.queryText = st.queryText; old.parsed = st.query; old.colNames = colNames; old.cols = vis.map((c, i) => ({ name: colNames[i], type: c.type })); old.deps = deps; old.check = st.check || null;
        cat.version++;
        return 'CREATE VIEW';
      }
      const rel = { kind: st.materialized ? 'matview' : 'view', schema, name: st.name.name, owner: s.user, queryText: st.queryText, parsed: st.query, colNames, cols: vis.map((c, i) => ({ name: colNames[i], type: c.type.cat === 'P' ? B().text : c.type, notNull: false })), deps, acl: [], indexes: [], constraints: [], triggers: [], check: st.check || null, recursive: st.recursive };
      if (st.materialized) {
        rel.file = this.db.newFile(schema + '.' + rel.name, 'heap');
        cat.addRel(rel);
        let n = 0;
        if (st.withData !== false) { const r = yield* s.runQueryForDDL(st.query, ctx); for (const row of r.rows) { yield* this.db.dml.insertRow(rel, row.slice(), ctx, { skipChecks: true }); n++; } rel.populated = true; } else rel.populated = false;
        return 'SELECT ' + n;
      }
      cat.addRel(rel);
      return 'CREATE VIEW';
    }
    /** the relations a plan reads (a view depends on them) */
    depsOf(plan) {
      const out = new Set();
      const walk = (n) => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) { n.forEach(walk); return; }
        if (n.rel && n.rel.oid !== undefined) out.add(n.rel.oid);
        if (n.view && n.view.oid !== undefined) out.add(n.view.oid);
        if (n.children) walk(n.children);
        if (n.k === 'sub') walk(n.plan);
        for (const k of ['cond', 'exprs', 'filter', 'targets', 'rows', 'groups', 'aggs', 'items', 'args', 'l', 'r', 'e', 'whens', 'else', 'test']) if (n[k] && typeof n[k] === 'object') walk(n[k]);
        if (n.cte && n.cte.plan && !n.cteSeen) { n.cteSeen = true; walk(n.cte.plan); }
      };
      walk(plan);
      return out;
    }
    *refresh(st, ctx, cat, s) {
      const rel = this.rel(cat, s, st.name, ['matview']);
      yield* this.lock(ctx, rel, st.concurrently ? 'exclusive' : 'access exclusive');
      // a new heap file replaces the old one when this transaction commits
      rel.file = this.db.newFile(rel.schema + '.' + rel.name, 'heap');
      for (const o of rel.indexes) { const ix = cat.rel(o); ix.file = this.db.newFile(ix.schema + '.' + ix.name, 'index'); }
      if (st.data === false) { rel.populated = false; return 'REFRESH MATERIALIZED VIEW'; }
      const r = yield* s.runQueryForDDL(rel.parsed || K.parse(rel.queryText)[0], ctx);
      for (const row of r.rows) {
        const tid = yield* this.db.dml.insertRow(rel, row.slice(), ctx, { skipChecks: true });
        void tid;
      }
      rel.populated = true;
      return 'REFRESH MATERIALIZED VIEW';
    }

    // ---- sequences -------------------------------------------------------------------------------------------------
    makeSequence(schema, name, o, s, colType, colMax) {
      const as = o.as ? this.typeOf(o.as, null, s) : colType || B().int8;
      const typeMax = as.id === 'int2' ? 32767n : as.id === 'int4' ? 2147483647n : 9223372036854775807n;
      const inc = o.increment !== undefined ? BigInt(o.increment) : 1n;
      if (inc === 0n) throw K.err(S.invalidParameter, 'INCREMENT must not be zero');
      const max = o.max !== undefined && o.max !== null ? BigInt(o.max) : inc > 0n ? (colMax || typeMax) : -1n;
      const min = o.min !== undefined && o.min !== null ? BigInt(o.min) : inc > 0n ? 1n : -(colMax || typeMax);
      const start = o.start !== undefined ? BigInt(o.start) : inc > 0n ? min : max;
      if (max > typeMax || max < -typeMax - 1n) throw K.err(S.invalidParameter, 'MAXVALUE (' + max + ') is out of range for sequence data type ' + T().sqlName(as));
      if (min > typeMax || min < -typeMax - 1n) throw K.err(S.invalidParameter, 'MINVALUE (' + min + ') is out of range for sequence data type ' + T().sqlName(as));
      if (min >= max) throw K.err(S.invalidParameter, 'MINVALUE (' + min + ') must be less than MAXVALUE (' + max + ')');
      if (start < min) throw K.err(S.invalidParameter, 'START value (' + start + ') cannot be less than MINVALUE (' + min + ')');
      if (start > max) throw K.err(S.invalidParameter, 'START value (' + start + ') cannot be greater than MAXVALUE (' + max + ')');
      return { kind: 'sequence', schema, name, owner: s.user, seq: { as, inc, min, max, start, cycle: !!o.cycle, cache: o.cache ? BigInt(o.cache) : 1n }, acl: [], indexes: [], constraints: [], cols: [] };
    }
    *createSequence(st, ctx, cat, s) {
      const schema = this.schemaOf(st.name, s, cat, st.temp);
      if (cat.schema(schema).objects.has(st.name.name)) { if (st.ifNotExists) { s.notice('relation "' + st.name.name + '" already exists, skipping'); return 'CREATE SEQUENCE'; } throw K.err(S.duplicateTable, 'relation "' + st.name.name + '" already exists'); }
      const seq = this.makeSequence(schema, st.name.name, st.opts, s);
      cat.addRel(seq);
      if (st.opts.ownedBy) { const parts = st.opts.ownedBy; const t = this.rel(cat, s, parts.schema ? { name: parts.schema } : { name: parts.name.split('.')[0] }, ['table'], true); void t; }
      return 'CREATE SEQUENCE';
    }
    *alterSequence(st, ctx, cat, s) {
      const rel = this.rel(cat, s, st.name, ['sequence'], st.ifExists);
      if (!rel) { s.notice('relation "' + qn(st.name) + '" does not exist, skipping'); return 'ALTER SEQUENCE'; }
      const o = st.opts, q = rel.seq;
      if (o.increment !== undefined) q.inc = BigInt(o.increment);
      if (o.min !== undefined) q.min = o.min === null ? (q.inc > 0n ? 1n : -9223372036854775807n) : BigInt(o.min);
      if (o.max !== undefined) q.max = o.max === null ? (q.inc > 0n ? 9223372036854775807n : -1n) : BigInt(o.max);
      if (o.start !== undefined) q.start = BigInt(o.start);
      if (o.cycle !== undefined) q.cycle = o.cycle;
      if (o.restart !== undefined) this.db.seqState(rel).restart(o.restart === true ? q.start : BigInt(o.restart));
      return 'ALTER SEQUENCE';
    }

    // ---- types and domains ------------------------------------------------------------------------------------------
    *createType(st, ctx, cat, s) {
      const schema = this.schemaOf(st.name, s, cat);
      const name = st.name.name;
      if (cat.types.has(schema + '.' + name) || T().byName(name)) throw K.err(S.duplicateObject, 'type "' + name + '" already exists');
      let t;
      if (st.kind === 'enum') {
        if (new Set(st.labels).size !== st.labels.length) throw K.err(S.invalidParameter, 'enum labels must be unique');
        t = { id: schema + '.' + name, name, cat: 'E', len: -1, labels: st.labels.slice() };
      } else if (st.kind === 'composite') t = { id: schema + '.' + name, name, cat: 'C', len: -1, fields: st.fields.map((f) => ({ name: f.name, type: this.typeOf(f.type, cat, s) })) };
      else throw K.err(S.featureNotSupported, 'range types are not supported');
      cat.addType(schema, t);
      return 'CREATE TYPE';
    }
    *alterType(st, ctx, cat, s) {
      const t = cat.userType(qn(st.name), s.searchPath());
      if (!t) throw K.err(S.undefinedObject, 'type "' + qn(st.name) + '" does not exist');
      if (st.a === 'addValue') {
        if (t.labels.includes(st.value)) { if (st.ifNotExists) { s.notice('enum label "' + st.value + '" already exists, skipping'); return 'ALTER TYPE'; } throw K.err(S.duplicateObject, 'enum label "' + st.value + '" already exists'); }
        const nb = st.before !== undefined ? st.before : st.after;
        if (nb !== undefined && !t.labels.includes(nb)) throw K.err(S.invalidParameter, '"' + nb + '" is not an existing enum label');
        const at = st.before !== undefined ? t.labels.indexOf(st.before) : st.after !== undefined ? t.labels.indexOf(st.after) + 1 : t.labels.length;
        t.labels.splice(at < 0 ? t.labels.length : at, 0, st.value);
      } else if (st.a === 'renameValue') {
        const i = t.labels.indexOf(st.from);
        if (i < 0) throw K.err(S.invalidParameter, '"' + st.from + '" is not an existing enum label');
        t.labels[i] = st.to;
      } else if (st.a === 'addAttribute') t.fields.push({ name: st.field.name, type: this.typeOf(st.field.type, cat, s) });
      this.retype(cat, t);
      cat.version++;
      return 'ALTER TYPE';
    }
    /** the catalog copy of a type changed: point this catalog's columns, arrays and domains at it */
    retype(cat, t) {
      const swap = (x) => {
        if (!x || x === t) return x;
        if (x.id === t.id && !x.elem) return t;
        if (x.cat === 'A' && x.elem) { const e = swap(x.elem); return e === x.elem ? x : T().arrayOf(e); }
        return x;
      };
      for (const r of cat.rels.values()) for (const c of r.cols || []) c.type = swap(c.type);
      for (const u of cat.types.values()) { if (u.base) u.base = swap(u.base); if (u.fields) for (const f of u.fields) f.type = swap(f.type); }
    }
    *createDomain(st, ctx, cat, s) {
      const schema = this.schemaOf(st.name, s, cat);
      const name = st.name.name;
      if (cat.types.has(schema + '.' + name)) throw K.err(S.duplicateObject, 'type "' + name + '" already exists');
      const base = this.typeOf(st.base, cat, s);
      const t = Object.assign({}, base, { id: schema + '.' + name, name, domain: true, base, notNull: st.notNull, checks: st.checks.map((c, i) => ({ name: c.name || name + '_check' + (i ? i : ''), expr: c.expr, text: c.text })), default: st.default || null, defaultText: st.defaultText });
      t.check = t.checks.length > 0;
      cat.addType(schema, t);
      // the checks are bound now so mistakes show at once
      for (const c of t.checks) this.db.domainCheck(s, t, c);
      return 'CREATE DOMAIN';
    }
    *alterDomain(st, ctx, cat, s) {
      const t = cat.userType(qn(st.name), s.searchPath());
      if (!t || !t.domain) throw K.err(S.undefinedObject, 'type "' + qn(st.name) + '" does not exist');
      if (st.a === 'setNotNull') t.notNull = true;
      else if (st.a === 'dropNotNull') t.notNull = false;
      else if (st.a === 'addCheck') { t.checks.push({ name: st.check.name || t.name + '_check', expr: st.check.expr }); t.check = true; }
      else if (st.a === 'dropConstraint') { t.checks = t.checks.filter((c) => c.name !== st.cname); t.check = t.checks.length > 0; }
      else if (st.a === 'setDefault') t.default = st.expr;
      else if (st.a === 'dropDefault') t.default = null;
      this.retype(cat, t);
      if (st.a === 'addCheck' || st.a === 'setNotNull') {
        // the stored values must already satisfy the new constraint
        const uses = (x) => x && (x.id === t.id || uses(x.elem) || (x.domain && uses(x.base)));
        for (const rel of cat.tables(['table'])) {
          rel.cols.forEach((c, i) => {
            if (c.dropped || !uses(c.type)) return;
            for (const row of this.db.liveRows(rel, ctx)) {
              const v = row.vals.length > i ? row.vals[i] : c.missing === undefined ? null : c.missing;
              if (st.a === 'setNotNull') { if (v === null && c.type.id === t.id) throw K.err(S.notNullViolation, 'column "' + c.name + '" of table "' + rel.name + '" contains null values'); continue; }
              try { K.T.cast(v, c.type, c.type, false, ctx); } catch (e) { if (e.code === S.checkViolation) throw K.err(S.checkViolation, 'column "' + c.name + '" of table "' + rel.name + '" contains values that violate the new constraint'); throw e; }
            }
          });
        }
      }
      cat.version++;
      return 'ALTER DOMAIN';
    }

    // ---- functions, procedures, triggers ------------------------------------------------------------------------------
    *createRoutine(st, ctx, cat, s) {
      const schema = this.schemaOf(st.name, s, cat);
      const params = st.params.map((p) => ({ name: p.name || null, type: this.typeOf(p.type, cat, s), mode: p.mode, default: p.default }));
      let retType = null;
      if (st.kind === 'function') {
        if (st.returnsTable) retType = { id: 'record', name: 'record', cat: 'C', len: -1, fields: st.returnsTable.map((f) => ({ name: f.name, type: this.typeOf(f.type, cat, s) })) };
        else if (st.returns) retType = this.typeOf(st.returns, cat, s);
        else {
          const outs = params.filter((p) => p.mode === 'out' || p.mode === 'inout');
          if (outs.length === 1) retType = outs[0].type;
          else if (outs.length > 1) retType = { id: 'record', name: 'record', cat: 'C', len: -1, fields: outs.map((p) => ({ name: p.name, type: p.type })) };
          else throw K.err(S.invalidFunctionDefinition || '42P13', 'function result type must be specified');
        }
      }
      const langs = ['sql', 'plpgsql', 'psm'];
      if (!langs.includes(st.lang)) throw K.err(S.undefinedObject, 'language "' + st.lang + '" does not exist', { hint: 'Kwery runs LANGUAGE sql and LANGUAGE plpgsql (SQL/PSM).' });
      const f = { name: st.name.name, schema, kind: st.kind, params, retType, setof: !!st.setof || !!st.returnsTable, returnsTable: !!st.returnsTable, lang: st.lang, body: st.body, bodyPos: st.bodyPos, volatility: st.volatility, strict: st.strict, security: st.security || 'invoker', owner: s.user, orReplace: st.orReplace, atomic: st.atomic };
      if (f.lang !== 'sql' && K.PSM) f.compiled = K.PSM.compile(f, s);
      if (f.lang === 'sql') f.parsedBody = K.parse(f.body);
      cat.addFunc(f);
      return st.kind === 'procedure' ? 'CREATE PROCEDURE' : 'CREATE FUNCTION';
    }
    *createTrigger(st, ctx, cat, s) {
      const rel = this.rel(cat, s, st.table, ['table', 'view']);
      this.owner(s, rel);
      const f = cat.userFuncs(st.func.name).find((x) => x.retType && x.retType.id === 'trigger');
      if (!f) throw K.err(S.undefinedFunction, 'function ' + st.func.name + '() does not exist');
      if (rel.triggers.some((t) => t.name === st.name)) { if (!st.orReplace) throw K.err(S.duplicateObject, 'trigger "' + st.name + '" for relation "' + rel.name + '" already exists'); rel.triggers = rel.triggers.filter((t) => t.name !== st.name); }
      if (st.timing === 'instead of' && rel.kind !== 'view') throw K.err('42809', '"' + rel.name + '" is a table', { detail: 'Tables cannot have INSTEAD OF triggers.' });
      rel.triggers.push({ name: st.name, timing: st.timing, events: st.events, forEach: st.forEach, when: st.when || null, func: f.name, args: (st.args || []).map((a) => (a.k === 'lit' ? String(a.v) : a.k === 'col' ? a.parts.join('.') : '')), referencing: st.referencing || null, enabled: true, constraint: st.constraint, deferrable: st.deferrable, deferred: st.deferred });
      cat.version++;
      return 'CREATE TRIGGER';
    }
    // ---- row-level security --------------------------------------------------------------------------------------------
    *createPolicy(st, ctx, cat, s) {
      const rel = this.rel(cat, s, st.table, ['table']);
      this.owner(s, rel);
      if (!rel.policies) rel.policies = [];
      if (rel.policies.some((p) => p.name === st.name)) throw K.err(S.duplicateObject, 'policy "' + st.name + '" for table "' + rel.name + '" already exists');
      if (st.check && (st.cmd === 'select' || st.cmd === 'delete')) throw K.err(S.syntax, 'WITH CHECK cannot be applied to SELECT or DELETE');
      if (st.using && st.cmd === 'insert') throw K.err(S.syntax, 'only WITH CHECK expression allowed for INSERT');
      const roles = st.roles.map((r) => (r === '$current' ? s.user : r));
      for (const r of roles) if (r !== 'public' && !cat.roles.has(r)) throw K.err(S.undefinedObject, 'role "' + r + '" does not exist');
      // the expressions are checked now, against the table's columns
      for (const e of [st.using, st.check]) if (e) this.db.tableExpr(s, rel, e, 'policy expression', { bool: true });
      rel.policies.push({ name: st.name, cmd: st.cmd, permissive: st.permissive, roles, using: st.using, check: st.check });
      cat.version++;
      return 'CREATE POLICY';
    }
    *createAssertion(st, ctx, cat, s) {
      // SQL's CREATE ASSERTION: a condition over the whole database, checked after every statement that could break it
      if (cat.assertions.has(st.name)) throw K.err(S.duplicateObject, 'assertion "' + st.name + '" already exists');
      const plan = s.bindOnly({ type: 'select', targets: [{ expr: st.check, alias: 'ok' }], from: [] }, cat);
      cat.assertions.set(st.name, { name: st.name, check: st.check, deps: this.depsOf(plan) });
      const ok = yield* s.checkAssertion(cat.assertions.get(st.name), ctx);
      if (!ok) throw K.err(S.checkViolation, 'assertion "' + st.name + '" is violated by the current data');
      return 'CREATE ASSERTION';
    }

    // ---- roles and privileges ----------------------------------------------------------------------------------------
    *createRole(st, ctx, cat, s) {
      if (!s.superuser()) throw K.err(S.insufficientPrivilege, 'permission denied to create role');
      if (cat.roles.has(st.name)) { if (st.ifNotExists) { s.notice('role "' + st.name + '" already exists, skipping'); return 'CREATE ROLE'; } throw K.err(S.duplicateObject, 'role "' + st.name + '" already exists'); }
      cat.roles.set(st.name, { name: st.name, superuser: !!st.opts.superuser, login: !!st.login, member: new Set() });
      for (const r of st.inRole || []) { const g = cat.roles.get(r); if (g) g.member.add(st.name); }
      cat.version++;
      return 'CREATE ROLE';
    }
    *alterRole(st, ctx, cat, s) {
      const r = cat.roles.get(st.name);
      if (!r) throw K.err(S.undefinedObject, 'role "' + st.name + '" does not exist');
      if (st.rename) { cat.roles.delete(st.name); r.name = st.rename; cat.roles.set(st.rename, r); }
      for (const k of Object.keys(st.opts)) { if (k === 'superuser') r.superuser = true; if (k === 'nosuperuser') r.superuser = false; if (k === 'login') r.login = true; if (k === 'nologin') r.login = false; }
      cat.version++;
      return 'ALTER ROLE';
    }
    *grant(st, ctx, cat, s) { return this.privs(st, cat, s, true); }
    *revoke(st, ctx, cat, s) { return this.privs(st, cat, s, false); }
    privs(st, cat, s, grant) {
      if (st.kind === 'role') {
        for (const g of st.granted) { const role = cat.roles.get(g); if (!role) throw K.err(S.undefinedObject, 'role "' + g + '" does not exist'); for (const r of st.roles) { if (!cat.roles.has(r)) throw K.err(S.undefinedObject, 'role "' + r + '" does not exist'); if (grant) role.member.add(r); else role.member.delete(r); } }
        cat.version++;
        return grant ? 'GRANT ROLE' : 'REVOKE ROLE';
      }
      const all = ['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger'];
      let objs;
      if (st.kind === 'all tables') objs = [...cat.schema(st.objects[0].name).objects.values()].filter((o) => o.kind === 'table' || o.kind === 'view');
      else if (st.kind === 'schema') objs = st.objects.map((o) => { const sc = cat.schema(o.name); return sc; });
      else if (st.kind === 'table' || st.kind === 'sequence') objs = st.objects.map((o) => this.rel(cat, s, o, st.kind === 'sequence' ? ['sequence'] : ['table', 'view', 'matview', 'sequence']));
      else return grant ? 'GRANT' : 'REVOKE';
      for (const o of objs) {
        // without the grant option, PostgreSQL warns and grants nothing (it is not an error)
        if (o.owner && o.owner !== s.user && !s.superuser() && !(o.acl || []).some((a) => s.roles().has(a.grantee) && a.grantOption)) {
          if (!(o.acl || []).some((a) => s.roles().has(a.grantee))) throw K.err(S.insufficientPrivilege, 'permission denied for ' + (o.kind || 'schema') + ' ' + o.name);
          s.notice('no privileges were ' + (grant ? 'granted' : 'revoked') + ' for "' + o.name + '"', 'WARNING');
          continue;
        }
        if (!o.acl) o.acl = [];
        for (const role of st.roles) {
          if (role !== 'public' && !cat.roles.has(role)) throw K.err(S.undefinedObject, 'role "' + role + '" does not exist');
          for (const p of st.privs) {
            const list = p.priv === 'all' ? (st.kind === 'schema' ? ['usage', 'create'] : all) : [K.lower(p.priv)];
            for (const priv of list) {
              const cols = p.cols || null;
              if (grant) { if (!o.acl.some((a) => a.grantee === role && a.priv === priv && String(a.cols) === String(cols))) o.acl.push({ grantee: role, priv, cols, grantor: s.user, grantOption: !!st.grantOption }); }
              else {
                // privileges this role passed on (WITH GRANT OPTION) depend on it: RESTRICT refuses, CASCADE revokes them too
                const dependents = (who) => o.acl.filter((a) => a.grantor === who && a.priv === priv && a.grantee !== who);
                const deps = dependents(role);
                if (deps.length && !st.cascade) throw K.err(S.dependentObjects, 'dependent privileges exist', { hint: 'Use CASCADE to revoke them too.' });
                const gone = new Set([role]);
                const queue = deps.map((a) => a.grantee);
                while (queue.length) { const g = queue.shift(); if (gone.has(g)) continue; gone.add(g); for (const a of dependents(g)) queue.push(a.grantee); }
                o.acl = o.acl.filter((a) => !(gone.has(a.grantee) && a.priv === priv && (!cols || String(a.cols) === String(cols))));
              }
            }
          }
        }
      }
      cat.version++;
      return grant ? 'GRANT' : 'REVOKE';
    }

    // ---- ALTER TABLE ----------------------------------------------------------------------------------------------------
    *alterTable(st, ctx, cat, s) {
      const rel = this.rel(cat, s, st.name, ['table', 'view', 'matview'], st.ifExists);
      if (!rel) { s.notice('relation "' + qn(st.name) + '" does not exist, skipping'); return 'ALTER TABLE'; }
      this.owner(s, rel);
      const weak = st.actions.every((a) => ['addConstraint', 'validateConstraint', 'enableTrigger'].includes(a.a) && (!a.constraint || a.constraint.kind === 'foreign'));
      yield* this.lock(ctx, rel, weak ? 'share row exclusive' : 'access exclusive');
      for (const a of st.actions) yield* this.alterAction(rel, a, ctx, cat, s);
      cat.version++;
      return 'ALTER TABLE';
    }
    colOf(rel, name, missingOk) {
      const i = rel.cols.findIndex((c) => c.name === name && !c.dropped);
      if (i < 0 && !missingOk) throw K.err(S.undefinedColumn, 'column "' + name + '" of relation "' + rel.name + '" does not exist');
      return i;
    }
    *alterAction(rel, a, ctx, cat, s) {
      switch (a.a) {
        case 'addColumn': {
          if (this.colOf(rel, a.col.name, true) >= 0) { if (a.ifNotExists) { s.notice('column "' + a.col.name + '" of relation "' + rel.name + '" already exists, skipping'); return; } throw K.err(S.duplicateColumn, 'column "' + a.col.name + '" of relation "' + rel.name + '" already exists'); }
          const col = this.columnOf(a.col, rel, cat, s);
          rel.cols.push(col);
          if (col.generated) this.checkGenerated(rel, col, s);
          const attnum = rel.cols.length - 1;
          for (const k of a.col.constraints) { if (k.kind === 'notnull') col.notNull = true; }
          if (col.serial || col.identity) yield* this.ownSequence(rel, col, ctx, cat, s);
          // existing rows get the default: a constant one is stored once as the "missing" value (no rewrite);
          // anything else (a volatile default, a generated column, a serial) rewrites the table
          const hasRows = this.db.liveRows(rel, ctx).next().done === false;
          if (hasRows) {
            if (col.default || col.generated || col.identity) {
              const f = col.default ? this.db.tableExpr(s, rel, col.default, 'default', { type: col.type, noCols: true }) : null;
              if (f && f.constant && !col.generated && !col.identity) col.missing = f([], ctx);
              else yield* this.rewrite(rel, ctx, cat, s, (vals, ctx2) => { vals[attnum] = col.identity ? T().cast(this.db.sequenceNext(cat.rel(col.seq), ctx2), B().int8, col.type, false, ctx2) : col.generated ? this.db.tableExpr(s, rel, col.generated, 'generation expression', { type: col.type })(vals, ctx2) : f(vals, ctx2); return vals; });
            }
            if (col.notNull) for (const row of this.db.liveRows(rel, ctx)) { const v = row.vals.length > attnum ? row.vals[attnum] : col.missing; if (v === null || v === undefined) throw K.err(S.notNullViolation, 'column "' + col.name + '" of relation "' + rel.name + '" contains null values'); }
          }
          for (const k of a.col.constraints) if (k.kind !== 'notnull' && k.kind !== 'null') yield* this.addConstraint(rel, Object.assign({}, k, { cols: [col.name] }), ctx, cat, s, false);
          return;
        }
        case 'dropColumn': {
          const i = this.colOf(rel, a.name, a.ifExists);
          if (i < 0) { s.notice('column "' + a.name + '" of relation "' + rel.name + '" does not exist, skipping'); return; }
          const gens = rel.cols.filter((c, k) => k !== i && c.generated && !c.dropped && this.checkCols(rel, c.generated).includes(a.name));
          if (gens.length && !a.cascade) throw K.err(S.dependentObjects, 'cannot drop column ' + a.name + ' of table ' + rel.name + ' because other objects depend on it', { detail: gens.map((c) => 'column ' + c.name + ' of table ' + rel.name + ' depends on column ' + a.name).join('\n'), hint: 'Use DROP ... CASCADE to drop the dependent objects too.' });
          for (const c of gens) { s.notice('drop cascades to column ' + c.name + ' of table ' + rel.name); yield* this.alterAction(rel, { a: 'dropColumn', name: c.name, cascade: true }, ctx, cat, s); }
          const users = rel.constraints.filter((c) => (c.cols && c.cols.includes(i)) || (c.kind === 'check' && this.checkCols(rel, c.expr).includes(a.name)));
          const refd = (rel.referencedBy || []).map((r) => ({ r, c: cat.rel(r.rel) && cat.rel(r.rel).constraints.find((x) => x.name === r.name) })).filter((x) => x.c && x.c.refCols.includes(i));
          if (refd.length && !a.cascade) throw K.err(S.dependentObjects, 'cannot drop column ' + a.name + ' of table ' + rel.name + ' because other objects depend on it', { detail: refd.map((x) => 'constraint ' + x.c.name + ' on table ' + cat.rel(x.r.rel).name + ' depends on index ' + rel.name + '_pkey').join('\n'), hint: 'Use DROP ... CASCADE to drop the dependent objects too.' });
          for (const x of refd) { const t = cat.rel(x.r.rel); t.constraints = t.constraints.filter((c) => c !== x.c); }
          for (const c of users) yield* this.dropConstraintObj(rel, c, cat, s, true);
          for (const o of rel.indexes.slice()) { const ix = cat.rel(o); if (ix && ix.keys.some((k) => k.attnum === i)) this.dropIndexObj(ix, cat); }
          rel.cols[i] = Object.assign({}, rel.cols[i], { dropped: true, name: '........pg.dropped.' + (i + 1) + '........', notNull: false });
          if (rel.pk && rel.pk.includes(i)) rel.pk = null;
          return;
        }
        case 'renameColumn': {
          const i = this.colOf(rel, a.from);
          if (this.colOf(rel, a.to, true) >= 0) throw K.err(S.duplicateColumn, 'column "' + a.to + '" of relation "' + rel.name + '" already exists');
          rel.cols[i].name = a.to;
          if (rel.kind === 'view') rel.colNames[i] = a.to;
          return;
        }
        case 'renameTable': {
          cat.renameRel(rel, a.to);
          return;
        }
        case 'renameConstraint': {
          const c = rel.constraints.find((x) => x.name === a.from);
          if (!c) throw K.err(S.undefinedObject, 'constraint "' + a.from + '" for table "' + rel.name + '" does not exist');
          c.name = a.to;
          if (c.index) { const ix = cat.rel(c.index); cat.renameRel(ix, a.to); ix.constraint = a.to; }
          return;
        }
        case 'setSchema': {
          const sc = cat.schema(a.schema);
          cat.schema(rel.schema).objects.delete(rel.name);
          rel.schema = a.schema; sc.objects.set(rel.name, rel);
          return;
        }
        case 'alterType': {
          const i = this.colOf(rel, a.col);
          const old = rel.cols[i];
          const views = cat.tables(['view', 'matview']).filter((v) => v.deps && v.deps.has(rel.oid));
          if (views.length) throw K.err(S.featureNotSupported, 'cannot alter type of a column used by a view or rule', { detail: 'rule _RETURN on view ' + views[0].name + ' depends on column "' + old.name + '"' });
          const nt = this.typeOf(a.type, cat, s);
          const conv = a.using ? this.db.tableExpr(s, rel, a.using, 'transform expression', { type: nt }) : null;
          if (!conv && !this.db.dml.assignable(old.type, nt)) throw K.err(S.datatypeMismatch, 'column "' + old.name + '" cannot be cast automatically to type ' + T().sqlName(nt), { hint: 'You might need to specify "USING ' + old.name + '::' + T().sqlName(nt) + '".' });
          // the default has to convert too (with an assignment cast), or the type change is refused
          if (old.default && !this.db.dml.assignable(this.db.tableExpr(s, rel, old.default, 'default', { type: old.type, noCols: true }).type, nt)) throw K.err(S.datatypeMismatch, 'default for column "' + old.name + '" cannot be cast automatically to type ' + T().sqlName(nt));
          const newCols = rel.cols.map((c, k) => (k === i ? Object.assign({}, c, { type: nt }) : c));
          yield* this.rewrite(rel, ctx, cat, s, (vals, ctx2) => { vals[i] = conv ? conv(vals, ctx2) : vals[i] === null ? null : T().cast(vals[i], old.type, nt, false, ctx2); return vals; }, newCols);
          for (const o of rel.indexes) { const ix = cat.rel(o); ix.keyTypes = ix.keys.map((k, n) => (k.attnum === i ? nt : ix.keyTypes[n])); }
          return;
        }
        case 'setDefault':
          // nextval('name') names its sequence through a regclass constant, resolved when the default is set
          (function walk(x, db) { if (!x || typeof x !== 'object') return; if (x.k === 'fn' && x.name === 'nextval' && x.args[0] && x.args[0].k === 'lit' && x.args[0].type === 'str') db.seqRel(x.args[0].v, ctx); for (const v of Object.values(x)) walk(v, db); })(a.expr, this.db);
          rel.cols[this.colOf(rel, a.col)].default = a.expr; rel.cols[this.colOf(rel, a.col)].defaultText = a.text; this.db.tableExpr(s, rel, a.expr, 'default', { type: rel.cols[this.colOf(rel, a.col)].type, noCols: true }); return;
        case 'dropDefault': { const c = rel.cols[this.colOf(rel, a.col)]; c.default = null; c.defaultText = null; return; }
        case 'setNotNull': {
          const i = this.colOf(rel, a.col);
          for (const row of this.db.liveRows(rel, ctx)) if (row.vals[i] === null) throw K.err(S.notNullViolation, 'column "' + a.col + '" of relation "' + rel.name + '" contains null values');
          rel.cols[i].notNull = true;
          return;
        }
        case 'dropNotNull': {
          const i = this.colOf(rel, a.col);
          if (rel.pk && rel.pk.includes(i)) throw K.err('42P16', 'column "' + a.col + '" is in a primary key');
          rel.cols[i].notNull = false;
          return;
        }
        case 'addConstraint': yield* this.addConstraint(rel, a.constraint, ctx, cat, s, false); return;
        case 'dropConstraint': {
          const c = rel.constraints.find((x) => x.name === a.name);
          if (!c) { if (a.ifExists) { s.notice('constraint "' + a.name + '" of relation "' + rel.name + '" does not exist, skipping'); return; } throw K.err(S.undefinedObject, 'constraint "' + a.name + '" of relation "' + rel.name + '" does not exist'); }
          yield* this.dropConstraintObj(rel, c, cat, s, a.cascade);
          return;
        }
        case 'validateConstraint': {
          const c = rel.constraints.find((x) => x.name === a.name);
          if (!c) throw K.err(S.undefinedObject, 'constraint "' + a.name + '" of relation "' + rel.name + '" does not exist');
          if (c.kind === 'check') yield* this.validateCheck(rel, c, ctx);
          if (c.kind === 'foreign') yield* this.validateForeign(rel, c, cat.rel(c.refRel), ctx);
          return;
        }
        case 'restartIdentity': case 'setIdentity': {
          const c = rel.cols[this.colOf(rel, a.col)];
          if (!c.identity) throw K.err('55000', 'column "' + c.name + '" of relation "' + rel.name + '" is not an identity column');
          if (a.how) c.identity = a.how;
          if (a.seqOpts) yield* this.alterSequence({ name: { name: cat.rel(c.seq).name, schema: rel.schema }, opts: a.seqOpts }, ctx, cat, s);
          if (a.restart !== undefined) { const seq = cat.rel(c.seq); this.db.seqState(seq).restart(a.restart === true ? seq.seq.start : BigInt(a.restart)); }
          return;
        }
        case 'addIdentity': {
          const c = rel.cols[this.colOf(rel, a.col)];
          if (c.identity) throw K.err('42P17', 'column "' + c.name + '" of relation "' + rel.name + '" is already an identity column');
          if (!c.notNull) throw K.err('55000', 'column "' + c.name + '" of relation "' + rel.name + '" must be declared NOT NULL before identity can be added');
          if (c.default) throw K.err('42P17', 'column "' + c.name + '" of relation "' + rel.name + '" already has a default value');
          c.identity = a.how; c.seqOpts = a.seqOpts;
          yield* this.ownSequence(rel, c, ctx, cat, s);
          return;
        }
        case 'dropIdentity': { const c = rel.cols[this.colOf(rel, a.col)]; if (c.seq) cat.removeRel(cat.rel(c.seq)); c.identity = null; c.seq = null; return; }
        case 'enableTrigger': for (const t of rel.triggers) if (a.name === 'all' || a.name === 'user' || t.name === a.name) t.enabled = a.enable; return;
        case 'clusterOn': {
          if (!a.index) { rel.clusterIndex = null; return; }
          const ix = cat.lookup({ schema: rel.schema, name: a.index }, null, ['index']);
          if (!ix || ix.table !== rel.oid) throw K.err(S.undefinedObject, 'index "' + a.index + '" for table "' + rel.name + '" does not exist');
          this.clusterable(ix);
          rel.clusterIndex = ix.oid;
          return;
        }
        case 'rls': if (a.enable !== undefined) rel.rls = a.enable; if (a.force !== undefined) rel.forceRls = a.force; return;
        case 'noop': return;
        case 'attachPartition': case 'detachPartition': throw K.err(S.featureNotSupported, 'partitions are shown in the sharding workbench');
      }
      throw K.err(S.featureNotSupported, 'ALTER TABLE ' + a.a + ' is not supported');
    }
    *dropConstraintObj(rel, c, cat, s, cascade) {
      if (c.kind === 'primary' || c.kind === 'unique') {
        const deps = (rel.referencedBy || []).filter((r) => { const t = cat.rel(r.rel); const fk = t && t.constraints.find((x) => x.name === r.name); return fk && fk.refIndex === c.index; });
        if (deps.length && !cascade) throw K.err(S.dependentObjects, 'cannot drop constraint ' + c.name + ' on table ' + rel.name + ' because other objects depend on it', { detail: deps.map((r) => 'constraint ' + r.name + ' on table ' + cat.rel(r.rel).name + ' depends on index ' + c.name).join('\n'), hint: 'Use DROP ... CASCADE to drop the dependent objects too.' });
        for (const r of deps) { const t = cat.rel(r.rel); t.constraints = t.constraints.filter((x) => x.name !== r.name); s.notice('drop cascades to constraint ' + r.name + ' on table ' + t.name); }
        rel.referencedBy = (rel.referencedBy || []).filter((r) => !deps.includes(r));
        const ix = cat.rel(c.index);
        if (ix) this.dropIndexObj(ix, cat);
        if (c.kind === 'primary') rel.pk = null;
      }
      if (c.kind === 'foreign') { const ref = cat.rel(c.refRel); if (ref) ref.referencedBy = (ref.referencedBy || []).filter((r) => !(r.rel === rel.oid && r.name === c.name)); }
      rel.constraints = rel.constraints.filter((x) => x !== c);
    }
    /** rewrite every live row into a new heap file (ALTER COLUMN TYPE, volatile defaults); indexes are rebuilt */
    *rewrite(rel, ctx, cat, s, fn, newCols, order) {
      const rows = [...this.db.liveRows(rel, ctx)].map((r) => fn(r.vals.concat(new Array(Math.max(0, rel.cols.length - r.vals.length)).fill(null)), ctx));
      if (order) rows.sort(order);
      if (newCols) rel.cols = newCols;
      rel.file = this.db.newFile(rel.schema + '.' + rel.name, 'heap');
      const idxs = rel.indexes.map((o) => cat.rel(o)).filter(Boolean);
      for (const ix of idxs) ix.file = this.db.newFile(ix.schema + '.' + ix.name, 'index');
      for (const vals of rows) yield* this.db.dml.insertRow(rel, vals, ctx, { skipChecks: false, ddl: true });
      this.db.bus.emit('ddl.rewrite', { rel: rel.name, rows: rows.length });
    }

    /** CLUSTER: rewrite a table in the order of one of its indexes (remembered for the next CLUSTER) */
    *cluster(st, ctx, cat, s) {
      const rels = st.table ? [this.rel(cat, s, st.table, ['table', 'matview'])] : cat.tables(['table', 'matview']).filter((r) => r.clusterIndex && (s.superuser() || r.owner === s.user));
      if (!st.table && s.tx && !s.tx.implicit) throw K.err(S.activeTxn, 'CLUSTER cannot run inside a transaction block');
      for (const rel of rels) {
        this.owner(s, rel);
        let ix;
        if (st.index) {
          ix = cat.lookup({ schema: rel.schema, name: st.index }, null, ['index']);
          if (!ix) throw K.err(S.undefinedObject, 'index "' + st.index + '" for table "' + rel.name + '" does not exist');
          if (ix.table !== rel.oid) throw K.err(S.wrongObjectType, '"' + st.index + '" is not an index for table "' + rel.name + '"');
        } else {
          ix = rel.clusterIndex && cat.rel(rel.clusterIndex);
          if (!ix) throw K.err(S.undefinedObject, 'there is no previously clustered index for table "' + rel.name + '"');
        }
        this.clusterable(ix);
        rel.clusterIndex = ix.oid;
        yield* this.lock(ctx, rel, 'access exclusive');
        const keys = ix.keys.map((k, i) => ({ k, type: ix.keyTypes[i], f: k.attnum === undefined || k.attnum === null ? this.db.tableExpr(s, rel, k.expr, 'index expression', {}) : null }));
        const val = (key, vals) => (key.f ? key.f(vals, ctx) : vals[key.k.attnum]);
        // the index's order: each key ascending or descending, NULLs last unless the key says otherwise
        const order = (a, b) => {
          for (const key of keys) {
            const x = val(key, a), y = val(key, b), desc = key.k.dir === 'desc', nf = key.k.nulls ? key.k.nulls === 'first' : desc;
            if (x === null || y === null) { if (x === y) continue; return (x === null) === nf ? -1 : 1; }
            const c = K.T.compare(x, y, key.type);
            if (c) return desc ? -c : c;
          }
          return 0;
        };
        yield* this.rewrite(rel, ctx, cat, s, (v) => v, null, order);
        this.db.bus.emit('ddl.cluster', { rel: rel.name, index: ix.name });
      }
      cat.version++;
      return 'CLUSTER';
    }
    clusterable(ix) {
      if (ix.method && ix.method !== 'btree') throw K.err(S.featureNotSupported, 'cannot cluster on index "' + ix.name + '" because access method does not support clustering');
      if (ix.where) throw K.err(S.featureNotSupported, 'cannot cluster on partial index "' + ix.name + '"');
    }

    // ---- DROP and TRUNCATE ----------------------------------------------------------------------------------------------
    *drop(st, ctx, cat, s) {
      const kind = st.kind;
      const tag = 'DROP ' + kind.toUpperCase().replace('MATVIEW', 'MATERIALIZED VIEW');
      // every named object must exist before anything is dropped
      if (!st.ifExists) for (const n of st.names) {
        if (kind === 'schema' && !cat.schema(n.name, true)) throw K.err('3F000', 'schema "' + n.name + '" does not exist');
        if (['table', 'view', 'matview', 'sequence', 'index'].includes(kind)) this.rel(cat, s, n, [kind]);
      }
      for (const n of st.names) {
        if (kind === 'table' || kind === 'view' || kind === 'matview' || kind === 'sequence' || kind === 'index') {
          const r = this.rel(cat, s, n, [kind], true);
          if (!r) {
            const other = cat.lookup(n, s.searchPath());
            if (other && !st.ifExists) throw K.err('42809', '"' + qn(n) + '" is not a ' + (kind === 'matview' ? 'materialized view' : kind), { hint: other.kind === 'view' ? 'Use DROP VIEW to remove a view.' : other.kind === 'table' ? 'Use DROP TABLE to remove a table.' : undefined });
            if (st.ifExists) { s.notice((kind === 'matview' ? 'materialized view' : kind) + ' "' + qn(n) + '" does not exist, skipping'); continue; }
            throw K.err(kind === 'index' ? S.undefinedObject : S.undefinedTable, (kind === 'matview' ? 'materialized view' : kind) + ' "' + qn(n) + '" does not exist');
          }
          this.owner(s, r);
          if (kind === 'index') { const t = cat.rel(r.table); if (r.constraint && t.constraints.some((c) => c.index === r.oid)) throw K.err(S.dependentObjects, 'cannot drop index ' + r.name + ' because constraint ' + r.constraint + ' on table ' + t.name + ' requires it', { hint: 'You can drop constraint ' + r.constraint + ' on table ' + t.name + ' instead.' }); yield* this.lock(ctx, t, 'access exclusive'); this.dropIndexObj(r, cat); continue; }
          if (r.kind !== 'sequence') yield* this.lock(ctx, r, 'access exclusive');
          yield* this.dropRel(r, cat, s, st.cascade, ctx);
          continue;
        }
        if (kind === 'schema') {
          const sc = cat.schema(n.name, true);
          if (!sc) { if (st.ifExists) { s.notice('schema "' + n.name + '" does not exist, skipping'); continue; } throw K.err('3F000', 'schema "' + n.name + '" does not exist'); }
          if (sc.system) throw K.err(S.insufficientPrivilege, 'cannot drop schema ' + n.name + ' because it is required by the database system');
          const objs = [...sc.objects.values()].filter((o) => o.oid !== undefined && o.kind !== 'index');
          if (objs.length && !st.cascade) throw K.err(S.dependentObjects, 'cannot drop schema ' + n.name + ' because other objects depend on it', { detail: objs.map((o) => o.kind + ' ' + n.name + '.' + o.name + ' depends on schema ' + n.name).join('\n'), hint: 'Use DROP ... CASCADE to drop the dependent objects too.' });
          for (const o of objs) if (cat.rels.has(o.oid)) yield* this.dropRel(o, cat, s, true, ctx);
          for (const [k] of cat.types) if (k.startsWith(n.name + '.')) cat.types.delete(k);
          cat.schemas.delete(n.name);
          cat.version++;
          continue;
        }
        if (kind === 'type' || kind === 'domain') {
          const t = cat.userType(qn(n), s.searchPath());
          if (!t || (kind === 'domain') !== !!t.domain) { if (st.ifExists) { s.notice('type "' + qn(n) + '" does not exist, skipping'); continue; } throw K.err(S.undefinedObject, 'type "' + qn(n) + '" does not exist'); }
          const users = cat.tables(['table', 'view', 'matview']).filter((r) => r.cols.some((c) => !c.dropped && typeUses(c.type, t)));
          if (users.length && !st.cascade) throw K.err(S.dependentObjects, 'cannot drop type ' + t.name + ' because other objects depend on it', { detail: users.map((r) => { const c = r.cols.find((x) => typeUses(x.type, t)); return 'column ' + c.name + ' of table ' + r.name + ' depends on type ' + t.name; }).join('\n'), hint: 'Use DROP ... CASCADE to drop the dependent objects too.' });
          const deps = [...cat.types.values()].filter((u) => u !== t && u.domain && typeUses(u.base, t));
          if (deps.length && !st.cascade) throw K.err(S.dependentObjects, 'cannot drop type ' + t.name + ' because other objects depend on it', { detail: deps.map((u) => 'type ' + u.name + ' depends on type ' + t.name).join('\n'), hint: 'Use DROP ... CASCADE to drop the dependent objects too.' });
          for (const u of deps) { cat.types.delete(u.schema + '.' + u.name); s.notice('drop cascades to type ' + u.name); }
          for (const r of users) for (const [i, c] of r.cols.entries()) if (typeUses(c.type, t)) { r.cols[i] = Object.assign({}, c, { dropped: true, name: '........pg.dropped.' + (i + 1) + '........' }); s.notice('drop cascades to column ' + c.name + ' of table ' + r.name); }
          cat.types.delete(t.schema + '.' + t.name);
          cat.version++;
          continue;
        }
        if (kind === 'function' || kind === 'procedure') {
          const list = cat.userFuncs(n.name).filter((f) => f.kind === kind && (!n.argTypes || (f.params.filter((p) => p.mode !== 'out').length === n.argTypes.length && f.params.filter((p) => p.mode !== 'out').every((p, i) => T().sqlName(p.type) === T().sqlName(this.typeOf(n.argTypes[i], cat, s))))));
          if (!list.length) { if (st.ifExists) { s.notice(kind + ' ' + n.name + '() does not exist, skipping'); continue; } throw K.err(S.undefinedFunction, kind + ' ' + n.name + (n.argTypes ? '(' + n.argTypes.map((t) => t.name).join(', ') + ')' : '') + ' does not exist'); }
          if (list.length > 1 && !n.argTypes) throw K.err('42725', kind + ' name "' + n.name + '" is not unique', { hint: 'Specify the argument list to select the ' + kind + ' unambiguously.' });
          cat.funcs.set(n.name, cat.userFuncs(n.name).filter((f) => f !== list[0]));
          cat.version++;
          continue;
        }
        if (kind === 'policy') {
          const rel = this.rel(cat, s, st.table, ['table'], st.ifExists);
          if (!rel || !(rel.policies || []).some((p) => p.name === n.name)) { if (st.ifExists) { s.notice('policy "' + n.name + '" for relation "' + qn(st.table) + '" does not exist, skipping'); continue; } throw K.err(S.undefinedObject, 'policy "' + n.name + '" for table "' + rel.name + '" does not exist'); }
          this.owner(s, rel);
          rel.policies = rel.policies.filter((p) => p.name !== n.name);
          cat.version++;
          continue;
        }
        if (kind === 'trigger') {
          const rel = this.rel(cat, s, st.table, ['table', 'view'], st.ifExists);
          if (!rel || !rel.triggers.some((t) => t.name === n.name)) { if (st.ifExists) { s.notice('trigger "' + n.name + '" for relation "' + qn(st.table) + '" does not exist, skipping'); continue; } throw K.err(S.undefinedObject, 'trigger "' + n.name + '" for table "' + qn(st.table) + '" does not exist'); }
          rel.triggers = rel.triggers.filter((t) => t.name !== n.name);
          cat.version++;
          continue;
        }
        if (kind === 'role') {
          if (!cat.roles.has(n.name)) { if (st.ifExists) { s.notice('role "' + n.name + '" does not exist, skipping'); continue; } throw K.err(S.undefinedObject, 'role "' + n.name + '" does not exist'); }
          if (n.name === s.user) throw K.err(S.objectInUse, 'current user cannot be dropped');
          cat.roles.delete(n.name);
          cat.version++;
          continue;
        }
        if (kind === 'assertion') { if (!cat.assertions.delete(n.name) && !st.ifExists) throw K.err(S.undefinedObject, 'assertion "' + n.name + '" does not exist'); continue; }
        if (kind === 'extension' || kind === 'rule') continue;
        throw K.err(S.featureNotSupported, 'DROP ' + kind.toUpperCase() + ' is not supported');
      }
      return tag;
    }
    /** drop a relation and, with CASCADE, what depends on it (views over it, foreign keys to it) */
    *dropRel(r, cat, s, cascade, ctx) {
      if (!cat.rels.has(r.oid)) return;
      const views = cat.tables(['view', 'matview']).filter((v) => v !== r && v.deps && v.deps.has(r.oid));
      const fks = (r.referencedBy || []).filter((x) => x.rel !== r.oid && cat.rel(x.rel));
      const owned = r.kind === 'sequence' && r.ownedBy && cat.rel(r.ownedBy.rel);
      // column defaults calling nextval('this sequence')
      const defaults = r.kind !== 'sequence' ? [] : cat.tables(['table']).flatMap((t) => t.cols.filter((c) => !c.dropped && c.default && !(owned && t === owned && c.name === r.ownedBy.col) && this.nextvalSeqs(c.default, ctx).includes(r)).map((c) => ({ t, c })));
      if ((views.length || fks.length || owned || defaults.length) && !cascade) {
        const lines = fks.map((x) => 'constraint ' + x.name + ' on table ' + cat.rel(x.rel).name + ' depends on table ' + r.name).concat(views.map((v) => (v.kind === 'matview' ? 'materialized view ' : 'view ') + v.name + ' depends on ' + (r.kind === 'view' ? 'view ' : 'table ') + r.name));
        if (owned) lines.push('default value for column ' + r.ownedBy.col + ' of table ' + owned.name + ' depends on sequence ' + r.name);
        for (const d of defaults) lines.push('default value for column ' + d.c.name + ' of table ' + d.t.name + ' depends on sequence ' + r.name);
        throw K.err(S.dependentObjects, 'cannot drop ' + (r.kind === 'matview' ? 'materialized view' : r.kind) + ' ' + r.name + ' because other objects depend on it', { detail: lines.join('\n'), hint: 'Use DROP ... CASCADE to drop the dependent objects too.' });
      }
      for (const x of fks) { const t = cat.rel(x.rel); t.constraints = t.constraints.filter((c) => c.name !== x.name); s.notice('drop cascades to constraint ' + x.name + ' on table ' + t.name); }
      for (const d of defaults) { d.c.default = null; d.c.defaultText = null; s.notice('drop cascades to default value for column ' + d.c.name + ' of table ' + d.t.name); }
      for (const v of views) { s.notice('drop cascades to ' + (v.kind === 'matview' ? 'materialized view ' : 'view ') + v.name); yield* this.dropRel(v, cat, s, true, ctx); }
      // the foreign keys this table has: the referenced tables forget them
      for (const c of r.constraints || []) if (c.kind === 'foreign') { const ref = cat.rel(c.refRel); if (ref && ref !== r) ref.referencedBy = (ref.referencedBy || []).filter((x) => x.rel !== r.oid); }
      for (const o of r.indexes || []) { const ix = cat.rel(o); if (ix) cat.removeRel(ix); }
      for (const c of r.cols || []) if (c.seq && cat.rel(c.seq)) cat.removeRel(cat.rel(c.seq));
      cat.removeRel(r);
      this.db.bus.emit('ddl.drop', { kind: r.kind, name: r.name, oid: r.oid });
    }
    /** the sequences an expression names in nextval('...') calls */
    nextvalSeqs(e, ctx) {
      const out = [];
      const walk = (x) => { if (!x || typeof x !== 'object') return; if (x.k === 'fn' && x.name === 'nextval' && x.args[0] && x.args[0].k === 'lit' && x.args[0].type === 'str') { try { out.push(this.db.seqRel(x.args[0].v, ctx)); } catch (err) { /* already gone */ } } for (const v of Object.values(x)) walk(v); };
      walk(e);
      return out;
    }
    dropIndexObj(ix, cat) { const t = cat.rel(ix.table); if (t) t.indexes = t.indexes.filter((o) => o !== ix.oid); cat.removeRel(ix); }
    *truncate(st, ctx, cat, s) {
      const rels = st.names.map((n) => this.rel(cat, s, n, ['table']));
      for (const r of rels) {
        s.checkPrivilege(r, 'truncate');
        const refs = (r.referencedBy || []).filter((x) => x.rel !== r.oid && !rels.some((y) => y.oid === x.rel));
        if (refs.length && !st.cascade) throw K.err(S.featureNotSupported, 'cannot truncate a table referenced in a foreign key constraint', { detail: 'Table "' + cat.rel(refs[0].rel).name + '" references "' + r.name + '".', hint: 'Truncate table "' + cat.rel(refs[0].rel).name + '" at the same time, or use TRUNCATE ... CASCADE.' });
        if (st.cascade) for (const x of refs) { const t = cat.rel(x.rel); if (!rels.includes(t)) { rels.push(t); s.notice('truncate cascades to table "' + t.name + '"'); } }
      }
      for (const r of rels) {
        yield* this.lock(ctx, r, 'access exclusive');
        // a fresh, empty file: the old one stays until commit, so ROLLBACK brings the rows back
        r.file = this.db.newFile(r.schema + '.' + r.name, 'heap');
        for (const o of r.indexes) { const ix = cat.rel(o); ix.file = this.db.newFile(ix.schema + '.' + ix.name, 'index'); }
        if (st.restart) for (const c of r.cols) if (c.seq) this.db.seqState(cat.rel(c.seq)).restart(cat.rel(c.seq).seq.start);
        this.db.bus.emit('ddl.truncate', { rel: r.name });
      }
      return 'TRUNCATE TABLE';
    }
    *rename(st, ctx, cat, s) {
      if (st.kind === 'schema') { const sc = cat.schema(st.name.name); if (cat.schemas.has(st.to)) throw K.err('42P06', 'schema "' + st.to + '" already exists'); cat.schemas.delete(sc.name); sc.name = st.to; for (const o of sc.objects.values()) if (o.schema !== undefined) o.schema = st.to; cat.schemas.set(st.to, sc); cat.version++; return 'ALTER SCHEMA'; }
      if (st.kind === 'type') { const t = cat.userType(qn(st.name), s.searchPath()); if (!t) throw K.err(S.undefinedObject, 'type "' + qn(st.name) + '" does not exist'); cat.types.delete(t.schema + '.' + t.name); t.name = st.to; t.id = t.schema + '.' + st.to; cat.types.set(t.id, t); cat.version++; return 'ALTER TYPE'; }
      if (st.kind === 'function') { const l = cat.userFuncs(st.name.name); if (!l.length) throw K.err(S.undefinedFunction, 'function ' + st.name.name + ' does not exist'); const f = l[0]; cat.funcs.set(st.name.name, l.slice(1)); f.name = st.to; cat.addFunc(Object.assign(f, { orReplace: true })); return 'ALTER FUNCTION'; }
      if (st.kind === 'trigger') { const rel = this.rel(cat, s, st.table, ['table', 'view']); const t = rel.triggers.find((x) => x.name === st.name.name); if (!t) throw K.err(S.undefinedObject, 'trigger "' + st.name.name + '" for table "' + rel.name + '" does not exist'); t.name = st.to; cat.version++; return 'ALTER TRIGGER'; }
      const kinds = st.kind === 'view' ? ['view', 'matview'] : [st.kind];
      const r = this.rel(cat, s, st.name, kinds, st.ifExists);
      if (!r) { s.notice('relation "' + qn(st.name) + '" does not exist, skipping'); return 'ALTER ' + st.kind.toUpperCase(); }
      this.owner(s, r);
      cat.renameRel(r, st.to);
      return 'ALTER ' + st.kind.toUpperCase();
    }
    *comment(st, ctx, cat, s) {
      if (st.kind === 'column') {
        if (!st.name.schema) throw K.err(S.syntax, 'column name must be qualified');
        const rel = this.rel(cat, s, st.name.catalog ? { schema: st.name.catalog, name: st.name.schema } : { name: st.name.schema }, ['table', 'view', 'matview']);
        const c = rel.cols.find((x) => x.name === st.name.name && !x.dropped);
        if (!c) throw K.err(S.undefinedColumn, 'column "' + st.name.name + '" of relation "' + rel.name + '" does not exist');
        c.comment = st.comment;
        return 'COMMENT';
      }
      const r = this.rel(cat, s, st.name, ['table', 'view', 'matview', 'index', 'sequence']);
      r.comment = st.comment;
      return 'COMMENT';
    }
  }
  const typeUses = (t, u) => t && (t.id === u.id || (t.cat === 'A' && typeUses(t.elem, u)) || (t.domain && typeUses(t.base, u)) || (t.fields && t.fields.some((f) => typeUses(f.type, u))));

  K.DDL = DDL;
})(typeof window !== 'undefined' ? window : globalThis);
