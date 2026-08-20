// Reverse engineering: an E-R model read back from the tables, keys and foreign keys of a Kwery catalog. The
// reduction to tables loses information, so some of the result is a guess; every guess and every loss is listed.
(function (root) {
  'use strict';
  const K = root.K;
  const ER = K.ER;
  const lc = (s) => String(s).toLowerCase();
  const list = (a) => a.join(', ');
  const setEq = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
  const subset = (a, b) => a.every((x) => b.includes(x));

  function typeText(t) {
    if (!t) return undefined;
    if (t.id === 'varchar') return t.n !== undefined ? 'varchar(' + t.n + ')' : 'varchar';
    if (t.id === 'char') return 'char(' + (t.n || 1) + ')';
    if (t.id === 'numeric') return t.p !== undefined ? 'numeric(' + t.p + ',' + t.s + ')' : 'numeric';
    const simple = { int2: 'smallint', int4: 'integer', int8: 'bigint', float4: 'real', float8: 'double precision', bool: 'boolean' };
    return simple[t.id] || (K.T && K.T.sqlName ? K.T.sqlName(t) : t.name);
  }

  /** read a catalog (or a session) back into an E-R model.
   *  opts: { schema: 'public', tables: [names] (default all), weak: 'auto'|'strong', inferImplicit: true }
   *  returns { model, notes: [{ table, kind, message, guess }], lost: [string], tables: { <table>: what it became } } */
  function fromCatalog(catalog, opts) {
    opts = opts || {};
    if (catalog && catalog.catalog && !catalog.tables) catalog = catalog.catalog;
    const schema = opts.schema || 'public';
    const rels = catalog.tables(['table']).filter((r) => r.schema === schema && !r.temp && (!opts.tables || opts.tables.some((n) => lc(n) === lc(r.name))));
    const byOid = new Map(rels.map((r) => [r.oid, r]));
    const notes = [], lost = [], what = {};
    const note = (table, kind, message, guess) => notes.push({ table, kind, message, guess: !!guess });

    // ---- a plain description of every table
    const T = new Map();
    for (const r of rels) {
      const name = (a) => r.cols[a].name;
      const cols = r.cols.map((c, i) => ({ c, i })).filter((x) => !x.c.dropped).map((x) => ({ name: x.c.name, type: typeText(x.c.type), notNull: !!x.c.notNull, serial: !!(x.c.serial || x.c.identity) }));
      const pkC = r.constraints.find((k) => k.kind === 'primary');
      const pk = (pkC ? pkC.cols : r.pk || []).map(name);
      const uniques = r.constraints.filter((k) => k.kind === 'unique').map((k) => k.cols.map(name));
      const fks = r.constraints.filter((k) => k.kind === 'foreign' && byOid.has(k.refRel)).map((k) => {
        const ref = byOid.get(k.refRel);
        const cs = k.cols.map(name);
        return { cols: cs, ref: ref.name, refCols: k.refCols.map((a) => ref.cols[a].name), onDelete: k.onDelete, notNull: cs.every((c) => cols.find((x) => x.name === c).notNull), unique: setEq(cs, pk) || uniques.some((u) => setEq(u, cs)) };
      });
      for (const k of r.constraints) if (k.kind === 'foreign' && !byOid.has(k.refRel)) note(r.name, 'outside', 'foreign key of ' + r.name + ' to a table outside the tables being read is ignored');
      const checks = r.constraints.filter((k) => k.kind === 'check').map((k) => k.text);
      T.set(r.name, { name: r.name, cols, pk, uniques, fks, checks, referencedBy: [] });
    }
    for (const t of T.values()) for (const fk of t.fks) if (fk.ref !== t.name) T.get(fk.ref).referencedBy.push(t.name);
    const fkCols = (t) => new Set([].concat(...t.fks.map((f) => f.cols)));

    // ---- classify
    for (const t of T.values()) {
      const inFk = fkCols(t);
      const nonFk = t.cols.filter((c) => !inFk.has(c.name));
      const pkFks = t.fks.filter((f) => subset(f.cols, t.pk));
      const pkAllFk = t.pk.length > 0 && t.pk.every((c) => inFk.has(c));
      const exact = t.fks.filter((f) => setEq(f.cols, t.pk) && f.ref !== t.name);
      if (!t.pk.length) { t.kind = 'entity'; note(t.name, 'no-key', t.name + ' has no primary key: it becomes an entity set without a key (fix that before using it)'); continue; }
      if (exact.length && (nonFk.length > 0 || t.fks.length === exact.length) && !(exact.length === 1 && t.fks.length > 1 && nonFk.length === 0)) {
        t.kind = 'child'; t.parents = exact.map((f) => f.ref);
        continue;
      }
      if (pkAllFk && t.fks.length >= 2 && !t.fks.some((f) => f.ref === t.name && setEq(f.cols, t.pk))) {
        t.kind = 'relationship';
        continue;
      }
      // a side table: the owner's key plus value columns, all of it the primary key. One value column, or a name
      // made from the owner's name, reads as a multivalued attribute; otherwise it is a weak entity set
      if (t.fks.length === 1 && pkFks.length === 1 && t.cols.length === t.pk.length && t.pk.length > pkFks[0].cols.length && !t.referencedBy.length && pkFks[0].ref !== t.name) {
        const extra = t.pk.filter((c) => !pkFks[0].cols.includes(c));
        const named = lc(t.name).startsWith(lc(pkFks[0].ref) + '_');
        if (extra.length === 1 || named) {
          t.kind = 'multivalued'; t.owner = pkFks[0].ref; t.values = extra;
          t.attrName = extra.length === 1 ? extra[0] : named ? t.name.slice(pkFks[0].ref.length + 1) : t.name;
          continue;
        }
      }
      const ownerFk = pkFks.find((f) => f.cols.length < t.pk.length && f.ref !== t.name);
      if (ownerFk && opts.weak !== 'strong') { t.kind = 'weak'; t.ownerFk = ownerFk; continue; }
      t.kind = 'entity';
    }
    // a relationship table that other tables refer to is an aggregation
    const aggName = (t) => t.name + '_agg';
    const nodeName = (refTable) => { const r = T.get(refTable); return r.kind === 'relationship' ? aggName(r) : r.kind === 'multivalued' ? null : r.name; };

    const model = { name: schema, entities: [], relationships: [], specializations: [], aggregations: [] };
    const used = new Set();
    const relName = (want) => { let n = want, k = 2; while (used.has(lc(n))) n = want + '_' + k++; used.add(lc(n)); return n; };
    for (const t of T.values()) if (t.kind !== 'relationship' && t.kind !== 'multivalued') used.add(lc(t.name));
    const attrOf = (t, c, extra) => Object.assign({ name: c.name, type: c.type }, extra || {});

    // entity sets
    const consumed = new Map(); // table -> Set of columns represented by relationships
    const consume = (t, cs) => { if (!consumed.has(t.name)) consumed.set(t.name, new Set()); for (const c of cs) consumed.get(t.name).add(c); };
    for (const t of T.values()) {
      if (t.kind === 'child') consume(t, t.pk);
      if (t.kind === 'weak') consume(t, t.ownerFk.cols);
    }
    // foreign keys of entity tables become binary relationships
    const binRels = [];
    for (const t of T.values()) {
      if (t.kind === 'relationship' || t.kind === 'multivalued') continue;
      for (const fk of t.fks) {
        if (t.kind === 'child' && setEq(fk.cols, t.pk)) continue;
        if (t.kind === 'weak' && fk === t.ownerFk) continue;
        const target = nodeName(fk.ref);
        if (!target) continue;
        if (fk.cols.some((c) => t.pk.includes(c)) && t.kind === 'entity') note(t.name, 'key-fk', 'foreign key (' + list(fk.cols) + ') of ' + t.name + ' is part of its primary key; it is read as a relationship, and the key keeps those columns', true);
        consume(t, fk.cols.filter((c) => !t.pk.includes(c)));
        const self = fk.ref === t.name;
        const name = relName(t.name + '_' + fk.ref);
        const one = fk.unique;
        const r = { name, participants: [
          { entity: t.name, min: fk.notNull ? 1 : 0, max: 1, total: fk.notNull, guess: true, role: self ? t.name : undefined },
          { entity: target, min: 0, max: one ? 1 : '*', guess: true, role: self ? (fk.cols.length === 1 ? fk.cols[0] : fk.cols.join('_')) : undefined },
        ], attributes: [] };
        binRels.push(r);
        what[t.name + '.' + list(fk.cols)] = 'relationship ' + name;
        note(t.name, one ? 'one-to-one' : 'many-to-one', 'foreign key (' + list(fk.cols) + ') of ' + t.name + ' to ' + fk.ref + ' becomes relationship ' + name + ': ' + (one ? 'one-to-one, because the foreign key is ' + (setEq(fk.cols, t.pk) ? 'the primary key' : 'UNIQUE') : 'many-to-one from ' + t.name + ' to ' + fk.ref) + '; participation of ' + t.name + ' guessed ' + (fk.notNull ? 'total (the column is NOT NULL)' : 'partial (the column allows nulls)') + ', of ' + fk.ref + ' guessed partial (a foreign key cannot say whether every ' + fk.ref + ' is referenced)', true);
      }
    }
    // undeclared references: a column named like the first key column of another table that has no foreign key
    const remodel = new Map(); // table -> key column, for tables whose extra key columns are really a multivalued attribute
    if (opts.inferImplicit !== false) {
      for (const t of T.values()) {
        if (t.kind === 'relationship' || t.kind === 'multivalued') continue;
        for (const c of t.cols) {
          if (t.pk.includes(c.name) || fkCols(t).has(c.name)) continue;
          for (const u of T.values()) {
            if (u === t || u.kind !== 'entity' || !u.pk.length || lc(u.pk[0]) !== lc(c.name) || u.fks.length) continue;
            if (u.pk.length > 1) {
              const other = [...T.values()].some((x) => x !== t && x !== u && x.fks.some((f) => f.ref === u.name));
              if (other) continue;
              remodel.set(u.name, u.pk[0]);
            }
            consume(t, [c.name]);
            const name = relName(t.name + '_' + u.name);
            binRels.push({ name, participants: [{ entity: t.name, min: c.notNull ? 1 : 0, max: 1, total: c.notNull, guess: true }, { entity: u.name, min: 0, max: '*', guess: true }], attributes: [] });
            note(t.name, 'implicit', 'column ' + c.name + ' of ' + t.name + ' has no foreign key, but its name is the ' + (u.pk.length > 1 ? 'first column of the primary key (' + list(u.pk) + ')' : 'primary key') + ' of ' + u.name + '; it is read as relationship ' + name + ' (many-to-one)' + (u.pk.length > 1 ? '. A foreign key was impossible because ' + c.name + ' alone is not a key of ' + u.name + ': the reduction of an entity set with a multivalued attribute whose own table was dropped looks exactly like this' : ''), true);
            break;
          }
        }
      }
    }

    for (const t of T.values()) {
      if (t.kind === 'relationship' || t.kind === 'multivalued') continue;
      const skip = consumed.get(t.name) || new Set();
      const e = { name: t.name, weak: t.kind === 'weak', attributes: [] };
      if (remodel.has(t.name)) {
        const k = remodel.get(t.name);
        const kc = t.cols.find((c) => c.name === k);
        e.attributes.push(attrOf(t, kc, { key: true }));
        const rest = t.cols.filter((c) => c.name !== k);
        e.attributes.push({ name: 'entries', multivalued: true, components: rest.map((c) => attrOf(t, c)) });
        note(t.name, 'multivalued', t.name + ' is read as entity set ' + t.name + ' with key ' + k + ' and a multivalued composite attribute entries (' + list(rest.map((c) => c.name)) + '): its primary key (' + list(t.pk) + ') is ' + k + ' plus the parts of one value. The name entries is made up', true);
        what[t.name] = 'entity set ' + t.name + ' (with a multivalued attribute)';
        model.entities.push(e);
        continue;
      }
      for (const c of t.cols) {
        if (skip.has(c.name)) continue;
        if (t.kind === 'child' && t.pk.includes(c.name)) continue;
        const a = attrOf(t, c);
        if (t.kind === 'entity' && t.pk.includes(c.name)) a.key = true;
        if (t.kind === 'weak' && t.pk.includes(c.name)) a.partial = true;
        if (c.serial) note(t.name, 'serial', t.name + '.' + c.name + ' is generated (serial/identity); that is a physical detail and is kept as an ordinary attribute');
        e.attributes.push(a);
      }
      if (t.kind === 'weak') {
        const o = t.ownerFk;
        const r = { name: relName(t.name + '_' + o.ref), identifying: true, participants: [{ entity: t.name, min: 1, max: 1, total: true }, { entity: nodeName(o.ref), min: 0, max: '*', guess: true }], attributes: [] };
        e.identifiedBy = r.name;
        model.relationships.push(r);
        const disc = t.pk.filter((c) => !o.cols.includes(c));
        note(t.name, 'weak', t.name + ' is read as a weak entity set owned by ' + o.ref + ': its primary key (' + list(t.pk) + ') holds the foreign key (' + list(o.cols) + ') to ' + o.ref + ' plus ' + list(disc) + ', which tell ' + t.name + ' entities apart only within one ' + o.ref + '; so ' + list(disc) + ' is the discriminator and ' + r.name + ' the identifying relationship' + (o.onDelete === 'cascade' ? ' (on delete cascade agrees: a ' + t.name + ' does not outlive its ' + o.ref + ')' : '') + '. Reading it as a strong entity set instead (option weak: strong) would put ' + list(o.cols) + ' into its key as an attribute, the very thing a relationship should express', true);
        what[t.name] = 'weak entity set ' + t.name;
      } else if (t.kind === 'child') {
        what[t.name] = 'entity set ' + t.name + ' (specialization of ' + list(t.parents) + ')';
        note(t.name, 'specialization', t.name + ' is read as a specialization of ' + list(t.parents) + ': its primary key is exactly a foreign key to ' + list(t.parents) + ' (the first method of reducing a specialization); whether this is really ISA or a one-to-one relationship is a guess', true);
      } else what[t.name] = 'entity set ' + t.name;
      model.entities.push(e);
    }
    // specializations, grouped by parent
    const byParent = new Map();
    for (const t of T.values()) if (t.kind === 'child') for (const p of t.parents) { if (!byParent.has(p)) byParent.set(p, []); byParent.get(p).push(t.name); }
    for (const [p, cs] of byParent) model.specializations.push({ name: 'isa_' + p, parent: p, children: cs, disjoint: false, total: false });
    if (byParent.size) lost.push('whether a specialization is disjoint or overlapping, total or partial: the tables of the first method look the same either way (read as overlapping and partial)');

    // relationship tables
    for (const t of T.values()) {
      if (t.kind !== 'relationship') continue;
      const at = (f) => { const i = Math.min(...f.cols.map((c) => t.pk.indexOf(c)).filter((i) => i >= 0)); return Number.isFinite(i) ? i : 1e9 + t.cols.findIndex((c) => c.name === f.cols[0]); };
      const parts = t.fks.map((f) => ({ f, node: nodeName(f.ref) })).filter((x) => x.node).sort((a, b) => at(a.f) - at(b.f));
      const fkc = fkCols(t);
      const dup = (n) => parts.filter((x) => x.node === n).length > 1;
      const n = parts.length;
      const outside = parts.filter((x) => !subset(x.f.cols, t.pk));
      const r = { name: relName(t.name), participants: [], attributes: t.cols.filter((c) => !fkc.has(c.name)).map((c) => attrOf(t, c)) };
      for (const x of parts) {
        const isKey = setEq(x.f.cols, t.pk) || t.uniques.some((u) => setEq(u, x.f.cols));
        const p = { entity: x.node, min: 0, max: n === 2 ? (isKey ? 1 : '*') : '*', guess: true };
        if (dup(x.node)) p.role = x.f.cols.length === 1 ? x.f.cols[0] : x.f.cols.join('_');
        if (n > 2 && outside.includes(x)) p.arrow = true;
        r.participants.push(p);
      }
      // a binary relationship table whose key is one side's foreign key is many-to-one; the other side's foreign
      // key may sit outside the primary key
      Object.defineProperty(r, 'table', { value: t.name, enumerable: false });
      model.relationships.push(r);
      const kind = n > 2 ? n + '-ary' : r.participants.every((p) => p.max === 1) ? 'one-to-one' : r.participants.some((p) => p.max === 1) ? 'many-to-one' : 'many-to-many';
      what[t.name] = 'relationship ' + r.name + ' (' + kind + ')';
      note(t.name, 'relationship', t.name + ' is read as ' + kind + ' relationship ' + r.name + ' between ' + list(parts.map((x) => x.f.ref)) + ': ' + (kind === 'many-to-many' || n > 2 ? 'its primary key is made of foreign keys to the participants' : 'its primary key is the foreign key to ' + parts.find((x) => setEq(x.f.cols, t.pk) || t.uniques.some((u) => setEq(u, x.f.cols))).f.ref + ', so each ' + parts.find((x) => setEq(x.f.cols, t.pk) || t.uniques.some((u) => setEq(u, x.f.cols))).f.ref + ' goes with at most one ' + parts.find((x) => !(setEq(x.f.cols, t.pk))).f.ref) + (r.attributes.length ? '; ' + list(r.attributes.map((a) => a.name)) + ' become' + (r.attributes.length > 1 ? '' : 's') + ' descriptive attribute' + (r.attributes.length > 1 ? 's' : '') : '') + (n > 2 && outside.length === 1 ? '; ' + outside[0].f.ref + ' is outside the key, so each combination of the others determines one ' + outside[0].f.ref + ' (an arrow)' : '') + '. Participation is unknown (read as partial)', true);
      const refs = t.referencedBy.filter((x) => T.get(x).kind !== 'multivalued');
      if (refs.length) {
        model.aggregations.push({ name: aggName(t), relationship: r.name });
        used.add(lc(aggName(t)));
        note(t.name, 'aggregation', 'relationship table ' + t.name + ' is referenced by ' + list(refs) + ', so relationship ' + r.name + ' is treated as an entity set: aggregation ' + aggName(t), true);
      }
    }
    // multivalued side tables
    for (const t of T.values()) {
      if (t.kind !== 'multivalued') continue;
      const owner = T.get(t.owner);
      const e = owner.kind === 'relationship' ? model.relationships.find((x) => x.table === owner.name) : model.entities.find((x) => x.name === t.owner);
      if (!e) continue;
      const cs = t.values.map((v) => t.cols.find((x) => x.name === v));
      e.attributes.push(cs.length === 1 ? { name: cs[0].name, type: cs[0].type, multivalued: true } : { name: t.attrName, multivalued: true, components: cs.map((c) => ({ name: c.name, type: c.type })) });
      what[t.name] = 'multivalued attribute ' + e.name + '.' + t.attrName;
      note(t.name, 'multivalued', t.name + ' is read as multivalued ' + (cs.length > 1 ? 'composite ' : '') + (owner.kind === 'relationship' ? 'descriptive attribute ' + t.attrName + ' of relationship ' : 'attribute ' + t.attrName + ' of ') + e.name + ': it has only the key of ' + t.owner + ' (as a foreign key) and ' + (cs.length > 1 ? 'the columns ' + list(t.values) + ' (its name begins with ' + t.owner + '_)' : 'one more column') + ', and all of it is the primary key; a weak entity set with no attributes beyond its discriminator would look the same', true);
    }
    model.relationships.push(...binRels);
    for (const t of T.values()) if (t.checks.length) note(t.name, 'check', 'check constraints of ' + t.name + ' (' + t.checks.join('; ') + ') are domain rules, outside the E-R model');

    lost.push(
      'relationship names: a foreign key does not record the relationship it came from (names are made from the table names)',
      'composite attributes: their components became separate columns, and nothing groups them again',
      'derived attributes: they were never stored',
      'participation constraints: NOT NULL suggests total participation on the side holding the foreign key, but total participation of the referenced side, and of any side of a many-to-many relationship, leaves no trace',
      'cardinality limits other than 0, 1 and many (such as 2..4)',
      'descriptive attributes of a many-to-one relationship combined into the many side: they look like ordinary attributes of that entity set',
      'role names, except where an entity set takes part twice (the column names are used then)',
      'the identifying relationship of a weak entity set (its schema was redundant and never made); it is rebuilt from the primary key',
    );
    lost.push('a side table holding only its owner\'s key and values: read as a multivalued attribute when it has one value column or is named <owner>_<attribute>, otherwise as a weak entity set (the two reduce to the same shape)');
    return { model: ER.normalize(model), notes, lost, tables: what };
  }
  ER.fromCatalog = fromCatalog;
  ER.typeText = typeText;
})(typeof window !== 'undefined' ? window : globalThis);
