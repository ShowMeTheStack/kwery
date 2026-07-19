// Drawing for the index views (the index of a table and the playground): a zoomable canvas, a tidy tree layout,
// and pictures of each structure from its describe() snapshot: B+ trees and B-trees as nodes of keys and
// pointers, hash files as directories or bucket tables with overflow chains, bitmaps as bit rows with their WAH
// words, LSM trees as a memtable over levels of runs with Bloom filters, R-trees, k-d trees and quadtrees as
// rectangles on a plane plus the tree. Highlights (visited, current path, current step, split) come in `hi`.
(function (root) {
  'use strict';
  const K = root.K;
  const UI = K.UI;
  const { h, s } = UI;
  const D = UI.IdxDraw = {};

  // ---- text ---------------------------------------------------------------------------------------------------
  /** the width of monospace text at a font size (the drawing uses the mono font for every label it measures) */
  const tw = (t, px) => String(t).length * (px || 12) * 0.61;
  D.tw = tw;
  const clip = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
  D.val = function (v, t) {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(+v.toFixed(3));
    if (typeof v === 'bigint') return String(v);
    if (typeof v === 'string') return v;
    if (t) { const x = UI.valueText(v, t); if (x !== null) return x; }
    if (K.Decimal && v instanceof K.Decimal) return v.toString();
    return String(v);
  };
  D.key = (key, types, n) => clip((Array.isArray(key) ? key : [key]).map((v, i) => D.val(v, types && types[i])).join(', '), n || 16);
  D.tid = (t) => (t ? '(' + t.b + ',' + t.o + ')' : '');
  D.tidKey = (t) => t.b + ':' + t.o;
  const cx = (...a) => a.filter(Boolean).join(' ');
  // marker ids must be unique in the document: a marker inside a hidden pane does not draw
  let markSeq = 0;

  // ---- the canvas: scroll, zoom, fit, drag to pan ----------------------------------------------------------------
  D.canvas = function (opts) {
    opts = opts || {};
    const scroll = h('div.ix-scroll');
    let z = 1, manual = false, W = 0, H = 0, svg = null, moved = false;
    const zl = h('span.ix-zl', '100%');
    const apply = () => { if (!svg) return; svg.setAttribute('width', Math.ceil(W * z)); svg.setAttribute('height', Math.ceil(H * z)); zl.textContent = Math.round(z * 100) + '%'; };
    const fitZ = (lo) => { const cw = scroll.clientWidth - 16; return cw > 40 && W > 0 ? Math.max(lo, Math.min(1, cw / W)) : 1; };
    const zoom = (f) => { manual = true; const c = [scroll.scrollLeft + scroll.clientWidth / 2, scroll.scrollTop + scroll.clientHeight / 2].map((v) => v / z); z = Math.max(0.2, Math.min(2.5, z * f)); apply(); scroll.scrollLeft = c[0] * z - scroll.clientWidth / 2; scroll.scrollTop = c[1] * z - scroll.clientHeight / 2; };
    const zb = (label, title, f) => h('button.ix-zb', { type: 'button', title, 'aria-label': title, onclick: f }, label);
    const bar = h('div.ix-zoom', zb('−', 'Zoom out', () => zoom(1 / 1.25)), zl, zb('+', 'Zoom in', () => zoom(1.25)), h('button.ix-zb', { type: 'button', title: 'Fit to view', 'aria-label': 'Fit to view', onclick: () => api.fit() }, UI.icon('max')));
    const el = h('div.ix-canvas' + (opts.cls ? '.' + opts.cls : ''), bar, scroll);
    // drag the background to pan
    let drag = null;
    scroll.addEventListener('pointerdown', (e) => { if (e.button !== 0 || e.pointerType === 'touch') return; drag = { x: e.clientX, y: e.clientY, l: scroll.scrollLeft, t: scroll.scrollTop }; moved = false; });
    scroll.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 5) return;
      if (!moved) { moved = true; scroll.setPointerCapture(e.pointerId); scroll.classList.add('panning'); }
      scroll.scrollLeft = drag.l - dx; scroll.scrollTop = drag.t - dy;
    });
    // a view that redraws takes the canvas out of the page and puts it back, which loses its scroll position: keep it
    let kept = [0, 0];
    scroll.addEventListener('scroll', () => { if (scroll.isConnected && scroll.clientWidth) kept = [scroll.scrollLeft, scroll.scrollTop]; });
    const end = () => { drag = null; scroll.classList.remove('panning'); };
    scroll.addEventListener('pointerup', end); scroll.addEventListener('pointercancel', end);
    scroll.addEventListener('click', (e) => { if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; } }, true);
    const api = {
      el, scroll,
      get zoom() { return z; },
      /** home: a box to bring into view (centred, at the top) when there is no focus, as when a new drawing opens */
      show(newSvg, w, hh, focus, home) {
        if (svg && svg.parentNode === scroll) scroll.replaceChild(newSvg, svg); else { scroll.innerHTML = ''; scroll.appendChild(newSvg); }
        svg = newSvg; W = w; H = hh;
        newSvg.setAttribute('viewBox', '0 0 ' + w + ' ' + hh);
        if (!manual) z = fitZ(opts.min || 0.6);
        apply();
        if (focus) api.reveal(focus);
        else if (home) api.home(home);
        else { scroll.scrollLeft = kept[0]; scroll.scrollTop = kept[1]; }
      },
      home(r, tries) {
        // the pane may not be laid out yet: try again on the next frames
        if (!scroll.clientWidth) { if ((tries || 0) < 5) requestAnimationFrame(() => api.home(r, (tries || 0) + 1)); return; }
        if (!manual) { z = fitZ(opts.min || 0.6); apply(); }
        scroll.scrollLeft = Math.max(0, (r.x + r.w / 2) * z - scroll.clientWidth / 2);
        scroll.scrollTop = Math.max(0, r.y * z - 20);
      },
      /** scroll so that a box (in drawing units) is in view */
      reveal(r) {
        const vw = scroll.clientWidth, vh = scroll.clientHeight;
        if (!vw) return;
        const x0 = r.x * z, x1 = (r.x + r.w) * z, y0 = r.y * z, y1 = (r.y + r.h) * z;
        if (x0 < scroll.scrollLeft || x1 > scroll.scrollLeft + vw) scroll.scrollLeft = Math.max(0, (x0 + x1) / 2 - vw / 2);
        if (y0 < scroll.scrollTop || y1 > scroll.scrollTop + vh) scroll.scrollTop = Math.max(0, (y0 + y1) / 2 - vh / 2);
      },
      fit() { manual = true; z = fitZ(0.1); apply(); scroll.scrollLeft = 0; scroll.scrollTop = 0; },
    };
    return api;
  };

  /**
   * Open an HTML-drawn tree fitted: scaled to show it whole (with fitHeight, its height too), but never below 60%,
   * where the text stays readable; what does not fit then scrolls, opening at the root.
   * wrap scrolls; sizer (inside it) takes the scaled size; inner is the W × H drawing; home { x, y, w } in drawing units.
   */
  D.fitHtml = function (wrap, sizer, inner, W, H, home, fitHeight, tries) {
    if (!wrap.clientWidth) { if ((tries || 0) < 8) requestAnimationFrame(() => D.fitHtml(wrap, sizer, inner, W, H, home, fitHeight, (tries || 0) + 1)); return; }
    const cw = wrap.clientWidth - 12, ch = wrap.clientHeight - 12;
    const z = Math.max(0.6, Math.min(1, cw / W, fitHeight && ch > 100 ? ch / H : Infinity));
    inner.style.transformOrigin = '0 0';
    inner.style.transform = z < 1 ? 'scale(' + z + ')' : '';
    Object.assign(sizer.style, { width: W * z + 'px', height: H * z + 'px', overflow: 'hidden', margin: '0 auto', position: 'relative' });
    if (home) { wrap.scrollLeft = Math.max(0, (home.x + home.w / 2) * z - wrap.clientWidth / 2); wrap.scrollTop = Math.max(0, home.y * z - 10); }
  };

  /** FLIP: nodes that kept their key slide from where they were; new ones fade in */
  D.positions = (svg) => { const m = new Map(); if (svg) for (const g of svg.querySelectorAll('[data-key]')) m.set(g.dataset.key, [+g.dataset.x, +g.dataset.y]); return m; };
  D.flip = function (old, svg) {
    if (!old || !old.size || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    for (const g of svg.querySelectorAll('[data-key]')) {
      const p = old.get(g.dataset.key);
      if (!p) { g.classList.add('ix-in'); continue; }
      const dx = p[0] - +g.dataset.x, dy = p[1] - +g.dataset.y;
      if (!dx && !dy) continue;
      g.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
      g.getBoundingClientRect();
      requestAnimationFrame(() => { g.style.transition = 'transform .45s cubic-bezier(.3,.7,.3,1)'; g.style.transform = ''; });
    }
    for (const p of svg.querySelectorAll('.ix-edge, .ix-chain')) p.classList.add('ix-in');
  };

  // ---- trees: items, tidy layout, drawing ----------------------------------------------------------------------
  // An item is { key, label, meta, fill, fillCls, cells: [{ t: 'ptr' | 'key' | 'gap', text, sub, tid, child, cls }],
  // children, cls, chainTo, linkTo, placeholder, empty, virtual }. A cell with `child` (an index into children) has
  // an edge to that child.
  // a node is a box: a header line (its label and, at the right, its meta), then a row of cells, then a fill bar
  const LBL = 16, GAPX = 14, GAPY = 40;
  /** a key's text in lines of about LINE characters, broken after its commas (a composite key's parts) or, for a
   *  long single value, every LINE characters; at most three lines, the end of anything longer left out */
  const LINE = 16;
  const wrapKey = (t) => {
    const lines = [];
    for (const part of String(t).split(/(?<=, )/)) {
      const last = lines.length - 1;
      if (last >= 0 && (lines[last] + part).trimEnd().length <= LINE) { lines[last] += part; continue; }
      for (let i = 0; i < part.length; i += LINE + 4) lines.push(part.slice(i, i + LINE + 4));
    }
    const out = lines.map((l) => l.trimEnd()).filter(Boolean);
    return out.length > 3 ? out.slice(0, 2).concat([clip(out.slice(2).join(''), LINE + 4)]) : out;
  };
  const cellW = (c) => (c.t === 'ptr' ? 14 : c.t === 'gap' ? tw(c.text, 11) + 12 : Math.max(26, Math.max(...c.lines.map((l) => tw(l, 12)), c.sub ? tw(c.sub, 10) : 0) + 14));
  function measure(it) {
    if (it.virtual) { it.w = 0; it.h = 0; return; }
    if (it.empty) { it.w = 14; it.h = 14; return; }
    if (it.placeholder) { it.w = tw(it.text, 11) + 22; it.h = 22; return; }
    it.head = it.label || it.meta ? LBL : 0;
    for (const c of it.cells) if (c.t === 'key') c.lines = wrapKey(c.text);
    // the cells are as tall as the tallest key (lines 14 apart) with its TID below
    it.cellH = Math.max(...it.cells.map((c) => (c.t === 'key' ? 12 + c.lines.length * 14 + (c.sub ? 10 : 0) : 26)));
    it.cw = it.cells.map(cellW);
    const cw = it.cw.reduce((a, b) => a + b, 0);
    it.w = Math.max(cw, tw(it.label || '', 10.5) + (it.meta ? tw(it.meta, 10) + 12 : 0) + 14, 30);
    if (it.w > cw && it.cells.length) { const extra = (it.w - cw) / it.cells.length; it.cw = it.cw.map((w) => w + extra); }
    it.boxH = it.head + it.cellH;
    it.h = it.boxH + (it.fill !== undefined && it.fill !== null ? 7 : 0);
  }
  /**
   * A tidy tree (Reingold–Tilford with contours, for nodes of any width): nodes of one depth share a row; each
   * subtree is pushed against its left siblings as close as their contours allow at every depth, the children are
   * also packed from the right and the two placements averaged (so small subtrees between big ones spread evenly
   * instead of crowding left), and each parent is centred over its first and last child.
   * kids(n) -> children, w(n) -> width; sets n.x (left edge, from 0) and n.depth; returns { W, depth }.
   */
  D.tidy = function (root, kids, w, gap) {
    const all = [];
    // contour of a subtree: per depth below it, [left, right] relative to its root's centre
    const walk = (n, depth) => {
      n.depth = depth; all.push(n);
      const ks = kids(n) || [];
      const half = w(n) / 2;
      if (!ks.length) { n.cont = [[-half, half]]; n.offs = []; return; }
      ks.forEach((k) => walk(k, depth + 1));
      // place the children one by one against the merged contour of those placed so far, from the left (dir 1)
      // or from the right (dir -1); returns each child's centre relative to the first one placed
      const pack = (dir) => {
        const off = new Array(ks.length);
        let acc = null;
        for (let j = 0; j < ks.length; j++) {
          const i = dir > 0 ? j : ks.length - 1 - j, k = ks[i];
          let o = 0;
          if (acc) {
            o = dir * -Infinity;
            for (let d = 0; d < Math.min(acc.length, k.cont.length); d++) {
              o = dir > 0 ? Math.max(o, acc[d][1] - k.cont[d][0] + gap) : Math.min(o, acc[d][0] - k.cont[d][1] - gap);
            }
          }
          off[i] = o;
          k.cont.forEach(([l, r], d) => { acc = acc || []; const a = acc[d]; acc[d] = a ? [Math.min(a[0], l + o), Math.max(a[1], r + o)] : [l + o, r + o]; });
        }
        return off;
      };
      const lo = pack(1), ro = pack(-1);
      // both packings are measured from their first-placed child: line them up on the leftmost child, average
      const shift = lo[0] - ro[0];
      const off = lo.map((v, i) => (v + ro[i] + shift) / 2);
      const mid = (off[0] + off[off.length - 1]) / 2;
      n.offs = off.map((v) => v - mid);
      const cont = [[-half, half]];
      ks.forEach((k, i) => k.cont.forEach(([l, r], d) => { const a = cont[d + 1]; cont[d + 1] = a ? [Math.min(a[0], l + n.offs[i]), Math.max(a[1], r + n.offs[i])] : [l + n.offs[i], r + n.offs[i]]; }));
      n.cont = cont;
    };
    walk(root, 0);
    // absolute centres, then shift so the leftmost point is at 0
    const place = (n, cxv) => { n.cx = cxv; (kids(n) || []).forEach((k, i) => place(k, cxv + n.offs[i])); };
    place(root, 0);
    const left = Math.min(...root.cont.map((c) => c[0])), right = Math.max(...root.cont.map((c) => c[1]));
    for (const n of all) { n.x = n.cx - left - w(n) / 2; delete n.cont; delete n.offs; delete n.cx; }
    return { W: right - left, all };
  };
  /** the tree of items laid out tidily, rows as tall as their tallest node */
  D.layout = function (rootItem) {
    const rowH = [];
    const each = (it) => { measure(it); (it.children || []).forEach(each); };
    each(rootItem);
    const L = D.tidy(rootItem, (it) => it.children, (it) => it.w, GAPX);
    for (const it of L.all) rowH[it.depth] = Math.max(rowH[it.depth] || 0, it.h);
    const ys = [0];
    for (let d = 1; d < rowH.length; d++) ys[d] = ys[d - 1] + rowH[d - 1] + (rowH[d - 1] ? GAPY : 0);
    for (const it of L.all) { it.y = ys[it.depth]; it.rowB = ys[it.depth] + rowH[it.depth]; }
    const H = rowH.reduce((a, r, d) => Math.max(a, ys[d] + r), 0);
    return { items: L.all, W: L.W, H };
  };

  /** draw a tree of items into an <svg>; returns { svg, w, h, focus } */
  D.tree = function (rootItem, o) {
    o = o || {};
    const L = D.layout(rootItem);
    const P = 10;
    const svg = s('svg', { class: 'ix-svg', role: 'img', 'aria-label': o.label || 'Index structure' });
    const edges = s('g'), nodes = s('g');
    svg.appendChild(edges); svg.appendChild(nodes);
    const X = (v) => v + P, Y = (v) => v + P;
    let focus = null;
    const grow = (it) => { const r = { x: X(it.x) - 20, y: Y(it.y) - 10, w: it.w + 40, h: it.h + 20 }; focus = focus ? { x: Math.min(focus.x, r.x), y: Math.min(focus.y, r.y), w: Math.max(focus.x + focus.w, r.x + r.w) - Math.min(focus.x, r.x), h: Math.max(focus.y + focus.h, r.y + r.h) - Math.min(focus.y, r.y) } : r; };
    const mid = 'ixA' + ++markSeq;
    // edges, from the cell holding the pointer to the top of the child: straight down to just below the parent's
    // row, a curve across the gap between the rows, straight down into the child. Every edge between two rows
    // leaves and arrives at the same heights, so edges in pointer order never cross.
    for (const it of L.items) {
      if (it.virtual || !it.cells) continue;
      let xo = 0;
      it.cells.forEach((c, ci) => {
        const w = it.cw[ci];
        if (c.child !== undefined && it.children[c.child]) {
          const ch = it.children[c.child];
          const x1 = X(it.x + xo + w / 2), y1 = Y(it.y + it.boxH), ya = Y(it.rowB) + 3;
          const x2 = X(ch.x + ch.w / 2), y2 = Y(ch.y), yb = y2 - 4;
          const k = (yb - ya) / 2;
          const on = (it.cls || []).includes('path') && (ch.cls || []).includes('path');
          edges.appendChild(s('path', { class: cx('ix-edge', on && 'path', ch.placeholder && 'faint'), d: 'M' + x1 + ' ' + y1 + ' L ' + x1 + ' ' + ya + ' C ' + x1 + ' ' + (ya + k) + ', ' + x2 + ' ' + (yb - k) + ', ' + x2 + ' ' + yb + ' L ' + x2 + ' ' + y2 }));
          if (c.t === 'ptr') edges.appendChild(s('circle', { class: 'ix-dot', cx: x1, cy: Y(it.y + it.head + it.cellH / 2), r: 2.6 }));
        }
        xo += w;
      });
    }
    // leaf chains (and links to a node not yet in its parent), between neighbours on a level, level with the cells
    const levels = new Map();
    for (const it of L.items) if (!it.virtual) { if (!levels.has(it.depth)) levels.set(it.depth, []); levels.get(it.depth).push(it); }
    for (const row of levels.values()) {
      row.sort((a, b) => a.x - b.x);
      row.forEach((a, i) => {
        for (const [prop, cls] of [['chainTo', 'ix-chain'], ['linkTo', 'ix-chain link']]) {
          if (!a[prop]) continue;
          const b = row[i + 1];
          const x1 = X(a.x + a.w) - (prop === 'chainTo' ? 7 : 0);
          const y = Y(a.y + a.head + a.cellH / 2);
          // to the next node when it is the one pointed at; a stub when that node is not drawn (left out, or elsewhere)
          if (b && b.key === a[prop] && b.cells) edges.appendChild(s('path', { class: cls, d: 'M' + x1 + ' ' + y + ' L ' + (X(b.x) - 2) + ' ' + y, 'marker-end': 'url(#' + mid + ')' }));
          else edges.appendChild(s('path', { class: cls, d: 'M' + x1 + ' ' + y + ' L ' + (X(a.x + a.w) + GAPX - 4) + ' ' + y, 'marker-end': 'url(#' + mid + ')' }));
        }
      });
    }
    svg.insertBefore(s('defs', null, s('marker', { id: mid, viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '6', markerHeight: '6', orient: 'auto-start-reverse' }, s('path', { d: 'M0 1 L9 5 L0 9 z', class: 'ix-arrowhead' }))), edges);
    // nodes
    for (const it of L.items) {
      if (it.virtual) continue;
      const x = X(it.x), y = Y(it.y);
      const cls = it.cls || [];
      const g = s('g', { class: cx('ix-node', ...cls, o.onNode && !it.placeholder && !it.empty && 'ix-click'), 'data-key': it.key, 'data-x': x, 'data-y': y });
      if (o.onNode && !it.placeholder && !it.empty) g.addEventListener('click', () => o.onNode(it));
      if (cls.some((c) => c === 'cur' || c === 'split' || c === 'pend' || c === 'hit')) grow(it);
      if (it.empty) { g.appendChild(s('circle', { class: 'ix-nil', cx: x + 7, cy: y + 4, r: 3 })); nodes.appendChild(g); continue; }
      if (it.placeholder) {
        g.appendChild(s('rect', { class: 'ix-ph', x, y, width: it.w, height: 22, rx: 11 }));
        g.appendChild(s('text', { class: 'ix-pht', x: x + it.w / 2, y: y + 15, 'text-anchor': 'middle', text: it.text }));
        nodes.appendChild(g); continue;
      }
      g.appendChild(s('rect', { class: 'ix-box', x, y, width: it.w, height: it.boxH, rx: 6 }));
      if (it.head) {
        // the header band, rounded at the top like the box
        g.appendChild(s('path', { class: 'ix-phead', d: 'M' + (x + 1) + ' ' + (y + it.head) + ' V' + (y + 6) + ' A5 5 0 0 1 ' + (x + 6) + ' ' + (y + 1) + ' H' + (x + it.w - 6) + ' A5 5 0 0 1 ' + (x + it.w - 1) + ' ' + (y + 6) + ' V' + (y + it.head) + ' Z' }));
        g.appendChild(s('line', { class: 'ix-sep', x1: x, y1: y + it.head, x2: x + it.w, y2: y + it.head }));
        if (it.label) g.appendChild(s('text', { class: 'ix-lbl', x: x + 6, y: y + 11.5, text: it.label }));
        if (it.meta) g.appendChild(s('text', { class: 'ix-meta', x: x + it.w - 6, y: y + 11.5, 'text-anchor': 'end', text: it.meta }));
      }
      let xo = 0;
      const top = y + it.head;
      it.cells.forEach((c, ci) => {
        const w = it.cw[ci], cx0 = x + xo, cy0 = top;
        if (ci > 0) g.appendChild(s('line', { class: 'ix-sep', x1: cx0, y1: cy0 + 1, x2: cx0, y2: cy0 + it.cellH - 1 }));
        if (c.t === 'ptr') {
          g.appendChild(s('rect', { class: cx('ix-ptr', c.cls), x: cx0 + 1, y: cy0 + 1, width: w - 2, height: it.cellH - 2, rx: 4 }));
          if (c.child === undefined && !c.next) g.appendChild(s('text', { class: 'ix-nullp', x: cx0 + w / 2, y: cy0 + it.cellH / 2 + 3.5, 'text-anchor': 'middle', text: '·' }));
        } else if (c.t === 'gap') {
          g.appendChild(s('text', { class: 'ix-gap', x: cx0 + w / 2, y: cy0 + it.cellH / 2 + 4, 'text-anchor': 'middle', text: c.text }));
        } else {
          if (c.cls) g.appendChild(s('rect', { class: 'ix-hl ' + c.cls, x: cx0 + 1.5, y: cy0 + 1.5, width: w - 3, height: it.cellH - 3, rx: 4 }));
          if (c.swatch !== undefined) g.appendChild(s('rect', { class: 'ix-sw lv' + c.swatch, x: cx0 + 4, y: cy0 + 4, width: 4, height: it.cellH - 8, rx: 2 }));
          // the key's lines and the TID under them, centred in the cell
          const off = (it.cellH - c.lines.length * 14 - (c.sub ? 10 : 0)) / 2;
          c.lines.forEach((l, li) => g.appendChild(s('text', { class: 'ix-k', x: cx0 + w / 2 + (c.swatch !== undefined ? 2 : 0), y: cy0 + off + 11 + li * 14, 'text-anchor': 'middle', text: l }, c.title ? s('title', { text: c.title }) : null)));
          if (c.sub) {
            const t = s('text', { class: cx('ix-sub', c.tid && o.onTid && 'ix-tid'), x: cx0 + w / 2, y: cy0 + off + c.lines.length * 14 + 9, 'text-anchor': 'middle', text: c.sub }, c.tid ? s('title', { text: 'Open the tuple at TID ' + D.tid(c.tid) + ' in the storage view' }) : null);
            if (c.tid && o.onTid) t.addEventListener('click', (e) => { e.stopPropagation(); o.onTid(c.tid, it); });
            g.appendChild(t);
          }
        }
        xo += w;
      });
      if (it.fill !== undefined && it.fill !== null) {
        g.appendChild(s('rect', { class: 'ix-fillbg', x, y: y + it.boxH + 3, width: it.w, height: 3, rx: 1.5 }));
        g.appendChild(s('rect', { class: cx('ix-fill', it.fillCls), x, y: y + it.boxH + 3, width: Math.max(0, Math.min(1, it.fill)) * it.w, height: 3, rx: 1.5 }));
      }
      nodes.appendChild(g);
    }
    const w = L.W + P * 2, hh = L.H + P * 2;
    const top = rootItem.virtual ? rootItem.children[0] : rootItem;
    return { svg, w, h: hh, focus, home: { x: X(top.x), y: Y(top.y), w: top.w, h: top.h } };
  };

  /** which of n entries to draw: all if few, else the first and last few plus the ones that must show */
  D.pick = function (n, max, force, head, tail) {
    if (n <= max) return [...Array(n).keys()];
    tail = tail === undefined ? 3 : tail;
    const keep = new Set([...Array(head || 3).keys(), ...Array(tail).keys()].map((i, j) => (j < (head || 3) ? i : n - 1 - i)));
    for (const i of force || []) if (i >= 0 && i < n) keep.add(i);
    return [...keep].sort((a, b) => a - b);
  };
  const ph = (key, n, what) => ({ key, placeholder: true, text: '⋯ ' + n + ' ' + what + (n === 1 ? '' : 's'), children: [] });
  const has = (set, v) => !!(set && set.has(v));
  const stateCls = (hi, id) => [has(hi.visited, id) && 'vis', has(hi.path, id) && 'path', has(hi.cur, id) && 'cur', has(hi.split, id) && 'split', has(hi.fresh, id) && 'new', hi.sel === id && 'sel'].filter(Boolean);

  // ---- B+ tree (btree.js describe()) -------------------------------------------------------------------------------
  /**
   * o: { cap: { leaf, internal } (with the fanout option) or null, usable: bytes on a node page, types, hi, max,
   *      pending: [{ node, after }] nodes written by a split but not yet linked into their parent }
   */
  D.bplusItems = function (snap, o) {
    const hi = o.hi || {};
    const max = o.max || 8;
    const pend = o.pending || [];
    // a tree with many leaves keeps only the first and last subtree of each internal node (and those lit up)
    const big = snap.nodes && snap.nodes.filter((n) => n.leaf).length > (o.budget || 32);
    const kidsOf = (cnt, force) => (big ? D.pick(cnt, 2, force, 1, 1) : D.pick(cnt, max, force));
    const marked = (n) => has(hi.path, n.block) || has(hi.cur, n.block) || has(hi.split, n.block) || has(hi.fresh, n.block) || hi.sel === n.block;
    const memo = new Map();
    const deep = (n) => { if (memo.has(n)) return memo.get(n); const v = marked(n) || n.entries.some((e, i) => has(hi.keys, n.block + ':' + i) || (e.tid && has(hi.tids, D.tidKey(e.tid)))) || (n.children || []).some(deep) || pend.some((p) => p.after === n.block); memo.set(n, v); return v; };
    const conv = (n, isRoot, pending) => {
      const E = n.entries, cnt = E.length;
      const cap = o.cap ? (n.leaf ? o.cap.leaf : o.cap.internal) : null;
      const min = o.cap ? (n.leaf ? Math.ceil(o.cap.leaf / 2) : Math.ceil(o.cap.internal / 2)) : null;
      const fill = cap ? cnt / cap : o.usable ? 1 - n.free / o.usable : null;
      const it = {
        key: 'b' + n.block, block: n.block, node: n, label: 'block ' + n.block, meta: cap ? cnt + (n.leaf ? ' / ' + cap + ' keys' : ' / ' + cap + ' ptrs') : fill !== null ? Math.round(fill * 100) + '% full' : '',
        fill, fillCls: !isRoot && !pending && (cap ? cnt < min : fill < 0.5) ? 'low' : (fill >= 0.999 ? 'full' : ''),
        cls: stateCls(hi, n.block).concat(pending ? ['pend'] : []), cells: [], children: [],
      };
      if (n.leaf) {
        const force = []; E.forEach((e, i) => { if (has(hi.keys, n.block + ':' + i) || has(hi.tids, D.tidKey(e.tid))) force.push(i); });
        let prev = -1;
        for (const i of D.pick(cnt, max, force)) {
          if (i > prev + 1) it.cells.push({ t: 'gap', text: '+' + (i - prev - 1) });
          const e = E[i];
          it.cells.push({ t: 'key', text: D.key(e.key, o.types, 200), sub: D.tid(e.tid), tid: e.tid, cls: has(hi.keys, n.block + ':' + i) || has(hi.tids, D.tidKey(e.tid)) ? 'hit' : null, title: D.key(e.key, o.types, 200) });
          prev = i;
        }
        if (!cnt) it.cells.push({ t: 'gap', text: 'empty' });
        it.cells.push({ t: 'ptr', next: true, cls: n.right !== null ? 'chain' : null });
        if (n.right !== null) it.chainTo = 'b' + n.right;
        return it;
      }
      if (!cnt) { it.cells.push({ t: 'gap', text: 'emptied' }); it.meta = 'freed'; return it; }
      const kids = n.children || [];
      const force = []; kids.forEach((c, i) => { if (deep(c)) force.push(i); });
      let prev = -1;
      const addKid = (c) => { it.children.push(c); return it.children.length - 1; };
      for (const i of kidsOf(cnt, force)) {
        if (i > prev + 1) it.cells.push({ t: 'gap', text: '⋯' + (i - prev - 1), child: addKid(ph('g' + n.block + '_' + i, i - prev - 1, 'node')) });
        if (i > 0) it.cells.push({ t: 'key', text: D.key(E[i].key, o.types, 200), title: D.key(E[i].key, o.types, 200) });
        it.cells.push({ t: 'ptr', child: kids[i] ? addKid(conv(kids[i], false)) : undefined });
        // a node split off this child, not yet in this parent: drawn beside it, linked from it
        for (const p of pend) if (kids[i] && p.after === kids[i].block) { const pi = conv(p.node, false, true); pi.children = []; it.children.push(pi); if (!kids[i].leaf) it.children[it.children.length - 2].linkTo = pi.key; }
        prev = i;
      }
      return it;
    };
    const top = conv(snap.tree, true);
    const rootPend = pend.find((p) => p.after === snap.tree.block);
    if (rootPend) { const pi = conv(rootPend.node, false, true); pi.children = []; if (!snap.tree.leaf) top.linkTo = pi.key; return { key: 'virtual', virtual: true, children: [top, pi] }; }
    return top;
  };

  // ---- the B-tree of btree-extra.js (K.BTreeClassic describe()) ---------------------------------------------------------
  D.btreeItems = function (snap, o) {
    const hi = o.hi || {};
    const conv = (n, isRoot) => {
      const it = { key: 'n' + n.id, id: n.id, node: n, label: 'node ' + n.id, meta: n.keys.length + ' / ' + snap.maxKeys + ' keys', fill: n.keys.length / snap.maxKeys, fillCls: !isRoot && n.keys.length < snap.minKeys ? 'low' : '', cls: stateCls(hi, n.id), cells: [], children: [] };
      if (n.leaf) { n.keys.forEach((k) => it.cells.push({ t: 'key', text: D.key(k, null, 10), cls: has(hi.keys, k) ? 'hit' : null })); if (!n.keys.length) it.cells.push({ t: 'gap', text: 'empty' }); return it; }
      // a big tree keeps only the first and last subtree of each node (and those lit up), as the B+ tree does
      const force = []; n.children.forEach((c, i) => { if (deep(c)) force.push(i); });
      let prev = -1;
      for (const i of big ? D.pick(n.children.length, 2, force, 1, 1) : n.children.map((_, j) => j)) {
        if (i > prev + 1) { it.children.push(ph('g' + n.id + '_' + i, i - prev - 1, 'node')); it.cells.push({ t: 'gap', text: '⋯' + (i - prev - 1), child: it.children.length - 1 }); }
        if (i > 0) it.cells.push({ t: 'key', text: D.key(n.keys[i - 1], null, 10), cls: has(hi.keys, n.keys[i - 1]) ? 'hit' : null });
        it.children.push(conv(n.children[i], false));
        it.cells.push({ t: 'ptr', child: it.children.length - 1 });
        prev = i;
      }
      return it;
    };
    const memo = new Map();
    const deep = (n) => { if (memo.has(n)) return memo.get(n); const v = stateCls(hi, n.id).length > 0 || n.keys.some((k) => has(hi.keys, k)) || n.children.some(deep); memo.set(n, v); return v; };
    let count = 0;
    const walk = (n) => { count++; n.children.forEach(walk); };
    walk(snap.root);
    const big = count > (o.budget || 40);
    return conv(snap.root, true);
  };

  // ---- hashing (hash.js describe()) -------------------------------------------------------------------------------------
  const ROW = 17, PHEAD = 21, KEYMAX = 32;
  /** the rows a bucket page shows: entry indices, and { gap: n } for entries left out */
  const pageRows = (p, force) => {
    const n = p.entries.length;
    if (n <= 7) return [...Array(n).keys()];
    const keep = [...new Set([0, 1, 2, 3, ...force.slice(0, 3)])].sort((a, b) => a - b);
    const out = [];
    let prev = -1;
    for (const i of keep) { if (i > prev + 1) out.push({ gap: i - prev - 1 }); out.push(i); prev = i; }
    if (prev < n - 1) out.push({ gap: n - 1 - prev });
    return out;
  };
  /** o: { types, hi: { visited, cur, split, fresh, tids, slots, sel, dir }, onNode, onTid } */
  D.hash = function (snap, o) {
    const hi = o.hi || {};
    const ext = snap.scheme === 'extendible', lin = snap.scheme === 'linear';
    const svg = s('svg', { class: 'ix-svg', role: 'img', 'aria-label': 'Hash index' });
    const edges = s('g'), nodes = s('g');
    svg.appendChild(edges); svg.appendChild(nodes);
    const mh = 'ixH' + ++markSeq;
    svg.insertBefore(s('defs', null, s('marker', { id: mh, viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '6', markerHeight: '6', orient: 'auto' }, s('path', { d: 'M0 1 L9 5 L0 9 z', class: 'ix-arrowhead' }))), edges);
    let focus = null;
    const d = snap.globalDepth || 0;
    const modN = snap.scheme === 'static' ? snap.nbuckets : snap.scheme === 'linear' ? snap.initialBuckets * 2 ** snap.level : 0;
    const modBits = modN && (modN & (modN - 1)) === 0 ? Math.log2(modN) : 0;
    // a page's columns: the key (as wide as the longest, up to KEYMAX characters), the hash bits, the TID
    let keyW = 56, tidW = 40;
    for (const b of snap.buckets) for (const p of b.pages) for (const e of p.entries) { keyW = Math.max(keyW, tw(D.key(e.key, o.types, KEYMAX), 12)); tidW = Math.max(tidW, tw(D.tid(e.tid), 10)); }
    const BITSX = 8 + keyW + 12, PW = Math.max(232, BITSX + tw('0'.repeat(Math.max(8, d, modBits) + 1), 11) + 12 + tidW + 8);
    /** a bucket page: header, entries (key, hash, TID) */
    const page = (b, p, k, x, y) => {
      const force = p.entries.map((e, i) => (has(hi.tids, D.tidKey(e.tid)) ? i : -1)).filter((i) => i >= 0);
      const rows = pageRows(p, force);
      const hh = PHEAD + Math.max(1, rows.length) * ROW + 6;
      const cls = stateCls(hi, p.block);
      const g = s('g', { class: cx('ix-node', 'ix-page', ...cls, o.onNode && 'ix-click'), 'data-key': 'p' + p.block, 'data-x': x, 'data-y': y });
      if (o.onNode) g.addEventListener('click', () => o.onNode({ bucket: b, page: p }));
      if (cls.includes('cur') || cls.includes('split') || cls.includes('new') || force.length) focus = { x: x - 30, y: y - 20, w: PW + 60, h: hh + 40 };
      g.appendChild(s('rect', { class: 'ix-box', x, y, width: PW, height: hh, rx: 7 }));
      g.appendChild(s('rect', { class: 'ix-phead', x: x + 1, y: y + 1, width: PW - 2, height: PHEAD - 2, rx: 6 }));
      g.appendChild(s('text', { class: 'ix-lbl strong', x: x + 8, y: y + 14, text: (k ? 'overflow page' : 'bucket ' + b.bucket) + ' · block ' + p.block }));
      const cap = snap.bucketCapacity;
      g.appendChild(s('text', { class: 'ix-meta', x: x + PW - 8, y: y + 14, 'text-anchor': 'end', text: ext && !k ? 'local depth ' + b.localDepth : p.entries.length + (cap ? ' / ' + cap : '') }));
      rows.forEach((r, row) => {
        const yy = y + PHEAD + row * ROW;
        if (typeof r === 'object') { g.appendChild(s('text', { class: 'ix-gap', x: x + PW / 2, y: yy + 12, 'text-anchor': 'middle', text: '⋯ ' + r.gap + ' more' })); return; }
        const e = p.entries[r];
        if (has(hi.tids, D.tidKey(e.tid))) g.appendChild(s('rect', { class: 'ix-hl hit', x: x + 3, y: yy + 1, width: PW - 6, height: ROW - 1, rx: 4 }));
        g.appendChild(s('text', { class: 'ix-k left', x: x + 8, y: yy + 12.5, text: D.key(e.key, o.types, KEYMAX) }, s('title', { text: D.key(e.key, o.types, 200) })));
        const bits = s('text', { class: 'ix-bits', x: x + BITSX, y: yy + 12.5 }, s('title', { text: 'h = ' + e.bits + ' (0x' + e.hex + ')' }));
        if (ext) {
          bits.appendChild(s('tspan', { class: 'on', text: e.bits.slice(0, d) }));
          bits.appendChild(s('tspan', { text: e.bits.slice(d, Math.max(8, d)) + '…' }));
        } else {
          // bucket = h mod N: when N is a power of two that is the low log2 N bits, lit here
          const nb = modBits;
          bits.appendChild(s('tspan', { text: '…' + e.bits.slice(-Math.max(8, nb), nb ? -nb : undefined) }));
          if (nb) bits.appendChild(s('tspan', { class: 'on', text: e.bits.slice(-nb) }));
        }
        g.appendChild(bits);
        const t = s('text', { class: cx('ix-sub', o.onTid && 'ix-tid'), x: x + PW - 8, y: yy + 12.5, 'text-anchor': 'end', text: D.tid(e.tid) }, s('title', { text: 'Open the tuple at TID ' + D.tid(e.tid) + ' in the storage view' }));
        if (o.onTid) t.addEventListener('click', (ev) => { ev.stopPropagation(); o.onTid(e.tid); });
        g.appendChild(t);
      });
      if (!p.entries.length) g.appendChild(s('text', { class: 'ix-gap', x: x + PW / 2, y: y + PHEAD + 12, 'text-anchor': 'middle', text: 'empty' }));
      nodes.appendChild(g);
      return hh;
    };
    const chain = (b, x, y) => {
      let hmax = 0;
      b.pages.forEach((p, k) => {
        const px = x + k * (PW + 30);
        const hh = page(b, p, k, px, y);
        hmax = Math.max(hmax, hh);
        if (k) edges.appendChild(s('path', { class: 'ix-chain', d: 'M' + (px - 30) + ' ' + (y + 10) + ' L ' + (px - 2) + ' ' + (y + 10), 'marker-end': 'url(#' + mh + ')' }));
      });
      return { h: hmax, w: b.pages.length * (PW + 30) - 30 };
    };
    // a big file shows its first and last buckets (and directory slots) and the ones lit up, with the count left out
    const lit = (b) => b.pages.some((p) => has(hi.cur, p.block) || has(hi.split, p.block) || has(hi.fresh, p.block) || has(hi.path, p.block) || hi.sel === p.block || p.entries.some((e) => has(hi.tids, D.tidKey(e.tid))));
    const gapText = (n, what) => '⋯ ' + n + ' more ' + what + (n === 1 ? '' : 's');
    let W = 0, H = 0;
    if (ext) {
      // directory: one row per slot (or per run of slots on the same bucket when there are many)
      const dir = snap.directory;
      const all = [];
      if (dir.length <= 32) for (const x of dir) all.push({ a: x, b: x, n: 1 });
      else for (const x of dir) { const r = all[all.length - 1]; if (r && r.b.block === x.block) { r.b = x; r.n++; } else all.push({ a: x, b: x, n: 1 }); }
      const byBlock = new Map(snap.buckets.map((b) => [b.block, b]));
      const hot = (r) => (r.a.slot <= (hi.slot ?? -1) && (hi.slot ?? -1) <= r.b.slot) || (byBlock.has(r.a.block) && lit(byBlock.get(r.a.block)));
      const keep = D.pick(all.length, 24, all.map((r, i) => (hot(r) ? i : -1)).filter((i) => i >= 0), 12);
      const rows = [];
      let prev = -1;
      for (const i of keep) { if (i > prev + 1) rows.push({ gap: all.slice(prev + 1, i).reduce((acc, r) => acc + r.n, 0) }); rows.push(all[i]); prev = i; }
      const DX = 0, DW = Math.max(64, tw(all[0] && all.some((r) => r.n > 1) ? 'x'.repeat(d * 2 + 4) : 'x'.repeat(Math.max(d, 1)), 12) + 24, ...rows.filter((r) => r.gap).map((r) => tw(gapText(r.gap, 'slot'), 11) + 16)), RH = 22;
      const BX = DX + DW + 110;
      const top = 22;
      nodes.appendChild(s('text', { class: 'ix-lbl strong', x: DX, y: 12, text: 'directory · i = ' + d }));
      nodes.appendChild(s('text', { class: 'ix-lbl strong', x: BX, y: 12, text: 'buckets' }));
      const dirOn = has(hi.dirAll, true);
      // buckets in the order the directory first points at them; those only the left-out slots point at are counted
      const order = [];
      const seen = new Set();
      for (const r of rows) {
        if (r.gap) { order.push({ gap: 0 }); continue; }
        if (!seen.has(r.a.block)) { seen.add(r.a.block); order.push(r.a.block); }
      }
      const hidden = snap.buckets.filter((b) => !seen.has(b.block)).length;
      const pos = new Map();
      let y = top;
      for (const blk of order) {
        if (blk.gap !== undefined) { if (hidden) { nodes.appendChild(s('text', { class: 'ix-gap', x: BX + 8, y: y + 12, text: gapText(hidden, 'bucket') })); y += 24; } continue; }
        const b = byBlock.get(blk);
        if (!b) continue;
        const c = chain(b, BX, y);
        pos.set(blk, y + 10);
        W = Math.max(W, BX + c.w); y += c.h + 12;
      }
      const dirH = rows.length * RH;
      // centre the directory against the buckets when it is the shorter column
      const dy = Math.max(0, (y - top - dirH) / 2);
      rows.forEach((r, i) => {
        const ry = top + dy + i * RH;
        if (r.gap) { nodes.appendChild(s('text', { class: 'ix-gap', x: DX + DW / 2, y: ry + 14, 'text-anchor': 'middle', text: gapText(r.gap, 'slot') })); return; }
        const slotHit = (r.a.slot <= (hi.slot ?? -1) && (hi.slot ?? -1) <= r.b.slot) || has(hi.path, r.a.block);
        const g = s('g', { class: cx('ix-node', 'ix-slot', (dirOn || slotHit) && 'cur', has(hi.dirVis, true) && 'vis') });
        g.appendChild(s('rect', { class: 'ix-box', x: DX, y: ry, width: DW, height: RH - 2, rx: i === 0 ? 6 : 2 }));
        g.appendChild(s('text', { class: 'ix-k', x: DX + DW / 2, y: ry + 14, 'text-anchor': 'middle', text: d === 0 ? '(any)' : r.n > 1 ? r.a.bits + '–' + r.b.bits : r.a.bits }, s('title', { text: r.n > 1 ? r.n + ' slots, ' + r.a.bits + ' to ' + r.b.bits + ', all on block ' + r.a.block : 'slot ' + r.a.slot + ' → block ' + r.a.block })));
        nodes.appendChild(g);
        const ty = pos.get(r.a.block);
        if (ty !== undefined) edges.appendChild(s('path', { class: cx('ix-edge', slotHit && 'path'), d: 'M' + (DX + DW) + ' ' + (ry + RH / 2 - 1) + ' C ' + (DX + DW + 60) + ' ' + (ry + RH / 2 - 1) + ', ' + (BX - 60) + ' ' + ty + ', ' + (BX - 2) + ' ' + ty, 'marker-end': 'url(#' + mh + ')' }));
      });
      H = Math.max(y, top + dy + dirH);
    } else {
      // the bucket table (bucket number → primary page), then each bucket's chain
      const TX = lin ? 46 : 0, TW = 44, BX = TX + TW + 40, top = 22;
      const list = snap.buckets;
      const keep = D.pick(list.length, 28, list.map((b, i) => (lit(b) || (hi.slot ?? -1) === b.bucket || (lin && b.bucket === snap.next) ? i : -1)).filter((i) => i >= 0), 16);
      nodes.appendChild(s('text', { class: 'ix-lbl strong', x: TX, y: 12, text: lin ? 'h mod ' + snap.initialBuckets * 2 ** snap.level : 'h mod ' + snap.nbuckets }));
      nodes.appendChild(s('text', { class: 'ix-lbl strong', x: BX, y: 12, text: 'buckets' }));
      const span = lin ? snap.initialBuckets * 2 ** snap.level : Infinity;
      let y = top, prev = -1;
      for (const i of keep) {
        if (i > prev + 1) { nodes.appendChild(s('text', { class: 'ix-gap', x: TX, y: y + 12, text: gapText(i - prev - 1, 'bucket') })); y += 26; }
        prev = i;
        const b = list[i];
        const c = chain(b, BX, y);
        const rowH = Math.max(c.h, 24);
        const split = lin && (b.bucket < snap.next || b.bucket >= span);
        const on = (hi.slot ?? -1) === b.bucket || has(hi.path, b.block);
        const g = s('g', { class: cx('ix-node', 'ix-slot', on && 'cur', split && 'split2') });
        g.appendChild(s('rect', { class: 'ix-box', x: TX, y, width: TW, height: 22, rx: 5 }));
        g.appendChild(s('text', { class: 'ix-k', x: TX + TW / 2, y: y + 15, 'text-anchor': 'middle', text: String(b.bucket) }, s('title', { text: split ? 'bucket ' + b.bucket + ': addressed with h mod ' + span * 2 : 'bucket ' + b.bucket })));
        nodes.appendChild(g);
        edges.appendChild(s('path', { class: cx('ix-edge', on && 'path'), d: 'M' + (TX + TW) + ' ' + (y + 10) + ' L ' + (BX - 2) + ' ' + (y + 10), 'marker-end': 'url(#' + mh + ')' }));
        if (lin && b.bucket === snap.next) {
          nodes.appendChild(s('path', { class: 'ix-next', d: 'M' + (TX - 40) + ' ' + (y + 11) + ' L ' + (TX - 6) + ' ' + (y + 11), 'marker-end': 'url(#' + mh + ')' }));
          nodes.appendChild(s('text', { class: 'ix-nextt', x: TX - 42, y: y + 7, text: 'next' }));
        }
        W = Math.max(W, BX + c.w); y += rowH + 12;
      }
      if (lin && snap.next >= list.length) { nodes.appendChild(s('text', { class: 'ix-nextt', x: 0, y: y + 8, text: 'next = ' + snap.next })); y += 14; }
      H = y;
    }
    W += 10; H += 10;
    return { svg, w: Math.max(W, 300), h: H, focus };
  };

  // ---- bitmaps (bitmap.js describe()) ----------------------------------------------------------------------------------
  const CELL = 4, MAXWORDS = 10;
  /** o: { types, bitsPerBlock, hi: { rows: Set of key texts, bits: Map keytext → bit, visitedRows }, onTid, onNode } */
  D.bitmap = function (snap, o) {
    const hi = o.hi || {};
    const svg = s('svg', { class: 'ix-svg', role: 'img', 'aria-label': 'Bitmap index' });
    const per = snap.bitsPerBlock;
    let W = 0, y = 4, focus = null;
    const keys = snap.keys.slice(0, 48);
    const subOf = (k) => k.count + (k.count === 1 ? ' row · ' : ' rows · ') + k.words + (k.words === 1 ? ' word' : ' words');
    // the key column is as wide as its longest key (up to 32 characters) and row summary
    const LW = Math.max(112, ...keys.map((k) => Math.max(tw(D.key(k.key, o.types, 32), 12), tw(subOf(k), 10)) + 22));
    for (const k of keys) {
      const kt = D.key(k.key, o.types, 40);
      const on = has(hi.rows, kt), vis = has(hi.visitedRows, kt);
      const g = s('g', { class: cx('ix-node', 'ix-brow', on && 'cur', vis && 'vis', hi.sel === kt && 'sel', o.onNode && 'ix-click'), 'data-key': 'k' + kt, 'data-x': 0, 'data-y': y });
      if (o.onNode) g.addEventListener('click', () => o.onNode(k));
      g.appendChild(s('rect', { class: 'ix-rowbg', x: 0, y: y - 2, width: 10, height: 34, rx: 6 }));
      g.appendChild(s('text', { class: 'ix-k left strong', x: 8, y: y + 11, text: D.key(k.key, o.types, 32) }, s('title', { text: kt })));
      g.appendChild(s('text', { class: 'ix-sub left', x: 8, y: y + 25, text: subOf(k) }));
      let x = LW, group = 0;
      const hitBit = hi.bits && hi.bits.has(kt) ? hi.bits.get(kt) : null;
      // a long bitmap shows its first and last words and the one holding the lit bit, with the count left out between
      const starts = [];
      for (const w of k.runs) { starts.push(group); group += w.type === 'literal' ? 1 : w.groups; }
      const force = hitBit === null ? [] : [k.runs.findIndex((w, i) => hitBit >= starts[i] * 31 && hitBit < (starts[i] + (w.type === 'literal' ? 1 : w.groups)) * 31)];
      const keep = D.pick(k.runs.length, MAXWORDS, force.filter((i) => i >= 0));
      let prev = -1;
      for (const wi of keep) {
        if (wi > prev + 1) {
          const t = '⋯ ' + (wi - prev - 1) + ' words';
          g.appendChild(s('text', { class: 'ix-gap', x: x + 4, y: y + 10, text: t }));
          x += tw(t, 11) + 14;
        }
        prev = wi;
        const w = k.runs[wi];
        group = starts[wi];
        if (w.type === 'literal') {
          for (let i = 0; i < 31; i++) {
            const pos = group * 31 + i, set = w.bits[i] === '1';
            const c = s('rect', { class: cx('ix-bit', set && 'on', pos === hitBit && 'hit', set && o.onTid && 'ix-tid'), x: x + i * CELL, y, width: CELL - 0.6, height: 13 }, s('title', { text: 'bit ' + pos + ' = ' + (set ? 1 : 0) + ' → TID (' + Math.floor(pos / per) + ',' + ((pos % per) + 1) + ')' }));
            if (set && o.onTid) c.addEventListener('click', (e) => { e.stopPropagation(); o.onTid({ b: Math.floor(pos / per), o: (pos % per) + 1 }); });
            g.appendChild(c);
          }
          g.appendChild(s('text', { class: 'ix-hex', x: x + 31 * CELL / 2, y: y + 25, 'text-anchor': 'middle', text: w.hex }));
          if (hitBit !== null && hitBit >= group * 31 && hitBit < group * 31 + 31) focus = { x: x - 40, y: y - 10, w: 31 * CELL + 80, h: 40 };
          x += 31 * CELL + 6;
        } else {
          const label = w.bit + ' × ' + w.groups + '·31';
          const ww = Math.max(46, tw(label, 10) + 14);
          g.appendChild(s('rect', { class: cx('ix-fillw', w.bit && 'one'), x, y, width: ww, height: 13, rx: 6.5 }, s('title', { text: 'fill word 0x' + w.hex + ': ' + w.groups + ' groups of 31 bits, all ' + w.bit + ' (' + w.bits + ' bits in one word)' })));
          g.appendChild(s('text', { class: 'ix-fillt' + (w.bit ? ' one' : ''), x: x + ww / 2, y: y + 10, 'text-anchor': 'middle', text: label }));
          g.appendChild(s('text', { class: 'ix-hex', x: x + ww / 2, y: y + 25, 'text-anchor': 'middle', text: w.hex }));
          x += ww + 6;
        }
      }
      if (!k.runs.length) g.appendChild(s('text', { class: 'ix-gap', x, y: y + 10, text: 'no bits set' }));
      g.firstChild.setAttribute('width', Math.max(x, 300) + 4);
      if (on && !focus) focus = { x: 0, y: y - 10, w: 300, h: 50 };
      W = Math.max(W, x + 8);
      svg.appendChild(g);
      y += 40;
    }
    if (snap.keys.length > keys.length) { svg.appendChild(s('text', { class: 'ix-gap', x: 8, y: y + 8, text: '⋯ ' + (snap.keys.length - keys.length) + ' more key values' })); y += 18; }
    if (!snap.keys.length) { svg.appendChild(s('text', { class: 'ix-gap', x: 8, y: y + 12, text: 'No key values yet' })); y += 20; }
    return { svg, w: Math.max(W, 320), h: y + 4, focus };
  };

  // ---- LSM trees (lsm.js describe()) -------------------------------------------------------------------------------------
  /** the bits a run's Bloom filter has set, recomputed from its entries the way lsm.js writes them */
  D.bloomSet = function (am, run) {
    if (!am || !am.bloomIdx) return null;
    const set = new Set();
    const texts = new Set();
    for (const p of run.pages) for (const e of p.entries) texts.add(am.bloomText(e.key));
    for (const t of texts) for (const i of am.bloomIdx(t, run.bloom.bits, run.bloom.hashes)) set.add(i);
    return set;
  };
  /** o: { types, am (for the Bloom hash functions), hi: { visited, cur, fresh, tids, runs, probe: { run, value, maybe } }, onNode, onTid } */
  D.lsm = function (snap, o) {
    const hi = o.hi || {};
    const svg = s('svg', { class: 'ix-svg', role: 'img', 'aria-label': 'LSM tree' });
    let y = 2, W = 0, focus = null;
    // the memtable, in memory
    const mt = snap.memtable;
    const mg = s('g', { class: cx('ix-node', has(hi.cur, 'mem') && 'cur') });
    // the entries as chips, in rows of up to 640 units, then "⋯ n more" when there are more than 40
    const chips = [];
    let cxp = 10, row = 0;
    const shown = mt.entries.slice(0, 40);
    const more = mt.entries.length - shown.length;
    for (const e of shown) { const t = D.key(e.key, o.types, KEYMAX); const w = tw(t, 11) + 14; if (cxp > 10 && cxp + w > 640) { cxp = 10; row++; } chips.push({ e, t, x: cxp, w, row }); cxp += w + 5; }
    if (more) { const w = tw('⋯ ' + more + ' more', 11) + 8; if (cxp + w > 640) { cxp = 10; row++; } chips.push({ more, x: cxp, w, row }); }
    const mw = Math.max(280, ...chips.map((c) => c.x + c.w + 10));
    const mh = 34 + row * 26;
    mg.appendChild(s('rect', { class: 'ix-box mem', x: 0, y: y + 16, width: mw, height: mh, rx: 8 }));
    mg.appendChild(s('text', { class: 'ix-lbl strong', x: 0, y: y + 11, text: 'Memtable (in memory, L0)' }));
    mg.appendChild(s('text', { class: 'ix-meta', x: mw, y: y + 11, 'text-anchor': 'end', text: mt.size + ' / ' + mt.capacity + ' entries' }));
    for (const c of chips) {
      const cy = y + 23 + c.row * 26;
      if (c.more) { mg.appendChild(s('text', { class: 'ix-gap', x: c.x + 4, y: cy + 14, text: '⋯ ' + c.more + ' more' })); continue; }
      const hit = has(hi.tids, D.tidKey(c.e.tid));
      mg.appendChild(s('rect', { class: cx('ix-chip', c.e.tomb && 'tomb', hit && 'hit'), x: c.x, y: cy, width: c.w, height: 20, rx: 10 }, s('title', { text: (c.e.tomb ? 'tombstone for ' : '') + D.key(c.e.key, o.types, 200) + ' at TID ' + D.tid(c.e.tid) })));
      mg.appendChild(s('text', { class: cx('ix-k', c.e.tomb && 'tomb'), x: c.x + c.w / 2, y: cy + 14, 'text-anchor': 'middle', text: c.t }));
      if (hit) focus = { x: 0, y, w: mw, h: mh + 26 };
    }
    if (!mt.entries.length) mg.appendChild(s('text', { class: 'ix-gap', x: 12, y: y + 37, text: 'empty' }));
    svg.appendChild(mg);
    W = mw; y += 64 + row * 26;
    // a run's pages are as wide as the longest key on them (up to KEYMAX characters)
    let PGW = 66;
    const KR = 13;
    for (const lv of snap.levels) for (const r of lv.runs) for (const p of r.pages.slice(0, 8)) for (const e of p.entries.slice(0, 5)) PGW = Math.max(PGW, tw((e.tomb ? '✕ ' : '') + D.key(e.key, o.types, KEYMAX), 10.5) + 12);
    for (const lv of snap.levels) {
      svg.appendChild(s('text', { class: 'ix-lbl strong', x: 0, y: y + 11, text: 'Level ' + lv.level + (lv.capacity ? ' · holds up to ' + lv.capacity + ' entries' : ' · up to ' + lv.maxRuns + ' runs') }));
      y += 18;
      let x = 0, rowH = 0;
      for (const r of lv.runs) {
        const pages = r.pages.slice(0, 8);
        const bits = Math.min(r.bloom.bits, 512);
        const cols = Math.min(bits, Math.max(32, Math.floor((Math.max(pages.length, 3) * (PGW + 6)) / 7)));
        const bw = cols * 7;
        const blabel = 'Bloom filter · ' + r.bloom.bits + ' bits · k = ' + r.bloom.hashes + ' · ' + r.bloom.setBits + ' set · false positives ≈ ' + (r.bloom.expectedFp * 100).toFixed(1) + '%';
        const rw = Math.max(pages.length * (PGW + 6) + 14 + (r.pages.length > pages.length ? 40 : 0), bw + 16, tw(blabel, 9.4) + 16, 200);
        const maxKeys = Math.max(1, ...pages.map((p) => Math.min(p.entries.length, 5)));
        const ph = 18 + maxKeys * KR + (pages.some((p) => p.entries.length > 5) ? KR : 0) + 4;
        const bloomRows = Math.ceil(bits / cols);
        const rh = 24 + ph + 24 + bloomRows * 7 + 10;
        const cls = [has(hi.runs, r.id) && 'cur', has(hi.fresh, r.id) && 'new', hi.sel === 'r' + r.id && 'sel', r.pages.some((p) => has(hi.visited, p.block)) && 'vis'];
        const g = s('g', { class: cx('ix-node', ...cls, o.onNode && 'ix-click'), 'data-key': 'r' + r.id, 'data-x': x, 'data-y': y });
        if (o.onNode) g.addEventListener('click', () => o.onNode({ run: r, level: lv.level }));
        g.appendChild(s('rect', { class: 'ix-box run', x, y, width: rw, height: rh, rx: 8 }));
        g.appendChild(s('text', { class: 'ix-lbl strong', x: x + 8, y: y + 15, text: 'run ' + r.id + ' · ' + r.entries + ' entries' + (r.tombstones ? ' · ' + r.tombstones + ' tombstones' : '') }));
        const pr = hi.probes ? hi.probes.get(r.id) || null : hi.probe && hi.probe.run === r.id ? hi.probe : null;
        if (pr) g.appendChild(s('text', { class: 'ix-badge ' + (pr.maybe ? 'maybe' : 'no'), x: x + rw - 8, y: y + 15, 'text-anchor': 'end', text: pr.maybe ? 'Bloom: maybe' : 'Bloom: no, skip' }));
        pages.forEach((p, i) => {
          const px = x + 8 + i * (PGW + 6), py = y + 22;
          const pc = cx('ix-pg', has(hi.visited, p.block) && 'vis', has(hi.cur, p.block) && 'cur');
          g.appendChild(s('rect', { class: pc, x: px, y: py, width: PGW, height: ph, rx: 5 }));
          g.appendChild(s('text', { class: 'ix-meta left', x: px + 5, y: py + 12, text: 'block ' + p.block }));
          p.entries.slice(0, 5).forEach((e, k) => {
            const hit = has(hi.tids, D.tidKey(e.tid));
            if (hit) { g.appendChild(s('rect', { class: 'ix-hl hit', x: px + 2, y: py + 16 + k * KR, width: PGW - 4, height: KR, rx: 3 })); focus = { x: px - 40, y: py - 20, w: PGW + 80, h: ph + 40 }; }
            g.appendChild(s('text', { class: cx('ix-k', 'small', e.tomb && 'tomb'), x: px + PGW / 2, y: py + 26 + k * KR, 'text-anchor': 'middle', text: (e.tomb ? '✕ ' : '') + D.key(e.key, o.types, KEYMAX) }, s('title', { text: (e.tomb ? 'tombstone: ' : '') + D.key(e.key, o.types, 200) + ' at TID ' + D.tid(e.tid) })));
          });
          if (p.entries.length > 5) g.appendChild(s('text', { class: 'ix-gap', x: px + PGW / 2, y: py + 26 + 5 * KR, 'text-anchor': 'middle', text: '+' + (p.entries.length - 5) }));
        });
        if (r.pages.length > pages.length) g.appendChild(s('text', { class: 'ix-gap', x: x + 8 + pages.length * (PGW + 6) + 4, y: y + 22 + ph / 2, text: '+' + (r.pages.length - pages.length) + ' pg' }));
        const by = y + 22 + ph + 8;
        g.appendChild(s('text', { class: 'ix-meta left', x: x + 8, y: by + 9, text: blabel }));
        const set = D.bloomSet(o.am, r);
        const probeBits = pr && o.am ? new Set(o.am.bloomIdx(o.am.bloomText([pr.value]), r.bloom.bits, r.bloom.hashes)) : null;
        for (let i = 0; i < bits; i++) {
          const on = set ? set.has(i) : false;
          g.appendChild(s('rect', { class: cx('ix-bb', on && 'on', probeBits && probeBits.has(i) && 'probe'), x: x + 8 + (i % cols) * 7, y: by + 15 + Math.floor(i / cols) * 7, width: 6, height: 6, rx: 1 }));
        }
        if (r.bloom.bits > bits) g.appendChild(s('text', { class: 'ix-gap', x: x + 8, y: by + 15 + bloomRows * 7 + 10, text: '⋯ ' + (r.bloom.bits - bits) + ' more bits' }));
        if (pr || cls.includes('new')) focus = focus || { x, y, w: rw, h: rh };
        svg.appendChild(g);
        x += rw + 14; rowH = Math.max(rowH, rh + (r.bloom.bits > bits ? 14 : 0));
      }
      W = Math.max(W, x); y += rowH + 16;
    }
    if (!snap.levels.length) { svg.appendChild(s('text', { class: 'ix-gap', x: 0, y: y + 10, text: 'No runs on disk yet: the memtable has not been flushed.' })); y += 20; }
    return { svg, w: W + 4, h: y + 4, focus };
  };

  // ---- the plane: rectangles and points (R-tree, k-d tree, quadtree) ------------------------------------------------------
  /**
   * o: { bounds: [x0, y0, x1, y1], size, rects: [{ r, cls, label }], points: [{ x, y, cls, title }], lines: [{ x1, y1, x2, y2, cls }],
   *      window: [x0, y0, x1, y1], grid: bool, onPoint(x, y), onRect(r) }
   */
  D.plane = function (o) {
    const S = o.size || 320, P = 18;
    const [bx0, by0, bx1, by1] = o.bounds;
    const sc = S / Math.max(bx1 - bx0, by1 - by0, 1e-9);
    const X = (x) => P + (x - bx0) * sc, Y = (y) => P + S - (y - by0) * sc;
    const svg = s('svg', { class: 'ix-plane-svg', viewBox: '0 0 ' + (S + P * 2) + ' ' + (S + P * 2), role: 'img', 'aria-label': o.label || 'The plane' });
    // the background, grid and axes are furniture; rectangles and split lines are regions the points sit in
    svg.appendChild(s('rect', { class: 'ix-pl-bg', x: P, y: P, width: S, height: S, rx: 4, 'data-audit': 'ignore' }));
    if (o.grid !== false) for (let i = 1; i < 4; i++) { svg.appendChild(s('line', { class: 'ix-pl-grid', 'data-audit': 'ignore', x1: P + (S * i) / 4, y1: P, x2: P + (S * i) / 4, y2: P + S })); svg.appendChild(s('line', { class: 'ix-pl-grid', 'data-audit': 'ignore', x1: P, y1: P + (S * i) / 4, x2: P + S, y2: P + (S * i) / 4 })); }
    const ax = (v) => D.val(+v.toFixed(1));
    svg.appendChild(s('text', { class: 'ix-pl-ax', x: P, y: P + S + 13, text: ax(bx0) }));
    svg.appendChild(s('text', { class: 'ix-pl-ax', x: P + S, y: P + S + 13, 'text-anchor': 'end', text: ax(bx1) }));
    svg.appendChild(s('text', { class: 'ix-pl-ax', x: P - 4, y: P + 8, 'text-anchor': 'end', transform: 'rotate(-90 ' + (P - 6) + ' ' + (P + 8) + ')', text: ax(by1) }));
    const clampR = (r) => [Math.max(bx0, r[0]), Math.max(by0, r[1]), Math.min(bx1, r[2]), Math.min(by1, r[3])];
    const boxes = (o.rects || []).map((R) => {
      const r = clampR(R.r);
      const w = Math.max(2, (r[2] - r[0]) * sc), hh = Math.max(2, (r[3] - r[1]) * sc);
      return { R, x: X(r[0]) - (w <= 2 ? 1 : 0), y: Y(r[3]) - (hh <= 2 ? 1 : 0), w, h: hh };
    });
    const pts = (o.points || []).map((p) => ({ p, x: X(p.x), y: Y(p.y), r: p.cls && p.cls.includes('hit') ? 5 : 3.6 }));
    for (const b of boxes) svg.appendChild(s('rect', { class: 'ix-mbr ' + (b.R.cls || ''), x: b.x, y: b.y, width: b.w, height: b.h, rx: 2, 'data-audit': 'group' }, b.R.title ? s('title', { text: b.R.title }) : null));
    // a rectangle's label goes in one of its inside corners, where it crosses no other rectangle's border and
    // touches no point and no other label; when no corner is free it is left out (the tree below names every node)
    const placed = [];
    const meets = (a, b, m) => a.x < b.x + b.w + m && b.x < a.x + a.w + m && a.y < b.y + b.h + m && b.y < a.y + a.h + m;
    const inside = (a, b) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
    for (const b of boxes) {
      if (!b.R.label) continue;
      const lw = tw(b.R.label, 9.5) + 1, lh = 11;
      // inside corners first, then just outside the top and bottom edges
      const spots = [[b.x + 3, b.y + 3], [b.x + b.w - 3 - lw, b.y + 3], [b.x + 3, b.y + b.h - 3 - lh], [b.x + b.w - 3 - lw, b.y + b.h - 3 - lh], [b.x, b.y - lh - 2], [b.x + b.w - lw, b.y - lh - 2], [b.x, b.y + b.h + 2], [b.x + b.w - lw, b.y + b.h + 2]];
      const ok = (q) => inside(q, { x: P + 1, y: P + 1, w: S - 2, h: S - 2 }) && (inside(q, { x: b.x + 2, y: b.y + 2, w: b.w - 4, h: b.h - 4 }) || !meets(q, b, 1.5))
        && boxes.every((c) => c === b || inside(q, { x: c.x + 1.5, y: c.y + 1.5, w: c.w - 3, h: c.h - 3 }) || !meets(q, c, 1.5))
        && pts.every((p) => !meets(q, { x: p.x - p.r, y: p.y - p.r, w: 2 * p.r, h: 2 * p.r }, 1))
        && placed.every((t) => !meets(q, t, 2));
      const at = spots.map(([x, y]) => ({ x, y, w: lw, h: lh })).find(ok);
      if (!at) continue;
      placed.push(at);
      svg.appendChild(s('text', { class: 'ix-mbr-t ' + (b.R.cls || ''), x: at.x, y: at.y + 8.5, text: b.R.label }));
    }
    for (const l of o.lines || []) svg.appendChild(s('line', { class: 'ix-split-l ' + (l.cls || ''), 'data-audit': 'group', x1: X(Math.max(bx0, Math.min(bx1, l.x1))), y1: Y(Math.max(by0, Math.min(by1, l.y1))), x2: X(Math.max(bx0, Math.min(bx1, l.x2))), y2: Y(Math.max(by0, Math.min(by1, l.y2))) }));
    if (o.window) { const r = clampR(o.window); svg.appendChild(s('rect', { class: 'ix-window', 'data-audit': 'overlap-ok', x: X(r[0]), y: Y(r[3]), width: Math.max(1, (r[2] - r[0]) * sc), height: Math.max(1, (r[3] - r[1]) * sc) })); }
    for (const q of pts) svg.appendChild(s('circle', { class: 'ix-pt ' + (q.p.cls || ''), 'data-audit': 'node', cx: q.x, cy: q.y, r: q.r }, s('title', { text: q.p.title || '(' + D.val(q.p.x) + ', ' + D.val(q.p.y) + ')' })));
    // clicks add points, drags make a query window
    if (o.onPoint || o.onRect) {
      svg.classList.add('ix-plane-live');
      const toData = (e) => { const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY; const q = pt.matrixTransform(svg.getScreenCTM().inverse()); return [bx0 + (q.x - P) / sc, by0 + (P + S - q.y) / sc]; };
      let start = null, box = null;
      svg.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; start = toData(e); svg.setPointerCapture(e.pointerId); e.preventDefault(); });
      svg.addEventListener('pointermove', (e) => {
        if (!start) return;
        const c = toData(e);
        if (!box && Math.hypot(c[0] - start[0], c[1] - start[1]) * sc < 6) return;
        if (!box) { box = s('rect', { class: 'ix-window drag', 'data-audit': 'overlap-ok' }); svg.appendChild(box); }
        const r = [Math.min(start[0], c[0]), Math.min(start[1], c[1]), Math.max(start[0], c[0]), Math.max(start[1], c[1])].map((v, i) => Math.max(o.bounds[i % 2], Math.min(o.bounds[2 + (i % 2)], v)));
        box.setAttribute('x', X(r[0])); box.setAttribute('y', Y(r[3])); box.setAttribute('width', (r[2] - r[0]) * sc); box.setAttribute('height', (r[3] - r[1]) * sc);
        box.r = r;
      });
      svg.addEventListener('pointerup', (e) => {
        if (!start) return;
        const c = toData(e), st = start;
        start = null;
        if (box) { const r = box.r; box.remove(); box = null; if (r && o.onRect) o.onRect(r.map((v) => Math.round(v))); return; }
        if (o.onPoint && c[0] >= bx0 && c[0] <= bx1 && c[1] >= by0 && c[1] <= by1) o.onPoint(Math.round(st[0]), Math.round(st[1]));
      });
      svg.addEventListener('pointercancel', () => { start = null; if (box) { box.remove(); box = null; } });
    }
    return svg;
  };

  // ---- R-tree (rtree.js describe()) ----------------------------------------------------------------------------------------
  /** the plane bounds to draw an R-tree (or any point set) in: a square around everything, padded */
  D.squareAround = function (rects) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of rects) { x0 = Math.min(x0, r[0]); y0 = Math.min(y0, r[1]); x1 = Math.max(x1, r[2]); y1 = Math.max(y1, r[3]); }
    if (!Number.isFinite(x0)) return [0, 0, 100, 100];
    const side = Math.max(x1 - x0, y1 - y0, 1) * 1.1;
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    // round outwards so the axis labels are plain numbers
    const r = side > 20 ? 1 : side > 2 ? 0.1 : 0.01;
    const fl = (v) => Math.floor(v / r) * r, sd = Math.ceil(side / r) * r;
    const a = fl(mx - side / 2), b = fl(my - side / 2);
    return [a, b, a + sd + r, b + sd + r];
  };
  D.rtreeNodes = (snap) => { const out = []; const w = (n) => { out.push(n); (n.children || []).forEach(w); }; w(snap.tree); return out; };
  /** the plane: every node's rectangle, coloured by level, and the points */
  D.rtreePlane = function (snap, o) {
    const hi = o.hi || {};
    const nodes = D.rtreeNodes(snap);
    const rects = [], points = [];
    const top = snap.levels - 1;
    for (const n of nodes) {
      if (n.mbr) rects.push({ r: n.mbr, cls: cx('lv' + Math.min(3, top - n.level), has(hi.visited, n.block) && 'vis', has(hi.path, n.block) && 'path', has(hi.cur, n.block) && 'cur', has(hi.split, n.block) && 'split', hi.sel === n.block && 'sel'), label: 'b' + n.block, title: 'node block ' + n.block + ' (level ' + n.level + ')' });
      if (n.leaf) for (const e of n.entries) {
        const isPt = e.mbr[0] === e.mbr[2] && e.mbr[1] === e.mbr[3];
        if (!isPt) rects.push({ r: e.mbr, cls: 'obj' + (has(hi.tids, D.tidKey(e.tid)) ? ' hit' : ''), title: D.key(e.key, o.types, 60) + ' at TID ' + D.tid(e.tid) });
        else points.push({ x: e.mbr[0], y: e.mbr[1], cls: cx(has(hi.tids, D.tidKey(e.tid)) && 'hit', has(hi.found, D.tidKey(e.tid)) && 'found'), title: '(' + D.key(e.key, o.types, 60) + ') at TID ' + D.tid(e.tid) });
      }
    }
    for (const p of o.pending || []) {
      const walk = (n) => { if (n.mbr) rects.push({ r: n.mbr, cls: 'split', label: 'b' + n.block, title: 'new node block ' + n.block + ', not yet in its parent' }); if (n.leaf) for (const e of n.entries) points.push({ x: e.mbr[0], y: e.mbr[1], cls: 'hit' }); };
      walk(p.node);
    }
    rects.sort((a, b) => (b.r[2] - b.r[0]) * (b.r[3] - b.r[1]) - (a.r[2] - a.r[0]) * (a.r[3] - a.r[1]));
    const bounds = o.bounds || D.squareAround(nodes.filter((n) => n.mbr).map((n) => n.mbr));
    return D.plane({ bounds, size: o.size, rects, points, window: hi.window, onPoint: o.onPoint, onRect: o.onRect, label: 'R-tree rectangles' });
  };
  D.rtreeItems = function (snap, o) {
    const hi = o.hi || {};
    const top = snap.levels - 1;
    const conv = (n, isRoot) => {
      const it = { key: 'b' + n.block, block: n.block, node: n, label: 'block ' + n.block, meta: n.entries.length + ' / ' + snap.maxEntries, fill: n.entries.length / snap.maxEntries, fillCls: !isRoot && n.entries.length < snap.minEntries ? 'low' : '', cls: stateCls(hi, n.block), cells: [], children: [] };
      n.entries.forEach((e, i) => {
        if (n.leaf) it.cells.push({ t: 'key', text: D.key(e.key, o.types, 200), sub: D.tid(e.tid), tid: e.tid, cls: has(hi.tids, D.tidKey(e.tid)) ? 'hit' : has(hi.found, D.tidKey(e.tid)) ? 'found' : null, title: 'MBR ' + e.mbr.map((v) => D.val(v)).join(', ') });
        else {
          it.children.push(conv(n.children[i], false));
          it.cells.push({ t: 'key', text: 'b' + e.child, swatch: Math.min(3, top - n.level + 1), child: it.children.length - 1, title: 'MBR x ' + D.val(e.mbr[0]) + '…' + D.val(e.mbr[2]) + ', y ' + D.val(e.mbr[1]) + '…' + D.val(e.mbr[3]) });
          for (const p of pend) if (p.after === e.child) { const pi = conv(p.node, false); pi.cls.push('pend'); pi.children = []; it.children.push(pi); it.children[it.children.length - 2].linkTo = pi.key; }
        }
      });
      if (!n.entries.length) it.cells.push({ t: 'gap', text: 'empty' });
      return it;
    };
    const pend = o.pending || [];
    const topItem = conv(snap.tree, true);
    const rp = pend.find((p) => p.after === snap.tree.block);
    if (rp) { const pi = conv(rp.node, false); pi.cls.push('pend'); pi.children = []; topItem.linkTo = pi.key; return { key: 'virtual', virtual: true, children: [topItem, pi] }; }
    return topItem;
  };

  // ---- k-d tree and quadtree (rtree.js, in memory) --------------------------------------------------------------------------
  const ptKey = (p) => p.x + ',' + p.y;
  D.ptKey = ptKey;
  D.kdPlane = function (snap, o) {
    const hi = o.hi || {};
    const b = o.bounds || [0, 0, 100, 100];
    const lines = [], points = [];
    const fin = (v, d) => (Number.isFinite(v) && v !== null ? v : d);
    const w = (n) => {
      if (!n) return;
      const bb = n.bounds;
      const x0 = fin(bb.x0, b[0]), y0 = fin(bb.y0, b[1]), x1 = fin(bb.x1, b[2]), y1 = fin(bb.y1, b[3]);
      const k = ptKey(n.point);
      if (n.axis === 'x') lines.push({ x1: n.point.x, y1: y0, x2: n.point.x, y2: y1, cls: 'ax-x' + (has(hi.path, k) ? ' path' : '') });
      else lines.push({ x1: x0, y1: n.point.y, x2: x1, y2: n.point.y, cls: 'ax-y' + (has(hi.path, k) ? ' path' : '') });
      points.push({ x: n.point.x, y: n.point.y, cls: cx(has(hi.cur, k) && 'hit', has(hi.found, k) && 'found', has(hi.visited, k) && 'vis') });
      w(n.left); w(n.right);
    };
    w(snap.root);
    return D.plane({ bounds: b, size: o.size, lines, points, window: hi.window, grid: false, onPoint: o.onPoint, onRect: o.onRect, label: 'k-d tree splits' });
  };
  D.kdItems = function (snap, o) {
    const hi = o.hi || {};
    const conv = (n) => {
      if (!n) return null;
      const k = ptKey(n.point);
      const it = { key: 'p' + k, label: 'split on ' + n.axis, cls: stateCls(hi, k).concat(has(hi.found, k) ? ['found'] : []), cells: [{ t: 'key', text: '(' + D.val(n.point.x) + ', ' + D.val(n.point.y) + ')', cls: has(hi.cur, k) ? 'hit' : has(hi.found, k) ? 'found' : null }], children: [] };
      if (n.left || n.right) {
        const l = conv(n.left) || { key: 'nil-l' + k, empty: true }, r = conv(n.right) || { key: 'nil-r' + k, empty: true };
        it.children = [l, r];
        it.cells = [{ t: 'ptr', child: 0 }].concat(it.cells, [{ t: 'ptr', child: 1 }]);
      }
      return it;
    };
    return conv(snap.root) || { key: 'none', label: 'empty tree', cells: [{ t: 'gap', text: 'no points' }], children: [] };
  };
  D.quadPlane = function (snap, o) {
    const hi = o.hi || {};
    const rects = [], points = [];
    const w = (n) => {
      const k = n.bounds.join(',');
      rects.push({ r: n.bounds, cls: cx('quad', has(hi.visited, k) && 'vis', has(hi.cur, k) && 'cur', has(hi.split, k) && 'split') });
      for (const p of n.points) points.push({ x: p.x, y: p.y, cls: cx(has(hi.tids, ptKey(p)) && 'hit', has(hi.found, ptKey(p)) && 'found') });
      n.children.forEach(w);
    };
    w(snap.root);
    const bounds = o.bounds && snap.root.bounds[2] - snap.root.bounds[0] <= o.bounds[2] - o.bounds[0] ? o.bounds : snap.root.bounds;
    return D.plane({ bounds, size: o.size, rects, points, window: hi.window, grid: false, onPoint: o.onPoint, onRect: o.onRect, label: 'Quadtree squares' });
  };
  D.quadItems = function (snap, o) {
    const hi = o.hi || {};
    const Q = ['SW', 'SE', 'NW', 'NE'];
    const conv = (n) => {
      const k = n.bounds.join(',');
      const it = { key: 'q' + k, label: '[' + n.bounds.map((v) => D.val(v)).join(', ') + ']', cls: stateCls(hi, k), cells: [], children: [] };
      if (n.children.length) { n.children.forEach((c, i) => { it.children.push(conv(c)); it.cells.push({ t: 'key', text: Q[i], child: i }); }); return it; }
      for (const p of n.points) it.cells.push({ t: 'key', text: '(' + D.val(p.x) + ', ' + D.val(p.y) + ')', cls: has(hi.tids, ptKey(p)) ? 'hit' : has(hi.found, ptKey(p)) ? 'found' : null });
      if (!n.points.length) it.cells.push({ t: 'gap', text: 'empty' });
      return it;
    };
    return conv(snap.root);
  };

  // ---- small pieces of page furniture ----------------------------------------------------------------------------------------
  /** a row of figures: [[label, value, cls?, title?]] */
  D.stats = (list) => h('div.ix-stats', list.filter(Boolean).map(([l, v, c, t]) => h('div.ix-stat' + (c ? '.' + c : ''), { title: t || null }, h('div.ix-sv', String(v)), h('div.ix-sl', l))));
  D.legend = (list) => h('div.ix-legend', list.map(([c, l]) => h('span.ix-lg', h('i.' + c), l)));

  // ---- a line chart with a hover crosshair ----------------------------------------------------------------------------------
  const nice = (v) => { if (v <= 0) return 1; const e = 10 ** Math.floor(Math.log10(v)); const f = v / e; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * e; };
  /**
   * o: { series: [{ name, c: 1 | 2, pts: [[x, y]], dots: bool }], x: { label, max, fmt }, y: { label, max, fmt }, marks: [{ x, label }], height }
   * Lines are 2px, dots ringed in the surface colour; one y axis; a legend for two series.
   */
  D.chart = function (o) {
    const W = 560, H = o.height || 230, L = 46, R = 14, T = 12, B = 34;
    const xmax = o.x.max || Math.max(1, ...o.series.flatMap((se) => se.pts.map((p) => p[0])));
    const ymax0 = o.y.max || Math.max(...o.series.flatMap((se) => se.pts.map((p) => p[1])), 0);
    const ystep = nice((ymax0 || 1) / 4), ymax = o.y.max || ystep * Math.ceil((ymax0 || 1) / ystep);
    const xstep = nice(xmax / 5);
    const X = (x) => L + (x / xmax) * (W - L - R), Y = (y) => T + (1 - y / ymax) * (H - T - B);
    const fx = o.x.fmt || ((v) => String(+v.toFixed(2))), fy = o.y.fmt || ((v) => String(+v.toFixed(3)));
    const svg = s('svg', { class: 'ix-chart', viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': o.label || '' });
    // grid lines and the vertical marks are guides drawn under the data; the series may cross each other and them
    for (let y = 0; y <= ymax + 1e-9; y += o.y.step || ystep) { svg.appendChild(s('line', { class: y ? 'grid' : 'axis', 'data-audit': 'ignore', x1: L, x2: W - R, y1: Y(y), y2: Y(y) })); svg.appendChild(s('text', { class: 'tick', x: L - 6, y: Y(y) + 3.5, 'text-anchor': 'end', text: fy(y) })); }
    for (let x = 0; x <= xmax + 1e-9; x += o.x.step || xstep) svg.appendChild(s('text', { class: 'tick', x: X(x), y: H - B + 15, 'text-anchor': 'middle', text: fx(x) }));
    svg.appendChild(s('text', { class: 'atitle', x: (L + W - R) / 2, y: H - 3, 'text-anchor': 'middle', text: o.x.label }));
    svg.appendChild(s('text', { class: 'atitle', x: 11, y: (T + H - B) / 2, 'text-anchor': 'middle', transform: 'rotate(-90 11 ' + (T + H - B) / 2 + ')', text: o.y.label }));
    // labels (mark names, end values) are placed where they meet no other label: [x0, y0, x1, y1] boxes
    const taken = [];
    const free = (b) => taken.every((t) => b[2] < t[0] - 2 || b[0] > t[2] + 2 || b[3] < t[1] - 1 || b[1] > t[3] + 1);
    const lw = (t, px) => String(t).length * px * 0.56;
    for (const m of o.marks || []) {
      svg.appendChild(s('line', { class: 'now', 'data-audit': 'ignore', x1: X(m.x), x2: X(m.x), y1: T, y2: H - B }));
      const w = lw(m.label, 10.5);
      // to the right of the line, or to its left near the right edge; lower down when another mark's label is there
      const right = X(m.x) + 4 + w <= W - R;
      let y = T + 9;
      const box = (yy) => (right ? [X(m.x) + 4, yy - 9, X(m.x) + 4 + w, yy + 3] : [X(m.x) - 4 - w, yy - 9, X(m.x) - 4, yy + 3]);
      while (!free(box(y)) && y < H - B - 12) y += 13;
      taken.push(box(y));
      svg.appendChild(s('text', { class: 'tick', x: right ? X(m.x) + 4 : X(m.x) - 4, y, 'text-anchor': right ? 'start' : 'end', text: m.label }));
    }
    for (const se of o.series) {
      if (se.dots) for (const p of se.pts) svg.appendChild(s('circle', { class: 'd' + se.c, 'data-audit': 'overlap-ok', cx: X(p[0]), cy: Y(Math.min(p[1], ymax)), r: 4 }));
      else if (se.pts.length) svg.appendChild(s('path', { class: 's' + se.c, 'data-audit': 'overlap-ok', d: se.pts.map((p, i) => (i ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(Math.min(p[1], ymax)).toFixed(1)).join(' ') }));
    }
    for (const se of o.series) for (const p of se.end ? [se.pts[se.pts.length - 1]] : []) {
      if (!p) continue;
      const px = X(p[0]), py = Y(Math.min(p[1], ymax)), t = se.endLabel || fy(p[1]), w = lw(t, 11);
      svg.appendChild(s('circle', { class: 'd' + se.c, 'data-audit': 'overlap-ok', cx: px, cy: py, r: 4 }));
      // above the end point, else below it
      const ys = [py - 8, py + 17].map((y) => Math.max(T + 10, Math.min(H - B - 4, y)));
      const y = ys.find((yy) => free([px - 6 - w, yy - 10, px - 6, yy + 3])) ?? ys[0];
      taken.push([px - 6 - w, y - 10, px - 6, y + 3]);
      svg.appendChild(s('text', { class: 'lbl', x: px - 6, y, 'text-anchor': 'end', text: t }));
    }
    // hover: the nearest x, every series' value there
    const hl = s('line', { class: 'hover-l', y1: T, y2: H - B, visibility: 'hidden' });
    svg.appendChild(hl);
    const tip = h('div.ix-tip', { hidden: true });
    const box = h('div.ix-chartwrap', { style: { position: 'relative' } }, svg, tip);
    svg.appendChild(s('rect', { class: 'hit', x: L, y: T, width: W - L - R, height: H - T - B }));
    const move = (e) => {
      const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
      const q = pt.matrixTransform(svg.getScreenCTM().inverse());
      const xv = ((q.x - L) / (W - L - R)) * xmax;
      const rows = [];
      let at = null;
      for (const se of o.series) {
        if (!se.pts.length) continue;
        let best = se.pts[0];
        for (const p of se.pts) if (Math.abs(p[0] - xv) < Math.abs(best[0] - xv)) best = p;
        if (at === null || Math.abs(best[0] - xv) < Math.abs(at - xv)) at = best[0];
        rows.push([se, best]);
      }
      if (at === null) return;
      hl.setAttribute('x1', X(at)); hl.setAttribute('x2', X(at)); hl.setAttribute('visibility', 'visible');
      tip.innerHTML = '';
      tip.appendChild(h('div', h('b', o.x.label + ': ' + fx(at))));
      for (const [se, p] of rows) tip.appendChild(h('div', h('span', { style: { color: 'var(--ix-c' + se.c + ')' } }, '● '), se.name + ': ' + fy(p[1]) + (p[0] !== at ? ' (at ' + fx(p[0]) + ')' : '')));
      tip.hidden = false;
      const r = box.getBoundingClientRect();
      const left = e.clientX - r.left + 12;
      tip.style.left = Math.min(left, r.width - tip.offsetWidth - 4) + 'px';
      tip.style.top = Math.max(0, e.clientY - r.top - 40) + 'px';
    };
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerleave', () => { tip.hidden = true; hl.setAttribute('visibility', 'hidden'); });
    return box;
  };
  /** the legend of a chart: [{ name, c, dots }] */
  D.chartKeys = (list) => h('div.ix-keys', list.map((x) => h('span', h('i.c' + x.c + (x.dots ? '.dot' : '')), x.name)));
})(typeof window !== 'undefined' ? window : globalThis);
