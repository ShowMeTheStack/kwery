// Geometry checks for the diagrams on the page, run inside the browser by tools/check-diagrams.mjs.
// KweryAudit.run(root) looks at every visible <svg> under root (and text in HTML boxes) and returns a list of
// problems: shapes that overlap, edges that cross each other or run through a shape or a label, labels that
// collide, labels that spill out of their box or are cut off by the drawing's edge or a clipping container.
//
// What counts as what is guessed from the elements, and can be stated with data-audit:
//   data-audit="ignore"  skip the element and everything inside it (backgrounds, grids, decorations)
//   data-audit="node"    a shape that edges join and nothing may overlap
//   data-audit="edge"    a connector
//   data-audit="label"   text that must not collide (default for <text>)
//   data-audit="group"   a container shape that other nodes may sit inside (a cluster, a lane, a page)
//   data-audit="overlap-ok" a shape that may overlap others (a highlight, a selection)
// Edges may share endpoints; an edge may touch the nodes at its two ends.
(function (root) {
  'use strict';
  const EPS = 1.5;

  const vis = (el) => {
    for (let e = el; e && e.nodeType === 1; e = e.parentNode) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false;
      if (e.dataset && e.dataset.audit === 'ignore') return false;
      if (e.tagName === 'marker' || e.tagName === 'defs' || e.tagName === 'clipPath' || e.tagName === 'pattern' || e.tagName === 'symbol') return false;
      // the body of a closed <details> is not drawn, though it still has boxes
      if (e.parentNode && e.parentNode.tagName === 'DETAILS' && !e.parentNode.open && e.tagName !== 'SUMMARY') return false;
    }
    return true;
  };
  const role = (el) => { for (let e = el; e && e.nodeType === 1 && e.tagName !== 'svg'; e = e.parentNode) if (e.dataset && e.dataset.audit && e.dataset.audit !== 'ignore') return e.dataset.audit; return null; };

  // ---- geometry ---------------------------------------------------------------------------------------------------
  const rect = (r) => ({ x: r.left, y: r.top, w: r.width, h: r.height });
  const inter = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const shrink = (a, d) => ({ x: a.x + d, y: a.y + d, w: Math.max(0, a.w - 2 * d), h: Math.max(0, a.h - 2 * d) });
  const contains = (a, b, d) => b.x >= a.x - (d || 0) && b.y >= a.y - (d || 0) && b.x + b.w <= a.x + a.w + (d || 0) && b.y + b.h <= a.y + a.h + (d || 0);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  /** proper intersection of two segments, ignoring touches within EPS of an endpoint */
  function segX(p1, p2, p3, p4, ends) {
    const d1 = cross(p3, p4, p1), d2 = cross(p3, p4, p2), d3 = cross(p1, p2, p3), d4 = cross(p1, p2, p4);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
      const t = d1 / (d1 - d2);
      const pt = { x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y) };
      const near = (q) => Math.hypot(q.x - pt.x, q.y - pt.y) < EPS * 2;
      // ends: the true ends of two edges (inner vertices of a curve or polyline are no excuse)
      if ((ends || [p1, p2, p3, p4]).some(near)) return null;
      return pt;
    }
    // collinear overlap of two edges running on top of each other
    if (Math.abs(d1) < 1e-6 && Math.abs(d2) < 1e-6) {
      const len = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
      const proj = (q) => ((q.x - p1.x) * (p2.x - p1.x) + (q.y - p1.y) * (p2.y - p1.y)) / len;
      const a = Math.max(0, Math.min(proj(p3), proj(p4))), b = Math.min(len, Math.max(proj(p3), proj(p4)));
      if (b - a > 4) return { x: p1.x + (p2.x - p1.x) * ((a + b) / 2 / len), y: p1.y + (p2.y - p1.y) * ((a + b) / 2 / len), along: true };
    }
    return null;
  }
  function segBox(p, q, b) {
    // does the segment pass through the interior of box b?
    if (Math.max(p.x, q.x) <= b.x || Math.min(p.x, q.x) >= b.x + b.w || Math.max(p.y, q.y) <= b.y || Math.min(p.y, q.y) >= b.y + b.h) return false;
    const inside = (r) => r.x > b.x && r.x < b.x + b.w && r.y > b.y && r.y < b.y + b.h;
    if (inside(p) || inside(q)) return true;
    const c = [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h }];
    for (let i = 0; i < 4; i++) if (segX(p, q, c[i], c[(i + 1) % 4])) return true;
    return false;
  }
  const inPoly = (pt, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) c = !c; } return c; };

  /** an element's outline in page coordinates: points along its geometry */
  function points(el) {
    const m = el.getScreenCTM();
    if (!m) return [];
    const tr = (x, y) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f });
    const t = el.tagName;
    if (t === 'line') return [tr(+el.getAttribute('x1') || 0, +el.getAttribute('y1') || 0), tr(+el.getAttribute('x2') || 0, +el.getAttribute('y2') || 0)];
    if (t === 'polyline' || t === 'polygon') { const ps = [...el.points].map((p) => tr(p.x, p.y)); if (t === 'polygon' && ps.length) ps.push(ps[0]); return ps; }
    if (t === 'path') {
      let len = 0; try { len = el.getTotalLength(); } catch (e) { return []; }
      const d = el.getAttribute('d') || '';
      const curved = /[CcQqSsTtAa]/.test(d);
      if (!curved) {
        // straight segments: take the vertices
        const out = []; let cur = { x: 0, y: 0 }, start = null;
        const toks = d.match(/[MmLlHhVvZz]|-?\d*\.?\d+(?:e-?\d+)?/g) || [];
        let cmd = 'M', i = 0;
        const num = () => +toks[i++];
        while (i < toks.length) {
          if (/[A-Za-z]/.test(toks[i])) cmd = toks[i++];
          if (cmd === 'Z' || cmd === 'z') { if (start) out.push(tr(start.x, start.y)); cur = start || cur; continue; }
          if (cmd === 'M' || cmd === 'L') { cur = { x: num(), y: num() }; if (cmd === 'M') { start = cur; out.push(null); } out.push(tr(cur.x, cur.y)); if (cmd === 'M') cmd = 'L'; }
          else if (cmd === 'm' || cmd === 'l') { cur = { x: cur.x + num(), y: cur.y + num() }; if (cmd === 'm') { start = cur; out.push(null); } out.push(tr(cur.x, cur.y)); if (cmd === 'm') cmd = 'l'; }
          else if (cmd === 'H') { cur = { x: num(), y: cur.y }; out.push(tr(cur.x, cur.y)); }
          else if (cmd === 'h') { cur = { x: cur.x + num(), y: cur.y }; out.push(tr(cur.x, cur.y)); }
          else if (cmd === 'V') { cur = { x: cur.x, y: num() }; out.push(tr(cur.x, cur.y)); }
          else if (cmd === 'v') { cur = { x: cur.x, y: cur.y + num() }; out.push(tr(cur.x, cur.y)); }
          else i++;
        }
        return out;
      }
      const n = Math.max(8, Math.min(60, Math.ceil(len / 6)));
      const out = [];
      for (let k = 0; k <= n; k++) { const p = el.getPointAtLength((len * k) / n); out.push(tr(p.x, p.y)); }
      return out;
    }
    return [];
  }
  const segs = (pts) => { const out = []; for (let i = 1; i < pts.length; i++) if (pts[i - 1] && pts[i]) out.push([pts[i - 1], pts[i]]); return out; };


  const filled = (el) => { const cs = getComputedStyle(el); return !clear(cs.fill) && +cs.fillOpacity > 0.05; };
  const clear = (c) => !c || c === 'none' || c === 'transparent' || /rgba\([^)]*,\s*0(\.0+)?\)$/.test(c);
  const stroked = (el) => { const cs = getComputedStyle(el); return !clear(cs.stroke) && parseFloat(cs.strokeWidth) > 0 && +cs.strokeOpacity > 0.05; };
  const label = (el) => { const s = (el.textContent || '').trim().replace(/\s+/g, ' '); return s.length > 28 ? s.slice(0, 26) + '…' : s; };
  const where = (el) => { const parts = []; for (let e = el; e && e.nodeType === 1 && parts.length < 3; e = e.parentNode) { const c = e.getAttribute && e.getAttribute('class'); parts.unshift(e.tagName.toLowerCase() + (c ? '.' + String(c).trim().split(/\s+/).slice(0, 2).join('.') : '')); if (e.tagName === 'svg') break; } return parts.join(' > '); };

  /** the clip a container puts on an element: the intersection of every overflow-hidden ancestor's box */
  function clipOf(el, stop) {
    let c = null;
    for (let e = el.parentElement; e && e !== document.documentElement; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (/(hidden|clip|auto|scroll)/.test(cs.overflow + cs.overflowX + cs.overflowY) && e.tagName !== 'svg') {
        // scrolling containers clip only what cannot be scrolled to: their full scroll area
        const r = e.getBoundingClientRect();
        const scrolls = /(auto|scroll)/.test(cs.overflow + cs.overflowX + cs.overflowY);
        const b = scrolls ? { x: r.left - e.scrollLeft, y: r.top - e.scrollTop, w: Math.max(r.width, e.scrollWidth), h: Math.max(r.height, e.scrollHeight) } : rect(r);
        c = c ? { x: Math.max(c.x, b.x), y: Math.max(c.y, b.y), w: Math.min(c.x + c.w, b.x + b.w) - Math.max(c.x, b.x), h: Math.min(c.y + c.h, b.y + b.h) - Math.max(c.y, b.y) } : b;
        // what lies in a scroll area can be scrolled into view: the containers above clip the scroller, not it
        if (scrolls) break;
      }
      if (e === stop) break;
    }
    return c;
  }

  // ---- one svg ----------------------------------------------------------------------------------------------------
  function auditSvg(svg, out, ctx) {
    const sr = rect(svg.getBoundingClientRect());
    if (sr.w < 20 || sr.h < 20) return;
    const svgArea = sr.w * sr.h;
    const all = [...svg.querySelectorAll('rect,circle,ellipse,polygon,path,line,polyline,text')].filter(vis);
    const nodes = [], edges = [], texts = [], groups = [];
    for (const el of all) {
      const r = role(el);
      if (r === 'ignore') continue;
      if (el.tagName === 'text') { if (label(el)) texts.push({ el, b: rect(el.getBoundingClientRect()), r }); continue; }
      const b = rect(el.getBoundingClientRect());
      if (b.w * b.h > svgArea * 0.6 && r !== 'node') continue; // a background
      if (r === 'group') { groups.push({ el, b }); continue; }
      if (r === 'edge') { edges.push({ el, b, pts: points(el) }); continue; }
      if (r === 'node' || r === 'overlap-ok') { nodes.push({ el, b, poly: el.tagName === 'polygon' ? points(el) : null, ok: r === 'overlap-ok' }); continue; }
      const t = el.tagName;
      const isFilled = filled(el);
      if (t === 'line' || t === 'polyline' || (t === 'path' && !isFilled)) { if (stroked(el) && Math.hypot(b.w, b.h) > 18) edges.push({ el, b, pts: points(el) }); continue; }
      if (!isFilled && !stroked(el)) continue;
      if (b.w < 6 && b.h < 6) continue; // dots, small markers
      if (t === 'polygon' && b.w * b.h < 200 && !(el.parentNode && el.parentNode.querySelector('text'))) continue; // arrowheads
      if (t === 'path' && isFilled && b.w * b.h < 200) continue;
      nodes.push({ el, b, poly: t === 'polygon' ? points(el) : null });
    }
    // HTML laid over the drawing (cards, labels next to it in the same box) takes part when it says what it is
    for (const el of svg.parentElement ? svg.parentElement.querySelectorAll('[data-audit]') : []) {
      if (el instanceof SVGElement || !vis(el)) continue;
      const r = el.dataset.audit, b = rect(el.getBoundingClientRect());
      if (b.w * b.h <= 0) continue;
      if (r === 'label' && label(el)) texts.push({ el, b, r });
      else if (r === 'node' || r === 'overlap-ok') nodes.push({ el, b, poly: null, ok: r === 'overlap-ok' });
    }
    const add = (kind, msg, a, b2) => out.push({ svg: ctx.name, kind, msg, a: a ? where(a) : '', b: b2 ? where(b2) : '' });

    // view box: what can be seen of the drawing (the svg's own box, clipped by its containers)
    const clip = clipOf(svg);
    // an svg that lets its drawing overflow is bounded only by its containers
    if (clip && getComputedStyle(svg).overflow === 'visible') sr.x = clip.x, sr.y = clip.y, sr.w = clip.w, sr.h = clip.h;
    const view = clip ? { x: Math.max(sr.x, clip.x), y: Math.max(sr.y, clip.y), w: Math.min(sr.x + sr.w, clip.x + clip.w) - Math.max(sr.x, clip.x), h: Math.min(sr.y + sr.h, clip.y + clip.h) - Math.max(sr.y, clip.y) } : sr;

    // labels cut off by the drawing's edge
    for (const t of texts) if (t.b.w > 0 && !contains(view, t.b, 1.5)) add('label-cut', '"' + label(t.el) + '" is cut off by the edge of the drawing', t.el);
    for (const n of nodes) if (!n.ok && n.b.w > 0 && !contains(view, n.b, 2)) add('shape-cut', 'a ' + n.el.tagName + ' is cut off by the edge of the drawing', n.el);

    // labels colliding with each other
    for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i], b = texts[j];
      const ov = inter(shrink(a.b, 1), shrink(b.b, 1));
      if (ov > 2) add('label-overlap', '"' + label(a.el) + '" overlaps "' + label(b.el) + '"', a.el, b.el);
    }
    // the box a label belongs to: the smallest node containing its centre (a highlight owns nothing)
    const owner = (t) => { const c = { x: t.b.x + t.b.w / 2, y: t.b.y + t.b.h / 2 }; let best = null; for (const n of nodes) { if (n.ok) continue; const inside = n.poly ? inPoly(c, n.poly) : c.x > n.b.x && c.x < n.b.x + n.b.w && c.y > n.b.y && c.y < n.b.y + n.b.h; if (inside && (!best || n.b.w * n.b.h < best.b.w * best.b.h)) best = n; } return best; };
    for (const t of texts) {
      const o = owner(t);
      t.owner = o;
      if (o) {
        const tb = shrink(t.b, 1);
        const fits = o.poly ? [{ x: tb.x, y: tb.y }, { x: tb.x + tb.w, y: tb.y }, { x: tb.x, y: tb.y + tb.h }, { x: tb.x + tb.w, y: tb.y + tb.h }].every((p) => inPoly(p, o.poly)) : contains(o.b, tb, 0.5);
        if (!fits) add('label-spill', '"' + label(t.el) + '" does not fit inside its ' + o.el.tagName, t.el, o.el);
      }
      // a label lying on a shape it is not inside
      for (const n of nodes) if (n !== o && !n.ok && inter(shrink(t.b, 1), n.b) > 4 && !contains(n.b, t.b, 0) && !(o && contains(n.b, o.b, 1))) add('label-on-shape', '"' + label(t.el) + '" lies across a ' + n.el.tagName, t.el, n.el);
    }
    // shapes overlapping (nesting is fine)
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      if (a.ok || b.ok) continue;
      if (contains(a.b, b.b, 1) || contains(b.b, a.b, 1)) continue;
      if (a.el.parentNode === b.el.parentNode && a.el.tagName === b.el.tagName && Math.abs(a.b.x - b.b.x) < 8 && Math.abs(a.b.y - b.b.y) < 8) continue; // a double border
      let ov = inter(shrink(a.b, 1), shrink(b.b, 1));
      if (ov > 4 && (a.poly || b.poly)) {
        // polygons: check the real outlines
        const pa = a.poly || [{ x: a.b.x, y: a.b.y }, { x: a.b.x + a.b.w, y: a.b.y }, { x: a.b.x + a.b.w, y: a.b.y + a.b.h }, { x: a.b.x, y: a.b.y + a.b.h }, { x: a.b.x, y: a.b.y }];
        const pb = b.poly || [{ x: b.b.x, y: b.b.y }, { x: b.b.x + b.b.w, y: b.b.y }, { x: b.b.x + b.b.w, y: b.b.y + b.b.h }, { x: b.b.x, y: b.b.y + b.b.h }, { x: b.b.x, y: b.b.y }];
        const hit = segs(pa).some(([p, q]) => segs(pb).some(([r, s]) => segX(p, q, r, s))) || pa.some((p) => inPoly(p, pb)) || pb.some((p) => inPoly(p, pa));
        if (!hit) ov = 0;
      }
      if (ov > 4) add('shape-overlap', 'a ' + a.el.tagName + ' and a ' + b.el.tagName + ' overlap' + (label(a.el.parentNode) ? ' ("' + label(a.el.parentNode) + '")' : ''), a.el, b.el);
    }
    // edges: crossings, through shapes, through labels
    const ends = (e) => { const ps = e.pts.filter(Boolean); return ps.length ? [ps[0], ps[ps.length - 1]] : []; };
    const touches = (pt, b, d) => pt.x >= b.x - d && pt.x <= b.x + b.w + d && pt.y >= b.y - d && pt.y <= b.y + b.h + d;
    for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++) {
      const A = segs(edges[i].pts), B = segs(edges[j].pts);
      let hit = null;
      const E = ends(edges[i]).concat(ends(edges[j]));
      for (const [p, q] of A) { for (const [r, s] of B) { hit = segX(p, q, r, s, E); if (hit) break; } if (hit) break; }
      if (hit) {
        // parallel strokes of one double line are one edge
        if (hit.along && edges[i].el.parentNode === edges[j].el.parentNode) continue;
        add(hit.along ? 'edge-overlap' : 'edge-cross', 'two edges ' + (hit.along ? 'run on top of each other' : 'cross') + ' at (' + Math.round(hit.x - sr.x) + ', ' + Math.round(hit.y - sr.y) + ')', edges[i].el, edges[j].el);
      }
    }
    for (const e of edges) {
      const [p0, p1] = ends(e);
      if (!p0) continue;
      for (const n of nodes) {
        if (n.ok) continue;
        if (touches(p0, n.b, 6) || touches(p1, n.b, 6)) continue; // an end of the edge
        if (n.el.parentNode === e.el.parentNode && n.b.w * n.b.h < 200) continue; // a marker drawn on the edge itself (a crow's foot circle)
        if (segs(e.pts).some(([p, q]) => segBox(p, q, shrink(n.b, 2)))) add('edge-through-shape', 'an edge runs through a ' + n.el.tagName + (label(n.el.parentNode) ? ' ("' + label(n.el.parentNode) + '")' : ''), e.el, n.el);
      }
      for (const t of texts) {
        if (t.owner && (touches(p0, t.owner.b, 6) || touches(p1, t.owner.b, 6))) continue;
        if (segs(e.pts).some(([p, q]) => segBox(p, q, shrink(t.b, 1.5)))) add('edge-through-label', 'an edge runs through "' + label(t.el) + '"', e.el, t.el);
      }
    }
  }

  // ---- text in HTML boxes -----------------------------------------------------------------------------------------
  function auditHtml(rootEl, out, ctx) {
    const els = [...rootEl.querySelectorAll('*')].filter((e) => !(e instanceof SVGElement) && e.children.length === 0 && (e.textContent || '').trim() && vis(e));
    for (const e of els) {
      const cs = getComputedStyle(e);
      const clips = /(hidden|clip)/.test(cs.overflow + cs.overflowX + cs.overflowY) || cs.textOverflow === 'ellipsis';
      if (clips && (e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 2) && !e.title) out.push({ svg: ctx.name, kind: 'html-cut', msg: '"' + label(e) + '" is cut off by its box', a: where(e), b: '' });
      if (e.closest('input,textarea,select,option,.ed-hl,.ed-ta,pre,code')) continue;
      const r = rect(e.getBoundingClientRect());
      const c = clipOf(e, rootEl);
      if (c && r.w > 0 && !contains(c, r, 2) && inter(c, r) > 0) out.push({ svg: ctx.name, kind: 'html-cut', msg: '"' + label(e) + '" is partly hidden by a container', a: where(e), b: '' });
    }
  }

  function run(rootEl, opts) {
    rootEl = rootEl || document.body;
    opts = opts || {};
    const out = [];
    const svgs = [...rootEl.querySelectorAll('svg')].filter((s) => vis(s) && !s.closest('button,.btn,.icon,.ic') && s.getBoundingClientRect().width > 40 && s.getBoundingClientRect().height > 40 && !(s.parentNode && s.parentNode.closest('svg')));
    svgs.forEach((s, i) => auditSvg(s, out, { name: (s.getAttribute('class') || s.getAttribute('aria-label') || 'svg') + '#' + i }));
    if (opts.html !== false) auditHtml(rootEl, out, { name: 'html' });
    // one line per distinct problem
    const seen = new Set();
    return out.filter((p) => { const k = p.kind + '|' + p.msg + '|' + p.a + '|' + p.b; if (seen.has(k)) return false; seen.add(k); return true; });
  }
  root.KweryAudit = { run };
})(typeof window !== 'undefined' ? window : globalThis);
