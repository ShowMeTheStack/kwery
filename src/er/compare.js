// Structural comparison of a student's E-R design with a reference design, for exercises. Entity sets are matched
// by name or, when renamed, by their attributes; relationships by the entity sets they connect. Designs the chapter
// treats as equivalent are accepted (an attribute of a one-to-many relationship placed on the many side, a
// composite attribute written as its components), and each difference comes with an explanation.
(function (root) {
  'use strict';
  const K = root.K;
  const ER = K.ER;
  const lc = (s) => String(s).toLowerCase();
  const q = (s) => "'" + s + "'";
  const norm = (s) => lc(s).replace(/[^a-z0-9]/g, '');
  const singular = (s) => { s = norm(s); return s.length > 3 ? s.replace(/ies$/, 'y').replace(/(ss|us)$/, '$1#').replace(/s$/, '').replace(/#$/, '') : s; };
  function lev(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }
  const nameSim = (a, b) => {
    const x = singular(a), y = singular(b);
    if (x === y) return 1;
    if (!x || !y) return 0;
    if (x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x))) return 0.8;
    return Math.max(0, 1 - lev(x, y) / Math.max(x.length, y.length));
  };
  const sameName = (a, b) => nameSim(a, b) >= 0.85;
  const leafNames = (attrs) => ER.leaves(attrs).map((l) => l.name);
  function jaccard(A, B) {
    if (!A.length && !B.length) return 1;
    const used = new Set();
    let hit = 0;
    for (const a of A) { const j = B.findIndex((b, i) => !used.has(i) && sameName(a, b)); if (j >= 0) { used.add(j); hit++; } }
    return hit / (A.length + B.length - hit);
  }
  const findAttr = (attrs, n) => ER.leaves(attrs).find((l) => sameName(l.name, n)) || null;
  const topAttr = (attrs, n) => (attrs || []).find((a) => sameName(a.name, n)) || null;

  /** compare designs: returns { score (0..100), correct, matches: { entities, relationships }, feedback: [{ level, code, message, at }] }
   *  level: 'ok' (an accepted equivalent), 'error', 'warning' or 'info' */
  function compare(student, reference, opts) {
    opts = opts || {};
    const S = ER.normalize(student), R = ER.normalize(reference);
    const fb = [];
    let total = 0, got = 0;
    const point = (ok, w) => { w = w === undefined ? 1 : w; total += w; if (ok) got += w; };
    const say = (level, code, message, at) => fb.push({ level, code, message, at: at || {} });

    // ---- entity sets
    const cands = [];
    for (const r of R.entities) for (const s of S.entities) {
      const ns = nameSim(s.name, r.name), as = jaccard(leafNames(s.attributes), leafNames(r.attributes));
      const ks = jaccard(ER.keyOf(S, s.name), ER.keyOf(R, r.name));
      const score = ns >= 0.85 ? 1 + ns + as * 0.1 : 0.35 * ns + 0.5 * as + 0.15 * ks;
      if (score >= 0.45) cands.push({ r, s, score, by: ns >= 0.85 ? 'name' : 'attributes', as });
    }
    cands.sort((a, b) => b.score - a.score);
    const eMap = new Map(), eRev = new Map(); // student name -> reference name and back
    const ePairs = [];
    for (const c of cands) {
      if (eRev.has(lc(c.r.name)) || eMap.has(lc(c.s.name))) continue;
      eMap.set(lc(c.s.name), c.r.name); eRev.set(lc(c.r.name), c.s.name);
      ePairs.push(c);
      if (c.by === 'attributes') say('info', 'renamed-entity', 'your entity set ' + q(c.s.name) + ' is taken to be ' + q(c.r.name) + ' (they share the attributes ' + leafNames(c.s.attributes).filter((a) => leafNames(c.r.attributes).some((b) => sameName(a, b))).join(', ') + ')', { entity: c.s.name });
    }
    // aggregations map through their relationships later; seed their names now when they match
    const toR = (sn) => eMap.get(lc(sn)) || null;
    const sEntity = (rn) => { const sn = eRev.get(lc(rn)); return sn ? ER.entity(S, sn) : null; };

    for (const r of R.entities) {
      const s = sEntity(r.name);
      if (!s) {
        point(false, 3);
        const asAttr = S.entities.map((e) => ({ e, a: findAttr(e.attributes, r.name) || ER.leaves(e.attributes).find((l) => R.entities.length && ER.keyOf(R, r.name).length === 1 && sameName(l.name, ER.keyOf(R, r.name)[0])) })).find((x) => x.a);
        const asRel = S.relationships.find((x) => sameName(x.name, r.name));
        if (asAttr) say('error', 'entity-as-attribute', q(r.name) + ' should be an entity set: you have it as attribute ' + q(asAttr.a.name) + ' of ' + q(asAttr.e.name) + '. It has attributes of its own (' + leafNames(r.attributes).join(', ') + ') and takes part in relationships, which an attribute cannot.', { entity: r.name });
        else if (asRel) say('warning', 'entity-as-relationship', q(r.name) + ' is an entity set in the reference, but a relationship set in your design. Both can be right; the reference makes it an entity set because ' + (leafNames(r.attributes).length ? 'it has its own identity (key ' + ER.keyOf(R, r.name).join(', ') + ')' : 'other relationships refer to it') + '.', { entity: r.name });
        else say('error', 'missing-entity', 'entity set ' + q(r.name) + ' (with ' + (leafNames(r.attributes).join(', ') || 'no attributes') + ') is missing', { entity: r.name });
        continue;
      }
      point(true);
      // strong or weak
      if (r.weak !== s.weak) {
        if (r.weak) {
          const want = ER.keyOf(R, r.name), have = ER.keyOf(S, s.name);
          const ok = want.every((k) => have.some((h) => sameName(h, k)));
          point(false);
          say(ok ? 'warning' : 'error', 'should-be-weak', q(s.name) + ' should be a weak entity set identified by ' + q(ER.owner(R, r) || '?') + (ok ? ': your key includes the owner\'s key as an ordinary attribute, which works but repeats the identifying relationship inside the key' : ': its entities can only be told apart within one ' + (ER.owner(R, r) || 'owner') + ' (discriminator ' + ER.leaves(r.attributes).filter((l) => l.partial).map((l) => l.name).join(', ') + ')'), { entity: s.name });
        } else { point(false); say('warning', 'should-be-strong', q(s.name) + ' is a strong entity set in the reference (key ' + ER.keyOf(R, r.name).join(', ') + '); it does not need an owner to be identified', { entity: s.name }); }
      } else {
        point(true);
        if (r.weak && ER.owner(R, r) && ER.owner(S, s) && toR(ER.owner(S, s)) !== ER.owner(R, r)) say('error', 'wrong-owner', 'weak entity set ' + q(s.name) + ' should be identified by ' + q(ER.owner(R, r)) + ', not ' + q(ER.owner(S, s)), { entity: s.name });
      }
      // keys
      const rk = r.weak ? ER.leaves(r.attributes).filter((l) => l.partial).map((l) => l.name) : ER.keyOf(R, r.name);
      const sk = s.weak ? ER.leaves(s.attributes).filter((l) => l.partial).map((l) => l.name) : ER.keyOf(S, s.name);
      if (r.weak === s.weak && !ER.parents(R, r.name).length) {
        const okKey = rk.length === sk.length && rk.every((k) => sk.some((x) => sameName(x, k)));
        point(okKey);
        if (!okKey) say('error', 'wrong-key', (r.weak ? 'the discriminator' : 'the key') + ' of ' + q(s.name) + ' should be ' + (rk.join(', ') || 'empty') + (sk.length ? ', not ' + sk.join(', ') : ' (you have none)'), { entity: s.name });
      }
      // attributes
      const rl = ER.leaves(r.attributes), sl = ER.leaves(s.attributes);
      for (const a of rl) {
        if (r.weak && a.partial) continue;
        const hit = sl.find((x) => sameName(x.name, a.name));
        if (hit) {
          point(true, 0.5);
          if (a.multivalued !== hit.multivalued) say('warning', 'multivalued', 'attribute ' + q(hit.name) + ' of ' + q(s.name) + (a.multivalued ? ' should be multivalued: an entity can have several' : ' should be single-valued'), { entity: s.name, attribute: hit.name });
          if (a.derived !== hit.derived) say('info', 'derived', 'attribute ' + q(hit.name) + ' of ' + q(s.name) + (a.derived ? ' is derived in the reference (computed from other attributes)' : ' is stored in the reference, not derived'), { entity: s.name, attribute: hit.name });
          const ra = a.path.length > 1 ? a.path[0] : null, sa = hit.path.length > 1 ? hit.path[0] : null;
          if (ra && !sa && !fb.some((x) => x.code === 'flattened' && x.at.entity === s.name && x.at.composite === ra)) say('ok', 'flattened', q(hit.name) + ' is a component of composite attribute ' + q(ra) + ' in the reference (' + rl.filter((x) => x.path[0] === ra).map((x) => x.name).join(', ') + '); listing the components directly gives the same tables but loses the grouping', { entity: s.name, attribute: hit.name, composite: ra });
          continue;
        }
        if (r.weak && rk.some((k) => sameName(k, a.name))) continue;
        // a composite in the student design standing for the reference's components, or the other way round
        const comp = topAttr(s.attributes, a.path[0]);
        if (a.path.length > 1 && comp && !comp.components) { point(true, 0.5); say('ok', 'composite-as-simple', q(comp.name) + ' of ' + q(s.name) + ' is composite in the reference (' + rl.filter((x) => x.path[0] === a.path[0]).map((x) => x.name).join(', ') + '); a simple attribute is acceptable but loses the structure', { entity: s.name, attribute: comp.name }); continue; }
        if (a.path.length > 1 && comp && fb.some((x) => x.code === 'composite-as-simple' && x.at.attribute === comp.name)) { point(true, 0.5); continue; }
        // on a one-to-many relationship where this entity set is the many side: equivalent
        const onRel = S.relationships.find((x) => x.participants.length === 2 && findAttr(x.attributes, a.name) && x.participants.some((p) => lc(p.entity) === lc(s.name) && p.max === 1));
        if (onRel) { point(true, 0.5); say('ok', 'attribute-on-relationship', q(a.name) + ' is on relationship ' + q(onRel.name) + ' in your design and on ' + q(s.name) + ' in the reference; since each ' + s.name + ' takes part in at most one ' + onRel.name + ', both are correct', { entity: s.name, attribute: a.name }); continue; }
        point(false, 0.5);
        const elsewhere = S.entities.find((e) => e !== s && findAttr(e.attributes, a.name));
        if (elsewhere) say('error', 'misplaced-attribute', 'attribute ' + q(a.name) + ' belongs to ' + q(s.name) + ', but you put it on ' + q(elsewhere.name), { entity: s.name, attribute: a.name });
        else say('error', 'missing-attribute', q(s.name) + ' is missing attribute ' + q(a.name), { entity: s.name, attribute: a.name });
      }
      for (const a of sl) {
        if (rl.some((x) => sameName(x.name, a.name)) || (r.weak && ER.keyOf(R, r.name).some((k) => sameName(k, a.name)) && !a.partial)) {
          if (r.weak && !rl.some((x) => sameName(x.name, a.name))) say('warning', 'owner-key-attribute', 'attribute ' + q(a.name) + ' of ' + q(s.name) + ' is the key of its owner ' + q(ER.owner(R, r)) + '; a weak entity set gets it from the identifying relationship, so it should not be an attribute', { entity: s.name, attribute: a.name });
          continue;
        }
        if (rl.some((x) => x.path.length > 1 && sameName(x.path[0], a.name))) continue;
        // the key of another entity set as an attribute: a relationship in disguise
        const fk = R.entities.find((e) => e !== r && ER.keyOf(R, e.name).length === 1 && sameName(ER.keyOf(R, e.name)[0], a.name));
        if (fk) { point(false, 0.5); say('error', 'foreign-key-attribute', 'attribute ' + q(a.name) + ' of ' + q(s.name) + ' is the key of ' + q(fk.name) + ': the connection to ' + fk.name + ' should be a relationship set, not an attribute (the reduction to tables adds the foreign key)', { entity: s.name, attribute: a.name }); continue; }
        const relAttr = R.relationships.find((x) => findAttr(x.attributes, a.name) && x.participants.some((p) => lc(p.entity) === lc(r.name)));
        if (relAttr) {
          const p = relAttr.participants.find((x) => lc(x.entity) === lc(r.name));
          // reported with the relationship's attributes below
          continue;
        }
        say('info', 'extra-attribute', q(s.name) + ' has attribute ' + q(a.name) + ', which the reference does not have', { entity: s.name, attribute: a.name });
      }
    }
    for (const s of S.entities) if (!toR(s.name)) {
      const asRel = R.relationships.find((x) => sameName(x.name, s.name));
      if (asRel) say('warning', 'relationship-as-entity', 'your entity set ' + q(s.name) + ' is relationship set ' + q(asRel.name) + ' between ' + asRel.participants.map((p) => p.entity).join(' and ') + ' in the reference: it has no identity of its own beyond the entities it connects');
      else say('info', 'extra-entity', 'entity set ' + q(s.name) + ' does not appear in the reference');
    }

    // ---- aggregations (named by their relationship)
    const aggMap = new Map();
    // ---- relationship sets
    const partKey = (m, r, map) => r.participants.map((p) => { const a = ER.aggregation(m, p.entity); return a ? 'agg:' + lc(map(a.relationship) || a.relationship) : lc(map(p.entity) || ('?' + p.entity)); }).sort().join('|');
    const rMapped = new Map(); // reference rel name -> student rel
    const sUsed = new Set();
    const relCands = [];
    // first pass relationships without aggregation participants, so aggregations can be mapped by relationship
    const relName = (rn) => { const r = [...rMapped.entries()].find(([k, v]) => lc(v.name) === lc(rn)); return r ? r[0] : null; };
    const passes = [R.relationships.filter((r) => !r.participants.some((p) => ER.aggregation(R, p.entity))), R.relationships.filter((r) => r.participants.some((p) => ER.aggregation(R, p.entity)))];
    for (const pass of passes) {
      for (const r of pass) {
        const rk = partKey(R, r, (x) => x);
        for (const s of S.relationships) {
          if (sUsed.has(s)) continue;
          const sk = partKey(S, s, (x) => toR(x) || (ER.relationship(S, x) ? relName(x) : null));
          if (sk !== rk) continue;
          relCands.push({ r, s, score: nameSim(r.name, s.name) + jaccard(leafNames(s.attributes), leafNames(r.attributes)) * 0.3 + (r.identifying === s.identifying ? 0.2 : 0) });
        }
      }
      relCands.sort((a, b) => b.score - a.score);
      for (const c of relCands) { if (rMapped.has(c.r.name) || sUsed.has(c.s)) continue; rMapped.set(c.r.name, c.s); sUsed.add(c.s); }
      relCands.length = 0;
    }
    for (const a of R.aggregations) { const s = rMapped.get(a.relationship); if (s) { const sa = S.aggregations.find((x) => lc(x.relationship) === lc(s.name)); if (sa) aggMap.set(lc(sa.name), a.name); } }

    for (const r of R.relationships) {
      const s = rMapped.get(r.name);
      const parts = r.participants.map((p) => p.entity).join(', ');
      if (!s) {
        point(false, 3);
        if (r.identifying) { const w = r.participants.find((p) => { const e = ER.entity(R, p.entity); return e && e.weak; }); const sw = w && sEntity(w.entity); if (sw && !sw.weak) continue; }
        // a ternary replaced by binaries, or a missing relationship
        if (r.participants.length > 2) {
          const pairs = S.relationships.filter((x) => !sUsed.has(x) && x.participants.length === 2 && x.participants.every((p) => r.participants.some((rp) => lc(rp.entity) === lc(toR(p.entity) || ''))));
          if (pairs.length) { say('error', 'ternary-as-binaries', 'relationship ' + q(r.name) + ' relates ' + parts + ' at once; your binary relationships ' + pairs.map((x) => q(x.name)).join(', ') + ' cannot say which combinations belong together (the chapter\'s point about replacing a ternary relationship by binary ones)', { relationship: r.name }); continue; }
        }
        const sameNamed = S.relationships.find((x) => sameName(x.name, r.name) && !sUsed.has(x));
        if (sameNamed) say('error', 'wrong-participants', 'relationship ' + q(sameNamed.name) + ' should relate ' + parts + ', but yours relates ' + sameNamed.participants.map((p) => p.entity).join(', '), { relationship: r.name });
        else {
          const sAttr = r.participants.length === 2 && S.entities.map((e) => ({ e, a: ER.leaves(e.attributes).find((l) => { const other = r.participants.find((p) => lc(p.entity) !== lc(toR(e.name) || '')); return other && ER.keyOf(R, other.entity).some((k) => sameName(k, l.name)); }) })).find((x) => x.a && r.participants.some((p) => lc(p.entity) === lc(toR(x.e.name) || '')));
          if (sAttr) say('error', 'relationship-as-attribute', 'relationship ' + q(r.name) + ' between ' + parts + ' is missing; your attribute ' + q(sAttr.a.name) + ' of ' + q(sAttr.e.name) + ' stands for it, but a connection between entity sets should be a relationship set', { relationship: r.name });
          else say('error', 'missing-relationship', 'relationship ' + q(r.name) + ' between ' + parts + ' is missing', { relationship: r.name });
        }
        continue;
      }
      point(true);
      if (r.identifying !== s.identifying) say('warning', 'identifying', 'relationship ' + q(s.name) + (r.identifying ? ' should be identifying (it identifies a weak entity set)' : ' should not be identifying'), { relationship: s.name });
      // align participants: same entity set, then role names, then order
      const sp = s.participants.slice();
      const pairs = r.participants.map((p) => {
        const cand = sp.filter((x) => { const a = ER.aggregation(S, x.entity); const mapped = a ? aggMap.get(lc(a.name)) : toR(x.entity); return lc(mapped || '') === lc(p.entity); });
        const pick = cand.find((x) => p.role && x.role && sameName(x.role, p.role)) || cand[0];
        if (pick) sp.splice(sp.indexOf(pick), 1);
        return [p, pick];
      });
      // a recursive relationship whose roles are named differently: pair its participants by what they say (the
      // pairing with the fewest differences in cardinality and participation), not by their order
      const mappedOf = (x) => { const a = ER.aggregation(S, x.entity); return lc((a ? aggMap.get(lc(a.name)) : toR(x.entity)) || ''); };
      const recursive = r.participants.some((p, i) => r.participants.some((y, j) => j !== i && lc(y.entity) === lc(p.entity)));
      const byRole = pairs.every(([p, x]) => !x || (p.role && x.role && sameName(x.role, p.role)));
      if (recursive && !byRole && r.participants.length <= 6) {
        const diff = (p, x) => (r.participants.length === 2 ? ((p.max === 1) !== (x.max === 1) ? 2 : 0) + (p.max !== x.max ? 0.5 : 0) : !!p.arrow !== !!x.arrow ? 2 : 0) + (ER.isTotal(p) !== ER.isTotal(x) ? 1 : 0);
        let best = null, bestD = Infinity;
        const used = new Set();
        const go = (i, acc, d) => {
          if (d >= bestD) return;
          if (i === r.participants.length) { bestD = d; best = acc.slice(); return; }
          const p = r.participants[i];
          const cand = s.participants.filter((x) => !used.has(x) && mappedOf(x) === lc(p.entity));
          if (!cand.length) { acc.push([p, undefined]); go(i + 1, acc, d); acc.pop(); return; }
          for (const x of cand) { used.add(x); acc.push([p, x]); go(i + 1, acc, d + diff(p, x)); acc.pop(); used.delete(x); }
        };
        go(0, [], 0);
        if (best) best.forEach((pr, i) => { pairs[i] = pr; });
      }
      let cardOk = true, partOk = true;
      pairs.forEach(([p, x], i) => {
        if (!x) return;
        const other = r.participants[1 - i] || r.participants[0];
        if (r.participants.length === 2) {
          if ((p.max === 1) !== (x.max === 1)) { cardOk = false; say('error', 'cardinality', 'in ' + q(s.name) + ', each ' + p.entity + (p.max === 1 ? ' should go with at most one ' + other.entity + ', but yours allows many' : ' may go with many ' + other.entity + ' entities, but yours allows at most one') + ' (the reference is ' + ER.mapping(r) + ' for ' + r.participants.map((y) => y.role || y.entity).join(', ') + ')', { relationship: s.name, participant: p.entity }); }
          else if (p.max !== x.max && p.max !== ER.MANY && x.max !== ER.MANY) say('info', 'range', 'the maximum for ' + p.entity + ' in ' + q(s.name) + ' is ' + p.max + ' in the reference, ' + x.max + ' in yours', { relationship: s.name });
        } else if (!!p.arrow !== !!x.arrow) { cardOk = false; say('error', 'cardinality', 'in ' + q(s.name) + ', the reference ' + (p.arrow ? 'has' : 'does not have') + ' an arrow to ' + p.entity + (p.arrow ? ': each combination of the other participants determines one ' + p.entity : ''), { relationship: s.name, participant: p.entity }); }
        if (ER.isTotal(p) !== ER.isTotal(x)) { partOk = false; say('warning', 'participation', 'participation of ' + p.entity + ' in ' + q(s.name) + ' should be ' + (ER.isTotal(p) ? 'total: every ' + p.entity + ' takes part in at least one ' + s.name : 'partial: a ' + p.entity + ' need not take part in ' + s.name), { relationship: s.name, participant: p.entity }); }
        if (p.role && !x.role && r.participants.filter((y) => lc(y.entity) === lc(p.entity)).length > 1) say('warning', 'role', 'give ' + p.entity + ' a role (such as ' + q(p.role) + ') in recursive relationship ' + q(s.name), { relationship: s.name });
      });
      point(cardOk); point(partOk, 0.5);
      // descriptive attributes
      const mapping = ER.mapping(r);
      const many = r.participants.length === 2 && (mapping === '1:N' || mapping === 'N:1') ? r.participants.find((p) => p.max === 1) : null;
      for (const a of ER.leaves(r.attributes)) {
        if (findAttr(s.attributes, a.name)) { point(true, 0.5); continue; }
        const se = many && sEntity(many.entity);
        if (se && findAttr(se.attributes, a.name)) { point(true, 0.5); say('ok', 'attribute-on-many-side', q(a.name) + ' of relationship ' + q(r.name) + ' is on ' + q(se.name) + ' in your design; ' + r.name + ' is ' + (mapping === 'N:1' ? 'many-to-one' : 'one-to-many') + ' and each ' + se.name + ' takes part in at most one, so this is equivalent', { relationship: s.name, attribute: a.name }); continue; }
        point(false, 0.5);
        const on = S.entities.find((e) => findAttr(e.attributes, a.name));
        if (on) say('error', 'attribute-belongs-to-relationship', 'attribute ' + q(a.name) + ' should be on relationship ' + q(s.name) + ': it depends on ' + r.participants.map((p) => p.entity).join(' and ') + ' together' + (mapping === 'M:N' ? ' (a many-to-many relationship)' : '') + ', not on ' + q(on.name) + ' alone', { relationship: s.name, attribute: a.name });
        else say('error', 'missing-attribute', 'relationship ' + q(s.name) + ' is missing descriptive attribute ' + q(a.name), { relationship: s.name, attribute: a.name });
      }
      for (const a of ER.leaves(s.attributes)) if (!findAttr(r.attributes, a.name)) {
        const owner = r.participants.map((p) => ({ p, e: ER.entity(R, p.entity) })).find((x) => x.e && findAttr(x.e.attributes, a.name));
        if (owner && r.participants.length === 2 && owner.p.max === 1) continue; // accepted above as the many side
        if (owner) say('warning', 'attribute-belongs-to-entity', 'attribute ' + q(a.name) + ' of relationship ' + q(s.name) + ' describes ' + q(owner.e.name) + ' alone; put it on the entity set', { relationship: s.name, attribute: a.name });
        else say('info', 'extra-attribute', 'relationship ' + q(s.name) + ' has attribute ' + q(a.name) + ', which the reference does not have', { relationship: s.name, attribute: a.name });
      }
    }
    for (const s of S.relationships) if (!sUsed.has(s)) {
      if (s.participants.length > 2) {
        const bins = R.relationships.filter((x) => x.participants.length === 2 && x.participants.every((p) => s.participants.some((sp) => lc(toR(sp.entity) || '') === lc(p.entity))));
        if (bins.length) { say('warning', 'binaries-as-ternary', 'your relationship ' + q(s.name) + ' joins ' + s.participants.map((p) => p.entity).join(', ') + '; the reference uses binary relationships ' + bins.map((x) => q(x.name)).join(', ') + ' because those facts are independent of each other', { relationship: s.name }); continue; }
      }
      if (s.identifying) { const w = s.participants.find((p) => { const e = ER.entity(S, p.entity); return e && e.weak; }); const rw = w && ER.entity(R, toR(w.entity) || ''); if (rw && !rw.weak) continue; }
      say('info', 'extra-relationship', 'relationship ' + q(s.name) + ' (' + s.participants.map((p) => p.entity).join(', ') + ') does not appear in the reference', { relationship: s.name });
    }

    // ---- specialization
    for (const r of R.specializations) {
      const s = S.specializations.find((x) => lc(toR(x.parent) || '') === lc(r.parent) && x.children.some((c) => r.children.some((rc) => lc(rc) === lc(toR(c) || ''))));
      if (!s) {
        point(false, 2);
        say('error', 'missing-specialization', 'specialization of ' + q(r.parent) + ' into ' + r.children.join(', ') + ' is missing' + (r.children.every((c) => sEntity(c)) ? ' (you have the entity sets but not the ISA link: they should inherit the key and attributes of ' + r.parent + ')' : ''), { specialization: r.name });
        continue;
      }
      point(true);
      const missing = r.children.filter((c) => !s.children.some((sc) => lc(toR(sc) || '') === lc(c)));
      point(!missing.length);
      if (missing.length) say('error', 'specialization-children', 'specialization of ' + q(s.parent) + ' should include ' + missing.join(', '), { specialization: s.name });
      if (r.disjoint !== s.disjoint) say('warning', 'disjointness', 'specialization of ' + q(s.parent) + ' should be ' + (r.disjoint ? 'disjoint: an entity belongs to at most one of ' + r.children.join(', ') : 'overlapping: an entity may belong to several of ' + r.children.join(', ')), { specialization: s.name });
      if (r.total !== s.total) say('warning', 'completeness', 'specialization of ' + q(s.parent) + ' should be ' + (r.total ? 'total: every ' + r.parent + ' belongs to one of them' : 'partial: some ' + r.parent + ' entities belong to none of them'), { specialization: s.name });
      point(r.disjoint === s.disjoint && r.total === s.total, 0.5);
    }
    for (const r of R.aggregations) {
      const s = rMapped.get(r.relationship);
      const ok = s && S.aggregations.some((a) => lc(a.relationship) === lc(s.name));
      point(!!ok);
      if (!ok) say('error', 'missing-aggregation', 'relationship ' + q(r.relationship) + ' should be aggregated (treated as an entity set) so that other relationships can involve it as a whole', { aggregation: r.name });
    }
    // the checker's design advice on the student's model, where it concerns attributes standing in for relationships
    for (const c of ER.check(S)) if ((c.code === 'fk-attribute' || c.code === 'redundant-attribute') && !fb.some((x) => x.at.entity === c.at.entity && x.at.attribute === c.at.attribute)) say('warning', c.code, c.message + '. ' + c.explanation, c.at);
    const errors = fb.filter((x) => x.level === 'error').length;
    const score = total ? Math.round((got / total) * 100) : 100;
    if (!errors && !fb.some((x) => x.level === 'warning')) say('ok', 'match', 'the design matches the reference' + (fb.some((x) => x.level === 'ok') ? ' (with the equivalent choices noted)' : ''));
    return { score, correct: errors === 0, matches: { entities: ePairs.map((c) => ({ student: c.s.name, reference: c.r.name, by: c.by })), relationships: [...rMapped.entries()].map(([r, s]) => ({ student: s.name, reference: r })) }, feedback: fb };
  }
  ER.compare = compare;
  ER.nameSimilarity = nameSim;
})(typeof window !== 'undefined' ? window : globalThis);
