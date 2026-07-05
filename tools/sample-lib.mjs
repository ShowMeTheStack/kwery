// Shared parts of the sample database generators: a seeded random number generator, invented names, SQL quoting,
// multi-row INSERT statements and writing the file. Every generator seeds its own generator, so the rows never change.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function rng(seed) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const chance = (p) => rnd() < p;
  const shuffle = (a) => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
  const sample = (a, n) => shuffle(a).slice(0, n);
  return { rnd, int, pick, chance, shuffle, sample };
}

export const FIRST = ['Aditi', 'Bruno', 'Chen', 'Dagny', 'Emeka', 'Farah', 'Goran', 'Hana', 'Ilya', 'Jun', 'Kofi', 'Lena', 'Mateo', 'Nadia', 'Oskar', 'Priya', 'Quinn', 'Rafael', 'Sana', 'Tomas', 'Uma', 'Viktor', 'Wen', 'Ximena', 'Yusuf', 'Zara',
  'Amara', 'Ben', 'Clara', 'David', 'Elena', 'Felix', 'Grace', 'Hugo', 'Iris', 'Jonas', 'Kira', 'Leo', 'Maya', 'Nico', 'Olga', 'Pablo', 'Rosa', 'Sami', 'Tara', 'Ivan', 'Vera', 'Omar', 'Lucia', 'Anil'];
export const LAST = ['Abara', 'Bellweather', 'Castellano', 'Dubois', 'Eriksen', 'Fujimoto', 'Gallagher', 'Hartmann', 'Iyer', 'Jovanovic', 'Kowalski', 'Lindqvist', 'Moreau', 'Nakamura', 'Okafor', 'Petrov', 'Quintero', 'Rahman', 'Sorensen', 'Takahashi', 'Ueda', 'Valdez', 'Whitfield', 'Xu', 'Yilmaz', 'Zielinski',
  'Achebe', 'Bianchi', 'Carvalho', 'Dhillon', 'Esposito', 'Ferreira', 'Grigoryan', 'Halvorsen', 'Ibarra', 'Jansen', 'Kaur', 'Larsen', 'Mbeki', 'Novak', 'Ortega', 'Park', 'Rossi', 'Santos', 'Tanaka', 'Usman', 'Varga', 'Weber', 'Yamamoto', 'Zhou'];

/** a SQL literal: null, a number, a boolean or a quoted string */
export const q = (v) => (v === null || v === undefined ? 'null' : typeof v === 'number' || typeof v === 'bigint' ? String(v) : typeof v === 'boolean' ? String(v) : "'" + String(v).replace(/'/g, "''") + "'");
/** INSERT statements of up to `chunk` rows each; rows are arrays of values (strings are quoted, raw SQL is { sql }) */
export function insert(table, cols, rows, chunk = 1000) {
  const lit = (v) => (v && typeof v === 'object' && 'sql' in v ? v.sql : q(v));
  const out = [];
  for (let i = 0; i < rows.length; i += chunk) out.push('insert into ' + table + (cols ? ' (' + cols.join(', ') + ')' : '') + ' values\n' + rows.slice(i, i + chunk).map((r) => '  (' + r.map(lit).join(', ') + ')').join(',\n') + ';');
  return out.join('\n');
}
export const pad = (n, w) => String(n).padStart(w, '0');
/** a date as YYYY-MM-DD, `days` after a start date (UTC arithmetic, so no time zone moves it) */
export function day(start, days) { const d = new Date(Date.parse(start + 'T00:00:00Z') + days * 86400000); return d.toISOString().slice(0, 10); }
/** a timestamp as YYYY-MM-DD HH:MI:SS, `minutes` after a start timestamp */
export function stamp(start, minutes) { const d = new Date(Date.parse(start.replace(' ', 'T') + 'Z') + Math.round(minutes) * 60000); return d.toISOString().slice(0, 19).replace('T', ' '); }
export function write(file, parts, counts) {
  const text = parts.join('\n\n') + '\n';
  fs.writeFileSync(path.join(root, 'src/data', file), text);
  console.log(file + ': ' + (text.length / 1024).toFixed(1) + ' KB; ' + Object.entries(counts).map(([k, v]) => k + ' ' + v).join(', '));
}
