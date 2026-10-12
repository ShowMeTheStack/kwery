// E-R diagrams in the three notations for every sample and every construct, and the schema diagram of every sample
// database. Run at both sizes with --narrow.
import designs from './er-designs.cjs';

const NOTATIONS = ['textbook', 'chen', 'crowsfoot'];
const wait = (ms) => 'await new Promise((r) => setTimeout(r, ' + ms + '));';
// open the E-R editor maximized, load a design (text, or a sample of the editor by key) and pick the notation
const er = (src, nt) => "K.app.dock.toggleMax(true); K.app.openView('er'); " + wait(300) +
  ' const ed = K.UI.ER.editor();' +
  (src.sample ? ' const s = K.UI.ER.SAMPLES[' + JSON.stringify(src.sample) + ']; ed.act.replaceModel(K.ER.parse(s.text), s.name);' : '') +
  (src.text ? ' ed.act.replaceModel(K.ER.parse(' + JSON.stringify(src.text) + '), ' + JSON.stringify(src.name) + ');' : '') +
  " ed.act.setNotation('" + nt + "'); " + wait(200) + ' ed.canvas.fit();';

// the editor's own view (another view may be open in the dock too)
const ROOT = '.er-view:has(.er-tools)';
const scenarios = [];
// the default design, as the editor opens on it
for (const nt of NOTATIONS) scenarios.push({ name: 'er-default-' + nt, setup: er({}, nt), wait: 900, root: ROOT });
for (const k of ['theatre', 'small']) for (const nt of NOTATIONS) scenarios.push({ name: 'er-sample-' + k + '-' + nt, setup: er({ sample: k }, nt), wait: 900, root: ROOT });
for (const [k, text] of Object.entries(designs)) for (const nt of NOTATIONS) scenarios.push({ name: 'er-' + k + '-' + nt, setup: er({ text, name: k }, nt), wait: k === 'city' ? 2500 : 1000, root: ROOT });

// the schema diagram follows the open database: one scenario per sample database
const SAMPLES = ['theatre', 'theatre-small', 'theatre-large', 'creditunion', 'studio', 'library', 'airline', 'shop', 'sensors'];
for (const id of SAMPLES) scenarios.push({
  name: 'erd-' + id,
  setup: "K.app.settings.sample = '" + id + "'; K.app.newDatabase();" +
    " for (let i = 0; i < 300; i++) { try { if (K.app.db && !K.app.db.loading && K.app.session.catalog.tables(['table']).some((r) => r.schema === 'public')) break; } catch (e) { /* not yet */ } " + wait(100) + ' }' +
    ' ' + wait(400) + " K.app.dock.toggleMax(true); K.app.openView('erd');",
  wait: 1800,
  root: '.er-view:has(.erd-head)',
});
// the design read back from a sample database, drawn in the dialog of From the database
const useDb = (id) => "K.app.settings.sample = '" + id + "'; K.app.newDatabase();" +
  " for (let i = 0; i < 300; i++) { try { if (K.app.session.catalog.tables(['table']).some((r) => r.schema === 'public')) break; } catch (e) { /* not yet */ } " + wait(100) + ' }' + wait(400);
for (const id of SAMPLES) for (const nt of id === 'theatre' ? NOTATIONS : ['textbook']) scenarios.push({
  name: 'er-fromdb-' + id + '-' + nt,
  setup: useDb(id) + er({}, nt) + ' ed.act.fromDb();',
  wait: 1500,
  root: '.er-fromdb',
});
export default scenarios;
