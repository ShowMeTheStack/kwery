// Equivalence rules of the relational algebra (the standard list for query optimization), as rewrites.
//   rulesAt(expr, path, src)       -> the rules that apply at one node, each with its rewritten subtree
//   applicable(expr, src)          -> for every node, the rules that apply there
//   applyRule(expr, path, id, src) -> the whole expression with one rule applied at path
// A path is a list of child keys from the root ('child', 'left', 'right'). Every rewrite is checked against the
// schemas (the result must name valid attributes and produce the same attributes), so a rule is only offered
// where it is valid. Attribute order is not significant in these rules; where a reordering would reach
// a positional operator (∪ ∩ −) above it, the rewrite adds a projection that restores the order.
(function (root) {
  'use strict';
  const K = root.K;
  const A = K.Algebra;
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const conj = (c) => (c && c.k === 'and' ? c.items.slice() : c ? [c] : []);
  const and = (items) => (!items.length ? null : items.length === 1 ? items[0] : { k: 'and', items: items.reduce((a, x) => a.concat(x.k === 'and' ? x.items : [x]), []) });
  const refs = (e) => { const out = []; const w = (x) => { if (!x || typeof x !== 'object') return; if (x.k === 'attr') { out.push(x); return; } for (const k in x) if (k !== 'pos') w(x[k]); }; w(e); return out; };
  const resolves = (e, attrs) => { try { for (const r of refs(e)) A.resolve(attrs, r); return true; } catch (err) { return false; } };
  const isTheta = (n) => n.op === 'join' && n.cond;
  const isNatural = (n) => n.op === 'join' && !n.cond;
  const SET = new Set(['union', 'intersect', 'minus']);

  const RULES = [
    { id: 'select-split', n: '1', name: 'Cascade of σ (split)', formula: 'σ[θ1 ∧ θ2](E) = σ[θ1](σ[θ2](E))',
      apply: (n) => { if (n.op !== 'select') return []; const c = conj(n.cond); if (c.length < 2) return []; return [{ op: 'select', cond: c[0], child: { op: 'select', cond: and(c.slice(1)), child: n.child } }]; } },
    { id: 'select-merge', n: '1', name: 'Cascade of σ (merge)', formula: 'σ[θ1](σ[θ2](E)) = σ[θ1 ∧ θ2](E)',
      apply: (n) => (n.op === 'select' && n.child.op === 'select' ? [{ op: 'select', cond: and(conj(n.cond).concat(conj(n.child.cond))), child: n.child.child }] : []) },
    { id: 'select-commute', n: '2', name: 'Commutativity of σ', formula: 'σ[θ1](σ[θ2](E)) = σ[θ2](σ[θ1](E))',
      apply: (n) => (n.op === 'select' && n.child.op === 'select' ? [{ op: 'select', cond: n.child.cond, child: { op: 'select', cond: n.cond, child: n.child.child } }] : []) },
    { id: 'project-cascade', n: '3', name: 'Cascade of π', formula: 'π[L1](π[L2](...(π[Ln](E)))) = π[L1](E)',
      apply: (n) => {
        if (n.op !== 'project' || n.child.op !== 'project') return [];
        let e = n.child;
        while (e.op === 'project' && e.items.every((it) => it.e.k === 'attr' && !it.as)) e = e.child;
        if (e === n.child && !(n.child.items.every((it) => it.e.k === 'attr' && !it.as))) return [];
        return [{ op: 'project', items: n.items, child: e === n.child ? n.child.child : e }];
      } },
    { id: 'select-product', n: '4a', name: 'σ over × is a θ-join', formula: 'σ[θ](E1 × E2) = E1 ⋈[θ] E2',
      apply: (n) => (n.op === 'select' && n.child.op === 'product' ? [{ op: 'join', left: n.child.left, right: n.child.right, cond: n.cond }] : []) },
    { id: 'join-to-select', n: '4a', name: 'θ-join as σ over × (definition)', formula: 'E1 ⋈[θ] E2 = σ[θ](E1 × E2)',
      apply: (n) => (isTheta(n) ? [{ op: 'select', cond: n.cond, child: { op: 'product', left: n.left, right: n.right } }] : []) },
    { id: 'select-join', n: '4b', name: 'σ into a θ-join', formula: 'σ[θ1](E1 ⋈[θ2] E2) = E1 ⋈[θ1 ∧ θ2] E2',
      apply: (n) => (n.op === 'select' && isTheta(n.child) ? [{ op: 'join', left: n.child.left, right: n.child.right, cond: and(conj(n.cond).concat(conj(n.child.cond))) }] : []) },
    { id: 'join-commute', n: '5', name: 'Commutativity of ⋈ and ×', formula: 'E1 ⋈[θ] E2 = E2 ⋈[θ] E1',
      apply: (n) => (n.op === 'join' || n.op === 'product' ? [Object.assign({}, n, { left: n.right, right: n.left })] : []) },
    { id: 'join-assoc', n: '6a', name: 'Associativity of natural join and ×', formula: '(E1 ⋈ E2) ⋈ E3 = E1 ⋈ (E2 ⋈ E3)',
      apply: (n) => {
        const out = [];
        if ((isNatural(n) || n.op === 'product') && n.left.op === n.op && (n.op === 'product' || isNatural(n.left))) out.push({ op: n.op, cond: n.cond, left: n.left.left, right: { op: n.op, cond: n.cond, left: n.left.right, right: n.right } });
        return out.map((x) => { if (x.op === 'product') { delete x.cond; delete x.right.cond; } return x; });
      } },
    { id: 'join-assoc-rev', n: '6a', name: 'Associativity of natural join and × (to the left)', formula: 'E1 ⋈ (E2 ⋈ E3) = (E1 ⋈ E2) ⋈ E3',
      apply: (n) => {
        if (!((isNatural(n) || n.op === 'product') && n.right.op === n.op && (n.op === 'product' || isNatural(n.right)))) return [];
        const x = { op: n.op, cond: n.cond, left: { op: n.op, cond: n.cond, left: n.left, right: n.right.left }, right: n.right.right };
        if (x.op === 'product') { delete x.cond; delete x.left.cond; }
        return [x];
      } },
    { id: 'theta-assoc', n: '6b', name: 'Associativity of θ-joins', formula: '(E1 ⋈[θ1] E2) ⋈[θ2 ∧ θ3] E3 = E1 ⋈[θ1 ∧ θ3] (E2 ⋈[θ2] E3), θ2 on E2 and E3 only',
      apply: (n, ctx) => {
        if (!isTheta(n) || !(isTheta(n.left) || n.left.op === 'product')) return [];
        const s23 = ctx.schema({ op: 'product', left: n.left.right, right: n.right });
        const c = conj(n.cond);
        const t2 = c.filter((x) => resolves(x, s23)), t3 = c.filter((x) => !resolves(x, s23));
        const inner = t2.length ? { op: 'join', left: n.left.right, right: n.right, cond: and(t2) } : { op: 'product', left: n.left.right, right: n.right };
        const top = and(conj(n.left.cond).concat(t3));
        return [top ? { op: 'join', left: n.left.left, right: inner, cond: top } : { op: 'product', left: n.left.left, right: inner }];
      } },
    { id: 'select-push', n: '7a', name: 'σ distributes over ⋈ (one side)', formula: 'σ[θ0](E1 ⋈[θ] E2) = σ[θ0](E1) ⋈[θ] E2, θ0 on E1 only',
      apply: (n, ctx) => {
        if (n.op !== 'select' || !(n.child.op === 'join' || n.child.op === 'product')) return [];
        const j = n.child, c = conj(n.cond);
        const sl = ctx.schema(j.left), sr = ctx.schema(j.right);
        const out = [];
        for (const [side, s] of [['left', sl], ['right', sr]]) {
          const mine = c.filter((x) => resolves(x, s)), rest = c.filter((x) => !resolves(x, s));
          if (!mine.length) continue;
          const nj = Object.assign({}, j, { [side]: { op: 'select', cond: and(mine), child: j[side] } });
          out.push(rest.length ? { op: 'select', cond: and(rest), child: nj } : nj);
        }
        return out;
      } },
    { id: 'select-push-both', n: '7b', name: 'σ distributes over ⋈ (both sides)', formula: 'σ[θ1 ∧ θ2](E1 ⋈[θ] E2) = σ[θ1](E1) ⋈[θ] σ[θ2](E2)',
      apply: (n, ctx) => {
        if (n.op !== 'select' || !(n.child.op === 'join' || n.child.op === 'product')) return [];
        const j = n.child, c = conj(n.cond);
        const sl = ctx.schema(j.left), sr = ctx.schema(j.right);
        const l = c.filter((x) => resolves(x, sl)), r = c.filter((x) => !resolves(x, sl) && resolves(x, sr)), rest = c.filter((x) => !resolves(x, sl) && !resolves(x, sr));
        if (!l.length || !r.length) return [];
        const nj = Object.assign({}, j, { left: { op: 'select', cond: and(l), child: j.left }, right: { op: 'select', cond: and(r), child: j.right } });
        return [rest.length ? { op: 'select', cond: and(rest), child: nj } : nj];
      } },
    { id: 'project-push', n: '8', name: 'π distributes over ⋈', formula: 'π[L1 ∪ L2](E1 ⋈[θ] E2) = π[L1 ∪ L2](π[L1 ∪ L3](E1) ⋈[θ] π[L2 ∪ L4](E2))',
      apply: (n, ctx) => {
        if (n.op !== 'project' || !(n.child.op === 'join' || n.child.op === 'product') || !n.items.every((it) => it.e.k === 'attr')) return [];
        const j = n.child;
        const sl = ctx.schema(j.left), sr = ctx.schema(j.right), sj = ctx.schema(j);
        // the attributes each side must keep: those of L, of θ, and (for a natural join) the common ones
        const need = n.items.map((it) => it.e).concat(refs(j.cond));
        const keepL = new Set(), keepR = new Set();
        const common = isNatural(j) ? sl.filter((a) => sr.some((b) => b.name === a.name)).map((a) => a.name) : [];
        for (const r of need) {
          const a = sj[A.resolve(sj, r)];
          const li = sl.findIndex((x) => x.name === a.name && x.quals.some((q) => a.quals.includes(q)));
          const ri = sr.findIndex((x) => x.name === a.name && x.quals.some((q) => a.quals.includes(q)));
          if (li >= 0 && (ri < 0 || common.includes(a.name) || resolves(r, sl))) keepL.add(li);
          if (ri >= 0 && (li < 0 || common.includes(a.name) || !resolves(r, sl))) keepR.add(ri);
        }
        for (const nm of common) { keepL.add(sl.findIndex((x) => x.name === nm)); keepR.add(sr.findIndex((x) => x.name === nm)); }
        if (keepL.size === sl.length && keepR.size === sr.length) return [];
        const proj = (s, keep, e) => (keep.size === s.length ? e : { op: 'project', items: [...keep].sort((a, b) => a - b).map((i) => ({ e: refFor(s, i), as: null })), child: e });
        const nj = Object.assign({}, j, { left: proj(sl, keepL, j.left), right: proj(sr, keepR, j.right) });
        return [{ op: 'project', items: n.items, child: nj }];
      } },
    { id: 'setop-commute', n: '9', name: 'Commutativity of ∪ and ∩', formula: 'E1 ∪ E2 = E2 ∪ E1,  E1 ∩ E2 = E2 ∩ E1',
      apply: (n) => (n.op === 'union' || n.op === 'intersect' ? [Object.assign({}, n, { left: n.right, right: n.left })] : []) },
    { id: 'setop-assoc', n: '10', name: 'Associativity of ∪ and ∩', formula: '(E1 ∪ E2) ∪ E3 = E1 ∪ (E2 ∪ E3)',
      apply: (n) => ((n.op === 'union' || n.op === 'intersect') && n.left.op === n.op ? [{ op: n.op, left: n.left.left, right: { op: n.op, left: n.left.right, right: n.right } }] : []) },
    { id: 'setop-assoc-rev', n: '10', name: 'Associativity of ∪ and ∩ (to the left)', formula: 'E1 ∪ (E2 ∪ E3) = (E1 ∪ E2) ∪ E3',
      apply: (n) => ((n.op === 'union' || n.op === 'intersect') && n.right.op === n.op ? [{ op: n.op, left: { op: n.op, left: n.left, right: n.right.left }, right: n.right.right }] : []) },
    { id: 'select-setop', n: '11a', name: 'σ distributes over ∪, ∩ and −', formula: 'σ[P](E1 ∪ E2) = σ[P](E1) ∪ σ[P](E2)  (also ∩, −)',
      apply: (n) => (n.op === 'select' && SET.has(n.child.op) ? [{ op: n.child.op, left: { op: 'select', cond: n.cond, child: n.child.left }, right: { op: 'select', cond: clone(n.cond), child: n.child.right } }] : []) },
    { id: 'select-setop-left', n: '11b', name: 'σ over ∩ and − (left operand only)', formula: 'σ[P](E1 − E2) = σ[P](E1) − E2  (also ∩)',
      apply: (n) => (n.op === 'select' && (n.child.op === 'minus' || n.child.op === 'intersect') ? [{ op: n.child.op, left: { op: 'select', cond: n.cond, child: n.child.left }, right: n.child.right }] : []) },
    { id: 'project-union', n: '12', name: 'π distributes over ∪', formula: 'π[L](E1 ∪ E2) = π[L](E1) ∪ π[L](E2)',
      apply: (n) => (n.op === 'project' && n.child.op === 'union' ? [{ op: 'union', left: { op: 'project', items: n.items, child: n.child.left }, right: { op: 'project', items: clone(n.items), child: n.child.right } }] : []) },
    { id: 'select-group', n: '13', name: 'σ over γ (on grouping attributes)', formula: 'σ[θ](G γ A (E)) = G γ A (σ[θ](E)), θ on G only',
      apply: (n, ctx) => {
        if (n.op !== 'select' || n.child.op !== 'group') return [];
        const g = n.child, gs = ctx.schema(g).slice(0, g.groups.length);
        const c = conj(n.cond);
        const mine = c.filter((x) => resolves(x, gs)), rest = c.filter((x) => !resolves(x, gs));
        if (!mine.length) return [];
        const ng = Object.assign({}, g, { child: { op: 'select', cond: and(mine), child: g.child } });
        return [rest.length ? { op: 'select', cond: and(rest), child: ng } : ng];
      } },
    { id: 'outer-commute', n: '14', name: 'Commutativity of outer joins', formula: 'E1 ⟗ E2 = E2 ⟗ E1,  E1 ⟕ E2 = E2 ⟖ E1',
      apply: (n) => (n.op === 'fjoin' || n.op === 'ljoin' || n.op === 'rjoin' ? [Object.assign({}, n, { op: n.op === 'ljoin' ? 'rjoin' : n.op === 'rjoin' ? 'ljoin' : 'fjoin', left: n.right, right: n.left })] : []) },
    { id: 'select-outer', n: '15', name: 'σ over an outer join (preserved side)', formula: 'σ[θ1](E1 ⟕[θ] E2) = σ[θ1](E1) ⟕[θ] E2, θ1 on E1 only',
      apply: (n, ctx) => {
        if (n.op !== 'select' || !(n.child.op === 'ljoin' || n.child.op === 'rjoin')) return [];
        const j = n.child, side = j.op === 'ljoin' ? 'left' : 'right';
        const s = ctx.schema(j[side]), c = conj(n.cond);
        // on a natural outer join a common attribute is the preserved side's value, so it may be pushed too
        const mine = c.filter((x) => resolves(x, s)), rest = c.filter((x) => !resolves(x, s));
        if (!mine.length) return [];
        const nj = Object.assign({}, j, { [side]: { op: 'select', cond: and(mine), child: j[side] } });
        return [rest.length ? { op: 'select', cond: and(rest), child: nj } : nj];
      } },
    { id: 'outer-to-inner', n: '16', name: 'Outer join to join under a null-rejecting σ', formula: 'σ[θ1](E1 ⟕[θ] E2) = σ[θ1](E1 ⋈[θ] E2), θ1 rejects nulls of E2',
      apply: (n, ctx) => {
        if (n.op !== 'select' || !['ljoin', 'rjoin', 'fjoin'].includes(n.child.op)) return [];
        const j = n.child;
        const sl = ctx.schema(j.left), sr = ctx.schema(j.right);
        const rejects = (s, other) => conj(n.cond).some((x) => nullRejecting(x) && refs(x).some((r) => resolves(r, s) && !resolves(r, other)));
        let op = j.op;
        if (op === 'ljoin' && rejects(sr, sl)) op = 'join';
        else if (op === 'rjoin' && rejects(sl, sr)) op = 'join';
        else if (op === 'fjoin') { const a = rejects(sl, sr), b = rejects(sr, sl); op = a && b ? 'join' : a ? 'ljoin' : b ? 'rjoin' : op; }
        if (op === j.op) return [];
        return [{ op: 'select', cond: n.cond, child: Object.assign({}, j, { op }) }];
      } },
  ];
  // a conjunct that is false or unknown whenever an attribute it names is null
  function nullRejecting(x) {
    if (x.k !== 'cmp' && x.k !== 'like') return false;
    let ok = true;
    const w = (y) => { if (!y || typeof y !== 'object') return; if (y.k === 'fn' && y.name === 'coalesce' || y.k === 'isnull' || y.k === 'or' || y.k === 'not') ok = false; for (const k in y) w(y[k]); };
    w(x);
    return ok;
  }
  function refFor(attrs, i) {
    const a = attrs[i];
    if (attrs.filter((b) => b.name === a.name).length === 1) return { k: 'attr', parts: [a.name] };
    const q = a.quals.find((x) => attrs.filter((b) => b.name === a.name && b.quals.includes(x)).length === 1);
    return { k: 'attr', parts: q ? [q, a.name] : [a.name] };
  }

  const toAst = (e) => (typeof e === 'string' ? A.parseExpr(e) : e);
  const getAt = (e, path) => path.reduce((x, k) => x[k], e);
  function setAt(e, path, sub) {
    if (!path.length) return sub;
    const out = clone(e);
    let x = out;
    for (let i = 0; i < path.length - 1; i++) x = x[path[i]];
    x[path[path.length - 1]] = sub;
    return out;
  }
  const sameNames = (a, b) => a.length === b.length && a.map((x) => x.name).sort().join('\u0001') === b.map((x) => x.name).sort().join('\u0001');

  /** the rules that apply at path: [{ id, n, name, formula, result (subtree), text, expr (whole expression) }] */
  function rulesAt(expr, path, src, opts) {
    opts = opts || {};
    expr = toAst(expr);
    const get = A.source(src);
    const env = opts.env || new Map();
    const node = getAt(expr, path);
    const ctx = { schema: (x) => A.schemaOf(x, get, env), src: get };
    let before;
    try { before = ctx.schema(node); } catch (e) { return []; }
    // does the attribute order reach a positional operator above (∪ ∩ −, or ρ with an attribute list)? A
    // projection or aggregation in between fixes the order by name
    let positional = false;
    for (let i = path.length - 1; i >= 0; i--) {
      const up = getAt(expr, path.slice(0, i));
      if (up.op === 'project' || up.op === 'group') break;
      if (SET.has(up.op) || (up.op === 'rename' && up.attrs)) { positional = true; break; }
    }
    const out = [];
    for (const r of RULES) {
      if (opts.only && !opts.only.includes(r.id)) continue;
      let cands;
      try { cands = r.apply(clone(node), ctx); } catch (e) { continue; }
      for (let res of cands) {
        let after;
        try { after = ctx.schema(res); } catch (e) { continue; }
        if (!sameNames(before, after)) continue;
        let reordered = after.some((a, i) => a.name !== before[i].name);
        if (reordered && positional) {
          const at = (b) => { const k = after.findIndex((a) => a.name === b.name && a.quals.some((x) => b.quals.includes(x))); return k >= 0 ? k : after.findIndex((a) => a.name === b.name); };
          res = { op: 'project', items: before.map((b) => ({ e: refFor(after, at(b)), as: null })), child: res };
          try { after = ctx.schema(res); } catch (e) { continue; }
          reordered = false;
        }
        const whole = setAt(expr, path, res);
        out.push({ id: r.id, n: r.n, name: r.name, formula: r.formula, result: res, text: A.toText(res), expr: whole, exprText: A.toText(whole), reordered });
      }
    }
    return out;
  }
  /** every node with the rules that apply there: [{ path, text, rules }] */
  function applicable(expr, src, opts) {
    expr = toAst(expr);
    const out = [];
    A.walk(expr, (n, path) => { const rules = rulesAt(expr, path, src, opts); if (rules.length) out.push({ path, op: n.op, text: A.toText(n), rules }); });
    return out;
  }
  /** apply rule id at path (the which-th alternative when a rule offers several); returns the new expression */
  function applyRule(expr, path, id, src, which, opts) {
    const rs = rulesAt(expr, path, src, opts).filter((r) => r.id === id);
    if (!rs.length) throw K.err('42601', 'rule ' + id + ' does not apply at this node');
    return rs[Math.min(which || 0, rs.length - 1)].expr;
  }

  /**
   * Tidy an expression without changing its result: compose cascaded projections, push selections below
   * projections, merge cascaded selections and drop identity projections. Used on generated expressions.
   */
  function simplify(expr, src, env) {
    const get = A.source(src);
    env = env || new Map();
    const schema = (x) => A.schemaOf(x, get, env);
    const subst = (e, items, attrs) => {
      const w = (x) => {
        if (!x || typeof x !== 'object') return x;
        if (x.k === 'attr') { const i = A.resolve(attrs, x); return clone(items[i].e); }
        const o = Array.isArray(x) ? [] : {};
        for (const k in x) o[k] = w(x[k]);
        return o;
      };
      return w(e);
    };
    const rec = (n) => {
      if (n.child) n.child = rec(n.child);
      if (n.left) n.left = rec(n.left);
      if (n.right) n.right = rec(n.right);
      try {
        if (n.op === 'project' && n.child.op === 'project') {
          const inner = n.child, ia = schema(inner);
          const items = n.items.map((it) => {
            const e = subst(it.e, inner.items, ia);
            const name = it.as || (it.e.k === 'attr' ? ia[A.resolve(ia, it.e)].name : null);
            const keeps = e.k === 'attr' && e.parts[e.parts.length - 1] === name;
            return { e, as: keeps ? null : name || it.as };
          });
          const cand = { op: 'project', items, child: inner.child };
          const a = schema(n), b = schema(cand);
          if (a.length === b.length && a.every((x, i) => x.name === b[i].name)) return rec(cand);
        }
        if (n.op === 'select' && n.child.op === 'project') {
          const p = n.child, pa = schema(p);
          const cand = Object.assign({}, p, { child: { op: 'select', cond: subst(n.cond, p.items, pa), child: p.child } });
          schema(cand);
          return rec(cand);
        }
        if (n.op === 'select' && n.child.op === 'select') return { op: 'select', cond: and(conj(n.cond).concat(conj(n.child.cond))), child: n.child.child };
        if (n.op === 'project' && n.items.every((it) => it.e.k === 'attr')) {
          const ca = schema(n.child);
          const a = schema(n);
          if (a.length === ca.length && n.items.every((it, i) => A.resolve(ca, it.e) === i && a[i].name === ca[i].name)) return n.child;
        }
      } catch (e) { /* leave this node as it is */ }
      return n;
    };
    return rec(clone(expr));
  }

  Object.assign(A, { simplify, RULES, rulesAt, applicable, applyRule, getAt, setAt });
})(typeof window !== 'undefined' ? window : globalThis);
