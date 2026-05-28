// The SQL types: what each one is, how text becomes a value and back, how values compare and cast, which
// type two mixed types become, and how each value is laid out in bytes on a page.
(function (root) {
  'use strict';
  const K = root.K;
  const S = K.STATE;
  const D = () => K.Decimal;

  // ---- composite value classes ---------------------------------------------------------------------------------
  class ArrayV {
    constructor(items, lower) { this.items = items; this.lower = lower === undefined || lower === null ? 1 : lower; }
    get length() { return this.items.length; }
    key() { return 'A' + this.lower + '[' + this.items.map(K.keyOf).join(',') + ']'; }
    dims() { const d = [this.items.length]; let x = this.items[0]; while (x instanceof ArrayV) { d.push(x.items.length); x = x.items[0]; } return d; }
  }
  class RowV {
    constructor(values, type) { this.values = values; this.type = type || null; }
    key() { return 'R(' + this.values.map(K.keyOf).join(',') + ')'; }
  }
  class JsonV {
    // binary = jsonb (normalized: keys sorted, duplicates removed, numbers as numeric); text kept for json
    constructor(v, binary, text) { this.v = v; this.binary = !!binary; this.text = text; }
    key() { return 'J' + jsonOut(this.v, true); }
  }
  K.ArrayV = ArrayV; K.RowV = RowV; K.JsonV = JsonV;

  // ---- the type descriptors -------------------------------------------------------------------------------------
  // cat: N numeric, S string, B boolean, D datetime, T timespan, X bytea, J json, A array, C composite, E enum,
  // U uuid, P pseudo (unknown literal / null / record / any)
  const BASE = {};
  function def(id, name, cat, len, extra) { BASE[id] = Object.assign({ id, name, cat, len }, extra || {}); return BASE[id]; }
  def('int2', 'smallint', 'N', 2, { rank: 1, int: true, min: -32768, max: 32767 });
  def('int4', 'integer', 'N', 4, { rank: 2, int: true, min: -2147483648, max: 2147483647 });
  def('int8', 'bigint', 'N', 8, { rank: 3, int: true, big: true, min: -(2n ** 63n), max: 2n ** 63n - 1n });
  def('numeric', 'numeric', 'N', -1, { rank: 4 });
  def('float4', 'real', 'N', 4, { rank: 5, float: true });
  def('float8', 'double precision', 'N', 8, { rank: 6, float: true });
  def('bool', 'boolean', 'B', 1);
  def('char', 'character', 'S', -1, { rank: 1 });
  def('varchar', 'character varying', 'S', -1, { rank: 2 });
  def('text', 'text', 'S', -1, { rank: 3 });
  def('date', 'date', 'D', 4, { rank: 1 });
  def('time', 'time without time zone', 'D', 8, { rank: 0 });
  def('timestamp', 'timestamp without time zone', 'D', 8, { rank: 2 });
  def('timestamptz', 'timestamp with time zone', 'D', 8, { rank: 3 });
  def('interval', 'interval', 'T', 16);
  def('bytea', 'bytea', 'X', -1);
  def('json', 'json', 'J', -1);
  def('jsonb', 'jsonb', 'J', -1);
  def('uuid', 'uuid', 'U', 16);
  def('unknown', 'unknown', 'P', -1); // a quoted literal whose type is not yet known
  def('null', 'unknown', 'P', -1);    // the NULL literal
  def('record', 'record', 'C', -1);
  def('anyelement', 'anyelement', 'P', -1);
  def('void', 'void', 'P', 0);
  def('trigger', 'trigger', 'P', 0);
  def('regclass', 'regclass', 'S', 4);
  def('name', 'name', 'S', -1, { rank: 1 });
  def('xid', 'xid', 'I', 4); // a transaction id (xmin, xmax): compared for equality, cast to and from text

  const ALIAS = {
    smallint: 'int2', int2: 'int2', integer: 'int4', int: 'int4', int4: 'int4', bigint: 'int8', int8: 'int8',
    numeric: 'numeric', decimal: 'numeric', dec: 'numeric', real: 'float4', float4: 'float4', 'double precision': 'float8', float8: 'float8', double: 'float8',
    boolean: 'bool', bool: 'bool', character: 'char', char: 'char', bpchar: 'char', 'character varying': 'varchar', varchar: 'varchar', text: 'text', string: 'text',
    date: 'date', time: 'time', 'time without time zone': 'time', timestamp: 'timestamp', 'timestamp without time zone': 'timestamp',
    timestamptz: 'timestamptz', 'timestamp with time zone': 'timestamptz', interval: 'interval', bytea: 'bytea', blob: 'bytea', 'binary large object': 'bytea',
    clob: 'text', 'character large object': 'text', json: 'json', jsonb: 'jsonb', uuid: 'uuid', record: 'record', void: 'void', trigger: 'trigger', regclass: 'regclass', name: 'name', xid: 'xid',
    serial: 'int4', serial4: 'int4', bigserial: 'int8', serial8: 'int8', smallserial: 'int2', serial2: 'int2', anyelement: 'anyelement',
  };

  /** a type with its modifiers: varchar(20), numeric(8,2), char(5), timestamp(3); arrays have elem */
  function make(id, mods) {
    const b = BASE[id];
    if (!b) return null;
    const t = Object.assign({}, b);
    if (mods && mods.length) {
      if (id === 'varchar' || id === 'char') t.n = mods[0];
      else if (id === 'numeric') { t.p = mods[0]; t.s = mods.length > 1 ? mods[1] : 0; if (t.p < 1 || t.p > 1000) throw K.err(S.invalidParameter, 'NUMERIC precision ' + t.p + ' must be between 1 and 1000'); if (t.s > 1000 || t.s < -1000) throw K.err(S.invalidParameter, 'NUMERIC scale ' + t.s + ' must be between -1000 and 1000'); }
      else if (/^(time|timestamp|timestamptz|interval)$/.test(id)) t.prec = mods[0];
      else if (id === 'float4' || id === 'float8') { /* float(p) handled by name */ }
    } else if (id === 'char') t.n = 1;
    return t;
  }
  const arrayOf = (elem) => ({ id: elem.id + '[]', name: elem.name + '[]', cat: 'A', len: -1, elem });

  /** look a type name up: built-in, or user types (enum, domain, composite) in the catalog */
  function byName(name, mods, catalog) {
    let n = K.lower(name).replace(/\s+/g, ' ').trim();
    if (n.endsWith('[]')) return arrayOf(byName(n.slice(0, -2), mods, catalog));
    if (n === 'float') { const p = mods && mods[0]; return make(p && p <= 24 ? 'float4' : 'float8'); }
    if (n === 'serial' || n === 'serial4' || n === 'bigserial' || n === 'serial8' || n === 'smallserial' || n === 'serial2') return Object.assign(make(ALIAS[n]), { serial: true });
    if (ALIAS[n]) return make(ALIAS[n], mods);
    if (catalog) { const u = catalog.userType(n); if (u) return u; }
    return null;
  }

  // ---- text input ---------------------------------------------------------------------------------------------
  /** a relation name read as regclass must name an existing relation (an OID is taken as it is) */
  function regclassIn(text, ctx) {
    const s = (ctx && ctx.session) || K.currentSession, t = String(text).trim();
    if (!s || !s.catalog || /^\d+$/.test(t)) return t;
    const parts = [];
    const re = /\s*(?:"((?:[^"]|"")*)"|([^."]+))\s*(\.|$)/y;
    let m;
    while (re.lastIndex < t.length && (m = re.exec(t))) { parts.push(m[1] !== undefined ? m[1].replace(/""/g, '"') : m[2].trim().toLowerCase()); if (!m[3]) break; }
    const qn = parts.length > 1 ? { schema: parts[parts.length - 2], name: parts[parts.length - 1] } : { name: parts[0] || t };
    const path = s.searchPath(), rel = s.catalog.lookup(qn, path, null);
    // the output names the relation, qualified only when the search path would not find it
    if (rel) return path.includes(rel.schema) && s.catalog.lookup({ name: rel.name }, path, null) === rel ? rel.name : rel.schema + '.' + rel.name;
    if (s.db.systemView && s.db.systemView(qn, s)) return qn.name;
    throw K.err(S.undefinedTable, 'relation "' + t + '" does not exist');
  }
  function regclassOid(v, ctx) {
    if (/^\d+$/.test(v)) return Number(v);
    const s = (ctx && ctx.session) || K.currentSession;
    const i = v.lastIndexOf('.'), rel = s && s.catalog.lookup(i < 0 ? { name: v } : { schema: v.slice(0, i), name: v.slice(i + 1) }, s.searchPath(), null);
    return rel ? rel.oid : 0;
  }
  function input(text, t, ctx) {
    if (text === null || text === undefined) return null;
    if (t.domain) return checkDomain(input(text, t.base, ctx), t, ctx);
    const s = String(text);
    switch (t.cat) {
      case 'N': return numIn(s, t);
      case 'B': return boolIn(s);
      case 'S': return t.id === 'regclass' ? regclassIn(s, ctx) : strFit(s, t, false);
      case 'D':
        if (t.id === 'date') return K.DateV.parse(s);
        if (t.id === 'time') return roundTs(K.TimeV.parse(s), t);
        return roundTs(K.TimestampV.parse(s, t.id === 'timestamptz', ctx && ctx.zone), t);
      case 'T': return ivFit(K.IntervalV.parse(s, t.field), t);
      case 'X': return byteaIn(s);
      case 'J': return jsonIn(s, t.id === 'jsonb');
      case 'U': return uuidIn(s);
      case 'I': { if (!/^\s*\d+\s*$/.test(s) || BigInt(s.trim()) > 4294967295n) throw K.err(S.invalidText, 'invalid input syntax for type xid: "' + s + '"'); return BigInt(s.trim()); }
      case 'A': return arrayIn(s, t, ctx);
      case 'E': if (!t.labels.includes(s)) throw K.err(S.invalidText, 'invalid input value for enum ' + t.name + ': "' + s + '"'); return s;
      case 'C': return rowIn(s, t, ctx);
      case 'P': return s;
    }
    throw K.err(S.featureNotSupported, 'no input function for type ' + t.name);
  }
  function numIn(s, t) {
    const x = s.trim();
    if (t.int) {
      // decimal, 0x hex, 0o octal and 0b binary, with single underscores between digits
      if (!/^[+-]?(\d(_?\d)*|0x[\da-f](_?[\da-f])*|0o[0-7](_?[0-7])*|0b[01](_?[01])*)$/i.test(x)) throw K.err(S.invalidText, 'invalid input syntax for type ' + t.name + ': "' + s + '"');
      const neg = x[0] === '-', b = BigInt(x.replace(/^[+-]/, '').replace(/_/g, '').toLowerCase());
      return intFit(t.big ? (neg ? -b : b) : Number(neg ? -b : b), t);
    }
    if (t.float) {
      const l = x.toLowerCase();
      if (l === 'nan') return NaN;
      if (/^\+?inf(inity)?$/.test(l)) return Infinity;
      if (/^-inf(inity)?$/.test(l)) return -Infinity;
      if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(x)) throw K.err(S.invalidText, 'invalid input syntax for type ' + t.name + ': "' + s + '"');
      const v = floatFit(Number(x), t, /[1-9]/.test(x.replace(/e.*$/i, '')));
      if (v === null) throw K.err(S.numericOutOfRange, '"' + x + '" is out of range for type ' + (t.id === 'float4' ? 'real' : 'double precision'));
      return v;
    }
    const l = x.toLowerCase();
    if (l === 'nan') return NaN;
    const inf = /^([+-]?)inf(inity)?$/.exec(l);
    if (inf) return numFitInf(inf[1] === '-' ? -Infinity : Infinity, t);
    return D().parse(x).fit(t.p, t.p !== undefined ? t.s : undefined);
  }
  /** a finite value rounded to the float type, or null when it overflows or underflows to zero */
  function floatFit(v, t, nonzero) {
    const r = t.id === 'float4' ? Math.fround(v) : v;
    return !Number.isFinite(r) || (r === 0 && nonzero) ? null : r;
  }
  function numFitInf(v, t) {
    if (t.p !== undefined) throw K.err(S.numericOutOfRange, 'numeric field overflow', { detail: 'A field with precision ' + t.p + ', scale ' + (t.s || 0) + ' cannot hold an infinite value.' });
    return v;
  }
  function intFit(v, t) {
    if (t.big) {
      const b = typeof v === 'bigint' ? v : BigInt(v);
      if (b < t.min || b > t.max) throw K.err(S.numericOutOfRange, 'bigint out of range');
      return b;
    }
    if (typeof v === 'bigint') v = Number(v);
    if (v < t.min || v > t.max || !Number.isFinite(v)) throw K.err(S.numericOutOfRange, (t.id === 'int2' ? 'smallint' : 'integer') + ' out of range');
    return v;
  }
  function boolIn(s) {
    const l = s.trim().toLowerCase();
    // any prefix of true/false/yes/no is accepted, and on/off from two letters, as PostgreSQL's boolin does
    if (l && ('true'.startsWith(l) || 'yes'.startsWith(l) || l === 'on' || l === '1')) return true;
    if (l && ('false'.startsWith(l) || 'no'.startsWith(l) || l === 'of' || l === 'off' || l === '0')) return false;
    throw K.err(S.invalidText, 'invalid input syntax for type boolean: "' + s + '"');
  }
  /** varchar(n) and char(n): too long is an error, except that trailing spaces beyond n are dropped; explicit casts truncate */
  function strFit(s, t, explicit) {
    if (t.n === undefined) return t.id === 'char' ? s.replace(/ +$/, '') : s;
    const chars = [...s];
    if (chars.length > t.n) {
      if (explicit || chars.slice(t.n).every((c) => c === ' ')) s = chars.slice(0, t.n).join('');
      else throw K.err(S.stringTooLong, 'value too long for type ' + (t.id === 'char' ? 'character' : 'character varying') + '(' + t.n + ')');
    }
    return t.id === 'char' ? s.padEnd(t.n, ' ') : s;
  }
  function byteaIn(s) {
    if (s.startsWith('\\x')) {
      const h = s.slice(2).replace(/\s/g, '');
      const bad = /[^0-9a-f]/i.exec(h);
      if (bad) throw K.err('22023', 'invalid hexadecimal digit: "' + bad[0] + '"');
      if (h.length % 2) throw K.err('22023', 'invalid hexadecimal data: odd number of digits');
      return Uint8Array.from(h.match(/../g) || [], (x) => parseInt(x, 16));
    }
    const out = [];
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\\') {
        if (s[i + 1] === '\\') { out.push(92); i++; }
        else if (/^[0-3][0-7]{2}$/.test(s.slice(i + 1, i + 4))) { out.push(parseInt(s.slice(i + 1, i + 4), 8)); i += 3; }
        else throw K.err(S.invalidText, 'invalid input syntax for type bytea');
      } else out.push(...K.utf8(s[i]));
    }
    return Uint8Array.from(out);
  }
  function uuidIn(s) {
    const h = s.trim().toLowerCase().replace(/^\{|\}$/g, '').replace(/-/g, '');
    if (!/^[0-9a-f]{32}$/.test(h)) throw K.err(S.invalidText, 'invalid input syntax for type uuid: "' + s + '"');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  /** INTERVAL DAY TO MINUTE, INTERVAL(2)...: drop the fields below the qualifier, round the seconds */
  function ivFit(iv, t) {
    if (!t.field && t.prec === undefined || iv.infSign()) return iv;
    const low = t.field ? t.field.split(' ').pop() : 'second', H = 3600e6, M = 60e6;
    let { months, days, us } = iv;
    if (low === 'year') { months = Math.trunc(months / 12) * 12; days = 0; us = 0; }
    else if (low === 'month') { days = 0; us = 0; }
    else if (low === 'day') us = 0;
    else if (low === 'hour') us = Math.trunc(us / H) * H;
    else if (low === 'minute') us = Math.trunc(us / M) * M;
    else if (t.prec !== undefined) { const q = 10 ** (6 - t.prec); us = Math.sign(us) * Math.round(Math.abs(us) / q) * q; }
    return new K.IntervalV(months, days, us);
  }
  function roundTs(v, t) {
    if (t.prec === undefined || !Number.isFinite(v.us)) return v;
    const q = 10 ** (6 - t.prec);
    if (v instanceof K.TimeV) return new K.TimeV(Math.round(v.us / q) * q);
    return new K.TimestampV(Math.round(v.us / q) * q, v.tz);
  }

  // JSON: a small parser that keeps numbers exact (as numeric) and, for jsonb, normalizes objects
  function jsonIn(s, binary) {
    let i = 0;
    const fail = (why) => { throw K.err(S.invalidText, 'invalid input syntax for type json' + (why ? ': ' + why : ''), { detail: 'near character ' + (i + 1) }); };
    const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
    const val = () => {
      ws();
      const c = s[i];
      if (c === '{') {
        i++; const o = []; ws();
        if (s[i] === '}') { i++; return obj(o); }
        for (;;) {
          ws(); if (s[i] !== '"') fail('expected a string key');
          const k = str(); ws(); if (s[i] !== ':') fail('expected ":"'); i++;
          o.push([k, val()]); ws();
          if (s[i] === ',') { i++; continue; }
          if (s[i] === '}') { i++; return obj(o); }
          fail('expected "," or "}"');
        }
      }
      if (c === '[') {
        i++; const a = []; ws();
        if (s[i] === ']') { i++; return a; }
        for (;;) { a.push(val()); ws(); if (s[i] === ',') { i++; continue; } if (s[i] === ']') { i++; return a; } fail('expected "," or "]"'); }
      }
      if (c === '"') return str();
      const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(s.slice(i));
      if (m) { i += m[0].length; return D().parse(m[0]); }
      if (s.startsWith('true', i)) { i += 4; return true; }
      if (s.startsWith('false', i)) { i += 5; return false; }
      if (s.startsWith('null', i)) { i += 4; return null; }
      fail('unexpected token');
    };
    const str = () => {
      i++; let out = '';
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\') {
          const e = s[++i];
          const map = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (map[e] !== undefined) { out += map[e]; i++; }
          else if (e === 'u') { const h = s.slice(i + 1, i + 5); if (!/^[0-9a-f]{4}$/i.test(h)) fail('bad unicode escape'); out += String.fromCharCode(parseInt(h, 16)); i += 5; }
          else fail('bad escape');
        } else out += s[i++];
      }
      if (s[i] !== '"') fail('unterminated string');
      i++; return out;
    };
    const obj = (pairs) => {
      const o = new Map();
      for (const [k, v] of pairs) { if (o.has(k) && binary) o.delete(k); o.set(k, v); }
      if (!binary) return { __pairs: pairs };
      // jsonb orders keys by length, then bytewise, as PostgreSQL stores them
      return new Map([...o.entries()].sort((a, b) => a[0].length - b[0].length || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
    };
    const v = val(); ws();
    if (i < s.length) fail('trailing characters');
    return new JsonV(binary ? v : normalizeText(v), binary, binary ? undefined : s);
  }
  // plain json keeps duplicate keys and order; for operators we still need a Map view
  function normalizeText(v) {
    if (Array.isArray(v)) return v.map(normalizeText);
    if (v && v.__pairs) { const m = new Map(); for (const [k, x] of v.__pairs) m.set(k, normalizeText(x)); return m; }
    return v;
  }
  function jsonOut(v, binary) {
    if (v === null) return 'null';
    if (v === true) return 'true';
    if (v === false) return 'false';
    if (v instanceof K.Decimal) return v.toString();
    if (typeof v === 'number') return String(v);
    if (typeof v === 'string') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map((x) => jsonOut(x, binary)).join(', ') + ']';
    if (v instanceof Map) return '{' + [...v.entries()].map(([k, x]) => JSON.stringify(k) + ': ' + jsonOut(x, binary)).join(', ') + '}';
    return JSON.stringify(v);
  }
  K.jsonOut = jsonOut;
  /** JS value (from functions) to the json model used here */
  K.toJsonModel = function toJ(x) {
    if (x === null || x === undefined) return null;
    if (typeof x === 'number') return D().of(x);
    if (typeof x === 'bigint') return D().of(x);
    if (Array.isArray(x)) return x.map(toJ);
    if (x instanceof Map) return new Map([...x].map(([k, v]) => [k, toJ(v)]));
    if (typeof x === 'object' && !(x instanceof K.Decimal)) return new Map(Object.entries(x).map(([k, v]) => [k, toJ(v)]));
    return x;
  };

  // array literals: '{1,2,3}', '{{1,2},{3,4}}', '{"a b",NULL}'
  function arrayIn(s, t, ctx) {
    let i = 0;
    const t0 = s.trim();
    let lower = 1;
    let body = t0;
    const fail = () => { throw K.err(S.invalidText, 'malformed array literal: "' + s + '"'); };
    const dm = /^((\[\s*-?\d+\s*:\s*-?\d+\s*\])+)\s*=/.exec(t0);
    let bounds = null;
    if (dm) { bounds = [...dm[1].matchAll(/(-?\d+)\s*:\s*(-?\d+)/g)].map((m) => [+m[1], +m[2]]); lower = bounds[0][0]; body = t0.slice(dm[0].length).trim(); }
    const parse = () => {
      if (body[i] !== '{') fail();
      i++;
      const items = [];
      while (i < body.length) {
        while (body[i] === ' ') i++;
        if (body[i] === '}') { i++; return new ArrayV(items); }
        if (body[i] === '{') items.push(parse());
        else if (body[i] === '"') {
          i++; let v = '';
          while (i < body.length && body[i] !== '"') { if (body[i] === '\\') i++; v += body[i++]; }
          i++;
          items.push(input(v, t.elem, ctx));
        } else {
          let v = '';
          while (i < body.length && body[i] !== ',' && body[i] !== '}') v += body[i++];
          v = v.trim();
          items.push(/^null$/i.test(v) ? null : input(v, t.elem, ctx));
        }
        while (body[i] === ' ') i++;
        if (body[i] === ',') i++;
        else if (body[i] !== '}') fail();
      }
      fail();
    };
    const a = parse();
    if (body.slice(i).trim()) fail();
    // every level must be all scalars or all sub-arrays of one shape
    const shape = (x) => (x instanceof ArrayV ? [x.items.length].concat(x.items.length && x.items[0] instanceof ArrayV ? shape(x.items[0]) : []) : []);
    const regular = (x) => { if (!(x instanceof ArrayV)) return true; const sub = x.items.map((y) => (y instanceof ArrayV ? shape(y).join(',') : '-')); return sub.every((y) => y === sub[0]) && x.items.every(regular); };
    if (!regular(a)) throw K.err(S.invalidText, 'malformed array literal: "' + s + '"', { detail: 'Multidimensional arrays must have sub-arrays with matching dimensions.' });
    if (bounds) {
      const sh = shape(a);
      if (sh.length !== bounds.length || bounds.some(([lo, hi], k) => hi - lo + 1 !== sh[k])) throw K.err(S.invalidText, 'malformed array literal: "' + s + '"', { detail: 'Specified array dimensions do not match array contents.' });
    }
    a.lower = lower;
    return a;
  }
  function rowIn(s, t, ctx) {
    const m = /^\((.*)\)$/s.exec(s.trim());
    if (!m) throw K.err(S.invalidText, 'malformed record literal: "' + s + '"');
    const parts = [];
    let cur = '', q = false, quoted = false;
    for (let i = 0; i < m[1].length; i++) {
      const c = m[1][i];
      if (q) { if (c === '"' && m[1][i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') { q = true; quoted = true; }
      else if (c === ',') { parts.push(cur === '' && !quoted ? null : cur); cur = ''; quoted = false; }
      else cur += c;
    }
    parts.push(cur === '' && !quoted ? null : cur);
    if (!t.fields) return new RowV(parts, t);
    if (parts.length !== t.fields.length) throw K.err(S.invalidText, 'malformed record literal: "' + s + '": expected ' + t.fields.length + ' columns');
    return new RowV(parts.map((p, i) => input(p, t.fields[i].type, ctx)), t);
  }
  function checkDomain(v, t, ctx) {
    if (v === null && t.notNull) throw K.err(S.notNullViolation, 'domain ' + t.name + ' does not allow null values');
    if (t.check && ctx && ctx.checkDomain) ctx.checkDomain(v, t);
    return v;
  }

  // ---- text output --------------------------------------------------------------------------------------------
  function output(v, t, ctx) {
    if (v === null || v === undefined) return null;
    if (!t) t = typeOfValue(v);
    switch (t.cat) {
      case 'I': return String(v);
      case 'N':
        if (typeof v === 'number') {
          if (Number.isNaN(v)) return 'NaN';
          if (v === Infinity) return 'Infinity';
          if (v === -Infinity) return '-Infinity';
          if (t.float) return floatOut(v, t.id === 'float4');
          return String(v);
        }
        return v.toString();
      case 'B': return v ? 't' : 'f';
      case 'D': return v.toString(ctx && ctx.zone);
      case 'T': return v.toString();
      case 'X': return '\\x' + Array.from(v, (b) => K.hex(b, 2)).join('');
      case 'J': return v.binary ? jsonOut(v.v, true) : (v.text !== undefined ? v.text : jsonOut(v.v, false));
      case 'A': return arrayOut(v, t, ctx);
      case 'C': return '(' + v.values.map((x, i) => { if (x === null) return ''; const o = output(x, t.fields ? t.fields[i].type : null, ctx); return /[\s,()"\\]/.test(o) || o === '' ? '"' + o.replace(/["\\]/g, (c) => c + c) + '"' : o; }).join(',') + ')';
      default: return String(v);
    }
  }
  /** shortest digits that read back exactly, laid out as PostgreSQL does: plain from 1e-4 up to 1e15 (1e6 for real), else 1.5e+15 */
  function floatOut(v, single) {
    if (Object.is(v, -0)) return '-0';
    let e = v.toExponential();
    if (single) for (let p = 1; p <= 9; p++) { const c = v.toExponential(p - 1); if (Math.fround(Number(c)) === v) { e = c; break; } }
    const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(e);
    const sign = m[1], digits = m[2] + (m[3] || ''), x = +m[4];
    if (x < -4 || x >= (single ? 6 : 15)) return sign + m[2] + (m[3] ? '.' + m[3] : '') + 'e' + (x < 0 ? '-' : '+') + String(Math.abs(x)).padStart(2, '0');
    if (x < 0) return sign + '0.' + '0'.repeat(-x - 1) + digits;
    if (digits.length <= x + 1) return sign + digits + '0'.repeat(x + 1 - digits.length);
    return sign + digits.slice(0, x + 1) + '.' + digits.slice(x + 1);
  }
  function arrayOut(a, t, ctx) {
    const el = t && t.elem;
    const one = (x) => {
      if (x instanceof ArrayV) return '{' + x.items.map(one).join(',') + '}';
      if (x === null) return 'NULL';
      const o = output(x, el && el.cat !== 'A' ? el : null, ctx);
      return o === '' || /[\s{},"\\]/.test(o) || /^null$/i.test(o) ? '"' + o.replace(/["\\]/g, (c) => '\\' + c) + '"' : o;
    };
    return (a.lower !== 1 ? '[' + a.lower + ':' + (a.lower + a.items.length - 1) + ']=' : '') + one(a);
  }

  /** the type of a JavaScript value as the engine produces it, for unknown contexts */
  function typeOfValue(v) {
    if (typeof v === 'number') return Number.isInteger(v) ? BASE.int4 : BASE.float8;
    if (typeof v === 'bigint') return BASE.int8;
    if (typeof v === 'boolean') return BASE.bool;
    if (typeof v === 'string') return BASE.text;
    if (v instanceof K.Decimal) return BASE.numeric;
    if (v instanceof K.DateV) return BASE.date;
    if (v instanceof K.TimeV) return BASE.time;
    if (v instanceof K.TimestampV) return v.tz ? BASE.timestamptz : BASE.timestamp;
    if (v instanceof K.IntervalV) return BASE.interval;
    if (v instanceof Uint8Array) return BASE.bytea;
    if (v instanceof JsonV) return v.binary ? BASE.jsonb : BASE.json;
    if (v instanceof ArrayV) { const first = (a) => { for (const x of a.items) { if (x instanceof ArrayV) { const y = first(x); if (y !== undefined) return y; } else if (x !== null) return x; } return undefined; }; const f = first(v); return arrayOf(f !== undefined ? typeOfValue(f) : BASE.text); }
    if (v instanceof RowV) return v.type || BASE.record;
    return BASE.unknown;
  }

  // ---- comparison -------------------------------------------------------------------------------------------
  /** compare two non-null values of one type: -1, 0, 1. NaN sorts above everything, as in PostgreSQL. */
  function compare(a, b, t) {
    if (t && t.cat === 'E') { const i = t.labels.indexOf(a), j = t.labels.indexOf(b); return i < j ? -1 : i > j ? 1 : 0; }
    if (typeof a === 'number' && typeof b === 'number') {
      if (Number.isNaN(a)) return Number.isNaN(b) ? 0 : 1;
      if (Number.isNaN(b)) return -1;
      return a < b ? -1 : a > b ? 1 : 0;
    }
    if (typeof a === 'bigint' && typeof b === 'bigint') return a < b ? -1 : a > b ? 1 : 0;
    if (a instanceof K.Decimal || b instanceof K.Decimal || typeof a !== typeof b && (typeof a === 'number' || typeof a === 'bigint')) {
      if (Number.isNaN(a)) return Number.isNaN(b) ? 0 : 1;
      if (Number.isNaN(b)) return -1;
      if (typeof a === 'number' && !Number.isFinite(a)) return a > 0 ? 1 : -1;
      if (typeof b === 'number' && !Number.isFinite(b)) return b > 0 ? -1 : 1;
      return D().of(a).cmp(D().of(b));
    }
    if (typeof a === 'string' && typeof b === 'string') {
      if (t && t.id === 'char') { a = a.replace(/ +$/, ''); b = b.replace(/ +$/, ''); }
      return a < b ? -1 : a > b ? 1 : 0; // the "C" collation: bytewise, as the test cluster is set up
    }
    if (typeof a === 'boolean') return a === b ? 0 : a ? 1 : -1;
    if (a && typeof a.cmp === 'function') return a.cmp(b);
    if (a instanceof Uint8Array) { for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; return a.length - b.length < 0 ? -1 : a.length > b.length ? 1 : 0; }
    if (a instanceof ArrayV) {
      // as PostgreSQL: the elements in storage order, then the element count, the dimensions and the lower bound
      let et = t && t.elem;
      while (et && et.cat === 'A') et = et.elem;
      const flat = (x) => x.items.flatMap((y) => (y instanceof ArrayV ? flat(y) : [y]));
      const fa = flat(a), fb = flat(b);
      for (let i = 0; i < Math.min(fa.length, fb.length); i++) {
        const x = fa[i], y = fb[i];
        if (x === null || y === null) { if (x === y) continue; return x === null ? 1 : -1; }
        const c = compare(x, y, et); if (c) return c;
      }
      if (fa.length !== fb.length) return fa.length < fb.length ? -1 : 1;
      const da = a.dims(), db = b.dims();
      if (da.length !== db.length) return da.length < db.length ? -1 : 1;
      for (let i = 0; i < da.length; i++) if (da[i] !== db[i]) return da[i] < db[i] ? -1 : 1;
      return a.lower < b.lower ? -1 : a.lower > b.lower ? 1 : 0;
    }
    if (a instanceof RowV) {
      for (let i = 0; i < Math.min(a.values.length, b.values.length); i++) {
        const x = a.values[i], y = b.values[i];
        if (x === null || y === null) { if (x === y) continue; return x === null ? 1 : -1; }
        const c = compare(x, y, t && t.fields ? t.fields[i].type : null); if (c) return c;
      }
      return 0;
    }
    if (a instanceof JsonV) return jsonCmp(a.v, b.v);
    return K.keyOf(a) < K.keyOf(b) ? -1 : K.keyOf(a) > K.keyOf(b) ? 1 : 0;
  }
  /** jsonb ordering as PostgreSQL's: objects > arrays > scalars; containers compare their sizes first; a top-level
   *  scalar is a one-element pseudo array, so [] sorts before every scalar and a scalar before [x] */
  function jsonCmp(a, b, nested) {
    const isO = (x) => x instanceof Map, isA = Array.isArray;
    const rank = (x) => (x === null ? 0 : typeof x === 'string' ? 1 : x instanceof K.Decimal ? 2 : typeof x === 'boolean' ? 3 : isA(x) ? 4 : 5);
    if (!nested && !isO(a) && !isO(b)) {
      const na = isA(a) ? a.length : 1, nb = isA(b) ? b.length : 1;
      if (na !== nb) return na < nb ? -1 : 1;
      if (isA(a) !== isA(b)) return isA(a) ? 1 : -1;
      if (!isA(a)) return jsonCmp(a, b, true);
    }
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra < rb ? -1 : 1;
    if (ra === 2) return a.cmp(b);
    if (ra === 1) return a < b ? -1 : a > b ? 1 : 0;
    if (ra === 3) return a === b ? 0 : a ? 1 : -1;
    if (ra === 4) { if (a.length !== b.length) return a.length < b.length ? -1 : 1; for (let i = 0; i < a.length; i++) { const c = jsonCmp(a[i], b[i], true); if (c) return c; } return 0; }
    if (ra === 5) {
      if (a.size !== b.size) return a.size < b.size ? -1 : 1;
      const ka = [...a.keys()], kb = [...b.keys()];
      for (let i = 0; i < ka.length; i++) {
        if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
        const c = jsonCmp(a.get(ka[i]), b.get(kb[i]), true); if (c) return c;
      }
      return 0;
    }
    return 0;
  }

  // ---- casting ------------------------------------------------------------------------------------------------
  /** can a value of type a be used where type b is expected, without an explicit cast? */
  function implicit(a, b) {
    if (!a || !b) return false;
    if (a.id === b.id && a.cat !== 'A') return true;
    if (a.cat === 'P') return true;
    if (a.cat === 'N' && b.cat === 'N') return (a.rank || 0) <= (b.rank || 0);
    if (a.cat === 'S' && b.cat === 'S') return true;
    if (a.id === 'date' && (b.id === 'timestamp' || b.id === 'timestamptz')) return true;
    if (a.id === 'timestamp' && b.id === 'timestamptz') return true;
    if (a.id === 'time' && b.id === 'interval') return true;
    if (a.cat === 'A' && b.cat === 'A') return implicit(a.elem, b.elem);
    if (a.domain) return implicit(a.base, b);
    if (a.cat === 'E' && b.cat === 'S') return false;
    if (a.cat === 'J' && b.cat === 'J') return a.id === b.id;
    return false;
  }
  /** the common type of several types (UNION, CASE, COALESCE, VALUES, IN lists), or an error */
  function common(types, what) {
    const real = types.filter((t) => t && t.cat !== 'P');
    if (!real.length) return BASE.text;
    let best = real[0].domain ? real[0].base : real[0];
    for (const t0 of real.slice(1)) {
      const t = t0.domain ? t0.base : t0;
      if (t.id === best.id) { if (t.cat === 'S' && t.n !== best.n) best = BASE[best.id === 'char' && t.id === 'char' ? 'char' : t.id]; continue; }
      if (t.cat === 'N' && best.cat === 'N') { if ((t.rank || 0) > (best.rank || 0)) best = t; continue; }
      // the string types all convert implicitly to one another, so the first one wins, as in select_common_type
      if (t.cat === 'S' && best.cat === 'S') { best = BASE[best.id]; continue; }
      if (t.cat === 'D' && best.cat === 'D' && t.id !== 'time' && best.id !== 'time') { if ((t.rank || 0) > (best.rank || 0)) best = t; continue; }
      if (t.cat === 'A' && best.cat === 'A') { best = arrayOf(common([best.elem, t.elem], what)); continue; }
      throw K.err(S.datatypeMismatch, (what || 'types') + ' ' + best.name + ' and ' + t.name + ' cannot be matched');
    }
    // as PostgreSQL's select_common_typmod: the modifier (varchar(n), numeric(p,s)) survives only when every input has it
    const mod = (t) => (t ? [t.id, t.n, t.p, t.s, t.prec].join(',') : '');
    if (BASE[best.id] && best.cat !== 'A' && (types.some((t) => !t || t.cat === 'P') || real.some((t) => mod(t.domain ? t.base : t) !== mod(best)))) best = BASE[best.id];
    return best;
  }
  /** convert a value; explicit = a CAST or ::, which allows more conversions and truncates strings */
  function cast(v, from, to, explicit, ctx) {
    if (v === null || v === undefined) { for (let t = to; t && t.domain; t = t.base) checkDomain(null, t, ctx); return null; }
    if (!to || to.cat === 'P' && to.id !== 'unknown') return v;
    if (to.domain) return checkDomain(cast(v, from, to.base, explicit, ctx), to, ctx);
    if (from && from.domain) from = from.base;
    if (!from) from = typeOfValue(v);
    if (from.cat === 'P' || (typeof v === 'string' && from.cat !== 'S' && from.cat !== 'E')) return explicit && to.cat === 'S' ? strFit(String(v), to, true) : input(v, to, ctx);
    if (from.id === 'char' && to.cat === 'S' && to.id !== 'char' && typeof v === 'string') return strFit(v.replace(/ +$/, ''), to, explicit);
    if (from.id === to.id && from.cat !== 'A' && from.cat !== 'C') {
      if (to.cat === 'S') return strFit(v, to, explicit);
      if (to.id === 'numeric' && to.p !== undefined) return D().of(v).fit(to.p, to.s);
      if (to.prec !== undefined && (v instanceof K.TimestampV || v instanceof K.TimeV)) return roundTs(v, to);
      if (v instanceof K.IntervalV) return ivFit(v, to);
      return v;
    }
    switch (to.cat) {
      case 'N': return from.id === 'regclass' ? regclassOid(v, ctx) : castNum(v, from, to);
      case 'S':
        if (to.id === 'regclass') return regclassIn(from.cat === 'S' ? v : output(v, from, ctx), ctx);
        if (from.cat === 'E') return strFit(v, to, explicit);
        // a boolean cast to text is spelled out, unlike its output form t/f
        if (from.cat === 'B') return strFit(v ? 'true' : 'false', to, explicit);
        return strFit(output(v, from, ctx), to, explicit);
      case 'B':
        if (from.id === 'int4' && explicit) return v !== 0;
        if (from.cat === 'S') return boolIn(v);
        if (from.cat === 'J' && explicit) { if (typeof v.v === 'boolean') return v.v; throw K.err(S.invalidParameter, 'cannot cast jsonb ' + jsonKind(v.v) + ' to type boolean'); }
        break;
      case 'D':
        if (to.id === 'date') {
          if (v instanceof K.TimestampV) return new K.DateV(Math.floor(v.local(ctx && ctx.zone) / K.US_DAY));
          if (from.cat === 'S') return K.DateV.parse(v);
        } else if (to.id === 'time') {
          if (v instanceof K.TimestampV) { const l = v.local(ctx && ctx.zone); return new K.TimeV(((l % K.US_DAY) + K.US_DAY) % K.US_DAY); }
          if (v instanceof K.IntervalV && explicit) return new K.TimeV(((v.us % K.US_DAY) + K.US_DAY) % K.US_DAY);
          if (from.cat === 'S') return K.TimeV.parse(v);
        } else {
          const tz = to.id === 'timestamptz';
          if (v instanceof K.DateV) { const us = v.days * K.US_DAY; return roundTs(new K.TimestampV(tz ? K.Zone.fromLocal(ctx && ctx.zone, us) : us, tz), to); }
          if (v instanceof K.TimestampV) {
            if (tz && !v.tz) return roundTs(new K.TimestampV(K.Zone.fromLocal(ctx && ctx.zone, v.us), true), to);
            if (!tz && v.tz) return roundTs(new K.TimestampV(v.local(ctx && ctx.zone), false), to);
          }
          if (from.cat === 'S') return roundTs(K.TimestampV.parse(v, tz, ctx && ctx.zone), to);
        }
        break;
      case 'T':
        if (v instanceof K.TimeV) return new K.IntervalV(0, 0, v.us);
        if (from.cat === 'S') return K.IntervalV.parse(v);
        break;
      case 'X': if (from.cat === 'S') return byteaIn(v); break;
      case 'J':
        if (from.cat === 'J') return to.id === 'jsonb' ? jsonIn(output(v, from), true) : new JsonV(v.v, false, output(v, from));
        if (from.cat === 'S') return jsonIn(v, to.id === 'jsonb');
        break;
      case 'U': if (from.cat === 'S') return uuidIn(v); break;
      case 'I': if (from.cat === 'S') return input(v, to, ctx); if (from.cat === 'N') return BigInt(v); break;
      case 'E': if (from.cat === 'S' && explicit) return input(v, to, ctx); break;
      case 'A':
        if (from.cat === 'A') return mapArray(v, (x) => cast(x, from.elem, to.elem, explicit, ctx));
        if (from.cat === 'S') return arrayIn(v, to, ctx);
        break;
      case 'C':
        if (v instanceof RowV && to.fields) { if (v.values.length !== to.fields.length) break; return new RowV(v.values.map((x, i) => cast(x, v.type && v.type.fields ? v.type.fields[i].type : null, to.fields[i].type, explicit, ctx)), to); }
        if (from.cat === 'S') return rowIn(v, to, ctx);
        break;
    }
    throw K.err(S.cannotCoerce, 'cannot cast type ' + from.name + ' to ' + to.name);
  }
  /** false when PostgreSQL has no cast at all between the two types (checked when an expression is bound) */
  function castable(from, to) {
    if (from.domain) from = from.base;
    if (to.domain) to = to.base;
    const f = from.cat, t = to.cat, plain = 'NBDTXUJI';
    if (!plain.includes(f) || !plain.includes(t) || f === t && f !== 'D') return true;
    if (f === 'D' && t === 'D') return from.id === to.id || (to.id === 'date' ? from.id !== 'time' : to.id === 'time' ? from.id !== 'date' : from.id !== 'time');
    if (f === 'N' && t === 'B') return from.id === 'int4';
    if (f === 'B' && t === 'N') return to.id === 'int4';
    if (f === 'J' && (t === 'N' || t === 'B')) return from.id === 'jsonb';
    if (f === 'D' && t === 'T') return from.id === 'time';
    if (f === 'T' && t === 'D') return to.id === 'time';
    return false;
  }
  function mapArray(a, f) { return new ArrayV(a.items.map((x) => (x instanceof ArrayV ? mapArray(x, f) : x === null ? null : f(x))), a.lower); }
  function castNum(v, from, to) {
    if (from.cat === 'S') return numIn(v, to);
    if (from.cat === 'B') { if (to.id === 'int4') return v ? 1 : 0; break_(); }
    if (from.cat === 'J') {
      if (v.v instanceof K.Decimal) return castNum(v.v, BASE.numeric, to);
      throw K.err(S.invalidParameter, 'cannot cast jsonb ' + jsonKind(v.v) + ' to type ' + to.name);
    }
    if (from.cat !== 'N') break_();
    if (to.int) {
      let x;
      if (typeof v === 'number' && Number.isNaN(v) && !from.float) throw K.err(S.featureNotSupported, 'cannot convert NaN to ' + to.name);
      if (typeof v === 'number') { if (!Number.isFinite(v)) throw K.err(S.numericOutOfRange, (to.big ? 'bigint' : to.id === 'int2' ? 'smallint' : 'integer') + ' out of range'); x = roundHalfEven(v); }
      else if (v instanceof K.Decimal) x = v.round(0).d;
      else x = v;
      return intFit(to.big ? BigInt(x) : typeof x === 'bigint' ? Number(x) : x, to);
    }
    if (to.float) {
      const x = typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : Number(v.toString());
      if (!Number.isFinite(x) && (typeof v !== 'number' || Number.isFinite(v))) throw K.err(S.numericOutOfRange, 'value out of range: overflow');
      const r = to.id === 'float4' ? Math.fround(x) : x;
      if (!Number.isFinite(r) && Number.isFinite(x)) throw K.err(S.numericOutOfRange, 'value out of range: overflow');
      if (r === 0 && x !== 0) throw K.err(S.numericOutOfRange, 'value out of range: underflow');
      return r;
    }
    // to numeric
    if (typeof v === 'number' && !Number.isFinite(v)) return Number.isNaN(v) ? NaN : numFitInf(v, to);
    // a float converts with DBL_DIG (FLT_DIG) significant digits, as PostgreSQL prints it with %.15g
    const d = typeof v === 'number' && from.float ? D().parse(Number(v.toPrecision(from.id === 'float4' ? 6 : 15)).toString()) : D().of(v);
    return d.fit(to.p, to.p !== undefined ? to.s : undefined);
  }
  const jsonKind = (x) => (x === null ? 'null' : typeof x === 'string' ? 'string' : typeof x === 'boolean' ? 'boolean' : Array.isArray(x) ? 'array' : 'object');
  function break_() { throw K.err(S.cannotCoerce, 'cannot cast to number'); }
  /** float to integer casts round half to even, as PostgreSQL does (rint) */
  function roundHalfEven(x) { const r = Math.round(x); return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r; }

  // ---- bytes on a page ------------------------------------------------------------------------------------------
  // Fixed-length types are written at their size; variable-length ones carry a 4-byte length, as a varlena does.
  function encode(v, t) {
    switch (t.cat) {
      case 'N':
        if (t.id === 'int2') { const b = new Uint8Array(2); new DataView(b.buffer).setInt16(0, v, true); return b; }
        if (t.id === 'int4') { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v, true); return b; }
        if (t.id === 'int8') { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, BigInt(v), true); return b; }
        if (t.id === 'float4') { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); return b; }
        if (t.id === 'float8') { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true); return b; }
        return varlena(K.utf8(Number.isNaN(v) ? 'NaN' : v.toString()));
      case 'B': return Uint8Array.of(v ? 1 : 0);
      case 'D':
        if (t.id === 'date') { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v.days === Infinity ? 0x7fffffff : v.days === -Infinity ? -0x80000000 : v.days, true); return b; }
        { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v.us, true); return b; }
      case 'T': { const b = new Uint8Array(16); const dv = new DataView(b.buffer); dv.setInt32(0, v.months, true); dv.setInt32(4, v.days, true); dv.setFloat64(8, v.us, true); return b; }
      case 'U': return Uint8Array.from(v.replace(/-/g, '').match(/../g), (x) => parseInt(x, 16));
      case 'X': return varlena(v);
      default: return varlena(K.utf8(output(v, t)));
    }
  }
  function varlena(bytes) { const b = new Uint8Array(4 + bytes.length); new DataView(b.buffer).setUint32(0, bytes.length, true); b.set(bytes, 4); return b; }
  /** read one value at off; returns [value, bytes used] */
  function decode(buf, off, t, ctx) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    switch (t.cat) {
      case 'N':
        if (t.id === 'int2') return [dv.getInt16(off, true), 2];
        if (t.id === 'int4') return [dv.getInt32(off, true), 4];
        if (t.id === 'int8') return [dv.getBigInt64(off, true), 8];
        if (t.id === 'float4') return [dv.getFloat32(off, true), 4];
        if (t.id === 'float8') return [dv.getFloat64(off, true), 8];
        { const n = dv.getUint32(off, true); const s = K.unutf8(buf.subarray(off + 4, off + 4 + n)); return [s === 'NaN' ? NaN : D().parse(s), 4 + n]; }
      case 'B': return [buf[off] === 1, 1];
      case 'D':
        if (t.id === 'date') { const d = dv.getInt32(off, true); return [new K.DateV(d === 0x7fffffff ? Infinity : d === -0x80000000 ? -Infinity : d), 4]; }
        if (t.id === 'time') return [new K.TimeV(dv.getFloat64(off, true)), 8];
        return [new K.TimestampV(dv.getFloat64(off, true), t.id === 'timestamptz'), 8];
      case 'T': { const us = dv.getFloat64(off + 8, true); return [Number.isFinite(us) ? new K.IntervalV(dv.getInt32(off, true), dv.getInt32(off + 4, true), us) : K.IntervalV.inf(Math.sign(us)), 16]; }
      case 'U': { const h = Array.from(buf.subarray(off, off + 16), (x) => K.hex(x, 2)).join(''); return [uuidIn(h), 16]; }
      case 'X': { const n = dv.getUint32(off, true); return [buf.slice(off + 4, off + 4 + n), 4 + n]; }
      default: { const n = dv.getUint32(off, true); const s = K.unutf8(buf.subarray(off + 4, off + 4 + n)); return [t.cat === 'S' || t.cat === 'E' ? s : input(s, t, ctx), 4 + n]; }
    }
  }
  /** the bytes a stored value takes, without decoding it */
  function width(buf, off, t) {
    switch (t.cat) {
      case 'N': if (t.id === 'int2') return 2; if (t.id === 'int4' || t.id === 'float4') return 4; if (t.id === 'int8' || t.id === 'float8') return 8; break;
      case 'B': return 1;
      case 'D': return t.id === 'date' ? 4 : 8;
      case 'T': case 'U': return 16;
    }
    return 4 + (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24 >>> 0));
  }
  /** alignment of a type on a page, as PostgreSQL's typalign: 1, 2, 4 or 8 */
  const align = (t) => (t.len === 2 ? 2 : t.len === 4 || t.len === -1 ? 4 : t.len === 8 || t.len === 16 ? 8 : 1);

  /** the SQL spelling of a type, as \d and error messages show it */
  function sqlName(t) {
    if (!t) return 'unknown';
    if (t.cat === 'A') return sqlName(t.elem) + '[]';
    if (t.id === 'varchar' && t.n !== undefined) return 'character varying(' + t.n + ')';
    if (t.id === 'char') return 'character(' + (t.n || 1) + ')';
    if (t.id === 'numeric' && t.p !== undefined) return 'numeric(' + t.p + ',' + t.s + ')';
    if (t.field) return 'interval ' + t.field + (t.prec !== undefined ? '(' + t.prec + ')' : '');
    if (t.prec !== undefined) return t.name.replace(/^(\w+)/, '$1(' + t.prec + ')');
    return t.name;
  }

  K.T = { BASE, castable, make, byName, arrayOf, input, output, compare, implicit, common, cast, encode, decode, width, align, sqlName, typeOfValue, intFit, strFit, jsonIn, jsonCmp, roundHalfEven, floatOut, mapArray, uuidIn, byteaIn };
})(typeof window !== 'undefined' ? window : globalThis);
