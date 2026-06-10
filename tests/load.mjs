// Loads the engine into this Node process, in the same order as the page.
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ENGINE = ['util', 'decimal', 'datetime', 'types', 'lexer', 'parser'];
export function load(extra) {
  const files = JSON.parse(fs.readFileSync(path.join(root, 'src/manifest.json'), 'utf8')).engine;
  for (const f of files.concat(extra || [])) vm.runInThisContext(fs.readFileSync(path.join(root, 'src', f), 'utf8'), { filename: f });
  return globalThis.K;
}
