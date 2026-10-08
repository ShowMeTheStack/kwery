// Browser tests of the index views: the index of a table (each access method, stepping through a recorded run,
// the picture before a split, opening a TID), the index playground (every structure, stepping, the 2-D plane,
// both comparisons) and the Bloom filter lab, in both themes and at phone width, with no console errors.
// Run: node tests/e2e/index.mjs   (builds index.html first; needs Google Chrome)
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../../tools/cdp.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
execSync('node build.mjs', { cwd: root, stdio: 'ignore' });

let pass = 0, fail = 0;
const ok = (name, cond, info) => { if (cond) { pass++; return; } fail++; console.log('FAIL ' + name + (info !== undefined ? ': ' + JSON.stringify(info).slice(0, 300) : '')); };
const js = (f) => '(' + f.toString() + ')()';

async function open(width, height) {
  const b = await launch({ width, height, mobile: width < 600 });
  await b.goto('');
  await b.waitFor('window.K && K.app && document.querySelector(".tab")', 20000);
  return b;
}
const errors = (b) => b.logs.filter((l) => l.type === 'error' || l.type === 'exception');
const pane = 'document.querySelector(".dock-pane:not([hidden])")';

// ---- the index of a table ------------------------------------------------------------------------------------------------
{
  const b = await open(1440, 1000);
  try {
    await b.eval(`K.app.openView('index'); 1`);
    ok('index view opens', await b.eval(`!!${pane}.querySelector('.ix-body')`));
    // the B+ tree example from the Examples menu
    await b.eval(js(() => { document.querySelector('.ix-head .btn.ghost').click(); [...document.querySelectorAll('.menu-item')].find((x) => x.textContent.startsWith('B+ tree')).click(); }));
    const nodes = await b.eval(`${pane}.querySelectorAll('.ix-svg .ix-node').length`);
    ok('B+ tree example drawn', nodes > 8, nodes);
    ok('summary shows the lookup cost', await b.eval(`/h_i \\+ 1 = \\d \\+ 1 = \\d/.test(${pane}.querySelector('.ix-formula').textContent)`));
    // a lookup: step to the leaf visit, then back to the start
    const visits = await b.eval(js(() => {
      K.app.runText('set enable_seqscan = off; select * from ex_bplus where k = 17');
      const tl = K.app.timeline;
      const v = tl.events.map((e, i) => [e, i]).filter(([e]) => e.type === 'btree.visit');
      const leaf = v.find(([e]) => e.data.leaf);
      tl.go(leaf[1] + 1);
      return v.length;
    }));
    ok('the lookup recorded B+ tree visits', visits >= 3, visits);
    ok('the search path is lit', await b.eval(`${pane}.querySelectorAll('.ix-node.path').length >= 3`));
    ok('the current node is lit', await b.eval(`${pane}.querySelectorAll('.ix-node.cur').length === 1`));
    ok('the path edges are lit', await b.eval(`${pane}.querySelectorAll('.ix-edge.path').length >= 2`));
    await b.eval('K.app.timeline.go(0); 1');
    ok('stepping back to the start clears the path', await b.eval(`${pane}.querySelectorAll('.ix-node.cur, .ix-node.path').length === 0`));
    await b.eval('K.app.timeline.step(1); K.app.timeline.step(1); K.app.timeline.go(K.app.timeline.length); 1');
    ok('stepping forward to the end', await b.eval(`/events on this index/.test(${pane}.querySelector('.ix-banner').textContent)`));
    // a split: before it the old tree, at it the split nodes
    const split = await b.eval(js(() => {
      K.app.runText("insert into ex_bplus values (17, 'a'), (18, 'b'), (16, 'c'), (17, 'd')");
      const tl = K.app.timeline;
      const i = tl.events.findIndex((e) => e.type === 'btree.split');
      if (i < 0) return null;
      tl.go(i + 1);
      const at = { split: document.querySelectorAll('.dock-pane:not([hidden]) .ix-node.split').length, fresh: document.querySelectorAll('.dock-pane:not([hidden]) .ix-node.new').length, leaves: document.querySelectorAll('.dock-pane:not([hidden]) .ix-svg .ix-node').length };
      tl.go(0);
      const before = { leaves: document.querySelectorAll('.dock-pane:not([hidden]) .ix-svg .ix-node').length, text: document.querySelector('.dock-pane:not([hidden]) .ix-banner').textContent };
      return { at, before };
    }));
    ok('the insert split a node', split && split.at.split >= 1 && split.at.fresh >= 1, split);
    ok('before the split the tree is drawn as it was', split && /before the statement/.test(split.before.text) && split.before.leaves < split.at.leaves, split);
    // a node's entries, and a TID opening the storage view
    await b.eval(`K.app.timeline.go(K.app.timeline.length); ${pane}.querySelector('.ix-svg .ix-node.ix-click').dispatchEvent(new MouseEvent('click', { bubbles: true })); 1`);
    ok('clicking a node lists its entries', await b.eval(`!!${pane}.querySelector('.ix-detail table')`));
    const st = await b.eval(js(() => { const t = document.querySelector('.dock-pane:not([hidden]) .ix-tid'); t.dispatchEvent(new MouseEvent('click', { bubbles: true })); return K.app.dock.active; }));
    ok('a TID opens the storage view', st === 'storage' || !(await b.eval(`K.UI.views.has('storage')`)), st);
    await b.eval(`K.app.openView('index'); 1`);
    // every other kind of index, from the examples
    for (const [label, re] of [['Extendible hashing', /directory · i = \d/], ['Linear hashing', /h mod \d/], ['Static hashing', /h mod 4/], ['Bitmap', /rows ·/], ['LSM tree', /Memtable/], ['R-tree on points', /block \d/]]) {
      const r = await b.eval(js(() => { document.querySelector('.ix-head .btn.ghost').click(); return 1; }));
      void r;
      const txt = await b.eval(`(() => { [...document.querySelectorAll('.menu-item')].find((x) => x.textContent === ${JSON.stringify(label)}).click(); const p = ${pane}; return { svg: p.querySelector('.ix-scroll svg') ? p.querySelector('.ix-scroll svg').textContent : '', err: !!p.querySelector('.res-err') }; })()`);
      ok(label + ' index drawn', !txt.err && re.test(txt.svg), txt.svg.slice(0, 120));
    }
    ok('the R-tree plane is drawn', await b.eval(`${pane}.querySelectorAll('.ix-plane-svg .ix-mbr').length > 2`));
    // a hash lookup and a bitmap scan, stepped
    const hashStep = await b.eval(js(() => {
      const ix = K.app.session.catalog.lookup({ name: 'ex_ehash_k' });
      K.app.openView('index', { index: ix.oid });
      K.app.runText('set enable_seqscan = off; select * from ex_ehash where k = 21');
      const tl = K.app.timeline;
      const v = tl.events.map((e, i) => [e, i]).filter(([e]) => e.type === 'hash.visit');
      tl.go(v[v.length - 1][1] + 1);
      return { visits: v.length, lit: document.querySelectorAll('.dock-pane:not([hidden]) .ix-page.cur, .dock-pane:not([hidden]) .ix-page.path').length };
    }));
    ok('a hash lookup lights its bucket', hashStep.visits >= 2 && hashStep.lit >= 1, hashStep);
    const lsmStep = await b.eval(js(() => {
      const ix = K.app.session.catalog.lookup({ name: 'ex_lsm_k' });
      K.app.openView('index', { index: ix.oid });
      K.app.runText('set enable_seqscan = off; select * from ex_lsm where k = 37');
      const tl = K.app.timeline;
      const i = tl.events.findIndex((e) => e.type === 'lsm.bloom');
      if (i < 0) return null;
      tl.go(i + 1);
      return document.querySelectorAll('.dock-pane:not([hidden]) .ix-bb.probe').length;
    }));
    ok('an LSM lookup shows the Bloom probe', lsmStep > 0, lsmStep);
    // dark theme
    await b.eval(`K.app.settings.theme = 'dark'; K.app.applyTheme(); 1`);
    ok('redraws in the dark theme', await b.eval(`document.documentElement.dataset.theme === 'dark' && !!${pane}.querySelector('.ix-svg')`));
    ok('index view: no console errors', errors(b).length === 0, errors(b));
  } finally { await b.close(); }
}

