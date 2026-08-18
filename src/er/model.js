// The E-R model: entity sets, attributes, relationship sets, specialization and aggregation, as in chapter 6 of
// Database System Concepts. A model is plain data (see normalize for the shape), so it can be saved as JSON,
// typed in the small text format parsed below, validated, and checked for the design mistakes the chapter warns about.
(function (root) {
  'use strict';
  const K = root.K;
  const ER = K.ER = K.ER || {};
  const lc = (s) => String(s == null ? '' : s).toLowerCase();
  const same = (a, b) => lc(a) === lc(b);
  const q = (s) => "'" + s + "'";

  // ---- shape --------------------------------------------------------------------------------------------------
  // model: { name, entities: [Entity], relationships: [Rel], specializations: [Isa], aggregations: [Agg] }
  // Entity: { name, weak, identifiedBy (name of the identifying relationship, weak only), attributes: [Attr] }
  // Attr: { name, type, key, partial (discriminator), multivalued, derived, from: [names], components: [Attr] }
  // Rel: { name, identifying, participants: [Part], attributes: [Attr] }
  // Part: { entity (entity or aggregation name), role, min, max (number or '*'), total, arrow (n-ary only) }
  //   min..max notation: each entity of the set takes part in at least min and at most max
  //   relationships. For a binary relationship max = 1 on the artist line means each artist has at most one
  //   company (an arrow towards company in the arrow notation). Arrows of n-ary relationships are kept in
  //   'arrow': an arrow to E means each combination of the other participants goes with at most one E.
  // Isa: { name, parent, children: [names], disjoint, total, by (defining attribute), kind: specialization|generalization }
  // Agg: { name, relationship } — the relationship (with its participants) treated as an entity set.
  const MANY = '*';
  function normMax(m) {
    if (m === undefined || m === null || m === '') return MANY;
    if (typeof m === 'number') return m;
    const s = lc(m);
    if (s === '*' || s === 'n' || s === 'm' || s === 'many') return MANY;
    if (s === 'one') return 1;
    const n = Number(s);
    return Number.isFinite(n) ? n : MANY;
  }
  function normAttr(a) {
    if (typeof a === 'string') a = { name: a };
    const o = { name: String(a.name == null ? '' : a.name) };
    if (a.type) o.type = String(a.type);
    for (const f of ['key', 'partial', 'multivalued', 'derived']) if (a[f]) o[f] = true;
    if (a.from && [].concat(a.from).length) o.from = [].concat(a.from).map(String);
    if (a.components && a.components.length) o.components = a.components.map(normAttr);
    if (a.loc) o.loc = a.loc;
    return o;
  }
  function normPart(p) {
    if (typeof p === 'string') p = { entity: p };
    const o = { entity: String(p.entity), min: p.min === undefined || p.min === null ? 0 : Number(p.min), max: normMax(p.max), total: !!p.total };
    if (o.min >= 1) o.total = true;
    else if (o.total && o.min === 0) o.min = 1;
    if (p.role) o.role = String(p.role);
    if (p.arrow) o.arrow = true;
    if (p.guess) o.guess = true;
    if (p.loc) o.loc = p.loc;
    if (p.declaredMin !== undefined) Object.defineProperty(o, 'declaredMin', { value: p.declaredMin, enumerable: false });
    return o;
  }
  function normalize(m) {
    m = m || {};
    const out = {
      name: m.name ? String(m.name) : '',
      entities: (m.entities || []).map((e) => {
        const o = { name: String(e.name), weak: !!e.weak, attributes: (e.attributes || []).map(normAttr) };
        if (e.identifiedBy) o.identifiedBy = String(e.identifiedBy);
        if (e.loc) o.loc = e.loc;
        return o;
      }),
      relationships: (m.relationships || []).map((r) => {
        const o = { name: String(r.name), identifying: !!r.identifying, participants: (r.participants || []).map(normPart), attributes: (r.attributes || []).map(normAttr) };
        if (r.loc) o.loc = r.loc;
        return o;
      }),
      specializations: (m.specializations || []).map((s, i) => {
        const o = { name: s.name ? String(s.name) : 'isa' + (i + 1), parent: String(s.parent), children: (s.children || []).map(String), disjoint: !!s.disjoint, total: !!s.total, kind: s.kind === 'generalization' ? 'generalization' : 'specialization' };
        if (s.by) o.by = String(s.by);
        if (s.loc) o.loc = s.loc;
        return o;
      }),
      aggregations: (m.aggregations || []).map((a) => {
        const o = { name: String(a.name), relationship: String(a.relationship) };
        if (a.loc) o.loc = a.loc;
        return o;
      }),
    };
    for (const e of out.entities) {
      if (!e.weak || e.identifiedBy) continue;
      const r = out.relationships.find((r) => r.identifying && r.participants.some((p) => same(p.entity, e.name)));
      if (r) e.identifiedBy = r.name;
    }
    return out;
  }
  function strip(x) {
    if (Array.isArray(x)) return x.map(strip);
    if (x && typeof x === 'object') { const o = {}; for (const k in x) if (k !== 'loc') o[k] = strip(x[k]); return o; }
    return x;
  }
  ER.MANY = MANY;
  ER.normalize = normalize;
  ER.toJSON = (m) => Object.assign({ format: 'kwery-er', version: 1 }, strip(normalize(m)));
  ER.fromJSON = (j) => {
    const o = typeof j === 'string' ? JSON.parse(j) : j;
    if (!o || typeof o !== 'object' || (o.entities && !Array.isArray(o.entities))) throw new Error('not an E-R model: expected an object with an "entities" array');
    return normalize(o);
  };
  ER.clone = (m) => normalize(JSON.parse(JSON.stringify(m)));

  // ---- lookups ------------------------------------------------------------------------------------------------
  const entity = ER.entity = (m, n) => m.entities.find((e) => same(e.name, n)) || null;
  const relationship = ER.relationship = (m, n) => m.relationships.find((r) => same(r.name, n)) || null;
  const aggregation = ER.aggregation = (m, n) => m.aggregations.find((a) => same(a.name, n)) || null;
  /** leaf attributes with their path: [{ attr, name, path: [names], key, partial, multivalued (from any ancestor) }] */
  function leaves(attrs, path, inh) {
    const out = [];
    for (const a of attrs || []) {
      const p = (path || []).concat(a.name);
      const flags = { key: !!(a.key || (inh && inh.key)), partial: !!(a.partial || (inh && inh.partial)), multivalued: !!(a.multivalued || (inh && inh.multivalued)), derived: !!(a.derived || (inh && inh.derived)) };
      if (a.components && a.components.length) out.push(...leaves(a.components, p, flags));
      else out.push(Object.assign({ attr: a, name: a.name, path: p }, flags));
    }
    return out;
  }
  ER.leaves = leaves;
  /** the specializations an entity set is a child of, and its parents */
  const parentsOf = ER.parents = (m, n) => m.specializations.filter((s) => s.children.some((c) => same(c, n))).map((s) => s.parent);
  ER.children = (m, n) => [].concat(...m.specializations.filter((s) => same(s.parent, n)).map((s) => s.children));
  /** the top of an entity set's specialization hierarchy (first parent at each step) */
  function rootOf(m, n, seen) {
    seen = seen || new Set();
    if (seen.has(lc(n))) return n;
    seen.add(lc(n));
    const ps = parentsOf(m, n);
    return ps.length ? rootOf(m, ps[0], seen) : n;
  }
  ER.rootOf = rootOf;
  /** attributes inherited from higher-level entity sets, nearest first: [{ from, attr }] */
  ER.inherited = (m, n) => {
    const out = [], seen = new Set([lc(n)]);
    const walk = (x) => { for (const p of parentsOf(m, x)) { if (seen.has(lc(p))) continue; seen.add(lc(p)); const e = entity(m, p); if (e) for (const a of e.attributes) out.push({ from: e.name, attr: a }); walk(p); } };
    walk(n);
    return out;
  };
  /** the owner (identifying entity set) of a weak entity set, or null */
  function ownerOf(m, e) {
    if (typeof e === 'string') e = entity(m, e);
    if (!e || !e.weak || !e.identifiedBy) return null;
    const r = relationship(m, e.identifiedBy);
    if (!r) return null;
    const o = r.participants.find((p) => !same(p.entity, e.name));
    return o ? o.entity : null;
  }
  ER.owner = ownerOf;
  /** the key of an entity set as leaf attribute names, following the chapter: a weak entity set's key is its owner's
   *  key plus its discriminator, a lower-level entity set's key is the key of the top of its hierarchy */
  function keyOf(m, n, seen) {
    seen = seen || new Set();
    if (seen.has(lc(n))) return [];
    seen.add(lc(n));
    const ag = aggregation(m, n);
    if (ag) { const r = relationship(m, ag.relationship); return r ? [].concat(...r.participants.map((p) => keyOf(m, p.entity, seen))) : []; }
    const e = entity(m, n);
    if (!e) return [];
    const ps = parentsOf(m, n);
    if (ps.length) return keyOf(m, rootOf(m, n), seen);
    const own = leaves(e.attributes).filter((l) => !l.multivalued && !l.derived);
    if (e.weak) { const o = ownerOf(m, e); return (o ? keyOf(m, o, seen) : []).concat(own.filter((l) => l.partial).map((l) => l.name)); }
    return own.filter((l) => l.key).map((l) => l.name);
  }
  ER.keyOf = keyOf;
  /** binary mapping cardinality read in participant order: '1:1', '1:N', 'N:1' or 'M:N'; null for n-ary */
  ER.mapping = (r) => {
    if (!r || r.participants.length !== 2) return null;
    const [a, b] = r.participants;
    const la = b.max === 1 ? '1' : 'N', lb = a.max === 1 ? '1' : 'N';
    return la === 'N' && lb === 'N' ? 'M:N' : la + ':' + lb;
  };
  ER.isTotal = (p) => !!(p.total || p.min >= 1);
  ER.range = (p) => (ER.isTotal(p) ? Math.max(1, p.min) : p.min) + '..' + p.max;
  /** names an entity set, relationship set or aggregation can be referred to by */
  const isNode = (m, n) => !!(entity(m, n) || aggregation(m, n));

  // ---- validation ---------------------------------------------------------------------------------------------
  /** structural errors and warnings: [{ severity: 'error'|'warning', code, message, at: { entity|relationship|... , attribute }, loc }] */
  function validate(model) {
    const m = normalize(model);
    const out = [];
    const add = (severity, code, message, at, loc) => out.push({ severity, code, message, at: at || {}, loc: loc || null });
    const names = new Map();
    const kinds = [['entity set', m.entities], ['relationship set', m.relationships], ['aggregation', m.aggregations]];
    for (const [kind, list] of kinds) for (const x of list) {
      if (!x.name || !/\S/.test(x.name)) { add('error', 'empty-name', 'a ' + kind + ' has no name', {}, x.loc); continue; }
      const prev = names.get(lc(x.name));
      if (prev) add('error', 'duplicate-name', 'duplicate name ' + q(x.name) + ': it is already used by ' + (prev.kind === kind ? 'another ' : 'a ') + prev.kind + '; entity sets, relationship sets and aggregations share one name space', { [kind.split(' ')[0]]: x.name }, x.loc);
      else names.set(lc(x.name), { kind, x });
    }
    const checkAttrs = (attrs, where, at, isRel, ent) => {
      const seen = new Map();
      const walk = (list, prefix) => {
        for (const a of list) {
          const atA = Object.assign({ attribute: a.name }, at);
          if (!a.name) { add('error', 'empty-name', 'an attribute of ' + where + ' has no name', at, a.loc); continue; }
          if (!prefix) {
            if (seen.has(lc(a.name))) add('error', 'duplicate-attribute', where + ' has two attributes named ' + q(a.name), atA, a.loc);
            seen.set(lc(a.name), a);
          }
          if (a.key && isRel) add('error', 'key-on-relationship', 'attribute ' + q(a.name) + ' of ' + where + ' is marked as a key; a relationship set is identified by its participants, its descriptive attributes cannot be keys', atA, a.loc);
          if (a.partial && isRel) add('error', 'partial-on-relationship', 'attribute ' + q(a.name) + ' of ' + where + ' is marked as a partial key; only a weak entity set has a discriminator', atA, a.loc);
          if (a.key && a.multivalued) add('error', 'key-multivalued', 'multivalued attribute ' + q(a.name) + ' of ' + where + ' cannot be a key: an entity has several values of it, so it cannot identify the entity', atA, a.loc);
          if ((a.key || a.partial) && a.derived) add('error', 'key-derived', 'derived attribute ' + q(a.name) + ' of ' + where + ' cannot be part of a key: it is computed from other attributes and is not stored', atA, a.loc);
          if (a.partial && a.multivalued) add('error', 'key-multivalued', 'multivalued attribute ' + q(a.name) + ' of ' + where + ' cannot be a discriminator', atA, a.loc);
          if (a.key && a.partial) add('error', 'key-and-partial', 'attribute ' + q(a.name) + ' of ' + where + ' is marked both key and partial key', atA, a.loc);
          if (a.components && a.components.length === 1) add('warning', 'composite-single', 'composite attribute ' + q(a.name) + ' of ' + where + ' has only one component; make it a simple attribute', atA, a.loc);
          if (a.components) {
            const cs = new Set();
            for (const c of a.components) { if (cs.has(lc(c.name))) add('error', 'duplicate-attribute', 'composite attribute ' + q(a.name) + ' of ' + where + ' has two components named ' + q(c.name), atA, c.loc); cs.add(lc(c.name)); }
            walk(a.components, a.name);
          }
          if (a.derived && a.from) for (const f of a.from) {
            const known = leaves(attrs).some((l) => l.path.some((p) => same(p, f))) || (ent && ER.inherited(m, ent.name).some((i) => same(i.attr.name, f)));
            if (!known) add('warning', 'derived-source', 'derived attribute ' + q(a.name) + ' of ' + where + ' is computed from ' + q(f) + ', which is not an attribute of ' + where, atA, a.loc);
          }
        }
      };
      walk(attrs, '');
      return seen;
    };
    for (const e of m.entities) {
      const where = 'entity set ' + q(e.name), at = { entity: e.name };
      const own = checkAttrs(e.attributes, where, at, false, e);
      for (const i of ER.inherited(m, e.name)) if (own.has(lc(i.attr.name))) add('error', 'duplicate-attribute', where + ' declares ' + q(i.attr.name) + ', which it already inherits from ' + q(i.from), Object.assign({ attribute: i.attr.name }, at), own.get(lc(i.attr.name)).loc);
      const ls = leaves(e.attributes);
      const isChild = parentsOf(m, e.name).length > 0;
      if (e.weak) {
        if (isChild) add('error', 'weak-subclass', where + ' is both weak and a lower-level entity set; a lower-level entity set takes its key from its higher-level entity set', at, e.loc);
        const ids = m.relationships.filter((r) => r.identifying && r.participants.some((p) => same(p.entity, e.name)));
        if (!e.identifiedBy || !relationship(m, e.identifiedBy)) {
          if (e.identifiedBy) add('error', 'weak-no-identifying', 'weak entity set ' + q(e.name) + ' names ' + q(e.identifiedBy) + ' as its identifying relationship, but there is no relationship set of that name', at, e.loc);
          else add('error', 'weak-no-identifying', 'weak entity set ' + q(e.name) + ' has no identifying relationship: a weak entity set exists only through an identifying relationship with its owner, e.g. identifying relationship ' + e.name + '_of (' + e.name + ' [1..1], owner [0..*])', at, e.loc);
        } else if (!relationship(m, e.identifiedBy).identifying) add('error', 'weak-no-identifying', 'relationship set ' + q(e.identifiedBy) + ' identifies weak entity set ' + q(e.name) + ' but is not marked identifying', at, e.loc);
        if (ids.length > 1) add('warning', 'weak-multiple-identifying', 'weak entity set ' + q(e.name) + ' takes part in ' + ids.length + ' identifying relationships (' + ids.map((r) => r.name).join(', ') + '); only ' + q(e.identifiedBy) + ' is used for its key', at, e.loc);
        for (const l of ls) if (l.key) add('error', 'weak-has-key', 'weak entity set ' + q(e.name) + ' marks ' + q(l.name) + ' as a key; a weak entity set has no key of its own: mark its discriminator with partial', Object.assign({ attribute: l.name }, at), l.attr.loc);
        if (!ls.some((l) => l.partial)) add('warning', 'weak-no-discriminator', 'weak entity set ' + q(e.name) + ' has no discriminator (partial key): it can then have at most one entity per owner entity', at, e.loc);
      } else {
        for (const l of ls) if (l.partial) add('error', 'partial-on-strong', 'attribute ' + q(l.name) + ' of strong entity set ' + q(e.name) + ' is marked as a partial key; only weak entity sets have discriminators (use key)', Object.assign({ attribute: l.name }, at), l.attr.loc);
        if (isChild && ls.some((l) => l.key)) add('warning', 'subclass-has-key', 'lower-level entity set ' + q(e.name) + ' declares key ' + ls.filter((l) => l.key).map((l) => l.name).join(', ') + '; it inherits the key of ' + q(rootOf(m, e.name)) + ' and its own key mark is ignored', at, e.loc);
        if (!isChild && !ls.some((l) => l.key)) add('error', 'missing-key', 'entity set ' + q(e.name) + ' has no key: mark the attribute(s) that identify an entity with key', at, e.loc);
      }
    }
    for (const r of m.relationships) {
      const where = 'relationship set ' + q(r.name), at = { relationship: r.name };
      checkAttrs(r.attributes, where, at, true);
      if (r.participants.length < 2) add('error', 'too-few-participants', where + ' has ' + (r.participants.length ? 'only one participant (' + r.participants[0].entity + ')' : 'no participants') + '; a relationship set associates at least two entity sets (list an entity set twice, with roles, for a recursive relationship)', at, r.loc);
      const counts = new Map();
      for (const p of r.participants) {
        const pat = Object.assign({ participant: p.entity }, at);
        if (!isNode(m, p.entity)) add('error', 'unknown-entity', where + ' refers to ' + q(p.entity) + ', which is not an entity set' + (relationship(m, p.entity) ? ' (it is a relationship set: declare an aggregation of it to relate it)' : ''), pat, p.loc || r.loc);
        counts.set(lc(p.entity), (counts.get(lc(p.entity)) || 0) + 1);
        if (p.max !== MANY && (!Number.isInteger(p.max) || p.max < 1)) add('error', 'cardinality-range', 'the maximum cardinality of ' + p.entity + ' in ' + where + ' is ' + p.max + '; it must be a positive whole number or *', pat, p.loc);
        if (!Number.isInteger(p.min) || p.min < 0) add('error', 'cardinality-range', 'the minimum cardinality of ' + p.entity + ' in ' + where + ' is ' + p.min + '; it must be 0 or more', pat, p.loc);
        else if (p.max !== MANY && p.min > p.max) add('error', 'cardinality-range', p.entity + ' in ' + where + ' has minimum ' + p.min + ' above maximum ' + p.max, pat, p.loc);
        if (p.total && p.declaredMin === 0) add('warning', 'total-min-zero', p.entity + ' in ' + where + ' is marked total but its minimum is 0; total participation means a minimum of at least 1', pat, p.loc);
        if (p.arrow && r.participants.length === 2) add('warning', 'arrow-binary', 'the arrow on ' + p.entity + ' in binary ' + where + ' is ignored; give the other participant a maximum of 1 instead', pat, p.loc);
      }
      for (const [n, c] of counts) if (c > 1) {
        const ps = r.participants.filter((p) => lc(p.entity) === n);
        const roles = new Set(ps.map((p) => lc(p.role || '')));
        if (roles.size < ps.length || roles.has('')) add('error', 'role-needed', where + ' relates ' + ps[0].entity + ' to itself; give each occurrence a distinct role (e.g. ' + ps[0].entity + ' as manager, ' + ps[0].entity + ' as worker)', at, r.loc);
      }
      if (r.participants.length > 2 && r.participants.filter((p) => p.arrow).length > 1) add('warning', 'multiple-arrows', where + ' has arrows to ' + r.participants.filter((p) => p.arrow).map((p) => p.entity).join(' and ') + '; with more than one arrow out of a non-binary relationship set the meaning is ambiguous, so the chapter allows at most one', at, r.loc);
      if (r.identifying) {
        const weak = r.participants.filter((p) => { const e = entity(m, p.entity); return e && e.weak; });
        if (!weak.length) add('error', 'identifying-not-weak', 'identifying relationship set ' + q(r.name) + ' has no weak entity set among its participants', at, r.loc);
        else {
          const w = weak[0];
          if (r.participants.length !== 2) add('warning', 'identifying-not-binary', 'identifying relationship set ' + q(r.name) + ' has ' + r.participants.length + ' participants; it normally links the weak entity set to one owner', at, r.loc);
          if (w.max !== 1) add('error', 'identifying-not-many-to-one', 'identifying relationship set ' + q(r.name) + ' must be many-to-one from ' + q(w.entity) + ' to its owner: each ' + w.entity + ' has exactly one owner, so its maximum must be 1 (it is ' + w.max + ')', Object.assign({ participant: w.entity }, at), w.loc || r.loc);
          if (!ER.isTotal(w)) add('error', 'identifying-partial', 'weak entity set ' + q(w.entity) + ' must participate totally in its identifying relationship ' + q(r.name) + ': a ' + w.entity + ' cannot exist without its owner', Object.assign({ participant: w.entity }, at), w.loc || r.loc);
          if (weak.length === 2 && r.participants.length === 2) add('warning', 'identifying-two-weak', 'both participants of identifying relationship set ' + q(r.name) + ' are weak', at, r.loc);
        }
      }
      const ag = m.aggregations.find((a) => same(a.relationship, r.name));
      if (ag && r.participants.some((p) => same(p.entity, ag.name))) add('error', 'aggregation-self', where + ' takes part in its own aggregation ' + q(ag.name), at, r.loc);
    }
    for (const a of m.aggregations) {
      if (!relationship(m, a.relationship)) add('error', 'unknown-relationship', 'aggregation ' + q(a.name) + ' refers to ' + q(a.relationship) + ', which is not a relationship set', { aggregation: a.name }, a.loc);
    }
    // weak entity sets owned in a cycle have no key
    for (const e of m.entities) {
      if (!e.weak) continue;
      const seen = new Set([lc(e.name)]);
      for (let o = ownerOf(m, e); o; o = ownerOf(m, o)) { if (seen.has(lc(o))) { add('error', 'weak-owner-cycle', 'weak entity set ' + q(e.name) + ' depends on itself through its owners (' + [...seen].join(' -> ') + '); some owner must be a strong entity set', { entity: e.name }, e.loc); break; } seen.add(lc(o)); }
    }
    const childSeen = new Map();
    for (const s of m.specializations) {
      const at = { specialization: s.name };
      if (!entity(m, s.parent)) add('error', 'unknown-parent', 'specialization ' + q(s.name) + ' has higher-level entity set ' + q(s.parent) + ', which is not an entity set', at, s.loc);
      if (!s.children.length) add('error', 'isa-no-children', 'specialization of ' + q(s.parent) + ' has no lower-level entity sets', at, s.loc);
      for (const c of s.children) {
        if (!entity(m, c)) add('error', 'unknown-child', 'specialization of ' + q(s.parent) + ' names ' + q(c) + ', which is not an entity set', at, s.loc);
        if (same(c, s.parent)) add('error', 'isa-self', q(c) + ' cannot be a specialization of itself', at, s.loc);
        const k = lc(s.parent) + '/' + lc(c);
        if (childSeen.has(k)) add('error', 'isa-duplicate-child', q(c) + ' is listed twice as a specialization of ' + q(s.parent), at, s.loc);
        childSeen.set(k, true);
      }
      if (s.by) { const p = entity(m, s.parent); if (p && !leaves(p.attributes).some((l) => same(l.name, s.by))) add('warning', 'isa-attribute', 'specialization of ' + q(s.parent) + ' is defined by attribute ' + q(s.by) + ', which ' + q(s.parent) + ' does not have', at, s.loc); }
    }
    const cycles = new Set();
    for (const e of m.entities) {
      // a cycle in the ISA graph, reported once
      const stack = [[e.name, [e.name]]], seen = new Set();
      let cyc = null;
      while (stack.length && !cyc) {
        const [n, path] = stack.pop();
        for (const p of parentsOf(m, n)) { if (same(p, e.name)) { cyc = path; break; } if (!seen.has(lc(p))) { seen.add(lc(p)); stack.push([p, path.concat(p)]); } }
      }
      const ck = cyc && cyc.map(lc).sort().join('/');
      if (cyc && !cycles.has(ck)) { cycles.add(ck); add('error', 'isa-cycle', 'the specialization hierarchy has a cycle: ' + cyc.concat(e.name).join(' ISA '), { entity: e.name }, e.loc); }
      const ps = parentsOf(m, e.name);
      if (ps.length > 1) {
        const roots = new Set(ps.map((p) => lc(rootOf(m, p))));
        if (roots.size > 1) add('warning', 'multiple-inheritance-keys', 'entity set ' + q(e.name) + ' inherits from ' + ps.join(' and ') + ', which have different keys; it is identified by the key of ' + q(rootOf(m, e.name)) + ' and refers to the others by theirs', { entity: e.name }, e.loc);
      }
    }
    return out;
  }
  ER.validate = validate;
  ER.errors = (m) => validate(m).filter((x) => x.severity === 'error');

  // ---- design checker -----------------------------------------------------------------------------------------
  const norm = (s) => lc(s).replace(/[^a-z0-9]/g, '');
  const singular = (s) => { s = norm(s); return s.replace(/ies$/, 'y').replace(/(ss|us)$/, '$1').replace(/s$/, ''); };
  /** advice on the design, following the chapter's discussion of common mistakes:
   *  [{ severity: 'advice'|'info', code, message, explanation, at }] */
  function check(model) {
    const m = normalize(model);
    const out = [];
    const add = (code, message, explanation, at, severity) => out.push({ severity: severity || 'advice', code, message, explanation, at: at || {} });
    const related = (a, b) => m.relationships.some((r) => r.participants.some((p) => same(p.entity, a)) && r.participants.some((p) => same(p.entity, b)));
    const keys = new Map(m.entities.map((e) => [lc(e.name), keyOf(m, e.name)]));
    for (const e of m.entities) {
      const ls = leaves(e.attributes);
      if (!e.weak && !parentsOf(m, e.name).length && !ls.some((l) => l.key))
        add('missing-key', 'entity set ' + q(e.name) + ' has no key', 'Every strong entity set needs a key: a set of attributes whose values tell any two entities apart. Without one the relational schema for ' + e.name + ' has no primary key, and nothing else can refer to its entities. If no attribute is unique, the entity set may really be weak (identified through an owner) or may need an identifier such as ' + e.name + '_id.', { entity: e.name });
      for (const l of ls) {
        if (l.key || l.partial) continue;
        for (const f of m.entities) {
          if (f === e) continue;
          const fk = keys.get(lc(f.name)) || [];
          const ownKey = keys.get(lc(e.name)) || [];
          if (fk.length === 1 && same(fk[0], l.name) && !ownKey.some((k) => same(k, l.name))) {
            if (related(e.name, f.name)) add('redundant-attribute', 'attribute ' + q(l.name) + ' of ' + q(e.name) + ' repeats the key of ' + q(f.name) + ', which ' + e.name + ' is already related to', 'The relationship between ' + e.name + ' and ' + f.name + ' already records which ' + f.name + ' each ' + e.name + ' goes with. Keeping ' + l.name + ' in ' + e.name + ' as well stores the same fact twice, and the two copies can disagree. Remove the attribute: when the design is reduced to tables, the relationship itself puts ' + l.name + ' into the schema of ' + e.name + ' as a foreign key if it is many-to-one.', { entity: e.name, attribute: l.name });
            else add('fk-attribute', 'attribute ' + q(l.name) + ' of ' + q(e.name) + ' looks like a foreign key to ' + q(f.name), 'In an E-R design a connection between entities is a relationship set, not an attribute holding the other entity\'s key. Modelling it as an attribute hides the connection (no cardinality, no participation constraint, no referential integrity). Replace ' + l.name + ' by a relationship between ' + e.name + ' and ' + f.name + '; the reduction to tables will create the foreign key.', { entity: e.name, attribute: l.name });
            break;
          }
        }
        const other = m.entities.find((f) => f !== e && (singular(f.name) === singular(l.name) || singular(f.name) === singular(l.name.replace(/_?(name|id)$/i, ''))));
        if (other && !out.some((x) => x.at.entity === e.name && x.at.attribute === l.name)) add('attribute-is-entity', 'attribute ' + q(l.name) + ' of ' + q(e.name) + ' names entity set ' + q(other.name), 'An attribute whose values are ' + other.name + ' entities should be a relationship set between ' + e.name + ' and ' + other.name + '. As an attribute, the facts the design records about each ' + other.name + ' are not connected to ' + e.name + '.', { entity: e.name, attribute: l.name });
      }
      for (const a of e.attributes) if (a.multivalued && a.components && a.components.length > 1) add('attribute-could-be-entity', 'multivalued composite attribute ' + q(a.name) + ' of ' + q(e.name) + ' might be an entity set', 'A multivalued attribute with several components (' + a.components.map((c) => c.name).join(', ') + ') describes things that have their own properties. If other entity sets need to refer to them, or they carry more information, make ' + a.name + ' an entity set related to ' + e.name + ' (the chapter discusses phone numbers as attributes versus entities).', { entity: e.name, attribute: a.name }, 'info');
      if (e.weak) {
        const owner = ownerOf(m, e), idr = e.identifiedBy && relationship(m, e.identifiedBy);
        const part = ls.filter((l) => l.partial);
        if (part.length && part.every((l) => /(^id$|_id$|[a-z]id$|_code$|^code$|_key$)/i.test(l.name))) add('weak-could-be-strong', 'weak entity set ' + q(e.name) + ' has discriminator ' + part.map((l) => l.name).join(', ') + ', which looks like an identifier', 'A weak entity set is right when its entities can only be told apart within one owner (section 1 of each course). If ' + part.map((l) => l.name).join(', ') + ' is unique on its own across all ' + (owner || 'owner') + ' entities, ' + e.name + ' can be a strong entity set with that key and an ordinary relationship to ' + (owner || 'its owner') + ', which gives shorter foreign keys in every table that refers to it.', { entity: e.name });
        if (idr) {
          const o = idr.participants.find((p) => !same(p.entity, e.name));
          if (o && o.max === 1) add('weak-one-to-one', 'identifying relationship ' + q(idr.name) + ' is one-to-one', 'Each ' + o.entity + ' has at most one ' + e.name + ', so the discriminator does not distinguish anything. The attributes of ' + e.name + ' could be attributes of ' + o.entity + ', or ' + e.name + ' could be a strong entity set sharing its owner\'s key.', { entity: e.name, relationship: idr.name });
          if (idr.attributes.length) add('identifying-attributes', 'identifying relationship ' + q(idr.name) + ' has descriptive attributes', 'Each ' + e.name + ' takes part in exactly one ' + idr.name + ' relationship, so its attributes (' + idr.attributes.map((a) => a.name).join(', ') + ') can simply be attributes of ' + e.name + '.', { relationship: idr.name }, 'info');
        }
        const uses = m.relationships.filter((r) => !r.identifying && r.participants.some((p) => same(p.entity, e.name))).length;
        if (uses >= 3) add('weak-widely-used', 'weak entity set ' + q(e.name) + ' takes part in ' + uses + ' relationships', 'Every table that refers to ' + e.name + ' must carry its full key: the key of ' + (owner || 'its owner') + ' plus the discriminator. With many references a strong entity set with its own identifier is often simpler.', { entity: e.name }, 'info');
      }
      const inRel = m.relationships.some((r) => r.participants.some((p) => same(p.entity, e.name))) || m.specializations.some((s) => same(s.parent, e.name) || s.children.some((c) => same(c, e.name)));
      if (!inRel && m.entities.length > 1) add('isolated-entity', 'entity set ' + q(e.name) + ' is not related to anything', 'An entity set with no relationships stands apart from the rest of the design. Check whether a relationship is missing, or whether its information belongs as attributes of another entity set.', { entity: e.name }, 'info');
      // an entity set that only links others: its key-less shape plus two or more many-to-one links is a relationship in disguise
      const links = m.relationships.filter((r) => r.participants.length === 2 && r.participants.some((p) => same(p.entity, e.name) && p.max === 1 && ER.isTotal(p)));
      const ownKey = ls.filter((l) => l.key);
      if (!e.weak && links.length >= 2 && ownKey.length === 1 && /^(id|.*_id)$/i.test(ownKey[0].name) && ls.length <= 3 && !m.relationships.some((r) => r.participants.some((p) => same(p.entity, e.name) && p.max !== 1)))
        add('entity-could-be-relationship', 'entity set ' + q(e.name) + ' only connects ' + links.map((r) => r.participants.find((p) => !same(p.entity, e.name)).entity).join(' and '), 'Each ' + e.name + ' is tied to exactly one of each of these entity sets and has little information of its own. That is what a relationship set records: consider replacing ' + e.name + ' by a relationship among them, with ' + ls.filter((l) => !l.key).map((l) => l.name).join(', ') + ' as descriptive attributes.', { entity: e.name }, 'info');
    }
    for (const r of m.relationships) {
      const ps = r.participants;
      if (ps.length >= 3) {
        const arrows = ps.filter((p) => p.arrow);
        if (arrows.length > 1) add('ternary-arrows', 'relationship set ' + q(r.name) + ' has more than one arrow', 'With more than one arrow out of a non-binary relationship set there are two readings (each combination of the others determines each arrowed entity, or something weaker), so the chapter allows at most one. Split the relationship or keep a single arrow.', { relationship: r.name });
        const pairs = [];
        for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
          // only many-to-many binaries: a many-to-one link records a different, functional fact
          const b = m.relationships.find((x) => x !== r && x.participants.length === 2 && ER.mapping(x) === 'M:N' && x.participants.some((p) => same(p.entity, ps[i].entity)) && x.participants.some((p) => same(p.entity, ps[j].entity)));
          if (b) pairs.push(b.name);
        }
        if (pairs.length) add('ternary-overlaps-binary', 'relationship set ' + q(r.name) + ' overlaps binary relationship ' + pairs.join(', '), 'The ' + ps.length + '-ary relationship ' + r.name + ' already relates ' + ps.map((p) => p.entity).join(', ') + '. If ' + pairs.join(' and ') + ' only record facts implied by it, they are redundant; if instead ' + r.name + ' is just a combination of independent binary facts, replace it by binary relationships. Keep the ' + ps.length + '-ary relationship only when the fact really involves all participants at once.', { relationship: r.name });
        if (arrows.length === 1) {
          const others = ps.filter((p) => !p.arrow);
          if (others.length === 2) add('ternary-functional', 'relationship set ' + q(r.name) + ' has an arrow to ' + q(arrows[0].entity), 'Each pair of ' + others.map((p) => p.entity).join(' and ') + ' determines at most one ' + arrows[0].entity + '. Check whether a single one of them already determines it; if so, the arrow belongs on a binary relationship and ' + r.name + ' should be split.', { relationship: r.name }, 'info');
        }
      }
      if (ps.length === 2) {
        const mp = ER.mapping(r);
        if ((mp === 'N:1' || mp === '1:N') && r.attributes.length) {
          const many = ps.find((p) => p.max === 1);
          add('attribute-on-many-side', 'relationship set ' + q(r.name) + ' is ' + (mp === 'N:1' ? 'many-to-one' : 'one-to-many') + ' and has descriptive attributes', 'Each ' + many.entity + ' takes part in at most one ' + r.name + ' relationship, so ' + r.attributes.map((a) => a.name).join(', ') + ' could equally be attributes of ' + many.entity + '. Both designs are correct; keeping them on the relationship makes it clear they describe the association.', { relationship: r.name }, 'info');
        }
        for (const a of leaves(r.attributes)) for (const p of ps) {
          const e = entity(m, p.entity);
          if (e && leaves(e.attributes).some((l) => same(l.name, a.name))) add('redundant-attribute', 'descriptive attribute ' + q(a.name) + ' of ' + q(r.name) + ' is also an attribute of ' + q(e.name), 'The same name on the relationship and on a participant usually means the same fact is stored twice. Keep it in one place: on ' + e.name + ' if it describes the entity, on ' + r.name + ' if it describes the association.', { relationship: r.name, attribute: a.name });
        }
      }
    }
    // several binary relationships around one entity set with a shared descriptive attribute may be one ternary
    for (const e of m.entities) {
      const bins = m.relationships.filter((r) => r.participants.length === 2 && !r.identifying && r.participants.some((p) => same(p.entity, e.name)) && r.participants.every((p) => p.max !== 1));
      for (let i = 0; i < bins.length; i++) for (let j = i + 1; j < bins.length; j++) {
        const common = leaves(bins[i].attributes).filter((a) => leaves(bins[j].attributes).some((b) => same(a.name, b.name)));
        if (common.length) add('binaries-could-be-ternary', 'relationship sets ' + q(bins[i].name) + ' and ' + q(bins[j].name) + ' both record ' + common.map((a) => a.name).join(', ') + ' for ' + q(e.name), 'Two many-to-many relationships through ' + e.name + ' with the same descriptive attribute may describe one event involving all three entity sets. Binary relationships cannot say which pairs belong together; if they do, a single ternary relationship is the right model.', { relationship: bins[i].name });
      }
    }
    for (const s of m.specializations) {
      if (s.children.length === 1 && s.total) add('isa-single-total', 'total specialization of ' + q(s.parent) + ' has a single lower-level entity set ' + q(s.children[0]), 'Every ' + s.parent + ' is then a ' + s.children[0] + ', so the two entity sets have the same entities; merge them.', { specialization: s.name });
      for (const c of s.children) {
        const ce = entity(m, c);
        if (ce && !ce.attributes.length && !m.relationships.some((r) => r.participants.some((p) => same(p.entity, c))) && !ER.children(m, c).length)
          add('isa-empty-child', 'lower-level entity set ' + q(c) + ' adds nothing to ' + q(s.parent), c + ' has no attributes or relationships of its own. A specialization is useful when the lower-level entity sets differ; otherwise an attribute of ' + s.parent + ' (such as a type) records the distinction.', { entity: c }, 'info');
      }
    }
    return out;
  }
  ER.check = check;

  // ---- the text format ----------------------------------------------------------------------------------------
  class ParseError extends Error {
    constructor(message, tok) {
      super('line ' + tok.line + ', column ' + tok.col + ': ' + message);
      this.name = 'ParseError';
      this.reason = message; this.line = tok.line; this.col = tok.col; this.pos = tok.pos; this.length = tok.len || 1;
    }
  }
  ER.ParseError = ParseError;
  function lex(src) {
    const toks = [];
    let i = 0, line = 1, ls = 0;
    const push = (t, v, start) => toks.push({ t, v, pos: start, len: i - start, line, col: start - ls + 1 });
    while (i < src.length) {
      const c = src[i];
      if (c === '\n') { i++; line++; ls = i; continue; }
      if (/\s/.test(c)) { i++; continue; }
      if (c === '#' || (c === '-' && src[i + 1] === '-') || (c === '/' && src[i + 1] === '/')) { while (i < src.length && src[i] !== '\n') i++; continue; }
      const start = i;
      if (/[A-Za-z_]/.test(c)) { while (i < src.length && /[A-Za-z0-9_$]/.test(src[i])) i++; push('word', src.slice(start, i), start); continue; }
      if (/[0-9]/.test(c)) { while (i < src.length && /[0-9]/.test(src[i])) i++; push('num', src.slice(start, i), start); continue; }
      if (c === '"') {
        i++;
        while (i < src.length && src[i] !== '"' && src[i] !== '\n') i++;
        if (src[i] !== '"') throw new ParseError('unterminated quoted name', { line, col: start - ls + 1, pos: start, len: i - start });
        i++; push('word', src.slice(start + 1, i - 1), start); toks[toks.length - 1].quoted = true; continue;
      }
      if (src.startsWith('..', i)) { i += 2; push('op', '..', start); continue; }
      if (src.startsWith('->', i)) { i += 2; push('op', '->', start); continue; }
      if ('()[]{},;:*'.includes(c)) { i++; push('op', c, start); continue; }
      i++;
      throw new ParseError('unexpected character ' + q(c), { line, col: start - ls + 1, pos: start, len: 1 });
    }
    toks.push({ t: 'eof', v: '', pos: src.length, len: 0, line, col: src.length - ls + 1 });
    return toks;
  }
  const ATTR_MODS = new Set(['key', 'partial', 'multi', 'multivalued', 'derived', 'from']);
  const PART_MODS = new Set(['total', 'partial', 'one', 'many', 'as']);
  const STMT = new Set(['entity', 'weak', 'relationship', 'identifying', 'isa', 'specialization', 'generalization', 'specialize', 'generalize', 'aggregation']);
  /** parse the text format into a model; throws ParseError (with line, col, pos) at the first error */
  function parse(src) {
    const toks = lex(String(src || ''));
    let i = 0;
    const tok = () => toks[i];
    const desc = (t) => (t.t === 'eof' ? 'the end of the text' : q(t.v));
    const fail = (msg, t) => { throw new ParseError(msg, t || tok()); };
    const isW = (v) => tok().t === 'word' && !tok().quoted && lc(tok().v) === v;
    const isO = (v) => tok().t === 'op' && tok().v === v;
    const eatW = (v) => (isW(v) ? (i++, true) : false);
    const eatO = (v) => (isO(v) ? (i++, true) : false);
    const expectO = (v, what) => { if (!eatO(v)) fail('expected ' + q(v) + (what ? ' ' + what : '') + ', found ' + desc(tok())); };
    const loc = (t) => ({ line: t.line, col: t.col, pos: t.pos });
    const name = (what) => {
      const t = tok();
      if (t.t !== 'word') fail('expected ' + what + ', found ' + desc(t));
      i++;
      return t.v;
    };
    const model = { entities: [], relationships: [], specializations: [], aggregations: [] };

    function tail(a) {
        // a type: words up to a modifier, ',' or ')', with an optional (n) or (p, s)
        const tw = [];
        while (tok().t === 'word' && !tok().quoted && !ATTR_MODS.has(lc(tok().v))) tw.push(toks[i++].v);
        if (tw.length) {
          let ty = tw.join(' ');
          if (isO('(')) {
            const ps = tok();
            i++;
            const ns = [];
            do { if (tok().t !== 'num') fail('expected a number in the type of ' + q(a.name) + ', found ' + desc(tok())); ns.push(toks[i++].v); } while (eatO(','));
            expectO(')', 'after the type parameters of ' + q(a.name));
            ty += '(' + ns.join(',') + ')';
            if (ns.length > 2) fail('a type takes at most two parameters', ps);
          }
          a.type = ty;
        }
        for (;;) {
          if (eatW('key')) a.key = true;
          else if (eatW('partial')) a.partial = true;
          else if (eatW('multi') || eatW('multivalued')) a.multivalued = true;
          else if (eatW('derived')) { a.derived = true; if (eatW('from')) { a.from = [name('the attribute it is derived from')]; } }
          else if (isW('from')) fail(q('from') + ' must follow derived');
          else break;
        }
    }
    function attr() {
      const t = tok();
      let multi = false;
      if (eatO('{')) multi = true;
      const a = { name: name('an attribute name'), loc: loc(t) };
      if (ATTR_MODS.has(lc(a.name)) && !t.quoted) fail(q(a.name) + ' is a keyword; put an attribute name before it' + (lc(a.name) === 'key' ? ' (e.g. ID key)' : ''), t);
      if (isO('(')) {
        i++;
        if (eatO(')')) a.derived = true; // age() as in the usual notation
        else { a.components = attrList(')'); expectO(')', 'to close the components of ' + q(a.name)); }
      }
      if (multi) { tail(a); expectO('}', 'to close multivalued attribute ' + q(a.name)); a.multivalued = true; }
      tail(a);
      return a;
    }
    function attrList(close) {
      const out = [];
      if (isO(close)) return out;
      for (;;) {
        out.push(attr());
        if (eatO(',')) continue;
        if (isO(close)) return out;
        fail('expected ' + q(',') + ' or ' + q(close) + ' after attribute ' + q(out[out.length - 1].name) + ', found ' + desc(tok()));
      }
    }
    function card() {
      // 1:N, N:1, M:N, 1:1 (binary only): the label on a side says how many of that side go with one of the other
      const start = tok(), labels = [];
      const lab = () => {
        const t = tok();
        if (t.t === 'num' && t.v === '1') { i++; return '1'; }
        if (t.t === 'word' && /^(n|m)$/i.test(t.v)) { i++; return 'N'; }
        if (t.t === 'op' && t.v === '*') { i++; return 'N'; }
        fail('expected 1, N or M in the mapping cardinality, found ' + desc(t));
      };
      labels.push(lab());
      expectO(':', 'in the mapping cardinality');
      labels.push(lab());
      return { labels, tok: start };
    }
    function bound(what) {
      const t = tok();
      if (t.t === 'num') { i++; return Number(t.v); }
      if (t.t === 'op' && t.v === '*') { i++; return MANY; }
      if (t.t === 'word' && /^(n|m)$/i.test(t.v)) { i++; return MANY; }
      fail('expected a number or * for the ' + what + ' cardinality, found ' + desc(t));
    }
    function participant() {
      const t = tok();
      const p = { entity: name('an entity set name'), loc: loc(t) };
      if (PART_MODS.has(lc(p.entity)) && !t.quoted && lc(p.entity) !== 'one' && lc(p.entity) !== 'many') fail(q(p.entity) + ' is a keyword; put the entity set name first', t);
      if (eatW('as')) p.role = name('a role name after as');
      for (;;) {
        if (isO('[')) {
          i++;
          p.min = bound('minimum');
          p.declaredMin = p.min;
          if (eatO('..')) p.max = bound('maximum');
          else { p.max = p.min; }
          expectO(']', 'after the cardinality of ' + q(p.entity));
        } else if (eatW('total')) p.total = true;
        else if (eatW('partial')) p.partial = true;
        else if (eatW('one')) p.one = true;
        else if (eatW('many')) p.many = true;
        else break;
      }
      return p;
    }
    function relStmt(identifying, t0) {
      const r = { name: name('a relationship set name'), identifying, participants: [], attributes: [], loc: loc(t0) };
      let c = null;
      if (tok().t === 'num' || (tok().t === 'word' && /^(n|m)$/i.test(tok().v) && toks[i + 1].t === 'op' && toks[i + 1].v === ':')) c = card();
      expectO('(', 'before the participants of ' + q(r.name));
      if (isO(')')) fail('relationship set ' + q(r.name) + ' needs participants');
      for (;;) {
        r.participants.push(participant());
        if (eatO(',')) continue;
        if (eatO(')')) break;
        fail('expected ' + q(',') + ' or ' + q(')') + ' after participant ' + q(r.participants[r.participants.length - 1].entity) + ', found ' + desc(tok()));
      }
      if (eatW('with') || isO('(')) {
        expectO('(', 'before the descriptive attributes of ' + q(r.name));
        r.attributes = attrList(')');
        expectO(')', 'after the descriptive attributes of ' + q(r.name));
      }
      const ps = r.participants;
      if (c) {
        if (ps.length !== 2) throw new ParseError('a mapping cardinality like ' + c.labels.join(':') + ' applies to binary relationships; ' + q(r.name) + ' has ' + ps.length + ' participants (use [min..max] on each)', c.tok);
        // label on a side = how many of that side per entity of the other side = the other side's maximum
        for (let k = 0; k < 2; k++) if (ps[1 - k].max === undefined) ps[1 - k].max = c.labels[k] === '1' ? 1 : MANY;
      }
      for (const p of ps) {
        if (p.one) {
          if (ps.length === 2) { const o = ps.find((x) => x !== p); if (o.max === undefined) o.max = 1; }
          else p.arrow = true;
        }
        delete p.one; delete p.many;
        if (p.partial) { if (p.total) fail('participant ' + q(p.entity) + ' of ' + q(r.name) + ' is marked both total and partial', toks[i - 1]); delete p.partial; }
      }
      model.relationships.push(r);
    }
    while (tok().t !== 'eof') {
      const t0 = tok();
      if (eatO(';')) continue;
      if (t0.t !== 'word' || !STMT.has(lc(t0.v))) fail('expected entity, weak entity, relationship, identifying relationship, isa or aggregation, found ' + desc(t0));
      if (eatW('weak') || eatW('entity')) {
        const weak = lc(t0.v) === 'weak';
        if (weak && !eatW('entity')) fail('expected entity after weak');
        const e = { name: name('an entity set name'), weak, attributes: [], loc: loc(t0) };
        if (STMT.has(lc(e.name)) && !toks[i - 1].quoted) fail(q(e.name) + ' is a keyword and cannot name an entity set (quote it: "' + e.name + '")', toks[i - 1]);
        if (eatW('owner') || eatW('of')) e.owner = name('the owner entity set');
        if (eatW('via')) e.identifiedBy = name('the identifying relationship set');
        if (eatO('(')) { e.attributes = attrList(')'); expectO(')', 'to close the attributes of ' + q(e.name)); }
        if (!e.identifiedBy && (eatW('via'))) e.identifiedBy = name('the identifying relationship set');
        if (e.owner && !weak) fail('only a weak entity set has an owner', t0);
        model.entities.push(e);
      } else if (eatW('identifying')) {
        if (!eatW('relationship')) fail('expected relationship after identifying');
        relStmt(true, t0);
      } else if (eatW('relationship')) relStmt(false, t0);
      else if (eatW('aggregation')) {
        const a = { name: name('an aggregation name'), loc: loc(t0) };
        if (!eatW('of')) {
          expectO('(', 'or of after aggregation ' + q(a.name));
          a.relationship = name('the relationship set it aggregates');
          expectO(')', 'after the aggregated relationship set');
        } else a.relationship = name('the relationship set it aggregates');
        model.aggregations.push(a);
      } else {
        // isa person (artist, patron) disjoint total [by type]
        const kind = /^gen/i.test(t0.v) ? 'generalization' : 'specialization';
        i++;
        const s = { parent: name('the higher-level entity set'), children: [], kind, loc: loc(t0) };
        if (!eatO('(')) { if (!eatO('->')) eatW('into'); }
        else i--;
        const paren = eatO('(');
        for (;;) {
          s.children.push(name('a lower-level entity set'));
          if (eatO(',')) continue;
          break;
        }
        if (paren) expectO(')', 'after the lower-level entity sets of ' + q(s.parent));
        for (;;) {
          if (eatW('disjoint')) s.disjoint = true;
          else if (eatW('overlapping')) s.disjoint = false;
          else if (eatW('total')) s.total = true;
          else if (eatW('partial')) s.total = false;
          else if (eatW('by')) s.by = name('the attribute that defines the specialization');
          else break;
        }
        model.specializations.push(s);
      }
    }
    // weak entity sets written with 'owner X' and no identifying relationship get one, named <weak>_<owner>
    for (const e of model.entities) {
      if (!e.owner) continue;
      const exists = model.relationships.find((r) => r.identifying && r.participants.some((p) => same(p.entity, e.name)));
      if (!exists && !e.identifiedBy) {
        const r = { name: e.name + '_' + e.owner, identifying: true, participants: [{ entity: e.name, min: 1, max: 1, total: true }, { entity: e.owner, min: 0, max: MANY }], attributes: [], loc: e.loc };
        model.relationships.push(r);
        e.identifiedBy = r.name;
      } else if (!e.identifiedBy) e.identifiedBy = exists.name;
      delete e.owner;
    }
    // the weak side of an identifying relationship is total with exactly one owner; fill that in when not written
    for (const r of model.relationships) if (r.identifying) for (const p of r.participants) {
      const e = model.entities.find((x) => same(x.name, p.entity));
      if (e && e.weak) { if (p.max === undefined) p.max = 1; if (p.min === undefined) p.total = true; }
    }
    return normalize(model);
  }
  ER.parse = parse;
  /** parse without throwing: { model, error } */
  ER.tryParse = (src) => { try { return { model: parse(src), error: null }; } catch (e) { if (e instanceof ParseError) return { model: null, error: e }; throw e; } };

  const qn = (n) => (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(n) && !STMT.has(lc(n)) && !ATTR_MODS.has(lc(n)) && !PART_MODS.has(lc(n)) && !['with', 'of', 'via', 'owner', 'by', 'into', 'disjoint', 'overlapping'].includes(lc(n)) ? n : '"' + n + '"');
  function attrText(a) {
    let s = qn(a.name);
    if (a.components) s += ' (' + a.components.map(attrText).join(', ') + ')';
    if (a.derived && !a.from && !a.components) s += '()';
    if (a.multivalued) s = '{' + s + '}';
    if (a.type) s += ' ' + a.type;
    if (a.key) s += ' key';
    if (a.partial) s += ' partial';
    if (a.derived && (a.from || a.components)) s += ' derived' + (a.from ? ' from ' + qn(a.from[0]) : '');
    return s;
  }
  /** the model in the text format (parse(toText(m)) gives m back) */
  function toText(model) {
    const m = normalize(model);
    const lines = [];
    for (const e of m.entities) lines.push((e.weak ? 'weak ' : '') + 'entity ' + qn(e.name) + ' (' + e.attributes.map(attrText).join(', ') + ')' + (e.weak && e.identifiedBy ? ' via ' + qn(e.identifiedBy) : ''));
    for (const r of m.relationships) {
      const ps = r.participants.map((p) => qn(p.entity) + (p.role ? ' as ' + qn(p.role) : '') + ' [' + (ER.isTotal(p) ? Math.max(1, p.min) : p.min) + '..' + p.max + ']' + (ER.isTotal(p) ? ' total' : '') + (p.arrow ? ' one' : ''));
      lines.push((r.identifying ? 'identifying ' : '') + 'relationship ' + qn(r.name) + ' (' + ps.join(', ') + ')' + (r.attributes.length ? ' with (' + r.attributes.map(attrText).join(', ') + ')' : ''));
    }
    for (const s of m.specializations) lines.push((s.kind === 'generalization' ? 'generalization ' : 'isa ') + qn(s.parent) + ' (' + s.children.map(qn).join(', ') + ') ' + (s.disjoint ? 'disjoint' : 'overlapping') + ' ' + (s.total ? 'total' : 'partial') + (s.by ? ' by ' + qn(s.by) : ''));
    for (const a of m.aggregations) lines.push('aggregation ' + qn(a.name) + ' of ' + qn(a.relationship));
    return lines.join('\n') + '\n';
  }
  ER.toText = toText;
  ER.GRAMMAR = [
    'model        := { statement [";"] }',
    'statement    := entity | relationship | isa | aggregation',
    'entity       := ["weak"] "entity" NAME ["owner" NAME] ["via" NAME] "(" [attributes] ")"',
    'attributes   := attribute { "," attribute }',
    'attribute    := ["{"] NAME ["(" attributes ")" | "()"] ["}"] [TYPE] { "key" | "partial" | "multi" | "derived" ["from" NAME] }',
    'TYPE         := WORD { WORD } ["(" INT ["," INT] ")"]          e.g. varchar(20), numeric(8,2), double precision',
    'relationship := ["identifying"] "relationship" NAME [CARD] "(" participant { "," participant } ")" [["with"] "(" attributes ")"]',
    'CARD         := ("1"|"N"|"M") ":" ("1"|"N"|"M")                binary only, in participant order',
    'participant  := NAME ["as" ROLE] { "[" MIN ".." MAX "]" | "total" | "partial" | "one" | "many" }',
    'MAX          := INT | "*" | "N" | "M"',
    'isa          := ("isa" | "specialization" | "generalization") NAME ["->"] ["("] NAME { "," NAME } [")"] { "disjoint" | "overlapping" | "total" | "partial" | "by" NAME }',
    'aggregation  := "aggregation" NAME ("of" NAME | "(" NAME ")")',
    'comments     := "--", "//" or "#" to the end of the line; names may be double-quoted',
  ].join('\n');
})(typeof window !== 'undefined' ? window : globalThis);
