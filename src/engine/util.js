// Kwery: shared helpers. Everything lives under one namespace, K, so the same files run in the page and in
// Node (the tests load them in order into one context).
(function (root) {
  'use strict';
  const K = root.K = root.K || {};

  /**
   * An error the database reports to the user. code is a five-character SQLSTATE as in PostgreSQL
   * (22012 division_by_zero, 23505 unique_violation, 42P01 undefined_table ...), pos the offset in the SQL text.
   */
  class DBError extends Error {
    constructor(code, message, extra) {
      super(message);
      this.code = code;
      Object.assign(this, extra || {});
    }
  }
  K.DBError = DBError;
  K.err = (code, message, extra) => new DBError(code, message, extra);

  // the SQLSTATE codes Kwery raises, by name
  K.STATE = {
    syntax: '42601', undefinedTable: '42P01', undefinedColumn: '42703', undefinedFunction: '42883', undefinedObject: '42704',
    duplicateTable: '42P07', duplicateObject: '42710', duplicateColumn: '42701', duplicateAlias: '42712', invalidColumnReference: '42P10', ambiguousColumn: '42702', datatypeMismatch: '42804',
    groupingError: '42803', windowingError: '42P20', invalidRecursion: '42P19', featureNotSupported: '0A000',
    divisionByZero: '22012', numericOutOfRange: '22003', invalidText: '22P02', stringTooLong: '22001', invalidDatetime: '22007',
    datetimeOverflow: '22008', nullNotAllowed: '23502', uniqueViolation: '23505', foreignKeyViolation: '23503', checkViolation: '23514',
    exclusionViolation: '23P01', cardinality: '21000', invalidParameter: '22023', notNullViolation: '23502', invalidJson: '22032',
    arraySubscript: '2202E', serialization: '40001', deadlock: '40P01', lockNotAvailable: '55P03', inFailedTxn: '25P02',
    noActiveTxn: '25P01', activeTxn: '25001', readOnlyTxn: '25006', insufficientPrivilege: '42501', invalidName: '42602',
    raise: 'P0001', tooManyRows: 'P0003', noDataFound: 'P0002', internal: 'XX000', diskFull: '53100', outOfMemory: '53200',
    invalidCursor: '34000', invalidTxnState: '25000', dependentObjects: '2BP01', objectInUse: '55006', triggeredAction: '09000',
    wrongObjectType: '42809', invalidTableDefinition: '42P16', invalidForeignKey: '42830', invalidFunctionDefinition: '42P13', generatedAlways: '428C9',
    duplicateSchema: '42P06', cantChangeRuntimeParam: '55P02', undefinedParameter: '42704', invalidTransactionTermination: '2D000', queryCanceled: '57014',
    cannotCoerce: '42846', ambiguousFunction: '42725', indeterminateDatatype: '42P18',
  };
  /** the DEFAULT keyword in a VALUES list of an INSERT */
  K.DEFAULT = Symbol('DEFAULT');

  // a * b + c with a single rounding: PostgreSQL's C compiler contracts expressions like these into fused
  // multiply-adds on arm64, and its float aggregates must give the same last digits
  const fview = new DataView(new ArrayBuffer(8));
  function fparts(x) {
    fview.setFloat64(0, x);
    const hi = fview.getUint32(0), ex = (hi >>> 20) & 0x7ff;
    let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(fview.getUint32(4));
    if (ex) m |= 1n << 52n;
    return [hi >>> 31 ? -m : m, ex ? ex - 1075 : -1074];
  }
  K.fma = (a, b, c) => {
    if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c) || a === 0 || b === 0) return a * b + c;
    const [ma, ea] = fparts(a), [mb, eb] = fparts(b), [mc, ec] = fparts(c);
    let m = ma * mb, e = ea + eb;
    if (mc) { if (ec >= e) m += mc << BigInt(ec - e); else { m = (m << BigInt(e - ec)) + mc; e = ec; } }
    if (!m) return 0;
    const neg = m < 0n;
    if (neg) m = -m;
    // keep 62 bits and fold the rest into a sticky bit, so converting to a double rounds exactly once
    const len = m.toString(2).length;
    if (len > 62) { const sh = BigInt(len - 62); m = (m >> sh) | (m & ((1n << sh) - 1n) ? 1n : 0n); e += len - 62; }
    const r = e < -1000 ? Number(m) * 2 ** (e + 600) * 2 ** -600 : Number(m) * 2 ** e;
    return neg ? -r : r;
  };

  K.assert = (cond, msg) => { if (!cond) throw K.err(K.STATE.internal, 'internal error: ' + msg); };

  // ---- small utilities ---------------------------------------------------------------------------------------
  K.hex = (n, w) => (n >>> 0).toString(16).padStart(w || 0, '0');
  K.clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  K.range = (n) => Array.from({ length: n }, (_, i) => i);
  K.lower = (s) => String(s).toLowerCase();
  /** a stable string key for any value, for hashing (DISTINCT, GROUP BY, hash join) */
  K.keyOf = (v) => {
    if (v === null || v === undefined) return '\u0000N';
    if (typeof v === 'bigint') return 'n' + v.toString();
    if (typeof v === 'number') return 'n' + (Object.is(v, -0) ? '0' : String(v));
    if (typeof v === 'string') return 's' + v;
    if (typeof v === 'boolean') return v ? 'T' : 'F';
    if (v && typeof v.key === 'function') return v.key();
    if (Array.isArray(v)) return '[' + v.map(K.keyOf).join(',') + ']';
    if (v instanceof Uint8Array) return 'x' + Array.from(v, (b) => K.hex(b, 2)).join('');
    return 'o' + JSON.stringify(v);
  };
  /** FNV-1a on a string: the hash function of the hash indexes and hash joins, so its values can be shown */
  K.fnv = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
  };
  // ASCII text (most of it, in the sample data) skips the general UTF-8 codec
  const enc = new TextEncoder(), dec = new TextDecoder();
  K.utf8 = (s) => {
    const n = s.length;
    if (n < 64) { const out = new Uint8Array(n); for (let i = 0; i < n; i++) { const c = s.charCodeAt(i); if (c > 127) return enc.encode(s); out[i] = c; } return out; }
    return enc.encode(s);
  };
  K.unutf8 = (b) => {
    const n = b.length;
    if (n < 64) { let s = ''; for (let i = 0; i < n; i++) { const c = b[i]; if (c > 127) return dec.decode(b); s += String.fromCharCode(c); } return s; }
    return dec.decode(b);
  };
  K.now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  /** an event bus: the engine reports what it does, and the views listen */
  class Bus {
    constructor() { this.subs = new Map(); this.muted = 0; }
    on(type, fn) { if (!this.subs.has(type)) this.subs.set(type, new Set()); this.subs.get(type).add(fn); return () => this.subs.get(type).delete(fn); }
    emit(type, data) {
      if (this.muted) return;
      const a = this.subs.get(type), b = this.subs.get('*');
      if (a) for (const f of a) f(data, type);
      if (b) for (const f of b) f(data, type);
    }
    get active() { return this.subs.size > 0 && !this.muted; }
    /** does someone listen for this type by name? (for events too frequent to build for '*' listeners alone) */
    wants(type) { const a = this.subs.get(type); return !this.muted && !!a && a.size > 0; }
  }
  K.Bus = Bus;
})(typeof window !== 'undefined' ? window : globalThis);
