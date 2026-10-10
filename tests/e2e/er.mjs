// End-to-end test of the E-R editor, the schema diagram and the E-R exercises, in headless Chrome: a design is
// built with the toolbar, the canvas and the text pane, drawn in all three notations, undone and redone, reduced
// to tables and run in a new schema, read back from the database, and an exercise is checked.
// Run: node build.mjs && node tests/e2e/er.mjs
import { launch } from '../../tools/cdp.mjs';

let pass = 0, fail = 0;
const ok = (c, what, extra) => { if (c) pass++; else { fail++; console.log('FAIL ' + what + (extra !== undefined ? '\n  ' + JSON.stringify(extra) : '')); } };
const b = await launch({ width: 1500, height: 950 });
const ev = (js) => b.eval('(() => {' + js + '})()');
const ed = 'K.UI.ER.editor()';
async function clickAt(p) { await b.click(p.x, p.y); await b.sleep(60); }
async function node(id) { return ev('return ' + ed + '.screenOf(' + JSON.stringify(id) + ');'); }

try {
  await b.goto('');
  await b.waitFor('window.K && K.app && document.querySelector(".tab")', 20000);
  // a clean browser: no saved diagrams, a wide dock
  await ev("Object.keys(localStorage).filter((k) => k.startsWith('kwery.er') || k.startsWith('kwery.erd') || k === 'kwery.progress').forEach((k) => localStorage.removeItem(k)); return 1;");
  await b.eval("K.app.openView('er'); document.querySelector('.dock').style.width = '1100px'; K.app.dock.renderActive(); 1");
  await b.sleep(200);
  ok(await ev('return ' + ed + '.model().entities.length === 9;'), 'starts with the theatre design');
  ok(await ev("return document.querySelectorAll('.er-diagram rect').length > 9 && /production/.test(document.querySelector('.er-diagram').textContent);"), 'the diagram is drawn');
  ok(await ev("return /entity sets/.test(document.querySelector('.er-intro').textContent);"), 'the view starts with an explanation');

  // ---- a new design built on the canvas
  await b.eval(ed + '.act.replaceModel({ entities: [] }, "Library"); 1');
  ok(await ev('return ' + ed + '.model().entities.length === 0;'), 'new empty diagram');
  await b.clickSel('.er-tools .btn[title^="Add an entity set"]');
  await b.waitFor("document.querySelector('.er-rename')");
  await b.eval("document.querySelector('.er-rename').select(); 1");
  await b.insertText('book');
  await b.key('Enter');
  await b.sleep(80);
  ok(await ev('return !!K.ER.entity(' + ed + '.model(), "book");'), 'entity added with the toolbar and renamed inline');
  // a double-click on the empty canvas adds another entity set there
  const r = await ev("const r = document.querySelector('.er-canvas').getBoundingClientRect(); return { x: r.left + 120, y: r.top + 120 };");
  await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
  await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
  await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 2 });
  await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 2 });
  await b.waitFor("document.querySelector('.er-rename')");
  await b.eval("document.querySelector('.er-rename').select(); 1");
  await b.insertText('author');
  await b.key('Enter');
  await b.sleep(80);
  ok(await ev('return ' + ed + '.model().entities.map((e) => e.name).join() === "book,author";'), 'double-click on the canvas adds an entity set', await ev('return ' + ed + '.model().entities.map((e) => e.name);'));
  // relationship: the toolbar button, then a click on each entity set
  await b.clickSel('.er-tools button[title^="Add a relationship set"]');
  ok(await ev("return !document.querySelector('.er-hint').hidden;"), 'relationship mode shows a hint');
  await clickAt(await node('e:author'));
  await clickAt(await node('e:book'));
  await b.waitFor("document.querySelector('.er-rename')");
  await b.eval("document.querySelector('.er-rename').select(); 1");
  await b.insertText('wrote');
  await b.key('Enter');
  await b.sleep(80);
  ok(await ev('const r = K.ER.relationship(' + ed + '.model(), "wrote"); return !!r && r.participants.map((p) => p.entity).join() === "author,book";'), 'relationship drawn between two clicked entity sets');
  // attributes through the API the toolbar uses, then cardinality in the properties
  await b.eval(ed + '.act.select({ kind: "entity", name: "book" }); ' + ed + '.act.addAttribute("simple"); 1');
  await b.sleep(80);
  await b.eval("document.querySelector('.er-rename') && document.querySelector('.er-rename').blur(); 1");
  ok(await ev('return K.ER.entity(' + ed + '.model(), "book").attributes.length === 2;'), 'attribute added to the selected entity set');
  await b.eval(ed + '.act.select({ kind: "relationship", name: "wrote" }); 1');
  await b.sleep(50);
  await b.eval("[...document.querySelectorAll('.er-props .er-seg button')].find((x) => x.textContent === 'N : 1').click(); 1");
  ok(await ev('return K.ER.mapping(K.ER.relationship(' + ed + '.model(), "wrote")) === "N:1";'), 'mapping cardinality set in the properties');
  // drag a node: its position changes and stays
  const p0 = await node('e:book');
  await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p0.x, y: p0.y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 5; i++) await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p0.x + i * 16, y: p0.y + i * 8, button: 'left', buttons: 1 });
  await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p0.x + 80, y: p0.y + 40, button: 'left', clickCount: 1 });
  await b.sleep(120);
  const p1 = await node('e:book');
  ok(Math.abs(p1.x - p0.x - 80) < 3 && Math.abs(p1.y - p0.y - 40) < 3, 'dragging moves the entity set', [p0, p1]);

  // ---- undo and redo
  const n0 = await ev('return K.ER.entity(' + ed + '.model(), "book").attributes.length;');
  await b.eval(ed + '.act.undo(); 1');
  const moved = await node('e:book');
  ok(Math.abs(moved.x - p0.x) < 3, 'undo puts the dragged node back');
  await b.eval(ed + '.act.undo(); ' + ed + '.act.undo(); 1');
  ok(await ev('return K.ER.entity(' + ed + '.model(), "book").attributes.length === ' + (n0 - 1) + ';'), 'undo removes the attribute');
  await b.eval(ed + '.act.redo(); ' + ed + '.act.redo(); ' + ed + '.act.redo(); 1');
  ok(await ev('return K.ER.entity(' + ed + '.model(), "book").attributes.length === ' + n0 + ' && K.ER.mapping(K.ER.relationship(' + ed + '.model(), "wrote")) === "N:1";'), 'redo brings the changes back');
  await b.eval("document.querySelector('.er-canvas').focus(); 1");
  await b.key('z', { ctrl: true });
  await b.sleep(50);
  ok(await ev('return K.ER.mapping(K.ER.relationship(' + ed + '.model(), "wrote")) !== "N:1" || Math.abs(' + ed + '.screenOf("e:book").x - ' + p0.x + ') < 3;'), 'Ctrl+Z undoes');
  await b.key('z', { ctrl: true, shift: true });

  // ---- the text pane: errors are marked at their place, a valid text redraws the diagram
  await b.eval(ed + '.act.showTab("text"); 1');
  ok(await ev("return /entity book/.test(document.querySelector('.er-textpane textarea').value);"), 'diagram changes show in the text');
  await b.eval(ed + '.act.setText("entity book (isbn key, title)\\nentity author (author_id key, , name)\\nrelationship wrote (author, book)"); 1');
  await b.sleep(50);
  ok(await ev("return !document.querySelector('.er-perr').hidden && /Line 2, column 31/.test(document.querySelector('.er-perr').textContent) && !!document.querySelector('.er-textpane .mk-err');"), 'a parse error is shown and underlined at its position', await ev("return document.querySelector('.er-perr').textContent;"));
  await b.eval(ed + '.act.setText("entity book (isbn key, title, {keyword})\\nentity author (author_id key, name)\\nweak entity copy (copy_no partial, shelf)\\nidentifying relationship book_copy (copy [1..1] total, book [0..*])\\nrelationship wrote (author [0..*], book [1..*] total)\\nentity member (card_no key, name)\\nrelationship borrows (copy [0..1], member [0..*]) with (due date)\\n"); 1');
  await b.sleep(80);
  ok(await ev("return document.querySelector('.er-perr').hidden && " + ed + ".model().entities.length === 4 && /member/.test(document.querySelector('.er-diagram').textContent);"), 'a valid text redraws the diagram');
  ok(await ev('return !!' + ed + '.screenOf("e:book") && !!' + ed + '.screenOf("e:copy");'), 'nodes kept or placed after a text edit');

  // ---- notations
  for (const [k, label] of [['chen', 'Chen'], ['crowsfoot', 'Crow\'s foot'], ['textbook', 'Boxed attributes']]) {
    await b.eval("[...document.querySelectorAll('.er-nt button')].find((x) => x.textContent === " + JSON.stringify(label) + ").click(); 1");
    await b.sleep(60);
    const st = await ev('return { nt: ' + ed + '.notation(), ellipses: document.querySelectorAll(".er-diagram ellipse").length, polys: document.querySelectorAll(".er-diagram polygon").length, text: document.querySelector(".er-diagram").textContent };');
    ok(st.nt === k, 'notation ' + k);
    if (k === 'chen') ok(st.ellipses >= 8, 'Chen draws attribute ovals', st.ellipses);
    if (k === 'crowsfoot') ok(/varchar|PK/.test(st.text) || /PK/.test(st.text), 'crow\'s foot lists keys', st.text.slice(0, 80));
    if (k === 'textbook') ok(st.polys >= 3 && /keyword/.test(st.text), 'the boxed notation draws diamonds and attributes in the boxes');
  }
  // specialization, aggregation and connect, from the toolbar
  await b.eval(ed + '.act.select({ kind: "entity", name: "member" }); 1');
  await b.clickSel('.er-tools .btn[title^="Specialize"]');
  ok(await ev('const m = ' + ed + '.model(); return m.specializations.length === 1 && m.specializations[0].parent === "member" && m.entities.length === 5;'), 'ISA adds a lower-level entity set');
  await b.eval(ed + '.act.select({ kind: "relationship", name: "borrows" }); 1');
  await b.clickSel('.er-tools .btn[title^="Aggregate"]');
  ok(await ev('return ' + ed + '.model().aggregations.length === 1 && ' + ed + '.layout().groups.length === 1;'), 'aggregation drawn as a box');
  await b.eval(ed + '.act.commit((m) => { m.entities.push({ name: "librarian", attributes: [{ name: "staff_id", key: true }] }); m.relationships.push({ name: "approves", participants: [{ entity: "librarian", min: 0, max: "*" }, { entity: "author", min: 0, max: "*" }], attributes: [] }); }); 1');
  await b.eval(ed + '.act.select({ kind: "relationship", name: "approves" }); 1');
  await b.clickSel('.er-tools .btn[title^="Connect"]');
  ok(await ev("return !document.querySelector('.er-hint').hidden && /entity set/.test(document.querySelector('.er-hint').textContent);"), 'connect mode starts from the selected relationship set');
  await b.eval(ed + '.act.pickInMode({ kind: "aggregation", name: ' + ed + '.model().aggregations[0].name }); 1');
  ok(await ev('const r = K.ER.relationship(' + ed + '.model(), "approves"); return r.participants.length === 3 && r.participants[2].entity === ' + ed + '.model().aggregations[0].name;'), 'connect adds the aggregation as a participant');
  ok(await ev('return K.ER.errors(' + ed + '.model()).length === 0;'), 'the design stays valid', await ev('return K.ER.errors(' + ed + '.model()).map((x) => x.message);'));
  // keys: F2 renames, Delete removes, Escape clears the selection
  await b.eval(ed + '.act.select({ kind: "entity", name: "librarian" }); document.querySelector(".er-canvas").focus(); 1');
  await b.key('F2');
  await b.waitFor("document.querySelector('.er-rename')");
  await b.eval("document.querySelector('.er-rename').select(); 1");
  await b.insertText('clerk');
  await b.key('Enter');
  await b.sleep(60);
  ok(await ev('const m = ' + ed + '.model(); return !!K.ER.entity(m, "clerk") && K.ER.relationship(m, "approves").participants[0].entity === "clerk";'), 'F2 renames, and the relationship follows');
  await b.eval(ed + '.act.select({ kind: "entity", name: "clerk" }); document.querySelector(".er-canvas").focus(); 1');
  await b.key('Backspace');
  await b.sleep(60);
  ok(await ev('return !K.ER.entity(' + ed + '.model(), "clerk");'), 'Backspace deletes the selection');
  await b.eval(ed + '.act.undo(); 1');
  // exports: SVG, PNG and the text, captured instead of downloaded
  await b.eval("window.__dl = []; const d = K.UI.download; K.UI.download = (n, t) => window.__dl.push([n, t.length, t.slice(0, 60)]); HTMLAnchorElement.prototype.__click = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) window.__dl.push([this.download, 0, this.href.slice(0, 5)]); else this.__click(); }; window.__restore = () => { K.UI.download = d; HTMLAnchorElement.prototype.click = HTMLAnchorElement.prototype.__click; }; 1");
  for (const label of ['Download as SVG', 'Download as PNG', 'Download the text (.er)']) {
    await b.clickSel('.er-tools .btn[title^="New, open"]');
    await b.eval("[...document.querySelectorAll('.menu-item')].find((x) => x.textContent.includes(" + JSON.stringify(label) + ")).click(); 1");
    await b.sleep(300);
  }
  const dl = await ev('const r = window.__dl; window.__restore(); return r;');
  ok(dl.length === 3 && /\.svg$/.test(dl[0][0]) && /<svg/.test(dl[0][2]) && /\.png$/.test(dl[1][0]) && dl[1][2] === 'blob:' && /\.er$/.test(dl[2][0]), 'SVG, PNG and text exports', dl);
  // save in the browser under a name, change the diagram, open the saved one again
  await b.clickSel('.er-tools .btn[title^="New, open"]');
  await b.eval("[...document.querySelectorAll('.menu-item')].find((x) => /Save in this browser/.test(x.textContent)).click(); 1");
  await b.waitFor("document.querySelector('.dlg input')");
  await b.eval("const i = document.querySelector('.dlg input'); i.value = 'Library design'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); 1");
  await b.sleep(60);
  const before = await ev('return ' + ed + '.model().entities.length;');
  await b.eval(ed + '.act.replaceModel({ entities: [] }, ""); 1');
  await b.clickSel('.er-tools .btn[title^="New, open"]');
  await b.eval("[...document.querySelectorAll('.menu-item')].find((x) => /Open a saved diagram/.test(x.textContent)).click(); 1");
  await b.waitFor("document.querySelector('.er-saved-open')");
  await b.eval("[...document.querySelectorAll('.er-saved-open')].find((x) => /Library design/.test(x.textContent)).click(); 1");
  await b.sleep(60);
  ok(await ev('return ' + ed + '.model().entities.length === ' + before + ' && !document.querySelector(".dlg");'), 'a saved diagram opens again');
  // checks: a key-less entity set is reported and a click selects it
  await b.eval(ed + '.act.commit((m) => { m.entities.push({ name: "shelfmark", attributes: [{ name: "code" }] }); }); ' + ed + '.act.showTab("checks"); 1');
  await b.sleep(60);
  ok(await ev("return [...document.querySelectorAll('.er-ci.error')].some((x) => /shelfmark/.test(x.textContent));"), 'checks list a missing key');
  await b.eval("[...document.querySelectorAll('.er-ci.error')].find((x) => /shelfmark/.test(x.textContent)).click(); 1");
  ok(await ev("return document.querySelectorAll('.er-over .er-sel').length === 1;"), 'clicking a check highlights the element');
  await b.eval(ed + '.act.remove(); 1');
  ok(await ev('return !K.ER.entity(' + ed + '.model(), "shelfmark");'), 'delete removes the selected entity set');

  // ---- To SQL and run it in a new schema
  await b.clickSel('.er-tools button[title^="Reduce the design"]');
  await b.waitFor("document.querySelector('.er-sql .er-step')");
  ok(await ev("return /Step 1 of \\d+/.test(document.querySelector('.er-step-pos').textContent);"), 'To SQL shows the steps one at a time');
  await b.clickSel('.er-stepper .btn[title="Next rule"]');
  ok(await ev("return /Step 2 of/.test(document.querySelector('.er-step-pos').textContent) && document.querySelectorAll('.er-tbl').length >= 5 && /create table/.test(document.querySelector('.er-ddl').textContent);"), 'next rule, tables and DDL');
  await b.eval("[...document.querySelectorAll('.er-sql .btn.primary')].find((x) => /Run in a new schema/.test(x.textContent)).click(); 1");
  await b.sleep(200);
  const made = await ev("const c = K.app.session.catalog; return c.schemas.has('er_1') ? c.tables(['table']).filter((t) => t.schema === 'er_1').map((t) => t.name).sort() : null;");
  ok(made && made.includes('book') && made.includes('copy') && made.includes('wrote') && made.includes('book_keyword'), 'the DDL ran in schema er_1', made);
  ok(await ev("return !document.querySelector('.er-sql');"), 'the dialog closes after running');
  ok(await ev("return K.app.dock.active === 'erd' && document.querySelector('.erd-head select').value === 'er_1';"), 'the schema diagram shows the new schema');
  ok(await ev("return document.querySelectorAll('.erd-head ~ .er-main .er-hit-node').length === " + (made ? made.length : -1) + ";"), 'one box per table in the schema diagram');

  // ---- the schema diagram of the Theatre database: a click shows a table
  await b.eval("const s = document.querySelector('.erd-head select'); s.value = 'public'; s.dispatchEvent(new Event('change')); 1");
  await b.sleep(100);
  ok(await ev("return document.querySelectorAll('.erd-head ~ .er-main .er-hit-node').length === 11 && /FK/.test(document.querySelector('.erd-head ~ .er-main .er-diagram').textContent);"), 'the Theatre schema has 11 tables with FK marks');
  const tp = await ev("const v = K.app.dock.open.find((o) => o.id === 'erd').view; const L = v.layout(); const n = L.nodes.find((x) => x.name === 'artist'); const sv = document.querySelector('.erd-head ~ .er-main svg.er-svg'); const r = sv.getBoundingClientRect(); const t = sv.querySelector('g').getAttribute('transform'); const m = /translate\\(([-\\d.]+),([-\\d.]+)\\) scale\\(([-\\d.]+)\\)/.exec(t); return { x: r.left + +m[1] + (n.x + n.w / 2 + L.origin.x) * +m[3], y: r.top + +m[2] + (n.y + n.h / 2 + L.origin.y) * +m[3] };");
  await clickAt(tp);
  ok(await ev("return /artist/.test(document.querySelector('.erd-info').textContent) && /company/.test(document.querySelector('.erd-info').textContent);"), 'clicking a table shows its keys and references');
  await b.eval("K.app.runText('create table public.erd_probe (id int primary key, ref varchar(6) references artist (person_id));'); 1");
  await b.sleep(100);
  ok(await ev("return document.querySelectorAll('.erd-head ~ .er-main .er-hit-node').length === 12;"), 'the schema diagram follows CREATE TABLE');
  await b.eval("K.app.runText('drop table public.erd_probe;'); 1");

  // ---- From the database
  await b.eval("K.app.openView('er'); " + ed + ".act.fromDb(); 1");
  await b.waitFor("document.querySelector('.er-fromdb svg')");
  ok(await ev("return document.querySelectorAll('.er-fromdb .er-list li').length > 10 && /cannot/.test(document.querySelector('.er-fromdb').textContent) && /guess/.test(document.querySelector('.er-fromdb').textContent);"), 'From the database shows the diagram, the notes and the losses');
  await b.eval("[...document.querySelectorAll('.dlg-foot .btn')].find((x) => /Open it in the editor/.test(x.textContent)).click(); 1");
  await b.sleep(150);
  ok(await ev('return ' + ed + '.model().entities.some((e) => e.name === "stage" && e.weak) && ' + ed + '.model().entities.length >= 7;'), 'the recovered design opens in the editor');
  await b.eval(ed + '.act.undo(); 1');
  ok(await ev('return !!K.ER.entity(' + ed + '.model(), "member");'), 'opening another design can be undone');

  // ---- save and load in the browser
  ok(await ev("const w = JSON.parse(localStorage.getItem('kwery.er.work')); return !!w && w.model.entities.some((e) => e.name === 'member');"), 'the working diagram is kept in the browser');

  // ---- an exercise: the button in the problem opens the editor on the exercise's own diagram
  await b.eval("K.UI.Exercises.open(K.app, 'er-chess'); 1");
  await b.sleep(100);
  ok(await ev("return K.app.dock.active === 'exercise' && /Chess league/.test(document.querySelector('.dock-pane:not([hidden]) .ls-title').textContent);"), 'the E-R exercise opens');
  await b.eval("[...document.querySelectorAll('.dock-pane:not([hidden]) .ls-view')].find((x) => /E-R editor/.test(x.textContent)).click(); 1");
  await b.sleep(100);
  ok(await ev('return K.app.dock.active === "er" && ' + ed + '.exercise() === "chess" && ' + ed + '.model().entities.length === 0 && !document.querySelector(".er-banner").hidden;'), 'the editor switches to the exercise\'s empty diagram');
  // a first attempt: the arbiter as an attribute of game
  await b.eval(ed + '.act.setText("entity club (club_name key, town, venue)\\nentity player (rating_no key, name, birth_date)\\nrelationship registered (player [0..1], club [0..*]) with (board_no)\\nentity game (game_id key, played, result, arbiter_no)\\nrelationship white (game [1..1] total, player as white_player [0..*])\\nrelationship black (game [1..1] total, player as black_player [0..*])\\n"); 1');
  await b.sleep(60);
  await b.eval("K.UI.Exercises.open(K.app, 'er-chess'); 1");
  await b.sleep(60);
  await b.eval("[...document.querySelectorAll('.dock-pane:not([hidden]) .ex-tools .btn')].find((x) => /Check my answer/.test(x.textContent)).click(); 1");
  await b.sleep(60);
  ok(await ev("const r = document.querySelector('.dock-pane:not([hidden]) .ex-res'); return !!r && r.classList.contains('bad') && /arbiter/.test(r.textContent);"), 'a wrong design is explained', await ev("const r = document.querySelector('.dock-pane:not([hidden]) .ex-res'); return r && r.textContent.slice(0, 300);"));
  await b.eval("K.app.openView('er'); " + ed + ".act.setText(K.ER.exercise('chess').reference); 1");
  await b.sleep(60);
  await b.eval("K.UI.Exercises.open(K.app, 'er-chess'); 1");
  await b.sleep(60);
  await b.eval("[...document.querySelectorAll('.dock-pane:not([hidden]) .ex-tools .btn')].find((x) => /Check my answer/.test(x.textContent)).click(); 1");
  await b.sleep(60);
  ok(await ev("const r = document.querySelector('.dock-pane:not([hidden]) .ex-res'); return !!r && r.classList.contains('ok');"), 'the reference design is accepted');
  ok(await ev("return !!JSON.parse(localStorage.getItem('kwery.progress')).solved['er-chess'];"), 'the exercise counts as solved');
  ok(await ev("return K.Content.exercises.size >= 25 && [...K.Content.exercises.values()].filter((x) => x.kind === 'er').length === 25;"), '25 E-R exercises registered in chapter 6');
  // back to the main diagram
  await b.eval("K.app.openView('er'); " + ed + ".act.leaveExercise(); 1");
  ok(await ev('return ' + ed + '.exercise() === null && !!K.ER.entity(' + ed + '.model(), "member");'), 'back to the main diagram');

  // ---- both themes draw with the theme's colours
  await b.eval("K.app.settings.theme = 'dark'; K.app.applyTheme(); 1");
  ok(await ev("return /#19283b/i.test(document.querySelector('.er-diagram').innerHTML);"), 'the dark theme redraws the diagram');
  await b.eval("K.app.settings.theme = 'light'; K.app.applyTheme(); 1");
  ok(await ev("return /#e8f0fb/i.test(document.querySelector('.er-diagram').innerHTML);"), 'the light theme redraws the diagram');

  const errs = b.logs.filter((l) => l.type === 'error' || l.type === 'exception');
  ok(!errs.length, 'no console errors', errs.map((e) => e.text));
} catch (e) {
  fail++;
  console.log('FAIL ' + e.stack);
} finally {
  await b.close();
}
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
