// SVG drawing of a laid-out E-R model in the Chen, boxed-attribute (min..max) and crow's foot notations. The output is a
// self-contained SVG string: presentation attributes only, no stylesheet, fonts or images from outside.
(function (root) {
  'use strict';
  const K = root.K;
  const ER = K.ER;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const f = (n) => +(+n).toFixed(1);
  const FONT = 'Helvetica, Arial, sans-serif';
  const FS = 13, LINE = 18, PAD = 12;
  // close to the advance width of Helvetica for identifiers; used for underlines
  const textW = (s, fs) => Math.ceil(String(s).length * (fs || FS) * 0.54);
  const THEME = {
    background: '#ffffff', text: '#1f2933', line: '#4a5560', muted: '#7b8794',
    entity: '#e8f0fb', entityStroke: '#2f5d8a', header: '#d3e2f5',
    rel: '#fdf1df', relStroke: '#a86523', attr: '#ffffff', attrStroke: '#5f6b76',
    assoc: '#f3ecfa', assocStroke: '#6b4c9a', assocHeader: '#e6dbf3', group: '#7a5ba8', isa: '#2f5d8a',
  };

  const text = (x, y, s, o) => {
    o = o || {};
    return '<text x="' + f(x) + '" y="' + f(y) + '" font-family="' + FONT + '" font-size="' + (o.size || FS) + '"' + (o.bold ? ' font-weight="600"' : '') + (o.italic ? ' font-style="italic"' : '') +
      ' fill="' + (o.fill || o.theme.text) + '"' + (o.anchor ? ' text-anchor="' + o.anchor + '"' : '') + (o.halo ? ' stroke="' + o.theme.background + '" stroke-width="3" paint-order="stroke" stroke-linejoin="round"' : '') + '>' + esc(s) + '</text>';
  };
  const line = (x1, y1, x2, y2, o) => '<line x1="' + f(x1) + '" y1="' + f(y1) + '" x2="' + f(x2) + '" y2="' + f(y2) + '" stroke="' + o.stroke + '" stroke-width="' + (o.width || 1.2) + '"' + (o.dash ? ' stroke-dasharray="' + o.dash + '"' : '') + '/>';
  const poly = (pts, o) => '<polyline points="' + pts.map((p) => f(p.x) + ',' + f(p.y)).join(' ') + '" fill="none" stroke="' + o.stroke + '" stroke-width="' + (o.width || 1.3) + '"' + (o.dash ? ' stroke-dasharray="' + o.dash + '"' : '') + ' stroke-linejoin="round"/>';
  const polygon = (pts, o) => '<polygon points="' + pts.map((p) => f(p.x) + ',' + f(p.y)).join(' ') + '" fill="' + o.fill + '" stroke="' + o.stroke + '" stroke-width="' + (o.width || 1.4) + '"' + (o.dash ? ' stroke-dasharray="' + o.dash + '"' : '') + '/>';
  // underline under centred or left-aligned text: solid for a key, dashed for a discriminator
  const underline = (x, y, w, partial, t) => line(x, y + 3, x + w, y + 3, { stroke: t.text, width: 1, dash: partial ? '4 3' : null });

  function offsetLine(pts, d) {
    // a polyline shifted sideways by d (for the double line of total participation), mitred at the bends so that
    // the two strokes stay parallel all the way
    const nrm = (a, b) => { const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1; return { x: -dy / L, y: dx / L }; };
    return pts.map((p, i) => {
      if (i === 0) { const n = nrm(p, pts[1]); return { x: p.x + n.x * d, y: p.y + n.y * d }; }
      if (i === pts.length - 1) { const n = nrm(pts[i - 1], p); return { x: p.x + n.x * d, y: p.y + n.y * d }; }
      const n1 = nrm(pts[i - 1], p), n2 = nrm(p, pts[i + 1]), k = 1 + n1.x * n2.x + n1.y * n2.y;
      if (k < 0.2) return { x: p.x + n1.x * d, y: p.y + n1.y * d };
      return { x: p.x + (n1.x + n2.x) * d / k, y: p.y + (n1.y + n2.y) * d / k };
    });
  }
  function arrowHead(tip, from, o) {
    const dx = tip.x - from.x, dy = tip.y - from.y, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
    const len = o.len || 11, half = o.half || 5;
    const b = { x: tip.x - ux * len, y: tip.y - uy * len };
    return polygon([tip, { x: b.x - uy * half, y: b.y + ux * half }, { x: b.x + uy * half, y: b.y - ux * half }], { fill: o.fill, stroke: o.stroke, width: 1.2 });
  }
  function crowMarker(end, prev, kind, t) {
    // drawn at 'end' (on the entity outline), looking back along the line towards 'prev'
    const dx = prev.x - end.x, dy = prev.y - end.y, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L, px = -uy, py = ux;
    const at = (d, s) => ({ x: end.x + ux * d + px * s, y: end.y + uy * d + py * s });
    const bar = (d) => { const a = at(d, -7), b = at(d, 7); return line(a.x, a.y, b.x, b.y, { stroke: t.line, width: 1.4 }); };
    const circle = (d) => { const c = at(d, 0); return '<circle cx="' + f(c.x) + '" cy="' + f(c.y) + '" r="4.5" fill="' + t.background + '" stroke="' + t.line + '" stroke-width="1.4"/>'; };
    const foot = () => { const o = at(14, 0), a = at(0, -8), b = at(0, 8), c = at(0, 0); return line(o.x, o.y, a.x, a.y, { stroke: t.line, width: 1.4 }) + line(o.x, o.y, b.x, b.y, { stroke: t.line, width: 1.4 }) + line(o.x, o.y, c.x, c.y, { stroke: t.line, width: 1.4 }); };
    if (kind === 'one-only') return bar(7) + bar(13);
    if (kind === 'zero-or-one') return bar(7) + circle(18);
    if (kind === 'one-or-many') return foot() + bar(19);
    return foot() + circle(23);
  }

  function entityBox(n, nt, t) {
    const out = [];
    const fill = n.kind === 'associative' ? t.assoc : t.entity, stroke = n.kind === 'associative' ? t.assocStroke : t.entityStroke;
    out.push('<rect x="' + f(n.x) + '" y="' + f(n.y) + '" width="' + f(n.w) + '" height="' + f(n.h) + '" rx="6" ry="6" fill="' + fill + '" stroke="' + stroke + '" stroke-width="1.5"/>');
    if (n.weak) out.push('<rect x="' + f(n.x + 4) + '" y="' + f(n.y + 4) + '" width="' + f(n.w - 8) + '" height="' + f(n.h - 8) + '" rx="4" ry="4" fill="none" stroke="' + stroke + '" stroke-width="1.2"/>');
    if (n.header) {
      const hy = n.y + n.header + (n.weak ? 2 : 0);
      const ins = n.weak ? 4 : 0;
      out.push('<path d="M' + f(n.x + ins + 0.75) + ' ' + f(hy) + ' V' + f(n.y + ins + 6) + ' Q' + f(n.x + ins + 0.75) + ' ' + f(n.y + ins + 0.75) + ' ' + f(n.x + ins + 6) + ' ' + f(n.y + ins + 0.75) + ' H' + f(n.x + n.w - ins - 6) + ' Q' + f(n.x + n.w - ins - 0.75) + ' ' + f(n.y + ins + 0.75) + ' ' + f(n.x + n.w - ins - 0.75) + ' ' + f(n.y + ins + 6) + ' V' + f(hy) + ' Z" fill="' + (n.kind === 'associative' ? t.assocHeader : t.header) + '" stroke="none"/>');
      out.push(line(n.x + ins, hy, n.x + n.w - ins, hy, { stroke: stroke, width: 1 }));
      out.push(text(n.x + n.w / 2, n.y + 19 + (n.weak ? 2 : 0), n.label, { theme: t, bold: true, size: FS + 1, anchor: 'middle' }));
      (n.lines || []).forEach((l, i) => {
        const x = n.x + PAD + l.depth * 14 + (n.weak ? 2 : 0), y = hy + 4 + (i + 1) * LINE - 4;
        out.push(text(x, y, l.text, { theme: t, italic: l.derived }));
        if (l.key || l.partial) {
          // only the name is underlined, not the braces or the type
          const name = l.text.replace(/^\{ /, '').replace(/ : .*$/, '').replace(/ \}$/, '').replace(/ \( \)$/, '');
          const off = l.text.startsWith('{ ') ? textW('{ ') : 0;
          if (!l.composite) out.push(underline(x + off, y, textW(name), l.partial && !l.key, t));
        }
        if (l.tag) out.push(text(n.x + n.w - PAD, y, l.tag, { theme: t, size: 10, fill: t.muted, anchor: 'end' }));
      });
    } else out.push(text(n.x + n.w / 2, n.y + n.h / 2 + 5, n.label, { theme: t, bold: true, size: FS + 1, anchor: 'middle' }));
    return out.join('');
  }
  function diamond(n, t) {
    const cx = n.x + n.w / 2, cy = n.y + n.h / 2;
    const pts = (dx, dy) => [{ x: cx, y: cy - dy }, { x: cx + dx, y: cy }, { x: cx, y: cy + dy }, { x: cx - dx, y: cy }];
    let s = polygon(pts(n.w / 2, n.h / 2), { fill: t.rel, stroke: t.relStroke });
    if (n.identifying) s += polygon(pts(n.w / 2 - 9, n.h / 2 - 6), { fill: 'none', stroke: t.relStroke, width: 1.2 });
    return s + text(cx, cy + 4.5, n.label, { theme: t, size: FS - 0.5, anchor: 'middle' });
  }
  function oval(n, t) {
    const cx = n.x + n.w / 2, cy = n.y + n.h / 2;
    let s = '<ellipse cx="' + f(cx) + '" cy="' + f(cy) + '" rx="' + f(n.w / 2) + '" ry="' + f(n.h / 2) + '" fill="' + t.attr + '" stroke="' + t.attrStroke + '" stroke-width="1.3"' + (n.derived ? ' stroke-dasharray="5 3"' : '') + '/>';
    if (n.multivalued) s += '<ellipse cx="' + f(cx) + '" cy="' + f(cy) + '" rx="' + f(n.w / 2 - 4) + '" ry="' + f(n.h / 2 - 4) + '" fill="none" stroke="' + t.attrStroke + '" stroke-width="1.1"/>';
    s += text(cx, cy + 4.5, n.label, { theme: t, size: FS - 1, anchor: 'middle', italic: n.derived });
    if (n.key || n.partial) { const w = textW(n.label, FS - 1); s += underline(cx - w / 2, cy + 4.5, w, n.partial && !n.key, t); }
    return s;
  }
  function attrBox(n, t) {
    let s = '<rect x="' + f(n.x) + '" y="' + f(n.y) + '" width="' + f(n.w) + '" height="' + f(n.h) + '" rx="4" ry="4" fill="' + t.attr + '" stroke="' + t.attrStroke + '" stroke-width="1.2"/>';
    (n.lines || []).forEach((l, i) => { s += text(n.x + PAD + l.depth * 14, n.y + 6 + (i + 1) * LINE - 4, l.text, { theme: t, size: FS - 1, italic: l.derived }); });
    return s;
  }
  function isaShape(n, L, t) {
    const cx = n.x + n.w / 2, cy = n.y + n.h / 2;
    if (n.shape === 'point') return '<circle cx="' + f(cx) + '" cy="' + f(cy) + '" r="3.5" fill="' + t.isa + '"/>';
    // the triangle fills its box with the apex on the side of the higher-level entity set, the base across from it
    const x0 = n.x, y0 = n.y, x1 = n.x + n.w, y1 = n.y + n.h;
    const P = { top: [{ x: cx, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }], bottom: [{ x: cx, y: y1 }, { x: x0, y: y0 }, { x: x1, y: y0 }],
      left: [{ x: x0, y: cy }, { x: x1, y: y0 }, { x: x1, y: y1 }], right: [{ x: x1, y: cy }, { x: x0, y: y1 }, { x: x0, y: y0 }] }[n.apex || 'top'];
    const gx = (P[0].x + P[1].x + P[2].x) / 3, gy = (P[0].y + P[1].y + P[2].y) / 3;
    return polygon(P, { fill: t.entity, stroke: t.isa }) + text(gx, gy + 3.5, 'ISA', { theme: t, size: 10, anchor: 'middle', bold: true });
  }
  function edge(e, nt, t) {
    const out = ['<g>'];
    const pts = e.points;
    if (pts.length < 2) return '';
    const dash = e.dashed ? '6 4' : null;
    const stroke = e.kind === 'attribute' ? t.attrStroke : t.line;
    // double lines stop short of the arrowhead so it stays clean
    if (e.double) { out.push(poly(offsetLine(pts, 2.2), { stroke, width: 1.1, dash })); out.push(poly(offsetLine(pts, -2.2), { stroke, width: 1.1, dash })); }
    else out.push(poly(pts, { stroke, width: e.kind === 'attribute' ? 1 : 1.3, dash }));
    const end = pts[pts.length - 1], prev = pts[pts.length - 2];
    if (e.arrow) out.push(arrowHead(end, prev, { fill: t.line, stroke: t.line }));
    if (e.arrowHead === 'hollow') out.push(arrowHead(end, prev, { fill: t.background, stroke: t.line, len: 14, half: 7 }));
    if (e.markers) {
      if (e.markers.from) out.push(crowMarker(pts[0], pts[1], e.markers.from, t));
      if (e.markers.to) out.push(crowMarker(end, prev, e.markers.to, t));
    }
    if (e.label && e.label.text) out.push(text(e.label.x, e.label.y + 4, e.label.text, { theme: t, size: 11, anchor: 'middle', halo: true, fill: e.kind && e.kind.startsWith('isa') ? t.muted : t.text, italic: !!(e.kind && e.kind.startsWith('isa')) }));
    if (e.roleLabel) out.push(text(e.roleLabel.x, e.roleLabel.y + 4, e.roleLabel.text, { theme: t, size: 11, anchor: 'middle', halo: true, italic: true, fill: t.muted }));
    if (e.name) out.push(text(e.name.x, e.name.y + 4, e.name.text, { theme: t, size: 11.5, anchor: 'middle', halo: true, italic: true }));
    if (e.roles) for (const r of e.roles) out.push(text(r.x, r.y + 4, r.text, { theme: t, size: 11, anchor: 'middle', halo: true, italic: true, fill: t.muted }));
    out.push('</g>');
    return out.join('');
  }

  /** an SVG string for a model. layout may be null (computed here). opts: { theme, title, background: false, showTypes } */
  function svg(model, L, notation, opts) {
    opts = opts || {};
    const nt = ER.notation(notation || (L && L.notation));
    if (!L || L.notation !== nt) L = ER.layout(model, nt, opts);
    const t = Object.assign({}, THEME, opts.theme || {});
    const top = opts.title ? 30 : 0;
    const W = L.width, H = L.height + top;
    const out = ['<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(opts.title || 'E-R diagram (' + nt + ' notation)') + '">'];
    out.push('<title>' + esc(opts.title || 'E-R diagram') + '</title>');
    if (opts.background !== false) out.push('<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="' + t.background + '"/>');
    if (opts.title) out.push(text(W / 2, 20, opts.title, { theme: t, bold: true, size: 15, anchor: 'middle' }));
    out.push('<g transform="translate(0,' + top + ')">');
    for (const g of L.groups) {
      out.push('<rect data-audit="group" x="' + f(g.x) + '" y="' + f(g.y) + '" width="' + f(g.w) + '" height="' + f(g.h) + '" rx="8" ry="8" fill="none" stroke="' + t.group + '" stroke-width="1.6"/>');
      out.push(text(g.x + 10, g.y + 16, g.label, { theme: t, size: 11.5, italic: true, fill: t.group }));
    }
    out.push('<g>' + L.edges.map((e) => edge(e, nt, t)).join('') + '</g>');
    out.push('<g>');
    for (const n of L.nodes) {
      if (n.kind === 'entity' || n.kind === 'associative') out.push(entityBox(n, nt, t));
      else if (n.kind === 'relationship') out.push(diamond(n, t));
      else if (n.kind === 'attribute') out.push(oval(n, t));
      else if (n.kind === 'relattrs') out.push(attrBox(n, t));
      else if (n.kind === 'isa') out.push(isaShape(n, L, t));
    }
    out.push('</g>');
    out.push('</g></svg>');
    return out.join('\n');
  }
  ER.svg = svg;

  /** the rows of a legend: [draw(x, centreY), caption] */
  function legendRows(nt, t) {
    const rows = [];
    const ent = (label, weak, lines) => {
      const h = (lines ? 28 + lines.length * LINE + 10 : 30) + (weak ? 6 : 0);
      const fn = (x, y) => entityBox({ kind: 'entity', x, y: y - h / 2, w: 96, h, label, weak, header: lines ? 28 : 0, lines }, nt, t);
      fn.h = h + 14;
      return fn;
    };
    const L = (x, y, o) => edge(Object.assign({ points: [{ x, y }, { x: x + 96, y }] }, o), nt, t);
    if (nt === 'chen') {
      rows.push([ent('entity', false), 'entity set']);
      rows.push([ent('weak', true), 'weak entity set (double rectangle)']);
      rows.push([(x, y) => diamond({ x, y: y - 20, w: 96, h: 40, label: 'relates' }, t), 'relationship set']);
      rows.push([(x, y) => diamond({ x: x - 8, y: y - 24, w: 112, h: 48, label: 'owns', identifying: true }, t), 'identifying relationship set']);
      rows.push([(x, y) => oval({ x: x + 8, y: y - 14, w: 80, h: 28, label: 'name' }, t), 'attribute']);
      rows.push([(x, y) => oval({ x: x + 8, y: y - 14, w: 80, h: 28, label: 'code', key: true }, t), 'key attribute (underlined)']);
      rows.push([(x, y) => oval({ x: x + 8, y: y - 14, w: 80, h: 28, label: 'seat_no', partial: true }, t), 'discriminator of a weak entity set (dashed underline)']);
      rows.push([(x, y) => oval({ x: x + 8, y: y - 14, w: 80, h: 28, label: 'phone', multivalued: true }, t), 'multivalued attribute (double oval)']);
      rows.push([(x, y) => oval({ x: x + 8, y: y - 14, w: 80, h: 28, label: 'age', derived: true }, t), 'derived attribute (dashed oval)']);
      rows.push([(x, y) => L(x, y, { double: true }), 'total participation (double line)']);
      rows.push([(x, y) => L(x, y, { arrow: true, label: { text: '1', x: x + 78, y: y - 10 } }), 'arrow / 1: at most one entity of this set']);
      rows.push([(x, y) => L(x, y, { label: { text: 'N', x: x + 78, y: y - 10 } }), 'N or M: many']);
      rows.push([(x, y) => isaShape({ x: x + 22, y: y - 20, w: 52, h: 40, shape: 'triangle', apex: 'top' }, null, t), 'specialization (ISA), labelled disjoint or overlapping']);
    } else if (nt === 'textbook') {
      rows.push([ent('member', false, [{ text: 'member_no', key: true, depth: 0 }, { text: 'name', depth: 0 }]), 'entity set with its attributes; the key is underlined']);
      rows.push([ent('seat', true, [{ text: 'seat_no', partial: true, depth: 0 }]), 'weak entity set; discriminator dashed']);
      rows.push([ent('person', false, [{ text: 'name', composite: true, depth: 0 }, { text: 'first', depth: 1 }, { text: '{ phone }', multivalued: true, depth: 0 }, { text: 'age ( )', derived: true, depth: 0 }]), 'composite (indented), { multivalued }, derived ( )']);
      rows.push([(x, y) => diamond({ x, y: y - 20, w: 96, h: 40, label: 'joins' }, t), 'relationship set']);
      rows.push([(x, y) => diamond({ x: x - 8, y: y - 24, w: 112, h: 48, label: 'in_hall', identifying: true }, t), 'identifying relationship set']);
      rows.push([(x, y) => attrBox({ x: x + 14, y: y - 8, w: 68, h: 26, lines: [{ text: 'since', depth: 0 }] }, t) + line(x + 48, y - 8, x + 48, y - 20, { stroke: t.line, dash: '6 4' }), 'descriptive attributes, joined by a dashed line']);
      rows.push([(x, y) => L(x, y, { double: true }), 'total participation (double line)']);
      rows.push([(x, y) => L(x, y, { arrow: true }), 'arrow: at most one entity of this set']);
      rows.push([(x, y) => L(x, y, { label: { text: '1..*', x: x + 76, y: y - 10 } }), 'min..max: how many relationships each entity takes part in']);
      rows.push([(x, y) => L(x, y, { arrowHead: 'hollow' }), 'specialization: hollow arrow to the higher-level entity set']);
    } else {
      rows.push([ent('member', false, [{ text: 'code', key: true, depth: 0, tag: 'PK' }, { text: 'name', depth: 0 }]), 'entity set; PK marks the key']);
      rows.push([(x, y) => entityBox({ kind: 'associative', x, y: y - 14, w: 96, h: 30, label: 'booking' }, nt, t), 'associative entity (a relationship with attributes or more than two participants)']);
      rows.push([(x, y) => L(x, y, { markers: { to: 'one-only' } }), 'exactly one']);
      rows.push([(x, y) => L(x, y, { markers: { to: 'zero-or-one' } }), 'zero or one']);
      rows.push([(x, y) => L(x, y, { markers: { to: 'one-or-many' } }), 'one or more']);
      rows.push([(x, y) => L(x, y, { markers: { to: 'zero-or-many' } }), 'zero or more']);
      rows.push([(x, y) => L(x, y, {}), 'identifying relationship (solid line)']);
      rows.push([(x, y) => L(x, y, { dashed: true }), 'non-identifying relationship (dashed line)']);
      rows.push([(x, y) => L(x, y, { arrowHead: 'hollow' }), 'specialization']);
    }
    return rows;
  }
  /** the legend as separate symbols, each a small SVG string with its caption (the page wraps the captions) */
  ER.legendRows = (notation, opts) => {
    opts = opts || {};
    const nt = ER.notation(notation), t = Object.assign({}, THEME, opts.theme || {});
    return legendRows(nt, t).map(([draw, caption]) => {
      const h = Math.max(44, draw.h || 0), W = 124;
      return { caption, svg: '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + h + '" viewBox="0 0 ' + W + ' ' + h + '" role="img" aria-label="' + esc(caption) + '">' + draw(14, h / 2) + '</svg>' };
    });
  };
  /** a legend of the symbols of a notation, as an SVG string */
  function svgLegend(notation, opts) {
    opts = opts || {};
    const nt = ER.notation(notation);
    const t = Object.assign({}, THEME, opts.theme || {});
    const rows = legendRows(nt, t);
    const heights = rows.map(([draw]) => Math.max(44, draw.h || 0));
    const W = 120 + Math.max(...rows.map((r) => textW(r[1], 12))) + 30;
    const H = heights.reduce((a, b) => a + b, 0) + 40;
    const out = ['<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="legend">', '<title>' + esc(nt + ' notation') + '</title>'];
    if (opts.background !== false) out.push('<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="' + t.background + '"/>');
    out.push(text(14, 22, ({ chen: 'Chen notation', textbook: 'Boxed-attribute notation', crowsfoot: 'Crow\'s foot notation' })[nt], { theme: t, bold: true, size: 14 }));
    let y = 40;
    rows.forEach(([draw, cap], i) => {
      const h = heights[i];
      const cy = y + h / 2;
      out.push(draw(14, cy));
      out.push(text(126, cy + 4, cap, { theme: t, size: 12 }));
      y += h;
    });
    out.push('</svg>');
    return out.join('\n');
  }
  ER.svgLegend = svgLegend;
})(typeof window !== 'undefined' ? window : globalThis);
