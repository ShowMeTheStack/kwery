// Automatic layout of an E-R model for the canvas, in three notations:
//   chen      — entity rectangles, relationship diamonds, attribute ovals around their owner
//   textbook  — the boxed-attribute notation (min..max): attributes listed inside the entity rectangle, diamonds for relationships,
//               descriptive attributes in a box tied to the diamond by a dashed line, hollow arrows for specialization
//   crowsfoot — entity boxes with attributes, binary relationships drawn as lines with crow's-foot ends, other
//               relationships as associative entity boxes
// Everything is data: positions, sizes, routed edge points and the markers each notation uses. render.js draws it.
//
// How the automatic layout works. Every entity set, relationship set and specialization point (and, in crow's foot,
// the middle of each relationship line) is a unit on a grid. Simulated annealing with a fixed seed (so a design is
// always drawn the same way) moves units between cells so that related units are next to each other in a row or a
// column, no edge crosses another or runs over a unit, a diamond uses each of its corners once, a specialization
// hangs below its parent, and the grid keeps the shape of the view. Each row and column then takes the size of its
// largest unit and units sit on the row's and column's centre lines, so neighbours are joined by straight lines.
// The router draws every edge as the simplest clean shape it finds (straight, one bend, two bends, a detour round
// the outside), checking each against every shape and every edge already drawn. Labels go next to their own line
// end at the first spot that touches no shape, line, marker or other label. Chen's attribute ovals and the boxed notation's
// box of descriptive attributes take the sides of their node that no edge uses.
// A layout from saved positions (the user moved things) keeps them and only routes the edges and places the labels.
(function (root) {
  'use strict';
  const K = root.K;
  const ER = K.ER;
  const lc = (s) => String(s).toLowerCase();
  const NOTATIONS = { chen: 'chen', textbook: 'textbook', '7e': 'textbook', book: 'textbook', crowsfoot: 'crowsfoot', crow: 'crowsfoot', 'crows-foot': 'crowsfoot', ie: 'crowsfoot' };
  ER.notation = (n) => NOTATIONS[lc(n || 'textbook')] || 'textbook';

  const FS = 13, LINE = 18, PAD = 12;
  const textW = (s, fs) => Math.ceil(String(s).length * (fs || FS) * 0.6);
  // the box of an 11px label (a little wider than the glyphs, for a margin)
  // close to the advance widths of Helvetica, in ems
  const EM = (ch) => ('ijlI.,:;|!\''.includes(ch) ? 0.24 : 'frt()[]{} '.includes(ch) ? 0.31 : 'mwMW@'.includes(ch) ? 0.86 : '*-'.includes(ch) ? 0.36 : /[A-Z]/.test(ch) ? 0.68 : 0.56);
  const tw = (s, size) => { let w = 0; for (const ch of String(s)) w += EM(ch); return w * size; };
  const labelW = (s) => Math.ceil(tw(s, 11) * 1.06) + 6;
  const LH = 14;
  /** a diamond wide enough for its name to sit inside it (inside the inner diamond of an identifying one) */
  const relW = (s, ident) => Math.max(ident ? 108 : 96, Math.ceil(String(s).length * 7 * (ident ? 1.6 : 1.42) + (ident ? 30 : 22)));

  /** the lines listed inside an entity rectangle (textbook and crow's foot notations) */
  function attrLines(attrs, showTypes, depth) {
    const out = [];
    for (const a of attrs || []) {
      let text = a.name + (a.derived && !a.components ? ' ( )' : '');
      if (a.multivalued) text = '{ ' + text + ' }';
      if (showTypes && a.type && !a.components) text += ' : ' + a.type;
      out.push({ text, key: !!a.key, partial: !!a.partial, derived: !!a.derived, multivalued: !!a.multivalued, composite: !!a.components, depth: depth || 0 });
      if (a.components) out.push(...attrLines(a.components, showTypes, (depth || 0) + 1).map((l) => Object.assign(l, { key: l.key || !!a.key, partial: l.partial || !!a.partial })));
    }
    return out;
  }
  ER.attrLines = attrLines;
  const boxSize = (title, lines) => {
    const w = Math.max(textW(title, FS + 1) + 2 * PAD, ...lines.map((l) => textW(l.text) + l.depth * 14 + 2 * PAD), 100);
    const h = 28 + (lines.length ? lines.length * LINE + 10 : 0);
    return { w, h };
  };

  // ---- geometry helpers
  const overlap = (a, b, gap) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
  const inflate = (b, d) => ({ x: b.x - d, y: b.y - d, w: b.w + 2 * d, h: b.h + 2 * d });
  const centre = (n) => ({ x: n.x + n.w / 2, y: n.y + n.h / 2 });
  const r1 = (v) => +(+v).toFixed(1);
  const pt = (x, y) => ({ x: r1(x), y: r1(y) });
  /** the point where the segment from the centre of node n towards p leaves the node's outline */
  function clip(n, p) {
    const cx = n.x + n.w / 2, cy = n.y + n.h / 2;
    const dx = p.x - cx, dy = p.y - cy;
    if (!dx && !dy) return { x: cx, y: cy };
    const hw = n.w / 2, hh = n.h / 2;
    let t;
    if (n.shape === 'diamond') t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
    else if (n.shape === 'ellipse') t = 1 / Math.sqrt((dx * dx) / (hw * hw) + (dy * dy) / (hh * hh));
    else if (n.shape === 'point') t = 0;
    else t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
    return pt(cx + dx * t, cy + dy * t);
  }
  /** does the segment pq pass through the inside of box b (running along its border does not count)? */
  function segBox(p, q, b) {
    let t0 = 0, t1 = 1;
    const dx = q.x - p.x, dy = q.y - p.y;
    const edge = (pp, qq) => {
      if (Math.abs(pp) < 1e-9) return qq > 1e-9;
      const r = qq / pp;
      if (pp < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
      return true;
    };
    if (!edge(-dx, p.x - b.x) || !edge(dx, b.x + b.w - p.x) || !edge(-dy, p.y - b.y) || !edge(dy, b.y + b.h - p.y)) return false;
    return (t1 - t0) * Math.hypot(dx, dy) > 0.5;
  }
  const cr = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const near = (a, b, d) => Math.abs(a.x - b.x) <= (d || 0.6) && Math.abs(a.y - b.y) <= (d || 0.6);
  function pointSeg(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0;
    return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
  }
  /** how two segments meet: 2 they cross, 1 they run along each other closer than `gap` or one ends on the other,
   *  0 they keep apart (sharing an end point is allowed) */
  function segMeet(p1, p2, p3, p4, gap) {
    const d1 = cr(p3, p4, p1), d2 = cr(p3, p4, p2), d3 = cr(p1, p2, p3), d4 = cr(p1, p2, p4);
    const s = (v) => (v > 1e-6 ? 1 : v < -1e-6 ? -1 : 0);
    if (s(d1) * s(d2) < 0 && s(d3) * s(d4) < 0) return 2;
    const l1 = Math.hypot(p2.x - p1.x, p2.y - p1.y), l2 = Math.hypot(p4.x - p3.x, p4.y - p3.y);
    if (l1 < 0.5 || l2 < 0.5) return 0;
    // nearly parallel and close: they would look like one line
    const ux = (p2.x - p1.x) / l1, uy = (p2.y - p1.y) / l1, vx = (p4.x - p3.x) / l2, vy = (p4.y - p3.y) / l2;
    if (Math.abs(ux * vy - uy * vx) < 0.05) {
      const dist = Math.abs(cr(p1, p2, p3)) / l1;
      if (dist < (gap || 7)) {
        const a = (p3.x - p1.x) * ux + (p3.y - p1.y) * uy, b = (p4.x - p1.x) * ux + (p4.y - p1.y) * uy;
        const lo = Math.max(0, Math.min(a, b)), hi = Math.min(l1, Math.max(a, b));
        if (hi - lo > 3) return 1;
      }
    }
    // an end lying on the other segment (a T), unless it is an end of that segment too
    const shared = near(p1, p3) || near(p1, p4) || near(p2, p3) || near(p2, p4);
    if (!shared) for (const [p, a, b] of [[p1, p3, p4], [p2, p3, p4], [p3, p1, p2], [p4, p1, p2]]) if (pointSeg(p, a, b) < 3) return 1;
    return 0;
  }
  const segsOf = (pts) => { const out = []; for (let i = 1; i < pts.length; i++) if (!near(pts[i - 1], pts[i], 0.05)) out.push([pts[i - 1], pts[i]]); return out; };
  const pathLen = (pts) => segsOf(pts).reduce((s, [a, b]) => s + Math.hypot(b.x - a.x, b.y - a.y), 0);
  /** drop repeated points and the middle of three points on one straight line */
  function tidy(pts) {
    const a = [];
    for (const p of pts) if (!a.length || !near(a[a.length - 1], p, 0.05)) a.push(p);
    for (let i = a.length - 2; i > 0; i--) if (Math.abs(cr(a[i - 1], a[i], a[i + 1])) < 0.01 && (a[i].x - a[i - 1].x) * (a[i + 1].x - a[i].x) + (a[i].y - a[i - 1].y) * (a[i + 1].y - a[i].y) > 0) a.splice(i, 1);
    return a;
  }

  // ---- clusters: a node with its satellites (Chen attribute ovals, the boxed notation's descriptive attribute box)
  // Satellite positions are relative to the cluster's main node centre.
  const angDist = (a, b) => { const d = Math.abs(a - b) % (2 * Math.PI); return Math.min(d, 2 * Math.PI - d); };
  const SIDE_ANGLE = { right: 0, bottom: Math.PI / 2, left: Math.PI, top: -Math.PI / 2 };
  /** angles for n satellites: evenly spread, or kept away from the given directions */
  function ringAngles(n, avoid) {
    if (!avoid || !avoid.length) return Array.from({ length: n }, (_, i) => (2 * Math.PI * i) / n - Math.PI / 2);
    const cand = Array.from({ length: 72 }, (_, k) => (2 * Math.PI * k) / 72 - Math.PI / 2);
    const chosen = [];
    const sep = Math.min(Math.PI / 4, (2 * Math.PI) / (n + avoid.length) * 0.9);
    for (let i = 0; i < n; i++) {
      let best = null, bestScore = -Infinity;
      for (const a of cand) {
        const de = Math.min(...avoid.map((b) => angDist(a, b)));
        const dc = chosen.length ? Math.min(...chosen.map((b) => angDist(a, b))) : Math.PI;
        // stay off the edges first, then away from the satellites already placed
        const score = Math.min(de, Math.PI / 3) * 2 + Math.min(dc, sep * 1.5) * 3 - (dc < sep * 0.6 ? 10 : 0) - (de < 0.5 ? 20 : 0);
        if (score > bestScore + 1e-9) { bestScore = score; best = a; }
      }
      chosen.push(best);
    }
    // keep the declared order of the attributes going round from the top
    const norm = (a) => ((a + Math.PI / 2) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
    return chosen.sort((a, b) => norm(a) - norm(b));
  }
  /** the bands beside a node that its edges use: satellites keep out of them */
  function strips(main, blocked) {
    const out = [], hw = main.w / 2, hh = main.h / 2, F = 1e5, m = 12;
    if (blocked.bottom) out.push({ x: -hw - m, y: hh, w: main.w + 2 * m, h: F });
    if (blocked.top) out.push({ x: -hw - m, y: -hh - F, w: main.w + 2 * m, h: F });
    if (blocked.right) out.push({ x: hw, y: -hh - m, w: F, h: main.h + 2 * m });
    if (blocked.left) out.push({ x: -hw - F, y: -hh - m, w: F, h: main.h + 2 * m });
    // a neighbour across a corner: its edge bends through that quadrant
    const sides = ['top', 'bottom', 'left', 'right'].filter((k) => blocked[k]).length;
    if (sides > 2) return out;
    if (blocked.br) out.push({ x: 0, y: 0, w: F, h: F });
    if (blocked.bl) out.push({ x: -F, y: 0, w: F, h: F });
    if (blocked.tr) out.push({ x: 0, y: -F, w: F, h: F });
    if (blocked.tl) out.push({ x: -F, y: -F, w: F, h: F });
    return out;
  }
  function ring(main, items, blocked) {
    // place items (each { w, h, kids }) on an elliptical ring around the main node, growing it until nothing overlaps
    const n = items.length;
    if (!n) return;
    const avoid = Object.keys(SIDE_ANGLE).filter((k) => blocked[k]).map((k) => SIDE_ANGLE[k]).concat(['br', 'bl', 'tl', 'tr'].filter((k) => blocked[k]).map((k) => ({ br: Math.PI / 4, bl: 3 * Math.PI / 4, tl: -3 * Math.PI / 4, tr: -Math.PI / 4 })[k]));
    const angles = ringAngles(n, avoid);
    const st = strips(main, blocked);
    let R = Math.max(main.w, main.h) / 2 + 26;
    for (let iter = 0; iter < 500; iter++) {
      const boxes = items.map((it, i) => {
        const a = angles[i];
        const cx = Math.cos(a) * R * 1.35, cy = Math.sin(a) * R;
        it.angle = a; it.cx = cx; it.cy = cy;
        return { x: cx - it.bw / 2, y: cy - it.bh / 2, w: it.bw, h: it.bh };
      });
      const mainBox = { x: -main.w / 2, y: -main.h / 2, w: main.w, h: main.h };
      let ok = boxes.every((b) => !overlap(b, mainBox, 14) && !st.some((s) => overlap(b, s, 4)));
      for (let i = 0; ok && i < n; i++) for (let j = i + 1; ok && j < n; j++) if (overlap(boxes[i], boxes[j], 10)) ok = false;
      if (ok) return;
      R += 6;
    }
  }
  function ovalItem(a) {
    // an attribute oval with its component ovals in a row further out
    const w = Math.max(textW(a.name) + 30, 54), h = 30;
    const it = { attr: a, w, h, kids: (a.components || []).map(ovalItem) };
    if (it.kids.length) {
      const rowW = it.kids.reduce((s, k) => s + k.bw, 0) + 12 * (it.kids.length - 1);
      const rowH = Math.max(...it.kids.map((k) => k.bh));
      it.bw = Math.max(w, rowW); it.bh = h + 26 + rowH; it.rowW = rowW; it.rowH = rowH;
    } else { it.bw = w; it.bh = h; }
    return it;
  }
  function placeOvals(it, cx, cy, outwardDown, out, ownerId, prefix) {
    // returns the oval node for the item; its kids sit in a row away from the owner
    const top = outwardDown ? cy - it.bh / 2 : cy + it.bh / 2 - it.h;
    const node = { id: prefix + it.attr.name, kind: 'attribute', shape: 'ellipse', name: it.attr.name, label: it.attr.name, x: cx - it.w / 2, y: top, w: it.w, h: it.h, owner: ownerId,
      key: !!it.attr.key, partial: !!it.attr.partial, multivalued: !!it.attr.multivalued, derived: !!it.attr.derived, composite: !!it.kids.length, type: it.attr.type || null };
    out.push(node);
    if (it.kids.length) {
      let x = cx - it.rowW / 2;
      const ky = outwardDown ? top + it.h + 26 + it.rowH / 2 : top - 26 - it.rowH / 2;
      for (const k of it.kids) {
        const kn = placeOvals(k, x + k.bw / 2, ky, outwardDown, out, node.id, node.id + '.');
        kn.parentAttr = node.id;
        x += k.bw + 12;
      }
    }
    return node;
  }
  function buildCluster(c, blocked) {
    // compute satellite offsets and the cluster's bounding box (relative to the main node's centre)
    blocked = blocked || {};
    const main = c.main;
    c.sat = [];
    c.blocked = blocked;
    if (c.items && c.items.length) {
      ring(main, c.items, blocked);
      for (const it of c.items) placeOvals(it, it.cx, it.cy, it.cy > 0.01, c.sat, main.id, main.id + '.');
    }
    if (c.attrBox) {
      // the descriptive attributes take a side of the diamond that no edge uses
      const b = c.attrBox, side = ['right', 'left', 'bottom', 'top'].find((s) => !blocked[s]) || 'right', d = 30;
      c.attrSide = side;
      if (side === 'right') { b.x = main.w / 2 + d; b.y = -b.h / 2; }
      else if (side === 'left') { b.x = -main.w / 2 - d - b.w; b.y = -b.h / 2; }
      else if (side === 'bottom') { b.x = -b.w / 2; b.y = main.h / 2 + d; }
      else { b.x = -b.w / 2; b.y = -main.h / 2 - d - b.h; }
      c.sat.push(b);
    }
    const all = [{ x: -main.w / 2, y: -main.h / 2, w: main.w, h: main.h }].concat(c.sat);
    // a line from an entity set back to itself loops out on its right
    if (c.loop) all.push({ x: main.w / 2, y: -main.h / 2, w: 120, h: main.h });
    const x0 = Math.min(...all.map((b) => b.x)), y0 = Math.min(...all.map((b) => b.y));
    const x1 = Math.max(...all.map((b) => b.x + b.w)), y1 = Math.max(...all.map((b) => b.y + b.h));
    c.bx = x0; c.by = y0; c.w = x1 - x0; c.h = y1 - y0;
  }

  // ---- grid placement by simulated annealing -------------------------------------------------------------------
  // units: [{ kind: 'ent'|'rel'|'pt', w, h, free }], edges: [{ a, b, k }] (k parallel edges), prefs: [{ above, below }]
  function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function gridPlace(units, edges, prefs, aspect, seed) {
    const n = units.length;
    const X = new Array(n).fill(0), Y = new Array(n).fill(0);
    if (n === 1) return [{ x: 0, y: 0 }];
    const occ = new Map(), key = (x, y) => (x + 4096) * 8192 + (y + 4096);
    const inc = units.map(() => []), nb = units.map(() => []), pin = units.map(() => []);
    edges.forEach((e, i) => { inc[e.a].push(i); inc[e.b].push(i); nb[e.a].push(e.b); nb[e.b].push(e.a); });
    prefs.forEach((p, i) => { pin[p.above].push(i); pin[p.below].push(i); });
    // the shape of a cell in pixels turns the view's aspect into one for the grid
    const cw = units.reduce((s, u) => s + u.w, 0) / n + 60, ch = units.reduce((s, u) => s + u.h, 0) / n + 50;
    const ac = Math.max(0.35, Math.min(4, aspect * ch / cw));
    const W_CROSS = 60, W_PASS = 60, W_CONF = 3, W_LEN = 2.5;
    const eLen = (e) => {
      const dx = Math.abs(X[e.a] - X[e.b]), dy = Math.abs(Y[e.a] - Y[e.b]), d = dx + dy;
      if (d === 1) return 0;
      if (dx === 1 && dy === 1) return 0.55;
      if (!dx || !dy) return d - 1 + 0.4;
      return d - 2 + 1.2;
    };
    const EA = new Int32Array(edges.length), EB = new Int32Array(edges.length);
    edges.forEach((e, i) => { EA[i] = e.a; EB[i] = e.b; });
    // the shapes an edge can take on the grid: straight when its ends share a row or a column, else one of two L's
    // (the router draws orthogonal lines, so a diagonal between centres would hide crossings)
    const VB = new Uint8Array(edges.length); // which L each bent edge takes: 0 along the row of its first unit first, 1 along the column
    const nVar = (i) => (X[EA[i]] === X[EB[i]] || Y[EA[i]] === Y[EB[i]] || (Math.abs(X[EA[i]] - X[EB[i]]) === 1 && Math.abs(Y[EA[i]] - Y[EB[i]]) === 1) ? 1 : 2);
    const legs = (i, v) => {
      const x1 = X[EA[i]], y1 = Y[EA[i]], x2 = X[EB[i]], y2 = Y[EB[i]];
      // a diagonal neighbour is a short diagonal: the router can bend it either way round the corner cells
      if (x1 === x2 || y1 === y2 || (Math.abs(x1 - x2) === 1 && Math.abs(y1 - y2) === 1)) return [[x1, y1, x2, y2]];
      return v ? [[x1, y1, x1, y2], [x1, y2, x2, y2]] : [[x1, y1, x2, y1], [x2, y1, x2, y2]];
    };
    /** two grid segments cross, or overlap along one line (touching at an end does not count) */
    const segHit = (s, t) => {
      const x1 = s[0], y1 = s[1], x2 = s[2], y2 = s[3], x3 = t[0], y3 = t[1], x4 = t[2], y4 = t[3];
      if (Math.max(x1, x2) < Math.min(x3, x4) || Math.max(x3, x4) < Math.min(x1, x2) || Math.max(y1, y2) < Math.min(y3, y4) || Math.max(y3, y4) < Math.min(y1, y2)) return false;
      const d1 = (x4 - x3) * (y1 - y3) - (y4 - y3) * (x1 - x3), d2 = (x4 - x3) * (y2 - y3) - (y4 - y3) * (x2 - x3);
      const d3 = (x2 - x1) * (y3 - y1) - (y2 - y1) * (x3 - x1), d4 = (x2 - x1) * (y4 - y1) - (y2 - y1) * (x4 - x1);
      if (d1 * d2 < 0 && d3 * d4 < 0) return true;
      if (!d1 && !d2) {
        const dx = x2 - x1, dy = y2 - y1, L = dx * dx + dy * dy;
        if (!L) return false;
        const t3 = ((x3 - x1) * dx + (y3 - y1) * dy) / L, t4 = ((x4 - x1) * dx + (y4 - y1) * dy) / L;
        return Math.min(1, Math.max(t3, t4)) - Math.max(0, Math.min(t3, t4)) > 1e-6;
      }
      return false;
    };
    /** do edges i and j cross whichever shapes they take? */
    const crossIx = (i, j) => {
      const a = EA[i], b = EB[i], c = EA[j], d = EB[j];
      if ((X[a] > X[b] ? X[a] : X[b]) < (X[c] < X[d] ? X[c] : X[d]) || (X[c] > X[d] ? X[c] : X[d]) < (X[a] < X[b] ? X[a] : X[b]) || (Y[a] > Y[b] ? Y[a] : Y[b]) < (Y[c] < Y[d] ? Y[c] : Y[d]) || (Y[c] > Y[d] ? Y[c] : Y[d]) < (Y[a] < Y[b] ? Y[a] : Y[b])) return 0;
      const ni = nVar(i), nj = nVar(j);
      for (const s1 of legs(i, ni > 1 ? VB[i] : 0)) for (const s2 of legs(j, nj > 1 ? VB[j] : 0)) if (segHit(s1, s2)) return 1;
      return 0;
    };
    /** how many units edge i runs over, in its better shape */
    const passCost = (i) => {
      let best = Infinity;
      const ax = X[EA[i]], ay = Y[EA[i]], bx = X[EB[i]], by = Y[EB[i]];
      for (let v = nVar(i) > 1 ? VB[i] : 0, k = 0; k < 1; k++) {
        let c = 0;
        for (const [x1, y1, x2, y2] of legs(i, v)) {
          if (Math.abs(x1 - x2) === 1 && Math.abs(y1 - y2) === 1) continue;
          const sx = Math.sign(x2 - x1), sy = Math.sign(y2 - y1);
          for (let x = x1, y = y1; ; x += sx, y += sy) {
            if (!(x === ax && y === ay) && !(x === bx && y === by) && occ.has(key(x, y))) c++;
            if (x === x2 && y === y2) break;
          }
        }
        if (c < best) best = c;
      }
      return best;
    };
    const conf = (u) => {
      const cnt = [0, 0, 0, 0];
      for (const ei of inc[u]) {
        const e = edges[ei], v = e.a === u ? e.b : e.a, dx = X[v] - X[u], dy = Y[v] - Y[u];
        cnt[Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 0 : 1) : (dy > 0 ? 2 : 3)] += e.k;
      }
      const cap = units[u].kind === 'ent' ? 2 : 1;
      let c = 0, used = 0;
      for (const v of cnt) { if (v) used++; c += Math.max(0, v - cap); }
      if (units[u].free && used + units[u].free > 4) c += 1;
      // a binary relationship reads best with its two entity sets on opposite sides
      if (units[u].kind === 'rel' && inc[u].length === 2 && used === 2 && !((cnt[0] && cnt[1]) || (cnt[2] && cnt[3]))) c += 0.15;
      return c;
    };
    const isaCost = (p) => { const d = Y[p.below] - Y[p.above]; return d >= 1 ? 0.15 * (d - 1) + (X[p.below] === X[p.above] ? 0 : 0.1) : 9 + (1 - d) * 3; };
    const area = () => {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let i = 0; i < n; i++) { if (X[i] < x0) x0 = X[i]; if (X[i] > x1) x1 = X[i]; if (Y[i] < y0) y0 = Y[i]; if (Y[i] > y1) y1 = Y[i]; }
      const w = x1 - x0 + 1, h = y1 - y0 + 1;
      return 0.3 * (w + h) + 1.2 * Math.max(w / (ac * h), (ac * h) / w) + 0.025 * w * h;
    };
    // the part of the cost that involves the units in S
    const mark = new Int32Array(edges.length), umark = new Int32Array(n), pmark = new Int32Array(prefs.length);
    let stamp = 0, ustamp = 0;
    function partial(S, cells) {
      stamp++;
      const A = [];
      for (const u of S) for (const ei of inc[u]) if (mark[ei] !== stamp) { mark[ei] = stamp; A.push(ei); }
      let c = 0;
      for (const ei of A) {
        const e = edges[ei];
        c += W_LEN * eLen(e) * (e.k > 1 ? 1.5 : 1);
        if (bucketsOn) {
          cstamp++;
          cellsOf(ei, (k) => { const b = bk.get(k); if (b) for (const fi of b) { if (cmark[fi] === cstamp) continue; cmark[fi] = cstamp; if (fi === ei || (mark[fi] === stamp && fi < ei)) continue; if (crossIx(ei, fi)) c += W_CROSS; } });
        } else for (let fi = 0; fi < edges.length; fi++) {
          if (fi === ei || (mark[fi] === stamp && fi < ei)) continue;
          if (crossIx(ei, fi)) c += W_CROSS;
        }
        c += W_PASS * passCost(ei);
      }
      // edges that may run over the moved units
      // (the same edges before and after a move: those over the cells the move empties or fills)
      for (const [x, y] of cells) {
        const b = bucketsOn ? bk.get(bkey(x, y)) : null;
        const list = b || (bucketsOn ? [] : edges.map((_, i) => i));
        for (const ei of list) if (mark[ei] !== stamp) { mark[ei] = stamp; c += W_PASS * passCost(ei); }
      }
      ustamp++;
      for (const u of S) { if (umark[u] !== ustamp) { umark[u] = ustamp; c += W_CONF * conf(u); } for (const v of nb[u]) if (umark[v] !== ustamp) { umark[v] = ustamp; c += W_CONF * conf(v); } }
      for (const u of S) for (const pi of pin[u]) if (pmark[pi] !== ustamp) { pmark[pi] = ustamp; c += isaCost(prefs[pi]); }
      return c;
    }
    // edges by the cells their bounding boxes cover: only edges sharing a cell can cross
    const bk = new Map(), cmark = new Int32Array(edges.length);
    let cstamp = 0, bucketsOn = false;
    // buckets of 3 by 3 cells
    const bkey = (x, y) => key(Math.floor(x / 3), Math.floor(y / 3));
    const cellsOf = (i, fn) => { const x0 = Math.floor(Math.min(X[EA[i]], X[EB[i]]) / 3), x1 = Math.floor(Math.max(X[EA[i]], X[EB[i]]) / 3), y0 = Math.floor(Math.min(Y[EA[i]], Y[EB[i]]) / 3), y1 = Math.floor(Math.max(Y[EA[i]], Y[EB[i]]) / 3); for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) fn(key(x, y)); };
    const bin = (i) => cellsOf(i, (k) => { let b = bk.get(k); if (!b) bk.set(k, (b = [])); b.push(i); });
    const bout = (i) => cellsOf(i, (k) => { const b = bk.get(k); const j = b.indexOf(i); if (j >= 0) b.splice(j, 1); });
    const bucketAll = () => { bk.clear(); for (let i = 0; i < edges.length; i++) bin(i); bucketsOn = true; };
    const put = (u, x, y) => { if (bucketsOn) for (const ei of inc[u]) bout(ei); if (occ.get(key(X[u], Y[u])) === u) occ.delete(key(X[u], Y[u])); X[u] = x; Y[u] = y; occ.set(key(x, y), u); if (bucketsOn) for (const ei of inc[u]) bin(ei); };
    const swap = (u, v) => {
      const ux = X[u], uy = Y[u], vx = X[v], vy = Y[v];
      if (bucketsOn) { for (const ei of inc[u]) bout(ei); for (const ei of inc[v]) if (EA[ei] !== u && EB[ei] !== u) bout(ei); }
      X[u] = vx; Y[u] = vy; X[v] = ux; Y[v] = uy; occ.set(key(vx, vy), u); occ.set(key(ux, uy), v);
      if (bucketsOn) { for (const ei of inc[u]) bin(ei); for (const ei of inc[v]) if (EA[ei] !== u && EB[ei] !== u) bin(ei); }
    };

    // a first placement: breadth first from the busiest unit, each next to its placed neighbours
    const order = [], seen = new Array(n).fill(false);
    const byDeg = units.map((_, i) => i).sort((a, b) => nb[b].length - nb[a].length || a - b);
    for (const s of byDeg) {
      if (seen[s]) continue;
      const qu = [s]; seen[s] = true;
      while (qu.length) { const v = qu.shift(); order.push(v); for (const w of nb[v].slice().sort((a, b) => nb[b].length - nb[a].length || a - b)) if (!seen[w]) { seen[w] = true; qu.push(w); } }
    }
    const placed = new Array(n).fill(false);
    const D4 = [[1, 0], [-1, 0], [0, 1], [0, -1]], D8 = D4.concat([[1, 1], [-1, 1], [1, -1], [-1, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]);
    for (const u of order) {
      const P = nb[u].filter((v) => placed[v]);
      let best = null, bestC = Infinity;
      const cands = [];
      if (!P.length) {
        let mx = -Infinity, my = 0;
        for (let i = 0; i < n; i++) if (placed[i]) { if (X[i] > mx) { mx = X[i]; } }
        cands.push(mx === -Infinity ? [0, 0] : [mx + 2, my]);
      } else for (const v of P) for (const [dx, dy] of D8) cands.push([X[v] + dx, Y[v] + dy]);
      for (const [x, y] of cands) {
        if (occ.has(key(x, y))) continue;
        X[u] = x; Y[u] = y; occ.set(key(x, y), u); placed[u] = true;
        // only edges to placed units count
        let c = 0;
        for (const ei of inc[u]) { const e = edges[ei], v = e.a === u ? e.b : e.a; if (!placed[v]) continue; c += W_LEN * eLen(e); for (let fi = 0; fi < edges.length; fi++) { const f = edges[fi]; if (fi !== ei && placed[f.a] && placed[f.b] && crossIx(ei, fi)) c += W_CROSS; } c += W_PASS * passCost(ei); }
        for (let ei = 0; ei < edges.length; ei++) { const e = edges[ei]; if (placed[e.a] && placed[e.b] && e.a !== u && e.b !== u) c += W_PASS * passCost(ei); }
        for (const pi of pin[u]) { const p = prefs[pi]; if (placed[p.above] && placed[p.below]) c += isaCost(p); }
        c += 0.05 * (Math.abs(x) + Math.abs(y));
        occ.delete(key(x, y)); placed[u] = false;
        if (c < bestC - 1e-9) { bestC = c; best = [x, y]; }
      }
      if (!best) best = [0, 0];
      X[u] = best[0]; Y[u] = best[1]; occ.set(key(best[0], best[1]), u); placed[u] = true;
    }
    // odd seeds start instead from a spring embedding snapped to the grid: springs pull a planar design apart
    // without crossings more often than the greedy start does
    if (seed % 2 === 1 && n > 3) {
      const r0 = rng(seed * 7 + n);
      const px = order.map(() => 0), py = order.map(() => 0);
      order.forEach((u, k) => { const a = 2 * Math.PI * k / n + r0() * 0.3; px[u] = Math.cos(a) * Math.sqrt(n); py[u] = Math.sin(a) * Math.sqrt(n); });
      let temp = Math.sqrt(n);
      for (let it = 0; it < 300; it++) {
        const fx = new Float64Array(n), fy = new Float64Array(n);
        for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
          let dx = px[i] - px[j], dy = py[i] - py[j]; let d2 = dx * dx + dy * dy;
          if (d2 < 1e-6) { dx = 0.01 * (i - j); dy = 0.01; d2 = dx * dx + dy * dy; }
          const f = 1 / d2; fx[i] += dx * f; fy[i] += dy * f; fx[j] -= dx * f; fy[j] -= dy * f;
        }
        for (const e of edges) { const dx = px[e.a] - px[e.b], dy = py[e.a] - py[e.b], d = Math.hypot(dx, dy) || 1e-3, f = d; fx[e.a] -= dx * f; fy[e.a] -= dy * f; fx[e.b] += dx * f; fy[e.b] += dy * f; }
        for (const p of prefs) { if (py[p.below] < py[p.above] + 1) { fy[p.below] += 0.5; fy[p.above] -= 0.5; } }
        for (let i = 0; i < n; i++) { const L = Math.hypot(fx[i], fy[i]) || 1, st = Math.min(L, temp); px[i] += fx[i] / L * st; py[i] += fy[i] / L * st; }
        temp = Math.max(0.02, temp * 0.97);
      }
      // scale to about one cell per edge, then snap, busiest units first
      const el = edges.reduce((t, e) => t + Math.hypot(px[e.a] - px[e.b], py[e.a] - py[e.b]), 0) / Math.max(1, edges.length);
      const sc = 1.15 / (el || 1);
      occ.clear();
      for (const u of byDeg) {
        const tx = px[u] * sc, ty = py[u] * sc;
        let best = null, bd = Infinity;
        for (let r = 0; r < 12 && !best; r++) for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
          const x = Math.round(tx) + dx, y = Math.round(ty) + dy;
          if (occ.has(key(x, y))) continue;
          const d = (x - tx) ** 2 + (y - ty) ** 2;
          if (d < bd) { bd = d; best = [x, y]; }
        }
        X[u] = best[0]; Y[u] = best[1]; occ.set(key(best[0], best[1]), u);
      }
    }

    // annealing: move a unit next to a neighbour, or swap it with the unit there
    bucketAll();
    const rand = rng(0x5eed + n * 7919 + edges.length + (seed || 0) * 104729);
    let cur = 0;
    const bestX = X.slice(), bestY = Y.slice(), bestV = new Uint8Array(edges.length);
    /** turn edge ei the other way: the change of cost */
    const edgeTerms = (ei) => { let c = W_PASS * passCost(ei); cstamp++; cellsOf(ei, (k) => { const b = bk.get(k); if (b) for (const fi of b) { if (cmark[fi] === cstamp || fi === ei) continue; cmark[fi] = cstamp; if (crossIx(ei, fi)) c += W_CROSS; } }); return c; };
    const flip = (ei) => { const b = edgeTerms(ei); VB[ei] ^= 1; return edgeTerms(ei) - b; };
    let bestDelta = 0;
    const M = Math.min(72000, 6000 + 840 * n);
    const T0 = 15, T1 = 0.03;
    const hot = [];
    for (let it = 0; it < M; it++) {
      const T = T0 * Math.pow(T1 / T0, it / M);
      // now and then: the units on edges that cross or run over others; moves favour them
      if (it % 300 === 0) {
        hot.length = 0;
        const h = new Set();
        for (let ei = 0; ei < edges.length; ei++) {
          let bad = passCost(ei) > 0;
          if (!bad) { cstamp++; cellsOf(ei, (k) => { const b = bk.get(k); if (b && !bad) for (const fi of b) { if (cmark[fi] === cstamp || fi === ei) continue; cmark[fi] = cstamp; if (crossIx(ei, fi)) { bad = true; break; } } }); }
          if (bad) { h.add(EA[ei]); h.add(EB[ei]); for (const v of nb[EA[ei]]) h.add(v); for (const v of nb[EB[ei]]) h.add(v); }
        }
        hot.push(...h);
      }
      const u = hot.length && rand() < 0.5 ? hot[Math.floor(rand() * hot.length)] : Math.floor(rand() * n);
      // sometimes turn a bent edge the other way round its corner
      if (inc[u].length && rand() < 0.12) {
        const ei = inc[u][Math.floor(rand() * inc[u].length)];
        if (nVar(ei) > 1) {
          const d = flip(ei);
          if (d <= 1e-9 || rand() < Math.exp(-d / T)) { cur += d; if (cur < bestDelta - 1e-9) { bestDelta = cur; for (let i = 0; i < n; i++) { bestX[i] = X[i]; bestY[i] = Y[i]; } bestV.set(VB); } }
          else VB[ei] ^= 1;
        }
        continue;
      }
      let tx, ty;
      if (nb[u].length && rand() < 0.75) {
        const v = nb[u][Math.floor(rand() * nb[u].length)];
        const d = rand() < 0.8 ? D4[Math.floor(rand() * 4)] : D8[4 + Math.floor(rand() * 8)];
        tx = X[v] + d[0]; ty = Y[v] + d[1];
      } else { tx = X[u] + Math.floor(rand() * 5) - 2; ty = Y[u] + Math.floor(rand() * 5) - 2; }
      if (tx === X[u] && ty === Y[u]) continue;
      const v = occ.get(key(tx, ty));
      const S = v === undefined ? [u] : [u, v];
      const ox = X[u], oy = Y[u];
      const cells = [[ox, oy], [tx, ty]];
      const before = partial(S, cells) + area();
      if (v === undefined) put(u, tx, ty);
      else swap(u, v);
      const d = partial(S, cells) + area() - before;
      if (d <= 1e-9 || rand() < Math.exp(-d / T)) {
        cur += d;
        if (cur < bestDelta - 1e-9) { bestDelta = cur; for (let i = 0; i < n; i++) { bestX[i] = X[i]; bestY[i] = Y[i]; } bestV.set(VB); }
      } else if (v === undefined) put(u, ox, oy);
      else swap(u, v);
    }
    // polish: from the best state, move each unit to the best cell around its neighbours (or swap) while that helps
    occ.clear();
    for (let i = 0; i < n; i++) { X[i] = bestX[i]; Y[i] = bestY[i]; occ.set(key(X[i], Y[i]), i); }
    VB.set(bestV);
    bucketAll();
    for (let sweep = 0; sweep < 6; sweep++) {
      let moved = false;
      for (let u = 0; u < n; u++) {
        const cand = new Set();
        for (const v of nb[u].concat([u])) for (const [dx, dy] of D8) cand.add(key(X[v] + dx, Y[v] + dy));
        let best = null, bestD = -1e-6;
        const ox = X[u], oy = Y[u];
        for (const k of cand) {
          const tx = Math.floor(k / 8192) - 4096, ty = (k % 8192) - 4096;
          if (tx === ox && ty === oy) continue;
          const v = occ.get(k);
          const S = v === undefined ? [u] : [u, v];
          const cells = [[ox, oy], [tx, ty]];
          const before = partial(S, cells) + area();
          if (v === undefined) put(u, tx, ty); else swap(u, v);
          const d = partial(S, cells) + area() - before;
          if (v === undefined) put(u, ox, oy); else swap(u, v);
          if (d < bestD) { bestD = d; best = [tx, ty, v]; }
        }
        if (best) {
          const [tx, ty, v] = best;
          if (v === undefined) put(u, tx, ty); else swap(u, v);
          moved = true;
        }
      }
      if (!moved) break;
    }
    for (let i = 0; i < n; i++) { bestX[i] = X[i]; bestY[i] = Y[i]; }
    // the polish may also turn edges
    for (let ei = 0; ei < edges.length; ei++) if (nVar(ei) > 1 && flip(ei) >= -1e-9) VB[ei] ^= 1;
    const cells = units.map((_, i) => ({ x: bestX[i], y: bestY[i] }));
    // for each bent edge: does it leave its first unit along the row ('h') or along the column ('v')?
    cells.bends = edges.map((e, i) => (nVar(i) > 1 ? (VB[i] ? 'v' : 'h') : null));
    return cells;
  }

  /** place units on the grid and give them pixel centres; o: { aspect, gapX, gapY, resize(unit, blockedSides) } */
  function gridLayout(units, edges, prefs, o) {
    if (!units.length) return { chX: [], chY: [] };
    const cells = gridPlace(units, edges, prefs, o.aspect, o.seed);
    // the sides each unit's edges leave from, so that its satellites keep out of their way
    if (o.resize) units.forEach((u, i) => {
      const bl = {};
      for (const e of edges) {
        if (e.a !== i && e.b !== i) continue;
        const j = e.a === i ? e.b : e.a, dx = cells[j].x - cells[i].x, dy = cells[j].y - cells[i].y;
        if (Math.abs(dx) >= Math.abs(dy)) bl[dx > 0 ? 'right' : 'left'] = true;
        if (Math.abs(dy) >= Math.abs(dx)) bl[dy > 0 ? 'bottom' : 'top'] = true;
        if (dx && dy) bl[(dy > 0 ? 'b' : 't') + (dx > 0 ? 'r' : 'l')] = true;
        // parallel edges go round: the sides across from them are used too
        if (e.k > 1) { if (Math.abs(dx) >= Math.abs(dy)) bl.top = bl.bottom = true; else bl.left = bl.right = true; }
      }
      o.resize(u, bl);
    });
    const xs = [...new Set(cells.map((c) => c.x))].sort((a, b) => a - b), ys = [...new Set(cells.map((c) => c.y))].sort((a, b) => a - b);
    const col = cells.map((c) => xs.indexOf(c.x)), row = cells.map((c) => ys.indexOf(c.y));
    const L = xs.map(() => 0), R = xs.map(() => 0), T = ys.map(() => 0), B = ys.map(() => 0);
    units.forEach((u, i) => { L[col[i]] = Math.max(L[col[i]], -u.bx); R[col[i]] = Math.max(R[col[i]], u.bx + u.w); T[row[i]] = Math.max(T[row[i]], -u.by); B[row[i]] = Math.max(B[row[i]], u.by + u.h); });
    const cx = [], cy = [], chX = [], chY = [];
    let x = 0;
    xs.forEach((_, c) => { cx[c] = x + L[c]; x = cx[c] + R[c] + o.gapX; if (c < xs.length - 1) chX.push(cx[c] + R[c] + o.gapX / 2); });
    let y = 0;
    ys.forEach((_, r) => { cy[r] = y + T[r]; y = cy[r] + B[r] + o.gapY; if (r < ys.length - 1) chY.push(cy[r] + B[r] + o.gapY / 2); });
    units.forEach((u, i) => { u.cx = cx[col[i]]; u.cy = cy[row[i]]; u.col = col[i]; u.row = row[i]; });
    return { chX, chY, bends: cells.bends };
  }

  // ---- the force-directed placement for saved positions: new clusters go next to the ones they are linked to
  function place(clusters, links, gap) {
    const n = clusters.length;
    if (!n) return;
    const pins = clusters.filter((c) => c.pin);
    for (const c of pins) { c.cx = c.pin.x; c.cy = c.pin.y; }
    if (pins.length === n) return;
    const adj = clusters.map(() => []);
    for (const [a, b] of links) if (a !== b) { adj[a].push(b); adj[b].push(a); }
    const order = [], seen = new Set();
    const starts = clusters.map((c, i) => i).sort((a, b) => adj[b].length - adj[a].length);
    for (const s of starts) {
      if (seen.has(s)) continue;
      const qu = [s]; seen.add(s);
      while (qu.length) { const v = qu.shift(); order.push(v); for (const w of adj[v].slice().sort((a, b) => adj[b].length - adj[a].length)) if (!seen.has(w)) { seen.add(w); qu.push(w); } }
    }
    const size = clusters.reduce((s, c) => s + Math.max(c.w, c.h), 0) / n;
    const k = size * 0.55 + gap * 1.2;
    const done = new Set(clusters.map((c, i) => (c.pin ? i : -1)).filter((i) => i >= 0));
    const rs = pins.map(rect);
    const x1 = rs.length ? Math.max(...rs.map((r) => r.x + r.w)) : 0, y0 = rs.length ? Math.min(...rs.map((r) => r.y)) : 0;
    let side = 0;
    order.forEach((v, i) => {
      const c = clusters[v];
      if (c.pin) return;
      const nb = adj[v].filter((w) => done.has(w));
      if (nb.length) {
        const mx = nb.reduce((t, w) => t + clusters[w].cx, 0) / nb.length, my = nb.reduce((t, w) => t + clusters[w].cy, 0) / nb.length;
        const a = i * 2.4;
        c.cx = mx + Math.cos(a) * k; c.cy = my + Math.sin(a) * k * 0.8;
      } else { c.cx = x1 + gap - c.bx; c.cy = y0 - c.by + side; side += c.h + gap; }
      done.add(v);
    });
    separate(clusters, gap);
  }
  const rect = (c) => ({ x: c.cx + c.bx, y: c.cy + c.by, w: c.w, h: c.h });
  function separate(clusters, gap) {
    // push free clusters off the others; pinned ones stay where the user put them
    for (let round = 0; round < 2000; round++) {
      let moved = false;
      for (let i = 0; i < clusters.length; i++) for (let j = i + 1; j < clusters.length; j++) {
        const a = rect(clusters[i]), b = rect(clusters[j]);
        if (!overlap(a, b, gap)) continue;
        const ca = clusters[i], cb = clusters[j];
        if (ca.pin && cb.pin) continue;
        moved = true;
        const fa = ca.pin ? 0 : cb.pin ? 2 : 1, fb = cb.pin ? 0 : ca.pin ? 2 : 1;
        const ox = Math.min(a.x + a.w + gap - b.x, b.x + b.w + gap - a.x), oy = Math.min(a.y + a.h + gap - b.y, b.y + b.h + gap - a.y);
        if (ox < oy) { const s = (a.x + a.w / 2 <= b.x + b.w / 2 ? -1 : 1) * (ox / 2 + 0.5); ca.cx += s * fa; cb.cx -= s * fb; }
        else { const s = (a.y + a.h / 2 <= b.y + b.h / 2 ? -1 : 1) * (oy / 2 + 0.5); ca.cy += s * fa; cb.cy -= s * fb; }
      }
      if (!moved) return true;
    }
    return false;
  }

  // ---- routing ---------------------------------------------------------------------------------------------------
  const SIDES = { right: [1, 0], left: [-1, 0], bottom: [0, 1], top: [0, -1] };
  const OPP = { right: 'left', left: 'right', top: 'bottom', bottom: 'top' };
  const horiz = (s) => s === 'left' || s === 'right';
  /** the router: obstacles are the boxes edges keep out of, groups the aggregation frames they may not cross */
  function makeRouter(obstacles, frames, channels, endLen) {
    // endLen: the straight run each end needs for its marker (crow's foot, arrowhead); other edges keep off it
    const zones = [];
    const segs = [];      // drawn segments: { p, q }
    const used = new Map(); // node id + side -> coordinates of the ports on it
    const SEP = 22;
    const usedOn = (T, side) => (used.get(T.id + '|' + side) || []).map((u) => u.c);
    let owner = null; // whose segments and ports are being added
    const fixed = (T) => T.shape !== 'rect';
    // a side that takes one edge only: a corner of a diamond, the apex or a slanted side of a triangle
    const single = (T, side) => T.shape === 'diamond' || (T.shape === 'tri' && !(T.apex && side === OPP[T.apex]));
    /** the range of positions for ports on a side of a terminal */
    function range(T, side) {
      const c = centre(T);
      if (T.shape === 'diamond' || T.shape === 'point') return horiz(side) ? [c.y, c.y] : [c.x, c.x];
      if (T.shape === 'tri') {
        if (!T.apex || side === T.apex) return horiz(side) ? [c.y, c.y] : [c.x, c.x];
        if (side === OPP[T.apex]) return horiz(side) ? [c.y - T.h / 2 + 9, c.y + T.h / 2 - 9] : [c.x - T.w / 2 + 9, c.x + T.w / 2 - 9];
        return horiz(side) ? [c.y, c.y] : [c.x, c.x];
      }
      const m = 11;
      let lo = horiz(side) ? T.y + Math.min(m, T.h / 2) : T.x + Math.min(m, T.w / 2), hi = horiz(side) ? T.y + T.h - Math.min(m, T.h / 2) : T.x + T.w - Math.min(m, T.w / 2);
      // an aggregation frame keeps its name clear
      if (T.labelW && side === 'top') lo = Math.min(hi, T.x + T.labelW + 18);
      // a box with a header: side ports keep off the line under the title
      if (T.header && horiz(side) && T.h > T.header + 24) lo = Math.max(lo, T.y + T.header + 10);
      return [lo, hi];
    }
    /** the point of a port: on the side of the terminal at the coordinate c along it */
    function port(T, side, c) {
      const ce = centre(T);
      if (T.shape === 'diamond') return pt(ce.x + SIDES[side][0] * T.w / 2, ce.y + SIDES[side][1] * T.h / 2);
      if (T.shape === 'point') return pt(ce.x, ce.y);
      if (T.shape === 'tri' && T.apex && side !== T.apex && side !== OPP[T.apex]) {
        // the middle of a slanted side
        const s = SIDES[side];
        return pt(ce.x + s[0] * T.w / 4, ce.y + s[1] * T.h / 4);
      }
      if (horiz(side)) return pt(side === 'right' ? T.x + T.w : T.x, c);
      return pt(c, side === 'bottom' ? T.y + T.h : T.y);
    }
    /** port positions on a side near pref that keep apart from the ports already there */
    function slots(T, side, pref, count) {
      const [lo, hi] = range(T, side);
      if (hi - lo < 1) return [lo];
      const taken = usedOn(T, side);
      const out = [];
      const p0 = Math.max(lo, Math.min(hi, pref));
      for (let k = 0; out.length < (count || 3) && k < 40; k++) {
        const c = p0 + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 13;
        if (c < lo - 0.01 || c > hi + 0.01) continue;
        if (taken.every((t) => Math.abs(t - c) >= SEP)) out.push(c);
      }
      if (!out.length) out.push(p0);
      return out;
    }
    function inside(T, F) { return T.id === F.id || (T.x >= F.x - 1 && T.y >= F.y - 1 && T.x + T.w <= F.x + F.w + 1 && T.y + T.h <= F.y + F.h + 1); }
    /** problems with a candidate path: segments through shapes, across frames, across or along drawn segments */
    function check(pts, S, D) {
      const ss = segsOf(pts);
      let bad = 0, close = 0;
      ss.forEach(([p, q], k) => {
        // only what lies near the segment's box can meet it
        const x0 = Math.min(p.x, q.x) - 12, x1 = Math.max(p.x, q.x) + 12, y0 = Math.min(p.y, q.y) - 12, y1 = Math.max(p.y, q.y) + 12;
        for (const o of obstacles) {
          if (o.x > x1 || o.x + o.w < x0 || o.y > y1 || o.y + o.h < y0) continue;
          if ((o.id === S.id && k === 0) || (o.id === D.id && k === ss.length - 1)) continue;
          if (o.id === S.id || o.id === D.id) { if (segBox(p, q, inflate(o, -1))) bad++; continue; }
          if (segBox(p, q, inflate(o, 4))) bad++;
          else if (segBox(p, q, inflate(o, 10))) close++;
        }
        for (const F of frames) {
          if (inside(S, F) !== inside(D, F)) continue;
          const b = inflate(F, 0);
          const inS = inside(S, F);
          const crossesBorder = [[{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }], [{ x: b.x + b.w, y: b.y }, { x: b.x + b.w, y: b.y + b.h }], [{ x: b.x, y: b.y + b.h }, { x: b.x + b.w, y: b.y + b.h }], [{ x: b.x, y: b.y }, { x: b.x, y: b.y + b.h }]].some(([a, c]) => segMeet(p, q, a, c, 4));
          if (crossesBorder || (!inS && segBox(p, q, b))) bad++;
        }
        for (const s of segs) { if ((s.p.x < x0 && s.q.x < x0) || (s.p.x > x1 && s.q.x > x1) || (s.p.y < y0 && s.q.y < y0) || (s.p.y > y1 && s.q.y > y1)) continue; const r = segMeet(p, q, s.p, s.q); if (r) bad += r === 2 ? 1 : 1.5; }
      });
      // room at both ends for the markers, and no running over the markers of others
      if (endLen && ss.length) {
        const l0 = Math.hypot(ss[0][1].x - ss[0][0].x, ss[0][1].y - ss[0][0].y), l1 = Math.hypot(ss[ss.length - 1][1].x - ss[ss.length - 1][0].x, ss[ss.length - 1][1].y - ss[ss.length - 1][0].y);
        if (S.shape !== 'point' && l0 < endLen) bad++;
        if (D.shape !== 'point' && l1 < endLen) bad++;
        for (const z of zones) for (const [p, q] of ss) if (segBox(p, q, z)) bad++;
      }
      // the path must not double back on itself
      for (let i = 0; i < ss.length; i++) for (let j = i + 2; j < ss.length; j++) if (segMeet(ss[i][0], ss[i][1], ss[j][0], ss[j][1])) bad++;
      return { bad, close };
    }
    function candidates(S, D, multi) {
      const out = [];
      const cS = centre(S), cD = centre(D);
      const add = (type, pts, sides, coords) => out.push({ type, pts: tidy(pts), sides, coords });
      const facing = (side) => {
        // D lies beyond S's side
        if (side === 'right') return D.x >= S.x + S.w + 10; if (side === 'left') return D.x + D.w <= S.x - 10;
        if (side === 'bottom') return D.y >= S.y + S.h + 10; return D.y + D.h <= S.y - 10;
      };
      // straight: a shared coordinate on facing sides
      for (const side of ['right', 'left', 'bottom', 'top']) {
        if (!facing(side)) continue;
        const ds = OPP[side];
        const [a0, a1] = range(S, side), [b0, b1] = range(D, ds);
        const lo = Math.max(a0, b0), hi = Math.min(a1, b1);
        if (hi < lo - 0.01) continue;
        const pref = horiz(side) ? (fixed(S) ? cS.y : fixed(D) ? cD.y : (Math.max(lo, Math.min(hi, (cS.y + cD.y) / 2)))) : (fixed(S) ? cS.x : fixed(D) ? cD.x : Math.max(lo, Math.min(hi, (cS.x + cD.x) / 2)));
        const sa = slots(S, side, pref, 6), sb = slots(D, ds, pref, 6);
        const common = sa.filter((c) => c >= lo - 0.01 && c <= hi + 0.01 && sb.some((d) => Math.abs(d - c) < 0.01));
        for (const c of common.slice(0, 3)) add('I', [port(S, side, c), port(D, ds, c)], [side, ds], [c, c]);
      }
      // one bend: out of S one way, into D the other
      for (const sh of [true, false]) {
        const sSide = sh ? (cD.x > cS.x ? 'right' : 'left') : (cD.y > cS.y ? 'bottom' : 'top');
        const dSide = sh ? (cS.y > cD.y ? 'bottom' : 'top') : (cS.x > cD.x ? 'right' : 'left');
        for (const a of slots(S, sSide, sh ? cS.y : cS.x, 2)) for (const b of slots(D, dSide, sh ? cD.x : cD.y, 2)) {
          const p = port(S, sSide, a), q = port(D, dSide, b);
          const corner = sh ? { x: q.x, y: p.y } : { x: p.x, y: q.y };
          // the bend must lie beyond both sides
          const v1 = SIDES[sSide], v2 = SIDES[dSide];
          if ((corner.x - p.x) * v1[0] + (corner.y - p.y) * v1[1] < 12) continue;
          if ((corner.x - q.x) * v2[0] + (corner.y - q.y) * v2[1] < 12) continue;
          add('L', [p, corner, q], [sSide, dSide], [a, b]);
        }
      }
      // two bends: out and in on facing sides, the middle in a channel between them
      for (const side of ['right', 'left', 'bottom', 'top']) {
        if (!facing(side)) continue;
        const ds = OPP[side], h = horiz(side);
        const s0 = h ? S.x + (side === 'right' ? S.w : 0) : S.y + (side === 'bottom' ? S.h : 0);
        const d0 = h ? D.x + (ds === 'right' ? D.w : 0) : D.y + (ds === 'bottom' ? D.h : 0);
        const lo = Math.min(s0, d0) + 12, hi = Math.max(s0, d0) - 12;
        if (hi < lo) continue;
        const mids = new Set([(s0 + d0) / 2]);
        for (const c of (h ? channels.x : channels.y)) if (c > lo && c < hi) mids.add(c);
        const ms = [...mids].flatMap((c) => [c, c + 9, c - 9, c + 18, c - 18]).filter((c) => c >= lo && c <= hi);
        for (const a of slots(S, side, h ? cS.y : cS.x, 2)) for (const b of slots(D, ds, h ? cD.y : cD.x, 2)) {
          const p = port(S, side, a), q = port(D, ds, b);
          for (const mcoord of ms.slice(0, 10)) add('Z', h ? [p, { x: mcoord, y: p.y }, { x: mcoord, y: q.y }, q] : [p, { x: p.x, y: mcoord }, { x: q.x, y: mcoord }, q], [side, ds], [a, b]);
        }
      }
      // round the outside: both ends leave on the same side
      for (const side of ['top', 'bottom', 'right', 'left']) {
        const h = horiz(side), v = SIDES[side];
        const edgeS = h ? (side === 'right' ? S.x + S.w : S.x) : (side === 'bottom' ? S.y + S.h : S.y);
        const edgeD = h ? (side === 'right' ? D.x + D.w : D.x) : (side === 'bottom' ? D.y + D.h : D.y);
        const far = (v[0] + v[1]) > 0 ? Math.max(edgeS, edgeD) : Math.min(edgeS, edgeD);
        for (const a of slots(S, side, h ? cS.y : cS.x, 2)) for (const b of slots(D, side, h ? cD.y : cD.x, 2)) {
          const p = port(S, side, a), q = port(D, side, b);
          if (near(p, q, 1)) continue;
          for (const d of [24, 36, 50, 66]) {
            const c = far + (v[0] + v[1]) * d;
            add('U', h ? [p, { x: c, y: p.y }, { x: c, y: q.y }, q] : [p, { x: p.x, y: c }, { x: q.x, y: c }, q], [side, side], [a, b]);
          }
        }
      }
      // a straight diagonal between the outlines
      if (!multi) { const p = clip(S, cD), q = clip(D, cS); add('D', [p, q], [null, null], [null, null]); }
      return out;
    }
    /** an orthogonal path found by A* on the lines through the edges of the shapes nearby: a crossing costs much
     *  more than a bend, a bend more than length; the path starts and ends on free ports of the two terminals */
    function search(S, D, margin) {
      const cS = centre(S), cD = centre(D), mg = margin || 320;
      const win = { x: Math.min(S.x, D.x) - mg, y: Math.min(S.y, D.y) - mg, w: Math.abs(cS.x - cD.x) + (S.w + D.w) / 2 + 2 * mg, h: Math.abs(cS.y - cD.y) + (S.h + D.h) / 2 + 2 * mg };
      const obs = obstacles.filter((o) => overlap(o, win, 0));
      const SEGS = segs.filter((s) => segBox(s.p, s.q, win) || overlap({ x: Math.min(s.p.x, s.q.x), y: Math.min(s.p.y, s.q.y), w: Math.abs(s.p.x - s.q.x), h: Math.abs(s.p.y - s.q.y) }, win, 0));
      const X = new Set(), Y = new Set();
      for (const o of obs) { X.add(r1(o.x - 12)); X.add(r1(o.x + o.w + 12)); X.add(r1(o.x + o.w / 2)); Y.add(r1(o.y - 12)); Y.add(r1(o.y + o.h + 12)); Y.add(r1(o.y + o.h / 2)); }
      for (const c of channels.x) if (c > win.x && c < win.x + win.w) for (const d of [0, 8, -8]) X.add(r1(c + d));
      for (const c of channels.y) if (c > win.y && c < win.y + win.h) for (const d of [0, 8, -8]) Y.add(r1(c + d));
      X.add(r1(win.x)); X.add(r1(win.x + win.w)); Y.add(r1(win.y)); Y.add(r1(win.y + win.h));
      // the ports: up to two free slots on each side of each terminal, and the point just outside
      const ends = (T, other) => {
        const out = [];
        for (const side of ['top', 'bottom', 'left', 'right']) {
          if (T.shape === 'tri' && T.apex && side === T.apex && !other) continue;
          const v = SIDES[side], co = centre(other);
          for (const c of slots(T, side, horiz(side) ? co.y : co.x, 2)) {
            const p = port(T, side, c);
            if (single(T, side) && usedOn(T, side).length) continue;
            if (T.shape !== 'rect' && T.shape !== 'diamond' && T.shape !== 'tri' && T.shape !== 'point') continue;
            const q = T.shape === 'point' ? p : pt(p.x + v[0] * 14, p.y + v[1] * 14);
            out.push({ side, c, p, q });
            X.add(q.x); Y.add(q.y);
          }
        }
        return out;
      };
      const starts = ends(S, D), goals = ends(D, S);
      const xs = [...X].sort((a, b) => a - b), ys = [...Y].sort((a, b) => a - b);
      const nx = xs.length, ny = ys.length;
      if (nx * ny > 250000) return null;
      const ix = new Map(xs.map((v, i) => [v, i])), iy = new Map(ys.map((v, i) => [v, i]));
      const blocked = new Uint8Array(nx * ny);
      for (const o of obs) {
        const b = inflate(o, 5);
        for (let i = 0; i < nx; i++) { if (xs[i] <= b.x || xs[i] >= b.x + b.w) continue; for (let j = 0; j < ny; j++) if (ys[j] > b.y && ys[j] < b.y + b.h) blocked[i * ny + j] = 1; }
      }
      const goalAt = new Map();
      for (const g of goals) { const k = ix.get(g.q.x) * ny + iy.get(g.q.y); blocked[k] = 0; goalAt.set(k, g); }
      // the cost of a step: length, plus crossings with drawn lines and running along them
      const SB = SEGS.map((s) => ({ s, x0: Math.min(s.p.x, s.q.x) - 8, x1: Math.max(s.p.x, s.q.x) + 8, y0: Math.min(s.p.y, s.q.y) - 8, y1: Math.max(s.p.y, s.q.y) + 8 }));
      const OB = obs.map((o) => inflate(o, 4));
      // both in buckets of 80px, so that a step looks only at what is near it
      const BS = 80;
      const index = (list, box) => { const m = new Map(); for (const it of list) { const b = box(it); for (let x = Math.floor(b.x0 / BS); x <= Math.floor(b.x1 / BS); x++) for (let y = Math.floor(b.y0 / BS); y <= Math.floor(b.y1 / BS); y++) { const k = x * 100003 + y; if (!m.has(k)) m.set(k, []); m.get(k).push(it); } } return m; };
      const SBI = index(SB, (b) => b), OBI = index(OB, (o) => ({ x0: o.x, x1: o.x + o.w, y0: o.y, y1: o.y + o.h }));
      let seen = 0; const seenAt = new Map();
      const near = (I, p, q, fn) => { seen++; for (let x = Math.floor(Math.min(p.x, q.x) / BS); x <= Math.floor(Math.max(p.x, q.x) / BS); x++) for (let y = Math.floor(Math.min(p.y, q.y) / BS); y <= Math.floor(Math.max(p.y, q.y) / BS); y++) { const l = I.get(x * 100003 + y); if (l) for (const it of l) { if (seenAt.get(it) === seen) continue; seenAt.set(it, seen); if (fn(it)) return true; } } return false; };
      const stepCost = (p, q) => {
        let c = Math.hypot(q.x - p.x, q.y - p.y);
        const x0 = Math.min(p.x, q.x), x1 = Math.max(p.x, q.x), y0 = Math.min(p.y, q.y), y1 = Math.max(p.y, q.y);
        near(SBI, p, q, (b) => { if (b.x1 < x0 || b.x0 > x1 || b.y1 < y0 || b.y0 > y1) return false; const m = segMeet(p, q, b.s.p, b.s.q, 6); if (m === 2) c += 400; else if (m === 1) c += 600; return false; });
        for (const F of frames) { if (inside(S, F) !== inside(D, F)) continue; const b = F; if ([[{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }], [{ x: b.x + b.w, y: b.y }, { x: b.x + b.w, y: b.y + b.h }], [{ x: b.x, y: b.y + b.h }, { x: b.x + b.w, y: b.y + b.h }], [{ x: b.x, y: b.y }, { x: b.x, y: b.y + b.h }]].some(([a, d]) => segMeet(p, q, a, d, 3) === 2)) c += 400; }
        return c;
      };
      const BEND = 40;
      const H = (i, j) => { let m = Infinity; for (const g of goals) { const v = Math.abs(xs[i] - g.q.x) + Math.abs(ys[j] - g.q.y); if (v < m) m = v; } return m; };
      // states: node * 4 + direction
      const N = nx * ny * 4, dist = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1), done = new Uint8Array(N);
      const heap = [];
      const push = (s, f) => { heap.push([f, s]); let i = heap.length - 1; while (i) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
      const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
      const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      const startOf = new Map();
      for (const st of starts) {
        const i = ix.get(st.q.x), j = iy.get(st.q.y), d = DIRS.findIndex((v) => v[0] === SIDES[st.side][0] && v[1] === SIDES[st.side][1]);
        const s = (i * ny + j) * 4 + d;
        blocked[i * ny + j] = 0;
        const c0 = stepCost(st.p, st.q);
        if (c0 < dist[s]) { dist[s] = c0; startOf.set(s, st); push(s, c0 + H(i, j)); }
      }
      let found = -1, budget = 200000;
      while (heap.length && budget-- > 0) {
        const [, s] = pop();
        if (done[s]) continue;
        done[s] = 1;
        const node = s >> 2, d = s & 3, i = Math.floor(node / ny), j = node % ny;
        const g = goalAt.get(node);
        if (g) {
          // arrive against the goal's side
          const v = SIDES[g.side];
          if (DIRS[d][0] === -v[0] && DIRS[d][1] === -v[1]) { found = s; break; }
        }
        for (let nd = 0; nd < 4; nd++) {
          if (DIRS[nd][0] === -DIRS[d][0] && DIRS[nd][1] === -DIRS[d][1]) continue;
          const i2 = i + DIRS[nd][0], j2 = j + DIRS[nd][1];
          if (i2 < 0 || j2 < 0 || i2 >= nx || j2 >= ny || blocked[i2 * ny + j2]) continue;
          const p = { x: xs[i], y: ys[j] }, q = { x: xs[i2], y: ys[j2] };
          // a step must not pass through a shape between two free points
          if (near(OBI, p, q, (o) => o.x < Math.max(p.x, q.x) && o.x + o.w > Math.min(p.x, q.x) && o.y < Math.max(p.y, q.y) && o.y + o.h > Math.min(p.y, q.y) && segBox(p, q, o))) continue;
          const s2 = (i2 * ny + j2) * 4 + nd;
          const c = dist[s] + stepCost(p, q) + (nd !== d ? BEND : 0);
          if (c < dist[s2] - 1e-9) { dist[s2] = c; prev[s2] = s; push(s2, c + H(i2, j2)); }
        }
      }
      if (found < 0) return null;
      const path = [];
      let s = found, last = found;
      while (s >= 0) { const node = s >> 2; path.push({ x: xs[Math.floor(node / ny)], y: ys[node % ny] }); last = s; s = prev[s]; }
      path.reverse();
      const first = startOf.get(last);
      const g = goalAt.get(found >> 2);
      if (!first || !g) return null;
      return { type: 'A', pts: tidy([first.p].concat(path, [g.p])), sides: [first.side, g.side], coords: [first.c, g.c] };
    }
    const BASE = { I: 0, L: 1.1, Z: 1.8, U: 2.6, D: 9 };
    /** route from terminal S to terminal D; returns the points */
    function route(S, D, opt) {
      opt = opt || {};
      const cands = candidates(S, D, opt.multi).filter((c) => !opt.sideS || c.sides[0] === opt.sideS);
      let best = null, bestCost = Infinity;
      for (const c of cands) {
        if (c.pts.length < 2) continue;
        const r = check(c.pts, S, D);
        let cost = BASE[c.type] + pathLen(c.pts) / 140 + r.bad * 20 + r.close * 0.35;
        // a corner of a diamond, or the apex of a triangle, already in use
        for (const [T, side] of [[S, c.sides[0]], [D, c.sides[1]]]) if (side && single(T, side) && usedOn(T, side).length) cost += 2.5;
        if (opt.avoidSide && (c.sides[0] === opt.avoidSide)) cost += 30;
        if (opt.avoidSideD && (c.sides[1] === opt.avoidSideD)) cost += 30;
        // the placement planned this edge to turn one way round its corner: other edges count on it
        if (opt.bend && c.sides[0] && c.type !== 'I' && c.type !== 'D' && (horiz(c.sides[0]) ? 'h' : 'v') !== opt.bend) cost += 4;
        if (cost < bestCost - 1e-9) { bestCost = cost; best = c; }
      }
      // nothing simple is clean: search the free space for the path with the fewest crossings and bends
      for (const margin of [320, 1400]) {
        if (bestCost < 20) break;
        const a = search(S, D, margin);
        if (a) {
          const r = check(a.pts, S, D);
          const cost = 3.5 + pathLen(a.pts) / 140 + r.bad * 20 + r.close * 0.35 + (opt.avoidSide && a.sides[0] === opt.avoidSide ? 30 : 0) + (opt.avoidSideD && a.sides[1] === opt.avoidSideD ? 30 : 0);
          if (cost < bestCost) { bestCost = cost; best = a; }
        }
      }
      if (!best) best = { pts: [clip(S, centre(D)), clip(D, centre(S))], sides: [null, null], coords: [null, null] };
      commit(best, S, D);
      return { pts: best.pts, sides: best.sides, clean: bestCost < 20 };
    }
    function commit(c, S, D) {
      if (owner !== null) { if (!termsOf.has(owner)) termsOf.set(owner, []); termsOf.get(owner).push(S.id, D.id); }
      [[S, 0], [D, 1]].forEach(([T, i]) => {
        const side = c.sides[i];
        if (!side) return;
        const k = T.id + '|' + side;
        if (!used.has(k)) used.set(k, []);
        used.get(k).push({ c: c.coords[i] === null ? 0 : c.coords[i], o: owner });
      });
      for (const [p, q] of segsOf(c.pts)) segs.push({ p, q, o: owner });
      if (endLen) for (const [T, at] of [[S, 0], [D, 1]]) {
        if (T.shape === 'point' || c.pts.length < 2) continue;
        const a = at ? c.pts[c.pts.length - 1] : c.pts[0], b = at ? c.pts[c.pts.length - 2] : c.pts[1];
        const L = Math.hypot(b.x - a.x, b.y - a.y) || 1, e = { x: a.x + (b.x - a.x) * Math.min(1, endLen / L), y: a.y + (b.y - a.y) * Math.min(1, endLen / L) };
        zones.push({ x: Math.min(a.x, e.x) - 9, y: Math.min(a.y, e.y) - 9, w: Math.abs(a.x - e.x) + 18, h: Math.abs(a.y - e.y) + 18, o: owner });
      }
    }
    /** a loop from a node back to itself, on its first free side */
    function loop(T) {
      const c = centre(T);
      for (const side of ['right', 'left', 'top', 'bottom']) {
        const h = horiz(side), v = SIDES[side];
        const ys = h ? [c.y - 22, c.y + 22] : [c.x - 24, c.x + 24];
        if (usedOn(T, side).some((u) => Math.abs(u - ys[0]) < SEP || Math.abs(u - ys[1]) < SEP)) continue;
        const e = h ? (side === 'right' ? T.x + T.w : T.x) : (side === 'bottom' ? T.y + T.h : T.y), out = e + (v[0] + v[1]) * 56;
        const pts = h ? [pt(e, ys[0]), pt(out, ys[0]), pt(out, ys[1]), pt(e, ys[1])] : [pt(ys[0], e), pt(ys[0], out), pt(ys[1], out), pt(ys[1], e)];
        if (check(pts, T, T).bad) continue;
        commit({ pts, sides: [side, side], coords: ys }, T, T);
        return pts;
      }
      const pts = [pt(T.x + T.w, c.y - 22), pt(T.x + T.w + 56, c.y - 22), pt(T.x + T.w + 56, c.y + 22), pt(T.x + T.w, c.y + 22)];
      commit({ pts, sides: [null, null], coords: [null, null] }, T, T);
      return pts;
    }
    /** the owners whose segments meet (cross or run along) those of owner o, and how many such meetings there are */
    const termsOf = new Map();
    /** segments of owner o that run through shapes other than its own two ends */
    function hits(o) {
      const t = termsOf.get(o) || [];
      let n = 0;
      for (const sg of segs) if (sg.o === o) {
        for (const ob of obstacles) if (!t.includes(ob.id) && segBox(sg.p, sg.q, inflate(ob, 1))) n++;
        for (const z of zones) if (z.o !== o && segBox(sg.p, sg.q, z)) n++;
      }
      return n;
    }
    function conflicts(o) {
      const mine = segs.filter((x) => x.o === o), with_ = new Set();
      let n = 0;
      for (const a of mine) { const x0 = Math.min(a.p.x, a.q.x) - 8, x1 = Math.max(a.p.x, a.q.x) + 8, y0 = Math.min(a.p.y, a.q.y) - 8, y1 = Math.max(a.p.y, a.q.y) + 8; for (const b of segs) { if (b.o === o || (b.p.x < x0 && b.q.x < x0) || (b.p.x > x1 && b.q.x > x1) || (b.p.y < y0 && b.q.y < y0) || (b.p.y > y1 && b.q.y > y1)) continue; if (segMeet(a.p, a.q, b.p, b.q)) { n++; if (b.o !== null) with_.add(b.o); } } }
      return { n, with: [...with_] };
    }
    const snapshot = () => ({ segs: segs.slice(), zones: zones.slice(), used: new Map([...used].map(([k, v]) => [k, v.slice()])) });
    const restore = (sn) => { segs.length = 0; segs.push(...sn.segs); zones.length = 0; zones.push(...sn.zones); used.clear(); for (const [k, v] of sn.used) used.set(k, v.slice()); };
    const remove = (o) => { for (let i = segs.length - 1; i >= 0; i--) if (segs[i].o === o) segs.splice(i, 1); for (let i = zones.length - 1; i >= 0; i--) if (zones[i].o === o) zones.splice(i, 1); for (const [k, v] of used) used.set(k, v.filter((u) => u.o !== o)); };
    return { route, loop, segs, conflicts, hits, snapshot, restore, remove, owner: (o) => { owner = o; },
      add: (pts) => { for (const [p, q] of segsOf(pts)) segs.push({ p, q, o: null }); }, use: (T, side, c) => { const k = T.id + '|' + side; if (!used.has(k)) used.set(k, []); used.get(k).push({ c, o: null }); } };
  }

  // ---- labels ------------------------------------------------------------------------------------------------------
  /** the point at arc length s from the start (or the end) of a path, and the direction there */
  function walk(pts, s, fromEnd) {
    const P = fromEnd ? pts.slice().reverse() : pts;
    let left = s;
    for (let i = 1; i < P.length; i++) {
      const a = P[i - 1], b = P[i], L = Math.hypot(b.x - a.x, b.y - a.y);
      if (L < 0.01) continue;
      if (left <= L || i === P.length - 1) { const t = Math.min(1, left / L); return { p: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, d: { x: (b.x - a.x) / L, y: (b.y - a.y) / L } }; }
      left -= L;
    }
    return { p: P[0], d: { x: 1, y: 0 } };
  }
  function labeller(nodes, groups, edges) {
    const boxes = nodes.filter((n) => n.shape !== 'point' || n.w > 4).map((n) => (n.shape === 'point' ? inflate(n, 3) : n)).concat(groups.map((g) => ({ x: g.x + 4, y: g.y + 3, w: labelW(g.label) + 12, h: 18 })));
    const segs = [];
    for (const e of edges) for (const [p, q] of segsOf(e.points)) segs.push({ p, q, e });
    // what is drawn at the ends of lines: arrowheads, crow's feet
    const marks = [];
    for (const e of edges) {
      const P = e.points;
      if (P.length < 2) continue;
      const endBox = (atEnd, len, half) => {
        const a = atEnd ? P[P.length - 1] : P[0], w = walk(P, len, atEnd);
        const xs = [a.x, w.p.x], ys = [a.y, w.p.y];
        marks.push({ x: Math.min(...xs) - half, y: Math.min(...ys) - half, w: Math.abs(xs[0] - xs[1]) + 2 * half, h: Math.abs(ys[0] - ys[1]) + 2 * half });
      };
      if (e.arrow || e.arrowHead) endBox(true, e.arrowHead ? 15 : 12, 8);
      if (e.markers) { if (e.markers.from) endBox(false, 28, 9); if (e.markers.to) endBox(true, 28, 9); }
    }
    const taken = [];
    let misses = 0;
    const box = (x, y, t) => { const w = labelW(t); return { x: x - w / 2, y: y - LH / 2, w, h: LH }; };
    const hits = (b, own) => {
      let n = 0;
      for (const o of boxes) if (overlap(b, o, 2)) n += 3;
      for (const o of taken) if (overlap(b, o, 2)) n += 3;
      for (const o of marks) if (overlap(b, o, 0)) n += 2;
      const bb = inflate(b, 2);
      for (const s of segs) if (segBox(s.p, s.q, bb)) n += s.e === own ? 1 : 2;
      return n;
    };
    /** a free spot for text t beside the path of edge e: near its end (where = 'end' | 'start') or its middle */
    function place(e, t, where, opt) {
      opt = opt || {};
      const P = e.points, total = pathLen(P);
      const w = labelW(t);
      const ss = [];
      if (where === 'mid' || where === 'at') {
        const m = where === 'at' ? opt.at : total / 2;
        for (let k = 0; k < 14; k++) ss.push(m + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 10);
      } else for (const s of (opt.from || [14, 22, 32, 44, 58, 74, 92, 112])) ss.push(s);
      let best = null, bestN = Infinity;
      for (const s of ss) {
        if (s < 2 || s > total - 2) continue;
        const { p, d } = walk(P, s, where === 'end');
        const nx = -d.y, ny = d.x;
        // clear of the line, and of the crow's feet that reach 8px either side of it
        const ex = e.markers ? 6 : 0, off = Math.abs(nx) * (w / 2 + 5 + ex) + Math.abs(ny) * (LH / 2 + 4 + ex);
        // horizontal lines: above first; vertical ones: right first
        const sgn = Math.abs(d.x) > Math.abs(d.y) ? (ny < 0 ? 1 : -1) : (nx > 0 ? 1 : -1);
        for (const sd of [sgn, -sgn]) {
          const x = p.x + nx * off * sd, y = p.y + ny * off * sd;
          const b = box(x, y, t);
          const n = hits(b, e);
          if (n < bestN) { bestN = n; best = { x: r1(x), y: r1(y) }; }
          if (!n) break;
        }
        if (!bestN) break;
      }
      if (!best) { const c = walk(P, total / 2, false).p; best = { x: r1(c.x), y: r1(c.y - 10) }; bestN = 1; }
      if (bestN) misses++;
      taken.push(box(best.x, best.y, t));
      return best;
    }
    /** a free spot for text t around a box (the caption of a specialization) */
    function around(n, t) {
      const w = labelW(t), c = centre(n);
      const cands = [];
      for (const d of [6, 14, 26, 40]) for (const dy of [0, -1, 1]) {
        cands.push([n.x + n.w + d + w / 2, c.y + dy * (LH / 2 + 6 + d / 2)], [n.x - d - w / 2, c.y + dy * (LH / 2 + 6 + d / 2)]);
        cands.push([c.x + dy * (w / 2 + 8), n.y - d - LH / 2], [c.x + dy * (w / 2 + 8), n.y + n.h + d + LH / 2]);
      }
      let best = null, bestN = Infinity;
      for (const [x, y] of cands) { const n2 = hits(box(x, y, t), null); if (n2 < bestN) { bestN = n2; best = { x: r1(x), y: r1(y) }; } if (!n2) break; }
      if (bestN) misses++;
      taken.push(box(best.x, best.y, t));
      return best;
    }
    return { place, around, boxOf: box, misses: () => misses };
  }

  // ---- the layout --------------------------------------------------------------------------------------------------
  /** lay out a model. notation: 'chen' | 'textbook' | 'crowsfoot'; opts: { showTypes, gap, positions, aspect, lineNames }
   *  positions: { <main node id>: { x, y } } fixes the centre of those nodes, in the coordinates of an earlier
   *  layout plus its origin (so a node keeps its place when the layout's bounding box changes); the other nodes
   *  are placed around them.
   *  returns { notation, width, height, origin, nodes, edges, groups } (see the comment at the top of the file) */
  const cache = new Map();
  function layout(model, notation, opts) {
    opts = opts || {};
    const nt = ER.notation(notation);
    const pins = opts.positions && Object.keys(opts.positions).length ? opts.positions : null;
    const key = JSON.stringify([model, nt, opts.showTypes, opts.aspect, opts.lineNames]);
    let auto = cache.get(key);
    if (!auto) {
      // a design whose first grid leaves edges crossing gets other seeds; the cleanest result is kept
      for (let seed = 0; seed < 6; seed++) {
        const L = compute(model, nt, Object.assign({}, opts, { seed }), null);
        if (!auto || L.score < auto.score) auto = L;
        if (!auto.score) break;
      }
      delete auto.score;
      cache.set(key, auto);
      if (cache.size > 12) cache.delete(cache.keys().next().value);
    }
    // positions that are those of the automatic layout give the automatic layout back, with its routing
    if (!pins || auto.nodes.filter((n) => !n.owner).every((n) => { const p = pins[n.id]; return p && Math.abs(p.x - (n.x + n.w / 2 + auto.origin.x)) < 1 && Math.abs(p.y - (n.y + n.h / 2 + auto.origin.y)) < 1; })) return JSON.parse(JSON.stringify(auto));
    return compute(model, nt, opts, pins);
  }
  function compute(model, nt, opts, pins) {
    const m = ER.normalize(model);
    const showTypes = opts.showTypes !== undefined ? !!opts.showTypes : nt === 'crowsfoot';
    const aspect = opts.aspect || 1.5;
    // crow's foot lines need room for a foot at each end, and between them for the name of the relationship
    const names = nt === 'crowsfoot' && opts.lineNames !== false ? m.relationships.filter((r) => r.participants.length === 2 && !ER.leaves(r.attributes).length).map((r) => labelW(r.name)) : [];
    const gapX = nt === 'crowsfoot' ? Math.max(78, Math.max(0, ...names) + 72) : nt === 'chen' ? 56 : 74, gapY = nt === 'crowsfoot' ? 78 : nt === 'chen' ? 50 : 60;
    const nodes = [], edges = [], groups = [];
    const clusters = [], clusterOf = new Map(); // main node id -> cluster index
    const addCluster = (c) => { c.index = clusters.length; clusters.push(c); clusterOf.set(c.main.id, c.index); return c; };
    const aggOf = new Map(m.aggregations.map((a) => [lc(a.relationship), a]));
    const entName = (n) => (ER.entity(m, n) || { name: n }).name;

    // which relationships the crow's foot notation draws as plain lines
    const asLine = (r) => nt === 'crowsfoot' && r.participants.length === 2 && !ER.leaves(r.attributes).length && !aggOf.has(lc(r.name)) && r.participants.every((p) => !ER.aggregation(m, p.entity));
    for (const e of m.entities) {
      const id = 'e:' + e.name;
      if (nt === 'chen') {
        const main = { id, kind: 'entity', shape: 'rect', name: e.name, label: e.name, weak: e.weak, w: Math.max(textW(e.name, FS + 1) + 2 * PAD + (e.weak ? 10 : 0), 90), h: e.weak ? 44 : 40 };
        addCluster({ main, items: e.attributes.map(ovalItem) });
      } else {
        const lines = attrLines(e.attributes, showTypes);
        if (nt === 'crowsfoot') for (const l of lines) if (l.key) l.tag = 'PK';
        const s = boxSize(e.name, lines);
        addCluster({ main: { id, kind: 'entity', shape: 'rect', name: e.name, label: e.name, weak: e.weak, w: s.w + (e.weak ? 8 : 0), h: s.h + (e.weak ? 4 : 0), header: 28, lines } });
      }
    }
    for (const r of m.relationships) {
      if (asLine(r)) continue;
      const id = 'r:' + r.name;
      if (nt === 'crowsfoot') {
        const lines = attrLines(r.attributes, showTypes);
        const s = boxSize(r.name, lines);
        addCluster({ main: { id, kind: 'associative', shape: 'rect', name: r.name, label: r.name, w: s.w, h: s.h, header: 28, lines, identifying: r.identifying } });
        continue;
      }
      const main = { id, kind: 'relationship', shape: 'diamond', name: r.name, label: r.name, identifying: r.identifying, w: relW(r.name, r.identifying), h: r.identifying ? 60 : 54 };
      const c = { main };
      if (nt === 'chen') c.items = r.attributes.map(ovalItem);
      else if (r.attributes.length) {
        const lines = attrLines(r.attributes, showTypes);
        const w = Math.max(...lines.map((l) => textW(l.text) + l.depth * 14 + 2 * PAD), 70);
        c.attrBox = { id: id + '.attributes', kind: 'relattrs', shape: 'rect', name: r.name, label: '', lines, w, h: lines.length * LINE + 12, owner: id };
      }
      addCluster(c);
    }
    // specialization nodes
    const isaNodes = [];
    for (const s of m.specializations) {
      const id = 's:' + s.name;
      const direct = nt === 'textbook' && !s.disjoint;
      if (direct) { isaNodes.push({ s, id: null }); continue; }
      const main = nt === 'chen' ? { id, kind: 'isa', shape: 'triangle', name: s.name, label: 'ISA', w: 66, h: 50 } : { id, kind: 'isa', shape: 'point', name: s.name, label: '', w: 10, h: 10 };
      addCluster({ main });
      isaNodes.push({ s, id });
    }

    // ---- the connections
    const partNode = (p) => (ER.aggregation(m, p.entity) ? 'a:' + ER.aggregation(m, p.entity).name : 'e:' + entName(p.entity));
    const aggMembers = new Map();
    for (const a of m.aggregations) {
      const r = ER.relationship(m, a.relationship);
      if (!r) continue;
      const ids = [asLine(r) ? null : 'r:' + r.name].concat(r.participants.map((p) => partNode(p))).filter((x) => x && clusterOf.has(x));
      aggMembers.set(a.name, [...new Set(ids)]);
    }
    const exists = (id) => clusterOf.has(id) || (id.startsWith('a:') && (aggMembers.get(id.slice(2)) || []).length > 0);
    const conns = [];
    for (const r of m.relationships) {
      if (asLine(r)) {
        const [a, b] = r.participants, A = partNode(a), B = partNode(b);
        if (!exists(A) || !exists(B)) continue;
        conns.push({ kind: 'line', r, a: A, b: B, pa: a, pb: b });
        if (A === B && clusterOf.has(A)) clusters[clusterOf.get(A)].loop = true;
        continue;
      }
      r.participants.forEach((p, i) => { const B = partNode(p); if (exists(B)) conns.push({ kind: 'part', r, i, p, a: 'r:' + r.name, b: B }); });
    }
    for (const { s, id } of isaNodes) {
      const P = 'e:' + entName(s.parent);
      if (!clusterOf.has(P)) continue;
      s.children.forEach((ch, i) => {
        const C = 'e:' + entName(ch);
        if (!clusterOf.has(C)) return;
        conns.push(id ? { kind: 'isa-child', s, i, a: C, b: id } : { kind: 'isa', s, i, a: C, b: P });
      });
      if (id) conns.push({ kind: 'isa-parent', s, a: id, b: P });
    }
    for (const c of clusters) buildCluster(c, {});

    // ---- placement
    const blocks = [], inBlock = new Map();
    for (const a of m.aggregations) {
      const ids = (aggMembers.get(a.name) || []).filter((id) => !inBlock.has(clusterOf.get(id)));
      if (!ids.length) continue;
      const idx = ids.map((id) => clusterOf.get(id));
      for (const i of idx) inBlock.set(i, blocks.length);
      blocks.push({ agg: a, members: idx, main: { id: 'a:' + a.name } });
    }
    const kindOf = (c) => (c.main.kind === 'relationship' ? 'rel' : c.main.kind === 'isa' ? 'pt' : 'ent');
    const unitOf = (c) => ({ kind: kindOf(c), bx: c.bx, by: c.by, w: c.w, h: c.h, free: c.attrBox || (c.items && c.items.length) ? 1 : 0, cluster: c });
    const resize = (u, bl) => { if (!u.cluster) return; buildCluster(u.cluster, bl); Object.assign(u, { bx: u.cluster.bx, by: u.cluster.by, w: u.cluster.w, h: u.cluster.h }); };
    const isaPref = (cn, ix) => (cn.kind === 'isa' ? { above: ix(cn.b), below: ix(cn.a) } : cn.kind === 'isa-parent' ? { above: ix(cn.b), below: ix(cn.a) } : cn.kind === 'isa-child' ? { above: ix(cn.b), below: ix(cn.a) } : null);
    /** grid edges among units: ix(node id) gives a unit index or undefined */
    function unitGraph(ix, virt) {
      const map = new Map(), es = [], prefs = [];
      const addE = (a, b) => { if (a === undefined || b === undefined || a === b) return; const k = Math.min(a, b) + ',' + Math.max(a, b); if (map.has(k)) map.get(k).k++; else { const e = { a, b, k: 1 }; map.set(k, e); es.push(e); } };
      for (const cn of conns) {
        const a = ix(cn.a), b = ix(cn.b);
        if (cn.v !== undefined && virt) { addE(a, cn.v); addE(cn.v, b); }
        else addE(a, b);
        const p = isaPref(cn, ix);
        if (p && p.above !== undefined && p.below !== undefined && p.above !== p.below) prefs.push(p);
      }
      return { es, prefs };
    }
    let channels = { x: [], y: [] };
    if (!pins) {
      // aggregations first: their members laid out on their own, then the block as one unit
      for (const b of blocks) {
        const units = b.members.map((i) => unitOf(clusters[i]));
        const local = new Map(b.members.map((ci, k) => [clusters[ci].main.id, k]));
        const g = unitGraph((id) => local.get(id), false);
        gridLayout(units, g.es, g.prefs, { aspect: 1.8, gapX, gapY, resize, seed: opts.seed });
        const x0 = Math.min(...units.map((u) => u.cx + u.bx)) - 20, y0 = Math.min(...units.map((u) => u.cy + u.by)) - 32;
        const x1 = Math.max(...units.map((u) => u.cx + u.bx + u.w)) + 20, y1 = Math.max(...units.map((u) => u.cy + u.by + u.h)) + 20;
        const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
        b.rel = units.map((u) => ({ c: u.cluster, dx: u.cx - mx, dy: u.cy - my }));
        b.bx = x0 - mx; b.by = y0 - my; b.w = x1 - x0; b.h = y1 - y0;
      }
      const outer = [], ixOf = new Map();
      clusters.forEach((c, i) => { if (!inBlock.has(i)) { ixOf.set(c.main.id, outer.length); outer.push(unitOf(c)); } });
      blocks.forEach((b) => { const k = outer.length; outer.push({ kind: 'ent', bx: b.bx, by: b.by, w: b.w, h: b.h, free: 0, block: b }); ixOf.set(b.main.id, k); for (const i of b.members) ixOf.set(clusters[i].main.id, k); });
      // crow's foot (optional): the middle of a relationship line as a unit of its own, where its name goes
      for (const cn of conns) {
        if (!opts.lineMiddles || cn.kind !== 'line' || ixOf.get(cn.a) === ixOf.get(cn.b)) continue;
        const t = opts.lineNames === false ? '' : cn.r.name, w = t ? labelW(t) + 12 : 18;
        cn.v = outer.length;
        outer.push({ kind: 'pt', bx: -w / 2, by: -12, w, h: 24, free: 0, conn: cn });
      }
      const g = unitGraph((id) => ixOf.get(id), true);
      const ch = gridLayout(outer, g.es, g.prefs, { aspect, gapX, gapY, resize, seed: opts.seed });
      channels = { x: ch.chX, y: ch.chY };
      // the way each bent edge turns on the grid, for the router to follow (seen from the edge's first end)
      const bendOf = new Map(g.es.map((e, k) => [Math.min(e.a, e.b) + ',' + Math.max(e.a, e.b), { e, b: ch.bends && ch.bends[k] }]));
      for (const cn of conns) {
        const ua = ixOf.get(cn.a), ub = ixOf.get(cn.b), x = ua !== undefined && ub !== undefined && bendOf.get(Math.min(ua, ub) + ',' + Math.max(ua, ub));
        if (x && x.b && !cn.v) cn.bend = x.e.a === ua ? x.b : x.b === 'h' ? 'v' : 'h';
      }
      for (const u of outer) {
        if (u.cluster) { u.cluster.cx = u.cx; u.cluster.cy = u.cy; }
        else if (u.block) { u.block.cx = u.cx; u.block.cy = u.cy; for (const r of u.block.rel) { r.c.cx = u.cx + r.dx; r.c.cy = u.cy + r.dy; } }
        else if (u.conn) u.conn.vpt = { x: u.cx, y: u.cy };
      }
    } else {
      // saved positions: keep them, put anything new next to what it is linked to
      for (const c of clusters) { const p = pins[c.main.id]; if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) c.pin = { x: p.x, y: p.y }; }
      const links = [];
      for (const cn of conns) { const i = clusterOf.get(cn.a.startsWith('a:') ? (aggMembers.get(cn.a.slice(2)) || [])[0] : cn.a), j = clusterOf.get(cn.b.startsWith('a:') ? (aggMembers.get(cn.b.slice(2)) || [])[0] : cn.b); if (i !== undefined && j !== undefined) links.push([i, j]); }
      place(clusters, links, opts.gap || 40);
      // the sides the edges leave from, for the satellites
      const blockedOf = new Map();
      const side = (c, o) => {
        const bl = blockedOf.get(c) || {}; blockedOf.set(c, bl);
        const dx = o.x - c.cx, dy = o.y - c.cy;
        if (Math.abs(dx) >= Math.abs(dy) * 0.6) bl[dx > 0 ? 'right' : 'left'] = true;
        if (Math.abs(dy) >= Math.abs(dx) * 0.6) bl[dy > 0 ? 'bottom' : 'top'] = true;
        if (Math.abs(dx) > 2 && Math.abs(dy) > 2) bl[(dy > 0 ? 'b' : 't') + (dx > 0 ? 'r' : 'l')] = true;
      };
      for (const [i, j] of links) if (i !== j) { side(clusters[i], { x: clusters[j].cx, y: clusters[j].cy }); side(clusters[j], { x: clusters[i].cx, y: clusters[i].cy }); }
      for (const c of clusters) if ((c.items && c.items.length) || c.attrBox) buildCluster(c, blockedOf.get(c) || {});
    }

    // absolute positions
    clusters.forEach((c) => {
      const mn = c.main;
      mn.x = c.cx - mn.w / 2; mn.y = c.cy - mn.h / 2;
      nodes.push(mn);
      for (const s of c.sat) { s.x += c.cx; s.y += c.cy; nodes.push(s); }
    });
    for (const b of blocks) {
      const ms = b.members.map((i) => clusters[i]);
      const all = [].concat(...ms.map((c) => [c.main].concat(c.sat)));
      const x0 = Math.min(...all.map((n) => n.x)) - 20, y0 = Math.min(...all.map((n) => n.y)) - 32, x1 = Math.max(...all.map((n) => n.x + n.w)) + 20, y1 = Math.max(...all.map((n) => n.y + n.h)) + 20;
      groups.push({ id: 'a:' + b.agg.name, kind: 'aggregation', name: b.agg.name, label: b.agg.name, relationship: b.agg.relationship, x: x0, y: y0, w: x1 - x0, h: y1 - y0, members: b.members.map((i) => clusters[i].main.id) });
    }
    const byId = new Map(nodes.concat(groups).map((n) => [n.id, n]));

    // ---- edges
    const obstacles = nodes.map((n) => ({ id: n.id, x: n.x, y: n.y, w: n.w, h: n.h })).concat(groups.map((g) => ({ id: g.id, x: g.x + 4, y: g.y + 3, w: labelW(g.label) + 10, h: 20 })));
    let best = null;
    for (let variant = 0; variant < 3; variant++) {
      const satE = [], apex = new Map();
      let routeBad;
      const R = makeRouter(obstacles, groups.map((g) => ({ id: g.id, x: g.x, y: g.y, w: g.w, h: g.h })), channels, nt === 'crowsfoot' ? 30 : 16);
      const term = (id) => { const n = byId.get(id); if (!n) return null; const t = { id, x: n.x, y: n.y, w: n.w, h: n.h, shape: n.kind === 'aggregation' ? 'rect' : n.shape === 'triangle' ? 'tri' : n.shape === 'diamond' ? 'diamond' : n.shape === 'point' ? 'point' : 'rect' }; if (n.kind === 'aggregation') t.labelW = labelW(n.label) + 10; if (n.header) t.header = n.header + (n.weak ? 2 : 0); return t; };
      const terms = new Map();
      const T = (id) => { if (!terms.has(id)) terms.set(id, term(id)); return terms.get(id); };
      // satellite lines first: they are fixed
      for (const n of nodes) if (n.kind === 'attribute') {
        const owner = byId.get(n.parentAttr || n.owner);
        // to the nearest point of an entity box (its blocked sides lie between), else towards the centre
        let pts;
        if (owner.shape === 'rect') { const c = centre(n), q = pt(Math.max(owner.x, Math.min(owner.x + owner.w, c.x)), Math.max(owner.y, Math.min(owner.y + owner.h, c.y))); pts = [clip(n, q), q]; }
        else pts = [clip(n, centre(owner)), clip(owner, centre(n))];
        satE.push({ id: 'at:' + n.id, kind: 'attribute', from: n.id, to: owner.id, points: pts });
        R.add(pts);
      }
      const relEdges = [];
      for (const c of clusters) if (c.attrBox && byId.has(c.attrBox.id)) {
        const b = c.attrBox, mn = c.main, side = c.attrSide || 'right', v = SIDES[side];
        const vx = mn.x + mn.w / 2 + v[0] * mn.w / 2, vy = mn.y + mn.h / 2 + v[1] * mn.h / 2;
        const q = horiz(side) ? pt(side === 'right' ? b.x : b.x + b.w, vy) : pt(vx, side === 'bottom' ? b.y : b.y + b.h);
        const pts = [q, pt(vx, vy)];
        relEdges.push({ id: 'd:' + mn.name, kind: 'relattrs', from: b.id, to: mn.id, points: pts, dashed: true });
        R.add(pts);
        R.use(T(mn.id), side, 0);
      }
      // the order of routing: the isa edge of a triangle first (it decides where the triangle points), then short ones
      const est = (cn) => { const a = byId.get(cn.a), b = byId.get(cn.b); if (!a || !b) return 1e9; const pa = cn.vpt || centre(b); return Math.hypot(centre(a).x - pa.x, centre(a).y - pa.y); };
      // edges between neighbours in a row or a column come first (they can be straight), the second of two parallel
      // edges last
      const seenPair = new Set();
      const rank = conns.map((cn) => {
        const pk = [cn.a, cn.b].sort().join('|'), second = seenPair.has(pk);
        seenPair.add(pk);
        const a = byId.get(cn.a), b = byId.get(cn.b);
        if (!a || !b) return 9;
        const ca = centre(a), cb = cn.vpt || centre(b);
        const aligned = Math.abs(ca.x - cb.x) < 1 || Math.abs(ca.y - cb.y) < 1;
        return (cn.kind === 'isa-parent' ? 0 : 1) + (second ? 4 : 0) + (aligned ? 0 : 2);
      });
      // other routing orders, tried when the first leaves problems: long edges before short ones
      const order = conns.map((cn, i) => i).sort((i, j) => variant === 1 ? (rank[i] % 2) - (rank[j] % 2) || est(conns[j]) - est(conns[i]) || i - j
        : variant === 2 ? (rank[i] & 2) - (rank[j] & 2) || est(conns[j]) - est(conns[i]) || i - j : rank[i] - rank[j] || est(conns[i]) - est(conns[j]) || i - j);
      const pairSeen = new Map();
      const pts = new Map();
      for (const i of order) {
        const cn = conns[i];
        const pk = [cn.a, cn.b].sort().join('|');
        cn.multi = (pairSeen.get(pk) || 0) > 0;
        pairSeen.set(pk, (pairSeen.get(pk) || 0) + 1);
      }
      function routeConn(i) {
        const cn = conns[i], multi = cn.multi;
        const A = T(cn.a), B = T(cn.b);
        if (!A || !B) return;
        R.owner(i);
        if (cn.a === cn.b) { pts.set(i, R.loop(A)); return; }
        if (cn.vpt) {
          // through the middle of the line: two pieces that meet there
          const V = { id: 'v:' + i, x: cn.vpt.x, y: cn.vpt.y, w: 0, h: 0, shape: 'point' };
          // the first piece must not arrive on the side the second one leaves from
          const cb = centre(B), dx = cb.x - V.x, dy = cb.y - V.y;
          const p1 = R.route(A, V, { multi, avoidSideD: Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'bottom' : 'top') });
          const back = p1.sides[1];
          const p2 = R.route(V, B, { multi, avoidSide: back || null });
          pts.set(i, tidy(p1.pts.concat(p2.pts.slice(1))));
          cn.vAt = pathLen(p1.pts);
        } else {
          // a participation runs from the relationship to the participant
          const r = R.route(A, B, { multi, bend: cn.bend });
          if (A.shape === 'tri' && cn.kind === 'isa-parent' && r.sides[0]) { A.apex = r.sides[0]; apex.set(cn.a, r.sides[0]); }
          pts.set(i, r.pts);
        }
      }
      for (const i of order) routeConn(i);
      // repair: an edge that still crosses others is routed again first, then the ones it crossed; kept if better
      for (let pass = 0; pass < 3; pass++) {
        let better = false;
        for (const i of order) {
          if (conns[i].kind === 'isa-parent') continue;
          const c = R.conflicts(i);
          if (!c.n) continue;
          const group = [i].concat(c.with.filter((j) => conns[j] && conns[j].kind !== 'isa-parent'));
          const total = (g) => g.reduce((s, j) => s + R.conflicts(j).n, 0);
          const before = total(group), sn = R.snapshot(), old = new Map(group.map((j) => [j, pts.get(j)])), oldV = new Map(group.map((j) => [j, conns[j].vAt]));
          for (const j of group) R.remove(j);
          for (const j of group) routeConn(j);
          if (total(group) < before) better = true;
          else { R.restore(sn); for (const j of group) { pts.set(j, old.get(j)); conns[j].vAt = oldV.get(j); } }
        }
        if (!better) break;
      }
      // what is still wrong: crossings and lines through shapes
      routeBad = 0;
      for (const i of order) routeBad += R.conflicts(i).n + R.hits(i);
      if (!best || routeBad < best.routeBad) best = { routeBad, pts, satE, relEdges, apex, conns: conns.map((c) => c.vAt) };
      if (!routeBad) break;
    }
    const { routeBad, pts, relEdges } = best;
    edges.push(...best.satE);
    for (const [id, side] of best.apex) byId.get(id).apex = side;
    conns.forEach((c, i) => { c.vAt = best.conns[i]; });
    const crowEnd = (p) => (p.max === 1 ? (ER.isTotal(p) ? 'one-only' : 'zero-or-one') : ER.isTotal(p) ? 'one-or-many' : 'zero-or-many');
    const cardLabel = (r, p, i) => {
      // Chen's 1/N/M at the entity end: how many of this entity set go with one of the others
      if (r.participants.length === 2) { const o = r.participants[1 - i]; return o.max === 1 ? '1' : i === 0 ? 'M' : 'N'; }
      return p.arrow ? '1' : 'N';
    };
    const isaEdges = new Map();
    conns.forEach((cn, i) => {
      const P = pts.get(i);
      if (!P) return;
      const r = cn.r;
      if (cn.kind === 'line') {
        // the end at b says how many b's go with one a: that is a's own min..max
        edges.push({ id: 'l:' + r.name, kind: 'relationship-line', relationship: r.name, from: cn.a, to: cn.b, points: P, dashed: !r.identifying, identifying: r.identifying, markers: { from: crowEnd(cn.pb), to: crowEnd(cn.pa) }, conn: cn });
      } else if (cn.kind === 'part') {
        const p = cn.p, ps = r.participants;
        const e = { id: 'p:' + r.name + ':' + cn.i, kind: 'participation', relationship: r.name, participant: cn.i, entity: p.entity, from: cn.a, to: cn.b, points: P, total: ER.isTotal(p), double: nt !== 'crowsfoot' && ER.isTotal(p), role: p.role || null };
        if (nt === 'crowsfoot') { e.markers = { from: crowEnd(p), to: 'one-only' }; e.dashed = !r.identifying; }
        else { e.arrow = ps.length === 2 ? ps[1 - cn.i].max === 1 : !!p.arrow; e.card = cardLabel(r, p, cn.i); e.range = ER.range(p); }
        edges.push(e);
      } else {
        const s = cn.s, kinds = (s.disjoint ? 'disjoint' : 'overlapping') + (s.total ? ', total' : '');
        let e;
        if (cn.kind === 'isa') e = { id: 'i:' + s.name + ':' + cn.i, kind: 'isa', specialization: s.name, from: cn.a, to: cn.b, points: P, arrowHead: 'hollow', double: false, total: s.total };
        else if (cn.kind === 'isa-child') e = { id: 'i:' + s.name + ':' + cn.i, kind: 'isa-child', specialization: s.name, from: cn.a, to: cn.b, points: P };
        else {
          e = { id: 'i:' + s.name, kind: 'isa-parent', specialization: s.name, from: cn.a, to: cn.b, points: P, double: s.total && nt === 'chen', total: s.total, arrowHead: nt === 'chen' ? null : 'hollow' };
          const isa = byId.get(cn.a); isa.disjoint = s.disjoint; isa.total = s.total; isa.caption = kinds;
        }
        e.kinds = kinds;
        if (!isaEdges.has(s.name)) isaEdges.set(s.name, []);
        isaEdges.get(s.name).push(e);
        edges.push(e);
      }
    });
    edges.push(...relEdges);

    // ---- labels, each next to its own line
    const lab = labeller(nodes, groups, edges);
    for (const e of edges) {
      if (e.kind === 'participation' && nt !== 'crowsfoot') e.label = Object.assign({ text: nt === 'chen' ? e.card : e.range }, lab.place(e, nt === 'chen' ? e.card : e.range, 'end'));
    }
    for (const e of edges) {
      if (e.kind === 'participation' && e.role) e.roleLabel = Object.assign({ text: e.role }, lab.place(e, e.role, 'start', { from: [20, 30, 42, 56, 72, 90, 110] }));
      if (e.kind === 'relationship-line') {
        const cn = e.conn;
        if (opts.lineNames !== false) e.name = Object.assign({ text: e.relationship }, cn.vAt !== undefined ? lab.place(e, e.relationship, 'at', { at: cn.vAt }) : lab.place(e, e.relationship, 'mid'));
        e.roles = [cn.pa.role ? Object.assign({ text: cn.pa.role }, lab.place(e, cn.pa.role, 'start', { from: [36, 46, 58, 72, 90] })) : null, cn.pb.role ? Object.assign({ text: cn.pb.role }, lab.place(e, cn.pb.role, 'end', { from: [36, 46, 58, 72, 90] })) : null].filter(Boolean);
      }
    }
    for (const [name, list] of isaEdges) {
      const up = list.find((e) => e.kind === 'isa-parent');
      const text = list[0].kinds;
      if (up) { const isa = byId.get(up.from); up.label = Object.assign({ text }, isa.shape === 'point' || isa.shape === 'triangle' ? lab.around(isa, text) : lab.place(up, text, 'start')); }
      else list[0].label = Object.assign({ text }, lab.place(list[0], text, 'end', { from: [30, 44, 58, 74, 92, 112, 20] }));
    }
    for (const e of edges) { delete e.conn; delete e.kinds; }

    // normalise to a margin
    const M = 24;
    const bx = [];
    for (const n of nodes) bx.push(n);
    for (const g of groups) bx.push(g);
    for (const e of edges) {
      for (const p of e.points) bx.push({ x: p.x, y: p.y, w: 0, h: 0 });
      for (const l of [e.label, e.name, e.roleLabel].concat(e.roles || [])) if (l) bx.push(lab.boxOf(l.x, l.y, l.text));
    }
    const x0 = bx.length ? Math.min(...bx.map((b) => b.x)) - M : 0, y0 = bx.length ? Math.min(...bx.map((b) => b.y)) - M : 0;
    const x1 = bx.length ? Math.max(...bx.map((b) => b.x + b.w)) + M : 2 * M, y1 = bx.length ? Math.max(...bx.map((b) => b.y + b.h)) + M : 2 * M;
    const sh = (o) => { o.x = r1(o.x - x0); o.y = r1(o.y - y0); };
    for (const n of nodes) { sh(n); n.w = r1(n.w); n.h = r1(n.h); }
    for (const g of groups) { sh(g); g.w = r1(g.w); g.h = r1(g.h); }
    for (const e of edges) { e.points.forEach(sh); for (const k of ['label', 'name', 'roleLabel']) if (e[k]) sh(e[k]); if (e.roles) e.roles.forEach(sh); }
    for (const n of nodes) { delete n.items; }
    return { notation: nt, width: Math.ceil(x1 - x0), height: Math.ceil(y1 - y0), origin: { x: r1(x0), y: r1(y0) }, nodes, edges, groups, score: routeBad + lab.misses() };
  }
  ER.layout = layout;

  /** pairs of nodes whose boxes overlap (an empty list for a good layout) */
  ER.layoutOverlaps = (L, gap) => {
    const out = [];
    for (let i = 0; i < L.nodes.length; i++) for (let j = i + 1; j < L.nodes.length; j++) if (overlap(L.nodes[i], L.nodes[j], -(gap || 0.5))) out.push([L.nodes[i].id, L.nodes[j].id]);
    for (const g of L.groups) for (const n of L.nodes) {
      if (g.members.includes(n.id) || g.members.includes(n.owner) || (n.owner && g.members.some((mid) => n.id.startsWith(mid + '.')))) continue;
      if (overlap(g, n, -0.5)) out.push([g.id, n.id]);
    }
    return out;
  };
})(typeof window !== 'undefined' ? window : globalThis);