// ---- the playground ---------------------------------------------------------------------------------------------------------
{
  const b = await open(1440, 1000);
  try {
    await b.eval(`K.app.openView('indexlab'); 1`);
    const kinds = await b.eval(`[...${pane}.querySelectorAll('.ix-head select option')].map((o) => o.value)`);
    ok('ten structures to choose from', kinds.length === 10, kinds);
    for (const k of kinds) {
      const r = await b.eval(`(() => {
        const p = ${pane};
        const sel = p.querySelector('.ix-head select'); sel.value = ${JSON.stringify(k)}; sel.dispatchEvent(new Event('change'));
        p.querySelector('.lab-chip').click();
        const range = p.querySelector('.lab-stepbar input');
        const max = +range.max;
        const say = () => p.querySelector('.lab-say').textContent;
        const btn = (t) => [...p.querySelectorAll('.lab-stepbar .btn')].find((x) => x.title === t);
        btn('Last step').click(); const last = say();
        btn('Step back').click(); const back = say();
        btn('First step').click(); const first = say();
        btn('Step forward').click(); const fwd = say();
        const structural = [...p.querySelectorAll('.lab-li')].find((x) => /split|overflow|double|flush|compaction|newkey|subdivide|newroot/.test(x.textContent));
        if (structural) structural.click();
        return { max, last, back, first, fwd, structural: structural ? say() : null, svg: p.querySelectorAll('.ix-scroll svg [data-key]').length, err: !!p.querySelector('.res-err') };
      })()`);
      ok(k + ': steps recorded', r.max >= 5, r.max);
      ok(k + ': every step is explained', [r.last, r.back, r.first, r.fwd].every((t) => t.length > 20) && r.last !== r.first, r);
      ok(k + ': drawn', r.svg > 0 && !r.err, r);
      if (!['bitmap', 'kdtree'].includes(k)) ok(k + ': a structural step is explained', r.structural && r.structural.length > 40, r.structural);
    }
    // a typed command line, a search, a range and a delete on the B+ tree
    const typed = await b.eval(js(() => {
      const p = document.querySelector('.dock-pane:not([hidden])');
      const sel = p.querySelector('.ix-head select'); sel.value = 'bplus'; sel.dispatchEvent(new Event('change'));
      const inp = p.querySelector('.lab-in'); inp.value = 'insert 8 14 21 26 33 38 44 50 57 63; search 38; range 14 40; delete 21 26 33';
      inp.dispatchEvent(new Event('input'));
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      const items = [...p.querySelectorAll('.lab-li')].map((x) => x.textContent);
      return { n: items.length, search: items.some((t) => /search 38/.test(t)), range: items.some((t) => /range/.test(t)), merge: items.some((t) => /merge|redistribute/.test(t)) };
    }));
    ok('typed commands run in order', typed.n > 20 && typed.search && typed.range, typed);
    ok('deletes coalesce or redistribute', typed.merge, typed);
    // a parameter change replays the same keys
    const replay = await b.eval(js(() => {
      const p = document.querySelector('.dock-pane:not([hidden])');
      const s = p.querySelector('.lab-param select'); s.value = '6'; s.dispatchEvent(new Event('change'));
      return p.querySelector('.lab-say').textContent;
    }));
    ok('changing the fan-out replays the keys', /delete|Deleted/.test(replay), replay);
    // the plane: click to insert, drag for a window
    await b.eval(js(() => { const p = document.querySelector('.dock-pane:not([hidden])'); const sel = p.querySelector('.ix-head select'); sel.value = 'rtree'; sel.dispatchEvent(new Event('change')); }));
    const box = await b.eval(`(() => { const r = ${pane}.querySelector('.ix-plane-svg').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()`);
    for (const [fx, fy] of [[0.3, 0.3], [0.6, 0.4], [0.4, 0.7], [0.7, 0.75], [0.2, 0.8]]) await b.click(box[0] + box[2] * fx, box[1] + box[3] * fy);
    const pts = await b.eval(`${pane}.querySelectorAll('.ix-plane-svg .ix-pt').length`);
    ok('clicking the plane inserts points', pts === 5, pts);
    await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box[0] + box[2] * 0.15, y: box[1] + box[3] * 0.15, button: 'left', clickCount: 1 });
    await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box[0] + box[2] * 0.5, y: box[1] + box[3] * 0.5, button: 'left' });
    await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box[0] + box[2] * 0.8, y: box[1] + box[3] * 0.85, button: 'left' });
    await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box[0] + box[2] * 0.8, y: box[1] + box[3] * 0.85, button: 'left', clickCount: 1 });
    await b.sleep(100);
    const win = await b.eval(`({ window: !!${pane}.querySelector('.ix-plane-svg .ix-window'), say: ${pane}.querySelector('.lab-say').textContent })`);
    ok('dragging a rectangle runs a window query', win.window && /Window/.test(win.say), win);
    // the comparisons
    const cmp1 = await b.eval(js(() => {
      const p = document.querySelector('.dock-pane:not([hidden])');
      [...p.querySelectorAll('.seg button')].find((x) => x.textContent === 'B+ vs B-tree').click();
      p.querySelector('.lab-chip').click();
      [...p.querySelectorAll('.lab-chip')].find((x) => x.textContent === 'search 38').click();
      return { svgs: p.querySelectorAll('.lab-two .ix-scroll svg').length, text: p.querySelector('.lab-two').textContent };
    }));
    ok('B+ tree and B-tree side by side', cmp1.svgs === 2 && /search 38/.test(cmp1.text), cmp1);
    const cmp2 = await b.eval(js(() => {
      const p = document.querySelector('.dock-pane:not([hidden])');
      [...p.querySelectorAll('.seg button')].find((x) => x.textContent === 'LSM vs B+ writes').click();
      [...p.querySelectorAll('.lab-chip')].find((x) => x.textContent === 'random 100').click();
      return { chart: !!p.querySelector('.ix-chart path.s1') && !!p.querySelector('.ix-chart path.s2'), stats: p.querySelector('.ix-stats').textContent };
    }));
    ok('LSM against B+ tree page writes', cmp2.chart && /LSM write amp/.test(cmp2.stats), cmp2);
    ok('playground: no console errors', errors(b).length === 0, errors(b));
  } finally { await b.close(); }
}

