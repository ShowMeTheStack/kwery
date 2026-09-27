// Blockchain databases (Ch. 26): a small chain of blocks of transfers between accounts. Each block holds the hash
// of the one before it (a hash pointer), a nonce found by proof of work, and the Merkle root of its transactions.
// Changing anything breaks the hashes from that block on, and repairing it means redoing the work of every later
// block. A three-node network shows a fork and the longest-chain rule, a comparison sets the chain beside a
// database replicated with Raft, and a tiny smart contract ("transfer only if the balance suffices") is checked
// in every block. Every change is a step in a history that can be walked back and forth.
(function (root) {
  'use strict';
  const K = root.K;
  const UI = K.UI;
  const { h, s } = UI;

  // ---- SHA-256 (FIPS 180-4), synchronous so that mining can count every attempt ---------------------------------
  const KC = new Uint32Array(64), H0 = new Uint32Array(8);
  (() => {
    const primes = [];
    for (let n = 2; primes.length < 64; n++) if (primes.every((p) => n % p)) primes.push(n);
    const frac = (x) => ((x - Math.floor(x)) * 4294967296) >>> 0;
    primes.forEach((p, i) => { KC[i] = frac(Math.cbrt(p)); if (i < 8) H0[i] = frac(Math.sqrt(p)); });
  })();
  const W = new Uint32Array(64);
  const enc = new TextEncoder();
  function sha256(str) {
    const b = enc.encode(str), l = b.length, n = Math.ceil((l + 9) / 64) * 64;
    const m = new Uint8Array(n);
    m.set(b); m[l] = 0x80;
    const bits = l * 8;
    m[n - 4] = bits >>> 24; m[n - 3] = (bits >>> 16) & 255; m[n - 2] = (bits >>> 8) & 255; m[n - 1] = bits & 255;
    let h0 = H0[0], h1 = H0[1], h2 = H0[2], h3 = H0[3], h4 = H0[4], h5 = H0[5], h6 = H0[6], h7 = H0[7];
    for (let o = 0; o < n; o += 64) {
      for (let t = 0; t < 16; t++) { const j = o + t * 4; W[t] = (m[j] << 24) | (m[j + 1] << 16) | (m[j + 2] << 8) | m[j + 3]; }
      for (let t = 16; t < 64; t++) {
        const x = W[t - 15], y = W[t - 2];
        const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
        const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
        W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
      }
      let a = h0, bb = h1, c = h2, d = h3, e = h4, f = h5, g = h6, hh = h7;
      for (let t = 0; t < 64; t++) {
        const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const t1 = (hh + S1 + ((e & f) ^ (~e & g)) + KC[t] + W[t]) | 0;
        const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const t2 = (S0 + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + bb) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + hh) | 0;
    }
    return [h0, h1, h2, h3, h4, h5, h6, h7].map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
  }
  UI.sha256 = sha256;

  // ---- blocks, Merkle trees, the contract ---------------------------------------------------------------------------
  const ACCOUNTS = ['Alice', 'Bob', 'Carol', 'Dave'];
  const txText = (t) => t.from + '→' + t.to + ':' + t.amt;
  const txLabel = (t) => (t.from === 'mint' ? 'mint → ' + t.to + ' ' + t.amt : t.from + ' → ' + t.to + ' ' + t.amt);
  /** the levels of the Merkle tree, leaves first; an odd level repeats its last hash (as Bitcoin does) */
  function merkle(txs) {
    let lvl = txs.map((t) => sha256(txText(t)));
    if (!lvl.length) lvl = [sha256('')];
    const levels = [lvl];
    while (lvl.length > 1) {
      const next = [];
      for (let i = 0; i < lvl.length; i += 2) next.push(sha256(lvl[i] + (lvl[i + 1] || lvl[i])));
      levels.push(next); lvl = next;
    }
    return levels;
  }
  const header = (b, root) => b.i + '|' + b.prev + '|' + b.ts + '|' + root + '|' + b.d + '|' + b.nonce;
  const blockHash = (b) => sha256(header(b, merkle(b.txs).slice(-1)[0][0]));
  const zeros = (d) => '0'.repeat(d);
  const short = (x, n) => (x ? x.slice(0, n || 6) + '…' + x.slice(-4) : '–');
  /** replay every block with the rule "transfer only if the balance suffices"; returns per-transaction verdicts */
  function contract(chain) {
    const bal = Object.fromEntries(ACCOUNTS.map((a) => [a, 0]));
    const blocks = chain.map((b) => {
      const txs = b.txs.map((t) => {
        const before = t.from === 'mint' ? null : bal[t.from];
        const ok = t.from === 'mint' ? b.i === 0 && t.amt > 0 : t.from !== t.to && t.amt > 0 && (bal[t.from] || 0) >= t.amt;
        const why = ok ? '' : t.from === 'mint' ? 'only the genesis block may create money' : t.amt <= 0 ? 'the amount must be positive' : t.from === t.to ? 'a transfer to oneself' : t.from + ' has only ' + (bal[t.from] || 0);
        if (ok) { if (t.from !== 'mint') bal[t.from] -= t.amt; bal[t.to] = (bal[t.to] || 0) + t.amt; }
        return { ok, before, why };
      });
      return { txs, after: Object.assign({}, bal), ok: txs.every((x) => x.ok) };
    });
    return { blocks, bal };
  }
  /** check every block: its hash, its proof of work, its pointer to the block before and the contract */
  function verify(chain) {
    const c = contract(chain);
    let broken = -1;
    const out = chain.map((b, i) => {
      const own = blockHash(b);
      const okHash = own === b.hash, okWork = own.startsWith(zeros(b.d)), okLink = i === 0 ? b.prev === zeros(64) : b.prev === chain[i - 1].hash, okRule = c.blocks[i].ok;
      const self = okHash && okWork && okLink && okRule;
      if (!self && broken < 0) broken = i;
      return { own, okHash, okWork, okLink, okRule, self, valid: broken < 0, root: merkle(b.txs).slice(-1)[0][0] };
    });
    return { blocks: out, broken, contract: c };
  }
  /** find a nonce in slices of work, so the page stays responsive; calls back with progress and the result */
  function mine(b, onProgress, onDone) {
    const root = merkle(b.txs).slice(-1)[0][0], target = zeros(b.d);
    const pre = b.i + '|' + b.prev + '|' + b.ts + '|' + root + '|' + b.d + '|';
    let nonce = 0, stop = false;
    const t0 = performance.now();
    const slice = () => {
      if (stop) return;
      const end = performance.now() + 24;
      while (performance.now() < end) {
        for (let k = 0; k < 400; k++, nonce++) {
          const x = sha256(pre + nonce);
          if (x.startsWith(target)) { onDone({ nonce, hash: x, attempts: nonce + 1, ms: performance.now() - t0 }); return; }
        }
      }
      onProgress(nonce, performance.now() - t0);
      setTimeout(slice, 0);
    };
    slice();
    return () => { stop = true; };
  }
  /** the same, all at once (small difficulties only) */
  function mineNow(b) { const root = merkle(b.txs).slice(-1)[0][0], pre = b.i + '|' + b.prev + '|' + b.ts + '|' + root + '|' + b.d + '|', target = zeros(b.d); for (let n = 0; ; n++) { const x = sha256(pre + n); if (x.startsWith(target)) return { nonce: n, hash: x, attempts: n + 1 }; } }
  const stamp = (i) => { const d = new Date(Date.UTC(2026, 2, 2, 9, 0) + i * 600000); return d.toISOString().slice(0, 16).replace('T', ' '); };

  function initial(d) {
    const txs = [
      [{ from: 'mint', to: 'Alice', amt: 100 }, { from: 'mint', to: 'Bob', amt: 60 }, { from: 'mint', to: 'Carol', amt: 40 }],
      [{ from: 'Alice', to: 'Bob', amt: 25 }, { from: 'Bob', to: 'Carol', amt: 10 }, { from: 'Carol', to: 'Dave', amt: 5 }],
      [{ from: 'Bob', to: 'Dave', amt: 30 }, { from: 'Alice', to: 'Carol', amt: 15 }, { from: 'Dave', to: 'Alice', amt: 8 }, { from: 'Carol', to: 'Bob', amt: 12 }, { from: 'Alice', to: 'Dave', amt: 4 }],
      [{ from: 'Dave', to: 'Carol', amt: 20 }, { from: 'Bob', to: 'Alice', amt: 7 }],
    ];
    const chain = [];
    let hashes = 0;
    txs.forEach((t, i) => {
      const b = { i, ts: stamp(i), prev: i ? chain[i - 1].hash : zeros(64), d, nonce: 0, txs: t, hash: '' };
      const r = mineNow(b); hashes += r.attempts;
      Object.assign(b, { nonce: r.nonce, hash: r.hash, attempts: r.attempts });
      chain.push(b);
    });
    return { d, chain, pool: [{ from: 'Alice', to: 'Bob', amt: 10 }, { from: 'Carol', to: 'Alice', amt: 500 }, { from: 'Dave', to: 'Bob', amt: 6 }], sel: 2, proof: 1, hashes, last: null, net: null };
  }

  // ---- the network: three nodes, a tree of blocks, the longest-chain rule --------------------------------------------
  const NODES = ['A', 'B', 'C'];
  function netStart(st) {
    const blocks = {};
    st.chain.forEach((b, i) => { blocks['m' + i] = { id: 'm' + i, ht: i, parent: i ? 'm' + (i - 1) : null, by: null, hash: b.hash, label: 'Block ' + i, txs: b.txs.length }; });
    const top = 'm' + (st.chain.length - 1);
    return { blocks, heads: { A: top, B: top, C: top }, seq: 0, log: ['All three nodes hold the same chain of ' + st.chain.length + ' blocks.'], ev: 'start' };
  }
  const SIM_TX = [['Alice', 'Bob', 3], ['Bob', 'Carol', 2], ['Carol', 'Dave', 1], ['Dave', 'Alice', 4], ['Alice', 'Carol', 2], ['Bob', 'Dave', 5]];
  function netMine(net, who, d) {
    const parent = net.blocks[net.heads[who]];
    const id = 'n' + ++net.seq;
    const tx = SIM_TX[net.seq % SIM_TX.length];
    const b = { i: parent.ht + 1, ts: stamp(parent.ht + 1), prev: parent.hash, d: Math.min(d, 3), nonce: 0, txs: [{ from: tx[0], to: tx[1], amt: tx[2] }] };
    const r = mineNow(b);
    net.blocks[id] = { id, ht: parent.ht + 1, parent: parent.id, by: who, hash: r.hash, label: 'Block ' + (parent.ht + 1) + who.toLowerCase(), txs: 1, tx: txLabel(b.txs[0]), attempts: r.attempts };
    net.heads[who] = id;
    return id;
  }
  /** a block reaches a node: it switches only to a strictly longer chain, so a tie keeps the block it saw first */
  function netDeliver(net, id, to) {
    const cur = net.blocks[net.heads[to]], b = net.blocks[id];
    if (b.ht > cur.ht) { net.heads[to] = id; return true; }
    return false;
  }
  const ancestors = (net, id) => { const out = new Set(); for (let x = id; x; x = net.blocks[x].parent) out.add(x); return out; };

  function create(app, el) {
    const A = UI.ADV;
    let st = initial(3);
    let tab = UI.store.get('chain.tab', 'chain');
    let busy = null; // { cancel, text } while mining
    let form = { from: 'Bob', to: 'Dave', amt: 5 };
    const hist = A.history((x) => { if (busy) { busy.cancel(); busy = null; } st = x; draw(); });
    hist.push(st, 'A chain of ' + st.chain.length + ' blocks, each mined at difficulty ' + st.d);
    const commit = (label) => { hist.push(st, label); draw(); };

    el.appendChild(h('div.view-intro', h('b', 'A blockchain is an append-only log that no single party controls. '), 'Each block holds the hash of the block before it (a hash pointer), so changing any old block changes every hash after it; proof of work makes each block expensive to produce, and every node checks every block and its smart-contract rules before accepting it. Edit a transaction below and watch verification fail from that block on.'));
    const head = h('div.view-head.adv-head');
    const body = h('div.view-body.adv-body.bc');
    el.appendChild(head); el.appendChild(body);

    function drawHead() {
      head.innerHTML = '';
      head.appendChild(A.seg([['chain', 'Chain'], ['forks', 'Forks'], ['compare', 'vs. Raft']], tab, (v) => { tab = v; UI.store.set('chain.tab', v); draw(); }, 'Part'));
      head.appendChild(hist.bar);
    }

    // ---- the chain, drawn as cards with hash pointers between them ----------------------------------------------------
    function chainStrip(v) {
      const row = h('div.bc-strip', { role: 'list' });
      st.chain.forEach((b, i) => {
        const r = v.blocks[i];
        if (i) {
          const bad = !r.okLink || !v.blocks[i - 1].valid;
          row.appendChild(h('div.bc-link' + (bad ? '.bad' : ''), { title: r.okLink ? 'prev of block ' + i + ' = hash of block ' + (i - 1) : 'prev of block ' + i + ' no longer matches the hash of block ' + (i - 1) },
            s('svg', { viewBox: '0 0 34 90', width: 34, height: 90 }, s('path', { d: 'M34 62 C 18 62, 16 38, 4 38', class: 'bc-ptr' }), s('path', { d: 'M9 33 L3 38 L9 43', class: 'bc-ptr' }))));
        }
        const cls = (i === st.sel ? '.on' : '') + (r.valid ? '' : '.bad');
        row.appendChild(h('button.bc-card' + cls, { type: 'button', role: 'listitem', 'aria-label': 'Block ' + i, onclick: () => { st.sel = i; st.proof = Math.min(st.proof, b.txs.length - 1); draw(); } },
          h('div.bc-ct', h('b', i ? 'Block ' + i : 'Genesis'), r.valid ? A.badge('valid', 'ok') : r.self ? A.badge('after a break', 'bad') : A.badge(!r.okRule && r.okHash ? 'rule broken' : 'tampered', 'bad')),
          h('div.bc-f', h('span', 'hash'), h('code' + (r.valid ? '.ok' : '.bad'), { title: r.own }, short(r.own))),
          h('div.bc-f', h('span', 'prev'), h('code' + (r.okLink ? '' : '.bad'), { title: b.prev }, short(b.prev))),
          h('div.bc-f', h('span', 'nonce'), h('code', A.num(b.nonce, 0))),
          h('div.bc-f', h('span', 'root'), h('code', { title: r.root }, short(r.root))),
          h('div.bc-f', h('span', 'txs'), h('span.bc-n', b.txs.length + ' transfer' + (b.txs.length === 1 ? '' : 's') + ' · d=' + b.d))));
      });
      return h('div.adv-scroll.bc-scroll', row);
    }
    function verdict(v) {
      if (v.broken < 0) return h('div.bc-verdict.good', UI.icon('check'), h('span', h('b', 'The chain verifies. '), 'Every block\'s hash is what its contents hash to and starts with its difficulty\'s zeros, every prev field points at the hash of the block before, and every transfer obeys the contract.'));
      const k = v.broken, r = v.blocks[k], n = st.chain.length - k;
      const why = !r.okHash ? 'its contents no longer hash to the hash it was mined with' : !r.okWork ? 'its hash does not start with ' + st.chain[k].d + ' zeros' : !r.okLink ? 'its prev field does not match the hash of block ' + (k - 1) : 'a transfer breaks the contract';
      return h('div.bc-verdict.bad', UI.icon('warn'), h('span', h('b', 'Verification fails at block ' + k + ': '), why + '. Every block after it hangs from a broken pointer, so ' + UI.plural(n, 'block') + ' must be mined again to repair the chain: about ' + A.num(n * Math.pow(16, st.chain[k].d), 0) + ' hash attempts, while honest miners keep making the chain longer.'));
    }

    // ---- one block: its fields, its transactions with the contract's verdicts, its Merkle tree and a proof -----------------
    function blockPanel(v) {
      const i = st.sel, b = st.chain[i], r = v.blocks[i], cv = v.contract.blocks[i];
      const edit = (label) => { commit(label); };
      const fields = h('div.bc-fields',
        h('div.bc-kv', h('span', 'Index'), h('code', String(b.i))),
        h('div.bc-kv', h('span', 'Timestamp'), h('input.inp.bc-in', { value: b.ts, 'aria-label': 'Timestamp', onchange: (e) => { b.ts = e.target.value; edit('Changed the timestamp of block ' + i); } })),
        h('div.bc-kv', h('span', 'Difficulty'), h('code', b.d + ' leading zero hex digit' + (b.d === 1 ? '' : 's'))),
        h('div.bc-kv', h('span', 'Nonce'), h('input.inp.bc-in', { type: 'number', value: String(b.nonce), 'aria-label': 'Nonce', onchange: (e) => { b.nonce = Math.max(0, Math.floor(+e.target.value || 0)); edit('Changed the nonce of block ' + i + ' to ' + b.nonce); } })),
        h('div.bc-kv', h('span', 'Prev'), h('code.bc-h' + (r.okLink ? '' : '.bad'), b.prev), r.okLink ? null : h('span.bc-why', i ? 'block ' + (i - 1) + ' now hashes to ' + short(st.chain[i - 1].hash) : '')),
        h('div.bc-kv', h('span', 'Merkle root'), h('code.bc-h', r.root)),
        h('div.bc-kv', h('span', 'Hash'), h('code.bc-h' + (r.okHash && r.okWork ? '.ok' : '.bad'), r.own), r.okHash ? null : h('span.bc-why', 'mined as ' + short(b.hash, 10) + ', the contents now hash to something else')));
      const txRows = b.txs.map((t, j) => {
        const c = cv.txs[j];
        const sel = (val, key) => h('select.inp.bc-in', { 'aria-label': key, onchange: (e) => { t[key] = e.target.value; edit('Changed transaction ' + (j + 1) + ' of block ' + i); } }, (key === 'from' && i === 0 ? ['mint'].concat(ACCOUNTS) : ACCOUNTS).map((a) => h('option', { value: a, selected: a === val }, a)));
        return h('tr' + (j === st.proof ? '.on' : '') + (c.ok ? '' : '.bad'),
          h('td.rn', h('button.link', { type: 'button', title: 'Show the Merkle proof of this transaction', onclick: () => { st.proof = j; draw(); } }, 'T' + (j + 1))),
          h('td', sel(t.from, 'from')), h('td', sel(t.to, 'to')),
          h('td', h('input.inp.bc-in.bc-amt', { type: 'number', value: String(t.amt), 'aria-label': 'Amount', onchange: (e) => { t.amt = Math.floor(+e.target.value || 0); edit('Changed transaction ' + (j + 1) + ' of block ' + i + ' to ' + txLabel(t)); } })),
          h('td.txt', c.ok ? h('span.bc-ok', UI.icon('check'), t.from === 'mint' ? 'created' : 'had ' + c.before) : h('span.bc-no', UI.icon('x'), c.why)));
      });
      const txs = h('div.adv-tbl', h('table.grid', h('thead', h('tr', h('th', ''), h('th', 'From'), h('th', 'To'), h('th', 'Amount'), h('th', 'Contract'))), h('tbody', txRows)));
      const tools = [UI.btn('bolt', 'Mine it again', 'Find a new nonce for this block, with prev set to the current hash of the block before', () => remine(i, i), r.self ? '' : 'primary'),
        i < st.chain.length - 1 ? UI.btn('refresh', 'Repair the rest', 'Mine this block and every later block again', () => remine(i, st.chain.length - 1)) : null];
      return A.sec((i ? 'Block ' + i : 'Genesis block') + (r.valid ? '' : ' (invalid)'), tools,
        h('div.adv-split', h('div.bc-col', fields, txs, A.note('Change a field or a transaction and the block\'s hash changes at once: the stored hash, and the prev pointer of the next block, no longer match. Mining again finds a nonce for the new contents.')),
          h('div.bc-col', merkleTree(b, i))));
    }
    function merkleTree(b, i) {
      const levels = merkle(b.txs);
      const p = Math.min(st.proof, b.txs.length - 1);
      const n0 = levels[0].length, cw = 76, gap = 8, top = 26, lh = 54;
      const width = Math.max(n0, 2) * (cw + gap) + gap, height = top + levels.length * lh + 22;
      // leaves evenly spaced; each hash centred over the two it is made of (over its one child when it has no pair)
      const xs = [levels[0].map((_, k) => gap + k * (cw + gap) + cw / 2 + (width - gap - n0 * (cw + gap)) / 2)];
      for (let lv = 1; lv < levels.length; lv++) xs.push(levels[lv].map((_, k) => (xs[lv - 1][2 * k] + xs[lv - 1][Math.min(2 * k + 1, levels[lv - 1].length - 1)]) / 2));
      const xOf = (lv, k) => xs[lv][k];
      const yOf = (lv) => height - 30 - lv * lh;
      // the path from the leaf to the root, and the sibling at each level (the proof)
      const path = [], sib = [];
      let k = p;
      for (let lv = 0; lv < levels.length; lv++) { path.push(k); const sk = k ^ 1; sib.push(lv < levels.length - 1 ? (sk < levels[lv].length ? sk : k) : null); k >>= 1; }
      const g = [];
      for (let lv = 1; lv < levels.length; lv++) levels[lv].forEach((x, k2) => {
        // a hash without a pair is hashed with itself: one dashed edge stands for both halves
        const pair = 2 * k2 + 1 < levels[lv - 1].length;
        for (const c of pair ? [2 * k2, 2 * k2 + 1] : [2 * k2]) g.push(s('path', { class: 'bc-edge' + (path[lv] === k2 && path[lv - 1] === c ? ' on' : '') + (pair ? '' : ' dup'), d: 'M' + xOf(lv, k2) + ' ' + (yOf(lv) + 13) + ' L' + xOf(lv - 1, c) + ' ' + (yOf(lv - 1) - 13) }));
      });
      levels.forEach((lvl, lv) => lvl.forEach((x, k2) => {
        const on = path[lv] === k2, pr = sib[lv] === k2 && !on;
        g.push(s('g', { class: 'bc-mn' + (on ? ' on' : '') + (pr ? ' proof' : '') + (lv === levels.length - 1 ? ' root' : '') + (lv === 0 ? ' leaf' : ''), transform: 'translate(' + (xOf(lv, k2) - cw / 2) + ',' + (yOf(lv) - 13) + ')', onclick: lv === 0 ? () => { st.proof = k2; draw(); } : null },
          s('rect', { width: cw, height: 26, rx: 6 }), s('text', { x: cw / 2, y: 17, 'text-anchor': 'middle', class: 'mono' }, x.slice(0, 8)), s('title', {}, x)));
      }));
      levels[0].forEach((x, k2) => g.push(s('text', { x: xOf(0, k2), y: height - 4, 'text-anchor': 'middle', class: 'bc-tl' + (k2 === p ? ' on' : '') }, 'T' + (k2 + 1))));
      g.push(s('text', { x: xOf(levels.length - 1, 0), y: yOf(levels.length - 1) - 19, 'text-anchor': 'middle', class: 'bc-tl' }, 'Merkle root'));
      const svg = s('svg', { class: 'adv-svg bc-merkle', width, height, viewBox: '0 0 ' + width + ' ' + height }, g);
      // the proof, step by step: the verifier needs only these hashes and the root in the block header
      const steps = [h('li', h('code', 'h = H(T' + (p + 1) + ')'), ' = ', h('code', levels[0][p].slice(0, 8)))];
      let acc = levels[0][p];
      for (let lv = 0; lv < levels.length - 1; lv++) {
        const me = path[lv], other = sib[lv], left = me % 2 === 0;
        const ot = levels[lv][other];
        acc = sha256(left ? acc + ot : ot + acc);
        steps.push(h('li', h('code', left ? 'h = H(h || ' + ot.slice(0, 8) + ')' : 'h = H(' + ot.slice(0, 8) + ' || h)'), ' = ', h('code', acc.slice(0, 8)), other === me ? h('span.muted', ' (no sibling: the hash is paired with itself)') : null));
      }
      const ok = acc === levels[levels.length - 1][0];
      return h('div.bc-mk', h('div.bc-mkh', h('b', 'Merkle tree'), h('span.adv-note', 'Click a leaf to prove that transaction is in the block.')), h('div.adv-scroll', svg),
        h('div.adv-legend', h('span', h('i', { style: '--c: var(--accent)' }), 'path to the root'), h('span', h('i', { style: '--c: var(--warn)' }), 'the proof: ' + UI.plural(levels.length - 1, 'hash', 'hashes'))),
        h('ol.bc-proof', steps), h('div.bc-pv' + (ok ? '.ok' : '.bad'), ok ? 'Equals the Merkle root in block ' + i + '\'s header: T' + (p + 1) + ' is in the block. A light client checks this with ' + UI.plural(levels.length - 1, 'hash', 'hashes') + ' instead of all ' + b.txs.length + ' transactions.' : 'Does not match the root.'));
    }

    // ---- the mempool and mining ----------------------------------------------------------------------------------------------
    function poolPanel(v) {
      const last = st.last;
      const add = () => { const t = { from: form.from, to: form.to, amt: Math.floor(+form.amt || 0) }; st.pool.push(t); commit('Sent ' + txLabel(t) + ' to the pool of pending transactions'); };
      const acct = (key) => h('select.inp', { 'aria-label': key, onchange: (e) => { form[key] = e.target.value; } }, ACCOUNTS.map((a) => h('option', { value: a, selected: a === form[key] }, a)));
      const list = st.pool.length ? h('ul.bc-pool', st.pool.map((t, j) => h('li', h('code', txLabel(t)), h('button.icon-btn', { type: 'button', 'aria-label': 'Remove', onclick: () => { st.pool.splice(j, 1); commit('Removed ' + txLabel(t) + ' from the pool'); } }, UI.icon('x'))))) : A.note('The pool is empty. Add a transfer, then mine a block.');
      const kpis = busy ? h('div.adv-kpis', kpi('Attempts', A.num(busy.n, 0)), kpi('Time', UI.ms(busy.ms)), kpi('Hash rate', A.num(busy.n / Math.max(busy.ms, 1) * 1000, 0) + '/s'), kpi('Expected', '≈ ' + A.num(Math.pow(16, st.d), 0)))
        : last ? h('div.adv-kpis', kpi('Attempts', A.num(last.attempts, 0)), kpi('Time', UI.ms(last.ms)), kpi('Hash rate', A.num(last.attempts / Math.max(last.ms, 0.01) * 1000, 0) + '/s'), kpi('Expected', '≈ ' + A.num(Math.pow(16, last.d), 0))) : null;
      return A.sec('Pending transactions and mining', [A.select('Difficulty', [1, 2, 3, 4, 5].map((d) => [d, d + ' zero' + (d > 1 ? 's' : '') + ' (≈' + A.num(Math.pow(16, d), 0) + ')']), st.d, (d) => { st.d = d; commit('Difficulty set to ' + d + ' leading zeros for new blocks'); }, 'Leading zero hex digits a new block\'s hash must have'),
        busy ? UI.btn('stop', 'Stop', 'Stop mining', () => { busy.cancel(); busy = null; draw(); }) : UI.btn('bolt', 'Mine a block', 'Put the valid pending transfers in a block and search for its nonce', mineNew, 'primary')],
      h('div.adv-row.bc-form', acct('from'), h('span.muted', '→'), acct('to'), h('input.inp.bc-amt', { type: 'number', value: String(form.amt), 'aria-label': 'Amount', oninput: (e) => { form.amt = e.target.value; } }), UI.btn('plus', 'Add', 'Add this transfer to the pool', add)),
      list,
      busy ? h('div.adv-busy', h('span.adv-spin'), busy.text) : null,
      kpis,
      A.note('Mining tries nonce 0, 1, 2 … until the block\'s SHA-256 hash starts with ', h('b', st.d + ' zero hex digit' + (st.d > 1 ? 's' : '')), ': a 1 in 16', st.d > 1 ? h('sup', String(st.d)) : null, ' chance per attempt. Each extra zero makes the work 16 times longer; checking the result takes one hash. The miner first runs the contract and leaves out transfers it rejects.'));
    }
    const kpi = (k, v) => h('div.adv-kpi', h('div.k', k), h('div.v', v));
    function mineNew() {
      if (busy) return;
      const v = verify(st.chain);
      const bal = Object.assign({}, v.contract.bal);
      const take = [], left = [], rejected = [];
      for (const t of st.pool) {
        if (take.length >= 10) { left.push(t); continue; }
        if (t.from !== t.to && t.amt > 0 && (bal[t.from] || 0) >= t.amt) { bal[t.from] -= t.amt; bal[t.to] += t.amt; take.push(t); } else rejected.push(t);
      }
      if (!take.length) { UI.toast(rejected.length ? 'The contract rejects every pending transfer: ' + rejected.map(txLabel).join(', ') : 'Add a transfer to the pool first', 'warn', 4000); if (rejected.length) { st.pool = left; commit('The contract rejected ' + rejected.map(txLabel).join(', ')); } return; }
      const tip = st.chain[st.chain.length - 1];
      const b = { i: st.chain.length, ts: stamp(st.chain.length), prev: tip.hash, d: st.d, nonce: 0, txs: take, hash: '' };
      run([b], 'Mining block ' + b.i, (res) => {
        st.chain.push(b); st.pool = left; st.sel = b.i; st.proof = 0;
        commit('Mined block ' + b.i + ': ' + A.num(res.attempts, 0) + ' attempts in ' + UI.ms(res.ms) + (rejected.length ? '; the contract rejected ' + rejected.map(txLabel).join(', ') : '') + (v.broken >= 0 ? ' (on top of a broken chain: honest nodes reject it)' : ''));
      });
    }
    /** mine blocks from..to again, each pointing at the new hash of the one before */
    function remine(from, to) {
      if (busy) return;
      const list = st.chain.slice(from, to + 1);
      run(list, 'Mining block ' + from, (res) => {
        st.sel = from;
        commit((from === to ? 'Mined block ' + from + ' again: ' : 'Mined blocks ' + from + '–' + to + ' again: ') + A.num(res.attempts, 0) + ' attempts in ' + UI.ms(res.ms));
      }, true);
    }
    /** mine a list of blocks one after the other; with relink each takes the fresh hash of its predecessor */
    function run(list, text, done, relink) {
      let k = 0, total = 0, ms = 0;
      const next = () => {
        const b = list[k];
        if (relink) { b.prev = b.i ? st.chain[b.i - 1].hash : zeros(64); if (b.d < 1) b.d = st.d; }
        b.nonce = 0;
        const cancel = mine(b, (n, t) => { busy.n = total + n; busy.ms = ms + t; busy.text = text.replace(/\d+$/, String(b.i)) + (list.length > 1 ? ' (' + (k + 1) + ' of ' + list.length + ')' : '') + '…'; drawSoon(); }, (r) => {
          b.nonce = r.nonce; b.hash = r.hash; b.attempts = r.attempts; b.ms = r.ms;
          total += r.attempts; ms += r.ms; st.hashes += r.attempts;
          k++;
          if (k < list.length) { next(); return; }
          busy = null; st.last = { attempts: total, ms, d: list[list.length - 1].d };
          done({ attempts: total, ms });
        });
        if (busy) busy.cancel = cancel;
      };
      busy = { n: 0, ms: 0, text: text + '…', cancel: () => {} };
      draw();
      next();
    }
    const drawSoon = UI.raf(() => draw());

    function contractPanel(v) {
      const c = v.contract;
      const code = 'contract transfer(from, to, amount):\n  require amount > 0 and from != to\n  require balance[from] >= amount     -- transfer only if the balance suffices\n  balance[from] -= amount\n  balance[to]   += amount';
      return A.sec('Smart contract', null,
        A.note('A smart contract is code stored on the chain that every node runs on every transaction, so all of them agree on its effect. Here the only rule is the classic one: ', h('b', 'a transfer happens only if the balance suffices'), '. The balances are not stored anywhere: each node computes them by replaying the chain.'),
        h('pre.ls-sql.bc-code', code),
        h('div.adv-tbl', h('table.grid', h('thead', h('tr', h('th', 'Balance after'), st.chain.map((b, i) => h('th.num' + (v.blocks[i].valid ? '' : '.bc-bad'), i ? 'Block ' + i : 'Genesis')))),
          h('tbody', ACCOUNTS.map((a) => h('tr', h('td.txt', a), c.blocks.map((x) => h('td.num', String(x.after[a] || 0)))))))));
    }

    // ---- forks ------------------------------------------------------------------------------------------------------
    function forksPanel() {
      if (!st.net) st.net = netStart(st);
      const net = st.net;
      const act = (f) => { const label = f(); net.log.push(label); commit(label); };
      const both = () => act(() => {
        const a = netMine(net, 'A', st.d), b = netMine(net, 'B', st.d);
        netDeliver(net, a, 'C'); netDeliver(net, b, 'C');
        return 'A and B both find block ' + net.blocks[a].ht + ' at the same moment. C hears from A first and keeps A\'s block; A and B each keep their own. The chain has forked: two chains of the same length.';
      });
      const one = (who) => act(() => {
        const id = netMine(net, who, st.d);
        const switched = NODES.filter((n) => n !== who && netDeliver(net, id, n));
        const b = net.blocks[id];
        return who + ' finds block ' + b.ht + ' on top of ' + net.blocks[b.parent].label + ' (' + A.num(b.attempts, 0) + ' attempts) and broadcasts it.' + (switched.length ? ' ' + switched.join(' and ') + (switched.length > 1 ? ' switch' : ' switches') + ' to this longer chain (the longest-chain rule).' : ' Nobody switches: a chain of the same length does not replace the one a node already has.');
      });
      const heads = NODES.map((n) => net.blocks[net.heads[n]]);
      const best = heads.reduce((a, b) => (b.ht > a.ht ? b : a));
      const agreed = heads.every((x) => x.id === heads[0].id);
      const live = new Set(); NODES.forEach((n) => ancestors(net, net.heads[n]).forEach((x) => live.add(x)));
      const main = ancestors(net, best.id);
      const stale = Object.values(net.blocks).filter((b) => !live.has(b.id));
      const tools = [UI.btn('bolt', 'A and B mine at once', 'Two miners find the next block at the same time', both, 'primary'), UI.btn('bolt', 'A mines', null, () => one('A')), UI.btn('bolt', 'B mines', null, () => one('B')), UI.btn('refresh', 'Start again', null, () => { st.net = netStart(st); commit('The network starts again from the chain of ' + st.chain.length + ' blocks'); })];
      return h('div.bc-forks',
        A.sec('A fork, and the longest-chain rule', tools,
          A.note('Three nodes (A and B mine, C only checks and relays) each keep the chain they believe in. When two miners find a block at the same time the chain forks, and nodes may disagree for a while. ', h('b', 'The longest-chain rule'), ' settles it: a node switches to a chain longer than its own, so the branch that gets the next block wins and the other block becomes stale; its transactions go back to the pool.'),
          forkTree(net, main, live),
          h('div.adv-kpis', NODES.map((n) => { const b = net.blocks[net.heads[n]]; return h('div.adv-kpi.bc-node.n' + n, h('div.k', 'Node ' + n + (n === 'C' ? ' · relay' : ' · miner')), h('div.v', b.label), h('div.s', 'chain of ' + (b.ht + 1) + ' blocks')); })),
          agreed ? h('div.bc-verdict.good', UI.icon('check'), h('span', 'All nodes agree on the chain ending at ' + best.label + '.' + (stale.length ? ' Stale: ' + stale.map((b) => b.label + ' (' + b.tx + ')').join(', ') + '; those transfers return to the pool and must be mined again.' : ''))) : h('div.bc-verdict.bad', UI.icon('warn'), h('span', h('b', 'The nodes disagree. '), 'A transfer in only one branch may still disappear; this is why a payment counts as final only after several more blocks (Bitcoin waits for 6), which makes a reversal exponentially unlikely: finality is probabilistic.')),
          h('ol.bc-log', net.log.slice(-6).map((x, j, arr) => h('li' + (j === arr.length - 1 ? '.new' : ''), x)))));
    }
    function forkTree(net, main, live) {
      const ids = Object.keys(net.blocks);
      // rows: the first child of a block stays in its parent's row, any later child opens a new row
      const kids = {}; ids.forEach((id) => { const p = net.blocks[id].parent; if (p) (kids[p] = kids[p] || []).push(id); });
      const row = {}; let rows = 0;
      const place = (id, r) => { row[id] = r; (kids[id] || []).forEach((c, j) => place(c, j === 0 ? r : ++rows)); };
      place('m0', 0); rows++;
      const maxHt = Math.max(...ids.map((id) => net.blocks[id].ht));
      const bw = 82, bh = 40, gx = 30, gy = 32, x0 = 10, y0 = 10;
      const width = x0 * 2 + (maxHt + 1) * (bw + gx), height = y0 + rows * (bh + gy) + 6;
      const X = (b) => x0 + b.ht * (bw + gx), Y = (id) => y0 + row[id] * (bh + gy);
      const g = [];
      g.push(s('defs', {}, s('marker', { id: 'bc-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, s('path', { d: 'M0 0 L10 5 L0 10 z', class: 'bc-ah' }))));
      ids.forEach((id) => { const b = net.blocks[id]; if (!b.parent) return; const p = net.blocks[b.parent]; g.push(s('path', { class: 'bc-tedge' + (live.has(id) ? '' : ' stale'), d: 'M' + X(b) + ' ' + (Y(id) + bh / 2) + ' C ' + (X(b) - gx / 2) + ' ' + (Y(id) + bh / 2) + ', ' + (X(p) + bw + gx / 2) + ' ' + (Y(p.id) + bh / 2) + ', ' + (X(p) + bw + 2) + ' ' + (Y(p.id) + bh / 2), 'marker-end': 'url(#bc-arrow)' })); });
      ids.forEach((id) => {
        const b = net.blocks[id];
        const cls = 'bc-tb' + (main.has(id) ? ' main' : '') + (live.has(id) ? '' : ' stale') + (b.by ? ' by' + b.by : '');
        const pins = NODES.filter((n) => net.heads[n] === id);
        g.push(s('g', { class: cls, transform: 'translate(' + X(b) + ',' + Y(id) + ')' }, s('rect', { width: bw, height: bh, rx: 8 }),
          s('text', { x: 8, y: 16, class: 'bc-tbt' }, b.label), s('text', { x: 8, y: 31, class: 'mono' }, b.hash.slice(0, 9)), s('title', {}, b.hash + (b.tx ? '\n' + b.tx : '')),
          pins.map((n, j) => s('g', { class: 'bc-pin n' + n, transform: 'translate(' + (6 + j * 24) + ',' + (bh + 4) + ')' }, s('rect', { width: 20, height: 16, rx: 8 }), s('text', { x: 10, y: 12, 'text-anchor': 'middle' }, n)))));
      });
      return h('div.adv-scroll.bc-tree', s('svg', { class: 'adv-svg', width, height, viewBox: '0 0 ' + width + ' ' + height }, g));
    }

    // ---- blockchain against a replicated database -------------------------------------------------------------------------
    function comparePanel() {
      const rows = [
        ['Who takes part', 'Anyone (permissionless); participants may be anonymous and need not trust each other', 'A fixed set of servers run by one organisation (or known partners)'],
        ['Faults tolerated', 'Byzantine: nodes may lie or cheat; safe while honest miners hold most of the computing power', 'Crash faults only: a server may stop or lose messages, but never lies; safe with a majority of servers up'],
        ['Agreement', 'Proof of work and the longest-chain rule; a fork can last a while', 'An elected leader appends to its log; an entry commits once a majority stores it'],
        ['Finality', 'Probabilistic: a block is safe only after several more are built on it (minutes to an hour)', 'Immediate: a committed transaction is never undone (milliseconds)'],
        ['History', 'Immutable and tamper-evident: every block is chained by hashes and checked by everyone', 'Data is updated in place; the log is compacted; an administrator can change anything'],
        ['Throughput', 'Bitcoin: about 7 transactions a second, a block every 10 minutes', 'Thousands of transactions a second'],
        ['Cost of agreement', 'Enormous: all miners hash all the time (you have computed ' + A.num(st.hashes, 0) + ' hashes so far)', 'A few messages per write'],
        ['Queries', 'Mostly lookups by key; balances are replayed or kept in a separate index', 'Full SQL, indexes, joins, transactions'],
      ];
      return h('div.bc-cmp',
        A.sec('A blockchain and a replicated database', [UI.btn('nodes', 'Open the Raft cluster', 'See Raft elect a leader and replicate a log', () => app.openView('cluster'))],
          A.note('Both keep the same ordered log on many machines. They differ in whom they trust. A replicated database (Raft, Paxos) assumes its servers are honest and only guards against crashes, which makes it fast and final. A blockchain assumes nobody is trustworthy, so it pays for agreement with proof of work and gains a history that nobody can quietly rewrite.'),
          h('div.adv-tbl', h('table.grid.bc-ctab', h('thead', h('tr', h('th', ''), h('th', 'Blockchain'), h('th', 'Database replicated with Raft'))), h('tbody', rows.map((r) => h('tr', h('td.txt', h('b', r[0])), h('td.wrap', r[1]), h('td.wrap', r[2]))))))),
        A.sec('Permissioned blockchains', null,
          A.note('Between the two sit permissioned blockchains, run by a known group of organisations (banks, or the firms in a supply chain). The members are identified, so there is no mining: a Byzantine fault-tolerant consensus protocol such as PBFT orders the blocks, and stays correct while fewer than a third of the members misbehave. Some systems go further and order blocks with Raft among trusted orderers (Hyperledger Fabric can), tolerating crashes only, as a database does. They keep the tamper-evident hash chain and smart contracts, and reach far higher throughput with immediate finality.'),
          A.note('A rule of thumb: use a blockchain when the parties do not trust each other and no single one may own the data; when one organisation is trusted to run the system, a database replicated with Raft is far cheaper and faster.')));
    }

    function draw() {
      drawHead();
      body.innerHTML = '';
      const v = verify(st.chain);
      if (st.sel >= st.chain.length) st.sel = st.chain.length - 1;
      if (tab === 'chain') {
        body.appendChild(A.sec('The chain', [UI.btn('check', 'Verify', 'Check every block again', () => { const x = verify(st.chain); UI.toast(x.broken < 0 ? 'Every block verifies' : 'Verification fails at block ' + x.broken, x.broken < 0 ? 'ok' : 'err'); })],
          chainStrip(v), verdict(v)));
        body.appendChild(poolPanel(v));
        body.appendChild(blockPanel(v));
        body.appendChild(contractPanel(v));
      } else if (tab === 'forks') body.appendChild(forksPanel());
      else body.appendChild(comparePanel());
    }
    return { render() { if (!busy) draw(); }, destroy() { if (busy) busy.cancel(); }, onHide() { if (busy) { busy.cancel(); busy = null; } } };
  }

  UI.registerView({ id: 'blockchain', title: 'Blockchain', icon: 'key', group: 'Advanced', order: 95, create });
})(typeof window !== 'undefined' ? window : globalThis);
