// The Architectures view: shared memory, shared disk, shared nothing and hierarchical systems drawn as boxes and
// wires, their speed-up and scale-up curves as processors are added (K.Cluster.Arch, with start-up cost,
// interference and skew as the brakes), a small queueing simulation of the shared resource, and the interconnect
// topologies with their diameter, degree and bisection width. A stepper moves the processor count along the curves.
(function (root) {
  'use strict';
  const K = root.K;
  const UI = K.UI;
  const { h, s } = UI;
  const C = () => K.Cluster;
  const ARCHS = [['shared-memory', 'Shared memory'], ['shared-disk', 'Shared disk'], ['shared-nothing', 'Shared nothing'], ['hierarchical', 'Hierarchical']];
  const COL = { 'shared-memory': 'c0', 'shared-disk': 'c1', 'shared-nothing': 'c2', hierarchical: 'c3' };
  const TOPOS = [['bus', 'Bus'], ['ring', 'Ring'], ['mesh', 'Mesh'], ['hypercube', 'Hypercube'], ['tree', 'Tree'], ['fat-tree', 'Fat tree']];

  function create(app, el) {
    const CK = UI.CK;
    const o = Object.assign({ arch: 'shared-nothing', max: 64, startup: 1, skew: 1, n: 16, scale: 'batch', topo: 'hypercube', tn: 8 }, UI.store.get('ar.opts', {}));
    const body = h('div.view-body.ck-body');
    el.appendChild(body);
    const save = () => UI.store.set('ar.opts', o);
    const set = (k, v) => { o[k] = v; save(); draw(); };

    function series() {
      const A = C().Arch;
      return ARCHS.map(([a]) => A.curves({ arch: a, maxNodes: o.max, startup: A.ARCH[a].startup * o.startup, skew: A.ARCH[a].skew * o.skew }));
    }
    function draw() {
      const keep = body.scrollTop;
      body.innerHTML = '';
      const A = C().Arch, S = series();
      const ns = S[0].points.map((p) => p.n);
      if (!ns.includes(o.n)) o.n = ns.reduce((a, b) => (Math.abs(b - o.n) < Math.abs(a - o.n) ? b : a));
      body.appendChild(CK.about('A parallel database system gets faster by adding processors (speed-up: the same task in less time, linear if n processors make it n times faster) or bigger at the same speed (scale-up: n times the work on n processors in the same time). Three things keep both below linear: start-up costs, interference on whatever the processors share, and skew, where the slowest partition decides. The architectures differ in what they share: memory, disks, or nothing but the network.'));
      body.appendChild(h('div.ck-controls', CK.seg(ARCHS, o.arch, (v) => set('arch', v))));
      const ar = A.ARCH[o.arch];
      // a phone has room for four processors in the drawing
      const narrow = (body.clientWidth || innerWidth) < 560;
      body.appendChild(CK.section(ar.label + ': shares ' + ar.shares, diagram(o.arch, Math.min(narrow ? 4 : 8, Math.max(2, o.n)), narrow), h('p.ck-note', ar.text + ' In the model: contention σ = ' + ar.sigma + ', coherency κ = ' + ar.kappa + ', so throughput X(n) = n / (1 + σ(n − 1) + κn(n − 1)).')));
      const i = ns.indexOf(o.n);
      const stepper = h('div.ar-stepper', UI.btn('stepBack', null, 'Fewer processors', () => { if (i > 0) set('n', ns[i - 1]); }, 'icon'), h('span.n', 'n = ' + o.n + ' processors'), UI.btn('step', null, 'More processors', () => { if (i < ns.length - 1) set('n', ns[i + 1]); }, 'icon'));
      body.appendChild(h('div.ck-controls', stepper,
        CK.select('Up to', [[16, '16'], [32, '32'], [64, '64'], [128, '128']], o.max, (v) => set('max', v)),
        h('label.ck-field', h('span', 'Start-up cost ×' + o.startup), h('input.ar-range', { type: 'range', min: '0', max: '5', step: '0.5', value: String(o.startup), 'aria-label': 'start-up cost multiplier', onchange: (e) => set('startup', +e.target.value) })),
        h('label.ck-field', h('span', 'Skew ×' + o.skew), h('input.ar-range', { type: 'range', min: '0', max: '5', step: '0.5', value: String(o.skew), 'aria-label': 'skew multiplier', onchange: (e) => set('skew', +e.target.value) }))));
      const sk = o.scale === 'batch' ? 'scaleupBatch' : 'scaleupTx';
      body.appendChild(h('div.ar-two',
        CK.section('Speed-up', chart(S, 'speedup', { max: o.max, linear: true, label: 'speed-up', narrow, fmt: (v) => v.toFixed(1) + '×' })),
        CK.section('Scale-up', CK.seg([['batch', 'Batch'], ['tx', 'Transactions']], o.scale, (v) => set('scale', v)), chart(S, sk, { max: o.max, ymax: 1.05, label: 'scale-up', narrow, flat: true, fmt: (v) => v.toFixed(2) }))));
      const at = S.map((c) => ({ c, p: c.points[i] }));
      body.appendChild(h('p.ck-note', 'At n = ' + o.n + ': ' + at.map(({ c, p }) => c.label.toLowerCase() + ' ' + p.speedup.toFixed(1) + '× faster (' + Math.round(p.efficiency * 100) + '% of linear)').join('; ') + '. ' + (o.scale === 'batch' ? 'Batch scale-up: one job ' + o.n + ' times bigger on ' + o.n + ' processors, time on one processor divided by time on n (1 is linear).' : 'Transaction scale-up: n times the transactions per second on n processors, relative to linear.') + ' Shared memory peaks at ' + A.peak('shared-memory').n + ' processors; past that, adding processors makes it slower.'));
      body.appendChild(simBox());
      body.appendChild(topoBox());
      body.scrollTop = keep;
    }
    function chart(S, key, opts) {
      // on a phone the chart is drawn at about the width it is shown at, so that its text keeps its size
      const W = opts.narrow ? 360 : 520, H = opts.narrow ? 210 : 230, L = 40, R = 78, T = 12, B = 30;
      const xmax = opts.max, ymax = opts.ymax || Math.max(...S.flatMap((c) => c.points.map((p) => p[key]))) * 1.08;
      const X = (n) => L + ((W - L - R) * (n - 1)) / Math.max(1, xmax - 1), Y = (v) => T + (H - T - B) * (1 - v / ymax);
      const svg = s('svg', { class: 'ar-chart', viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': opts.label + ' against the number of processors for four architectures' });
      const g = s('g', { class: 'grid' }), ax = s('g', { class: 'axis' });
      const yt = ymax > 4 ? niceTicks(ymax) : [0, 0.25, 0.5, 0.75, 1].filter((v) => v <= ymax);
      // grid and axis lines are the background; the series are data marks that may cross, and the dots and the
      // dashed linear line are highlights on them
      g.setAttribute('data-audit', 'ignore');
      for (const v of yt) { if (v) g.appendChild(s('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v) })); ax.appendChild(s('text', { x: L - 6, y: Y(v) + 3.5, 'text-anchor': 'end', text: ymax > 4 ? String(v) : v.toFixed(2) })); }
      for (const n of niceTicks(xmax).filter((n) => n >= 1)) ax.appendChild(s('text', { x: X(n), y: H - B + 15, 'text-anchor': 'middle', text: String(n) }));
      ax.appendChild(s('text', { x: (L + W - R) / 2, y: H - 2, 'text-anchor': 'middle', text: 'processors n' }));
      ax.appendChild(s('line', { x1: L, x2: W - R, y1: Y(0), y2: Y(0), 'data-audit': 'ignore' }));
      svg.appendChild(g); svg.appendChild(ax);
      if (opts.linear) svg.appendChild(s('line', { x1: X(1), y1: Y(1), x2: X(Math.min(xmax, ymax)), y2: Y(Math.min(xmax, ymax)), class: 'lin', 'data-audit': 'overlap-ok' }));
      if (opts.flat) svg.appendChild(s('line', { x1: X(1), y1: Y(1), x2: X(xmax), y2: Y(1), class: 'lin', 'data-audit': 'overlap-ok' }));
      // direct labels at the line ends, spread 12 apart and kept between the top and the x axis's labels
      const ends = S.map((c) => ({ c, y: Y(c.points[c.points.length - 1][key]) })).sort((a, b) => a.y - b.y);
      const top = T + 4, bottom = H - B - 4;
      for (let k = 0; k < ends.length; k++) ends[k].y = Math.max(ends[k].y, k ? ends[k - 1].y + 12 : top);
      for (let k = ends.length - 1; k >= 0; k--) ends[k].y = Math.min(ends[k].y, k < ends.length - 1 ? ends[k + 1].y - 12 : bottom);
      for (const c of S) {
        const d = c.points.map((p, j) => (j ? 'L' : 'M') + X(p.n) + ' ' + Y(p[key])).join(' ');
        svg.appendChild(s('path', { d, class: 'ln ' + COL[c.arch] + (c.arch === o.arch ? '' : ' dim'), 'data-audit': 'overlap-ok' }));
      }
      for (const e of ends) svg.appendChild(s('text', { x: W - R + 6, y: e.y + 4, class: 'dl', text: e.c.label.replace('Shared ', 'sh. ').replace('Hierarchical', 'hierarch.') }));
      const cur = S[0].points.findIndex((p) => p.n === o.n);
      svg.appendChild(s('line', { x1: X(o.n), x2: X(o.n), y1: T, y2: H - B, class: 'cur', 'data-audit': 'overlap-ok' }));
      for (const c of S) svg.appendChild(s('circle', { cx: X(o.n), cy: Y(c.points[cur][key]), r: c.arch === o.arch ? 4.5 : 3, class: 'dot ' + COL[c.arch], 'data-audit': 'overlap-ok' }));
      const box = h('div.ar-chartbox', svg, h('div.ck-legend', S.map((c) => h('span', h('i.line.' + COL[c.arch]), c.label)), opts.linear || opts.flat ? h('span', h('i.dash'), 'linear') : null));
      const tip = h('div.ar-tip', { hidden: true });
      box.appendChild(tip);
      const hover = s('line', { x1: 0, x2: 0, y1: T, y2: H - B, class: 'cur', visibility: 'hidden', 'data-audit': 'overlap-ok' });
      svg.appendChild(hover);
      const move = (ev) => {
        const r = svg.getBoundingClientRect();
        const x = ((ev.clientX - r.left) / r.width) * W;
        if (x < L - 10 || x > W - R + 10) { tip.hidden = true; hover.setAttribute('visibility', 'hidden'); return; }
        const pts = S[0].points;
        let j = 0; for (let k = 1; k < pts.length; k++) if (Math.abs(X(pts[k].n) - x) < Math.abs(X(pts[j].n) - x)) j = k;
        hover.setAttribute('x1', X(pts[j].n)); hover.setAttribute('x2', X(pts[j].n)); hover.setAttribute('visibility', 'visible');
        tip.innerHTML = '';
        tip.appendChild(h('b', 'n = ' + pts[j].n));
        for (const c of S) tip.appendChild(h('div', h('i.' + COL[c.arch]), c.label + ' ' + opts.fmt(c.points[j][key])));
        tip.hidden = false;
        const bx = box.getBoundingClientRect();
        tip.style.left = Math.min(bx.width - 170, Math.max(0, ev.clientX - bx.left + 12)) + 'px';
        tip.style.top = Math.max(0, ev.clientY - bx.top - 20) + 'px';
      };
      svg.addEventListener('pointermove', move);
      svg.addEventListener('pointerleave', () => { tip.hidden = true; hover.setAttribute('visibility', 'hidden'); });
      svg.addEventListener('click', (ev) => { const r = svg.getBoundingClientRect(); const x = ((ev.clientX - r.left) / r.width) * W; const pts = S[0].points; let j = 0; for (let k = 1; k < pts.length; k++) if (Math.abs(X(pts[k].n) - x) < Math.abs(X(pts[j].n) - x)) j = k; set('n', pts[j].n); });
      return box;
    }
    function niceTicks(max) { const step = max <= 8 ? 1 : max <= 16 ? 4 : max <= 40 ? 8 : max <= 80 ? 16 : 32; const out = []; for (let v = 0; v <= max + 1e-9; v += step) out.push(v); return out; }

    function diagram(arch, n, narrow) {
      const W = narrow ? 360 : 520, H = 210;
      const svg = s('svg', { class: 'ar-diag', viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': arch + ' with ' + n + ' processors' });
      const xs = (k, x0, x1) => K.range(k).map((i) => (k === 1 ? (x0 + x1) / 2 : x0 + ((x1 - x0) * i) / (k - 1)));
      const P = (x, y, t) => s('g', { class: 'p' }, s('rect', { x: x - 20, y, width: 40, height: 26, rx: 5 }), s('text', { x, y: y + 17, 'text-anchor': 'middle', text: t }));
      const Mm = (x, y, t, w) => s('g', { class: 'm' }, s('rect', { x: x - (w || 40) / 2, y, width: w || 40, height: 22, rx: 4 }), s('text', { x, y: y + 15, 'text-anchor': 'middle', text: t }));
      // a disk: one outline, the cylinder's side and its top
      const D = (x, y, t) => s('g', { class: 'd' }, s('path', { d: 'M' + (x - 16) + ' ' + (y + 4) + ' v18 a16 5 0 0 0 32 0 v-18 a16 5 0 0 0 -32 0 a16 5 0 0 0 32 0' }), s('text', { x, y: y + 22, 'text-anchor': 'middle', text: t }));
      const Net = (x0, x1, y, t) => s('g', { class: 'net' }, s('rect', { x: x0, y, width: x1 - x0, height: 16, rx: 8 }), s('text', { x: (x0 + x1) / 2, y: y + 12, 'text-anchor': 'middle', class: 'lab', text: t }));
      const ln = (x1, y1, x2, y2) => s('line', { x1, y1, x2, y2 });
      const px = xs(n, 50, W - 50);
      if (arch === 'shared-memory') {
        px.forEach((x, i) => { svg.appendChild(ln(x, 36, x, 80)); svg.appendChild(P(x, 10, 'P' + i)); });
        svg.appendChild(Net(30, W - 30, 80, 'memory bus / interconnect'));
        svg.appendChild(ln(W / 2, 96, W / 2, 118)); svg.appendChild(Mm(W / 2, 118, 'shared memory M', 160));
        xs(3, W / 2 - 90, W / 2 + 90).forEach((x, i) => { svg.appendChild(ln(W / 2, 140, x, 168)); svg.appendChild(D(x, 166, 'D' + i)); });
      } else if (arch === 'shared-disk') {
        px.forEach((x, i) => { svg.appendChild(ln(x, 36, x, 46)); svg.appendChild(ln(x, 68, x, 120)); svg.appendChild(P(x, 10, 'P' + i)); svg.appendChild(Mm(x, 46, 'M' + i)); });
        svg.appendChild(Net(30, W - 30, 120, 'storage network'));
        xs(4, 90, W - 90).forEach((x, i) => { svg.appendChild(ln(x, 136, x, 166)); svg.appendChild(D(x, 162, 'D' + i)); });
      } else if (arch === 'shared-nothing') {
        px.forEach((x, i) => { svg.appendChild(s('rect', { x: x - 26, y: 4, width: 52, height: 118, rx: 8, class: 'grp', 'data-audit': 'group' })); svg.appendChild(ln(x, 36, x, 46)); svg.appendChild(ln(x, 68, x, 80)); svg.appendChild(ln(x, 108, x, 150)); svg.appendChild(P(x, 10, 'P' + i)); svg.appendChild(Mm(x, 46, 'M' + i)); svg.appendChild(D(x, 78, 'D' + i)); });
        svg.appendChild(Net(30, W - 30, 150, 'interconnection network'));
        svg.appendChild(s('text', { x: W / 2, y: 190, 'text-anchor': 'middle', class: 'lab', text: 'each node: its own processor, memory and disk' }));
      } else {
        const groups = Math.ceil(n / 2), gx = xs(groups, 80, W - 80);
        gx.forEach((x, g) => {
          svg.appendChild(s('rect', { x: x - 54, y: 4, width: 108, height: 150, rx: 8, class: 'grp', 'data-audit': 'group' }));
          const mine = K.range(n).filter((i) => Math.floor(i / 2) === g);
          xs(mine.length, x - 26, x + 26).forEach((xx, j) => { svg.appendChild(ln(xx, 36, xx, 50)); svg.appendChild(P(xx, 10, 'P' + mine[j])); });
          svg.appendChild(s('line', { x1: x - 46, x2: x + 46, y1: 52, y2: 52, style: 'stroke-width: 3' }));
          svg.appendChild(ln(x, 52, x, 64)); svg.appendChild(Mm(x, 64, 'M' + g, 60)); svg.appendChild(ln(x, 86, x, 98)); svg.appendChild(D(x, 96, 'D' + g)); svg.appendChild(ln(x, 124, x, 168));
        });
        svg.appendChild(Net(30, W - 30, 168, 'network between shared-memory nodes'));
      }
      return svg;
    }
    function simBox() {
      const A = C().Arch;
      const rows = ['shared-memory', 'shared-disk', 'shared-nothing'].map((a) => ({ a, r: A.simulate({ arch: a, n: o.n, think: 10, service: 1, requests: 60, seed: 1 }), one: A.simulate({ arch: a, n: 1, think: 10, service: 1, requests: 60, seed: 1 }) }));
      return CK.section('Interference at n = ' + o.n,
        h('p.ck-note', 'Each processor computes for about 10 time units, then needs a shared resource for about 1: the memory bus or the disk subsystem when it is shared, its own disk under shared nothing. A shared resource saturates once n × 1 approaches 10, and the waits grow.'),
        CK.bars(rows.map(({ a, r, one }) => ({ label: A.ARCH[a].label, value: r.throughput / one.throughput, note: (r.throughput / one.throughput).toFixed(1) + '× one processor · busy ' + Math.round(r.utilization * 100) + '% · wait ' + r.avgWait.toFixed(1), cls: COL[a] })), { max: Math.max(1, o.n) }));
    }
    function topoBox() {
      const A = C().Arch;
      const t = A.topology(o.topo, o.tn);
      const svg = topoDraw(t, o.topo);
      const all = TOPOS.map(([k, l]) => ({ k, l, t: A.topology(k, o.tn) }));
      return CK.section('Interconnection networks',
        h('div.ck-controls', CK.seg(TOPOS, o.topo, (v) => set('topo', v)), CK.select('', [[8, '8 processors'], [16, '16 processors']], o.tn, (v) => set('tn', v))),
        h('div.ck-ringbox', svg, h('div.ck-tbl', h('table.grid.small', h('thead', h('tr', h('th', 'Topology'), h('th.num', 'Diameter'), h('th.num', 'Avg hops'), h('th.num', 'Degree'), h('th.num', 'Bisection'), h('th.num', 'Links'))),
          h('tbody', all.map((x) => h('tr' + (x.k === o.topo ? '.on' : ''), h('td', x.l), h('td.num', String(x.t.diameter)), h('td.num', x.t.avgHops.toFixed(2)), h('td.num', String(x.t.degree)), h('td.num', String(x.t.bisection)), h('td.num', String(x.t.linkCount)))))))),
        h('p.ck-note', 'Diameter: the most hops between two processors. Bisection width: how many links must be cut to split the processors into two halves, a measure of how much traffic can cross the middle. A bus is one shared link; a hypercube of 2^d processors needs d links each but is at most d hops across; a fat tree widens its links toward the root (thicker lines) so the bisection keeps up.'));
    }
    /**
     * an interconnect drawn so that no link crosses another or passes a processor: a bus with the processors above and
     * below it, a ring, a mesh, a hypercube as nested squares (a 4-cube as two 3-cubes, each node joined to its twin in
     * the other), a tree with the processors at the leaves
     */
    function topoDraw(t, kind) {
      const n = t.n, R = 10, at = new Map(), extra = [];
      let W, H;
      const put = (id, x, y) => at.set(id, { x, y });
      const procs = t.nodes.filter((x) => !x.switch).map((x) => x.id);
      if (kind === 'bus') {
        const cols = n > 8 ? Math.ceil(n / 2) : n, gap = 34;
        W = cols * gap + 30; H = n > 8 ? 150 : 100;
        const yb = n > 8 ? H / 2 : H - 26;
        procs.forEach((id, i) => put(id, 15 + gap / 2 + (i % cols) * gap, i < cols ? yb - 42 : yb + 42));
        put('bus', W / 2, yb);
        extra.push(s('rect', { x: 12, y: yb - 5, width: W - 24, height: 10, rx: 5, class: 'sw' }));
      } else if (kind === 'ring') {
        W = H = n > 8 ? 250 : 200;
        const r0 = W / 2 - R - 8;
        procs.forEach((id, i) => { const a = -Math.PI / 2 + (2 * Math.PI * i) / n; put(id, W / 2 + r0 * Math.cos(a), H / 2 + r0 * Math.sin(a)); });
      } else if (kind === 'mesh') {
        const w = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / w), gap = 52;
        W = (w - 1) * gap + 2 * (R + 12); H = (rows - 1) * gap + 2 * (R + 12);
        procs.forEach((id, i) => put(id, R + 12 + (i % w) * gap, R + 12 + Math.floor(i / w) * gap));
      } else if (kind === 'hypercube') {
        // bits 0 and 1 go round a square in Gray-code order, bit 2 picks the outer or the inner square, bit 3 the cube
        const cube = 190, outer = 150, inner = 66, corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
        const cubes = n > 8 ? 2 : 1;
        W = cubes * cube + (cubes - 1) * 30; H = cube + (cubes > 1 ? 44 : 0);
        procs.forEach((id) => {
          const i = Number(id.slice(1)), c = corners[[0, 1, 2, 3].indexOf(i & 3)], half = ((i >> 2) & 1 ? inner : outer) / 2, cx = cube / 2 + ((i >> 3) & 1) * (cube + 30);
          put(id, cx + c[0] * half, cube / 2 + c[1] * half);
        });
        if (cubes > 1) {
          // the 8 links between the cubes would cross the squares: one bracket below stands for them
          const y0 = cube / 2 + outer / 2 + R + 6, y1 = y0 + 14, l = cube / 2, r = cube * 1.5 + 30;
          extra.push(s('path', { d: 'M' + l + ' ' + y0 + ' V' + y1 + ' H' + r + ' V' + y0, class: 'tl twin', 'stroke-width': 3, fill: 'none' }, s('title', { text: 'each processor is linked to the one with the same number plus or minus 8 in the other cube: ' + n / 2 + ' links' })));
          extra.push(s('text', { x: (l + r) / 2, y: y1 + 14, 'text-anchor': 'middle', class: 'lab', text: 'each node ↔ its twin in the other cube (' + n / 2 + ' links)' }));
        }
      } else {
        const levels = Math.round(Math.log2(n)), gap = n > 8 ? 28 : 34, rowH = 46;
        W = n * gap + 10; H = levels * rowH + 2 * (R + 8);
        for (const x of t.nodes) put(x.id, 5 + x.x * n * gap, R + 8 + x.y * levels * rowH);
      }
      const svg = s('svg', { class: 'ar-topo', viewBox: '0 0 ' + W + ' ' + H, style: 'max-width: ' + W + 'px', role: 'img', 'aria-label': kind + ' of ' + t.n + ' processors' });
      for (const [a, b, cap] of t.links) {
        const p = at.get(a), q = at.get(b);
        if (!p || !q) continue;
        // a link to the bus ends at the bus bar, under its processor
        const qq = b === 'bus' ? { x: p.x, y: q.y + (p.y < q.y ? -5 : 5) } : q;
        if (kind === 'hypercube' && (Number(a.slice(1)) ^ Number(b.slice(1))) === 8) continue;
        svg.appendChild(s('line', { x1: p.x, y1: p.y, x2: qq.x, y2: qq.y, class: 'tl', 'stroke-width': 1 + Math.log2(cap || 1) }));
      }
      for (const e of extra) svg.appendChild(e);
      for (const x of t.nodes) {
        const p = at.get(x.id);
        if (!p || x.id === 'bus') continue;
        if (x.switch) svg.appendChild(s('rect', { x: p.x - 7, y: p.y - 7, width: 14, height: 14, rx: 3, class: 'sw' }));
        else svg.appendChild(s('g', {}, s('circle', { cx: p.x, cy: p.y, r: R, class: 'p' }), s('text', { x: p.x, y: p.y + 3.5, 'text-anchor': 'middle', text: x.id.slice(1) })));
      }
      return svg;
    }
    draw();
    return { render() { draw(); }, set, get opts() { return o; } };
  }
  UI.registerView({ id: 'arch', title: 'Architectures', icon: 'screen', group: 'Distributed', order: 63, create });
})(typeof window !== 'undefined' ? window : globalThis);