// ---- the Bloom filter lab ---------------------------------------------------------------------------------------------------
{
  const b = await open(1440, 1000);
  try {
    await b.eval(`K.app.openView('bloom'); 1`);
    const r = await b.eval(js(() => {
      const p = document.querySelector('.dock-pane:not([hidden])');
      const chip = (t) => [...p.querySelectorAll('.lab-chip')].find((x) => x.textContent.includes(t)).click();
      chip('six');
      const on = p.querySelectorAll('.bl-bit.on').length;
      chip('query Ferry');
      const verdict = p.querySelector('.bl-verdict').textContent;
      chip('find a false positive');
      const fp = p.querySelector('.bl-verdict.fp') ? p.querySelector('.bl-verdict').textContent : '';
      const charts = p.querySelectorAll('.ix-chart').length;
      const s = p.querySelector('.ix-head select'); s.value = '128'; s.dispatchEvent(new Event('change'));
      const bits = p.querySelectorAll('.bl-bit').length;
      [...p.querySelectorAll('.ix-head .btn')].find((x) => /Optimal/.test(x.textContent)).click();
      const k = +p.querySelectorAll('.ix-head select')[1].value;
      return { on, verdict, fp, charts, bits, k };
    }));
    ok('inserting sets bits', r.on > 3 && r.on <= 18, r.on);
    ok('a query gets a verdict', /Query Ferry/.test(r.verdict), r.verdict);
    ok('a false positive is found and explained', /false positive/.test(r.fp), r.fp);
    ok('the two charts are drawn', r.charts === 2, r.charts);
    ok('m changes the bit array', r.bits === 128, r.bits);
    ok('optimal k is (m/n) ln 2', r.k === Math.min(16, Math.max(1, Math.round((128 / 6) * Math.LN2))), r.k);
    ok('Bloom lab: no console errors', errors(b).length === 0, errors(b));
  } finally { await b.close(); }
}

// ---- phone width -------------------------------------------------------------------------------------------------------------
{
  const b = await open(390, 844);
  try {
    for (const id of ['index', 'indexlab', 'bloom']) {
      const r = await b.eval(`(() => {
        K.app.openView(${JSON.stringify(id)});
        const p = ${pane};
        const chip = p.querySelector('.lab-chip'); if (chip) chip.click();
        const body = p.querySelector('.view-body');
        const over = [...p.querySelectorAll('.ix-body > *')].filter((e) => !e.classList.contains('ix-canvas') && e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).overflowX === 'visible').map((e) => e.className);
        return { body: [body.scrollWidth, body.clientWidth], page: document.documentElement.scrollWidth, over };
      })()`);
      ok(id + ' fits a phone', r.body[0] <= r.body[1] + 1 && r.page <= 391 && !r.over.length, r);
    }
    ok('phone: no console errors', errors(b).length === 0, errors(b));
  } finally { await b.close(); }
}

console.log(`index views: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
