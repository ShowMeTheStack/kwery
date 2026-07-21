// The Bloom filter lab (chapter 24): m bits, k hash functions, keys inserted and queried one at a time, and the
// false-positive rate measured against the formula (1 − e^(−kn/m))^k as n grows, with the k that makes it
// smallest. The k positions of a key come from two hashes by double hashing, h1 + i · h2 mod m, as the LSM
// tree's filters compute them.
(function (root) {
  'use strict';
  const K = root.K;
  const UI = K.UI;
  const { h } = UI;
  const D = () => UI.IdxDraw;

  // FNV-1a's low bits are weakly mixed, and m is often a power of two here: a finalizer spreads them
  const mix = (x) => { x ^= x >>> 16; x = Math.imul(x, 0x85ebca6b); x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); x ^= x >>> 16; return x >>> 0; };
  const positions = (key, m, k) => {
    const t = String(key);
    const h1 = mix(K.fnv(t)), h2 = (mix(K.fnv('\u0002' + t)) | 1) >>> 0;
    const out = [];
    for (let i = 0; i < k; i++) out.push(((h1 + Math.imul(i, h2)) >>> 0) % m);
    return out;
  };
  const theory = (m, k, n) => Math.pow(1 - Math.exp((-k * n) / m), k);
  const KMAX = 16;
  const optK = (m, n) => (n ? Math.min(KMAX, Math.max(1, Math.round((m / n) * Math.LN2))) : 1);
  /** the measured false-positive rate of a filter holding these keys: probes of keys never inserted */
  function measure(m, k, keys, probes) {
    const bits = new Uint8Array(m);
    for (const x of keys) for (const p of positions(x, m, k)) bits[p] = 1;
    const have = new Set(keys.map(String));
    let fp = 0, tried = 0;
    for (let j = 0; tried < probes; j++) {
      const q = '#q' + j;
      if (have.has(q)) continue;
      tried++;
      if (positions(q, m, k).every((p) => bits[p])) fp++;
    }
    return fp / probes;
  }

  function create(app, el) {
    const store = UI.store;
    let m = store.get('bloom.m', 64), k = store.get('bloom.k', 3);
    let keys = [], last = null, draft = '';
    const head = h('div.view-head.ix-head');
    const body = h('div.view-body.ix-body');
    el.appendChild(head); el.appendChild(body);
    const bitsOf = () => { const b = new Uint8Array(m); for (const x of keys) for (const p of positions(x, m, k)) b[p] = 1; return b; };
    const add = (list) => { for (const x of list) if (!keys.includes(x)) keys.push(x); const x = list[list.length - 1]; last = { op: 'insert', key: x, pos: positions(x, m, k), count: list.length }; };
    const query = (x) => {
      const b = bitsOf(), pos = positions(x, m, k);
      const maybe = pos.every((p) => b[p]);
      last = { op: 'query', key: x, pos, maybe, member: keys.includes(x), zero: pos.filter((p) => !b[p]) };
    };
    const toks = (t) => (t.match(/[^\s,;]+/g) || []);
    let seq = 1;
    const randomKeys = (n) => K.range(n).map(() => 'k' + (seq++ * 7919 % 100003));

    const view = {
      render() {
        head.innerHTML = '';
        const sel = (label, val, opts, set) => h('label.lab-param', h('span', label), h('select.inp', { 'aria-label': label, onchange: (e) => { set(+e.target.value); last = null; view.render(); } }, opts.map((o) => h('option', { value: String(o), selected: o === val }, String(o)))));
        head.appendChild(sel('Bits m', m, [16, 32, 64, 128, 256, 512, 1024], (v) => { m = v; store.set('bloom.m', v); }));
        head.appendChild(sel('Hash functions k', k, K.range(KMAX).map((i) => i + 1), (v) => { k = v; store.set('bloom.k', v); }));
        const n = keys.length, best = optK(m, n);
        head.appendChild(UI.btn('bolt', 'Optimal k = ' + best, 'Use k = (m / n) ln 2, rounded, for the keys in the filter', () => { k = best; store.set('bloom.k', k); last = null; view.render(); }, 'small' + (k === best ? ' ghost' : '')));
        body.innerHTML = '';
        body.appendChild(h('p.ix-intro', h('b', 'Bloom filter. '), 'A bit array of m bits and k hash functions: inserting a key sets its k bits, and a query says "definitely not in the set" if any of its k bits is 0, "possibly in the set" otherwise. It never misses a key that was inserted, but other keys can find all their bits set by chance: with n keys that happens with probability about (1 − e^(−kn/m))^k, smallest when k = (m/n) ln 2. LSM trees keep one per run to skip runs on lookups.'));
        // keys in, keys asked
        const input = h('input.inp.lab-in', { type: 'text', 'aria-label': 'Keys', placeholder: 'keys, e.g. Riverlight Harbour Glasshouse', value: draft, oninput: (e) => { draft = e.target.value; } });
        const doInsert = () => { const t = toks(input.value); if (!t.length) { UI.toast('Type a key or two first', 'warn'); return; } add(t); draft = ''; view.render(); };
        const doQuery = () => { const t = toks(input.value); if (!t.length) { UI.toast('Type the key to look for', 'warn'); return; } query(t[t.length - 1]); view.render(); };
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) doQuery(); else doInsert(); } });
        body.appendChild(h('div.lab-ctl',
          h('div.lab-ops', input, h('div.ix-row', UI.btn('plus', 'Insert', 'Insert the keys (Enter)', doInsert, 'small'), UI.btn('search', 'Query', 'Is the key in the set? (Shift+Enter)', doQuery, 'small'))),
          h('div.lab-quick', h('span', 'Try:'),
            h('button.lab-chip', { type: 'button', onclick: () => { add(['Riverlight', 'Harbour', 'Glasshouse', 'Lantern', 'Meridian', 'Copperleaf']); view.render(); } }, 'six venues'),
            h('button.lab-chip', { type: 'button', onclick: () => { add(randomKeys(10)); view.render(); } }, '+10 random keys'),
            h('button.lab-chip', { type: 'button', onclick: () => { add(randomKeys(Math.max(1, Math.round(m / 8)))); view.render(); } }, '+m/8 keys'),
            h('button.lab-chip', { type: 'button', onclick: () => { query('Ferry'); view.render(); } }, 'query Ferry'),
            h('button.lab-chip', { type: 'button', onclick: () => { let j = 0; while (j < 5000) { const q = 'probe' + j++; if (keys.includes(q)) continue; const b = bitsOf(); if (positions(q, m, k).every((p) => b[p])) { query(q); break; } } if (j >= 5000) UI.toast('No false positive found in 5,000 tries: the filter is nearly empty', 'warn'); view.render(); } }, 'find a false positive'),
            h('div.grow'),
            UI.btn('refresh', 'Empty', 'Empty the filter', () => { keys = []; last = null; view.render(); }, 'small ghost'))));
        // the bits
        const b = bitsOf();
        const set = b.reduce((a, x) => a + x, 0);
        const lp = new Set(last ? last.pos : []);
        const cells = h('div.bl-bits' + (m > 256 ? '.small' : m <= 64 ? '.num' : ''), { role: 'img', 'aria-label': set + ' of ' + m + ' bits set' });
        for (let i = 0; i < m; i++) cells.appendChild(h('span.bl-bit' + (b[i] ? '.on' : '') + (lp.has(i) ? (last.op === 'insert' ? '.ins' : '.q') + (b[i] ? '' : '.off') : ''), { title: 'bit ' + i + ' = ' + b[i] }, m <= 64 ? String(i) : ''));
        const fpT = theory(m, k, n), fpM = n ? measure(m, k, keys, 2000) : 0;
        body.appendChild(D().stats([['Keys n', n], ['Bits set', set + ' / ' + m], ['Fill', Math.round((set / m) * 100) + '%'], ['FP by formula', (fpT * 100).toFixed(2) + '%', 'acc', '(1 − e^(−kn/m))^k = (1 − e^(−' + k + '·' + n + '/' + m + '))^' + k], ['FP measured', (fpM * 100).toFixed(2) + '%', null, '2,000 queries of keys never inserted'], ['Optimal k', best, k === best ? 'ok' : null, '(m / n) ln 2 = ' + (n ? ((m / n) * Math.LN2).toFixed(2) : '∞')]]));
        body.appendChild(h('div.ix-cbox', h('h3', 'The bit array'), h('p.sub', 'Each key sets the bits h_i(K) = (h1(K) + i · h2(K)) mod ' + m + ', i = 0 … ' + (k - 1) + '.'), cells,
          keys.length ? h('div.bl-set', keys.slice(-40).map((x) => h('span.bl-key', x)), keys.length > 40 ? h('span.muted', '… ' + (keys.length - 40) + ' more') : null) : null));
        if (last) {
          const pos = 'h(' + last.key + ') = ' + last.pos.join(', ');
          if (last.op === 'insert') body.appendChild(h('div.bl-verdict', h('b', 'Inserted ' + (last.count > 1 ? last.count + ' keys, the last ' : '') + last.key + ': '), 'its ' + k + ' bits are now 1 (outlined).', h('div.bl-hash', pos)));
          else {
            const cls = !last.maybe ? 'no' : last.member ? 'maybe' : 'fp';
            const say = !last.maybe ? 'definitely not in the set: ' + (last.zero.length > 1 ? 'bits ' + last.zero.join(', ') + ' are' : 'bit ' + last.zero[0] + ' is') + ' 0, and every inserted key would have set it.' : last.member ? 'possibly in the set, and it is: all ' + k + ' bits are 1.' : 'possibly in the set, but it was never inserted: a false positive. All ' + k + ' of its bits were set by other keys. The index would read the run for nothing and find no entry.';
            body.appendChild(h('div.bl-verdict.' + cls, h('b', 'Query ' + last.key + ': '), say, h('div.bl-hash', pos)));
          }
        }
        // the false-positive rate as n grows
        const nMax = Math.max(8, Math.round(m * 1.2));
        const theo = K.range(61).map((i) => { const x = (nMax * i) / 60; return [x, theory(m, k, x)]; });
        // one small filter is a noisy sample: each point averages eight filters filled with different keys
        const meas = K.range(9).map((i) => { const x = Math.round((nMax * i) / 8); if (!x) return [0, 0]; let sum = 0; for (let t = 0; t < 8; t++) sum += measure(m, k, K.range(x).map((j) => '#s' + t + '_' + j), 300); return [x, sum / 8]; });
        const pct = (v) => (v ? (v * 100).toFixed(v < 0.1 ? 1 : 0) : '0') + '%';
        body.appendChild(h('div.ix-cbox', h('h3', 'False positives as the filter fills'), h('p.sub', 'm = ' + m + ' bits, k = ' + k + ': the formula against real filters; each dot averages 8 filters of n random keys, each probed with 300 keys never inserted'),
          D().chartKeys([{ name: '(1 − e^(−kn/m))^k', c: 1 }, { name: 'measured', c: 2, dots: true }]),
          D().chart({ label: 'False positive rate against keys inserted', series: [{ name: 'formula', c: 1, pts: theo }, { name: 'measured', c: 2, pts: meas, dots: true }], x: { label: 'keys inserted n', max: nMax, fmt: (v) => String(Math.round(v)) }, y: { label: 'false positive rate', max: 1, step: 0.25, fmt: pct }, marks: n ? [{ x: Math.min(n, nMax), label: 'n = ' + n }] : [] })));
        // the rate against k, for the keys there are now
        const nn = Math.max(1, n || Math.round(m / 8));
        const byK = K.range(KMAX).map((i) => [i + 1, theory(m, i + 1, nn)]);
        const bk = optK(m, nn);
        const top = Math.max(...byK.map((p) => p[1]));
        body.appendChild(h('div.ix-cbox', h('h3', 'Choosing k'), h('p.sub', 'For m = ' + m + ' and n = ' + nn + (n ? '' : ' (m / 8, until you insert keys)') + ': too few hash functions leave each key easy to match, too many fill the array. The best k is (m/n) ln 2 ≈ ' + ((m / nn) * Math.LN2).toFixed(2) + ', giving about ' + pct(theory(m, bk, nn)) + '.'),
          D().chart({ label: 'False positive rate against hash functions', height: 190, series: [{ name: 'formula', c: 1, pts: byK }], x: { label: 'hash functions k', max: KMAX, step: 1, fmt: (v) => String(Math.round(v)) }, y: { label: 'false positive rate', max: Math.min(1, top < 0.02 ? 0.02 : top * 1.1), fmt: (v) => (v * 100).toFixed(top < 0.05 ? 1 : 0) + '%' }, marks: [{ x: bk, label: 'best k = ' + bk }].concat(k !== bk ? [{ x: k, label: 'k = ' + k }] : []) })));
      },
    };
    return view;
  }

  UI.registerView({ id: 'bloom', title: 'Bloom filter', icon: 'grid', group: 'Indexing', order: 22, create });
})(typeof window !== 'undefined' ? window : globalThis);
