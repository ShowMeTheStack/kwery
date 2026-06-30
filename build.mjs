// Build: inline the CSS, the sample databases and all the JavaScript (in manifest order) into one index.html.
import { readFileSync, writeFileSync, readdirSync, existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(join(root, 'src', p), 'utf8');
const manifest = JSON.parse(src('manifest.json'));
let version = '0.1.0';
try { version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version; } catch (e) { /* none yet */ }
const expand = (list) => (list || []).flatMap((f) => {
  if (f.includes('*')) {
    const d = f.slice(0, f.lastIndexOf('/'));
    const re = new RegExp('^' + f.slice(f.lastIndexOf('/') + 1).replace(/\./g, '\\.').replace('*', '.*') + '$');
    return existsSync(join(root, 'src', d)) ? readdirSync(join(root, 'src', d)).filter((x) => re.test(x) && !list.includes(d + '/' + x)).sort().map((x) => d + '/' + x) : [];
  }
  return existsSync(join(root, 'src', f)) ? [f] : [];
});
const files = [...new Set([...expand(manifest.engine), ...expand(manifest.ui)])];
const samples = JSON.parse(src('data/samples.json'));
// each sample database is loaded once here and stored as a snapshot, so the page opens with it at once
const { load } = await import('./tests/load.mjs');
const K = load();
const snapshots = {};
// snapshots are cached between builds, keyed by the sample's SQL and the engine's code
const { createHash } = await import('node:crypto');
const { mkdirSync } = await import('node:fs');
const engineHash = createHash('sha1').update(manifest.engine.map((f) => (existsSync(join(root, 'src', f)) ? src(f) : '')).join('\n')).digest('hex').slice(0, 12);
mkdirSync(join(root, '.cache'), { recursive: true });
for (const s of samples) {
  const key = join(root, '.cache', 'snap-' + s.id + '-' + engineHash + '-' + createHash('sha1').update(src('data/' + s.file)).digest('hex').slice(0, 12) + '.json');
  if (existsSync(key)) { snapshots[s.id] = JSON.parse(readFileSync(key, 'utf8')); continue; }
  const db = new K.Database({ pageSize: 4096 });
  const ses = db.session({ name: 'build' });
  ses.exec(src('data/' + s.file));
  ses.exec('analyze');
  ses.exec('checkpoint');
  db.buffers.flushAll();
  snapshots[s.id] = K.Snapshot.save(db);
  writeFileSync(key, JSON.stringify(snapshots[s.id]));
}
// a big snapshot is stored compressed (deflate, then base64) and opened asynchronously in the page
const { deflateRawSync } = await import('node:zlib');
// the first sample (the one the page opens with) is inside the page; the others are files beside it, fetched
// when chosen (and built from their SQL when the page is opened without a server)
mkdirSync(join(root, 'data'), { recursive: true });
const packed = (s, i) => {
  if (i === 0) return { snapshot: snapshots[s.id] };
  const kwz = join(root, 'data', s.id + '.kwz');
  writeFileSync(kwz + '.' + process.pid, deflateRawSync(Buffer.from(JSON.stringify(snapshots[s.id])), { level: 9 }));
  renameSync(kwz + '.' + process.pid, kwz);
  return { file: 'data/' + s.id + '.kwz' };
};
const data = 'K.SAMPLES = {' + samples.map((s, i) => JSON.stringify(s.id) + ': ' + JSON.stringify(Object.assign({ title: s.title, about: s.about, sql: src('data/' + s.file) }, packed(s, i)))).join(',\n') + '};\nK.VERSION = ' + JSON.stringify(version) + ';';
const js = files.map((f) => `// ==== ${f} ====\n${src(f)}`).join('\n').replace('// ==== ' + (expand(manifest.ui)[0] || 'ui') + ' ====', (m) => '// ==== sample databases ====\n(function (root) { const K = root.K;\n' + data + '\n})(window);\n' + m).replace(/<\/script/gi, '<\\/script');
const css = expand(manifest.css).map((f) => src(f)).join('\n');
let html = src('shell.html');
html = html.replace('/*@@CSS@@*/', () => css);
html = html.replace('//@@JS@@', () => js);
if (existsSync(join(root, 'assets', 'author.png'))) html = html.replace(/@@AUTHOR_PNG@@/g, () => readFileSync(join(root, 'assets', 'author.png')).toString('base64'));
html = html.replace(/@@VERSION@@/g, version);
// written aside and renamed, so a page loaded during a build never sees half a file
writeFileSync(join(root, 'index.html.' + process.pid), html);
renameSync(join(root, 'index.html.' + process.pid), join(root, 'index.html'));
console.log(`index.html: ${(html.length / 1024).toFixed(1)} KB, ${files.length} scripts`);
