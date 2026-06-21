// Built-in string functions: length, substring, trim, pad, replace, split_part, format, quoting, md5 and sha256,
// encode/decode, POSIX regular expressions (PostgreSQL's ARE syntax translated to JavaScript), LIKE and regex
// operators, and to_char / to_number for numbers.
(function (root) {
  'use strict';
  const K = root.K;
  const F = K.F;
  const B = K.T.BASE;
  const Dec = K.Decimal;

  const err = (code, msg, extra) => K.err(code, msg, extra);
  const cps = (s) => Array.from(s); // code points: PostgreSQL counts characters, not UTF-16 units
  const cpLen = (s) => { let n = 0; for (let i = 0; i < s.length; i++) { n++; if (s.charCodeAt(i) >= 0xd800 && s.charCodeAt(i) < 0xdc00) i++; } return n; };
  const txt = (v, t, ctx) => (v === null ? null : typeof v === 'string' ? v : K.T.output(v, t, ctx));
  // case mapping and initcap's word test follow the C locale of the reference cluster: ASCII letters only
  const isAlnum = (c) => /[A-Za-z0-9]/.test(c);
  const up = (s) => s.replace(/[a-z]+/g, (x) => x.toUpperCase());
  const down = (s) => s.replace(/[A-Z]+/g, (x) => x.toLowerCase());
  const fn = F.fn, op = F.op;

  // ---- lengths and case --------------------------------------------------------------------------------------
  const charLen = [{ args: ['text'], ret: 'int4', fn: (v) => cpLen(v[0]) }, { args: ['char'], ret: 'int4', fn: (v) => cpLen(v[0].replace(/ +$/, '')) }];
  fn('length', [...charLen, { args: ['bytea'], ret: 'int4', fn: (v) => v[0].length }]);
  fn('char_length', charLen);
  fn('character_length', charLen);
  fn('octet_length', [{ args: ['text'], ret: 'int4', fn: (v) => K.utf8(v[0]).length }, { args: ['char'], ret: 'int4', fn: (v) => K.utf8(v[0]).length }, { args: ['bytea'], ret: 'int4', fn: (v) => v[0].length }]);
  fn('bit_length', [{ args: ['text'], ret: 'int4', fn: (v) => K.utf8(v[0]).length * 8 }, { args: ['bytea'], ret: 'int4', fn: (v) => v[0].length * 8 }]);
  fn('lower', { args: ['text'], ret: 'text', fn: (v) => down(v[0]) });
  fn('upper', { args: ['text'], ret: 'text', fn: (v) => up(v[0]) });
  fn('initcap', { args: ['text'], ret: 'text', fn: (v) => {
    let out = '', prev = false;
    for (const c of v[0]) { out += prev ? down(c) : up(c); prev = isAlnum(c); }
    return out;
  } });

  // ---- substrings --------------------------------------------------------------------------------------------
  /** characters start .. start+len-1 (1-based), with SQL's rules for starts before 1 */
  function sub(arr, start, len) {
    if (len !== undefined && len < 0) throw err('22011', 'negative substring length not allowed');
    const s1 = Math.max(start, 1);
    if (len === undefined) return arr.slice(s1 - 1);
    const e = start + len;
    if (e <= s1) return arr.slice(0, 0);
    return arr.slice(s1 - 1, e - 1);
  }
  const subText = (v) => sub(cps(v[0]), v[1], v.length > 2 ? v[2] : undefined).join('');
  const subBytes = (v) => sub(v[0], v[1], v.length > 2 ? v[2] : undefined);
  const substrSpecs = [
    { args: ['text', 'int4', 'int4'], minArgs: 2, ret: 'text', fn: subText },
    { args: ['bytea', 'int4', 'int4'], minArgs: 2, ret: 'bytea', fn: subBytes },
  ];
  fn('substr', substrSpecs);
  // substring(text FROM pattern): the first parenthesized part of the match, or the whole match. It comes first so
  // that an unknown literal pattern is taken as text, as PostgreSQL prefers
  fn('substring', { args: ['text', 'text'], ret: 'text', fn: (v) => {
    const m = regex(v[1], '').exec(v[0]);
    if (!m) return null;
    return m.length > 1 ? (m[1] === undefined ? null : m[1]) : m[0];
  } });
  fn('substring', substrSpecs);
  // substring(text SIMILAR pattern ESCAPE esc): the part between the two escape-double-quote markers
  const substringSimilar = { args: ['text', 'text', 'text'], ret: 'text', fn: (v) => {
    const [s, pat, esc] = v;
    if (cpLen(esc) > 1) throw err('22025', 'invalid escape string', { hint: 'Escape string must be empty or one character.' });
    const parts = esc ? splitSimilar(pat, esc) : [pat];
    if (parts.length !== 1 && parts.length !== 3) throw err('2201B', 'SQL regular expression may not contain more than two escape-double-quote separators');
    let re;
    if (parts.length === 1) re = '^(' + similarBody(parts[0], esc) + ')$';
    else re = '^(?:' + similarBody(parts[0], esc).replace(/\*(?!\?)/g, '*?') + ')(' + similarBody(parts[1], esc) + ')(?:' + similarBody(parts[2], esc) + ')$';
    let m;
    try { m = new RegExp(re, 's').exec(s); } catch (e) { throw err('2201B', 'invalid regular expression: ' + String(e.message).replace(/^.*: /, '').toLowerCase()); }
    return m ? (m[1] === undefined ? null : m[1]) : null;
  } };
  fn('substring_similar', substringSimilar);
  // substring(text FROM pattern FOR escape) is the SQL:1999 spelling of SIMILAR ... ESCAPE
  fn('substring', substringSimilar);
  function splitSimilar(pat, esc) {
    const out = []; let cur = '';
    for (let i = 0; i < pat.length; i++) {
      if (pat[i] === esc && pat[i + 1] === '"') { out.push(cur); cur = ''; i++; }
      else if (pat[i] === esc) { cur += pat[i] + (pat[i + 1] || ''); i++; }
      else cur += pat[i];
    }
    out.push(cur);
    return out;
  }
  const similarBody = (pat, esc) => K.Expr.similarBody(pat, esc);
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');

  // position(needle IN haystack) (the parser passes the needle first) and strpos(haystack, needle)
  const strpos = (h, n) => { const i = h.indexOf(n); return i < 0 ? 0 : cpLen(h.slice(0, i)) + 1; };
  const bytepos = (h, n) => { outer: for (let i = 0; i + n.length <= h.length; i++) { for (let j = 0; j < n.length; j++) if (h[i + j] !== n[j]) continue outer; return i + 1; } return 0; };
  fn('position', [{ args: ['text', 'text'], ret: 'int4', fn: (v) => strpos(v[1], v[0]) }, { args: ['bytea', 'bytea'], ret: 'int4', fn: (v) => bytepos(v[1], v[0]) }]);
  fn('strpos', { args: ['text', 'text'], ret: 'int4', fn: (v) => strpos(v[0], v[1]) });
  function overlay(s, p, from, len, join) {
    if (len === undefined) len = p.length;
    if (from <= 0) throw err('22011', 'negative substring length not allowed');
    if (len < 0) throw err('22011', 'negative substring length not allowed');
    return join(sub(s, 1, from - 1), p, sub(s, from + len));
  }
  fn('overlay', [
    { args: ['text', 'text', 'int4', 'int4'], minArgs: 3, ret: 'text', fn: (v) => overlay(cps(v[0]), cps(v[1]), v[2], v[3], (a, b, c) => a.join('') + b.join('') + c.join('')) },
    { args: ['bytea', 'bytea', 'int4', 'int4'], minArgs: 3, ret: 'bytea', fn: (v) => overlay(v[0], v[1], v[2], v[3], (a, b, c) => Uint8Array.from([...a, ...b, ...c])) },
  ]);

  // ---- trimming and padding ------------------------------------------------------------------------------------
  function trim(s, chars, l, r) {
    const set = new Set(cps(chars));
    const a = cps(s);
    let i = 0, j = a.length;
    if (l) while (i < j && set.has(a[i])) i++;
    if (r) while (j > i && set.has(a[j - 1])) j--;
    return a.slice(i, j).join('');
  }
  function trimBytes(s, chars, l, r) {
    const set = new Set(chars);
    let i = 0, j = s.length;
    if (l) while (i < j && set.has(s[i])) i++;
    if (r) while (j > i && set.has(s[j - 1])) j--;
    return s.slice(i, j);
  }
  for (const [name, l, r] of [['btrim', true, true], ['ltrim', true, false], ['rtrim', false, true]]) {
    fn(name, [
      { args: ['text', 'text'], minArgs: 1, ret: 'text', fn: (v) => trim(v[0], v.length > 1 ? v[1] : ' ', l, r) },
      { args: ['bytea', 'bytea'], ret: 'bytea', fn: (v) => trimBytes(v[0], v[1], l, r) },
    ]);
  }
  function pad(v, left) {
    const a = cps(v[0]), n = v[1], fill = cps(v.length > 2 ? v[2] : ' ');
    if (n <= 0) return '';
    if (a.length >= n || !fill.length) return a.slice(0, n).join('');
    const p = [];
    for (let i = 0; p.length < n - a.length; i++) p.push(fill[i % fill.length]);
    return left ? p.join('') + a.join('') : a.join('') + p.join('');
  }
  fn('lpad', { args: ['text', 'int4', 'text'], minArgs: 2, ret: 'text', fn: (v) => pad(v, true) });
  fn('rpad', { args: ['text', 'int4', 'text'], minArgs: 2, ret: 'text', fn: (v) => pad(v, false) });
  fn('left', { args: ['text', 'int4'], ret: 'text', fn: (v) => { const a = cps(v[0]); return (v[1] < 0 ? a.slice(0, Math.max(a.length + v[1], 0)) : a.slice(0, v[1])).join(''); } });
  fn('right', { args: ['text', 'int4'], ret: 'text', fn: (v) => { const a = cps(v[0]); return (v[1] < 0 ? a.slice(Math.min(-v[1], a.length)) : a.slice(Math.max(a.length - v[1], 0))).join(''); } });
  fn('repeat', { args: ['text', 'int4'], ret: 'text', fn: (v) => {
    if (v[1] <= 0) return '';
    if (v[0].length * v[1] > 1 << 28) throw err('54000', 'requested length too large');
    return v[0].repeat(v[1]);
  } });
  fn('replace', { args: ['text', 'text', 'text'], ret: 'text', fn: (v) => (v[1] === '' ? v[0] : v[0].split(v[1]).join(v[2])) });
  fn('reverse', { args: ['text'], ret: 'text', fn: (v) => cps(v[0]).reverse().join('') });
  fn('translate', { args: ['text', 'text', 'text'], ret: 'text', fn: (v) => {
    const from = cps(v[1]), to = cps(v[2]), map = new Map();
    from.forEach((c, i) => { if (!map.has(c)) map.set(c, i < to.length ? to[i] : ''); });
    return cps(v[0]).map((c) => (map.has(c) ? map.get(c) : c)).join('');
  } });
  fn('split_part', { args: ['text', 'text', 'int4'], ret: 'text', fn: (v) => {
    const [s, d, n] = v;
    if (n === 0) throw err('22023', 'field position must not be zero');
    if (d === '') return n === 1 || n === -1 ? s : '';
    const parts = s.split(d);
    const i = n > 0 ? n - 1 : parts.length + n;
    return i >= 0 && i < parts.length ? parts[i] : '';
  } });
  fn('starts_with', { args: ['text', 'text'], ret: 'bool', fn: (v) => v[0].startsWith(v[1]) });
  op('^@', { args: ['text', 'text'], ret: 'bool', fn: (v) => v[0].startsWith(v[1]) });
  fn('chr', { args: ['int4'], ret: 'text', fn: (v) => {
    const n = v[0];
    if (n === 0) throw err('54000', 'null character not permitted');
    if (n < 0) throw err('22023', 'character number must be positive');
    if (n > 0x10ffff) throw err('54000', 'requested character too large for encoding: ' + n);
    if (n >= 0xd800 && n <= 0xdfff) throw err('54000', 'requested character not valid for encoding: ' + n);
    return String.fromCodePoint(n);
  } });
  fn('ascii', { args: ['text'], ret: 'int4', fn: (v) => (v[0] === '' ? 0 : v[0].codePointAt(0)) });
  op('||', { args: ['bytea', 'bytea'], ret: 'bytea', fn: (v) => { const r = new Uint8Array(v[0].length + v[1].length); r.set(v[0]); r.set(v[1], v[0].length); return r; } });

  // ---- concat and format -----------------------------------------------------------------------------------------
  fn('concat', { args: ['any', 'any'], variadic: true, strict: false, ret: 'text', fn: (v, ctx, info) => v.map((x, i) => (x === null ? '' : txt(x, info.at[i], ctx))).join('') });
  fn('concat_ws', { args: ['text', 'any', 'any'], variadic: true, strict: false, ret: 'text', fn: (v, ctx, info) => {
    if (v[0] === null) return null;
    return v.slice(1).map((x, i) => (x === null ? null : txt(x, info.at[i + 1], ctx))).filter((x) => x !== null).join(v[0]);
  } });

  const KEYWORDS = new Set([...(K.RESERVED || []), ...('between bigint bit boolean char character coalesce dec decimal exists extract float greatest grouping inout int integer ' +
    'interval json json_array json_object least merge_action national nchar none normalize nullif numeric out overlay position precision real row setof smallint ' +
    'substring time timestamp treat trim values varchar xmlattributes xmlconcat xmlelement xmlexists xmlforest xmlparse xmlpi xmlroot xmlserialize xmltable ' +
    'collation current_schema ilike is isnull join left like natural notnull outer overlaps right similar tablesample verbose cross full inner analyse analyze').split(' ')]);
  const quoteIdent = (s) => (/^[a-z_][a-z0-9_]*$/.test(s) && !KEYWORDS.has(s) ? s : '"' + s.replace(/"/g, '""') + '"');
  const quoteLiteral = (s) => (s.includes('\\') ? "E'" + s.replace(/\\/g, '\\\\').replace(/'/g, "''") + "'" : "'" + s.replace(/'/g, "''") + "'");
  K.quoteIdent = quoteIdent;
  K.quoteLiteral = quoteLiteral;
  fn('parse_ident', { args: ['text', 'bool'], minArgs: 1, ret: 'text[]', fn: (v) => {
    const s = v[0], out = [], bad = () => err('22023', 'string is not a valid identifier: "' + s + '"');
    let i = 0;
    for (;;) {
      while (/\s/.test(s[i] || '')) i++;
      if (s[i] === '"') {
        let p = '';
        for (i++; ; i++) { if (i >= s.length) throw bad(); if (s[i] === '"') { if (s[i + 1] === '"') { p += '"'; i++; continue; } i++; break; } p += s[i]; }
        if (!p) throw bad();
        out.push(p);
      } else {
        const m = /^[A-Za-z_\u0080-\uffff][A-Za-z0-9_$\u0080-\uffff]*/.exec(s.slice(i));
        if (!m) throw bad();
        out.push(down(m[0])); i += m[0].length;
      }
      while (/\s/.test(s[i] || '')) i++;
      if (i >= s.length) break;
      if (s[i] !== '.') { if (v[1] === false) break; throw bad(); }
      i++;
    }
    return new K.ArrayV(out);
  } });
  fn('quote_ident', { args: ['text'], ret: 'text', fn: (v) => quoteIdent(v[0]) });
  fn('quote_literal', [{ args: ['text'], ret: 'text', fn: (v) => quoteLiteral(v[0]) }, { args: ['anyelement'], ret: 'text', fn: (v, ctx, info) => quoteLiteral(txt(v[0], info.at[0], ctx)) }]);
  fn('quote_nullable', [
    { args: ['text'], strict: false, ret: 'text', fn: (v) => (v[0] === null ? 'NULL' : quoteLiteral(v[0])) },
    { args: ['anyelement'], strict: false, ret: 'text', fn: (v, ctx, info) => (v[0] === null ? 'NULL' : quoteLiteral(txt(v[0], info.at[0], ctx))) },
  ]);

  fn('format', { args: ['text', 'any'], variadic: true, minArgs: 1, strict: false, nullVariadicEmpty: true, ret: 'text', fn: (v, ctx, info) => {
    const f = v[0];
    if (f === null) return null;
    const args = v.slice(1), types = info.at.slice(1);
    let out = '', next = 0;
    const bad = (c) => err('22023', 'unrecognized format() type specifier "' + c + '"', { hint: 'For a single "%" use "%%".' });
    const few = () => err('22023', 'too few arguments for format()');
    const num = (i) => { let n = ''; while (i < f.length && /\d/.test(f[i])) n += f[i++]; return [n, i]; };
    for (let i = 0; i < f.length; i++) {
      if (f[i] !== '%') { out += f[i]; continue; }
      i++;
      if (i >= f.length) throw err('22023', 'unterminated format() type specifier', { hint: 'For a single "%" use "%%".' });
      if (f[i] === '%') { out += '%'; continue; }
      let argPos = null, left = false, width = null;
      let [n, j] = num(i);
      if (n && f[j] === '$') { argPos = +n; if (argPos === 0) throw err('22023', 'format specifies argument 0, but arguments are numbered from 1'); i = j + 1; }
      if (f[i] === '-') { left = true; i++; }
      if (f[i] === '*') {
        i++;
        let wa;
        [n, j] = num(i);
        if (n && f[j] === '$') { wa = +n - 1; i = j + 1; } else wa = next++;
        if (wa >= args.length) throw few();
        const w = args[wa];
        width = w === null ? 0 : Number(w);
        if (width < 0) { left = true; width = -width; }
      } else { [n, j] = num(i); if (n) { width = +n; i = j; } }
      if (i >= f.length) throw err('22023', 'unterminated format() type specifier', { hint: 'For a single "%" use "%%".' });
      const type = f[i];
      if (type !== 's' && type !== 'I' && type !== 'L') throw bad(type);
      const ai = argPos !== null ? argPos - 1 : next;
      next = ai + 1;
      if (ai >= args.length) throw few();
      const x = args[ai];
      let s;
      if (type === 's') s = x === null ? '' : txt(x, types[ai], ctx);
      else if (type === 'I') { if (x === null) throw err('22004', 'null values cannot be formatted as an SQL identifier'); s = quoteIdent(txt(x, types[ai], ctx)); }
      else s = x === null ? 'NULL' : quoteLiteral(txt(x, types[ai], ctx));
      if (width !== null && cpLen(s) < width) s = left ? s + ' '.repeat(width - cpLen(s)) : ' '.repeat(width - cpLen(s)) + s;
      out += s;
    }
    return out;
  } });

  // ---- hashes and encodings ------------------------------------------------------------------------------------------
  function md5(bytes) {
    const K_ = new Int32Array(64), S_ = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    for (let i = 0; i < 64; i++) K_[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0;
    const n = bytes.length, total = ((n + 8) >> 6) + 1, w = new Int32Array(total * 16);
    for (let i = 0; i < n; i++) w[i >> 2] |= bytes[i] << ((i % 4) * 8);
    w[n >> 2] |= 0x80 << ((n % 4) * 8);
    w[total * 16 - 2] = (n * 8) | 0; w[total * 16 - 1] = Math.floor(n / 0x20000000);
    let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
    for (let c = 0; c < total; c++) {
      let a = a0, b = b0, cc = c0, d = d0;
      for (let i = 0; i < 64; i++) {
        let f, g;
        if (i < 16) { f = (b & cc) | (~b & d); g = i; }
        else if (i < 32) { f = (d & b) | (~d & cc); g = (5 * i + 1) % 16; }
        else if (i < 48) { f = b ^ cc ^ d; g = (3 * i + 5) % 16; }
        else { f = cc ^ (b | ~d); g = (7 * i) % 16; }
        const s = S_[(i >> 4) * 4 + (i % 4)];
        const t = (a + f + K_[i] + w[c * 16 + g]) | 0;
        a = d; d = cc; cc = b; b = (b + ((t << s) | (t >>> (32 - s)))) | 0;
      }
      a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + cc) | 0; d0 = (d0 + d) | 0;
    }
    return [a0, b0, c0, d0].map((x) => [0, 8, 16, 24].map((k) => K.hex((x >>> k) & 255, 2)).join('')).join('');
  }
  function sha256(bytes, is224) {
    const k = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
      0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
      0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
      0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    let h = is224 ? [0xc1059ed8, 0x367cd507, 0x3070dd17, 0xf70e5939, 0xffc00b31, 0x68581511, 0x64f98fa7, 0xbefa4fa4] : [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const n = bytes.length, total = ((n + 8) >> 6) + 1, w = new Int32Array(total * 16);
    for (let i = 0; i < n; i++) w[i >> 2] |= bytes[i] << (24 - (i % 4) * 8);
    w[n >> 2] |= 0x80 << (24 - (n % 4) * 8);
    w[total * 16 - 1] = (n * 8) | 0; w[total * 16 - 2] = Math.floor(n / 0x20000000);
    const r = (x, s) => (x >>> s) | (x << (32 - s));
    const m = new Int32Array(64);
    for (let c = 0; c < total; c++) {
      for (let i = 0; i < 16; i++) m[i] = w[c * 16 + i];
      for (let i = 16; i < 64; i++) {
        const s0 = r(m[i - 15], 7) ^ r(m[i - 15], 18) ^ (m[i - 15] >>> 3), s1 = r(m[i - 2], 17) ^ r(m[i - 2], 19) ^ (m[i - 2] >>> 10);
        m[i] = (m[i - 16] + s0 + m[i - 7] + s1) | 0;
      }
      let [a, b, cc, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i++) {
        const t1 = (hh + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + k[i] + m[i]) | 0;
        const t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & cc) ^ (b & cc))) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0; d = cc; cc = b; b = a; a = (t1 + t2) | 0;
      }
      h = [a, b, cc, d, e, f, g, hh].map((x, i) => (x + h[i]) | 0);
    }
    const out = new Uint8Array(is224 ? 28 : 32);
    for (let i = 0; i < out.length; i++) out[i] = (h[i >> 2] >>> (24 - (i % 4) * 8)) & 255;
    return out;
  }
  K.md5 = md5;
  // PostgreSQL's hash_bytes (Bob Jenkins' lookup3), as hashtext uses it on a little-endian machine
  function hashBytes(k) {
    const rot = (x, n) => (x << n) | (x >>> (32 - n));
    let len = k.length, a, b, c, i = 0;
    a = b = c = (0x9e3779b9 + len + 3923095) | 0;
    const w = (j) => k[j] | (k[j + 1] << 8) | (k[j + 2] << 16) | (k[j + 3] << 24);
    while (len >= 12) {
      a = (a + w(i)) | 0; b = (b + w(i + 4)) | 0; c = (c + w(i + 8)) | 0;
      a = (a - c) | 0; a ^= rot(c, 4); c = (c + b) | 0;
      b = (b - a) | 0; b ^= rot(a, 6); a = (a + c) | 0;
      c = (c - b) | 0; c ^= rot(b, 8); b = (b + a) | 0;
      a = (a - c) | 0; a ^= rot(c, 16); c = (c + b) | 0;
      b = (b - a) | 0; b ^= rot(a, 19); a = (a + c) | 0;
      c = (c - b) | 0; c ^= rot(b, 4); b = (b + a) | 0;
      i += 12; len -= 12;
    }
    // the last bytes: the lowest byte of c is left for the length
    if (len >= 9) for (let j = len - 1; j >= 8; j--) c = (c + (k[i + j] << (8 * (j - 7)))) | 0;
    if (len >= 5) for (let j = Math.min(len, 8) - 1; j >= 4; j--) b = (b + (k[i + j] << (8 * (j - 4)))) | 0;
    for (let j = Math.min(len, 4) - 1; j >= 0; j--) a = (a + (k[i + j] << (8 * j))) | 0;
    c ^= b; c = (c - rot(b, 14)) | 0;
    a ^= c; a = (a - rot(c, 11)) | 0;
    b ^= a; b = (b - rot(a, 25)) | 0;
    c ^= b; c = (c - rot(b, 16)) | 0;
    a ^= c; a = (a - rot(c, 4)) | 0;
    b ^= a; b = (b - rot(a, 14)) | 0;
    c ^= b; c = (c - rot(b, 24)) | 0;
    return c;
  }
  fn('hashtext', { args: ['text'], ret: 'int4', fn: (v) => hashBytes(K.utf8(v[0])) });
  fn('md5', [{ args: ['text'], ret: 'text', fn: (v) => md5(K.utf8(v[0])) }, { args: ['bytea'], ret: 'text', fn: (v) => md5(v[0]) }]);
  fn('sha256', { args: ['bytea'], ret: 'bytea', fn: (v) => sha256(v[0], false) });
  fn('sha224', { args: ['bytea'], ret: 'bytea', fn: (v) => sha256(v[0], true) });

  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function b64enc(b) {
    let out = '', line = 0;
    for (let i = 0; i < b.length; i += 3) {
      const n = (b[i] << 16) | ((b[i + 1] || 0) << 8) | (b[i + 2] || 0);
      const q = B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < b.length ? B64[n & 63] : '=');
      if (line >= 76) { out += '\n'; line = 0; }
      out += q; line += 4;
    }
    return out;
  }
  function b64dec(s) {
    const out = [];
    let acc = 0, bits = 0, end = false;
    for (const c of s) {
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') continue;
      if (c === '=') { end = true; continue; }
      const v = B64.indexOf(c);
      if (v < 0 || end) throw err('22023', 'invalid symbol "' + c + '" found while decoding base64 sequence');
      acc = (acc << 6) | v; bits += 6;
      if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); }
    }
    if (bits >= 6) throw err('22023', 'invalid base64 end sequence', { hint: 'Input data is missing padding, is truncated, or is otherwise corrupted.' });
    return Uint8Array.from(out);
  }
  const encodings = {
    hex: [(b) => Array.from(b, (x) => K.hex(x, 2)).join(''), (s) => {
      const h = s.replace(/\s/g, '');
      const bad = /[^0-9a-fA-F]/.exec(h);
      if (bad) throw err('22023', 'invalid hexadecimal digit: "' + bad[0] + '"');
      if (h.length % 2) throw err('22023', 'invalid hexadecimal data: odd number of digits');
      return Uint8Array.from(h.match(/../g) || [], (x) => parseInt(x, 16));
    }],
    base64: [b64enc, b64dec],
    escape: [(b) => Array.from(b, (x) => (x === 92 ? '\\\\' : x === 0 || x >= 128 ? '\\' + x.toString(8).padStart(3, '0') : String.fromCharCode(x))).join(''), (s) => K.T.byteaIn(s)],
  };
  const encoding = (name) => { const e = encodings[name.toLowerCase()]; if (!e) throw err('22023', 'unrecognized encoding: "' + name + '"'); return e; };
  fn('encode', { args: ['bytea', 'text'], ret: 'text', fn: (v) => encoding(v[1])[0](v[0]) });
  fn('decode', { args: ['text', 'text'], ret: 'bytea', fn: (v) => encoding(v[1])[1](v[0]) });
  const utf8Name = (n) => { if (!/^utf-?8$/i.test(n)) throw err('22023', 'invalid destination encoding name "' + n + '"'); };
  fn('convert_to', { args: ['text', 'text'], ret: 'bytea', fn: (v) => { utf8Name(v[1]); return K.utf8(v[0]); } });
  fn('convert_from', { args: ['bytea', 'text'], ret: 'text', fn: (v) => { utf8Name(v[1]); return K.unutf8(v[0]); } });
  const byteAt = (b, n) => { if (n < 0 || n >= b.length) throw err('2202E', 'index ' + n + ' out of valid range, 0..' + (b.length - 1)); };
  fn('get_byte', { args: ['bytea', 'int4'], ret: 'int4', fn: (v) => { byteAt(v[0], v[1]); return v[0][v[1]]; } });
  fn('set_byte', { args: ['bytea', 'int4', 'int4'], ret: 'bytea', fn: (v) => { byteAt(v[0], v[1]); const b = Uint8Array.from(v[0]); b[v[1]] = v[2] & 255; return b; } });
  fn('to_hex', [{ args: ['int4'], ret: 'text', fn: (v) => (v[0] >>> 0).toString(16) }, { args: ['int8'], ret: 'text', fn: (v) => BigInt.asUintN(64, BigInt(v[0])).toString(16) }]);

  // ---- regular expressions ---------------------------------------------------------------------------------------------
  const CLASSES = {
    alpha: 'a-zA-Z', digit: '0-9', alnum: 'a-zA-Z0-9', upper: 'A-Z', lower: 'a-z', space: '\\s', blank: ' \\t', punct: '!-\\/:-@\\[-`{-~',
    xdigit: '0-9A-Fa-f', word: '\\w', cntrl: '\\x00-\\x1f\\x7f', print: '\\x20-\\x7e', graph: '\\x21-\\x7e',
  };
  /** PostgreSQL's advanced regular expressions (ARE) to a JavaScript RegExp source; returns [source, flags] */
  function translate(pat, flags) {
    let ci = false, nl = false, expanded = false, quote = false, glob = false;
    const apply = (f, embedded) => {
      for (const c of f) {
        switch (c) {
          case 'g': if (embedded) throw bad(); glob = true; break;
          case 'i': ci = true; break;
          case 'c': ci = false; break;
          case 'n': case 'm': nl = true; break;
          case 's': nl = false; break;
          case 'x': expanded = true; break;
          case 't': expanded = false; break;
          case 'q': quote = true; break;
          case 'p': case 'w': nl = true; break;
          case 'b': case 'e': break;
          default: throw err('22023', 'invalid regular expression option: "' + c + '"');
        }
      }
    };
    const bad = () => err('22023', 'invalid regular expression option: "g"');
    apply(flags || '', false);
    if (pat.startsWith('***=')) { quote = true; pat = pat.slice(4); }
    else if (pat.startsWith('***:')) pat = pat.slice(4);
    const em = !quote && /^\(\?([a-z]+)\)/.exec(pat);
    if (em) { apply(em[1], true); pat = pat.slice(em[0].length); }
    let src = '';
    if (quote) src = reEsc(pat);
    else {
      for (let i = 0; i < pat.length; i++) {
        const c = pat[i];
        if (expanded && /\s/.test(c)) continue;
        if (expanded && c === '#') { while (i < pat.length && pat[i] !== '\n') i++; continue; }
        if (c === '\\') {
          const d = pat[++i];
          if (d === undefined) throw err('2201B', 'invalid regular expression: invalid escape \\ sequence');
          switch (d) {
            case 'm': src += '\\b(?=\\w)'; break;
            case 'M': src += '\\b(?<=\\w)'; break;
            case 'y': src += '\\b'; break;
            case 'Y': src += '\\B'; break;
            case 'A': src += '(?<![\\s\\S])'; break;
            case 'Z': src += '(?![\\s\\S])'; break;
            case 'b': src += '\\x08'; break;
            case 'e': src += '\\x1b'; break;
            default: src += '\\' + d;
          }
          continue;
        }
        if (c === '[') {
          let j = i + 1, body = '';
          if (pat[j] === '^') { body += '^'; j++; }
          if (pat[j] === ']') { body += '\\]'; j++; }
          for (; j < pat.length && pat[j] !== ']'; j++) {
            if (pat[j] === '[' && (pat[j + 1] === ':' || pat[j + 1] === '.' || pat[j + 1] === '=')) {
              const kind = pat[j + 1], end = pat.indexOf(kind + ']', j + 2);
              if (end < 0) throw err('2201B', 'invalid regular expression: brackets [] not balanced');
              const name = pat.slice(j + 2, end);
              if (kind === ':') { if (!CLASSES[name]) throw err('2201B', 'invalid regular expression: invalid character class'); body += CLASSES[name]; }
              else body += reEsc(name);
              j = end + 1;
              continue;
            }
            if (pat[j] === '\\') { body += pat[j] + (pat[j + 1] || ''); j++; continue; }
            body += pat[j] === '[' ? '\\[' : pat[j];
          }
          if (j >= pat.length) throw err('2201B', 'invalid regular expression: brackets [] not balanced');
          src += '[' + body + ']';
          i = j;
          continue;
        }
        if (c === '(' && pat.startsWith('?<', i + 1) && !'=!'.includes(pat[i + 3])) throw err('2201B', 'invalid regular expression: quantifier operand invalid');
        src += c;
      }
    }
    return [src, (ci ? 'i' : '') + (nl ? 'm' : 's'), glob];
  }
  // JavaScript's complaints, in PostgreSQL's words
  const reMessage = (m) => (/group|\)/i.test(m) ? 'parentheses () not balanced' : /character class/i.test(m) ? 'brackets [] not balanced'
    : /nothing to repeat/i.test(m) ? 'quantifier operand invalid' : /out of order|quantifier/i.test(m) ? 'invalid repetition count(s)' : /escape/i.test(m) ? 'invalid escape \\ sequence' : m.toLowerCase());
  const reCache = new Map();
  /** compile a pattern with PostgreSQL flags; g in the flags makes the RegExp global */
  function regex(pat, flags, forceGlobal) {
    const key = pat + '\u0000' + (flags || '') + (forceGlobal ? '\u0001' : '');
    let re = reCache.get(key);
    if (re) { re.lastIndex = 0; return re; }
    const [src, f, g] = translate(pat, flags);
    try { re = new RegExp(src, f + (g || forceGlobal ? 'g' : '') + 'd'); }
    catch (e) { throw err('2201B', 'invalid regular expression: ' + reMessage(String(e.message).replace(/^Invalid regular expression: \/.*\/[a-z]*: /, ''))); }
    re.pgGlobal = g;
    if (reCache.size > 500) reCache.clear();
    reCache.set(key, re);
    return re;
  }
  K.pgRegex = regex;
  /** all matches, as PostgreSQL finds them: non-overlapping, an empty match advances one character */
  function matches(s, re, start) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    g.lastIndex = start || 0;
    const out = [];
    let m;
    while ((m = g.exec(s))) {
      out.push(m);
      if (m[0] === '') g.lastIndex += s.codePointAt(g.lastIndex) > 0xffff ? 2 : 1;
      if (g.lastIndex > s.length) break;
    }
    return out;
  }
  /** a 1-based character position to a UTF-16 offset */
  const offsetOf = (s, pos) => { let i = 0; for (let n = 1; n < pos && i < s.length; n++) i += s.codePointAt(i) > 0xffff ? 2 : 1; return i; };
  const charPos = (s, off) => cpLen(s.slice(0, off)) + 1;
  const noGlobal = (name, flags) => { if (flags && flags.includes('g')) throw err('22023', name + '() does not support the "global" option', { hint: 'Use the regexp_matches function instead.' }); };
  const checkStart = (n, what) => { if (n <= 0) throw err('22023', 'invalid value for parameter "' + (what || 'start') + '": ' + n); };

  function replaceWith(m, repl) {
    let out = '';
    for (let i = 0; i < repl.length; i++) {
      const c = repl[i];
      if (c === '\\' && i + 1 < repl.length) {
        const d = repl[i + 1];
        if (d >= '1' && d <= '9') { out += m[+d] === undefined ? '' : m[+d]; i++; continue; }
        if (d === '&') { out += m[0]; i++; continue; }
        if (d === '\\') { out += '\\'; i++; continue; }
      }
      out += c;
    }
    return out;
  }
  function regexpReplace(s, pat, repl, start, n, flags) {
    const re = regex(pat, flags);
    const all = n === 0 || (n === undefined && re.pgGlobal);
    const want = n === undefined ? 1 : n;
    const ms = matches(s, re, offsetOf(s, start || 1));
    let out = '', last = 0, count = 0;
    for (const m of ms) {
      count++;
      if (!all && count !== want) continue;
      out += s.slice(last, m.index) + replaceWith(m, repl);
      last = m.index + m[0].length;
      if (!all) break;
    }
    return out + s.slice(last);
  }
  fn('regexp_replace', [
    { args: ['text', 'text', 'text', 'text'], minArgs: 3, ret: 'text', fn: (v) => regexpReplace(v[0], v[1], v[2], 1, undefined, v[3]) },
    { args: ['text', 'text', 'text', 'int4', 'int4', 'text'], minArgs: 4, ret: 'text', fn: (v) => {
      checkStart(v[3]);
      if (v.length > 4 && v[4] < 0) throw err('22023', 'invalid value for parameter "n": ' + v[4]);
      return regexpReplace(v[0], v[1], v[2], v[3], v.length > 4 ? v[4] : undefined, v[5]);
    } },
  ]);
  const textArr = (items) => new K.ArrayV(items);
  fn('regexp_match', { args: ['text', 'text', 'text'], minArgs: 2, ret: () => K.T.arrayOf(B.text), fn: (v) => {
    noGlobal('regexp_match', v[2]);
    const m = regex(v[1], v[2]).exec(v[0]);
    if (!m) return null;
    return textArr(m.length > 1 ? m.slice(1).map((x) => (x === undefined ? null : x)) : [m[0]]);
  } });
  fn('regexp_like', { args: ['text', 'text', 'text'], minArgs: 2, ret: 'bool', fn: (v) => { noGlobal('regexp_like', v[2]); return regex(v[1], v[2]).test(v[0]); } });
  fn('regexp_count', { args: ['text', 'text', 'int4', 'text'], minArgs: 2, ret: 'int4', fn: (v) => {
    const start = v.length > 2 ? v[2] : 1;
    checkStart(start);
    noGlobal('regexp_count', v[3]);
    return matches(v[0], regex(v[1], v[3]), offsetOf(v[0], start)).length;
  } });
  function nth(v, flagsAt, name) {
    const start = v.length > 2 ? v[2] : 1, n = v.length > 3 ? v[3] : 1;
    checkStart(start);
    if (n <= 0) throw err('22023', 'invalid value for parameter "n": ' + n);
    noGlobal(name, v[flagsAt]);
    const ms = matches(v[0], regex(v[1], v[flagsAt]), offsetOf(v[0], start));
    return ms[n - 1] || null;
  }
  fn('regexp_substr', { args: ['text', 'text', 'int4', 'int4', 'text', 'int4'], minArgs: 2, ret: 'text', fn: (v) => {
    const sx = v.length > 5 ? v[5] : 0;
    if (sx < 0) throw err('22023', 'invalid value for parameter "subexpr": ' + sx);
    const m = nth(v, 4, 'regexp_substr');
    if (!m || sx >= m.length) return null;
    return m[sx] === undefined ? null : m[sx];
  } });
  fn('regexp_instr', { args: ['text', 'text', 'int4', 'int4', 'int4', 'text', 'int4'], minArgs: 2, ret: 'int4', fn: (v) => {
    const endopt = v.length > 4 ? v[4] : 0, sx = v.length > 6 ? v[6] : 0;
    if (endopt !== 0 && endopt !== 1) throw err('22023', 'invalid value for parameter "endoption": ' + endopt);
    if (sx < 0) throw err('22023', 'invalid value for parameter "subexpr": ' + sx);
    const m = nth(v, 5, 'regexp_instr');
    if (!m || sx >= m.length || m[sx] === undefined) return 0;
    const [a, b] = m.indices[sx];
    return charPos(v[0], endopt ? b : a);
  } });
  fn('regexp_split_to_array', { args: ['text', 'text', 'text'], minArgs: 2, ret: () => K.T.arrayOf(B.text), fn: (v) => {
    noGlobal('regexp_split_to_array', v[2]);
    const s = v[0];
    // empty matches at either end or right after the previous match do not split
    const out = []; let last = 0;
    for (const m of matches(s, regex(v[1], v[2]), 0)) { if (m.index >= s.length || m.index + m[0].length <= last) continue; out.push(s.slice(last, m.index)); last = m.index + m[0].length; }
    out.push(s.slice(last));
    return textArr(out);
  } });
  const reOp = (sym, flags, neg) => op(sym, { args: ['text', 'text'], ret: 'bool', fn: (v) => regex(v[1], flags).test(v[0]) !== neg });
  reOp('~', '', false); reOp('~*', 'i', false); reOp('!~', '', true); reOp('!~*', 'i', true);
  const likeCache = new Map();
  const likeOp = (sym, ci, neg) => op(sym, { args: ['text', 'text'], ret: 'bool', fn: (v) => {
    const key = (ci ? 'i' : 'c') + v[1];
    let re = likeCache.get(key);
    if (!re) { re = K.Expr.likeRe(v[1], '\\', ci); if (likeCache.size > 500) likeCache.clear(); likeCache.set(key, re); }
    return re.test(v[0]) !== neg;
  } });
  likeOp('~~', false, false); likeOp('~~*', true, false); likeOp('!~~', false, true); likeOp('!~~*', true, true);

  // ---- to_char and to_number for numbers ---------------------------------------------------------------------------
  const NUM_KEYS = ['FM', 'fm', 'EEEE', 'eeee', 'RN', 'rn', 'TH', 'th', 'PR', 'pr', 'MI', 'mi', 'PL', 'pl', 'SG', 'sg', 'SP', 'sp', 'S', 's', 'V', 'v',
    'L', 'l', 'G', 'g', 'D', 'd', 'B', 'b', '9', '0', '.', ','];
  function numFormat(fmt) {
    const nodes = [];
    const d = { pre: 0, post: 0, zeroStart: 0, zeroEnd: 0, flags: new Set(), lsign: null, preLsign: 0, multi: 0 };
    const has = (f) => d.flags.has(f);
    for (let i = 0; i < fmt.length;) {
      if (fmt[i] === '"') {
        let j = i + 1;
        while (j < fmt.length && fmt[j] !== '"') { if (fmt[j] === '\\' && j + 1 < fmt.length) j++; nodes.push({ ch: fmt[j] }); j++; }
        i = j + 1; continue;
      }
      if (fmt[i] === '\\' && fmt[i + 1] === '"') { nodes.push({ ch: '"' }); i += 2; continue; }
      const k = NUM_KEYS.find((x) => fmt.startsWith(x, i));
      if (!k) { nodes.push({ ch: fmt[i] }); i++; continue; }
      const id = k.toUpperCase();
      i += k.length;
      switch (id) {
        case '9':
          if (has('PR')) throw err('42601', '"9" must be ahead of "PR"');
          if (has('V')) { d.multi++; break; }
          if (has('DEC')) d.post++; else d.pre++;
          break;
        case '0':
          if (has('PR')) throw err('42601', '"0" must be ahead of "PR"');
          if (!has('ZERO') && !has('DEC')) { d.flags.add('ZERO'); d.zeroStart = d.pre + 1; }
          if (has('DEC')) d.post++; else d.pre++;
          d.zeroEnd = d.pre + d.post;
          break;
        case 'B': if (d.pre === 0 && d.post === 0 && !has('ZERO')) d.flags.add('BLANK'); break;
        case '.': case 'D':
          if (has('DEC')) throw err('42601', 'multiple decimal points');
          if (has('V')) throw err('42601', 'cannot use "V" and decimal point together');
          d.flags.add('DEC');
          break;
        case 'FM': d.flags.add('FM'); break;
        case 'S':
          if (d.lsign) throw err('42601', 'cannot use "S" twice');
          if (has('PL') || has('MI') || has('PR')) throw err('42601', 'cannot use "S" and "PL"/"MI"/"SG"/"PR" together');
          if (!has('DEC')) { d.lsign = 'pre'; d.preLsign = d.pre; } else d.lsign = 'post';
          break;
        case 'MI': if (d.lsign) throw err('42601', 'cannot use "S" and "MI" together'); d.flags.add('MI'); break;
        case 'PL': if (d.lsign) throw err('42601', 'cannot use "S" and "PL" together'); d.flags.add('PL'); break;
        case 'SG': if (d.lsign) throw err('42601', 'cannot use "S" and "SG" together'); d.flags.add('MI'); d.flags.add('PL'); break;
        case 'PR': if (d.lsign || has('PL') || has('MI')) throw err('42601', 'cannot use "PR" and "S"/"PL"/"MI"/"SG" together'); d.flags.add('PR'); break;
        case 'RN': d.flags.add('RN'); break;
        case 'L': case 'G': case ',': case 'TH': case 'SP': break;
        case 'V': if (has('DEC')) throw err('42601', 'cannot use "V" and decimal point together'); d.flags.add('V'); break;
        case 'EEEE':
          if (has('EEEE')) throw err('42601', 'cannot use "EEEE" twice');
          d.flags.add('EEEE');
          break;
      }
      nodes.push({ key: id, raw: k });
    }
    return { nodes, d };
  }
  const ROMAN = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  const roman = (n) => { let s = ''; for (const [v, r] of ROMAN) while (n >= v) { s += r; n -= v; } return s; };
  const ordinal = (n, upper) => { const a = Math.abs(n) % 100, b = Math.abs(n) % 10; const s = a >= 11 && a <= 13 ? 'th' : b === 1 ? 'st' : b === 2 ? 'nd' : b === 3 ? 'rd' : 'th'; return upper ? s.toUpperCase() : s; };

  /** the value as a decimal, from any numeric type (floats through their shortest text) */
  function asDec(v, t) {
    if (typeof v === 'bigint') return new Dec(v, 0);
    if (typeof v === 'number') return t && t.float ? Dec.parse(K.T.floatOut(v, t.id === 'float4')) : Dec.of(v);
    return v;
  }
  function numToChar(v, t, fmt) {
    const { nodes, d } = numFormat(fmt);
    const fm = d.flags.has('FM');
    const special = typeof v === 'number' && !Number.isFinite(v);
    if (d.flags.has('RN')) {
      if (special) return fm ? '###############'.trim() : '###############';
      const n = Number(asDec(v, t).round(0).d);
      const r = n < 1 || n > 3999 ? '###############' : roman(n);
      const s = fm ? r : r.padStart(15, ' ');
      return nodes.some((x) => x.raw === 'rn') ? s.toLowerCase() : s;
    }
    if (d.flags.has('EEEE')) {
      if (special || Number.isNaN(v)) return ' ' + '#'.repeat(d.pre + d.post + 5 + (d.flags.has('DEC') ? 1 : 0));
      const x = asDec(v, t);
      let e = x.isZero() ? 0 : babsLen(x) - 1 - x.s;
      let m = x.isZero() ? x.round(d.post) : new Dec(x.d, x.s + e).round(d.post);
      if (babsLen(m) - m.s > 1) { e++; m = new Dec(x.d, x.s + e).round(d.post); }
      const body = (m.sign() < 0 ? '-' : fm ? '' : ' ') + m.abs().toString() + (d.post === 0 && d.flags.has('DEC') ? '.' : '') + 'e' + (e < 0 ? '-' : '+') + String(Math.abs(e)).padStart(2, '0');
      return body;
    }
    let x = null;
    if (!special) {
      x = asDec(v, t);
      if (d.flags.has('V')) { x = x.mul(new Dec(10n ** BigInt(d.multi), 0)); d.pre += d.multi; }
      if (t && t.float) {
        // as sprintf("%.*f") on the double: exact binary value, ties to even, at most 15 (6 for real) digits
        const dig = t.id === 'float4' ? 6 : 15;
        const ex = exactDec(typeof v === 'number' ? v * 10 ** (d.flags.has('V') ? d.multi : 0) : x.toNumber());
        const preLen0 = roundEven(ex.abs(), 0).toString().length;
        d.post = preLen0 >= dig ? 0 : Math.min(d.post, dig - preLen0);
        x = roundEven(ex, d.post);
      } else x = x.round(d.post);
    }
    let sign = '+', numstr;
    let outPre = 0;
    if (x === null) numstr = Number.isNaN(v) ? 'NaN' : 'Infinity', sign = v < 0 ? '-' : '+';
    else {
      numstr = x.toString();
      if (numstr[0] === '-') { sign = '-'; numstr = numstr.slice(1); }
      if (x.isZero()) sign = '+';
    }
    const dot = numstr.indexOf('.');
    const preLen = dot < 0 ? numstr.length : dot;
    // a numeric NaN is printed as the digits "NaN"; infinities and float NaN overflow the template
    if (x === null && !(Number.isNaN(v) && !(t && t.float)) || preLen > d.pre) {
      numstr = '#'.repeat(d.pre) + (d.post || d.flags.has('DEC') ? '.' : '') + '#'.repeat(d.post);
    } else if (preLen < d.pre) outPre = d.pre - preLen;
    if (d.post === 0 && numstr.endsWith('.')) numstr = numstr.slice(0, -1);
    return numProcess(nodes, d, numstr, outPre, sign, v, t);
  }
  /** the exact value of a double as a decimal */
  function exactDec(v) {
    if (Number.isInteger(v)) return new Dec(BigInt(v), 0);
    let m = v, e = 0;
    while (!Number.isInteger(m)) { m *= 2; e++; }
    return new Dec(BigInt(m) * 5n ** BigInt(e), e);
  }
  function roundEven(x, n) {
    if (n >= x.s) return x.round(n);
    const k = 10n ** BigInt(x.s - n), neg = x.d < 0n, a = neg ? -x.d : x.d;
    let q = a / k; const r = a % k;
    if (r * 2n > k || (r * 2n === k && q % 2n === 1n)) q += 1n;
    return new Dec(neg ? -q : q, n);
  }
  const babsLen = (x) => (x.d < 0n ? -x.d : x.d).toString().length;

  /** PostgreSQL's NUM_processor, in the to_char direction */
  function numProcess(nodes, d, number, outPre, sign, orig, t) {
    const IS = (f) => d.flags.has(f);
    const fm = IS('FM'), zero = IS('ZERO');
    if (d.zeroStart) d.zeroStart--; // 1-based in the template, 0-based from here, as in PostgreSQL
    let signWrote;
    let lsign = d.lsign;
    if (IS('PL') || IS('MI')) signWrote = !(IS('PL') && !IS('MI'));
    else {
      if (sign !== '-' && fm) d.flags.delete('PR');
      signWrote = sign === '+' && fm && !lsign;
      if (lsign === 'pre' && d.pre === d.preLsign) lsign = 'post';
    }
    const bracket = IS('PR');
    let numCount = d.post + d.pre - 1;
    let lastRel = -1; // index in number of the last digit worth printing, under FM
    if (fm && IS('DEC')) {
      const p = number.indexOf('.');
      if (p >= 0) { lastRel = p; for (let i = p + 1; i < number.length; i++) if (number[i] !== '0') lastRel = i; }
      if (lastRel >= 0 && d.zeroEnd > outPre) { let lz = d.zeroEnd - outPre; if (lz >= number.length) lz = number.length - 1; if (lastRel < lz) lastRel = lz; }
    }
    if (!signWrote && outPre === 0) numCount++;
    let out = '', np = 0, cur = 0, numIn = false;
    const predecSpace = () => !zero && np === 0 && number[0] === '0' && d.post !== 0;
    const numpart = (id) => {
      numIn = false;
      if (!signWrote && (cur >= outPre || (zero && d.zeroStart === cur)) && (!predecSpace() || (lastRel >= 0 && number[lastRel] === '.'))) {
        if (lsign) { if (lsign === 'pre') { out += sign === '-' ? '-' : '+'; signWrote = true; } }
        else if (bracket) { out += sign === '+' ? ' ' : '<'; signWrote = true; }
        else if (sign === '+') { if (!fm) out += ' '; signWrote = true; }
        else if (sign === '-') { out += '-'; signWrote = true; }
      }
      if (cur < outPre && (d.zeroStart > cur || !zero)) { if (!fm) out += ' '; }
      else if (zero && cur < outPre && d.zeroStart <= cur) { out += '0'; numIn = true; }
      else {
        if (number[np] === '.') {
          if (lastRel < 0 || number[lastRel] !== '.') out += '.';
          else if (fm && number[lastRel] === '.') out += '.';
        } else if (np < number.length) {
          if (lastRel >= 0 && np > lastRel && id !== '0') { /* trailing zero dropped by FM */ }
          else if (predecSpace()) { if (!fm) out += ' '; else if (lastRel >= 0 && number[lastRel] === '.') out += '0'; }
          else { out += number[np]; numIn = true; }
        }
        if (np < number.length) np++;
      }
      let end = numCount + (outPre ? 1 : 0) + (IS('DEC') ? 1 : 0);
      if (lastRel >= 0 && lastRel + 1 === np) end = cur;
      if (cur + 1 === end) {
        if (signWrote && bracket) out += sign === '+' ? ' ' : '>';
        else if (lsign === 'post') out += sign === '-' ? '-' : '+';
      }
      cur++;
    };
    for (const n of nodes) {
      if (!n.key) { out += n.ch; continue; }
      switch (n.key) {
        case '9': case '0': case '.': case 'D': numpart(n.key === 'D' ? '.' : n.key); break;
        case ',': case 'G': if (!numIn) { if (!fm) out += ' '; } else out += ','; break;
        case 'L': out += ' '; break;
        case 'MI': if (sign === '-') out += '-'; else if (!fm) out += ' '; break;
        case 'PL': if (sign === '+') out += '+'; else if (!fm) out += ' '; break;
        case 'SG': out += sign === '-' ? '-' : '+'; break;
        case 'TH': {
          if (IS('RN') || number.includes('#') || sign === '-' || IS('DEC')) break;
          out += ordinal(Number(number.replace(/\D/g, '') || 0), n.raw === 'TH');
          break;
        }
        default: break;
      }
    }
    return out;
  }
  const numToCharSpecs = ['int4', 'int8', 'numeric', 'float4', 'float8'].map((t) => ({ args: [t, 'text'], ret: 'text', fn: (v, ctx, info) => numToChar(v[0], info.at[0], v[1]) }));
  fn('to_char', numToCharSpecs);

  // to_number walks template and input together, as PostgreSQL does: each digit position takes one input character
  // (skipping one space before it), separators are taken only when present, other template characters skip one
  fn('to_number', { args: ['text', 'text'], ret: 'numeric', fn: (v) => {
    const s = v[0], { nodes, d } = numFormat(v[1]);
    let p = 0, neg = false, intp = '', frac = '', inFrac = false, any = false;
    const plainSign = !d.lsign && !d.flags.has('MI') && !d.flags.has('PL');
    for (const n of nodes) {
      if (p >= s.length) break;
      if (!n.key) { p++; continue; }
      switch (n.key) {
        case '9': case '0': case '.': case 'D':
          if (s[p] === ' ') p++;
          if (p >= s.length) break;
          if (!any && (n.key === '9' || n.key === '0')) {
            if (plainSign && (s[p] === '-' || s[p] === '+')) { neg = s[p] === '-'; p++; }
            else if (d.flags.has('PR') && s[p] === '<') { neg = true; p++; }
            else if (d.lsign === 'pre' && (s[p] === '-' || s[p] === '+')) { neg = s[p] === '-'; p++; }
          }
          if (p >= s.length) break;
          if (/\d/.test(s[p])) { if (inFrac) frac += s[p]; else intp += s[p]; any = true; }
          else if (d.flags.has('DEC') && !inFrac && s[p] === '.') inFrac = true;
          p++;
          break;
        case ',': case 'G': if (s[p] === ',') p++; break;
        case 'S': case 'MI': case 'PL': case 'SG':
          if (s[p] === '-') { neg = true; p++; } else if (s[p] === '+' || s[p] === ' ') p++;
          break;
        case 'PR': if (s[p] === '>') p++; break;
        case 'FM': case 'TH': case 'EEEE': case 'V': case 'RN': case 'B': break;
        default: p++;
      }
    }
    if (!any) throw err('22P02', 'invalid input syntax for type numeric: " "');
    let r = Dec.parse((intp || '0') + (frac ? '.' + frac : ''));
    if (d.flags.has('V')) r = r.div(new Dec(10n ** BigInt(d.multi), 0));
    else {
      // the result fits the template, as numeric(pre + post, post)
      r = r.round(d.post);
      if (!r.isZero() && babsLen(r) - r.s > d.pre) throw err('22003', 'numeric field overflow', { detail: 'A field with precision ' + (d.pre + d.post) + ', scale ' + d.post + ' must round to an absolute value less than 10^' + d.pre + '.' });
    }
    return neg ? r.neg() : r;
  } });

  K.StrFn = { numToChar, regex, translate, quoteIdent, quoteLiteral, md5, sha256, cps, cpLen };
})(typeof window !== 'undefined' ? window : globalThis);
