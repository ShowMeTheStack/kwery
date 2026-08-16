// Design theory: functional and multivalued dependencies, closures, keys, canonical covers, normal forms,
// decomposition algorithms and their tests, FD discovery from data, and anomaly scripts. Every function takes a
// schema and a dependency set (text or structured), works on bitmasks over the schema's attributes, and returns
// names in schema order together with the steps it took and a plain-text explanation.
(function (root) {
  'use strict';
  const K = root.K;
  const SYN = K.STATE ? K.STATE.syntax : '42601';
  const fail = (msg, pos) => { throw K.err(SYN, msg, pos === undefined ? {} : { pos }); };
  const MAXA = 30;

  // ---- bit sets ------------------------------------------------------------------------------------------------
  const pop = (m) => { let n = 0; while (m) { m &= m - 1; n++; } return n; };
  const sub = (a, b) => (a & b) === a;
  const bitsOf = (m) => { const b = []; for (let i = 0; i < MAXA; i++) if (m & (1 << i)) b.push(1 << i); return b; };
  function combos(bits, k) {
    const out = [];
    const rec = (s, k2, acc) => { if (!k2) { out.push(acc); return; } for (let i = s; i <= bits.length - k2; i++) rec(i + 1, k2 - 1, acc | bits[i]); };
    rec(0, k, 0);
    return out;
  }
  function subsets(m, max) {
    const b = bitsOf(m);
    if (b.length > 20) fail('too many attributes (' + b.length + ') for a test over all subsets');
    const out = [];
    for (let k = 0; k <= Math.min(b.length, max === undefined ? b.length : max); k++) for (const c of combos(b, k)) out.push(c);
    return out;
  }
  function clo(fds, x) {
    let c = x, ch = true;
    while (ch) { ch = false; for (const f of fds) if ((f.l & c) === f.l && (f.r & c) !== f.r) { c |= f.r; ch = true; } }
    return c;
  }

  // ---- parsing --------------------------------------------------------------------------------------------------
  function lex(text, base) {
    base = base || 0;
    const out = [];
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === '\n') { out.push({ t: 'sep', v: '\n', pos: base + i }); i++; continue; }
      if (/\s/.test(c) || c === '{' || c === '}') { i++; continue; }
      if (text.startsWith('->>', i)) { out.push({ t: 'arrow', mvd: true, pos: base + i }); i += 3; continue; }
      if (c === '↠') { out.push({ t: 'arrow', mvd: true, pos: base + i }); i++; continue; }
      if (text.startsWith('->', i) || text.startsWith('=>', i)) { out.push({ t: 'arrow', pos: base + i }); i += 2; continue; }
      if (c === '→') { out.push({ t: 'arrow', pos: base + i }); i++; continue; }
      if (c === ',' || c === ';') { out.push({ t: 'sep', v: c, pos: base + i }); i++; continue; }
      const m = /^[A-Za-z_][A-Za-z0-9_$#]*/.exec(text.slice(i));
      if (!m) fail('unexpected character "' + c + '" at position ' + (base + i + 1), base + i);
      out.push({ t: 'id', v: m[0], pos: base + i });
      i += m[0].length;
    }
    return out;
  }
  const strong = (t) => t.t === 'sep' && t.v !== ',';

  /** 'R(A, B, C)', 'r = (a, b)', 'A B C', 'ABC', ['A', 'B'] or { name, attrs } -> { name, attrs } */
  function parseSchema(s) {
    if (s && s.isProblem) return { name: s.name, attrs: s.attrs.slice() };
    if (s && Array.isArray(s.attrs)) return { name: s.name || null, attrs: uniq(s.attrs.map(String)) };
    if (Array.isArray(s)) return { name: null, attrs: uniq(s.map(String)) };
    const text = String(s);
    const m = /^\s*([A-Za-z_][\w$]*)\s*=?\s*\(/.exec(text);
    let name = null, inner = text, base = 0;
    if (m || /^\s*\(/.test(text)) {
      const open = text.indexOf('('), close = text.lastIndexOf(')');
      if (close < open) fail('missing ")" in schema', text.length);
      if (text.slice(close + 1).trim()) fail('unexpected text after ")" at position ' + (close + 2), close + 1);
      name = m ? m[1] : null; inner = text.slice(open + 1, close); base = open + 1;
    }
    const toks = lex(inner, base);
    const bad = toks.find((t) => t.t === 'arrow');
    if (bad) fail('a schema lists attributes; "->" at position ' + (bad.pos + 1) + ' belongs in the dependencies', bad.pos);
    let ids = toks.filter((t) => t.t === 'id');
    if (ids.length === 1 && /^[A-Z]{2,}$/.test(ids[0].v)) ids = ids[0].v.split('').map((v, k) => ({ v, pos: ids[0].pos + k }));
    if (!ids.length) fail('the schema has no attributes', base);
    const seen = new Set();
    for (const t of ids) { if (seen.has(t.v)) fail('attribute "' + t.v + '" appears twice in the schema (position ' + (t.pos + 1) + ')', t.pos); seen.add(t.v); }
    return { name, attrs: ids.map((t) => t.v) };
  }
  function uniq(a) { const seen = new Set(); for (const x of a) { if (seen.has(x)) fail('attribute "' + x + '" appears twice in the schema'); seen.add(x); } return a; }

  /**
   * Dependencies as text: 'A B -> C, C -> D', 'AB -> C; C ->> D', one per line ... Sides list attributes separated
   * by spaces or commas; dependencies are separated by ';', a new line, or a comma (the last comma before the next
   * left side). With a schema whose attributes are all single letters, 'AB' means A and B.
   * Returns [{ lhs, rhs, mvd, pos, text }].
   */
  function parseDeps(text, schema, opts) {
    opts = opts || {};
    text = String(text);
    const toks = lex(text);
    const attrs = schema ? schema.attrs : null;
    const ids = toks.filter((t) => t.t === 'id');
    const letters = opts.letters !== undefined ? opts.letters : attrs ? attrs.every((a) => a.length === 1) : ids.every((t) => /^[A-Z]+$/.test(t.v));
    const arrows = [];
    toks.forEach((t, i) => { if (t.t === 'arrow') arrows.push(i); });
    if (!arrows.length) { if (!ids.length) return []; fail('expected "->" in a dependency after "' + ids[0].v + '" (position ' + (ids[0].pos + 1) + ')', ids[0].pos); }
    const resolve = (t) => {
      if (attrs) {
        if (attrs.includes(t.v)) return [t.v];
        if (letters && t.v.split('').every((c) => attrs.includes(c))) return t.v.split('');
        const near = attrs.find((a) => a.toLowerCase() === t.v.toLowerCase());
        fail('unknown attribute "' + t.v + '" at position ' + (t.pos + 1) + (near ? ' (did you mean "' + near + '"?)' : ''), t.pos);
      }
      return letters ? t.v.split('') : [t.v];
    };
    const side = (ts, what, at) => {
      const out = [];
      let sawStrong = false;
      for (const t of ts) {
        if (strong(t)) { if (out.length) sawStrong = true; continue; }
        if (t.t !== 'id') continue;
        if (sawStrong) fail('expected "->" after "' + out.join(' ') + '" before "' + t.v + '" (position ' + (t.pos + 1) + ')', t.pos);
        for (const a of resolve(t)) if (!out.includes(a)) out.push(a);
      }
      if (!out.length) fail('the ' + what + ' side of the dependency at position ' + (at.pos + 1) + ' is empty', at.pos);
      return out;
    };
    const deps = [];
    let start = 0;
    for (let k = 0; k < arrows.length; k++) {
      const a = arrows[k];
      let end = toks.length;
      if (k + 1 < arrows.length) {
        const nx = arrows[k + 1];
        let s = -1, c = -1;
        for (let i = a + 1; i < nx; i++) { if (strong(toks[i])) s = i; else if (toks[i].t === 'sep') c = i; }
        if (s >= 0) end = s;
        else if (c >= 0) end = c;
        else { const t = toks.slice(a + 1, nx).find((x) => x.t === 'id') || toks[nx]; fail('missing separator between dependencies near position ' + (t.pos + 1) + ' (use ";", "," or a new line)', t.pos); }
      }
      const lhs = side(toks.slice(start, a), 'left', toks[a]);
      const rhs = side(toks.slice(a + 1, end), 'right', toks[a]);
      const first = toks.slice(start, end).find((t) => t.t !== 'sep');
      const last = toks[end - 1];
      deps.push({ lhs, rhs, mvd: !!toks[a].mvd, pos: first.pos, text: text.slice(first.pos, last.pos + (last.v ? last.v.length : 1)).trim() });
      start = end + 1;
    }
    return deps;
  }

  /** a problem: the schema with its dependencies, the internal form every function works on */
  function problem(schema, deps, opts) {
    if (schema && schema.isProblem && deps === undefined) return schema;
    let sch = schema ? parseSchema(schema) : null;
    const list = [];
    const addStruct = (d) => {
      const side = (x) => (Array.isArray(x) ? x.map(String) : sch ? namesOfText(sch.attrs, x) : String(x).split(/[\s,]+/).filter(Boolean));
      list.push({ lhs: side(d.lhs), rhs: side(d.rhs), mvd: !!d.mvd, text: d.text });
    };
    const addAny = (d) => {
      if (d === null || d === undefined) return;
      if (d.isProblem) { for (const f of d.fds) list.push({ lhs: names(d, f.l), rhs: names(d, f.r) }); for (const f of d.mvds) list.push({ lhs: names(d, f.l), rhs: names(d, f.r), mvd: true }); return; }
      if (typeof d === 'string') { for (const x of parseDeps(d, sch, opts)) list.push(x); return; }
      if (Array.isArray(d)) { d.forEach(addAny); return; }
      addStruct(d);
    };
    addAny(deps);
    if (!sch) {
      const attrs = [];
      for (const d of list) for (const a of d.lhs.concat(d.rhs)) if (!attrs.includes(a)) attrs.push(a);
      sch = { name: null, attrs };
    }
    const attrs = sch.attrs;
    if (attrs.length > MAXA) fail('a schema may have at most ' + MAXA + ' attributes here');
    const idx = new Map(attrs.map((a, i) => [a, i]));
    const P = { isProblem: true, name: sch.name, attrs, idx, all: attrs.length === 0 ? 0 : (2 ** attrs.length) - 1, letters: attrs.every((a) => a.length === 1), fds: [], mvds: [] };
    for (const d of list) {
      const m = (xs) => xs.reduce((acc, a) => { if (!idx.has(a)) fail('unknown attribute "' + a + '" in ' + (d.text || d.lhs.join(' ') + ' -> ' + d.rhs.join(' '))); return acc | (1 << idx.get(a)); }, 0);
      (d.mvd ? P.mvds : P.fds).push({ l: m(d.lhs), r: m(d.rhs) });
    }
    return P;
  }
  function namesOfText(attrs, x) {
    const letters = attrs.every((a) => a.length === 1);
    const out = [];
    for (const tok of String(x).split(/[\s,(){}]+/).filter(Boolean)) {
      if (attrs.includes(tok)) out.push(tok);
      else if (letters && tok.split('').every((c) => attrs.includes(c))) out.push(...tok.split(''));
      else if (tok !== '∅') fail('unknown attribute "' + tok + '"');
    }
    return out.filter((a, i) => out.indexOf(a) === i);
  }
  const names = (P, m) => P.attrs.filter((a, i) => m & (1 << i));
  function mask(P, x) {
    if (typeof x === 'number') return x;
    const list = Array.isArray(x) ? x.flatMap((a) => (P.idx.has(String(a)) ? [String(a)] : namesOfText(P.attrs, a))) : namesOfText(P.attrs, x);
    return list.reduce((acc, a) => acc | (1 << P.idx.get(a)), 0);
  }
  const setText = (P, m) => (m === 0 ? '∅' : P.letters ? names(P, m).join('') : names(P, m).join(', '));
  const fdText = (P, l, r, mvd) => setText(P, l) + (mvd ? ' ↠ ' : ' → ') + setText(P, r);
  const fdOut = (P, f) => ({ lhs: names(P, f.l), rhs: names(P, f.r), text: fdText(P, f.l, f.r) });
  const schemaText = (P, m) => '(' + names(P, m).join(', ') + ')';
  const fText = (P, fds) => '{ ' + fds.map((f) => fdText(P, f.l, f.r, f.mvd)).join(', ') + ' }';

  // ---- closures, F+, derivations ---------------------------------------------------------------------------------
  function closure(schema, deps, X) {
    const P = problem(schema, deps);
    const x = mask(P, X);
    let cur = x;
    const steps = [];
    let ch = true;
    while (ch) {
      ch = false;
      for (const f of P.fds) {
        if (sub(f.l, cur) && !sub(f.r, cur)) {
          const added = f.r & ~cur;
          cur |= f.r;
          steps.push({ fd: fdOut(P, f), added: names(P, added), result: names(P, cur) });
          ch = true;
        }
      }
    }
    const lines = ['result := ' + setText(P, x)];
    for (const s of steps) lines.push('using ' + s.fd.text + ': ' + setText(P, mask(P, s.fd.lhs)) + ' ⊆ result, add ' + s.added.join(', ') + ' → result = ' + setText(P, mask(P, s.result)));
    lines.push('no dependency adds anything more, so (' + setText(P, x) + ')+ = ' + setText(P, cur));
    return { attrs: names(P, cur), superkey: sub(P.all, cur), steps, text: lines.join('\n') };
  }

  /** F+ for a small schema; mode: 'nontrivial' (default), 'all', or 'closures' (X -> X+ for each X) */
  function fplus(schema, deps, opts) {
    opts = opts || {};
    const P = problem(schema, deps);
    const max = opts.max || 8;
    if (P.attrs.length > max) fail('F+ is listed only for schemas of at most ' + max + ' attributes (this one has ' + P.attrs.length + ')');
    const mode = opts.mode || 'nontrivial';
    const out = [];
    for (const x of subsets(P.all)) {
      const c = clo(P.fds, x);
      if (mode === 'closures') { out.push({ lhs: names(P, x), rhs: names(P, c), text: fdText(P, x, c) }); continue; }
      for (const y of subsets(c)) {
        if (!y || (mode !== 'all' && sub(y, x))) continue;
        out.push({ lhs: names(P, x), rhs: names(P, y), text: fdText(P, x, y) });
      }
    }
    return { fds: out, count: out.length, text: 'F+ (' + mode + ') has ' + out.length + ' dependencies' + (out.length <= 60 ? ':\n' + out.map((f) => f.text).join('\n') : '') };
  }

  /**
   * A proof of X -> Y from F with Armstrong's axioms: reflexivity, augmentation, transitivity, and the derived
   * union and decomposition rules (opts.basic uses only the three axioms). Each line cites the lines it uses.
   */
  function derive(schema, deps, X, Y, opts) {
    opts = opts || {};
    const P = problem(schema, deps);
    const x = mask(P, X), y = mask(P, Y);
    const trace = [];
    let cur = x, ch = true;
    while (ch) { ch = false; for (const f of P.fds) if (sub(f.l, cur) && !sub(f.r, cur)) { trace.push({ f, added: f.r & ~cur }); cur |= f.r; ch = true; } }
    const goal = fdText(P, x, y);
    if (!sub(y, cur)) {
      return { follows: false, closure: names(P, cur), missing: names(P, y & ~cur), steps: [], text: goal + ' does not follow from F: (' + setText(P, x) + ')+ = ' + setText(P, cur) + ', which lacks ' + setText(P, y & ~cur) + '. Every dependency derivable from F with Armstrong\'s axioms has its right side inside the closure of its left side.' };
    }
    // keep only the closure steps that contribute to Y
    let need = y & ~x;
    const keep = [];
    for (let i = trace.length - 1; i >= 0; i--) { const t = trace[i]; if (t.added & need) { keep.unshift(t); need = (need & ~t.added) | (t.f.l & ~x); } }
    const L = [];
    const add = (l, r, rule, from, note) => { L.push({ n: L.length + 1, l, r, rule, from: from || [], note: note || '' }); return L.length; };
    if (!keep.length) add(x, y, 'reflexivity', [], setText(P, y) + ' ⊆ ' + setText(P, x));
    else {
      let s = x, sStep = null;
      for (const t of keep) {
        const g = add(t.f.l, t.f.r, 'given', [], 'in F');
        let xb = g;
        if (t.f.l !== x) {
          let xa;
          if (sub(t.f.l, x)) xa = add(x, t.f.l, 'reflexivity', [], setText(P, t.f.l) + ' ⊆ ' + setText(P, x));
          else { const ref = add(s, t.f.l, 'reflexivity', [], setText(P, t.f.l) + ' ⊆ ' + setText(P, s)); xa = add(x, t.f.l, 'transitivity', [sStep, ref]); }
          xb = add(x, t.f.r, 'transitivity', [xa, g]);
        }
        if (t === keep[keep.length - 1] && sub(y, t.f.r)) { sStep = xb; s = t.f.r; break; }
        if (sStep === null) sStep = add(x, x | t.f.r, 'augmentation', [xb], 'augment with ' + setText(P, x));
        else if (opts.basic) { const au = add(s, s | t.f.r, 'augmentation', [xb], 'augment with ' + setText(P, s)); sStep = add(x, s | t.f.r, 'transitivity', [sStep, au]); }
        else sStep = add(x, s | t.f.r, 'union', [sStep, xb]);
        s |= t.f.r;
      }
      if (s !== y) {
        if (opts.basic) { const ref = add(s, y, 'reflexivity', [], setText(P, y) + ' ⊆ ' + setText(P, s)); add(x, y, 'transitivity', [sStep, ref]); }
        else add(x, y, 'decomposition', [sStep]);
      }
    }
    const steps = L.map((s) => ({ n: s.n, lhs: names(P, s.l), rhs: names(P, s.r), fd: fdText(P, s.l, s.r), rule: s.rule, from: s.from, note: s.note }));
    const text = 'Proof of ' + goal + ':\n' + steps.map((s) => s.n + '. ' + s.fd + '   ' + s.rule + (s.from.length ? ' on ' + s.from.join(', ') : '') + (s.note ? ' (' + s.note + ')' : '')).join('\n');
    return { follows: true, closure: names(P, cur), steps, text };
  }

  // ---- keys ------------------------------------------------------------------------------------------------------
  function keysOf(P, R) {
    let core = 0, only = 0;
    const whole = R === P.all;
    if (whole) {
      let rhs = 0, lhs = 0;
      for (const f of P.fds) { rhs |= f.r & ~f.l; lhs |= f.l; }
      core = R & ~rhs; only = R & rhs & ~lhs;
    }
    const mid = R & ~core & ~only;
    const keys = [], steps = [];
    if (sub(R, clo(P.fds, core))) { keys.push(core); steps.push({ size: 0, tested: 1, found: [core] }); }
    else {
      const bits = bitsOf(mid);
      for (let k = 1; k <= bits.length; k++) {
        let tested = 0;
        const found = [];
        for (const c0 of combos(bits, k)) {
          const c = core | c0;
          if (keys.some((kk) => sub(kk, c))) continue;
          tested++;
          if (sub(R, clo(P.fds, c))) { keys.push(c); found.push(c); }
        }
        if (!tested) break;
        steps.push({ size: pop(core) + k, tested, found });
      }
    }
    return { keys, core, only, mid, steps, whole };
  }
  function keys(schema, deps, opts) {
    opts = opts || {};
    const P = problem(schema, deps);
    const R = opts.sub ? mask(P, opts.sub) : P.all;
    const r = keysOf(P, R);
    const lines = [];
    if (r.whole) {
      lines.push('Attributes on no right side (they must be in every key): ' + setText(P, r.core));
      lines.push('Attributes only on right sides (they are in no key): ' + setText(P, r.only));
      lines.push('Attributes to search: ' + setText(P, r.mid));
    } else lines.push('Searching the subsets of ' + schemaText(P, R) + ' by size, with closures under F.');
    for (const s of r.steps) lines.push('size ' + s.size + ': tested ' + s.tested + ' sets' + (s.found.length ? ', keys ' + s.found.map((k) => setText(P, k)).join('; ') : ', no key') + (s.size === 0 ? '' : ' (supersets of keys skipped)'));
    lines.push('Candidate keys: ' + r.keys.map((k) => '{' + setText(P, k) + '}').join(', '));
    return {
      keys: r.keys.map((k) => names(P, k)), mustHave: names(P, r.core), never: names(P, r.only),
      steps: r.steps.map((s) => ({ size: s.size, tested: s.tested, found: s.found.map((k) => names(P, k)) })), text: lines.join('\n'),
    };
  }
  function isSuperkey(schema, deps, X, opts) {
    const P = problem(schema, deps);
    const R = opts && opts.sub ? mask(P, opts.sub) : P.all;
    const x = mask(P, X), c = clo(P.fds, x);
    const ok = sub(R, c);
    return { ok, closure: names(P, c), missing: names(P, R & ~c), text: '(' + setText(P, x) + ')+ = ' + setText(P, c) + (ok ? ' contains every attribute of ' + schemaText(P, R) + ', so it is a superkey' : ', missing ' + setText(P, R & ~c) + ', so it is not a superkey') };
  }
  function primeAttrs(schema, deps, opts) {
    const P = problem(schema, deps);
    const R = opts && opts.sub ? mask(P, opts.sub) : P.all;
    const ks = keysOf(P, R).keys;
    const pr = ks.reduce((a, k) => a | k, 0);
    return { prime: names(P, pr), nonprime: names(P, R & ~pr), keys: ks.map((k) => names(P, k)), text: 'Prime attributes (in some candidate key): ' + setText(P, pr) + '; nonprime: ' + setText(P, R & ~pr) };
  }

  // ---- canonical cover -------------------------------------------------------------------------------------------
  function coverOf(P, fds) {
    let F = fds.map((f) => ({ l: f.l, r: f.r }));
    const steps = [];
    for (let guard = 0; guard < 1000; guard++) {
      const merged = [];
      for (const f of F) {
        const m = merged.find((g) => g.l === f.l);
        if (m) { steps.push({ action: 'union', fds: [fdText(P, m.l, m.r), fdText(P, f.l, f.r)], into: fdText(P, m.l, m.r | f.r), text: m.r === f.r ? fdText(P, f.l, f.r) + ' appears twice; keep one' : 'union rule: ' + fdText(P, m.l, m.r) + ' and ' + fdText(P, f.l, f.r) + ' become ' + fdText(P, m.l, m.r | f.r) }); m.r |= f.r; }
        else merged.push({ l: f.l, r: f.r });
      }
      F = merged;
      let changed = false;
      outer: for (let i = 0; i < F.length; i++) {
        const f = F[i];
        for (const a of bitsOf(f.l)) {
          const c = clo(F, f.l & ~a);
          if (sub(f.r, c)) {
            steps.push({ action: 'lhs', fd: fdText(P, f.l, f.r), attr: names(P, a)[0], closure: names(P, c), into: fdText(P, f.l & ~a, f.r), text: names(P, a)[0] + ' is extraneous in the left side of ' + fdText(P, f.l, f.r) + ': (' + setText(P, f.l & ~a) + ')+ = ' + setText(P, c) + ' under F already contains ' + setText(P, f.r) });
            F[i] = { l: f.l & ~a, r: f.r };
            changed = true;
            break outer;
          }
        }
        for (const a of bitsOf(f.r)) {
          const F2 = F.map((g, j) => (j === i ? { l: g.l, r: g.r & ~a } : g)).filter((g) => g.r);
          const c = clo(F2, f.l);
          if (c & a) {
            const rest = f.r & ~a;
            steps.push({ action: 'rhs', fd: fdText(P, f.l, f.r), attr: names(P, a)[0], closure: names(P, c), into: rest ? fdText(P, f.l, rest) : null, text: names(P, a)[0] + ' is extraneous in the right side of ' + fdText(P, f.l, f.r) + ': with ' + (rest ? fdText(P, f.l, rest) : 'the dependency removed') + ' instead, (' + setText(P, f.l) + ')+ = ' + setText(P, c) + ' still contains ' + names(P, a)[0] });
            F = F2;
            changed = true;
            break outer;
          }
        }
      }
      if (!changed) break;
    }
    return { F, steps };
  }
  function canonicalCover(schema, deps) {
    const P = problem(schema, deps);
    const { F, steps } = coverOf(P, P.fds);
    const text = 'F = ' + fText(P, P.fds) + '\n' + (steps.length ? steps.map((s, i) => (i + 1) + '. ' + s.text).join('\n') : 'no dependency can be combined and no attribute is extraneous') + '\nCanonical cover Fc = ' + fText(P, F);
    return { fds: F.map((f) => fdOut(P, f)), steps, text };
  }

  // ---- normal forms ----------------------------------------------------------------------------------------------
  function bcnfV(P, R, exhaustive) {
    const out = [];
    if (!exhaustive) {
      for (const f of P.fds) {
        if (!sub(f.l, R)) continue;
        const r = f.r & R & ~f.l;
        if (!r || sub(R, clo(P.fds, f.l))) continue;
        out.push({ l: f.l, r, given: true });
      }
      if (out.length || R === P.all) return out;
    }
    for (const a of subsets(R)) {
      if (out.some((v) => sub(v.l, a))) continue;
      const c = clo(P.fds, a) & R;
      if ((c & ~a) && c !== R) out.push({ l: a, r: c & ~a });
    }
    return out;
  }
  function threeV(P, R, exhaustive, ks) {
    const prime = ks.reduce((a, k) => a | k, 0);
    const out = [];
    if (R === P.all && !exhaustive) {
      for (const f of P.fds) {
        const r = f.r & ~f.l;
        if (!r || sub(P.all, clo(P.fds, f.l))) continue;
        const bad = r & ~prime;
        if (bad) out.push({ l: f.l, r: bad, given: true });
      }
      return out;
    }
    for (const a of subsets(R)) {
      const c = clo(P.fds, a) & R;
      if (c === R) continue;
      const bad = c & ~a & ~prime;
      if (bad && !out.some((v) => sub(v.l, a) && sub(bad, v.r))) out.push({ l: a, r: bad });
    }
    return out;
  }
  function twoV(P, R, ks) {
    const prime = ks.reduce((a, k) => a | k, 0);
    const out = [];
    for (const k of ks) for (const a of subsets(k)) {
      if (a === k) continue;
      const bad = clo(P.fds, a) & R & ~a & ~prime;
      if (bad && !out.some((v) => v.l === a)) out.push({ l: a, r: bad, key: k });
    }
    return out;
  }
  const vOut = (P, v, why) => ({ lhs: names(P, v.l), rhs: names(P, v.r), text: fdText(P, v.l, v.r, v.mvd), reason: why, given: !!v.given });
  function subMask(P, s) { return s === undefined || s === null ? P.all : mask(P, s); }

  function isBCNF(schema, deps, sub0, opts) {
    const P = problem(schema, deps);
    const R = subMask(P, sub0);
    const v = bcnfV(P, R, opts && opts.exhaustive).map((x) => vOut(P, x, setText(P, x.l) + ' is not a superkey of ' + schemaText(P, R)));
    return { ok: !v.length, violations: v, text: schemaText(P, R) + (v.length ? ' is not in BCNF: ' + v.map((x) => x.text + ' (' + x.reason + ')').join('; ') : ' is in BCNF: the left side of every nontrivial dependency on it is a superkey') };
  }
  function is3NF(schema, deps, sub0, opts) {
    const P = problem(schema, deps);
    const R = subMask(P, sub0);
    const ks = keysOf(P, R).keys;
    const v = threeV(P, R, opts && opts.exhaustive, ks).map((x) => vOut(P, x, setText(P, x.l) + ' is not a superkey and ' + setText(P, x.r) + ' is not prime'));
    return { ok: !v.length, violations: v, keys: ks.map((k) => names(P, k)), text: schemaText(P, R) + (v.length ? ' is not in 3NF: ' + v.map((x) => x.text + ' (' + x.reason + ')').join('; ') : ' is in 3NF') };
  }
  function is2NF(schema, deps, sub0) {
    const P = problem(schema, deps);
    const R = subMask(P, sub0);
    const ks = keysOf(P, R).keys;
    const v = twoV(P, R, ks).map((x) => vOut(P, x, setText(P, x.r) + ' depends on ' + setText(P, x.l) + ', a proper part of the key ' + setText(P, x.key)));
    return { ok: !v.length, violations: v, keys: ks.map((k) => names(P, k)), text: schemaText(P, R) + (v.length ? ' is not in 2NF: ' + v.map((x) => x.text + ' (' + x.reason + ')').join('; ') : ' is in 2NF: no nonprime attribute depends on part of a candidate key') };
  }
  /** the highest normal form among 1NF, 2NF, 3NF, BCNF (and 4NF when MVDs are given), with every test */
  function normalForm(schema, deps, opts) {
    opts = opts || {};
    const P = problem(schema, deps);
    const R = subMask(P, opts.sub);
    const ks = keysOf(P, R).keys;
    const prime = ks.reduce((a, k) => a | k, 0);
    const nonAtomic = (opts.nonAtomic || []).slice();
    const tests = {
      '1NF': { ok: !nonAtomic.length, violations: [], note: nonAtomic.length ? 'attributes with non-atomic domains: ' + nonAtomic.join(', ') : 'every domain is taken to be atomic' },
      '2NF': { ok: true, violations: twoV(P, R, ks).map((x) => vOut(P, x, 'partial dependency on the key ' + setText(P, x.key))) },
      '3NF': { ok: true, violations: threeV(P, R, opts.exhaustive, ks).map((x) => vOut(P, x, setText(P, x.l) + ' is not a superkey and ' + setText(P, x.r) + ' is not prime')) },
      'BCNF': { ok: true, violations: bcnfV(P, R, opts.exhaustive).map((x) => vOut(P, x, setText(P, x.l) + ' is not a superkey')) },
    };
    if (P.mvds.length) tests['4NF'] = { ok: true, violations: fourV(P, R).map((x) => vOut(P, x, setText(P, x.l) + ' is not a superkey')) };
    for (const k in tests) if (k !== '1NF') tests[k].ok = !tests[k].violations.length;
    const order = ['1NF', '2NF', '3NF', 'BCNF'].concat(tests['4NF'] ? ['4NF'] : []);
    let nf = null;
    for (const k of order) { if (!tests[k].ok) break; nf = k; }
    const lines = ['Candidate keys of ' + schemaText(P, R) + ': ' + ks.map((k) => '{' + setText(P, k) + '}').join(', ') + '; prime attributes: ' + setText(P, prime)];
    for (const k of order) lines.push(k + ': ' + (tests[k].ok ? 'yes' : 'no') + (tests[k].note ? ' (' + tests[k].note + ')' : '') + (tests[k].violations.length ? ', violated by ' + tests[k].violations.map((v) => v.text + ' (' + v.reason + ')').join('; ') : ''));
    lines.push(nf ? 'The schema is in ' + nf + (nf === order[order.length - 1] ? '.' : ' but not in ' + order[order.indexOf(nf) + 1] + '.') : 'The schema is not even in 1NF.');
    return { nf, keys: ks.map((k) => names(P, k)), prime: names(P, prime), tests, text: lines.join('\n') };
  }

  // ---- decompositions --------------------------------------------------------------------------------------------
  const decompOf = (P, list) => list.map((x) => mask(P, x));
  function bcnfDecompose(schema, deps, opts) {
    opts = opts || {};
    const P = problem(schema, deps);
    let result = [P.all];
    const steps = [];
    for (let guard = 0; guard < 200; guard++) {
      let i = -1, v = null;
      for (let j = 0; j < result.length && i < 0; j++) { const vs = bcnfV(P, result[j], false); if (vs.length) { i = j; v = vs[0]; } }
      if (i < 0) break;
      const Ri = result[i];
      const beta = opts.expand ? clo(P.fds, v.l) & Ri & ~v.l : v.r;
      const a = Ri & ~beta, b = v.l | beta;
      steps.push({ schema: names(P, Ri), fd: fdText(P, v.l, beta), lhs: names(P, v.l), rhs: names(P, beta), into: [names(P, a), names(P, b)], text: schemaText(P, Ri) + ' is not in BCNF: ' + fdText(P, v.l, beta) + ' holds and ' + setText(P, v.l) + ' is not a superkey of it. Replace it by ' + schemaText(P, a) + ' and ' + schemaText(P, b) + '.' });
      result.splice(i, 1, a, b);
      result = result.filter((s, k) => !result.some((t, m) => m !== k && sub(s, t) && (s !== t || m < k)));
    }
    const pres = preserveM(P, result);
    const text = (steps.length ? steps.map((s, k) => (k + 1) + '. ' + s.text).join('\n') : schemaText(P, P.all) + ' is already in BCNF.') + '\nResult: ' + result.map((s) => schemaText(P, s)).join(', ') + '\nThe decomposition is lossless' + (pres.lost.length ? '; it does not preserve ' + pres.lost.map((f) => fdText(P, f.l, f.r)).join(', ') : ' and preserves the dependencies') + '.';
    return { schemas: result.map((s) => names(P, s)), steps, preserved: !pres.lost.length, lost: pres.lost.map((f) => fdOut(P, f)), text };
  }
  function synth3NF(schema, deps, opts) {
    opts = opts || {};
    const P = problem(schema, deps);
    const cover = coverOf(P, opts.reverse ? P.fds.slice().reverse() : P.fds).F;
    const steps = [{ action: 'cover', fds: cover.map((f) => fdOut(P, f)), text: 'Canonical cover Fc = ' + fText(P, cover) }];
    const schemas = [];
    for (const f of cover) { schemas.push(f.l | f.r); steps.push({ action: 'schema', fd: fdText(P, f.l, f.r), schema: names(P, f.l | f.r), text: 'for ' + fdText(P, f.l, f.r) + ' add ' + schemaText(P, f.l | f.r) }); }
    const ks = keysOf(P, P.all).keys;
    const holder = schemas.find((s) => ks.some((k) => sub(k, s)));
    if (holder === undefined) { schemas.push(ks[0]); steps.push({ action: 'key', schema: names(P, ks[0]), text: 'no schema contains a candidate key, so add ' + schemaText(P, ks[0]) + ' for the key ' + setText(P, ks[0]) }); }
    else steps.push({ action: 'key', schema: null, text: schemaText(P, holder) + ' contains the candidate key ' + setText(P, ks.find((k) => sub(k, holder))) });
    const alive = schemas.map(() => true);
    for (let j = 0; j < schemas.length; j++) {
      const k = schemas.findIndex((t, m) => m !== j && alive[m] && sub(schemas[j], t));
      if (k >= 0) { alive[j] = false; steps.push({ action: 'remove', schema: names(P, schemas[j]), within: names(P, schemas[k]), text: 'remove ' + schemaText(P, schemas[j]) + ', contained in ' + schemaText(P, schemas[k]) }); }
    }
    const result = schemas.filter((s, j) => alive[j]);
    return { schemas: result.map((s) => names(P, s)), cover: cover.map((f) => fdOut(P, f)), steps, text: steps.map((s, k) => (k + 1) + '. ' + s.text).join('\n') + '\nResult: ' + result.map((s) => schemaText(P, s)).join(', ') };
  }

  function losslessBinary(schema, deps, R1, R2) {
    const P = problem(schema, deps);
    const a = mask(P, R1), b = mask(P, R2), c = a & b, cl = clo(P.fds, c);
    const toA = sub(a, cl), toB = sub(b, cl);
    const covers = (a | b) === P.all;
    const ok = covers && (toA || toB);
    const why = !covers ? 'the two schemas do not cover ' + setText(P, P.all & ~(a | b)) : toA ? setText(P, c) + ' → ' + setText(P, a) + ' holds' : toB ? setText(P, c) + ' → ' + setText(P, b) + ' holds' : 'neither ' + setText(P, c) + ' → ' + setText(P, a) + ' nor ' + setText(P, c) + ' → ' + setText(P, b) + ' is in F+';
    return { lossless: ok, common: names(P, c), closure: names(P, cl), text: 'R1 ∩ R2 = ' + setText(P, c) + ', whose closure is ' + setText(P, cl) + '; ' + why + ', so the decomposition is ' + (ok ? 'lossless' : 'lossy') + '.' };
  }

  function chaseM(P, D) {
    const cols = bitsOf(P.all).map((b) => Math.log2(b));
    const two = D.length < 10 && cols.length < 10;
    const rows = D.map((s, i) => cols.map((j) => (s & (1 << j) ? 'a' + (j + 1) : 'b' + (i + 1) + (two ? '' : ',') + (j + 1))));
    const states = [{ fd: null, rows: rows.map((r) => r.slice()) }];
    const full = () => rows.findIndex((r) => r.every((v) => v[0] === 'a'));
    let ch = true;
    while (ch && full() < 0) {
      ch = false;
      for (const f of P.fds) {
        let changed = false;
        const lcols = cols.filter((j) => f.l & (1 << j)), rcols = cols.filter((j) => f.r & (1 << j));
        const groups = new Map();
        rows.forEach((r, i) => { const k = lcols.map((j) => r[j]).join('|'); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); });
        for (const g of groups.values()) {
          if (g.length < 2) continue;
          for (const j of rcols) {
            const vals = new Set(g.map((i) => rows[i][j]));
            if (vals.size < 2) continue;
            const rep = [...vals].find((v) => v[0] === 'a') || rows[g[0]][j];
            for (const r of rows) if (vals.has(r[j])) r[j] = rep;
            changed = true;
          }
        }
        if (changed) { ch = true; states.push({ fd: fdText(P, f.l, f.r), rows: rows.map((r) => r.slice()) }); if (full() >= 0) break; }
      }
    }
    return { lossless: full() >= 0, row: full(), states };
  }
  /** the chase (tableau) test of a decomposition into any number of schemas */
  function chase(schema, deps, decomp) {
    const P = problem(schema, deps);
    const D = decompOf(P, decomp);
    const r = chaseM(P, D);
    const covers = D.reduce((a, s) => a | s, 0) === P.all;
    const lines = ['Tableau: one row per schema, a_j where the schema has attribute j, b_ij elsewhere.'];
    for (const s of r.states) lines.push((s.fd ? 'after ' + s.fd + ':' : 'initial:') + '\n' + s.rows.map((row) => '  ' + row.join(' ')).join('\n'));
    lines.push(r.lossless ? 'Row ' + (r.row + 1) + ' has only a\'s, so the decomposition is lossless.' : 'No dependency changes the tableau further and no row has only a\'s, so the decomposition is lossy.');
    if (!covers) lines.push('Note: the schemas do not cover every attribute.');
    return { lossless: r.lossless && covers, attrs: P.attrs.slice(), tableaux: r.states, text: lines.join('\n') };
  }

  function preserveM(P, D) {
    const results = [], lost = [];
    for (const f of P.fds) {
      let res = f.l;
      const steps = [];
      let ch = true;
      while (ch) {
        ch = false;
        for (const Ri of D) {
          const from = res & Ri, c = clo(P.fds, from), t = c & Ri;
          steps.push({ schema: Ri, from, closure: c, t, result: res | t });
          if (t & ~res) { res |= t; ch = true; }
        }
      }
      const ok = sub(f.r, res);
      results.push({ f, ok, res, steps });
      if (!ok) lost.push(f);
    }
    return { results, lost };
  }
  /** the polynomial dependency preservation test */
  function preservesDependencies(schema, deps, decomp) {
    const P = problem(schema, deps);
    const D = decompOf(P, decomp);
    const r = preserveM(P, D);
    const lines = [];
    const results = r.results.map((x) => {
      lines.push(fdText(P, x.f.l, x.f.r) + ': result = ' + setText(P, x.f.l));
      for (const s of x.steps) if (s.t & ~s.from) lines.push('  ' + schemaText(P, s.schema) + ': (' + setText(P, s.from) + ')+ ∩ R = ' + setText(P, s.t) + ' → result = ' + setText(P, s.result));
      lines.push('  ' + (x.ok ? 'preserved: ' + setText(P, x.f.r) + ' ⊆ ' + setText(P, x.res) : 'not preserved: result ' + setText(P, x.res) + ' lacks ' + setText(P, x.f.r & ~x.res)));
      return { fd: fdOut(P, x.f), preserved: x.ok, result: names(P, x.res), steps: x.steps.map((s) => ({ schema: names(P, s.schema), from: names(P, s.from), closure: names(P, s.closure), added: names(P, s.t & ~s.from), result: names(P, s.result) })) };
    });
    lines.push(r.lost.length ? 'The decomposition does not preserve ' + r.lost.map((f) => fdText(P, f.l, f.r)).join(', ') + '.' : 'The decomposition preserves every dependency.');
    return { preserved: !r.lost.length, results, lost: r.lost.map((f) => fdOut(P, f)), text: lines.join('\n') };
  }

  // ---- multivalued dependencies and 4NF --------------------------------------------------------------------------
  function parseMVDs(text, schema) {
    const P = problem(schema, text);
    return { fds: P.fds.map((f) => fdOut(P, f)), mvds: P.mvds.map((m) => ({ lhs: names(P, m.l), rhs: names(P, m.r), text: fdText(P, m.l, m.r, true) })) };
  }
  // The dependency basis of X: X ->> Y holds iff Y - X is a union of blocks. Each FD V -> W is used as the MVDs
  // V ->> A for A in W, which is sound but does not apply the FD/MVD interaction rules (coalescence) in full.
  function depBasis(P, x) {
    const deps = P.mvds.map((m) => ({ l: m.l, r: m.r }));
    for (const f of P.fds) for (const a of bitsOf(f.r)) deps.push({ l: f.l, r: a });
    let blocks = [P.all & ~x].filter(Boolean);
    let ch = true;
    while (ch) {
      ch = false;
      for (const d of deps) {
        const next = [];
        for (const y of blocks) {
          if (!(d.l & y) && (y & d.r) && (y & ~d.r)) { next.push(y & d.r, y & ~d.r); ch = true; } else next.push(y);
        }
        blocks = next;
      }
    }
    return blocks;
  }
  // On a subschema Ri an MVD a ->> b of D+ with a inside Ri gives a ->> (b ∩ Ri); the test tries every a in Ri
  // and the blocks of its dependency basis, so it finds what the basis can derive (given MVDs first).
  function fourV(P, R) {
    const out = [];
    const sk = (a) => sub(R, clo(P.fds, a));
    for (const m of P.mvds) {
      if (!sub(m.l, R)) continue;
      const b = m.r & R & ~m.l;
      if (!b || (m.l | b) === R || sk(m.l)) continue;
      out.push({ l: m.l, r: b, mvd: true, given: true });
    }
    if (out.length) return out;
    for (const f of bcnfV(P, R, false)) out.push(Object.assign({ mvd: false }, f));
    if (out.length) return out;
    for (const a of subsets(R)) {
      if (sk(a) || out.some((v) => sub(v.l, a))) continue;
      for (const y of depBasis(P, a)) {
        const b = y & R;
        if (!b || (a | b) === R) continue;
        out.push({ l: a, r: b, mvd: true });
        break;
      }
    }
    return out;
  }
  function is4NF(schema, deps, sub0) {
    const P = problem(schema, deps);
    const R = subMask(P, sub0);
    const v = fourV(P, R).map((x) => vOut(P, x, setText(P, x.l) + ' is not a superkey of ' + schemaText(P, R)));
    return { ok: !v.length, violations: v, text: schemaText(P, R) + (v.length ? ' is not in 4NF: ' + v.map((x) => x.text + ' (' + x.reason + ')').join('; ') : ' is in 4NF') };
  }
  function fourNFDecompose(schema, deps) {
    const P = problem(schema, deps);
    const result = [P.all];
    const steps = [];
    for (let guard = 0; guard < 200; guard++) {
      let i = -1, v = null;
      for (let j = 0; j < result.length && i < 0; j++) { const vs = fourV(P, result[j]); if (vs.length) { i = j; v = vs[0]; } }
      if (i < 0) break;
      const Ri = result[i], a = Ri & ~v.r, b = v.l | v.r;
      steps.push({ schema: names(P, Ri), dep: fdText(P, v.l, v.r, true), into: [names(P, a), names(P, b)], text: schemaText(P, Ri) + ' is not in 4NF: ' + fdText(P, v.l, v.r, true) + ' is nontrivial and ' + setText(P, v.l) + ' is not a superkey. Replace it by ' + schemaText(P, a) + ' and ' + schemaText(P, b) + '.' });
      result.splice(i, 1, a, b);
    }
    return { schemas: result.map((s) => names(P, s)), steps, text: (steps.length ? steps.map((s, k) => (k + 1) + '. ' + s.text).join('\n') : schemaText(P, P.all) + ' is already in 4NF.') + '\nResult: ' + result.map((s) => schemaText(P, s)).join(', ') };
  }

  // ---- FD discovery from data ------------------------------------------------------------------------------------
  /**
   * The minimal functional dependencies X -> A (|X| <= maxLhs) that hold in a table instance, found level by
   * level: X -> A is tested only when no subset of X already determines A. Input: { cols, rows } (cols as names
   * or { name }), or a Kwery session and a table name. NULL is compared as a value equal to itself.
   */
  function discover(src, table, opts) {
    let data;
    if (src && typeof src.query === 'function' && typeof table === 'string') {
      const r = src.query('SELECT * FROM ' + table);
      data = { cols: r.cols.map((c) => c.name), rows: r.rows };
    } else { data = src; opts = table; }
    opts = opts || {};
    const cols = data.cols.map((c) => (typeof c === 'string' ? c : c.name));
    const n = cols.length;
    if (n > (opts.maxCols || 12)) fail('FD discovery handles at most ' + (opts.maxCols || 12) + ' columns (this table has ' + n + ')');
    const maxLhs = opts.maxLhs === undefined ? 3 : opts.maxLhs;
    const rows = data.rows.map((r) => (Array.isArray(r) ? r : cols.map((c) => r[c])));
    const kv = rows.map((r) => r.map((v) => K.keyOf(v)));
    const found = cols.map(() => []);
    const holds = [], fails = [], uniques = [];
    const maxFails = opts.maxFails || 300;
    const P = { attrs: cols, letters: false };
    const all = (2 ** n) - 1;
    for (let k = 0; k <= Math.min(maxLhs, n - 1); k++) {
      for (const X of combos(bitsOf(all), k)) {
        const xs = bitsOf(X).map((b) => Math.log2(b));
        const gid = new Map(), g = new Array(rows.length);
        rows.forEach((r, i) => { const key = xs.map((j) => kv[i][j]).join('\u0001'); if (!gid.has(key)) gid.set(key, gid.size); g[i] = gid.get(key); });
        const unique = gid.size === rows.length;
        if (unique && rows.length > 1 && !uniques.some((u) => sub(u, X))) uniques.push(X);
        for (let a = 0; a < n; a++) {
          if (X & (1 << a) || found[a].some((m) => sub(m, X))) continue;
          const first = new Map();
          let bad = null;
          const support = [];
          for (let i = 0; i < rows.length; i++) {
            const f = first.get(g[i]);
            if (f === undefined) { first.set(g[i], i); continue; }
            if (kv[i][a] !== kv[f][a]) { bad = [f, i]; break; }
            if (support.length < 3) support.push([f, i]);
          }
          if (bad) { if (fails.length < maxFails) fails.push({ lhs: names(P, X), rhs: [cols[a]], violation: bad }); continue; }
          found[a].push(X);
          holds.push({ lhs: names(P, X), rhs: [cols[a]], support, vacuous: !support.length, key: unique, text: fdText(P, X, 1 << a) });
        }
      }
    }
    const byL = new Map();
    for (const h of holds) { const key = h.lhs.join(','); if (!byL.has(key)) byL.set(key, { lhs: h.lhs, rhs: [] }); byL.get(key).rhs.push(h.rhs[0]); }
    const grouped = [...byL.values()].map((x) => Object.assign(x, { text: (x.lhs.length ? x.lhs.join(', ') : '∅') + ' → ' + x.rhs.join(', ') }));
    const lines = ['In these ' + rows.length + ' rows (NULL counted as equal to NULL), the minimal dependencies with at most ' + maxLhs + ' attributes on the left are:'];
    for (const x of grouped) lines.push('  ' + x.text);
    if (uniques.length) lines.push('Unique column sets (keys of this instance): ' + uniques.map((u) => '{' + names(P, u).join(', ') + '}').join(', '));
    lines.push('A dependency that holds in one instance may still fail in others; only the design decides which are real.');
    return { cols, rows, holds, grouped, fails, keys: uniques.map((u) => names(P, u)), text: lines.join('\n') };
  }

  // ---- anomaly scripts -------------------------------------------------------------------------------------------
  const RESERVED = new Set(['all', 'and', 'any', 'as', 'asc', 'case', 'check', 'column', 'constraint', 'create', 'default', 'desc', 'distinct', 'do', 'else', 'end', 'for', 'foreign', 'from', 'grant', 'group', 'having', 'in', 'into', 'is', 'join', 'limit', 'not', 'null', 'on', 'or', 'order', 'primary', 'references', 'select', 'table', 'then', 'to', 'union', 'unique', 'user', 'using', 'when', 'where', 'with', 'both', 'offset', 'window', 'cast']);
  const ident = (s) => (/^[a-z_][a-z0-9_]*$/.test(s) && !RESERVED.has(s) ? s : '"' + s.replace(/"/g, '""') + '"');
  const lit = (v) => (v === null || v === undefined ? 'NULL' : "'" + String(v).replace(/'/g, "''") + "'");
  /**
   * Update, insert and delete anomalies of a schema that is not in BCNF, as SQL scripts for Kwery. Each scenario
   * script creates and fills the table itself, so it runs on its own. opts: { table, rows (arrays in schema order) }.
   */
  function anomalies(schema, deps, opts) {
    opts = opts || {};
    const P = problem(schema, deps);
    const v = bcnfV(P, P.all, false)[0];
    const table = ident(opts.table || (P.name ? K.lower(P.name) : 'r'));
    if (!v) return { table, violation: null, scenarios: [], text: schemaText(P, P.all) + ' is in BCNF: every fact is stored once, so these anomalies do not arise.' };
    const key = keysOf(P, P.all).keys[0];
    const det = clo(P.fds, v.l);
    const dep = det & ~v.l;
    const target = bitsOf(dep & ~key)[0] || bitsOf(dep)[0];
    const at = (m) => bitsOf(m).map((b) => Math.log2(b));
    const A = P.attrs;
    let rows = (opts.rows || []).map((r) => (Array.isArray(r) ? r.map((x) => (x === null ? null : String(x))) : A.map((a) => (r[a] === null || r[a] === undefined ? null : String(r[a])))));
    const val = (j, n) => K.lower(A[j]) + '_' + n;
    const same = (r, s, m) => at(m).every((j) => r[j] === s[j]);
    let pair = null;
    for (let i = 0; i < rows.length && !pair; i++) for (let j = i + 1; j < rows.length && !pair; j++) if (same(rows[i], rows[j], v.l) && !same(rows[i], rows[j], key) && rows[i][at(target)[0]] !== null) pair = [i, j];
    if (!pair) {
      const r1 = A.map((a, j) => val(j, 'x1'));
      const r2 = A.map((a, j) => (det & (1 << j) ? r1[j] : val(j, 'x2')));
      rows.push(r1, r2);
      pair = [rows.length - 2, rows.length - 1];
    }
    let lone = rows.findIndex((r) => rows.filter((s) => same(r, s, v.l)).length === 1);
    if (lone < 0) { rows.push(A.map((a, j) => val(j, 'x3'))); lone = rows.length - 1; }
    const kcols = at(key), lcols = at(v.l), dcols = at(dep), t = at(target)[0];
    const where = (r, cs) => cs.map((j) => ident(A[j]) + (r[j] === null ? ' IS NULL' : ' = ' + lit(r[j]))).join(' AND ');
    const setup = 'CREATE TABLE ' + table + ' (' + A.map((a) => ident(a) + ' text').join(', ') + ', PRIMARY KEY (' + kcols.map((j) => ident(A[j])).join(', ') + '));\n' +
      'INSERT INTO ' + table + ' VALUES\n' + rows.map((r) => '  (' + r.map(lit).join(', ') + ')').join(',\n') + ';\n';
    const L = lcols.map((j) => ident(A[j])).join(', ');
    const fd = fdText(P, v.l, dep);
    const r1 = rows[pair[0]], r3 = rows[lone];
    const scenarios = [
      {
        kind: 'update', title: 'Update anomaly',
        sql: setup + '-- ' + A[t] + ' is stored once per row, so changing it in one row leaves the others behind\n' +
          'UPDATE ' + table + ' SET ' + ident(A[t]) + ' = ' + lit(val(t, 'changed')) + ' WHERE ' + where(r1, kcols) + ';\n' +
          'SELECT ' + L + ', count(DISTINCT ' + ident(A[t]) + ') AS versions FROM ' + table + ' GROUP BY ' + L + ' HAVING count(DISTINCT ' + ident(A[t]) + ') > 1;',
        explain: 'Because ' + fd + ' holds but ' + setText(P, v.l) + ' is not a key, the value of ' + A[t] + ' for one ' + setText(P, v.l) + ' is repeated in several rows. Updating one copy makes the table contradict ' + fd + '; the last query lists the ' + setText(P, v.l) + ' values that now have more than one ' + A[t] + '.',
        expect: { rows: 1 },
      },
      {
        kind: 'insert', title: 'Insertion anomaly',
        sql: setup + '-- a new fact about ' + setText(P, v.l) + ' cannot be stored without a value for the key\n' +
          'INSERT INTO ' + table + ' (' + lcols.concat(dcols).map((j) => ident(A[j])).join(', ') + ') VALUES (' + lcols.concat(dcols).map((j) => lit(val(j, 'new'))).join(', ') + ');',
        explain: 'To record ' + fd + ' for a new ' + setText(P, v.l) + ' value we must also supply the key ' + setText(P, key) + '; leaving ' + setText(P, key & ~det) + ' NULL violates the primary key, so the insert fails.',
        expect: { error: '23502' },
      },
      {
        kind: 'delete', title: 'Deletion anomaly',
        sql: setup + '-- the only row for this ' + setText(P, v.l) + ' value also carries the fact ' + fd + '\n' +
          'DELETE FROM ' + table + ' WHERE ' + where(r3, kcols) + ';\n' +
          'SELECT ' + lcols.concat(dcols).map((j) => ident(A[j])).join(', ') + ' FROM ' + table + ' WHERE ' + where(r3, lcols) + ';',
        explain: 'Deleting the last row with ' + setText(P, v.l) + ' = ' + lcols.map((j) => r3[j]).join(', ') + ' also loses what ' + fd + ' said about it; the query finds nothing.',
        expect: { rows: 0 },
      },
    ];
    return { table, violation: fdOut(P, { l: v.l, r: dep }), key: names(P, key), rows, setup, scenarios, text: schemaText(P, P.all) + ' is not in BCNF because of ' + fd + '.\n' + scenarios.map((s) => s.title + ': ' + s.explain).join('\n') };
  }

  // ---- exercises -------------------------------------------------------------------------------------------------
  function rng(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const KINDS = ['closure', 'keys', 'cover', 'normalForm', 'bcnf', '3nf', 'lossless', 'preservation'];
  function randomProblem(r, n) {
    const attrs = 'ABCDEFGHIJ'.slice(0, n).split('');
    const all = (2 ** n) - 1;
    const pick = (from, k) => { let b = bitsOf(from), m = 0; for (let i = 0; i < k && b.length; i++) { const j = Math.floor(r() * b.length); m |= b[j]; b = b.filter((_, x) => x !== j); } return m; };
    const fds = [];
    const m = n - 2 + Math.floor(r() * 3);
    for (let tries = 0; fds.length < m && tries < 50; tries++) {
      const u = r();
      const l = pick(all, Math.min(n - 1, u < 0.55 ? 1 : u < 0.9 ? 2 : 3));
      const rr = pick(all & ~l, r() < 0.7 ? 1 : 2);
      if (!rr || fds.some((f) => f.l === l && f.r === rr)) continue;
      fds.push({ l, r: rr });
    }
    const P = problem(attrs, fds.map((f) => ({ lhs: attrs.filter((a, i) => f.l & (1 << i)), rhs: attrs.filter((a, i) => f.r & (1 << i)) })));
    return P;
  }
  function exercise(kind, seed, opts) {
    opts = opts || {};
    if (!KINDS.includes(kind)) fail('unknown exercise kind "' + kind + '" (one of ' + KINDS.join(', ') + ')');
    seed = seed === undefined ? 1 : seed;
    const r = rng(seed * 7919 + KINDS.indexOf(kind));
    const n = opts.attrs || 4 + Math.floor(r() * 4);
    let P;
    for (let t = 0; t < 40; t++) {
      P = randomProblem(r, n);
      if (kind === 'bcnf' && !bcnfV(P, P.all, false).length) continue;
      if (kind === '3nf' && !threeV(P, P.all, false, keysOf(P, P.all).keys).length) continue;
      if (kind === 'cover' && coverOf(P, P.fds).steps.length === 0 && t < 39) continue;
      break;
    }
    const sch = 'R(' + P.attrs.join(', ') + ')';
    const F = fText(P, P.fds);
    const ex = { kind, seed, schema: { name: 'R', attrs: P.attrs.slice() }, fds: P.fds.map((f) => fdOut(P, f)), fdText: F, given: {}, answer: {} };
    if (kind === 'closure') {
      let x = 0;
      for (let t = 0; t < 10 && (!x || clo(P.fds, x) === x); t++) x = bitsOf(P.all).filter(() => r() < 0.35).reduce((a, b) => a | b, 0) || bitsOf(P.all)[Math.floor(r() * n)];
      ex.given.attrs = names(P, x);
      ex.prompt = 'Given ' + sch + ' and F = ' + F + ', compute (' + setText(P, x) + ')+.';
      ex.answer.closure = names(P, clo(P.fds, x));
    } else if (kind === 'keys') {
      ex.prompt = 'Given ' + sch + ' and F = ' + F + ', find all candidate keys.';
      ex.answer.keys = keysOf(P, P.all).keys.map((k) => names(P, k));
    } else if (kind === 'cover') {
      ex.prompt = 'Given ' + sch + ' and F = ' + F + ', find a canonical cover of F.';
      ex.answer.fds = coverOf(P, P.fds).F.map((f) => fdOut(P, f).text);
    } else if (kind === 'normalForm') {
      ex.prompt = 'Given ' + sch + ' and F = ' + F + ', what is the highest normal form (1NF, 2NF, 3NF, BCNF) of R?';
      ex.answer.nf = normalForm(P).nf;
    } else if (kind === 'bcnf') {
      ex.prompt = 'Given ' + sch + ' and F = ' + F + ', decompose R into BCNF (lossless).';
      ex.answer.schemas = bcnfDecompose(P).schemas;
    } else if (kind === '3nf') {
      ex.prompt = 'Given ' + sch + ' and F = ' + F + ', give a lossless, dependency-preserving decomposition of R into 3NF.';
      ex.answer.schemas = synth3NF(P).schemas;
    } else {
      let D;
      if (r() < 0.5) D = bcnfDecompose(P).schemas.map((s) => mask(P, s));
      if (!D || D.length < 2) {
        const k = 2 + Math.floor(r() * 2);
        D = [];
        for (let i = 0; i < k; i++) D.push(bitsOf(P.all).filter(() => r() < 0.5).reduce((a, b) => a | b, 0) || bitsOf(P.all)[i % n]);
        for (const b of bitsOf(P.all)) if (!D.some((s) => s & b)) D[Math.floor(r() * k)] |= b;
      }
      ex.given.schemas = D.map((s) => names(P, s));
      const dt = D.map((s) => schemaText(P, s)).join(', ');
      if (kind === 'lossless') { ex.prompt = 'Given ' + sch + ' and F = ' + F + ', is the decomposition ' + dt + ' lossless?'; ex.answer.lossless = chaseM(P, D).lossless; }
      else { const pr = preserveM(P, D); ex.prompt = 'Given ' + sch + ' and F = ' + F + ', does the decomposition ' + dt + ' preserve the dependencies? If not, which dependencies of F are lost?'; ex.answer.preserved = !pr.lost.length; ex.answer.lost = pr.lost.map((f) => fdText(P, f.l, f.r)); }
    }
    return ex;
  }
  function parseSets(P, x) {
    if (Array.isArray(x)) return x.map((s) => mask(P, s));
    const text = String(x);
    if (text.includes('(')) {
      const out = [];
      const re = /\(([^)]*)\)/g;
      let m;
      while ((m = re.exec(text))) out.push(mask(P, m[1]));
      return out;
    }
    let parts;
    if (P.letters) parts = /[,;|\n]/.test(text) ? text.split(/[,;|\n]+/) : text.split(/\s+/);
    else parts = text.split(/[;|\n]+/);
    return parts.map((s) => s.replace(/[{}]/g, '').trim()).filter(Boolean).map((s) => mask(P, s));
  }
  function parseBool(x) {
    if (typeof x === 'boolean') return x;
    const s = String(x).trim().toLowerCase();
    if (/^(yes|y|true|lossless|preserved|preserving|t)$/.test(s)) return true;
    if (/^(no|n|false|lossy|not|not preserved|f)$/.test(s)) return false;
    return null;
  }
  function check(ex, answer) {
    const P = problem(ex.schema, ex.fds.map((f) => ({ lhs: f.lhs, rhs: f.rhs })));
    const fb = [];
    const details = {};
    const pick = (k) => (answer && typeof answer === 'object' && !Array.isArray(answer) && k in answer ? answer[k] : answer);
    let ok = false;
    try {
      switch (ex.kind) {
        case 'closure': {
          const want = clo(P.fds, mask(P, ex.given.attrs)), got = mask(P, pick('closure'));
          ok = got === want;
          if (want & ~got) fb.push('missing: ' + setText(P, want & ~got));
          if (got & ~want) fb.push('not in the closure: ' + setText(P, got & ~want));
          details.expected = names(P, want);
          break;
        }
        case 'keys': {
          const want = keysOf(P, P.all).keys, got = parseSets(P, pick('keys'));
          for (const k of want) if (!got.includes(k)) fb.push('missing candidate key ' + setText(P, k));
          for (const g of got) {
            if (want.includes(g)) continue;
            if (!sub(P.all, clo(P.fds, g))) fb.push(setText(P, g) + ' is not a superkey: its closure is ' + setText(P, clo(P.fds, g)));
            else fb.push(setText(P, g) + ' is a superkey but not minimal');
          }
          ok = !fb.length && new Set(got).size === want.length;
          if (!fb.length && !ok) fb.push('a key is listed twice');
          break;
        }
        case 'cover': {
          const a = pick('fds');
          const G = problem(P.attrs, Array.isArray(a) ? a.map((f) => (typeof f === 'string' ? f : f)) : String(a)).fds;
          for (const f of P.fds) if (!sub(f.r, clo(G, f.l))) fb.push(fdText(P, f.l, f.r) + ' of F does not follow from your cover');
          for (const g of G) if (!sub(g.r, clo(P.fds, g.l))) fb.push(fdText(P, g.l, g.r) + ' does not follow from F');
          const ls = G.map((g) => g.l);
          if (new Set(ls).size !== ls.length) fb.push('two dependencies have the same left side; combine them with the union rule');
          if (!fb.length) {
            G.forEach((g, i) => {
              for (const b of bitsOf(g.l)) if (sub(g.r, clo(G, g.l & ~b))) fb.push(names(P, b)[0] + ' is extraneous in the left side of ' + fdText(P, g.l, g.r));
              for (const b of bitsOf(g.r)) { const G2 = G.map((h, j) => (j === i ? { l: h.l, r: h.r & ~b } : h)).filter((h) => h.r); if (clo(G2, g.l) & b) fb.push(names(P, b)[0] + ' is extraneous in the right side of ' + fdText(P, g.l, g.r)); }
            });
          }
          ok = !fb.length;
          break;
        }
        case 'normalForm': {
          const want = normalForm(P);
          const got = String(pick('nf')).toUpperCase().replace(/\s+/g, '').replace(/^BOYCE.*/, 'BCNF').replace(/^(FIRST|1)(NF)?$/, '1NF').replace(/^(SECOND|2)(NF)?$/, '2NF').replace(/^(THIRD|3)(NF)?$/, '3NF');
          ok = got === want.nf;
          if (!ok) {
            const order = ['1NF', '2NF', '3NF', 'BCNF'];
            if (order.indexOf(got) > order.indexOf(want.nf)) { const nx = order[order.indexOf(want.nf) + 1]; fb.push('R is not in ' + nx + ': ' + want.tests[nx].violations.map((v) => v.text + ' (' + v.reason + ')').join('; ')); }
            else if (order.includes(got)) fb.push('R satisfies more than ' + got);
            else fb.push('answer with 1NF, 2NF, 3NF or BCNF');
          }
          details.expected = want.nf;
          break;
        }
        case 'bcnf': case '3nf': {
          const D = parseSets(P, pick('schemas'));
          const cover = D.reduce((x, s) => x | s, 0);
          if (cover !== P.all) fb.push('attributes missing from every schema: ' + setText(P, P.all & ~cover));
          if (!chaseM(P, D).lossless) fb.push('the decomposition is lossy (the chase ends with no row of a\'s)');
          for (const s of D) {
            if (ex.kind === 'bcnf') { const v = bcnfV(P, s, false); if (v.length) fb.push(schemaText(P, s) + ' is not in BCNF: ' + fdText(P, v[0].l, v[0].r) + ' holds and ' + setText(P, v[0].l) + ' is not a superkey of it'); }
            else { const v = threeV(P, s, s !== P.all, keysOf(P, s).keys); if (v.length) fb.push(schemaText(P, s) + ' is not in 3NF: ' + fdText(P, v[0].l, v[0].r)); }
          }
          if (ex.kind === '3nf') { const lost = preserveM(P, D).lost; if (lost.length) fb.push('not dependency preserving: ' + lost.map((f) => fdText(P, f.l, f.r)).join(', ') + ' cannot be checked on the schemas'); }
          ok = !fb.length;
          break;
        }
        case 'lossless': {
          const want = chaseM(P, ex.given.schemas.map((s) => mask(P, s))).lossless, got = parseBool(pick('lossless'));
          ok = got === want;
          if (got === null) fb.push('answer yes (lossless) or no (lossy)');
          else if (!ok) fb.push(want ? 'it is lossless: the chase produces a row of a\'s' : 'it is lossy: the chase ends without a row of a\'s');
          break;
        }
        case 'preservation': {
          const pr = preserveM(P, ex.given.schemas.map((s) => mask(P, s)));
          const got = parseBool(pick('preserved'));
          ok = got === !pr.lost.length;
          if (got === null) fb.push('answer yes or no');
          else if (!ok) fb.push(pr.lost.length ? 'some dependencies are lost: ' + pr.lost.map((f) => fdText(P, f.l, f.r)).join(', ') : 'every dependency is preserved');
          const lost = answer && typeof answer === 'object' && answer.lost;
          if (ok && lost && pr.lost.length) {
            const G = problem(P.attrs, lost).fds;
            const same = G.length === pr.lost.length && G.every((g) => pr.lost.some((f) => f.l === g.l && f.r === g.r));
            if (!same) { ok = false; fb.push('the lost dependencies are ' + pr.lost.map((f) => fdText(P, f.l, f.r)).join(', ')); }
          }
          break;
        }
      }
    } catch (e) {
      ok = false;
      fb.push('could not read the answer: ' + e.message);
    }
    if (ok) fb.unshift('correct');
    return { ok, feedback: fb, details };
  }

  K.Normal = {
    parseSchema, parseDeps, parseFDs: (text, schema, opts) => parseDeps(text, schema ? parseSchema(schema) : null, opts).filter((d) => !d.mvd), parseMVDs, problem,
    closure, fplus, derive, keys, isSuperkey, canonicalCover, primeAttrs,
    normalForm, is2NF, is3NF, isBCNF, is4NF, bcnfDecompose, synth3NF, fourNFDecompose, losslessBinary, chase, preservesDependencies,
    discover, anomalies, exercise, check, KINDS,
    fmt: { set: (P, x) => setText(P, mask(P, x)), fd: (P, l, r, mvd) => fdText(P, mask(P, l), mask(P, r), mvd), schema: (P, x) => schemaText(P, mask(P, x)) },
    names, mask, closureMask: (P, x) => clo(P.fds, x),
  };
})(typeof window !== 'undefined' ? window : globalThis);
