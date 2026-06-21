// Built-in math: abs, round, trunc, sqrt, exp, ln, log, power and friends, trigonometry, random numbers,
// width_bucket, the bitwise integer operators, and ^ @ |/ ||/. NUMERIC results keep PostgreSQL's scales,
// computed exactly with BigInt fixed-point arithmetic.
(function (root) {
  'use strict';
  const K = root.K;
  const F = K.F;
  const B = K.T.BASE;
  const Dec = K.Decimal;
  const NUM = B.numeric; // as a type object: an exact match scores high, an integer argument prefers float8, as in PostgreSQL

  const err = (code, msg) => K.err(code, msg);
  const isNaNum = (v) => typeof v === 'number' && Number.isNaN(v);
  const P10 = (n) => 10n ** BigInt(n);
  const babs = (x) => (x < 0n ? -x : x);
  const intName = (t) => (t === 'int2' ? 'smallint' : t === 'int8' ? 'bigint' : 'integer');
  const outOfRange = (t) => err('22003', intName(t) + ' out of range');
  /** a decimal with a non-negative scale (rounding to negative places leaves a negative one) */
  const norm = (d) => (d.s < 0 ? new Dec(d.d * P10(-d.s), 0) : d);
  /** a float8 result, with PostgreSQL's overflow and underflow checks */
  function fl(r, args, zeroOk) {
    if (!Number.isFinite(r) && args.every(Number.isFinite)) throw err('22003', 'value out of range: overflow');
    if (r === 0 && !zeroOk && args.every((a) => a !== 0 && Number.isFinite(a))) throw err('22003', 'value out of range: underflow');
    return r;
  }
  function roundDiv(a, b) {
    const neg = (a < 0n) !== (b < 0n);
    const x = babs(a), y = babs(b);
    let q = x / y;
    if ((x % y) * 2n >= y) q += 1n;
    return neg ? -q : q;
  }
  const rint = (x) => { const r = Math.round(x); return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r === 0 && x < 0 ? -0 : r; };

  // ---- exact helpers for numeric -------------------------------------------------------------------------------
  /** floor(log10(|d|)) for d != 0 */
  const dweight = (d) => babs(d.d).toString().length - 1 - d.s;
  /** the weight in base-10000 digits, as PostgreSQL's NumericVar keeps it */
  const nweight = (d) => (d.d === 0n ? 0 : Math.floor(dweight(d) / 4));
  const toFix = (d, W) => (d.s <= W ? d.d * P10(W - d.s) : roundDiv(d.d, P10(d.s - W)));
  const fromFix = (x, W, rscale) => norm(new Dec(x, W).round(rscale));
  function isqrt(n) {
    if (n < 2n) return n;
    let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
    for (;;) { const y = (x + n / x) >> 1n; if (y >= x) return x; x = y; }
  }
  /** exp(x) for x a BigInt at scale W, at scale W */
  function expFix(x, W) {
    const one = P10(W);
    let k = 0;
    for (let a = babs(x); a > one / 100n; a /= 2n) k++;
    const G = W + 6 + Math.ceil(k * 0.302), oneG = P10(G);
    const r = (x * P10(G - W)) / (1n << BigInt(k));
    let sum = oneG, term = oneG;
    for (let n = 1n; term !== 0n; n++) { term = (term * r) / oneG / n; sum += term; }
    for (let i = 0; i < k; i++) sum = (sum * sum) / oneG;
    return roundDiv(sum, P10(G - W));
  }
  /** ln(y) for y a BigInt at scale G with 1 <= y < 10ish, at scale G */
  function lnNear(y, G) {
    const one = P10(G);
    let k = 0;
    while (y - one > one / 100n) { y = isqrt(y * one); k++; }
    const z = ((y - one) * one) / (y + one), z2 = (z * z) / one;
    let sum = 0n, p = z;
    for (let n = 1n; p !== 0n; n += 2n) { sum += p / n; p = (p * z2) / one; }
    return 2n * sum * (1n << BigInt(k));
  }
  const ln10Cache = new Map();
  const ln10 = (G) => { if (!ln10Cache.has(G)) ln10Cache.set(G, lnNear(10n * P10(G), G)); return ln10Cache.get(G); };
  /** ln(d) for a positive decimal, as a BigInt at scale W */
  function lnFix(d, W) {
    const e = dweight(d);
    const G = W + 8 + String(Math.abs(e)).length;
    const sh = G - d.s - e;
    const y = sh >= 0 ? d.d * P10(sh) : roundDiv(d.d, P10(-sh));
    let r = lnNear(y, G);
    if (e) r += BigInt(e) * ln10(G);
    return roundDiv(r, P10(G - W));
  }
  /** ln(|d|) as a double, for any size of d */
  const lnApprox = (d) => { const s = babs(d.d).toString(); return Math.log(Number('0.' + s.slice(0, 17)) * 10) + (s.length - 1 - d.s) * Math.LN10; };
  /** the decimal weight of ln(d), estimated as PostgreSQL does to choose result scales */
  function lnDweight(d) {
    if (d.cmp(Dec.parse('0.9')) >= 0 && d.cmp(Dec.parse('1.1')) <= 0) { const x = d.sub(1); return x.isZero() ? 0 : dweight(x); }
    return Math.trunc(Math.log10(Math.abs(lnApprox(d))));
  }
  const clampScale = (r, ...mins) => Math.min(Math.max(r, ...mins, 0), 1000);
  function checkLn(d) {
    if (d.isZero()) throw err('2201E', 'cannot take logarithm of zero');
    if (d.sign() < 0) throw err('2201E', 'cannot take logarithm of a negative number');
  }
  function numSqrt(d) {
    if (d.sign() < 0) throw err('2201F', 'cannot take square root of a negative number');
    const sweight = (nweight(d) + 1) * 2 - 1;
    const rscale = clampScale(16 - sweight, d.s);
    const sh = 2 * (rscale + 1) - d.s;
    const n = sh >= 0 ? d.d * P10(sh) : d.d / P10(-sh);
    return norm(new Dec(roundDiv(isqrt(n), 10n), rscale));
  }
  function numExp(d) {
    let val = d.toNumber() * 0.434294481903252;
    if (val > 131072) throw err('22003', 'value overflows numeric format');
    val = Math.max(-1000, Math.min(1000, val));
    const rscale = clampScale(16 - Math.trunc(val), d.s);
    if (val < -1001) return new Dec(0n, rscale);
    const W = rscale + Math.max(0, Math.ceil(val)) + 10;
    return fromFix(expFix(toFix(d, W), W), W, rscale);
  }
  function numLn(d) {
    checkLn(d);
    const rscale = clampScale(16 - lnDweight(d), d.s);
    const W = rscale + 10;
    return fromFix(lnFix(d, W), W, rscale);
  }
  function numLog(b, x) {
    checkLn(b); checkLn(x);
    const db = lnDweight(b), dx = lnDweight(x);
    const rscale = clampScale(16 - (dx - db), b.s, x.s);
    const W = rscale + 12 + Math.max(0, -db) + Math.max(0, dx);
    const lb = lnFix(b, W), lx = lnFix(x, W);
    if (lb === 0n) throw err('22012', 'division by zero');
    return fromFix(roundDiv(lx * P10(W), lb), W, rscale);
  }
  function numPow(b, e) {
    if (isNaNum(b)) return isNaNum(e) || !e.isZero() ? NaN : new Dec(1n, 0);
    if (isNaNum(e)) return b.cmp(1) === 0 ? new Dec(1n, 0) : NaN;
    const eInt = e.trimTo(0).s <= 0;
    if (b.isZero() && e.sign() < 0) throw err('2201F', 'zero raised to a negative power is undefined');
    if (b.sign() < 0 && !eInt) throw err('2201F', 'a negative number raised to a non-integer power yields a complex result');
    const ei = eInt ? e.trunc(0).d : null;
    if (eInt && ei >= -2147483648n && ei <= 2147483647n) {
      const n = Number(ei);
      if (b.isZero()) { const rs = clampScale(16, b.s, e.s); return new Dec(n === 0 ? P10(rs) : 0n, rs); }
      const s = babs(b.d).toString();
      const f = n * (Math.log10(Number('0.' + s.slice(0, 17)) * 10) + (s.length - 1 - b.s));
      if (f > 3000) throw err('22003', 'value overflows numeric format');
      if (f + 1 < -1000) return new Dec(0n, 1000);
      const rscale = clampScale(16 - Math.trunc(f), b.s, e.s);
      if (n === 0) return new Dec(P10(rscale), rscale);
      const m = Math.abs(n);
      if (m * s.length < 20000) {
        const num = b.d ** BigInt(m), sc = b.s * m;
        if (n > 0) return norm(new Dec(num, sc).round(rscale));
        // 1 / b^m at rscale
        const sh = rscale + sc;
        return norm(new Dec(roundDiv(sh >= 0 ? P10(sh) : 1n, sh >= 0 ? num : num * P10(-sh)), rscale));
      }
    }
    if (b.isZero()) return new Dec(0n, 16);
    // b^e = exp(e * ln(b))
    const ld = lnDweight(b);
    const approx = e.toNumber() * lnApprox(b);
    let val = approx * 0.434294481903252;
    if (val > 131072) throw err('22003', 'value overflows numeric format');
    val = Math.max(-1000, Math.min(1000, val));
    const rscale = clampScale(16 - Math.trunc(val), b.s, e.s);
    const W = rscale + Math.max(0, Math.ceil(val)) + 10;
    const W2 = W + Math.max(0, -ld) + String(babs(e.trunc(0).d)).length + 4;
    const prod = roundDiv(lnFix(b, W2) * toFix(e, W2), P10(W2));
    return fromFix(expFix(roundDiv(prod, P10(W2 - W)), W), W, rscale);
  }
  K.NumMath = { sqrt: numSqrt, exp: numExp, ln: numLn, log: numLog, pow: numPow };

  // ---- registration helpers ---------------------------------------------------------------------------------------
  const INTS = ['int2', 'int4', 'int8'];
  /** f for float8 and g for numeric, with NaN passing through numeric functions */
  function fnum(name, f, g, opts) {
    const o = opts || {};
    const specs = [];
    if (f) specs.push(Object.assign({ args: ['float8'], ret: o.fret || 'float8', fn: (v) => f(v[0]) }, o.extra));
    if (g) specs.push(Object.assign({ args: [NUM], ret: o.gret || 'numeric', fn: (v) => (isNaNum(v[0]) ? (o.nanG ? o.nanG(v[0]) : NaN) : g(Dec.of(v[0]))) }, o.extra));
    F.fn(name, specs);
  }

  // abs and @
  // float8 first: an unknown literal argument takes the first overload, and PostgreSQL prefers float8 for it
  const absSpecs = [
    { args: ['float8'], ret: 'float8', fn: (v) => Math.abs(v[0]) },
    { args: ['int2'], ret: 'int2', fn: (v) => { if (v[0] === -32768) throw outOfRange('int2'); return Math.abs(v[0]); } },
    { args: ['int4'], ret: 'int4', fn: (v) => { if (v[0] === -2147483648) throw outOfRange('int4'); return Math.abs(v[0]); } },
    { args: ['int8'], ret: 'int8', fn: (v) => { if (v[0] === -(2n ** 63n)) throw outOfRange('int8'); return babs(v[0]); } },
    { args: [NUM], ret: 'numeric', fn: (v) => (isNaNum(v[0]) ? NaN : Dec.of(v[0]).abs()) },
    { args: ['float4'], ret: 'float4', fn: (v) => Math.abs(v[0]) },
  ];
  F.fn('abs', absSpecs);
  F.op('u@', absSpecs);

  fnum('ceil', (x) => Math.ceil(x), (d) => norm(d.ceil()));
  fnum('ceiling', (x) => Math.ceil(x), (d) => norm(d.ceil()));
  fnum('floor', (x) => Math.floor(x), (d) => norm(d.floor()));
  fnum('round', rint, (d) => norm(d.round(0)));
  fnum('trunc', (x) => Math.trunc(x), (d) => norm(d.trunc(0)));
  F.fn('round', { args: [NUM, 'int4'], ret: 'numeric', fn: (v) => (isNaNum(v[0]) ? NaN : norm(Dec.of(v[0]).round(Math.min(v[1], 1000)))) });
  F.fn('trunc', { args: [NUM, 'int4'], ret: 'numeric', fn: (v) => (isNaNum(v[0]) ? NaN : norm(Dec.of(v[0]).trunc(Math.min(v[1], 1000)))) });
  fnum('sign', (x) => (Number.isNaN(x) ? NaN : x > 0 ? 1 : x < 0 ? -1 : 0), (d) => new Dec(BigInt(d.sign()), 0));
  fnum('sqrt', (x) => { if (x < 0) throw err('2201F', 'cannot take square root of a negative number'); return Math.sqrt(x); }, numSqrt);
  F.op('u|/', { args: ['float8'], ret: 'float8', fn: (v) => { if (v[0] < 0) throw err('2201F', 'cannot take square root of a negative number'); return Math.sqrt(v[0]); } });
  F.fn('cbrt', { args: ['float8'], ret: 'float8', fn: (v) => Math.cbrt(v[0]) });
  F.op('u||/', { args: ['float8'], ret: 'float8', fn: (v) => Math.cbrt(v[0]) });
  fnum('exp', (x) => fl(Math.exp(x), [x], x === -Infinity), numExp);
  const flLn = (x, f) => { if (x === 0) throw err('2201E', 'cannot take logarithm of zero'); if (x < 0) throw err('2201E', 'cannot take logarithm of a negative number'); return f(x); };
  fnum('ln', (x) => flLn(x, Math.log), numLn);
  fnum('log', (x) => flLn(x, Math.log10), (d) => numLog(new Dec(10n, 0), d));
  fnum('log10', (x) => flLn(x, Math.log10), (d) => numLog(new Dec(10n, 0), d));
  F.fn('log', { args: [NUM, NUM], ret: 'numeric', fn: (v) => (isNaNum(v[0]) || isNaNum(v[1]) ? NaN : numLog(Dec.of(v[0]), Dec.of(v[1]))) });

  function flPow(x, y) {
    if (Number.isNaN(x)) return y === 0 ? 1 : NaN;
    if (Number.isNaN(y)) return x === 1 ? 1 : NaN;
    if (x === 0 && y < 0) throw err('2201F', 'zero raised to a negative power is undefined');
    if (x < 0 && Number.isFinite(x) && Number.isFinite(y) && !Number.isInteger(y)) throw err('2201F', 'a negative number raised to a non-integer power yields a complex result');
    if (Math.abs(x) === 1 && !Number.isFinite(y)) return 1;
    return fl(Math.pow(x, y), [x, y], !Number.isFinite(y) || !Number.isFinite(x));
  }
  const powSpecs = [
    { args: ['float8', 'float8'], ret: 'float8', fn: (v) => flPow(v[0], v[1]) },
    { args: [NUM, NUM], ret: 'numeric', fn: (v) => numPow(isNaNum(v[0]) ? NaN : Dec.of(v[0]), isNaNum(v[1]) ? NaN : Dec.of(v[1])) },
  ];
  F.fn('power', powSpecs);
  F.fn('pow', powSpecs);
  F.op('^', powSpecs);

  // mod, div, gcd, lcm, factorial
  F.fn('mod', [
    ...INTS.map((t) => ({ args: [t, t], ret: t, fn: (v) => {
      if (t === 'int8') { if (v[1] === 0n) throw err('22012', 'division by zero'); return v[1] === -1n ? 0n : v[0] % v[1]; }
      if (v[1] === 0) throw err('22012', 'division by zero');
      return (v[0] % v[1]) || 0;
    } })),
    { args: [NUM, NUM], ret: 'numeric', fn: (v) => (isNaNum(v[0]) || isNaNum(v[1]) ? NaN : Dec.of(v[0]).mod(Dec.of(v[1]))) },
  ]);
  F.fn('div', { args: [NUM, NUM], ret: 'numeric', fn: (v) => {
    if (isNaNum(v[0]) || isNaNum(v[1])) return NaN;
    const a = Dec.of(v[0]), b = Dec.of(v[1]);
    if (b.isZero()) throw err('22012', 'division by zero');
    const [x, y] = Dec.align(a, b);
    return new Dec(x / y, 0);
  } });
  const bgcd = (a, b) => { a = babs(a); b = babs(b); while (b) [a, b] = [b, a % b]; return a; };
  for (const t of ['int4', 'int8']) {
    const big = t === 'int8', lim = big ? 2n ** 63n - 1n : 2147483647n;
    const fit = (r) => { if (r > lim) throw outOfRange(t); return big ? r : Number(r); };
    F.fn('gcd', { args: [t, t], ret: t, fn: (v) => fit(bgcd(BigInt(v[0]), BigInt(v[1]))) });
    F.fn('lcm', { args: [t, t], ret: t, fn: (v) => { const a = BigInt(v[0]), b = BigInt(v[1]); if (a === 0n || b === 0n) return big ? 0n : 0; return fit(babs(a / bgcd(a, b) * b)); } });
  }
  F.fn('gcd', { args: [NUM, NUM], ret: 'numeric', fn: (v) => { if (isNaNum(v[0]) || isNaNum(v[1])) return NaN; const [x, y, s] = Dec.align(v[0], v[1]); return new Dec(bgcd(x, y), s); } });
  F.fn('lcm', { args: [NUM, NUM], ret: 'numeric', fn: (v) => {
    if (isNaNum(v[0]) || isNaNum(v[1])) return NaN;
    const [x, y, s] = Dec.align(v[0], v[1]);
    if (x === 0n || y === 0n) return new Dec(0n, s);
    return new Dec(babs(x / bgcd(x, y) * y), s);
  } });
  F.fn('factorial', { args: ['int8'], ret: 'numeric', fn: (v) => {
    const n = BigInt(v[0]);
    if (n < 0n) throw err('22003', 'factorial of a negative number is undefined');
    if (n > 32177n) throw err('22003', 'value overflows numeric format');
    let r = 1n; for (let i = 2n; i <= n; i++) r *= i;
    return new Dec(r, 0);
  } });

  // trigonometry, in radians and in degrees (the *d forms are exact at the familiar angles)
  const f1 = (name, f) => F.fn(name, { args: ['float8'], ret: 'float8', fn: (v) => f(v[0]) });
  const domain = (ok, r) => { if (!ok) throw err('22003', 'input is out of range'); return r; };
  F.fn('pi', { args: [], ret: 'float8', fn: () => Math.PI });
  f1('degrees', (x) => x * (180 / Math.PI));
  f1('radians', (x) => x * (Math.PI / 180));
  f1('sin', (x) => domain(Number.isFinite(x) || Number.isNaN(x), Math.sin(x)));
  f1('cos', (x) => domain(Number.isFinite(x) || Number.isNaN(x), Math.cos(x)));
  f1('tan', (x) => domain(Number.isFinite(x) || Number.isNaN(x), Math.tan(x)));
  f1('cot', (x) => domain(Number.isFinite(x) || Number.isNaN(x), 1 / Math.tan(x)));
  f1('asin', (x) => domain(Number.isNaN(x) || (x >= -1 && x <= 1), Math.asin(x)));
  f1('acos', (x) => domain(Number.isNaN(x) || (x >= -1 && x <= 1), Math.acos(x)));
  f1('atan', Math.atan);
  F.fn('atan2', { args: ['float8', 'float8'], ret: 'float8', fn: (v) => Math.atan2(v[0], v[1]) });
  f1('sinh', Math.sinh); f1('cosh', Math.cosh); f1('tanh', Math.tanh);
  f1('asinh', Math.asinh);
  f1('acosh', (x) => domain(Number.isNaN(x) || x >= 1, Math.acosh(x)));
  f1('atanh', (x) => domain(Number.isNaN(x) || (x >= -1 && x <= 1), Math.atanh(x)));
  const RAD = Math.PI / 180;
  const sin030 = (x) => Math.sin(x * RAD) / Math.sin(30 * RAD) / 2;
  const cos060 = (x) => 1 - (1 - Math.cos(x * RAD)) / (1 - Math.cos(60 * RAD)) / 2;
  const sindq1 = (x) => (x <= 30 ? sin030(x) : cos060(90 - x));
  const cosdq1 = (x) => (x <= 60 ? cos060(x) : sin030(90 - x));
  const nz = (r) => (r === 0 ? 0 : r);
  const fmod = (x, y) => x % y;
  f1('sind', (a) => {
    if (Number.isNaN(a)) return NaN;
    domain(Number.isFinite(a));
    let x = fmod(a, 360), s = 1;
    if (x < 0) { x = -x; s = -s; }
    if (x > 180) { x -= 180; s = -s; }
    if (x > 90) x = 180 - x;
    return nz(s * sindq1(x));
  });
  f1('cosd', (a) => {
    if (Number.isNaN(a)) return NaN;
    domain(Number.isFinite(a));
    let x = fmod(a, 360), s = 1;
    if (x < 0) x = -x;
    if (x > 180) x = 360 - x;
    if (x > 90) { x = 180 - x; s = -s; }
    return nz(s * cosdq1(x));
  });
  const tan45 = sindq1(45) / cosdq1(45);
  const tanLike = (a, cot) => {
    if (Number.isNaN(a)) return NaN;
    domain(Number.isFinite(a));
    let x = fmod(a, 360), s = 1;
    if (x < 0) { x = -x; s = -s; }
    if (x > 180) { x -= 180; s = -s; }
    if (x > 90) { x = 180 - x; s = -s; }
    const r = cot ? cosdq1(x) / sindq1(x) / (1 / tan45) : sindq1(x) / cosdq1(x) / tan45;
    return nz(s * r);
  };
  f1('tand', (a) => tanLike(a, false));
  f1('cotd', (a) => tanLike(a, true));
  const asin05 = Math.asin(0.5), acos05 = Math.acos(0.5), atan1 = Math.atan(1);
  const asindq1 = (x) => (x <= 0.5 ? (Math.asin(x) / asin05) * 30 : 90 - (Math.acos(x) / acos05) * 60);
  const acosdq1 = (x) => (x <= 0.5 ? 90 - (Math.asin(x) / asin05) * 30 : (Math.acos(x) / acos05) * 60);
  f1('asind', (x) => { if (Number.isNaN(x)) return NaN; domain(x >= -1 && x <= 1); return nz(x >= 0 ? asindq1(x) : -asindq1(-x)); });
  f1('acosd', (x) => { if (Number.isNaN(x)) return NaN; domain(x >= -1 && x <= 1); return x >= 0 ? acosdq1(x) : 90 + asindq1(-x); });
  f1('atand', (x) => (Math.atan(x) / atan1) * 45);
  F.fn('atan2d', { args: ['float8', 'float8'], ret: 'float8', fn: (v) => (Math.atan2(v[0], v[1]) / atan1) * 45 });

  // random numbers: one generator, seeded by setseed() for repeatable runs
  const rng = {
    s: [0x9e3779b9, 0x243f6a88, 0xb7e15162, 0xdeadbeef].map((x) => (x ^ (Date.now() & 0xffffffff)) >>> 0),
    next32() {
      // xoshiro128**
      const s = this.s, r = Math.imul(rotl(Math.imul(s[1], 5), 7), 9) >>> 0, t = s[1] << 9;
      s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3]; s[2] ^= t; s[3] = rotl(s[3], 11);
      return r;
    },
    next() { return ((this.next32() >>> 5) * 67108864 + (this.next32() >>> 6)) / 9007199254740992; },
    seed(x) { let h = Math.floor(x * 2147483647) | 0; for (let i = 0; i < 4; i++) { h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) + 0x9e3779b9 * (i + 1); this.s[i] = h >>> 0; } if (!this.s.some(Boolean)) this.s[0] = 1; },
  };
  const rotl = (x, k) => (x << k) | (x >>> (32 - k));
  K.rng = rng;
  const bounds = (lo, hi) => { if (lo > hi) throw err('22023', 'lower bound must be less than or equal to upper bound'); };
  F.fn('random', [
    { args: [], ret: 'float8', volatile: true, fn: () => rng.next() },
    { args: ['int4', 'int4'], ret: 'int4', volatile: true, fn: (v) => { bounds(v[0], v[1]); return v[0] + Math.floor(rng.next() * (v[1] - v[0] + 1)); } },
    { args: ['int8', 'int8'], ret: 'int8', volatile: true, fn: (v) => {
      bounds(v[0], v[1]);
      const span = v[1] - v[0] + 1n;
      let r = 0n; for (let i = 0; i < 3; i++) r = (r << 32n) | BigInt(rng.next32());
      return v[0] + (r % span);
    } },
    { args: [NUM, NUM], ret: 'numeric', volatile: true, fn: (v) => {
      const a = Dec.of(v[0]), b = Dec.of(v[1]);
      if (a.cmp(b) > 0) bounds(1, 0);
      const [x, y, s] = Dec.align(a, b);
      const span = y - x + 1n;
      let r = 0n; for (let i = 0; i < Math.ceil(span.toString(2).length / 32) + 1; i++) r = (r << 32n) | BigInt(rng.next32());
      return new Dec(x + (r % span), s);
    } },
  ]);
  F.fn('random_normal', { args: ['float8', 'float8'], minArgs: 0, ret: 'float8', volatile: true, fn: (v) => {
    const mean = v.length > 0 ? v[0] : 0, sd = v.length > 1 ? v[1] : 1;
    let u = 0; while (u === 0) u = rng.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng.next());
  } });
  F.fn('setseed', { args: ['float8'], ret: 'void', volatile: true, fn: (v) => {
    if (!(v[0] >= -1 && v[0] <= 1)) throw err('22023', 'setseed parameter ' + v[0] + ' is out of allowed range [-1,1]');
    rng.seed(v[0]);
    return '';
  } });

  // width_bucket
  function wbCheck(count, nan, inf) {
    if (count <= 0) throw err('2201G', 'count must be greater than zero');
    if (nan) throw err('2201G', 'operand, lower bound, and upper bound cannot be NaN');
    if (inf) throw err('2201G', 'lower and upper bounds must be finite');
  }
  F.fn('width_bucket', [
    { args: ['float8', 'float8', 'float8', 'int4'], ret: 'int4', fn: (v) => {
      const [x, b1, b2, n] = v;
      wbCheck(n, Number.isNaN(x) || Number.isNaN(b1) || Number.isNaN(b2), !Number.isFinite(b1) || !Number.isFinite(b2));
      let r;
      if (b1 < b2) { if (x < b1) return 0; if (x >= b2) { if (n === 2147483647) throw outOfRange('int4'); return n + 1; } r = Math.trunc(n * ((x - b1) / (b2 - b1))); }
      else if (b1 > b2) { if (x > b1) return 0; if (x <= b2) { if (n === 2147483647) throw outOfRange('int4'); return n + 1; } r = Math.trunc(n * ((b1 - x) / (b1 - b2))); }
      else throw err('2201G', 'lower bound cannot equal upper bound');
      return (r >= n ? n - 1 : r) + 1;
    } },
    { args: [NUM, NUM, NUM, 'int4'], ret: 'int4', fn: (v) => {
      const n = v[3];
      wbCheck(n, v.slice(0, 3).some(isNaNum), false);
      const [x, b1, b2] = v.slice(0, 3).map(Dec.of);
      const c1 = b1.cmp(b2);
      if (c1 === 0) throw err('2201G', 'lower bound cannot equal upper bound');
      const lo = c1 < 0;
      if (lo ? x.cmp(b1) < 0 : x.cmp(b1) > 0) return 0;
      if (lo ? x.cmp(b2) >= 0 : x.cmp(b2) <= 0) { if (n === 2147483647) throw outOfRange('int4'); return n + 1; }
      const num = (lo ? x.sub(b1) : b1.sub(x)).mul(n), den = lo ? b2.sub(b1) : b1.sub(b2);
      const [p, q] = Dec.align(num, den);
      return Number(p / q) + 1;
    } },
    { args: ['anyelement', 'anyarray'], ret: 'int4', fn: (v, ctx, info) => {
      const items = v[1].items, t = info.at[0];
      if (items.some((x) => x instanceof K.ArrayV)) throw err('2202E', 'thresholds must be one-dimensional array');
      if (items.some((x) => x === null)) throw err('22004', 'thresholds array must not contain NULLs');
      let lo = 0, hi = items.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (K.T.compare(v[0], items[m], t) >= 0) lo = m + 1; else hi = m; }
      return lo;
    } },
  ]);

  // the scale of a numeric
  const minScale = (d) => { let s = d.s; let x = d.d; while (s > 0 && x % 10n === 0n) { x /= 10n; s--; } return Math.max(s, 0); };
  F.fn('scale', { args: [NUM], ret: 'int4', fn: (v) => (isNaNum(v[0]) ? null : Math.max(Dec.of(v[0]).s, 0)) });
  F.fn('min_scale', { args: [NUM], ret: 'int4', fn: (v) => (isNaNum(v[0]) ? null : minScale(Dec.of(v[0]))) });
  F.fn('trim_scale', { args: [NUM], ret: 'numeric', fn: (v) => (isNaNum(v[0]) ? NaN : norm(Dec.of(v[0]).trimTo(0))) });

  // ---- bitwise integer operators ------------------------------------------------------------------------------
  const wrap = { int2: (x) => (x << 16) >> 16, int4: (x) => x | 0, int8: (x) => BigInt.asIntN(64, x) };
  for (const t of INTS) {
    const w = wrap[t], big = t === 'int8';
    F.op('&', { args: [t, t], ret: t, fn: (v) => w(v[0] & v[1]) });
    F.op('|', { args: [t, t], ret: t, fn: (v) => w(v[0] | v[1]) });
    F.op('#', { args: [t, t], ret: t, fn: (v) => w(v[0] ^ v[1]) });
    F.op('u~', { args: [t], ret: t, fn: (v) => w(~v[0]) });
    F.op('<<', { args: [t, 'int4'], ret: t, fn: (v) => (big ? w(v[0] << BigInt(v[1] & 63)) : t === 'int2' ? w(v[0] << (v[1] & 31)) : v[0] << v[1]) });
    F.op('>>', { args: [t, 'int4'], ret: t, fn: (v) => (big ? v[0] >> BigInt(v[1] & 63) : t === 'int2' ? w(v[0] >> (v[1] & 31)) : v[0] >> v[1]) });
  }
})(typeof window !== 'undefined' ? window : globalThis);
