// SQL tokens. Unquoted names fold to lower case and quoted ones keep their spelling, as in PostgreSQL.
// Every token keeps its position so errors can point at it.
(function (root) {
  'use strict';
  const K = root.K;

  // words that cannot be used as bare column or table names (a subset of the reserved words of SQL and PostgreSQL)
  const RESERVED = new Set(('all analyse analyze and any array as asc asymmetric both case cast check collate column constraint create ' +
    'current_catalog current_date current_role current_time current_timestamp current_user default deferrable desc distinct do else end ' +
    'except false fetch for foreign from grant group having in initially intersect into lateral leading limit localtime localtimestamp not ' +
    'null offset on only or order placing primary references returning select session_user some symmetric table then to trailing true ' +
    'union unique user using variadic when where window with join inner left right full outer cross natural is isnull notnull like ilike ' +
    'similar between overlaps verbose freeze tablesample authorization binary concurrently').split(' '));

  const OPS = ['||/', '->>', '#>>', '!~~*', '~~*', '!~~', '!~*', '::', '<=', '>=', '<>', '!=', '||', '->', '#>', '@>', '<@', '@?', '@@', '?|', '?&', '~~', '!~', '~*',
    '&&', '<<', '>>', '**', ':=', '=>', '..', '^@', '#-', '|/', '+', '-', '*', '/', '%', '^', '=', '<', '>', '(', ')', '[', ']', ',', ';', '.', ':', '~', '!', '@', '#', '&', '|', '?'];

  function lex(src) {
    const toks = [];
    let i = 0;
    const n = src.length;
    const at = (p) => src[p];
    const fail = (msg, p) => { throw K.err(K.STATE.syntax, msg, { pos: p === undefined ? i : p }); };
    while (i < n) {
      const c = at(i);
      if (/\s/.test(c)) { i++; continue; }
      if (c === '-' && at(i + 1) === '-') { while (i < n && at(i) !== '\n') i++; continue; }
      if (c === '/' && at(i + 1) === '*') {
        let depth = 1; const start = i; i += 2;
        while (i < n && depth) { if (at(i) === '/' && at(i + 1) === '*') { depth++; i += 2; } else if (at(i) === '*' && at(i + 1) === '/') { depth--; i += 2; } else i++; }
        if (depth) fail('unterminated /* comment', start);
        continue;
      }
      const start = i;
      // strings: '...', E'...', N'...', X'...', B'...', U&'...'
      if (c === "'" || (/[eEnNxXbB]/.test(c) && at(i + 1) === "'")) {
        let kind = 's';
        if (c !== "'") { kind = c.toLowerCase(); i++; }
        i++;
        let v = '';
        for (;;) {
          if (i >= n) fail('unterminated quoted string', start);
          const d = at(i);
          if (d === "'") { if (at(i + 1) === "'") { v += "'"; i += 2; continue; } i++; break; }
          if (d === '\\' && kind === 'e') {
            const e = at(i + 1);
            const map = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '\\': '\\', "'": "'" };
            if (map[e] !== undefined) { v += map[e]; i += 2; continue; }
            if (e === 'x') { const m = /^[0-9a-fA-F]{1,2}/.exec(src.slice(i + 2)); if (m) { v += String.fromCharCode(parseInt(m[0], 16)); i += 2 + m[0].length; continue; } }
            if (e === 'u' || e === 'U') { const w = e === 'u' ? 4 : 8, h = src.slice(i + 2, i + 2 + w); if (new RegExp('^[0-9a-fA-F]{' + w + '}$').test(h)) { v += String.fromCodePoint(parseInt(h, 16)); i += 2 + w; continue; } throw K.err('22025', 'invalid Unicode escape', { pos: i }); }
            if (/[0-7]/.test(e)) { const m = /^[0-7]{1,3}/.exec(src.slice(i + 1)); v += String.fromCharCode(parseInt(m[0], 8)); i += 1 + m[0].length; continue; }
            v += e; i += 2; continue;
          }
          v += d; i++;
        }
        // adjacent string literals separated by a newline join, as the standard says
        if (kind === 's' || kind === 'e' || kind === 'n') {
          let j = i, sawNl = false;
          while (j < n && /\s/.test(at(j))) { if (at(j) === '\n') sawNl = true; j++; }
          if (sawNl && at(j) === "'" && toks.length && false) { /* rare; not supported */ }
        }
        if (kind === 'x') { if (/[^0-9a-fA-F]/.test(v)) fail('"' + v + '" is not a valid hexadecimal digit', start); toks.push({ t: 'str', v, bits: 'x', pos: start, end: i }); }
        else if (kind === 'b') { if (/[^01]/.test(v)) fail('"' + v + '" is not a valid binary digit', start); toks.push({ t: 'str', v, bits: 'b', pos: start, end: i }); }
        else toks.push({ t: 'str', v, pos: start, end: i });
        continue;
      }
      // U&'...': \XXXX and \+XXXXXX are Unicode escapes, \\ is a backslash
      if ((c === 'u' || c === 'U') && at(i + 1) === '&' && at(i + 2) === "'") {
        i += 3;
        let raw = '';
        for (;;) {
          if (i >= n) fail('unterminated quoted string', start);
          if (at(i) === "'") { if (at(i + 1) === "'") { raw += "'"; i += 2; continue; } i++; break; }
          raw += at(i++);
        }
        let v = '';
        for (let k = 0; k < raw.length; k++) {
          if (raw[k] !== '\\') { v += raw[k]; continue; }
          if (raw[k + 1] === '\\') { v += '\\'; k++; continue; }
          const m = raw[k + 1] === '+' ? /^[0-9a-fA-F]{6}/.exec(raw.slice(k + 2)) : /^[0-9a-fA-F]{4}/.exec(raw.slice(k + 1));
          if (!m) fail('invalid Unicode escape', start);
          v += String.fromCodePoint(parseInt(m[0], 16)); k += m[0].length + (raw[k + 1] === '+' ? 1 : 0);
        }
        toks.push({ t: 'str', v, pos: start, end: i });
        continue;
      }
      // dollar quoting: $$...$$ or $tag$...$tag$
      if (c === '$' && /[A-Za-z_$]/.test(at(i + 1) || '')) {
        const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i));
        if (m) {
          const tag = m[0];
          const end = src.indexOf(tag, i + tag.length);
          if (end < 0) fail('unterminated dollar-quoted string', start);
          toks.push({ t: 'str', v: src.slice(i + tag.length, end), dollar: true, pos: start, end: end + tag.length });
          i = end + tag.length;
          continue;
        }
      }
      if (c === '$' && /\d/.test(at(i + 1) || '')) {
        const m = /^\$(\d+)/.exec(src.slice(i));
        toks.push({ t: 'param', v: +m[1], pos: start, end: i + m[0].length });
        i += m[0].length;
        continue;
      }
      // numbers: 12, 12.5, .5, 1e3, 0x1F
      if (/\d/.test(c) || (c === '.' && /\d/.test(at(i + 1) || ''))) {
        const m = /^(0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(\d[\d_]*)?(\.\d*)?([eE][+-]?\d+)?)/.exec(src.slice(i));
        let text = m[0];
        if (text === '.' || text === '') { toks.push({ t: 'op', v: '.', pos: start, end: i + 1 }); i++; continue; }
        if (text.endsWith('.') && at(i + text.length) === '.') text = text.slice(0, -1); // 1..5 in FOR loops
        i += text.length;
        if (/[A-Za-z_]/.test(at(i) || '')) fail('trailing junk after numeric literal at or near "' + src.slice(start, i + 1) + '"', start);
        const clean = text.replace(/_/g, '');
        let kind = 'int';
        let val = clean;
        if (/^0[xX]/.test(clean)) val = String(BigInt(clean));
        else if (/^0[oO]/.test(clean)) val = String(BigInt('0o' + clean.slice(2)));
        else if (/^0[bB]/.test(clean)) val = String(BigInt('0b' + clean.slice(2)));
        else if (/[.eE]/.test(clean)) kind = 'num';
        toks.push({ t: kind, v: val, pos: start, end: i });
        continue;
      }
      // identifiers and keywords
      if (/[A-Za-z_\u0080-￿]/.test(c)) {
        const m = /^[A-Za-z_\u0080-￿][A-Za-z0-9_$\u0080-￿]*/.exec(src.slice(i));
        i += m[0].length;
        toks.push({ t: 'id', v: m[0].toLowerCase(), raw: m[0], pos: start, end: i });
        continue;
      }
      if (c === '"') {
        let v = ''; i++;
        for (;;) {
          if (i >= n) fail('unterminated quoted identifier', start);
          if (at(i) === '"') { if (at(i + 1) === '"') { v += '"'; i += 2; continue; } i++; break; }
          v += at(i++);
        }
        if (!v) fail('zero-length delimited identifier', start);
        toks.push({ t: 'id', v, raw: '"' + v + '"', quoted: true, pos: start, end: i });
        continue;
      }
      const op = OPS.find((o) => src.startsWith(o, i));
      if (op) { toks.push({ t: 'op', v: op, pos: start, end: i + op.length }); i += op.length; continue; }
      fail('syntax error at or near "' + c + '"', start);
    }
    toks.push({ t: 'eof', v: '', pos: n, end: n });
    return toks;
  }

  K.lex = lex;
  K.RESERVED = RESERVED;
})(typeof window !== 'undefined' ? window : globalThis);
