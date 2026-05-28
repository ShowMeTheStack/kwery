// Exact decimal numbers for NUMERIC and DECIMAL: an integer of digits (BigInt) and a scale, as in
// PostgreSQL. 0.1 + 0.2 is exactly 0.3 here, which is the point of the type.
(function (root) {
  'use strict';
  const K = root.K;
  const TEN = 10n;
  const pow10 = (n) => TEN ** BigInt(n);

  class Decimal {
    constructor(digits, scale) { this.d = digits; this.s = scale; } // value = d / 10^s
    static of(v) {
      if (v instanceof Decimal) return v;
      if (typeof v === 'bigint') return new Decimal(v, 0);
      if (typeof v === 'number') {
        if (!Number.isFinite(v)) throw K.err(K.STATE.invalidText, 'cannot convert ' + v + ' to numeric');
        if (Number.isInteger(v)) return new Decimal(BigInt(v), 0);
        return Decimal.parse(String(v));
      }
      return Decimal.parse(String(v));
    }
    static parse(text) {
      let t = String(text).trim();
      if (/\d_\d/.test(t) && !/__|_$|^_|_\D|\D_/.test(t.replace(/^[+-]/, ''))) t = t.replace(/_/g, '');
      const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(t);
      if (!m || (m[2] === '' && (m[3] === undefined || m[3] === ''))) throw K.err(K.STATE.invalidText, 'invalid input syntax for type numeric: "' + text + '"');
      const frac = m[3] || '';
      let d = BigInt((m[2] || '0') + frac);
      let s = frac.length;
      const e = m[4] ? parseInt(m[4], 10) : 0;
      if (e > 0) { if (e >= s) { d *= pow10(e - s); s = 0; } else s -= e; } else if (e < 0) s -= e;
      if (m[1] === '-') d = -d;
      return new Decimal(d, s);
    }
    static align(a, b) {
      a = Decimal.of(a); b = Decimal.of(b);
      if (a.s === b.s) return [a.d, b.d, a.s];
      if (a.s > b.s) return [a.d, b.d * pow10(a.s - b.s), a.s];
      return [a.d * pow10(b.s - a.s), b.d, b.s];
    }
    add(o) { const [x, y, s] = Decimal.align(this, o); return new Decimal(x + y, s); }
    sub(o) { const [x, y, s] = Decimal.align(this, o); return new Decimal(x - y, s); }
    mul(o) { o = Decimal.of(o); return new Decimal(this.d * o.d, this.s + o.s); }
    /** division keeps at least 16 significant digits, like PostgreSQL's numeric division */
    div(o) {
      o = Decimal.of(o);
      if (o.d === 0n) throw K.err(K.STATE.divisionByZero, 'division by zero');
      const scale = Decimal.divScale(this, o);
      const num = this.d * pow10(scale + o.s), den = o.d * pow10(this.s);
      return new Decimal(roundDiv(num, den), scale);
    }
    /** the base-10000 weight and leading digit group of a value, as PostgreSQL stores numerics */
    group() {
      if (this.d === 0n) return { weight: 0, first: 0 };
      const ad = this.d < 0n ? -this.d : this.d;
      const e = ad.toString().length - 1 - this.s;
      const weight = Math.floor(e / 4);
      const shift = this.s + 4 * weight;
      const first = shift >= 0 ? ad / pow10(shift) : ad * pow10(-shift);
      return { weight, first: Number(first) };
    }
    mod(o) {
      o = Decimal.of(o);
      if (o.d === 0n) throw K.err(K.STATE.divisionByZero, 'division by zero');
      const [x, y, s] = Decimal.align(this, o);
      return new Decimal(x % y, s);
    }
    neg() { return new Decimal(-this.d, this.s); }
    abs() { return this.d < 0n ? this.neg() : this; }
    sign() { return this.d > 0n ? 1 : this.d < 0n ? -1 : 0; }
    cmp(o) { const [x, y] = Decimal.align(this, o); return x < y ? -1 : x > y ? 1 : 0; }
    isZero() { return this.d === 0n; }
    /** round half away from zero to n digits after the point (n may be negative) */
    round(n) {
      n = n || 0;
      if (n >= this.s) return new Decimal(this.d * pow10(n - this.s), n);
      const k = pow10(this.s - n);
      return new Decimal(roundDiv(this.d, k), n);
    }
    trunc(n) {
      n = n || 0;
      if (n >= this.s) return new Decimal(this.d * pow10(n - this.s), n);
      return new Decimal(this.d / pow10(this.s - n), n);
    }
    floor() { const t = this.trunc(0); return this.d < 0n && t.cmp(this) !== 0 ? t.sub(1) : t; }
    ceil() { const t = this.trunc(0); return this.d > 0n && t.cmp(this) !== 0 ? t.add(1) : t; }
    /** drop trailing zeros below the given scale (used after division) */
    trimTo(min) {
      let d = this.d, s = this.s;
      while (s > min && d % TEN === 0n) { d /= TEN; s--; }
      return new Decimal(d, s);
    }
    /** check precision and scale for NUMERIC(p, s); rounds to s, errors if too many digits */
    fit(p, s) {
      const r = s === undefined ? this : this.round(s);
      if (p !== undefined) {
        const intDigits = (r.d < 0n ? -r.d : r.d).toString().length - r.s;
        if (r.d !== 0n && intDigits > p - (s || 0)) throw K.err(K.STATE.numericOutOfRange, 'numeric field overflow: a field with precision ' + p + ', scale ' + (s || 0) + ' must round to an absolute value less than 10^' + (p - (s || 0)));
      }
      return r;
    }
    toNumber() { return Number(this.d) / 10 ** this.s; }
    toBigInt() { return this.round(0).d; }
    toString() {
      const neg = this.d < 0n;
      let t = (neg ? -this.d : this.d).toString();
      if (this.s > 0) {
        t = t.padStart(this.s + 1, '0');
        t = t.slice(0, t.length - this.s) + '.' + t.slice(t.length - this.s);
      } else if (this.s < 0) t += '0'.repeat(-this.s);
      return (neg ? '-' : '') + t;
    }
    key() { const r = this.trimTo(0); return 'd' + r.d + 'e' + r.s; }
  }
  function roundDiv(a, b) {
    // a / b rounded half away from zero
    const neg = (a < 0n) !== (b < 0n);
    let x = a < 0n ? -a : a; const y = b < 0n ? -b : b;
    let q = x / y; const r = x % y;
    if (r * 2n >= y) q += 1n;
    return neg ? -q : q;
  }
  /** the scale PostgreSQL gives a quotient: at least 16 significant digits, and no less than either input's scale */
  Decimal.divScale = (a, b) => {
    const x = a.group(), y = b.group();
    let qweight = x.weight - y.weight;
    if (x.first <= y.first) qweight--;
    return Math.min(1000, Math.max(16 - qweight * 4, a.s, b.s, 0));
  };
  K.Decimal = Decimal;
})(typeof window !== 'undefined' ? window : globalThis);
