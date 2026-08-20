// Reduction of an E-R model to relational schemas, following the rules of the chapter one at a time. Every step
// says which rule it applied and why, so a student can follow how each table, column and constraint came about.
(function (root) {
  'use strict';
  const K = root.K;
  const ER = K.ER;
  const lc = (s) => String(s).toLowerCase();
  const same = (a, b) => lc(a) === lc(b);
  const q = (s) => "'" + s + "'";
  const list = (a) => a.join(', ');

  ER.RULES = {
    'strong-entity': 'Strong entity set: one schema with its simple attributes; its key becomes the primary key',
    'composite-attribute': 'Composite attribute: flattened into one column per component; the composite itself gets no column',
    'multivalued-attribute': 'Multivalued attribute: a separate schema of the entity set\'s key and the attribute, with a foreign key to the entity set',
    'derived-attribute': 'Derived attribute: not stored; it can be computed when needed (in a view or a query)',
    'weak-entity': 'Weak entity set: its attributes plus the primary key of its owner; the primary key is the owner\'s key and the discriminator',
    'identifying-relationship': 'Identifying relationship: its schema would repeat the weak entity set\'s schema, so it is not created',
    'relationship-many-to-many': 'Many-to-many relationship set: its own schema with the primary keys of the participants and its descriptive attributes',
    'relationship-many-to-one': 'Many-to-one relationship set: combined with the schema of the many side, which gets the primary key of the one side as a foreign key',
    'relationship-many-to-one-separate': 'Many-to-one relationship set kept as its own schema: the primary key is the many side\'s key',
    'relationship-one-to-one': 'One-to-one relationship set: combined with one side\'s schema; the foreign key is UNIQUE',
    'relationship-one-to-one-separate': 'One-to-one relationship set kept as its own schema: either participant\'s key is a candidate key',
    'relationship-n-ary': 'Non-binary relationship set: its own schema with the primary keys of all participants',
    'specialization-per-entity': 'Specialization, first method: a schema for the higher-level entity set and one for each lower-level entity set holding the higher-level key and its own attributes',
    'specialization-lower-only': 'Specialization, second method: no schema for the higher-level entity set; each lower-level schema holds all inherited attributes',
    'specialization-single-table': 'Specialization as a single schema: the lower-level attributes join the higher-level schema, with a column saying which lower-level entity sets an entity belongs to',
    'specialization-fallback': 'Specialization method not applicable here: the first method is used instead',
    'aggregation': 'Aggregation: the aggregated relationship set\'s schema stands for the aggregation; its primary key is what other relationships refer to',
    'unenforced': 'A constraint of the E-R design that foreign keys, NOT NULL and UNIQUE cannot express',
  };

  // words that must be quoted as identifiers in PostgreSQL (and Kwery)
  const PG_RESERVED = new Set(('all analyse analyze and any array as asc asymmetric authorization binary both case cast check collate collation column concurrently constraint create cross current_catalog current_date current_role current_schema current_time current_timestamp current_user default deferrable desc distinct do else end except false fetch for foreign freeze from full grant group having ilike in initially inner intersect into is isnull join lateral leading left like limit localtime localtimestamp natural not notnull null offset on only or order outer overlaps placing primary references returning right select session_user similar some symmetric system_user table tablesample then to trailing true union unique user using variadic verbose when where window with').split(' '));
  const ident = (n) => (/^[a-z_][a-z0-9_$]*$/i.test(n) && !PG_RESERVED.has(lc(n)) && !(K.RESERVED && K.RESERVED.has(lc(n))) ? n : '"' + String(n).replace(/"/g, '""') + '"');
  ER.ident = ident;
  const idLike = (n) => /(^id$|_id$|id$|_no$|_num$|number$|code$)/i.test(n);

  const METHODS = { 'per-entity': 'per-entity', 'table-per-entity': 'per-entity', 'first': 'per-entity', 'lower-only': 'lower-only', 'second': 'lower-only', 'single-table': 'single-table', 'single': 'single-table' };

  /** reduce a model to relational schemas.
   *  opts: { specialization: 'per-entity'|'lower-only'|'single-table' or { <isa name or parent>: method },
   *          defaultType: 'varchar(30)', mergeManyToOne: true, avoidNulls: false, oneToOne: 'merge'|'separate',
   *          useRoles: false (name foreign key columns after roles even when not recursive), comments: false }
   *  returns { tables: [Table], steps: [Step], ddl, statements: [sql], drop }
   *  Table: { name, source: { kind, name }, columns: [{ name, type, notNull, origin }], primaryKey: [col],
   *           uniques: [[col]], foreignKeys: [{ columns, references, refColumns, onDelete, reason, alter }], checks: [{ expr, reason }] }
   *  Step: { rule, title, source, target, reason } */
  function toRelational(model, opts) {
    opts = opts || {};
    const m = ER.normalize(model);
    const errs = ER.errors(m);
    if (errs.length) { const e = new Error('the model has errors: ' + errs.map((x) => x.message).join('; ')); e.problems = errs; throw e; }
    const defType = opts.defaultType || 'varchar(30)';
    const tables = [], byName = new Map(), steps = [];
    const step = (rule, source, target, reason) => steps.push({ rule, title: ER.RULES[rule], source, target: target || null, reason });
    const tableName = (want) => { let n = want, k = 2; while (byName.has(lc(n))) n = want + '_' + k++; return n; };
    const newTable = (want, source) => { const t = { name: tableName(want), source, columns: [], primaryKey: [], uniques: [], foreignKeys: [], checks: [] }; tables.push(t); byName.set(lc(t.name), t); return t; };
    const col = (t, n) => t.columns.find((c) => same(c.name, n));
    const addCol = (t, want, type, notNull, origin, prefixes) => {
      let n = want;
      for (const p of prefixes || []) { if (!col(t, n)) break; n = p + '_' + want; }
      let k = 2;
      while (col(t, n)) n = want + '_' + k++;
      t.columns.push({ name: n, type: type || defType, notNull: !!notNull, origin });
      return n;
    };

    // ---- the method for each specialization
    const method = new Map();
    const referenced = (n) => m.relationships.some((r) => r.participants.some((p) => same(p.entity, n))) || m.aggregations.some((a) => { const r = ER.relationship(m, a.relationship); return r && r.participants.some((p) => same(p.entity, n)); });
    for (const s of m.specializations) {
      const o = opts.specialization;
      let want = (o && typeof o === 'object' ? o[s.name] || o[s.parent] : o) || 'per-entity';
      want = METHODS[lc(want)] || 'per-entity';
      let why = null;
      if (want === 'lower-only') {
        if (!s.total || !s.disjoint) why = 'the second method needs a total, disjoint specialization: ' + (s.total ? '' : 'with a partial specialization a ' + s.parent + ' that is in no lower-level entity set would have nowhere to be stored') + (!s.total && !s.disjoint ? '; ' : '') + (s.disjoint ? '' : 'with an overlapping one an entity in two lower-level sets would be stored twice');
        else if (referenced(s.parent)) why = s.parent + ' takes part in relationships, and without a ' + s.parent + ' table their foreign keys would have no single table to refer to';
        else if (ER.parents(m, s.parent).length) why = s.parent + ' is itself a lower-level entity set';
        else if (m.specializations.some((x) => x !== s && same(x.parent, s.parent))) why = s.parent + ' has more than one specialization';
        else if (m.entities.some((e) => e.weak && same(ER.owner(m, e) || '', s.parent))) why = s.parent + ' owns a weak entity set';
        else if (s.children.some((c) => ER.parents(m, c).length > 1)) why = 'a lower-level entity set has several higher-level entity sets';
      } else if (want === 'single-table') {
        if (s.children.some((c) => ER.parents(m, c).length > 1)) why = 'a lower-level entity set has several higher-level entity sets';
      }
      if (why) { step('specialization-fallback', s.parent, null, 'specialization of ' + s.parent + ' into ' + list(s.children) + ': ' + why + '. Using a table for every entity set.'); want = 'per-entity'; }
      method.set(s, want);
    }
    const isaOf = (child) => m.specializations.filter((s) => s.children.some((c) => same(c, child)));
    const absorbed = (n) => { const ss = isaOf(n); return ss.length === 1 && method.get(ss[0]) === 'single-table'; };
    const dropped = (n) => m.specializations.some((s) => same(s.parent, n) && method.get(s) === 'lower-only');

    // ---- attributes into columns
    const mv = []; // pending multivalued attributes: { ent (owner info), attr }
    function addAttrs(t, attrs, ownerName, nullable, info) {
      for (const a of attrs) {
        if (a.derived) { step('derived-attribute', ownerName + '.' + a.name, t.name, a.name + ' is derived' + (a.from ? ' from ' + list(a.from) : '') + ', so it is computed rather than stored; ' + t.name + ' gets no column for it'); continue; }
        if (a.multivalued) { mv.push({ ownerName, attr: a, info }); continue; }
        if (a.components) {
          const made = [];
          const flat = (cs, path) => {
            for (const c of cs) {
              if (c.derived) { step('derived-attribute', ownerName + '.' + path.concat(c.name).join('.'), t.name, 'component ' + c.name + ' is derived, so it is not stored'); continue; }
              if (c.components) { flat(c.components, path.concat(c.name)); continue; }
              const n = addCol(t, c.name, c.type, false, 'attribute', [path.concat(c.name).slice(0, -1).join('_')]);
              made.push(n);
              info.paths.set(lc(path.concat(c.name).join('.')), n);
              info.paths.set(lc(c.name), info.paths.get(lc(c.name)) || n);
            }
          };
          flat(a.components, [a.name]);
          step('composite-attribute', ownerName + '.' + a.name, t.name, 'composite attribute ' + a.name + ' becomes columns ' + list(made) + ' of ' + t.name);
          continue;
        }
        const n = addCol(t, a.name, a.type, false, 'attribute', [ownerName]);
        info.paths.set(lc(a.name), n);
      }
    }
    const keyColsOf = (info, leafNames) => leafNames.map((k) => info.paths.get(lc(k)) || k);

    // ---- entity sets, owners and higher-level entity sets first
    const ents = new Map(); // lc(name) -> { table, key: [col], types: [type], paths }
    const busy = new Set();
    function ensure(n) {
      const k = lc(n);
      if (ents.has(k)) return ents.get(k);
      if (busy.has(k)) return null;
      busy.add(k);
      const ag = ER.aggregation(m, n);
      const r = ag ? ensureAggregation(ag) : ensureEntity(ER.entity(m, n));
      ents.set(k, r);
      return r;
    }
    const keyTypes = (info) => info.key.map((c) => col(info.table, c).type);
    function inheritFrom(t, parentInfo, parentName, notNull, primary) {
      const cols = parentInfo.key.map((c, i) => addCol(t, c, keyTypes(parentInfo)[i], notNull, 'key', [parentName]));
      if (primary) t.primaryKey = cols.slice();
      return cols;
    }
    function ensureEntity(e) {
      const info = { table: null, key: [], paths: new Map(), entity: e.name };
      const ps = ER.parents(m, e.name);
      if (dropped(e.name)) {
        const s = m.specializations.find((x) => same(x.parent, e.name));
        step('specialization-lower-only', e.name, null, 'specialization of ' + e.name + ' into ' + list(s.children) + ' is total and disjoint, so every ' + e.name + ' is in exactly one lower-level entity set; ' + e.name + ' gets no table and its attributes are repeated in ' + list(s.children));
        info.dropped = true;
        return info;
      }
      if (ps.length && absorbed(e.name)) {
        const s = isaOf(e.name)[0];
        const host = ensure(s.parent);
        info.table = host.table; info.key = host.key.slice(); info.host = host;
        for (const [p, c] of host.paths) info.paths.set(p, c);
        const before = host.table.columns.length;
        addAttrs(host.table, e.attributes, e.name, true, info);
        const added = host.table.columns.slice(before).map((c) => c.name);
        step('specialization-single-table', e.name, host.table.name, e.name + ' is stored in ' + host.table.name + (added.length ? ': its attributes ' + list(added) + ' become nullable columns there (null for entities that are not ' + e.name + ')' : '; it has no attributes of its own'));
        return info;
      }
      if (ps.length) {
        const ss = isaOf(e.name);
        const lower = ss.length === 1 && method.get(ss[0]) === 'lower-only';
        const t = newTable(e.name, { kind: 'entity', name: e.name });
        info.table = t;
        if (lower) {
          const p = ER.entity(m, ss[0].parent);
          addAttrs(t, p.attributes, p.name, false, info);
          const inheritedCols = t.columns.map((c) => c.name);
          const pk = keyColsOf(info, ER.keyOf(m, p.name));
          t.primaryKey = pk.slice(); info.key = pk.slice();
          for (const c of pk) col(t, c).notNull = true;
          addAttrs(t, e.attributes, e.name, false, info);
          step('specialization-lower-only', e.name, t.name, t.name + ' holds the attributes it inherits from ' + p.name + ' (' + list(inheritedCols) + ') and its own; primary key ' + list(pk));
          return info;
        }
        const first = ensure(ps[0]);
        const pk = inheritFrom(t, first, ps[0], true, true);
        info.key = pk.slice();
        for (let i = 0; i < first.key.length; i++) info.paths.set(lc(first.key[i]), pk[i]);
        t.foreignKeys.push({ columns: pk, references: first.table.name, refColumns: first.key.slice(), onDelete: 'cascade', reason: 'each ' + e.name + ' is a ' + ps[0] + '; deleting the ' + ps[0] + ' deletes its ' + e.name + ' row too (cascade)' });
        for (const pn of ps.slice(1)) {
          const pi = ensure(pn);
          let cols = pi.key.map((c) => col(t, c) ? c : null);
          if (cols.some((c) => !c) || !same(ER.rootOf(m, pn), ER.rootOf(m, ps[0]))) {
            cols = inheritFrom(t, pi, pn, true, false);
            t.uniques.push(cols);
          }
          t.foreignKeys.push({ columns: cols, references: pi.table.name, refColumns: pi.key.slice(), onDelete: 'cascade', reason: e.name + ' is also a ' + pn + ' (multiple inheritance)' });
        }
        addAttrs(t, e.attributes, e.name, false, info);
        step('specialization-per-entity', e.name, t.name, t.name + ' has the primary key of ' + list(ps) + ' (' + list(pk) + '), which is also a foreign key to ' + list(ps.map((p) => ensure(p).table.name)) + ', plus its own attributes; the inherited attributes stay in the higher-level table');
        return info;
      }
      if (e.weak) {
        const owner = ER.owner(m, e);
        const oi = ensure(owner);
        const t = newTable(e.name, { kind: 'weak', name: e.name });
        info.table = t;
        const oc = inheritFrom(t, oi, owner, true, false);
        addAttrs(t, e.attributes, e.name, false, info);
        const disc = keyColsOf(info, ER.leaves(e.attributes).filter((l) => l.partial && !l.multivalued && !l.derived).map((l) => l.path.join('.')));
        t.primaryKey = oc.concat(disc);
        for (const c of t.primaryKey) col(t, c).notNull = true;
        info.key = t.primaryKey.slice();
        t.foreignKeys.push({ columns: oc, references: oi.table.name, refColumns: oi.key.slice(), onDelete: 'cascade', reason: 'a ' + e.name + ' exists only with its ' + owner + ' (existence dependence), so deleting the ' + owner + ' deletes its ' + e.name + ' rows (cascade)' });
        step('weak-entity', e.name, t.name, e.name + ' is weak and identified by ' + owner + ': ' + t.name + ' gets ' + owner + '\'s primary key (' + list(oc) + ') as a foreign key; primary key = ' + list(oc) + (disc.length ? ' + discriminator ' + list(disc) : ' (there is no discriminator)'));
        const idr = ER.relationship(m, e.identifiedBy);
        step('identifying-relationship', idr.name, null, 'the schema for ' + idr.name + ' would have the columns ' + list(t.primaryKey) + ', all already in ' + t.name + ', so it is redundant and not created' + (idr.attributes.length ? '; its attributes ' + list(idr.attributes.map((a) => a.name)) + ' go into ' + t.name : ''));
        if (idr.attributes.length) addAttrs(t, idr.attributes, idr.name, true, info);
        return info;
      }
      const t = newTable(e.name, { kind: 'entity', name: e.name });
      info.table = t;
      addAttrs(t, e.attributes, e.name, false, info);
      const pk = keyColsOf(info, ER.keyOf(m, e.name));
      t.primaryKey = pk.slice(); info.key = pk.slice();
      for (const c of pk) col(t, c).notNull = true;
      step('strong-entity', e.name, t.name, e.name + ' is a strong entity set: table ' + t.name + ' (' + list(t.columns.map((c) => c.name)) + ') with primary key ' + list(pk));
      const ls = ER.leaves(e.attributes);
      if (ls.length && ls.every((l) => l.key || l.multivalued) && ls.filter((l) => l.multivalued).length && e.attributes.filter((a) => a.multivalued).length === 1)
        step('multivalued-attribute', e.name, t.name, e.name + ' has only its key and one multivalued attribute; the chapter notes that its own schema is then redundant with the multivalued attribute\'s schema. It is kept here so that other tables can refer to ' + t.name + '.');
      return info;
    }
    function ensureAggregation(ag) {
      const r = ER.relationship(m, ag.relationship);
      const info = relTable(r, 'aggregated by ' + ag.name);
      step('aggregation', ag.name, info.table.name, 'aggregation ' + ag.name + ' treats relationship ' + r.name + ' as an entity set; relationships with ' + ag.name + ' refer to ' + info.table.name + ' by its primary key (' + list(info.key) + ')');
      return info;
    }

    // ---- relationship sets
    const done = new Set();
    // the columns a participant contributes: role names for recursive relationships, entity-prefixed names on clashes
    function wantCols(r, p, pi) {
      const dup = r.participants.filter((x) => same(x.entity, p.entity)).length > 1;
      return pi.key.map((c) => (p.role && (dup || opts.useRoles) ? (pi.key.length === 1 && idLike(p.role) ? p.role : p.role + '_' + c) : c));
    }
    function partCols(t, r, p, pi, notNull, origin, want) {
      want = want || wantCols(r, p, pi);
      return want.map((w, i) => addCol(t, w, keyTypes(pi)[i], notNull, origin || 'foreign key', [p.role || p.entity]));
    }
    function relTable(r, why) {
      if (done.has(r)) return ents.get('rel:' + lc(r.name));
      done.add(r);
      const t = newTable(byName.has(lc(r.name)) ? r.name + '_rel' : r.name, { kind: 'relationship', name: r.name });
      const info = { table: t, key: [], paths: new Map() };
      ents.set('rel:' + lc(r.name), info);
      const parts = r.participants.map((p) => ({ p, info: ensure(p.entity) }));
      // key columns with the same name in two participants (patron.id, artist.id) are prefixed in both
      const wants = parts.map(({ p, info: pi }) => wantCols(r, p, pi));
      const count = new Map();
      for (const w of wants) for (const c of w) count.set(lc(c), (count.get(lc(c)) || 0) + 1);
      const colsOf = parts.map(({ p, info: pi }, i) => partCols(t, r, p, pi, true, null, wants[i].map((c) => (count.get(lc(c)) > 1 ? lc(p.role || p.entity) + '_' + c : c))));
      parts.forEach(({ p, info: pi }, i) => t.foreignKeys.push({ columns: colsOf[i], references: pi.table.name, refColumns: pi.key.slice(), onDelete: 'cascade', reason: 'a ' + r.name + ' relationship means nothing without its ' + (p.role || p.entity) + ', so deleting it deletes the relationship row (cascade)' }));
      addAttrs(t, r.attributes, r.name, true, info);
      let pk, rule;
      const n = r.participants.length;
      if (n > 2) {
        const arrows = parts.map((x, i) => i).filter((i) => parts[i].p.arrow);
        pk = arrows.length === 1 ? [].concat(...colsOf.filter((c, i) => i !== arrows[0])) : [].concat(...colsOf);
        rule = 'relationship-n-ary';
        step(rule, r.name, t.name, r.name + ' relates ' + n + ' entity sets, so it gets its own table with the primary keys of ' + list(r.participants.map((p) => p.role || p.entity)) + (arrows.length === 1 ? '; with the arrow to ' + parts[arrows[0]].p.entity + ', the primary key is the keys of the other participants (' + list(pk) + ')' : '; primary key ' + list(pk)) + (why ? ' (' + why + ')' : ''));
      } else {
        const [a, b] = r.participants;
        if (a.max === 1 && b.max === 1) { pk = colsOf[0]; t.uniques.push(colsOf[1]); rule = 'relationship-one-to-one-separate'; }
        else if (a.max === 1) { pk = colsOf[0]; rule = 'relationship-many-to-one-separate'; }
        else if (b.max === 1) { pk = colsOf[1]; rule = 'relationship-many-to-one-separate'; }
        else { pk = colsOf[0].concat(colsOf[1]); rule = 'relationship-many-to-many'; }
        step(rule, r.name, t.name, rule === 'relationship-many-to-many'
          ? r.name + ' is many-to-many: table ' + t.name + ' with the primary keys of ' + list(r.participants.map((p) => p.role || p.entity)) + ' (' + list(pk) + ')' + (r.attributes.length ? ' and its descriptive attributes' : '') + '; the primary key is the union of the participants\' keys'
          : r.name + ' gets its own table ' + (why ? 'because ' + why : '') + '; primary key ' + list(pk) + (rule === 'relationship-one-to-one-separate' ? ', and ' + list(colsOf[1]) + ' is UNIQUE (one-to-one)' : ''));
      }
      t.primaryKey = pk;
      info.key = pk.slice();
      for (const p of r.participants) if (ER.isTotal(p))
        step('unenforced', r.name, t.name, 'total participation of ' + (p.role || p.entity) + ' in ' + r.name + ' (every ' + p.entity + ' has a row in ' + t.name + ') cannot be expressed by a foreign key; it needs a trigger or an assertion');
      return info;
    }
    function merge(r, many, one, oneToOne) {
      const host = ensure(many.entity), target = ensure(one.entity);
      const t = host.table;
      const total = ER.isTotal(many);
      const cols = target.key.map((c, i) => {
        // the many side may already have an attribute with this name: that attribute was the foreign key all along
        const x = !one.role && !oneToOne && !same(many.entity, one.entity) ? col(t, c) : null;
        return x && x.origin === 'attribute' && !t.primaryKey.includes(x.name) ? x : null;
      });
      let fresh;
      if (cols.every((c) => c)) {
        fresh = cols.map((x, i) => { x.origin = 'foreign key'; x.type = keyTypes(target)[i]; return x.name; });
        step('relationship-many-to-one', r.name, t.name, 'attribute' + (fresh.length > 1 ? 's ' : ' ') + list(fresh) + ' of ' + many.entity + ' repeat' + (fresh.length > 1 ? '' : 's') + ' the key of ' + one.entity + '; that is the same fact as ' + r.name + ', so the existing column is used as the foreign key (the attribute was redundant in the E-R design)');
      } else fresh = partCols(t, r, one, target, false);
      if (total) for (const c of fresh) col(t, c).notNull = true;
      const onDelete = total ? 'restrict' : 'set null';
      t.foreignKeys.push({ columns: fresh, references: target.table.name, refColumns: target.key.slice(), onDelete, reason: total
        ? 'participation of ' + many.entity + ' in ' + r.name + ' is total, so the column is NOT NULL and a ' + one.entity + ' that still has ' + many.entity + ' rows cannot be deleted (restrict); set null would break the total participation'
        : 'participation of ' + many.entity + ' in ' + r.name + ' is partial, so the column may be null; deleting the ' + one.entity + ' sets it to null (set null) and keeps the ' + many.entity });
      if (oneToOne) t.uniques.push(fresh);
      const before = t.columns.length;
      addAttrs(t, r.attributes, r.name, true, host);
      const extra = t.columns.slice(before).map((c) => c.name);
      return { fresh, extra, total };
    }
    for (const r of m.relationships) {
      if (r.identifying || done.has(r)) continue;
      const ag = m.aggregations.find((a) => same(a.relationship, r.name));
      if (ag) { ensure(ag.name); continue; }
      if (r.participants.length !== 2) { relTable(r); continue; }
      const [a, b] = r.participants;
      const hasTable = (p) => !ER.aggregation(m, p.entity) && ensure(p.entity) && ensure(p.entity).table;
      const mvAttr = ER.leaves(r.attributes).some((l) => l.multivalued);
      if (a.max === 1 && b.max === 1) {
        // one-to-one: the foreign key goes on the side whose participation is total
        const order = ER.isTotal(a) || !ER.isTotal(b) ? [a, b] : [b, a];
        const [hold, other] = order;
        let why = null;
        if (opts.oneToOne === 'separate') why = 'one-to-one relationships are kept separate (option oneToOne: separate)';
        else if (mvAttr) why = r.name + ' has a multivalued attribute';
        else if (!hasTable(hold)) why = hold.entity + ' has no table of its own to hold the foreign key';
        else if (opts.avoidNulls && !ER.isTotal(hold)) why = 'neither side participates totally and nulls are to be avoided (option avoidNulls)';
        if (why) { relTable(r, why); continue; }
        const res = merge(r, hold, other, true);
        done.add(r);
        step('relationship-one-to-one', r.name, ensure(hold.entity).table.name, r.name + ' is one-to-one; ' + (ER.isTotal(hold) && ER.isTotal(other) ? 'both sides are total, so either table could take the foreign key (the two entity sets could even share one table); ' : ER.isTotal(hold) ? hold.entity + ' participates totally, so its table takes the foreign key (NOT NULL); ' : 'neither side is total, so the foreign key on ' + hold.entity + ' is nullable; ') + list(res.fresh) + ' refers to ' + ensure(other.entity).table.name + ' and is UNIQUE so that each ' + other.entity + ' goes with at most one ' + hold.entity + (res.extra.length ? '; descriptive attributes ' + list(res.extra) + ' go along' : ''));
        if (ER.isTotal(other)) step('unenforced', r.name, ensure(hold.entity).table.name, 'total participation of ' + other.entity + ' in ' + r.name + ' cannot be enforced by the foreign key in ' + ensure(hold.entity).table.name + '; it needs a trigger or an assertion');
        continue;
      }
      if (a.max === 1 || b.max === 1) {
        const many = a.max === 1 ? a : b, one = many === a ? b : a;
        let why = null;
        if (opts.mergeManyToOne === false) why = 'combining schemas is turned off (option mergeManyToOne: false)';
        else if (!hasTable(many)) why = (ER.aggregation(m, many.entity) ? 'the many side is aggregation ' + many.entity : many.entity + ' has no table of its own') + ', so there is no table to combine it with';
        else if (mvAttr) why = r.name + ' has a multivalued attribute';
        else if (opts.avoidNulls && !ER.isTotal(many)) why = 'participation of ' + many.entity + ' is partial, so combining would leave nulls in ' + ensure(many.entity).table.name + ' for every ' + many.entity + ' without a ' + one.entity + ' (option avoidNulls)';
        if (why) { relTable(r, why); continue; }
        const res = merge(r, many, one, false);
        done.add(r);
        step('relationship-many-to-one', r.name, ensure(many.entity).table.name, r.name + ' is many-to-one from ' + (many.role || many.entity) + ' to ' + (one.role || one.entity) + ': each ' + many.entity + ' has at most one ' + one.entity + ', so the schema for ' + r.name + ' (primary key = the key of ' + many.entity + ') is combined with ' + ensure(many.entity).table.name + ', which gets ' + list(res.fresh) + ' as a foreign key to ' + ensure(one.entity).table.name + (res.total ? '; NOT NULL because the participation of ' + many.entity + ' is total' : '; nullable because the participation of ' + many.entity + ' is partial (null = no ' + one.entity + ')') + (res.extra.length ? '; descriptive attributes ' + list(res.extra) + ' go along' : ''));
        if (ER.isTotal(one)) step('unenforced', r.name, ensure(many.entity).table.name, 'total participation of ' + one.entity + ' in ' + r.name + ' (every ' + one.entity + ' has at least one ' + many.entity + ') cannot be enforced with a foreign key; it needs a trigger or an assertion');
        continue;
      }
      relTable(r);
    }
    for (const e of m.entities) ensure(e.name);
    for (const a of m.aggregations) ensure(a.name);

    // ---- discriminator columns for single-table specializations
    for (const s of m.specializations) {
      if (method.get(s) !== 'single-table') continue;
      const host = ensure(s.parent);
      const t = host.table;
      const vals = s.children.map((c) => "'" + String(c).replace(/'/g, "''") + "'");
      if (s.disjoint) {
        let c = s.by ? host.paths.get(lc(s.by)) : null;
        if (!c) c = addCol(t, (lc(s.parent) + '_type'), 'varchar(' + Math.max(10, ...s.children.map((x) => x.length)) + ')', s.total, 'type');
        else col(t, c).origin = 'type';
        if (s.total) col(t, c).notNull = true;
        t.checks.push({ expr: ident(c) + ' in (' + vals.join(', ') + ')', reason: 'which lower-level entity set a ' + s.parent + ' belongs to' });
        step('specialization-single-table', s.parent, t.name, 'disjoint specialization of ' + s.parent + ': column ' + c + ' says which of ' + list(s.children) + ' an entity is' + (s.total ? ' (NOT NULL: the specialization is total)' : ' (null: none of them, the specialization is partial)'));
      } else {
        const cs = s.children.map((ch) => { const n = addCol(t, 'is_' + lc(ch), 'boolean', true, 'type'); col(t, n).default = 'false'; return n; });
        if (s.total) t.checks.push({ expr: cs.map(ident).join(' or '), reason: 'the specialization is total: every ' + s.parent + ' is in at least one lower-level entity set' });
        step('specialization-single-table', s.parent, t.name, 'overlapping specialization of ' + s.parent + ': one boolean column per lower-level entity set (' + list(cs) + '), since an entity may be in several' + (s.total ? '; a check requires at least one to be true (total)' : ''));
      }
      step('unenforced', s.parent, t.name, 'columns of a lower-level entity set in ' + t.name + ' should be null unless the row belongs to it, and relationships of a lower-level entity set refer to all of ' + t.name + '; checks or triggers would be needed to enforce that');
    }
    for (const s of m.specializations) {
      const mt = method.get(s);
      if (mt === 'per-entity') {
        if (s.disjoint && s.children.length > 1) step('unenforced', s.parent, null, 'disjointness of ' + list(s.children) + ' (no ' + s.parent + ' in two of their tables) cannot be expressed with keys; it needs a trigger or an assertion');
        if (s.total) step('unenforced', s.parent, null, 'total specialization of ' + s.parent + ' (every ' + s.parent + ' row has a row in one of ' + list(s.children) + ') cannot be expressed with foreign keys');
      }
    }

    // ---- multivalued attributes (after the entity tables, in a stable order)
    for (const { ownerName, attr, info } of mv) {
      const owner = info.table ? info : null;
      if (!owner) continue;
      const t = newTable(owner.table.name + '_' + lc(attr.name), { kind: 'multivalued', name: ownerName + '.' + attr.name });
      const kc = owner.key.map((c, i) => addCol(t, c, keyTypes(owner)[i], true, 'key'));
      const vc = [];
      const flat = (a, path) => { if (a.components) { for (const c of a.components) if (!c.derived) flat(c, path.concat(c.name)); } else vc.push(addCol(t, a.name, a.type, true, 'attribute', [path.slice(0, -1).join('_') || ownerName])); };
      flat(attr, [attr.name]);
      t.primaryKey = kc.concat(vc);
      t.foreignKeys.push({ columns: kc, references: owner.table.name, refColumns: owner.key.slice(), onDelete: 'cascade', reason: 'the values belong to their ' + ownerName + ': deleting it deletes them (cascade)' });
      step('multivalued-attribute', ownerName + '.' + attr.name, t.name, attr.name + ' is multivalued: table ' + t.name + ' holds one row per value, with ' + ownerName + '\'s key (' + list(kc) + ') as a foreign key; the primary key is all of its columns (' + list(t.primaryKey) + ')');
    }

    // ---- DDL: tables in foreign key order; foreign keys that close a cycle become ALTER TABLE
    const order = [], state = new Map();
    const visit = (t) => {
      if (state.get(t) === 2) return;
      if (state.get(t) === 1) return;
      state.set(t, 1);
      for (const fk of t.foreignKeys) { const rt = byName.get(lc(fk.references)); if (rt && rt !== t) { if (state.get(rt) === 1) fk.alter = true; else visit(rt); } }
      state.set(t, 2);
      order.push(t);
    };
    for (const t of tables) visit(t);
    const placed = new Set();
    for (const t of order) { for (const fk of t.foreignKeys) { const rt = byName.get(lc(fk.references)); if (rt && rt !== t && !placed.has(rt)) fk.alter = true; } placed.add(t); }
    const ids = (cs) => cs.map(ident).join(', ');
    const fkText = (fk) => 'foreign key (' + ids(fk.columns) + ') references ' + ident(fk.references) + ' (' + ids(fk.refColumns) + ')' + (fk.onDelete && fk.onDelete !== 'no action' ? ' on delete ' + fk.onDelete : '');
    const statements = [];
    for (const t of order) {
      const lines = t.columns.map((c) => '  ' + ident(c.name) + ' ' + c.type + (c.default ? ' default ' + c.default : '') + (c.notNull && !t.primaryKey.includes(c.name) ? ' not null' : ''));
      if (t.primaryKey.length) lines.push('  primary key (' + ids(t.primaryKey) + ')');
      for (const u of t.uniques) lines.push('  unique (' + ids(u) + ')');
      for (const fk of t.foreignKeys) if (!fk.alter) lines.push('  ' + fkText(fk));
      for (const c of t.checks) lines.push('  check (' + c.expr + ')');
      // with opts.comments each table is preceded by where it came from and why its foreign keys act as they do
      const head = opts.comments ? ['-- ' + t.source.kind + ' ' + t.source.name].concat(t.foreignKeys.map((fk) => '--   ' + list(fk.columns) + ' -> ' + fk.references + ': ' + fk.reason)).join('\n') + '\n' : '';
      statements.push(head + 'create table ' + ident(t.name) + ' (\n' + lines.join(',\n') + '\n)');
    }
    for (const t of order) for (const fk of t.foreignKeys) if (fk.alter) statements.push('alter table ' + ident(t.name) + ' add ' + fkText(fk));
    tables.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const ddl = statements.map((s) => s + ';').join('\n\n') + '\n';
    const drop = order.slice().reverse().map((t) => 'drop table if exists ' + ident(t.name) + ' cascade;').join('\n') + '\n';
    return { tables, steps, ddl, statements, drop };
  }
  ER.toRelational = toRelational;
  ER.toSql = (model, opts) => toRelational(model, opts).ddl;
  /** the schemas in the usual notation: artist (person_id, company_id, billed_as, fee) with the key underlined as _person_id_ */
  ER.schemaText = (res) => res.tables.map((t) => t.name + ' (' + t.columns.map((c) => (t.primaryKey.includes(c.name) ? '_' + c.name + '_' : c.name)).join(', ') + ')').join('\n');
})(typeof window !== 'undefined' ? window : globalThis);
