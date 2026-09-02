// The Cluster view's scenarios: partitioning a Theatre table, replication (primary copy and quorums), CAP,
// two- and three-phase commit, distributed deadlock detection, Raft and Paxos. Each one builds a K.Cluster
// simulation, says what to capture in every frame and how to draw it; the kit in cluster.js records and plays it.
(function (root) {
  'use strict';
  const K = root.K;
  const UI = K.UI;
  const { h, s } = UI;
  const CK = UI.CK = UI.CK || {};
  const SC = CK.scenarios = CK.scenarios || [];
  const C = () => K.Cluster;
  const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => [n, 'seed ' + n]);
  const seedCtl = (o, set) => CK.select('', SEEDS, o.seed, (v) => set('seed', v), 'Random seed: another seed, another run (each run is reproducible)');
  const B = (label, value) => h('span', label + ' ', h('b', String(value)));
  const dot = (id) => h('i.ck-dot.c' + ((Number(String(id).replace(/\D/g, '')) || 1) - 1) % 8);
  const hist = (items) => h('ul.ck-hist', items);
  const tm = (t) => h('span.tm', 't ' + Math.round(t));

  // ---- partitioning -------------------------------------------------------------------------------------------
  const PTABLES = ['booking', 'patron', 'performance', 'production', 'casting', 'artist', 'person', 'mentor'];
  const SCHEMES = [['round-robin', 'Round-robin'], ['hash', 'Hash: h(key) mod n'], ['range-width', 'Range, equal-width boundaries'], ['range', 'Range, equi-depth boundaries'], ['virtual', 'Virtual nodes (4 per node)'], ['consistent', 'Consistent hashing ring']];
  SC.push({
    id: 'partition', title: 'Partitioning a table', group: 'Data placement',
    about: 'Partitioning spreads the rows of a relation over the nodes (each node here is a real database): round-robin deals rows out evenly, hash partitioning sends a row to h(key) mod n, and range partitioning gives each node a range of keys. Pick a table, key and scheme to see the rows per node and the skew (the slowest node decides how long a parallel scan takes); add or remove a node to see which rows have to move, and with consistent hashing only the keys on the new node\'s arcs move.',
    defaults: { table: 'booking', key: 'patron_id', scheme: 'consistent', n: 3, vnodes: 8 },
    slow: 'Loading the Theatre database into the cluster…',
    controls(o, set) {
      if (!PTABLES.includes(o.table)) o.table = 'booking';
      const T = CK.theatre().tables[o.table];
      if (!T.cols.some((c) => c.name === o.key)) o.key = T.cols[0].name;
      return [
        CK.select('Table', PTABLES.map((t) => [t, t]), o.table, (v) => { o.key = CK.theatre().tables[v].cols[0].name; set('table', v); }),
        CK.select('Key', T.cols.map((c) => [c.name, c.name + ' (' + c.type + ')']), o.key, (v) => set('key', v)),
        CK.select('Scheme', SCHEMES, o.scheme, (v) => set('scheme', v)),
        CK.select('Nodes', [2, 3, 4, 5, 6].map((n) => [n, n + ' nodes']), o.n, (v) => set('n', v)),
        o.scheme === 'consistent' ? CK.select('Points per node', [1, 2, 4, 8, 32].map((n) => [n, n + (n === 1 ? ' point' : ' points')]), o.vnodes, (v) => set('vnodes', v), 'Virtual nodes: how many points each node has on the ring') : null,
      ];
    },
    start(o) { return partitionSrc(o); },
  });

  function partitionSrc(o) {
    if (!PTABLES.includes(o.table)) o.table = 'booking';
    const P = C().Partition, u = CK.theatre(), T = u.tables[o.table];
    const ki = T.cols.findIndex((c) => c.name === o.key), type = T.cols[ki].type;
    const numeric = P.isNumType(type);
    let scheme = o.scheme === 'range-width' && !numeric ? 'range' : o.scheme;
    const notes = [];
    if (o.scheme === 'range-width' && !numeric) notes.push('Equal-width boundaries need a numeric key; ' + o.key + ' is ' + type + ', so the boundaries are equi-depth.');
    const first = K.range(o.n).map((i) => 'n' + (i + 1));
    const keys = T.rows.map((r) => r[ki]);
    let ops = [], seq = o.n, sh = null, rec = null;

    function build(list) {
      rec = new CK.Rec();
      if (scheme === 'virtual') {
        const r = P.virtualNodes(T.rows, o.n, o.n * 4, { key: ki, type });
        const sizes = {}; first.forEach((id, i) => { sizes[id] = r.sizes[i]; });
        rec.add(0, [], { nodes: first.slice(), sizes, virtual: r });
        sh = null;
        return;
      }
      sh = new P.Shards({ scheme: scheme === 'range-width' ? 'range' : scheme, nodes: first, vnodes: o.vnodes, seed: 1 });
      sh.load(T, { key: o.key, bounds: scheme === 'range-width' ? P.equiWidth(keys, o.n) : undefined });
      rec.add(0, [], snapOf(sh.sizes(), null));
      for (const op of list) runOp(op);
    }
    function snapOf(sizes, last, nodes) { return { nodes: nodes || sh.nodes.slice(), sizes: Object.assign({}, sizes), ring: sh.scheme === 'consistent' ? sh.ring.view() : null, bounds: sh.bounds ? sh.bounds.slice() : null, last }; }
    function wouldMove(before, after) {
      // the rows hash mod n would move for the same change of membership
      let n = 0;
      for (const k of keys) { const hh = P.hashOf(k, type); if (before[hh % before.length] !== after[hh % after.length]) n++; }
      return n;
    }
    function runOp(op) {
      const before = sh.nodes.slice(), sizes0 = sh.sizes();
      const t0 = sh.net.trace.length;
      const res = op.kind === 'add' ? sh.addNode(op.id) : sh.removeNode(op.id);
      if (!res) return;
      const after = sh.nodes.slice();
      const all = [...new Set(before.concat(after))];
      const sizes = Object.assign({}, sizes0); if (sizes[op.id] === undefined) sizes[op.id] = 0;
      const tos = [...new Set(res.moves.map((m) => m.to))], froms = [...new Set(res.moves.map((m) => m.from))];
      const last = { kind: op.kind, id: op.id, moved: res.moved, total: res.total, fraction: res.fraction, tos, froms, hashWould: wouldMove(before, after), movedKeys: [...new Set(res.moves.map((m) => m.key))], n: before.length };
      op.fi = rec.add(sh.net.clock, [], snapOf(sizes, last, all), { user: (op.kind === 'add' ? op.id + ' joins the cluster: ' : op.id + ' leaves the cluster: ') + res.moved + ' of ' + res.total + ' rows (' + (res.fraction * 100).toFixed(1) + '%) must move' + (op.kind === 'add' ? ', ' + (tos.length === 1 && tos[0] === op.id ? 'all of them to ' + op.id : 'to ' + tos.join(', ')) : ', from ' + froms.join(', ') + ' to ' + tos.join(', ')) }).i;
      const moveOf = new Map();
      CK.fromTrace(sh.net.trace.slice(t0), {
        rec,
        group: (e) => e.kind + '|' + e.t + '|' + e.from + '|' + e.to + '|' + e.node,
        apply: (e) => {
          if (e.kind === 'send' && e.type === 'move-row') moveOf.set(e.msg, [e.from, e.to]);
          if (e.kind === 'deliver' && moveOf.has(e.msg)) { const [a, b] = moveOf.get(e.msg); sizes[a]--; sizes[b] = (sizes[b] || 0) + 1; }
        },
        snap: () => snapOf(sizes, last, all),
      });
      rec.add(sh.net.clock, [], snapOf(sh.sizes(), last, after), { user: 'Rows per node now: ' + after.map((id) => id + ' ' + sh.sizes()[id]).join(', ') + (op.kind === 'remove' ? '; ' + op.id + ' has left' : '') });
    }
    build(ops);
    const src = {
      base: 6, noCrash: true, noLinks: true,
      get rec() { return rec; },
      intervene(i, op) {
        if (op.kind === 'add') op = { kind: 'add', id: 'n' + (++seq) };
        const keep = ops.filter((x) => x.fi !== undefined && x.fi <= i);
        if (keep.length === ops.length && i === rec.last) { ops.push(op); runOp(op); }
        else { ops = keep.concat([op]); build(ops); }
        return op.fi === undefined ? rec.last : op.fi;
      },
      layout(f, w) {
        const ids = f.s.nodes;
        // rows move between any two nodes: each node hangs on the network hub, and a moving row goes in along its
        // sender's spoke and out along its receiver's
        return { height: ids.length > 4 ? 380 : 320, nodes: CK.circle(ids, { narrow: w < 520 }).concat([{ id: CK.HUB, x: 0.5, y: 0.5, kind: 'hub' }]), links: CK.spokes(ids) };
      },
      card(id, f) {
        const st = f.s, n = st.sizes[id] || 0, total = Object.values(st.sizes).reduce((a, b) => a + b, 0);
        const leaving = st.last && st.last.kind === 'remove' && st.last.id === id;
        const share = st.ring && st.ring.shares[id] !== undefined ? 'ring ' + (st.ring.shares[id] * 100).toFixed(1) + '%' : 'share ' + (total ? ((100 * n) / total).toFixed(1) : 0) + '%';
        return { title: h('span', dot(id), id), badge: leaving ? 'leaving' : st.last && st.last.id === id ? 'new' : null, badgeCls: leaving ? 'warn' : 'acc', lines: [B('rows', n), share], cls: leaving ? 'warn' : '' };
      },
      menu(id, f) {
        if (!sh) return [];
        return f.s.nodes.length > 1 ? [{ label: 'Remove ' + id + ' from the cluster', icon: 'trash', op: { kind: 'remove', id } }] : [];
      },
      actions(f) {
        if (!sh) return [];
        return [
          { label: 'Add a node', icon: 'plus', primary: true, title: 'A new node joins; the rows it now owns move to it', op: { kind: 'add' } },
          f.s.nodes.length > 1 ? { label: 'Remove ' + f.s.nodes[f.s.nodes.length - 1], icon: 'trash', title: 'The node leaves; its rows move to the others', op: { kind: 'remove', id: f.s.nodes[f.s.nodes.length - 1] } } : null,
        ].filter(Boolean);
      },
      note: (e) => (e.kind === 'note' && e.what === 'join' ? e.node + ' joins' : e.kind === 'note' && e.what === 'leave' ? e.node + ' has handed over its rows and leaves' : undefined),
      panel(el, f) {
        const st = f.s, ids = st.nodes, sizes = ids.map((id) => st.sizes[id] || 0);
        const sk = P.skew(sizes);
        for (const t of notes) el.appendChild(h('p.ck-note', t));
        el.appendChild(CK.section('Rows per node',
          CK.bars(ids.map((id) => ({ label: id, value: st.sizes[id] || 0, cls: 'c' + ((Number(id.slice(1)) - 1) % 8) }))),
          h('p.ck-note', 'Largest ' + sk.max + ', mean ' + CK.fix(sk.mean, 1) + ': max/mean = ' + sk.ratio + '. A parallel scan waits for the largest partition, so it runs ' + sk.ratio + '× as long as a perfectly balanced one' + (sk.ratio > 1.15 ? ' (skew).' : ' (well balanced).'))));
        if (st.last) {
          const L = st.last;
          const kids = [h('p.ck-note', (L.kind === 'add' ? L.id + ' joined: ' : L.id + ' left: ') + L.moved + ' of ' + L.total + ' rows moved (' + (L.fraction * 100).toFixed(1) + '%), ' + (L.kind === 'add' ? 'to ' + L.tos.join(', ') : 'from ' + L.froms.join(', ') + ' to ' + L.tos.join(', ')) + '. Each moved row is a message, an INSERT at its new node and a DELETE at its old one.')];
          if (scheme !== 'hash') kids.push(h('p.ck-note', 'Hash partitioning (h(key) mod n) would have moved ' + L.hashWould + ' rows (' + ((100 * L.hashWould) / L.total).toFixed(1) + '%) for the same change, because changing n changes almost every row\'s h(key) mod n.'));
          el.appendChild(CK.section('The last change', ...kids));
        }
        if (st.ring) el.appendChild(CK.section('The hash ring', ringDraw(st, keys, type, P), h('p.ck-note', 'Each node owns the arcs that end at its points (named outside the ring while there is room); a key (a tick inside the ring) belongs to the next point clockwise. With more points per node the shares even out.' + (st.last ? ' Red ticks are the keys that moved in the last change.' : ''))));
        if (st.bounds && st.bounds.length) el.appendChild(CK.section('Range boundaries', h('div.ck-kv', st.nodes.map((id, i) => h('span', h('b', id), ' ' + (i === 0 ? o.key + ' ≤ ' + st.bounds[0] : i >= st.bounds.length ? o.key + ' > ' + st.bounds[st.bounds.length - 1] : st.bounds[i - 1] + ' < ' + o.key + ' ≤ ' + st.bounds[i]))))));
        if (st.virtual) el.appendChild(CK.section('Virtual partitions', h('p.ck-note', 'The rows are hashed into ' + st.virtual.virtualSizes.length + ' virtual partitions of sizes ' + st.virtual.virtualSizes.join(', ') + ', dealt to the nodes round-robin: a heavy virtual partition shares its node with light ones. The mapping is fixed here; change the node count above to repartition.')));
        el.appendChild(compareSchemes(T, o.key, ids.length, P));
      },
    };
    return src;
  }
  /**
   * the hash ring: each node's arcs in its colour, the keys as ticks inside the ring (red: moved in the last change).
   * A node's points (its tokens) are marked and named outside the ring while there is room for every name, the
   * names spread apart where points crowd; with many points the arcs alone show who owns what
   */
  function ringDraw(st, keys, type, P) {
    const R = 92, cx = 150, cy = 130, RING = 4294967296, LR = R + 22;
    const xy = (ang, r) => [cx + r * Math.cos((ang - 90) * Math.PI / 180), cy + r * Math.sin((ang - 90) * Math.PI / 180)];
    const svg = s('svg', { class: 'ck-ringsvg', viewBox: '0 0 300 260', role: 'img', 'aria-label': 'hash ring with ' + st.ring.points.length + ' points' }, s('circle', { cx, cy, r: R, class: 'rg', 'data-audit': 'group' }));
    const pts = st.ring.points;
    const col = (id) => 'c' + ((Number(String(id).slice(1)) - 1) % 8);
    pts.forEach((p, i) => {
      const prev = i ? pts[i - 1].angle : pts[pts.length - 1].angle - 360;
      const [x1, y1] = xy(prev, R), [x2, y2] = xy(p.angle, R);
      const large = p.angle - prev > 180 ? 1 : 0;
      svg.appendChild(s('path', { d: 'M' + x1 + ' ' + y1 + ' A ' + R + ' ' + R + ' 0 ' + large + ' 1 ' + x2 + ' ' + y2, class: 'arc ' + col(p.node), 'data-audit': 'group' }, s('title', { text: 'arc owned by ' + p.node })));
    });
    const moved = new Set(((st.last && st.last.movedKeys) || []).map((k) => P.canon(k, type)));
    const seen = new Set(), ticks = s('g', {});
    for (const k of keys) {
      const c = P.canon(k, type); if (seen.has(c)) continue; seen.add(c);
      const a = (P.hashOf(k, type) / RING) * 360, [x1, y1] = xy(a, R - 9), [x2, y2] = xy(a, R - 15);
      ticks.appendChild(s('line', { x1, y1, x2, y2, class: 'key' + (moved.has(c) ? ' moved' : '') }));
    }
    svg.appendChild(ticks);
    // room for a name per point: about 22px of the label circle each
    if (pts.length * 24 <= 2 * Math.PI * LR) {
      const step = (24 / (2 * Math.PI * LR)) * 360;
      // spread the names: cut the circle at the widest gap between points, then lay the names along it in order,
      // no two closer than one step, each run of crowded names centred on its points
      const lab = pts.map((p) => ({ p, a: p.angle })).sort((x, y) => x.a - y.a);
      let cut = 0, widest = -1;
      lab.forEach((x, i) => { const g = (lab[(i + 1) % lab.length].a - x.a + 360) % 360 || 360; if (g > widest) { widest = g; cut = (i + 1) % lab.length; } });
      const line = lab.slice(cut).concat(lab.slice(0, cut));
      const t = [];
      line.forEach((x, i) => t.push(i && x.a < t[i - 1] ? x.a + 360 : x.a));
      const blocks = [];
      t.forEach((v, i) => {
        blocks.push({ i, n: 1, sum: v });
        for (;;) {
          const b = blocks[blocks.length - 1], a2 = blocks[blocks.length - 2];
          if (!a2) break;
          const pa = a2.sum / a2.n - ((a2.n - 1) * step) / 2, pb = b.sum / b.n - ((b.n - 1) * step) / 2;
          if (pa + a2.n * step <= pb) break;
          // merge: the block's names sit step apart around the mean of their (shifted) targets
          blocks.pop(); blocks.pop();
          const n = a2.n + b.n;
          let sum = 0; for (let k = 0; k < n; k++) sum += t[a2.i + k] - k * step;
          blocks.push({ i: a2.i, n, sum: sum + n * ((n - 1) * step) / 2 });
        }
      });
      for (const b of blocks) { const start = b.sum / b.n - ((b.n - 1) * step) / 2; for (let k = 0; k < b.n; k++) line[b.i + k].a = start + k * step; }
      for (const { p, a } of lab) {
        const [px, py] = xy(p.angle, R), [lx, ly] = xy(a, LR);
        const [ex, ey] = xy(a, LR - 9);
        svg.appendChild(s('line', { x1: px, y1: py, x2: ex, y2: ey, class: 'lead', 'data-audit': 'edge' }));
        svg.appendChild(s('circle', { cx: px, cy: py, r: 4, class: 'pt ' + col(p.node), 'data-audit': 'overlap-ok' }, s('title', { text: p.node + ' point ' + p.v })));
        svg.appendChild(s('text', { x: lx, y: ly + 4, 'text-anchor': 'middle', class: 'nm', text: p.node }));
      }
    }
    svg.appendChild(s('text', { x: cx, y: cy + 4, 'text-anchor': 'middle', text: seen.size + ' keys' }));
    const shares = h('div.ck-legend', st.ring.nodes.map((id) => h('span', h('i.' + col(id)), id + ' ' + (st.ring.shares[id] * 100).toFixed(1) + '%')));
    return h('div.ck-ringbox', svg, shares);
  }
  function compareSchemes(T, key, n, P) {
    const cmp = P.compare(T, key, n);
    const best = Math.min(...cmp.schemes.map((x) => x.skew.ratio));
    const rows = cmp.schemes.map((x) => h('tr' + (x.skew.ratio === best ? '.good' : ''), h('td', x.name), h('td', x.sizes.join(' · ')), h('td.num', String(x.skew.ratio)), h('td.wrap', x.note)));
    const top = cmp.valueSkew.top.slice(0, 3).map((t) => (t.value === null ? 'null' : t.value) + ' (' + (t.share * 100).toFixed(1) + '%)').join(', ');
    return CK.section('Every scheme on ' + T.name + '.' + key + ' with ' + n + ' nodes',
      h('div.ck-tbl', h('table.grid.small', h('thead', h('tr', h('th', 'Scheme'), h('th', 'Rows per node'), h('th.num', 'max/mean'), h('th', 'Why'))), h('tbody', rows))),
      h('p.ck-note', cmp.valueSkew.distinct + ' distinct values; the most frequent: ' + top + '. A single value that holds more than 1/' + n + ' of the rows cannot be split by any key-based scheme (attribute-value skew).'));
  }

  // ---- replication: primary copy ------------------------------------------------------------------------------------
  const histItem = (x, viol, cur) => {
    const v = viol && viol.find((y) => y.n === x.n && y.client === x.client);
    const what = x.op === 'write' ? 'write ' + x.key + ' = ' + x.value : x.op === 'merge' ? 'merge ' + x.key : 'read ' + x.key + (x.from ? ' from ' + x.from.join(',') : x.node ? ' at ' + x.node : '');
    const res = cur ? '…' : !x.ok ? 'failed: ' + x.err : x.op === 'write' ? 'ok' + (x.ver !== undefined ? ' (version ' + verText(x.ver) + ')' : '') : '→ ' + valText(x.value) + (x.ver !== undefined ? ' (version ' + verText(x.ver) + ')' : '');
    const why = v ? (v.kind === 'ryw' ? 'misses its own write (read-your-writes)' : v.kind === 'monotonic' ? 'older than an earlier read (monotonic reads)' : 'stale: misses a finished write') : !x.ok && !cur ? 'refused' : '';
    return h('li' + (v ? '.bad' : !x.ok && !cur ? '.fail' : '') + (cur ? '.cur' : ''), tm(x.start), h('span.op', (x.client ? x.client + ': ' : '') + what + ' ' + res), why ? h('span.why', why) : null);
  };
  const valText = (v) => (v === null || v === undefined ? 'nothing' : Array.isArray(v) ? '{' + v.join(', ') + '}' : String(v));
  const verText = (v) => (Array.isArray(v) ? 't' + Math.round(v[0]) + '/' + v[1] : String(v));
  const clientCard = (st, id) => {
    const c = st.clients[id];
    const cur = c && c.cur;
    return { title: id, lines: [cur ? cur.op + ' ' + cur.key + (cur.value !== undefined && cur.op === 'write' ? ' = ' + cur.value : '') + ' …' : (c ? c.hist.length : 0) + ' done', c && c.bad ? h('span', h('b', String(c.bad)), ' violations') : ''], cls: c && c.bad ? 'badn' : '' };
  };
  const clientsOf = (sys, viol) => {
    const out = {};
    for (const id of sys.clients) { const st = sys.net.node(id).state; out[id] = { hist: C().clone(st.hist), cur: st.cur ? C().clone(st.cur) : null, bad: viol.filter((v) => v.client === id).length }; }
    return out;
  };

  SC.push({
    id: 'replication', title: 'Replication: sync and async', group: 'Replication',
    about: 'With primary-copy replication every write goes to the primary P, which numbers it and ships it to the replicas. Synchronous replication answers the client only after every replica has applied the write; asynchronous answers at once, so the replicas lag (R2 sits behind a slow link) and a read from a replica can miss the client\'s own write. A session token (the newest write the client has seen) restores read-your-writes: a replica holds the read until it has caught up.',
    defaults: { mode: 'async', readFrom: 'any', tokens: false, lag: 60, seed: 2 },
    controls: (o, set) => [
      CK.seg([['sync', 'Synchronous'], ['semi', 'Semi-sync'], ['async', 'Asynchronous']], o.mode, (v) => set('mode', v)),
      CK.select('Reads from', [['any', 'any copy'], ['replicas', 'replicas only'], ['primary', 'the primary'], ['sticky', 'one replica (sticky)']], o.readFrom, (v) => set('readFrom', v)),
      CK.check('Session token', o.tokens, (v) => set('tokens', v), 'The client sends the newest version it has seen; a replica waits until it has applied that far'),
      CK.select('R2 lag', [[0, 'none'], [30, '+30'], [60, '+60'], [120, '+120']], o.lag, (v) => set('lag', v), 'Extra latency on the link from P to R2'),
      seedCtl(o, set),
    ],
    start(o) {
      const R = C().Replication;
      const script = [];
      for (let i = 1; i <= 8; i++) script.push({ op: 'write', key: 'k', value: 'v' + i }, { op: 'read', key: 'k' }, { op: 'read', key: 'k' });
      return CK.liveSrc({
        base: 60, horizon: 2000, chunk: 1000,
        make() { const sys = new R.PrimaryCopy({ seed: o.seed, nodes: ['P', 'R1', 'R2'], mode: o.mode, readFrom: o.readFrom, tokens: o.tokens, lag: o.lag ? { R2: o.lag } : {} }); sys.client('c', script, { think: 2 }); return sys; },
        capture(sys) {
          const reps = {};
          for (const id of sys.nodes) { const st = sys.replica(id); reps[id] = { applied: st.applied, seq: st.seq, k: st.store.k ? Object.assign({}, st.store.k) : null, waits: st.waits.length }; }
          const all = sys.history();
          const viol = R.check(all).filter((v) => v.kind !== 'stale');
          return { reps, lag: sys.lag(), clients: clientsOf(sys, viol), viol };
        },
        layout: () => ({ height: 300, nodes: [{ id: 'P', x: 0.5, y: 0 }, { id: 'R1', x: 0.08, y: 1 }, { id: 'R2', x: 0.92, y: 1 }, { id: 'c', x: 0.5, y: 0.62, kind: 'client' }], links: [['P', 'R1'], ['P', 'R2', o.lag ? 'slow' : '', o.lag ? 'slow link +' + o.lag : ''], ['c', 'P', 'faint'], ['c', 'R1', 'faint'], ['c', 'R2', 'faint']] }),
        card(id, f) {
          const st = f.s;
          if (id === 'c') return clientCard(st, 'c');
          const r = st.reps[id];
          const k = r.k ? r.k.value + ' (v' + r.k.ver + ')' : '–';
          if (id === 'P') return { title: 'P', badge: 'primary', badgeCls: 'acc', cls: 'lead', lines: [B('writes', r.seq), B('k =', k)] };
          const lag = st.lag[id];
          return { title: id, badge: lag ? lag + ' behind' : 'up to date', badgeCls: lag ? 'warn' : 'ok', cls: lag ? 'warn' : '', lines: [B('applied', r.applied), B('k =', k), r.waits ? h('span', h('b', String(r.waits)), ' read waiting') : ''] };
        },
        note(e) {
          const d = e.data || {};
          if (e.what === 'commit') return 'P commits write ' + d.seq + ' (' + d.key + ' = ' + d.value + ')';
          if (e.what === 'apply') return e.node + ' applies write ' + d.seq;
          if (e.what === 'read waits') return e.node + ' holds the read: the client has seen write ' + d.token + ', it has applied only ' + d.applied;
          if (e.what === 'op') return e.node + ' starts: ' + d.op + ' ' + d.key + (d.value !== undefined ? ' = ' + d.value : '');
          if (e.what === 'done') return e.node + ' finished ' + d.op + (d.op === 'read' ? '' : '');
          return undefined;
        },
        panel(el, f, rec) {
          const st = f.s;
          el.appendChild(CK.section('Replication lag (writes behind the primary)', spark(rec, f.i, (x) => x.s.lag, ['R1', 'R2'], { c: { R1: 'c0', R2: 'c1' } })));
          const c = st.clients.c;
          const items = c.hist.map((x) => histItem(x, st.viol));
          if (c.cur) items.push(histItem(c.cur, null, true));
          const kinds = st.viol.reduce((m, v) => { m[v.kind] = (m[v.kind] || 0) + 1; return m; }, {});
          el.appendChild(CK.section('The client\'s session',
            st.viol.length ? CK.ok(false, (kinds.ryw ? kinds.ryw + ' read-your-writes ' : '') + (kinds.monotonic ? kinds.monotonic + ' monotonic-read ' : '') + 'violations so far' + (o.mode !== 'sync' && !o.tokens ? '. Turn on the session token, or make replication synchronous, and run again.' : '.')) : CK.ok(true, 'No session guarantee violated so far' + (o.tokens ? ' (the token makes replicas wait).' : o.mode === 'sync' ? ' (synchronous: every replica has a write before it is acknowledged).' : '.')),
            hist(items.reverse())));
        },
      });
    },
  });

  /** a small line chart of numbers per frame, up to frame i */
  function spark(rec, i, get, keys, opts) {
    opts = opts || {};
    const W = 520, H = 90, pad = 4;
    const fr = rec.frames.slice(0, i + 1).filter((x, j, a) => j === a.length - 1 || x.t !== a[j + 1].t);
    const t1 = Math.max(1, rec.frames[rec.last].t), mx = Math.max(1, ...fr.map((x) => Math.max(...keys.map((k) => get(x)[k] || 0))));
    const X = (t) => pad + ((W - pad - 6) * t) / t1, Y = (v) => H - 14 - ((H - 24) * v) / mx;
    // the drawing stretches to the panel's width, so its scale labels are HTML beside it rather than stretched text
    const svg = s('svg', { class: 'ck-spark', viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none', role: 'img', 'aria-label': 'lag over time' },
      s('line', { x1: pad, y1: H - 14, x2: W, y2: H - 14, class: 'ax', 'vector-effect': 'non-scaling-stroke', 'data-audit': 'ignore' }));
    for (const k of keys) {
      let d = '';
      fr.forEach((x, j) => { const v = get(x)[k] || 0; d += (j ? ' H ' + X(x.t) + ' V ' : 'M ' + X(x.t) + ' ') + Y(v); });
      if (fr.length) d += ' H ' + X(rec.frames[i].t);
      svg.appendChild(s('path', { d, class: 'ln ' + (opts.c ? opts.c[k] : ''), 'vector-effect': 'non-scaling-stroke', 'data-audit': 'overlap-ok' }));
    }
    svg.appendChild(s('line', { x1: X(rec.frames[i].t), y1: 4, x2: X(rec.frames[i].t), y2: H - 14, class: 'now', 'vector-effect': 'non-scaling-stroke', 'data-audit': 'overlap-ok' }));
    const scale = h('div.ck-sparky', { style: { paddingTop: Y(mx) - 7 + 'px' } }, h('span', String(mx)), h('span', '0'));
    return h('div', h('div.ck-sparkbox', scale, svg), h('div.ck-legend', keys.map((k) => h('span', h('i.line.' + (opts.c ? opts.c[k] : '')), k))));
  }

  // ---- quorums --------------------------------------------------------------------------------------------------
  SC.push({
    id: 'quorum', title: 'Quorums: N, R, W', group: 'Replication',
    about: 'Each item is stored on N replicas. A write is acknowledged once W replicas have stored it, and a read returns the newest of R answers. When R + W > N every read quorum overlaps every write quorum, so a read that starts after a write finished sees it; make R + W ≤ N and stale reads (in red) appear, while read repair sends the newest version back to replicas that answered with an old one.',
    defaults: { N: 5, R: 3, W: 3, repair: true, fanout: 'quorum', seed: 3 },
    controls(o, set) {
      o.R = Math.min(o.R, o.N); o.W = Math.min(o.W, o.N);
      const ks = K.range(o.N).map((i) => [i + 1, String(i + 1)]);
      return [
        CK.select('N', [[3, '3'], [5, '5']], o.N, (v) => set('N', v)),
        CK.select('R', ks, o.R, (v) => set('R', v)), CK.select('W', ks, o.W, (v) => set('W', v)),
        CK.check('Read repair', o.repair, (v) => set('repair', v)),
        CK.select('Ask', [['quorum', 'exactly R or W replicas'], ['all', 'all, wait for R or W']], o.fanout, (v) => set('fanout', v)),
        seedCtl(o, set),
      ];
    },
    start(o) {
      const R = C().Replication, nodes = 'ABCDE'.slice(0, o.N).split('');
      const rng = new (C().Rng)(o.seed * 7);
      const script = (tag) => K.range(10).map((i) => (rng.chance(0.4) ? { op: 'write', key: 'x', value: tag + '.' + i } : { op: 'read', key: 'x' }));
      const s1 = script('c1'), s2 = script('c2');
      return CK.liveSrc({
        base: 60, horizon: 2000, chunk: 1000,
        make() { const q = R.quorum({ seed: o.seed, nodes, R: o.R, W: o.W, readRepair: o.repair, fanout: o.fanout, net: { latency: 5, jitter: 25 } }); q.client('c1', s1, { timeout: 150 }); q.client('c2', s2, { timeout: 150 }); return q; },
        capture(q) {
          const reps = {};
          for (const id of nodes) { const v = q.replica(id).store.x; reps[id] = v ? { value: v.value, ver: v.ver.slice() } : null; }
          const viol = q.violations();
          return { reps, clients: clientsOf(q, viol), viol };
        },
        // the replicas in a row between the two clients, so that no client's links cross the other's. A narrow canvas
        // has no room for that row: the replicas stand in a column between the clients and only the messages are drawn,
        // since the links to the ends of the column would graze the cards next to them
        layout: (f, w) => (w < 520 ? { height: 460, nodes: CK.col(nodes, 0.5, 0, 1).concat([{ id: 'c1', x: 0, y: 0.5, kind: 'client' }, { id: 'c2', x: 1, y: 0.5, kind: 'client' }]), links: [] }
          : { height: 360, nodes: CK.row(nodes, 0.5, 0, 1).concat([{ id: 'c1', x: 0.5, y: 0, kind: 'client' }, { id: 'c2', x: 0.5, y: 1, kind: 'client' }]), links: nodes.flatMap((n) => [['c1', n, 'faint'], ['c2', n, 'faint']]) }),
        card(id, f) {
          const st = f.s;
          if (id[0] === 'c') return clientCard(st, id);
          const v = st.reps[id];
          const newest = Object.values(st.reps).filter(Boolean).reduce((a, b) => (!a || b.ver[0] > a.ver[0] || (b.ver[0] === a.ver[0] && b.ver[1] > a.ver[1]) ? b : a), null);
          const fresh = v && newest && v.ver[0] === newest.ver[0] && v.ver[1] === newest.ver[1];
          return { title: id, badge: v ? (fresh ? 'newest' : 'stale') : 'empty', badgeCls: fresh ? 'ok' : v ? 'warn' : '', lines: [B('x =', v ? v.value : '–'), v ? 'written at t ' + Math.round(v.ver[0]) : 'no version'] };
        },
        note(e) {
          const d = e.data || {};
          if (e.what === 'read repair') return e.node + ' repairs ' + d.node + ' with the newest version';
          if (e.what === 'repaired') return e.node + ' takes the repaired version';
          if (e.what === 'op') return e.node + ' starts: ' + d.op + ' x' + (d.value !== undefined ? ' = ' + d.value : '');
          return undefined;
        },
        panel(el, f) {
          const st = f.s;
          const strict = o.R + o.W > o.N;
          el.appendChild(CK.ok(strict, 'R + W = ' + (o.R + o.W) + (strict ? ' > N = ' + o.N + ': any R replicas include at least one of the last W written, so reads see completed writes.' : ' ≤ N = ' + o.N + ': a read quorum can miss the write quorum entirely, so reads can be stale.')));
          const items = Object.values(st.clients).flatMap((c) => c.hist.concat(c.cur ? [Object.assign({ cur: true }, c.cur)] : [])).sort((a, b) => a.start - b.start);
          el.appendChild(CK.section('Operations', st.viol.length ? CK.ok(false, st.viol.length + ' stale reads so far') : null, hist(items.map((x) => histItem(x, st.viol, x.cur)).reverse())));
        },
      });
    },
  });

  // ---- CAP ----------------------------------------------------------------------------------------------------------
  SC.push({
    id: 'cap', title: 'CAP: a partition', group: 'Replication',
    about: 'Three replicas A, B and C hold x; at t = 50 the network splits {A, B, c1} | {C, c2}, both clients write x during the split, and it heals at t = 400. A CP system (primary copy with the primary A on the majority side, a write needs a majority) keeps one value but refuses the minority\'s requests: consistent, not available. An AP system lets every replica take writes: everyone is answered, the sides diverge, and after the heal they reconcile, by last-writer-wins (one write is lost) or by keeping both writes as siblings.',
    defaults: { mode: 'CP', resolve: 'lww', seed: 1 },
    controls: (o, set) => [
      CK.seg([['CP', 'CP: consistent'], ['AP', 'AP: available']], o.mode, (v) => set('mode', v)),
      o.mode === 'AP' ? CK.select('Reconcile by', [['lww', 'last writer wins'], ['vv', 'version vectors (siblings)']], o.resolve, (v) => set('resolve', v)) : null,
      seedCtl(o, set),
    ],
    start(o) {
      const R = C().Replication, cp = o.mode === 'CP';
      return CK.liveSrc({
        base: 40, horizon: 900, chunk: 400,
        make() {
          const net = { latency: 5, jitter: 2 };
          const sys = cp ? new R.PrimaryCopy({ seed: o.seed, net, nodes: ['A', 'B', 'C'], mode: 'semi', readFrom: 'primary', retry: 50, client: { timeout: 100 } }) : new R.MultiMaster({ seed: o.seed, net, nodes: ['A', 'B', 'C'], resolve: o.resolve, client: { timeout: 100 } });
          const to = (n) => (cp ? {} : { to: n });
          sys.client('c1', [{ op: 'write', key: 'x', value: 'v0', at: 0 }, Object.assign({ op: 'write', key: 'x', value: 'left', at: 100 }, to('A')), Object.assign({ op: 'read', key: 'x', at: 250 }, to('B')), Object.assign({ op: 'read', key: 'x', at: 500 }, to('A'))], { home: 'A' });
          sys.client('c2', [Object.assign({ op: 'write', key: 'x', value: 'right', at: 110 }, to('C')), Object.assign({ op: 'read', key: 'x', at: 260 }, to('C')), Object.assign({ op: 'read', key: 'x', at: 510 }, to('C'))], { home: 'C' });
          sys.net.at(50, 'partition', [['A', 'B', 'c1'], ['C', 'c2']]);
          sys.net.at(400, 'heal');
          if (!cp) sys.net.at(420, 'call', () => sys.sync());
          return sys;
        },
        capture(sys) {
          const reps = {};
          for (const id of sys.nodes) { const st = sys.replica(id); reps[id] = cp ? (st.store.x ? [st.store.x.value] : []) : (st.store.x || []).map((v) => v.value).sort(); }
          return { reps, clients: clientsOf(sys, []), conflicts: sys.conflicts ? sys.conflicts().length : 0 };
        },
        // the majority side {A, B, c1} on the left (on top on a narrow canvas), the minority {C, c2} on the right
        layout: (f, w) => ({ height: w < 520 ? 420 : 300, nodes: w < 520 ? [{ id: 'A', x: 0, y: 0 }, { id: 'B', x: 1, y: 0 }, { id: 'c1', x: 0.5, y: 0.3, kind: 'client' }, { id: 'c2', x: 0, y: 1, kind: 'client' }, { id: 'C', x: 1, y: 1 }] : [{ id: 'A', x: 0, y: 0 }, { id: 'B', x: 0, y: 1 }, { id: 'c1', x: 0.33, y: 0.5, kind: 'client' }, { id: 'c2', x: 0.67, y: 0.5, kind: 'client' }, { id: 'C', x: 1, y: 0.5 }],
          links: [['A', 'B'], ['A', 'C'], ['B', 'C'], ['c1', 'A', 'faint'], ['c1', 'B', 'faint'], ['c2', 'C', 'faint']].concat(cp ? [['c2', 'A', 'faint']] : []) }),
        card(id, f) {
          if (id[0] === 'c') return clientCard(f.s, id);
          const v = f.s.reps[id];
          return { title: id, badge: cp ? (id === 'A' ? 'primary' : 'replica') : 'master', badgeCls: cp && id === 'A' ? 'acc' : '', cls: v.length > 1 ? 'warn' : '', lines: [B('x =', v.length ? (v.length > 1 ? '{' + v.join(', ') + '}' : v[0]) : '–'), v.length > 1 ? 'siblings' : ''] };
        },
        note(e) {
          const d = e.data || {};
          if (e.what === 'conflict') return e.node + ' finds concurrent writes of x: ' + d.versions.map((v) => v.value).join(' and ') + (d.winner ? '; keeps ' + d.winner + ' (newer timestamp), loses ' + d.lost.join(', ') : '; keeps both');
          if (e.what === 'failed') return e.node + ': ' + d.op + ' fails (' + d.err + ')';
          if (e.what === 'op') return e.node + ' starts: ' + d.op + ' x' + (d.value !== undefined ? ' = ' + d.value : '');
          return undefined;
        },
        panel(el, f) {
          const st = f.s;
          const all = Object.values(st.clients).flatMap((c) => c.hist).sort((a, b) => a.start - b.start);
          const during = all.filter((x) => x.start >= 50 && x.start < 400);
          const refused = during.filter((x) => !x.ok), reads = during.filter((x) => x.op === 'read' && x.ok).map((x) => valText(x.value));
          const vals = Object.values(st.reps).map((v) => v.join(','));
          const kids = [];
          if (f.t < 50) kids.push(h('p.ck-note', 'Before the partition: every replica can reach every other.'));
          else {
            if (cp) kids.push(refused.length ? CK.ok(false, 'Not available: ' + refused.map((x) => x.client + ' ' + x.op + ' refused (' + x.err + ')').join('; ')) : h('p.ck-note', 'The minority side has not been refused yet.'));
            else kids.push(refused.length ? CK.ok(false, refused.length + ' requests refused') : CK.ok(true, 'Available: every request so far was answered'));
            kids.push(new Set(reads).size > 1 ? CK.ok(false, 'Diverged: during the split the clients read ' + [...new Set(reads)].join(' and ')) : CK.ok(true, 'Consistent: every read during the split saw the same value'));
            if (f.t >= 400) kids.push(new Set(vals).size === 1 ? CK.ok(true, 'After the heal every replica holds x = ' + valText(Object.values(st.reps)[0]) + (st.conflicts ? ' (' + st.conflicts + ' conflict' + (st.conflicts > 1 ? 's' : '') + ' resolved)' : '')) : h('p.ck-note', 'Healed: the replicas are still exchanging their states.'));
          }
          el.appendChild(CK.section('What the clients saw', ...kids, hist(all.map((x) => histItem(x, [])).concat(Object.values(st.clients).filter((c) => c.cur).map((c) => histItem(c.cur, null, true))).reverse())));
        },
      });
    },
  });

  // ---- two- and three-phase commit ----------------------------------------------------------------------------------
  const F2 = [['none', 'no failure'], ['vote-no', 'a participant votes no'], ['participant-before-vote', 'participant crashes before voting'], ['participant-after-vote', 'participant crashes after voting yes'],
    ['coordinator-before-prepare', 'coordinator crashes before PREPARE'], ['coordinator-before-decision', 'coordinator crashes before deciding'], ['coordinator-after-decision', 'coordinator crashes after logging commit'],
    ['coordinator-partial-decision', 'coordinator sends COMMIT to one, then crashes'], ['lost-prepare', 'a PREPARE is lost'], ['lost-vote', 'a vote is lost'], ['lost-decision', 'a decision is lost'], ['partition-during-vote', 'a participant is cut off while voting']];
  const F3 = [['none', 'no failure'], ['vote-no', 'a participant votes no'], ['coordinator-before-precommit', 'coordinator crashes before PRECOMMIT'], ['coordinator-partial-precommit', 'PRECOMMIT reaches one, coordinator crashes'], ['coordinator-after-precommit', 'coordinator crashes after PRECOMMIT'], ['partition', 'coordinator crashes, then a partition']];
  const recText = (r) => '<' + r.type + ' ' + r.T + (r.type === 'ready' && r.writes ? ' ' + r.writes.length + ' write' + (r.writes.length === 1 ? '' : 's') : '') + '>';
  SC.push({
    id: '2pc', title: 'Two-phase commit', group: 'Transactions',
    about: 'The coordinator C ships each participant its part of a transfer (a real UPDATE on its own database), then sends PREPARE: a participant forces <ready T> to its log and votes yes, or votes no. With every vote yes C logs <commit T> and sends COMMIT, otherwise ABORT. Choose a failure, or click any node at any moment to crash it: a participant that voted yes and cannot learn the decision is blocked, still holding its row locks, until someone who knows the outcome answers.',
    defaults: { proto: '2pc', failure: 'none', n: 3, target: 'P2', restart: true, seed: 1 },
    controls(o, set) {
      const list = o.proto === '3pc' ? F3 : F2;
      if (!list.some((x) => x[0] === o.failure)) o.failure = 'none';
      if (+o.target.slice(1) > o.n) o.target = 'P' + o.n;
      return [
        CK.seg([['2pc', '2PC'], ['3pc', '3PC']], o.proto, (v) => set('proto', v)),
        CK.select('Failure', list, o.failure, (v) => set('failure', v)),
        o.proto === '2pc' ? CK.select('Target', K.range(o.n).map((i) => ['P' + (i + 1), 'P' + (i + 1)]), o.target, (v) => set('target', v), 'The participant the failure hits') : null,
        CK.select('', [[2, '2 participants'], [3, '3 participants'], [4, '4 participants']], o.n, (v) => set('n', v)),
        o.proto === '2pc' ? CK.check('Crashed nodes come back', o.restart, (v) => set('restart', v), 'A node the failure crashes restarts 150 time units later') : null,
        seedCtl(o, set),
      ];
    },
    start(o) { return o.proto === '3pc' ? threePC(o) : twoPC(o); },
  });
  // the coordinator and the participants on one ellipse around the network hub: every message, the coordinator's and
  // the participants' to each other (the termination protocol), goes along the sender's spoke and the receiver's
  const pLayout = (parts, w) => ({ height: 380, nodes: CK.circle(['C'].concat(parts), { narrow: w < 520 }).concat([{ id: CK.HUB, x: 0.5, y: 0.5, kind: 'hub' }]), links: CK.spokes(['C'].concat(parts)) });
  function twoPC(o) {
    const parts = K.range(o.n).map((i) => 'P' + (i + 1));
    const F = C().TwoPC.failures;
    return CK.liveSrc({
      base: 50, horizon: 4000, chunk: 1500, ahead: 1500,
      make: () => new (C().TwoPC)({ failure: o.failure, seed: o.seed, n: o.n, target: o.target, restart: o.restart }),
      capture(sim, memo, t) {
        const co = sim.net.node('C');
        const P = {};
        for (const p of sim.parts) {
          const n = sim.net.node(p);
          n.logSql = false;
          let bal = null;
          try { bal = Number(n.query('select balance from account').rows[0][0]); } catch (e) { bal = null; }
          // the open transaction sees its own uncommitted update
          let pend = null;
          if (n.tx && n.tx.tx && !n.tx.tx.failed) { try { pend = Number(C().textResult(n.tx.query('select balance from account')).rows[0][0]); } catch (e) { pend = null; } }
          n.logSql = true;
          const bl = n.state.blocked;
          const open = bl.length && bl[bl.length - 1].to === null ? bl[bl.length - 1].from : null;
          P[p] = { phase: n.v.phase, log: n.state.log.map(recText), bal, pend: pend !== bal ? pend : null, locks: !!(n.tx && n.tx.tx), blocked: open, waited: bl.reduce((a, b) => a + ((b.to === null ? t : b.to) - b.from), 0), failed: n.v.failed };
        }
        return { C: { phase: co.v.phase, decision: co.decisionInLog(), log: co.state.log.map(recText) }, P, viol: sim.violations.slice() };
      },
      layout: (f, w) => pLayout(parts, w),
      card(id, f) {
        const st = f.s;
        if (id === 'C') return { title: 'C', badge: st.C.phase, badgeCls: st.C.decision === 'commit' ? 'ok' : st.C.decision === 'abort' ? 'bad' : 'acc', cls: 'lead', lines: ['coordinator', B('decision', st.C.decision || '–')] };
        const p = st.P[id];
        const blocked = p.blocked !== null;
        return { title: id, badge: blocked ? 'blocked' : p.phase, badgeCls: blocked ? 'warn' : p.phase === 'committed' ? 'ok' : p.phase === 'aborted' ? 'bad' : p.phase === 'ready' ? 'acc' : '', cls: blocked ? 'warn' : p.phase === 'committed' ? 'hot' : '',
          lines: [h('span', 'balance ', h('b', p.bal === null ? '?' : String(p.bal)), p.pend !== null ? ' → ' + p.pend + '?' : ''), p.locks ? h('span', h('b', 'holds'), ' row lock') : 'no locks', p.log.length ? p.log[p.log.length - 1] : 'log empty'] };
      },
      note(e) {
        const d = e.data;
        switch (e.what) {
          case 'log': return e.node + ' forces ' + d + ' to its log';
          case 'statement failed': return e.node + ': the update fails (' + d + ')';
          case 'timeout': return e.node + ': ' + d;
          case 'blocked': return e.node + ' is blocked: it voted yes, has no decision, and asks the others';
          case 'unblocked': return e.node + ' is no longer blocked (it waited ' + Math.round(d.after) + ')';
          case 'learned': return e.node + ' learns the outcome: ' + d;
          case 'recover': return e.node + ' recovers from its log: ' + d;
          case 'resend': return 'C resends ' + d + ' (an acknowledgement is missing)';
          case 'violation': return e.node + ': ' + d;
        }
        return undefined;
      },
      panel(el, f) {
        const st = f.s;
        const boxes = h('div.ck-cols');
        boxes.appendChild(h('div.ck-box.on', h('h4', 'C', CK.up(f, 'C') ? CK.badge(st.C.phase, 'acc') : CK.badge('down', 'bad')), h('ul.ck-loglist', st.C.log.length ? st.C.log.map((r) => h('li', r)) : h('li.muted', 'log empty'))));
        for (const p of parts) {
          const x = st.P[p];
          boxes.appendChild(h('div.ck-box', h('h4', p, !CK.up(f, p) ? CK.badge('down', 'bad') : CK.badge(x.blocked !== null ? 'blocked' : x.phase, x.blocked !== null ? 'warn' : '')), h('ul.ck-loglist', x.log.length ? x.log.map((r) => h('li', r)) : h('li.muted', 'log empty')),
            h('div.ck-note', 'balance ' + (x.bal === null ? '?' : x.bal) + (x.pend !== null ? ' (' + x.pend + ' in its open transaction)' : '') + (x.locks ? ' · holds its row lock' : '') + (x.waited >= 1 ? ' · blocked for ' + Math.round(x.waited) : ''))));
        }
        el.appendChild(CK.section('Logs (stable storage) and data', boxes));
        const vals = parts.map((p) => st.P[p].phase);
        const total = parts.reduce((a, p) => a + (st.P[p].bal || 0), 0);
        const kids = [h('p.ck-note', 'Failure: ' + F[o.failure] + '.')];
        const committed = vals.filter((v) => v === 'committed').length, aborted = vals.filter((v) => v === 'aborted').length;
        if (committed && aborted) kids.push(CK.ok(false, 'Not atomic: some participants committed and some aborted'));
        else if (committed === parts.length) kids.push(CK.ok(true, 'Every participant committed: the transfer happened everywhere'));
        else if (aborted === parts.length) kids.push(CK.ok(true, 'Every participant aborted: the transfer happened nowhere'));
        else if (parts.some((p) => st.P[p].blocked !== null)) kids.push(CK.ok(false, 'Blocked: ' + parts.filter((p) => st.P[p].blocked !== null).join(', ') + ' voted yes and cannot decide alone; their rows stay locked'));
        else kids.push(h('p.ck-note', 'In progress: ' + parts.map((p) => p + ' ' + st.P[p].phase).join(', ')));
        kids.push(h('p.ck-note', 'Total balance ' + total + ' (it must stay ' + 100 * parts.length + ': the transfer moves money, it never makes or loses it).'));
        el.appendChild(CK.section('Outcome', ...kids));
      },
    });
  }
  function threePC(o) {
    const parts = K.range(o.n).map((i) => 'P' + (i + 1));
    const F = C().ThreePC.failures;
    return CK.liveSrc({
      base: 50, horizon: 3000, chunk: 1000,
      make: () => new (C().ThreePC)({ failure: o.failure, seed: o.seed, n: o.n }),
      capture(sim) {
        const P = {};
        for (const p of parts) { const st = sim.net.node(p).state; P[p] = { phase: st.phase, by: st.decidedBy, round: st.round }; }
        const c = sim.net.node('C').state;
        return { C: { phase: c.phase, log: c.log.slice() }, P };
      },
      layout: (f, w) => pLayout(parts, w),
      card(id, f) {
        if (id === 'C') return { title: 'C', badge: f.s.C.phase, badgeCls: 'acc', cls: 'lead', lines: ['coordinator', 'log: ' + (f.s.C.log.join(', ') || '–')] };
        const p = f.s.P[id];
        return { title: id, badge: p.phase, badgeCls: p.phase === 'committed' ? 'ok' : p.phase === 'aborted' ? 'bad' : p.phase === 'precommitted' ? 'acc' : '', cls: p.phase === 'committed' ? 'hot' : '', lines: [p.by ? 'decided by ' + p.by : p.round ? 'termination round ' + p.round : 'waiting'] };
      },
      note(e) {
        const d = e.data || {};
        if (e.what === 'committed' || e.what === 'aborted') return e.node + ' ' + e.what + ' (decided by ' + d.by + ')';
        if (e.what === 'termination') return e.node + ' timed out and starts the termination protocol (round ' + d.round + ')';
        if (e.what === 'new coordinator') return e.node + ' takes over as coordinator: states ' + Object.entries(d.states).map(([k, v]) => k + ' ' + v).join(', ') + ' → ' + d.decision;
        return undefined;
      },
      panel(el, f) {
        const vals = parts.map((p) => f.s.P[p].phase);
        el.appendChild(CK.section('Participants', CK.bars(parts.map((p) => ({ label: p, value: 1, note: f.s.P[p].phase + (f.s.P[p].by ? ' (by ' + f.s.P[p].by + ')' : ''), cls: f.s.P[p].phase === 'committed' ? 'c4' : f.s.P[p].phase === 'aborted' ? 'c5' : 'c7' })))));
        const kids = [h('p.ck-note', 'Failure: ' + F[o.failure] + '.')];
        if (vals.includes('committed') && vals.includes('aborted')) kids.push(CK.ok(false, 'Not atomic: the two sides of the partition terminated differently. 3PC is safe when nodes crash, not when the network partitions.'));
        else if (vals.every((v) => v === 'committed' || v === 'aborted')) kids.push(CK.ok(true, 'Everyone ' + vals[0] + ', and nobody was left blocked: the PRECOMMIT phase lets the survivors decide'));
        el.appendChild(CK.section('Outcome', ...kids));
      },
    });
  }

  // ---- distributed deadlock --------------------------------------------------------------------------------------------
  SC.push({
    id: 'deadlock', title: 'Distributed deadlock', group: 'Transactions',
    about: 'Each site\'s lock manager sees only its own wait-for graph. T1 and T2 each lock an item at one site and then want the other one\'s item at the other site: neither local graph has a cycle, but the detector D, which collects the local graphs every 40 time units, finds T1 → T2 → T1 in their union and aborts the younger transaction at every site. With delayed reports the detector can also see a cycle that never existed (a false cycle).',
    defaults: { variant: 'real', seed: 1 },
    controls: (o, set) => [CK.seg([['real', 'A global deadlock'], ['false', 'A false cycle']], o.variant, (v) => set('variant', v)), o.variant === 'real' ? seedCtl(o, set) : null],
    start(o) { return o.variant === 'false' ? falseCycle() : realDeadlock(o); },
  });
  const ddLayout = () => ({ height: 260, nodes: [{ id: 'D', x: 0.5, y: 0 }, { id: 'S1', x: 0, y: 1 }, { id: 'S2', x: 1, y: 1 }], links: [['D', 'S1'], ['D', 'S2'], ['S1', 'S2', 'faint']] });
  function realDeadlock(o) {
    return CK.liveSrc({
      base: 40, horizon: 1000, chunk: 500,
      make: () => new (C().DistDeadlock)({ seed: o.seed }),
      capture(sim) {
        const sites = {};
        for (const x of sim.sites) { const n = sim.net.node(x); sites[x] = { edges: n.localEdges().map((e) => ({ from: e.from, to: e.to })), done: Object.assign({}, n.state.done) }; }
        const r = sim.net.node('D').state.rounds;
        const last = r.length ? r[r.length - 1] : null;
        return { sites, round: last ? { n: last.round, edges: last.edges.map((e) => ({ from: e.from, to: e.to, site: e.site })), cycle: last.cycle, victim: last.victim || null } : null, found: r.find((x) => x.cycle) ? true : false };
      },
      layout: ddLayout,
      card(id, f) {
        const st = f.s;
        if (id === 'D') return { title: 'D', badge: 'detector', badgeCls: 'acc', cls: st.round && st.round.cycle ? 'badn' : '', lines: [st.round ? 'round ' + st.round.n : 'no round yet', st.round && st.round.cycle ? 'cycle ' + st.round.cycle.concat(st.round.cycle[0]).join('→') : 'no cycle'] };
        const x = st.sites[id];
        const done = (T) => (x.done[T] ? T + ' ' + x.done[T] : T + ' running');
        return { title: id, badge: 'site', cls: x.edges.length ? 'warn' : '', lines: [x.edges.length ? 'waits: ' + x.edges.map((e) => e.from + '→' + e.to).join(', ') : 'no one waits', done('T1'), done('T2')] };
      },
      note(e) {
        const d = e.data || {};
        if (e.what === 'statement') return e.node + ': ' + d.T + ' runs “' + d.sql + '” → ' + d.state;
        if (e.what === 'global wait-for graph') return 'D builds the global wait-for graph: ' + (d.edges.join(', ') || 'no edges') + (d.cycle ? ' — cycle ' + d.cycle.join(' → ') : ' — no cycle');
        if (e.what === 'victim') return 'D chooses ' + d + ' (the younger) as the victim';
        if (e.what === 'aborted') return e.node + ' rolls back ' + d.T;
        if (e.what === 'committed') return d + ' commits at every site';
        return undefined;
      },
      panel(el, f) {
        const st = f.s;
        const T = ['T1', 'T2'];
        const cls = {}; for (const x of Object.values(st.sites)) for (const [t, v] of Object.entries(x.done)) cls[t] = v === 'aborted' ? 'victim' : 'done';
        const g = (title, edges, cyc) => h('div.ck-box', h('h4', title), CK.graph(T, edges.map((e) => ({ from: e.from, to: e.to, cls: cyc ? 'cyc' : '', title: e.from + ' waits for ' + e.to + (e.site ? ' at ' + e.site : '') })), { label: title, cls }), h('div.ck-note', edges.length ? (cyc ? 'cycle: deadlock' : 'no cycle') : 'no edges'));
        const r = st.round;
        el.appendChild(CK.section('Wait-for graphs', h('div.ck-cols', g('S1, local', st.sites.S1.edges, false), g('S2, local', st.sites.S2.edges, false), g('D, global' + (r ? ' (round ' + r.n + ')' : ''), r ? r.edges : [], !!(r && r.cycle)))));
        el.appendChild(CK.section('Outcome', st.found ? CK.ok(true, 'The global graph had the cycle that no site could see; ' + (r && r.victim ? r.victim : 'T2') + ' was chosen as the victim and rolled back everywhere, so the other could finish.') : h('p.ck-note', 'Step on: the transactions lock their first items, then each asks for the other\'s.')));
      },
    });
  }
  function falseCycle() {
    const r = C().DistDeadlock.falseCycle();
    const truth = new Map(), view = new Map(), bodies = new Map();
    let det = null;
    const rec = CK.fromTrace(r.trace, {
      apply(e) {
        if (e.kind === 'send') bodies.set(e.msg, e.body);
        if (e.kind === 'note' && (e.node === 'S1' || e.node === 'S2')) { if (e.what === 'insert') truth.set(e.data, e.node); else truth.delete(e.data); }
        if (e.kind === 'deliver' && e.to === 'D') { const b = bodies.get(e.msg); const k = b.from + '->' + b.to; if (b.op === 'insert') view.set(k, 1); else view.delete(k); }
        if (e.kind === 'note' && e.node === 'D') det = { what: e.what, cycle: e.data.cycle, trueEdges: e.data.trueEdges };
      },
      snap: () => ({ truth: [...truth.keys()], view: [...view.keys()], det }),
      start: 'S1 reports its edges to D over a slow link (60), S2 over a fast one (5).',
    });
    rec.frames[0].s = { truth: [], view: [], det: null };
    const edges = (list, cyc) => list.map((k) => { const [a, b] = k.split('->'); return { from: a, to: b, cls: cyc ? 'cyc' : '' }; });
    return {
      rec, base: 15, noCrash: true, noLinks: true,
      layout: () => Object.assign(ddLayout(), { links: [['D', 'S1', 'slow', 'slow link'], ['D', 'S2'], ['S1', 'S2', 'faint']] }),
      card(id, f) {
        const st = f.s;
        if (id === 'D') return { title: 'D', badge: 'detector', badgeCls: 'acc', cls: st.det ? 'badn' : '', lines: ['sees: ' + (st.view.join(', ') || 'nothing'), st.det ? 'false cycle!' : 'no cycle'] };
        const mine = st.truth.filter((k) => (id === 'S1' ? /T1->T2/.test(k) : /T2->T1/.test(k)));
        return { title: id, badge: 'site', lines: ['really: ' + (mine.join(', ') || 'no waits')] };
      },
      note(e) {
        if (e.kind !== 'note') return undefined;
        if (e.node === 'D') return 'D sees the cycle ' + e.data.cycle.join(' → ') + ', but right now only ' + (e.data.trueEdges.join(', ') || 'nothing') + ' is true: a false cycle';
        return e.node + ': edge ' + e.data + (e.what === 'insert' ? ' appears' : ' disappears (T2 released its lock)');
      },
      panel(el, f) {
        const st = f.s;
        el.appendChild(CK.section('What is true and what D believes', h('div.ck-cols',
          h('div.ck-box', h('h4', 'true wait-for graph'), CK.graph(['T1', 'T2'], edges(st.truth, false), { label: 'true graph' }), h('div.ck-note', st.truth.join(', ') || 'no edges')),
          h('div.ck-box' + (st.det ? '.on' : ''), h('h4', 'D\'s graph'), CK.graph(['T1', 'T2'], edges(st.view, !!st.det && st.view.length > 1), { label: 'detector graph' }), h('div.ck-note', st.view.join(', ') || 'no edges')))));
        el.appendChild(CK.section('Outcome', st.det ? CK.ok(false, 'A false cycle: the removal of T1 → T2 is still on the slow link when T2 → T1 arrives. Aborting a victim now costs an unnecessary abort, never a missed deadlock.') : h('p.ck-note', 'T1 waits for T2 at S1; T2 then releases its lock at S1 and waits for T1 at S2. There was never a cycle.')));
      },
    };
  }

  // ---- Raft -----------------------------------------------------------------------------------------------------------
  const cmdText = (c) => (!c ? '' : c.op === 'noop' ? 'no-op' : c.op === 'set' ? c.key + '=' + c.value : c.op + (c.key ? ' ' + c.key : ''));
  SC.push({
    id: 'raft', title: 'Raft', group: 'Consensus',
    about: 'Raft keeps the same log on every server. A follower that hears nothing from a leader before its election timer (the ring) runs out stands for the next term, and a majority of votes makes it leader; the leader copies client commands to the followers and commits an entry once a majority stores it. Crash the leader or cut it off, then heal the network, and watch a new leader take over and the old leader\'s uncommitted entries be replaced.',
    defaults: { n: 5, seed: 1 },
    controls: (o, set) => [CK.select('Servers', [[3, '3 servers'], [5, '5 servers']], o.n, (v) => set('n', v)), seedCtl(o, set)],
    start(o) {
      const ids = K.range(o.n).map((i) => 's' + (i + 1)), maj = Math.floor(o.n / 2) + 1;
      let writes = 2;
      return CK.liveSrc({
        base: 150, horizon: 900, chunk: 600, ahead: 600,
        make() {
          const c = C().Raft.create({ n: o.n, seed: o.seed });
          c.net.at(400, 'call', () => c.submit({ op: 'set', key: 'x', value: 1 }));
          c.net.at(560, 'call', () => c.submit({ op: 'set', key: 'y', value: 2 }));
          return c;
        },
        capture(c, memo, t) {
          memo.seen = memo.seen || {};
          const q = c.net.queue;
          return {
            nodes: c.nodes().map((n) => {
              const st = n.state;
              const tm = q.find((e) => e.kind === 'timer' && e.node === n.id && e.name === 'election');
              if (tm && memo.seen[tm.id] === undefined) memo.seen[tm.id] = t;
              return { id: n.id, role: st.role, term: st.term, voted: st.votedFor, commit: st.commit, votes: st.votes.length, log: st.log.map((e) => [e.term, cmdText(e.cmd)]), kv: Object.assign({}, st.kv.data), timer: tm ? { start: memo.seen[tm.id], end: tm.at } : null };
            }),
            reqs: c.client.state.order.map((r) => { const x = c.client.state.reqs[r]; return { id: r, cmd: cmdText(x.cmd), status: x.status, index: x.index, tries: x.tries }; }),
            leaders: Object.assign({}, c.chk.leaders), viol: c.chk.violations.map((v) => v.prop + ': ' + v.detail),
          };
        },
        apply(c, op) {
          if (op.kind === 'write') { c.submit({ op: 'set', key: op.key, value: op.value }); return 'the client asks for ' + op.key + ' = ' + op.value; }
          const l = c.leader();
          if (op.kind === 'crashLeader') { if (!l) return 'there is no leader to crash right now'; c.crash(l); return 'the leader ' + l + ' crashes'; }
          if (op.kind === 'cutLeader') {
            if (!l) return 'there is no leader to cut off right now';
            // the follower next to the leader, so that the two sides sit together on the drawing
            const k = c.ids.indexOf(l), f = c.ids.slice(k + 1).concat(c.ids.slice(0, k)).find((i) => c.net.isUp(i));
            const minority = [l, f, 'client'], majority = c.ids.filter((i) => i !== l && i !== f);
            c.partition([minority, majority]);
            return 'partition {' + minority.join(', ') + '} | {' + majority.join(', ') + '}: the leader keeps the client but has lost its majority';
          }
          if (op.kind === 'restartAll') { const down = c.ids.filter((i) => !c.net.isUp(i)); down.forEach((i) => c.restart(i)); return 'restart ' + down.join(', '); }
          return '';
        },
        // the servers talk to each other all to all, which no drawing of direct links shows without crossings: the
        // servers and the client (at the bottom) sit on an ellipse around the network hub, and a message goes along
        // its sender's spoke and its receiver's
        layout: (f, w) => {
          const half = Math.ceil(ids.length / 2), order = ids.slice(0, half).concat(['client'], ids.slice(half));
          const nodes = CK.circle(order, { narrow: w < 520 }).map((n) => (n.id === 'client' ? Object.assign(n, { kind: 'client' }) : n));
          return { height: o.n === 5 ? 440 : 380, nodes: nodes.concat([{ id: CK.HUB, x: 0.5, y: 0.5, kind: 'hub' }]), links: CK.spokes(order) };
        },
        card(id, f) {
          if (id === 'client') {
            const p = f.s.reqs.filter((r) => r.status === 'pending');
            return { title: 'client', lines: [p.length ? 'waits: ' + p.map((r) => r.cmd).join(', ') : f.s.reqs.filter((r) => r.status === 'done').length + ' commands done'] };
          }
          const n = f.s.nodes.find((x) => x.id === id);
          const r = n.role;
          return {
            title: id, badge: r, badgeCls: r === 'leader' ? 'acc' : r === 'candidate' ? 'warn' : '', cls: r === 'leader' ? 'lead' : r === 'candidate' ? 'cand' : '',
            lines: [B('term', n.term), r === 'leader' ? B('commit', n.commit) : r === 'candidate' ? B('votes', n.votes + '/' + maj) : B('voted', n.voted || '–'), B('log', n.log.length)],
            timer: r !== 'leader' && n.timer ? Object.assign({ label: 'election timer: becomes a candidate when it runs out' }, n.timer) : null,
          };
        },
        actions: (f) => [
          { label: 'Client write', icon: 'plus', primary: true, title: 'The client sends the leader a new command', op: () => { writes++; return { kind: 'write', key: 'xyzwuvpqrst'[(writes - 1) % 11], value: writes }; } },
          { label: 'Crash the leader', icon: 'crash', op: { kind: 'crashLeader' } },
          { label: 'Cut off the leader', icon: 'split', title: 'Partition: the leader, one follower and the client on one side, the rest on the other', op: { kind: 'cutLeader' } },
          f.s.nodes.some((n) => !CK.up(f, n.id)) ? { label: 'Restart crashed servers', icon: 'refresh', op: { kind: 'restartAll' } } : null,
        ].filter(Boolean),
        note(e) {
          const d = e.data || {};
          switch (e.what) {
            case 'candidate': return e.node + '\'s election timer ran out: it becomes a candidate for term ' + d.term;
            case 'vote': return e.node + ' votes for ' + d.for + ' in term ' + d.term;
            case 'leader': return e.node + ' has a majority: leader of term ' + d.term;
            case 'stepdown': return e.node + ' sees term ' + d.term + ' and steps down to follower';
            case 'append': return e.node + ' appends ' + cmdText(d.cmd) + ' at index ' + d.index;
            case 'commit': return e.node + ' commits up to index ' + d.index;
            case 'apply': return e.node + ' applies ' + cmdText(d.cmd);
            case 'truncate': return e.node + ' deletes its entries from index ' + d.from + ': they conflict with the leader\'s log';
            case 'backup': return 'the leader backs up to index ' + d.next + ' for ' + d.peer;
            case 'recover': return e.node + ' restarts with term ' + d.term + ' and ' + d.log + ' log entries (they were on disk)';
            case 'done': return 'the client hears back: ' + d.req + ' done at index ' + d.index;
            case 'failed': return 'the client gives up on ' + d.req;
          }
          return undefined;
        },
        panel(el, f) {
          const st = f.s;
          const max = Math.max(1, ...st.nodes.map((n) => n.log.length));
          const logs = h('div.ck-logs', h('div.ck-logrow', h('span.ck-logid', 'index'), K.range(max).map((i) => h('span.ck-ent.idx', String(i + 1)))));
          for (const n of st.nodes) {
            logs.appendChild(h('div.ck-logrow' + (CK.up(f, n.id) ? '' : '.down'), h('span.ck-logid', n.id, n.role === 'leader' ? CK.badge('L', 'acc') : null),
              n.log.map(([term, cmd], i) => h('span.ck-ent.c' + (term % 8) + (i < n.commit ? '.done' : '') + (i + 1 === n.commit ? '.cm' : ''), { title: 'index ' + (i + 1) + ', term ' + term + ': ' + cmd + (i < n.commit ? ' (committed here)' : ' (not committed here)') }, h('b', String(term)), h('span', cmd)))));
          }
          el.appendChild(CK.section('Logs', h('p.ck-note', 'Each box is an entry: the number is its term, below it the command. Solid boxes are committed on that server, dashed ones are not; the green bar marks its commit index.'), logs));
          const lead = Object.entries(st.leaders).map(([t, l]) => 'term ' + t + ': ' + l).join(' · ');
          el.appendChild(CK.section('Leaders and state machines', h('p.ck-note', lead || 'No leader elected yet.'), h('div.ck-kv', st.nodes.map((n) => h('span', h('b', n.id), ' ' + (Object.entries(n.kv).map(([k, v]) => k + '=' + v).join(' ') || '{}'))))));
          el.appendChild(CK.section('Client requests', st.reqs.length ? hist(st.reqs.map((r) => h('li' + (r.status === 'pending' ? '.cur' : r.status === 'failed' ? '.fail' : ''), h('span.op', r.id + ': set ' + r.cmd), h('span.why', { style: { color: 'var(--muted)' } }, r.status === 'done' ? 'committed at index ' + r.index : r.status + (r.tries > 1 ? ', ' + r.tries + ' tries' : ''))))) : h('p.ck-note', 'The client writes x at t = 400 and y at t = 560. Add more with “Client write”.')));
          el.appendChild(st.viol.length ? CK.ok(false, st.viol.join('; ')) : CK.ok(true, 'Safety holds: at most one leader per term, logs that agree at an index agree before it, and no committed entry is ever lost.'));
        },
      });
    },
  });

  // ---- Paxos ----------------------------------------------------------------------------------------------------------
  const bal = (n) => (n === undefined || n === null || n < 0 ? '–' : Math.floor(n / 16) + '.' + (n % 16));
  SC.push({
    id: 'paxos', title: 'Paxos (single decree)', group: 'Consensus',
    about: 'Paxos chooses one value. A proposer sends prepare(n) with a ballot number n (shown as round.proposer); an acceptor promises to ignore lower ballots and reports any proposal it has accepted, and with promises from a majority the proposer sends accept(n, v), where v is the highest-ballot value reported, or its own if none was. Proposers that start together can pre-empt each other, but once a majority accepts one value every later ballot proposes that same value.',
    defaults: { acceptors: 3, proposers: 2, start: 'duel', loss: 0, seed: 1 },
    controls: (o, set) => [
      CK.select('Acceptors', [[3, '3 acceptors'], [5, '5 acceptors']], o.acceptors, (v) => set('acceptors', v)),
      CK.select('Proposers', [[1, '1 proposer'], [2, '2 proposers'], [3, '3 proposers']], o.proposers, (v) => set('proposers', v)),
      CK.select('Start', [['duel', 'at the same time'], ['late', 'one after another']], o.start, (v) => set('start', v)),
      CK.select('Loss', [[0, 'no loss'], [0.1, '10% lost'], [0.25, '25% lost']], o.loss, (v) => set('loss', v), 'Share of messages the network loses'),
      seedCtl(o, set),
    ],
    start(o) {
      const A = K.range(o.acceptors).map((i) => 'a' + (i + 1)), Pr = K.range(o.proposers).map((i) => 'p' + (i + 1));
      const vals = ['A', 'B', 'C'].slice(0, o.proposers);
      return CK.liveSrc({
        base: 60, horizon: 3000, chunk: 1500,
        make: () => C().Paxos.single({ acceptors: o.acceptors, proposers: o.proposers, values: vals, start: o.start === 'duel' ? [0, 2, 4] : [0, 250, 500], seed: o.seed, loss: o.loss }),
        capture(p) { const v = p.view(); return { acc: v.acceptors, prop: v.proposers, learner: v.learner, chosen: p.chosen(), viol: p.chk.violations.length }; },
        // one ellipse around the network hub: the proposers along the top, the acceptors along the bottom, the
        // learner at the right end; every proposer talks to every acceptor, so each message goes along its sender's
        // spoke and its receiver's
        layout: (f, w) => {
          const n = Pr.length + A.length + 1, step = (2 * Math.PI) / n, top = -Math.PI / 2 - ((Pr.length - 1) * step) / 2;
          const order = Pr.concat(['learner'], A.slice().reverse());
          return { height: 440, nodes: CK.circle(order, { start: top, narrow: w < 520 }).concat([{ id: CK.HUB, x: 0.5, y: 0.5, kind: 'hub' }]), links: CK.spokes(order) };
        },
        card(id, f) {
          const st = f.s;
          if (id === 'learner') return { title: 'learner', badge: st.learner !== null ? 'learned' : 'waiting', badgeCls: st.learner !== null ? 'ok' : '', cls: st.learner !== null ? 'hot' : '', lines: [B('chosen', st.learner === null ? '–' : st.learner)] };
          const a = st.acc.find((x) => x.id === id);
          if (a) return { title: id, badge: 'acceptor', cls: a.accepted && st.chosen !== null && a.accepted.v === st.chosen ? 'hot' : '', lines: [B('promised', bal(a.promised)), B('accepted', a.accepted ? '(' + bal(a.accepted.n) + ', ' + a.accepted.v + ')' : '–')] };
          const p = st.prop.find((x) => x.id === id);
          return { title: id, badge: p.phase, badgeCls: p.phase === 'accept' ? 'acc' : p.phase === 'done' ? 'ok' : p.phase === 'backoff' ? 'warn' : '', cls: p.phase === 'accept' ? 'lead' : '', lines: [B('wants', p.value === null ? '–' : p.value), B('ballot', bal(p.n)), p.chosen !== null ? B('learned', p.chosen) : p.proposed !== undefined ? B('proposes', p.proposed) : ''] };
        },
        note(e) {
          const d = e.data || {};
          switch (e.what) {
            case 'prepare': return e.node + ' starts ballot ' + bal(d.n) + ': prepare(' + bal(d.n) + ') to every acceptor';
            case 'promise': return e.node + ' promises ballot ' + bal(d.n) + (d.accepted ? ' and reports it accepted (' + bal(d.accepted.n) + ', ' + d.accepted.v + ')' : '');
            case 'propose': return e.node + ' has a majority of promises: accept(' + bal(d.n) + ', ' + d.v + ')' + (d.adopted ? ', a value reported in a promise, not its own' : '');
            case 'accepted': return e.node + ' accepts (' + bal(d.n) + ', ' + d.v + ')';
            case 'rejected': return e.node + '\'s ballot ' + bal(d.n) + ' is rejected: an acceptor promised ' + bal(d.promised) + '. It backs off and tries again';
            case 'chosen': return e.node + ' learns that ' + d.v + ' is chosen';
          }
          return undefined;
        },
        panel(el, f) {
          const st = f.s;
          el.appendChild(CK.section('Acceptors', h('div.ck-tbl', h('table.grid.small', h('thead', h('tr', h('th', 'Acceptor'), h('th', 'Promised ballot'), h('th', 'Accepted proposal'))), h('tbody', st.acc.map((a) => h('tr' + (!CK.up(f, a.id) ? '.bad' : ''), h('td', a.id), h('td', bal(a.promised)), h('td', a.accepted ? '(' + bal(a.accepted.n) + ', ' + a.accepted.v + ')' : '–'))))))));
          el.appendChild(CK.section('Proposers', h('div.ck-kv', st.prop.map((p) => h('span', h('b', p.id), ' wants ' + p.value + ', ' + p.attempts + ' ballot' + (p.attempts === 1 ? '' : 's') + ', ' + p.phase)))));
          el.appendChild(st.viol ? CK.ok(false, 'Two different values were chosen') : st.chosen !== null ? CK.ok(true, 'Chosen: ' + st.chosen + '. A majority of acceptors accepted it in one ballot; every later ballot will find it in some promise and propose it again.') : h('p.ck-note', 'Nothing is chosen yet: no ballot has been accepted by a majority (' + (Math.floor(o.acceptors / 2) + 1) + ' of ' + o.acceptors + ').'));
        },
      });
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
